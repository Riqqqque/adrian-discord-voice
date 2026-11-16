// Top headlines from a few news feeds (RSS or Atom), for the morning briefing
// and "what's in the news". Only titles: no article text, no AI summary that
// could state a guess as fact. Feeds are set in the config; headlines are
// other people's words, so the model reads them as data.

import type { Tool } from '../core/interfaces.js';

type Fetch = typeof fetch;

const CACHE_MS = 30 * 60_000;
const TIMEOUT_MS = 6_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TITLE = 140;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };

/** Text inside a feed's title element: CDATA, entities and stray tags gone. */
export function feedText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
}

/** Item titles from an RSS or Atom feed, in feed order. */
export function feedTitles(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(m[0]);
    const text = t ? feedText(t[1]!) : '';
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

export class Headlines {
  private cache: { at: number; titles: string[] } | undefined;

  constructor(
    private readonly feeds: readonly string[],
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get usable(): boolean {
    return this.feeds.length > 0;
  }

  private async read(url: string, signal?: AbortSignal): Promise<string[]> {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const res = await this.fetchFn(url, { signal: sig, headers: { accept: 'application/rss+xml, application/atom+xml, text/xml' } });
    if (!res.ok) throw new Error(`feed answered ${res.status}`);
    if (res.url && !res.url.startsWith('https://')) throw new Error('feed left https');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('feed too big');
    return feedTitles(new TextDecoder().decode(buf));
  }

  /** The top `n`, taking turns between feeds. */
  async top(n: number, signal?: AbortSignal): Promise<string[]> {
    if (!this.cache || this.now() - this.cache.at >= CACHE_MS) {
      const lists = await Promise.all(this.feeds.map((f) => this.read(f, signal).catch(() => [] as string[])));
      const mixed: string[] = [];
      for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) for (const l of lists) if (l[i] && !mixed.includes(l[i]!)) mixed.push(l[i]!);
      if (!mixed.length) return [];
      this.cache = { at: this.now(), titles: mixed.slice(0, 20) };
    }
    return this.cache.titles.slice(0, n);
  }

  tool(): Tool {
    return {
      slow: true,
      timeoutMs: 8_000,
      route: /\b(news|headlines?|happening (in|around) the world|going on (in|around) the world|current events)\b/i,
      spec: {
        name: 'headlines',
        description: 'Top news headlines right now (titles only). For "what\'s in the news", "any big news". For a specific story, use web_search.',
        parameters: { type: 'object', properties: { count: { type: 'number', description: '1-8, default 4' } }, additionalProperties: false },
      },
      run: async (a, signal) => {
        const n = typeof a.count === 'number' && a.count >= 1 ? Math.min(Math.floor(a.count), 8) : 4;
        const t = await this.top(n, signal);
        return t.length ? t.map((x) => `- ${x}`).join('\n') : "I couldn't get the news just now.";
      },
    };
  }
}
