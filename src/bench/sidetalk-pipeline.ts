// The PC room's real ListeningPipeline, fed in real time: clips back to back
// (1 s apart, as a person talking on and off), Smart Turn holds and joins
// included. Counts what the server decodes against what it heard, and the
// process CPU per heard segment.
//
// Usage: node dist/bench/sidetalk-pipeline.js <corpus_root> <models_dir> <out.jsonl>
//   env THREADS (Parakeet, default 4), MINUTES (audio to feed, default 12).

import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sherpa from 'sherpa-onnx-node';
import type { SpeechToText, VoiceTransport } from '../core/interfaces.js';
import { endsDangling, type HeardEvent, ListeningPipeline } from '../listen/pipeline.js';
import { EnglishWords } from '../speech/language.js';
import { ParakeetStt } from '../speech/sherpa.js';
import type { TurnDetector } from '../speech/smart-turn.js';
import { TextWakeDetector } from '../wake/text-wake.js';

const [root, models, out] = process.argv.slice(2);
if (!root || !models || !out) {
  console.error('usage: sidetalk-pipeline <corpus_root> <models_dir> <out.jsonl>');
  process.exit(2);
}
const threads = Number(process.env.THREADS ?? 4);
const minutes = Number(process.env.MINUTES ?? 12);

// --- a session: continuous talk first, then single utterances -----------------
interface Clip { id: string; wake: boolean; file: string }
const clips: Clip[] = [];
const dirOf = (d: string) => join(root, d);
const wavs = (d: string) => (existsSync(dirOf(d)) ? readdirSync(dirOf(d)).filter((f) => f.endsWith('.wav')).sort() : []);
for (const f of wavs('samples')) clips.push({ id: `samples/${f}`, wake: false, file: join(dirOf('samples'), f) });
for (const f of wavs('asr-bench/corpus/ami-long').slice(0, 40)) clips.push({ id: `ami-long/${f}`, wake: false, file: join(dirOf('asr-bench/corpus/ami-long'), f) });
{
  const labels = JSON.parse(readFileSync(join(root, 'bench/corpus/labels.json'), 'utf8')) as { file: string; kind: string; voice: string }[];
  // one voice per phrase, the voices taking turns
  const seen = new Set<string>();
  for (const l of labels) {
    const key = `${l.kind}-${l.file.split('-')[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clips.push({ id: `tts/${l.file}`, wake: l.kind === 'wake', file: join(root, 'bench/corpus', l.file) });
  }
}
for (const f of wavs('asr-bench/corpus/ami-head')) clips.push({ id: `ami-head/${f}`, wake: false, file: join(dirOf('asr-bench/corpus/ami-head'), f) });

// --- models ---------------------------------------------------------------
const stt = await ParakeetStt.load({ modelDir: join(models, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'), threads });
const child = fork(fileURLToPath(new URL('./turn-child.js', import.meta.url)), [join(models, 'smart-turn-v3.2-cpu.onnx')], { serialization: 'advanced' });
let turnCalls = 0, turnCpu = 0, nextId = 0;
const waiting = new Map<number, (p: number) => void>();
await new Promise<void>((ok) => child.on('message', (m: { ready?: true; id?: number; p?: number; cpuMs?: number }) => {
  if (m.ready) return ok();
  turnCpu += m.cpuMs ?? 0;
  waiting.get(m.id!)?.(m.p ?? 1);
  waiting.delete(m.id!);
}));
const detector: TurnDetector = {
  complete: (samples) => new Promise((ok) => {
    turnCalls++;
    const id = nextId++;
    waiting.set(id, ok);
    child.send({ id, samples });
  }),
};
let decodes = 0, decodedSeconds = 0;
const counting: SpeechToText = {
  transcribe(samples, rate, signal) {
    decodes++;
    decodedSeconds += samples.length / rate;
    return stt.transcribe(samples, rate, signal);
  },
};
const wake = new TextWakeDetector();
const english = new EnglishWords(join(models, 'kokoro-multi-lang-v1_0/lexicon-us-en.txt'));
class FakeTransport extends EventEmitter {
  connect = async () => undefined;
  disconnect = async () => undefined;
  isReady = () => true;
}
const transport = new FakeTransport();
let holds = 0;
const pipeline = new ListeningPipeline(
  transport as unknown as VoiceTransport,
  counting,
  wake,
  { model: join(models, 'silero_vad.onnx'), threshold: 0.5, minSilence: 0.8, minSpeech: 0.25, maxSpeech: 20 },
  {
    detector,
    holdMs: 1200,
    onHold: () => void holds++,
    // stack.ts's, with no follow-up window and no push-to-talk: side talk
    shouldHold: (_user, text) => {
      const m = wake.matchLoose(text);
      if (!m.woke) return false;
      const said = m.woke ? m.remainder : text;
      return !english.looksEnglish(said) || endsDangling(said);
    },
    onHeldWords: () => undefined,
  },
);
const heard: (HeardEvent & { clip?: string })[] = [];
const spans: { id: string; from: number; to: number; wake: boolean }[] = [];
pipeline.on('heard', (e) => {
  const start = (e.vadClosedAt ?? e.segmentClosedAt) - e.audioSeconds * 1000;
  const c = spans.find((s) => start >= s.from - 400 && start < s.to);
  heard.push({ ...e, ...(c ? { clip: c.id } : {}) });
});

// --- feed in real time --------------------------------------------------------
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME = 960; // 20 ms at 48 kHz
const gap = new Int16Array(48_000); // 1 s of quiet between clips
let fed = 0, speechSeconds = 0;
const c0 = cpu();
const t0 = performance.now();
let clock = t0;
for (const c of clips) {
  if (fed / 48_000 / 60 >= minutes) break;
  const w = sherpa.readWave(c.file);
  const up = new sherpa.LinearResampler(w.sampleRate, 48_000).resample(w.samples);
  const pcm = Int16Array.from(up, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
  speechSeconds += pcm.length / 48_000;
  const from = performance.now();
  for (const part of [pcm, gap]) {
    for (let i = 0; i < part.length; i += FRAME) {
      clock += 20;
      const ahead = clock - performance.now();
      if (ahead > 0) await sleep(ahead);
      transport.emit('audio', 'u1', { samples: part.subarray(i, i + FRAME), sampleRate: 48_000, receivedAt: performance.now() });
      fed += FRAME;
    }
    if (part === pcm) spans.push({ id: c.id, from, to: performance.now(), wake: c.wake });
  }
}
await sleep(6_000); // holds and decodes still running
const mainCpu = cpu() - c0;
const wall = (performance.now() - t0) / 1000;
child.kill();

const heardSeconds = heard.reduce((a, e) => a + e.audioSeconds, 0);
const wakeSpans = spans.filter((s) => s.wake);
const woke = new Set(heard.filter((e) => e.woke && e.clip).map((e) => e.clip));
const sideWoke = heard.filter((e) => e.woke && !wakeSpans.some((s) => s.id === e.clip)).length;
writeFileSync(out, heard.map((e) => JSON.stringify({ clip: e.clip, text: e.text, woke: e.woke, loose: e.loose ?? false, seconds: e.audioSeconds, holdMs: e.holdMs ?? null })).join('\n') + '\n');
const r1 = (x: number) => Math.round(x * 10) / 10;
console.log(JSON.stringify({
  threads,
  clips: spans.length,
  fedSeconds: r1(fed / 48_000),
  speechSeconds: r1(speechSeconds),
  wallSeconds: r1(wall),
  heard: heard.length,
  heardSeconds: r1(heardSeconds),
  decodes,
  decodedSeconds: r1(decodedSeconds),
  decodedPerHeardSecond: Number((decodedSeconds / heardSeconds).toFixed(3)),
  turnCalls,
  holds,
  wakeClipsWoke: `${woke.size}/${wakeSpans.length}`,
  wokeOutsideWakeClips: sideWoke,
  mainCpuMs: Math.round(mainCpu),
  turnCpuMs: Math.round(turnCpu),
  cpuMsPerHeard: r1((mainCpu + turnCpu) / heard.length),
  cpuRtfOfFed: Number(((mainCpu + turnCpu) / 1000 / (fed / 48_000)).toFixed(4)),
}));
