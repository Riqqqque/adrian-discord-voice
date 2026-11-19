// Render every built-in alarm tone (20 s each, with its gap and the fade-in an
// alarm uses) to WAV, to listen to and to measure.
// node bench/alarm-tones.mjs <out folder>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ringStream, TONES, tonePattern } from '../dist/features/alarm-tones.js';

const GAPS = { classic: 0.6, digital: 0.35, chime: 1.0, bells: 0.9, marimba: 0.8, gentle: 0.4, birds: 1.4, pulse: 0.5, buzzer: 0.45 };
const out = process.argv[2] ?? 'alarm-tones';
mkdirSync(out, { recursive: true });
for (const t of TONES) {
  const chunks = [];
  for await (const c of ringStream({ pattern: tonePattern(t.name), gap: GAPS[t.name], fadeIn: 10, startLevel: 0.3, seconds: 20 })) chunks.push(c);
  const pcm = Buffer.concat(chunks);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48_000, 24);
  h.writeUInt32LE(48_000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(join(out, `${t.name}.wav`), Buffer.concat([h, pcm]));
}
console.log(`wrote ${TONES.length} tones to ${out}`);
