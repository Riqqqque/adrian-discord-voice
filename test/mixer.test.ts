import { PassThrough, type Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FRAME_BYTES, LEAD_FRAMES, Mixer, START_LEAD_FRAMES } from '../src/voice/mixer.js';

/** Frames of a constant sample value. */
const pcm = (frames: number, value: number) => {
  const b = Buffer.alloc(FRAME_BYTES * frames);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(value, i * 2);
  return b;
};

/** Frames written so far. */
const frames = (outs: Buffer[]) => Buffer.concat(outs).length / FRAME_BYTES;

/** Silent frames ahead of the first sound. */
const silenceFirst = (outs: Buffer[]) => {
  const all = Buffer.concat(outs);
  for (let f = 0; f * FRAME_BYTES < all.length; f++) if (all.readInt16LE(f * FRAME_BYTES) !== 0) return f;
  return -1;
};

/** Silent frames between the first sound and the last. */
const holes = (outs: Buffer[]) => {
  const all = Buffer.concat(outs);
  const sound = (f: number) => all.readInt16LE(f * FRAME_BYTES) !== 0;
  const first = silenceFirst(outs);
  if (first < 0) return 0;
  let last = all.length / FRAME_BYTES - 1;
  while (last > first && !sound(last)) last--;
  let n = 0;
  for (let f = first; f <= last; f++) if (!sound(f)) n++;
  return n;
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
    s.write(pcm(20, 32000));
    m.write(pcm(20, 32000));
    await r.flush();
    await r.run(1);
    expect(r.last()).toBe(32767);
  });

  it('opens with a short silence, and the first audio fills the full lead', async () => {
    const r = rig();
    const speech = new PassThrough();
    speech.write(pcm(100, 3000)); // the Speaker writes before it calls playPcm
    r.m.playPcm(speech, { volume: 1 });
    await r.flush();
    expect(frames(r.outs)).toBe(START_LEAD_FRAMES);
    await r.run(1);
    expect(silenceFirst(r.outs)).toBe(START_LEAD_FRAMES);
    expect(frames(r.outs)).toBe(1 + LEAD_FRAMES);
    await r.run(10);
    expect(frames(r.outs)).toBe(11 + LEAD_FRAMES);
  });

  it('holds the silence short while a slow source starts', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    await r.run(5); // ffmpeg hasn't delivered yet
    expect(frames(r.outs)).toBe(5 + START_LEAD_FRAMES);
    music.write(pcm(100, 900));
    await r.flush();
    await r.run(1);
    expect(silenceFirst(r.outs)).toBe(5 + START_LEAD_FRAMES);
    expect(frames(r.outs)).toBe(6 + LEAD_FRAMES);
  });

  it('gives a small first chunk a moment to collect the rest', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(2, 900)); // ffmpeg's first chunk can be this small
    await r.flush();
    await r.run(1);
    music.write(pcm(100, 900)); // the rest, moments later
    await r.flush();
    await r.run(2);
    expect(silenceFirst(r.outs)).toBe(1 + START_LEAD_FRAMES);
    expect(holes(r.outs)).toBe(0);
    expect(frames(r.outs)).toBe(3 + LEAD_FRAMES);
    expect(r.m.takeStats().musicGaps).toBe(0);
  });

  it.each(['music', 'a sound effect'])('leaves no hole when the rest of %s comes late', async (kind) => {
    const r = rig();
    const source = new PassThrough();
    if (kind === 'music') r.m.playMusic(source, 1);
    else r.m.playPcm(source, { volume: 1 }); // sound effects come from ffmpeg too
    source.write(pcm(2, 900));
    await r.flush();
    await r.run(3); // more than a small chunk's moment
    source.write(pcm(100, 900));
    await r.flush();
    await r.run(10);
    expect(holes(r.outs)).toBe(0);
    expect(r.m.takeStats().musicGaps).toBe(0);
  });

  it('leaves no hole in a source that only just keeps up', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    for (let i = 0; i < 15; i++) {
      music.write(pcm(2, 900)); // a throttled stream: two frames per 40 ms
      await r.flush();
      await r.run(2);
    }
    expect(holes(r.outs)).toBe(0);
    expect(r.m.takeStats().musicGaps).toBe(0);
  });

  it('only plays sound on the full lead, so a stall can only cost silence', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(3, 900));
    await r.flush();
    let ticks = 0;
    while (silenceFirst(r.outs) < 0 && ticks < 20) {
      await r.run(1);
      ticks++;
    }
    expect(frames(r.outs)).toBe(ticks + LEAD_FRAMES);
  });

  it('reaches the full lead with a source that stays slow, and a clip that is short', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(1, 900));
    await r.flush();
    await r.run(2); // the only frame so far has played
    music.write(pcm(1, 900));
    await r.flush();
    await r.run(1);
    expect(frames(r.outs)).toBe(3 + LEAD_FRAMES);

    const s = rig();
    const clip = new PassThrough();
    s.m.playPcm(clip, { volume: 1 });
    clip.end(pcm(2, 3000));
    await s.flush();
    await s.run(1);
    expect(frames(s.outs)).toBe(START_LEAD_FRAMES + 2); // all of it at once, nothing left to wait for
  });

  it('keeps the full lead through stalls and gaps once audio plays', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(20, 900));
    await r.flush();
    await r.run(1);
    // A stall right after the first audio: a player catching up finds frames.
    const stalled = r.advance(150);
    expect(frames(r.outs)).toBeGreaterThanOrEqual(Math.floor(stalled / 20));
    await r.run(1);
    expect(frames(r.outs)).toBe(Math.floor(stalled / 20) + 1 + LEAD_FRAMES);
    await r.run(30); // the source ran dry: silence, on the same lead
    expect(r.last()).toBe(0);
    expect(frames(r.outs)).toBe(Math.floor(stalled / 20) + 31 + LEAD_FRAMES);
  });

  it('opens every new playback the same way', async () => {
    const r = rig();
    const a = new PassThrough();
    r.m.playPcm(a, { volume: 1 });
    a.end(pcm(2, 3000));
    await r.flush();
    await r.run(12);
    await r.flush();
    expect(r.ends()).toBe(1);
    r.outs.length = 0;
    const b = new PassThrough();
    b.write(pcm(20, 3000));
    r.m.playPcm(b, { volume: 1 });
    await r.flush();
    await r.run(1);
    expect(r.starts()).toBe(2);
    expect(silenceFirst(r.outs)).toBe(START_LEAD_FRAMES);
  });

  it('gives each new playback its own moment to collect a small first chunk', async () => {
    const r = rig();
    const a = new PassThrough();
    r.m.playMusic(a, 1);
    a.write(pcm(2, 900));
    await r.flush();
    await r.run(30); // long past the moment, and played out
    r.m.pauseMusic();
    await r.run(1);
    await r.flush();
    expect(r.ends()).toBe(1);
    r.outs.length = 0;
    const b = new PassThrough();
    r.m.playPcm(b, { volume: 1 });
    b.write(pcm(2, 3000));
    await r.flush();
    await r.run(1);
    b.write(pcm(20, 3000));
    await r.flush();
    await r.run(1);
    expect(silenceFirst(r.outs)).toBe(1 + START_LEAD_FRAMES);
  });

  it('picks a track back up at once, however little of it is waiting', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(12, 900));
    await r.flush();
    await r.run(1);
    r.m.pauseMusic();
    await r.run(1); // nothing else to play: the playback ends
    await r.flush();
    expect(r.ends()).toBe(1);
    r.outs.length = 0;
    r.m.resumeMusic();
    await r.flush();
    expect(silenceFirst(r.outs)).toBe(0);
  });

  it('adds no silence when audio is already waiting, and paused music does not count', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(200, 900));
    await r.flush();
    await r.run(2);
    r.m.pauseMusic();
    await r.run(1); // nothing else to play: the playback ends
    await r.flush();
    expect(r.ends()).toBe(1);

    r.outs.length = 0;
    const speech = new PassThrough();
    speech.end(pcm(3, 3000));
    r.m.playPcm(speech, { volume: 1 });
    await r.flush();
    await r.run(1);
    expect(silenceFirst(r.outs)).toBe(START_LEAD_FRAMES); // the paused track's audio isn't what plays
    await r.run(12);
    await r.flush();
    expect(r.ends()).toBe(2);

    r.outs.length = 0;
    r.m.resumeMusic();
    await r.flush();
    expect(silenceFirst(r.outs)).toBe(0);
    expect(frames(r.outs)).toBe(LEAD_FRAMES);
  });

  it('does not count filling the lead as catching up on a stall', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    r.m.takeStats(); // the music player clears them right after playMusic
    music.write(pcm(100, 900));
    await r.flush();
    await r.run(5);
    expect(r.m.takeStats().madeUp).toBe(0);
    r.advance(100);
    await r.run(1);
    expect(r.m.takeStats().madeUp).toBe(5);
  });

  it('ends a wake duck for a requested track', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(300, 800));
    await r.flush();
    r.m.duckFor(8_000);
    await r.run(2);
    expect(r.last()).toBe(200);
    const asked = r.advance(0); // the request, right after its own wake
    r.advance(400); // the lookup
    r.m.endDuck(asked);
    await r.run(2);
    expect(r.last()).toBe(800);
  });

  it('keeps the duck of a wake newer than the request', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(300, 800));
    await r.flush();
    r.m.duckFor(8_000);
    const asked = r.advance(0);
    r.advance(200);
    r.m.duckFor(8_000); // someone else woke her during the lookup
    r.advance(200);
    r.m.endDuck(asked);
    await r.run(2);
    expect(r.last()).toBe(200);
    r.m.endDuck(r.advance(0)); // a request after that wake does clear it
    await r.run(2);
    expect(r.last()).toBe(800);
  });

  it('still ducks under speech and holds after the wake duck ends', async () => {
    const r = rig();
    const music = new PassThrough();
    r.m.playMusic(music, 1);
    music.write(pcm(300, 800));
    await r.flush();
    r.m.duckFor(8_000);
    const asked = r.advance(0);
    const release = r.m.hold();
    r.m.endDuck(asked);
    await r.run(2);
    expect(r.last()).toBe(200);
    release();
    await r.run(2);
    expect(r.last()).toBe(800);

    const speech = new PassThrough(); // "On it." stays on top
    speech.end(pcm(3, 5000));
    r.m.playPcm(speech, { volume: 1 });
    r.m.endDuck(r.advance(0));
    await r.flush();
    await r.run(2);
    expect(r.last()).toBe(5000 + 200);
  });
});
