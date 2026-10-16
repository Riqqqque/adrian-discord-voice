// Piper (VITS) voices via sherpa-onnx, for languages Kokoro can't speak
// (Vietnamese). Same loudness handling as Kokoro: one calibration per
// speed, then gain + limiter per chunk.

import sherpa from 'sherpa-onnx-node';
import type { TextToSpeech } from '../core/interfaces.js';
import { integratedLoudness } from '../audio/loudness.js';
import { levelChunk, TARGET_LUFS } from './kokoro.js';

const CALIBRATION_VI = [
  'Xin chào, tôi có thể giúp gì cho bạn hôm nay?',
  'Hôm nay trời nắng đẹp, nhiệt độ khoảng hai mươi tám độ.',
  'Bạn muốn nghe một câu chuyện vui không?',
];

export class PiperTts implements TextToSpeech {
  private engine: Promise<InstanceType<typeof sherpa.OfflineTts>> | undefined;
  private readonly gains = new Map<number, Promise<number>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: { modelDir: string; modelFile: string; threads: number; calibration?: string[] }) {}

  private tts() {
    const d = this.o.modelDir;
    this.engine ??= sherpa.OfflineTts.createAsync({
      model: { vits: { model: `${d}/${this.o.modelFile}`, tokens: `${d}/tokens.txt`, dataDir: `${d}/espeak-ng-data` }, numThreads: this.o.threads, provider: 'cpu', debug: 0 },
      maxNumSentences: 1,
    });
    return this.engine;
  }

  private raw(text: string, speed: number, signal?: AbortSignal) {
    const job = this.queue.then(async () => {
      if (signal?.aborted) throw new Error('cancelled');
      const t0 = performance.now();
      const a = await (await this.tts()).generateAsync({ text, sid: 0, speed });
      return { samples: a.samples, sampleRate: a.sampleRate, synthMs: Math.round(performance.now() - t0) };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  gainFor(speed: number): Promise<number> {
    let g = this.gains.get(speed);
    if (!g) {
      g = (async () => {
        const parts = [];
        for (const t of this.o.calibration ?? CALIBRATION_VI) parts.push(await this.raw(t, speed));
        const rate = parts[0]!.sampleRate;
        const all = new Float32Array(parts.reduce((n, p) => n + p.samples.length, 0));
        let off = 0;
        for (const p of parts) {
          all.set(p.samples, off);
          off += p.samples.length;
        }
        const l = integratedLoudness(all, rate);
        return Number.isFinite(l) ? TARGET_LUFS - l : 0;
      })();
      this.gains.set(speed, g);
    }
    return g;
  }

  async synthesize(text: string, opts: { voice: string; speed: number }, signal?: AbortSignal) {
    const gain = await this.gainFor(opts.speed);
    const r = await this.raw(text, opts.speed, signal);
    return { ...r, samples: levelChunk(r.samples, r.sampleRate, gain) };
  }
}

/** Routes each voice to its engine: Piper voices by name, Kokoro otherwise. */
export class VoiceRouter implements TextToSpeech {
  constructor(
    private readonly kokoro: TextToSpeech,
    private readonly piper: Record<string, TextToSpeech>,
  ) {}

  synthesize(text: string, opts: { voice: string; speed: number }, signal?: AbortSignal) {
    return (this.piper[opts.voice] ?? this.kokoro).synthesize(text, opts, signal);
  }
}
