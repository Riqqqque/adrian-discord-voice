// The corpus lines whose spoken text differs between two builds, as the text
// each build sends to an English voice (splitter -> toSpeakable -> forSpeech).
//   node bench/speech-changed.mjs <old dist> <new dist> > changed.json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = async (d) => import(`${pathToFileURL(resolve(d)).href}/brain/speech-text.js`);
const [a, b] = await Promise.all(process.argv.slice(2, 4).map(load));
const said = (m, line) => {
  const chunks = line.kind === 'tool' ? [m.toSpeakable(line.text)] : (() => { const s = new m.SentenceSplitter(); return [...s.push(line.text), ...s.flush()].map((c) => m.toSpeakable(c)).filter(Boolean); })();
  return chunks.map((c) => (m.forSpeech ? m.forSpeech(c) : c));
};
const lines = JSON.parse(readFileSync(new URL('./speech-lines.json', import.meta.url), 'utf8'));
const out = [];
for (const [i, l] of lines.entries()) {
  const before = said(a, l);
  const after = said(b, l);
  if (before.join('|') !== after.join('|')) out.push({ id: l.id, heldOut: i % 4 === 3, say: l.say, before, after });
}
console.log(JSON.stringify(out, null, 1));
console.error(`${out.length} of ${lines.length} lines change; ${out.reduce((n, l) => n + l.before.join(' ').length + l.after.join(' ').length, 0)} characters to voice both`);
