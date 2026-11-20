import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SpeechToText, UserId, VoiceTransport, WakeDetector } from '../src/core/interfaces.js';
import { type EarlyOptions, type HeardEvent, ListeningPipeline, type TurnOptions, type UserState } from '../src/listen/pipeline.js';
import { Downsampler, type SileroVad } from '../src/speech/sherpa.js';

/** A VAD stand-in: hands out what's in `closing` on the next audio. */
class FakeVad {
  closing: Float32Array[] = [];
  queue: Float32Array[] = [];
  speaking = false;
  flushed = 0;
  accept() {
    return this.closing.splice(0);
  }
  flush() {
    this.flushed++;
    return this.queue.splice(0);
  }
  isSpeaking() {
    return this.speaking;
  }
}

/** The full wait's VAD and the quick one. */
class TestPipeline extends ListeningPipeline {
  readonly vad = new FakeVad();
  readonly quick = new FakeVad();
  withQuick = true;
  protected override user(id: UserId): UserState {
    let u = this.users.get(id);
    if (!u) {
      u = { down: new Downsampler(), vad: this.vad as unknown as SileroVad, ...(this.withQuick ? { early: this.quick as unknown as SileroVad } : {}), epoch: 0 };
      this.users.set(id, u);
    }
    return u;
  }
  has(id: UserId) {
    return this.users.has(id);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) await wait(2);
}
/** Speech-like samples: every value different, so a copy compares equal and a cut doesn't. */
const speech = (s: number, from = 0) => Float32Array.from({ length: Math.round(s * 16_000) }, (_, i) => Math.sin((i + from) * 0.01) * 0.3);

interface Setup {
  turn?: Partial<TurnOptions> | false;
  early?: Partial<EarlyOptions> | false;
  decodeMs?: number;
  vadSilence?: number;
}

function setup(o: Setup = {}) {
  const transport = new EventEmitter() as unknown as VoiceTransport;
  const heard: HeardEvent[] = [];
  const decoded: Float32Array[] = [];
  const cancelled: Float32Array[] = [];
  const stt = {
    transcribe: async (s: Float32Array, _r: number, signal?: AbortSignal) => {
      decoded.push(s);
      await wait(o.decodeMs ?? 5);
      if (signal?.aborted) cancelled.push(s);
      return { text: `words ${s.length}`, decodeMs: 1 };
    },
  } as unknown as SpeechToText;
  const wake = { match: (t: string) => ({ woke: t.startsWith('words'), remainder: t }) } as unknown as WakeDetector;
  const words: { userId: UserId; text: string; samples: Float32Array; startedAt: number; signal: AbortSignal }[] = [];
  const turn: TurnOptions | undefined =
    o.turn === false
      ? undefined
      : { holdMs: 60, detector: { complete: async () => 0.9 }, ...(o.turn ?? {}) } as TurnOptions;
  const early: EarlyOptions | undefined = o.early === false ? undefined : { minSilence: 0.32, onWords: (userId, w) => void words.push({ userId, ...w }), ...(o.early ?? {}) };
  const p = new TestPipeline(transport, stt, wake, { model: 'x', threshold: 0.5, minSilence: o.vadSilence ?? 0.8, minSpeech: 0.25, maxSpeech: 20 }, turn, early);
  p.on('heard', (e: HeardEvent) => void heard.push(e));
  const audio = () => (transport as unknown as EventEmitter).emit('audio', 'u1', { samples: new Int16Array(0), receivedAt: 0 });
  /** The quick VAD closes a clip. */
  const quickClose = (s: Float32Array) => {
    p.quick.closing.push(s);
    audio();
  };
  /** The full wait closes a clip. */
  const fullClose = (s: Float32Array) => {
    p.vad.closing.push(s);
    audio();
  };
  return { p, transport: transport as unknown as EventEmitter, heard, decoded, cancelled, words, quickClose, fullClose, audio };
}

describe('recognizing during the silence wait', () => {
  it('reuses the early words when the full wait closes the same audio', async () => {
    const t = setup();
    const clip = speech(1.5);
    t.quickClose(clip);
    expect(t.decoded).toHaveLength(1);
    await until(() => t.words.length === 1);
    t.fullClose(Float32Array.from(clip)); // a copy: same samples, other array
    await until(() => t.heard.length === 1);
    expect(t.decoded).toHaveLength(1);
    expect(t.heard[0]!.text).toBe(`words ${clip.length}`);
    // heard carries the array the early listen was started for
    expect(t.heard[0]!.samples).toBe(t.words[0]!.samples);
    expect(t.words[0]!.signal.aborted).toBe(false);
    expect(t.heard[0]!.early).toBe(true);
  });

  it('gives exactly the heard event it gives without it', async () => {
    const strip = (e: HeardEvent) => ({ ...e, early: undefined, samples: Array.from(e.samples!), sttLatencyMs: 0, segmentClosedAt: 0, vadClosedAt: 0, turnCheckMs: 0, holdMs: 0 });
    const a = setup();
    const b = setup({ early: false });
    const clip = speech(1.2);
    a.quickClose(clip);
    a.fullClose(Float32Array.from(clip));
    b.fullClose(Float32Array.from(clip));
    await until(() => a.heard.length === 1 && b.heard.length === 1);
    expect(strip(a.heard[0]!)).toEqual(strip(b.heard[0]!));
  });

  it('drops the early clip when they went on talking: the full clip gets its own words', async () => {
    const t = setup();
    const first = speech(1);
    t.quickClose(first);
    await until(() => t.words.length === 1);
    const all = speech(2.5); // same start, more speech after the pause
    t.fullClose(all);
    await until(() => t.heard.length === 1);
    expect(t.words[0]!.signal.aborted).toBe(true);
    expect(t.decoded.map((s) => s.length)).toEqual([first.length, all.length]);
    expect(t.heard[0]!.text).toBe(`words ${all.length}`);
    expect(t.heard[0]!.early).toBeUndefined();
  });

  it('pausing again before the full wait closes: the end alone is not recognized', async () => {
    const t = setup();
    t.quickClose(speech(1));
    await until(() => t.words.length === 1);
    t.quickClose(speech(0.8, 99)); // only the end of what the full wait will close
    await wait(20);
    expect(t.decoded).toHaveLength(1);
    expect(t.words).toHaveLength(1);
    expect(t.words[0]!.signal.aborted).toBe(true);
    const all = speech(2.4);
    t.fullClose(all);
    await until(() => t.heard.length === 1);
    expect(t.decoded.map((x) => x.length)).toEqual([16_000, all.length]);
    expect(t.heard[0]!.text).toBe(`words ${all.length}`);
  });

  it('after the full wait closes, the next clip is recognized early again', async () => {
    const t = setup();
    const first = speech(1);
    t.quickClose(first);
    t.fullClose(Float32Array.from(first));
    await until(() => t.heard.length === 1);
    const second = speech(0.8, 99);
    t.quickClose(second);
    t.fullClose(Float32Array.from(second));
    await until(() => t.heard.length === 2);
    expect(t.decoded).toHaveLength(2);
    expect(t.heard[1]!.samples).toBe(second);
  });

  it('speech_end lets the next clip be recognized early', async () => {
    const t = setup();
    t.quickClose(speech(1));
    t.transport.emit('speechEnd', 'u1');
    t.quickClose(speech(0.8, 5));
    await until(() => t.words.length === 2);
    expect(t.decoded).toHaveLength(2);
  });

  it('a dropped clip has its recognition cancelled', async () => {
    const t = setup({ decodeMs: 40 });
    t.quickClose(speech(1));
    t.fullClose(speech(2)); // went on talking: the early clip is dropped at once
    await until(() => t.heard.length === 1);
    expect(t.cancelled).toHaveLength(1);
    expect(t.words).toHaveLength(0);
  });

  it('only says the words of a clip still in play', async () => {
    const t = setup({ decodeMs: 30 });
    t.quickClose(speech(1));
    t.fullClose(speech(2));
    await until(() => t.heard.length === 1);
    expect(t.words).toHaveLength(0);
  });

  it('coughs are not recognized early', () => {
    const t = setup();
    t.quickClose(speech(0.2));
    expect(t.decoded).toHaveLength(0);
  });

  it('speech_end starts both VADs over and drops what was early', async () => {
    const t = setup();
    t.quickClose(speech(1));
    await until(() => t.words.length === 1);
    t.transport.emit('speechEnd', 'u1');
    expect(t.p.quick.flushed).toBe(1);
    expect(t.words[0]!.signal.aborted).toBe(true);
  });

  it('someone leaving drops their early clip', async () => {
    const t = setup();
    t.quickClose(speech(1));
    await until(() => t.words.length === 1);
    t.transport.emit('membersChanged', new Set());
    expect(t.words[0]!.signal.aborted).toBe(true);
    expect(t.p.has('u1')).toBe(false);
  });

  it('judges when they started talking as heard will, from the full wait', async () => {
    const t = setup();
    const clip = speech(1);
    const before = performance.now();
    t.quickClose(clip);
    await until(() => t.words.length === 1);
    // full close ≈ now + 0.48 s; minus the 1 s clip
    expect(t.words[0]!.startedAt).toBeGreaterThanOrEqual(before + 480 - 1000 - 1);
    expect(t.words[0]!.startedAt).toBeLessThanOrEqual(performance.now() + 480 - 1000 + 1);
  });

  it('works without Smart Turn too', async () => {
    const t = setup({ turn: false });
    const clip = speech(1);
    t.quickClose(clip);
    t.fullClose(Float32Array.from(clip));
    await until(() => t.heard.length === 1);
    expect(t.decoded).toHaveLength(1);
    expect(t.heard[0]!.samples).toBe(clip);
  });

  it('while speech is held, the rest is not recognized alone: it will be joined', async () => {
    const probs = [0.2, 0.9];
    const t = setup({ turn: { holdMs: 500, detector: { complete: async () => probs.shift() ?? 0.9 } } });
    const first = speech(1);
    t.fullClose(first); // held: sounds unfinished
    await wait(20);
    const rest = speech(0.6, 5);
    t.quickClose(rest);
    await wait(20);
    expect(t.decoded).toHaveLength(1);
    t.fullClose(Float32Array.from(rest));
    await until(() => t.heard.length === 1);
    expect(t.words).toHaveLength(0);
    expect(t.heard[0]!.samples!.length).toBe(first.length + 4_000 + rest.length);
    expect(t.heard[0]!.text).toBe(`words ${first.length + 4_000 + rest.length}`);
    expect(t.heard[0]!.early).toBeUndefined();
  });

  it('a held clip whose words came early says so when released', async () => {
    const t = setup({ turn: { holdMs: 30, detector: { complete: async () => 0.2 } } });
    const clip = speech(1);
    t.quickClose(clip);
    t.fullClose(Float32Array.from(clip));
    await until(() => t.heard.length === 1);
    expect(t.decoded).toHaveLength(1);
    expect(t.heard[0]!.early).toBe(true);
  });

  it('side talk Smart Turn doubts is let go as soon as the check answers, since its words are already there', async () => {
    // Without early words, "talking again?" is asked when the decode ends; with them, when
    // Smart Turn answers. Speech that resumes in between is joined in one case, not the other.
    const turn = { holdMs: 500, detector: { complete: async () => 0.2 }, shouldHold: () => false };
    const run = async (early: boolean) => {
      const t = setup({ turn, decodeMs: 40, ...(early ? {} : { early: false as const }) });
      const clip = speech(1);
      if (early) {
        t.quickClose(clip);
        await wait(60); // its words are in before the full wait closes
      }
      t.fullClose(Float32Array.from(clip));
      await wait(10);
      t.p.vad.speaking = true; // they start talking again before a fresh decode would end
      await wait(80);
      return t.heard.length;
    };
    expect(await run(false)).toBe(0); // held, to be joined with what comes next
    expect(await run(true)).toBe(1); // released on its own
  });

  it('is off unless both waits are whole Silero windows', () => {
    // 1.0 s is 31.25 windows: the two VADs would cut the same speech apart
    const t = setup({ vadSilence: 1.0 });
    t.p.withQuick = false; // what user() builds is beside the point here
    expect((t.p as unknown as { early: unknown }).early).toBeUndefined();
    const u = setup({ early: { minSilence: 0.3 } });
    expect((u.p as unknown as { early: unknown }).early).toBeUndefined();
    const v = setup();
    expect((v.p as unknown as { early: unknown }).early).toBeDefined();
  });

  it('is off when the quick wait is not quicker', () => {
    const t = setup({ early: { minSilence: 0.8 } });
    expect((t.p as unknown as { early: unknown }).early).toBeUndefined();
  });
});
