import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { classifyMusic } from '../src/conversation/intents.js';
import type { PlaybackHandle } from '../src/core/interfaces.js';
import {
  decoderArgs,
  deezerTopTracks,
  heatmapPeak,
  MusicPlayer,
  type MusicOutput,
  musicState,
  musicTools,
  parseList,
  parseYtdlpPeaks,
  type Runner,
  type TopTracks,
  trackKey,
  whoAsked,
  YoutubeSource,
} from '../src/features/music.js';

const quiet = { info() {}, warn() {} };
const sig = () => AbortSignal.timeout(2000);
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const id = (n: number | string) => `vid${String(n).padStart(8, '0')}`; // 11 chars

interface Fake {
  /** Radio listing lines for a seed: [id, title, artist]. */
  radio?: (seed: string) => [string, string, string?][];
  /** Watch pages that fail, and how. */
  broken?: Record<string, string>;
  search?: string[];
}

function rig(f: Fake = {}, o: { autoplay?: boolean; topTracks?: TopTracks } = {}) {
  const calls: string[] = [];
  const run: Runner = async (_cmd, args) => {
    const url = args.at(-1)!;
    calls.push(url);
    if (url.includes('#songs')) return `${id('song')}\n`;
    if (url.includes('list=RDAMVM')) {
      const seed = url.split('v=')[1]!.slice(0, 11);
      return (f.radio?.(seed) ?? []).map(([v, t, a]) => `Mix\t${v}\t${t}\t200\t${a ?? 'NA'}`).join('\n');
    }
    if (url.startsWith('ytsearch5:')) return (f.search ?? [id('other')]).map((v) => `${v}\t200\tNA`).join('\n');
    if (url.includes('watch?v=')) {
      const v = url.split('v=')[1]!;
      if (f.broken?.[v]) throw new Error(f.broken[v]);
      const peaks = args.includes('%(title)s\t%(artist,creator,uploader)s\t%(duration)s\t%(release_year)s\t%(heatmap)j\t%(url)s');
      return peaks ? `Title ${v}\tArtist\t200\t2019\t[{"start_time": 60, "end_time": 62, "value": 1}]\thttps://stream/${v}\n` : `Title ${v}\tArtist\t200\thttps://stream/${v}\n`;
    }
    return '';
  };
  const ends: ((o: 'finished') => void)[] = [];
  const decoded: { input: string; range?: { startS: number; seconds: number } }[] = [];
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
  const p = new MusicPlayer({
    sources: [new YoutubeSource({ ytdlp: 'yt-dlp' }, run)],
    output: out,
    decode: (input, range) => {
      decoded.push({ input: 'url' in input ? input.url : 'stream', ...(range ? { range } : {}) });
      return { pcm: new PassThrough(), kill: () => {} };
    },
    log: quiet,
    autoplay: o.autoplay ?? false,
    ...(o.topTracks ? { topTracks: o.topTracks } : {}),
  });
  return { p, calls, decoded, finish: () => ends.at(-1)!('finished') };
}

describe('lists carry the artist', () => {
  it('reads the uploader column, and splits "Artist - Song" when it has none', () => {
    const c = parseList(`Mix\t${id(1)}\tSave Your Tears\t216\tThe Weeknd\nMix\t${id(2)}\tRadiohead - Creep (Official Video)\t237\tNA\nMix\t${id(3)}\tStarboy\t231\tThe Weeknd - Topic\n`);
    expect(c.tracks.map((t) => [t.title, t.artist])).toEqual([
      ['Save Your Tears', 'The Weeknd'],
      ['Creep', 'Radiohead'],
      ['Starboy', 'The Weeknd'],
    ]);
  });
});

describe('autoplay', () => {
  it("doesn't bring the same song back under another upload, nor nightcore remakes", async () => {
    const r = rig({
      radio: () => [
        [id('a'), `Title ${id('song')}`, 'Artist'], // the song playing, as another upload
        [id('b'), 'Other Song (Official Video)', 'Band'],
        [id('c'), 'Other Song', 'Band'], // the same song again
        [id('d'), 'Third Song (Nightcore)', 'Someone'],
        [id('e'), 'Fourth Song', 'Band'],
      ],
    }, { autoplay: true });
    await r.p.request('song', 'some song', 'now', sig());
    await flush();
    expect(r.p.upNext.map((t) => t.id)).toEqual([id('b'), id('e')]);
  });

  it('tops up before an artist shuffle runs out, not after a silent gap', async () => {
    const top: TopTracks = async () => ({ artist: 'Band', titles: ['One', 'Two', 'Three', 'Four', 'Five'], known: true });
    const r = rig({ radio: () => [[id('r1'), 'Radio Song', 'Band'], [id('r2'), 'Radio Two', 'Band']] }, { autoplay: true, topTracks: top });
    await r.p.request('artist', 'band', 'now', sig());
    await flush();
    for (let i = 0; i < 3 && !r.calls.some((u) => u.includes('RDAMVM')); i++) {
      r.finish();
      await flush();
    }
    // Lazy songs (found by name at their turn) are still queued, and similar songs come after them.
    expect(r.calls.some((u) => u.includes('RDAMVM'))).toBe(true);
    expect(r.p.upNext.some((t) => !t.id || t.auto)).toBe(true);
  });
});

describe('who asked, and going back', () => {
  it('remembers who asked for a song, and says autoplay picked the rest', async () => {
    const r = rig();
    const [play] = musicTools(r.p);
    await play!.run({ request_type: 'song', query: 'some song' }, sig(), { userId: '123456789012345678', speaker: 'Alex' });
    expect(r.p.nowPlaying?.by).toBe('Alex');
    expect(whoAsked(r.p)).toBe('Alex asked for this one.');
    expect(musicState(r.p)).toContain('("Alex" asked for it)');
    r.p.nowPlaying!.by = undefined;
    r.p.nowPlaying!.auto = true;
    expect(whoAsked(r.p)).toBe('Nobody picked this one. Autoplay did.');
  });

  it('goes back to the song before, and the one it left comes next', async () => {
    const r = rig({ search: [id('two')] });
    await r.p.request('song', 'first', 'now', sig());
    const first = r.p.nowPlaying!.title;
    await r.p.request('video', 'second', 'now', sig());
    const second = r.p.nowPlaying!.title;
    expect(second).not.toBe(first);
    const b = await r.p.back(sig());
    expect(b && b.title).toBe(first);
    expect(r.p.nowPlaying!.title).toBe(first);
    expect(r.p.upNext[0]!.title).toBe(second);
    expect(await rig().p.back(sig())).toBe(false);
  });

  it('sets the volume to a level', () => {
    const r = rig();
    expect(r.p.setVolume(0.3)).toBe(0.3);
    expect(r.p.setVolume(4)).toBe(1);
    expect(r.p.setVolume(0)).toBe(0.05);
  });
});

describe('songs YouTube will not play', () => {
  it('plays another upload of the same song', async () => {
    const r = rig({ broken: { [id('song')]: 'Sign in to confirm your age. This video may be inappropriate for some users.' }, search: [id('song'), id('lyrics')] });
    const res = await r.p.request('song', 'some song', 'now', sig());
    expect(res).toMatchObject({ ok: true });
    expect(r.p.nowPlaying!.id).toBe(id('lyrics'));
  });

  it('says it is age-restricted when no upload plays', async () => {
    const r = rig({ broken: { [id('song')]: 'Sign in to confirm your age', [id('other')]: 'Sign in to confirm your age' } });
    expect(await r.p.request('song', 'some song', 'now', sig())).toEqual({ ok: false, message: "That one's age-restricted on YouTube, so I can't play it." });
  });
});

describe('quiz clips through the player', () => {
  it('seeks to the part, stays out of the history and autoplay, and plays nothing after it', async () => {
    const r = rig({ radio: () => [[id('r1'), 'Radio Song', 'Band']] }, { autoplay: true });
    const t = await r.p.clipTrack({ title: 'Song', artist: 'Band', source: 'youtube', ref: '' }, sig());
    expect(t).toMatchObject({ year: 2019, peakS: 60, durationS: 200 });
    const clip = await r.p.clip(t, () => ({ startS: 57, seconds: 20 }), sig());
    expect(r.decoded.at(-1)).toEqual({ input: `https://stream/${id('song')}`, range: { startS: 57, seconds: 20 } });
    expect(r.p.nowPlaying).toBeUndefined();
    expect(r.p.recent).toHaveLength(0);
    r.finish();
    await clip.done;
    await flush();
    expect(r.calls.some((u) => u.includes('RDAMVM'))).toBe(false);
    expect(r.decoded).toHaveLength(1);
  });

  it('lends the music: requests wait, a stop goes to the borrower, and it comes back', async () => {
    const r = rig();
    await r.p.request('song', 'some song', 'now', sig());
    let stops = 0;
    const back = r.p.lend({ reason: 'Busy.', stop: () => stops++, skip() {} });
    expect(r.p.nowPlaying).toBeUndefined(); // what played stopped
    expect(await r.p.request('song', 'x', 'now', sig())).toEqual({ ok: false, message: 'Busy.' });
    expect(musicState(r.p)).toMatch(/quiz/);
    expect(r.p.stop()).toBe(true);
    expect(stops).toBe(1);
    back();
    expect(r.p.lent).toBeUndefined();
    expect(await r.p.request('song', 'x', 'now', sig())).toMatchObject({ ok: true });
  });
});

describe('a bare "play X"', () => {
  const deezer = (artists: { id: number; name: string; nb_fan: number }[]) =>
    deezerTopTracks((async (url: unknown) =>
      new Response(JSON.stringify(String(url).includes('/top') ? { data: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((title) => ({ title, artist: { id: artists[0]!.id } })) } : { data: artists })),
    ) as unknown as typeof fetch);

  it('plays the song when only a small act has that name', async () => {
    const m = await deezer([{ id: 1, name: 'Believer', nb_fan: 7_665 }]).match!('believer', sig());
    expect(m?.known).toBe(false);
  });

  it('finds the real artist past small acts of the same name', async () => {
    const acts = [...Array.from({ length: 6 }, (_, i) => ({ id: 10 + i, name: 'Queen', nb_fan: 400 + i })), { id: 412, name: 'Queen', nb_fan: 12_862_367 }];
    const m = await deezer(acts).match!('queen', sig());
    expect(m).toMatchObject({ artist: 'Queen', known: true });
  });
});

describe('pieces', () => {
  it('seeks ffmpeg before the input and cuts after it', () => {
    const a = decoderArgs({ url: 'https://stream/x' }, { startS: 57, seconds: 20 });
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(a.indexOf('-t')).toBeGreaterThan(a.indexOf('-i'));
    expect(a[a.indexOf('-ss') + 1]).toBe('57.0');
    expect(decoderArgs({ url: 'https://stream/x' })).not.toContain('-ss');
  });

  it("finds the most replayed part past the intro", () => {
    const heat = JSON.stringify([
      { start_time: 0, end_time: 2, value: 1 },
      { start_time: 30, end_time: 32, value: 0.4 },
      { start_time: 61, end_time: 63, value: 0.8 },
      { start_time: 190, end_time: 192, value: 0.9 },
    ]);
    expect(heatmapPeak(heat, 200)).toBe(61);
    expect(heatmapPeak('NA', 200)).toBeUndefined();
    const t = parseYtdlpPeaks(`The Weeknd - Blinding Lights\tThe Weeknd\t200\t2019\t${heat}\thttps://stream/x\n`);
    expect(t).toMatchObject({ title: 'Blinding Lights', artist: 'The Weeknd', year: 2019, peakS: 61, ref: 'https://stream/x' });
    expect(parseYtdlpPeaks(`Song\tArtist\t200\tNA\tNA\thttps://stream/x\n`)).not.toHaveProperty('peakS');
  });

  it('keys a song by title and first artist', () => {
    expect(trackKey({ title: 'Blinding Lights (Official Video)', artist: 'The Weeknd' })).toBe(trackKey({ title: 'Blinding Lights', artist: 'The Weeknd, Someone' }));
    expect(trackKey({ title: 'Creep' })).toBeUndefined();
  });

  it('hears back, who asked, and a level', () => {
    expect(classifyMusic('Adrian, go back')).toEqual({ kind: 'control', action: 'back' });
    expect(classifyMusic('previous song')).toEqual({ kind: 'control', action: 'back' });
    expect(classifyMusic('who requested this song')).toEqual({ kind: 'control', action: 'who' });
    expect(classifyMusic('who put this on?')).toEqual({ kind: 'control', action: 'who' });
    expect(classifyMusic('set the music to 30 percent')).toEqual({ kind: 'control', action: 'volume', level: 30 });
    expect(classifyMusic('music volume 150')).toEqual({ kind: 'control', action: 'volume', level: 100 });
  });
});
