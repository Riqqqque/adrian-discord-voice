// How long are her answers with the real model? Spoken-style questions, counted
// in sentences and rough seconds of speech (2.6 words a second).
//   node bench/answer-length.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

// [question, most sentences that's still fine]
const CASES = [
  ['what happens if I accidentally ingest Epsom salt?', 2],
  ['what is the capital of Australia?', 1],
  ['how many ounces in a pound?', 1],
  ['do you think pineapple belongs on pizza?', 2],
  ['should I get an SSD or a hard drive for games?', 2],
  ['what does a VPN do?', 2],
  ['who won the first Super Bowl?', 1],
  ['how are you doing today?', 2],
  ['why is the sky blue?', 4],
  ['how does a heat pump work?', 4],
  ['explain in detail how a car engine works', 12],
];

let good = 0;
const words = [];
for (const [text, most] of CASES) {
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), [], {
    spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  });
  let said = '';
  for await (const chunk of o.ask('u', 'Sam', text, AbortSignal.timeout(30_000))) said += `${chunk} `;
  const n = said.split(/[.!?]+(\s|$)/).filter((x) => x.trim()).length;
  const w = said.trim().split(/\s+/).length;
  words.push(w);
  const ok = n <= most;
  if (ok) good++;
  console.log(ok ? 'PASS' : 'LONG', `${n} sentences, ${w} words, ${(w / 2.6).toFixed(1)} s`, JSON.stringify(text), '->', said.trim().slice(0, 170));
}
words.sort((a, b) => a - b);
console.log(`${good}/${CASES.length} within limit; median ${words[words.length >> 1]} words`);
