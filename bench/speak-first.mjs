// Time to her first heard audio, real Sabrina (Speechify), through the real
// Speaker and Mixer. "Heard" = when the mixer's first non-silent frame would
// play: playback open time + its frame index x 20 ms. Also counts silent
// frames inside each line, so a stream that underruns shows up.
//   node bench/speak-first.mjs <dist dir> <secrets.env> [runs] [lines.json] [--gap-ms 2000] [--capture dir] [--dry]
// Uses about 790 characters per run plus 128 for calibration and the warm-up.
// Requests start at least --gap-ms apart (production shares the account); the
// wait comes before a line's clock starts. An HTTP 429 stops the run with exit
// code 3. --capture keeps each answer's raw bytes and when each piece came
// (for bench/stream-level.mjs --from). --dry answers from a fake API instead.
// --replay dir serves a capture's bytes at its captured piece times instead
// (no characters), --slow N stretches those times N-fold (N > ~15 is slower
// than real time). Also counts frames inside a line that are part sound, part
// zero padding (partialInside): the stream fell behind mid-word.
import { readdirSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(k) ? argv.splice(argv.indexOf(k), 2)[1] : undefined);
const dry = argv.includes('--dry') ? (argv.splice(argv.indexOf('--dry'), 1), true) : false;
const GAP_MS = Number(flag('--gap-ms') ?? 2000);
const captureDir = flag('--capture');
const replayDir = flag('--replay');
const slowBy = Number(flag('--slow') ?? 1);
const [distArg, secretsFile, runsArg = '1', linesFile] = argv;
const dist = pathToFileURL(resolve(distArg)).href;
const { readSecrets } = await import(`${dist}/config.js`);
const { CharBudget, SpeechifyTts } = await import(`${dist}/speech/speechify.js`);
const { Speaker } = await import(`${dist}/voice/speaker.js`);
const { Mixer, FRAME_BYTES } = await import(`${dist}/voice/mixer.js`);

const LINES = JSON.parse(readFileSync(linesFile ?? new URL('./speak-first-lines.json', import.meta.url), 'utf8'));

const key = dry || replayDir ? 'offline' : readSecrets(secretsFile).get('SPEECHIFY_API_KEY');

/** The captured answers, by what was asked. */
const replays = new Map();
if (replayDir) {
  for (const f of readdirSync(replayDir).filter((x) => x.endsWith('.json'))) {
    const meta = JSON.parse(readFileSync(`${replayDir}/${f}`, 'utf8'));
    replays.set(meta.input, { ...meta, bytes: readFileSync(`${replayDir}/${f.replace('.json', '.pcm')}`) });
  }
}
/** A stand-in API for --replay: the captured bytes, at the captured times. */
async function replayApi(_url, init) {
  const t0 = performance.now();
  const a = replays.get(String(JSON.parse(String(init.body)).input));
  if (!a) return new Response('not captured', { status: 404 });
  const until = (ms) => new Promise((r) => setTimeout(r, Math.max(0, t0 + ms * slowBy - performance.now())));
  await until(a.headersMs);
  let k = 0;
  let off = 0;
  const body = new ReadableStream({
    async pull(c) {
      if (k >= a.pieces.length) return c.close();
      const p = a.pieces[k++];
      await until(p.ms);
      c.enqueue(new Uint8Array(a.bytes.subarray(off, (off += p.bytes))));
    },
  });
  return new Response(body, { status: 200 });
}

/** A stand-in API for --dry: 3 s of tone per request, in 8 KB pieces. */
async function fakeApi(_url, init) {
  await new Promise((r) => setTimeout(r, 120));
  const pcm = Buffer.alloc(24_000 * 2 * 3);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i / 10) * (Math.sin(i / 3000) > 0 ? 1 : 0.01)), i * 2);
  let off = 0;
  const body = new ReadableStream({ async pull(c) { if (off >= pcm.length) return c.close(); await new Promise((r) => setTimeout(r, 15)); c.enqueue(new Uint8Array(pcm.subarray(off, (off += 8192)))); } });
  void init;
  return new Response(body, { status: 200 });
}

// Every request goes through here: spaced, watched for 429, and captured.
let lastStart = -Infinity;
let spacedInsideLine = 0;
let inLine = false;
let got429 = false;
let n = 0;
if (captureDir) mkdirSync(captureDir, { recursive: true });
async function api(url, init) {
  const wait = lastStart + GAP_MS - performance.now();
  if (wait > 0) {
    if (inLine) spacedInsideLine++;
    await new Promise((r) => setTimeout(r, wait));
  }
  lastStart = performance.now();
  const input = String(JSON.parse(String(init.body)).input);
  const id = String(n++).padStart(2, '0');
  const r = await (dry ? fakeApi : replayDir ? replayApi : fetch)(url, init);
  if (r.status === 429) got429 = true;
  if (!captureDir || !r.ok || !r.body) return r;
  const t0 = lastStart;
  const pieces = [];
  const parts = [];
  const reader = r.body.getReader();
  const body = new ReadableStream({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) {
        writeFileSync(`${captureDir}/${id}.pcm`, Buffer.concat(parts));
        writeFileSync(`${captureDir}/${id}.json`, JSON.stringify({ input, headersMs: Math.round(headersAt - t0), pieces }));
        return c.close();
      }
      pieces.push({ bytes: value.byteLength, ms: Math.round(performance.now() - t0) });
      parts.push(Buffer.from(value));
      c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const headersAt = performance.now();
  return new Response(body, { status: r.status, headers: r.headers });
}
const budget = new CharBudget(undefined, 0, 'UTC');
const fallback = { synthesize: async () => { throw new Error('fell back to the local voice'); } };
const log = { info() {}, warn: (m, f) => console.log('warn', m, JSON.stringify(f ?? {})) };
const tts = new SpeechifyTts({ apiKey: key, voiceId: 'sabrina', model: 'simba-3.5', speed: 1, timeoutMs: 4000, budget, log, fetch: api }, fallback, 'af_heart');

// One playback per line: record when it opened and every frame written.
let cur;
const mixer = new Mixer({
  start(stream) {
    const rec = { openAt: performance.now(), bytes: 0, firstLoud: -1, lastLoud: -1, zeros: [], partial: [] };
    cur = rec;
    stream.on('data', (b) => {
      for (let off = 0; off + FRAME_BYTES <= b.length; off += FRAME_BYTES) {
        const k = (rec.bytes + off) / FRAME_BYTES;
        let loud = false;
        for (let i = off; i < off + FRAME_BYTES; i += 2) if (b.readInt16LE(i) !== 0) { loud = true; break; }
        if (loud) { if (rec.firstLoud < 0) rec.firstLoud = k; rec.lastLoud = k; } else if (rec.firstLoud >= 0) rec.zeros.push(k);
        // Part sound, ending in 1 ms or more of exact zeros: a frame padded with silence.
        if (loud) { let z = true; for (let i = off + FRAME_BYTES - 192; i < off + FRAME_BYTES; i += 2) if (b.readInt16LE(i) !== 0) { z = false; break; } if (z) rec.partial.push(k); }
      }
      rec.bytes += b.length;
    });
    let end;
    const done = new Promise((r) => (end = r));
    stream.on('end', () => end('finished'));
    stream.on('close', () => end('finished'));
    return { done, stop: () => (stream.destroy(), end('stopped')) };
  },
});
const speaker = new Speaker(mixer, tts);
async function* one(t) { yield t; }

await tts.synthesize('Okay, warming up.', { voice: 'cloud:en', speed: 1 }).catch((e) => console.log('warm-up', e.message)); // calibration + connection
if (got429) {
  console.log(JSON.stringify({ stopped: 'HTTP 429', chars: budget.used() }));
  process.exit(3);
}
const rows = [];
for (let run = 0; run < Number(runsArg); run++) {
  for (const line of LINES) {
    // Let the last playback close, and keep requests GAP_MS apart before the clock starts.
    await new Promise((r) => setTimeout(r, Math.max(300, lastStart + GAP_MS - performance.now())));
    inLine = true;
    const t0 = performance.now();
    const r = await speaker.speak(one(line), { voice: 'cloud:en', speed: 1, volume: 0.7 }, AbortSignal.timeout(20_000)).catch((e) => ({ outcome: `error: ${e.message}`, synthMs: [] }));
    inLine = false;
    if (got429) {
      console.log(JSON.stringify({ stopped: 'HTTP 429', after: rows.length, chars: budget.used() }));
      process.exit(3);
    }
    await new Promise((res) => setTimeout(res, 100));
    const rec = cur;
    const heard = rec.firstLoud < 0 ? NaN : rec.openAt + rec.firstLoud * 20 - t0;
    const gaps = rec.zeros.filter((k) => k < rec.lastLoud).length;
    const partial = rec.partial.filter((k) => k < rec.lastLoud).length;
    rows.push({ run, chars: line.length, heardMs: Math.round(heard), speakerFirstMs: r.firstAudioMs, synthMs: r.synthMs[0], silentInside: gaps, partialInside: partial, outcome: r.outcome });
  }
}
console.table(rows);
const med = (k) => { const a = rows.map((x) => x[k]).filter(Number.isFinite).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const p90 = (k) => { const a = rows.map((x) => x[k]).filter(Number.isFinite).sort((x, y) => x - y); return a[Math.floor(a.length * 0.9)]; };
console.log(JSON.stringify({ dist: distArg, n: rows.length, heardMedian: med('heardMs'), heardP90: p90('heardMs'), speakerFirstMedian: med('speakerFirstMs'), synthMedian: med('synthMs'), silentInsideTotal: rows.reduce((n, x) => n + x.silentInside, 0), partialInsideTotal: rows.reduce((n, x) => n + x.partialInside, 0), chars: replayDir ? 0 : budget.used(), spacedInsideLine, ...(replayDir ? { replay: replayDir, slowBy } : {}) }));
