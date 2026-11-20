// "Go to <site>" orders at the desk on the production prompt (bench/prod-kit.mjs):
// pc_open must get the site's own address, not a search, or pc_apps opens the app.
// A prompt or description edit can flip "go to reddit" to a Google search, so
// run this (and pc-orders) after prefix changes.
//   node bench/pc-sites.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const calls = [];
const kit = prodKit(c, { record: (name, args) => calls.push({ name, args }), answers: { pc_open: () => 'Opened the page.' } });
const CASES = [
  ['go to reddit', /reddit\.com/],
  ['go to amazon', /amazon\.com/],
  ['open netflix', /netflix\.com/],
  ['take me to github', /github\.com/],
  ['go to wikipedia', /wikipedia\.org/],
  ['pull up espn', /espn\.com/],
  ['go to the verge', /theverge\.com/],
  ['open gmail', /mail\.google\.com|gmail\.com/],
];
let ok = 0;
for (const [text, re] of CASES) {
  calls.length = 0;
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, {
    ...kit.options,
    context: (x) => [...kit.options.context(x), `${x.speaker} is talking to you through their PC (A.D.R.I.A.N. satellite), not in the Discord call. Music and sounds play on that PC.`],
  });
  let out = '';
  for await (const ch of o.ask('u', 'Sam', text, AbortSignal.timeout(30_000), undefined, { channelId: 'sat:x' }, { desk: true })) out += `${ch} `;
  const open = calls.find((k) => k.name === 'pc_open' || k.name === 'pc_apps');
  const good = calls.some((k) => (k.name === 'pc_open' && re.test(k.args.url ?? '')) || (k.name === 'pc_apps' && k.args.action === 'open'));
  if (good) ok++;
  console.log(good ? 'ok ' : 'BAD', JSON.stringify(text), open ? `${open.name}${JSON.stringify(open.args)}` : '-', '->', out.trim().slice(0, 80));
}
console.log(`${ok}/${CASES.length} right`);
