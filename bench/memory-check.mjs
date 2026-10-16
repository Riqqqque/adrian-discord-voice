// Roster, room talk, automatic memory and note privacy with the real model.
//   node bench/memory-check.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { RoomTalk } from '../dist/conversation/room.js';
import { AutoMemory } from '../dist/features/automemory.js';
import { UserNotes } from '../dist/features/notes.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const sessions = new SessionMemory(16, 3_600_000);
const notes = new UserNotes(undefined);
const room = new RoomTalk();
const log = { debug() {}, info() {}, warn: console.log, error: console.log };
const auto = new AutoMemory(llm, notes, sessions, log, () => {}, 1);
const roster = (asker) => [`People in this voice call right now (general): ${['Sean', 'Sam', 'Kim'].map((n) => (n === asker ? `${n} (talking to you now)` : n)).join(', ')}.`];
const o = new ConversationOrchestrator(llm, sessions, [], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 0,
  context: (x) => ['Reply in English.', ...roster(x.speaker), ...room.context('ch', x.userId), ...notes.context(x.userId, x.speaker)],
});
async function say(uid, who, text, toBot = true) {
  room.add('ch', uid, who, text);
  if (!toBot) return;
  let out = '';
  for await (const ch of o.ask(uid, who, text, AbortSignal.timeout(20000), undefined, { channelId: 'ch' })) out += (out ? ' ' : '') + ch;
  room.add('ch', 'bot', `You (answering ${who})`, out);
  console.log(`[${who}] ${text}\n    -> ${out.slice(0, 220)}`);
}
await say('kim', 'Kim', 'bro I finally beat the Ender Dragon', false);
await say('a', 'Sean', 'who is in the call right now?');
await say('a', 'Sean', 'my dog Biscuit chewed up my controller again, and I am thinking of getting a PS5 next month');
console.log('    learned:', JSON.stringify(await auto.learn('a', 'Sean')));
await say('b', 'Sam', 'what did Kim just say she did?');
await say('b', 'Sam', 'what do you know about Sean, like his dog or what he is buying?');
await say('a', 'Sean', 'what do you remember about me?');
