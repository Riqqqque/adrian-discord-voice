// Listening pipeline (milestone 3): per user, Discord audio → 16 kHz →
// Silero VAD → speech segments → Parakeet (shared, one at a time) → wake
// check. Each user has their own downsampler and VAD keyed by user ID, so
// audio and state never mix between users. Audio lives only in memory.

import { EventEmitter } from 'node:events';
import { rmsDbfs } from '../audio/pcm.js';
import type { SpeechToText, UserId, VoiceTransport, WakeDetector } from '../core/interfaces.js';
import { ASR_SAMPLE_RATE, Downsampler, type SileroOptions, SileroVad } from '../speech/sherpa.js';
import type { TurnDetector } from '../speech/smart-turn.js';

export interface HeardEvent {
  userId: UserId;
  /** Full transcript (dev logging only; never persisted). */
  text: string;
  woke: boolean;
  /** Text after the wake phrase. */
  command: string;
  /** Woken by the looser check (bare name, or wake phrase mid-sentence). */
  loose?: boolean;
  /** The clip, 16 kHz mono, for a second recognition pass. Never stored. */
  samples?: Float32Array;
  audioSeconds: number;
  levelDbfs: number;
  /** End of speech (VAD segment close) → transcript ready, ms. */
  sttLatencyMs: number;
  /** performance.now() when the VAD closed the segment. */
  segmentClosedAt: number;
  decodeMs: number;
}

export interface ListeningPipelineEvents {
  heard: (e: HeardEvent) => void;
  /** Continuous speech from a user so far, ms (for barge-in). */
  voiceActivity: (userId: UserId, voicedMs: number) => void;
  error: (userId: UserId, err: Error) => void;
}

export interface UserState {
  down: Downsampler;
  vad: SileroVad;
  /** performance.now() when the current run of speech began. */
  voicedSince?: number;
  /** Speech held because it sounded unfinished (turn option). */
  held?: { samples: Float32Array; timer?: NodeJS.Timeout; since: number; epoch: number };
  epoch: number;
}

/** Waiting for the rest of a sentence (PC rooms): see src/speech/smart-turn.ts. */
export interface TurnOptions {
  detector: TurnDetector;
  /** How much longer to wait after the normal silence when it sounds unfinished, ms. */
  holdMs: number;
  /** Logs each hold, for tuning. */
  onHold?: (userId: UserId, info: { probability: number; seconds: number }) => void;
}

/** Segments shorter than this are coughs/clicks; don't spend ASR on them. */
const MIN_SEGMENT_SECONDS = 0.3;
/** Silence after the speech when asking whether the turn is over (what the normal wait has heard). */
const TURN_TAIL = new Float32Array(Math.round(0.8 * ASR_SAMPLE_RATE));
/** Between held speech and what came next, so the recognizer hears a pause. */
const JOIN_GAP = new Float32Array(Math.round(0.25 * ASR_SAMPLE_RATE));
/** Never hold one person's speech longer than this in total, ms. */
const MAX_HOLD_MS = 15_000;

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class ListeningPipeline extends EventEmitter {
  protected readonly users = new Map<UserId, UserState>();

  constructor(
    private readonly transport: VoiceTransport,
    private readonly stt: SpeechToText,
    private readonly wake: WakeDetector,
    private readonly vadOptions: SileroOptions,
    private readonly turn?: TurnOptions,
  ) {
    super();
    transport.on('audio', (id, chunk) => {
      const u = this.user(id);
      const segments = u.vad.accept(u.down.push(chunk.samples));
      if (u.vad.isSpeaking()) {
        u.voicedSince ??= chunk.receivedAt;
        this.emit('voiceActivity', id, Math.round(chunk.receivedAt - u.voicedSince));
      } else {
        delete u.voicedSince;
      }
      for (const s of segments) this.handleSegment(id, s);
    });
    // Discord stopped sending for this user: close any open segment.
    transport.on('speechEnd', (id) => {
      const u = this.users.get(id);
      if (!u) return;
      delete u.voicedSince;
      for (const s of u.vad.flush()) this.handleSegment(id, s);
    });
    transport.on('membersChanged', (members) => {
      for (const id of this.users.keys()) if (!members.has(id)) this.users.delete(id);
    });
  }

  override on<E extends keyof ListeningPipelineEvents>(e: E, l: ListeningPipelineEvents[E]): this {
    return super.on(e, l);
  }

  protected user(id: UserId): UserState {
    let u = this.users.get(id);
    if (!u) {
      u = { down: new Downsampler(), vad: new SileroVad(this.vadOptions), epoch: 0 };
      this.users.set(id, u);
    }
    return u;
  }

  private handleSegment(userId: UserId, samples: Float32Array): void {
    const short = samples.length / ASR_SAMPLE_RATE < MIN_SEGMENT_SECONDS;
    if (!this.turn) {
      if (!short) this.transcribe(userId, samples);
      return;
    }
    const u = this.users.get(userId);
    if (!u) return;
    const held = u.held;
    if (short) {
      // a cough while we wait: keep waiting, but don't let the wait stall
      if (held && !held.timer) this.arm(userId, u);
      return;
    }
    if (held?.timer) clearTimeout(held.timer);
    const all = held ? concat(held.samples, JOIN_GAP, samples) : samples;
    const epoch = ++u.epoch;
    u.held = { samples: all, since: held?.since ?? performance.now(), epoch };
    void this.turn.detector
      .complete(concat(all.length > 8 * ASR_SAMPLE_RATE ? all.subarray(all.length - 8 * ASR_SAMPLE_RATE) : all, TURN_TAIL))
      .catch(() => 1) // if the model fails, don't make anyone wait
      .then((p) => {
        const h = u.held;
        if (!h || h.epoch !== epoch) return; // more speech came in meanwhile
        if (p > 0.5 || performance.now() - h.since > MAX_HOLD_MS) {
          this.release(userId, u);
        } else {
          this.turn?.onHold?.(userId, { probability: Number(p.toFixed(2)), seconds: Number((h.samples.length / ASR_SAMPLE_RATE).toFixed(2)) });
          this.arm(userId, u);
        }
      });
  }

  /** Release held speech after holdMs, unless they're talking again by then. */
  private arm(userId: UserId, u: UserState): void {
    const h = u.held;
    if (!h || !this.turn) return;
    const check = () => {
      if (u.held !== h) return;
      // talking again: the VAD will close a segment soon and that decides
      if (u.vad.isSpeaking() && performance.now() - h.since < MAX_HOLD_MS) {
        h.timer = setTimeout(check, 300);
        return;
      }
      this.release(userId, u);
    };
    h.timer = setTimeout(check, this.turn.holdMs);
  }

  private release(userId: UserId, u: UserState): void {
    const h = u.held;
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    delete u.held;
    this.transcribe(userId, h.samples);
  }

  private transcribe(userId: UserId, samples: Float32Array): void {
    const audioSeconds = samples.length / ASR_SAMPLE_RATE;
    const segmentClosedAt = performance.now();
    const pcm = Int16Array.from(samples, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
    const levelDbfs = Number(rmsDbfs(pcm).toFixed(1));
    this.stt
      .transcribe(samples, ASR_SAMPLE_RATE)
      .then(({ text, decodeMs }) => {
        if (!text) return;
        const m = this.wake.matchLoose?.(text) ?? { ...this.wake.match(text), loose: false };
        this.emit('heard', {
          userId,
          text,
          woke: m.woke,
          command: m.remainder,
          ...(m.loose ? { loose: true } : {}),
          samples,
          audioSeconds: Number(audioSeconds.toFixed(2)),
          levelDbfs,
          sttLatencyMs: Math.round(performance.now() - segmentClosedAt),
          segmentClosedAt,
          decodeMs,
        } satisfies HeardEvent);
      })
      .catch((e: Error) => this.emit('error', userId, e));
  }
}
