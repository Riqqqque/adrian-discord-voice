// Memory at start, per component: what each model adds to the process once
// loaded (steady) and the most it held while loading or first running (peak).
// Loads the same components, with the same options and in the same order, as
// the service's start (src/app/stack.ts), without Discord or the network.
//
// Usage (after `npm run build`, at low priority on a shared machine):
//   node --expose-gc bench/mem-start.mjs <models dir> [--cloud] [--json file]
//   --cloud   the cloud voice is primary (prod): local Kokoro is only the fallback
//   --dist D  measure another build (relative to the repo root), e.g. a copy of the old dist/
//
// <models dir> holds the install's layout: silero_vad.onnx,
// sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/, kokoro-multi-lang-v1_0/,
// smart-turn-v3.2-cpu.onnx. Linux needs LD_LIBRARY_PATH to include
// node_modules/sherpa-onnx-linux-x64.
//
// rss is the resident set (the working set on Windows). private is memory only
// this process holds: RssAnon on Linux, private bytes on Windows. Peaks come from
// a 10 ms sampler plus the OS's own high-water mark.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  setPriority(19); // idle on Windows, nice 19 on Linux: this is a shared machine
} catch {
  /* not allowed: carry on */
}

const args = process.argv.slice(2);
const modelsDir = args.find((a, i) => !a.startsWith('--') && !['--json', '--dist'].includes(args[i - 1]));
if (!modelsDir) {
  console.error('usage: node --expose-gc bench/mem-start.mjs <models dir> [--cloud] [--json file]');
  process.exit(2);
}
const cloud = args.includes('--cloud');
const jsonOut = args[args.indexOf('--json') + 1];
const root = new URL('..', import.meta.url);
/** Built code to measure: dist/ by default, or --dist DIR (another build, for an A/B). */
const distDir = args.includes('--dist') ? args[args.indexOf('--dist') + 1].replace(/[\\/]*$/, '/') : 'dist/';
const dist = (p) => import(new URL(`${distDir}${p}`, root).href);

const MB = 1048576;
const mb = (b) => Math.round(b / MB);

/** 16-bit PCM mono WAV → float samples (no native module: see --turn-only). */
function readWav(file) {
  const b = readFileSync(file);
  let o = 12;
  while (o + 8 <= b.length && b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  const n = Math.floor(b.readUInt32LE(o + 4) / 2);
  return Float32Array.from({ length: n }, (_, i) => b.readInt16LE(o + 8 + 2 * i) / 32768);
}

/** rss and private now, plus the OS's lifetime peaks. */
function osMem() {
  if (existsSync('/proc/self/status')) {
    const s = readFileSync('/proc/self/status', 'utf8');
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] ?? 0) * 1024;
    return { rss: kb('VmRSS'), priv: kb('RssAnon'), peakRss: kb('VmHWM'), peakPriv: NaN };
  }
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${process.pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.PeakWorkingSet64) $($p.PeakPagedMemorySize64)"`],
      { encoding: 'utf8' },
    );
    const [rss, priv, peakRss, peakPriv] = r.stdout.trim().split(/\s+/).map(Number);
    return { rss, priv, peakRss, peakPriv };
  }
  const rss = process.memoryUsage().rss;
  return { rss, priv: NaN, peakRss: process.resourceUsage().maxRSS * 1024, peakPriv: NaN };
}

// --- a 10 ms sampler: the native loads run off this thread ------------------------
let phasePeak = 0;
const sampler = setInterval(() => {
  const r = process.memoryUsage.rss();
  if (r > phasePeak) phasePeak = r;
}, 10);

const rows = [];
let last = osMem();
const t0 = performance.now();
async function phase(name, fn) {
  phasePeak = process.memoryUsage.rss();
  const before = last;
  const t = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t);
  globalThis.gc?.();
  await new Promise((r) => setTimeout(r, 300));
  const now = osMem();
  const peak = Math.max(phasePeak, process.memoryUsage.rss());
  rows.push({
    phase: name,
    ms,
    rssMb: mb(now.rss),
    privMb: mb(now.priv),
    addRssMb: mb(now.rss - before.rss),
    addPrivMb: mb(now.priv - before.priv),
    peakRssMb: mb(peak),
    peakOverEndMb: mb(peak - now.rss),
    osPeakRssMb: mb(now.peakRss),
    osPeakPrivMb: mb(now.peakPriv),
  });
  last = now;
  return out;
}

// --- the start, in the service's order ---------------------------------------------
const asrDir = join(modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
const ttsDir = join(modelsDir, 'kokoro-multi-lang-v1_0');
const turnModel = join(modelsDir, 'smart-turn-v3.2-cpu.onnx');
const vadModel = join(modelsDir, 'silero_vad.onnx');
const threads = 4; // listen.asrThreads and voice.threads defaults
const voice = 'af_heart';

if (args.includes('--turn-only')) {
  // Windows can't hold two onnxruntime.dll builds in one process (sherpa-onnx
  // brings its own), so there Smart Turn is measured alone and added on.
  const { SmartTurn } = await dist('speech/smart-turn.js');
  const wav = readWav(join(modelsDir, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'test_wavs', 'en.wav'));
  await phase('turn-only base', () => undefined);
  await phase('smart turn (worker) + first check', async () => {
    const d = await SmartTurn.load(join(modelsDir, 'smart-turn-v3.2-cpu.onnx'));
    await d.complete(wav);
    globalThis.__turn = d;
  });
  console.log(JSON.stringify(rows[1]));
  process.exit(0);
}

await phase('node + code (stack.js imports)', () => dist('app/stack.js'));
const { ParakeetStt, SileroVad, Downsampler } = await dist('speech/sherpa.js');
const { KokoroTts } = await dist('speech/kokoro.js');
const { SmartTurn } = await dist('speech/smart-turn.js');
const { EnglishWords } = await dist('speech/language.js');

const { Client, GatewayIntentBits, Partials } = await import('discord.js');
await phase('discord client (no login)', () => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] }));

// The service's own start step for the local voice, when this build has one
// (src/app/local-voice.ts); the old build calibrated Kokoro at every start.
const localVoice = existsSync(new URL(`${distDir}app/local-voice.js`, root)) ? await dist('app/local-voice.js') : undefined;
const stt = await phase('asr load (parakeet)', () => ParakeetStt.load({ modelDir: asrDir, threads }));
const tts = new KokoroTts({ modelDir: ttsDir, threads });
await phase(localVoice ? 'tts: prepareLocalVoice' : 'tts load + calibration (kokoro)', () =>
  localVoice
    ? localVoice.prepareLocalVoice(tts, { modelDir: ttsDir, voice, speed: 1, cloudPrimary: cloud }, { info() {}, warn() {} })
    : tts.gainFor(voice, 1),
);

// First real use grows onnxruntime's arenas: a normal question, then a maximum-length segment.
const en = readWav(join(asrDir, 'test_wavs', 'en.wav'));
await phase('asr first decodes (5 s + 20 s)', async () => {
  await stt.transcribe(en, 16_000);
  const long = new Float32Array(20 * 16_000);
  for (let i = 0; i < long.length; i += en.length) long.set(en.subarray(0, Math.min(en.length, long.length - i)), i);
  await stt.transcribe(long, 16_000);
});
if (!cloud) await phase('tts first sentence', () => tts.synthesize("Sure, I set a timer for ten minutes. It'll ring at four thirty.", { voice, speed: 1 }));

await phase('english words', () => new EnglishWords(join(ttsDir, 'lexicon-us-en.txt')));
await phase('vad x4 users + audio', () => {
  const vads = Array.from({ length: 4 }, () => ({ d: new Downsampler(), v: new SileroVad({ model: vadModel, threshold: 0.5, minSilence: 0.5, minSpeech: 0.25, maxSpeech: 20 }) }));
  const pcm48 = new Int16Array(48_000);
  for (const u of vads) for (let s = 0; s < 5; s++) u.v.accept(u.d.push(pcm48));
  globalThis.__vads = vads;
});
const prism = (await import('prism-media')).default;
await phase('opus encoder', () => new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 }).destroy());
let turnApart;
if (process.platform === 'win32') {
  const r = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), modelsDir, '--turn-only', '--dist', distDir], { encoding: 'utf8' });
  turnApart = JSON.parse(r.stdout.trim().split('\n').pop());
  turnApart.phase = 'smart turn (worker) + first check [own process]';
} else {
  await phase('smart turn (worker) + first check', async () => {
    const d = await SmartTurn.load(turnModel);
    await d.complete(en);
    globalThis.__turn = d;
  });
}
await phase('settled (3 s)', () => new Promise((r) => setTimeout(r, 3000)));

clearInterval(sampler);
const end = osMem();
const summary = {
  cloud,
  platform: process.platform,
  node: process.version,
  build: distDir,
  localVoiceStep: !!localVoice,
  totalMs: Math.round(performance.now() - t0),
  // On Windows Smart Turn's own-process additions are added on (see --turn-only).
  steadyRssMb: mb(end.rss) + (turnApart?.addRssMb ?? 0),
  steadyPrivMb: mb(end.priv) + (turnApart?.addPrivMb ?? 0),
  peakRssMb: Math.max(...rows.map((r) => r.peakRssMb), mb(end.peakRss)) + (turnApart?.addRssMb ?? 0),
  osPeakPrivMb: mb(end.peakPriv) + (turnApart?.addPrivMb ?? 0),
};
if (turnApart) rows.push(turnApart);
console.table(rows);
console.log(JSON.stringify(summary));
if (jsonOut && !jsonOut.startsWith('--')) writeFileSync(jsonOut, JSON.stringify({ summary, rows }, null, 2));
process.exit(0);
