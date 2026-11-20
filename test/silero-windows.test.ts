// SileroVad hands sherpa one 512-sample window per call, however the audio is
// framed. sherpa ends a segment where the call that heard the last silent
// window ends, so with bigger calls the cut moves with the framing, and two
// VADs with different waits cut the same speech apart (see EarlyOptions).
import { describe, expect, it, vi } from 'vitest';

const calls: number[] = [];
vi.mock('sherpa-onnx-node', () => {
  class Vad {
    acceptWaveform(s: Float32Array) {
      calls.push(s.length);
    }
    isEmpty() {
      return true;
    }
    isDetected() {
      return false;
    }
    flush() {}
    reset() {}
  }
  return { default: { Vad, LinearResampler: class {} } };
});

const { SileroVad } = await import('../src/speech/sherpa.js');

const vadOpts = { model: 'x', threshold: 0.5, minSilence: 0.8, minSpeech: 0.25, maxSpeech: 20 };

describe('SileroVad framing', () => {
  it('feeds whole windows only, whatever the frame size, and keeps every sample in order', () => {
    calls.length = 0;
    const v = new SileroVad(vadOpts);
    let seed = 3;
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const n = 50 + ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 3000);
      v.accept(new Float32Array(n));
      total += n;
    }
    expect(calls.every((n) => n === 512)).toBe(true);
    expect(calls.length).toBe(Math.floor(total / 512));
  });

  it('20 ms frames: one window per call, as before', () => {
    calls.length = 0;
    const v = new SileroVad(vadOpts);
    for (let i = 0; i < 100; i++) v.accept(new Float32Array(320));
    expect(calls).toEqual(Array(62).fill(512));
  });

  it('hands over the part window before a flush, and a reset forgets it', () => {
    calls.length = 0;
    const v = new SileroVad(vadOpts);
    v.accept(new Float32Array(700));
    expect(calls).toEqual([512]);
    v.flush(); // sherpa keeps a part window to itself, as it did when frames went in whole
    expect(calls).toEqual([512, 188]);
    v.accept(new Float32Array(400));
    v.reset();
    v.accept(new Float32Array(200));
    expect(calls).toEqual([512, 188]); // nothing left over from before the reset
    v.accept(new Float32Array(312));
    expect(calls).toEqual([512, 188, 512]);
  });
});
