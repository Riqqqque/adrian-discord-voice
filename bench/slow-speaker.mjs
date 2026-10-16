// Long answer, slow "speaker", short generation limit: does the answer get
// cut? Old way (pull while speaking) vs eager (pull as fast as it comes).
//   node bench/slow-speaker.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { eager } from '../dist/core/eager.js';

const c = loadConfig(process.argv[2]);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: readSecrets(c.secretsFile).get('ANTHROPIC_API_KEY'), effort: 'low' });
const o = new ConversationOrchestrator(llm, new SessionMemory(4, 60_000), [], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 0,
});
const q = 'Explain in about eight sentences how a rocket gets to orbit.';
for (const mode of ['old', 'eager']) {
  const limit = AbortSignal.timeout(6_000);
  let gen = o.ask(`u-${mode}`, 'Sean', q, limit);
  if (mode === 'eager') gen = eager(gen);
  let n = 0;
  let err = '';
  try {
    for await (const _ of gen) {
      n++;
      await new Promise((r) => setTimeout(r, 1_500)); // "speaking" this sentence
    }
  } catch (e) {
    err = e.message;
  }
  console.log(`${mode.padEnd(5)} sentences spoken: ${n}${err ? ` (stopped: ${err.slice(0, 60)})` : ' (complete)'}; limit fired: ${limit.aborted}`);
}
