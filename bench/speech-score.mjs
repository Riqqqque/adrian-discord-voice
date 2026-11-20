// Word error rate for spoken lines: one normalizer for the reference and the
// transcript, so "3:45 PM", "345 p.m." and "three forty five PM" all match.
// Used by bench/speech-words.mjs and bench/speech-wavs.mjs.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function spell(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + spell(n % 100) : '');
  // Four digits read in pairs: years, 1080, 5070, 1499 (not 2000-2009 or round hundreds).
  if (n > 1000 && n < 10_000 && n % 100 !== 0 && !(n >= 2000 && n < 2010)) return spell(Math.floor(n / 100)) + ' ' + (n % 100 < 10 ? 'oh ' + ONES[n % 100] : spell(n % 100));
  if (n < 1_000_000) return spell(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + spell(n % 1000) : '');
  return String(n).split('').map((d) => ONES[+d]).join(' ');
}
const ORD = { first: 'one', second: 'two', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve' };
const FILLERS = new Set(['uh', 'um', 'mm', 'hmm', 'ah', 'eh', 'oh', 'er', 'and', 'the']);
const SAME = { dr: 'doctor', mr: 'mister', st: 'saint', etc: 'et cetera', acdc: 'ac dc', okay: 'ok', youre: 'you are', its: 'it is', thats: 'that is', youve: 'you have', theyre: 'they are', itll: 'it will', gigs: 'gigabytes', gig: 'gigabyte', megs: 'megabits', approx: 'approximately', percents: 'percent', minus: 'negative', mins: 'minutes', min: 'minutes', o: '', clock: '', fahrenheit: '', celsius: '' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Units right after a number, as the recognizer writes them when it heard the word.
const UNITS = { GB: 'gigabytes', MB: 'megabytes', Mbps: 'megabits per second', Hz: 'hertz', ms: 'milliseconds', km: 'kilometers', kg: 'kilograms', mph: 'miles per hour', lbs: 'pounds', ft: 'feet' };
export function norm(s) {
  s = s.replace(/(\d)\s?(GB|MB|Mbps|Hz|ms|km|kg|mph|lbs|ft)\b/g, (_, d, u) => `${d} ${UNITS[u]}`);
  // Times written without the colon: "815 AM", "1.10 pm", "101 p.m.".
  s = s.replace(/\b(\d{1,2})[.:]?(\d\d)\s*([ap])\.?\s?m\b\.?/gi, '$1:$2 $3m');
  let t = s.toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[’]/g, "'").replace(/\b([a-z])\.([a-z])\b\.?/g, '$1$2');
  t = t.replace(/(\d),(\d{3})/g, '$1$2');
  t = t.replace(/\$(\d+)\.(\d\d)\b/g, '$1 dollars $2 cents').replace(/\$(\d+)/g, '$1 dollars').replace(/€(\d+)/g, '$1 euros').replace(/£(\d+)/g, '$1 pounds');
  t = t.replace(/(\d+)\s*%/g, '$1 percent').replace(/°\s*[fc]?\b/g, ' degrees ').replace(/(\d+)(st|nd|rd|th)\b/g, '$1');
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (m, a, b) => (+a >= 1 && +a <= 12 ? `${MONTHS[+a - 1]} ${b}` : m));
  t = t.replace(/(\d+):(\d\d)(?::(\d\d))?/g, (_, h, m, s2) => (s2 ? ` ${+h} hours ${+m} minutes ${+s2} seconds ` : ` ${+h} ${m === '00' ? '' : m[0] === '0' ? 'oh ' + m[1] : m} `));
  t = t.replace(/(\d+)((?:\.\d+)+)/g, (_, a, rest) => [a, ...rest.slice(1).split('.').map((b) => (b.length === 1 ? spell(+b) : b))].join(' point '));
  t = t.replace(/(\d+)-(\d+)/g, '$1 to $2');
  t = t.replace(/\d+/g, (d) => ' ' + spell(Number(d)) + ' ');
  t = t.replace(/\b(\w+)\.(com|net|org|txt|pdf)\b/g, '$1 dot $2');
  t = t.replace(/[']/g, '').replace(/[^a-z ]+/g, ' ');
  const out = [];
  for (let w of t.split(/\s+/)) {
    if (!w || FILLERS.has(w)) continue;
    w = ORD[w] ?? (/^(\w+)ieth$/.test(w) ? w.replace(/ieth$/, 'y') : /^(four|six|seven|ten|eleven|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|hundred|thousand)th$/.test(w) ? w.slice(0, -2) : w);
    const s2 = SAME[w];
    if (s2 === '') continue;
    out.push(...(s2 ?? w).split(' '));
  }
  // Letters said one by one ("P M", "p.m.", "PM") count as one word.
  const merged = [];
  let run = false;
  for (const w of out) {
    if (w.length === 1 && run) merged[merged.length - 1] += w;
    else merged.push(w);
    run = w.length === 1 || (run && w.length === 1);
  }
  return merged.flatMap((w) => (SAME[w] ? SAME[w].split(" ") : [w]));
}
export function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Best (lowest WER) match of a transcript against the acceptable readings. */
export function score(heard, says) {
  const h = norm(heard);
  let best = { errors: Infinity, words: 1 };
  for (const s of says) {
    const r = norm(s);
    const e = edits(r, h);
    if (e / r.length < best.errors / best.words) best = { errors: e, words: r.length, ref: r.join(' ') };
  }
  return { ...best, hyp: h.join(' ') };
}

export const summary = (rs) => {
  const e = rs.reduce((n, r) => n + r.errors, 0);
  const w = rs.reduce((n, r) => n + r.words, 0);
  return { lines: rs.length, wrongLines: rs.filter((r) => r.errors > 0).length, errors: e, words: w, wer: +((100 * e) / Math.max(1, w)).toFixed(1) };
};
