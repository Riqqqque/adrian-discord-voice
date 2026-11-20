// Loose wakes on the real model, through the production prompt: what follows
// her name when the name may not have been for her. `old` judges it with the
// follow-up line ("said this without using your name"), `new` with the loose
// line ("with your name in it, but maybe about you"). Counts only: which
// lines she answered and which she let pass (SILENT).
//   node bench/loose-wake.mjs <bot.json> [reps] [out.json]
import { writeFileSync } from 'node:fs';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const reps = Number(process.argv[3] ?? 2);
const outFile = process.argv[4] ?? 'loose-wake.json';
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: readSecrets(c.secretsFile).get('ANTHROPIC_API_KEY'), effort: 'low' });
// What reaches the model is the part after the name. `for`: meant for her (true), or not (false).
const LINES = [
  { said: 'skipped this song', for: true, from: '"Adrian, skip this song", heard in the past tense' },
  { said: 'paused the music', for: true, from: '"Adrian, pause the music", past tense' },
  { said: "what's the weather tomorrow", for: true, from: '"Adrian, what\'s the weather tomorrow"' },
  { said: 'Yo, what is good', for: true, from: '"Yo, what is good, Adrian?"' },
  { said: 'can you turn it up a bit', for: true, from: '"Adrian can you turn it up a bit"' },
  { said: 'said he would be late', for: false, from: '"Adrian said he would be late."' },
  { said: 'is in the other channel', for: false, from: '"Hey, Adrian is in the other channel."' },
  { said: 'will handle it', for: false, from: '"Okay, Adrian will handle it."' },
  { said: 'is so slow today', for: false, from: '"Adrian is so slow today"' },
  { said: 'went home already', for: false, from: '"Adrian went home already"' },
];
const IN = 1 / 1e6;
const OUT = 5 / 1e6;
const results = [];
let cost = 0;
for (let r = 0; r < reps; r++) {
  for (const desk of [false, true]) {
    for (const variant of ['old', 'new']) {
      for (const line of LINES) {
        const kit = prodKit(c, { pc: 'absent' });
        const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, kit.options);
        let out = '';
        let silent = false;
        let usage;
        try {
          for await (const ch of o.ask(`u${r}`, 'Sam', line.said, AbortSignal.timeout(20_000), (u) => (usage = u), desk ? { channelId: 'sat:x' } : { channelId: 'call', guildId: 'g' }, {
            followUp: true,
            ...(variant === 'new' ? { loose: true } : {}),
            ...(desk ? { desk: true } : {}),
            onSilent: () => (silent = true),
          }))
            out += (out ? ' ' : '') + ch;
        } catch (e) {
          out = `error: ${e.message}`;
        }
        const answered = !silent && !!out;
        if (usage) cost += (usage.inputTokens - usage.cachedTokens) * IN + usage.cachedTokens * IN * 0.1 + usage.outputTokens * OUT;
        const rec = { rep: r, desk, variant, said: line.said, for: line.for, answered, right: answered === line.for, out: out.slice(0, 140) };
        results.push(rec);
        console.log(JSON.stringify(rec));
        writeFileSync(outFile, JSON.stringify(results, null, 1));
      }
    }
  }
}
for (const desk of [false, true]) {
  for (const variant of ['old', 'new']) {
    const rs = results.filter((x) => x.desk === desk && x.variant === variant);
    const forHer = rs.filter((x) => x.for);
    const notForHer = rs.filter((x) => !x.for);
    console.log(`${desk ? 'pc  ' : 'call'} ${variant}: answered ${forHer.filter((x) => x.answered).length}/${forHer.length} meant for her, let pass ${notForHer.filter((x) => !x.answered).length}/${notForHer.length} not meant for her`);
  }
}
console.log(`about $${cost.toFixed(3)}`);
