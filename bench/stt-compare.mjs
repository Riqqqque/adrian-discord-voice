// Local Parakeet vs Whisper large v3 turbo on Groq, on things said to her at
// a PC: two voices, normal and fast, with room noise mixed in. Prints word
// error rate per engine and Groq's latency.
//   LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64 node bench/stt-compare.mjs <models dir> <bot.json>
import sherpa from 'sherpa-onnx-node';
import { loadConfig, readSecrets } from '../dist/config.js';
import { KokoroTts } from '../dist/speech/kokoro.js';
import { ParakeetStt } from '../dist/speech/sherpa.js';
import { groqTranscribe, sttPrompt } from '../dist/speech/cloud-stt.js';

const [M, cfgPath] = process.argv.slice(2);
const c = loadConfig(cfgPath);
const key = readSecrets(c.secretsFile).get('GROQ_API_KEY');
const kokoro = new KokoroTts({ modelDir: `${M}/kokoro-multi-lang-v1_0`, threads: 4 });
const parakeet = await ParakeetStt.load({ modelDir: `${M}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, threads: 4 });

const phrases = [
  'hey adrian what shows are good on netflix right now',
  'pause the show',
  'what shoes should i wear with black jeans',
  'open the jei modrinth page',
  'put on some drake',
  'turn spotify down a little',
  'what is eating up my ram',
  'open valorant and mute discord',
  'remind me in ten minutes to check the oven',
  'who sings the song that is playing',
  'switch to chrome and close steam',
  'how do i install sodium on fabric',
  'what is the weather in denver tomorrow',
  'skip this song it is trash',
  'search youtube for minecraft speedrun world record',
];
const NUM = { 10: 'ten', 2: 'two', 1: 'one', 5: 'five' };
const norm = (s) =>
  s.toLowerCase().replace(/\b(\d+)\b/g, (d) => NUM[d] ?? d).replace(/what's/g, 'what is').replace(/it's/g, 'it is').replace(/that's/g, 'that is').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = norm(ref), h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length };
}

const tot = { local: { e: 0, w: 0 }, groq: { e: 0, w: 0 } };
const lat = [];
let seed = 7;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.06;
for (const [voice, speed] of [['am_michael', 1.0], ['af_heart', 1.15]]) {
  for (const p of phrases) {
    const q = await kokoro.synthesize(p, { voice, speed });
    const pcm = new sherpa.LinearResampler(q.sampleRate, 16000).flush(q.samples);
    const noisy = Float32Array.from(pcm, (v) => v * 0.6 + noise());
    const local = (await parakeet.transcribe(noisy, 16000)).text;
    await new Promise((r) => setTimeout(r, 3200)); // Groq free tier: ~20 a minute
    const t0 = performance.now();
    const cloud = await groqTranscribe(key, noisy, 16000, { prompt: sttPrompt(['Rique']), signal: AbortSignal.timeout(8000) });
    lat.push(performance.now() - t0);
    const a = wer(p, local), b = wer(p, cloud);
    tot.local.e += a.errors; tot.local.w += a.words;
    tot.groq.e += b.errors; tot.groq.w += b.words;
    if (a.errors || b.errors) console.log(`${voice} ${speed}  "${p}"\n   local: ${local}${a.errors ? `  (${a.errors})` : ''}\n   groq:  ${cloud}${b.errors ? `  (${b.errors})` : ''}`);
  }
}
lat.sort((x, y) => x - y);
console.log(`\nword error rate: local ${((100 * tot.local.e) / tot.local.w).toFixed(1)}%, groq ${((100 * tot.groq.e) / tot.groq.w).toFixed(1)}%`);
console.log(`groq latency ms: median ${Math.round(lat[lat.length >> 1])}, worst ${Math.round(lat.at(-1))}`);
