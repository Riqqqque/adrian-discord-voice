// Smart Turn off the main thread. Its features and onnxruntime's run() block
// for 50-250 ms on the server, on every segment the PC sends, and that is longer
// than the music mixer's 160 ms lead: songs at the PC skipped while anyone talked.
import { parentPort, workerData } from 'node:worker_threads';
import { SmartTurn } from './smart-turn.js';

const port = parentPort!;
const turn = await SmartTurn.loadHere((workerData as { modelPath: string }).modelPath);
port.on('message', (m: { id: number; samples: Float32Array }) => {
  turn.complete(m.samples).then(
    (p) => port.postMessage({ id: m.id, p }),
    (e: Error) => port.postMessage({ id: m.id, error: e.message }),
  );
});
port.postMessage({ ready: true });
