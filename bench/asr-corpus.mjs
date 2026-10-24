// Builds the speech-to-text shootout corpus (16 kHz mono WAV + refs.jsonl):
//  pc:  60 things said to her at a PC, in 4 voices (her Sabrina voice from
//       Speechify, and three Kokoro voices incl. a British one), each roughed
//       up like a desk mic: room noise, echo, a cheap headset, quiet speech.
//  ami-far: real meeting speech from one microphone across the room (AMI sdm).
//  ami-head: real meeting speech from headset mics (AMI ihm).
//  libri-other: LibriSpeech's harder read speech.
//   node bench/asr-corpus.mjs <models dir> <bot.json> <out dir>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { loadConfig, readSecrets } from '../dist/config.js';
import { KokoroTts } from '../dist/speech/kokoro.js';

const [M, cfgPath, OUT] = process.argv.slice(2);
const secrets = readSecrets(loadConfig(cfgPath).secretsFile);
mkdirSync(OUT, { recursive: true });
const refs = [];

function wav(samples, rate = 16000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}
// Any audio file (AMI is float WAV, LibriSpeech is FLAC) to 16 kHz mono via ffmpeg.
function decode(buf) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { input: buf, maxBuffer: 1 << 28 });
  if (r.status !== 0 || !r.stdout.length) throw new Error(`ffmpeg: ${r.stderr}`);
  const out = new Float32Array(r.stdout.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = r.stdout.readInt16LE(i * 2) / 32768;
  return out;
}
const save = (set, id, samples, ref) => {
  mkdirSync(join(OUT, set), { recursive: true });
  const file = join(set, `${id}.wav`);
  writeFileSync(join(OUT, file), wav(samples));
  refs.push({ id: `${set}/${id}`, set, file, ref });
};

// --- degradations -----------------------------------------------------------
let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
function noise(x, snrDb) {
  const target = rms(x) / 10 ** (snrDb / 20);
  let b = 0; // brown-ish room rumble + hiss
  const n = Float32Array.from(x, () => ((b = b * 0.98 + (rnd() - 0.5) * 0.4), b + (rnd() - 0.5) * 0.3));
  const k = target / (rms(n) || 1);
  return Float32Array.from(x, (v, i) => v + n[i] * k);
}
function echo(x) {
  const y = Float32Array.from(x);
  for (const [ms, g] of [[23, 0.35], [57, 0.25], [111, 0.15], [173, 0.08]]) {
    const d = Math.round((ms / 1000) * 16000);
    for (let i = d; i < x.length; i++) y[i] += x[i - d] * g;
  }
  return y;
}
function headset(x) {
  let lp = 0, hpIn = 0, hpOut = 0;
  return Float32Array.from(x, (v) => {
    hpOut = 0.95 * (hpOut + v - hpIn); hpIn = v; // ~200 Hz high-pass
    lp += 0.55 * (hpOut - lp); // ~3.4 kHz low-pass
    return Math.tanh(lp * 2.2) / 2.2; // a little clipping
  });
}
const DEGRADE = [
  ['noise', (x) => noise(x, 18)],
  ['echo+noise', (x) => noise(echo(x), 15)],
  ['headset', (x) => noise(headset(x), 20)],
  ['quiet+noise', (x) => noise(Float32Array.from(x, (v) => v * 0.25), 12)],
];

// --- pc commands ---------------------------------------------------------------
const PHRASES = [
  'hey adrian what shows are good on netflix right now', 'pause the show', 'what shoes should i wear with black jeans',
  'open the jei modrinth page', 'put on some drake', 'play nights by frank ocean', 'turn spotify down a little',
  'what is eating up my ram', 'open valorant and mute discord', 'remind me in ten minutes to check the oven',
  'who sings the song that is playing', 'switch to chrome and close steam', 'how do i install sodium on fabric',
  'what is the weather in denver tomorrow', 'skip this song it is trash', 'search youtube for minecraft speedrun world record',
  'set the volume to thirty', 'lock my computer', 'what time is it in tokyo', 'tell sam i will be on in five minutes',
  'how many people are in the discord call', 'open my downloads folder', 'is the minecraft server up', 'play something chill for studying',
  'what was that song from earlier', 'turn the volume up on discord', 'open fl studio with auto tune', 'what is kendrick lamar doing these days',
  'can you explain how compound interest works', 'yo what is good adrian', 'bro that was hilarious', 'add milk and eggs to my list',
  'how long do i boil pasta', 'what is a good movie to watch tonight', 'play the newest joe rogan episode', 'mute my mic in discord',
  'close all my chrome tabs', 'what is my cpu temperature', 'go to reddit dot com', 'shut down my pc in an hour',
  'what does fortnite cost on xbox', 'play the weeknd blinding lights', 'open obs and start recording', 'show me the leaderboard for valorant',
  'how do i say thank you in japanese', 'flip a coin', 'roll a twenty sided die', 'what did i ask you to remember',
  'cancel my timer', 'next song please', 'go back to the last song', 'what is on my calendar tomorrow',
  'open twitch and find xqc', 'how much storage do i have left', 'minimize everything', 'is it going to rain this weekend',
  'play lofi hip hop on youtube', 'what is the capital of australia', 'set a timer for twenty five minutes', 'okay thanks that is all',
];
// `real` as a 4th argument keeps the pc clips already built and redoes only the recorded sets.
const REAL_ONLY = process.argv[5] === 'real';
if (REAL_ONLY) refs.push(...readFileSync(join(OUT, 'refs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.set === 'pc'));
const kokoro = REAL_ONLY ? undefined : new KokoroTts({ modelDir: `${M}/kokoro-multi-lang-v1_0`, threads: 4 });
const spKey = secrets.get('SPEECHIFY_API_KEY');
async function sabrina(text) {
  const r = await fetch('https://api.speechify.ai/v1/audio/stream', {
    method: 'POST',
    headers: { Authorization: `Bearer ${spKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice_id: 'sabrina', model: 'simba-3.2', language: 'en-US', output_format: 'pcm_24000', options: { text_normalization: true } }),
  });
  if (!r.ok) throw new Error(`speechify ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  const f = new Float32Array(b.length / 2);
  for (let i = 0; i < f.length; i++) f[i] = b.readInt16LE(i * 2) / 32768;
  return new sherpa.LinearResampler(24000, 16000).flush(f);
}
const VOICES = ['sabrina', 'am_michael', 'af_heart', 'bm_george'];
let n = 0;
for (const [pi, p] of REAL_ONLY ? [] : PHRASES.entries()) {
  for (const [vi, v] of VOICES.entries()) {
    let s;
    if (v === 'sabrina') s = spKey ? await sabrina(p) : undefined;
    else {
      const q = await kokoro.synthesize(p, { voice: v, speed: v === 'af_heart' ? 1.15 : 1 });
      s = new sherpa.LinearResampler(q.sampleRate, 16000).flush(q.samples);
    }
    if (!s) continue;
    const [dname, d] = DEGRADE[(pi + vi) % DEGRADE.length];
    // 0.3 s of room tone before and after, like a real segment
    const pad = new Float32Array(4800);
    const full = new Float32Array(pad.length * 2 + s.length);
    full.set(s, pad.length);
    save('pc', `${String(pi).padStart(2, '0')}-${v}-${dname}`, d(full), p);
    n++;
  }
}
console.log(`pc: ${n} clips`);

// --- real recorded speech (Hugging Face datasets server) ----------------------------
async function rows(dataset, config, split, want, textKey, minWords, maxWords) {
  const got = [];
  for (let off = 0; got.length < want && off < 3000; off += 100) {
    const r = await fetch(`https://datasets-server.huggingface.co/rows?dataset=${dataset}&config=${config}&split=${split}&offset=${off}&length=100`);
    if (!r.ok) { console.log('rows failed', dataset, r.status); break; }
    const j = await r.json();
    for (const { row } of j.rows) {
      const text = String(row[textKey] ?? '');
      const w = text.split(/\s+/).filter(Boolean).length;
      if (w < minWords || w > maxWords) continue;
      const src = Array.isArray(row.audio) ? row.audio[0]?.src : row.audio?.src;
      if (src) got.push({ text, src });
      if (got.length >= want) break;
    }
  }
  return got;
}
for (const [set, ds, cfg, split, want, key] of [
  ['ami-far', 'edinburghcstr/ami', 'sdm', 'test', 60, 'text'],
  ['ami-head', 'edinburghcstr/ami', 'ihm', 'test', 40, 'text'],
  ['libri-other', 'openslr/librispeech_asr', 'other', 'test', 40, 'text'],
]) {
  const list = await rows(ds, cfg, split, want, key, 6, 30);
  let k = 0;
  for (const [i, it] of list.entries()) {
    const r = await fetch(it.src);
    if (!r.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    try {
      save(set, String(i).padStart(3, '0'), decode(buf), it.text);
      k++;
    } catch (e) {
      console.log('skip', set, i, e.message);
    }
  }
  console.log(`${set}: ${k} clips`);
}
writeFileSync(join(OUT, 'refs.jsonl'), refs.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`total ${refs.length}`);
