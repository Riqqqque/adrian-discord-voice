// Writes exactly what the bot sends to Discord (Kokoro → calibrated gain →
// limiter → 48 kHz stereo s16) to a WAV per sentence, for an independent
// loudness/true-peak check with ffmpeg.
// Usage: node bench/level-check.mjs <kokoro_dir> <voice> <out_dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { KokoroTts } from '../dist/speech/kokoro.js';
import { toDiscordPcm } from '../dist/voice/speaker.js';

const [dir, voice, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const tts = new KokoroTts({ modelDir: dir, threads: 4 });
const lines = [
  'Hi, this is Adrian.',
  "It's about seventy two degrees right now, with clear skies all afternoon.",
  'Sorry, I could not get an answer just now.',
  'Yes?',
  'The capital of Australia is Canberra. A lot of people guess Sydney!',
];
lines.forEach(() => {});
let i = 0;
for (const text of lines) {
  const a = await tts.synthesize(text, { voice, speed: 1.0 });
  const pcm = toDiscordPcm(a.samples, a.sampleRate);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(48000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(`${out}/${i++}.wav`, Buffer.concat([h, pcm]));
}
console.log(`wrote ${lines.length} files`);
