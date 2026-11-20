// Intelligibility of her spoken text: each line goes through the code under
// test exactly as an answer does (sentence splitter -> toSpeakable -> the
// Kokoro engine), is transcribed back with Parakeet, and scored as word error
// rate against the words she should say (bench/speech-lines.json; any of the
// listed readings counts). "oracle" synthesizes the intended words themselves,
// which measures what Kokoro + Parakeet get wrong on their own.
//   node bench/speech-words.mjs <dist dir> <kokoro dir> <parakeet dir> [--oracle] [--dev] [--json out.json] [--wav dir] [--voice af_heart]
// --dev hides the held-out quarter (every 4th line) while working on fixes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const [distArg, kokoroDir, parakeetDir] = args;
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const dist = pathToFileURL(resolve(distArg)).href;
const { SentenceSplitter, toSpeakable, forSpeech } = await import(`${dist}/brain/speech-text.js`);
const { KokoroTts } = await import(`${dist}/speech/kokoro.js`);
const { ParakeetStt } = await import(`${dist}/speech/sherpa.js`);
const sherpa = (await import('sherpa-onnx-node')).default;
const voice = opt('--voice') ?? 'af_heart';
const wavDir = opt('--wav');
if (wavDir) mkdirSync(wavDir, { recursive: true });

const lines = JSON.parse(readFileSync(new URL('./speech-lines.json', import.meta.url), 'utf8')).map((l, i) => ({ ...l, heldOut: i % 4 === 3 }));
const tts = new KokoroTts({ modelDir: kokoroDir, threads: 2 });
const stt = await ParakeetStt.load({ modelDir: parakeetDir, threads: 2 });

import { score, summary as sum } from './speech-score.mjs';

// --- synthesis as an answer is spoken ---
function chunksOf(line) {
  if (line.kind === 'tool') return [toSpeakable(line.text)];
  const sp = new SentenceSplitter();
  return [...sp.push(line.text), ...sp.flush()].map((c) => toSpeakable(c)).filter(Boolean);
}
const gap = new Float32Array(Math.round(0.25 * 24_000));
async function render(chunks) {
  const parts = [];
  let rate = 24_000;
  for (const c of chunks) {
    const a = await tts.synthesize(c, { voice, speed: 1 });
    rate = a.sampleRate;
    parts.push(a.samples, gap);
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (all.set(p, o), (o += p.length));
  return { samples: all, rate };
}
function wav(path, x, rate) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  x.forEach((s, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  writeFileSync(path, b);
}

const rows = [];
for (const line of lines) {
  if (flag('--dev') && line.heldOut) continue;
  const chunks = flag('--oracle') ? [line.say[0]] : chunksOf(line);
  const { samples, rate } = await render(chunks);
  if (wavDir) wav(`${wavDir}/${line.id}.wav`, samples, rate);
  const down = new sherpa.LinearResampler(rate, 16_000).flush(samples);
  const { text: heard } = await stt.transcribe(down, 16_000);
  const sc = score(heard, line.say);
  rows.push({ id: line.id, kind: line.kind, heldOut: line.heldOut, spoken: chunks.map((c) => (forSpeech ? forSpeech(c) : c)).join(' | '), heard, ref: sc.ref, hyp: sc.hyp, errors: sc.errors, words: sc.words });
}
for (const r of rows) if (r.errors) console.log(`${r.errors}/${r.words} ${r.id}${r.heldOut ? ' (held out)' : ''}\n   spoken: ${r.spoken}\n   heard:  ${r.heard}\n   ref:    ${r.ref}\n   hyp:    ${r.hyp}`);
const report = { dist: distArg, oracle: flag('--oracle'), all: sum(rows), tool: sum(rows.filter((r) => r.kind === 'tool')), model: sum(rows.filter((r) => r.kind === 'model')), heldOut: sum(rows.filter((r) => r.heldOut)) };
console.log(JSON.stringify(report));
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ report, rows }, null, 1));
