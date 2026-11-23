// "Fill in my name on the form I sent": does the model use the document tool
// the right way (look at the fields before filling, use only values given,
// read before answering questions), and leave it alone for other talk? Real
// model and real PDF work; the writing model, DMs and the PC are stubs.
//   node bench/document-orders.mjs <bot.json>
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { documentTool, DocumentStore } from '../dist/features/documents.js';
import { runOp } from '../dist/features/documents-ops.js';
import { WritingStore } from '../dist/features/writing.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const ME = '100000000000000001';

async function permit() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('City parking permit application', { x: 72, y: 720, size: 14, font });
  page.drawText('Fee: $120.00 per year. Pets are not covered by this permit.', { x: 72, y: 690, size: 11, font });
  const form = doc.getForm();
  form.createTextField('applicant_name').addToPage(page, { x: 72, y: 600, width: 220, height: 20 });
  form.createTextField('date_signed').addToPage(page, { x: 72, y: 570, width: 120, height: 20 });
  form.createTextField('plate_number').addToPage(page, { x: 72, y: 540, width: 120, height: 20 });
  return doc.save();
}
const PDF = await permit();

const calls = [];
const fresh = async () => {
  const store = new DocumentStore();
  store.add(ME, 'permit.pdf', 'pdf', PDF, { pages: 1, fields: 3 });
  const real = documentTool({
    store,
    run: runOp,
    writer: () => ({ llm: { model: 'stub', async *stream() { yield { type: 'text', delta: '{"summary":"Shorter.","text":"Short."}' }; } }, maxTokens: 100, spend: () => {} }),
    drafts: new WritingStore(),
    tell: async () => {},
    sendFile: async () => 'https://cdn.discordapp.com/attachments/1/2/f',
    openOnPc: async () => undefined,
  });
  const tool = { ...real, run: async (args, signal, ctx) => (calls.push({ name: 'document', args }), real.run(args, signal, ctx)) };
  return new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), [tool], {
    spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3, stablePrefix: true,
    context: () => ['Reply in English.', 'Morgan has sent you documents before; their newest is "permit.pdf" (PDF, 1 page, a form with 3 fields).'],
  });
};

let ok = 0;
let total = 0;
async function ask(text, check) {
  calls.length = 0;
  let out = '';
  const o = await fresh();
  for await (const ch of o.ask(ME, 'Morgan', text, AbortSignal.timeout(40000), undefined, {}, { text: true })) out += (out ? ' ' : '') + ch;
  const pass = check(calls, out);
  total++;
  if (pass) ok++;
  console.log(`${pass ? 'ok ' : 'BAD'} "${text}"\n    tools: ${calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ') || '-'}\n    says: ${out.slice(0, 220).replace(/\n/g, ' ')}`);
}
const did = (cs, pred) => cs.some((k) => pred(k.args));
const none = (cs) => !cs.length;

await ask('what does the permit say about pets', (cs, out) => did(cs, (x) => x.action === 'read') && /not covered|aren't covered|doesn't cover|no pets|not included/i.test(out));
await ask('summarize the pdf I sent you', (cs) => did(cs, (x) => x.action === 'read'));
await ask('fill in the form: my name is Jane Example and my plate is ABC1234', (cs) => did(cs, (x) => x.action === 'fill' && JSON.stringify(x.values ?? {}).includes('Jane Example') && JSON.stringify(x.values ?? {}).includes('ABC1234') && !JSON.stringify(x.values ?? {}).match(/date_signed/)));
await ask('change the fee from $120.00 to $95.00 in that pdf', (cs) => did(cs, (x) => x.action === 'replace' && /120/.test(x.find ?? '') && /95/.test(x.replace ?? '')));
await ask('turn the permit into a word document', (cs) => did(cs, (x) => x.action === 'convert' && x.format === 'docx'));
await ask('open the permit on my pc', (cs) => did(cs, (x) => x.action === 'open_on_pc'));
await ask('add "Signed electronically" at the bottom of page one', (cs) => did(cs, (x) => x.action === 'add_text' && /signed electronically/i.test(x.text ?? '')));
await ask('what fields does the form have', (cs, out) => did(cs, (x) => x.action === 'fields' || x.action === 'read') && /plate/i.test(out));
// Not about her documents.
await ask('what is a pdf file anyway', none);
await ask('how do I renew my passport', none);

console.log(`\n${ok}/${total}`);
