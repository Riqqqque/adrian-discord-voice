// Streamed sentences get levelChunk's cap on hot sentences: the first stretch
// plays at once, the rest waits for the whole sentence (it arrives far faster
// than it plays), and a sentence that isn't hot is untouched.
import { describe, expect, it } from 'vitest';
import { integratedLoudness, StreamCap, StreamLimiter } from '../src/audio/loudness.js';
import { levelChunk, MAX_OVER_LU, TARGET_LUFS } from '../src/speech/kokoro.js';

const RATE = 24_000;
const MAX = TARGET_LUFS + MAX_OVER_LU;

/** Speech-like audio: syllable bursts of a few tones, `level` sets loudness. */
function speech(seconds: number, level: number, seed = 1): Float32Array {
  const x = new Float32Array(Math.round(seconds * RATE));
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const f = [180 + 60 * rnd(), 400 + 200 * rnd(), 1200 + 600 * rnd()];
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    const syl = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2;
    const s = Math.sin(2 * Math.PI * f[0]! * t) + 0.5 * Math.sin(2 * Math.PI * f[1]! * t) + 0.25 * Math.sin(2 * Math.PI * f[2]! * t);
    x[i] = level * syl * s * 0.5 + 0.0002 * (rnd() - 0.5);
  }
  return x;
}

function cat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/** Push x in pieces of the given sizes (cycled), optionally release() after a
 *  piece, then end(). */
function run(lim: StreamLimiter, x: Float32Array, sizes: number[], releaseAfter = -1) {
  const parts: Float32Array[] = [];
  for (let off = 0, k = 0; off < x.length; k++) {
    const n = sizes[k % sizes.length]!;
    parts.push(lim.push(x.subarray(off, off + n)));
    off += n;
    if (k === releaseAfter) parts.push((lim as StreamCap).release());
  }
  const firstOut = parts[0]!.length;
  parts.push(lim.end());
  return { out: cat(...parts), firstOut };
}

/** Index of the first sample that differs, or -1 if identical (fast, unlike toEqual on big arrays). */
function firstDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

const gainFor = (x: Float32Array, lufs: number) => lufs - integratedLoudness(x, RATE);
const cap = (gain: number, freeS?: number) => new StreamCap(RATE, gain, -2, { maxLufs: MAX, ...(freeS ? { freeS } : {}) });
const plain = (gain: number) => new StreamLimiter(RATE, gain, -2);

describe('stream cap', () => {
  it('leaves a sentence that is not hot sample for sample as it was, even one that starts loud', () => {
    // Sabrina's sentences open louder than they go on: an estimate from the
    // start would turn most of them down. Here the opening is far over the
    // cap while the whole sentence is under it.
    const frontLoaded = cat(speech(0.8, 0.6, 3), speech(2.6, 0.2, 3));
    const cases = [frontLoaded, speech(3, 0.3, 1), speech(4, 0.3, 2)];
    for (const x of cases) {
      for (const whole of [-19.01, MAX - 0.2]) {
        const gain = gainFor(x, whole);
        for (const sizes of [[4096, 1001], [7, 338], [100_000]]) {
          const c = cap(gain);
          expect(firstDiff(run(c, x, sizes).out, run(plain(gain), x, sizes).out)).toBe(-1);
          expect(c.cutDb).toBe(0);
        }
      }
    }
  });

  it('caps a hot sentence where levelChunk puts it, give or take its first 0.6 s', () => {
    for (const over of [0.1, 0.45, 1, 3]) {
      for (const seed of [1, 4]) {
        const x = speech(3.5, 0.3, seed);
        const gain = gainFor(x, MAX + over);
        const c = cap(gain);
        const got = integratedLoudness(run(c, x, [1250]).out, RATE) - MAX;
        const whole = integratedLoudness(levelChunk(x, RATE, gain), RATE) - MAX;
        expect(Math.abs(whole)).toBeLessThan(0.02);
        expect(c.cutDb).toBeCloseTo(over, 1);
        // The free 0.6 s of 3.5 s play at the old gain.
        expect(got).toBeGreaterThan(-0.02);
        expect(got).toBeLessThan(over * 0.25 + 0.02);
      }
    }
  });

  it('first audio is the same as without the cap: the free stretch goes out as it comes', () => {
    const x = speech(3, 0.3, 2);
    const gain = gainFor(x, MAX + 1);
    for (const first of [480, 4800, 14_400]) {
      expect(run(cap(gain), x, [first, 1250]).firstOut).toBe(run(plain(gain), x, [first, 1250]).firstOut);
    }
    // Nothing past the free stretch comes out before end().
    const c = cap(gain);
    let n = 0;
    for (let off = 0; off < x.length; off += 1250) n += c.push(x.subarray(off, off + 1250)).length;
    expect(n).toBeLessThanOrEqual(0.6 * RATE);
    expect(c.holding).toBe(true);
  });

  it('gives the same samples however the audio arrives', () => {
    const x = speech(3, 0.3, 5);
    const gain = gainFor(x, MAX + 2);
    const a = run(cap(gain), x, [1]).out;
    for (const sizes of [[3, 338, 7, 4096, 1001], [2400], [100_000]]) expect(firstDiff(run(cap(gain), x, sizes).out, a)).toBe(-1);
  });

  it('released before the sentence is in, the rest plays uncapped: as streaming did before', () => {
    const x = speech(3, 0.3, 6);
    const gain = gainFor(x, MAX + 2);
    const c = cap(gain);
    const got = run(c, x, [1250], 20); // 20 pieces in = 1.05 s: past the free stretch
    expect(firstDiff(got.out, run(plain(gain), x, [1250]).out)).toBe(-1);
    expect(c.cutDb).toBe(0);
  });

  it('turns the gain down over a short ramp, never in a step', () => {
    // Quiet enough that the peak limiter never acts, so out/in is the gain.
    const x = speech(3, 0.02, 7);
    const gain = gainFor(x, MAX + 4);
    const c = new StreamCap(RATE, gain, 40, { maxLufs: MAX });
    const out = run(c, x, [1250]).out;
    let worst = 0;
    for (let i = 1; i < x.length; i++) {
      if (Math.abs(x[i]!) < 1e-3 || Math.abs(x[i - 1]!) < 1e-3) continue;
      worst = Math.max(worst, Math.abs(20 * Math.log10(out[i]! / x[i]!) - 20 * Math.log10(out[i - 1]! / x[i - 1]!)));
    }
    // 4 dB over 50 ms is 0.0033 dB a sample; the rest is float32 rounding.
    expect(worst).toBeLessThan(0.005);
    expect(c.cutDb).toBeCloseTo(4, 1);
  });
});
