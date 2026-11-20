// Time to her first heard audio, real Sabrina (Speechify), through the real
// Speaker and Mixer. "Heard" = when the mixer's first non-silent frame would
// play: playback open time + its frame index x 20 ms. Also counts silent
// frames inside each line, so a stream that underruns shows up.
//   node bench/speak-first.mjs <dist dir> <secrets.env> [runs] [lines.json]
// Uses about 790 characters per run plus 111 for calibration.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [distArg, secretsFile, runsArg = '1', linesFile] = process.argv.slice(2);
const dist = pathToFileURL(resolve(distArg)).href;
const { readSecrets } = await import(`${dist}/config.js`);
const { CharBudget, SpeechifyTts } = await import(`${dist}/speech/speechify.js`);
const { Speaker } = await import(`${dist}/voice/speaker.js`);
const { Mixer, FRAME_BYTES } = await import(`${dist}/voice/mixer.js`);

const LINES = JSON.parse(readFileSync(linesFile ?? new URL('./speak-first-lines.json', import.meta.url), 'utf8'));

const key = readSecrets(secretsFile).get('SPEECHIFY_API_KEY');
const budget = new CharBudget(undefined, 0, 'UTC');
const fallback = { synthesize: async () => { throw new Error('fell back to the local voice'); } };
const log = { info() {}, warn: (m, f) => console.log('warn', m, JSON.stringify(f ?? {})) };
const tts = new SpeechifyTts({ apiKey: key, voiceId: 'sabrina', model: 'simba-3.5', speed: 1, timeoutMs: 4000, budget, log }, fallback, 'af_heart');

// One playback per line: record when it opened and every frame written.
let cur;
const mixer = new Mixer({
  start(stream) {
    const rec = { openAt: performance.now(), bytes: 0, firstLoud: -1, lastLoud: -1, zeros: [] };
    cur = rec;
    stream.on('data', (b) => {
      for (let off = 0; off + FRAME_BYTES <= b.length; off += FRAME_BYTES) {
        const k = (rec.bytes + off) / FRAME_BYTES;
        let loud = false;
        for (let i = off; i < off + FRAME_BYTES; i += 2) if (b.readInt16LE(i) !== 0) { loud = true; break; }
        if (loud) { if (rec.firstLoud < 0) rec.firstLoud = k; rec.lastLoud = k; } else if (rec.firstLoud >= 0) rec.zeros.push(k);
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

await tts.synthesize('Okay, warming up.', { voice: 'cloud:en', speed: 1 }); // calibration + connection
const rows = [];
for (let run = 0; run < Number(runsArg); run++) {
  for (const line of LINES) {
    await new Promise((r) => setTimeout(r, 300)); // let the last playback close
    const t0 = performance.now();
    const r = await speaker.speak(one(line), { voice: 'cloud:en', speed: 1, volume: 0.7 }, AbortSignal.timeout(20_000));
    await new Promise((res) => setTimeout(res, 100));
    const rec = cur;
    const heard = rec.firstLoud < 0 ? NaN : rec.openAt + rec.firstLoud * 20 - t0;
    const gaps = rec.zeros.filter((k) => k < rec.lastLoud).length;
    rows.push({ run, chars: line.length, heardMs: Math.round(heard), speakerFirstMs: r.firstAudioMs, synthMs: r.synthMs[0], silentInside: gaps, outcome: r.outcome });
  }
}
console.table(rows);
const med = (k) => { const a = rows.map((x) => x[k]).filter(Number.isFinite).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const p90 = (k) => { const a = rows.map((x) => x[k]).filter(Number.isFinite).sort((x, y) => x - y); return a[Math.floor(a.length * 0.9)]; };
console.log(JSON.stringify({ dist: distArg, n: rows.length, heardMedian: med('heardMs'), heardP90: p90('heardMs'), speakerFirstMedian: med('speakerFirstMs'), synthMedian: med('synthMs'), silentInsideTotal: rows.reduce((n, x) => n + x.silentInside, 0), chars: budget.used() }));
