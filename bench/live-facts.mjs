// Facts that depend on today, right now or where they are (sunset, the weather
// outside, tonight's score, a price, store hours, the news) must come from a
// tool, never from memory; stable facts (history, science, units) must not
// search. The production prompt and tools (bench/prod-kit.mjs); searches get
// canned results whose numbers differ from what a guess from memory would say,
// so an answer from memory fails on content too.
//   node bench/live-facts.mjs <bot.json> [--holdout]
// --holdout runs only the held-out cases: written with the rest, never looked
// at while changing the prompt.
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const calls = [];
const SEARCH = [
  [/sunrise|sun ?rise|sun come up/i, '- Sunrise and sunset (published 2026-11-20): tomorrow sunrise 6:58 AM, sunset 4:37 PM.'],
  [/sunset|sun ?set|sun go(es)? down|dark/i, '- Sunrise and sunset today (published 2026-11-20): sunrise 6:57 AM, sunset 4:38 PM, civil twilight ends 5:06 PM.'],
  [/post office|usps|mail/i, '- Post office hours (published 2026-11-12): Monday to Friday 8:30 AM to 5:30 PM, Saturday 9 AM to 1 PM.'],
  [/blackhawks|hockey|nhl/i, '- Blackhawks beat Stars 5-2 (published 2026-11-20): Chicago won last night at the United Center; Bedard had two goals.'],
  [/bears|nfl|football/i, '- Bears vs. Lions (published 2026-11-19): Chicago hosts Detroit this Sunday, kickoff 2:25 PM.'],
  [/egg/i, '- Egg prices (published 2026-11-18): a dozen large eggs average $3.17 at metro grocery stores this week.'],
  [/tesla|tsla/i, '- Tesla stock (published 2026-11-20): TSLA trades at $412.30, down 1.4% today.'],
  [/stock market|dow|s&p|nasdaq|stocks/i, '- Markets today (published 2026-11-20): the S&P 500 is up 0.8% and the Dow is up 310 points at midday.'],
  [/euro|exchange|eur/i, '- Exchange rates (published 2026-11-20): 1 euro = 1.13 US dollars.'],
  [/costco/i, '- Costco hours (published 2026-11-15): weekdays 10 AM to 8:30 PM, Saturday 9:30 AM to 6 PM, Sunday 10 AM to 6 PM.'],
  [/home depot/i, '- Home Depot hours (published 2026-11-14): Monday to Saturday 6 AM to 9 PM, Sunday 8 AM to 8 PM.'],
  [/dmv|motor vehicle/i, '- Illinois DMV office hours (published 2026-11-10): Monday to Friday 8 AM to 4:30 PM, closed weekends.'],
  [/traffic|i-?25|highway|commute/i, '- Traffic (published 2026-11-20): I-25 northbound slow from Colfax to 58th, about 15 minutes of delay after a crash.'],
  [/gas|fuel/i, '- Local gas prices (published 2026-11-19): regular averages $2.89 a gallon in the metro area.'],
  [/rain|umbrella/i, '- Chicago forecast today (published 2026-11-20): cloudy, 60% chance of rain after 3 PM, high 51°F.'],
  [/weather|forecast|temperature|cold|outside|degrees|jacket|coat/i, '- Chicago weather now (published 2026-11-20): 37°F, feels like 31°F, light wind; high today 51°F, rain likely after 3 PM.'],
  [/news|headline/i, '- Top stories (published 2026-11-20): Senate passes spending bill; winter storm heads for the Northeast.'],
];
const answers = {
  web_search: (a) => SEARCH.find(([re]) => re.test(String(a.query ?? '')))?.[1] ?? 'No results.',
  headlines: () => 'NPR: Senate passes spending bill; Winter storm heads for the Northeast; Rocket launch delayed to Monday.',
};
const kit = prodKit(c, { record: (name, args) => calls.push({ name, args }), answers, pc: 'absent' });
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const LIVE = ['web_search', 'weather', 'headlines', 'briefing'];

let ok = 0;
let total = 0;
let long = 0;
const fails = [];
const groups = {};
/** `tool`: 'live' (any of the lookup tools must run), null (no tool), or a tool name. */
async function ask(group, text, { tool = 'live', says, max = 25 } = {}) {
  calls.length = 0;
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, {
    ...kit.options,
    context: (x) => [...kit.options.context(x), `People in this voice call right now (general): ${x.speaker} (talking to you now), Kim.`],
  });
  let out = '';
  for await (const ch of o.ask(`u${total}`, 'Sam', text, AbortSignal.timeout(30_000), undefined, { channelId: 'call', guildId: 'g' })) out += (out ? ' ' : '') + ch;
  const toolOk = tool === 'live' ? calls.some((k) => LIVE.includes(k.name)) : tool === null ? calls.length === 0 : calls.some((k) => k.name === tool);
  // Length is counted, not graded: the brevity benches grade it.
  const why = [!toolOk && 'tool', says && !says.test(out) && 'content'].filter(Boolean);
  if (words(out) > max) long++;
  total++;
  const g = (groups[group] ??= { ok: 0, n: 0 });
  g.n++;
  if (!why.length) {
    ok++;
    g.ok++;
  } else fails.push(text);
  console.log(`${why.length ? 'BAD' : 'ok '} [${group}] "${text}"${why.length ? `  [${why.join(',')}]` : ''}${words(out) > max ? ' (long)' : ''}\n    tools: ${calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says (${words(out)} words): ${out.slice(0, 220)}`);
}

if (process.argv.includes('--holdout')) await holdout();
else await main();
console.log(`\n${long}/${total} over their word limit`);
console.log(`${ok}/${total} right (${Object.entries(groups).map(([k, g]) => `${k} ${g.ok}/${g.n}`).join(', ')})${fails.length ? `; failed: ${fails.map((f) => JSON.stringify(f)).join(', ')}` : ''}`);

async function main() {
  // Today, now, here: a tool, and the tool's number.
  await ask('live', 'what time does the sun set today', { says: /4:38|four thirty.?eight/i, max: 15 });
  await ask('live', 'when does the sun come up tomorrow', { says: /6:58|six fifty.?eight/i, max: 15 });
  await ask('live', 'how cold is it outside right now', { says: /37|thirty.?seven/i });
  await ask('live', 'is it gonna rain today', { says: /60|sixty|after (3|three)|afternoon|likely|yes|yeah/i });
  await ask('live', 'did the avalanche win last night', { says: /5.?2|five.?(to.?)?two|yes|yeah|they did/i });
  await ask('live', 'how much is a dozen eggs right now', { says: /3\.17|three (dollars )?(and )?seventeen/i });
  await ask('live', "what's tesla stock at", { says: /412|four hundred (and )?twelve|four twelve/i });
  await ask('live', 'what time does costco close tonight', { says: /8:30|eight thirty/i, max: 20 });
  await ask('live', "what's the euro to dollar rate today", { says: /1\.13|one (point )?one three|a dollar thirteen|one dollar (and )?thirteen/i });
  await ask('live', 'is the post office open today', { says: /5:30|five thirty|yes|yeah|open/i });
  // Stable facts: answered straight, no lookup.
  await ask('stable', 'how tall is the eiffel tower', { tool: null, says: /33\d|three hundred (and )?thirty|1,?0[68]\d|thousand/i, max: 20 });
  await ask('stable', 'when did world war two end', { tool: null, says: /1945|nineteen forty.?five/i, max: 20 });
  await ask('stable', 'what temperature does water boil at in fahrenheit', { tool: null, says: /212|two hundred (and )?twelve|two twelve/i, max: 15 });
  await ask('stable', 'who won the first super bowl', { tool: null, says: /packers|green bay/i, max: 20 });
  await ask('stable', 'why do we have leap years', { tool: null, says: /365|quarter|orbit|sun|calendar/i, max: 40 });
  await ask('stable', 'what time is it', { tool: 'get_time', max: 12 });
}

async function holdout() {
  await ask('held', 'when does it get dark tonight', { says: /4:38|four thirty.?eight|5:06|five (oh )?six/i, max: 20 });
  await ask('held', 'is home depot open right now', { says: /9|nine|yes|yeah|open/i });
  await ask('held', "what's traffic like on i-25", { says: /15|fifteen|slow|crash|delay|backed/i });
  await ask('held', 'do I need a jacket today', { says: /37|thirty.?seven|51|fifty.?one|yes|yeah|definitely|cold|chilly/i });
  await ask('held', 'how are stocks doing today', { says: /0\.8|point eight|310|three hundred (and )?ten|up/i });
  await ask('held', 'is the dmv open tomorrow', { says: /closed|no|nope|weekend|saturday|monday/i });
  await ask('held', 'how many feet in a mile', { tool: null, says: /5,?280|fifty.?two hundred|five thousand/i, max: 15 });
  await ask('held', 'how far away is the moon', { tool: null, says: /23\d|two hundred (and )?thirty|38\d|three hundred (and )?eighty/i, max: 20 });
}
