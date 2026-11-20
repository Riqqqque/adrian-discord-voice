// What each heard segment costs the server, and whether it wakes her.
// Streams every clip as the server gets it (48 kHz s16, 20 ms frames) through
// the Downsampler and Silero VAD with the PC room's settings, then gives each
// segment to Smart Turn (optional), Parakeet and the wake check, in turn, and
// measures each stage's CPU time (process.cpuUsage, all threads).
//
// Usage: node dist/bench/sidetalk-bench.js <corpus_root> <models_dir> <out.jsonl>
//   env THREADS (Parakeet threads, default 4), TURN=0 (skip Smart Turn),
//   LIMIT (clips per set, for a quick run), SETS (comma list).
// corpus_root holds bench/corpus (labels.json), asr-bench/corpus (refs.jsonl),
// asr-bench/real-raw, samples, samples-ml, samples-name.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParakeetStt as Stt } from '../speech/sherpa.js';
import type { SmartTurn as Turn } from '../speech/smart-turn.js';

// On Windows onnxruntime-node won't load after sherpa-onnx (both ship an
// onnxruntime.dll), and loaded first it takes sherpa's place. So Smart Turn is
// measured in a run of its own (TURN=only), Parakeet in another (TURN=0).
const turnMode = process.env.TURN ?? '0';
if (turnMode !== '0') await import('onnxruntime-node');
const sherpa = (await import('sherpa-onnx-node')).default;
const { ASR_SAMPLE_RATE, Downsampler, ParakeetStt, SileroVad } = await import('../speech/sherpa.js');
const { SmartTurn } = await import('../speech/smart-turn.js');
const { TextWakeDetector } = await import('../wake/text-wake.js');

type Kind = 'wake' | 'notWake' | 'hard';
interface Clip {
  id: string;
  set: string;
  kind: Kind;
  file: string;
}

const [root, models, out] = process.argv.slice(2);
if (!root || !models || !out) {
  console.error('usage: sidetalk-bench <corpus_root> <models_dir> <out.jsonl>');
  process.exit(2);
}
const threads = Number(process.env.THREADS ?? 4);
const useTurn = turnMode !== '0';
const useAsr = turnMode !== 'only';
const limit = Number(process.env.LIMIT ?? Infinity);
const onlySets = process.env.SETS?.split(',');

// --- the corpus ---------------------------------------------------------------
const clips: Clip[] = [];
const add = (c: Clip) => existsSync(c.file) && clips.push(c);
{
  const dir = join(root, 'bench/corpus');
  const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')) as { file: string; kind: 'wake' | 'notWake'; index: number }[];
  // notWake 27-29 say the wake phrase word for word (wake-bench's HARD_INDEXES).
  for (const l of labels) add({ id: `tts/${l.file}`, set: l.kind === 'wake' ? 'tts-wake' : 'tts-side', kind: l.kind === 'wake' ? 'wake' : l.index >= 27 ? 'hard' : 'notWake', file: join(dir, l.file) });
}
{
  const dir = join(root, 'asr-bench/corpus');
  for (const line of readFileSync(join(dir, 'refs.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { id: string; set: string; file: string; ref: string };
    add({ id: r.id, set: r.set, kind: /\badrian\b/.test(r.ref) ? 'wake' : 'notWake', file: join(dir, r.file) });
  }
}
{
  const dir = join(root, 'asr-bench/real-raw');
  for (const day of existsSync(dir) ? readdirSync(dir) : []) {
    for (const line of readFileSync(join(dir, day, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line) as { file: string; local: string };
      add({ id: `real/${r.file}`, set: 'real', kind: /^hey adrian/i.test(r.local) ? 'wake' : 'notWake', file: join(dir, day, r.file) });
    }
  }
}
for (const s of ['samples', 'samples-ml', 'samples-name']) {
  const dir = join(root, s);
  for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.wav')).sort() : []) add({ id: `${s}/${f}`, set: s, kind: s === 'samples-ml' && !f.startsWith('reply-') ? 'wake' : 'notWake', file: join(dir, f) });
}
const perSet = new Map<string, number>();
const todo = clips.filter((c) => {
  if (onlySets && !onlySets.includes(c.set)) return false;
  const n = perSet.get(c.set) ?? 0;
  perSet.set(c.set, n + 1);
  return n < limit;
});

// --- the models ---------------------------------------------------------------
const stt: Stt | undefined = useAsr ? await ParakeetStt.load({ modelDir: join(models, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'), threads }) : undefined;
const turn: Turn | undefined = useTurn ? await SmartTurn.loadHere(join(models, 'smart-turn-v3.2-cpu.onnx')) : undefined;
const wake = new TextWakeDetector();
const vadOptions = { model: join(models, 'silero_vad.onnx'), threshold: 0.5, minSilence: 0.8, minSpeech: 0.25, maxSpeech: 20 };
const TURN_TAIL = new Float32Array(Math.round(0.8 * ASR_SAMPLE_RATE));

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
/** CPU time of f, plus what onnxruntime's idle threads spin for after it
 *  (`settle` ms of waiting, as between two segments): that is real load too. */
async function timed<T>(f: () => T | Promise<T>, settle = 0): Promise<{ v: T; ms: number; wall: number }> {
  const c0 = cpu();
  const w0 = performance.now();
  const v = await f();
  const wall = performance.now() - w0;
  if (settle) await new Promise((r) => setTimeout(r, settle));
  return { v, ms: cpu() - c0, wall };
}
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 80);
const r2 = (x: number) => Math.round(x * 100) / 100;

// warm up: first decodes are slower
{
  const w = sherpa.readWave(todo[0]!.file);
  for (let i = 0; i < 3; i++) await stt?.transcribe(w.samples, w.sampleRate);
  if (turn) await turn.complete(w.samples);
}

const lines: string[] = [];
for (const c of todo) {
  const w = sherpa.readWave(c.file);
  // as the server gets it: 48 kHz s16
  const up = new sherpa.LinearResampler(w.sampleRate, 48_000).resample(w.samples);
  const pcm = Int16Array.from(up, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
  // a second of quiet after it, so the VAD closes it the usual way
  const s16 = new Int16Array(pcm.length + 48_000);
  s16.set(pcm);
  const down = new Downsampler();
  const vad = new SileroVad(vadOptions);
  const segs: Float32Array[] = [];
  const v = await timed(() => {
    for (let i = 0; i < s16.length; i += 960) segs.push(...vad.accept(down.push(s16.subarray(i, i + 960))));
    segs.push(...vad.flush());
  });
  const out: Record<string, unknown>[] = [];
  for (const s of segs) {
    const seconds = s.length / ASR_SAMPLE_RATE;
    if (seconds < 0.3) continue; // the pipeline's MIN_SEGMENT_SECONDS
    const t = turn ? await timed(() => {
      const tail = s.length > 8 * ASR_SAMPLE_RATE ? s.subarray(s.length - 8 * ASR_SAMPLE_RATE) : s;
      const x = new Float32Array(tail.length + TURN_TAIL.length);
      x.set(tail);
      return turn.complete(x);
    }, SETTLE_MS) : undefined;
    const a = await timed(() => stt?.transcribe(s, ASR_SAMPLE_RATE) ?? { text: '', decodeMs: 0 }, stt ? SETTLE_MS : 0);
    const m = await timed(() => wake.matchLoose(a.v.text));
    out.push({
      seconds: r2(seconds),
      text: a.v.text,
      woke: m.v.woke,
      loose: m.v.loose,
      ...(stt ? { asrMs: r2(a.ms), asrWall: r2(a.wall) } : {}),
      ...(t ? { turnMs: r2(t.ms), turnWall: r2(t.wall), p: r2(t.v) } : {}),
      wakeMs: r2(m.ms),
    });
  }
  lines.push(JSON.stringify({ id: c.id, set: c.set, kind: c.kind, audioSeconds: r2(w.samples.length / w.sampleRate), vadMs: r2(v.ms), segments: out }));
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(JSON.stringify({ clips: lines.length, threads, turn: turnMode, out }));
