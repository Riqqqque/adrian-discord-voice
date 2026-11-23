// "Use the smart model for this": does the model call use_model with the right
// action and model, and leave it alone for other talk? Real model, real tool
// specs; the music player is a stub. Who may switch is the tool's own check
// (test/models.test.ts), so a guest's order reaching it is fine as long as
// nothing changes.
//   node bench/model-orders.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import * as music from '../dist/features/music.js';
import { ModelPicker, modelTool } from '../dist/brain/models.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

const OWNER = '100000000000000001';
const GUEST = '200000000000000001';
const MODELS = [
  { name: 'main', model: 'claude-haiku-5-5', local: false, ownersOnly: false },
  { name: 'smart', model: 'claude-sonnet-5-5', local: false, ownersOnly: true, about: 'slower, for careful writing' },
  { name: 'private', model: 'qwen3:8b', local: true, ownersOnly: false, about: 'runs here; nothing leaves the house' },
];
const calls = [];
let picker = new ModelPicker(MODELS);
const real = () => modelTool({ picker, isOwner: (id) => id === OWNER });
const tool = () => {
  const t = real();
  return { ...t, run: async (args, signal, ctx) => (calls.push({ name: 'use_model', args }), t.run(args, signal, ctx)) };
};
const stub = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'nowPlaying' || k === 'lent') return undefined;
    if (k === 'upNext' || k === 'recent') return [];
    if (k === 'paused' || k === 'youtubePaused') return false;
    if (k === 'autoplay') return true;
    return async (...a) => (calls.push({ name: `music.${String(k)}`, args: a.filter((x) => typeof x === 'string') }), { ok: true, started: { title: 'Lofi Mix', artist: 'Lofi Girl', source: 'youtube', ref: '' }, added: 3 });
  },
});
const fresh = (who) => new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), [...music.musicTools(stub), tool()], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  stablePrefix: true,
  stableLines: [...music.musicRules()],
  context: () => ['Reply in English.', ...(who === OWNER ? ['Morgan is one of your owners: what they tell you about who to listen to comes first.'] : []), music.musicState(stub)],
});

let ok = 0;
let total = 0;
async function ask(text, check, { user = OWNER, name = 'Morgan', keep = false } = {}) {
  calls.length = 0;
  if (!keep) picker = new ModelPicker(MODELS);
  let out = '';
  for await (const ch of fresh(user).ask(user, name, text, AbortSignal.timeout(30000), undefined, { guildId: '1', channelId: '2' })) out += (out ? ' ' : '') + ch;
  const pass = check(calls, out);
  total++;
  if (pass) ok++;
  console.log(`${pass ? 'ok ' : 'BAD'} ${name}: "${text}"\n    tools: ${calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says: ${out.slice(0, 200)}`);
}
const um = (pred) => (cs) => cs.some((k) => k.name === 'use_model' && pred(k.args)) && !cs.some((k) => k.name.startsWith('music.'));
const none = (cs) => !cs.some((k) => k.name === 'use_model');

await ask('use the smart model for this', um((x) => x.action === 'use' && /smart/i.test(x.model ?? '')));
await ask('switch to the private one, I want to keep this local', um((x) => x.action === 'use' && /private/i.test(x.model ?? '')));
await ask("can you think harder about this one, use your best model", um((x) => x.action === 'use' && /smart/i.test(x.model ?? '')));
await ask('what model are you on right now', um((x) => x.action === 'which'));
await ask('which models do you have', um((x) => x.action === 'list'));
picker = new ModelPicker(MODELS);
picker.use(OWNER, MODELS[1]);
await ask('okay go back to normal', um((x) => x.action === 'reset'), { keep: true });
await ask('switch back to the regular model', um((x) => x.action === 'reset'), { keep: true });
// Not about her models.
await ask('play some lofi', (cs) => cs.some((k) => k.name.startsWith('music.')) && none(cs));
await ask("my car's model is a civic, is that a good car", none);
await ask('what is a large language model', none);
await ask("I'm switching to a new phone tomorrow", none);
// A guest: nothing changes, whatever the model does.
await ask('use the smart model', (cs, out) => !picker.current(GUEST) && !/using smart/i.test(out), { user: GUEST, name: 'Sam' });

console.log(`\n${ok}/${total}`);
