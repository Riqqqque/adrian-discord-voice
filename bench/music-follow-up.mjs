// Words without her name, a few seconds after an answer, that start like a music
// order. The judge has to let "play Drake" through to music (it once called that
// side talk, and nothing played) and stay out of "play the objective". Real
// model, the stack's own hint and matcher; the player is a stub that records.
//   node bench/music-follow-up.mjs <bot.json>
// Importing the stack loads sherpa: run it where the bot runs, LD_LIBRARY_PATH set.
import { MUSIC_FOLLOW_UP, MUSICISH } from '../dist/app/stack.js';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import * as music from '../dist/features/music.js';
import { SOUND_RULE, soundTool } from '../dist/features/sounds.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const calls = [];
const NIGHTS = { title: 'Nights', artist: 'Frank Ocean', source: 'youtube', ref: '' };
const player = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'nowPlaying') return NIGHTS;
    if (k === 'upNext' || k === 'recent') return [];
    if (k === 'paused' || k === 'youtubePaused') return false;
    if (k === 'autoplay') return true;
    return async (...a) => (calls.push(`${String(k)}(${a.filter((x) => typeof x === 'string').join(', ')})`), { ok: true, started: NIGHTS, added: 1 });
  },
});
const sounds = { find: async (q) => (calls.push(`sound(${q})`), { title: q, ref: '' }), play: async () => {} };
const tools = [...music.musicTools(player), soundTool(sounds)];
const memory = new SessionMemory(16, 3_600_000);
const o = new ConversationOrchestrator(llm, memory, tools, {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  stablePrefix: true,
  stableLines: [SOUND_RULE, ...music.musicRules()],
  context: () => ['Reply in English.', music.musicState(player)],
});

// [what they said, is it for her?]
const CASES = [
  ['play Drake', true],
  ['play some Frank Ocean', true],
  ['put on Kendrick', true],
  ['now play Blinding Lights', true],
  ['skip this song', true],
  ['pause the music', true],
  ['make a cat sound', true],
  ['play the objective', false],
  ['skip this round', false],
  ['play off me, I will flank', false],
  ['queue up for ranked', false],
  ['spin around, he is behind you', false],
];

let good = 0;
let n = 0;
for (const [text, forHer] of CASES) {
  // Seeded, not asked: the words come right after an answer, as they do live.
  const user = `u${n++}`;
  memory.append(user, { role: 'user', content: 'what is the capital of Australia' });
  memory.append(user, { role: 'assistant', content: 'Canberra.' });
  calls.length = 0;
  let said = '';
  let silent = false;
  const hint = MUSICISH.test(text);
  const opts = { followUp: true, ...(hint ? { extra: [MUSIC_FOLLOW_UP] } : {}), onSilent: () => (silent = true) };
  for await (const chunk of o.ask(user, 'Sam', text, AbortSignal.timeout(30_000), undefined, { channelId: 'call' }, opts)) said += `${chunk} `;
  const pass = hint && (forHer ? calls.length > 0 : silent && !calls.length);
  if (pass) good++;
  console.log(pass ? 'PASS' : 'FAIL', JSON.stringify(text), hint ? '' : '(no hint: MUSICISH missed it)', silent ? 'SILENT' : `says: ${said.trim().slice(0, 100)}`, calls.join(' '));
}
console.log(`\n${good}/${CASES.length} as expected`);
