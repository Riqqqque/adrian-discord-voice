// Sound effects: what YouTube returns for a range of requests, and whether
// the model reaches for play_sound when asked (audio isn't played).
//   node bench/sound-check.mjs <bot.json> <yt-dlp>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { YoutubeSource } from '../dist/features/music.js';
import { SOUND_RULE, soundTool } from '../dist/features/sounds.js';

const [cfgPath, ytdlp] = process.argv.slice(2);
const c = loadConfig(cfgPath);
const yt = new YoutubeSource({ ytdlp, node: process.execPath });

for (const q of ['airhorn', 'cat meow', 'drum roll', 'sad trombone', 'thunder', 'applause', 'dog bark', 'vine boom', 'doorbell', 'wolf howl']) {
  const t0 = performance.now();
  const t = await yt.soundEffect(q, AbortSignal.timeout(30_000)).catch((e) => ({ title: `ERROR ${e.message}` }));
  console.log(`${q.padEnd(14)} ${((performance.now() - t0) / 1000).toFixed(1)}s  ${t ? `${t.title} | ${t.durationS ?? '?'}s` : 'NOTHING'}`);
}

const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: readSecrets(c.secretsFile).get('ANTHROPIC_API_KEY'), effort: 'low' });
const asked = [];
const tool = soundTool({ find: async (q) => (asked.push(q), { title: q, source: 'youtube', ref: 'x' }), play: async () => {} });
const o = new ConversationOrchestrator(llm, new SessionMemory(4, 60_000), [tool], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 200, maxToolRounds: 2,
  stableLines: [SOUND_RULE], context: () => ['Reply in English.'], stablePrefix: true,
});
for (const q of ['make a cat sound', 'can you do an airhorn', 'give me a drum roll', 'make a fart noise', 'what does a cow sound like']) {
  asked.length = 0;
  let out = '';
  for await (const ch of o.ask(`u${q}`, 'Sam', q, AbortSignal.timeout(25_000))) out += (out ? ' ' : '') + ch;
  console.log(`> ${q}\n  play_sound: ${asked.join(', ') || 'NONE'} | said: ${out.slice(0, 100)}`);
}
