import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { classifyMusic } from '../src/conversation/intents.js';
import { cleanTitle, MusicPlayer, type MusicOutput, type MusicSource, parseYtdlp, pickVideo, PlexMusicSource, type Track, YoutubeSource } from '../src/features/music.js';
import type { PlaybackHandle } from '../src/core/interfaces.js';

const quiet = { info() {}, warn() {} };

describe('music titles', () => {
  it('cleans YouTube titles for speaking', () => {
    expect(cleanTitle('Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers', 'Daft Punk')).toEqual({ title: 'Get Lucky', artist: 'Daft Punk' });
    expect(cleanTitle('Kendrick Lamar "HUMBLE." (AUDIO)', 'KendrickLamarVEVO')).toEqual({ title: 'HUMBLE.', artist: 'Kendrick Lamar' });
    expect(cleanTitle('HUMBLE.', 'Kendrick Lamar - Topic')).toEqual({ title: 'HUMBLE.', artist: 'Kendrick Lamar' });
    expect(cleanTitle('lofi hip hop radio 📚 beats to relax/study to', 'Lofi Girl')).toEqual({ title: 'lofi hip hop radio 📚 beats to relax/study to', artist: 'Lofi Girl' });
    expect(cleanTitle('Blinding Lights [Official Music Video]', 'TheWeekndVEVO')).toEqual({ title: 'Blinding Lights', artist: 'TheWeeknd' });
  });

  it('reads the yt-dlp print line', () => {
    const t = parseYtdlp('Daft Punk - Get Lucky (Official Audio)\tDaft Punk\t249\thttps://rr1.example/videoplayback?x=1\n');
    expect(t).toMatchObject({ title: 'Get Lucky', artist: 'Daft Punk', durationS: 249, source: 'youtube', ref: 'https://rr1.example/videoplayback?x=1' });
    expect(parseYtdlp('Round 2\tJaeyBxrd, JaeyBxrd\t128\thttps://x/y')!.artist).toBe('JaeyBxrd');
    expect(parseYtdlp('')).toBeUndefined();
    expect(parseYtdlp('Live stream\tSomeone\tNA\thttps://x/live')!.durationS).toBeUndefined();
  });

  it('finds songs in the YouTube Music catalog, mixes on YouTube', async () => {
    const calls: string[][] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', node: '/n' }, async (_c, args) => {
      calls.push(args);
      const target = args.at(-1)!;
      if (target.startsWith('https://music.youtube.com/search')) return 'AAAAAAAAAAA\n';
      if (target.startsWith('ytsearch5:')) return 'BBBBBBBBBBB\t15718\tNA\nCCCCCCCCCCC\tNA\tis_live\n';
      return 'A - B\tA\t100\thttps://x/y\n';
    });
    const t = await yt.find('get lucky', AbortSignal.timeout(1000));
    expect(calls[0]!.at(-1)).toBe('https://music.youtube.com/search?q=get%20lucky#songs');
    expect(calls[1]!.at(-1)).toBe('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    expect(t).toMatchObject({ title: 'B', artist: 'A', ref: 'https://x/y' });
    expect(calls[0]).toContain('--js-runtimes');
    expect(calls[0]).toContain('--no-cache-dir');
    calls.length = 0;
    await yt.find('chill lofi beats', AbortSignal.timeout(1000));
    expect(calls[0]!.at(-1)).toBe('ytsearch5:chill lofi beats'); // mixes skip the song catalog
    expect(calls[1]!.at(-1)).toBe('https://www.youtube.com/watch?v=BBBBBBBBBBB'); // long is fine for a mix
  });

  it('never picks hour-long uploads or live streams for a song', () => {
    expect(pickVideo('BBBBBBBBBBB\t15718\tNA\nCCCCCCCCCCC\tNA\tis_live\nDDDDDDDDDDD\t214\tnot_live\n', false)).toBe('DDDDDDDDDDD');
    expect(pickVideo('BBBBBBBBBBB\t15718\tNA\n', false)).toBeUndefined();
    expect(pickVideo('BBBBBBBBBBB\t15718\tNA\n', true)).toBe('BBBBBBBBBBB');
  });
});

describe('music commands', () => {
  it('recognizes play, queue and source', () => {
    expect(classifyMusic('Hey Adrian, play Get Lucky by Daft Punk')).toEqual({ kind: 'play', query: 'Get Lucky by Daft Punk', mode: 'now' });
    expect(classifyMusic('can you put on some lofi please')).toEqual({ kind: 'play', query: 'some lofi', mode: 'now' });
    expect(classifyMusic('queue up humble')).toEqual({ kind: 'play', query: 'humble', mode: 'queue' });
    expect(classifyMusic('play sicko mode next')).toEqual({ kind: 'play', query: 'sicko mode', mode: 'queue' });
    expect(classifyMusic('add blinding lights to the queue')).toEqual({ kind: 'play', query: 'blinding lights', mode: 'queue' });
    expect(classifyMusic('play thriller from plex')).toEqual({ kind: 'play', query: 'thriller', mode: 'now', source: 'plex' });
  });

  it('leaves games and other things alone', () => {
    expect(classifyMusic('play trivia')).toBeUndefined();
    expect(classifyMusic('play a game with us')).toBeUndefined();
    expect(classifyMusic('play would you rather')).toBeUndefined();
    expect(classifyMusic('add milk to my list')).toBeUndefined();
    expect(classifyMusic('what is the capital of france')).toBeUndefined();
    expect(classifyMusic('play minecraft with me')).toBeUndefined();
  });

  it('recognizes controls', () => {
    expect(classifyMusic('skip')).toEqual({ kind: 'control', action: 'skip' });
    expect(classifyMusic('Adrian, next song')).toEqual({ kind: 'control', action: 'skip' });
    expect(classifyMusic('pause the music')).toEqual({ kind: 'control', action: 'pause' });
    expect(classifyMusic('keep playing')).toEqual({ kind: 'control', action: 'resume' });
    expect(classifyMusic('stop the music')).toEqual({ kind: 'control', action: 'stop' });
    expect(classifyMusic("what's playing?")).toEqual({ kind: 'control', action: 'status' });
    expect(classifyMusic('what song is this')).toEqual({ kind: 'control', action: 'status' });
  });
});

describe('plex music', () => {
  it('finds a track and streams it with the token in a header', async () => {
    const seen: { url: string; token?: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, token: (init.headers as Record<string, string>)['X-Plex-Token'] });
      if (url.includes('/hubs/search')) {
        return Response.json({ MediaContainer: { Hub: [{ type: 'artist', Metadata: [] }, { type: 'track', Metadata: [{ title: 'Thriller', grandparentTitle: 'Michael Jackson', duration: 357000, Media: [{ Part: [{ key: '/library/parts/5/file.mp3' }] }] }] }] } });
      }
      return new Response('audio');
    }) as unknown as typeof fetch;
    const plex = new PlexMusicSource({ url: 'http://plex:32400', token: 'secret' }, f);
    const t = await plex.find('thriller', AbortSignal.timeout(1000));
    expect(t).toEqual({ title: 'Thriller', artist: 'Michael Jackson', durationS: 357, source: 'plex', ref: '/library/parts/5/file.mp3' });
    await plex.open(t!, AbortSignal.timeout(1000));
    expect(seen[1]).toEqual({ url: 'http://plex:32400/library/parts/5/file.mp3', token: 'secret' });
    expect(seen.every((s) => !s.url.includes('secret'))).toBe(true);
  });
});

describe('music player', () => {
  function rig(opts: { youtubeFails?: boolean } = {}) {
    const plays: { track: string; handle: PlaybackHandle; end: (o: 'finished' | 'stopped') => void }[] = [];
    let paused = false;
    let volume = 0;
    const out: MusicOutput = {
      playMusic: (_s, v) => {
        volume = v;
        let end!: (o: 'finished' | 'stopped') => void;
        const done = new Promise<'finished' | 'stopped' | 'error'>((r) => (end = r));
        const h = { done, stop: () => end('stopped') };
        plays.push({ track: current, handle: h, end });
        return h;
      },
      pauseMusic: () => (paused = true),
      resumeMusic: () => (paused = false),
      setMusicVolume: (v) => (volume = v),
      get musicPlaying() {
        return plays.length > 0;
      },
      get musicPaused() {
        return paused;
      },
    };
    let current = '';
    const src = (name: 'youtube' | 'plex', fail = false): MusicSource => ({
      name,
      find: async (q) => {
        if (fail) throw new Error('yt-dlp broke');
        return { title: q, source: name, ref: `${name}:${q}` } as Track;
      },
      open: async (t) => {
        current = `${t.source}:${t.title}`;
        return { url: t.ref };
      },
    });
    const p = new MusicPlayer({
      sources: [src('youtube', opts.youtubeFails), src('plex')],
      output: out,
      decode: () => ({ pcm: new PassThrough(), kill: () => {} }),
      log: quiet,
      volume: 0.5,
    });
    return { p, plays, volume: () => volume, paused: () => paused };
  }
  const sig = () => AbortSignal.timeout(1000);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('plays, queues, advances and skips', async () => {
    const r = rig();
    expect(await r.p.play('one', 'now', sig())).toMatchObject({ ok: true, queued: 0 });
    expect(await r.p.play('two', 'queue', sig())).toMatchObject({ ok: true, queued: 1 });
    expect(await r.p.play('three', 'queue', sig())).toMatchObject({ ok: true, queued: 2 });
    expect(r.plays.map((x) => x.track)).toEqual(['youtube:one']);
    r.plays[0]!.end('finished'); // song ends: the next one starts
    await tick();
    await tick();
    expect(r.plays.map((x) => x.track)).toEqual(['youtube:one', 'youtube:two']);
    const n = await r.p.skip();
    expect(n).toMatchObject({ title: 'three' });
    expect(r.plays.map((x) => x.track)).toEqual(['youtube:one', 'youtube:two', 'youtube:three']);
    await tick();
    expect(r.plays.length).toBe(3); // the skipped song's end didn't start another
  });

  it('falls back to Plex when YouTube fails, or uses Plex when asked', async () => {
    const r = rig({ youtubeFails: true });
    await r.p.play('thriller', 'now', sig());
    expect(r.plays[0]!.track).toBe('plex:thriller');
    const r2 = rig();
    await r2.p.play('thriller', 'now', sig(), 'plex');
    expect(r2.plays[0]!.track).toBe('plex:thriller');
  });

  it('pause, resume, volume and stop', async () => {
    const r = rig();
    expect(r.p.pause()).toBe(false); // nothing playing
    await r.p.play('one', 'now', sig());
    expect(r.p.pause()).toBe(true);
    expect(r.paused()).toBe(true);
    expect(r.p.resume()).toBe(true);
    expect(r.p.nudgeVolume(-1)).toBeCloseTo(0.35);
    expect(r.volume()).toBeCloseTo(0.35);
    await r.p.play('two', 'queue', sig());
    expect(r.p.stop()).toBe(true);
    expect(r.p.upNext).toEqual([]);
  });
});
