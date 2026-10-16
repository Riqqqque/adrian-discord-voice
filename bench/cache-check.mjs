// Prompt caching with the real API: back-to-back questions from different
// people should read the cached tools + stable prompt.
//   node bench/cache-check.mjs <bot.json> [stablePrefix=1]
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { tavilySearchTool, timeTool } from '../dist/brain/tools.js';
import { routeTools } from '../dist/brain/tool-router.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { musicRules, musicState, musicTools } from '../dist/features/music.js';
import { matureContext } from '../dist/brain/mature.js';

const [cfgPath, stableArg = '1'] = process.argv.slice(2);
const c = loadConfig(cfgPath);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const stub = { nowPlaying: undefined, upNext: [], paused: false, recent: [], autoplay: true, request: async () => ({ ok: true, added: 0 }) };
const tools = [timeTool(c.timezone), tavilySearchTool('x'), ...musicTools(stub)];
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), tools, {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 300, maxToolRounds: 3,
  creator: { name: 'Sean', spoken: 'Shawn', heardAs: ['Shaun'] },
  context: (x) => ['Reply in English.', `People in this voice call right now (general): Sean, Sam, Kim (${x.speaker} talking to you now).`, musicState(stub)],
  stableLines: [...matureContext('always', false), ...musicRules()],
  selectTools: (text, _ctx, all) => routeTools(all, text, {}),
  stablePrefix: stableArg === '1',
});
const qs = [['r', 'Sean', 'what is the capital of australia'], ['r', 'Sean', 'and what is it famous for'], ['r', 'Sean', 'how far is it from sydney'], ['r', 'Sean', 'would you rather live there or melbourne'], ['s', 'Sam', 'give me a fun fact about octopuses'], ['r', 'Sean', 'ok back to australia, best time to visit?']];
for (const [id, who, q] of qs) {
  let u;
  let first = 0;
  const t0 = performance.now();
  for await (const _ of o.ask(id, who, q, AbortSignal.timeout(30000), (x) => (u = x))) if (!first) first = performance.now() - t0;
  console.log(`${who.padEnd(6)} first chunk ${String(Math.round(first)).padStart(5)} ms | in ${u.inputTokens} (cache read ${u.cachedTokens} = ${Math.round((100 * u.cachedTokens) / u.inputTokens)}%, write ${u.cacheWriteTokens}, uncached ${u.inputTokens - u.cachedTokens - u.cacheWriteTokens}) out ${u.outputTokens}`);
}
