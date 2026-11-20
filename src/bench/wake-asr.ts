// Transcribes the wake extra corpus (bench/wake-extra.mjs) the way the server
// hears it: 48 kHz s16 in 20 ms frames, the Downsampler, Silero VAD with the
// PC room's settings, then Parakeet for every segment of 0.3 s or more.
// Writes the same per-clip lines as sidetalk-bench (plus cls and phrase), so
// bench/wake-score.mjs can replay the words through any wake detector.
//
// Usage: node dist/bench/wake-asr.js <extra_dir> <models_dir> <out.jsonl>
//   env THREADS (Parakeet threads, default 2)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { ASR_SAMPLE_RATE, Downsampler, ParakeetStt, SileroVad } from '../speech/sherpa.js';

interface Label {
  id: string;
  file: string;
  cls: string;
  kind: string;
  phrase: string;
}

const [dir, models, out] = process.argv.slice(2);
if (!dir || !models || !out) {
  console.error('usage: wake-asr <extra_dir> <models_dir> <out.jsonl>');
  process.exit(2);
}
const labels = readFileSync(join(dir, 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Label);
const stt = await ParakeetStt.load({ modelDir: join(models, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'), threads: Number(process.env.THREADS ?? 2) });
const vadOptions = { model: join(models, 'silero_vad.onnx'), threshold: 0.5, minSilence: 0.8, minSpeech: 0.25, maxSpeech: 20 };

const lines: string[] = [];
for (const l of labels) {
  const w = sherpa.readWave(join(dir, l.file));
  const up = new sherpa.LinearResampler(w.sampleRate, 48_000).resample(w.samples);
  const pcm = Int16Array.from(up, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
  const s16 = new Int16Array(pcm.length + 48_000); // a second of quiet closes the segment
  s16.set(pcm);
  const down = new Downsampler();
  const vad = new SileroVad(vadOptions);
  const segs: Float32Array[] = [];
  for (let i = 0; i < s16.length; i += 960) segs.push(...vad.accept(down.push(s16.subarray(i, i + 960))));
  segs.push(...vad.flush());
  const segments: { seconds: number; text: string }[] = [];
  for (const s of segs) {
    const seconds = s.length / ASR_SAMPLE_RATE;
    if (seconds < 0.3) continue; // the pipeline's MIN_SEGMENT_SECONDS
    const { text } = await stt.transcribe(s, ASR_SAMPLE_RATE);
    segments.push({ seconds: Math.round(seconds * 100) / 100, text });
  }
  lines.push(JSON.stringify({ id: l.id, set: 'extra', kind: l.kind, cls: l.cls, phrase: l.phrase, audioSeconds: Math.round((w.samples.length / w.sampleRate) * 100) / 100, segments }));
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(JSON.stringify({ clips: lines.length, out }));
