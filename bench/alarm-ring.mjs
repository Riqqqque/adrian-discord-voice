// A real ring on the wall clock: the real mixer and ringIn for N seconds,
// written to a capturing player. Frames should keep pace with time (no gaps
// from the alarm source), and memory shouldn't grow.
//   node bench/alarm-ring.mjs [seconds]
import { Mixer, FRAME_BYTES } from '../dist/voice/mixer.js';
import { ringIn } from '../dist/app/alarm-ring.js';
import { DEFAULTS } from '../dist/features/alarms.js';

const secs = Number(process.argv[2] ?? 60);
let frames = 0;
let loud = 0;
const mixer = new Mixer({
  start: (s) => {
    s.on('data', (b) => {
      for (let o = 0; o + FRAME_BYTES <= b.length; o += FRAME_BYTES) {
        frames++;
        let peak = 0;
        for (let i = 0; i < FRAME_BYTES; i += 32) peak = Math.max(peak, Math.abs(b.readInt16LE(o + i)));
        if (peak > 300) loud++;
      }
    });
    return { done: new Promise(() => {}), stop() {} };
  },
});
const alarm = { id: 'a', userId: 'u', speaker: 'S', kind: 'alarm', label: 'gym', at: Date.now(), base: Date.now(), tz: 'UTC', enabled: true, ringingSince: Date.now() };
const said = [];
const h = ringIn({ key: 'discord', mixer }, { userId: 'u', alarms: () => [alarm], prefs: { ...DEFAULTS, fadeIn: 10 }, fresh: true, lateMs: 0 }, {
  soundOf: () => 'classic', clip: () => undefined, speak: async (_r, t) => said.push(t), name: () => 'Sean', log: () => {}, level: 0.7,
}, true);
global.gc?.();
const heap0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
await new Promise((r) => setTimeout(r, secs * 1000));
const elapsed = (performance.now() - t0) / 1000;
global.gc?.();
const heap1 = process.memoryUsage().heapUsed;
console.log(`alive ${h.alive()}, ${frames} frames in ${elapsed.toFixed(1)} s (expected ~${Math.round(elapsed * 50)}), ${Math.round((100 * loud) / frames)}% with sound, voice lines ${said.length} ("${said[0]}"), heap ${((heap1 - heap0) / 1e6).toFixed(2)} MB`);
h.stop();
await new Promise((r) => setTimeout(r, 300));
console.log(`after stop: alive ${h.alive()}, ringing ${mixer.alarmRinging}`);
process.exit(0);
