// Alarms, timers and their options asked the everyday way: does the real model
// call the right alarm tool with the right arguments, and stay short? Real
// tools on a real clock; nothing rings (the ring is a stub).
//   node bench/alarm-orders.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { AlarmClock } from '../dist/features/alarms.js';
import { ALARM_RULE, alarmTools } from '../dist/features/alarm-tools.js';
import { Reminders } from '../dist/features/reminders.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const calls = [];
const clock = new AlarmClock(undefined, c.timezone, { placeFor: () => 'discord', ring: () => ({ stop() {}, alive: () => true }), dm: async () => true });
const reminders = new Reminders(undefined, c.timezone, () => {});
const real = [
  ...reminders.tools().filter((t) => t.spec.name === 'set_reminder'),
  ...alarmTools({
    clock,
    reminders,
    english: () => true,
    reach: () => 'call',
    preview: async () => true,
    saveClip: async (_c, q, name) => ({ name, owner: 'x', file: 'f.pcm', seconds: 3, title: `${q} sound effect` }),
    musicOk: true,
  }),
];
const tools = real.map((t) => ({ ...t, run: async (a, sig, ctx) => (calls.push({ name: t.spec.name, args: a }), t.run(a, sig, ctx)) }));
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), tools, {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  stablePrefix: true,
  stableLines: [ALARM_RULE],
  context: () => ['Reply in English.'],
});

let ok = 0;
let total = 0;
const words = (t) => t.split(/\s+/).filter(Boolean).length;
async function ask(text, check, maxWords = 30, { user = 'u1', followUp = false } = {}) {
  calls.length = 0;
  let out = '';
  for await (const ch of o.ask(user, 'Rique', text, AbortSignal.timeout(30000), undefined, { channelId: 'voice1', guildId: 'g1' }, { followUp })) out += (out ? ' ' : '') + ch;
  const got = calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ');
  const pass = check(calls, out) && words(out) <= maxWords;
  total++;
  if (pass) ok++;
  console.log(`${pass ? 'ok ' : 'BAD'} "${text}"\n    tools: ${got || '-'}\n    says (${words(out)} words): ${out.slice(0, 220)}`);
}
const call = (name, pred = () => true) => (cs) => cs.some((k) => k.name === name && pred(k.args));
const clear = () => clock.remove(clock.all().map((a) => a.id));
const t = (x) => String(x ?? '').replace(/^0/, '');

await ask('wake me up at 7', call('set_alarm', (x) => /^0?7(:00)?$/.test(t(x.time)) || x.time === '19:00'));
await ask('set an alarm for 6:30 every weekday', call('set_alarm', (x) => /6:30/.test(x.time) && /weekday/i.test(x.repeat ?? '')));
await ask('set a timer for 10 minutes', call('set_timer', (x) => Number(x.minutes) === 10));
await ask('pizza timer, twelve minutes', call('set_timer', (x) => Number(x.minutes) === 12 && /pizza/i.test(x.label ?? '')));
await ask('how much time is left on my pizza timer', call('list_timers'));
await ask('add five minutes to the pizza timer', call('edit_alarm', (x) => Number(x.add_minutes) === 5));
await ask('what alarms do i have', call('list_timers'), 50);
await ask('skip tomorrow morning\'s alarm', call('edit_alarm', (x) => x.skip_next === true || !!x.skip_date || x.on === false));
await ask('change my 6:30 alarm to 6:45', call('edit_alarm', (x) => /6:45/.test(x.time ?? '')));
await ask('what alarm sounds do you have', (cs, out) => call('alarm_options', (x) => x.action === 'sounds')(cs) && /chime|marimba|birds|bells|classic/i.test(out), 60);
await ask('let me hear the marimba one', call('alarm_options', (x) => x.action === 'preview' && /marimba/i.test(x.sound ?? '')), 30, { followUp: true });
await ask('use birds for my alarms', (cs) => call('alarm_options', (x) => x.action === 'set' && /birds/i.test(x.default_sound ?? ''))(cs) || call('edit_alarm', (x) => /birds/i.test(x.sound ?? ''))(cs));
await ask("make it so i have to say i'm up to turn it off", call('alarm_options', (x) => x.action === 'set' && x.dismiss === 'firm'));
await ask('i want snooze to be 15 minutes', (cs) => call('alarm_options', (x) => x.action === 'set' && Number(x.snooze_minutes) === 15)(cs) || call('edit_alarm', (x) => Number(x.snooze_minutes) === 15)(cs));
await ask('wake me up to some drake tomorrow at 9', call('set_alarm', (x) => /^0?9(:00)?$/.test(t(x.time)) && /drake/i.test(x.play ?? x.sound ?? '')));
await ask('save an airhorn as an alarm sound', call('alarm_options', (x) => x.action === 'save_sound' && /air ?horn/i.test(x.query ?? '')));
await ask('remind me to take out the trash at 8 pm', (cs) => call('set_reminder')(cs) && !call('set_alarm')(cs));
await ask('i set my own alarm on my phone lol', (cs) => cs.length === 0, 35);
await ask('stop my alarm', (cs) => call('alarm_control', (x) => x.action === 'stop')(cs) || cs.length === 0);
// Deleting a repeating alarm asks first; the yes is their next turn.
{
  const user = 'del';
  await ask('set an alarm for 5:45 on weekdays', call('set_alarm'), 30, { user });
  await ask('delete my weekday alarm', (cs, out) => call('cancel_timer')(cs) && /\?/.test(out) && clock.forUser(user).length === 1, 30, { user, followUp: true });
  await ask('yes', (cs) => call('cancel_timer')(cs) && clock.forUser(user).length === 0, 30, { user, followUp: true });
}
clear();
console.log(`\n${ok}/${total} right`);
