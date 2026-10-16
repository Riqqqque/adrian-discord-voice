// End-to-end latency bench without Discord: wake clips are played in real
// time (20 ms frames, as Discord delivers) through the real VAD → Parakeet →
// wake → orchestrator → Kokoro → normalization path. The LLM is a local
// mock with a configurable time-to-first-token, so everything except the
// real model is measured. Reports end of speech → first audio.
//
// Usage: node dist/bench/e2e-bench.js <bench.json>

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { ConversationOrchestrator } from '../brain/orchestrator.js';
import { readSecrets } from '../config.js';
import { OpenAiCompatibleLlm } from '../brain/openai-compatible.js';
import { SessionMemory } from '../brain/sessions.js';
import { timeTool } from '../brain/tools.js';
import type { PlaybackHandle, VoiceTransport } from '../core/interfaces.js';
import { ListeningPipeline } from '../listen/pipeline.js';
import { KokoroTts } from '../speech/kokoro.js';
import { ParakeetStt } from '../speech/sherpa.js';
import { Speaker } from '../voice/speaker.js';
import { TextWakeDetector } from '../wake/text-wake.js';

interface BenchConfig {
  corpusDir: string;
  vadModel: string;
  asrDir: string;
  kokoroDir: string;
  voice: string;
  clips: string[];
  /** Mock LLM time to first token, ms. */
  ttftMs: number;
  /** Mock LLM delay between tokens, ms. */
  tokenMs: number;
  minSilence: number;
  /** Use a real LLM instead of the mock (key read from secretsFile). */
  realLlm?: { baseUrl: string; model: string; apiKeySecret: string; secretsFile: string; extraBody?: Record<string, unknown> };
  /** Pause between clips, ms (stay under provider rate limits). */
  gapMs?: number;
}
const cfg: BenchConfig = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const PAD_S = 0.6; // trailing silence in every corpus clip

// --- mock LLM -------------------------------------------------------------
const ANSWERS = [
  "It's about seventy two degrees right now, with clear skies all afternoon.",
  'The capital of Australia is Canberra. A lot of people guess Sydney.',
  "Sure, I can help with that. Here's the short version of it.",
  'Mount Everest is about eight thousand eight hundred forty nine meters tall.',
];
let answerN = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await new Promise((r) => setTimeout(r, cfg.ttftMs));
    const answer = ANSWERS[answerN++ % ANSWERS.length]!;
    for (const w of answer.split(/(?<= )/)) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, cfg.tokenMs));
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

// --- fake transport -------------------------------------------------------
class FakeTransport extends EventEmitter implements VoiceTransport {
  firstAudioAt: number | undefined;
  async connect() {}
  async disconnect() {}
  isReady() {
    return true;
  }
  play(): PlaybackHandle {
    return { done: Promise.resolve('finished'), stop() {} };
  }
  playPcm(stream: NodeJS.ReadableStream): PlaybackHandle {
    stream.once('data', () => (this.firstAudioAt ??= performance.now()));
    const done = new Promise<'finished'>((r) => {
      stream.on('end', () => r('finished'));
      stream.resume();
    });
    return { done, stop() {} };
  }
}

const transport = new FakeTransport();
const stt = await ParakeetStt.load({ modelDir: cfg.asrDir, threads: 4 });
const tts = new KokoroTts({ modelDir: cfg.kokoroDir, threads: 4 });
await tts.gainFor(cfg.voice, 1.0);
const speaker = new Speaker(transport, tts);
const real = cfg.realLlm;
const realKey = real ? readSecrets(real.secretsFile).get(real.apiKeySecret) : undefined;
const orchestrator = new ConversationOrchestrator(
  real
    ? new OpenAiCompatibleLlm({
        baseUrl: real.baseUrl,
        model: real.model,
        ...(realKey ? { apiKey: realKey } : {}),
        ...(real.extraBody ? { extraBody: real.extraBody } : {}),
      })
    : new OpenAiCompatibleLlm({ baseUrl, model: 'mock' }),
  new SessionMemory(),
  [timeTool('America/Denver')],
  { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'America/Denver', firstEventTimeoutMs: 8_000, maxTokens: 200, maxToolRounds: 2 },
);
const pipeline = new ListeningPipeline(transport, stt, new TextWakeDetector(), {
  model: cfg.vadModel,
  threshold: 0.5,
  minSilence: cfg.minSilence,
  minSpeech: 0.25,
  maxSpeech: 20,
});

const results: { clip: string; e2eMs: number; sttMs: number; firstChunkMs: number; ttsFirstMs: number }[] = [];
for (const clip of cfg.clips) {
  transport.firstAudioAt = undefined;
  const w = sherpa.readWave(join(cfg.corpusDir, clip));
  const up = new sherpa.LinearResampler(w.sampleRate, 48_000).flush(w.samples);
  const pcm = Int16Array.from(up, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
  const speechEndSample = pcm.length - PAD_S * 48_000;
  let speechEndAt = 0;

  const done = new Promise<void>((resolve) => {
    pipeline.once('heard', async (e) => {
      if (!e.woke) {
        console.log(JSON.stringify({ clip, error: 'no wake', heard: e.text }));
        resolve();
        return;
      }
      const t0 = performance.now();
      let firstChunkAt = 0;
      const gen = orchestrator.ask('bench', 'Bench', e.command, AbortSignal.timeout(15_000));
      const src = (async function* () {
        for await (const c of gen) {
          firstChunkAt ||= performance.now();
          yield c;
        }
      })();
      const r = await speaker.speak(src, { voice: cfg.voice, speed: 1, volume: 0.7 }, AbortSignal.timeout(20_000));
      results.push({
        clip,
        e2eMs: Math.round(transport.firstAudioAt! - speechEndAt),
        sttMs: e.sttLatencyMs,
        firstChunkMs: Math.round(firstChunkAt - t0),
        ttsFirstMs: r.synthMs[0] ?? -1,
      });
      console.log(JSON.stringify(results.at(-1)));
      resolve();
    });
  });

  // Play the clip in real time, 20 ms frames, then the same silence Discord
  // would send until its end-of-speech timeout.
  transport.emit('speechStart', 'bench');
  const frame = 960;
  const start = performance.now();
  for (let i = 0, k = 0; i < pcm.length; i += frame, k++) {
    if (i >= speechEndSample && !speechEndAt) speechEndAt = performance.now();
    transport.emit('audio', 'bench', { samples: pcm.subarray(i, i + frame), sampleRate: 48_000, receivedAt: performance.now() });
    const wait = start + (k + 1) * 20 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  transport.emit('speechEnd', 'bench');
  await done;
  await new Promise((r) => setTimeout(r, cfg.gapMs ?? 300));
}

const sorted = (k: keyof (typeof results)[number]) => results.map((r) => r[k] as number).sort((a, b) => a - b);
const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
for (const k of ['e2eMs', 'sttMs', 'firstChunkMs', 'ttsFirstMs'] as const) {
  const a = sorted(k);
  console.log(JSON.stringify({ metric: k, n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: a.at(-1) }));
}
console.log(JSON.stringify({ llm: real ? real.model : 'mock', mock: real ? null : { ttftMs: cfg.ttftMs, tokenMs: cfg.tokenMs }, minSilence: cfg.minSilence, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
server.close();
process.exit(0);
