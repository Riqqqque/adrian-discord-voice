// PC follow-ups (said without the name after an answer): real follow-ups get
// answered, sound from a show or game stays SILENT.
//   node bench/desk-followup.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), [], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 300, maxToolRounds: 0,
});
let ok = 0;
let total = 0;
async function say(text, { followUp = true, expect } = {}) {
  let out = '';
  let silent = false;
  for await (const ch of o.ask('u1', 'Rique', text, AbortSignal.timeout(20000), undefined, { channelId: 'sat:x' }, { followUp, desk: true, onSilent: () => (silent = true) }))
    out += (out ? ' ' : '') + ch;
  const got = silent || !out ? 'silent' : 'answer';
  if (expect) {
    total++;
    if (got === expect) ok++;
  }
  console.log(`${followUp ? '  ' : '@ '}${text}\n    -> ${got === 'silent' ? '(SILENT)' : out.slice(0, 160)}${expect && got !== expect ? '   <-- expected ' + expect : ''}`);
}
await say('what should I make for dinner tonight', { followUp: false });
await say("I don't really have chicken though", { expect: 'answer' });
await say('hmm what about pasta', { expect: 'answer' });
await say('okay how long do I boil it', { expect: 'answer' });
await say("Jack, I told you, we have to leave before the storm hits. Get in the car!", { expect: 'silent' });
await say('yeah one sec mom I am on the phone', { expect: 'silent' });
await say('wait what did you say about the sauce', { expect: 'answer' });
await say('enemy behind you, he is one shot', { expect: 'silent' });
await say('thanks that helps', { expect: 'answer' });
console.log(`\n${ok}/${total} as expected`);
