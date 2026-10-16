// Small PCM helpers. Discord gives 48 kHz interleaved stereo s16; the speech
// models want 16 kHz mono.

/** Interleaved stereo s16 → mono s16 (average of channels). */
export function downmixStereo(interleaved: Int16Array): Int16Array {
  const out = new Int16Array(interleaved.length >> 1);
  for (let i = 0, j = 0; j < out.length; i += 2, j++) {
    out[j] = ((interleaved[i]! + interleaved[i + 1]!) / 2) | 0;
  }
  return out;
}

/** 48 kHz → 16 kHz by averaging each group of 3 samples (a crude low-pass
 *  that's adequate for speech; replace with a proper filter if ASR accuracy
 *  suffers in milestone 3). */
export function decimate48kTo16k(samples: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(samples.length / 3));
  for (let i = 0, j = 0; j < out.length; i += 3, j++) {
    out[j] = ((samples[i]! + samples[i + 1]! + samples[i + 2]!) / 3) | 0;
  }
  return out;
}

/** RMS level in dBFS (−Infinity for digital silence). */
export function rmsDbfs(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

/** View a Node Buffer of s16le PCM as Int16Array without copying when aligned. */
export function bufferToInt16(buf: Buffer): Int16Array {
  if (buf.byteOffset % 2 === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  }
  const copy = Buffer.from(buf);
  return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength >> 1);
}
