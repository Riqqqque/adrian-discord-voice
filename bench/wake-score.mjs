// Scores the wake check by replaying saved transcripts through it: the words
// Parakeet wrote for each segment (sidetalk-bench and wake-asr runs) go
// through matchLoose of a baseline detector and of the current one, so a rule
// change is judged without decoding again.
//
// The corpus is split by phrase, never by clip: every voice and noise of one
// phrase lands on the same side. Within each class the phrases are ordered by
// a fixed hash and every third one is held out. Held-out transcripts are only
// printed with --final.
//
// Usage: node bench/wake-score.mjs [--base old/text-wake.js] [--new dist/wake/text-wake.js]
//          [--show] [--final] [--time] <run.jsonl> [run2.jsonl ...]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const basePath = opt('--base');
const newPath = opt('--new') ?? 'dist/wake/text-wake.js';
const show = flag('--show');
const final = flag('--final');
const time = flag('--time');
if (!args.length) {
  console.error('usage: wake-score [--base old.js] [--new new.js] [--show] [--final] [--time] <run.jsonl> ...');
  process.exit(2);
}
const load = async (p) => new (await import(pathToFileURL(resolve(p)).href)).TextWakeDetector();
const detectors = [...(basePath ? [['base', await load(basePath)]] : []), ['new', await load(newPath)]];

// --- the clips, their class and phrase ------------------------------------------
/** Class and phrase of a clip from the sidetalk corpus (or the extra one, which says). */
function place(c) {
  if (c.cls) return { cls: c.cls, phrase: c.phrase };
  let m;
  if ((m = /^tts\/(wake|notWake)-(\d+)-/.exec(c.id))) return { cls: c.kind === 'hard' ? 'tts-hard' : c.kind === 'wake' ? 'tts-wake' : 'tts-side', phrase: `tts-${m[1]}-${m[2]}` };
  if ((m = /^pc\/(\d+)-/.exec(c.id))) return { cls: c.kind === 'wake' ? 'pc-wake' : 'pc-side', phrase: `pc-${m[1]}` };
  if (c.set === 'real' || c.set.startsWith('samples')) return { cls: `${c.set}-${c.kind}`, phrase: c.id };
  return { cls: c.set, phrase: c.id };
}
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (const ch of `wake-split-1:${s}`) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h;
};

const clips = [];
for (const f of args) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
  const c = JSON.parse(l);
  clips.push({ ...c, ...place(c) });
}
const heldOut = new Set();
const byCls = new Map();
for (const c of clips) (byCls.get(c.cls) ?? byCls.set(c.cls, new Set()).get(c.cls)).add(c.phrase);
for (const phrases of byCls.values()) [...phrases].sort((a, b) => fnv(a) - fnv(b) || (a < b ? -1 : 1)).forEach((p, i) => i % 3 === 2 && heldOut.add(p));
for (const c of clips) c.split = heldOut.has(c.phrase) ? 'held-out' : 'tuning';

// --- replay ---------------------------------------------------------------------------
/** A wake that asks something besides greeting her (then an empty request is wrong). */
const hasAsk = (c) => c.kind === 'wake' && c.segments.some((s) => s.text.replace(/\b(hey|hi|okay|ok|yo|hello|adrian\w*|um|uh|so|good|morning|evening|afternoon|there|excuse|me)\b|[^a-z]/gi, '').length > 0);
function judge(d, c) {
  let woke = false, strict = false, empty = false;
  const segs = [];
  for (const s of c.segments) {
    const m = d.matchLoose(s.text);
    segs.push(m.woke ? (m.loose ? 'L' : 'S') : '-');
    if (m.woke) {
      woke = true;
      if (!m.loose) strict = true;
      if (!m.remainder.trim()) empty = true;
    }
  }
  return { woke, strict, empty: woke && empty && hasAsk(c), segs };
}
const KINDS = ['wake', 'notWake', 'hard', 'undecidable'];
const results = new Map(); // detector -> split -> kind -> {n, woke, strict, empty}
const perCls = new Map(); // `${split}|${cls}` -> detector -> counts
for (const [name, d] of detectors) {
  for (const c of clips) {
    const r = judge(d, c);
    c[name] = r;
    for (const split of [c.split, 'all']) {
      const k = `${name}|${split}|${c.kind}`;
      const x = results.get(k) ?? { n: 0, woke: 0, strict: 0, empty: 0 };
      x.n++;
      x.woke += +r.woke;
      x.strict += +r.strict;
      x.empty += +r.empty;
      results.set(k, x);
    }
    const key = `${c.split}|${c.cls}`;
    const pc = perCls.get(key) ?? perCls.set(key, { kind: c.kind }).get(key);
    const x = pc[name] ?? (pc[name] = { n: 0, woke: 0, strict: 0, empty: 0 });
    x.n++;
    x.woke += +r.woke;
    x.strict += +r.strict;
    x.empty += +r.empty;
  }
}

// The base detector on the sidetalk runs must give the decisions those runs saved.
if (basePath) {
  let diff = 0;
  for (const c of clips) for (const [i, s] of c.segments.entries()) if (s.woke !== undefined && `${s.woke ? (s.loose ? 'L' : 'S') : '-'}` !== c.base.segs[i]) diff++;
  console.log(`replay check: ${diff} segments decided differently from the saved run`);
}

const cell = (x, f) => (x ? `${x[f]}/${x.n}` : '-');
for (const split of ['tuning', 'held-out', 'all']) {
  const phrases = new Set(clips.filter((c) => split === 'all' || c.split === split).map((c) => c.phrase)).size;
  console.log(`\n== ${split} (${phrases} phrases)`);
  console.log('detector | recall loose | recall strict | false wakes loose | false wakes strict | hard loose | hard strict | undecidable loose | undecidable strict | wake with no request');
  for (const [name] of detectors) {
    const g = (k) => results.get(`${name}|${split}|${k}`);
    console.log(`${name} | ${cell(g('wake'), 'woke')} | ${cell(g('wake'), 'strict')} | ${cell(g('notWake'), 'woke')} | ${cell(g('notWake'), 'strict')} | ${cell(g('hard'), 'woke')} | ${cell(g('hard'), 'strict')} | ${cell(g('undecidable'), 'woke')} | ${cell(g('undecidable'), 'strict')} | ${cell(g('wake'), 'empty')}`);
  }
  if (split === 'all') continue;
  console.log(`  class (kind) | ${detectors.map(([n]) => `${n} woke / strict`).join(' | ')}`);
  for (const [key, pc] of [...perCls.entries()].filter(([k]) => k.startsWith(`${split}|`)).sort()) {
    console.log(`  ${key.split('|')[1]} (${pc.kind}) | ${detectors.map(([n]) => `${cell(pc[n], 'woke')} / ${cell(pc[n], 'strict')}`).join(' | ')}`);
  }
}

// Clips decided wrongly (or differently from the base) by the current detector.
if (show || final) {
  console.log('\n== wrong or changed (current detector)');
  for (const c of clips) {
    if (c.split === 'held-out' && !final) continue;
    const r = c.new;
    const wrong = c.kind === 'wake' ? !r.strict || r.empty : r.woke;
    const changed = c.base && c.base.segs.join() !== r.segs.join();
    if (wrong || changed) console.log(`${c.split} ${c.kind} ${c.cls} ${c.base ? c.base.segs.join('') + '>' : ''}${r.segs.join('')}${r.empty ? ' EMPTY' : ''} ${c.id}: ${c.segments.map((s) => s.text).join(' | ')}`);
  }
}

// What one check costs: every transcript, plus a long joined one.
if (time) {
  const long = 'so I was thinking we could probably just go to the store after this match and grab some snacks because honestly I am starving and nobody ate anything since lunch and the game is going to take at least another hour if we keep losing rounds like this so yeah what do you guys think about that plan';
  const texts = [...clips.flatMap((c) => c.segments.map((s) => s.text)), long];
  console.log(`\n== cost per matchLoose call (${texts.length} texts, ${long.split(' ').length}-word one included)`);
  for (const [name, d] of detectors) {
    for (let i = 0; i < 200; i++) for (const t of texts) d.matchLoose(t); // warm up
    const reps = 2000;
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) for (const t of texts) d.matchLoose(t);
    const all = Number(process.hrtime.bigint() - t0) / 1e3 / (reps * texts.length);
    t0 = process.hrtime.bigint();
    for (let i = 0; i < reps * 20; i++) d.matchLoose(long);
    const one = Number(process.hrtime.bigint() - t0) / 1e3 / (reps * 20);
    console.log(`${name}: ${all.toFixed(2)} us per transcript on average, ${one.toFixed(2)} us for the long one`);
  }
}
