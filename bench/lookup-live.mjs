// The question that went unanswered on 2026-11-25, end to end with real Tavily:
// her own query wording has to find it.  node bench/lookup-live.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { tavilySearchTool } from '../dist/brain/tools.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const search = tavilySearchTool(s.get('TAVILY_API_KEY'));
for (const q of ["What key is Justin Bieber's Too Much Live From Paris?", "what's the BPM of Morgan Wallen's Wasted On You?"]) {
  const queries = [];
  const kit = prodKit(c, { answers: { web_search: (a) => (queries.push(a.query), search.run(a, AbortSignal.timeout(8000))) } });
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, kit.options);
  const t0 = Date.now();
  let said = '';
  for await (const chunk of o.ask('u', 'Sam', q, AbortSignal.timeout(40_000))) said += `${chunk} `;
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(queries), '->', said.trim());
}
