// Claude models vs Groq on the bot's real prompt: time to the first spoken
// chunk, total time, tokens, estimated cost, and the answer text.
//   node bench/claude-vs.mjs <bot.json>

import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { OpenAiCompatibleLlm } from '../dist/brain/openai-compatible.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { routeTools } from '../dist/brain/tool-router.js';
import { timeTool } from '../dist/brain/tools.js';
import { matureContext } from '../dist/brain/mature.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { PartyGames } from '../dist/features/games.js';
import { Reminders } from '../dist/features/reminders.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const PRICE = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'openai/gpt-oss-120b': [0.15, 0.6] };
const models = [
  ['groq gpt-oss-120b', () => new OpenAiCompatibleLlm({ baseUrl: c.brain.baseUrl, model: c.brain.model, apiKey: s.get(c.brain.apiKeySecret), extraBody: { reasoning_effort: 'medium', include_reasoning: false } })],
  ['claude-haiku-5-5 low', () => new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' })],
  ['claude-sonnet-5-5 low', () => new AnthropicLlm({ model: 'claude-sonnet-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' })],
  ['claude-opus-5-5 low', () => new AnthropicLlm({ model: 'claude-opus-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' })],
];
const questions = [
  'why is the sky blue',
  'i just died to a creeper again, give me a quick roast',
  'set a timer for five minutes for the pizza',
  'if i have 3 diamonds and trade 2 for 10 emeralds each, how many emeralds do i get',
];

for (const [label, make] of models) {
  const llm = make();
  const rem = new Reminders(undefined, c.timezone, () => {});
  const tools = [timeTool(c.timezone), ...rem.tools(), ...new PartyGames().tools()];
  const o = new ConversationOrchestrator(llm, new SessionMemory(), tools, {
    spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
    context: () => ['Reply in English.', ...matureContext('always', false)],
    selectTools: (t, x, all) => routeTools(all, t, {}),
    creator: { name: 'Sean', spoken: 'Shawn', heardAs: c.identity.creatorHeardAs },
  });
  const firsts = [];
  for (const q of questions) {
    const t0 = performance.now();
    let first, out = '', usage;
    try {
      for await (const ch of o.ask('u-' + label + q.length, 'Sean', q, AbortSignal.timeout(20000), (u) => (usage = u))) {
        first ??= Math.round(performance.now() - t0);
        out += (out ? ' ' : '') + ch;
      }
    } catch (e) {
      out = 'ERROR ' + e.message.slice(0, 120);
    }
    const total = Math.round(performance.now() - t0);
    const p = PRICE[llm.model] ?? [0, 0];
    const cost = usage ? (usage.inputTokens * p[0] + usage.outputTokens * p[1]) / 1e6 : 0;
    if (first) firsts.push(first);
    console.log(JSON.stringify({ model: label, q, firstChunkMs: first ?? null, totalMs: total, in: usage?.inputTokens, out: usage?.outputTokens, tools: usage?.toolCalls, costUsd: Number(cost.toFixed(5)), answer: out.slice(0, 170) }));
    await new Promise((r) => setTimeout(r, 1500));
  }
  firsts.sort((a, b) => a - b);
  console.log(JSON.stringify({ model: label, medianFirstChunkMs: firsts[Math.floor(firsts.length / 2)] ?? null }));
}
