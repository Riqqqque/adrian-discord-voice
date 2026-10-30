// Mixes speech and music into one Discord playback. Discord has one audio
// player per connection, so both go through here: speech at full volume,
// music turned down ("ducked") while the bot is listening or talking.
//
// Frames are written against the wall clock with a small lead (160 ms), so
// speech written now is heard about now (the encoder would otherwise buffer
// music seconds ahead), and a stalled event loop is made up right after
// instead of leaving the buffer short for the rest of the song. When neither
// channel has anything to play, the playback ends, so Discord doesn't show
// the bot as talking all the time.

import { PassThrough, type Readable } from 'node:stream';
import type { PlaybackHandle } from '../core/interfaces.js';

/** 20 ms of 48 kHz stereo s16le. */
export const FRAME_BYTES = 3840;
const FRAME_MS = 20;
/** Frames kept ahead of the player: covers event-loop hiccups, yet low
 *  enough that speech and ducking still feel immediate. */
export const LEAD_FRAMES = 8;
/** After a stall longer than this, skip ahead instead of bursting. */
const MAX_CATCH_UP = 50;
/** Downstream isn't reading (player paused): stop writing past this. */
const MAX_UNREAD = FRAME_BYTES * 60;

type Outcome = 'finished' | 'stopped' | 'error';

/** One input: PCM bytes read as the clock asks for them. */
class Channel {
  private chunks: Buffer[] = [];
  private queued = 0;
  ended = false;
  private resolve!: (o: Outcome) => void;
  readonly done = new Promise<Outcome>((r) => (this.resolve = r));
  private settled = false;
  /** True once the source has delivered at least one frame. */
  started = false;

  constructor(
    readonly source: NodeJS.ReadableStream,
    public volume: number,
    private readonly onChange: () => void,
  ) {
    source.on('data', (b: Buffer) => {
      this.chunks.push(b);
      this.queued += b.length;
      // Keep music from piling up in memory: pause the source while a
      // couple of seconds are waiting.
      if (this.queued > FRAME_BYTES * 150) (source as Readable).pause?.();
      onChange();
    });
    source.on('end', () => {
      this.ended = true;
      onChange();
    });
    source.on('close', () => {
      this.ended = true;
      onChange();
    });
    source.on('error', () => {
      this.ended = true;
      this.finish('error');
      onChange();
    });
  }

  /** Bytes waiting to be played. */
  get buffered(): number {
    return this.queued;
  }

  /** Nothing left and nothing more coming. */
  get drained(): boolean {
    return this.ended && this.queued === 0;
  }

  /** Next frame, or undefined if nothing is buffered (an underrun). */
  take(): Buffer | undefined {
    if (this.queued === 0) return undefined;
    const out = Buffer.alloc(FRAME_BYTES);
    let off = 0;
    while (off < FRAME_BYTES && this.chunks.length) {
      const c = this.chunks[0]!;
      const n = Math.min(c.length, FRAME_BYTES - off);
      c.copy(out, off, 0, n);
      off += n;
      if (n === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(n);
    }
    this.queued -= off;
    this.started = true;
    if (this.queued < FRAME_BYTES * 50) (this.source as Readable).resume?.();
    return out; // a short tail is padded with silence
  }

  finish(o: Outcome): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(o);
  }

  drop(): void {
    this.chunks = [];
    this.queued = 0;
    this.ended = true;
    (this.source as Readable).destroy?.();
    this.finish('stopped');
  }
}

export interface MixerOptions {
  /** Starts the real playback of the mixed stream (raw 48 kHz stereo). */
  start(stream: Readable): PlaybackHandle;
  /** Music level while ducked, as a fraction of its normal level. */
  duckLevel?: number;
  /** Her voice (or a sound) started or stopped being played. */
  onVoice?: (on: boolean) => void;
  /** Clock (tests use a fake one). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export class Mixer {
  private speech: Channel[] = [];
  private music: Channel | undefined;
  private out: PassThrough | undefined;
  private playback: PlaybackHandle | undefined;
  private timer: unknown;
  /** Current music gain, ramped toward its target to avoid clicks. */
  private gain = 1;
  private duckedUntil = 0;
  private holds = 0;
  /** Clock start of the current playback, and frames written since. */
  private startAt = 0;
  private written = 0;
  /** Since the last takeStats(): frames the music source was empty, frames made up after stalls, longest stall. */
  private stats = { musicGaps: 0, madeUp: 0, longestStallMs: 0 };
  private lastTick = 0;
  private paused = false;
  /** What onVoice last said. */
  private voice = false;

  constructor(
    private readonly o: MixerOptions,
    private readonly now: () => number = () => performance.now(),
  ) {}

  // --- speech: the Speaker's transport -------------------------------------

  /** Same shape as VoiceTransport.playPcm, so the Speaker uses it as is. */
  playPcm(stream: NodeJS.ReadableStream, opts?: { volume?: number }): PlaybackHandle {
    const ch = new Channel(stream, opts?.volume ?? 0.7, () => this.wake());
    this.speech.push(ch);
    this.wake();
    return { done: ch.done, stop: () => (ch.drop(), this.wake()) };
  }

  // --- music -----------------------------------------------------------------

  /** Play music (raw 48 kHz stereo s16le); replaces any current track. */
  playMusic(stream: NodeJS.ReadableStream, volume: number): PlaybackHandle {
    this.music?.drop();
    const ch = new Channel(stream, volume, () => this.wake());
    this.music = ch;
    this.paused = false;
    this.wake();
    return { done: ch.done, stop: () => (ch.drop(), this.wake()) };
  }

  /** A track is loaded (playing or paused). */
  get musicPlaying(): boolean {
    return !!this.music && !this.music.drained;
  }

  get musicPaused(): boolean {
    return this.paused && this.musicPlaying;
  }

  pauseMusic(): void {
    this.paused = true;
  }

  resumeMusic(): void {
    this.paused = false;
    this.wake();
  }

  setMusicVolume(v: number): void {
    if (this.music) this.music.volume = v;
  }

  /** Turn music down for a while (someone woke the bot). */
  duckFor(ms: number): void {
    this.duckedUntil = Math.max(this.duckedUntil, this.now() + ms);
  }

  /** Keep music down until the returned function is called. */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (!released) this.holds--;
      released = true;
    };
  }

  /** Playback health since the last call. */
  takeStats(): { musicGaps: number; madeUp: number; longestStallMs: number } {
    const s = this.stats;
    this.stats = { musicGaps: 0, madeUp: 0, longestStallMs: 0 };
    return s;
  }

  /** Stop everything (leaving the call). */
  stopAll(): void {
    for (const s of this.speech) s.drop();
    this.speech = [];
    this.music?.drop();
    this.music = undefined;
    this.halt();
  }

  // --- the clock -------------------------------------------------------------

  private get speaking(): boolean {
    return this.speech.some((s) => s.buffered > 0 || !s.ended);
  }

  private wake(): void {
    if (this.timer || !(this.speech.length || (this.music && !this.paused))) return;
    this.out = new PassThrough({ highWaterMark: FRAME_BYTES * LEAD_FRAMES });
    this.playback = this.o.start(this.out);
    const pb = this.playback;
    void pb.done.then(() => {
      if (this.playback !== pb) return;
      this.halt(); // the player stopped on its own (an error)
      if (this.speech.length || (this.music && !this.paused)) setTimeout(() => this.wake(), 200);
    });
    this.startAt = this.now();
    this.written = 0;
    const si = this.o.setInterval ?? ((f: () => void, ms: number) => setInterval(f, ms));
    this.timer = si(() => this.tick(), FRAME_MS / 2);
    this.tick();
  }

  private halt(): void {
    if (this.timer) (this.o.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
    this.lastTick = 0;
    const out = this.out;
    this.out = undefined;
    this.playback = undefined;
    out?.end();
    this.setVoice(false);
  }

  private setVoice(on: boolean): void {
    if (on === this.voice) return;
    this.voice = on;
    this.o.onVoice?.(on);
  }

  /** Write every frame that is due by now (plus the lead). Public for tests. */
  tick(): void {
    if (!this.out) return;
    const due = Math.floor((this.now() - this.startAt) / FRAME_MS) + LEAD_FRAMES;
    const t = this.now();
    if (this.lastTick) this.stats.longestStallMs = Math.max(this.stats.longestStallMs, Math.round(t - this.lastTick));
    this.lastTick = t;
    if (due - this.written > 1) this.stats.madeUp += due - this.written - 1;
    if (due - this.written > MAX_CATCH_UP) this.written = due - LEAD_FRAMES; // long stall: drop the gap
    while (this.out && this.written < due) {
      if (this.out.writableLength > MAX_UNREAD) return; // the player isn't reading
      this.mixFrame();
      this.written++;
    }
  }

  private mixFrame(): void {
    const out = this.out;
    if (!out) return;

    // Speech: the oldest channel with audio plays; finished ones resolve.
    while (this.speech.length && this.speech[0]!.drained) this.speech.shift()!.finish('finished');
    const sp = this.speech[0];
    const sFrame = sp?.take();

    const m = this.music;
    if (m?.drained) {
      m.finish('finished');
      this.music = undefined;
    }
    const mFrame = this.paused ? undefined : this.music?.take();
    if (this.music && !this.paused && !mFrame && this.music.started && !this.music.ended) this.stats.musicGaps++;

    this.setVoice(!!sFrame || this.speaking);
    const ducked = this.holds > 0 || this.speaking || this.now() < this.duckedUntil;
    const target = ducked ? (this.o.duckLevel ?? 0.2) : 1;

    if (!sFrame && !mFrame) {
      if (!this.speech.length && (!this.music || this.paused)) {
        this.halt();
        return;
      }
      out.write(Buffer.alloc(FRAME_BYTES)); // waiting on a source: silence
      return;
    }

    const frame = Buffer.alloc(FRAME_BYTES);
    const sv = sp?.volume ?? 0;
    const mv = this.music?.volume ?? 0;
    const n = FRAME_BYTES / 2;
    const step = (target - this.gain) / (n / 2); // ramp over one frame
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0 && Math.abs(target - this.gain) > Math.abs(step)) this.gain += step;
      else if (i % 2 === 0) this.gain = target;
      let v = 0;
      if (sFrame) v += sFrame.readInt16LE(i * 2) * sv;
      if (mFrame) v += mFrame.readInt16LE(i * 2) * mv * this.gain;
      frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
    }
    out.write(frame);
  }
}
