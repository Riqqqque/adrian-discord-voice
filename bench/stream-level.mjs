// Does streaming change her level? Each line is fetched once from Speechify;
// the same bytes are leveled the old way (levelChunk on the whole sentence,
// which also caps a hot sentence) and the streamed way (calibrated gain +
// StreamLimiter, piece by piece). Prints the largest sample difference and
// whether the whole-sentence cap would have kicked in.
//   node bench/stream-level.mjs <dist dir> <secrets.env> [lines.json]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distArg, secretsFile, linesFile] = process.argv.slice(2);
const dist = pathToFileURL(resolve(distArg)).href;
const { readSecrets } = await import(`${dist}/config.js`);
const { pcm16ToFloat } = await import(`${dist}/speech/speechify.js`);
const { levelChunk, TARGET_LUFS, CEILING_DB } = await import(`${dist}/speech/kokoro.js`);
const { integratedLoudness, StreamLimiter } = await import(`${dist}/audio/loudness.js`);
const key = readSecrets(secretsFile).get('SPEECHIFY_API_KEY');
const lines = linesFile ? JSON.parse(readFileSync(linesFile, 'utf8')) : JSON.parse(readFileSync(new URL('./speak-first-lines.json', import.meta.url), 'utf8'));
const CALIBRATION = "Sure, here's what I found. It's seventy two degrees and clear right now. The capital of Australia is Canberra.";
let chars = 0;
async function fetchPcm(text) {
  chars += text.length;
  const r = await fetch('https://api.speechify.ai/v1/audio/stream', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice_id: 'sabrina', model: 'simba-3.5', language: 'en-US', output_format: 'pcm_24000', options: { text_normalization: true } }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const gain = TARGET_LUFS - integratedLoudness(pcm16ToFloat(await fetchPcm(CALIBRATION)), 24_000);
const rows = [];
for (const text of lines) {
  const raw = pcm16ToFloat(await fetchPcm(text));
  const whole = levelChunk(raw, 24_000, gain);
  const lim = new StreamLimiter(24_000, gain, CEILING_DB);
  const parts = [];
  for (let off = 0; off < raw.length; off += 1_000) parts.push(lim.push(raw.subarray(off, off + 1_000)));
  parts.push(lim.end());
  let maxDiff = 0, o = 0;
  for (const p of parts) for (let i = 0; i < p.length; i++, o++) maxDiff = Math.max(maxDiff, Math.abs(p[i] - whole[o]));
  const over = integratedLoudness(raw, 24_000) + gain - TARGET_LUFS;
  rows.push({ chars: text.length, overTargetLU: +over.toFixed(2), capped: over > 1.5, maxSampleDiff: +maxDiff.toExponential(2), lufsWhole: +integratedLoudness(whole, 24_000).toFixed(2) });
}
console.table(rows);
console.log(JSON.stringify({ gainDb: +gain.toFixed(2), capped: rows.filter((r) => r.capped).length, maxOverLU: Math.max(...rows.map((r) => r.overTargetLU)), chars }));
