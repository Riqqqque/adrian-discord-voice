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

/** gainAndLimit for audio that arrives in pieces: the same output, sample for
 *  sample, as running gainAndLimit on all of it at once. Holds back the 2 ms
 *  look-ahead until the next piece (or end()) shows what follows. */
export class StreamLimiter {
  protected readonly g: number;
  private readonly ceil: number;
  private readonly look: number;
  private readonly releasePerSample: number;
  private env = 1;
  /** Input not yet output (the look-ahead), with its gain applied (in double,
   *  as gainAndLimit computes x * g * env), and its required reduction. */
  private held = new Float64Array(0);
  private need = new Float32Array(0);

  constructor(rate: number, gainDb: number, ceilingDb = -2) {
    this.g = 10 ** (gainDb / 20);
    this.ceil = 10 ** (ceilingDb / 20);
    this.look = Math.max(1, Math.round(0.002 * rate));
    this.releasePerSample = 1 - Math.exp(-1 / (0.05 * rate));
  }

  push(x: Float32Array): Float32Array {
    return this.pushWithGains(x);
  }

  /** push(), with a linear gain per sample instead of the fixed one. */
  protected pushWithGains(x: Float32Array, gains?: Float64Array): Float32Array {
    const k = this.held.length;
    const held = new Float64Array(k + x.length);
    held.set(this.held);
    for (let i = 0; i < x.length; i++) held[k + i] = x[i]! * (gains ? gains[i]! : this.g);
    const need = new Float32Array(held.length);
    need.set(this.need);
    for (let i = k; i < held.length; i++) {
      const a = Math.abs(held[i]!);
      need[i] = a > this.ceil ? this.ceil / a : 1;
    }
    // A sample is final once its whole look-ahead window has arrived.
    const ready = Math.max(0, held.length - this.look + 1);
    const out = this.run(held, need, ready, held.length);
    this.held = held.subarray(ready);
    this.need = need.subarray(ready);
    return out;
  }

  /** The held tail, now that nothing follows it. */
  end(): Float32Array {
    const out = this.run(this.held, this.need, this.held.length, this.held.length);
    this.held = new Float64Array(0);
    this.need = new Float32Array(0);
    return out;
  }

  private run(x: Float64Array, need: Float32Array, count: number, n: number): Float32Array {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let target = 1;
      for (let j = i; j < Math.min(n, i + this.look); j++) target = Math.min(target, need[j]!);
      this.env = target < this.env ? target : this.env + (target - this.env) * this.releasePerSample;
      let v = x[i]! * this.env;
      if (v > this.ceil) v = this.ceil;
      else if (v < -this.ceil) v = -this.ceil;
      out[i] = v;
    }
    return out;
  }
}

export interface StreamCapOptions {
  /** The loudest a sentence may land, LUFS (levelChunk's target + MAX_OVER_LU). */
  maxLufs: number;
  /** Audio that goes out at once at the calibrated gain, s (default 0.6). */
  freeS?: number;
  /** Ramp from the calibrated gain to the capped one, s (default 0.05). */
  rampS?: number;
}

/** levelChunk's whole-sentence cap for audio played as it arrives. The first
 *  freeS seconds go out at once at the calibrated gain, so first audio is as
 *  early as without the cap. The rest is held until the sentence is complete
 *  (end()), then gets the cap measured on the whole sentence, as levelChunk
 *  does, reached with a short ramp. Speechify sends a sentence about 30 times
 *  faster than it plays, so all of it is normally in long before the held
 *  part is due. If the caller says it's due first (release()), it goes out
 *  uncapped, as does the rest of the sentence: what streaming did before.
 *  A sentence that isn't hot comes out sample for sample as StreamLimiter's. */
export class StreamCap extends StreamLimiter {
  private readonly baseDb: number;
  private readonly freeN: number;
  private readonly rampN: number;
  private readonly all: Float32Array[] = [];
  private waiting: Float32Array[] = [];
  private sent = 0;
  private mode: 'free' | 'hold' | 'open' | 'done' = 'free';
  /** How far the held part was turned down, dB (0 if the sentence wasn't hot or wasn't held). */
  cutDb = 0;

  constructor(
    private readonly rate: number,
    gainDb: number,
    ceilingDb: number,
    private readonly o: StreamCapOptions,
  ) {
    super(rate, gainDb, ceilingDb);
    this.baseDb = gainDb;
    this.freeN = Math.round((o.freeS ?? 0.6) * rate);
    this.rampN = Math.max(1, Math.round((o.rampS ?? 0.05) * rate));
  }

  /** Audio is being held until end() or release(). */
  get holding(): boolean {
    return this.mode === 'hold' && this.waiting.length > 0;
  }

  override push(x: Float32Array): Float32Array {
    if (this.mode === 'done') return new Float32Array(0);
    this.all.push(x);
    if (this.mode === 'open') return super.push(x);
    let now = x;
    if (this.mode === 'free') {
      const take = Math.min(x.length, this.freeN - this.sent);
      now = x.subarray(0, take);
      this.sent += take;
      if (take < x.length) {
        this.mode = 'hold';
        this.waiting.push(x.subarray(take));
      }
    } else {
      this.waiting.push(x);
      now = new Float32Array(0);
    }
    return super.push(now);
  }

  /** The held part is due before the sentence is complete: out it goes,
   *  uncapped, and so does everything after it. */
  release(): Float32Array {
    if (this.mode === 'done' || this.mode === 'open') return new Float32Array(0);
    this.mode = 'open';
    const held = concat(this.waiting);
    this.waiting = [];
    return super.push(held);
  }

  /** The whole sentence is in: the held part with the cap, then the limiter's tail. */
  override end(): Float32Array {
    if (this.mode === 'done') return new Float32Array(0);
    let out: Float32Array = new Float32Array(0);
    if (this.mode !== 'open' && this.waiting.length) {
      const held = concat(this.waiting);
      this.waiting = [];
      const l = integratedLoudness(concat(this.all), this.rate);
      this.cutDb = Number.isFinite(l) ? Math.max(0, this.baseDb - (this.o.maxLufs - l)) : 0;
      if (this.cutDb === 0) out = super.push(held);
      else {
        const g = new Float64Array(held.length);
        for (let i = 0; i < g.length; i++) g[i] = 10 ** ((this.baseDb - this.cutDb * Math.min(1, (i + 1) / this.rampN)) / 20);
        out = this.pushWithGains(held, g);
      }
    }
    this.mode = 'done';
    return concat([out, super.end()]);
  }
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}
