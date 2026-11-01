import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { PlaybackHandle, ToolContext } from '../src/core/interfaces.js';
import { deezerTopTracks, inputArgs, MusicPlayer, type MusicOutput, type MusicSource, musicTools, runProgram, type Runner, type TopTracks, type Track, YoutubeSource } from '../src/features/music.js';

const sig = () => AbortSignal.timeout(4000);
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ticks = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};
const id = (n: number | string) => `vid${String(n).padStart(8, '0')}`; // 11 chars
const ctx: ToolContext = { userId: 'u1', speaker: 'Sam' };
const CANT = "I can't reach YouTube right now.";
const BOT = 'ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Rejects when the signal does, like a killed program. */
const until = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    p.then(resolve, reject);
  });

/** A fake yt-dlp that answers by URL. `gate` holds a call back while it returns a promise. */
function fakeYtdlp(calls: string[], gate?: (url: string) => Promise<unknown> | undefined): Runner {
  return async (_cmd, args, signal) => {
    const url = args.at(-1)!;
    calls.push(url);
    const held = gate?.(url);
    if (held) await until(held, signal);
    if (url.includes('#songs')) return `${id('song')}\n`;
    if (url.includes('#albums')) return 'MPREb_ALBUM\n';
    if (url.includes('browse/MPREb_ALBUM')) return [1, 2, 3].map((n) => `Album - Graduation\t${id(`a${n}`)}\tTrack ${n}\t200`).join('\n');
    if (url.includes('list=RDAMVM')) {
      const seed = url.split('v=')[1]!.slice(0, 11);
      return [1, 2, 3].map((n) => `Mix\t${id(`${seed.slice(-3)}${n}`)}\tRadio ${n}\t150`).join('\n');
    }
    if (url.startsWith('ytsearch5:')) return `${id('vid')}\t200\tNA\n`;
    if (url.includes('watch?v=')) {
      const v = url.split('v=')[1]!;
      return `Artist - Title ${v}\tArtist\t200\thttps://stream/${v}\n`;
    }
    return '';
  };
}

function plexSource(has: (q: string) => boolean = () => true) {
  const asked: string[] = [];
  const plex: MusicSource = {
    name: 'plex',
    find: async (q) => {
      asked.push(q);
      return has(q) ? ({ title: q, source: 'plex', ref: `/library/parts/${asked.length}/x.mp3` } as Track) : undefined;
    },
    open: async () => ({ stream: Readable.from([]) }),
  };
  return { plex, asked };
}

interface RigOptions {
  run?: Runner;
  gate?: (url: string) => Promise<unknown> | undefined;
  topTracks?: TopTracks;
  plex?: MusicSource;
  autoplay?: boolean;
  maxQueue?: number;
  now?: () => number;
  stallMs?: number;
  searchApi?: string;
}

function rig(o: RigOptions = {}) {
  const calls: string[] = [];
  const events: string[] = [];
  const ends: ((v: 'finished' | 'error') => void)[] = [];
  const ducks: number[] = [];
  const logs: ({ m: string } & Record<string, unknown>)[] = [];
  const pcms: PassThrough[] = [];
  const out: MusicOutput & { musicPaused: boolean } = {
    playMusic: () => {
      events.push('play');
      let end!: (v: 'finished' | 'error') => void;
      const done = new Promise<'finished' | 'stopped' | 'error'>((r) => (end = r));
      ends.push(end);
      return {
        done,
        stop: () => {
          events.push('stop');
          end('finished');
        },
      } as PlaybackHandle;
    },
    pauseMusic() {},
    resumeMusic() {},
    setMusicVolume() {},
    endDuck: (since) => ducks.push(since),
    musicPlaying: true,
    musicPaused: false,
  };
  const yt = new YoutubeSource(
    { ytdlp: 'yt-dlp', ...(o.now ? { now: o.now } : {}), ...(o.searchApi ? { searchApi: o.searchApi } : {}) },
    o.run ?? fakeYtdlp(calls, o.gate),
  );
  const killed: number[] = [];
  const p = new MusicPlayer({
    sources: [yt, ...(o.plex ? [o.plex] : [])],
    output: out,
    decode: (input) => {
      events.push('url' in input ? `decode ${input.url}` : 'decode plex');
      const pcm = new PassThrough();
      pcms.push(pcm);
      const n = pcms.length - 1;
      return { pcm, kill: () => killed.push(n) };
    },
    log: {
      info: (m, f) => logs.push({ m, ...f }),
      warn: (m, f) => logs.push({ m, ...f }),
    },
    autoplay: o.autoplay ?? false,
    ...(o.maxQueue ? { maxQueue: o.maxQueue } : {}),
    ...(o.topTracks ? { topTracks: o.topTracks } : {}),
    ...(o.stallMs ? { stallMs: o.stallMs } : {}),
  });
  const logged = (m: string) => logs.filter((l) => l.m === m);
  return { p, yt, out, calls, events, ends, ducks, logs, logged, pcms, killed, finishLast: () => ends.at(-1)!('finished') };
}

const songs = (n: number) => Array.from({ length: n }, (_, i) => `Song ${i + 1}`);
const known = (artist: string, n = 30): TopTracks => async () => ({ artist, titles: songs(n), known: true });

describe('the music timing line', () => {
  it('says how a song was found and where the time went', async () => {
    const r = rig();
    await r.p.request('song', 'round 2', 'now', sig());
    expect(r.logged('music timing')).toEqual([]); // not until the first audio
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    const [t] = r.logged('music timing');
    expect(t).toMatchObject({ via: 'ytdlp', source: 'youtube' });
    for (const k of ['searchMs', 'resolveMs', 'pcmMs']) expect(t![k]).toEqual(expect.any(Number));
    expect(r.logged('music timing')).toHaveLength(1);
  });

  it('counts the time Deezer took on an artist request', async () => {
    const r = rig({
      topTracks: async () => {
        await wait(30);
        return { artist: 'Drake', titles: songs(10), known: true };
      },
    });
    await r.p.request('artist', 'drake', 'now', sig());
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    expect(r.logged('music timing')[0]!.deezerMs).toBeGreaterThanOrEqual(25);
  });

  it('follows a list track through its lookup', async () => {
    const r = rig();
    await r.p.request('album', 'graduation', 'now', sig());
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    const [t] = r.logged('music timing');
    expect(t).toMatchObject({ via: 'list' });
    expect(t!.resolveMs).toEqual(expect.any(Number));
  });

  it('follows an artist song through its search', async () => {
    const r = rig({ topTracks: known('Drake', 6) });
    await r.p.request('artist', 'drake', 'now', sig());
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    const [t] = r.logged('music timing');
    expect(t).toMatchObject({ via: 'ytdlp' });
    expect(t!.searchMs).toEqual(expect.any(Number));
  });

  it('marks a song that was ready before its turn', async () => {
    const r = rig();
    await r.p.request('album', 'graduation', 'now', sig());
    await ticks();
    await r.p.skip();
    await ticks();
    r.pcms[1]!.write(Buffer.alloc(100));
    await ticks();
    expect(r.logged('music timing').at(-1)).toMatchObject({ via: 'ready' });
  });

  it('carries no words', async () => {
    const r = rig();
    await r.p.request('song', 'round 2', 'now', sig());
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    expect(JSON.stringify(r.logged('music timing'))).not.toMatch(/round|Title/);
  });
});

describe('a bot check', () => {
  const blocked =
    (calls: string[], message = BOT): Runner =>
    async (_c, args) => {
      calls.push(args.at(-1)!);
      throw new Error(message);
    };

  it('pauses YouTube for 30 minutes, then lets it back', async () => {
    let now = 1_000_000;
    let bot = true;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const r = rig({
      now: () => now,
      run: async (c, a, s) => {
        if (bot) {
          calls.push(a.at(-1)!);
          throw new Error(BOT);
        }
        return inner(c, a, s);
      },
    });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    expect(r.yt.paused).toBe(true);
    expect(r.logged('youtube paused')).toHaveLength(1);
    bot = false;
    calls.length = 0;
    await expect(r.yt.resolve(id('x'), sig())).rejects.toThrow(/paused/i);
    await expect(r.yt.find('x', sig())).rejects.toThrow(/paused/i);
    await expect(r.yt.radio(id('x'), sig())).rejects.toThrow(/paused/i);
    await expect(r.yt.soundEffect('x', sig())).rejects.toThrow(/paused/i);
    expect(calls).toEqual([]);
    now += 29 * 60_000;
    expect(r.yt.paused).toBe(true);
    now += 61_000;
    expect(r.yt.paused).toBe(false);
    expect(await r.yt.resolve(id('x'), sig())).toMatchObject({ id: id('x') });
  });

  it('is seen even in a search, which swallows its own errors', async () => {
    const calls: string[] = [];
    const r = rig({ run: blocked(calls) });
    await expect(r.yt.album('graduation', sig())).rejects.toThrow(/paused/i);
    expect(r.yt.paused).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('is not an age gate on one video', async () => {
    const calls: string[] = [];
    const r = rig({ run: blocked(calls, 'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.') });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    expect(r.yt.paused).toBe(false);
    expect(r.logged('youtube paused')).toEqual([]);
  });

  it('leaves other failures alone', async () => {
    const calls: string[] = [];
    const r = rig({ run: blocked(calls, 'ERROR: Video unavailable') });
    await expect(r.yt.resolve(id('x'), sig())).rejects.toThrow('Video unavailable');
    expect(r.yt.paused).toBe(false);
  });

  it('sends a request to Plex without touching YouTube again', async () => {
    const calls: string[] = [];
    const { plex, asked } = plexSource();
    const r = rig({ run: blocked(calls), plex });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    calls.length = 0;
    const res = await r.p.request('song', 'thriller', 'now', sig());
    expect(res).toMatchObject({ ok: true, started: { source: 'plex' } });
    expect(asked).toEqual(['thriller']);
    expect(calls).toEqual([]);
    expect(r.logged('music search failed')).toEqual([]);
  });

  it('takes the request it landed on to Plex as well', async () => {
    const calls: string[] = [];
    const { plex, asked } = plexSource();
    const r = rig({ run: blocked(calls), plex });
    const res = await r.p.request('album', 'graduation', 'now', sig());
    expect(res).toMatchObject({ ok: true, started: { source: 'plex' } });
    expect(asked).toEqual(['graduation']);
  });

  it('asks Deezer once when it lands on an artist request', async () => {
    const calls: string[] = [];
    const { plex } = plexSource();
    let lists = 0;
    const r = rig({
      run: blocked(calls),
      plex,
      topTracks: async () => {
        lists++;
        return { artist: 'Small Act', titles: songs(2), known: true };
      },
    });
    expect(await r.p.request('artist', 'small act', 'now', sig())).toMatchObject({ ok: true, started: { source: 'plex' } });
    expect(lists).toBe(1);
  });

  it('says so when Plex has nothing', async () => {
    const calls: string[] = [];
    const { plex } = plexSource(() => false);
    const r = rig({ run: blocked(calls), plex });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    for (const kind of ['song', 'artist', 'album', 'vibe', 'podcast', 'video'] as const) {
      expect(await r.p.request(kind, 'thriller', 'now', sig())).toEqual({ ok: false, message: CANT });
    }
    expect(await r.p.request('similar', 'thriller', 'now', sig())).toEqual({ ok: false, message: CANT });
    expect(await r.p.request('link', `https://youtu.be/${id('l')}`, 'now', sig())).toEqual({ ok: false, message: CANT });
    expect(await r.p.playNamed('thriller', 'now', sig())).toEqual({ ok: false, message: CANT });
    expect(calls).toHaveLength(1);
  });

  it('says the same when Plex is down too', async () => {
    const calls: string[] = [];
    const down: MusicSource = {
      name: 'plex',
      find: async () => {
        throw new Error('Plex answered 500');
      },
      open: async () => ({ stream: Readable.from([]) }),
    };
    const r = rig({ run: blocked(calls), plex: down });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    expect(await r.p.request('song', 'thriller', 'now', sig())).toEqual({ ok: false, message: CANT });
    expect(await r.p.request('artist', 'thriller', 'now', sig())).toEqual({ ok: false, message: CANT });
    expect(r.events).toEqual([]);
  });

  it('never takes a link for a Plex search', async () => {
    const { plex, asked } = plexSource();
    const r = rig({ run: blocked([]), plex });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    expect(await r.p.request('link', `https://youtu.be/${id('l')}`, 'now', sig())).toEqual({ ok: false, message: CANT });
    expect(asked).toEqual([]);
  });

  it('says so for a list that was found just before', async () => {
    let n = 0;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const { plex } = plexSource(() => false);
    const r = rig({
      plex,
      run: async (c, a, s) => {
        if (a.at(-1)!.includes('watch?v=') && ++n === 1) throw new Error(BOT);
        return inner(c, a, s);
      },
    });
    expect(await r.p.request('album', 'graduation', 'now', sig())).toEqual({ ok: false, message: CANT });
    expect(r.logged('music track failed')[0]).toMatchObject({ error: CANT });
  });

  it('says so with no Plex at all', async () => {
    const r = rig({ run: blocked([]) });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    expect(await r.p.play('thriller', 'now', sig())).toEqual({ ok: false, message: CANT });
  });

  it('still says a song is missing when Plex was asked for by name', async () => {
    const { plex } = plexSource(() => false);
    const r = rig({ run: blocked([]), plex });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    expect(await r.p.play('thriller', 'now', sig(), 'plex')).toEqual({ ok: false, message: "I couldn't find thriller." });
  });

  it('goes unnoticed by Deezer: no list of songs that cannot be looked up', async () => {
    const top = vi.fn(known('Drake'));
    const { plex } = plexSource();
    const r = rig({ run: blocked([]), plex, topTracks: top });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    await r.p.playNamed('drake', 'now', sig());
    await r.p.request('artist', 'drake', 'now', sig());
    await r.p.mix(['drake'], 'now', sig(), 'music');
    expect(top).not.toHaveBeenCalled();
  });

  it('looks up queued list tracks on Plex by title and artist', async () => {
    let bot = false;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const { plex, asked } = plexSource();
    const r = rig({
      plex,
      topTracks: known('Drake', 8),
      run: async (c, a, s) => {
        if (bot) throw new Error(BOT);
        return inner(c, a, s);
      },
    });
    await r.p.request('artist', 'drake', 'now', sig());
    await ticks();
    const later = r.p.upNext[1]!;
    expect(later.ref).toBe('');
    bot = true;
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    r.p.clearQueue();
    (r.p.upNext as Track[]).push(later);
    const before = calls.length;
    const n = await r.p.skip();
    expect(asked).toEqual([`${later.title} Drake`]);
    expect(n).toMatchObject({ source: 'plex' });
    expect(r.p.nowPlaying?.source).toBe('plex');
    expect(calls.length).toBe(before);
  });

  it('a list found just before the bot check goes to Plex too', async () => {
    let n = 0;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const { plex, asked } = plexSource();
    const r = rig({
      plex,
      run: async (c, a, s) => {
        if (a.at(-1)!.includes('watch?v=') && ++n === 1) throw new Error(BOT);
        return inner(c, a, s);
      },
    });
    const res = await r.p.request('album', 'graduation', 'now', sig());
    expect(res).toMatchObject({ ok: true, started: { source: 'plex' } });
    expect(asked).toEqual(['Track 1']);
    expect(r.logged('music track failed')).toEqual([]);
  });

  it('the first caller to trip it logs it, once', async () => {
    const r = rig({
      run: async () => {
        throw new Error(BOT);
      },
    });
    await Promise.all([r.yt.resolve(id('a'), sig()).catch(() => {}), r.yt.resolve(id('b'), sig()).catch(() => {})]);
    expect(r.logged('youtube paused')).toHaveLength(1);
    expect(r.logged('youtube paused')[0]).toMatchObject({ minutes: 30 });
  });

  it('tells a skip there is nothing to reach', async () => {
    let bot = false;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const { plex } = plexSource(() => false);
    const r = rig({
      plex,
      run: async (c, a, s) => {
        if (bot) throw new Error(BOT);
        return inner(c, a, s);
      },
    });
    await r.p.request('album', 'graduation', 'now', sig());
    r.p.clearQueue();
    (r.p.upNext as Track[]).push({ title: 'x', artist: 'y', source: 'youtube', ref: '', id: id('z') });
    bot = true;
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    const control = musicTools(r.p)[1]!;
    expect(await control.run({ action: 'skip' }, sig(), ctx)).toBe(CANT);
    expect(r.p.youtubePaused).toBe(true);
  });

  it('plays a track that already has its stream', async () => {
    let bot = false;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const r = rig({
      run: async (c, a, s) => {
        if (bot) throw new Error(BOT);
        return inner(c, a, s);
      },
    });
    await r.p.request('album', 'graduation', 'now', sig());
    await ticks();
    expect(r.p.upNext[0]!.ref).toBeTruthy();
    bot = true;
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    expect(await r.p.skip()).toMatchObject({ source: 'youtube', id: id('a2') });
  });

  it('stops autoplay and getting the next song ready', async () => {
    let bot = false;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const { plex } = plexSource();
    const r = rig({
      plex,
      autoplay: true,
      run: async (c, a, s) => {
        calls.push(a.at(-1)!);
        if (bot) throw new Error(BOT);
        return inner(c, a, s);
      },
    });
    await r.p.request('song', 'first', 'now', sig());
    await ticks();
    bot = true;
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    calls.length = 0;
    r.logs.length = 0;
    r.p.clearQueue();
    r.p.setAutoplay(true);
    await r.p.request('song', 'second', 'now', sig());
    (r.p.upNext as Track[]).push({ title: 'z', source: 'youtube', ref: '', id: id('z') });
    r.p.shuffle();
    await ticks();
    expect(calls).toEqual([]);
    expect(r.logged('music autoplay failed')).toEqual([]);
  });

  it('play_music says the line itself, for English speakers', async () => {
    const r = rig({ run: blocked([]) });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    const [play] = musicTools(r.p);
    const raw = await play!.run({ request_type: 'song', query: 'thriller' }, sig(), ctx);
    expect(raw).toBe(CANT);
    expect(play!.speak?.({}, raw, ctx)).toBe(CANT);
    const [foreign] = musicTools(r.p, undefined, () => false);
    expect(foreign!.speak?.({}, raw, ctx)).toBeUndefined();
  });
});

describe('Deezer beside the search', () => {
  const twoStep = (known: boolean, list: () => Promise<string[]>, delay?: Promise<unknown>): TopTracks & { titlesAsked: () => number } => {
    let asked = 0;
    const top = async () => {
      await delay;
      return { artist: 'Name', titles: await list(), known };
    };
    return Object.assign(top, {
      titlesAsked: () => asked,
      match: async () => {
        await delay;
        return {
          artist: 'Name',
          known,
          titles: async () => {
            asked++;
            return list();
          },
        };
      },
    });
  };

  it('searches for the song without waiting for Deezer', async () => {
    const d = deferred();
    const r = rig({ topTracks: twoStep(false, async () => [], d.promise) });
    const going = r.p.playNamed('get lucky', 'now', sig());
    await ticks();
    expect(r.calls.some((u) => u.includes('#songs'))).toBe(true);
    expect(r.calls.some((u) => u.includes('watch?v='))).toBe(true); // the resolve doesn't wait either
    d.resolve();
    expect(await going).toMatchObject({ ok: true, started: { id: id('song') } });
  });

  it("doesn't let a song start before Deezer has said what the name is", async () => {
    const d = deferred();
    const r = rig({ topTracks: twoStep(false, async () => [], d.promise) });
    const going = r.p.playNamed('get lucky', 'now', sig());
    await ticks();
    expect(r.events).toEqual([]);
    d.resolve();
    await going;
    expect(r.events.filter((e) => e === 'play')).toHaveLength(1);
  });

  it('a song owes Deezer nothing when the search outlasts it', async () => {
    const gate = deferred();
    const r = rig({ gate: (u) => (u.includes('watch?v=') ? gate.promise : undefined), topTracks: twoStep(false, async () => [], wait(30)) });
    const going = r.p.playNamed('get lucky', 'now', sig());
    await wait(60);
    gate.resolve();
    await going;
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    expect(r.logged('music timing')[0]).toMatchObject({ deezerMs: 0 });
  });

  it('a song owes Deezer the time it was held up by', async () => {
    const r = rig({ topTracks: twoStep(false, async () => [], wait(60)) });
    await r.p.playNamed('get lucky', 'now', sig());
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    expect(r.logged('music timing')[0]!.deezerMs).toBeGreaterThanOrEqual(30);
  });

  it('a small act costs one Deezer call', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ data: [{ id: 1, name: 'Get Lucky', nb_fan: 12 }] }));
    }) as unknown as typeof fetch;
    const r = rig({ topTracks: deezerTopTracks(f) });
    expect(await r.p.playNamed('get lucky', 'now', sig())).toMatchObject({ ok: true, started: { id: id('song') } });
    expect(urls).toHaveLength(1);
  });

  it('a known artist costs both', async () => {
    const top = twoStep(true, async () => songs(30));
    const r = rig({ topTracks: top });
    await r.p.playNamed('drake', 'now', sig());
    expect(top.titlesAsked()).toBe(1);
  });

  it('drops the running resolve once a known artist has enough songs', async () => {
    let aborted = 0;
    let holding = true;
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const run: Runner = async (c, a, s) => {
      const url = a.at(-1)!;
      if (holding && url.includes('watch?v=')) {
        holding = false;
        return new Promise((_, reject) => s.addEventListener('abort', () => (aborted++, reject(new Error('aborted'))), { once: true }));
      }
      return inner(c, a, s);
    };
    const list = deferred<string[]>();
    const r = rig({ run, topTracks: twoStep(true, () => list.promise) });
    const going = r.p.playNamed('drake', 'now', sig());
    await ticks();
    expect(aborted).toBe(0); // not on the name alone: the list comes first
    list.resolve(songs(30));
    expect(await going).toMatchObject({ ok: true, artist: 'Name' });
    expect(aborted).toBe(1);
    expect(r.p.upNext.length).toBe(24);
  });

  it('keeps the song when a known artist has too few songs', async () => {
    const seen: boolean[] = [];
    const calls: string[] = [];
    const inner = fakeYtdlp(calls);
    const run: Runner = async (c, a, s) => {
      const out = await inner(c, a, s);
      seen.push(s.aborted);
      return out;
    };
    const r = rig({ run, topTracks: twoStep(true, async () => songs(3)) });
    expect(await r.p.playNamed('get lucky', 'now', sig())).toMatchObject({ ok: true, started: { id: id('song') } });
    expect(seen).not.toContain(true);
    expect(r.p.upNext).toHaveLength(0);
  });

  it('plays the song when Deezer fails, at either step', async () => {
    const down: TopTracks = Object.assign(async () => undefined, {
      match: async () => {
        throw new Error('down');
      },
    });
    const a = rig({ topTracks: down });
    expect(await a.p.playNamed('get lucky', 'now', sig())).toMatchObject({ ok: true, started: { id: id('song') } });
    expect(a.logged('top songs lookup failed')).toHaveLength(1);
    const b = rig({
      topTracks: twoStep(true, async () => {
        throw new Error('down');
      }),
    });
    expect(await b.p.playNamed('get lucky', 'now', sig())).toMatchObject({ ok: true, started: { id: id('song') } });
  });

  it('works the same with a list that comes in one step', async () => {
    const r = rig({ topTracks: known('Drake') });
    expect(await r.p.playNamed('some drake', 'now', sig())).toMatchObject({ ok: true, artist: 'Drake' });
  });

  it('leaves nothing unhandled when the request is called off', async () => {
    const ctl = new AbortController();
    const top: TopTracks = Object.assign(async () => undefined, {
      match: (_a: string, s: AbortSignal) => new Promise<undefined>((_, reject) => s.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 10), { once: true })),
    });
    const r = rig({ gate: () => new Promise(() => {}), topTracks: top });
    const going = r.p.playNamed('get lucky', 'now', ctl.signal);
    await ticks();
    ctl.abort();
    await expect(going).rejects.toThrow();
    await wait(30);
  });

  it('splits Deezer into who the name is and their songs', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(String(u));
      return new Response(
        JSON.stringify({
          data: String(u).includes('/search/')
            ? [{ id: 2, name: 'Tame Impala', nb_fan: 2_000_000 }]
            : [
                { title: 'Dracula', artist: { id: 2 } },
                { title: 'Dracula (with JENNIE)', artist: { id: 2 } },
                { title: 'Not theirs', artist: { id: 9 } },
              ],
        }),
      );
    }) as unknown as typeof fetch;
    const top = deezerTopTracks(f);
    const m = await top.match!('tame impala', sig());
    expect(m).toMatchObject({ artist: 'Tame Impala', known: true });
    expect(urls).toHaveLength(1);
    expect(await m!.titles(sig())).toEqual(['Dracula']);
    expect(urls).toHaveLength(2);
  });
});

describe('direct YouTube Music search', () => {
  const song = (videoId: string, dur?: string) => ({
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'A title' }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist' }, { text: ' • ' }, { text: 'Album' }, ...(dur ? [{ text: ' • ' }, { text: dur }] : [])] } } },
      ],
    },
  });
  const results = (...items: object[]) => ({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: items } }] } } } }] } } });

  async function api(reply: (req: IncomingMessage, res: ServerResponse) => void) {
    const hits: { method?: string; url?: string; headers: IncomingMessage['headers']; body: Record<string, any> }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (b) => (raw += b));
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
        reply(req, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      url,
      hits,
      close: () => {
        server.closeAllConnections();
        return new Promise((r) => server.close(r));
      },
    };
  }
  const json = (o: unknown) => (_q: IncomingMessage, res: ServerResponse) => res.end(JSON.stringify(o));

  it('asks for songs, and skips yt-dlp for the search', async () => {
    const s = await api(json(results(song(id('hit'), '3:45'))));
    const r = rig({ searchApi: s.url });
    const t = await r.yt.find('get lucky', sig());
    await s.close();
    expect(t).toMatchObject({ id: id('hit'), title: `Title ${id('hit')}` });
    expect(r.calls).toEqual([`https://www.youtube.com/watch?v=${id('hit')}`]);
    expect(s.hits).toHaveLength(1);
    expect(s.hits[0]).toMatchObject({ method: 'POST', url: '/youtubei/v1/search?prettyPrint=false' });
    expect(s.hits[0]!.body).toMatchObject({ query: 'get lucky', params: 'EgWKAQIIAWoKEAoQAxAEEAkQBQ==', context: { client: { clientName: 'WEB_REMIX' } } });
    expect(s.hits[0]!.headers['content-type']).toBe('application/json');
  });

  it('logs that it went this way', async () => {
    const s = await api(json(results(song(id('hit'), '3:45'))));
    const r = rig({ searchApi: s.url });
    await r.p.request('song', 'get lucky', 'now', sig());
    await s.close();
    r.pcms[0]!.write(Buffer.alloc(100));
    await ticks();
    expect(r.logged('music timing')[0]).toMatchObject({ via: 'direct' });
  });

  it('looks up a list track the same way', async () => {
    const s = await api(json(results(song(id('hit'), '3:45'))));
    const r = rig({ searchApi: s.url, topTracks: known('Drake', 6) });
    await r.p.request('artist', 'drake', 'now', sig());
    await ticks();
    await s.close();
    expect(r.p.nowPlaying?.id).toBe(id('hit'));
    expect(r.calls.filter((u) => u.includes('#songs'))).toEqual([]);
  });

  it.each([
    ['a long song', [song(id('echoes'), '23:31'), song(id('cover'), '4:10')]],
    ['one with no duration it can read', [song(id('first')), song(id('cover'), '4:10')]],
  ])('never passes over the top result for a lower one: %s goes to yt-dlp', async (_n, items) => {
    const s = await api(json(results(...items)));
    const r = rig({ searchApi: s.url });
    expect(await r.yt.find('x', sig())).toMatchObject({ id: id('song') });
    await s.close();
    expect(r.calls[0]).toContain('#songs');
  });

  it('skips a top row with no id, as yt-dlp does', async () => {
    const empty = { musicResponsiveListItemRenderer: {} };
    const s = await api(json(results(empty, song(id('good'), '4:10'))));
    const r = rig({ searchApi: s.url });
    expect(await r.yt.find('x', sig())).toMatchObject({ id: id('good') });
    await s.close();
  });

  it('looks at the top three rows, as yt-dlp does', async () => {
    const empty = { musicResponsiveListItemRenderer: {} };
    const s = await api(json(results(empty, empty, empty, song(id('late'), '3:00'))));
    const r = rig({ searchApi: s.url });
    expect(await r.yt.find('x', sig())).toMatchObject({ id: id('song') });
    await s.close();
    expect(r.calls[0]).toContain('#songs');
  });

  it.each([
    ['an error status', (_q: IncomingMessage, res: ServerResponse) => ((res.statusCode = 500), res.end(JSON.stringify(results(song(id('hit'), '3:45')))))],
    ['a page that is not JSON', (_q: IncomingMessage, res: ServerResponse) => res.end('<html>')],
    ['a changed shape', json({ contents: { somethingElse: true } })],
    ['a body of null', json(null)],
    ['a row of null', json(results(null as never))],
    ['columns of the wrong type', json(results({ musicResponsiveListItemRenderer: { playlistItemData: { videoId: id('x') }, flexColumns: [{}, { musicResponsiveListItemFlexColumnRenderer: { text: { runs: 'nope' } } }] } }))],
    ['no results', json(results())],
    ['an id that is not one', json(results(song('short', '3:00')))],
  ])('falls through to yt-dlp on %s', async (_name, reply) => {
    const s = await api(reply);
    const r = rig({ searchApi: s.url });
    expect(await r.yt.find('x', sig())).toMatchObject({ id: id('song') });
    await s.close();
    expect(r.calls[0]).toContain('#songs');
  });

  it('falls through when the connection fails', async () => {
    const s = await api(json({}));
    await s.close();
    const r = rig({ searchApi: s.url });
    expect(await r.yt.find('x', sig())).toMatchObject({ id: id('song') });
  });

  it('gives it 1.5 s, not more', async () => {
    const s = await api(() => {}); // never answers
    const r = rig({ searchApi: s.url });
    const t0 = performance.now();
    expect(await r.yt.find('x', sig())).toMatchObject({ id: id('song') });
    const ms = performance.now() - t0;
    await s.close();
    expect(ms).toBeGreaterThan(1400);
    expect(ms).toBeLessThan(3000);
  });

  it('leaves mixes to ytsearch', async () => {
    const s = await api(json(results(song(id('hit'), '3:45'))));
    const r = rig({ searchApi: s.url });
    await r.yt.find('chill lofi beats', sig());
    await s.close();
    expect(s.hits).toEqual([]);
    expect(r.calls[0]).toBe('ytsearch5:chill lofi beats');
  });

  it('goes quiet with the rest of YouTube after a bot check', async () => {
    const s = await api(json(results(song(id('hit'), '3:45'))));
    const r = rig({
      searchApi: s.url,
      run: async () => {
        throw new Error(BOT);
      },
    });
    await r.yt.resolve(id('x'), sig()).catch(() => {});
    await expect(r.yt.find('x', sig())).rejects.toThrow(/paused/i);
    await s.close();
    expect(s.hits).toEqual([]);
  });

  it('never runs unless it is given the address', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    const r = rig();
    await r.yt.find('x', sig());
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });

  it('stops when the request is called off', async () => {
    const s = await api(() => {});
    const r = rig({ searchApi: s.url });
    const ctl = new AbortController();
    const going = r.yt.find('x', ctl.signal);
    await wait(30);
    ctl.abort();
    await expect(going).rejects.toThrow();
    await s.close();
    expect(r.calls).toEqual([]);
  });
});

describe('the duck around a requested song', () => {
  it('ends when the song starts, counted from before the lookup', async () => {
    let lookedAt = 0;
    const r = rig({
      gate: (u) => {
        if (u.includes('watch?v=')) lookedAt = performance.now();
        return undefined;
      },
    });
    const before = performance.now();
    await r.p.request('song', 'round 2', 'now', sig());
    expect(r.ducks).toHaveLength(1);
    expect(r.ducks[0]).toBeGreaterThanOrEqual(before);
    expect(r.ducks[0]).toBeLessThanOrEqual(lookedAt);
  });

  it.each([
    ['a song', (r: ReturnType<typeof rig>) => r.p.play('x', 'now', sig())],
    ['a bare name', (r: ReturnType<typeof rig>) => r.p.playNamed('x', 'now', sig())],
    ['a mix', (r: ReturnType<typeof rig>) => r.p.mix(['drake'], 'now', sig(), 'music')],
    ['an album', (r: ReturnType<typeof rig>) => r.p.request('album', 'x', 'now', sig())],
  ])('ends for %s', async (_n, go) => {
    const r = rig({ topTracks: known('Drake') });
    await go(r);
    expect(r.ducks).toHaveLength(1);
  });

  it('ends for a skip', async () => {
    const r = rig();
    await r.p.request('album', 'x', 'now', sig());
    await r.p.skip();
    expect(r.ducks).toHaveLength(2);
  });

  it('stays for a song that came up by itself', async () => {
    const r = rig();
    await r.p.request('album', 'x', 'now', sig());
    r.finishLast();
    await ticks();
    expect(r.events.filter((e) => e === 'play')).toHaveLength(2);
    expect(r.ducks).toHaveLength(1);
  });

  it('stays for a song that only joined the queue', async () => {
    const r = rig();
    await r.p.request('album', 'x', 'now', sig());
    await r.p.request('song', 'y', 'queue', sig());
    expect(r.ducks).toHaveLength(1);
  });
});

describe('returning at the URL line', () => {
  const stub = (script: string): Runner => (_c, _a, signal, done) => runProgram(process.execPath, ['-e', script], signal, done);

  it('has the stream before the program exits, and lets it exit by itself', async () => {
    const mark = join(mkdtempSync(join(tmpdir(), 'exit-')), 'done');
    const script = `process.stdout.write('A - B\\tA\\t100\\thttps://x/y\\n'); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(mark)}, 'x'), 500);`;
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp' }, stub(script));
    const t = await yt.resolve(id('x'), sig());
    expect(t).toMatchObject({ ref: 'https://x/y', id: id('x') });
    expect(existsSync(mark)).toBe(false);
    await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 4000, interval: 25 });
  });

  it('waits for the whole line', async () => {
    const script = `process.stdout.write('A - B\\tA\\t100\\thttps://x/y'); setTimeout(() => process.stdout.write('zzz\\n'), 200);`;
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp' }, stub(script));
    expect(await yt.resolve(id('x'), sig())).toMatchObject({ ref: 'https://x/yzzz' });
  });

  it('still fails when no URL comes', async () => {
    const script = `console.error('ERROR: gone'); process.exit(1);`;
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp' }, stub(script));
    await expect(yt.resolve(id('x'), sig())).rejects.toThrow('ERROR: gone');
  });

  it('still reads to the end for everything else', async () => {
    const out = await runProgram(process.execPath, ['-e', `console.log('one'); setTimeout(() => console.log('two'), 100);`], sig());
    expect(out).toContain('two');
  });
});

describe('getting a track ready', () => {
  const list = (): Track => ({ title: 'x', source: 'youtube', ref: '', id: id('x') });
  const named = (): Track => ({ title: 'x', artist: 'y', source: 'youtube', ref: '', query: 'x y' });

  it('a second caller joins the lookup already running', async () => {
    const gate = deferred();
    const r = rig({ gate: () => gate.promise });
    const t = list();
    const a = r.yt.prepare(t, sig());
    await ticks();
    const b = r.yt.prepare(t, sig());
    await ticks();
    gate.resolve();
    await Promise.all([a, b]);
    expect(r.calls).toEqual([`https://www.youtube.com/watch?v=${id('x')}`]);
    expect(t.ref).toBeTruthy();
  });

  it('a skip during prepare needs no second lookup', async () => {
    const gate = deferred();
    let open = false;
    const r = rig({ gate: (u) => (open && u.includes(id('a2')) ? gate.promise : undefined) });
    await r.p.request('album', 'x', 'now', sig());
    // Back to a track that isn't ready, with its lookup held.
    r.p.clearQueue();
    open = true;
    (r.p.upNext as Track[]).push({ title: 'b', source: 'youtube', ref: '', id: id('a2') });
    r.p.shuffle(); // gets it ready
    await ticks();
    const skipping = r.p.skip();
    await ticks();
    gate.resolve();
    expect(await skipping).toMatchObject({ id: id('a2') });
    expect(r.calls.filter((u) => u.endsWith(`v=${id('a2')}`))).toHaveLength(2); // once when the album was found ahead, once here
  });

  it('a lookup for a named track is shared too', async () => {
    const gate = deferred();
    const r = rig({ gate: () => gate.promise });
    const t = named();
    const a = r.yt.prepare(t, sig());
    await ticks();
    const b = r.yt.prepare(t, sig());
    gate.resolve();
    await Promise.all([a, b]);
    expect(r.calls.filter((u) => u.includes('#songs'))).toHaveLength(1);
  });

  it('tries again by itself when the shared lookup fails', async () => {
    let n = 0;
    const gate = deferred();
    const run: Runner = async (_c, a) => {
      n++;
      if (n === 1) {
        await gate.promise;
        throw new Error('first failed');
      }
      return `A - B\tA\t100\thttps://x/${a.at(-1)!.slice(-3)}\n`;
    };
    const r = rig({ run });
    const t = list();
    const a = r.yt.prepare(t, sig());
    await ticks();
    const b = r.yt.prepare(t, sig());
    gate.resolve();
    await expect(a).rejects.toThrow('first failed');
    await b;
    expect(n).toBe(2);
    expect(t.ref).toContain('https://x/');
  });

  it('a failure clears the way for the next try', async () => {
    let n = 0;
    const run: Runner = async () => {
      if (++n === 1) throw new Error('nope');
      return 'A - B\tA\t100\thttps://x/y\n';
    };
    const r = rig({ run });
    const t = list();
    await expect(r.yt.prepare(t, sig())).rejects.toThrow('nope');
    await r.yt.prepare(t, sig());
    expect(t.ref).toBe('https://x/y');
  });

  it("gives up on a shared lookup when its own wait is over, without ending the other's", async () => {
    const gate = deferred();
    const r = rig({ gate: () => gate.promise });
    const t = list();
    const a = r.yt.prepare(t, sig());
    await ticks();
    const ctl = new AbortController();
    const b = r.yt.prepare(t, ctl.signal);
    ctl.abort();
    await expect(b).rejects.toBeDefined();
    gate.resolve();
    await a;
    expect(t.ref).toBeTruthy();
  });

  it('a caller already cancelled does not join', async () => {
    const gate = deferred();
    const r = rig({ gate: () => gate.promise });
    const t = list();
    const a = r.yt.prepare(t, sig());
    await ticks();
    await expect(r.yt.prepare(t, AbortSignal.abort())).rejects.toBeDefined();
    gate.resolve();
    await a;
  });

  const expiring = (url: (expire: number) => string, leftMs: number, nowMs: number): Track => ({ ...list(), ref: url(Math.round((nowMs + leftMs) / 1000)) });
  const query = (e: number) => `https://rr1.example/videoplayback?expire=${e}&id=1`;
  const inPath = (e: number) => `https://rr1.example/videoplayback/expire/${e}/id/1`;

  it.each([
    ['a query', query],
    ['a path', inPath],
  ])('looks again when %s says the URL is close to expiring', async (_n, url) => {
    const now = 1_800_000_000_000;
    const r = rig({ now: () => now });
    const t = expiring(url, 19 * 60_000, now);
    await r.yt.prepare(t, sig());
    expect(r.calls).toHaveLength(1);
    expect(t.ref).toBe(`https://stream/${id('x')}`);
  });

  it('keeps a URL with time left', async () => {
    const now = 1_800_000_000_000;
    const r = rig({ now: () => now });
    const t = expiring(query, 21 * 60_000, now);
    const before = t.ref;
    await r.yt.prepare(t, sig());
    expect(r.calls).toEqual([]);
    expect(t.ref).toBe(before);
  });

  it('keeps a URL with no expiry, or one it cannot look up again', async () => {
    const now = 1_800_000_000_000;
    const r = rig({ now: () => now });
    const plain: Track = { ...list(), ref: 'https://cf-media.example/full.mp3' };
    await r.yt.prepare(plain, sig());
    const link: Track = { title: 'x', source: 'youtube', ref: query(1) };
    await r.yt.prepare(link, sig());
    expect(r.calls).toEqual([]);
    expect(await r.yt.open(link, sig())).toEqual({ url: query(1) });
  });
});

describe('a stream that stalls', () => {
  it('tells ffmpeg to give up on a dead connection', () => {
    const a = inputArgs({ url: 'https://x/y' });
    expect(a.slice(a.indexOf('-rw_timeout'), a.indexOf('-rw_timeout') + 2)).toEqual(['-rw_timeout', '15000000']);
    expect(a.indexOf('-rw_timeout')).toBeLessThan(a.indexOf('-i'));
    expect(a.at(-1)).toBe('https://x/y');
    expect(a).toContain('-protocol_whitelist');
    expect(inputArgs({ stream: Readable.from([]) })).toEqual(['-i', 'pipe:0']);
  });

  async function playing(o: RigOptions = {}) {
    const r = rig({ stallMs: 80, ...o });
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    return r;
  }

  it('ends a track that delivers nothing more, and moves on', async () => {
    const r = await playing();
    r.pcms[0]!.write(Buffer.alloc(100));
    await vi.waitFor(() => expect(r.killed).toContain(0), { timeout: 2000, interval: 10 });
    expect(r.logged('music stalled')).toHaveLength(1);
  });

  it('ends a track that never delivered anything', async () => {
    const r = await playing();
    await vi.waitFor(() => expect(r.killed).toContain(0), { timeout: 2000, interval: 10 });
  });

  it('leaves a track alone while audio keeps coming', async () => {
    const r = await playing({ stallMs: 150 });
    for (let i = 0; i < 8; i++) {
      r.pcms[0]!.write(Buffer.alloc(100));
      await wait(40);
    }
    expect(r.killed).toEqual([]);
  });

  it('leaves a paused song alone', async () => {
    const r = await playing();
    r.out.musicPaused = true;
    await wait(250);
    expect(r.killed).toEqual([]);
    r.out.musicPaused = false;
    await vi.waitFor(() => expect(r.killed).toContain(0), { timeout: 2000, interval: 10 });
  });

  it('leaves a stream the mixer is holding back alone', async () => {
    const r = await playing();
    r.pcms[0]!.pause(); // what the mixer does when it has enough
    await wait(250);
    expect(r.killed).toEqual([]);
  });

  it('stops watching a track once it is over', async () => {
    const r = await playing();
    await r.p.skip();
    await r.p.skip();
    r.p.clearQueue();
    r.finishLast();
    await wait(250);
    expect(r.logged('music stalled')).toEqual([]);
  });
});

describe('starting a track', () => {
  it('leaves the song playing until the new one is ready', async () => {
    const gate = deferred();
    let hold = false;
    const r = rig({ topTracks: known('Drake'), gate: (u) => (hold && u.includes('watch?v=') ? gate.promise : undefined) });
    await r.p.request('song', 'old', 'now', sig());
    r.events.length = 0;
    hold = true;
    const going = r.p.request('artist', 'drake', 'now', sig());
    await ticks();
    expect(r.events).toEqual([]);
    hold = false;
    gate.resolve();
    await going;
    expect(r.events.filter((e) => !e.startsWith('decode'))).toEqual(['stop', 'play']);
  });

  it('a request called off during the lookup changes nothing', async () => {
    const r = rig({ topTracks: known('Drake'), gate: (u) => (u.includes('#songs') ? new Promise(() => {}) : undefined) });
    await r.p.request('album', 'graduation', 'now', sig());
    const ids = r.p.upNext.map((t) => t.id);
    const now = r.p.nowPlaying;
    r.events.length = 0;
    const ctl = new AbortController();
    const going = r.p.request('artist', 'drake', 'now', ctl.signal);
    await ticks();
    ctl.abort();
    await expect(going).rejects.toThrow();
    expect(r.events).toEqual([]);
    expect(r.p.nowPlaying).toBe(now);
    expect(r.p.upNext.map((t) => t.id)).toEqual(ids);
  });

  it('a list that will not play leaves the song and queue alone', async () => {
    let down = false;
    const r = rig({ topTracks: known('Drake', 6), gate: (u) => (down ? Promise.reject(new Error('down')) : u === 'never' ? undefined : undefined) });
    await r.p.request('album', 'graduation', 'now', sig());
    const ids = r.p.upNext.map((t) => t.id);
    r.events.length = 0;
    down = true;
    expect(await r.p.request('artist', 'drake', 'now', sig())).toMatchObject({ ok: false });
    expect(r.events).toEqual([]);
    expect(r.p.upNext.map((t) => t.id)).toEqual(ids);
  });

  it('stop during the lookup means no music', async () => {
    const gate = deferred();
    let hold = false;
    const r = rig({ gate: (u) => (hold && u.includes('watch?v=') ? gate.promise : undefined) });
    await r.p.request('song', 'old', 'now', sig());
    hold = true;
    const going = r.p.request('album', 'graduation', 'now', sig());
    await ticks();
    r.p.stop();
    r.events.length = 0;
    hold = false;
    gate.resolve();
    await going;
    expect(r.events).toEqual([]);
    expect(r.p.upNext).toEqual([]);
  });

  it('stop during a song search means no music either', async () => {
    const gate = deferred();
    const r = rig({ gate: (u) => (u.includes('#songs') ? gate.promise : undefined) });
    const going = r.p.play('x', 'now', sig());
    await ticks();
    r.p.stop();
    gate.resolve();
    expect(await going).toEqual({ ok: false, message: 'Stopped.' });
    expect(r.events).toEqual([]);
  });

  it('a song that was asked for while the next one was looked up stays', async () => {
    const gate = deferred();
    const r = rig({ gate: (u) => (u.includes(id('a2')) ? gate.promise : undefined) });
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    const skipping = r.p.skip();
    await ticks();
    await r.p.request('video', 'wanted', 'now', sig());
    gate.resolve();
    expect(await skipping).toBeUndefined();
    expect(r.p.nowPlaying?.id).toBe(id('vid'));
  });

  /** A rig whose second album track can't be found, once `failing` lets go. */
  function failingNext(o: RigOptions = {}) {
    const gate = deferred();
    const calls: string[] = [];
    const yt = fakeYtdlp(calls);
    const run: Runner = async (c, args, signal, enough) => {
      if (args.at(-1)!.includes(id('a2'))) {
        await until(gate.promise, signal);
        throw new Error('ERROR: Video unavailable');
      }
      return yt(c, args, signal, enough);
    };
    return { gate, r: rig({ ...o, run }) };
  }

  it('a stop lands on a next song that then fails: no more music, not even radio', async () => {
    const { gate, r } = failingNext({ autoplay: true });
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    r.finishLast(); // on to the second, which is still being looked up
    await ticks();
    r.p.stop();
    r.events.length = 0;
    gate.resolve();
    await ticks(12);
    expect(r.events).toEqual([]);
    expect(r.p.upNext).toEqual([]);
  });

  it('a next song that fails leaves alone what was asked for meanwhile', async () => {
    const { gate, r } = failingNext();
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    r.finishLast();
    await ticks();
    await r.p.request('song', 'wanted', 'now', sig());
    await r.p.request('video', 'after that', 'queue', sig());
    gate.resolve();
    await ticks(12);
    expect(r.p.nowPlaying?.id).toBe(id('song'));
    expect(r.p.upNext.map((t) => t.id)).toEqual([id('vid')]);
  });

  it('a skip whose next song fails leaves alone what was asked for meanwhile', async () => {
    const { gate, r } = failingNext();
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    const skipping = r.p.skip();
    await ticks();
    await r.p.request('song', 'wanted', 'now', sig());
    await r.p.request('video', 'after that', 'queue', sig());
    gate.resolve();
    expect(await skipping).toBeUndefined();
    await ticks();
    expect(r.p.nowPlaying?.id).toBe(id('song'));
    expect(r.p.upNext.map((t) => t.id)).toEqual([id('vid')]);
  });

  it('a skip called off during its lookup starts nothing: the stop that did it won', async () => {
    const gate = deferred();
    let hold = false;
    const r = rig({ gate: (u) => (hold && u.includes(id('a3')) ? gate.promise : undefined) });
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    hold = true;
    await r.p.skip(); // a2 plays, and a3 is being looked up ahead of its turn
    const stop = new AbortController();
    const skipping = r.p.skip(stop.signal);
    await ticks();
    r.events.length = 0;
    stop.abort();
    await ticks();
    hold = false;
    gate.resolve();
    expect(await skipping).toBeUndefined();
    await ticks(12);
    expect(r.events).toEqual([]);
  });

  it('a skip called off while radio is fetched starts nothing either', async () => {
    const gate = deferred();
    const r = rig({ autoplay: true, gate: (u) => (u.includes('RDAMVM') ? gate.promise : undefined) });
    await r.p.request('song', 'first', 'now', sig());
    const stop = new AbortController();
    const skipping = r.p.skip(stop.signal);
    await ticks();
    r.events.length = 0;
    stop.abort();
    gate.resolve();
    expect(await skipping).toBeUndefined();
    await ticks();
    expect(r.events).toEqual([]);
  });

  it('music_control hands its signal to the skip', async () => {
    const gate = deferred();
    let hold = false;
    const r = rig({ gate: (u) => (hold && u.includes(id('a3')) ? gate.promise : undefined) });
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    hold = true;
    await r.p.skip();
    const stop = new AbortController();
    const skipping = musicTools(r.p)[1]!.run({ action: 'skip' }, stop.signal, ctx);
    await ticks();
    r.events.length = 0;
    stop.abort();
    await ticks();
    hold = false;
    gate.resolve();
    await skipping;
    await ticks(12);
    expect(r.events).toEqual([]);
  });

  it('a next song that fails with nothing newer still moves on to the one after', async () => {
    const { gate, r } = failingNext();
    await r.p.request('album', 'x', 'now', sig());
    await ticks();
    r.finishLast();
    gate.resolve();
    await ticks(12);
    expect(r.p.nowPlaying?.id).toBe(id('a3'));
  });

  it('a list queued before a stop stays out of what plays after it', async () => {
    const gate = deferred();
    const r = rig({ gate: (u) => (u.includes('#albums') ? gate.promise : undefined) });
    await r.p.request('song', 'old', 'now', sig());
    const going = r.p.request('album', 'graduation', 'queue', sig());
    await ticks();
    r.p.stop();
    await r.p.request('video', 'new', 'now', sig());
    gate.resolve();
    expect(await going).toEqual({ ok: false, message: 'Stopped.' });
    expect(r.p.upNext).toEqual([]);
  });

  it('an album asked for during a radio lookup is not skipped ahead', async () => {
    const gate = deferred();
    const r = rig({ autoplay: true, gate: (u) => (u.includes('RDAMVM') ? gate.promise : undefined) });
    await r.p.request('song', 'first', 'now', sig());
    r.finishLast();
    await ticks();
    await r.p.request('album', 'x', 'now', sig());
    expect(r.p.nowPlaying?.id).toBe(id('a1'));
    gate.resolve();
    await ticks();
    expect(r.p.nowPlaying?.id).toBe(id('a1'));
    expect(r.p.upNext.map((t) => t.id)).toEqual([id('a2'), id('a3')]);
  });

  it('a skip waiting on radio leaves alone what was asked for meanwhile', async () => {
    const gate = deferred();
    const r = rig({ autoplay: true, gate: (u) => (u.includes('RDAMVM') ? gate.promise : undefined) });
    await r.p.request('song', 'first', 'now', sig());
    const skipping = r.p.skip();
    await ticks();
    await r.p.request('album', 'x', 'now', sig());
    gate.resolve();
    expect(await skipping).toBeUndefined();
    expect(r.p.nowPlaying?.id).toBe(id('a1'));
    expect(r.p.upNext.map((t) => t.id)).toEqual([id('a2'), id('a3')]);
  });

  it('a song that ends during a radio lookup does not replace what was asked for next', async () => {
    const gate = deferred();
    const r = rig({ autoplay: true, gate: (u) => (u.includes('RDAMVM') ? gate.promise : undefined) });
    await r.p.request('song', 'first', 'now', sig());
    r.finishLast();
    await ticks();
    await r.p.request('video', 'second', 'now', sig());
    const second = r.p.nowPlaying!;
    expect(second.id).toBe(id('vid'));
    const plays = r.events.filter((e) => e === 'play').length;
    gate.resolve();
    await ticks();
    expect(r.events.filter((e) => e === 'play')).toHaveLength(plays);
    expect(r.p.nowPlaying).toBe(second);
  });

  it("drops the old song's radio when a new song replaces it", async () => {
    const gate = deferred();
    const r = rig({ autoplay: true, gate: (u) => (u.includes(`RDAMVM${id('song')}`) ? gate.promise : undefined) });
    await r.p.request('song', 'first', 'now', sig());
    await ticks();
    await r.p.request('video', 'second', 'now', sig());
    gate.resolve();
    await ticks();
    expect(r.p.upNext.map((t) => t.title).filter((t) => t.startsWith('Radio'))).toEqual([]);
  });

  it('an artist with few known songs starts before its radio is back', async () => {
    const gate = deferred();
    const r = rig({ autoplay: true, gate: (u) => (u.includes('RDAMVM') ? gate.promise : undefined) });
    const going = r.p.request('artist', 'small act', 'now', sig());
    await wait(100);
    expect(r.events.filter((e) => e === 'play')).toHaveLength(1); // radio still out
    expect(await going).toMatchObject({ ok: true, started: { id: id('song') } });
    gate.resolve();
    await ticks();
    expect(r.p.upNext.length).toBeGreaterThan(1);
  });

  it('that radio still comes with autoplay off', async () => {
    const r = rig({ autoplay: false });
    await r.p.request('artist', 'small act', 'now', sig());
    await ticks();
    expect(r.calls.some((u) => u.includes('RDAMVM'))).toBe(true);
    expect(r.p.upNext.length).toBeGreaterThan(1);
  });
});

describe('"play X next"', () => {
  async function radioPlaying(o: RigOptions = {}) {
    const r = rig({ autoplay: true, ...o });
    await r.p.request('song', 'first', 'now', sig());
    await ticks();
    expect(r.p.upNext.length).toBe(3);
    return r;
  }

  it('comes before the radio songs', async () => {
    const r = await radioPlaying();
    const res = await r.p.play('wanted', 'queue', sig());
    expect(res).toMatchObject({ ok: true, queued: 1 });
    expect(r.p.upNext[0]!.title).toBe(`Title ${id('song')}`);
    expect(r.p.upNext[0]!.auto).toBeFalsy();
    expect(r.p.upNext.slice(1).every((t) => t.auto)).toBe(true);
  });

  it('a list comes before them too, in order', async () => {
    const r = await radioPlaying();
    await r.p.request('album', 'graduation', 'queue', sig());
    expect(r.p.upNext.slice(0, 3).map((t) => t.id)).toEqual([id('a1'), id('a2'), id('a3')]);
  });

  it('two requests keep their order', async () => {
    const r = await radioPlaying();
    await r.p.request('album', 'graduation', 'queue', sig());
    await r.p.request('video', 'second', 'queue', sig());
    expect(r.p.upNext[3]!.id).toBe(id('vid'));
  });

  it('gets ready at once when it is next', async () => {
    const r = await radioPlaying();
    r.calls.length = 0;
    await r.p.request('album', 'graduation', 'queue', sig());
    await ticks();
    expect(r.calls).toContain(`https://www.youtube.com/watch?v=${id('a1')}`);
  });

  it('a later refill lands behind it', async () => {
    const r = await radioPlaying();
    r.p.clearQueue();
    await r.p.request('video', 'wanted', 'queue', sig());
    r.p.setAutoplay(true);
    await ticks();
    expect(r.p.upNext.length).toBeGreaterThan(1);
    expect(r.p.upNext[0]!.id).toBe(id('vid'));
    expect(r.p.upNext.slice(1).every((t) => t.auto)).toBe(true);
  });

  it("radio songs don't fill the queue", async () => {
    const r = await radioPlaying({ maxQueue: 3 });
    expect(await r.p.play('wanted', 'queue', sig())).toMatchObject({ ok: true });
    expect(await r.p.request('album', 'graduation', 'queue', sig())).toMatchObject({ ok: true, added: 2 });
    expect(await r.p.play('more', 'queue', sig())).toEqual({ ok: false, message: 'The queue is full.' });
  });

  it("comes before an artist's shuffle as well", async () => {
    const r = rig({ topTracks: known('Drake') });
    await r.p.request('artist', 'drake', 'now', sig());
    const res = await r.p.play('wanted', 'queue', sig());
    expect(res).toMatchObject({ ok: true, queued: 1 });
  });

  it('stays behind an album someone asked for', async () => {
    const r = rig();
    await r.p.request('album', 'graduation', 'now', sig());
    const res = await r.p.play('wanted', 'queue', sig());
    expect(res).toMatchObject({ ok: true, queued: 3 });
  });
});

describe('autoplay after a repeat', () => {
  const radios = (r: ReturnType<typeof rig>) => r.calls.filter((u) => u.includes('RDAMVM')).length;

  it('works again for a song played, stopped and played again', async () => {
    const r = rig({ autoplay: true });
    await r.p.request('song', 'fav', 'now', sig());
    await ticks();
    expect(radios(r)).toBe(1);
    r.p.stop();
    await r.p.request('song', 'fav', 'now', sig());
    await ticks();
    expect(radios(r)).toBe(2);
  });

  it('works for a song played twice in a row', async () => {
    const r = rig({ autoplay: true });
    await r.p.play('fav', 'now', sig());
    await ticks();
    await r.p.play('fav', 'now', sig());
    await ticks();
    expect(radios(r)).toBe(2);
  });

  it('works for a favourite with another song between', async () => {
    const r = rig({ autoplay: true });
    await r.p.request('song', 'fav', 'now', sig());
    await ticks();
    await r.p.request('video', 'other', 'now', sig());
    await ticks();
    await r.p.request('song', 'fav', 'now', sig());
    await ticks();
    expect(radios(r)).toBeGreaterThanOrEqual(3);
  });

  it('works when a list starts over on the same song', async () => {
    const r = rig({ autoplay: true });
    await r.p.request('video', 'x', 'now', sig());
    await ticks();
    await r.p.request('video', 'x', 'now', sig());
    await ticks();
    expect(radios(r)).toBe(2);
  });

  it('still seeds one song only once while its list runs', async () => {
    const r = rig({ autoplay: true });
    await r.p.request('song', 'fav', 'now', sig());
    await ticks();
    r.p.clearQueue();
    r.p.setAutoplay(true);
    await ticks();
    expect(radios(r)).toBe(1);
  });
});

describe('music_control speaks for itself', () => {
  const speak = (action: string, raw: string, english = true) => musicTools(rig().p, undefined, () => english)[1]!.speak?.({ action }, raw, ctx);

  it.each([
    ['pause', 'Paused.', 'Paused.'],
    ['resume', 'Resumed.', 'Resumed.'],
    ['stop', 'Music stopped.', 'Music stopped.'],
    ['louder', 'Music volume 70%.', 'Music volume 70 percent.'],
    ['shuffle', 'Shuffled 4 songs.', 'Shuffled 4 songs.'],
    ['clear_queue', 'Cleared 4 songs from the queue.', 'Cleared 4 songs from the queue.'],
    ['autoplay_on', 'Autoplay on.', 'Autoplay on.'],
    ['skip', 'Skipped. Nothing else is queued.', 'Skipped. Nothing else is queued.'],
  ])('%s is a confirmation', (action, raw, line) => {
    expect(speak(action, raw)).toBe(line);
  });

  it("a skip's next song starting is the answer: its title isn't read out", () => {
    expect(speak('skip', 'Skipped. Now playing Some Song by Someone.')).toBe('');
  });

  it.each([
    ['pause', 'Nothing is playing.'],
    ['resume', 'Nothing is paused.'],
    ['skip', 'Nothing is playing.'],
    ['stop', 'Nothing is playing.'],
    ['shuffle', 'Shuffled 0 songs.'],
    ['clear_queue', 'Cleared 0 songs from the queue.'],
    ['pause', "Music isn't available here."],
  ])('%s with nothing to do goes to the model', (action, raw) => {
    expect(speak(action, raw)).toBeUndefined();
  });

  it('status goes to the model', () => {
    expect(speak('status', 'Playing: x. Autoplay on.')).toBeUndefined();
    expect(speak('status', 'Paused: x. Autoplay on.')).toBeUndefined();
  });

  it('non-English speakers get the model', () => {
    expect(speak('pause', 'Paused.', false)).toBeUndefined();
  });

  it('counts one song properly, now that it is said word for word', async () => {
    const r = rig();
    await r.p.request('album', 'x', 'now', sig());
    (r.p.upNext as Track[]).length = 1;
    const control = musicTools(r.p)[1]!;
    expect(await control.run({ action: 'shuffle' }, sig(), ctx)).toBe('Shuffled 1 song.');
    expect(await control.run({ action: 'clear_queue' }, sig(), ctx)).toBe('Cleared 1 song from the queue.');
  });
});

describe('a PC opening a YouTube video', () => {
  it('finds the id without a resolve', async () => {
    const r = rig();
    expect(await r.yt.videoId('some video', sig())).toBe(id('vid'));
    expect(r.calls).toEqual(['ytsearch5:some video']);
  });

  it('video() still resolves it', async () => {
    const r = rig();
    expect(await r.yt.video('some video', sig())).toMatchObject({ id: id('vid'), ref: `https://stream/${id('vid')}` });
  });
});
