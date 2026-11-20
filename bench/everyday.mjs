// Everyday household questions by voice, on the production prompt (every live
// tool and rule, bench/prod-kit.mjs): does she give the right answer, use a tool
// only when it's needed, stay short enough to listen to, and admit what she
// can't do? Web searches get canned results (no network); timers and notes run
// for real on stubs. Each case is a fresh conversation unless it's a follow-up.
//   node bench/everyday.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const calls = [];
// Made-up search results, picked by what the query is about.
const SEARCH = [
  [/weather|forecast|snow|rain|temperature/i, '- Tomorrow\'s forecast (published 2026-11-20): Saturday, partly cloudy, high 48°F, low 29°F, 10% chance of snow, wind 10 mph.\n- Weekend outlook: dry and sunny Sunday, high 52°F.'],
  [/broncos|game|score|won|nfl/i, '- Broncos beat Raiders 24-17 (published 2026-11-16): Denver won on Sunday behind two fourth-quarter touchdowns.\n- Week 11 recap: Broncos improve to 7-3.'],
  [/target|thanksgiving|open|hours/i, '- Target Thanksgiving 2026 hours (published 2026-11-12): Target stores are closed on Thanksgiving Day, Thursday Nov 26, and open at 6 AM on Black Friday.'],
  [/ps5|playstation|price|cost/i, '- PS5 prices this week (published 2026-11-18): PS5 Slim digital $449.99, PS5 Slim with disc drive $499.99, PS5 Pro $749.99; Black Friday deals start Nov 27.'],
  [/gas|fuel/i, '- Local gas prices (published 2026-11-19): regular averages $2.89 a gallon in the metro area, down 6 cents from last week.'],
];
const answers = {
  web_search: (a) => SEARCH.find(([re]) => re.test(String(a.query ?? '')))?.[1] ?? 'No results.',
  briefing: () => 'Good morning. Partly cloudy today, high of forty eight. No reminders left today. In the news: the Senate passed a spending bill.',
  headlines: () => 'NPR: Senate passes spending bill; Winter storm heads for the Northeast; Rocket launch delayed to Monday.',
};
const kit = prodKit(c, { record: (name, args) => calls.push({ name, args }), answers, pc: false });
const memory = new SessionMemory(16, 3_600_000);
const o = new ConversationOrchestrator(llm, memory, kit.tools, {
  ...kit.options,
  context: (x) => [...kit.options.context(x), `In the voice call with ${x.speaker}: Kim, Alex.`],
});

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const OPENERS = /^(great question|sure[,!.]|absolutely|of course|certainly|as an ai)/i;
let ok = 0;
let total = 0;
const fails = [];
/** `tool`: a name that must be called (with `args` true), null for no tool at all, 'any' for either. */
async function ask(text, { tool = null, args = () => true, says, max = 20, user = `u${total}` } = {}) {
  calls.length = 0;
  let out = '';
  for await (const ch of o.ask(user, 'Sam', text, AbortSignal.timeout(30_000), undefined, { channelId: 'call', guildId: 'g' })) out += (out ? ' ' : '') + ch;
  const toolOk = tool === 'any' ? true : tool === null ? calls.length === 0 : calls.some((k) => k.name === tool && args(k.args));
  const saysOk = !says || says.test(out);
  const short = words(out) <= max;
  const clean = !OPENERS.test(out.trim()) && !/\n- |\*\*|https?:/.test(out);
  const pass = toolOk && saysOk && short && clean;
  total++;
  if (pass) ok++;
  else fails.push(text);
  const why = [!toolOk && 'tool', !saysOk && 'content', !short && 'long', !clean && 'style'].filter(Boolean).join(',');
  console.log(`${pass ? 'ok ' : 'BAD'} "${text}"${why ? `  [${why}]` : ''}\n    tools: ${calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says (${words(out)} words): ${out.slice(0, 300)}`);
}

// Quick facts: just the fact.
await ask('how many tablespoons are in a cup', { says: /16|sixteen/i, max: 15 });
await ask("what's fifteen percent of eighty", { says: /12|twelve/i, max: 15 });
await ask('how many grams in an ounce', { says: /28|twenty.?eight/i, max: 15 });
await ask('what temperature does chicken need to be cooked to', { says: /165|one sixty.?five|one hundred (and )?sixty.?five/i, max: 20 });
await ask('how do you spell necessary', { says: /n.?e.?c.?e.?s.?s.?a.?r.?y/i, max: 25 });
await ask('how many days until christmas', { says: /3[45]|thirty.?(four|five)/i, max: 15 });
await ask('what day is thanksgiving this year', { says: /26|twenty.?sixth/i, max: 15 });
await ask("what's the capital of canada", { says: /ottawa/i, max: 10 });
await ask('how long do I boil an egg for a soft yolk', { says: /\b(6|7|six|seven)\b/i, max: 20 });
// How and why: a real answer, still short enough to hear.
await ask('how do I get a red wine stain out of the carpet', { says: /blot|salt|baking soda|club soda|dish soap|vinegar|peroxide/i, max: 40 });
await ask('why does my wifi keep dropping', { max: 40 });
await ask('what can I make for dinner with eggs, rice and spinach', { says: /fried rice|omelet|frittata|bowl/i, max: 40 });
await ask("what's a good substitute for buttermilk", { says: /lemon|vinegar|yogurt/i, max: 30, user: 'buttermilk' });
await ask('how much lemon juice', { says: /tablespoon|spoon/i, max: 25, user: 'buttermilk' });
await ask('should I get a real christmas tree or a fake one', { max: 35 });
// Things that change: look it up, then say only what matters.
await ask("what's the weather supposed to be tomorrow", { tool: 'web_search', says: /48|forty.?eight/i, max: 25 });
await ask('did the broncos win', { tool: 'web_search', says: /24|twenty.?four|yes|yeah|they did/i, max: 25 });
await ask('is target open on thanksgiving', { tool: 'web_search', says: /closed|no|nope/i, max: 25 });
await ask('how much is a ps5 right now', { tool: 'web_search', says: /449|499|749|four (hundred|forty)|seven (hundred|forty)/i, max: 30 });
await ask("what's in the news today", { tool: 'headlines', max: 40 });
// Timers and reminders: the tool, then a short read-back.
await ask('set a timer for ten minutes for the pasta', { tool: 'set_timer', args: (a) => Number(a.minutes) === 10, max: 15 });
await ask('remind me to take the chicken out of the freezer at five', { tool: 'set_reminder', max: 20 });
await ask('set a timer', { tool: 'any', says: /how long|\?/i, max: 15 });
// What she can't do: say so briefly, call nothing, invent nothing.
await ask('turn off the living room lights', { says: /can't|cannot|can not|don't have|not able|no way to|not hooked|not set up|not connected/i, max: 25 });
await ask('order more paper towels on amazon', { says: /can't|cannot|can not|don't have|not able|no way to|(isn't|not) something I can/i, max: 25 });
await ask('call my mom', { says: /can't|cannot|can not|don't have|not able|no way to|(isn't|not) something I can/i, max: 25 });
// Hanging out: warm and short.
await ask("I'm so bored", { max: 25 });
await ask('tell me a joke', { max: 35 });
await ask("how's your day going", { max: 20 });
// The morning briefing is said by the tool itself.
await ask('good morning adrian', { tool: 'briefing', max: 40 });

console.log(`\n${ok}/${total} right${fails.length ? `; failed: ${fails.map((f) => JSON.stringify(f)).join(', ')}` : ''}`);
