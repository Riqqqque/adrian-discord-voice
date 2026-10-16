// Time-to-first-token survey across models on one OpenAI-compatible
// endpoint. Usage: node bench/ttft-survey.mjs <bot.json> <runs> <model> [model...]
// Env EXTRA='{"reasoning_effort":"none"}' adds body fields.

import { OpenAiCompatibleLlm } from '../dist/brain/openai-compatible.js';
import { loadConfig, readSecrets } from '../dist/config.js';

const [cfgPath, runsArg, ...models] = process.argv.slice(2);
const cfg = loadConfig(cfgPath);
const key = readSecrets(cfg.secretsFile).get(cfg.brain.apiKeySecret);
const extra = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : undefined;
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];

for (const model of models) {
  const llm = new OpenAiCompatibleLlm({ baseUrl: cfg.brain.baseUrl, model, apiKey: key, ...(extra ? { extraBody: extra } : {}) });
  const t = [];
  let errors = 0;
  for (let i = 0; i < Number(runsArg); i++) {
    const t0 = performance.now();
    try {
      for await (const ev of llm.stream(
        [{ role: 'system', content: 'Answer in one short sentence.' }, { role: 'user', content: `What is ${i + 2} plus ${i + 3}?` }],
        { maxTokens: 40, signal: AbortSignal.timeout(30_000) },
      )) {
        if (ev.type === 'text') {
          t.push(Math.round(performance.now() - t0));
          break;
        }
      }
    } catch (e) {
      errors++;
      if (errors === 1) console.log(`  ${model}: ${String(e.message).slice(0, 160)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(JSON.stringify({ model, extra: extra ?? null, n: t.length, errors, p50: pct(t, 50), p90: pct(t, 90), min: Math.min(...t), max: Math.max(...t), all: t }));
}
