// Real Speechify latency and level check.
//   node bench/cloud-voice.mjs <secrets.env> [voice] [out.wav]
import { writeFileSync } from 'node:fs';
import { integratedLoudness } from '../dist/audio/loudness.js';
import { readSecrets } from '../dist/config.js';
import { CharBudget, SpeechifyTts } from '../dist/speech/speechify.js';

const [secretsFile, voiceId = 'sabrina', out] = process.argv.slice(2);
const key = readSecrets(secretsFile).get('SPEECHIFY_API_KEY');
const budget = new CharBudget(undefined, 0, 'UTC');
const local = { synthesize: async (t) => (console.log(`  FELL BACK to local voice: ${t}`), { samples: new Float32Array(2400), sampleRate: 24000, synthMs: -1 }) };
const tts = new SpeechifyTts({ apiKey: key, voiceId, model: 'simba-3.2', timeoutMs: 6000, budget, log: console }, local, 'af_heart');
const lines = [
  'Yes?',
  "Yeah, the Minecraft server's up right now.",
  "Three people are on, and it's been running for about six hours.",
  'Honestly? That play was kind of insane.',
  "Your timer's got two minutes left.",
  'Nah, that play was fucking terrible, bro. Absolute dogshit.',
  "It's 3:45 PM, 72°F, and the server on port 25566 has 12 players.",
];
const parts = [];
for (const l of lines) {
  const a = await tts.synthesize(l, { voice: 'cloud:en', speed: 1 });
  parts.push(a.samples);
  console.log(`${String(a.synthMs).padStart(5)} ms  ${(a.samples.length / a.sampleRate).toFixed(2)} s  ${l}`);
}
const again = await tts.synthesize('Yes?', { voice: 'cloud:en', speed: 1 });
console.log(`cached "Yes?": ${again.synthMs} ms`);
const fast = await tts.synthesize('Okay, a bit faster now.', { voice: 'cloud:en', speed: 1.1 });
console.log(`speed 1.1: ${fast.synthMs} ms, ${(fast.samples.length / 24000).toFixed(2)} s`);
const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
let o = 0;
for (const p of parts) (all.set(p, o), (o += p.length));
console.log(`level ${integratedLoudness(all, 24000).toFixed(1)} LUFS mono (target -19.0), chars ${budget.used()}`);
if (out) {
  const b = Buffer.alloc(44 + all.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + all.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(all.length * 2, 40);
  all.forEach((s, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2));
  writeFileSync(out, b);
}
