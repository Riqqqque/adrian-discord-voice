// Smart Turn v3.2 (pipecat-ai, BSD-2): from the sound of the last 8 s of
// speech, has the person finished their turn or just paused? Input is a
// Whisper-style log-mel spectrogram, computed here exactly as the reference
// (transformers' WhisperFeatureExtractor, chunk_length 8, do_normalize).
// bench/turn-bench.py measured it on 460 clips: used after the normal 0.8 s
// wait, it halves mid-sentence cut-offs for about 0.2 s more waiting.

const RATE = 16_000;
const SECONDS = 8;
const N_FFT = 400;
const HOP = 160;
const MELS = 80;
const BINS = N_FFT / 2 + 1;
const FRAMES = (SECONDS * RATE) / HOP; // 800 after dropping the last one

export interface TurnDetector {
  /** Probability (0..1) that the speech ending here is a finished turn. */
  complete(samples: Float32Array): Promise<number>;
}

// --- Whisper log-mel ---------------------------------------------------------

const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + (27 * Math.log(f / 1000)) / Math.log(6.4));
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) * (m - 15)) / 27));

/** Slaney-scale, slaney-normalized triangular filters, [MELS][BINS]. */
function melFilters(): Float32Array[] {
  const lo = hzToMel(0), hi = hzToMel(RATE / 2);
  const f = Array.from({ length: MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (MELS + 1)));
  const fft = Array.from({ length: BINS }, (_, k) => ((RATE / 2) * k) / (BINS - 1));
  return Array.from({ length: MELS }, (_, m) => {
    const row = new Float32Array(BINS);
    const enorm = 2 / (f[m + 2]! - f[m]!);
    for (let k = 0; k < BINS; k++) {
      const down = (fft[k]! - f[m]!) / (f[m + 1]! - f[m]!);
      const up = (f[m + 2]! - fft[k]!) / (f[m + 2]! - f[m + 1]!);
      row[k] = Math.max(0, Math.min(down, up)) * enorm;
    }
    return row;
  });
}

const FILTERS = melFilters();
// periodic Hann, as transformers' window_function(400, "hann"), folded into the DFT tables
const WINDOW = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
const COS = new Float64Array(BINS * N_FFT);
const SIN = new Float64Array(BINS * N_FFT);
for (let k = 0; k < BINS; k++) {
  for (let n = 0; n < N_FFT; n++) {
    const a = (2 * Math.PI * ((k * n) % N_FFT)) / N_FFT;
    COS[k * N_FFT + n] = Math.cos(a) * WINDOW[n]!;
    SIN[k * N_FFT + n] = Math.sin(a) * WINDOW[n]!;
  }
}

/** [1, 80, 800] features for the last 8 s of `samples` (16 kHz), left-padded with silence. */
export function turnFeatures(samples: Float32Array): Float32Array {
  const total = SECONDS * RATE;
  const x = new Float64Array(total);
  const src = samples.length > total ? samples.subarray(samples.length - total) : samples;
  x.set(src, total - src.length);
  // zero mean, unit variance over the whole 8 s
  let mean = 0;
  for (const v of x) mean += v;
  mean /= total;
  let v2 = 0;
  for (const v of x) v2 += (v - mean) ** 2;
  const sd = Math.sqrt(v2 / total + 1e-7);
  for (let i = 0; i < total; i++) x[i] = (x[i]! - mean) / sd;
  // centered frames with reflect padding
  const pad = N_FFT / 2;
  const at = (i: number) => x[i < 0 ? -i : i >= total ? 2 * total - 2 - i : i]!;
  const logMel = new Float32Array(MELS * FRAMES);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  let max = -Infinity;
  // Frames that lie wholly in the leading silence are all the same: compute one, copy it.
  const silent = total - src.length;
  const sameUntil = Math.max(0, Math.floor((silent - N_FFT + pad) / HOP) + 1);
  for (let t = 0; t < FRAMES; t++) {
    if (t > 0 && t < sameUntil) {
      for (let m = 0; m < MELS; m++) logMel[m * FRAMES + t] = logMel[m * FRAMES]!;
      continue;
    }
    const start = t * HOP - pad;
    for (let i = 0; i < N_FFT; i++) frame[i] = at(start + i);
    for (let k = 0; k < BINS; k++) {
      let re = 0, im = 0;
      const o = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) {
        re += frame[n]! * COS[o + n]!;
        im += frame[n]! * SIN[o + n]!;
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < MELS; m++) {
      const row = FILTERS[m]!;
      let s = 0;
      for (let k = 0; k < BINS; k++) s += row[k]! * power[k]!;
      const l = Math.log10(Math.max(s, 1e-10));
      logMel[m * FRAMES + t] = l;
      if (l > max) max = l;
    }
  }
  for (let i = 0; i < logMel.length; i++) logMel[i] = (Math.max(logMel[i]!, max - 8) + 4) / 4;
  return logMel;
}

// --- the model ------------------------------------------------------------------

interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

export class SmartTurn implements TurnDetector {
  private constructor(
    private readonly session: OrtSession,
    private readonly Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown,
  ) {}

  /** onnxruntime-node is loaded only when Smart Turn is used. */
  static async load(modelPath: string): Promise<SmartTurn> {
    const ort = (await import('onnxruntime-node')) as unknown as {
      InferenceSession: { create(path: string, opts: object): Promise<OrtSession> };
      Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
    };
    const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' });
    return new SmartTurn(session, ort.Tensor);
  }

  async complete(samples: Float32Array): Promise<number> {
    const input = new this.Tensor('float32', turnFeatures(samples), [1, MELS, FRAMES]);
    const out = await this.session.run({ [this.session.inputNames[0]!]: input });
    return Number(out[this.session.outputNames[0]!]!.data[0]);
  }
}
