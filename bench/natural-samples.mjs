// Render the same spoken answer several ways to compare how natural it
// sounds: the current chunking vs whole sentences with trimmed edges and
// natural pauses, across the stronger Kokoro voices.
//
// Usage (from the built app dir, LD_LIBRARY_PATH set for sherpa):
//   node bench/natural-samples.mjs <kokoro model dir> <out dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toWav } from '../dist/audio/wav.js';
import { SentenceSplitter, toSpeakable } from '../dist/brain/speech-text.js';
import { KokoroTts } from '../dist/speech/kokoro.js';

const [modelDir, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const tts = new KokoroTts({ modelDir, threads: 4 });

const ANSWER =
  "It's sixty eight degrees and partly cloudy in Denver right now. Tonight it drops to about forty five, so grab a jacket if you're heading out. Tomorrow looks sunny, with a high near seventy two.";

/** Chunks the way the live bot gets them: streamed in small deltas. */
function chunks(splitter) {
  const out = [];
  for (let i = 0; i < ANSWER.length; i += 4) out.push(...splitter.push(ANSWER.slice(i, i + 4)));
  out.push(...splitter.flush());
  return out.map((c) => toSpeakable(c));
}

/** Drop leading/trailing near-silence (below -45 dBFS in 10 ms windows), keep a 15 ms margin. */
function trim(x, rate) {
  const win = Math.round(rate / 100);
  const thr = 10 ** (-45 / 20);
  const loud = (i) => {
    let s = 0;
    for (let j = i; j < Math.min(x.length, i + win); j++) s += x[j] * x[j];
    return Math.sqrt(s / win) > thr;
  };
  let a = 0;
  while (a < x.length && !loud(a)) a += win;
  let b = x.length - win;
  while (b > a && !loud(b)) b -= win;
  const m = Math.round(rate * 0.015);
  return x.subarray(Math.max(0, a - m), Math.min(x.length, b + win + m));
}

function join_(parts, rate, gapFor) {
  const pieces = [];
  parts.forEach((p, i) => {
    pieces.push(p.samples);
    if (i < parts.length - 1) pieces.push(new Float32Array(Math.round(rate * gapFor(p.text))));
  });
  const all = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of pieces) {
    all.set(p, o);
    o += p.length;
  }
  return all;
}

async function render(name, voice, list, { trimEdges, speed = 1 }) {
  const parts = [];
  const synth = [];
  for (const text of list) {
    const a = await tts.synthesize(text, { voice, speed });
    synth.push(a.synthMs);
    parts.push({ text, rate: a.sampleRate, samples: trimEdges ? trim(a.samples, a.sampleRate) : a.samples });
  }
  const rate = parts[0].rate;
  // Natural pauses: longer after a sentence, shorter after a clause. Untrimmed
  // chunks keep Kokoro's own padding (what the bot does today).
  const gap = (t) => (!trimEdges ? 0 : /[.!?]["')\]]?$/.test(t) ? 0.32 : 0.16);
  const audio = join_(parts, rate, gap);
  writeFileSync(join(out, `${name}.wav`), toWav(audio, rate));
  console.log(JSON.stringify({ name, chunks: list, firstChunkSynthMs: synth[0], seconds: Number((audio.length / rate).toFixed(2)) }));
}

const current = chunks(new SentenceSplitter());
const sentences = chunks(new SentenceSplitter({ firstChunkMinChars: 10_000, maxChunkChars: 400 }));

await render('1-now-am_michael', 'am_michael', current, { trimEdges: false });
await render('2-sentences-am_michael', 'am_michael', sentences, { trimEdges: true });
await render('3-whole-am_michael', 'am_michael', [ANSWER], { trimEdges: true });
for (const v of ['am_fenrir', 'am_puck', 'bm_george', 'bm_fable', 'af_heart']) {
  await render(`4-sentences-${v}`, v, sentences, { trimEdges: true });
}
await render('5-sentences-am_michael-speed1.1', 'am_michael', sentences, { trimEdges: true, speed: 1.1 });
