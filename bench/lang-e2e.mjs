// End to end per language, the way the live bot handles it: Parakeet hears
// the wake → English check → Whisper second pass → model reply with the
// language rule → that language's voice. Prints timings and the reply.
//   LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64 node bench/lang-e2e.mjs <bot.json> <models dir> <out dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import sherpa from 'sherpa-onnx-node';
import { toWav } from '../dist/audio/wav.js';
import { integratedLoudness, peakDbfs } from '../dist/audio/loudness.js';
import { OpenAiCompatibleLlm } from '../dist/brain/openai-compatible.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { KokoroTts } from '../dist/speech/kokoro.js';
import { EnglishWords, LANGS, looksSpanish, replyLang, stripWakeLead } from '../dist/speech/language.js';
import { PiperTts, VoiceRouter } from '../dist/speech/piper.js';
import { ParakeetStt } from '../dist/speech/sherpa.js';
import { WhisperStt } from '../dist/speech/whisper.js';
import { TextWakeDetector } from '../dist/wake/text-wake.js';

const [cfgFile, M, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const c = loadConfig(cfgFile);
const s = readSecrets(c.secretsFile);
const kokoro = new KokoroTts({ modelDir: `${M}/kokoro-multi-lang-v1_0`, threads: 4 });
const piper = new PiperTts({ modelDir: `${M}/vits-piper-vi_VN-vais1000-medium`, modelFile: 'vi_VN-vais1000-medium.onnx', threads: 4 });
const tts = new VoiceRouter(kokoro, { vi_piper: piper });
const parakeet = await ParakeetStt.load({ modelDir: `${M}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, threads: 4 });
const whisper = await WhisperStt.load({ modelDir: `${M}/sherpa-onnx-whisper-small`, threads: 4 });
const english = new EnglishWords(`${M}/kokoro-multi-lang-v1_0/lexicon-us-en.txt`);
const wake = new TextWakeDetector();
const llm = new OpenAiCompatibleLlm({ baseUrl: c.brain.baseUrl, model: c.brain.model, apiKey: s.get(c.brain.apiKeySecret), extraBody: { reasoning_effort: 'medium', include_reasoning: false } });
let lang = 'en';
const orch = new ConversationOrchestrator(llm, new SessionMemory(), [], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 8000, maxTokens: 500, maxToolRounds: 0,
  context: () => (LANGS[lang].prompt ? [LANGS[lang].prompt] : []),
});

// The "person" asking, in each language.
const asks = [
  ['en', 'af_bella', 'Hey Adrian, what is the tallest mountain in the world?'],
  ['es', 'em_alex', 'Hola Adrian, ¿cuál es la montaña más alta del mundo?'],
  ['zh', 'zm_yunxi', '嘿 Adrian，世界上最高的山是什么？'],
  ['ja', 'jm_kumo', 'せかいで いちばん たかい やまは なんですか？', 'followup'],
  ['vi', 'vi_piper', 'Ngọn núi cao nhất thế giới là gì?', 'followup'],
];

for (const [want, askVoice, question, mode] of asks) {
  const q = await tts.synthesize(question, { voice: askVoice, speed: 1 });
  const pcm = new sherpa.LinearResampler(q.sampleRate, 16000).flush(q.samples);
  const p = await parakeet.transcribe(pcm, 16000);
  // followup: they said "Hey Adrian", heard "Yes?", then asked: the whole clip is the question.
  let m = mode === 'followup' ? { woke: true, remainder: p.text, loose: false } : wake.matchLoose(p.text);
  let text = m.remainder;
  let secondMs = 0;
  lang = 'en';
  if (looksSpanish(text)) lang = 'es';
  else if (!english.looksEnglish(m.woke ? m.remainder : p.text)) {
    const w = await whisper.transcribe(pcm);
    secondMs = w.decodeMs;
    lang = replyLang(w.lang);
    const m2 = wake.matchLoose(w.text);
    text = m2.woke ? m2.remainder : mode === 'followup' ? w.text : stripWakeLead(w.text);
  }
  // Warm the reply voice first (the live bot does this at startup).
  await tts.synthesize('Okay.', { voice: LANGS[lang].voice, speed: 1 }).catch(() => {});
  const t0 = performance.now();
  let reply = '';
  for await (const ch of orch.ask('u-' + want, 'Sean', text, AbortSignal.timeout(15000))) reply += (reply ? ' ' : '') + ch;
  const llmMs = Math.round(performance.now() - t0);
  const voice = LANGS[lang].voice;
  const parts = [];
  let firstSynth;
  for (const sentence of reply.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [reply]) {
    const t1 = performance.now();
    const a = await tts.synthesize(sentence.trim(), { voice, speed: 1 });
    firstSynth ??= Math.round(performance.now() - t1);
    parts.push(a);
  }
  const rate = parts[0].sampleRate;
  const all = new Float32Array(parts.reduce((n, x) => n + x.samples.length, 0));
  let off = 0;
  for (const x of parts) {
    all.set(x.samples, off);
    off += x.samples.length;
  }
  writeFileSync(`${out}/reply-${want}.wav`, toWav(all, rate));
  console.log(JSON.stringify({
    want, parakeetHeard: p.text, woke: m.woke, secondPassMs: secondMs, detected: lang, question: text, llmMs, voice, firstSentenceSynthMs: firstSynth,
    lufsMono: Number(integratedLoudness(all, rate).toFixed(1)), peakDb: Number(peakDbfs(all).toFixed(1)), reply: reply.slice(0, 160),
  }));
  await new Promise((r) => setTimeout(r, 5000));
}
