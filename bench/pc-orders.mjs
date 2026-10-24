// Orders and chat at a PC: does the model pick the right PC tool with the
// right arguments, keep confirmations short, and chat naturally? Real model,
// real PC tool specs and prompt lines; the PC is a stub that records actions.
//   node bench/pc-orders.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import * as music from '../dist/features/music.js';
import { PC_RULE, pcTools } from '../dist/satellite/tools.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const calls = [];
const RESULTS = {
  pc_apps: 'Opening Spotify (app).',
  pc_open: 'Opened the page.',
  pc_media: 'Spotify is playing “Nights” by Frank Ocean.',
  pc_volume: 'Volume 40%.',
  pc_system: 'Locked the PC.',
  pc_info: 'CPU 12%; memory 17.2 GB of 30.9 GB used (56%); disks: C: 480 GB free of 930 GB; up 5h 2m.',
};
// Results that match the action, like the real PC's.
const result = (name, x) => {
  if (name === 'pc_apps')
    return x.action === 'open' ? `Opening ${x.name} (app).` : x.action === 'close' ? `Asked ${x.name} to close.` : x.action === 'focus' ? `Switched to ${x.name}.` : 'Open: Chrome, Discord, Spotify.';
  if (name === 'pc_volume')
    return x.app ? `${x.app} ${x.action === 'mute' ? 'muted' : 'at 40%'}.` : x.action === 'set' ? `Volume ${x.level}%.` : x.action === 'get' ? 'Volume is 50%.' : `Volume ${x.action === 'up' ? 60 : 40}%.`;
  if (name === 'pc_media')
    return x.action === 'status' ? 'Spotify is playing “Nights” by Frank Ocean.' : x.action === 'next' ? 'Spotify is playing “Ivy” by Frank Ocean.' : 'Spotify is paused on “Nights” by Frank Ocean.';
  if (name === 'pc_info') return x.action === 'processes' ? 'Using the most memory: chrome 4.2 GB (24 processes), valorant 3.1 GB, discord 1.4 GB (6 processes).' : RESULTS.pc_info;
  if (name === 'pc_open') return x.folder ? `Opened the ${x.folder} folder.` : x.video_id ? 'Opened the YouTube video.' : 'Opened the page.';
  return RESULTS[name];
};
const pc = { action: async (name, args) => (calls.push({ name, args }), { ok: true, result: result(name, args) }) };
const stub = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'nowPlaying') return undefined;
    if (k === 'upNext' || k === 'recent') return [];
    if (k === 'paused') return false;
    if (k === 'autoplay') return true;
    return async (...a) => (calls.push({ name: `music.${String(k)}`, args: a.filter((x) => typeof x === 'string') }), { ok: true, started: { title: 'Lofi Mix', artist: 'Lofi Girl', source: 'youtube', ref: '' }, added: 3 });
  },
});
const tools = [...music.musicTools(stub), ...pcTools({ pcFor: () => pc, findVideo: async () => 'jfKfPfyJRdk' })];
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), tools, {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  stablePrefix: true,
  stableLines: [...music.musicRules(), PC_RULE],
  context: (x) => ['Reply in English.', music.musicState(stub), `${x.speaker} is talking to you through their PC (A.D.R.I.A.N. satellite), not in the Discord call. Music and sounds play on that PC.`],
});

let ok = 0;
let total = 0;
const words = (t) => t.split(/\s+/).filter(Boolean).length;
async function ask(text, check, maxWords = 30) {
  calls.length = 0;
  let out = '';
  // A fresh conversation per check, so one result can't color the next.
  for await (const ch of o.ask(`u${total}`, 'Rique', text, AbortSignal.timeout(30000), undefined, { channelId: 'sat:x' }, { desk: true })) out += (out ? ' ' : '') + ch;
  const got = calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ');
  const pass = check(calls, out) && words(out) <= maxWords;
  total++;
  if (pass) ok++;
  console.log(`${pass ? 'ok ' : 'BAD'} "${text}"\n    tools: ${got || '-'}\n    says (${words(out)} words): ${out.slice(0, 220)}`);
}
const call = (name, pred = () => true) => (cs) => cs.some((k) => k.name === name && pred(k.args));
const a = (k) => (k.action ?? '').toString();

await ask('open spotify', call('pc_apps', (x) => a(x) === 'open' && /spotify/i.test(x.name)));
await ask('close discord', call('pc_apps', (x) => a(x) === 'close' && /discord/i.test(x.name)));
await ask('turn it down a little', call('pc_volume', (x) => a(x) === 'down' || a(x) === 'set'));
await ask('set the volume to 30', call('pc_volume', (x) => a(x) === 'set' && Number(x.level) === 30));
await ask('mute discord', call('pc_volume', (x) => a(x) === 'mute' && /discord/i.test(x.app ?? '')));
await ask('skip this song', (cs) => call('pc_media', (x) => a(x) === 'next')(cs) || cs.some((k) => k.name === 'music.skip'));
await ask('pause it', call('pc_media', (x) => ['pause', 'play_pause'].includes(a(x))));
await ask("what's playing right now", call('pc_media', (x) => a(x) === 'status'));
await ask('how much ram am i using', call('pc_info'));
await ask("what's eating up my memory", call('pc_info', (x) => a(x) === 'processes'));
await ask('open my downloads folder', call('pc_open', (x) => x.folder === 'downloads'));
await ask('go to reddit', call('pc_open', (x) => /reddit\.com/.test(x.url ?? '')));
// Heard exactly like this on 2026-10-21 (ASR split "Modrinth").
await ask('open the JEI Mod Drinth page', call('pc_open', (x) => /jei/i.test(x.url ?? '')));
await ask('pull up the wiki page for the ender dragon', call('pc_open', (x) => /ender(%20|\+|_| )dragon/i.test(x.url ?? '')));
await ask('put on some lofi on youtube', (cs) => call('pc_open', (x) => /lofi/i.test(x.youtube ?? '') || !!x.video_id)(cs) || cs.some((k) => k.name === 'music.request'));
await ask('lock my pc', call('pc_system', (x) => a(x) === 'lock'));
await ask('switch to chrome', call('pc_apps', (x) => a(x) === 'focus' && /chrome/i.test(x.name)));
await ask('shut down my computer', (cs, out) => !cs.some((k) => k.name === 'pc_system' && k.args.confirmed === true) && /\?/.test(out), 40);
await ask('open valorant and turn my music down', (cs) => call('pc_apps', (x) => /valorant/i.test(x.name))(cs) && cs.some((k) => k.name === 'pc_volume' || k.name === 'pc_media'));
// Chat: short, natural, no lists.
await ask("how's it going", (cs, out) => cs.length === 0 && out.length > 0 && !/\n- |\*\*/.test(out), 35);
await ask('tell me something interesting about octopuses', (cs, out) => cs.length === 0 && !/\n- |\*\*/.test(out), 70);
await ask('i had a long day honestly', (cs, out) => cs.length === 0 && out.length > 0, 45);
console.log(`\n${ok}/${total} right`);
