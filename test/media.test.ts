import { describe, expect, it } from 'vitest';
import { mediaTools } from '../src/features/media.js';

const sig = () => AbortSignal.timeout(2000);
const ctx = { userId: 'a', speaker: 'R' };
const seen: { url: string; headers: Headers; method: string }[] = [];
const fake = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  seen.push({ url, headers: new Headers(init?.headers), method: init?.method ?? 'GET' });
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/library/recentlyAdded'))
    return ok({ MediaContainer: { Metadata: [{ type: 'movie', title: 'Dune: Part Three', year: 2026, addedAt: 1792100000 }, { type: 'episode', grandparentTitle: 'Severance', parentIndex: 3, index: 2, title: 'Hello', addedAt: 1792000000 }] } });
  if (url.includes('/hubs/search')) return ok({ MediaContainer: { Hub: [{ type: 'movie', Metadata: [{ type: 'movie', title: 'Dune', year: 2021 }] }, { type: 'actor', Metadata: [{ title: 'Zendaya' }] }] } });
  if (url.includes(':8989/api/v3/queue')) return ok({ records: [{ series: { title: 'Severance' }, episode: { seasonNumber: 3, episodeNumber: 3 }, size: 2e9, sizeleft: 5e8, timeleft: '00:04:10', status: 'downloading' }] });
  if (url.includes(':7878/api/v3/queue')) return ok({ records: [] });
  if (url.includes('/api/v3/calendar')) return ok([{ series: { title: 'The Apothecary Diaries' }, seasonNumber: 3, episodeNumber: 3, title: 'Let Them Eat Cake', airDateUtc: '2026-10-16T14:00:00Z', hasFile: false }]);
  return new Response('no', { status: 404 });
}) as typeof fetch;

const tools = mediaTools(
  { plex: { url: 'http://127.0.0.1:32400', token: 'plex-tok' }, sonarr: { url: 'http://127.0.0.1:8989', apiKey: 'son-key' }, radarr: { url: 'http://127.0.0.1:7878', apiKey: 'rad-key' }, timezone: 'America/Denver' },
  fake,
);
const run = (n: string, a: Record<string, unknown> = {}) => tools.find((t) => t.spec.name === n)!.run(a, sig(), ctx);

describe('media tools', () => {
  it('describes recent Plex additions and searches movies and shows only', async () => {
    expect(await run('plex_recently_added')).toContain('Dune: Part Three (2026) [movie]');
    expect(await run('plex_recently_added')).toContain('Severance season 3 episode 2 "Hello"');
    const s = await run('plex_search', { title: 'dune' });
    expect(s).toBe('On Plex: Dune (2021) [movie]');
  });

  it('reports downloads and upcoming episodes', async () => {
    expect(await run('downloads')).toBe('Severance S3E3: downloading, 75%, 00:04:10 left');
    expect(await run('upcoming_episodes')).toContain('The Apothecary Diaries S3E3 "Let Them Eat Cake", Fri, Oct 16');
  });

  it('only reads, and each key goes only to its own app', () => {
    for (const s of seen) {
      expect(s.method).toBe('GET');
      if (s.headers.get('x-plex-token')) expect(s.url).toContain(':32400');
      if (s.headers.get('x-api-key') === 'son-key') expect(s.url).toContain(':8989');
      if (s.headers.get('x-api-key') === 'rad-key') expect(s.url).toContain(':7878');
    }
  });

  it('leaves out apps without keys', () => {
    expect(mediaTools({ timezone: 'UTC' })).toEqual([]);
    expect(mediaTools({ sonarr: { url: 'x', apiKey: 'k' }, timezone: 'UTC' }).map((t) => t.spec.name)).toEqual(['downloads', 'upcoming_episodes']);
  });
});
