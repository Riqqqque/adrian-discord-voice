import { PassThrough, type Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FRAME_BYTES, Mixer } from '../src/voice/mixer.js';

/** Frames of a constant sample value. */
const pcm = (frames: number, value: number) => {
  const b = Buffer.alloc(FRAME_BYTES * frames);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(value, i * 2);
  return b;
};

function rig() {
  let now = 0;
  const outs: Buffer[] = [];
  let starts = 0;
  let current: Readable | undefined;
  let ends = 0;
  const m = new Mixer(
    {
      start: (stream) => {
        starts++;
        current = stream;
        stream.on('data', (b: Buffer) => outs.push(b));
        stream.on('end', () => ends++);
        return { done: new Promise(() => {}), stop: () => {} };
      },
      duckLevel: 0.25,
      setInterval: () => 1,
      clearInterval: () => {},
    },
    () => now,
  );
  const flush = () => new Promise((r) => setImmediate(r));
  /** Run n clock ticks, letting streams deliver in between. */
  const run = async (n: number) => {
    for (let i = 0; i < n; i++) {
      now += 20;
      m.tick();
      await flush();
    }
  };
  const last = () => outs.at(-1)!.readInt16LE(0);
  return { m, outs, run, flush, last, starts: () => starts, current: () => current, ends: () => ends, advance: (ms: number) => (now += ms) };
}

describe('mixer', () => {
  it('plays music, ducks it under speech, and brings it back', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(200, 1000));
    await r.flush();
    await r.run(5);
    expect(r.last()).toBe(1000);

    const speech = new PassThrough();
    const h = r.m.playPcm(speech, { volume: 1 });
    speech.write(pcm(3, 5000));
    speech.end();
    await r.flush();
    await r.run(2);
    expect(r.last()).toBe(5000 + 250); // speech plus music at the duck level
    await r.run(3);
    expect(await h.done).toBe('finished');
    await r.run(3);
    expect(r.last()).toBe(1000); // music back up
  });

  it('ducks for a while after a wake, and while held', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(300, 800));
    await r.flush();
    r.m.duckFor(100);
    await r.run(2);
    expect(r.last()).toBe(200);
    await r.run(6);
    expect(r.last()).toBe(800);
    const release = r.m.hold();
    await r.run(2);
    expect(r.last()).toBe(200);
    release();
    await r.run(2);
    expect(r.last()).toBe(800);
  });

  it('plays silence on an underrun and stops when nothing is left', async () => {
    const r = rig();
    const speech = new PassThrough();
    r.m.playPcm(speech, { volume: 1 });
    speech.write(pcm(1, 3000));
    await r.flush();
    await r.run(3);
    expect(r.outs.some((b) => b.readInt16LE(0) === 3000)).toBe(true);
    expect(r.last()).toBe(0); // waiting for the next sentence: silence
    speech.end();
    await r.run(3);
    await r.flush();
    expect(r.ends()).toBe(1);
    // Something new starts a fresh playback.
    const again = new PassThrough();
    r.m.playPcm(again, { volume: 1 });
    expect(r.starts()).toBe(2);
  });

  it('stop drops a channel at once; a new track replaces the old one', async () => {
    const r = rig();
    const a = new PassThrough();
    const h = r.m.playMusic(a, 1);
    a.write(pcm(100, 700));
    await r.flush();
    await r.run(2);
    const b = new PassThrough();
    r.m.playMusic(b, 1);
    expect(await h.done).toBe('stopped');
    b.write(pcm(100, 900));
    await r.flush();
    await r.run(2);
    expect(r.last()).toBe(900);
    expect(r.m.musicPlaying).toBe(true);
    r.m.stopAll();
    expect(r.m.musicPlaying).toBe(false);
  });

  it('makes up frames after a stall instead of staying short', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(500, 600));
    await r.flush();
    await r.run(5);
    const before = r.outs.length;
    r.advance(100); // the event loop was blocked for 100 ms
    await r.run(1); // one tick: the 5 missed frames plus this one
    expect(r.outs.length - before).toBe(6);
    // A very long stall skips ahead rather than bursting seconds of audio.
    const mid = r.outs.length;
    r.advance(5_000);
    await r.run(1);
    expect(r.outs.length - mid).toBeLessThanOrEqual(10);
  });

  it('clips instead of wrapping around', async () => {
    const r = rig();
    const s = new PassThrough();
    const m = new PassThrough();
    r.m.playMusic(m, 1);
    r.m.playPcm(s, { volume: 1 });
    s.write(pcm(5, 32000));
    m.write(pcm(5, 32000));
    await r.flush();
    await r.run(1);
    expect(r.last()).toBe(32767);
  });
});
