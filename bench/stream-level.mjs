// Does streaming change her level? Each line's raw Speechify audio is leveled
// three ways: whole (levelChunk on the whole sentence, which caps a hot
// sentence), the first streaming build (calibrated gain + StreamLimiter, piece
// by piece, no cap), and StreamCap (the cap on all but the first 0.6 s, held
// until the sentence is in). Prints each one's loudness against the target,
// checks that sentences that aren't hot come out sample for sample as before,
// and, with captured piece times, whether the held part was ever due before
// the sentence was in (then it plays uncapped). --slow N stretches the
// captured times N-fold to force that path.
//   node bench/stream-level.mjs <dist dir> <secrets.env> [lines.json]   fetches (about 900 characters)
//   node bench/stream-level.mjs <dist dir> --from <capture dir>         no characters: audio and piece
//                                                                       sizes saved by speak-first.mjs --capture
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dist = pathToFileURL(resolve(args[0])).href;
const { pcm16ToFloat } = await import(`${dist}/speech/speechify.js`);
const { levelChunk, TARGET_LUFS, CEILING_DB, MAX_OVER_LU } = await import(`${dist}/speech/kokoro.js`);
const { integratedLoudness, StreamLimiter, StreamCap } = await import(`${dist}/audio/loudness.js`);
const { CAP_FREE_S, CAP_DUE_MS } = await import(`${dist}/speech/speechify.js`);
const slowBy = args.includes('--slow') ? Number(args[args.indexOf('--slow') + 1]) : 1;
const CALIBRATION = "Sure, here's what I found. It's seventy two degrees and clear right now. The capital of Australia is Canberra.";

/** [{ input, bytes: Buffer, pieces: number[] (byte sizes) }] */
let answers;
let chars = 0;
if (args[1] === '--from') {
  const dir = args[2];
  answers = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const meta = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      return { input: meta.input, bytes: readFileSync(`${dir}/${f.replace('.json', '.pcm')}`), pieces: meta.pieces.map((p) => p.bytes), times: meta.pieces.map((p) => p.ms * slowBy) };
    });
} else {
  const { readSecrets } = await import(`${dist}/config.js`);
  const key = readSecrets(args[1]).get('SPEECHIFY_API_KEY');
  const lines = JSON.parse(readFileSync(args[2] ?? new URL('./speak-first-lines.json', import.meta.url), 'utf8'));
  answers = [];
  for (const text of [CALIBRATION, ...lines]) {
    chars += text.length;
    const r = await fetch('https://api.speechify.ai/v1/audio/stream', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice_id: 'sabrina', model: 'simba-3.5', language: 'en-US', output_format: 'pcm_24000', options: { text_normalization: true } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const parts = [];
    for await (const p of r.body) parts.push(Buffer.from(p));
    answers.push({ input: text, bytes: Buffer.concat(parts), pieces: parts.map((p) => p.length) });
    await new Promise((res) => setTimeout(res, 2_000));
  }
}
const cal = answers.find((a) => a.input === CALIBRATION);
if (!cal) throw new Error('no calibration answer');
const gain = TARGET_LUFS - integratedLoudness(pcm16ToFloat(cal.bytes), 24_000);

/** Feed the bytes as they came (16-bit samples split across pieces carried
 *  over). With piece times, a StreamCap is released when its held part is
 *  due before the next piece, as rawStream does. */
function streamed(lim, a) {
  const out = [];
  let carry;
  let off = 0;
  let first = -1;
  let firstAt;
  let released = false;
  for (const [k, n] of a.pieces.entries()) {
    const at = a.times?.[k];
    if (lim.holding && at !== undefined && firstAt !== undefined && at > firstAt + CAP_DUE_MS) {
      out.push(lim.release());
      released = true;
    }
    let b = a.bytes.subarray(off, off + n);
    off += n;
    if (carry) b = Buffer.concat([carry, b]);
    const even = b.length & ~1;
    carry = even < b.length ? Buffer.from(b.subarray(even)) : undefined;
    const o = lim.push(pcm16ToFloat(b.subarray(0, even)));
    if (first < 0 && o.length) first = out.reduce((s, x) => s + x.length, 0) + o.length;
    if (o.length && firstAt === undefined) firstAt = at;
    out.push(o);
  }
  out.push(lim.end());
  const all = new Float32Array(out.reduce((k, x) => k + x.length, 0));
  let k = 0;
  for (const x of out) (all.set(x, k), (k += x.length));
  return { all, first, released, lastAfterFirstMs: a.times && firstAt !== undefined ? a.times.at(-1) - firstAt : undefined };
}
const over = (x) => +(integratedLoudness(x, 24_000) - TARGET_LUFS).toFixed(2);
const rows = [];
for (const a of answers) {
  if (a === cal || a.input.length <= 40) continue; // short lines never stream
  const raw = pcm16ToFloat(a.bytes);
  const whole = levelChunk(raw, 24_000, gain);
  const old = streamed(new StreamLimiter(24_000, gain, CEILING_DB), a);
  const lev = new StreamCap(24_000, gain, CEILING_DB, { maxLufs: TARGET_LUFS + MAX_OVER_LU, freeS: CAP_FREE_S });
  const now = streamed(lev, a);
  let same = old.all.length === now.all.length;
  for (let i = 0; same && i < old.all.length; i++) same = old.all[i] === now.all[i];
  const rawOver = integratedLoudness(raw, 24_000) + gain - TARGET_LUFS;
  rows.push({
    chars: a.input.length,
    pieces: a.pieces.length,
    rawOverLU: +rawOver.toFixed(2),
    hot: rawOver > MAX_OVER_LU,
    wholeLU: over(whole),
    oldStreamLU: over(old.all),
    capLU: over(now.all),
    cutDb: +lev.cutDb.toFixed(2),
    sameAsOld: same,
    firstOutSame: old.first === now.first,
    inAfterMs: now.lastAfterFirstMs,
    released: now.released,
  });
}
console.table(rows);
const hot = rows.filter((r) => r.hot);
const cool = rows.filter((r) => !r.hot);
const worst = (rs, k) => (rs.length ? Math.max(...rs.map((r) => r[k])) : null);
console.log(
  JSON.stringify({
    gainDb: +gain.toFixed(2),
    lines: rows.length,
    hot: hot.length,
    hotOldStreamOverCapLU: worst(hot.map((r) => ({ v: r.oldStreamLU - MAX_OVER_LU })), 'v'),
    hotCapOverCapLU: worst(hot.map((r) => ({ v: r.capLU - MAX_OVER_LU })), 'v'),
    hotWholeOverCapLU: worst(hot.map((r) => ({ v: r.wholeLU - MAX_OVER_LU })), 'v'),
    coolUnchanged: cool.filter((r) => r.sameAsOld).length,
    coolMaxCutDb: worst(cool, 'cutDb'),
    firstOutSame: rows.every((r) => r.firstOutSame),
    released: rows.filter((r) => r.released).length,
    slowestInAfterMs: worst(rows.filter((r) => r.inAfterMs !== undefined), 'inAfterMs'),
    chars,
  }),
);
