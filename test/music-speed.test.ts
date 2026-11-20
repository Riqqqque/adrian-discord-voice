// Faster lookups and the request classes the corpus bench found missing:
// yt-dlp started before the search answers, YouTube's video search asked
// directly, albums and playlists found through YouTube Music's API, genres,
// versions asked for by name, other scripts and apostrophes.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { PlaybackHandle } from '../src/core/interfaces.js';
import {
  hasVersions,
  isGenre,
  matchScore,
  MusicPlayer,
  type MusicOutput,
  otherScript,
  pickBrowse,
  pickSong,
  runProgram,
  soundOf,
  type Runner,
  type TopTracks,
  versionsAsked,
  webSearchLines,
  YoutubePaused,
  YoutubeSource,
  YTM_API,
} from '../src/features/music.js';
import { PocConfigSchema } from '../src/config.js';
import { quizSongs } from '../src/features/quiz.js';

const sig = () => AbortSignal.timeout(4000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (n: string) => `vid${n.padStart(8, '0')}`; // 11 chars

// --- answers shaped like YouTube's ---------------------------------------------------
const row = (o: { videoId?: string; browseId?: string; title: string; second: string[] }) => ({
  musicResponsiveListItemRenderer: {
    ...(o.videoId ? { playlistItemData: { videoId: o.videoId } } : {}),
    ...(o.browseId ? { navigationEndpoint: { browseEndpoint: { browseId: o.browseId } } } : {}),
    flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: o.title }] } } }, { musicResponsiveListItemFlexColumnRenderer: { text: { runs: o.second.map((text) => ({ text })) } } }],
  },
});
const song = (videoId: string, title: string, artist: string, dur = '3:30') => row({ videoId, title, second: [artist, ' • ', 'Album', ' • ', dur] });
const ytm = (...items: object[]) => ({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: items } }] } } } }] } } });
const video = (videoId: string, title: string, channel: string, length?: string, extra: object = {}) => ({
  videoRenderer: { videoId, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: channel }] }, ...(length ? { lengthText: { simpleText: length } } : {}), ...extra },
});
const web = (...items: object[]) => ({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } } });

/** A YouTube Music and YouTube API stand-in: answers by client and filter. */
async function api(answer: (body: { query: string; params: string; context: { client: { clientName: string } } }) => unknown) {
  // (an answer may be a promise: the reply waits for it)
  const hits: { client: string; query: string; params: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (b) => (raw += b));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      hits.push({ client: body.context?.client?.clientName, query: body.query, params: body.params });
      void Promise.resolve(answer(body)).then((a) => {
        if (a === undefined) res.statusCode = 500;
        res.end(JSON.stringify(a ?? {}));
      });
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

interface Run {
  args: string[];
  target: string;
  /** When the address came (early runs), relative to the start. */
  at: number;
  startedAt: number;
  early: boolean;
}

/** A fake yt-dlp. Runs started early wait for their address on `input`. */
function ytdlp(runs: Run[], answer: (target: string) => string | Promise<string> = defaultAnswer): Runner {
  const t0 = performance.now();
  return async (_cmd, args, _signal, _enough, input) => {
    const r: Run = { args, target: input ? '' : args.at(-1)!, at: 0, startedAt: performance.now() - t0, early: !!input };
    runs.push(r);
    if (input) {
      const url = await input;
      r.at = performance.now() - t0;
      if (!url) throw new Error('ERROR: You must provide at least one URL.');
      r.target = url.trim();
    }
    return answer(r.target);
  };
}
function defaultAnswer(target: string): string {
  if (target.includes('watch?v=')) {
    const v = target.split('v=')[1]!;
    return `Title ${v}\tArtist\t200\thttps://stream/${v}\n`;
  }
  if (target.includes('browse/') || target.includes('playlist?list=')) return [1, 2, 3, 4, 5].map((n) => `List\t${id(`l${n}`)}\tTrack ${n}\t200\tArtist`).join('\n');
  if (target.startsWith('ytsearch')) return `${id('ytdlp')}\t200\tNA\tA video\tA channel\n`;
  if (target.includes('#')) return `${id('flat')}\n`;
  return '';
}

function player(yt: YoutubeSource, topTracks?: TopTracks) {
  const logs: { m: string }[] = [];
  const out: MusicOutput = {
    playMusic: () => ({ done: new Promise(() => {}), stop: () => {} }) as unknown as PlaybackHandle,
    pauseMusic() {},
    resumeMusic() {},
    setMusicVolume() {},
    musicPlaying: true,
    musicPaused: false,
  };
  const p = new MusicPlayer({
    sources: [yt],
    output: out,
    decode: () => ({ pcm: new PassThrough(), kill() {} }),
    log: { info: (m, f) => logs.push({ m, ...f }), warn: (m, f) => logs.push({ m, ...f }) },
    autoplay: false,
    ...(topTracks ? { topTracks } : {}),
  });
  return { p, logs };
}

describe('the words of a title', () => {
  it("reads God's as gods, as speech recognition writes it", () => {
    expect(matchScore('gods plan by drake', "God's Plan Drake")).toBe(1);
    expect(matchScore('dont stop me now', 'Don’t Stop Me Now Queen')).toBe(1);
  });

  it('hears a soft g inside a word as j', () => {
    expect(soundOf('bougie')).toBe(soundOf('boujee'));
    expect(soundOf('get')).not.toBe(soundOf('jet')); // not at the start
  });

  it('joins two words heard for one name', () => {
    expect(matchScore('bad and bougie by me goes', 'Bad and Boujee Migos, Lil Uzi Vert • Culture')).toBe(1);
    // "me goes" alone doesn't make "YFG Fatso - Bougie Hoes" Migos.
    expect(matchScore('bad and bougie by me goes', 'YFG Fatso - Bougie Hoes (Official Music Video) YFG Fatso')).toBe(0.5);
    // Too few sounds to be sure: "so easy" isn't SZA.
    expect(matchScore('so easy', 'Kill Bill SZA')).toBe(0);
  });
});

describe('versions asked for by name', () => {
  it('finds them in a request', () => {
    expect(versionsAsked('tems free mind tiny desk')).toEqual(['tiny desk']);
    expect(versionsAsked('sweater weather sped-up')).toEqual(['sped up']);
    expect(versionsAsked('blinding lights')).toEqual([]);
    // Describes nearly any video: not a version.
    expect(versionsAsked('on the radar performance loba')).toEqual([]);
  });

  it('checks a title has all of them', () => {
    expect(hasVersions('Tems: Tiny Desk Concert NPR Music', ['tiny desk'])).toBe(true);
    expect(hasVersions('Free Mind Tems', ['tiny desk'])).toBe(false);
    expect(hasVersions('Sweater Weather (Sped Up)', ['sped up'])).toBe(true);
    expect(hasVersions('anything', [])).toBe(true);
  });

  it('looks further for one the catalog song lacks, and takes a whole set up to 40 min', async () => {
    const s = await api((b) => (b.context.client.clientName === 'WEB_REMIX' ? ytm(song(id('studio'), 'Free Mind', 'Tems')) : web(video(id('desk'), 'Tems: Tiny Desk Concert', 'NPR Music', '20:22'), video(id('lyric'), 'Tems - Free Mind (Lyrics)', 'Lyrics', '4:07'))));
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, webApi: s.url }, ytdlp(runs, (t) => `Tems: Tiny Desk Concert\tNPR Music\t1222\thttps://stream/${t.split('v=')[1]}\n`));
    // Three of five words is a fair match, but without "tiny desk" it isn't what was asked for.
    const t = await yt.find('tems free mind tiny desk', sig());
    await s.close();
    expect(t).toMatchObject({ id: id('desk'), durationS: 1222 });
    expect(runs.map((r) => r.target)).toEqual([`https://www.youtube.com/watch?v=${id('desk')}`]); // not swapped back for the studio song
  });

  it('never takes a video without the version over the song', async () => {
    const s = await api((b) => (b.context.client.clientName === 'WEB_REMIX' ? ytm(song(id('studio'), 'Free Mind', 'Tems')) : web(video(id('live'), 'Tems - Free Mind (Live)', 'Desk Tiny', '4:07'))));
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, webApi: s.url }, ytdlp([]));
    expect(await yt.songId('tems free mind tiny desk', sig())).toEqual({ id: id('studio'), via: 'direct' });
    await s.close();
  });
});

describe('a catalog answer in another script', () => {
  it('is told apart', () => {
    expect(otherScript('yoru ni kakeru', '夜に駆ける YOASOBI • 夜に駆ける • 4:22')).toBe(true);
    expect(otherScript('yoru ni kakeru', 'Racing into the Night YOASOBI')).toBe(false);
    expect(otherScript('夜に駆ける', '夜に駆ける YOASOBI')).toBe(false);
  });

  it('is kept without a video search: its words can’t be compared', async () => {
    const s = await api((b) => (b.context.client.clientName === 'WEB_REMIX' ? ytm(song(id('yoasobi'), '夜に駆ける', 'YOASOBI', '4:22')) : web(video(id('fan'), 'YOASOBI | Racing Into The Night / Yoru Ni Kakeru', 'Fan uploads', '4:19'))));
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, webApi: s.url }, ytdlp([]));
    expect(await yt.songId('yoru ni kakeru', sig())).toEqual({ id: id('yoasobi'), via: 'direct' });
    await s.close();
    expect(s.hits.map((h) => h.client)).toEqual(['WEB_REMIX']);
  });

  it('still looks further for a version the song lacks', async () => {
    const s = await api((b) => (b.context.client.clientName === 'WEB_REMIX' ? ytm(song(id('studio'), 'Lemon', '米津玄師')) : web(video(id('desk'), 'Kenshi Yonezu Lemon Tiny Desk', 'NPR Music', '5:00'))));
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, webApi: s.url }, ytdlp([]));
    expect(await yt.songId('kenshi yonezu lemon tiny desk', sig())).toMatchObject({ id: id('desk'), via: 'ytsearch-match' });
    await s.close();
  });
});

describe('the song catalog’s top row longer than a song', () => {
  it('is played as yt-dlp would have found it, without starting yt-dlp to search again', () => {
    expect(pickSong(ytm(song(id('jams'), 'Best 90s Slow Jams', 'M-Beat', '1:08:55'), song(id('tamia'), 'So Into You', 'Tamia')))).toEqual({ id: id('jams'), text: expect.stringContaining('Best 90s Slow Jams'), title: 'Best 90s Slow Jams', long: true });
    expect(pickSong(ytm(song(id('tamia'), 'So Into You', 'Tamia')))).toEqual({ id: id('tamia'), text: expect.any(String), title: 'So Into You' });
  });
});

describe("YouTube's video search, asked directly", () => {
  it('reads results as yt-dlp search lines', () => {
    const lines = webSearchLines(
      web(
        { shelfRenderer: {} },
        video(id('a'), 'Tems: Tiny\tDesk Concert', 'NPR Music', '20:22'),
        video(id('live'), 'Lofi radio', 'Lofi Girl', undefined, { badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] }),
        video(id('soon'), 'Premiere', 'Someone', undefined, { upcomingEventData: { startTime: '1' } }),
        video('short', 'Not an id', 'x', '1:00'),
        video(id('b'), 'Two', 'Ch', '1:02:03'),
      ),
      3,
    );
    expect(lines).toBe(`${id('a')}\t1222\tNA\tTems: Tiny Desk Concert\tNPR Music\n${id('live')}\tNA\tis_live\tLofi radio\tLofi Girl\n${id('soon')}\tNA\tis_upcoming\tPremiere\tSomeone\n`);
    expect(webSearchLines({ contents: {} } as never, 5)).toBeUndefined();
    expect(webSearchLines(web(), 5)).toBeUndefined(); // yt-dlp asks again: none, or a shape it doesn't know
    expect(webSearchLines(web({ lockupViewModel: {} }), 5)).toBeUndefined();
  });

  it('replaces the ytsearch run, with the same filter yt-dlp sends', async () => {
    const s = await api(() => web(video(id('rain'), 'Rain sounds 10 hours', 'Sleep', '10:00:00')));
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', webApi: s.url }, ytdlp(runs));
    expect(await yt.videoId('rain sounds', sig())).toBe(id('rain'));
    await s.close();
    expect(s.hits).toEqual([{ client: 'WEB', query: 'rain sounds', params: 'EgIQAfABAQ==' }]);
    expect(runs).toEqual([]);
  });

  it('leaves it to yt-dlp when YouTube answers oddly', async () => {
    const s = await api(() => undefined); // 500
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', webApi: s.url }, ytdlp(runs));
    expect(await yt.videoId('rain sounds', sig())).toBe(id('ytdlp'));
    await s.close();
    expect(runs.map((r) => r.target)).toEqual(['ytsearch5:rain sounds']);
  });

  it('is on by default only beside YouTube Music’s real API', () => {
    const asks = (o: ConstructorParameters<typeof YoutubeSource>[0]) => (new YoutubeSource(o, ytdlp([])) as unknown as { webApi?: string }).webApi;
    expect(asks({ ytdlp: 'x', searchApi: 'https://music.youtube.com' })).toBe('https://www.youtube.com');
    expect(asks({ ytdlp: 'x', searchApi: 'http://127.0.0.1:1' })).toBeUndefined();
    expect(asks({ ytdlp: 'x' })).toBeUndefined();
  });
});

describe('yt-dlp started before the search answers', () => {
  it('is running while the search is, and gets the video on stdin', async () => {
    let answer!: () => void;
    const searched = new Promise<void>((r) => (answer = r));
    const s = await api(() => searched.then(() => ytm(song(id('hit'), 'Get Lucky', 'Daft Punk'))));
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, startEarly: true }, ytdlp(runs));
    const going = yt.find('get lucky daft punk', sig());
    await wait(5);
    expect(runs).toHaveLength(1); // started before any answer
    expect(runs[0]!.args.slice(-2)).toEqual(['--batch-file', '-']);
    answer();
    const t = await going;
    await s.close();
    expect(t).toMatchObject({ id: id('hit'), ref: `https://stream/${id('hit')}` });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.target).toBe(`https://www.youtube.com/watch?v=${id('hit')}`);
  });

  it('is let go, asking nothing, when nothing is found', async () => {
    const s = await api(() => ytm());
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, webApi: s.url, startEarly: true }, ytdlp(runs, () => ''));
    expect(await yt.find('nothing at all', sig())).toBeUndefined();
    await s.close();
    await wait(5);
    const early = runs.filter((r) => r.early);
    expect(early).toHaveLength(1);
    expect(early[0]!.target).toBe(''); // its stdin closed empty
  });

  it('is let go when the search fails', async () => {
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', startEarly: true }, ytdlp(runs, () => Promise.reject(new Error('HTTP Error 503'))));
    await expect(yt.find('x', sig())).rejects.toThrow('503');
    await wait(5);
    expect(runs.filter((r) => r.early).map((r) => r.target)).toEqual(['']);
  });

  it('is off with a stand-in yt-dlp unless asked for, and on with the real one', () => {
    const on = (y: YoutubeSource) => (y as unknown as { startEarly: boolean }).startEarly;
    expect(on(new YoutubeSource({ ytdlp: 'x' }, ytdlp([])))).toBe(false);
    expect(on(new YoutubeSource({ ytdlp: 'x' }))).toBe(true);
    expect(on(new YoutubeSource({ ytdlp: 'x', startEarly: false }))).toBe(false);
  });

  it('reaches a real program through stdin', async () => {
    let give!: (s: string) => void;
    const input = new Promise<string | undefined>((r) => (give = r));
    const out = runProgram(process.execPath, ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write("got "+s))'], sig(), undefined, input);
    await wait(20);
    give('https://www.youtube.com/watch?v=abc\n');
    expect(await out).toBe('got https://www.youtube.com/watch?v=abc\n');
  });
});

describe('albums and playlists', () => {
  it('reads the album or playlist id as yt-dlp’s flat search would', () => {
    expect(pickBrowse(ytm(row({ title: 'Graduation', second: ['Album', ' • ', 'Kanye West'], browseId: 'MPREb_KCNeTnK02S7' })))).toBe('MPREb_KCNeTnK02S7');
    expect(pickBrowse(ytm({ musicResponsiveListItemRenderer: {} }, row({ title: 'Lofi', second: ['x'], browseId: 'VLPLZ6fAZ0eySdy4Txkh' })))).toBe('VLPLZ6fAZ0eySdy4Txkh');
    expect(pickBrowse(ytm())).toBeUndefined();
  });

  it('finds an album through the API, with its listing and first song started beside it', async () => {
    const s = await api((b) => (b.params === 'EgWKAQIYAWoKEAoQAxAEEAkQBQ==' ? ytm(row({ title: 'Graduation', second: ['Album'], browseId: 'MPREb_GRAD' })) : undefined));
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, startEarly: true }, ytdlp(runs));
    const { p } = player(yt);
    const r = await p.request('album', 'graduation kanye west', 'now', sig());
    await s.close();
    expect(r).toMatchObject({ ok: true, started: { id: id('l1') } });
    // (the third, the next song got ready while the first plays, is the player's own)
    expect(runs.slice(0, 2).map((x) => [x.early, x.target])).toEqual([
      [true, 'https://music.youtube.com/browse/MPREb_GRAD'],
      [true, `https://www.youtube.com/watch?v=${id('l1')}`],
    ]);
    expect(runs.some((x) => x.target.includes('#albums'))).toBe(false);
  });

  it('turns a playlist row into its list', async () => {
    const s = await api(() => ytm(row({ title: 'Lofi', second: ['x'], browseId: 'VLPLlofi' })));
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url }, ytdlp(runs));
    const c = await yt.playlist('chill lofi beats', sig());
    await s.close();
    expect(c?.tracks).toHaveLength(5);
    expect(runs.map((x) => x.target)).toEqual(['https://music.youtube.com/playlist?list=PLlofi']);
  });

  it('leaves the search to yt-dlp when the API has nothing', async () => {
    const s = await api(() => ytm());
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, startEarly: true }, ytdlp(runs));
    await yt.album('graduation', sig());
    await s.close();
    expect(runs.filter((x) => !x.early).map((x) => x.target)).toEqual(['https://music.youtube.com/search?q=graduation#albums']);
    expect(runs[0]).toMatchObject({ early: true, target: `https://music.youtube.com/browse/${id('flat')}` });
  });
});

describe('a bare "play X"', () => {
  it.each(['jazz', '90s r&b', 'old school hip hop', 'the 80s', '2000s hits', 'lofi', 'smooth jazz music'])('plays a genre or an era as a playlist: %s', (q) => expect(isGenre(q)).toBe(true));
  it.each(['pop smoke', 'rap god', 'the 1975', 'house of the rising sun', 'queen', 'country roads', 'soul sister'])('leaves names alone: %s', (q) => expect(isGenre(q)).toBe(false));

  it('"some jazz" finds a jazz playlist, without asking Deezer', async () => {
    const s = await api((b) => (b.params === 'EgeKAQQoAEABagoQChADEAQQCRAF' ? ytm(row({ title: 'Jazz Classics', second: ['x'], browseId: 'VLPLjazz' })) : undefined));
    let deezer = 0;
    const top: TopTracks = async () => (deezer++, undefined);
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url }, ytdlp([]));
    const { p } = player(yt, top);
    const r = await p.playNamed('some jazz', 'now', sig());
    await s.close();
    expect(r).toMatchObject({ ok: true, label: 'List' });
    expect(s.hits.map((h) => h.query)).toEqual(['jazz']);
    expect(deezer).toBe(0);
  });

  it.each([
    ['some nights', 'nights'],
    ['a little respect', 'respect'],
    ['more than a feeling', 'than a feeling'],
    ['silly love songs', 'silly love'],
    ['some fleetwood mac', 'fleetwood mac'],
  ])('searches the song as asked ("%s"); only Deezer gets "%s"', async (asked, artist) => {
    const s = await api(() => ytm(song(id('x'), 'X', 'Y')));
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url }, ytdlp([]));
    const deezer: string[] = [];
    const top: TopTracks = Object.assign(async () => undefined, { match: async (a: string) => (deezer.push(a), undefined) });
    const { p } = player(yt, top);
    await p.playNamed(asked, 'now', sig());
    await s.close();
    expect(s.hits[0]?.query).toBe(asked);
    expect(deezer).toEqual([artist]);
  });

  it("waits for a known artist's own top song when it's 2 s behind Deezer, rather than looking up another", async () => {
    const s = await api(() => ytm(song(id('lead'), 'Hotline Bling', 'Drake')));
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url }, ytdlp(runs, async (t) => (await wait(t.includes(id('lead')) ? 2_000 : 0), `Hotline Bling\tDrake\t267\thttps://stream/${t.split('v=')[1]}\n`)));
    const top: TopTracks = async () => ({ artist: 'Drake', titles: ['One Dance', 'Passionfruit', 'Started From the Bottom', 'Nonstop', 'Jimmy Cooks', 'Hotline Bling'], known: true });
    const { p } = player(yt, top);
    const r = await p.playNamed('drake', 'now', sig());
    await s.close();
    expect(r).toMatchObject({ ok: true, artist: 'Drake', started: { id: id('lead') } });
    expect(runs).toHaveLength(1);
    expect(s.hits).toHaveLength(1);
  }, 8_000);
});

// --- review fixes ----------------------------------------------------------------------

/** The fake yt-dlp, stopping when its signal does (as spawn's does), each answer `ms` late. */
function abortable(runs: Run[], ms: number): Runner {
  const inner = ytdlp(runs, async (t) => (await wait(ms), defaultAnswer(t)));
  return (cmd, args, signal, enough, input) =>
    new Promise((res, rej) => {
      const stop = () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      inner(cmd, args, signal, enough, input)
        .then(res, rej)
        .finally(() => signal.removeEventListener('abort', stop));
    });
}
const lofi = () => ytm(row({ title: 'Lofi', second: ['x'], browseId: 'VLPLlofi' }));

describe("a list's spare stream lookup", () => {
  it("goes only to that list's songs, not to another room's", async () => {
    const s = await api(lofi);
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, startEarly: true }, abortable(runs, 0));
    const c = await yt.playlist('chill lofi beats', new AbortController().signal);
    // Another room's song while the spare waits: it runs its own yt-dlp.
    expect(await yt.resolve(id('other'), sig())).toMatchObject({ id: id('other') });
    expect(runs.find((r) => r.target.includes(id('other')))?.early).toBe(false);
    // The list's song that plays first takes it.
    await yt.prepare(c!.tracks[2]!, sig());
    await s.close();
    expect(runs.find((r) => r.target.includes(id('l3')))?.early).toBe(true);
    expect(runs).toHaveLength(3);
  });

  it("doesn't die with the request that started it once a song took it; the song's own stop ends it", async () => {
    const s = await api(lofi);
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, startEarly: true }, abortable(runs, 300));
    const a = new AbortController();
    const c = await yt.playlist('chill lofi beats', a.signal);
    const going = yt.prepare(c!.tracks[0]!, new AbortController().signal);
    await wait(50);
    a.abort(); // the asker barged in on "Added."
    await going;
    expect(c!.tracks[0]!.ref).toBe(`https://stream/${id('l1')}`);

    const c2 = await yt.playlist('chill lofi beats', new AbortController().signal);
    const b = new AbortController();
    const t0 = performance.now();
    const going2 = yt.prepare(c2!.tracks[0]!, b.signal);
    await wait(50);
    b.abort();
    await expect(going2).rejects.toThrow(/abort/i);
    expect(performance.now() - t0).toBeLessThan(250);
    await s.close();
    expect(runs.filter((r) => r.early && r.target.includes('watch?v='))).toHaveLength(2);
  });

  it("isn't started for a quiz, which looks its clips up another way", async () => {
    const s = await api(lofi);
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, startEarly: true }, ytdlp(runs));
    const songs = await quizSongs({ rounds: 2, decade: '90s' }, { yt, recent: () => [], log: { info() {}, warn() {} } }, sig());
    await s.close();
    expect(songs.length).toBeGreaterThan(0);
    expect(runs.map((r) => [r.early, r.target])).toEqual([[true, 'https://music.youtube.com/playlist?list=PLlofi']]);
  });
});

describe('a bot check while a run waits for its address', () => {
  it('stops that run before it asks YouTube anything', async () => {
    let answer!: () => void;
    const searched = new Promise<void>((r) => (answer = r));
    const s = await api(() => searched.then(() => ytm(song(id('hit'), 'Get Lucky', 'Daft Punk'))));
    const runs: Run[] = [];
    const bot = (t: string) => (t.includes(id('bot')) ? Promise.reject(new Error("ERROR: [youtube] x: Sign in to confirm you're not a bot")) : defaultAnswer(t));
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, startEarly: true }, ytdlp(runs, bot));
    const going = yt.find('get lucky daft punk', sig());
    going.catch(() => {});
    await wait(5);
    // Meanwhile another lookup meets the bot check.
    await expect(yt.resolve(id('bot'), sig())).rejects.toBeInstanceOf(YoutubePaused);
    answer();
    await expect(going).rejects.toBeInstanceOf(YoutubePaused);
    await s.close();
    await wait(5);
    expect(runs.filter((r) => r.early).map((r) => r.target)).toEqual(['']);
  });
});

describe("YouTube's video search, asked directly: limits", () => {
  it('can be turned off (music.directSearch, on by default)', async () => {
    const s = await api(() => web(video(id('rain'), 'Rain sounds', 'Sleep', '3:00')));
    const runs: Run[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', webApi: s.url, directSearch: false }, ytdlp(runs));
    expect(await yt.videoId('rain sounds', sig())).toBe(id('ytdlp'));
    await s.close();
    expect(s.hits).toEqual([]);
    expect(runs.map((r) => r.target)).toEqual(['ytsearch5:rain sounds']);
    const asks = (o: ConstructorParameters<typeof YoutubeSource>[0]) => (new YoutubeSource(o, ytdlp([])) as unknown as { webApi?: string }).webApi;
    expect(asks({ ytdlp: 'x', searchApi: YTM_API, directSearch: false })).toBeUndefined();
    expect(PocConfigSchema.shape.music.parse(undefined).directSearch).toBe(true);
    expect(PocConfigSchema.shape.music.parse({}).directSearch).toBe(true);
    expect(PocConfigSchema.shape.music.parse({ directSearch: false }).directSearch).toBe(false);
  });

  it('rests after three failures in a row, then tries again', async () => {
    let clock = 1_000_000;
    const s = await api(() => undefined); // 500
    const runs: Run[] = [];
    const warns: string[] = [];
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', webApi: s.url, now: () => clock }, ytdlp(runs));
    yt.log = { info() {}, warn: (m) => warns.push(m) };
    for (let i = 0; i < 5; i++) expect(await yt.videoId(`rain ${i}`, sig())).toBe(id('ytdlp'));
    expect(s.hits).toHaveLength(3);
    expect(warns.filter((m) => m === 'direct video search resting')).toHaveLength(1);
    clock += 5 * 60_000 + 1;
    await yt.videoId('rain again', sig());
    await s.close();
    expect(s.hits).toHaveLength(4);
    expect(runs).toHaveLength(6);
  });

  it('gets one share of time per lookup, however many searches the lookup makes', async () => {
    const s = await api((b) => (b.context.client.clientName === 'WEB_REMIX' ? ytm(song(id('song'), 'Something Else', 'Nobody')) : new Promise(() => {})));
    const runs: Run[] = [];
    // The catalog's song won't play here: another upload is searched for.
    const answer = (t: string) => (t.includes(id('song')) ? Promise.reject(new Error('ERROR: [youtube] x: Video unavailable')) : defaultAnswer(t));
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, webApi: s.url, webTimeoutMs: 150, webBudgetMs: 150 }, ytdlp(runs, answer));
    const t0 = performance.now();
    const t = await yt.find('kiss me again the band', AbortSignal.timeout(8000));
    const took = performance.now() - t0;
    await s.close();
    expect(t?.id).toBe(id('ytdlp'));
    // The closer-match search waited its share; the other-upload search didn't wait at all.
    expect(s.hits.filter((h) => h.client === 'WEB')).toHaveLength(1);
    expect(runs.filter((r) => r.target.startsWith('ytsearch'))).toHaveLength(2);
    expect(took).toBeLessThan(1500);
  }, 10_000);
});

describe('a catalog answer whose credits alone are in another script', () => {
  it('is still checked by its title, and looked further for', async () => {
    const wrong = row({ videoId: id('wrong'), title: 'Kiss Me', second: ['東京バンド', ' • ', 'ベスト', ' • ', '3:30'] });
    expect(pickSong(ytm(wrong))).toMatchObject({ id: id('wrong'), title: 'Kiss Me' });
    const s = await api((b) => (b.context.client.clientName === 'WEB_REMIX' ? ytm(wrong) : web(video(id('right'), 'Kiss Me Again', 'The Band', '3:40'))));
    const yt = new YoutubeSource({ ytdlp: 'yt-dlp', searchApi: s.url, webApi: s.url }, ytdlp([]));
    expect(await yt.songId('kiss me again', sig())).toMatchObject({ id: id('right'), via: 'ytsearch-match' });
    await s.close();
  });
});
