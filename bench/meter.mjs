// Token, cost and speed meter for the real-model benches. Load it before a
// bench, which then runs unchanged:
//   METER_OUT=run.json node --import ./bench/meter.mjs bench/pc-orders.mjs <bot.json>
// Every Claude call: input (uncached / cache read / cache write), output, and
// the time to its first text. Every answer (one ask): its words, model calls
// and cost. Prices are Claude Haiku 5.5's: $0.10 in, $0.50 out per million,
// cache reads 0.1x and 5-minute writes 1.25x input.
// METER_POOL=off sends every cloud request with Node's own fetch instead of the
// kept-open connections (src/core/http.ts), for an A/B of the pool; the
// default is the pool, as the service runs.
import { writeFileSync } from 'node:fs';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { cloud } from '../dist/core/http.js';

const POOL = process.env.METER_POOL !== 'off';
if (!POOL) {
  // Before any provider is made: they take cloud.fetch when they're built.
  cloud.fetch = (input, init) => globalThis.fetch(input, init);
  cloud.fetchOnce = cloud.fetch;
}

const IN = 0.1 / 1e6;
const OUT = 0.5 / 1e6;
const calls = [];
const turns = [];
let current;

const stream = AnthropicLlm.prototype.stream;
AnthropicLlm.prototype.stream = async function* (messages, opts) {
  const t0 = performance.now();
  const c = { firstTextMs: undefined, input: 0, cached: 0, written: 0, output: 0, tools: !!opts?.tools?.length };
  calls.push(c);
  if (current) current.calls++;
  for await (const ev of stream.call(this, messages, opts)) {
    if (ev.type === 'text' && c.firstTextMs === undefined && ev.delta.trim()) c.firstTextMs = performance.now() - t0;
    if (ev.type === 'usage') {
      c.cached = ev.cachedTokens;
      c.written = ev.cacheWriteTokens ?? 0;
      c.input = ev.inputTokens - c.cached - c.written;
      c.output = ev.outputTokens;
      c.cost = c.input * IN + c.cached * IN * 0.1 + c.written * IN * 1.25 + c.output * OUT;
      if (current) current.cost += c.cost;
    }
    yield ev;
  }
};

const ask = ConversationOrchestrator.prototype.ask;
ConversationOrchestrator.prototype.ask = async function* (...args) {
  const t = { text: args[2], said: '', calls: 0, cost: 0, firstChunkMs: undefined };
  const t0 = performance.now();
  const outer = current;
  current = t;
  try {
    for await (const chunk of ask.apply(this, args)) {
      if (t.firstChunkMs === undefined) t.firstChunkMs = performance.now() - t0;
      t.said += (t.said ? ' ' : '') + chunk;
      yield chunk;
    }
  } finally {
    current = outer;
    turns.push(t);
  }
};

const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : undefined;
};
const words = (t) => t.split(/\s+/).filter(Boolean).length;

process.on('exit', () => {
  const spoken = turns.filter((t) => t.said);
  const w = spoken.map((t) => words(t.said));
  const r = {
    pool: POOL,
    turns: turns.length,
    modelCalls: calls.length,
    callsPerTurn: turns.length ? calls.length / turns.length : 0,
    inputUncached: sum(calls, 'input'),
    inputCached: sum(calls, 'cached'),
    inputWritten: sum(calls, 'written'),
    output: sum(calls, 'output'),
    costUsd: sum(calls, 'cost'),
    costPerTurn: turns.length ? sum(calls, 'cost') / turns.length : 0,
    inputPerCall: calls.length ? (sum(calls, 'input') + sum(calls, 'cached') + sum(calls, 'written')) / calls.length : 0,
    outputPerCall: calls.length ? sum(calls, 'output') / calls.length : 0,
    firstTextMsMedian: median(calls.filter((c) => c.firstTextMs !== undefined).map((c) => c.firstTextMs)),
    firstChunkMsMedian: median(spoken.map((t) => t.firstChunkMs)),
    wordsMedian: median(w),
    wordsMean: w.length ? w.reduce((a, b) => a + b, 0) / w.length : undefined,
    over20: w.length ? w.filter((x) => x > 20).length / w.length : undefined,
    firstTextMs: calls.map((c) => (c.firstTextMs === undefined ? null : Math.round(c.firstTextMs))),
    perTurn: turns.map((t) => ({ text: t.text, words: words(t.said), calls: t.calls, cost: Number(t.cost.toFixed(6)), firstChunkMs: t.firstChunkMs === undefined ? undefined : Math.round(t.firstChunkMs), said: t.said.slice(0, 400) })),
  };
  if (process.env.METER_OUT) writeFileSync(process.env.METER_OUT, JSON.stringify(r, null, 1));
  const { perTurn: _drop, firstTextMs: _each, ...head } = r;
  console.log(`METER ${JSON.stringify(head)}`);
});
