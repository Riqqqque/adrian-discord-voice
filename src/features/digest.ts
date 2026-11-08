// What's new since someone was last around: new episodes and movies (Sonarr
// and Radarr import history, or Plex's recently added when those aren't set
// up) and the game servers' status. Fetched only when asked, bounded, with a
// time limit; coalesced into one short line for speaking.

import { dateFormat } from '../core/time.js';
import { getJson, type MediaConfig } from './media.js';
import type { GameServer, McStatus } from './gameservers.js';

type Fetch = typeof fetch;

/** History pages read per app, and their size: at most 600 imports looked at. */
const PAGE = 200;
const MAX_PAGES = 3;
/** Plex's recently added list, at most this many items. */
const PLEX_ITEMS = 300;
/** The longest a title may be in a spoken line or a recap. */
const MAX_TITLE = 48;
/** The most a spoken digest may be. */
export const MAX_WORDS = 25;

export interface Media {
  /** New episodes per show, most first. */
  shows: { title: string; n: number }[];
  episodes: number;
  /** Newest first, one per movie; only the first few have a title, the rest are ''. */
  movies: string[];
  /** More than the pages read: the counts are a floor. */
  capped: boolean;
}

export interface News extends Media {
  /** Game server up (true) or down (false), by name; missing: no answer. */
  servers: Record<string, boolean>;
  /** Sources that failed or ran out of time. */
  failed: string[];
}

export const cleanTitle = (s: string | undefined): string => {
  const t = (s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
};

function tally(map: Map<string, number>): { title: string; n: number }[] {
  return [...map].map(([title, n]) => ({ title, n })).sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));
}

interface HistoryRecord {
  episodeId?: number;
  seriesId?: number;
  movieId?: number;
  date?: string;
}

/** Titles are looked up for this many shows or movies; the rest are only counted. */
const NAMED = 3;

/** Imports from a Sonarr or Radarr history, within (since, until]. Upgrades of
 *  the same episode or movie count once. The records are read without their
 *  series or movie (each would carry its whole entry, images and all), and
 *  only the top few titles are looked up. */
async function imports(
  f: Fetch,
  app: { url: string; apiKey: string },
  kind: 'series' | 'movie',
  since: number,
  until: number,
  signal: AbortSignal,
): Promise<{ titles: { title: string; n: number }[]; count: number; capped: boolean }> {
  /** Per series (episodes) or movie: count, in order of the newest import. */
  const per = new Map<number, number>();
  const seen = new Set<number>();
  let capped = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    // eventType 3: downloadFolderImported, in both apps.
    const j = await getJson<{ records?: HistoryRecord[] }>(
      f,
      `${app.url}/api/v3/history?page=${page}&pageSize=${PAGE}&sortKey=date&sortDirection=descending&eventType=3`,
      { 'X-Api-Key': app.apiKey },
      signal,
    );
    const recs = j.records ?? [];
    let older = false;
    for (const r of recs) {
      const at = Date.parse(r.date ?? '');
      if (!Number.isFinite(at)) continue;
      if (at <= since) {
        older = true;
        break;
      }
      if (at > until) continue;
      const item = kind === 'series' ? r.episodeId : r.movieId;
      const group = kind === 'series' ? r.seriesId : r.movieId;
      if (typeof item !== 'number' || typeof group !== 'number' || seen.has(item)) continue;
      seen.add(item);
      per.set(group, (per.get(group) ?? 0) + 1);
    }
    if (older || recs.length < PAGE) break;
    if (page === MAX_PAGES) capped = true;
  }
  // Most first; for movies (one each) the newest first, as imported.
  const order = [...per].sort((a, b) => b[1] - a[1]);
  const named = await Promise.all(
    order.slice(0, NAMED).map(([id]) =>
      getJson<{ title?: string }>(f, `${app.url}/api/v3/${kind}/${id}`, { 'X-Api-Key': app.apiKey }, signal).then(
        (x) => cleanTitle(x.title),
        () => '',
      ),
    ),
  );
  return { titles: order.map(([, n], i) => ({ title: named[i] ?? '', n })), count: order.reduce((a, [, n]) => a + n, 0), capped };
}

interface PlexItem {
  type?: string;
  title?: string;
  grandparentTitle?: string;
  parentTitle?: string;
  addedAt?: number;
  leafCount?: number;
}

/** Plex's recently added, within (since, until]. A season stands for its episodes. */
async function plexAdded(f: Fetch, plex: { url: string; token: string }, since: number, until: number, signal: AbortSignal) {
  const j = await getJson<{ MediaContainer?: { Metadata?: PlexItem[] } }>(
    f,
    `${plex.url}/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=${PLEX_ITEMS}`,
    { 'X-Plex-Token': plex.token },
    signal,
  );
  const items = (j.MediaContainer?.Metadata ?? []).slice(0, PLEX_ITEMS);
  const shows = new Map<string, number>();
  const movies: string[] = [];
  let all = true;
  for (const m of items) {
    const at = (m.addedAt ?? 0) * 1000;
    if (at <= since) {
      all = false;
      continue;
    }
    if (at > until) continue;
    if (m.type === 'episode') {
      const t = cleanTitle(m.grandparentTitle) || 'a show';
      shows.set(t, (shows.get(t) ?? 0) + 1);
    } else if (m.type === 'season') {
      const t = cleanTitle(m.parentTitle) || 'a show';
      shows.set(t, (shows.get(t) ?? 0) + Math.max(1, m.leafCount ?? 1));
    } else if (m.type === 'movie') {
      const t = cleanTitle(m.title);
      if (t && !movies.includes(t)) movies.push(t);
    }
  }
  return { shows, movies, capped: all && items.length >= PLEX_ITEMS };
}

export interface Sources {
  media: MediaConfig;
  servers: GameServer[];
  ping: (host: string, port: number) => Promise<McStatus>;
  fetch?: Fetch;
}

export const hasSources = (s: Sources) => !!(s.media.plex || s.media.sonarr || s.media.radarr || s.servers.length);

/** New episodes and movies in (since, until]. Sonarr and Radarr when set up
 *  (exact), else Plex. A source that fails is named in `failed`. */
export async function newMedia(s: Sources, since: number, until: number, signal: AbortSignal): Promise<Media & { failed: string[] }> {
  const f = s.fetch ?? fetch;
  const failed: string[] = [];
  const m = s.media;
  const out: Media & { failed: string[] } = { shows: [], episodes: 0, movies: [], capped: false, failed };
  const usePlex = !!m.plex && (!m.sonarr || !m.radarr);
  const [son, rad, plex] = await Promise.all([
    m.sonarr ? imports(f, m.sonarr, 'series', since, until, signal).catch(() => void failed.push('Sonarr')) : undefined,
    m.radarr ? imports(f, m.radarr, 'movie', since, until, signal).catch(() => void failed.push('Radarr')) : undefined,
    usePlex ? plexAdded(f, m.plex!, since, until, signal).catch(() => void failed.push('Plex')) : undefined,
  ]);
  if (son) {
    out.shows = son.titles;
    out.episodes = son.count;
    out.capped ||= son.capped;
  } else if (!m.sonarr && plex) {
    out.shows = tally(plex.shows);
    out.episodes = out.shows.reduce((a, b) => a + b.n, 0);
    out.capped ||= plex.capped;
  }
  if (rad) {
    out.movies = rad.titles.map((t) => t.title);
    out.capped ||= rad.capped;
  } else if (!m.radarr && plex) {
    out.movies = plex.movies;
    out.capped ||= plex.capped;
  }
  return out;
}

/** Everything new since `since`, within `timeoutMs`: whatever didn't answer in time is left out. */
export async function gatherNews(s: Sources, since: number, now: number, timeoutMs: number, signal?: AbortSignal): Promise<News> {
  const limit = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, limit]) : limit;
  const failed: string[] = [];
  const timeout = new Promise<'timeout'>((r) => {
    if (sig.aborted) r('timeout');
    sig.addEventListener('abort', () => r('timeout'), { once: true });
  });
  const media = Promise.race([newMedia(s, since, now, sig), timeout]);
  const servers = Promise.all(
    s.servers.map(async (g) => {
      const st = await Promise.race([s.ping(g.host, g.port).catch(() => ({ online: false, error: 'unreachable' }) as McStatus), timeout]);
      return [g.name, st] as const;
    }),
  );
  const [m, sv] = await Promise.all([media, servers]);
  const out: News = { shows: [], episodes: 0, movies: [], capped: false, servers: {}, failed };
  if (m === 'timeout') {
    if (s.media.sonarr || s.media.radarr || s.media.plex) failed.push('the media apps');
  } else {
    Object.assign(out, { shows: m.shows, episodes: m.episodes, movies: m.movies, capped: m.capped });
    failed.push(...m.failed);
  }
  for (const [name, st] of sv) {
    if (st === 'timeout') failed.push(name);
    // "No answer" from a server that's down is an answer: it's down.
    else out.servers[name] = st.online;
  }
  return out;
}

// --- one spoken line -----------------------------------------------------------

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function episodesPart(m: Media, names: number): string | undefined {
  const n = m.episodes;
  if (!n) return undefined;
  const count = m.capped ? `over ${n}` : `${n}`;
  const top = m.shows.slice(0, names).map((s) => s.title).filter(Boolean);
  if (m.shows.length === 1 && top.length) return n === 1 && !m.capped ? `a new ${top[0]} episode` : `${count} new ${top[0]} episodes`;
  if (n === 1 && !m.capped) return 'a new episode';
  if (!top.length) return `${count} new episodes`;
  if (m.shows.length === 2 && top.length >= 2) return `${count} new episodes of ${list(top)}`;
  const covered = m.shows.slice(0, top.length).reduce((a, b) => a + b.n, 0);
  return `${count} new episodes, ${covered * 2 >= n ? 'mostly' : 'including'} ${list(top)}`;
}

function moviesPart(m: Media, names: number): string | undefined {
  const n = m.movies.length;
  if (!n) return undefined;
  const count = m.capped ? `over ${n}` : `${n}`;
  const titles = m.movies.slice(0, Math.min(names, 2)).filter(Boolean);
  if (n <= 2 && titles.length === n) return `${list(titles)} finished downloading`;
  if (n === 1) return 'a new movie';
  if (!titles.length) return `${count} new movies`;
  return `${count} new movies, including ${list(titles)}`;
}

function serversPart(down: string[], names: boolean): string | undefined {
  if (!down.length) return undefined;
  if (!names) return down.length === 1 ? 'a game server is down' : `${down.length} game servers are down`;
  const shown = down.slice(0, 3);
  // "Survival Server" is down, not "the Survival Server server".
  if (shown.some((n) => /\bserver\b/i.test(n))) return `${list(shown)} ${shown.length === 1 ? 'is' : 'are'} down`;
  return shown.length === 1 ? `the ${shown[0]} server is down` : `the ${list(shown)} servers are down`;
}

/** One line, at most `maxWords`, about what's new; undefined when nothing is.
 *  Detail goes first when it won't fit: names, then the lead. */
export function digestLine(m: Media, serversDown: string[], opts: { since?: string; lead?: string; maxWords?: number } = {}): string | undefined {
  const max = opts.maxWords ?? MAX_WORDS;
  const levels: [number, number, boolean][] = [
    [2, 2, true],
    [1, 1, true],
    [1, 0, true],
    [0, 0, true],
    [0, 0, false],
  ];
  let last = '';
  for (const [shows, movies, srv] of levels) {
    const parts = [episodesPart(m, shows), moviesPart(m, movies), serversPart(serversDown, srv)].filter((p): p is string => !!p);
    if (!parts.length) return undefined;
    // "a and b", "a, mostly x, and b", "a, b, and c".
    const body =
      parts.length === 1 ? parts[0]! : parts.length === 2 && !parts[0]!.includes(',') ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
    const head = [opts.lead, opts.since].filter(Boolean).join(', ');
    const line = head ? `${head}: ${body}.` : `${body[0]!.toUpperCase()}${body.slice(1)}.`;
    last = line;
    if (words(line) <= max) return capitalize(line);
  }
  // Still too long (very long names): cut whole words.
  return capitalize(`${last.split(/\s+/).slice(0, max).join(' ').replace(/[,:;]$/, '')}.`.replace(/\.\.$/, '.'));
}

const capitalize = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

// --- "since yesterday" -------------------------------------------------------

function localDate(ms: number, tz: string): string {
  const p = Object.fromEntries(dateFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const dayNumber = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86_400_000;

/** "since earlier today", "since yesterday", "since Tuesday", "since October 3". */
export function sinceWords(since: number, now: number, tz: string): string {
  const days = dayNumber(localDate(now, tz)) - dayNumber(localDate(since, tz));
  if (days <= 0) return 'since earlier today';
  if (days === 1) return 'since yesterday';
  if (days < 7) return `since ${dateFormat('en-US', { timeZone: tz, weekday: 'long' }).format(since)}`;
  return `since ${dateFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(since)}`;
}
