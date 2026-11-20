// Local speech on CPU via sherpa-onnx: Silero VAD per user, one shared
// Parakeet recognizer with at most one decode at a time (brief section 7).

import sherpa from 'sherpa-onnx-node';
import type { DecodeOptions, SpeechToText, VoiceActivityDetector } from '../core/interfaces.js';
import { DecodeQueue } from './decode-queue.js';

export const ASR_SAMPLE_RATE = 16_000;
/** Silero's window at 16 kHz, samples. */
const WINDOW = 512;

export interface SileroOptions {
  model: string;
  threshold: number;
  /** Silence that closes a segment, seconds. */
  minSilence: number;
  minSpeech: number;
  maxSpeech: number;
  /** Audio kept from just before each detected segment, seconds. Silero
   *  triggers a little after speech starts, which clips soft onsets such as
   *  the "h" in "hey". Default 0.25. */
  preroll?: number;
}

export class SileroVad implements VoiceActivityDetector {
  private readonly vad: InstanceType<typeof sherpa.Vad>;
  private readonly prerollSamples: number;
  /** Ring buffer of recent input, so segments can be extended backwards. */
  private readonly hist: Float32Array;
  /** Samples accepted since the last reset (Silero's segment.start is
   *  relative to the same origin). */
  private total = 0;
  /** Input not yet handed to sherpa: less than one window. */
  private readonly part = new Float32Array(WINDOW);
  private partLen = 0;

  constructor(o: SileroOptions) {
    this.prerollSamples = Math.round((o.preroll ?? 0.25) * ASR_SAMPLE_RATE);
    this.hist = new Float32Array((Math.ceil(o.maxSpeech) + 3) * ASR_SAMPLE_RATE);
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: o.model,
          threshold: o.threshold,
          minSilenceDuration: o.minSilence,
          minSpeechDuration: o.minSpeech,
          maxSpeechDuration: o.maxSpeech,
          windowSize: WINDOW,
        },
        sampleRate: ASR_SAMPLE_RATE,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      // Buffer comfortably more than one maximum-length segment.
      Math.ceil(o.maxSpeech) + 10,
    );
  }

  /** sherpa is handed one Silero window per call. It ends a segment at the end
   *  of the call that heard the last silent window, so a call holding several
   *  windows moves the cut by up to a call's length, with the framing: two VADs
   *  on the same audio then cut the same speech apart. One window per call cuts
   *  where the window does, however the audio arrives. 20 ms frames already
   *  gave sherpa at most one window per call, so their segments are unchanged. */
  accept(samples: Float32Array): Float32Array[] {
    this.remember(samples);
    let o = 0;
    if (this.partLen) {
      o = Math.min(WINDOW - this.partLen, samples.length);
      this.part.set(samples.subarray(0, o), this.partLen);
      this.partLen += o;
      if (this.partLen < WINDOW) return [];
      this.vad.acceptWaveform(this.part);
      this.partLen = 0;
    }
    for (; o + WINDOW <= samples.length; o += WINDOW) this.vad.acceptWaveform(samples.subarray(o, o + WINDOW));
    this.part.set(samples.subarray(o), 0);
    this.partLen = samples.length - o;
    return this.drain();
  }

  flush(): Float32Array[] {
    // sherpa keeps a part window to itself, as it did when frames went in whole
    if (this.partLen) this.vad.acceptWaveform(this.part.slice(0, this.partLen));
    this.partLen = 0;
    this.vad.flush();
    const out = this.drain();
    this.reset();
    return out;
  }

  reset(): void {
    this.vad.reset();
    this.total = 0;
    this.partLen = 0;
  }

  /** Speech is currently detected (Silero above threshold). */
  isSpeaking(): boolean {
    return this.vad.isDetected();
  }

  private remember(samples: Float32Array): void {
    const cap = this.hist.length;
    for (let i = 0; i < samples.length; i++) this.hist[(this.total + i) % cap] = samples[i]!;
    this.total += samples.length;
  }

  private drain(): Float32Array[] {
    const out: Float32Array[] = [];
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      // Prepend up to `preroll` of audio that came just before the segment
      // and is still in the ring buffer.
      const cap = this.hist.length;
      const from = Math.max(0, seg.start - this.prerollSamples, this.total - cap);
      const pre = Math.max(0, seg.start - from);
      const joined = new Float32Array(pre + seg.samples.length);
      for (let i = 0; i < pre; i++) joined[i] = this.hist[(from + i) % cap]!;
      joined.set(seg.samples, pre); // copies out of native memory before pop()
      out.push(joined);
      this.vad.pop();
    }
    return out;
  }
}

/** 48 kHz s16 mono (Discord, downmixed) → 16 kHz float, per user stream. */
export class Downsampler {
  private readonly r = new sherpa.LinearResampler(48_000, ASR_SAMPLE_RATE);

  push(samples: Int16Array): Float32Array {
    const f = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) f[i] = samples[i]! / 32768;
    return this.r.resample(f);
  }
}

export interface ParakeetOptions {
  modelDir: string;
  threads: number;
}

export class ParakeetStt implements SpeechToText {
  private readonly queue = new DecodeQueue();

  private constructor(private readonly recognizer: InstanceType<typeof sherpa.OfflineRecognizer>) {}

  static async load(o: ParakeetOptions): Promise<ParakeetStt> {
    const r = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: `${o.modelDir}/encoder.int8.onnx`,
          decoder: `${o.modelDir}/decoder.int8.onnx`,
          joiner: `${o.modelDir}/joiner.int8.onnx`,
        },
        tokens: `${o.modelDir}/tokens.txt`,
        numThreads: o.threads,
        provider: 'cpu',
        modelType: 'nemo_transducer',
        debug: 0,
      },
    });
    return new ParakeetStt(r);
  }

  /** Decodes are serialized: one ASR job at a time, background ones last
   *  (DecodeQueue). A request cancelled while queued never starts. */
  transcribe(
    samples: Float32Array,
    sampleRate: number,
    signal?: AbortSignal,
    options?: DecodeOptions,
  ): Promise<{ text: string; decodeMs: number }> {
    return this.queue.run(
      async () => {
        const stream = this.recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate });
        const t0 = performance.now();
        const r = await this.recognizer.decodeAsync(stream);
        return { text: r.text.trim(), decodeMs: Math.round(performance.now() - t0) };
      },
      signal,
      options,
    );
  }
}
