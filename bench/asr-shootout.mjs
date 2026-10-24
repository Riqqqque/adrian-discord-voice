// Speech-to-text shootout: runs one model over the corpus from asr-corpus.mjs
// and writes results/<model>.jsonl ({id, hyp, ms}).
//   LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64 node bench/asr-shootout.mjs <bench dir> <model> [bot.json]
// Models: see MODELS below; groq-* need bot.json for the key.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';

const [BENCH, name, cfgPath] = process.argv.slice(2);
const L = `${process.env.HOME}/adrian-dev/models`;
const B = `${BENCH}/models`;
const THREADS = 4; // what the bot uses
// The same word list the bot gives Whisper (names and apps people say at a PC).
const VOCAB = 'Hey Adrian, Rique. Spotify, Discord, Valorant, Steam, Chrome, YouTube, Netflix, Modrinth, CurseForge, Minecraft, Fabric, Forge, OBS, FL Studio.';
const HOTWORDS = 'Adrian,Rique,Spotify,Discord,Valorant,Steam,Chrome,YouTube,Netflix,Modrinth,CurseForge,Minecraft,Fabric,Forge,OBS,FL Studio';

const transducer = (dir, files = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx']) => ({
  transducer: { encoder: `${dir}/${files[0]}`, decoder: `${dir}/${files[1]}`, joiner: `${dir}/${files[2]}` },
  tokens: `${dir}/tokens.txt`,
  modelType: 'nemo_transducer',
});
const MODELS = {
  'parakeet-v3': () => transducer(`${L}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`),
  'parakeet-v2': () => transducer(`${L}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`),
  'parakeet-unified': () => transducer(`${B}/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming`),
  'parakeet-110m': () => transducer(`${B}/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8`),
  'canary-180m': () => ({
    canary: {
      encoder: `${B}/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/encoder.int8.onnx`,
      decoder: `${B}/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/decoder.int8.onnx`,
      srcLang: 'en', tgtLang: 'en', usePnc: 1,
    },
    tokens: `${B}/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/tokens.txt`,
  }),
  'moonshine-base': () => ({
    moonshine: { encoder: `${B}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27/encoder_model.ort`, mergedDecoder: `${B}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27/decoder_model_merged.ort` },
    tokens: `${B}/sherpa-onnx-moonshine-base-en-quantized-2026-02-27/tokens.txt`,
  }),
  'sensevoice': () => ({
    senseVoice: { model: `${B}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/model.int8.onnx`, language: 'en', useInverseTextNormalization: 1 },
    tokens: `${B}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/tokens.txt`,
  }),
  'sensevoice-nano': () => ({
    senseVoice: { model: `${B}/sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17/model.int8.onnx`, language: 'en', useInverseTextNormalization: 1 },
    tokens: `${B}/sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17/tokens.txt`,
  }),
  'qwen3-asr': () => ({
    qwen3Asr: {
      convFrontend: `${B}/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/conv_frontend.onnx`,
      encoder: `${B}/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/encoder.int8.onnx`,
      decoder: `${B}/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/decoder.int8.onnx`,
      tokenizer: `${B}/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/tokenizer`,
      hotwords: HOTWORDS,
    },
    tokens: '',
  }),
  'whisper-small': () => ({
    whisper: { encoder: `${L}/sherpa-onnx-whisper-small/small-encoder.int8.onnx`, decoder: `${L}/sherpa-onnx-whisper-small/small-decoder.int8.onnx`, language: 'en', task: 'transcribe' },
    tokens: `${L}/sherpa-onnx-whisper-small/small-tokens.txt`,
  }),
  'whisper-turbo-local': () => ({
    whisper: { encoder: `${L}/sherpa-onnx-whisper-turbo/turbo-encoder.int8.onnx`, decoder: `${L}/sherpa-onnx-whisper-turbo/turbo-decoder.int8.onnx`, language: 'en', task: 'transcribe' },
    tokens: `${L}/sherpa-onnx-whisper-turbo/turbo-tokens.txt`,
  }),
  'distil-large-v3.5': () => ({
    whisper: { encoder: `${B}/sherpa-onnx-whisper-distil-large-v3.5/distil-large-v3.5-encoder.int8.onnx`, decoder: `${B}/sherpa-onnx-whisper-distil-large-v3.5/distil-large-v3.5-decoder.int8.onnx`, language: 'en', task: 'transcribe' },
    tokens: `${B}/sherpa-onnx-whisper-distil-large-v3.5/distil-large-v3.5-tokens.txt`,
  }),
};

function readWav(file) {
  const b = readFileSync(file);
  const n = (b.length - 44) / 2;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = b.readInt16LE(44 + i * 2) / 32768;
  return f;
}
function wavBytes(file) {
  return readFileSync(file);
}

const refs = readFileSync(`${BENCH}/corpus/refs.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
mkdirSync(`${BENCH}/results`, { recursive: true });
const out = `${BENCH}/results/${name}.jsonl`;
const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);

let transcribe;
let before = async () => {};
if (name.startsWith('groq-')) {
  const { loadConfig, readSecrets } = await import('../dist/config.js');
  const key = readSecrets(loadConfig(cfgPath).secretsFile).get('GROQ_API_KEY');
  const model = { 'groq-turbo': 'whisper-large-v3-turbo', 'groq-v3': 'whisper-large-v3' }[name];
  let next = 0;
  // Free tier: about 20 a minute. The wait isn't counted in the clip's time.
  before = async () => {
    const wait = next - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    next = Date.now() + 3100;
  };
  transcribe = async (r) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const form = new FormData();
      form.append('file', new Blob([wavBytes(join(BENCH, 'corpus', r.file))], { type: 'audio/wav' }), 'a.wav');
      form.append('model', model);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      form.append('language', 'en');
      form.append('prompt', VOCAB);
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
      if (res.status === 429) {
        await new Promise((x) => setTimeout(x, 20_000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).text ?? '';
    }
    throw new Error('rate limited');
  };
} else {
  // `<model>-hot[-score]`: beam search biased toward the words in hotwords.txt (asr-hotwords.py).
  const hot = /^(.*)-hot(?:-([\d.]+))?$/.exec(name);
  const base = hot ? hot[1] : name;
  const phrases = hot ? readFileSync(`${BENCH}/hotwords.txt`, 'utf8').trim().split('\n').map((l) => `${l} :${hot[2] ?? '1.5'}`).join('/') : undefined;
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...MODELS[base](), numThreads: THREADS, provider: 'cpu', debug: 0 },
    decodingMethod: hot ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths: 4,
  });
  transcribe = async (r) => {
    const s = rec.createStream(phrases);
    s.acceptWaveform({ sampleRate: 16000, samples: readWav(join(BENCH, 'corpus', r.file)) });
    rec.decode(s);
    return rec.getResult(s).text ?? '';
  };
}

let k = 0;
for (const r of refs) {
  if (done.has(r.id)) continue;
  await before();
  const t0 = performance.now();
  let hyp;
  try {
    hyp = await transcribe(r);
  } catch (e) {
    hyp = `<<error ${e.message}>>`;
  }
  appendFileSync(out, JSON.stringify({ id: r.id, hyp: hyp.trim(), ms: Math.round(performance.now() - t0) }) + '\n');
  if (++k % 50 === 0) console.log(name, k);
}
console.log(name, 'done', k);
