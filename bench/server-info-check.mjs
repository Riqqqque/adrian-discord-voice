// server_info against the real server (read only), then whether the model
// picks server_info / message_member / ping codes when it should.
//   node bench/server-info-check.mjs <bot.json>
// Logs in a second gateway session with no voice; it sends nothing to Discord.
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { privilegedIntents } from '../dist/app/stack.js';
import { discordTools, RelayLimiter } from '../dist/features/discordinfo.js';
import { loadConfig, readSecrets } from '../dist/config.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const token = s.get('DISCORD_TOKEN');
const quiet = { info: () => {}, warn: (m, f) => console.log(m, f) };
const g = await privilegedIntents(token, { info: (m, f) => console.log(m, JSON.stringify(f)), warn: quiet.warn });
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(g.members ? [GatewayIntentBits.GuildMembers] : []), ...(g.presences ? [GatewayIntentBits.GuildPresences] : [])],
});
await client.login(token);
await new Promise((r) => client.once(Events.ClientReady, r));
const app = await client.application.fetch();
const asker = c.owners[0] ?? app.owner?.ownerId ?? app.owner?.id;
const [info, relay] = discordTools(
  { client, allowedGuilds: c.allowedGuilds, members: g.members, presences: g.presences, timezone: c.timezone },
  { limiter: new RelayLimiter(10, 5), isOwner: () => false, maxChars: 600 },
);
const ctx = { userId: asker, speaker: 'Rique', guildId: c.guildId };
for (const what of ['overview', 'voice', 'channels', 'roles', 'online', 'members']) {
  const out = await info.run({ what }, AbortSignal.timeout(15000), ctx).catch((e) => `ERROR ${e.message}`);
  console.log(`--- ${what} (${out.length} chars)\n${out.split('\n').slice(0, 4).join('\n')}`);
}
console.log('--- member (me):', (await info.run({ what: 'member', name: `<@${asker}>` }, AbortSignal.timeout(15000), ctx)).split('. ')[1]);
console.log('--- DM context:', await info.run({ what: 'overview' }, AbortSignal.timeout(15000), { userId: asker, speaker: 'Rique' }).then((x) => x.split('\n')[0], (e) => e.message));
console.log('--- relay to a bot:', await relay.run({ member: `<@${client.user.id}>`, message: 'hi' }, AbortSignal.timeout(15000), ctx));
await client.destroy();

// Does the model reach for the right tool? Stub tools record the calls.
const calls = [];
const stub = (t, reply) => ({ ...t, run: async (a) => (calls.push(`${t.spec.name}(${JSON.stringify(a)})`), reply) });
const tools = [
  stub(info, 'Sam (@samx, ping code <@111111111111111111>): online, playing Valorant\nKim (@kimk, ping code <@222222222222222222>): idle'),
  stub(relay, 'Sent Sam a DM.'),
];
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), tools, {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 400, maxToolRounds: 3, stablePrefix: true,
});
const cases = [
  ['text', "who's online right now?", /server_info/],
  ['text', 'what is Sam playing', /server_info/],
  ['text', 'tag kim and tell her to hop on valorant', /<@222222222222222222>|message_member/],
  ['voice', "tell Sam dinner's ready", /message_member/],
  ['voice', 'how many people are in this server', /server_info/],
  ['text', 'what time is it in tokyo', /^(?!.*message_member)/],
];
let ok = 0;
for (const [mode, q, want] of cases) {
  calls.length = 0;
  let out = '';
  for await (const ch of o.ask(`u${ok}${q.length}`, 'Rique', q, AbortSignal.timeout(25000), undefined, { guildId: 'G', channelId: 'C' }, { text: mode === 'text' })) out += (out ? ' ' : '') + ch;
  const got = `${calls.join(' ')} ${out}`;
  const pass = want.test(got);
  if (pass) ok++;
  console.log(`[${mode}] ${q}\n    tools: ${calls.join(' ') || '-'}\n    -> ${out.slice(0, 200)}${pass ? '' : '   <-- MISS'}`);
}
console.log(`\n${ok}/${cases.length} as expected`);
