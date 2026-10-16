// Kokoro speed and memory on this machine.
// Usage: node bench/tts-speed.mjs <model_dir> <model_file> <threads> [sid]
// Needs LD_LIBRARY_PATH to include node_modules/sherpa-onnx-linux-x64.

import sherpa from 'sherpa-onnx-node';

const [dir, modelFile, threadsArg, sidArg] = process.argv.slice(2);
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);
const rss0 = rssMb();
const t0 = performance.now();
const tts = await sherpa.OfflineTts.createAsync({
  model: {
    kokoro: {
      model: `${dir}/${modelFile}`,
      voices: `${dir}/voices.bin`,
      tokens: `${dir}/tokens.txt`,
      dataDir: `${dir}/espeak-ng-data`,
      lexicon: `${dir}/lexicon-us-en.txt`,
      lang: 'en-us',
    },
    numThreads: Number(threadsArg),
    provider: 'cpu',
    debug: 0,
  },
  maxNumSentences: 1,
});
console.log(JSON.stringify({ model: modelFile, threads: Number(threadsArg), loadMs: Math.round(performance.now() - t0), rssBeforeMb: rss0, rssLoadedMb: rssMb() }));

const sentences = [
  "It's seventy two degrees right now.",
  'The capital of Australia is Canberra, not Sydney, which surprises a lot of people.',
  'Sure, I set a timer for ten minutes.',
];
for (const text of sentences) {
  for (let run = 0; run < 3; run++) {
    const s = performance.now();
    const a = await tts.generateAsync({ text, sid: Number(sidArg ?? 16), speed: 1.0 });
    const ms = performance.now() - s;
    const sec = a.samples.length / a.sampleRate;
    console.log(JSON.stringify({ chars: text.length, run, audioS: Number(sec.toFixed(2)), synthMs: Math.round(ms), rtf: Number((ms / 1000 / sec).toFixed(3)), sampleRate: a.sampleRate, rssMb: rssMb() }));
  }
}
