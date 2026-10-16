// Does the model use the music tools for indirect requests? Real model, real
// tool router and prompt line; the player is a stub that records calls.
//   node bench/music-intent.mjs <bot.json> ["request" ...]
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { routeTools } from '../dist/brain/tool-router.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import * as music from '../dist/features/music.js';

const [cfgPath, ...given] = process.argv.slice(2);
const c = loadConfig(cfgPath);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const calls = [];
const history = [{ title: 'Round 2', artist: 'JaeyBxrd', source: 'youtube' }];
// Stub player: records what the model asked for.
const stub = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'nowPlaying') return undefined;
    if (k === 'upNext') return [];
    if (k === 'paused') return false;
    if (k === 'recent') return history;
    if (k === 'autoplay') return true;
    return async (...a) => {
      calls.push(`${String(k)}(${a.filter((x) => typeof x !== 'object' || Array.isArray(x)).map((x) => JSON.stringify(x)).join(', ')})`);
      return { ok: true, started: { title: 'X', artist: 'Y', source: 'youtube', ref: '' }, added: 3 };
    };
  },
});
const tools = music.musicTools(stub);
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), tools, {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  context: () => ['Reply in English.', ...music.musicPromptLines(stub)],
  selectTools: (text, _ctx, all) => routeTools(all, text, {}),
});
const asks = given.length
  ? given
  : [
      'play me a playlist like the song I just listened to',
      'put on something with this type of vibe, like chill late night stuff',
      'play some Joe Rogan podcast',
      'play the whole Graduation album by Kanye',
      'play something hype for gaming',
      'keep playing songs like that one',
    ];
for (const q of asks) {
  calls.length = 0;
  let out = '';
  const t0 = performance.now();
  for await (const ch of o.ask('r', 'Sean', q, AbortSignal.timeout(30000), undefined, { channelId: 'ch' })) out += (out ? ' ' : '') + ch;
  console.log(`[${q}] ${((performance.now() - t0) / 1000).toFixed(1)}s\n   tools: ${calls.join(' | ') || 'NONE'}\n   said: ${out.slice(0, 160)}`);
}
