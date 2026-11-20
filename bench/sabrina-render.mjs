// Renders the changed corpus lines (bench/speech-changed.mjs output) with the
// real cloud voice, before and after, as the text each build sends: one
// request per sentence, 0.25 s between sentences. Score the WAVs on a machine
// with Parakeet: node bench/speech-wavs.mjs <dir> <parakeet dir>.
//   node bench/sabrina-render.mjs <secrets.env> <changed.json> <out dir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [secretsFile, changedFile, outDir] = process.argv.slice(2);
const env = readFileSync(secretsFile, 'utf8');
const key = /^SPEECHIFY_API_KEY=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!key) throw new Error('no SPEECHIFY_API_KEY');
const changed = JSON.parse(readFileSync(changedFile, 'utf8'));
mkdirSync(outDir, { recursive: true });
let chars = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One sentence, gently: the account's rate limit is shared with production. */
async function voice(text, tries = 4) {
  await sleep(700);
  chars += text.length;
  const r = await fetch('https://api.speechify.ai/v1/audio/stream', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice_id: 'sabrina', model: 'simba-3.5', language: 'en-US', output_format: 'pcm_24000', options: { text_normalization: true } }),
  });
  if (r.status === 429 && tries > 1) {
    chars -= text.length;
    await sleep(8_000);
    return voice(text, tries - 1);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
function wav(path, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24_000, 24); h.writeUInt32LE(48_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
}
const gap = Buffer.alloc(0.25 * 24_000 * 2);
const meta = [];
for (const l of changed) {
  for (const side of ['before', 'after']) {
    if (existsSync(`${outDir}/${l.id}.${side}.wav`)) continue; // a rerun after a rate limit
    const parts = [];
    for (const c of l[side]) parts.push(await voice(c), gap);
    wav(`${outDir}/${l.id}.${side}.wav`, Buffer.concat(parts));
  }
  meta.push({ id: l.id, heldOut: l.heldOut, say: l.say, before: l.before, after: l.after });
}
writeFileSync(`${outDir}/lines.json`, JSON.stringify(meta, null, 1));
console.log(JSON.stringify({ lines: changed.length, chars }));
