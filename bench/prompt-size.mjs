// How big is the cached prefix she sends on every call, and what is it made of?
// Counts with Claude's own token counter (free): the whole production prefix
// (tools + stable prompt, bench/prod-kit.mjs), then each tool and rule left out
// in turn, so every part shows its own share.
//   node bench/prompt-size.mjs <bot.json> [--each]
import Anthropic from '@anthropic-ai/sdk';
import { stablePrompt } from '../dist/brain/orchestrator.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { prodKit } from './prod-kit.mjs';

const c = loadConfig(process.argv[2]);
const client = new Anthropic({ apiKey: readSecrets(c.secretsFile).get('ANTHROPIC_API_KEY') });
const kit = prodKit(c);
const count = async (tools, system) =>
  (
    await client.messages.countTokens({
      model: 'claude-haiku-5-5',
      system,
      tools: tools.map((t) => ({ name: t.spec.name, description: t.spec.description, input_schema: t.spec.parameters })),
      messages: [{ role: 'user', content: 'hi' }],
    })
  ).input_tokens;
const system = stablePrompt(kit.options, kit.tools.map((t) => t.spec.name));
const all = await count(kit.tools, system);
const bare = await count([], 'x');
const noTools = await count([], system);
console.log(`tools ${kit.tools.length}; prefix ${all} tokens: stable prompt ${noTools - bare}, tool specs ${all - noTools}`);
if (process.argv.includes('--each')) {
  const rows = [];
  for (const t of kit.tools) rows.push([t.spec.name, all - (await count(kit.tools.filter((x) => x !== t), system))]);
  for (const line of kit.options.stableLines) rows.push([`rule: ${line.slice(0, 40)}`, all - (await count(kit.tools, stablePrompt({ ...kit.options, stableLines: kit.options.stableLines.filter((l) => l !== line) }, kit.tools.map((t) => t.spec.name))))]);
  rows.sort((a, b) => b[1] - a[1]);
  for (const [n, k] of rows) console.log(String(k).padStart(6), n);
}
