// "Make the second bullet shorter": does the model call the draft tool with the
// right action and pass the instruction along, and leave it alone for other
// talk? Real model, real tool specs; the writing model and the music player are
// stubs, so nothing is really rewritten.
//   node bench/writing-orders.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import * as music from '../dist/features/music.js';
import { writingContext, writingTool, WritingStore } from '../dist/features/writing.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

const ME = '100000000000000001';
const calls = [];
let store;
const fresh = (text) => {
  store = new WritingStore();
  const d = store.create(ME, 'Q3 review', { text: '## Summary\nLed the move to the new system.\n\n## Results\n- Cut wait times by 30 percent across three sites\n- Trained 12 people on the new tools\n' });
  d.options = { target: 'Led the move to the new system.', items: ['Headed the move.', 'Ran the move.', 'Drove the move.'] };
  const real = writingTool({
    store,
    templates: [{ name: 'letter', sections: [{ name: 'Opening' }, { name: 'Body' }, { name: 'Closing' }], style: [] }],
    timezone: c.timezone,
    writer: () => ({ llm: { model: 'stub', async *stream() { yield { type: 'text', delta: '{"summary":"ok","edits":[]}' }; } }, maxTokens: 100, spend: () => {} }),
    tell: async () => {},
    sendFile: async () => 'https://cdn.example/x',
    dictate: () => true,
  });
  const tool = { ...real, run: async (args, signal, ctx) => (calls.push({ name: 'draft', args }), real.run(args, signal, ctx)) };
  const stub = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'nowPlaying' || k === 'lent') return undefined;
      if (k === 'upNext' || k === 'recent') return [];
      if (k === 'paused' || k === 'youtubePaused') return false;
      if (k === 'autoplay') return true;
      return async (...a) => (calls.push({ name: `music.${String(k)}`, args: a.filter((x) => typeof x === 'string') }), { ok: true, started: { title: 'Lofi Mix', artist: 'Lofi Girl', source: 'youtube', ref: '' }, added: 3 });
    },
  });
  return new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), [...music.musicTools(stub), tool], {
    spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
    stablePrefix: true,
    stableLines: [...music.musicRules()],
    context: () => ['Reply in English.', music.musicState(stub), ...writingContext(store, ME, 'Morgan', false)],
  });
};

let ok = 0;
let total = 0;
async function ask(text, check, { typed = false } = {}) {
  calls.length = 0;
  let out = '';
  for await (const ch of fresh(typed).ask(ME, 'Morgan', text, AbortSignal.timeout(30000), undefined, { guildId: '1', channelId: '2' }, typed ? { text: true } : {})) out += (out ? ' ' : '') + ch;
  const pass = check(calls, out);
  total++;
  if (pass) ok++;
  console.log(`${pass ? 'ok ' : 'BAD'} "${text}"\n    tools: ${calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says: ${out.slice(0, 200)}`);
}
const dr = (pred) => (cs) => cs.some((k) => k.name === 'draft' && pred(k.args)) && !cs.some((k) => k.name.startsWith('music.'));
const none = (cs) => !cs.some((k) => k.name === 'draft');
const has = (x, re) => re.test(String(x ?? ''));

await ask('start a new draft called cover letter using the letter template', dr((x) => x.action === 'start' && has(x.title, /cover letter/i) && has(x.template, /letter/i)));
await ask('I want to dictate my review', dr((x) => x.action === 'dictate' || x.action === 'open' || x.action === 'start'));
await ask('make the second bullet shorter', dr((x) => x.action === 'revise' && has(x.instruction, /second bullet/i)));
await ask('can you make the whole thing sound more formal', dr((x) => x.action === 'revise' && has(x.instruction, /formal/i)));
await ask('give me three versions of the opening line', dr((x) => x.action === 'options' && has(x.instruction, /open/i)));
await ask("I'll go with option two", dr((x) => x.action === 'choose' && Number(x.n) === 2));
await ask('proofread it', dr((x) => x.action === 'proofread'));
await ask('undo that last change', dr((x) => x.action === 'undo'));
await ask('how long is it now, am I over any limits', dr((x) => x.action === 'count'));
await ask('read it back to me', dr((x) => x.action === 'read'));
await ask('log that I finished the audit two days early', dr((x) => x.action === 'log' && has(x.text, /audit/i)));
await ask('turn everything I logged this quarter into a draft', dr((x) => x.action === 'from_log'));
await ask('always write QA for quality assurance', dr((x) => x.action === 'word' && has(x.short, /^QA$/) && has(x.long, /quality assurance/i)));
await ask('send me the draft as a text file', dr((x) => x.action === 'export' && x.format === 'txt'));
await ask('make a template called report with sections summary and findings, bullets under 200 characters, no first person', dr((x) => x.action === 'template' && has(x.template ?? x.title, /report/i) && Number(x.bullet_limit) === 200));
await ask('add a bullet that says I mentored two new hires', dr((x) => (x.action === 'add' && has(x.text, /mentor/i) && !has(x.text, /add a bullet/i)) || (x.action === 'revise' && has(x.instruction, /mentor/i))), { typed: true });
// Not about her drafts.
await ask('play some lofi', (cs) => cs.some((k) => k.name.startsWith('music.')) && none(cs));
await ask('what time does the post office close', none);
await ask('who wrote pride and prejudice', none);

console.log(`\n${ok}/${total}`);
