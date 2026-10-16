// Kokoro-82M TTS on CPU via sherpa-onnx (multi-lang v1.0 model, fp32: int8
// measured slower than real time on this CPU). One synthesis at a time.
// Each voice/speed pair is calibrated once to −16 LUFS; every sentence then
// gets that gain plus a peak limiter, so level doesn't jump between
// sentences.

import sherpa from 'sherpa-onnx-node';
import type { TextToSpeech } from '../core/interfaces.js';
import { gainAndLimit, integratedLoudness } from '../audio/loudness.js';

import { KOKORO_VOICES } from './voices.js';

/** Languages A.D.R.I.A.N. can speak (Kokoro voice prefix → language). */
export type SpeechLang = 'us' | 'gb' | 'es' | 'fr' | 'it' | 'pt' | 'hi' | 'ja' | 'zh';
const PREFIX: Record<string, SpeechLang> = { a: 'us', b: 'gb', e: 'es', f: 'fr', i: 'it', p: 'pt', h: 'hi', j: 'ja', z: 'zh' };
/** espeak-ng voice per language (plain "en" is British English). */
const ESPEAK: Record<SpeechLang, string> = { us: 'en-us', gb: 'en', es: 'es', fr: 'fr', it: 'it', pt: 'pt-br', hi: 'hi', ja: 'ja', zh: 'cmn' };

/** Apply a voice's calibrated gain to one chunk, capped so short chunks
 *  don't come out hot, then peak-limit. Shared by every voice engine. */
export function levelChunk(samples: Float32Array, rate: number, gainDb: number): Float32Array {
  let gain = gainDb;
  // Chunks shorter than one 400 ms block are measured whole by padding with
  // silence (the gates then ignore the padding).
  const probe = samples.length >= 0.4 * rate ? samples : Float32Array.from({ length: Math.ceil(0.4 * rate) }, (_, i) => samples[i] ?? 0);
  const chunkLufs = integratedLoudness(probe, rate);
  if (Number.isFinite(chunkLufs) && chunkLufs + gain > TARGET_LUFS + MAX_OVER_LU) gain = TARGET_LUFS + MAX_OVER_LU - chunkLufs;
  return gainAndLimit(samples, rate, gain, CEILING_DB);
}

/** Calibration sentences for voices that don't speak English. */
const CALIBRATION_BY_LANG: Partial<Record<SpeechLang, string[]>> = {
  es: ['Claro, esto es lo que encontré. Hace veintidós grados y está despejado.', 'La capital de Australia es Canberra, aunque mucha gente piensa que es Sídney.'],
  zh: ['好的，这是我找到的信息。现在二十二度，天气晴朗。', '澳大利亚的首都是堪培拉，很多人以为是悉尼。'],
  ja: ['はい、しらべました。いまは にじゅうにど で、はれています。', 'オーストラリアの しゅとは キャンベラです。'],
  fr: ['Bien sûr, voici ce que j’ai trouvé. Il fait vingt-deux degrés et le ciel est dégagé.'],
  it: ['Certo, ecco cosa ho trovato. Ci sono ventidue gradi e il cielo è sereno.'],
  pt: ['Claro, aqui está o que encontrei. Está fazendo vinte e dois graus e o céu está limpo.'],
};

export function langOf(voice: string): SpeechLang {
  return PREFIX[voice[0] ?? 'a'] ?? 'us';
}

export { KOKORO_VOICES };

/** Playback is mono duplicated to both stereo channels, and BS.1770 sums
 *  channels (+3.01 LU), so −19 LUFS mono plays as −16 LUFS stereo. */
export const TARGET_LUFS = -16 - 3.01;
/** A single chunk may come out at most this far above the target (short
 *  words like "Yes?" read hotter than the calibration sentences). */
const MAX_OVER_LU = 1.5;
/** Sample-peak ceiling; leaves ~1 dB for inter-sample peaks → < −1 dBTP. */
const CEILING_DB = -2;
const CALIBRATION = [
  "Sure, here's what I found. It's seventy two degrees and clear right now.",
  'The capital of Australia is Canberra, which surprises a lot of people.',
];

export interface KokoroOptions {
  modelDir: string;
  modelFile?: string;
  threads: number;
}

export class KokoroTts implements TextToSpeech {
  private readonly engines = new Map<SpeechLang, Promise<InstanceType<typeof sherpa.OfflineTts>>>();
  private readonly gains = new Map<string, Promise<number>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: KokoroOptions) {}

  static voiceId(name: string): number {
    const i = (KOKORO_VOICES as readonly string[]).indexOf(name);
    if (i < 0) throw new Error(`unknown Kokoro voice "${name}"`);
    return i;
  }

  /** One engine per language: British voices need the British lexicon and
   *  espeak "en"; other languages use espeak's own rules for that language.
   *  Engines load on first use (each holds a copy of the model). */
  private engine(voice: string) {
    const lex = langOf(voice);
    let e = this.engines.get(lex);
    if (!e) {
      const d = this.o.modelDir;
      e = sherpa.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: `${d}/${this.o.modelFile ?? 'model.onnx'}`,
            voices: `${d}/voices.bin`,
            tokens: `${d}/tokens.txt`,
            dataDir: `${d}/espeak-ng-data`,
            // Chinese needs its own lexicon (plus English for mixed text) and
            // the jieba dictionary for word splitting.
            lexicon: lex === 'zh' ? `${d}/lexicon-us-en.txt,${d}/lexicon-zh.txt` : `${d}/lexicon-${lex === 'gb' ? 'gb' : 'us'}-en.txt`,
            ...(lex === 'zh' ? { dictDir: `${d}/dict` } : {}),
            lang: ESPEAK[lex],
          },
          numThreads: this.o.threads,
          provider: 'cpu',
          debug: 0,
        },
        // Chinese numbers, dates and phone numbers read out properly.
        ...(lex === 'zh' ? { ruleFsts: `${d}/date-zh.fst,${d}/phone-zh.fst,${d}/number-zh.fst` } : {}),
        maxNumSentences: 1,
      });
      this.engines.set(lex, e);
    }
    return e;
  }

  /** Raw synthesis, serialized (one TTS job at a time). */
  private raw(text: string, voice: string, speed: number, signal?: AbortSignal) {
    const job = this.queue.then(async () => {
      if (signal?.aborted) throw new Error('cancelled');
      const tts = await this.engine(voice);
      const t0 = performance.now();
      const a = await tts.generateAsync({ text, sid: KokoroTts.voiceId(voice), speed });
      return { samples: a.samples, sampleRate: a.sampleRate, synthMs: Math.round(performance.now() - t0) };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Gain (dB) that brings this voice/speed to the target loudness. */
  gainFor(voice: string, speed: number): Promise<number> {
    const key = `${voice}@${speed}`;
    let g = this.gains.get(key);
    if (!g) {
      g = (async () => {
        const parts = await Promise.all((CALIBRATION_BY_LANG[langOf(voice)] ?? CALIBRATION).map((t) => this.raw(t, voice, speed)));
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
      this.gains.set(key, g);
    }
    return g;
  }

  async synthesize(text: string, opts: { voice: string; speed: number }, signal?: AbortSignal) {
    const gain = await this.gainFor(opts.voice, opts.speed);
    const r = await this.raw(text, opts.voice, opts.speed, signal);
    return { ...r, samples: levelChunk(r.samples, r.sampleRate, gain) };
  }
}
