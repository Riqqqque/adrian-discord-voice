// Time to the first audio: real Claude answer + real Sabrina (Speechify),
// first chunk = whole sentence vs first clause (comma) once 30+ chars.
//   node bench/first-audio.mjs <bot.json>
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { CharBudget, SpeechifyTts } from '../dist/speech/speechify.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });
const quiet = { info() {}, warn: console.log };
const tts = new SpeechifyTts({ apiKey: s.get('SPEECHIFY_API_KEY'), voiceId: 'sabrina', model: 'simba-3.2', timeoutMs: 6000, budget: new CharBudget(undefined, 0, 'UTC'), log: quiet }, { synthesize: async () => { throw new Error('fallback'); } }, 'af_heart');
await tts.synthesize('Okay, warming up the voice.', { voice: 'cloud:en', speed: 1 }); // calibration
const qs = [
  'why do cats purr?',
  'what makes a good gaming mouse?',
  'how does a microwave heat food?',
  'is it better to rent or buy a house, short answer',
  'why is the ocean salty?',
  'what should I eat before the gym?',
];
const res = { whole: [], clause: [] };
for (const q of qs) {
  for (const mode of ['whole', 'clause']) {
    const o = new ConversationOrchestrator(llm, new SessionMemory(2, 60_000), [], {
      spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 400, maxToolRounds: 0,
      ...(mode === 'clause' ? { splitter: { maxChunkChars: 220, firstChunkMinChars: 30 } } : {}),
    });
    const t0 = performance.now();
    let first;
    for await (const ch of o.ask(`u-${mode}-${q}`, 'Sean', q, AbortSignal.timeout(20000))) {
      if (first !== undefined) continue;
      first = ch;
      const textMs = performance.now() - t0;
      const a = await tts.synthesize(ch, { voice: 'cloud:en', speed: 1 });
      const audioMs = performance.now() - t0;
      res[mode].push(audioMs);
      console.log(`${mode.padEnd(6)} text ${Math.round(textMs)} ms + voice ${a.synthMs} ms = first audio ${Math.round(audioMs)} ms  (${ch.length} chars: ${ch.slice(0, 50)})`);
    }
  }
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`\nmedian first audio: whole sentence ${Math.round(med(res.whole))} ms, first clause ${Math.round(med(res.clause))} ms`);
