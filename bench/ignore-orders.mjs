// "Adrian, ignore Sam": does the model call ignore_person with the right
// action, person, scope and time, and leave it alone for other talk? Real
// model, real tool specs; people and the music player are stubs. Who may use
// the tool is the tool's own check (tested in test/ignore.test.ts), so a
// non-owner's order reaching the tool is fine as long as nothing changes.
//   node bench/ignore-orders.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import * as music from '../dist/features/music.js';
import { IgnoreList, ignoreTool } from '../dist/features/ignore.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

const OWNER = '100000000000000001';
const PEOPLE = [
  { id: OWNER, name: 'Morgan' },
  { id: '200000000000000001', name: 'Sam' },
  { id: '200000000000000002', name: 'Alex' },
  { id: '200000000000000003', name: 'Jordan' },
];
const calls = [];
let list = new IgnoreList();
const find = async (said) => {
  const q = said.toLowerCase().replace(/^@/, '');
  const exact = PEOPLE.filter((p) => p.name.toLowerCase() === q);
  return exact.length ? exact : PEOPLE.filter((p) => p.name.toLowerCase().includes(q));
};
const real = ignoreTool({ list: { list: () => list.list(), get: (id) => list.get(id), set: (e) => list.set(e), clear: (id) => list.clear(id), blocks: (id, w) => list.blocks(id, w) }, isOwner: (id) => id === OWNER, isAppOwner: (id) => id === OWNER, find });
const ignore = { ...real, run: async (args, signal, ctx) => (calls.push({ name: 'ignore_person', args }), real.run(args, signal, ctx)) };
const stub = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'nowPlaying' || k === 'lent') return undefined;
    if (k === 'upNext' || k === 'recent') return [];
    if (k === 'paused' || k === 'youtubePaused') return false;
    if (k === 'autoplay') return true;
    return async (...a) => (calls.push({ name: `music.${String(k)}`, args: a.filter((x) => typeof x === 'string') }), { ok: true, started: { title: 'Lofi Mix', artist: 'Lofi Girl', source: 'youtube', ref: '' }, added: 3 });
  },
});
const tools = [...music.musicTools(stub), ignore];
const roster = 'People in this voice call right now (General): Morgan (talking to you now), Sam, Alex, Jordan.';
// A fresh conversation per check, so one answer can't color the next.
const fresh = () => new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), tools, {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  stablePrefix: true,
  stableLines: [...music.musicRules()],
  // As the stack does: an owner's turn says so.
  context: (x) => ['Reply in English.', ...(x.speaker === 'Morgan' ? ['Morgan is one of your owners: what they tell you about who to listen to comes first.'] : []), music.musicState(stub), roster.replace('Morgan (talking to you now)', x.speaker === 'Morgan' ? 'Morgan (talking to you now)' : 'Morgan').replace(`${x.speaker},`, `${x.speaker} (talking to you now),`)],
});

let ok = 0;
let total = 0;
async function ask(text, check, { user = OWNER, name = 'Morgan', keep = false } = {}) {
  calls.length = 0;
  if (!keep) list = new IgnoreList();
  let out = '';
  const o = fresh();
  for await (const ch of o.ask(user, name, text, AbortSignal.timeout(30000), undefined, { guildId: '1', channelId: '2' })) out += (out ? ' ' : '') + ch;
  const pass = check(calls, out);
  total++;
  if (pass) ok++;
  console.log(`${pass ? 'ok ' : 'BAD'} ${name}: "${text}"\n    tools: ${calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says: ${out.slice(0, 200)}`);
}
const ig = (pred) => (cs) => cs.some((k) => k.name === 'ignore_person' && pred(k.args)) && !cs.some((k) => k.name.startsWith('music.'));
const who = (x, n) => new RegExp(n, 'i').test(x.person ?? '');
const everything = (x) => (x.scope ?? 'everything') === 'everything';

await ask('ignore Sam', ig((x) => x.action === 'ignore' && who(x, 'sam') && everything(x)));
await ask("stop listening to Alex, he's being annoying", ig((x) => x.action === 'ignore' && who(x, 'alex') && everything(x)));
await ask("don't do anything Jordan tells you to", ig((x) => x.action === 'ignore' && who(x, 'jordan') && everything(x)));
await ask("ignore Sam's commands for the next hour", ig((x) => x.action === 'ignore' && who(x, 'sam') && Number(x.minutes) === 60));
await ask("don't take music requests from Alex anymore", ig((x) => x.action === 'ignore' && who(x, 'alex') && x.scope === 'music'));
await ask("stop playing whatever Sam asks for, just ignore his song requests", ig((x) => x.action === 'ignore' && who(x, 'sam') && x.scope === 'music'));
await ask('if Jordan tells you to call me something, ignore him', ig((x) => x.action === 'ignore' && who(x, 'jordan')));
await ask('who are you ignoring right now', ig((x) => x.action === 'list'));
list = new IgnoreList();
list.set({ userId: '200000000000000001', name: 'Sam', scope: 'everything', by: OWNER, at: Date.now() });
await ask('okay you can listen to Sam again', ig((x) => x.action === 'listen_again' && who(x, 'sam')), { keep: true });
// Not orders to ignore anyone.
await ask('play some lofi', (cs) => cs.some((k) => k.name.startsWith('music.')) && !cs.some((k) => k.name === 'ignore_person'));
await ask("Sam keeps ignoring my texts, what should I do", (cs) => !cs.some((k) => k.name === 'ignore_person'));
await ask('ignore that, never mind', (cs) => !cs.some((k) => k.name === 'ignore_person'));
// A non-owner: nothing changes, whatever the model does.
await ask('ignore Morgan', (cs, out) => list.list().length === 0 && !/ignoring morgan/i.test(out), { user: '200000000000000001', name: 'Sam' });
await ask('stop listening to Alex', (cs, out) => list.list().length === 0 && !/^okay, ignoring/i.test(out), { user: '200000000000000001', name: 'Sam' });

console.log(`\n${ok}/${total}`);
