// Scores rendered before/after WAVs (bench/sabrina-render.mjs) with Parakeet,
// using the same normalizer as bench/speech-words.mjs.
//   node bench/speech-wavs.mjs <dir with lines.json + <id>.<before|after>.wav> <parakeet dir> <dist dir>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { score, summary } from './speech-score.mjs';

const [dir, parakeetDir, distArg] = process.argv.slice(2);
const { ParakeetStt } = await import(`${pathToFileURL(resolve(distArg)).href}/speech/sherpa.js`);
const sherpa = (await import('sherpa-onnx-node')).default;
const stt = await ParakeetStt.load({ modelDir: parakeetDir, threads: 2 });
const lines = JSON.parse(readFileSync(`${dir}/lines.json`, 'utf8'));
const read = (path) => {
  const b = readFileSync(path);
  const n = (b.length - 44) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
  return x;
};
const rows = { before: [], after: [] };
for (const l of lines) {
  for (const side of ['before', 'after']) {
    const x = read(`${dir}/${l.id}.${side}.wav`);
    const { text } = await stt.transcribe(new sherpa.LinearResampler(24_000, 16_000).flush(x), 16_000);
    rows[side].push({ id: l.id, heldOut: l.heldOut, heard: text, said: l[side].join(' | '), ...score(text, l.say) });
  }
}
for (let i = 0; i < lines.length; i++) {
  const b = rows.before[i], a = rows.after[i];
  if (b.errors !== a.errors) console.log(`${lines[i].id}: ${b.errors} -> ${a.errors} errors\n   before: ${b.said}\n   heard:  ${b.heard}\n   after:  ${a.said}\n   heard:  ${a.heard}`);
}
console.log(JSON.stringify({ before: summary(rows.before), after: summary(rows.after), heldOutBefore: summary(rows.before.filter((r) => r.heldOut)), heldOutAfter: summary(rows.after.filter((r) => r.heldOut)) }));
