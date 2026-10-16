// Loudness measurement (ITU-R BS.1770-4: K-weighting, 400 ms blocks,
// absolute and relative gating) and a peak limiter, so every sound the bot
// plays lands near −16 LUFS with peaks under −1 dBTP (brief: audio safety).

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** K-weighting filter coefficients for a sample rate (bilinear transform of
 *  the BS.1770 analog prototypes, as in pyloudnorm). */
function kWeighting(rate: number): [Biquad, Biquad] {
  // Stage 1: high-shelf, +4 dB above ~1.5 kHz.
  let G = 3.999843853973347;
  let fc = 1681.974450955533;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * fc) / rate);
  let Vh = 10 ** (G / 20);
  let Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high-pass at ~38 Hz.
  G = 0;
  fc = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * fc) / rate);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  void G;
  return [shelf, hp];
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    const o = f.b0 * v + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = o;
    y[i] = o;
  }
  return y;
}

/** Integrated loudness of mono float audio, LUFS (−Infinity if silent or
 *  shorter than one 400 ms block). */
export function integratedLoudness(x: Float32Array, rate: number): number {
  const [s1, s2] = kWeighting(rate);
  const y = filter(filter(x, s1), s2);
  const block = Math.round(0.4 * rate);
  const step = Math.round(0.1 * rate); // 75% overlap
  const ms: number[] = [];
  for (let start = 0; start + block <= y.length; start += step) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += y[i]! * y[i]!;
    ms.push(sum / block);
  }
  const lufs = (m: number) => -0.691 + 10 * Math.log10(m);
  const abs = ms.filter((m) => lufs(m) > -70);
  if (!abs.length) return -Infinity;
  const relGate = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((m) => lufs(m) > relGate);
  if (!rel.length) return -Infinity;
  return lufs(rel.reduce((a, b) => a + b, 0) / rel.length);
}

export function peakDbfs(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p === 0 ? -Infinity : 20 * Math.log10(p);
}

/** Apply `gainDb`, then a look-ahead peak limiter at `ceilingDb` (sample
 *  peak). Callers pick a ceiling ~1 dB under the true-peak target, since
 *  inter-sample peaks can exceed sample peaks after resampling. */
export function gainAndLimit(x: Float32Array, rate: number, gainDb: number, ceilingDb = -2): Float32Array {
  const g = 10 ** (gainDb / 20);
  const ceil = 10 ** (ceilingDb / 20);
  const look = Math.max(1, Math.round(0.002 * rate)); // 2 ms look-ahead
  const releasePerSample = 1 - Math.exp(-1 / (0.05 * rate)); // ~50 ms release
  const n = x.length;
  // Required gain reduction per sample, then a running minimum over the
  // look-ahead window so reduction starts before the peak arrives.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]! * g);
    need[i] = a > ceil ? ceil / a : 1;
  }
  const out = new Float32Array(n);
  let env = 1;
  for (let i = 0; i < n; i++) {
    let target = 1;
    for (let j = i; j < Math.min(n, i + look); j++) target = Math.min(target, need[j]!);
    env = target < env ? target : env + (target - env) * releasePerSample;
    let v = x[i]! * g * env;
    if (v > ceil) v = ceil;
    else if (v < -ceil) v = -ceil;
    out[i] = v;
  }
  return out;
}
