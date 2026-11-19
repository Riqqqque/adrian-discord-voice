// Can "stop", "snooze" and "I'm up" be heard over a ringing alarm? Kokoro says
// each phrase, it's mixed with every built-in tone (the tone as loud as the
// voice, and 6 dB under), Parakeet listens as the live bot does, and ringWord
// decides. Each tone alone must give no alarm words at all.
//   LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64 node bench/alarm-words.mjs <models dir>
import sherpa from 'sherpa-onnx-node';
import { KokoroTts } from '../dist/speech/kokoro.js';
import { ParakeetStt } from '../dist/speech/sherpa.js';
import { TONES, tonePattern } from '../dist/features/alarm-tones.js';
import { ringWord } from '../dist/features/alarms.js';

const [M] = process.argv.slice(2);
const kokoro = new KokoroTts({ modelDir: `${M}/kokoro-multi-lang-v1_0`, threads: 4 });
const parakeet = await ParakeetStt.load({ modelDir: `${M}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, threads: 4 });

const phrases = [
  ['af_heart', 'stop', 'stop'],
  ['am_michael', 'stop the alarm', 'stop'],
  ['af_heart', 'turn it off', 'stop'],
  ['am_michael', "okay I'm up", 'up'],
  ['af_heart', 'snooze', 'snooze'],
  ['am_michael', 'five more minutes', 'snooze'],
  ['af_heart', 'snooze for ten minutes', 'snooze'],
];
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const to16k = (samples, rate) => new sherpa.LinearResampler(rate, 16000).flush(samples);

let ok = 0;
let total = 0;
let falses = 0;
const speech = [];
for (const [voice, text, want] of phrases) {
  const q = await kokoro.synthesize(text, { voice, speed: 1 });
  speech.push({ text, want, pcm: to16k(q.samples, q.sampleRate) });
}
for (const t of TONES) {
  const tone = to16k(tonePattern(t.name), 48_000);
  // Alone, looped for 4 s: nothing it rings may read as an order.
  const alone = new Float32Array(64_000).map((_, i) => tone[i % tone.length]);
  const heardAlone = (await parakeet.transcribe(alone, 16000)).text;
  if (ringWord(heardAlone)) falses++;
  const line = [`${t.name.padEnd(8)} alone: "${heardAlone}"`];
  for (const db of [0, -6]) {
    for (const s of speech) {
      // Half a second of tone first, the phrase over the rest.
      const n = s.pcm.length + 8000 + 4000;
      const k = (rms(s.pcm) / rms(tone)) * 10 ** (db / 20);
      const mix = new Float32Array(n);
      for (let i = 0; i < n; i++) mix[i] = tone[i % tone.length] * k + (i >= 8000 && i - 8000 < s.pcm.length ? s.pcm[i - 8000] : 0);
      const heard = (await parakeet.transcribe(mix, 16000)).text;
      const got = ringWord(heard)?.action;
      const pass = got === s.want;
      total++;
      if (pass) ok++;
      else line.push(`  ${db} dB "${s.text}" → "${heard}" (${got ?? 'nothing'})`);
    }
  }
  console.log(line.join('\n'));
}
console.log(`\n${ok}/${total} heard right over the tones; tones alone read as an order: ${falses}/${TONES.length}`);
