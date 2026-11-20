// Idle connections to the cloud providers, on the real APIs: the time to the
// first token / byte of a request made after the connection sat idle for a
// gap, with Node's default connections (`default`, 4 s idle) against the
// shared pool in core/http.ts.
//   node bench/keepalive.mjs <bot.json> [reps] [out.json]
// Every sample is on its own: a fresh pool, one free request to open the
// connection, the gap, then the timed request. Arms (ARMS=...):
//   default    Node's own connections (what every provider used before)
//   preopen    default + a pre-open LEAD_MS ahead (what `wake()` does), no longer idle
//   keepalive  the shared pool's idle limits, no pre-open
//   shipped    the shared pool + `wake()` LEAD_MS ahead (opens one only if none is open)
//   h2         the shared pool over HTTP/2, no pre-open
// Providers (PROVIDERS=...): claude (first text of a tiny streamed answer),
// groq (a 1 s transcription), speechify (first audio byte of "Hi."), tavily
// (first byte of an unauthenticated GET: no search credits). Requests to one
// provider are spaced (Groq ≥ 6.5 s, Speechify ≥ 2.5 s) and a provider stops
// at its first 429 (nothing more goes to it, pre-opens included).
// GAPS=5,30,120,600 (seconds); GAPS_<PROVIDER>=... for one provider.
import { AsyncLocalStorage } from 'node:async_hooks';
import diagnostics from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
import { Agent } from 'undici';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { Connections } from '../dist/core/http.js';
import { groqTranscribe } from '../dist/speech/cloud-stt.js';

const c = loadConfig(process.argv[2]);
const reps = Number(process.argv[3] ?? 12);
const outFile = process.argv[4] ?? 'keepalive.json';
const ARMS = (process.env.ARMS ?? 'default,preopen,keepalive,shipped,h2').split(',');
const PROVIDERS = (process.env.PROVIDERS ?? 'claude,groq,speechify,tavily').split(',');
const GAPS = (process.env.GAPS ?? '5,30,120,600').split(',').map((s) => Number(s) * 1000);
const LEAD = Number(process.env.LEAD_MS ?? 1000);
const SPACING = { claude: 1500, groq: 6500, speechify: 2500, tavily: 1500 };
const secrets = readSecrets(c.secretsFile);
const KEY = { claude: secrets.get('ANTHROPIC_API_KEY'), groq: secrets.get(c.cloudStt.apiKeySecret), speechify: secrets.get('SPEECHIFY_API_KEY') };
const ORIGIN = { claude: 'https://api.anthropic.com', groq: 'https://api.groq.com', speechify: 'https://api.speechify.ai', tavily: 'https://api.tavily.com' };
const OPEN = { claude: '/v1/models', groq: '/openai/v1/models', speechify: '/v1/voices', tavily: '/' };
const MODEL = process.env.MODEL ?? 'claude-haiku-5-5';
// $ per token, as bench/prewarm.mjs prices Haiku.
const PRICE_IN = 0.1 / 1e6;
const PRICE_OUT = 0.5 / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which socket each timed request went out on: new, or one already used.
const als = new AsyncLocalStorage();
const byRequest = new WeakMap();
const seen = new WeakSet();
const socketOf = new Map();
diagnostics.subscribe('undici:request:create', ({ request }) => {
  const id = als.getStore();
  if (id !== undefined) byRequest.set(request, id);
});
diagnostics.subscribe('undici:client:sendHeaders', ({ request, socket }) => {
  const id = byRequest.get(request);
  if (id !== undefined && !socketOf.has(id)) socketOf.set(id, seen.has(socket) ? 'reused' : 'new');
  seen.add(socket);
});

/** fetch + pre-open for one arm, on its own connections. */
function armHttp(arm, provider) {
  if (arm === 'default' || arm === 'preopen') {
    const agent = new Agent();
    const f = (u, i) => fetch(u, { ...i, dispatcher: agent });
    return {
      fetch: f,
      open: () => f(ORIGIN[provider] + OPEN[provider]).then((r) => r.arrayBuffer()),
      wake: arm === 'preopen' ? () => void f(ORIGIN[provider] + OPEN[provider]).then((r) => r.arrayBuffer(), () => undefined) : undefined,
      close: () => agent.close(),
    };
  }
  const pool = new Connections(arm === 'h2' ? { allowH2: true } : {});
  return {
    fetch: pool.fetch,
    open: () => pool.fetch(ORIGIN[provider] + OPEN[provider]).then((r) => r.arrayBuffer()),
    wake: arm === 'shipped' ? () => pool.preconnect(ORIGIN[provider]) : undefined,
    close: () => pool.close(),
  };
}

const tone = new Float32Array(16_000).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16_000) + 0.01 * (Math.random() - 0.5));

/** The timed request: ms to the first token or byte, plus what it cost. */
async function timed(provider, http) {
  const t0 = performance.now();
  if (provider === 'claude') {
    const llm = new AnthropicLlm({ model: MODEL, apiKey: KEY.claude, effort: 'low', fetch: http.fetch });
    let first;
    let usage;
    for await (const ev of llm.stream([{ role: 'user', content: 'Reply with the single word: hi' }], { maxTokens: 8, signal: AbortSignal.timeout(20_000) })) {
      if (ev.type === 'text' && first === undefined) first = performance.now() - t0;
      if (ev.type === 'usage') usage = ev;
    }
    return { ms: first, total: performance.now() - t0, cost: usage ? usage.inputTokens * PRICE_IN + usage.outputTokens * PRICE_OUT : 0 };
  }
  if (provider === 'groq') {
    await groqTranscribe(KEY.groq, tone, 16_000, { model: c.cloudStt.model, signal: AbortSignal.timeout(10_000), fetch: http.fetch });
    const ms = performance.now() - t0;
    return { ms, total: ms };
  }
  if (provider === 'speechify') {
    const r = await http.fetch('https://api.speechify.ai/v1/audio/stream', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY.speechify}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'Hi.', voice_id: 'sabrina', model: 'simba-3.5', language: 'en-US', output_format: 'pcm_24000', options: { text_normalization: true } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw Object.assign(new Error(`speechify HTTP ${r.status}`), { status: r.status });
    let first;
    for await (const _ of r.body) first ??= performance.now() - t0;
    return { ms: first, total: performance.now() - t0, chars: 3 };
  }
  const r = await http.fetch('https://api.tavily.com/', { signal: AbortSignal.timeout(10_000) });
  const ms = performance.now() - t0;
  await r.arrayBuffer();
  return { ms, total: ms };
}

// The schedule: per provider, samples sorted by gap (arms interleaved), each
// timed request in its own slot, its pool opened one gap earlier.
const samples = [];
for (const provider of PROVIDERS) {
  let at = 5_000;
  for (const gap of process.env[`GAPS_${provider.toUpperCase()}`]?.split(',').map((x) => Number(x) * 1000) ?? GAPS) {
    for (let r = 0; r < reps; r++) {
      for (const arm of [...ARMS].sort(() => Math.random() - 0.5)) {
        at = Math.max(at, gap + 3_500);
        samples.push({ id: samples.length, provider, arm, gap, rep: r, at });
        at += SPACING[provider];
      }
    }
  }
}
const stopped = new Set();
const results = [];
const t0 = performance.now();
const save = () => writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(JSON.stringify({ samples: samples.length, minutes: +(Math.max(...samples.map((s) => s.at)) / 60_000).toFixed(1) }));

async function run(s) {
  const http = armHttp(s.arm, s.provider);
  const rec = { ...s };
  try {
    await sleep(Math.max(0, s.at - s.gap - 400 - (performance.now() - t0)));
    if (stopped.has(s.provider)) return;
    await http.open();
    const openedAt = performance.now();
    if (http.wake) {
      await sleep(s.at - LEAD - (performance.now() - t0));
      if (stopped.has(s.provider)) return;
      rec.woke = http.wake() ?? true;
    }
    await sleep(s.at - (performance.now() - t0));
    if (stopped.has(s.provider)) return;
    rec.idle = Math.round(performance.now() - openedAt);
    const out = await als.run(s.id, () => timed(s.provider, http));
    Object.assign(rec, out);
    rec.socket = socketOf.get(s.id);
  } catch (e) {
    rec.error = String(e.cause?.message ?? e.message).slice(0, 160);
    if (e.status === 429 || /\b429\b/.test(e.message)) {
      stopped.add(s.provider);
      console.log(JSON.stringify({ stop: s.provider, reason: rec.error }));
    }
  } finally {
    await http.close().catch(() => undefined);
  }
  if (stopped.has(s.provider) && rec.ms === undefined && !rec.error) return;
  results.push(rec);
  console.log(JSON.stringify({ p: rec.provider, arm: rec.arm, gap: rec.gap / 1000, idle: rec.idle, ms: rec.ms && Math.round(rec.ms), socket: rec.socket, woke: rec.woke, err: rec.error }));
  save();
}

await Promise.all(samples.map(run));
save();
const cost = results.reduce((a, r) => a + (r.cost ?? 0), 0);
const chars = results.reduce((a, r) => a + (r.chars ?? 0), 0);
console.log(JSON.stringify({ done: results.length, claudeUsd: +cost.toFixed(4), speechifyChars: chars }));
process.exit(0);
