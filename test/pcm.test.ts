import { describe, expect, it } from 'vitest';
import { bufferToInt16, decimate48kTo16k, downmixStereo, rmsDbfs } from '../src/audio/pcm.js';

describe('pcm helpers', () => {
  it('downmixes interleaved stereo by averaging', () => {
    expect([...downmixStereo(Int16Array.from([100, 300, -200, 200, 32767, 32767]))]).toEqual([200, 0, 32767]);
  });

  it('decimates 48 kHz to 16 kHz', () => {
    const out = decimate48kTo16k(Int16Array.from([3, 6, 9, 30, 30, 30, 1]));
    expect([...out]).toEqual([6, 30]);
  });

  it('measures RMS in dBFS', () => {
    expect(rmsDbfs(new Int16Array(10))).toBe(-Infinity);
    const full = Int16Array.from({ length: 480 }, (_, i) => (i % 2 ? 32767 : -32768));
    expect(rmsDbfs(full)).toBeCloseTo(0, 1);
    const half = Int16Array.from({ length: 480 }, (_, i) => (i % 2 ? 16384 : -16384));
    expect(rmsDbfs(half)).toBeCloseTo(-6.02, 1);
  });

  it('views odd-aligned buffers safely', () => {
    const backing = Buffer.alloc(9);
    const odd = backing.subarray(1, 9);
    odd.writeInt16LE(1234, 0);
    odd.writeInt16LE(-5, 6);
    const v = bufferToInt16(odd);
    expect([...v]).toEqual([1234, 0, 0, -5]);
  });
});

describe('chunk joins', () => {
  it('trims padding but keeps a short margin', async () => {
    const { trimSilence } = await import('../src/audio/pauses.js');
    const rate = 24_000;
    const x = new Float32Array(rate); // 1 s: 0.3 s silence, 0.4 s tone, 0.3 s silence
    for (let i = 0.3 * rate; i < 0.7 * rate; i++) x[i] = 0.3 * Math.sin(i / 5);
    const y = trimSilence(x, rate);
    expect(y.length / rate).toBeGreaterThan(0.4);
    expect(y.length / rate).toBeLessThan(0.48);
    expect(trimSilence(new Float32Array(rate), rate).length).toBe(0);
  });

  it('pauses longer after sentences than after clauses', async () => {
    const { pauseAfter } = await import('../src/audio/pauses.js');
    expect(pauseAfter('Right now.')).toBeGreaterThan(pauseAfter('so grab a jacket,'));
    expect(pauseAfter('Really?')).toBeGreaterThanOrEqual(pauseAfter('Right now.'));
    expect(pauseAfter('and then the')).toBeLessThan(pauseAfter('so grab a jacket,'));
  });
});
