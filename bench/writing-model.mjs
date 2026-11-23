// The writing model for real: does it answer with usable JSON, edits that match
// the draft exactly, the template's limits kept, the rest of the draft left as
// it was, and nothing invented? Real model as the writer, on a made-up draft.
//   node bench/writing-model.mjs <bot.json> [model]
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { counts, fromLog, options, revise, WritingStore } from '../dist/features/writing.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const model = process.argv[3] ?? 'claude-haiku-5-5';
const llm = new AnthropicLlm({ model, apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
let spentIn = 0;
let spentOut = 0;
const w = { llm, maxTokens: 4000, spend: (u) => ((spentIn += u.inputTokens), (spentOut += u.outputTokens)) };
const T = { name: 'review', sections: [{ name: 'Summary', limit: 300 }, { name: 'Results' }], bulletLimit: 110, style: ['No first person.', 'Start each bullet with a past-tense verb.'] };
const WORDS = [{ short: 'QA', long: 'quality assurance' }];
const DRAFT = `## Summary
I led the move of the support team to the new ticket system over the summer, and it went better than expected for everyone involved.

## Results
- I cut the average wait time for customers by 30 percent across all three of our sites, which was a big improvement over last year
- Trained 12 people on the new tools
- I set up a weekly quality assurance review that caught 45 problems before customers saw them
`;

let ok = 0;
let total = 0;
const check = (name, pass, detail) => {
  total++;
  if (pass) ok++;
  console.log(`${pass ? 'ok ' : 'BAD'} ${name}${detail ? `\n    ${detail}` : ''}`);
};
const fresh = () => new WritingStore().create('1', 'Q3 review', { text: DRAFT });
const signal = () => AbortSignal.timeout(90_000);
const numbers = (t) => (t.match(/\d+/g) ?? []).sort().join(',');
const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
// Lines of DRAFT: 0 "## Summary", 1 the summary, 2 "## Results", 3-5 the bullets.
const same = (r, ...keep) => keep.every((k) => lines(r.text).includes(lines(DRAFT)[k]));
const firstPerson = (t) => /(^|[\s(])I\s/.test(t);

const cases = [
  ['make the second bullet shorter', (r) => /12/.test(r.text) && same(r, 1, 3, 5)],
  ['make the whole thing follow the template style rules', (r) => !firstPerson(r.text) && /QA/.test(r.text) && counts(r.text, T).over.length === 0],
  ['make the summary more formal', (r) => !firstPerson(r.text.split('## Results')[0]) && same(r, 4)],
  ['add a bullet that says Wrote the onboarding guide used by every new hire', (r) => /onboarding guide/i.test(r.text) && same(r, 1, 4)],
  ['shorten every bullet to under 110 characters', (r) => counts(r.text, T).over.length === 0],
];
for (const [what, test] of cases) {
  const t0 = performance.now();
  try {
    const r = await revise(w, fresh(), what, T, WORDS, signal());
    const kept = numbers(DRAFT).split(',').every((n) => numbers(r.text).includes(n));
    check(`revise: ${what}`, test(r) && !r.missed && kept, `${Math.round(performance.now() - t0)} ms, missed ${r.missed ?? 0}, over ${counts(r.text, T).over.length}, numbers kept ${kept}: ${r.summary}`);
  } catch (e) {
    check(`revise: ${what}`, false, e.message);
  }
}
try {
  const r = await revise(w, fresh(), "Fix spelling, grammar and punctuation only. Don't reword anything that is already correct.", T, WORDS, signal());
  // Correct text stays as it is: this draft has nothing much to fix.
  const changed = lines(r.text).filter((l) => !lines(DRAFT).includes(l)).length;
  check('proofread', !r.missed && changed <= 1, `${changed} lines changed: ${r.summary}`);
} catch (e) {
  check('proofread', false, e.message);
}
try {
  const d = fresh();
  const o = await options(w, d, 'the first bullet', 3, T, WORDS, signal());
  check('options: three versions of the first bullet', o.items.length === 3 && d.text.includes(o.target) && o.items.every((x) => x.length <= 110), o.items.join(' | '));
} catch (e) {
  check('options', false, e.message);
}
try {
  const log = [
    { at: Date.parse('2026-09-02T15:00:00Z'), text: 'finished the vendor audit two days early' },
    { at: Date.parse('2026-09-20T15:00:00Z'), text: 'set up laptops for the 4 new hires' },
    { at: Date.parse('2026-10-11T15:00:00Z'), text: 'cut the backlog from 300 tickets to 90' },
  ];
  const r = await fromLog(w, log, 'Write it as clear bullets, one per accomplishment, most important first.', T, WORDS, 'UTC', signal());
  check('from_log', /audit/i.test(r.text) && /300/.test(r.text) && /90/.test(r.text) && /\b4\b/.test(r.text) && counts(r.text, T).over.length === 0, r.text.replace(/\n/g, ' | ').slice(0, 300));
} catch (e) {
  check('from_log', false, e.message);
}
console.log(`\n${ok}/${total} with ${model}; ${spentIn} tokens in, ${spentOut} out`);
