import { describe, expect, it } from 'vitest';
import { digestLine, gatherNews, MAX_WORDS, newMedia, sinceWords, type Media, type Sources } from '../src/features/digest.js';
import type { McStatus } from '../src/features/gameservers.js';

const T0 = Date.UTC(2026, 10, 8, 18); // a Sunday, 18:00 UTC
const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function media(shows: [string, number][], movies: string[] = [], capped = false): Media {
  return { shows: shows.map(([title, n]) => ({ title, n })), episodes: shows.reduce((a, [, n]) => a + n, 0), movies, capped };
}

/** A fake Sonarr/Radarr/Plex. `episodes`/`movies`: [title, ms ago]. */
function fakeApps(o: { episodes?: [string, number][]; movies?: [string, number][]; plex?: { type: string; title?: string; grandparentTitle?: string; addedAt: number }[]; fail?: string[]; hang?: string[] }) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const app = url.includes(':8989') ? 'sonarr' : url.includes(':7878') ? 'radarr' : 'plex';
    if (o.hang?.includes(app))
      return new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    if (o.fail?.includes(app)) return new Response('no', { status: 500 });
    if (app === 'plex') return Response.json({ MediaContainer: { Metadata: o.plex ?? [] } });
    const u = new URL(url);
    const src0 = app === 'sonarr' ? (o.episodes ?? []) : (o.movies ?? []);
    const titles = [...new Set(src0.map(([t]) => t))];
    const one = /\/api\/v3\/(series|movie)\/(\d+)$/.exec(u.pathname);
    if (one) return Response.json({ title: titles[+one[2]!], images: [] });
    const page = Number(u.searchParams.get('page'));
    const size = Number(u.searchParams.get('pageSize'));
    const src = app === 'sonarr' ? (o.episodes ?? []) : (o.movies ?? []);
    const all = src.map(([title, ago], i) => ({
      ...(app === 'sonarr' ? { episodeId: i + 1, seriesId: titles.indexOf(title) } : { movieId: titles.indexOf(title) }),
      date: new Date(T0 - ago).toISOString(),
    }));
    return Response.json({ records: all.slice((page - 1) * size, page * size) });
  }) as typeof fetch;
  return { f, calls };
}

const sources = (f: typeof fetch, extra: Partial<Sources> = {}): Sources => ({
  media: { sonarr: { url: 'http://127.0.0.1:8989', apiKey: 'k' }, radarr: { url: 'http://127.0.0.1:7878', apiKey: 'k' }, timezone: 'UTC' },
  servers: [],
  ping: async () => ({ online: true }),
  fetch: f,
  ...extra,
});

describe('digest line', () => {
  it('says one item plainly', () => {
    expect(digestLine(media([['Frieren', 1]]), [], { since: 'since yesterday' })).toBe('Since yesterday: a new Frieren episode.');
    expect(digestLine(media([], ['Dune']), [], { since: 'since yesterday' })).toBe('Since yesterday: Dune finished downloading.');
  });

  it('coalesces two items', () => {
    expect(digestLine(media([['Frieren', 1], ['One Piece', 1]]), [])).toBe('2 new episodes of Frieren and One Piece.');
    expect(digestLine(media([], ['Dune', 'Arrival']), [], { since: 'since Tuesday' })).toBe('Since Tuesday: Dune and Arrival finished downloading.');
  });

  it('coalesces 14 items into one line', () => {
    const line = digestLine(media([['Frieren', 6], ['One Piece', 5], ['The Bear', 2]], ['Dune']), [], { since: 'since yesterday' })!;
    expect(line).toBe('Since yesterday: 13 new episodes, mostly Frieren and One Piece, and Dune finished downloading.');
    expect(words(line)).toBeLessThanOrEqual(MAX_WORDS);
  });

  it('keeps 300 items to a short line, never one per item', () => {
    const shows: [string, number][] = Array.from({ length: 27 }, (_, i) => [`Show Number ${i}`, i < 2 ? 100 : 4] as [string, number]);
    const movies = Array.from({ length: 20 }, (_, i) => `A Fairly Long Movie Title ${i}`);
    const line = digestLine(media(shows, movies), ['Survival Server One', 'Creative'], { since: 'since October 3', lead: 'Alex' })!;
    expect(words(line)).toBeLessThanOrEqual(MAX_WORDS);
    expect(line.startsWith('Alex, since October 3: 300 new episodes')).toBe(true);
    expect(line).not.toContain('Number 5');
  });

  it('says "over" when the history was cut off', () => {
    expect(digestLine(media([['Frieren', 600]], [], true), [])).toBe('Over 600 new Frieren episodes.');
  });

  it('uses "including" when the top shows are a small share', () => {
    const line = digestLine(media([['A', 3], ['B', 3], ['C', 3], ['D', 3], ['E', 3]]), [])!;
    expect(line).toBe('15 new episodes, including A and B.');
  });

  it('drops names before going over the word limit', () => {
    const long = 'The Extraordinarily Long Named Show About Many Things Indeed';
    const line = digestLine(media([[long, 4], [long + ' Two', 3], ['x', 1]], ['Dune: Part Two Extended Edition', 'Arrival']), [], { since: 'since yesterday', lead: 'Alex' })!;
    expect(words(line)).toBeLessThanOrEqual(MAX_WORDS);
    expect(line).toMatch(/^Alex, since yesterday: 8 new episodes/);
  });

  it('mentions servers that went down', () => {
    expect(digestLine(media([]), ['Survival'])).toBe('The Survival server is down.');
    expect(digestLine(media([['Frieren', 2]]), ['Survival', 'Creative'])).toBe('2 new Frieren episodes and the Survival and Creative servers are down.');
  });

  it('joins two plain parts without a comma, and names servers called "server" once', () => {
    expect(digestLine(media([['A', 2], ['B', 3], ['C', 9]]), [], { since: 'since yesterday', maxWords: 6 })).toBe('Since yesterday: 14 new episodes.');
    expect(digestLine({ shows: [{ title: '', n: 8 }, { title: '', n: 5 }], episodes: 13, movies: ['', ''], capped: false }, [])).toBe('13 new episodes and 2 new movies.');
    expect(digestLine(media([]), ['Survival Server'])).toBe('Survival Server is down.');
  });

  it('leaves names out when their lookup failed', async () => {
    const f = (async (u: string) =>
      String(u).includes('/history') ? Response.json({ records: [{ episodeId: 1, seriesId: 7, date: new Date(T0 - HOUR).toISOString() }] }) : new Response('', { status: 500 })) as typeof fetch;
    const n = await gatherNews(sources(f, { media: { sonarr: { url: 'http://127.0.0.1:8989', apiKey: 'k' }, timezone: 'UTC' } }), T0 - DAY_MS, T0, 1000);
    expect(digestLine(n, [])).toBe('A new episode.');
  });

  it('says nothing when nothing is new', () => {
    expect(digestLine(media([]), [])).toBeUndefined();
  });
});

describe('since words', () => {
  const tz = 'America/Denver';
  it('reads as people talk', () => {
    expect(sinceWords(T0 - 2 * HOUR, T0, tz)).toBe('since earlier today');
    expect(sinceWords(T0 - 24 * HOUR, T0, tz)).toBe('since yesterday');
    expect(sinceWords(T0 - 3 * 24 * HOUR, T0, tz)).toBe('since Thursday');
    expect(sinceWords(T0 - 20 * 24 * HOUR, T0, tz)).toBe('since October 19');
  });
});

describe('gathering news', () => {
  it('counts imports since then, once per episode, newest pages only', async () => {
    const eps: [string, number][] = [
      ['Frieren', 1 * HOUR],
      ['Frieren', 2 * HOUR],
      ['One Piece', 3 * HOUR],
      ['Old Show', 30 * HOUR],
    ];
    const { f, calls } = fakeApps({ episodes: eps, movies: [['Dune', 5 * HOUR]] });
    const n = await gatherNews(sources(f), T0 - 24 * HOUR, T0, 1000);
    expect(n.episodes).toBe(3);
    expect(n.shows).toEqual([{ title: 'Frieren', n: 2 }, { title: 'One Piece', n: 1 }]);
    expect(n.movies).toEqual(['Dune']);
    expect(n.failed).toEqual([]);
    // One page each: the first page already reached past `since`.
    expect(calls.filter((c) => c.includes('/history'))).toHaveLength(2);
    // Titles: one lookup per show or movie named, at most three each.
    expect(calls.filter((c) => !c.includes('/history'))).toHaveLength(3);
  });

  it('reads at most three pages and says the count is a floor', async () => {
    const eps = Array.from({ length: 1000 }, (_, i) => ['Frieren', i * 1000] as [string, number]);
    const { f, calls } = fakeApps({ episodes: eps });
    const n = await gatherNews(sources(f), T0 - 24 * HOUR, T0, 1000);
    expect(n.episodes).toBe(600);
    expect(n.capped).toBe(true);
    expect(calls.filter((c) => c.includes(':8989/api/v3/history'))).toHaveLength(3);
  });

  it('counts 300 imports exactly', async () => {
    const eps = Array.from({ length: 300 }, (_, i) => [i % 3 ? 'One Piece' : 'Frieren', i * 60_000] as [string, number]);
    const n = await gatherNews(sources(fakeApps({ episodes: eps }).f), T0 - 24 * HOUR, T0, 1000);
    expect(n.episodes).toBe(300);
    expect(n.capped).toBe(false);
    expect(digestLine(n, [])).toBe('300 new episodes of One Piece and Frieren.');
  });

  it('keeps what answered when one app is down', async () => {
    const { f } = fakeApps({ episodes: [['Frieren', HOUR]], fail: ['radarr'] });
    const n = await gatherNews(sources(f), T0 - 24 * HOUR, T0, 1000);
    expect(n.episodes).toBe(1);
    expect(n.failed).toEqual(['Radarr']);
  });

  it('gives up on apps and servers that take too long', async () => {
    const { f } = fakeApps({ hang: ['sonarr', 'radarr'] });
    const slow = () => new Promise<McStatus>(() => undefined);
    const t = Date.now();
    const n = await gatherNews(sources(f, { servers: [{ name: 'Survival', host: 'h', port: 1, kind: 'minecraft' }], ping: slow }), T0 - HOUR, T0, 80);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(n.episodes).toBe(0);
    expect(n.failed).toContain('Survival');
    expect(n.failed.join()).toMatch(/Sonarr|media apps/);
  });

  it('falls back to Plex when Sonarr and Radarr are not set up', async () => {
    const at = (h: number) => Math.round((T0 - h * HOUR) / 1000);
    const { f } = fakeApps({
      plex: [
        { type: 'episode', title: 'Ep', grandparentTitle: 'Frieren', addedAt: at(1) },
        { type: 'movie', title: 'Dune', addedAt: at(2) },
        { type: 'movie', title: 'Old', addedAt: at(50) },
      ],
    });
    const n = await gatherNews({ media: { plex: { url: 'http://127.0.0.1:32400', token: 't' }, timezone: 'UTC' }, servers: [], ping: async () => ({ online: true }), fetch: f }, T0 - 24 * HOUR, T0, 1000);
    expect(n.shows).toEqual([{ title: 'Frieren', n: 1 }]);
    expect(n.movies).toEqual(['Dune']);
  });

  it('reports servers up and down', async () => {
    const ping = async (host: string) => ({ online: host === 'up' });
    const n = await gatherNews(
      sources(fakeApps({}).f, { servers: [{ name: 'A', host: 'up', port: 1, kind: 'minecraft' }, { name: 'B', host: 'down', port: 1, kind: 'minecraft' }], ping }),
      T0 - HOUR,
      T0,
      1000,
    );
    expect(n.servers).toEqual({ A: true, B: false });
  });

  it('keeps imports within the window for a past week', async () => {
    const { f } = fakeApps({ episodes: [['Late', HOUR], ['In', 3 * 24 * HOUR], ['Early', 9 * 24 * HOUR]] });
    const m = await newMedia(sources(f), T0 - 7 * 24 * HOUR, T0 - 2 * HOUR, AbortSignal.timeout(1000));
    expect(m.shows.map((s) => s.title)).toEqual(['In']);
  });
});
