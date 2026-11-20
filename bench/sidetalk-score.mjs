// Scores runs of dist/bench/sidetalk-bench.js: wake recall and false wakes per
// set, CPU ms per segment (median, p90) by stage, and CPU real-time factor.
// With two or more runs of the same corpus it also checks that every clip got
// the same words and the same wake decision in each.
//
// Usage: node bench/sidetalk-score.mjs <run.jsonl> [run2.jsonl ...]

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: sidetalk-score <run.jsonl> [run2.jsonl ...]');
  process.exit(2);
}
const pct = (a, p) => {
  // nearest rank
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const r1 = (x) => Math.round(x * 10) / 10;

const runs = files.map((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
for (const [i, clips] of runs.entries()) {
  const sets = new Map();
  const seg = { asr: [], turn: [], wake: [], total: [], side: [], asrWall: [], turnWall: [] };
  let audio = 0, cpuAll = 0, vadAll = 0;
  for (const c of clips) {
    const woke = c.segments.some((s) => s.woke);
    const strict = c.segments.some((s) => s.woke && !s.loose);
    const k = `${c.set}:${c.kind}`;
    const x = sets.get(k) ?? { n: 0, woke: 0, strict: 0, segments: 0 };
    x.n++;
    x.woke += woke ? 1 : 0;
    x.strict += strict ? 1 : 0;
    x.segments += c.segments.length;
    sets.set(k, x);
    audio += c.audioSeconds;
    vadAll += c.vadMs;
    cpuAll += c.vadMs;
    for (const s of c.segments) {
      const t = (s.asrMs ?? 0) + (s.turnMs ?? 0) + s.wakeMs;
      if (s.asrMs !== undefined) seg.asr.push(s.asrMs);
      if (s.turnMs !== undefined) seg.turn.push(s.turnMs);
      if (s.asrWall !== undefined) seg.asrWall.push(s.asrWall);
      if (s.turnWall !== undefined) seg.turnWall.push(s.turnWall);
      seg.wake.push(s.wakeMs);
      seg.total.push(t);
      if (c.kind !== 'wake') seg.side.push(t);
      cpuAll += t;
    }
  }
  const tot = (kind) => [...sets.entries()].filter(([k]) => k.endsWith(`:${kind}`)).reduce((a, [, x]) => ({ n: a.n + x.n, woke: a.woke + x.woke, strict: a.strict + x.strict }), { n: 0, woke: 0, strict: 0 });
  const w = tot('wake'), nw = tot('notWake'), h = tot('hard');
  const stat = (a) => ({ median: r1(pct(a, 50)), p90: r1(pct(a, 90)), mean: r1(a.reduce((x, y) => x + y, 0) / (a.length || 1)) });
  console.log(`== ${files[i]}`);
  console.log(JSON.stringify({
    clips: clips.length,
    segments: seg.total.length,
    wakeRecall: `${w.woke}/${w.n}`,
    wakeRecallStrict: `${w.strict}/${w.n}`,
    falseWakes: `${nw.woke}/${nw.n}`,
    falseWakesStrict: `${nw.strict}/${nw.n}`,
    hardWoke: `${h.woke}/${h.n}`,
    cpuMsPerSegment: stat(seg.total),
    cpuMsPerSideSegment: stat(seg.side),
    asrMs: stat(seg.asr),
    turnMs: seg.turn.length ? stat(seg.turn) : null,
    wakeMs: stat(seg.wake),
    asrWallMs: seg.asrWall.length ? stat(seg.asrWall) : null,
    turnWallMs: seg.turnWall.length ? stat(seg.turnWall) : null,
    asrCpuSecondsPerAudioSecond: seg.asr.length ? Number((seg.asr.reduce((a, b) => a + b, 0) / 1000 / audio).toFixed(4)) : null,
    vadMsPerAudioSecond: r1(vadAll / audio),
    cpuRtf: Number((cpuAll / 1000 / audio).toFixed(4)),
    audioSeconds: Math.round(audio),
  }));
  for (const [k, x] of [...sets.entries()].sort()) console.log(`  ${k.padEnd(22)} n=${String(x.n).padStart(3)} woke=${x.woke} strict=${x.strict} segs=${x.segments}`);
}

// The same words and decisions in every run?
if (runs.length > 1) {
  const base = new Map(runs[0].map((c) => [c.id, c]));
  for (const [i, clips] of runs.entries()) {
    if (i === 0) continue;
    let textDiff = 0, wakeDiff = 0, missing = 0;
    const shown = [];
    for (const c of clips) {
      const b = base.get(c.id);
      if (!b) {
        missing++;
        continue;
      }
      const tb = b.segments.map((s) => s.text).join(' | '), tc = c.segments.map((s) => s.text).join(' | ');
      const wb = b.segments.map((s) => `${s.woke}${s.loose}`).join(), wc = c.segments.map((s) => `${s.woke}${s.loose}`).join();
      if (tb !== tc) {
        textDiff++;
        if (shown.length < 8) shown.push(`  ${c.id}: "${tb}" -> "${tc}"`);
      }
      if (wb !== wc) wakeDiff++;
    }
    console.log(`== ${files[i]} vs ${files[0]}: textDiffers=${textDiff} wakeDecisionDiffers=${wakeDiff} missing=${missing}`);
    for (const s of shown) console.log(s);
  }
}
