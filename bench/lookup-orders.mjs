// Does she look things up instead of saying she doesn't know, and still answer
// what she knows without a search? Real model, production prompt and tools
// (bench/prod-kit.mjs); web_search answers from canned results, so this checks
// her choices, not the web.
//   node bench/lookup-orders.mjs <bot.json> [runs]
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const runs = Number(process.argv[3] ?? 1);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

const KEY = '- 2 Much (Live from Paris) Chords by Justin Bieber: Key: A; bpm: 120.\n- Key & BPM for 2 Much by Justin Bieber - Tunebat: in A major at 120 BPM.';
// [turns, least searches, most searches, what the answer must say, results (in order; the last repeats)]
const CASES = [
  [["What key is Justin Bieber's Too Much Live From Paris?"], 1, 3, /\bA\b|A major/, [KEY]],
  [["What key is Justin Bieber's Too Much Live From Paris?"], 2, 3, /\bA\b|A major/, ['No results.', KEY]],
  [["What key is Justin Bieber's Too Much Live From Paris?", 'Okay, then look it up.'], 1, 4, /\bA\b|A major/, [KEY]],
  [["what's the BPM of Blinding Lights?"], 1, 3, /171|170/, ['- Blinding Lights by The Weeknd: 171 BPM, key F minor.']],
  [["what's the TDP of the RTX 5070?"], 1, 3, /250/, ['- GeForce RTX 5070 specs: total graphics power 250 W.']],
  [['look up how many calories are in a Big Mac'], 1, 3, /590|five hundred ninety/i, ['- Big Mac nutrition: 590 calories.']],
  [['who plays drums in the band Wallows?'], 1, 3, /Cole/i, ['- Wallows: Dylan Minnette, Braeden Lemasters, Cole Preston (drums).']],
  [['what is the capital of Australia?'], 0, 0, /Canberra/i, []],
  [['how many ounces in a pound?'], 0, 0, /sixteen|16/i, []],
  [['why is the sky blue?'], 0, 0, /scatter/i, []],
  [['who wrote Romeo and Juliet?'], 0, 0, /Shakespeare/i, []],
  [["what's fifteen times twelve?"], 0, 0, /180|one (hundred )?eighty/i, []],
];

let good = 0;
let total = 0;
for (let run = 0; run < runs; run++) {
  for (const [turns, least, most, must, results] of CASES) {
    let searches = 0;
    const kit = prodKit(c, {
      answers: { web_search: () => results[Math.min(searches++, results.length - 1)] ?? 'No results.' },
    });
    const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, kit.options);
    let said = '';
    for (const t of turns) {
      said = '';
      for await (const chunk of o.ask('u', 'Sam', t, AbortSignal.timeout(40_000))) said += `${chunk} `;
    }
    said = said.trim();
    const ok = searches >= least && searches <= most && must.test(said);
    total++;
    if (ok) good++;
    console.log(ok ? 'PASS' : 'FAIL', `searches ${searches} (want ${least}-${most})`, JSON.stringify(turns.at(-1)), '->', said.slice(0, 160));
  }
}
console.log(`${good}/${total}`);
