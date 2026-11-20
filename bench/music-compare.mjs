// Before and after, from two runs of bench/music-corpus.mjs (their .jsonl rows).
//   node bench/music-compare.mjs <before.jsonl> <after.jsonl>
import { readFileSync } from 'node:fs';

const [before, after] = process.argv.slice(2).map((f) =>
  readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l)),
);
const pct = (xs, p) => {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : '-';
};
const stats = (rows) => ({
  hits: `${rows.filter((r) => r.hit).length}/${rows.length}`,
  urlMedian: pct(rows.map((r) => r.urlMs), 50),
  urlP90: pct(rows.map((r) => r.urlMs), 90),
  audioMedian: pct(rows.map((r) => r.audioMs), 50),
  audioP90: pct(rows.map((r) => r.audioMs), 90),
  noAudio: rows.filter((r) => r.hit !== undefined && r.urlMs !== undefined && r.audioMs === undefined).length,
  ytPerRequest: (rows.reduce((a, r) => a + r.yt, 0) / rows.length).toFixed(2),
  ytTotal: rows.reduce((a, r) => a + r.yt, 0),
});
const b = stats(before);
const a = stats(after);
console.log('| | before | after |\n|---|---|---|');
for (const k of Object.keys(b)) console.log(`| ${k} | ${b[k]} | ${a[k]} |`);

const by = new Map(after.map((r) => [r.say, r]));
console.log('\nper request (before → after):');
for (const r of before) {
  const n = by.get(r.say);
  if (!n) continue;
  const flag = r.hit && !n.hit ? 'WORSE' : !r.hit && n.hit ? 'FIXED' : r.id !== n.id ? 'other' : '';
  console.log(`${flag.padEnd(5)} ${r.say.padEnd(50).slice(0, 50)} ${String(r.urlMs ?? '-').padStart(5)} → ${String(n.urlMs ?? '-').padStart(5)} ms  yt ${r.yt}→${n.yt}  ${flag ? `${r.got}  →  ${n.got}` : ''}`);
}
