// Model → play_music → real YouTube lookups (audio not decoded), with the
// production options: stable cached prefix, slow-tool filler, tool limits.
//   node bench/music-e2e.mjs <bot.json> <yt-dlp>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { describe, MusicPlayer, musicPromptLines, musicTools, YoutubeSource } from '../dist/features/music.js';

const [cfgPath, ytdlp] = process.argv.slice(2);
const c = loadConfig(cfgPath);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: readSecrets(c.secretsFile).get('ANTHROPIC_API_KEY'), effort: 'low' });
const out = { playMusic: () => ({ done: new Promise(() => {}), stop() {} }), pauseMusic() {}, resumeMusic() {}, setMusicVolume() {}, musicPlaying: true, musicPaused: false };
const player = new MusicPlayer({ sources: [new YoutubeSource({ ytdlp, node: process.execPath })], output: out, decode: () => ({ pcm: { on() {}, pipe() {} }, kill() {} }), log: { info() {}, warn: (m, f) => console.log('   WARN', m, f ?? '') } });
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), musicTools(player), {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 300, maxToolRounds: 3,
  context: () => ['Reply in English.', ...musicPromptLines(player)],
  stablePrefix: true,
  filler: () => 'One sec.',
});
for (const q of ['play the whole Graduation album by Kanye', 'play the newest Joe Rogan episode', 'now play a playlist like the song that was playing before']) {
  const t0 = performance.now();
  const chunks = [];
  let u;
  for await (const ch of o.ask('r', 'Sean', q, AbortSignal.timeout(20_000), (x) => (u = x))) chunks.push(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${ch}`);
  console.log(`> ${q}\n  ${chunks.join('\n  ')}\n  now: ${player.nowPlaying ? describe(player.nowPlaying) : '-'} | queued ${player.upNext.length} | tools ${u?.toolCalls} | cache read ${u?.cachedTokens}`);
}
process.exit(0);
