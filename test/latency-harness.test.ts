// Reply latency harness: real startVoiceStack, real ListeningPipeline and real
// Silero VAD, fed rendered speech the way a PC sends it (20 ms frames in real
// time, the gate's 1.2 s quiet tail, then speech_end). Everything that waits on
// a network or a big model is a stub with a fixed delay taken from production:
// local recognition (serialized, like Parakeet), Smart Turn, Groq, the model's
// first sentence and the first sentence's voice. Prints where the time goes,
// from the end of the speech in the clip to her first audio.
//
// Off in the normal suite. Run it with:
//   LATENCY_HARNESS=1 npx vitest run test/latency-harness.test.ts
// Options (env): LATENCY_RUNS (5), LATENCY_STT_MS (300, comma list for several),
// LATENCY_OUT (raw runs as JSON), LATENCY_TABLE (the table as text), ADRIAN_MODELS (D:/Tools/adrian-models).
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setPriority, constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'discord.js';
import sherpa from 'sherpa-onnx-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVoiceStack } from '../src/app/stack.js';
import { PocConfigSchema } from '../src/config.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import { SmartTurn } from '../src/speech/smart-turn.js';
import { MODEL_LAYOUT } from '../src/web/checks.js';

const ON = process.env.LATENCY_HARNESS === '1';
const MODELS = process.env.ADRIAN_MODELS ?? 'D:/Tools/adrian-models';
const RUNS = Number(process.env.LATENCY_RUNS ?? 5);
const STT_LIST = (process.env.LATENCY_STT_MS ?? '300').split(',').map(Number);

/** Production medians (14 days, 20 answers), ms. */
const DELAY = { turn: 155, groq: 523, llmFirstSentence: 1360, ttsFirst: 428 };

const h = vi.hoisted(() => ({ sat: undefined as any }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawnSync: () => ({ status: 0 }) }));
vi.mock('../src/transport/discord.js', async () => {
  const { EventEmitter } = await import('node:events');
  class DiscordVoiceTransport extends EventEmitter {
    up = false;
    playPcm() {
      return { done: Promise.resolve('finished'), stop() {} };
    }
    isReady() {
      return this.up;
    }
    retry() {}
    async connect() {
      this.up = true;
    }
    async disconnect() {
      this.up = false;
    }
  }
  return { DiscordVoiceTransport };
});
vi.mock('../src/satellite/server.js', () => ({
  startSatelliteServer: (o: unknown) => {
    h.sat = o;
    return { connections: () => [], close: async () => {} };
  },
}));

const OWNER = '100000000000000030';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => unknown, what: string, ms = 15_000) {
  const t0 = performance.now();
  while (!ok()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

// --- speech ---------------------------------------------------------------
const LINES: Record<string, [string, number]> = {
  wake: ['Hey Adrian, open Spotify.', 0],
  wake2: ['Hey Adrian, what is the capital of Australia?', 11],
  name: ['Hey Adrian.', 0],
  cmd: ['Open Spotify.', 0],
  follow: ['And turn it up a little.', 0],
  play: ['Hey Adrian, play', 0],
  drake: ['Drake.', 0],
  side: ['So then we went to the store and they were out of everything.', 3],
};

/** 48 kHz s16 mono renders of LINES, cached between runs. Nothing is played. */
async function clips(): Promise<Record<string, Int16Array>> {
  const dir = join(tmpdir(), 'adrian-latency-clips');
  mkdirSync(dir, { recursive: true });
  const out: Record<string, Int16Array> = {};
  let tts: any;
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.002;
  for (const [name, [text, sid]] of Object.entries(LINES)) {
    const f = join(dir, `${name}.pcm`);
    if (!existsSync(f)) {
      const d = join(MODELS, 'kokoro-multi-lang-v1_0');
      tts ??= await sherpa.OfflineTts.createAsync({
        model: { kokoro: { model: `${d}/model.onnx`, voices: `${d}/voices.bin`, tokens: `${d}/tokens.txt`, dataDir: `${d}/espeak-ng-data`, lexicon: `${d}/lexicon-us-en.txt`, lang: 'en-us' }, numThreads: 2, provider: 'cpu', debug: 0 },
        maxNumSentences: 1,
      });
      const a = await tts.generateAsync({ text, sid, speed: 1 });
      const up: Float32Array = new sherpa.LinearResampler(a.sampleRate, 48_000).flush(a.samples);
      const pcm = Int16Array.from(up, (v) => Math.max(-32768, Math.min(32767, Math.round((v * 0.5 + noise()) * 32767))));
      writeFileSync(f, Buffer.from(pcm.buffer));
    }
    const b = readFileSync(f);
    out[name] = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  }
  return out;
}
/** A mic's noise floor, never digital silence. */
function quiet(seconds: number): Int16Array {
  const a = new Int16Array(Math.round(seconds * 48_000));
  let seed = 7;
  for (let i = 0; i < a.length; i++) a[i] = Math.round((((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * 0.002 * 32767);
  return a;
}
/** Where the speech in a clip ends, in samples. */
function speechEnd(a: Int16Array): number {
  for (let i = a.length - 1; i >= 0; i--) if (Math.abs(a[i]!) > 0.01 * 32767) return i + 1;
  return 0;
}

// --- one scenario ----------------------------------------------------------
interface Scenario {
  name: string;
  /** Parts of one utterance, with the pause before each part after the first, s. */
  parts: { clip: string; pauseBefore?: number }[];
  /** Words the recognizers give for audio this long (s): local and cloud alike. The
   *  lengths are what the VADs cut from these renders (LATENCY_DEBUG=1 prints them). */
  words(seconds: number): string;
  /** Smart Turn: done (0.9) unless this says the clip sounds unfinished. */
  unfinished?(seconds: number): boolean;
  /** An answer first, so this one is a follow-up without her name. */
  afterAnswer?: boolean;
  /** Not for her: no answer expected. */
  sideTalk?: boolean;
}

const SCENARIOS: Scenario[] = [
  { name: 'wake + order', parts: [{ clip: 'wake' }], words: () => 'Hey Adrian, open Spotify.' },
  { name: 'wake + question', parts: [{ clip: 'wake2' }], words: () => 'Hey Adrian, what is the capital of Australia?' },
  { name: 'wake, 0.45 s pause, order', parts: [{ clip: 'name' }, { clip: 'cmd', pauseBefore: 0.45 }], words: (s) => (s < 1.3 ? 'Hey Adrian.' : s < 2.3 ? 'Open Spotify.' : 'Hey Adrian. Open Spotify.') },
  { name: 'wake + "play", 0.4 s, "Drake"', parts: [{ clip: 'play' }, { clip: 'drake', pauseBefore: 0.4 }], words: (s) => (s < 1 ? 'Drake.' : s < 2 ? 'Hey Adrian, play' : 'Hey Adrian, play Drake.') },
  {
    name: 'order, 0.4 s, more order',
    parts: [{ clip: 'wake' }, { clip: 'follow', pauseBefore: 0.4 }],
    words: (s) => (s < 2 ? 'And turn it up a little.' : s < 3.5 ? 'Hey Adrian, open Spotify.' : 'Hey Adrian, open Spotify. And turn it up a little.'),
  },
  { name: 'follow-up, no name', parts: [{ clip: 'follow' }], words: () => 'And turn it up a little.', afterAnswer: true },
  {
    name: 'held: "play" ... "Drake"',
    parts: [{ clip: 'play' }, { clip: 'drake', pauseBefore: 1.0 }],
    words: (s) => (s < 1 ? 'Drake.' : s < 2 ? 'Hey Adrian, play' : 'Hey Adrian, play. Drake.'),
    unfinished: (s) => s >= 1 && s < 2,
  },
  { name: 'side talk', parts: [{ clip: 'side' }], words: () => 'So then we went to the store and they were out of everything.', sideTalk: true },
];

interface Run {
  scenario: string;
  sttMs: number;
  /** End of the speech in the clip → first audio handed to the PC, ms. */
  trueMs: number;
  answered: Record<string, unknown> | undefined;
  decodes: number;
  groqCalls: number;
}

async function runOnce(sc: Scenario, sttMs: number, audio: Record<string, Int16Array>): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'latency-'));
  mkdirSync(join(dir, 'kokoro'));
  const lexicon = 'hey adrian open spotify what is the capital of australia and turn it up a little play drake so then we went to store they were out everything';
  writeFileSync(join(dir, 'kokoro', 'lexicon-us-en.txt'), lexicon.split(' ').map((w) => `${w} x`).join('\n'));
  writeFileSync(join(dir, MODEL_LAYOUT.smartTurn), '');
  const turnDetector = {
    complete: async (s: Float32Array) => {
      await sleep(DELAY.turn);
      return sc.unfinished?.(s.length / 16_000 - 0.8) ? 0.2 : 0.9;
    },
  };
  vi.spyOn(SmartTurn, 'load').mockResolvedValue(turnDetector as never);
  const config = PocConfigSchema.parse({
    guildId: '100000000000000010',
    channelId: '100000000000000020',
    secretsFile: join(dir, 'secrets.env'),
    listen: { vadModel: join(MODELS, 'silero_vad.onnx'), asrModelDir: dir },
    voice: { modelDir: join(dir, 'kokoro') },
    brain: { provider: 'openai', baseUrl: 'http://llm.test/v1', model: 'fake', apiKeySecret: 'LLM_API_KEY', priceInPerM: 1, priceOutPerM: 5, totalTimeoutMs: 15_000, firstEventTimeoutMs: 10_000, search: {} },
    music: { enabled: false },
    languages: false,
    autoMemory: false,
    serverInfo: { enabled: false },
    textChat: { enabled: false },
    satellite: { enabled: true, port: 40000, unfinishedWaitMs: 1200 },
    cloudStt: { enabled: true },
    limits: { perUserPerHour: 0, dailyUsd: 0, monthlyUsd: 0 },
  });
  // What both recognizers hear (the warm-up answer has words of its own).
  let words = sc.words;
  // Local recognition: one job at a time, like Parakeet.
  let decodes = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const stt = {
    transcribe(samples: Float32Array, _rate: number, signal?: AbortSignal) {
      const job = queue.then(async () => {
        if (signal?.aborted) throw new Error('cancelled');
        decodes++;
        if (process.env.LATENCY_DEBUG) process.stderr.write(`decode ${sc.name}: ${(samples.length / 16_000).toFixed(3)} s -> ${words(samples.length / 16_000)}
`);
        await sleep(sttMs);
        return { text: words(samples.length / 16_000), decodeMs: sttMs };
      });
      queue = job.catch(() => undefined);
      return job;
    },
  };
  let groqCalls = 0;
  let firstAudioAt: number | undefined;
  let answers = 0;
  vi.stubGlobal('fetch', async (url: unknown, init: any) => {
    const u = String(url);
    if (u.includes('audio/transcriptions')) {
      groqCalls++;
      const file = (init.body as FormData).get('file') as Blob;
      const seconds = (file.size - 44) / 32_000;
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, DELAY.groq);
        init.signal?.addEventListener('abort', () => (clearTimeout(t), rej(new DOMException('aborted', 'AbortError'))), { once: true });
      });
      return new Response(JSON.stringify({ text: words(seconds) }), { status: 200 });
    }
    if (u.endsWith('/chat/completions')) {
      const enc = new TextEncoder();
      const ev = (p: unknown) => enc.encode(`data: ${JSON.stringify(p)}\n\n`);
      return new Response(
        new ReadableStream({
          async start(c) {
            // The first sentence lands whole: the orchestrator speaks whole sentences.
            await sleep(DELAY.llmFirstSentence);
            c.enqueue(ev({ choices: [{ delta: { content: 'Okay, done. ' } }] }));
            await sleep(150);
            c.enqueue(ev({ choices: [{ delta: { content: 'Anything else?' } }] }));
            c.enqueue(ev({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
        { status: 200 },
      );
    }
    if (u.includes('applications/@me')) return new Response('{}', { status: 401 });
    throw new Error(`unexpected fetch ${u}`);
  });
  const tts = {
    gainFor: async () => 0,
    async synthesize() {
      await sleep(DELAY.ttsFirst);
      return { samples: new Float32Array(4800).fill(0.1), sampleRate: 48_000, synthMs: DELAY.ttsFirst };
    },
  };
  const logged: { m: string; f: any }[] = [];
  const log = { debug() {}, info: (m: string, f?: unknown) => void logged.push({ m, f }), warn: (m: string, f?: unknown) => void logged.push({ m: `WARN ${m}`, f }), error() {} };
  vi.spyOn(Client.prototype, 'login').mockImplementation(async function (this: any) {
    this.user = { id: '100000000000000050', tag: 'bot#0' };
    return 'x';
  });
  const secrets = new Map([['DISCORD_TOKEN', 'x'], ['LLM_API_KEY', 'y'], ['GROQ_API_KEY', 'z']]);
  const ledger = new UsageLedger(undefined, { perUserPerHour: 0, dailyUsd: 0, monthlyUsd: 0 }, 'UTC');
  const stack = await startVoiceStack(config as never, secrets, log as never, ledger, { sttFor: async () => stt as never, ttsFor: () => tts as never }, dir);

  const conn = Object.assign(new EventEmitter(), {
    device: { id: 'd1', name: 'Desk', owner: OWNER },
    owner: OWNER,
    lastSeen: Date.now(),
    isReady: () => true,
    mode() {},
    state() {},
    send() {},
    transcript() {},
    async action() {
      return { ok: true, result: 'Done.' };
    },
    playPcm(stream: NodeJS.ReadableStream) {
      firstAudioAt ??= performance.now();
      answers++;
      const done = new Promise<string>((r) => {
        stream.on('data', () => {});
        stream.once('end', () => r('finished'));
        stream.once('close', () => r('finished'));
      });
      return { done, stop() {} };
    },
  });
  h.sat.onConnect(conn);

  /** Speak like the PC: gate preroll of quiet, the speech, 1.2 s quiet, speech_end. Returns when speech ended. */
  async function speak(parts: Scenario['parts']): Promise<number> {
    const chunks: Int16Array[] = [quiet(0.3)];
    for (const p of parts) {
      if (p.pauseBefore) chunks.push(quiet(p.pauseBefore));
      chunks.push(audio[p.clip]!);
    }
    const speech = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) (speech.set(c, o), (o += c.length));
    const endAt = speechEnd(speech);
    const all = new Int16Array(speech.length + 1.2 * 48_000);
    all.set(speech);
    all.set(quiet(1.2), speech.length);
    conn.emit('speechStart', OWNER);
    const t0 = performance.now();
    let endWall = NaN;
    for (let i = 0, f = 0; i < all.length; i += 960, f++) {
      const due = t0 + f * 20;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
      conn.emit('audio', OWNER, { samples: all.subarray(i, i + 960), sampleRate: 48_000, receivedAt: performance.now() });
      if (Number.isNaN(endWall) && i + 960 >= endAt) endWall = t0 + (endAt / 48_000) * 1000;
    }
    conn.emit('speechEnd', OWNER);
    return endWall;
  }

  try {
    if (sc.afterAnswer) {
      words = () => 'Hey Adrian, open Spotify.';
      await speak([{ clip: 'wake' }]);
      await until(() => stack.answers().length === 1, 'the first answer');
      await sleep(300);
      firstAudioAt = undefined;
      words = sc.words;
    }
    const before = { decodes, groqCalls, answers: stack.answers().length };
    const endWall = await speak(sc.parts);
    if (sc.sideTalk) await sleep(2_000);
    else await until(() => stack.answers().length > before.answers, 'the answer');
    const rec = stack.answers().at(-1);
    return {
      scenario: sc.name,
      sttMs,
      trueMs: sc.sideTalk || firstAudioAt === undefined ? NaN : Math.round(firstAudioAt - endWall),
      answered: sc.sideTalk ? undefined : (rec as unknown as Record<string, unknown>),
      decodes: decodes - before.decodes,
      groqCalls: groqCalls - before.groqCalls,
    };
  } catch (e) {
    console.log(logged.map((l) => `${l.m} ${JSON.stringify(l.f ?? {})}`).join('\n'));
    throw e;
  } finally {
    await stack.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.skipIf(!ON)('reply latency harness', () => {
  it('prints the breakdown', async () => {
    try {
      setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* not allowed here: fine */
    }
    const audio = await clips();
    const runs: Run[] = [];
    for (const sttMs of STT_LIST)
      for (let i = 0; i < RUNS; i++)
        for (const sc of SCENARIOS) {
          const r = await runOnce(sc, sttMs, audio);
          runs.push(r);
        }
    if (process.env.LATENCY_OUT) writeFileSync(process.env.LATENCY_OUT, JSON.stringify(runs, null, 1));
    const rows: string[] = [];
    const pad = (s: unknown, n: number) => String(s).padStart(n);
    rows.push(`${'scenario'.padEnd(28)}${pad('stt', 5)}${pad('n', 3)}${pad('true', 7)}${pad('min', 6)}${pad('max', 6)}${pad('logged', 8)}${pad('sttLat', 7)}${pad('turn', 6)}${pad('hold', 6)}${pad('groq', 6)}${pad('llm', 6)}${pad('tts', 6)}${pad('dec', 5)}${pad('groqN', 6)}`);
    for (const sttMs of STT_LIST)
      for (const sc of SCENARIOS) {
        const rs = runs.filter((r) => r.scenario === sc.name && r.sttMs === sttMs);
        const f = (k: string) => median(rs.map((r) => Number(r.answered?.[k] ?? NaN)));
        const t = rs.map((r) => r.trueMs).filter(Number.isFinite);
        rows.push(
          `${sc.name.padEnd(28)}${pad(sttMs, 5)}${pad(rs.length, 3)}${pad(median(t), 7)}${pad(t.length ? Math.min(...t) : NaN, 6)}${pad(t.length ? Math.max(...t) : NaN, 6)}${pad(f('speechEndToAudioMs'), 8)}${pad(f('sttLatencyMs'), 7)}${pad(f('turnCheckMs'), 6)}${pad(f('holdMs'), 6)}${pad(f('groqMs'), 6)}${pad(f('llmFirstChunkMs'), 6)}${pad(f('ttsFirstMs'), 6)}${pad(median(rs.map((r) => r.decodes)), 5)}${pad(median(rs.map((r) => r.groqCalls)), 6)}`,
        );
      }
    const table = `\nReply latency (ms; true = end of speech in the clip → first audio; logged = the answered line's speechEndToAudioMs)\n${rows.join('\n')}\n`;
    process.stderr.write(table);
    if (process.env.LATENCY_TABLE) writeFileSync(process.env.LATENCY_TABLE, table);
    expect(runs.length).toBeGreaterThan(0);
  }, 3_600_000);
});
