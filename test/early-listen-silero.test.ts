// The early listen with the real Silero VAD on rendered speech, at the frame
// sizes a client might send: how often the quick VAD's clip is the one the full
// wait closes (its words are then reused), and how many decodes that takes.
// Needs ADRIAN_MODELS (see test/speech-clips.ts); skipped without it.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { describe, expect, it } from 'vitest';
import type { SpeechToText, VoiceTransport, WakeDetector } from '../src/core/interfaces.js';
import { type HeardEvent, ListeningPipeline } from '../src/listen/pipeline.js';
import { SileroVad } from '../src/speech/sherpa.js';
import { clips, join16, MODELS, NO_MODELS, quiet } from './speech-clips.js';

const SILERO = MODELS && join(MODELS, 'silero_vad.onnx');
const ON = !!SILERO && existsSync(SILERO);
if (!ON) console.warn(`early-listen-silero: skipped, ${NO_MODELS}`);

const vadOpts = (minSilence: number) => ({ model: SILERO!, threshold: 0.5, minSilence, minSpeech: 0.25, maxSpeech: 20 });

/** One utterance: clips with the pause before each one after the first, s. */
type Utterance = [string, number?][];
const SINGLES: Utterance[] = ['wake', 'wake2', 'name', 'cmd', 'follow', 'play', 'drake', 'side'].map((c) => [[c]]);
/** A pause inside the 0.32-0.8 s band: the full wait closes more than the quick one. */
const PAUSED: Utterance[] = [
  [['name'], ['cmd', 0.45]],
  [['play'], ['drake', 0.4]],
  [['wake'], ['follow', 0.4]],
];
/** A long pause: two clips, each its own. */
const APART: Utterance[] = [[['wake'], ['follow', 1.2]]];

type Framing = { name: string; next: () => number };
function framings(): Framing[] {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return [
    { name: '960 (20 ms)', next: () => 960 },
    { name: '882', next: () => 882 },
    { name: '1920', next: () => 1920 },
    { name: '4800 (100 ms)', next: () => 4800 },
    { name: 'random 200-4200', next: () => 200 + Math.floor(rnd() * 4000) },
  ];
}

interface Count {
  clips: number;
  reused: number;
  decodes: number;
  lengths: number[];
}

/** Feeds utterances through a PC-style pipeline (0.8 s wait, 0.32 s early) and counts. */
function run(audio: Record<string, Int16Array>, utterances: Utterance[], framing: Framing, early = true): Promise<Count> {
  const transport = new EventEmitter();
  const c: Count = { clips: 0, reused: 0, decodes: 0, lengths: [] };
  const stt = {
    transcribe: async (s: Float32Array) => {
      c.decodes++;
      return { text: `n${s.length}`, decodeMs: 0 };
    },
  } as unknown as SpeechToText;
  const wake = { match: (t: string) => ({ woke: false, remainder: t }) } as unknown as WakeDetector;
  const p = new ListeningPipeline(transport as unknown as VoiceTransport, stt, wake, vadOpts(0.8), undefined, early ? { minSilence: 0.32 } : undefined);
  const heard: HeardEvent[] = [];
  p.on('heard', (e) => void heard.push(e));
  for (const u of utterances) {
    const parts = [quiet(0.3)];
    for (const [clip, pause] of u) {
      if (pause) parts.push(quiet(pause, 99));
      parts.push(audio[clip]!);
    }
    parts.push(quiet(1.2, 5));
    const all = join16(...parts);
    for (let o = 0; o < all.length; ) {
      const n = framing.next();
      transport.emit('audio', 'u1', { samples: all.subarray(o, o + n), sampleRate: 48_000, receivedAt: performance.now() });
      o += n;
    }
    transport.emit('speechEnd', 'u1');
  }
  return new Promise((done) =>
    setTimeout(() => {
      c.clips = heard.length;
      c.reused = heard.filter((e) => e.early).length;
      c.lengths = heard.map((e) => e.samples!.length);
      done(c);
    }, 50),
  );
}

describe.skipIf(!ON)('the early listen on real Silero', () => {
  it('reuses the quick clip for speech said in one go, however the audio is framed', async () => {
    const audio = await clips(MODELS!);
    const lines: string[] = [];
    const results: { one: Count; paused: Count; apart: Count }[] = [];
    for (const f of framings()) {
      const one = await run(audio, SINGLES, f);
      const paused = await run(audio, PAUSED, f);
      const apart = await run(audio, APART, f);
      results.push({ one, paused, apart });
      lines.push(`${f.name.padEnd(16)} in one go ${one.reused}/${one.clips} reused, ${one.decodes} decodes | 0.4 s pause ${paused.reused}/${paused.clips}, ${paused.decodes} decodes | 1.2 s apart ${apart.reused}/${apart.clips}, ${apart.decodes} decodes`);
    }
    process.stderr.write(`early listen, real Silero:\n${lines.join('\n')}\n`);
    for (const { one, paused, apart } of results) {
      expect(one.clips).toBe(SINGLES.length);
      expect(one.reused).toBe(one.clips);
      expect(one.decodes).toBe(one.clips);
      // a pause in the band: the full clip is decoded on its own, nothing reused
      expect(paused.clips).toBe(PAUSED.length);
      expect(paused.reused).toBe(0);
      expect(apart.clips).toBe(2);
      expect(apart.reused).toBe(2);
    }
  }, 120_000);

  it('the full wait cuts the same clips with or without it', async () => {
    const audio = await clips(MODELS!);
    for (const f of framings().slice(0, 1)) {
      const on = await run(audio, [...SINGLES, ...PAUSED, ...APART], f);
      const off = await run(audio, [...SINGLES, ...PAUSED, ...APART], f, false);
      expect(on.lengths).toEqual(off.lengths);
    }
  }, 120_000);

  it('20 ms frames: SileroVad cuts exactly what sherpa cut when it was handed whole frames', async () => {
    const audio = await clips(MODELS!);
    const all = join16(quiet(0.3), audio.wake!, quiet(1.2), audio.name!, quiet(0.45), audio.cmd!, quiet(1.2), audio.side!, quiet(1.2));
    for (const minSilence of [0.8, 0.32]) {
      const mine = new SileroVad({ ...vadOpts(minSilence), preroll: 0 });
      const raw = new sherpa.Vad({ sileroVad: { model: SILERO!, threshold: 0.5, minSilenceDuration: minSilence, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 }, sampleRate: 16_000, numThreads: 1, provider: 'cpu', debug: 0 }, 30);
      const down = [new sherpa.LinearResampler(48_000, 16_000), new sherpa.LinearResampler(48_000, 16_000)];
      const a: Float32Array[] = [];
      const b: Float32Array[] = [];
      for (let o = 0; o < all.length; o += 960) {
        const f = Float32Array.from(all.subarray(o, o + 960), (v) => v / 32768);
        a.push(...mine.accept(down[0]!.resample(f)));
        raw.acceptWaveform(down[1]!.resample(f));
        while (!raw.isEmpty()) {
          b.push(Float32Array.from(raw.front(false).samples));
          raw.pop();
        }
      }
      expect(a.length).toBeGreaterThanOrEqual(3);
      expect(a.map((s) => Array.from(s))).toEqual(b.map((s) => Array.from(s)));
    }
  }, 120_000);
});
