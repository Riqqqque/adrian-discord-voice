// Wake / false-wake bench: streams labelled clips through the same VAD →
// Parakeet → wake path the bot uses (20 ms frames, as from Discord) and
// reports miss rate, false-wake rate and ASR timing.
//
// Usage: node dist/bench/wake-bench.js <corpus_dir> <vad.onnx> <asr_dir> <threads> [gainDb ...]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { ASR_SAMPLE_RATE, ParakeetStt, SileroVad } from '../speech/sherpa.js';
import { TextWakeDetector } from '../wake/text-wake.js';

interface Label {
  file: string;
  kind: 'wake' | 'notWake';
  index: number;
  voice: string;
  text: string;
}

/** notWake phrases that are word-for-word identical to a wake when spoken
 *  without a pause; reported separately. */
const HARD_INDEXES = new Set([27, 28, 29]);

const [corpusDir, vadModel, asrDir, threadsArg, ...gainArgs] = process.argv.slice(2);
if (!corpusDir || !vadModel || !asrDir) {
  console.error('usage: wake-bench <corpus_dir> <vad.onnx> <asr_dir> <threads> [gainDb ...]');
  process.exit(2);
}
const gains = gainArgs.length ? gainArgs.map(Number) : [0];
const labels: Label[] = JSON.parse(readFileSync(join(corpusDir, 'labels.json'), 'utf8'));
const stt = await ParakeetStt.load({ modelDir: asrDir, threads: Number(threadsArg ?? 4) });
const wake = new TextWakeDetector();
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

for (const gainDb of gains) {
  const g = 10 ** (gainDb / 20);
  let wakeTotal = 0, missed = 0, normalTotal = 0, falseWakes = 0, hardTotal = 0, hardWakes = 0, cmdMismatch = 0;
  const decode: number[] = [];
  const misses: string[] = [];
  const falses: string[] = [];
  for (const l of labels) {
    const w = sherpa.readWave(join(corpusDir, l.file));
    const x = w.samples.map((v) => v * g);
    const vad = new SileroVad({
      model: vadModel, threshold: 0.5, minSilence: 0.5, minSpeech: 0.25, maxSpeech: 20,
      preroll: Number(process.env.PREROLL ?? 0.25),
    });
    const segments: Float32Array[] = [];
    const frame = (ASR_SAMPLE_RATE / 1000) * 20;
    for (let i = 0; i < x.length; i += frame) segments.push(...vad.accept(x.subarray(i, i + frame)));
    segments.push(...vad.flush());
    // The bot acts on the first segment of an utterance.
    let woke = false;
    let heard = '';
    let command = '';
    for (const s of segments) {
      if (s.length / ASR_SAMPLE_RATE < 0.3) continue;
      const r = await stt.transcribe(s, ASR_SAMPLE_RATE);
      decode.push(r.decodeMs);
      heard ||= r.text;
      const m = wake.match(r.text);
      if (m.woke) {
        woke = true;
        command = m.remainder;
      }
      break;
    }
    if (l.kind === 'wake') {
      wakeTotal++;
      if (!woke) {
        missed++;
        misses.push(`${l.voice}: "${l.text}" → heard "${heard}"`);
      } else {
        const expected = l.text.replace(/^(hey|hi|okay|yo)\s+adrian[,.]?\s*/i, '').toLowerCase().replace(/[^a-z ]/g, '');
        if (command.toLowerCase().replace(/[^a-z ]/g, '') !== expected) cmdMismatch++;
      }
    } else if (HARD_INDEXES.has(l.index)) {
      hardTotal++;
      if (woke) hardWakes++;
    } else {
      normalTotal++;
      if (woke) {
        falseWakes++;
        falses.push(`${l.voice}: "${l.text}" → heard "${heard}"`);
      }
    }
  }
  console.log(
    JSON.stringify({
      gainDb,
      wakeClips: wakeTotal,
      missed,
      missRatePct: Number(((100 * missed) / wakeTotal).toFixed(1)),
      commandTextDiffers: cmdMismatch,
      notWakeClips: normalTotal,
      falseWakes,
      falseWakeRatePct: Number(((100 * falseWakes) / normalTotal).toFixed(1)),
      hardClips: hardTotal,
      hardWokeUp: hardWakes,
      decodeMs: { p50: pct(decode, 50), p95: pct(decode, 95), max: Math.max(...decode) },
    }),
  );
  for (const m of misses.slice(0, 15)) console.log(`  MISS ${m}`);
  for (const f of falses.slice(0, 15)) console.log(`  FALSE ${f}`);
}
