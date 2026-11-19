// Built-in alarm sounds, made in code: nothing to download, nothing that can
// be missing when an alarm is due. Each one is a short pattern that repeats,
// rendered once per process at 48 kHz.

import { Readable } from 'node:stream';

export const TONE_RATE = 48_000;

export interface ToneInfo {
  name: string;
  /** For the list: "classic beeping, like a bedside clock". */
  about: string;
  /** Soft ones suit waking up slowly; harsh ones heavy sleepers. */
  feel: 'soft' | 'medium' | 'loud';
}

export const TONES: readonly ToneInfo[] = [
  { name: 'classic', about: 'classic beeping, like a bedside alarm clock', feel: 'medium' },
  { name: 'chime', about: 'a bright two-note chime', feel: 'soft' },
  { name: 'bells', about: 'ringing bells', feel: 'medium' },
  { name: 'marimba', about: 'a rising marimba tune', feel: 'soft' },
  { name: 'gentle', about: 'a soft swelling chord, for waking up slowly', feel: 'soft' },
  { name: 'birds', about: 'chirping birds', feel: 'soft' },
  { name: 'pulse', about: 'pulsing sonar pings', feel: 'medium' },
  { name: 'digital', about: 'fast digital beeps', feel: 'loud' },
  { name: 'buzzer', about: 'a harsh buzzer, for heavy sleepers', feel: 'loud' },
];

export const DEFAULT_TONE = 'classic';
export const DEFAULT_TIMER_TONE = 'chime';

export function isTone(name: string): boolean {
  return TONES.some((t) => t.name === name);
}

const TAU = Math.PI * 2;
const s = (sec: number) => Math.round(sec * TONE_RATE);

/** Adds a note into `buf` at `at` seconds. */
function note(
  buf: Float32Array,
  at: number,
  dur: number,
  freq: number,
  opts: { partials?: [number, number][]; attack?: number; decay?: number; gain?: number; release?: number; shape?: 'sine' | 'square' | 'saw' } = {},
): void {
  const start = s(at);
  const n = s(dur);
  const attack = s(opts.attack ?? 0.005);
  const release = s(opts.release ?? 0.01);
  const gain = opts.gain ?? 1;
  const partials = opts.partials ?? [[1, 1]];
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const t = i / TONE_RATE;
    let env = i < attack ? i / attack : 1;
    if (opts.decay) env *= Math.exp(-t / opts.decay);
    if (i > n - release) env *= Math.max(0, (n - i) / release);
    let v = 0;
    for (const [mult, amp] of partials) {
      const ph = TAU * freq * mult * t;
      if (opts.shape === 'square') {
        // A soft square: odd harmonics, rolled off so it doesn't hurt.
        v += amp * (Math.sin(ph) + Math.sin(3 * ph) / 3 + Math.sin(5 * ph) / 5 + Math.sin(7 * ph) / 7) * 0.8;
      } else if (opts.shape === 'saw') {
        let w = 0;
        for (let k = 1; k <= 12; k++) w += Math.sin(k * ph) / k;
        v += amp * w * 0.55;
      } else v += amp * Math.sin(ph);
    }
    buf[start + i]! += v * env * gain;
  }
}

/** Sweep from f0 to f1 (a chirp). */
function chirp(buf: Float32Array, at: number, dur: number, f0: number, f1: number, gain: number): void {
  const start = s(at);
  const n = s(dur);
  let ph = 0;
  for (let i = 0; i < n && start + i < buf.length; i++) {
    const x = i / n;
    const f = f0 + (f1 - f0) * x;
    ph += (TAU * f) / TONE_RATE;
    const env = Math.sin(Math.PI * x) ** 2;
    buf[start + i]! += Math.sin(ph) * env * gain;
  }
}

const NOTE = (semitonesFromA4: number) => 440 * 2 ** (semitonesFromA4 / 12);
const BELL: [number, number][] = [
  [1, 1],
  [2, 0.5],
  [2.76, 0.35],
  [5.4, 0.15],
];
const MARIMBA: [number, number][] = [
  [1, 1],
  [4, 0.25],
  [10, 0.05],
];

function render(name: string): Float32Array {
  switch (name) {
    case 'classic': {
      const b = new Float32Array(s(1.0));
      for (let k = 0; k < 4; k++) note(b, k * 0.125, 0.07, 1000, { shape: 'square', gain: 0.55, attack: 0.003, release: 0.006 });
      return b;
    }
    case 'digital': {
      const b = new Float32Array(s(0.5));
      note(b, 0, 0.06, 2000, { shape: 'square', gain: 0.5, attack: 0.002, release: 0.004 });
      note(b, 0.1, 0.06, 2000, { shape: 'square', gain: 0.5, attack: 0.002, release: 0.004 });
      return b;
    }
    case 'chime': {
      const b = new Float32Array(s(2.2));
      note(b, 0, 1.4, NOTE(7), { partials: BELL, decay: 0.45, gain: 0.6 }); // E5
      note(b, 0.35, 1.6, NOTE(3), { partials: BELL, decay: 0.55, gain: 0.6 }); // C5
      return b;
    }
    case 'bells': {
      const b = new Float32Array(s(2.4));
      [NOTE(10), NOTE(7), NOTE(3), NOTE(-2)].forEach((f, k) => note(b, k * 0.3, 1.8, f, { partials: BELL, decay: 0.6, gain: 0.5 }));
      return b;
    }
    case 'marimba': {
      const b = new Float32Array(s(2.0));
      [NOTE(3), NOTE(7), NOTE(10), NOTE(15), NOTE(10), NOTE(15)].forEach((f, k) => note(b, k * 0.16, 0.6, f, { partials: MARIMBA, decay: 0.18, gain: 0.75 }));
      return b;
    }
    case 'gentle': {
      const b = new Float32Array(s(4.0));
      for (const f of [NOTE(-9), NOTE(-5), NOTE(-2), NOTE(3)]) {
        // A slow swell in and out.
        const n = b.length;
        for (let i = 0; i < n; i++) {
          const t = i / TONE_RATE;
          const env = Math.sin((Math.PI * i) / n) ** 2;
          b[i]! += (Math.sin(TAU * f * t) + 0.2 * Math.sin(TAU * f * 2 * t)) * env * 0.22;
        }
      }
      return b;
    }
    case 'birds': {
      const b = new Float32Array(s(2.6));
      // A fixed little song: two calls, a trill, a pause.
      chirp(b, 0.0, 0.09, 3200, 4600, 0.5);
      chirp(b, 0.14, 0.09, 3300, 4800, 0.5);
      for (let k = 0; k < 6; k++) chirp(b, 0.5 + k * 0.06, 0.045, 4200, 3600, 0.4);
      chirp(b, 1.1, 0.16, 2800, 4000, 0.45);
      chirp(b, 1.3, 0.12, 4000, 3000, 0.45);
      return b;
    }
    case 'pulse': {
      const b = new Float32Array(s(1.6));
      [0, 0.4, 0.8].forEach((at, k) => note(b, at, 0.35, 1320 + k * 110, { partials: [[1, 1], [2, 0.15]], decay: 0.09, gain: 0.7 }));
      return b;
    }
    case 'buzzer': {
      const b = new Float32Array(s(1.0));
      note(b, 0, 0.42, 220, { shape: 'saw', gain: 0.6, attack: 0.004, release: 0.01 });
      note(b, 0.5, 0.42, 220, { shape: 'saw', gain: 0.6, attack: 0.004, release: 0.01 });
      return b;
    }
    default:
      return render(DEFAULT_TONE);
  }
}

/** Patterns, scaled so each peaks at the same level. */
const cache = new Map<string, Float32Array>();
const PEAK = 0.5; // -6 dBFS before the trim below
/** dB on top, so every tone is about -13 LUFS at full level (a little over her
 *  voice at -16), measured with ffmpeg ebur128 on bench/alarm-tones.mjs output.
 *  Peaks stay at -1 dBFS or under. */
const TRIM_DB: Record<string, number> = { classic: -2.6, digital: -3.2, chime: 4.8, bells: 4.7, marimba: 3.0, gentle: 3.4, birds: 0.5, pulse: 2.8, buzzer: -0.3 };

export function tonePattern(name: string): Float32Array {
  const key = isTone(name) ? name : DEFAULT_TONE;
  let p = cache.get(key);
  if (!p) {
    p = render(key);
    let peak = 0;
    for (const v of p) peak = Math.max(peak, Math.abs(v));
    const k = (peak > 0 ? PEAK / peak : 1) * 10 ** ((TRIM_DB[key] ?? 0) / 20);
    for (let i = 0; i < p.length; i++) p[i]! *= k;
    cache.set(key, p);
  }
  return p;
}

export interface RingAudio {
  /** Mono samples at 48 kHz, one repeat of the pattern. */
  pattern: Float32Array;
  /** Gap after each repeat, seconds. */
  gap?: number;
  /** Seconds from the first level to full level (0: full at once). */
  fadeIn?: number;
  /** Where the fade starts, 0..1 of full. */
  startLevel?: number;
  /** Stop after this many seconds (the ring's own time limit is elsewhere; this
   *  is for previews). */
  seconds?: number;
}

/** 48 kHz stereo s16le, made as the reader asks for it: a ring that lasts ten
 *  minutes never sits in memory, and the mixer's pause on a full buffer holds it. */
export function ringStream(a: RingAudio): Readable {
  const p = a.pattern;
  const gap = s(a.gap ?? 0);
  const cycle = p.length + gap;
  const fade = s(a.fadeIn ?? 0);
  const first = Math.min(1, Math.max(0.05, a.startLevel ?? 0.3));
  const limit = a.seconds !== undefined ? s(a.seconds) : Infinity;
  let pos = 0;
  const CHUNK = 960 * 5; // 100 ms
  return new Readable({
    read() {
      if (pos >= limit) {
        this.push(null);
        return;
      }
      const n = Math.min(CHUNK, limit - pos);
      const out = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        const at = pos + i;
        const c = at % cycle;
        let v = c < p.length ? p[c]! : 0;
        // Level rises evenly in dB, which sounds like a steady climb.
        if (fade > 0 && at < fade) v *= first * (1 / first) ** (at / fade);
        // A short fade on the very last 10 ms of a preview, so it doesn't click.
        if (limit !== Infinity && limit - at < 480) v *= (limit - at) / 480;
        const x = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        out.writeInt16LE(x, i * 4);
        out.writeInt16LE(x, i * 4 + 2);
      }
      pos += n;
      this.push(out);
    },
  });
}

/** PCM samples (mono, any rate) to a pattern at 48 kHz, for saved clips. */
export function patternFromPcm(samples: Int16Array, rate: number): Float32Array {
  const n = Math.floor((samples.length * TONE_RATE) / rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * rate) / TONE_RATE;
    const j = Math.floor(x);
    const f = x - j;
    const a = samples[j] ?? 0;
    const b = samples[j + 1] ?? a;
    out[i] = (a + (b - a) * f) / 32768;
  }
  return out;
}
