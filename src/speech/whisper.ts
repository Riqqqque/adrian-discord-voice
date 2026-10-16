// Whisper (small, int8) as a second pass for questions that aren't in
// English: about a second per clip on 4 threads, but it understands Chinese,
// Japanese, Vietnamese, Spanish and many more, and says which language it
// heard. Parakeet stays the fast always-on recognizer for the wake phrase.

import sherpa from 'sherpa-onnx-node';

export class WhisperStt {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly rec: InstanceType<typeof sherpa.OfflineRecognizer>) {}

  static async load(o: { modelDir: string; threads: number; name?: string }): Promise<WhisperStt> {
    const n = o.name ?? 'small';
    const rec = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: `${o.modelDir}/${n}-encoder.int8.onnx`, decoder: `${o.modelDir}/${n}-decoder.int8.onnx`, language: '', task: 'transcribe', tailPaddings: -1 },
        tokens: `${o.modelDir}/${n}-tokens.txt`,
        numThreads: o.threads,
        provider: 'cpu',
        debug: 0,
      },
    });
    return new WhisperStt(rec);
  }

  /** 16 kHz mono → text and detected language ("zh", "ja", ...). One at a time. */
  transcribe(samples: Float32Array): Promise<{ text: string; lang: string; decodeMs: number }> {
    const job = this.queue.then(async () => {
      const s = this.rec.createStream();
      s.acceptWaveform({ samples, sampleRate: 16000 });
      const t0 = performance.now();
      const r = await this.rec.decodeAsync(s);
      return { text: r.text.trim(), lang: (r.lang ?? '').replace(/[<>|]/g, '') || 'en', decodeMs: Math.round(performance.now() - t0) };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}
