// Saving a YouTube clip as an alarm sound, with YouTube and ffmpeg stubbed:
// a clip found, nothing found, too long, decode failures, name clashes, a full disk.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { saveClip } from '../src/app/alarm-commands.js';
import { previewIn, type RingerDeps, type RingRoom } from '../src/app/alarm-ring.js';
import { AlarmClock } from '../src/features/alarms.js';
import { alarmTools } from '../src/features/alarm-tools.js';
import { Reminders } from '../src/features/reminders.js';
import type { DecoderFactory, Track } from '../src/features/music.js';

/** 'clip': the next .pcm write fills the disk halfway through; 'json': alarms.json can't be written. */
let diskFull: 'clip' | 'json' | undefined;
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const full = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  return {
    ...fs,
    writeFileSync: (...a: Parameters<typeof fs.writeFileSync>) => {
      const path = String(a[0]);
      if (diskFull === 'clip' && path.endsWith('.pcm')) {
        fs.writeFileSync(path, Buffer.alloc(4096)); // part of it made it
        throw full();
      }
      if (diskFull === 'json' && path.endsWith('.json.tmp')) throw full();
      return fs.writeFileSync(...a);
    },
  };
});

const TZ = 'America/Denver';
const SAM = '400000000000000005';
const ctx = { userId: SAM, speaker: 'Sam', text: true };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

/** 48 kHz stereo s16le: `seconds` of a 440 Hz tone at `amp`, or silence at amp 0. */
function pcm(seconds: number, amp: number): Buffer {
  const n = Math.round(seconds * 48_000);
  const b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / 48_000));
    b.writeInt16LE(v, i * 4);
    b.writeInt16LE(v, i * 4 + 2);
  }
  return b;
}

/** ffmpeg, stubbed. `audio`: what it decodes to, in odd-sized chunks; 'error' fails
 *  partway; 'dead' never starts (its output just closes); 'endless' is a long
 *  video that keeps coming until killed; 'hang' sends nothing and never ends. */
function ffmpeg(audio: Buffer | 'error' | 'dead' | 'endless' | 'hang') {
  const st = { kills: 0, bytes: 0, urls: [] as string[] };
  const factory: DecoderFactory = (input) => {
    st.urls.push('url' in input ? input.url : 'stream');
    let s: Readable;
    if (audio === 'endless') {
      const chunk = pcm(1, 9000);
      s = new Readable({ read() { st.bytes += chunk.length; this.push(chunk); } });
    } else {
      const p = new PassThrough();
      s = p;
      setImmediate(() => {
        if (audio === 'dead') return void p.destroy();
        if (audio === 'hang') return;
        if (audio === 'error') {
          p.write(pcm(0.5, 9000));
          return void p.destroy(new Error('ffmpeg exited with code 1'));
        }
        for (let i = 0; i < audio.length; i += 3333) p.write(audio.subarray(i, i + 3333));
        p.end();
      });
    }
    return { pcm: s, kill: () => (st.kills++, s.destroy()) };
  };
  return { st, factory };
}

const found = (title = 'Air Horn Sound Effect'): ((q: string, s: AbortSignal) => Promise<Track | undefined>) => async () => ({ title, source: 'youtube', ref: 'https://media.example/clip', durationS: 6 });

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-clips-'));
  const soundsDir = join(dir, 'alarm-sounds');
  const logs: string[] = [];
  const clock = new AlarmClock(join(dir, 'alarms.json'), TZ, {
    placeFor: () => undefined,
    ring: () => undefined,
    dm: async () => true,
    // As stack.ts does it.
    soundGone: (file) => rmSync(join(soundsDir, file), { force: true }),
    log: (e) => void logs.push(e),
  });
  const save = (o: { find?: ReturnType<typeof found>; audio?: Parameters<typeof ffmpeg>[0]; query?: string; name?: string; signal?: AbortSignal }) => {
    const f = ffmpeg(o.audio ?? Buffer.concat([pcm(0.5, 0), pcm(5, 8000), pcm(0.5, 0)]));
    const r = saveClip({ find: o.find ?? found(), decode: f.factory, dir: soundsDir, clock, userId: SAM, query: o.query ?? 'air horn', name: o.name ?? 'airhorn', signal: o.signal ?? AbortSignal.timeout(5000), log: quiet as never });
    return { r, f };
  };
  let audio: Parameters<typeof ffmpeg>[0] = Buffer.concat([pcm(0.2, 0), pcm(3, 12000)]);
  const tools = alarmTools({
    clock,
    reminders: new Reminders(undefined, TZ, () => {}),
    english: () => true,
    reach: () => 'call',
    preview: async () => true,
    musicOk: true,
    saveClip: (c, query, name, signal) => saveClip({ find: found(`${query} sfx`), decode: ffmpeg(audio).factory, dir: soundsDir, clock, userId: c.userId, query, name, signal, log: quiet as never }),
  });
  const options = (a: Record<string, unknown>) => tools.find((t) => t.spec.name === 'alarm_options')!.run(a, AbortSignal.timeout(5000), ctx) as Promise<string>;
  return { dir, soundsDir, clock, save, options, logs, setAudio: (a: typeof audio) => void (audio = a), files: () => (existsSync(soundsDir) ? readdirSync(soundsDir) : []) };
}

describe('saving a clip as an alarm sound', () => {
  it('a clip found: kept as 24 kHz mono, silence trimmed, at the tones\' peak', async () => {
    const w = rig();
    const { r, f } = w.save({});
    const s = await r;
    if (typeof s === 'string') throw new Error(s);
    expect(s).toMatchObject({ name: 'airhorn', owner: SAM, title: 'Air Horn Sound Effect' });
    expect(s.seconds).toBeCloseTo(5, 1);
    expect(f.st.urls).toEqual(['https://media.example/clip']);
    const b = readFileSync(join(w.soundsDir, s.file));
    const samples = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
    expect(samples.length).toBe(Math.round(s.seconds * 24_000));
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(16_300);
    expect(peak).toBeLessThanOrEqual(16_384);
    expect(w.clock.savedSound(SAM, 'AIRHORN')?.file).toBe(s.file);
  });

  it('nothing found, or YouTube not answering', async () => {
    const w = rig();
    expect(await w.save({ find: async () => undefined }).r).toBe('Found no short "air horn" sound on YouTube.');
    expect(
      await w.save({
        find: async () => {
          throw new Error('Sign in to confirm you are not a bot');
        },
      }).r,
    ).toBe("YouTube didn't answer just now; try again in a minute.");
    expect(w.files()).toEqual([]);
  });

  it('too long: the first 30 seconds, and ffmpeg is stopped', async () => {
    const w = rig();
    const { r, f } = w.save({ audio: 'endless' });
    const s = await r;
    if (typeof s === 'string') throw new Error(s);
    expect(s.seconds).toBeGreaterThan(29.9);
    expect(s.seconds).toBeLessThanOrEqual(30);
    expect(f.st.kills).toBeGreaterThanOrEqual(1);
    expect(f.st.bytes).toBeLessThan(40 * 48_000 * 4);
  });

  it('decode failures', async () => {
    const w = rig();
    expect(await w.save({ audio: 'error' }).r).toBe("Couldn't read that sound.");
    // ffmpeg missing or refused to start: its output closes without an end or an error.
    const t0 = performance.now();
    expect(await w.save({ audio: 'dead' }).r).toBe("Couldn't read that sound.");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(await w.save({ audio: Buffer.alloc(0) }).r).toBe("Couldn't read that sound.");
    // Too slow: the tool's time limit ends it.
    const slow = w.save({ audio: 'hang', signal: AbortSignal.timeout(50) });
    expect(await slow.r).toBe('That took too long.');
    expect(slow.f.st.kills).toBe(1);
    const gone = new AbortController();
    gone.abort();
    expect(await w.save({ signal: gone.signal }).r).toBe('That took too long.');
    expect(w.files()).toEqual([]);
  });

  it('silence or a faint hiss is refused, not saved to ring as nothing', async () => {
    const w = rig();
    expect(await w.save({ audio: pcm(5, 0) }).r).toBe('That sound came out empty; try another.');
    expect(await w.save({ audio: pcm(5, 40) }).r).toBe('That sound came out empty; try another.');
    expect(await w.save({ audio: pcm(0.1, 9000) }).r).toBe('That sound came out empty; try another.');
    expect(w.files()).toEqual([]);
    expect(w.clock.sounds(SAM)).toEqual([]);
  });

  it('a full disk: nothing half-written is left, and a failed list save is said', async () => {
    const w = rig();
    diskFull = 'clip';
    try {
      expect(await w.save({}).r).toBe("Couldn't save it on the server.");
    } finally {
      diskFull = undefined;
    }
    expect(w.files()).toEqual([]);
    expect(w.clock.sounds(SAM)).toEqual([]);
    diskFull = 'json';
    try {
      const t = await w.options({ action: 'save_sound', query: 'air horn', name: 'airhorn' });
      expect(t).toMatch(/^Saved "airhorn" \(3 seconds, from "air horn sfx"\)\. It can be used as sound "airhorn"\. \(Note: saving to disk failed/);
    } finally {
      diskFull = undefined;
    }
  });

  it('names: cleaned, built-in names refused, the same name replaces the old one and its file', async () => {
    const w = rig();
    expect(await w.options({ action: 'save_sound', query: 'beep', name: 'Classic' })).toBe('"classic" is taken by a built-in sound; pick another name.');
    expect(await w.options({ action: 'save_sound', query: 'x', name: 'Voice' })).toBe('"voice" is taken by a built-in sound; pick another name.');
    expect(await w.options({ action: 'save_sound', query: 'air horn', name: 'Air <Horn>!' })).toMatch(/^Saved "air horn"/);
    // No name given: one is made from the query, cleaned the same way.
    expect(await w.options({ action: 'save_sound', query: 'Fog:Horn @everyone' })).toMatch(/^Saved "foghorn everyone"/);
    const first = w.clock.savedSound(SAM, 'air horn')!.file;
    w.setAudio(Buffer.concat([pcm(0.1, 0), pcm(2, 12000)]));
    expect(await w.options({ action: 'save_sound', query: 'louder air horn', name: 'air horn' })).toMatch(/^Saved "air horn" \(2 seconds/);
    const second = w.clock.savedSound(SAM, 'air horn')!.file;
    expect(second).not.toBe(first);
    expect(w.files().sort()).toEqual([second, w.clock.savedSound(SAM, 'foghorn everyone')!.file].sort());
    expect(w.clock.sounds(SAM)).toHaveLength(2);
    // Deleting it takes its file too, and the alarms that used it go back to the default.
    expect(await w.options({ action: 'delete_sound', name: 'air horn' })).toBe('Deleted the "air horn" sound; alarms that used it are back on their default.');
    expect(w.files()).toEqual([w.clock.savedSound(SAM, 'foghorn everyone')!.file]);
  });

  it('up to 10 saved sounds', async () => {
    const w = rig();
    for (let i = 0; i < 10; i++) expect(await w.options({ action: 'save_sound', query: 'beep', name: `beep ${i}` })).toMatch(/^Saved/);
    expect(await w.options({ action: 'save_sound', query: 'beep', name: 'beep 10' })).toBe('They have 10 saved sounds; delete one first.');
    // Replacing one of the ten is fine.
    expect(await w.options({ action: 'save_sound', query: 'beep', name: 'beep 3' })).toMatch(/^Saved/);
    expect(w.files()).toHaveLength(10);
  });
});

describe('a saved clip ringing', () => {
  /** The first `seconds` of what a preview of `sound` plays. */
  async function heard(clip: Float32Array | undefined, seconds = 2): Promise<number> {
    const streams: Readable[] = [];
    const room = { key: 'discord', mixer: { playAlarm: (s: Readable) => (streams.push(s), { stop() {}, done: new Promise(() => {}) }) } } as unknown as RingRoom;
    const logs: string[] = [];
    const d: RingerDeps = { soundOf: () => 'clip:airhorn', clip: () => clip, speak: async () => undefined, name: () => 'Sam', log: (e) => void logs.push(e), level: 0.7 };
    previewIn(room, 'clip:airhorn', d, SAM, 1);
    let peak = 0;
    let got = 0;
    for await (const b of streams[0]! as AsyncIterable<Buffer>) {
      for (let i = 0; i < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
      got += b.length;
      if (got >= seconds * 48_000 * 4) break;
    }
    return peak;
  }

  it('rings what was saved; an empty or missing file rings the classic tone, never silence', async () => {
    expect(await heard(new Float32Array(48_000).fill(0.4))).toBeGreaterThan(10_000);
    expect(await heard(undefined)).toBeGreaterThan(5_000);
    expect(await heard(new Float32Array(0))).toBeGreaterThan(5_000);
  });
});
