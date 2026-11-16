// Calendar files expanded off the main thread. Walking a repeating event from
// its first day takes a step per occurrence (a daily event from 2015 is ~4,000),
// and a busy calendar took about half a second: longer than the music mixer's
// 160 ms lead, so a song playing in the call would skip while she read it.
import { parentPort } from 'node:worker_threads';
import { eventsBetween } from './calendar.js';

const port = parentPort!;
port.on('message', (m: { id: number; ics: string; from: number; to: number; name: string; tz: string }) => {
  try {
    port.postMessage({ id: m.id, events: eventsBetween(m.ics, m.from, m.to, m.name, m.tz) });
  } catch (e) {
    port.postMessage({ id: m.id, error: (e as Error).message.slice(0, 200) });
  }
});
