// Checks src/speech/smart-turn.ts against the reference Python (pipecat's own
// preprocessing): same clips (+0.8 s of silence), probabilities side by side.
//   node bench/turn-parity.mjs <model.onnx> <python results.json> <wav>...
import { readFileSync } from 'node:fs';
import { SmartTurn } from '../dist/speech/smart-turn.js';

const [model, pyFile, ...wavs] = process.argv.slice(2);
const py = JSON.parse(readFileSync(pyFile, 'utf8'));
const st = await SmartTurn.load(model);
const read = (f) => {
  const b = readFileSync(f);
  const n = (b.length - 44) / 2;
  const out = new Float32Array(n + 12_800);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(44 + i * 2) / 32768;
  return out;
};
let worst = 0, flips = 0, ms = [];
for (const f of wavs) {
  const t0 = performance.now();
  const p = await st.complete(read(f));
  ms.push(performance.now() - t0);
  const d = Math.abs(p - py[f]);
  worst = Math.max(worst, d);
  if (p > 0.5 !== py[f] > 0.5) flips++;
  if (d > 0.03) console.log(f, p.toFixed(3), py[f].toFixed(3));
}
ms.sort((a, b) => a - b);
console.log(`clips ${wavs.length}, largest difference ${worst.toFixed(4)}, decisions that differ ${flips}, TS time p50 ${ms[ms.length >> 1].toFixed(0)} ms (features + model)`);
