import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { classifyMusic } from '../src/conversation/intents.js';
import { MusicPlayer, musicPromptLines, type MusicOutput, parseList, type Runner, YoutubeSource } from '../src/features/music.js';
import type { PlaybackHandle } from '../src/core/interfaces.js';

const quiet = { info() {}, warn() {} };
const sig = () => AbortSignal.timeout(2000);
const tick = () => new Promise((r) => setTimeout(r, 0));
const id = (n: number | string) => `vid${String(n).padStart(8, '0')}`; // 11 chars

/** A fake yt-dlp: answers by the URL it was given, records calls. */
function fakeYtdlp() {
  const calls: string[] = [];
  const run: Runner = async (_cmd, args) => {
    const url = args.at(-1)!;
    calls.push(url);
    if (url.includes('#songs')) return `${id('song')}\n`;
    if (url.includes('#albums')) return 'MPREb_ALBUM\n';
    if (url.includes('#community+playlists')) return 'VLPLchill\n';
    if (url.includes('#episodes')) return 'MPSPPLshow\n';
    if (url.includes('browse/MPREb_ALBUM')) return [1, 2, 3].map((n) => `Album - Graduation\t${id(`a${n}`)}\tTrack ${n}\t200`).join('\n');
    if (url.includes('list=PLchill')) return [1, 2, 3, 4].map((n) => `Late night\t${id(`p${n}`)}\tChill ${n}\t180`).join('\n');
    if (url.includes('list=PLshow')) return [1, 2].map((n) => `The Show\t${id(`e${n}`)}\tEpisode ${n}\t7200`).join('\n');
    if (url.includes('list=RDAMVM')) {
      const seed = url.split('v=')[1]!.slice(0, 11);
      return [seed, id('r1'), id('r2'), id('long'), id('r3')].map((v) => `Mix\t${v}\tRadio ${v}\t${v === id('long') ? 4000 : 150}`).join('\n');
    }
    if (url.startsWith('ytsearch5:')) return `${id('vid')}\t36000\tNA\n`;
    if (url.includes('watch?v=')) {
      const v = url.split('v=')[1]!;
      return `Artist - Title ${v}\tArtist\t200\thttps://stream/${v}\n`;
    }
    return '';
  };
  return { run, calls };
}

function rig() {
  const { run, calls } = fakeYtdlp();
  const started: string[] = [];
  const ends: ((o: 'finished') => void)[] = [];
  const out: MusicOutput = {
    playMusic: () => {
      let end!: (o: 'finished') => void;
      const done = new Promise<'finished' | 'stopped' | 'error'>((r) => (end = r));
      ends.push(end);
      return { done, stop: () => end('finished') } as PlaybackHandle;
    },
    pauseMusic() {},
    resumeMusic() {},
    setMusicVolume() {},
    musicPlaying: true,
    musicPaused: false,
  };
  const yt = new YoutubeSource({ ytdlp: 'yt-dlp' }, run);
  const p = new MusicPlayer({
    sources: [yt],
    output: out,
    decode: (input) => {
      started.push('url' in input ? input.url : 'stream');
      return { pcm: new PassThrough(), kill: () => {} };
    },
    log: quiet,
  });
  return { p, calls, started, finishCurrent: () => ends.at(-1)!('finished') };
}

describe('music requests', () => {
  it('reads playlist listings', () => {
    const c = parseList(`Album - Graduation\t${id(1)}\tGood Morning\t196\nAlbum - Graduation\tNA\tNA\tNA\n`);
    expect(c.title).toBe('Graduation');
    expect(c.tracks).toEqual([{ title: 'Good Morning', durationS: 196, source: 'youtube', ref: '', id: id(1) }]);
  });

  it('plays a whole album, the first track now and the rest queued', async () => {
    const r = rig();
    const res = await r.p.request('album', 'graduation kanye', 'now', sig());
    expect(res).toMatchObject({ ok: true, label: 'Graduation', added: 2 });
    expect(r.started).toEqual([`https://stream/${id('a1')}`]);
    expect(r.p.upNext.slice(0, 2).map((t) => t.id)).toEqual([id('a2'), id('a3')]); // then autoplay's similar songs
  });

  it('finds a playlist for a vibe', async () => {
    const r = rig();
    const res = await r.p.request('vibe', 'chill late night r&b', 'now', sig());
    expect(res.ok).toBe(true);
    expect(r.calls[0]).toContain('#community+playlists');
    expect(r.p.upNext.length).toBe(3);
  });

  it('plays songs like the one just played, without repeating it', async () => {
    const r = rig();
    await r.p.request('song', 'round 2', 'now', sig());
    const first = r.p.nowPlaying!.id;
    const res = await r.p.request('similar', '', 'now', sig());
    expect(res).toMatchObject({ ok: true });
    const ids = [r.p.nowPlaying!.id, ...r.p.upNext.map((t) => t.id)];
    expect(ids).not.toContain(first); // not the seed again
    expect(ids).not.toContain(id('long')); // nothing over 15 minutes
    expect(r.calls.some((u) => u.includes(`list=RDAMVM${first}`))).toBe(true);
  });

  it('says so when there is nothing to base "similar" on', async () => {
    const r = rig();
    expect(await r.p.request('similar', '', 'now', sig())).toMatchObject({ ok: false });
  });

  it('plays a podcast episode and does not autoplay radio after it', async () => {
    const r = rig();
    const res = await r.p.request('podcast', 'joe rogan', 'now', sig());
    expect(res).toMatchObject({ ok: true, label: 'The Show' });
    expect(r.p.nowPlaying!.kind).toBe('podcast');
    await tick();
    expect(r.calls.some((u) => u.includes('RDAMVM'))).toBe(false);
  });

  it('artist: top song first, then similar songs', async () => {
    const r = rig();
    const res = await r.p.request('artist', 'jaeybxrd', 'now', sig());
    expect(res).toMatchObject({ ok: true });
    expect(r.p.nowPlaying!.id).toBe(id('song'));
    expect(r.p.upNext.length).toBeGreaterThan(1);
  });

  it('autoplay keeps going with similar songs when the queue runs out', async () => {
    const r = rig();
    await r.p.request('song', 'round 2', 'now', sig());
    await tick();
    await tick();
    expect(r.p.upNext.length).toBe(3); // radio added, minus the seed and the 4000 s one
    r.p.setAutoplay(false);
    r.p.clearQueue();
    r.finishCurrent();
    await tick();
    expect(r.started.length).toBe(1); // autoplay off: nothing more
  });

  it('tells the model to use the tool and what is playing', async () => {
    const r = rig();
    await r.p.request('song', 'round 2', 'now', sig());
    const lines = musicPromptLines(r.p).join(' ');
    expect(lines).toContain('call play_music right away');
    expect(lines).toContain('Never say you can');
    expect(lines).toContain(`playing Title ${id('song')} by Artist`);
  });
});

describe('local music commands leave vague requests to the model', () => {
  it('keeps plain songs local and sends vibes, playlists and "like that" to the model', () => {
    expect(classifyMusic('play round 2 by jaeybxrd')).toMatchObject({ kind: 'play' });
    expect(classifyMusic('play me a playlist like the song I just listened to')).toBeUndefined();
    expect(classifyMusic('play something chill')).toBeUndefined();
    expect(classifyMusic('put on some hype music for gaming')).toBeUndefined();
    expect(classifyMusic('play the joe rogan podcast')).toBeUndefined();
    expect(classifyMusic('play the graduation album')).toBeUndefined();
  });
});

describe('time questions answered locally', () => {
  it('matches the plain time questions only', async () => {
    const { isTimeQuestion } = await import('../src/conversation/intents.js');
    expect(isTimeQuestion('Hey Adrian, what time is it?')).toBe(true);
    expect(isTimeQuestion("what's the time")).toBe(true);
    expect(isTimeQuestion('what time is it in Tokyo')).toBe(false); // the model handles places
    expect(isTimeQuestion('what time does the game start')).toBe(false);
  });
});
