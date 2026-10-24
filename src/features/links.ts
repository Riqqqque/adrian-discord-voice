// Links people paste in Discord, so "play that link I just sent" works.
// Only sites the music player can actually play are kept (YouTube, YouTube
// Music, SoundCloud, Bandcamp; Spotify is looked up by its title on YouTube),
// so a pasted link can never make the server fetch an arbitrary address.
// Memory only, for half an hour.

export type MediaLink =
  | { kind: 'youtube'; id: string; url: string }
  | { kind: 'youtube-list'; list: string; url: string }
  | { kind: 'soundcloud' | 'bandcamp'; url: string }
  | { kind: 'spotify'; url: string };

const VIDEO_ID = /^[\w-]{11}$/;
const LIST_ID = /^[\w-]{10,64}$/;

/** A link the music player can play, or undefined. */
export function parseMediaLink(raw: string): MediaLink | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/^<|>$/g, ''));
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return undefined;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const path = u.pathname;
  if (host === 'youtu.be') {
    const id = path.slice(1).split('/')[0] ?? '';
    return VIDEO_ID.test(id) ? { kind: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` } : undefined;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v') ?? '';
    const short = /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(path)?.[1];
    const id = path === '/watch' && VIDEO_ID.test(v) ? v : short;
    if (id) return { kind: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` };
    const list = u.searchParams.get('list') ?? '';
    if (path === '/playlist' && LIST_ID.test(list)) return { kind: 'youtube-list', list, url: `https://www.youtube.com/playlist?list=${list}` };
    return undefined;
  }
  const clean = `https://${host}${path.replace(/\/+$/, '')}`;
  if (host === 'soundcloud.com' && /^\/[\w-]+\/[\w-]+(?:\/sets\/[\w-]+)?$/.test(path.replace(/\/+$/, ''))) return { kind: 'soundcloud', url: clean };
  if (host === 'on.soundcloud.com' && /^\/\w+$/.test(path)) return { kind: 'soundcloud', url: clean };
  if (/^[a-z0-9-]+\.bandcamp\.com$/.test(host) && /^\/(?:track|album)\/[\w-]+$/.test(path.replace(/\/+$/, ''))) return { kind: 'bandcamp', url: clean };
  if (host === 'open.spotify.com' && /^\/(?:intl-[a-z-]+\/)?(?:track|album|playlist)\/\w{22}$/.test(path.replace(/\/+$/, ''))) return { kind: 'spotify', url: clean };
  return undefined;
}

/** Every playable link in a message (text and embeds), in order. */
export function mediaLinksIn(text: string): MediaLink[] {
  const out: MediaLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/<?https?:\/\/[^\s<>()]+>?/gi)) {
    const l = parseMediaLink(m[0]);
    if (l && !seen.has(l.url)) {
      seen.add(l.url);
      out.push(l);
    }
  }
  return out;
}

export interface PastedLink {
  link: MediaLink;
  userId: string;
  name: string;
  guildId?: string;
  channelId: string;
  at: number;
}

const KEEP_MS = 30 * 60_000;
const MAX = 50;

export class RecentLinks {
  private items: PastedLink[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  add(p: Omit<PastedLink, 'at'>): void {
    this.items.push({ ...p, at: this.now() });
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
  }

  private fresh(): PastedLink[] {
    const cutoff = this.now() - KEEP_MS;
    this.items = this.items.filter((i) => i.at >= cutoff);
    return this.items;
  }

  /** "That link": the asker's own latest (anywhere, DMs too), else the latest
   *  anyone posted in this server in the last 10 minutes. */
  latestFor(userId: string, guildId?: string): PastedLink | undefined {
    const all = this.fresh();
    const mine = all.filter((i) => i.userId === userId).at(-1);
    if (mine) return mine;
    const recent = this.now() - 10 * 60_000;
    return all.filter((i) => i.at >= recent && (!guildId || i.guildId === guildId)).at(-1);
  }

  /** For the prompt: the newest few in this server (and the asker's DMs). */
  forPrompt(userId: string, guildId?: string, max = 5): PastedLink[] {
    return this.fresh()
      .filter((i) => i.userId === userId || (guildId && i.guildId === guildId))
      .slice(-max)
      .reverse();
  }
}

/** A prompt line listing recent links, so "play the one Sam sent" works. */
export function linksLine(links: PastedLink[], now = Date.now()): string[] {
  if (!links.length) return [];
  const ago = (t: number) => {
    const m = Math.round((now - t) / 60_000);
    return m < 1 ? 'just now' : `${m} min ago`;
  };
  return [`Links pasted in chat (newest first; to play one, call play_music with request_type link and the exact URL as query): ${links.map((l) => `${l.name}, ${ago(l.at)}: ${l.link.url}`).join('; ')}.`];
}

/** "play that link", "play the video I just sent", "put on what I pasted"... */
export const PLAY_THAT_LINK =
  /^\W*(?:(?:hey|ok(?:ay)?|yo|so|and|alright|bro)\W+)*(?:adri\w*\W+)?(?:(?:can|could|would|will) you (?:please )?|please )?(?:play|put on|throw on|queue(?: up)?|start|bump|blast)\s+(?:(?:that|the|this|my)\s+(?:link|url|video|song|track|one|thing)(?:\s+(?:i|he|she|they|someone|we)\s+(?:just\s+)?(?:sent|posted|pasted|dropped|shared|linked|put in(?: the)? chat)(?:\s+in(?: the)? chat)?)?|what\s+(?:i|he|she|they|someone)\s+(?:just\s+)?(?:sent|posted|pasted|dropped|shared|linked))(?:\s+(?:please|for me|now|real quick))*\W*$/i;

export interface SpotifyItem {
  kind: 'song' | 'album' | 'playlist';
  /** Search words for YouTube Music, e.g. "Blinding Lights The Weeknd". */
  query: string;
}

/** What a Spotify page is (song, album or playlist and its name), to find on
 *  YouTube: Spotify itself can't be streamed. Reads the page's og: tags. */
export async function spotifyItem(url: string, signal: AbortSignal, f: typeof fetch = fetch): Promise<SpotifyItem | undefined> {
  const r = await f(url, { signal, headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' }, redirect: 'follow' });
  if (!r.ok || !new URL(r.url || url).hostname.endsWith('spotify.com')) return undefined;
  const html = (await r.text()).slice(0, 300_000);
  const meta = (name: string) =>
    new RegExp(`<meta[^>]+(?:property|name)="${name}"[^>]+content="([^"]*)"`, 'i').exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${name}"`, 'i').exec(html)?.[1];
  const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const raw = meta('og:title');
  if (!raw) return undefined;
  // Tracks: og:title "Blinding Lights", og:description "The Weeknd · After Hours · Song · 2020".
  // Albums/playlists: "Listen to After Hours - Album by The Weeknd | Spotify".
  const title = decode(raw)
    .replace(/^Listen to\s+/i, '')
    .replace(/\s*\|\s*Spotify$/i, '')
    .replace(/\s+-\s+(?:Album|Single|EP|Playlist)\s+by\s+.*$/i, '');
  const artist = decode(meta('og:description') ?? '').split('·')[0]?.trim();
  const kind = /\/album\//.test(url) ? 'album' : /\/playlist\//.test(url) ? 'playlist' : 'song';
  const query = (kind !== 'playlist' && artist && !/^listen/i.test(artist) ? `${title} ${artist}` : title).slice(0, 200);
  return query ? { kind, query } : undefined;
}
