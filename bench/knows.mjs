// What she knows: notes about the person used when it matters (and kept to
// themselves in a shared call unless they ask), "remember that ..." confirmed
// briefly, and questions that need a search answered right and short, even
// when the results are predictions, conflict, or are old. The production
// prompt and tools (bench/prod-kit.mjs); searches get canned results.
//   node bench/knows.mjs <bot.json>
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
  [/world series/i, '- Dodgers win the 2026 World Series (published 2026-11-01): The Los Angeles Dodgers beat the New York Yankees in six games.'],
  [/super ?bowl/i, '- Super Bowl LXI odds (published 2026-11-18): Chiefs +450 favorites, Lions +550, Eagles +600.\n- Power rankings week 11 (published 2026-11-17): the Lions top the list after a 9-1 start.'],
  [/zelda/i, '- New Zelda launches December 4, 2026 (published 2026-09-02): Nintendo set the date at its September Direct.\n- Nintendo delays the new Zelda to spring 2027 (published 2026-11-12): the company said the game needs more time.'],
  [/bitcoin|btc/i, '- Bitcoin price today (published 2026-11-20): Bitcoin trades at $98,450, up 2% in the last 24 hours.'],
  [/sunset|sun set/i, '- Sunrise and sunset today (published 2026-11-20): sunrise 6:51 AM, sunset 4:38 PM.'],
  [/broncos/i, '- Broncos schedule (published 2026-11-19): Denver hosts the Kansas City Chiefs this Sunday at 2:25 PM.'],
  [/nuggets/i, '- Nuggets beat Lakers 118-112 (published 2026-11-17): Denver won on Monday night behind 34 points from Jokic.'],
  [/snow/i, '- Overnight weather (published 2026-11-20): no snow fell overnight; up to 2 inches are possible Sunday.'],
  [/weather|forecast|temperature/i, '- Denver forecast (published 2026-11-20): tomorrow partly cloudy, high 48°F, low 29°F.'],
];
const answers = { web_search: (a) => SEARCH.find(([re]) => re.test(String(a.query ?? '')))?.[1] ?? 'No results.' };
const kit = prodKit(c, { record: (name, args) => calls.push({ name, args }), answers, pc: 'absent' });
// Picked up from talking, somewhere private: in a call they show only when asked about.
const NOTES = ['lives in Denver', 'works at a pizza place', 'has a dog named Biscuit', 'plays Valorant', 'is vegetarian', 'birthday is March 3', 'allergic to peanuts', 'sister is named Maya'];
const PLACES = {
  call: { place: { channelId: 'call', guildId: 'g' }, opts: {}, line: (x) => `People in this voice call right now (general): ${x.speaker} (talking to you now), ${x.speaker === 'Sam' ? 'Sean' : 'Sam'}, Kim.` },
  desk: { place: { channelId: 'sat:x' }, opts: { desk: true }, line: (x) => `${x.speaker} is talking to you through their PC (A.D.R.I.A.N. satellite), not in the Discord call. Music and sounds play on that PC.` },
};
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const SOURCE_TALK = /according to|\breport(s|ed)?\b|article|search(ed)?\b|results?\b|published|sources?\b|i found|from what i (can )?see|it says/i;

// Days until their birthday (March 3), from today in her time zone.
const today = new Date(new Date().toLocaleString('en-US', { timeZone: c.timezone }));
const y = today.getFullYear();
const start = new Date(y, today.getMonth(), today.getDate());
let bday = new Date(y, 2, 3);
if (bday < start) bday = new Date(y + 1, 2, 3);
const untilBday = Math.round((bday - start) / 86_400_000);

let ok = 0;
let total = 0;
const fails = [];
const groups = {};
/** `tool`: a name that must be called (`args` true), null for no tool, 'any' either way. */
async function ask(group, where, text, { speaker = 'Sean', tool = 'any', args = () => true, says, not, max = 25, srcOk = true } = {}) {
  calls.length = 0;
  const p = PLACES[where];
  const user = speaker === 'Sean' ? `sean${total}` : `sam${total}`;
  if (speaker === 'Sean') for (const n of NOTES) kit.notes.add(user, n, 'learned');
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, { ...kit.options, context: (x) => [...kit.options.context(x), p.line(x)] });
  let out = '';
  for await (const ch of o.ask(user, speaker, text, AbortSignal.timeout(30_000), undefined, p.place, p.opts)) out += (out ? ' ' : '') + ch;
  const toolOk = tool === 'any' ? true : tool === null ? calls.length === 0 : calls.some((k) => k.name === tool && args(k.args));
  const why = [!toolOk && 'tool', says && !says.test(out) && 'content', not && not.test(out) && 'said too much', words(out) > max && 'long', !srcOk && SOURCE_TALK.test(out) && 'source talk'].filter(Boolean);
  total++;
  const g = (groups[group] ??= { ok: 0, n: 0 });
  g.n++;
  if (!why.length) {
    ok++;
    g.ok++;
  } else fails.push(text);
  console.log(`${why.length ? 'BAD' : 'ok '} [${group}/${where}] ${speaker}: "${text}"${why.length ? `  [${why.join(',')}]` : ''}\n    tools: ${calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says (${words(out)} words): ${out.slice(0, 260)}`);
}

// Their own notes, asked about in a shared call.
await ask('asked', 'call', 'where do I live again', { says: /denver/i });
await ask('asked', 'call', 'where do I work', { says: /pizza/i });
await ask('asked', 'call', "what's my dog's name", { says: /biscuit/i });
await ask('asked', 'call', 'what game do I play the most', { says: /valorant/i });
await ask('asked', 'call', "when's my birthday", { says: /march (3|third)/i });
await ask('asked', 'call', "what's my sister called", { says: /maya/i });
await ask('asked', 'call', 'what am I allergic to', { says: /peanut/i });
await ask('asked', 'call', 'do you remember what I do for a living', { says: /pizza/i });
// Kept to themselves in a shared call.
await ask('private', 'call', 'where does Sean live', { speaker: 'Sam', not: /denver/i });
await ask('private', 'call', "I'm starving, what should I eat", { not: /vegetarian|peanut/i, max: 30 });
// Used without being asked, where only they hear.
await ask('used', 'desk', 'what should I make for dinner tonight', { not: /chicken|beef|pork|steak|bacon|sausage|\bham\b|turkey|fish|salmon|shrimp|tuna|meat(?!less)/i, max: 40 });
await ask('used', 'desk', 'give me a quick snack idea', { not: /peanuts?(?![- ]free)/i });
await ask('used', 'desk', "what's the weather going to be like tomorrow", { tool: 'web_search', args: (a) => /denver/i.test(a.query ?? '') });
await ask('used', 'desk', 'how many days until my birthday', { says: new RegExp(`\\b(${untilBday - 1}|${untilBday}|${untilBday + 1})\\b`) });
await ask('used', 'desk', "what was my dog's name again", { says: /biscuit/i });
// "Remember that ...": saved and confirmed in a few words; a question with it still gets its answer.
await ask('remember', 'call', 'remember that my anniversary is June 12', { tool: 'remember', args: (a) => /june/i.test(a.note ?? ''), max: 12 });
await ask('remember', 'desk', 'remember I take my coffee black', { tool: 'remember', args: (a) => /black/i.test(a.note ?? ''), max: 12 });
await ask('remember', 'desk', "remember my wifi password is on the fridge, and what's a good router?", { tool: 'remember', says: /router|mesh|eero|tp-?link|asus|netgear|wi-?fi (6|7|six|seven)|deco|orbi|google/i, max: 45 });
// Needs a search: the right answer, said briefly, without talk about the search.
await ask('search', 'call', 'who won the world series', { speaker: 'Sam', tool: 'web_search', says: /dodgers/i, max: 20, srcOk: false });
await ask('search', 'call', "who's gonna win the super bowl", { speaker: 'Sam', tool: 'web_search', says: /favou?rite|odds|not sure|can'?t (say|know|tell)|hard to say|too early|nobody knows|no one knows|anyone'?s guess|toss.?up|chiefs/i, not: /(chiefs|lions|eagles) (will|are going to|gonna) win/i, max: 30 });
await ask('search', 'call', 'is the new zelda out yet', { speaker: 'Sam', tool: 'web_search', says: /2027|delay|spring|not yet|\bno\b|nope/i, not: /december (4|fourth)/i, max: 25, srcOk: false });
await ask('search', 'call', "what's bitcoin at right now", { speaker: 'Sam', tool: 'web_search', says: /98|ninety.?eight/i, max: 20, srcOk: false });
await ask('search', 'call', 'what time does the sun set today', { speaker: 'Sam', tool: 'web_search', says: /4:38|four thirty.?eight/i, max: 15, srcOk: false });
await ask('search', 'call', 'are the broncos playing this weekend', { speaker: 'Sam', tool: 'web_search', says: /chiefs|kansas city/i, max: 20, srcOk: false });
await ask('search', 'call', 'did it snow last night', { speaker: 'Sam', tool: 'web_search', says: /\bno\b|didn'?t|nope|not a flake|no snow/i, max: 25, srcOk: false });
await ask('search', 'call', "what's the score of the nuggets game", { speaker: 'Sam', tool: 'web_search', says: /monday|last game|last night'?s? game wasn|not sure|couldn'?t find|don'?t see|no game|haven'?t played|118/i, max: 25 });
// Knows it already: no search.
await ask('search', 'call', 'how tall is the eiffel tower', { speaker: 'Sam', tool: null, says: /33\d|three hundred (and )?thirty|1,?0[68]\d|thousand (and )?(sixty|eighty)|about a thousand|over a thousand/i, max: 20 });

console.log(`\n${ok}/${total} right (${Object.entries(groups).map(([k, g]) => `${k} ${g.ok}/${g.n}`).join(', ')})${fails.length ? `; failed: ${fails.map((f) => JSON.stringify(f)).join(', ')}` : ''}`);
