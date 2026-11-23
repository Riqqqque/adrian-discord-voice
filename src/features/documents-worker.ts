// One document operation off the main thread (documents-ops.ts): started per
// job and ended after it, so a file that eats memory or loops only takes this
// thread down, and the caller's time limit can stop it.
import { parentPort } from 'node:worker_threads';
import { type DocOp, DocError, runOp } from './documents-ops.js';

// Notices the libraries print that only say what isn't used: no canvas
// (pages are never drawn), no font data (text only), XFA (refused anyway).
const quiet = (out: (...a: unknown[]) => void) => (...a: unknown[]) => {
  if (typeof a[0] === 'string' && /@napi-rs\/canvas|standardFontDataUrl|Removing XFA|Cannot polyfill/.test(a[0])) return;
  out(...a);
};
console.warn = quiet(console.warn.bind(console));
console.log = quiet(console.log.bind(console));
const port = parentPort!;
port.once('message', async (o: DocOp) => {
  try {
    port.postMessage({ result: await runOp(o) });
  } catch (e) {
    port.postMessage({ error: (e as Error).message.slice(0, 300), known: e instanceof DocError });
  }
});
