// Local speech on CPU via sherpa-onnx: Silero VAD per user, one shared
// Parakeet recognizer with at most one decode at a time (brief section 7).

import sherpa from 'sherpa-onnx-node';
import type { SpeechToText, VoiceActivityDetector } from '../core/interfaces.js';

export const ASR_SAMPLE_RATE = 16_000;

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
          windowSize: 512,
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

  accept(samples: Float32Array): Float32Array[] {
    this.remember(samples);
    this.vad.acceptWaveform(samples);
    return this.drain();
  }

  flush(): Float32Array[] {
    this.vad.flush();
    const out = this.drain();
    this.reset();
    return out;
  }

  reset(): void {
    this.vad.reset();
    this.total = 0;
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
  private queue: Promise<unknown> = Promise.resolve();

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

  /** Decodes are serialized: one ASR job at a time. A request cancelled
   *  while queued never starts. */
  transcribe(
    samples: Float32Array,
    sampleRate: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; decodeMs: number }> {
    const job = this.queue.then(async () => {
      if (signal?.aborted) throw new Error('cancelled');
      const stream = this.recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate });
      const t0 = performance.now();
      const r = await this.recognizer.decodeAsync(stream);
      return { text: r.text.trim(), decodeMs: Math.round(performance.now() - t0) };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}
