// Parakeet speed and memory on this machine.
// Usage: node bench/asr-speed.mjs <model_dir> <threads> <wav...>
// Needs LD_LIBRARY_PATH to include node_modules/sherpa-onnx-linux-x64.

import sherpa from 'sherpa-onnx-node';

const [modelDir, threadsArg, ...wavs] = process.argv.slice(2);
const threads = Number(threadsArg);
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

const rss0 = rssMb();
const t0 = performance.now();
const recognizer = await sherpa.OfflineRecognizer.createAsync({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: `${modelDir}/encoder.int8.onnx`,
      decoder: `${modelDir}/decoder.int8.onnx`,
      joiner: `${modelDir}/joiner.int8.onnx`,
    },
    tokens: `${modelDir}/tokens.txt`,
    numThreads: threads,
    provider: 'cpu',
    modelType: 'nemo_transducer',
    debug: 0,
  },
});
const loadMs = performance.now() - t0;
console.log(JSON.stringify({ threads, loadMs: Math.round(loadMs), rssBeforeMb: rss0, rssLoadedMb: rssMb() }));

for (const wav of wavs) {
  const w = sherpa.readWave(wav);
  const seconds = w.samples.length / w.sampleRate;
  for (let run = 0; run < 3; run++) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: w.samples, sampleRate: w.sampleRate });
    const s = performance.now();
    const r = await recognizer.decodeAsync(stream);
    const ms = performance.now() - s;
    console.log(JSON.stringify({
      file: wav.split('/').pop(), run, audioS: Number(seconds.toFixed(2)), decodeMs: Math.round(ms),
      rtf: Number((ms / 1000 / seconds).toFixed(3)), rssMb: rssMb(), text: r.text.slice(0, 80),
    }));
  }
}
