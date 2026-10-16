// Read-only Plex, Sonarr and Radarr: what's new, what's in the library,
// what's downloading, what's coming up. Only GET requests to local apps;
// nothing is requested, deleted or changed.

import type { Tool } from '../core/interfaces.js';

type Fetch = typeof fetch;

export interface MediaConfig {
  plex?: { url: string; token: string };
  sonarr?: { url: string; apiKey: string };
  radarr?: { url: string; apiKey: string };
  timezone: string;
}

async function getJson<T>(f: Fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<T> {
  const r = await f(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
  if (!r.ok) throw new Error(`${new URL(url).port === '32400' ? 'Plex' : 'the media app'} answered ${r.status}`);
  return (await r.json()) as T;
}

interface PlexItem {
  type?: string;
  title?: string;
  grandparentTitle?: string;
  parentTitle?: string;
  parentIndex?: number;
  index?: number;
  year?: number;
  addedAt?: number;
  leafCount?: number;
}

function plexLabel(m: PlexItem): string {
  if (m.type === 'episode') return `${m.grandparentTitle} season ${m.parentIndex} episode ${m.index} "${m.title}"`;
  if (m.type === 'season') return `${m.parentTitle} ${m.title}${m.leafCount ? ` (${m.leafCount} episodes)` : ''}`;
  if (m.type === 'movie') return `${m.title}${m.year ? ` (${m.year})` : ''} [movie]`;
  if (m.type === 'show') return `${m.title}${m.year ? ` (${m.year})` : ''} [show]`;
  return `${m.title ?? 'untitled'}${m.type ? ` [${m.type}]` : ''}`;
}

function sizeGb(b: number): string {
  return `${(b / 1e9).toFixed(1)} GB`;
}

export function mediaTools(c: MediaConfig, f: Fetch = fetch): Tool[] {
  const tools: Tool[] = [];
  const day = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: c.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(ms);

  if (c.plex) {
    const { url, token } = c.plex;
    const h = { 'X-Plex-Token': token };
    tools.push(
      {
        spec: {
          name: 'plex_recently_added',
          description: 'What was recently added to the household Plex server (movies, shows, episodes), newest first.',
          parameters: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
        },
        run: async (a, signal) => {
          const n = Math.min(15, Math.max(1, typeof a.limit === 'number' ? Math.round(a.limit) : 8));
          const j = await getJson<{ MediaContainer?: { Metadata?: PlexItem[] } }>(
            f, `${url}/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=${n}`, h, signal);
          const items = j.MediaContainer?.Metadata ?? [];
          return items.length ? items.map((m) => `${plexLabel(m)}${m.addedAt ? `, added ${day(m.addedAt * 1000)}` : ''}`).join('\n') : 'Nothing recently added.';
        },
      },
      {
        spec: {
          name: 'plex_search',
          description: 'Check whether a movie or show is on the household Plex server.',
          parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
        },
        run: async (a, signal) => {
          const q = typeof a.title === 'string' ? a.title.trim().slice(0, 100) : '';
          if (!q) return 'Give a title.';
          const j = await getJson<{ MediaContainer?: { Hub?: { type?: string; Metadata?: PlexItem[] }[] } }>(
            f, `${url}/hubs/search?query=${encodeURIComponent(q)}&limit=5`, h, signal);
          const items = (j.MediaContainer?.Hub ?? [])
            .filter((x) => x.type === 'movie' || x.type === 'show')
            .flatMap((x) => x.Metadata ?? [])
            .slice(0, 6);
          return items.length ? `On Plex: ${items.map(plexLabel).join('; ')}` : `Nothing on Plex matches "${q}".`;
        },
      },
    );
  }

  if (c.sonarr || c.radarr) {
    tools.push({
      spec: {
        name: 'downloads',
        description: 'What shows and movies are downloading right now, with progress and time left.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      run: async (_a, signal) => {
        const lines: string[] = [];
        if (c.sonarr) {
          const j = await getJson<{ records?: { series?: { title?: string }; episode?: { seasonNumber?: number; episodeNumber?: number }; size?: number; sizeleft?: number; timeleft?: string; status?: string }[] }>(
            f, `${c.sonarr.url}/api/v3/queue?pageSize=15&includeSeries=true&includeEpisode=true`, { 'X-Api-Key': c.sonarr.apiKey }, signal);
          for (const r of j.records ?? []) {
            const pct = r.size ? Math.round(100 * (1 - (r.sizeleft ?? 0) / r.size)) : 0;
            lines.push(`${r.series?.title} S${r.episode?.seasonNumber}E${r.episode?.episodeNumber}: ${r.status}, ${pct}%${r.timeleft && r.status !== 'completed' ? `, ${r.timeleft} left` : ''}`);
          }
        }
        if (c.radarr) {
          const j = await getJson<{ records?: { movie?: { title?: string }; size?: number; sizeleft?: number; timeleft?: string; status?: string }[] }>(
            f, `${c.radarr.url}/api/v3/queue?pageSize=15&includeMovie=true`, { 'X-Api-Key': c.radarr.apiKey }, signal);
          for (const r of j.records ?? []) {
            const pct = r.size ? Math.round(100 * (1 - (r.sizeleft ?? 0) / r.size)) : 0;
            lines.push(`${r.movie?.title} (movie, ${r.size ? sizeGb(r.size) : '?'}): ${r.status}, ${pct}%${r.timeleft && r.status !== 'completed' ? `, ${r.timeleft} left` : ''}`);
          }
        }
        return lines.length ? lines.join('\n') : 'Nothing is downloading.';
      },
    });
  }

  if (c.sonarr) {
    const { url, apiKey } = c.sonarr;
    tools.push({
      spec: {
        name: 'upcoming_episodes',
        description: 'New episodes of the household\'s tracked shows airing soon (default the next 7 days).',
        parameters: { type: 'object', properties: { days: { type: 'number' } }, additionalProperties: false },
      },
      run: async (a, signal) => {
        const days = Math.min(30, Math.max(1, typeof a.days === 'number' ? Math.round(a.days) : 7));
        const start = new Date();
        const end = new Date(start.getTime() + days * 86_400_000);
        const j = await getJson<{ series?: { title?: string }; seasonNumber?: number; episodeNumber?: number; title?: string; airDateUtc?: string; hasFile?: boolean }[]>(
          f, `${url}/api/v3/calendar?start=${start.toISOString()}&end=${end.toISOString()}&includeSeries=true`, { 'X-Api-Key': apiKey }, signal);
        return j.length
          ? j.slice(0, 15).map((e) => `${e.series?.title} S${e.seasonNumber}E${e.episodeNumber} "${e.title}", ${e.airDateUtc ? day(Date.parse(e.airDateUtc)) : 'date unknown'}${e.hasFile ? ' (already downloaded)' : ''}`).join('\n')
          : `No episodes in the next ${days} days.`;
      },
    });
  }
  return tools;
}
