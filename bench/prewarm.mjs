// Cache warm-up on the real API: the first answer after a quiet spell, with
// the warmer off (cold) and with `prewarm()` fired `lead` ms before the
// question reaches the model, through the production prompt (prod-kit) and
// the real orchestrator + CacheWarmer path. Every sample adds its own marker
// to the first tool's description, so its prefix has never been cached.
//   node bench/prewarm.mjs <bot.json> [rounds] [out.json]
// Arms (ARMS=...): cold, lead<N> (warm-up N ms ahead), mix (the lead drawn from
// production's cloud-listen times), false (a warm-up no question follows).
// GAP_MS (default 6000) between samples lets idle HTTP connections close.
import { writeFileSync } from 'node:fs';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { CacheWarmer } from '../dist/brain/prewarm.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const rounds = Number(process.argv[3] ?? 10);
const outFile = process.argv[4] ?? 'prewarm.json';
const ARMS = (process.env.ARMS ?? 'cold,lead300,lead500,lead700,lead1500,mix,false').split(',');
const GAP = Number(process.env.GAP_MS ?? 6000);
const QUESTION = process.env.Q ?? 'how far away is the moon';
// Cloud-listen (Groq) wait on woken answers, ms, from the live bot's `answered` lines (2026-11-03 to 11-20).
const PROD_LEADS = [313, 364, 543, 343, 626, 585, 1067, 350, 523, 417, 680, 866, 376, 558, 505, 1626, 411, 657, 348, 780, 507, 389, 449, 756];
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: readSecrets(c.secretsFile).get('ANTHROPIC_API_KEY'), effort: 'low' });
const IN = 0.1 / 1e6;
const OUT = 0.5 / 1e6;
const price = (u) => (u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * IN + u.cachedTokens * IN * 0.1 + u.cacheWriteTokens * IN * 1.25 + u.outputTokens * OUT;

let firstText;
const stream = AnthropicLlm.prototype.stream;
AnthropicLlm.prototype.stream = async function* (messages, opts) {
  const t0 = performance.now();
  for await (const ev of stream.call(this, messages, opts)) {
    if (ev.type === 'text' && firstText === undefined && ev.delta.trim()) firstText = performance.now() - t0;
    yield ev;
  }
};
const warmUsage = [];
const warmer = new CacheWarmer(llm, { enabled: true, maxPerHour: 1_000, onUsage: (u) => warmUsage.push(u) });
const off = new CacheWarmer(llm, { enabled: false, maxPerHour: 1_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
for (let r = 0; r < rounds; r++) {
  for (const arm of ARMS) {
    const kit = prodKit(c, { pc: 'absent' });
    const marker = `[cw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}]`;
    kit.tools[0] = { ...kit.tools[0], spec: { ...kit.tools[0].spec, description: `${kit.tools[0].spec.description} ${marker}` } };
    const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), kit.tools, { ...kit.options, warmer: arm === 'cold' ? off : warmer });
    const lead = arm === 'mix' ? PROD_LEADS[(r * 7 + 3) % PROD_LEADS.length] : arm.startsWith('lead') ? Number(arm.slice(4)) : 0;
    const rec = { arm, round: r, lead };
    warmUsage.length = 0;
    try {
      rec.prewarm = o.prewarm('heard');
      if (arm === 'false') {
        await until(() => warmUsage.length > 0, 10_000);
      } else {
        await sleep(lead);
        firstText = undefined;
        let usage;
        const t0 = performance.now();
        for await (const ch of o.ask(`u${r}-${arm}`, 'Sam', QUESTION, AbortSignal.timeout(30_000), (u) => (usage = u), { channelId: 'call', guildId: 'g' })) {
          rec.firstChunk ??= performance.now() - t0;
          rec.said = (rec.said ? `${rec.said} ` : '') + ch;
        }
        rec.firstText = firstText;
        rec.answer = usage;
        await until(() => rec.prewarm !== 'sent' || warmUsage.length > 0, 10_000);
      }
    } catch (e) {
      rec.error = String(e.message).slice(0, 200);
    }
    rec.warm = warmUsage[0];
    rec.cost = (rec.answer ? price(rec.answer) : 0) + (rec.warm ? price(rec.warm) : 0);
    results.push(rec);
    console.log(JSON.stringify({ arm, r, lead, prewarm: rec.prewarm, firstText: rec.firstText && Math.round(rec.firstText), firstChunk: rec.firstChunk && Math.round(rec.firstChunk), read: rec.answer?.cachedTokens, wrote: rec.answer?.cacheWriteTokens, warmWrote: rec.warm?.cacheWriteTokens, cost: +rec.cost.toFixed(6), err: rec.error }));
    writeFileSync(outFile, JSON.stringify(results, null, 1));
    await sleep(GAP);
  }
}

async function until(ok, ms) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(20);
}

// Summary per arm: first text and first chunk median / p90, cost per sample.
const q = (a, p) => {
  const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]) : '-';
};
for (const arm of ARMS) {
  const rs = results.filter((x) => x.arm === arm && !x.error);
  const cost = rs.reduce((s, x) => s + x.cost, 0) / Math.max(1, rs.length);
  const reads = rs.filter((x) => (x.answer?.cachedTokens ?? 0) > 5_000).length;
  console.log(`${arm.padEnd(9)} n=${rs.length} firstText ${q(rs.map((x) => x.firstText), 0.5)}/${q(rs.map((x) => x.firstText), 0.9)} firstChunk ${q(rs.map((x) => x.firstChunk), 0.5)}/${q(rs.map((x) => x.firstChunk), 0.9)} read ${reads}/${rs.length} $${cost.toFixed(5)}`);
}
