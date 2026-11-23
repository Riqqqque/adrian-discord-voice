// One document operation off the main thread (documents-ops.ts): started per
// job and ended after it, so a file that eats memory or loops only takes this
// thread down, and the caller's time limit can stop it.
import { parentPort } from 'node:worker_threads';
import { type DocOp, DocError, runOp } from './documents-ops.js';

const port = parentPort!;
port.once('message', async (o: DocOp) => {
  try {
    port.postMessage({ result: await runOp(o) });
  } catch (e) {
    port.postMessage({ error: (e as Error).message.slice(0, 300), known: e instanceof DocError });
  }
});
