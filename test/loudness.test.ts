import { describe, expect, it } from 'vitest';
import { gainAndLimit, integratedLoudness, peakDbfs } from '../src/audio/loudness.js';

const sine = (freq: number, amp: number, seconds: number, rate: number) =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

describe('BS.1770 loudness', () => {
  // Reference: a full-scale 1 kHz sine, mono, reads −3.01 LUFS.
  for (const rate of [24_000, 48_000]) {
    it(`matches the 1 kHz reference at ${rate} Hz`, () => {
      expect(integratedLoudness(sine(1000, 1, 3, rate), rate)).toBeCloseTo(-3.01, 1);
      expect(integratedLoudness(sine(1000, 0.1, 3, rate), rate)).toBeCloseTo(-23.01, 1);
    });
  }

  it('gates out silence', () => {
    const rate = 24_000;
    const x = new Float32Array(rate * 4);
    x.set(sine(1000, 0.1, 2, rate), rate);
    // Blocks straddling the tone edges pass both gates and pull it ~0.6 LU lower.
    expect(Math.abs(integratedLoudness(x, rate) + 23.01)).toBeLessThan(1);
    expect(integratedLoudness(new Float32Array(rate * 2), rate)).toBe(-Infinity);
  });
});

describe('gain and limiter', () => {
  it('applies gain and keeps peaks under the ceiling', () => {
    const rate = 24_000;
    const x = sine(440, 0.5, 1, rate);
    const y = gainAndLimit(x, rate, 12, -2); // would peak at about +6 dBFS
    expect(peakDbfs(y)).toBeLessThanOrEqual(-2 + 1e-6);
    // Quiet input is just gained, not limited.
    const q = gainAndLimit(sine(440, 0.01, 1, rate), rate, 6, -2);
    expect(peakDbfs(q)).toBeCloseTo(20 * Math.log10(0.01 * 10 ** (6 / 20)), 1);
  });
});
