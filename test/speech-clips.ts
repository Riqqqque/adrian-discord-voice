// Rendered speech for the tests that run real models (off unless ADRIAN_MODELS
// points at the model folder). Kokoro renders each line once, at 48 kHz s16
// mono like a PC sends, into the temp folder; nothing is played or committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';

/** The model folder (silero_vad.onnx, kokoro-multi-lang-v1_0, ...), or undefined: skip. */
export const MODELS = process.env.ADRIAN_MODELS || undefined;
export const NO_MODELS = 'set ADRIAN_MODELS to the model folder (silero_vad.onnx, kokoro-multi-lang-v1_0) to run this';

/** Name → [text, Kokoro speaker]. The cache is by name: change a line, rename it. */
export const LINES: Record<string, [string, number]> = {
  wake: ['Hey Adrian, open Spotify.', 0],
  wake2: ['Hey Adrian, what is the capital of Australia?', 11],
  name: ['Hey Adrian.', 0],
  cmd: ['Open Spotify.', 0],
  follow: ['And turn it up a little.', 0],
  play: ['Hey Adrian, play', 0],
  drake: ['Drake.', 0],
  side: ['So then we went to the store and they were out of everything.', 3],
};

export async function clips(models: string): Promise<Record<string, Int16Array>> {
  const dir = join(tmpdir(), 'adrian-latency-clips');
  mkdirSync(dir, { recursive: true });
  const out: Record<string, Int16Array> = {};
  let tts: any;
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.002;
  for (const [name, [text, sid]] of Object.entries(LINES)) {
    const f = join(dir, `${name}.pcm`);
    if (!existsSync(f)) {
      const d = join(models, 'kokoro-multi-lang-v1_0');
      tts ??= await sherpa.OfflineTts.createAsync({
        model: { kokoro: { model: `${d}/model.onnx`, voices: `${d}/voices.bin`, tokens: `${d}/tokens.txt`, dataDir: `${d}/espeak-ng-data`, lexicon: `${d}/lexicon-us-en.txt`, lang: 'en-us' }, numThreads: 2, provider: 'cpu', debug: 0 },
        maxNumSentences: 1,
      });
      const a = await tts.generateAsync({ text, sid, speed: 1 });
      const up: Float32Array = new sherpa.LinearResampler(a.sampleRate, 48_000).flush(a.samples);
      const pcm = Int16Array.from(up, (v) => Math.max(-32768, Math.min(32767, Math.round((v * 0.5 + noise()) * 32767))));
      writeFileSync(f, Buffer.from(pcm.buffer));
    }
    const b = readFileSync(f);
    out[name] = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  }
  return out;
}

/** A mic's noise floor, never digital silence. */
export function quiet(seconds: number, seed = 7): Int16Array {
  const a = new Int16Array(Math.round(seconds * 48_000));
  for (let i = 0; i < a.length; i++) a[i] = Math.round((((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * 0.002 * 32767);
  return a;
}

export function join16(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}
