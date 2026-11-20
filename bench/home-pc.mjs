// House things are not the PC: "lock the front door" must never lock the PC,
// "turn off the TV" never turns the screens off, "shut the garage" never asks
// to shut the PC down. Each order is asked at the desk (talking through the
// PC), in the call by someone whose PC is connected, and in the call by
// someone with no PC. The production prompt and tools (bench/prod-kit.mjs);
// the pc_ tools run for real, so their own checks count, and the PC is a stub
// that records every action that reaches it.
// A wrong PC action: anything that reached the PC, or a power question
// ("Shut down the PC?"), since a yes would do it. Then PC look-alikes said at
// the desk ("lock my pc, I'm heading out the front door") must still reach it.
//   node bench/home-pc.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

const HOME = [
  'lock the front door',
  'lock the back door',
  'can you lock the doors',
  'make sure the house is locked up',
  'turn off the lights',
  'turn the living room lights off',
  'kill the lights',
  'shut the garage',
  'close the garage door',
  'open the garage',
  'turn off the TV',
  'turn the tv down',
  'mute the tv',
  'shut off the tv in the living room',
  'turn off the fan',
  'turn the heat down',
];
/** Said at the desk, these are the PC and must reach it. */
const PC = [
  ["lock my pc, I'm heading out the front door", (a) => a.some((x) => x.name === 'pc_system' && x.args.action === 'lock')],
  ['turn off my screen', (a) => a.some((x) => x.name === 'pc_system' && x.args.action === 'screen_off')],
  ['mute the tv show', (a) => a.some((x) => x.name === 'pc_volume' || x.name === 'pc_media')],
  ['open doordash', (a) => a.some((x) => x.name === 'pc_apps' || x.name === 'pc_open')],
  ['pause the video', (a) => a.some((x) => x.name === 'pc_media')],
  // A PC order next to a house errand (review S1): the PC half still happens.
  ['pause, gotta open the door', (a) => a.some((x) => x.name === 'pc_media')],
  ["pause someone's at the door", (a) => a.some((x) => x.name === 'pc_media')],
  ['mute, let me open the garage', (a) => a.some((x) => x.name === 'pc_volume' || x.name === 'pc_media')],
  ['skip and turn the lights on', (a) => a.some((x) => x.name === 'pc_media' && x.args.action === 'next')],
  ['cancel the shutdown and turn the lights back on', (a) => a.some((x) => x.name === 'pc_system' && x.args.action === 'cancel_shutdown')],
  ['open the tv app', (a) => a.some((x) => (x.name === 'pc_apps' && x.args.action === 'open') || x.name === 'pc_open')],
];

const pcAnswer = (name, x = {}) => {
  if (name === 'pc_system') return x.action === 'cancel_shutdown' ? 'Called off the shutdown.' : x.action === 'lock' ? 'Locked the PC.' : x.action === 'screen_off' ? 'Screens off.' : x.action === 'sleep' ? 'Going to sleep in 3 seconds.' : `${x.action === 'restart' ? 'Restarting' : 'Shutting down'} in 30 seconds. Saying "cancel that" stops it.`;
  if (name === 'pc_apps') return x.action === 'open' ? `Opening ${x.name} (app).` : x.action === 'close' ? `Asked ${x.name} to close.` : 'Open: Chrome, Discord, Spotify.';
  if (name === 'pc_media') return x.action === 'status' ? 'Nothing is playing.' : 'Spotify is paused on “Nights” by Frank Ocean.';
  if (name === 'pc_volume') return x.playing ? 'Spotify down to 40%.' : `Volume ${x.level ?? 40}%.`;
  if (name === 'pc_windows') return 'Chrome is maximized.';
  return 'Done.';
};
const PC_NAMES = ['pc_apps', 'pc_windows', 'pc_open', 'pc_media', 'pc_volume', 'pc_system', 'pc_info', 'pc_clipboard', 'pc_screen'];
const answers = Object.fromEntries(PC_NAMES.map((n) => [n, (x) => pcAnswer(n, x)]));

const tried = [];
const reached = [];
const kits = {
  connected: prodKit(c, { record: (name, args) => tried.push({ name, args }), answers, pc: 'connected', runPc: true, onPc: (name, args) => reached.push({ name, args }) }),
  absent: prodKit(c, { record: (name, args) => tried.push({ name, args }), answers, pc: 'absent' }),
};
const desk = (x) => `${x.speaker} is talking to you through their PC (A.D.R.I.A.N. satellite), not in the Discord call. Music and sounds play on that PC.`;
const inCall = (x) => `People in this voice call right now (general): ${x.speaker} (talking to you now), Sam, Kim.`;
const orch = (kit, line) => new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, { ...kit.options, context: (x) => [...kit.options.context(x), line(x)] });
const PLACES = {
  desk: { o: orch(kits.connected, desk), place: { channelId: 'sat:x' }, opts: { desk: true } },
  call: { o: orch(kits.connected, inCall), place: { channelId: 'call', guildId: 'g' }, opts: {} },
  nopc: { o: orch(kits.absent, inCall), place: { channelId: 'call', guildId: 'g' }, opts: {} },
};

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const POWER_Q = /(shut down|restart|put) the pc( to sleep)?\?/i;
const HONEST = /can'?t|cannot|can not|don'?t have|not able|no way|not hooked|not set up|not connected|only (control|reach|handle)|isn'?t (something|connected)|not something|\?/i;
let n = 0;
let wrong = 0;
let attempts = 0;
let honest = 0;
const wrongCases = [];
async function ask(where, text) {
  const p = PLACES[where];
  tried.length = 0;
  reached.length = 0;
  let out = '';
  for await (const ch of p.o.ask(`u${n}`, 'Sam', text, AbortSignal.timeout(30_000), undefined, p.place, p.opts)) out += (out ? ' ' : '') + ch;
  n++;
  const pcTried = tried.filter((k) => k.name.startsWith('pc_'));
  const bad = reached.length > 0 || POWER_Q.test(out);
  if (pcTried.length) attempts++;
  if (bad) {
    wrong++;
    wrongCases.push(`${where}: ${text}`);
  }
  const ok = HONEST.test(out) && !bad;
  if (ok) honest++;
  console.log(`${bad ? 'WRONG' : ok ? 'ok   ' : 'meh  '} [${where}] "${text}"\n    tried: ${pcTried.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}${reached.length ? `\n    REACHED THE PC: ${reached.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ')}` : ''}\n    says (${words(out)} words): ${out.slice(0, 200)}`);
}

for (const where of ['desk', 'call', 'nopc']) for (const text of HOME) await ask(where, text);

let pcOk = 0;
for (const [text, want] of PC) {
  tried.length = 0;
  reached.length = 0;
  let out = '';
  for await (const ch of PLACES.desk.o.ask(`p${pcOk}${text.length}`, 'Sam', text, AbortSignal.timeout(30_000), undefined, PLACES.desk.place, PLACES.desk.opts)) out += (out ? ' ' : '') + ch;
  // A refusal of ours shows as a pc_ call that never reached the PC.
  const refused = tried.some((k) => k.name.startsWith('pc_')) && !reached.length;
  const good = want(reached) && !refused;
  if (good) pcOk++;
  console.log(`${good ? 'ok   ' : 'BAD  '} [desk, the PC] "${text}"\n    reached: ${reached.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says (${words(out)} words): ${out.slice(0, 200)}`);
}

console.log(`\nwrong PC actions: ${wrong}/${n} (pc_ tool tried on ${attempts}); honest answers ${honest}/${n}; PC orders that still worked ${pcOk}/${PC.length}${wrongCases.length ? `\nwrong: ${wrongCases.join('; ')}` : ''}`);
