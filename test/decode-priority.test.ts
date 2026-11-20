// One Parakeet serves every room. A PC's early decodes (recognizing during the
// silence wait) must not hold up a clip someone's waiting on: they go after
// every real clip that's waiting. One already running can't be stopped, so a
// real clip waits for at most that one.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { UserId, VoiceTransport, WakeDetector } from '../src/core/interfaces.js';
import { type HeardEvent, ListeningPipeline, type UserState } from '../src/listen/pipeline.js';

const DECODE_MS = 40;
/** Which clip lengths were decoded, in order. */
const ran: number[] = [];
vi.mock('sherpa-onnx-node', () => {
  class OfflineRecognizer {
    static async createAsync() {
      return new OfflineRecognizer();
    }
    createStream() {
      let n = 0;
      return {
        acceptWaveform: (w: { samples: Float32Array }) => void (n = w.samples.length),
        get n() {
          return n;
        },
      };
    }
    async decodeAsync(s: { n: number }) {
      ran.push(s.n);
      await new Promise((r) => setTimeout(r, DECODE_MS));
      return { text: `words ${s.n}` };
    }
  }
  class LinearResampler {
    resample(f: Float32Array) {
      return f;
    }
  }
  return { default: { OfflineRecognizer, LinearResampler, Vad: class {} } };
});

const { Downsampler, ParakeetStt } = await import('../src/speech/sherpa.js');
type SileroVad = import('../src/speech/sherpa.js').SileroVad;

class FakeVad {
  closing: Float32Array[] = [];
  accept() {
    return this.closing.splice(0);
  }
  flush() {
    return [];
  }
  isSpeaking() {
    return false;
  }
}

/** Each user gets their own pair of fake VADs. */
class TestPipeline extends ListeningPipeline {
  readonly vads = new Map<UserId, { vad: FakeVad; quick: FakeVad }>();
  protected override user(id: UserId): UserState {
    let u = this.users.get(id);
    if (!u) {
      const v = { vad: new FakeVad(), quick: new FakeVad() };
      this.vads.set(id, v);
      u = { down: new Downsampler(), vad: v.vad as unknown as SileroVad, ...(this.hasEarly ? { early: v.quick as unknown as SileroVad } : {}), epoch: 0 };
      this.users.set(id, u);
    }
    return u;
  }
  /** This person's VADs (made on first use). */
  vadsFor(id: UserId) {
    this.user(id);
    return this.vads.get(id)!;
  }
  get hasEarly() {
    return !!(this as unknown as { early: unknown }).early;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean, ms = 3_000) {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) await wait(2);
}
/** Clips of distinct lengths, so the decode order says whose they were. */
const clip = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.01 + n) * 0.3);

async function rig() {
  ran.length = 0;
  const stt = await ParakeetStt.load({ modelDir: 'x', threads: 1 });
  const wake = { match: (t: string) => ({ woke: true, remainder: t }) } as unknown as WakeDetector;
  const vad = { model: 'x', threshold: 0.5, minSilence: 0.8, minSpeech: 0.25, maxSpeech: 20 };
  const pcT = new EventEmitter();
  const callT = new EventEmitter();
  // The PC: early listen on, no Smart Turn (it would only add its own wait).
  const pc = new TestPipeline(pcT as unknown as VoiceTransport, stt, wake, vad, undefined, { minSilence: 0.32 });
  // Her Discord call: the normal pipeline.
  const call = new TestPipeline(callT as unknown as VoiceTransport, stt, wake, { ...vad, minSilence: 0.48 });
  const heard: HeardEvent[] = [];
  pc.on('heard', (e) => void heard.push(e));
  call.on('heard', (e) => void heard.push(e));
  const audio = (t: EventEmitter, id: string) => t.emit('audio', id, { samples: new Int16Array(0), receivedAt: performance.now() });
  return {
    heard,
    /** The PC's quick VAD closes a clip for this person. */
    pcQuick(id: string, s: Float32Array) {
      pc.vadsFor(id).quick.closing.push(s);
      audio(pcT, id);
    },
    pcFull(id: string, s: Float32Array) {
      pc.vadsFor(id).vad.closing.push(s);
      audio(pcT, id);
    },
    /** Someone in the call finishes a sentence. */
    callFull(id: string, s: Float32Array) {
      call.vadsFor(id).vad.closing.push(s);
      audio(callT, id);
    },
  };
}

describe('early decodes and the shared recognizer', () => {
  it("a call clip goes before PC early decodes that are waiting, behind at most the one running", async () => {
    const r = await rig();
    // Three PC users pause mid-speech at once: three early decodes, the first starts.
    r.pcQuick('p1', clip(16_001));
    r.pcQuick('p2', clip(16_002));
    r.pcQuick('p3', clip(16_003));
    await wait(5);
    r.callFull('d1', clip(24_000));
    await until(() => r.heard.length === 1);
    expect(r.heard[0]!.userId).toBe('d1');
    // only the early decode already running was ahead of it
    expect(ran.slice(0, 2)).toEqual([16_001, 24_000]);
    expect(r.heard[0]!.sttLatencyMs).toBeLessThan(2 * DECODE_MS + 30);
    await until(() => ran.length === 4);
    expect(ran).toEqual([16_001, 24_000, 16_002, 16_003]);
  });

  it("once the full wait closes the same clip, the PC's decode is a real one, in its place from when it was handed in", async () => {
    const r = await rig();
    r.callFull('d1', clip(24_001)); // running
    await wait(5);
    const mine = clip(16_001);
    r.pcQuick('p1', mine); // waits, behind call clips
    r.callFull('d2', clip(24_002));
    r.pcFull('p1', Float32Array.from(mine)); // the same audio: now someone waits on it
    r.callFull('d3', clip(24_003));
    await until(() => ran.length === 4 && r.heard.length === 4);
    // p1 was handed in before d2 and d3, and someone is waiting on it now
    expect(ran).toEqual([24_001, 16_001, 24_002, 24_003]);
    expect(r.heard.find((e) => e.userId === 'p1')!.early).toBe(true);
  });

  it('a dropped early clip leaves the queue at once and never decodes', async () => {
    const r = await rig();
    r.callFull('d1', clip(24_001)); // running
    await wait(5);
    r.pcQuick('p1', clip(16_001));
    r.pcFull('p1', clip(30_000)); // they went on talking: the early clip is dropped
    await until(() => r.heard.length === 2);
    expect(ran).toEqual([24_001, 30_000]);
  });
});

describe('DecodeQueue', () => {
  it('runs one at a time in order, background last, and a job cancelled while waiting leaves at once', async () => {
    const { DecodeQueue } = await import('../src/speech/decode-queue.js');
    const q = new DecodeQueue();
    const order: string[] = [];
    const job = (name: string, ms = 10) => async () => {
      order.push(`${name}+`);
      await wait(ms);
      order.push(`${name}-`);
      return name;
    };
    const ctl = new AbortController();
    const a = q.run(job('a'));
    const bg = q.run(job('bg'), undefined, { background: () => true });
    const b = q.run(job('b'));
    const gone = q.run(job('gone'), ctl.signal);
    const c = q.run(job('c'));
    ctl.abort();
    await expect(gone).rejects.toThrow('cancelled');
    expect(q.length).toBe(3); // bg, b, c: the cancelled one left before its turn
    expect(await Promise.all([a, b, c, bg])).toEqual(['a', 'b', 'c', 'bg']);
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-', 'bg+', 'bg-']);
    await expect(q.run(job('late'), ctl.signal)).rejects.toThrow('cancelled');
  });

  it('a failing job does not stop the queue', async () => {
    const { DecodeQueue } = await import('../src/speech/decode-queue.js');
    const q = new DecodeQueue();
    const bad = q.run(async () => {
      throw new Error('boom');
    });
    const good = q.run(async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    expect(await good).toBe('ok');
  });
});
