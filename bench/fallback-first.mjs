// Time to the first audio of the first sentence that has to fall back to the
// local voice after a start, with the cloud voice primary (Kokoro not loaded).
// Speechify is faked: it answers 503 at once, or never answers (timeout).
// Real Kokoro, through the real Speaker. Run each case in a fresh process.
//   node bench/fallback-first.mjs <dist> <kokoro dir> <503|timeout> [--gains file] [--json out]
//   --gains: the state file for kept calibration (builds that support it).
// Uses no Speechify characters.
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const [distArg, kokoroDir, mode] = args;
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const gainFile = opt('--gains');
const jsonOut = opt('--json');
const gainState = gainFile ? (existsSync(gainFile) ? 'kept' : 'first start') : 'none';
const dist = pathToFileURL(resolve(distArg)).href;
const { KokoroTts } = await import(`${dist}/speech/kokoro.js`);
const { CharBudget, SpeechifyTts } = await import(`${dist}/speech/speechify.js`);
const { Speaker } = await import(`${dist}/voice/speaker.js`);
const { prepareLocalVoice } = await import(`${dist}/app/local-voice.js`);

const lines = [];
const log = { info: (m, f) => lines.push({ t: Math.round(performance.now()), m, ...(f ?? {}) }), warn: (m, f) => lines.push({ t: Math.round(performance.now()), m, ...(f ?? {}) }), error: (m, f) => lines.push({ m, ...(f ?? {}) }) };
const kokoro = new KokoroTts({ modelDir: kokoroDir, threads: 4 });
await prepareLocalVoice(kokoro, { modelDir: kokoroDir, voice: 'af_heart', speed: 1, cloudPrimary: true, ...(gainFile ? { gainFile } : {}) }, log);

const fakeFetch = async (_url, init) => {
  if (mode === '503') return new Response('unavailable', { status: 503 });
  // Never answers: only the request's own timeout ends it.
  return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
};
const cloud = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.5', speed: 1, timeoutMs: 4000, budget: new CharBudget(undefined, 0, 'UTC'), log, fetch: fakeFetch }, kokoro, 'af_heart');

let openedAt = 0;
const transport = {
  playPcm(stream) {
    openedAt = performance.now();
    stream.resume();
    return { done: new Promise((r) => stream.on('end', () => r('finished'))), stop() {} };
  },
};
const speaker = new Speaker(transport, cloud);
async function* answer() {
  yield 'Sure, the capital of Australia is Canberra, not Sydney.';
  yield 'A lot of people get that one wrong.';
}
// AbortSignal.timeout doesn't keep the process alive on its own.
const keepAlive = setInterval(() => undefined, 1_000);
const rss0 = Math.round(process.memoryUsage().rss / 1e6);
const t0 = performance.now();
const r = await speaker.speak(answer(), { voice: 'cloud:en', speed: 1, volume: 1 }, AbortSignal.timeout(60_000));
const row = {
  mode,
  gains: gainState,
  firstAudioMs: r.firstAudioMs,
  openMs: Math.round(openedAt - t0),
  secondSentenceMs: r.synthMs[1],
  rssBeforeMb: rss0,
  rssAfterMb: Math.round(process.memoryUsage().rss / 1e6),
  log: lines.filter((l) => /local voice|cloud voice/.test(l.m)).map((l) => `${l.t - Math.round(t0)}ms ${l.m}`),
};
clearInterval(keepAlive);
console.log(JSON.stringify(row));
if (jsonOut) appendFileSync(jsonOut, `${JSON.stringify({ dist: distArg, ...row })}\n`);
process.exit(0);
