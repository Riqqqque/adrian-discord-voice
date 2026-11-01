// How long are her answers with the real model? Spoken-style questions, counted
// in sentences and rough seconds of speech (2.6 words a second).
//   node bench/answer-length.mjs <bot.json> [--real]
// --real asks with the production prompt: every tool the stack offers, in its
// order, and its cached lines, so what the music and PC rules do to her length
// shows up. Keep those in step with stack.ts. The tools are stubs: only the
// model is called. Without it the prompt has no tools and no extra rules.
import { genderLines } from '../dist/app/identity.js';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { matureContext } from '../dist/brain/mature.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { tavilySearchTool, timeTool } from '../dist/brain/tools.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { discordTools, RelayLimiter } from '../dist/features/discordinfo.js';
import { PartyGames } from '../dist/features/games.js';
import { gameServerTool } from '../dist/features/gameservers.js';
import { mediaTools } from '../dist/features/media.js';
import * as music from '../dist/features/music.js';
import { UserNotes } from '../dist/features/notes.js';
import { Reminders } from '../dist/features/reminders.js';
import { SOUND_RULE, soundTool } from '../dist/features/sounds.js';
import { MusicTaste } from '../dist/features/taste.js';
import { PC_RULE, pcTools } from '../dist/satellite/tools.js';
import { LANGS } from '../dist/speech/language.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const used = [];

function production() {
  const player = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'nowPlaying') return undefined;
      if (k === 'upNext' || k === 'recent') return [];
      if (k === 'paused' || k === 'youtubePaused') return false;
      if (k === 'autoplay') return true;
      return async () => ({ ok: true, added: 0 });
    },
  });
  const taste = new MusicTaste(undefined);
  const unused = { url: 'http://unused.invalid', token: 'unused', apiKey: 'unused' };
  const tools = [
    timeTool(c.timezone),
    tavilySearchTool('unused'),
    ...new Reminders(undefined, c.timezone, async () => {}).tools(),
    ...new UserNotes(undefined).tools(),
    ...new PartyGames().tools(),
    ...music.musicTools(player, taste),
    ...taste.tools(),
    soundTool({ find: async () => undefined, play: async () => {} }),
    ...pcTools({ pcFor: () => undefined }),
    ...discordTools({ client: {}, allowedGuilds: [], members: true, presences: true, timezone: c.timezone }, { limiter: new RelayLimiter(10, 5), isOwner: () => false, maxChars: 500 }),
    ...(c.gameServers.length ? [gameServerTool(c.gameServers)] : []),
    ...mediaTools({ plex: unused, sonarr: unused, radarr: unused, timezone: c.timezone }),
  ].map((t) => ({ ...t, run: async () => (used.push(t.spec.name), 'Nothing found.') }));
  const creator = c.identity.creator;
  return {
    tools,
    options: {
      maxTokens: c.brain?.maxTokens ?? 500,
      stablePrefix: true,
      filler: () => 'One sec.',
      ...(creator ? { creator: { name: creator, spoken: c.identity.creatorSpoken ?? creator, heardAs: c.identity.creatorHeardAs } } : {}),
      stableLines: [...genderLines(c.botGender), SOUND_RULE, ...(c.mature === 'age-restricted' ? [] : matureContext(c.mature, false)), ...music.musicRules(), PC_RULE],
      context: (x) => [LANGS.en.prompt, music.musicState(player), ...taste.context(x.userId, x.speaker)],
    },
  };
}

const real = process.argv.includes('--real') ? production() : undefined;

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
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), real?.tools ?? [], {
    spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
    ...real?.options,
  });
  used.length = 0;
  let said = '';
  for await (const chunk of o.ask('u', 'Sam', text, AbortSignal.timeout(30_000))) said += `${chunk} `;
  const n = said.split(/[.!?]+(\s|$)/).filter((x) => x.trim()).length;
  const w = said.trim().split(/\s+/).length;
  words.push(w);
  const ok = n <= most;
  if (ok) good++;
  console.log(ok ? 'PASS' : 'LONG', `${n} sentences, ${w} words, ${(w / 2.6).toFixed(1)} s`, JSON.stringify(text), used.length ? `[${used.join(', ')}]` : '', '->', said.trim().slice(0, 170));
}
words.sort((a, b) => a - b);
console.log(`${good}/${CASES.length} within limit; median ${words[words.length >> 1]} words`);
