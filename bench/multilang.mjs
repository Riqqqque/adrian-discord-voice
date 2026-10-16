// Multilingual round trip: speak a sentence per language, then transcribe
// it with Whisper (small and turbo) to compare accuracy, speed and the
// detected language. Run from the built app dir:
//   LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64 node bench/multilang.mjs <models dir> <out dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import sherpa from 'sherpa-onnx-node';
import { toWav } from '../dist/audio/wav.js';
import { KokoroTts } from '../dist/speech/kokoro.js';

const [M, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const kokoro = new KokoroTts({ modelDir: `${M}/kokoro-multi-lang-v1_0`, threads: 4 });
const vi = new sherpa.OfflineTts({
  model: {
    vits: {
      model: `${M}/vits-piper-vi_VN-vais1000-medium/vi_VN-vais1000-medium.onnx`,
      tokens: `${M}/vits-piper-vi_VN-vais1000-medium/tokens.txt`,
      dataDir: `${M}/vits-piper-vi_VN-vais1000-medium/espeak-ng-data`,
    },
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
  },
  maxNumSentences: 1,
});

function whisper(name) {
  const d = `${M}/sherpa-onnx-whisper-${name}`;
  return sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: `${d}/${name}-encoder.int8.onnx`, decoder: `${d}/${name}-decoder.int8.onnx`, language: '', task: 'transcribe', tailPaddings: -1 },
      tokens: `${d}/${name}-tokens.txt`,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  });
}

const cases = [
  ['en', 'af_heart', 'Hey Adrian, what is the weather like today?'],
  ['es', 'ef_dora', 'Hola Adrian, ¿qué tiempo hace hoy en Madrid?'],
  ['zh', 'zf_xiaobei', '你好，今天北京的天气怎么样？'],
  ['ja', 'jf_alpha', 'こんにちは、今日の東京の天気はどうですか？'],
  ['vi', 'piper', 'Xin chào, hôm nay thời tiết ở Hà Nội thế nào?'],
];

const clips = [];
for (const [lang, voice, text] of cases) {
  const t0 = performance.now();
  let samples, rate;
  try {
    if (voice === 'piper') {
      const a = vi.generate({ text, sid: 0, speed: 1 });
      samples = a.samples;
      rate = a.sampleRate;
    } else {
      const a = await kokoro.synthesize(text, { voice, speed: 1 });
      samples = a.samples;
      rate = a.sampleRate;
    }
  } catch (e) {
    console.log(JSON.stringify({ lang, voice, ttsError: e.message }));
    continue;
  }
  const synthMs = Math.round(performance.now() - t0);
  writeFileSync(`${out}/${lang}-${voice}.wav`, toWav(samples, rate));
  clips.push({ lang, voice, text, pcm: new sherpa.LinearResampler(rate, 16000).flush(samples), seconds: samples.length / rate, synthMs });
}

for (const name of ['small', 'turbo']) {
  const t0 = performance.now();
  const rec = await whisper(name);
  const loadMs = Math.round(performance.now() - t0);
  for (const c of clips) {
    const s = rec.createStream();
    s.acceptWaveform({ samples: c.pcm, sampleRate: 16000 });
    const t1 = performance.now();
    await rec.decodeAsync(s);
    const decodeMs = Math.round(performance.now() - t1);
    const r = rec.getResult(s);
    console.log(JSON.stringify({ model: name, loadMs, lang: c.lang, voice: c.voice, synthMs: c.synthMs, audioS: Number(c.seconds.toFixed(2)), decodeMs, detected: r.lang, said: c.text, heard: r.text.trim() }));
  }
}
console.log(JSON.stringify({ rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
