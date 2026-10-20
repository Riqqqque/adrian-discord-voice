// Text chat with channel context: does the model use the history, answer
// real follow-ups and stay SILENT for side talk?
//   node bench/text-followup.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { historyBlock } from '../dist/app/textchat.js';
import { loadConfig, readSecrets } from '../dist/config.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), [], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 400, maxToolRounds: 0,
});
const past = [];
let ok = 0;
let total = 0;
async function msg(uid, who, text, { direct = false, expect } = {}) {
  let out = '';
  let silent = false;
  if (direct || expect) {
    const extra = historyBlock(past.slice(-30));
    for await (const ch of o.ask(uid, who, text, AbortSignal.timeout(20000), undefined, { channelId: 'ch' }, { text: true, followUp: !direct, extra, onSilent: () => (silent = true) }))
      out += (out ? ' ' : '') + ch;
    const got = silent || !out ? 'silent' : 'answer';
    if (expect) {
      total++;
      if (got === expect) ok++;
    }
    console.log(`[${who}${direct ? ' @' : ''}] ${text}\n    -> ${got === 'silent' ? '(SILENT)' : out.slice(0, 220)}${expect && got !== expect ? `   <-- expected ${expect}` : ''}`);
  }
  past.push({ author: who, mine: false, text });
  if (out && !silent) past.push({ author: 'A.D.R.I.A.N.', mine: true, text: out });
}
await msg('s', 'Sam', 'yo who wants to run valorant tonight');
await msg('k', 'Kim', 'im down after 9');
await msg('s', 'Sam', 'bet, rique you in?');
await msg('r', 'Rique', 'what are they planning?', { direct: true, expect: 'answer' });
await msg('r', 'Rique', 'ok and what time did kim say', { expect: 'answer' });
// (A message that @mentions someone else never reaches the model.)
await msg('r', 'Rique', 'yeah im in', { expect: 'silent' });
await msg('r', 'Rique', 'lmaooo', { expect: 'silent' });
await msg('r', 'Rique', 'what agent should I play if we need a controller', { expect: 'answer' });
await msg('r', 'Rique', 'kim you playing sova again?', { expect: 'silent' });
await msg('k', 'Kim', 'adrian is lowkey smart', { expect: 'silent' });
await msg('k', 'Kim', 'adrian what rank is good for a duo queue', { expect: 'answer' });
console.log(`\n${ok}/${total} judged as expected`);
