// The cloud voice and its local stand-in: the local voice starts loading at the
// first sign of trouble (and never while the cloud works), and a stream that
// stalls mid-sentence is a gap up to STALL_MS, then a cut.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechPiece, TextToSpeech } from '../src/core/interfaces.js';
import { CAP_DUE_MS, CharBudget, LOW_CHARS, SLOW_MS, SpeechifyTts, STALL_MS } from '../src/speech/speechify.js';

const RATE = 24_000;
const LONG = 'This sentence is long enough that it is streamed, not cached.';

/** Half a second of tone as 16-bit PCM. */
function tone(seconds = 0.5): Buffer {
  const n = Math.round(seconds * RATE);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return b;
}

/** Resolves after ms, or rejects when the request is aborted (as fetch does). */
const later = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** A Speechify stand-in. Each sentence: wait `firstMs` for the answer, then
 *  pieces each after its own delay. The calibration line answers at once. */
function api(o: { status?: number; firstMs?: number; pieces?: { afterMs: number; seconds: number }[] } = {}) {
  const calls: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const input = String(JSON.parse(String(init.body)).input);
    calls.push(input);
    if (input.startsWith('Sure,')) return new Response(tone(2), { status: 200 });
    if (o.status) return new Response('nope', { status: o.status });
    if (o.firstMs) await later(o.firstMs, init.signal);
    const plan = o.pieces ?? [{ afterMs: 0, seconds: 0.5 }];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i >= plan.length) return c.close();
        const p = plan[i++]!;
        if (p.afterMs) await later(p.afterMs, init.signal);
        c.enqueue(new Uint8Array(tone(p.seconds)));
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function rig(f: typeof fetch, o: { monthlyChars?: number; used?: number; prepareFails?: boolean } = {}) {
  const lines: string[] = [];
  const log = { info: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(m) };
  const prepared: [string, number][] = [];
  const local: TextToSpeech & { said: string[]; prepare(v: string, s: number): Promise<void> } = {
    said: [],
    async synthesize(text) {
      this.said.push(text);
      return { samples: new Float32Array(2_400).fill(0.1), sampleRate: RATE, synthMs: 1 };
    },
    async prepare(v, s) {
      prepared.push([v, s]);
      if (o.prepareFails) throw new Error('Failed to create OfflineTts');
    },
  };
  const budget = new CharBudget(undefined, o.monthlyChars ?? 0, 'UTC');
  if (o.used) budget.add(o.used);
  const tts = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.5', timeoutMs: 4000, budget, log, fetch: f, now: () => performance.now() }, local, 'af_heart');
  return { tts, local, prepared, lines };
}

async function collect(it: AsyncIterable<SpeechPiece>) {
  const out: SpeechPiece[] = [];
  for await (const p of it) out.push(p);
  return out;
}
const seconds = (ps: SpeechPiece[]) => ps.reduce((n, p) => n + p.samples.length, 0) / RATE;

beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => void vi.useRealTimers());

/** Run a stream to its end while the fake clock moves on. */
async function drain(it: AsyncIterable<SpeechPiece>, stepMs = 50, maxMs = 20_000) {
  let done = false;
  let out: SpeechPiece[] = [];
  let err: unknown;
  void collect(it).then(
    (r) => ((out = r), (done = true)),
    (e) => ((err = e), (done = true)),
  );
  for (let t = 0; !done && t < maxMs; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (err) throw err;
  return out;
}

describe('the local voice loads at the first sign of trouble', () => {
  it('never while the cloud voice works: long lines, short lines, warm-ups', async () => {
    const r = rig(api().f);
    await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    await drain(r.tts.stream('Yes?', { voice: 'cloud:en', speed: 1 }));
    await r.tts.warmIfIdle();
    expect(r.prepared).toEqual([]);
    expect(r.local.said).toEqual([]);
  });

  it('when the cloud fails, once, for the voice and speed it will stand in with', async () => {
    const r = rig(api({ status: 503 }).f);
    await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1.1 }));
    await drain(r.tts.stream(`${LONG} Again.`, { voice: 'cloud:en', speed: 1.1 }));
    expect(r.prepared).toEqual([['af_heart', 1.1]]);
    expect(r.local.said).toHaveLength(2);
  });

  it('when a warm-up fails: someone is talking, before any answer', async () => {
    const r = rig(api({ status: 429 }).f);
    await r.tts.warmIfIdle();
    expect(r.prepared).toHaveLength(1);
    expect(r.lines).toContain('loading the local voice in case the cloud voice fails');
  });

  it('when no audio has come after SLOW_MS, while the request keeps going', async () => {
    const r = rig(api({ firstMs: SLOW_MS + 600 }).f);
    let heardAt = -1;
    const t0 = performance.now();
    const p = (async () => {
      for await (const _ of r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 })) if (heardAt < 0) heardAt = performance.now() - t0;
    })();
    await vi.advanceTimersByTimeAsync(SLOW_MS - 50);
    expect(r.prepared).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.prepared).toHaveLength(1); // loading while the cloud is still on its way
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(heardAt).toBeGreaterThanOrEqual(SLOW_MS + 600);
    expect(r.local.said).toEqual([]); // and the cloud still said it
  });

  it('when the month is nearly spent', async () => {
    const r = rig(api().f, { monthlyChars: 100_000, used: 100_000 - LOW_CHARS + 1 });
    await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(r.prepared).toHaveLength(1);
    expect(r.local.said).toEqual([]);
  });

  it('a load that fails is logged, never thrown, and the next sign of trouble tries again', async () => {
    const r = rig(api({ status: 503 }).f, { prepareFails: true });
    await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.lines).toContain('local voice failed to load');
    await vi.advanceTimersByTimeAsync(61_000); // past the cloud's pause
    await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(r.prepared).toHaveLength(2);
  });
});

describe('a stream that stalls mid-sentence', () => {
  const plan = (gapMs: number) => [
    { afterMs: 0, seconds: 0.5 },
    { afterMs: gapMs, seconds: 0.5 },
    { afterMs: 0, seconds: 0.5 },
  ];

  it('a gap shorter than STALL_MS is only a gap: the whole sentence comes', async () => {
    const r = rig(api({ pieces: plan(STALL_MS - 300) }).f);
    const out = await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(seconds(out)).toBeCloseTo(1.5, 2);
    expect(r.lines).not.toContain('cloud voice broke off mid-sentence; local voice for a minute');
    expect(r.prepared).toHaveLength(STALL_MS - 300 > SLOW_MS ? 1 : 0); // loaded in case only past SLOW_MS
  });

  it('a longer one cuts the sentence at STALL_MS, not at the 4 s first-audio limit, and pauses the cloud', async () => {
    const r = rig(api({ pieces: plan(10_000) }).f);
    const t0 = performance.now();
    const out = await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    const tookMs = performance.now() - t0;
    expect(seconds(out)).toBeLessThan(0.6); // what came before the gap
    expect(tookMs).toBeGreaterThanOrEqual(STALL_MS);
    expect(tookMs).toBeLessThan(STALL_MS + 500);
    expect(r.lines).toContain('cloud voice broke off mid-sentence; local voice for a minute');
    expect(r.local.said).toEqual([]); // the rest isn't said again from the start
    // The next sentence is the local voice's, which started loading by the cut.
    expect(r.prepared).toHaveLength(1);
    await drain(r.tts.stream(`${LONG} Next.`, { voice: 'cloud:en', speed: 1 }));
    expect(r.local.said).toEqual([`${LONG} Next.`]);
  });

  it('the first audio still gets the full timeoutMs: nothing has been heard yet', async () => {
    const r = rig(api({ firstMs: 3_000 }).f);
    const out = await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(seconds(out)).toBeCloseTo(0.5, 2);
    expect(r.local.said).toEqual([]);
  });

  it('past timeoutMs without first audio it falls back for the sentence', async () => {
    const r = rig(api({ firstMs: 5_000 }).f);
    await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(r.local.said).toEqual([LONG]);
    expect(r.lines).toContain('cloud voice failed; local voice for a minute');
  });
});

describe('the held part of a sentence (past the free 0.6 s)', () => {
  it('still plays when the body breaks after it arrived', async () => {
    const f = (async (_url: string, init: RequestInit) => {
      const input = String(JSON.parse(String(init.body)).input);
      if (input.startsWith('Sure,')) return new Response(tone(2), { status: 200 });
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (i++ === 0) return c.enqueue(new Uint8Array(tone(1)));
          await later(10, init.signal);
          c.error(new TypeError('terminated', { cause: new Error('other side closed') }));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const r = rig(f);
    const out = await drain(r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(seconds(out)).toBeCloseTo(1, 1); // all of it, not just the free 0.6 s
    expect(r.lines).toContain('cloud voice broke off mid-sentence; local voice for a minute');
  });

  it('goes out uncapped by CAP_DUE_MS when the rest of the sentence is late', async () => {
    const r = rig(api({ pieces: [{ afterMs: 0, seconds: 1 }, { afterMs: 1_500, seconds: 0.5 }] }).f);
    const got: { at: number; s: number }[] = [];
    const t0 = performance.now();
    const p = (async () => {
      for await (const piece of r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 })) got.push({ at: performance.now() - t0, s: piece.samples.length / RATE });
    })();
    await vi.advanceTimersByTimeAsync(CAP_DUE_MS + 50);
    const early = got.reduce((n, x) => n + x.s, 0);
    expect(early).toBeCloseTo(1, 1); // the free 0.6 s and the held 0.4 s, before the late piece
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    expect(got.reduce((n, x) => n + x.s, 0)).toBeCloseTo(1.5, 1);
  });
});

describe('a caller that stops early', () => {
  it('closes the response body, as for await did, and leaves nothing unhandled', async () => {
    let cancelled = false;
    const f = (async (_url: string, init: RequestInit) => {
      const input = String(JSON.parse(String(init.body)).input);
      if (input.startsWith('Sure,')) return new Response(tone(2), { status: 200 });
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (i++ > 0) await later(5_000, init.signal); // the rest is slow
          c.enqueue(new Uint8Array(tone(1)));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const r = rig(f);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const done = (async () => {
        for await (const _ of r.tts.stream(LONG, { voice: 'cloud:en', speed: 1 })) break; // the free 0.6 s, then stop
      })();
      await vi.advanceTimersByTimeAsync(100);
      await done;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(cancelled).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
