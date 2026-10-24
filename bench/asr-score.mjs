// Scores results/*.jsonl from asr-shootout.mjs / asr-bark.py against the corpus.
//   node bench/asr-score.mjs <bench dir> [--errors model]
// WER per set (same normalizer for every model), key words heard on the pc
// set (names, apps, the words that change what she does), latency.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [BENCH, flag, which] = process.argv.slice(2);
const refs = new Map(readFileSync(`${BENCH}/corpus/refs.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function spell(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + spell(n % 100) : '');
  if (n < 10000) return spell(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + spell(n % 1000) : '');
  return String(n).split('').map((d) => ONES[+d]).join(' ');
}
const FILLERS = new Set(['uh', 'um', 'mm', 'hmm', 'mhm', 'ah', 'eh', 'oh', 'er', 'erm', 'uhm', 'huh']);
const SAME = { okay: 'ok', 'o.k': 'ok', lofi: 'lo fi', dont: 'do not', cant: 'can not', cannot: 'can not', wont: 'will not', im: 'i am', its: 'it is', whats: 'what is', thats: 'that is', ill: 'i will', youre: 'you are', isnt: 'is not', didnt: 'did not', doesnt: 'does not', theres: 'there is', lets: 'let us', ive: 'i have', id: 'i would', gonna: 'going to', wanna: 'want to', yeah: 'yes', yep: 'yes', alright: 'all right', autotune: 'auto tune', weekend: 'weeknd' };
export function norm(s) {
  let t = s.toLowerCase().replace(/<[^>]*>/g, ' ');
  t = t.replace(/(\d+)%/g, '$1 percent').replace(/(\d+)(st|nd|rd|th)\b/g, '$1');
  t = t.replace(/([a-z])\.(com|net|org|gg|tv)\b/g, '$1 dot $2');
  t = t.replace(/(\d+):(\d\d)/g, '$1 $2');
  t = t.replace(/\d+/g, (d) => ' ' + spell(Number(d)) + ' ');
  t = t.replace(/[’']/g, '').replace(/[^a-z ]+/g, ' ');
  const out = [];
  for (const w of t.split(/\s+/)) {
    if (!w || FILLERS.has(w)) continue;
    out.push(...(SAME[w] ?? w).split(' '));
  }
  return out;
}
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Words that change what she does or who/what it's about.
const KEYS = ['shows', 'netflix', 'pause', 'shoes', 'jeans', 'jei', 'modrinth', 'drake', 'frank ocean', 'spotify', 'ram', 'valorant', 'discord', 'oven', 'chrome', 'steam', 'sodium', 'fabric', 'denver', 'skip', 'youtube', 'minecraft', 'thirty', 'lock', 'tokyo', 'sam', 'downloads', 'chill', 'fl studio', 'auto tune', 'kendrick lamar', 'compound interest', 'milk', 'eggs', 'pasta', 'movie', 'joe rogan', 'mute', 'cpu', 'reddit', 'shut down', 'fortnite', 'xbox', 'weeknd', 'blinding lights', 'obs', 'leaderboard', 'japanese', 'coin', 'twenty', 'remember', 'cancel', 'next', 'calendar', 'twitch', 'xqc', 'storage', 'minimize', 'rain', 'lo fi', 'australia', 'twenty five'];
const has = (words, k) => (' ' + words.join(' ') + ' ').includes(' ' + k + ' ');

const files = readdirSync(`${BENCH}/results`).filter((f) => f.endsWith('.jsonl'));
const rows = [];
for (const f of files) {
  const name = f.replace(/\.jsonl$/, '');
  const res = readFileSync(join(BENCH, 'results', f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const per = {};
  let keyN = 0, keyHit = 0, msPc = [], audio = 0, ms = 0, errs = 0;
  const bad = [];
  for (const r of res) {
    const ref = refs.get(r.id);
    if (!ref) continue;
    if (r.hyp.startsWith('<<error')) errs++;
    const R = norm(ref.ref), H = norm(r.hyp);
    const e = edits(R, H);
    const s = (per[ref.set] ??= { e: 0, n: 0, clips: 0 });
    s.e += e; s.n += R.length; s.clips++;
    audio += (statSync(join(BENCH, 'corpus', ref.file)).size - 44) / 32000;
    ms += r.ms;
    if (ref.set === 'pc') {
      msPc.push(r.ms);
      for (const k of KEYS) if (has(R, k)) { keyN++; if (has(H, k)) keyHit++; else bad.push(`${k}: "${r.hyp}"`); }
    }
    if (flag === '--errors' && which === name && e > 0) console.log(`${r.id}\n  ref: ${R.join(' ')}\n  hyp: ${H.join(' ')}`);
  }
  msPc.sort((a, b) => a - b);
  const wer = (k) => (per[k] ? (100 * per[k].e) / per[k].n : NaN);
  const all = Object.values(per).reduce((a, s) => ({ e: a.e + s.e, n: a.n + s.n }), { e: 0, n: 0 });
  rows.push({
    name, clips: res.length, pc: wer('pc'), far: wer('ami-far'), head: wer('ami-head'), libri: wer('libri-other'),
    all: (100 * all.e) / all.n, keys: keyN ? (100 * keyHit) / keyN : NaN, keyMiss: keyN - keyHit,
    p50: msPc[Math.floor(msPc.length / 2)], p90: msPc[Math.floor(msPc.length * 0.9)], rtf: ms / 1000 / audio, errs, bad,
  });
}
rows.sort((a, b) => a.all - b.all);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1).padStart(5) : '    -');
console.log('model                 clips  pc%  ami-far ami-head libri  all%  keys%  miss  p50ms  p90ms   rtf  err');
for (const r of rows) console.log(`${r.name.padEnd(21)} ${String(r.clips).padStart(5)} ${f1(r.pc)} ${f1(r.far)}   ${f1(r.head)}  ${f1(r.libri)} ${f1(r.all)}  ${f1(r.keys)} ${String(r.keyMiss).padStart(5)} ${String(r.p50).padStart(6)} ${String(r.p90).padStart(6)} ${r.rtf.toFixed(3)} ${r.errs}`);
if (flag === '--keys') for (const r of rows.filter((x) => !which || x.name === which)) console.log(`\n${r.name}:\n  ` + r.bad.join('\n  '));
