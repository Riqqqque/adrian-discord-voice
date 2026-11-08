// Steam, read-only: which friends are online and what they're playing, what's
// on sale from a wishlist, and what a game costs. Nothing is polled: every
// answer is fetched when asked, and kept a short while in small caches.
//
// Each person's own Steam account only (steam.accounts maps a Discord ID to a
// SteamID64). Another member's account is used only when steam.shareWithServer
// is on and that member has one linked. SteamIDs never appear in answers.
// Friend names and the games they show are written by other people: they are
// cleaned and shortened before being said.

import type { Tool, ToolContext } from '../core/interfaces.js';

type Fetch = typeof fetch;

export const STEAM_KEY = 'STEAM_API_KEY';
const WEB = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com';

/** One request's longest wait. */
const REQUEST_MS = 4_000;
/** Biggest reply read (a large wishlist is ~100 KB). */
const MAX_BODY = 4 * 1024 * 1024;
/** After a 429, Steam is left alone this long. */
const PAUSE_MS = 60_000;
/** Steam allows 100k Web API calls a day per key; this stays far under it. */
const WEB_PER_DAY = 20_000;
/** The store has no key and limits by address (about 200 per 5 minutes). */
const STORE_PER_5MIN = 150;

const SUMMARY_MS = 60_000;
const FRIENDS_MS = 10 * 60_000;
const WISHLIST_MS = 30 * 60_000;
const ITEM_MS = 60 * 60_000;
const SEARCH_MS = 60 * 60_000;

/** Most wishlist games checked per question, friends per question. */
export const WISHLIST_CAP = 300;
export const FRIENDS_CAP = 1000;
/** GetItems and GetPlayerSummaries both take up to 100 IDs. */
const BATCH = 100;
/** appdetails price batches, when GetItems is down. */
const PRICE_BATCH = 50;
/** One-by-one appdetails, when batching is refused. */
const ONE_BY_ONE_CAP = 20;

export const STEAMID = /^7656119\d{10}$/;
const VANITY = /^[A-Za-z0-9_-]{2,32}$/;

/** A configured account: a SteamID64, a profile link, or a custom profile name. */
export function parseSteamAccount(v: string): { steamid: string } | { vanity: string } | undefined {
  const s = v.trim();
  if (STEAMID.test(s)) return { steamid: s };
  const m = /^(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/(profiles|id)\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(s);
  if (m) {
    if (m[1]!.toLowerCase() === 'profiles') return STEAMID.test(m[2]!) ? { steamid: m[2]! } : undefined;
    return VANITY.test(m[2]!) ? { vanity: m[2]! } : undefined;
  }
  if (/^\d+$/.test(s)) return undefined; // digits that aren't a SteamID64
  return VANITY.test(s) ? { vanity: s } : undefined;
}

// ---------------------------------------------------------------- caches

/** A bounded map whose entries expire. Reading an entry makes it newest. */
export class TtlCache<V> {
  private readonly m = new Map<string, { at: number; v: V }>();
  constructor(
    private readonly cap: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    this.m.delete(k);
    if (this.now() - e.at >= this.ttlMs) return undefined;
    this.m.set(k, e);
    return e.v;
  }

  set(k: string, v: V): void {
    this.m.delete(k);
    this.m.set(k, { at: this.now(), v });
    while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value!);
  }

  get size(): number {
    return this.m.size;
  }
}

// ---------------------------------------------------------------- errors

type Trouble = 'timeout' | 'busy' | 'down' | 'badkey' | 'unreadable';

export class SteamError extends Error {
  constructor(
    readonly kind: Trouble,
    readonly status?: number,
  ) {
    super(kind);
  }
}

function troubleLine(e: unknown): string {
  const kind = e instanceof SteamError ? e.kind : 'down';
  switch (kind) {
    case 'timeout':
      return "Steam didn't answer in time. Try again in a moment.";
    case 'busy':
      return 'Steam is limiting requests right now. Try again in a minute.';
    case 'badkey':
      return 'Steam turned down the API key. The STEAM_API_KEY secret needs a new key from steamcommunity.com/dev/apikey.';
    case 'unreadable':
      return "Steam sent back something I couldn't read. Try again later.";
    default:
      return "Steam isn't answering right now. Try again later.";
  }
}

// ---------------------------------------------------------------- text helpers

const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };

/** A name reduced for comparing: case, accents, marks, punctuation, numerals. */
export function normName(s: string): string {
  return s
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
        .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .map((w) => NUMBER_WORDS[w] ?? ROMAN[w] ?? w)
    .join(' ');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: string, b: string): number {
  if (a.replace(/ /g, '') === b.replace(/ /g, '')) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let both = 0;
  let total = 0;
  for (const n of A.values()) total += n;
  for (const n of B.values()) total += n;
  for (const [g, n] of A) both += Math.min(n, B.get(g) ?? 0);
  return total ? (2 * both) / total : 0;
}

/** How well a spoken or typed name fits a store name, 0..1. */
export function nameScore(query: string, name: string): number {
  const q = normName(query);
  const n = normName(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const qt = q.split(' ');
  const nt = new Set(n.split(' '));
  if (n.startsWith(`${q} `)) return 0.9 - Math.min(0.2, (n.length - q.length) / 200);
  const all = qt.every((w) => nt.has(w));
  const tokens = all ? 0.85 * Math.pow(qt.length / nt.size, 0.3) : 0;
  return Math.max(tokens, dice(q, n) * 0.85);
}

/** Text someone else wrote (a friend's name, a game they named), safe to say. */
export function cleanText(s: unknown, max: number, fallback: string): string {
  if (typeof s !== 'string') return fallback;
  const t = s
    .replace(/[™®©]/g, '')
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, '')
    .replace(/[<>@#*_~`|[\]{}\\^]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = t.length > max ? t.slice(0, max).trim() : t;
  return /[\p{L}\p{N}]/u.test(cut) ? cut : fallback;
}

function listAnd(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Games Steam can't see, because they aren't launched through it. */
const NOT_ON_STEAM = new Set(
  ['valorant', 'league of legends', 'league', 'lol', 'fortnite', 'minecraft', 'roblox', 'genshin impact', 'world of warcraft', 'wow', 'hearthstone', 'overwatch', 'teamfight tactics', 'tft', 'legends of runeterra', 'honkai star rail', 'zenless zone zero', 'escape from tarkov', 'tarkov'].map(normName),
);
/** "overwatch 2" is on Steam; plain "overwatch" may not be. Only exact names count. */
export const notOnSteam = (game: string) => NOT_ON_STEAM.has(normName(game)) && normName(game) !== 'overwatch';

// ---------------------------------------------------------------- store items

export interface Price {
  /** As Steam formats it, in the configured country's currency ("$47.99"). */
  final: string;
  original?: string;
  pct?: number;
  /** Unix seconds. */
  ends?: number;
  /** The edition this price is for. */
  option: string;
  /** Steam asks for no percentage to be shown (some regions). */
  hidePct?: boolean;
}

export interface StoreItem {
  appid: number;
  /** Steam knows this app at all. */
  known: boolean;
  /** Can be seen in this country's store. */
  visible: boolean;
  name: string;
  /** 0 game, 1 demo, 4 DLC, others: soundtracks, software, video. */
  type: number;
  parent?: number;
  free: boolean;
  comingSoon: boolean;
  comingText?: string;
  release?: number;
  unlisted: boolean;
  /** Steam's pick of the cheapest way to buy it. */
  best?: Price;
  /** The standard edition, when all purchase options were asked for. */
  base?: Price;
  full: boolean;
}

function priceOf(o: any): Price | undefined {
  if (!o || typeof o !== 'object' || typeof o.formatted_final_price !== 'string') return undefined;
  const pct = Number(o.discount_pct);
  const ends = Number(o.active_discounts?.[0]?.discount_end_date);
  return {
    final: cleanText(o.formatted_final_price, 24, '?'),
    ...(typeof o.formatted_original_price === 'string' ? { original: cleanText(o.formatted_original_price, 24, '?') } : {}),
    ...(pct > 0 && pct < 100 ? { pct: Math.round(pct) } : {}),
    ...(ends > 0 ? { ends } : {}),
    option: cleanText(o.purchase_option_name, 80, ''),
    ...(o.hide_discount_pct_for_compliance === true ? { hidePct: true } : {}),
  };
}

export function parseItem(i: any, full: boolean): StoreItem | undefined {
  const appid = Number(i?.appid || i?.id);
  if (!Number.isInteger(appid) || appid <= 0) return undefined;
  const name = cleanText(i.name, 100, '');
  const known = i.success === 1 && !!name;
  const rel = i.release ?? {};
  const comingSoon = rel.is_coming_soon === true || i.is_coming_soon === true;
  const best = priceOf(i.best_purchase_option);
  let base: Price | undefined;
  if (full && Array.isArray(i.purchase_options)) {
    const opts = (i.purchase_options as any[]).map((o) => ({ raw: o, p: priceOf(o) })).filter((o) => o.p) as { raw: any; p: Price }[];
    const same = opts.find((o) => normName(o.p.option) === normName(name));
    const single = opts
      .filter((o) => o.raw.must_purchase_as_set !== true && !o.raw.bundleid)
      .sort((a, b) => Number(a.raw.final_price_in_cents ?? Infinity) - Number(b.raw.final_price_in_cents ?? Infinity));
    base = (same ?? single[0] ?? opts[0])?.p;
  }
  const comingText = cleanText(rel.custom_release_date_message, 40, '');
  const release = Number(rel.steam_release_date);
  return {
    appid,
    known,
    visible: i.visible !== false,
    name: name || `app ${appid}`,
    type: Number.isInteger(i.type) ? i.type : 0,
    ...(Number(i.related_items?.parent_appid) > 0 ? { parent: Number(i.related_items.parent_appid) } : {}),
    free: i.is_free === true,
    comingSoon,
    ...(comingText ? { comingText } : {}),
    ...(release > 0 ? { release } : {}),
    unlisted: i.unlisted === true,
    ...(best ? { best } : {}),
    ...(base ? { base } : {}),
    full,
  };
}

// ---------------------------------------------------------------- the client

export interface SteamOptions {
  /** Discord user ID → SteamID64, profile link or custom profile name. */
  accounts: Record<string, string>;
  /** Two-letter store country; prices come in its currency. */
  country: string;
  /** Let members ask about each other's Steam (only those with an account linked). */
  shareWithServer: boolean;
  apiKey?: string | undefined;
  /** A member's display name, to match "is Alex's wishlist…". */
  nameOf?: (discordId: string) => string;
  timezone?: string;
  fetch?: Fetch;
  now?: () => number;
}

interface Summary {
  name: string;
  state: number;
  game?: string;
  visibility: number;
}

type Who = { steamid: string; self: boolean; label: string };

/** Limits how many requests run at once. */
async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Wait for a shared request, but give up when this caller is cancelled. */
function orCancel<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('cancelled'));
    signal.addEventListener('abort', stop, { once: true });
    p.then(
      (v) => (signal.removeEventListener('abort', stop), resolve(v)),
      (e) => (signal.removeEventListener('abort', stop), reject(e)),
    );
  });
}

export class Steam {
  private readonly f: Fetch;
  private readonly now: () => number;
  readonly country: string;
  private pausedUntil = 0;
  private webDay = { day: '', n: 0 };
  private storeWindow: number[] = [];
  private readonly inflight = new Map<string, Promise<{ status: number; body: any }>>();

  private readonly summaries: TtlCache<Summary>;
  private readonly friendLists: TtlCache<string[]>;
  private readonly wishlists: TtlCache<number[]>;
  private readonly items: TtlCache<StoreItem>;
  private readonly searches: TtlCache<{ id: number; name: string; type: string; price?: { currency: string; initial: number; final: number } }[]>;
  private readonly vanities: TtlCache<string>;

  /** At least one Steam account is linked (steam.accounts). */
  get linked(): boolean {
    return Object.keys(this.o.accounts).length > 0;
  }

  constructor(private readonly o: SteamOptions) {
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.country = /^[A-Za-z]{2}$/.test(o.country) ? o.country.toUpperCase() : 'US';
    this.summaries = new TtlCache(2_000, SUMMARY_MS, this.now);
    this.friendLists = new TtlCache(20, FRIENDS_MS, this.now);
    this.wishlists = new TtlCache(20, WISHLIST_MS, this.now);
    this.items = new TtlCache(3_000, ITEM_MS, this.now);
    this.searches = new TtlCache(200, SEARCH_MS, this.now);
    this.vanities = new TtlCache(50, 7 * 24 * 3600_000, this.now);
  }

  get hasKey(): boolean {
    return !!this.o.apiKey;
  }

  /** Entries held across the caches (for tests and diagnostics). */
  cacheSizes(): Record<string, number> {
    return { summaries: this.summaries.size, friendLists: this.friendLists.size, wishlists: this.wishlists.size, items: this.items.size, searches: this.searches.size };
  }

  // ---- HTTP

  private budget(web: boolean): void {
    const now = this.now();
    if (now < this.pausedUntil) throw new SteamError('busy');
    if (web) {
      const day = new Date(now).toISOString().slice(0, 10);
      if (this.webDay.day !== day) this.webDay = { day, n: 0 };
      if (++this.webDay.n > WEB_PER_DAY) throw new SteamError('busy');
    } else {
      this.storeWindow = this.storeWindow.filter((t) => now - t < 5 * 60_000);
      if (this.storeWindow.length >= STORE_PER_5MIN) throw new SteamError('busy');
      this.storeWindow.push(now);
    }
  }

  /** GET JSON. Same URL at the same time: one request. Never puts the key or
   *  the address into an error. Returns non-2xx statuses the caller handles. */
  private async get(url: string, signal: AbortSignal, handled: number[] = []): Promise<{ status: number; body: any }> {
    let p = this.inflight.get(url);
    if (!p) {
      this.budget(url.startsWith(WEB));
      p = (async () => {
        let r: Response;
        try {
          r = await this.f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_MS) });
        } catch (e) {
          throw new SteamError((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError' ? 'timeout' : 'down');
        }
        if (r.status === 429) {
          this.pausedUntil = this.now() + PAUSE_MS;
          throw new SteamError('busy', 429);
        }
        if (r.status >= 500) throw new SteamError('down', r.status);
        if (!r.ok) return { status: r.status, body: undefined };
        const len = Number(r.headers.get('content-length') ?? 0);
        if (len > MAX_BODY) throw new SteamError('unreadable');
        let text: string;
        try {
          text = await r.text();
        } catch (e) {
          throw new SteamError((e as Error).name === 'TimeoutError' ? 'timeout' : 'down');
        }
        if (text.length > MAX_BODY) throw new SteamError('unreadable');
        try {
          return { status: r.status, body: JSON.parse(text) };
        } catch {
          throw new SteamError('unreadable');
        }
      })();
      this.inflight.set(url, p);
      const forget = () => this.inflight.delete(url);
      p.then(forget, forget);
    }
    const res = await orCancel(p, signal);
    if (res.status >= 200 && res.status < 300) return res;
    if (handled.includes(res.status)) return res;
    if (url.startsWith(WEB) && (res.status === 403 || res.status === 401) && /[?&]key=/.test(url)) throw new SteamError('badkey', res.status);
    throw new SteamError('down', res.status);
  }

  /** A Web API address; the key goes along only where it's needed. */
  private web(path: string, params: Record<string, string>, withKey = true): string {
    const q = new URLSearchParams({ ...(withKey && this.o.apiKey ? { key: this.o.apiKey } : {}), ...params });
    return `${WEB}/${path}?${q}`;
  }

  // ---- accounts

  private mapped(discordId: string): string | undefined {
    return Object.hasOwn(this.o.accounts, discordId) ? this.o.accounts[discordId] : undefined;
  }

  /** Which Steam account a question is about, or the sentence saying why not. */
  async who(ctx: ToolContext, member: unknown, signal: AbortSignal): Promise<Who | string> {
    let target = ctx.userId;
    let label = 'your';
    const m = typeof member === 'string' ? member.trim().slice(0, 64) : '';
    const me = !m || /^(me|my|mine|myself|i)$/i.test(m) || (!!ctx.speaker && nameScore(m.replace(/'s$/i, ''), ctx.speaker) >= 0.8);
    if (!me) {
      const id = /^<@!?(\d{15,22})>$/.exec(m)?.[1] ?? (/^\d{15,22}$/.test(m) ? m : undefined);
      const named = id ? undefined : this.byName(m);
      const found = id ?? named;
      if (found !== ctx.userId) {
        if (!this.o.shareWithServer) return "I can only check your own Steam account, not anyone else's.";
        const known = found ? this.o.nameOf?.(found) : undefined;
        const shown = cleanText(known && known !== 'someone' ? known : m.replace(/^<@!?\d+>$/, 'They'), 32, 'They');
        if (!found || !this.mapped(found)) return `${shown} doesn't have a Steam account linked with me.`;
        target = found;
        label = `${shown}'s`;
      }
    }
    const self = target === ctx.userId;
    const raw = this.mapped(target);
    if (!raw)
      return "Your Steam account isn't linked yet. The admin can link it by adding your SteamID64 under steam.accounts in the config.";
    const acct = parseSteamAccount(raw);
    if (!acct) return `The Steam account set for ${self ? 'you' : label.replace(/'s$/, '')} isn't a valid SteamID64. The admin needs to fix it under steam.accounts.`;
    if ('steamid' in acct) return { steamid: acct.steamid, self, label };
    const known = this.vanities.get(acct.vanity.toLowerCase());
    if (known) return { steamid: known, self, label };
    if (!this.o.apiKey)
      return `The Steam account for ${self ? 'you' : label.replace(/'s$/, '')} is set by profile name, which needs the STEAM_API_KEY secret to look up. A SteamID64 works without it.`;
    const r = await this.get(this.web('ISteamUser/ResolveVanityURL/v1/', { vanityurl: acct.vanity }), signal);
    const sid = String(r.body?.response?.steamid ?? '');
    if (r.body?.response?.success !== 1 || !STEAMID.test(sid))
      return `Steam has no profile named the way the config says for ${self ? 'you' : label.replace(/'s$/, '')}. The admin should use the SteamID64 instead.`;
    this.vanities.set(acct.vanity.toLowerCase(), sid);
    return { steamid: sid, self, label };
  }

  private byName(name: string): string | undefined {
    const ids = Object.keys(this.o.accounts);
    let best: { id: string; s: number } | undefined;
    for (const id of ids) {
      const shown = this.o.nameOf?.(id);
      if (!shown || shown === 'someone') continue;
      const s = nameScore(name.replace(/'s$/i, ''), shown);
      if (s >= 0.8 && (!best || s > best.s)) best = { id, s };
    }
    return best?.id;
  }

  // ---- players

  private async summariesFor(ids: string[], signal: AbortSignal): Promise<Map<string, Summary>> {
    const out = new Map<string, Summary>();
    const missing: string[] = [];
    for (const id of ids) {
      const s = this.summaries.get(id);
      if (s) out.set(id, s);
      else missing.push(id);
    }
    await mapLimit(chunks(missing, BATCH), 3, async (batch) => {
      const r = await this.get(this.web('ISteamUser/GetPlayerSummaries/v2/', { steamids: batch.join(',') }), signal);
      const players = r.body?.response?.players;
      if (!Array.isArray(players)) throw new SteamError('unreadable');
      for (const p of players) {
        const id = String(p?.steamid ?? '');
        if (!STEAMID.test(id)) continue;
        const game = p.gameextrainfo ? cleanText(p.gameextrainfo, 48, '') : '';
        const s: Summary = {
          name: cleanText(p.personaname, 32, 'a friend'),
          state: Number.isInteger(p.personastate) ? p.personastate : 0,
          ...(game ? { game } : p.gameid ? { game: 'a game' } : {}),
          visibility: Number(p.communityvisibilitystate) || 0,
        };
        this.summaries.set(id, s);
        out.set(id, s);
      }
    });
    return out;
  }

  /** Why a profile's lists can't be read, if its profile is private. */
  private async privateProfile(who: Who, signal: AbortSignal): Promise<string | undefined> {
    if (!this.o.apiKey) return undefined;
    const me = (await this.summariesFor([who.steamid], signal)).get(who.steamid);
    if (me && me.visibility !== 3)
      return who.self
        ? 'Your Steam profile is private. In Steam, go to your profile, Edit Profile, Privacy Settings, and set My profile to Public.'
        : `${who.label.replace(/'s$/, '')}'s Steam profile is private.`;
    return undefined;
  }

  async friends(ctx: ToolContext, game: unknown, member: unknown, signal: AbortSignal): Promise<string> {
    try {
      if (!this.o.apiKey) return "Checking Steam friends needs a Steam Web API key, and the STEAM_API_KEY secret isn't set.";
      const who = await this.who(ctx, member, signal);
      if (typeof who === 'string') return who;
      const your = who.self ? 'your' : who.label;
      let ids = this.friendLists.get(who.steamid);
      if (!ids) {
        const r = await this.get(this.web('ISteamUser/GetFriendList/v1/', { steamid: who.steamid, relationship: 'friend' }), signal, [401, 403]);
        if (r.status === 401 || r.status === 403) {
          // A bad key fails the profile check below as well.
          const priv = await this.privateProfile(who, signal);
          if (priv) return priv;
          return who.self
            ? 'Your Steam friends list is private. In Steam, go to Edit Profile, Privacy Settings, and set Friends List to Public.'
            : `${who.label.replace(/'s$/, '')}'s Steam friends list is private.`;
        }
        const list = r.body?.friendslist?.friends;
        if (list !== undefined && !Array.isArray(list)) throw new SteamError('unreadable');
        ids = (list ?? []).map((x: any) => String(x?.steamid ?? '')).filter((s: string) => STEAMID.test(s));
        this.friendLists.set(who.steamid, ids!);
      }
      if (!ids!.length) return `${cap(your)} Steam friends list is empty.`;
      const many = ids!.length > FRIENDS_CAP;
      const sums = await this.summariesFor(ids!.slice(0, FRIENDS_CAP), signal);
      return describeFriends([...sums.values()], typeof game === 'string' ? game.trim().slice(0, 80) : '', your, !!ctx.text, many);
    } catch (e) {
      if ((e as Error).message === 'cancelled') throw e;
      return troubleLine(e);
    }
  }

  // ---- store

  /** Store details for apps, from cache or GetItems in batches. Apps that
   *  couldn't be fetched are left out. `full`: every edition's price. */
  async storeItems(appids: number[], full: boolean, signal: AbortSignal): Promise<Map<number, StoreItem>> {
    const out = new Map<number, StoreItem>();
    const missing: number[] = [];
    for (const id of appids) {
      const it = this.items.get(`${this.country}:${id}`);
      if (it && (it.full || !full)) out.set(id, it);
      else missing.push(id);
    }
    let failed: unknown;
    let anyOk = false;
    await mapLimit(chunks(missing, BATCH), 2, async (batch) => {
      try {
        const input = {
          ids: batch.map((appid) => ({ appid })),
          context: { language: 'english', country_code: this.country },
          data_request: { include_release: true, ...(full ? { include_all_purchase_options: true } : {}) },
        };
        const r = await this.get(`${WEB}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`, signal);
        const list = r.body?.response?.store_items;
        if (!Array.isArray(list)) throw new SteamError('unreadable');
        for (const raw of list) {
          const it = parseItem(raw, full);
          if (!it) continue;
          this.items.set(`${this.country}:${it.appid}`, it);
          out.set(it.appid, it);
        }
        // Unknown apps come back with appid 0: remember them as unknown.
        for (const id of batch)
          if (!out.has(id)) {
            const none: StoreItem = { appid: id, known: false, visible: false, name: `app ${id}`, type: 0, free: false, comingSoon: false, unlisted: false, full };
            this.items.set(`${this.country}:${id}`, none);
            out.set(id, none);
          }
        anyOk = true;
      } catch (e) {
        if ((e as Error).message === 'cancelled') throw e;
        failed = e;
      }
    });
    if (failed && !anyOk && !out.size) throw failed;
    return out;
  }

  /** Discounts from appdetails, for when GetItems is down: batches, then one
   *  by one if batching is refused. Names aren't known here. */
  async appdetailsPrices(appids: number[], signal: AbortSignal): Promise<Map<number, Price | null>> {
    const out = new Map<number, Price | null>();
    const read = (id: number, e: any) => {
      if (!e || e.success !== true) return;
      const p = e.data && !Array.isArray(e.data) ? e.data.price_overview : undefined;
      if (!p || typeof p.final_formatted !== 'string') return out.set(id, null);
      const pct = Number(p.discount_percent);
      out.set(id, {
        final: cleanText(p.final_formatted, 24, '?'),
        ...(p.initial_formatted ? { original: cleanText(p.initial_formatted, 24, '?') } : {}),
        ...(pct > 0 && pct < 100 ? { pct } : {}),
        option: '',
      });
    };
    let batching = true;
    for (const batch of chunks(appids, PRICE_BATCH)) {
      const r = await this.get(`${STORE}/api/appdetails?appids=${batch.join(',')}&filters=price_overview&cc=${this.country}`, signal, [400]);
      if (r.status === 400 || r.body === null || typeof r.body !== 'object') {
        batching = false;
        break;
      }
      for (const id of batch) read(id, r.body[String(id)]);
    }
    if (!batching)
      await mapLimit(appids.filter((id) => !out.has(id)).slice(0, ONE_BY_ONE_CAP), 2, async (id) => {
        const r = await this.get(`${STORE}/api/appdetails?appids=${id}&filters=price_overview&cc=${this.country}`, signal, [400]);
        if (r.body && typeof r.body === 'object') read(id, r.body[String(id)]);
      });
    return out;
  }

  /** A name from appdetails (one app per call). */
  private async appName(id: number, signal: AbortSignal): Promise<string | undefined> {
    const r = await this.get(`${STORE}/api/appdetails?appids=${id}&filters=basic&cc=${this.country}`, signal, [400]);
    const d = r.body?.[String(id)];
    return d?.success === true && d.data && !Array.isArray(d.data) ? cleanText(d.data.name, 100, '') || undefined : undefined;
  }

  async wishlistSales(ctx: ToolContext, member: unknown, signal: AbortSignal): Promise<string> {
    try {
      const who = await this.who(ctx, member, signal);
      if (typeof who === 'string') return who;
      const your = who.self ? 'your' : who.label;
      let ids = this.wishlists.get(who.steamid);
      if (!ids) {
        const r = await this.get(this.web('IWishlistService/GetWishlist/v1/', { steamid: who.steamid }, false), signal, [400, 401, 403]);
        if (r.status !== 200) {
          return (await this.privateProfile(who, signal)) ?? privateWishlist(who);
        }
        const items = r.body?.response?.items;
        if (items !== undefined && !Array.isArray(items)) throw new SteamError('unreadable');
        const list = ((items ?? []) as any[])
          .map((x) => ({ appid: Number(x?.appid), priority: Number(x?.priority) || 0, added: Number(x?.date_added) || 0 }))
          .filter((x) => Number.isInteger(x.appid) && x.appid > 0)
          // Ranked games first (1 is the top), then unranked ones, newest first.
          .sort((a, b) => (a.priority || Infinity) - (b.priority || Infinity) || b.added - a.added);
        ids = [...new Set(list.map((x) => x.appid))];
        if (!ids.length) return (await this.privateProfile(who, signal)) ?? privateWishlist(who);
        this.wishlists.set(who.steamid, ids);
      }
      const checked = ids.slice(0, WISHLIST_CAP);
      const capNote = ids.length > WISHLIST_CAP ? ` I checked the first ${WISHLIST_CAP} of ${ids.length} games on it.` : '';
      let sales: { name: string; p: Price }[] = [];
      let unchecked = 0;
      /** On sale, but past the few whose names were looked up. */
      let unnamed = 0;
      try {
        const got = await this.storeItems(checked, false, signal);
        unchecked = checked.filter((id) => !got.has(id)).length;
        for (const it of got.values()) {
          if (!it.best?.pct || it.free || it.unlisted) continue;
          sales.push({ name: it.name, p: it.best });
        }
      } catch (e) {
        if ((e as Error).message === 'cancelled') throw e;
        // GetItems is down: prices from appdetails, names only for the top few.
        const prices = await this.appdetailsPrices(checked, signal);
        unchecked = checked.filter((id) => !prices.has(id)).length;
        const on = [...prices].filter((x): x is [number, Price] => !!x[1]?.pct).sort((a, b) => b[1].pct! - a[1].pct!);
        const top = on.slice(0, ctx.text ? 12 : 5);
        const names = await mapLimit(top, 2, async ([id]) => this.appName(id, signal).catch(() => undefined));
        sales = top.map(([, p], i) => ({ name: names[i] ?? 'a game', p }));
        unnamed = on.length - top.length;
      }
      return describeSales(sales, checked.length - unchecked, your, !!ctx.text, this.o.timezone, unnamed) + capNote + (unchecked ? ` Steam didn't give prices for ${plural(unchecked, 'game')}.` : '');
    } catch (e) {
      if ((e as Error).message === 'cancelled') throw e;
      return troubleLine(e);
    }
  }

  private async search(term: string, signal: AbortSignal) {
    const key = `${this.country}:${normName(term)}`;
    const hit = this.searches.get(key);
    if (hit) return hit;
    const r = await this.get(`${STORE}/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=${this.country}`, signal);
    const items = r.body?.items;
    if (items !== undefined && !Array.isArray(items)) throw new SteamError('unreadable');
    const list = ((items ?? []) as any[])
      .map((x) => ({
        id: Number(x?.id),
        name: cleanText(x?.name, 100, ''),
        type: String(x?.type ?? 'app'),
        ...(x?.price && typeof x.price.currency === 'string' && Number.isFinite(Number(x.price.final))
          ? { price: { currency: String(x.price.currency).slice(0, 3), initial: Number(x.price.initial), final: Number(x.price.final) } }
          : {}),
      }))
      .filter((x) => Number.isInteger(x.id) && x.id > 0 && x.name)
      .slice(0, 10);
    this.searches.set(key, list);
    return list;
  }

  async price(ctx: ToolContext, game: unknown, signal: AbortSignal): Promise<string> {
    const g = typeof game === 'string' ? game.trim().slice(0, 100) : '';
    if (!g) return 'Which game?';
    try {
      // A store link or an app number names the app outright.
      const direct = /store\.steampowered\.com\/app\/(\d{1,9})/i.exec(g)?.[1] ?? (/^\d{1,9}$/.test(g) ? g : undefined);
      if (direct) {
        const it = (await this.storeItems([Number(direct)], true, signal)).get(Number(direct));
        if (!it?.known) return "Steam doesn't have a store page for that app.";
        return this.describeItem(it, !!ctx.text, signal);
      }
      const results = await this.search(g, signal);
      if (!results.length)
        return notOnSteam(g) ? `${cleanText(g, 40, 'That game')} isn't sold on Steam.` : `I couldn't find ${cleanText(g, 60, 'that')} on the Steam store.`;
      const ranked = results.map((r) => ({ r, s: nameScore(g, r.name) })).sort((a, b) => b.s - a.s);
      const top = ranked.slice(0, 5);
      let items: Map<number, StoreItem> | undefined;
      try {
        items = await this.storeItems(
          top.filter((x) => x.r.type === 'app').map((x) => x.r.id),
          true,
          signal,
        );
      } catch (e) {
        if ((e as Error).message === 'cancelled') throw e;
        items = undefined; // fall back to the search's own price
      }
      const wants = normName(g);
      const pick = top
        .map((x) => {
          const it = items?.get(x.r.id);
          let s = x.s;
          if (it) {
            if (it.type === 4 && !/\b(dlc|expansion|pack|season pass|edition)\b/.test(wants)) s -= 0.08;
            if (it.type === 1 && !/\bdemo\b/.test(wants)) s -= 0.2;
            if (it.type !== 0 && it.type !== 4 && it.type !== 1 && !/\b(soundtrack|ost|artbook)\b/.test(wants)) s -= 0.15;
            if (!it.known) s -= 0.5;
          }
          if (x.r.type !== 'app') s -= 0.05;
          return { ...x, it, fit: x.s, s };
        })
        .sort((a, b) => b.s - a.s || a.r.name.length - b.r.name.length)[0]!;
      const close = pick.fit < 0.55;
      let line: string;
      if (pick.it?.known) line = await this.describeItem(pick.it, !!ctx.text, signal, items);
      else line = describeSearchPrice(pick.r, !!ctx.text);
      return close ? `I couldn't find ${cleanText(g, 60, 'that')} on Steam. The closest match: ${line}` : line;
    } catch (e) {
      if ((e as Error).message === 'cancelled') throw e;
      return troubleLine(e);
    }
  }

  private async describeItem(it: StoreItem, text: boolean, signal: AbortSignal, near?: Map<number, StoreItem>): Promise<string> {
    let name = it.name;
    if (it.type === 4) {
      let parent = it.parent ? (near?.get(it.parent) ?? this.items.get(`${this.country}:${it.parent}`)) : undefined;
      if (it.parent && !parent) parent = (await this.storeItems([it.parent], false, signal).catch(() => undefined))?.get(it.parent);
      name = parent?.known ? `${it.name}, DLC for ${parent.name},` : `${it.name} (DLC)`;
    }
    const pct = (p: Price) => (p.hidePct || !p.pct ? 'on sale' : text ? `${p.pct}% off` : `${p.pct} percent off`);
    const until = (p: Price) => (p.ends && text ? `, until ${this.day(p.ends)}` : '');
    if (it.unlisted) return `${name} was taken off the Steam store, so it can't be bought there now.`;
    if (!it.visible) return `${name} isn't sold in the Steam store for ${this.country}.`;
    const base = it.base ?? it.best;
    if (it.comingSoon) {
      const when = it.release && it.release * 1000 > this.now() ? `it's due ${this.day(it.release)}` : `Steam lists it as ${it.comingText ? it.comingText.toLowerCase() : 'coming soon'}`;
      return `${name} isn't out yet; ${when}.${base ? ` Pre-order price: ${base.final}.` : ''}`;
    }
    if (it.free && !base) return it.type === 4 ? `${name} is free.` : `${name} is free to play on Steam.`;
    if (!base) return `${name} has no price on the Steam store right now.`;
    let line = base.pct
      ? `${name} is on sale on Steam: ${base.final}, ${pct(base)}${base.original ? ` (normally ${base.original})` : ''}${until(base)}.`
      : `${name} is ${base.final} on Steam${text ? ', not on sale' : ''}.`;
    const deal = it.best;
    if (deal?.pct && it.base && deal.option && normName(deal.option) !== normName(it.base.option))
      line += ` The ${editionOf(deal.option, it.name)} is ${pct(deal)} at ${deal.final}${until(deal)}.`;
    return line;
  }

  private day(unixS: number): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: this.o.timezone ?? 'UTC', month: 'short', day: 'numeric' }).format(unixS * 1000);
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "007 First Light - Deluxe Edition" for "007 First Light" → "Deluxe Edition". */
function editionOf(option: string, name: string): string {
  const rest = option.startsWith(name) ? option.slice(name.length).replace(/^[\s:–—-]+/, '') : '';
  return rest || option;
}

function privateWishlist(who: Who): string {
  return who.self
    ? "Your Steam wishlist came back empty. If it isn't, it's hidden: in Steam, go to Edit Profile, Privacy Settings, and set Game details to Public."
    : `${who.label.replace(/'s$/, '')}'s Steam wishlist is empty or private.`;
}

function describeSearchPrice(r: { name: string; type: string; price?: { currency: string; initial: number; final: number } }, text: boolean): string {
  const name = r.type === 'app' ? r.name : `${r.name} (a bundle)`;
  if (!r.price) return `Steam didn't give a price for ${name}; it may be free or not out yet.`;
  const fmt = (c: number) => {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: r.price!.currency }).format(c / 100);
    } catch {
      return `${(c / 100).toFixed(2)} ${r.price!.currency}`;
    }
  };
  if (r.price.initial > r.price.final && r.price.initial > 0) {
    const pct = Math.round((1 - r.price.final / r.price.initial) * 100);
    return `${name} is on sale on Steam: ${fmt(r.price.final)}, ${pct}${text ? '%' : ' percent'} off (normally ${fmt(r.price.initial)}).`;
  }
  return `${name} is ${fmt(r.price.final)} on Steam.`;
}

export function describeFriends(sums: Summary[], game: string, your: string, text: boolean, many: boolean): string {
  const on = sums.filter((s) => s.state > 0 || s.game);
  const playing = on.filter((s) => s.game);
  const more = many ? ` I only looked at the first ${FRIENDS_CAP} friends.` : '';
  const max = text ? 20 : 6;
  if (game) {
    const hits = playing.filter((s) => nameScore(game, s.game!) >= 0.75 || normName(s.game!).includes(normName(game)));
    const shown = cleanText(game, 40, 'that');
    if (!hits.length) {
      const why = notOnSteam(game) ? ` ${shown} isn't a Steam game, so Steam usually can't see who's playing it.` : '';
      return `None of ${your} Steam friends are playing ${shown} right now.${why}`;
    }
    const names = hits.slice(0, max).map((s) => s.name);
    const rest = hits.length - names.length;
    const title = hits[0]!.game!;
    return `Yes: ${listAnd(rest ? [...names, `${rest} more`] : names)} ${hits.length === 1 ? 'is' : 'are'} playing ${title}.${more}`;
  }
  if (!on.length) return `None of ${your} Steam friends are online right now.${more}`;
  const byGame = new Map<string, string[]>();
  for (const s of playing) byGame.set(s.game!, [...(byGame.get(s.game!) ?? []), s.name]);
  const groups = [...byGame].sort((a, b) => b[1].length - a[1].length);
  const parts: string[] = [];
  let said = 0;
  for (const [g, names] of groups) {
    if (said >= max) break;
    const take = names.slice(0, max - said);
    said += take.length;
    const rest = names.length - take.length;
    parts.push(`${listAnd(rest ? [...take, `${rest} more`] : take)} ${names.length === 1 ? 'is' : 'are'} playing ${g}`);
  }
  const unsaidPlaying = playing.length - said;
  const idle = on.filter((s) => !s.game).sort((a, b) => (a.state === 1 ? 0 : 1) - (b.state === 1 ? 0 : 1));
  const idleMax = text ? 20 : 5;
  const idleNames = idle.slice(0, idleMax).map((s) => (text && s.state !== 1 ? `${s.name} (${STATE[s.state] ?? 'online'})` : s.name));
  const idleRest = idle.length - idleNames.length;
  let out = `${plural(on.length, 'friend')} ${on.length === 1 ? 'is' : 'are'} on Steam.`;
  if (parts.length) out += ` ${parts.join('; ')}${groups.length > parts.length || unsaidPlaying > 0 ? `; ${unsaidPlaying} more in other games` : ''}.`;
  else out += ' Nobody is in a game.';
  if (idleNames.length) out += ` Online: ${listAnd(idleRest ? [...idleNames, `${idleRest} more`] : idleNames)}.`;
  return out + more;
}

const STATE: Record<number, string> = { 1: 'online', 2: 'busy', 3: 'away', 4: 'snoozing', 5: 'looking to trade', 6: 'looking to play' };

export function describeSales(sales: { name: string; p: Price }[], checked: number, your: string, text: boolean, timezone?: string, unnamed = 0): string {
  if (!sales.length) return `Nothing on ${your} Steam wishlist is on sale right now (${plural(checked, 'game')} checked).`;
  const sorted = [...sales].sort((a, b) => (b.p.pct ?? 0) - (a.p.pct ?? 0) || a.name.localeCompare(b.name));
  const max = text ? 12 : 5;
  const day = (s: number) => new Intl.DateTimeFormat('en-US', { timeZone: timezone ?? 'UTC', month: 'short', day: 'numeric' }).format(s * 1000);
  const lines = sorted.slice(0, max).map(({ name, p }) => {
    const ed = p.option && normName(p.option) !== normName(name) ? ` (${editionOf(p.option, name)})` : '';
    const off = p.hidePct ? 'on sale' : `${p.pct}${text ? '%' : ' percent'} off`;
    return text ? `${name}${ed}: ${p.final}, ${off}${p.ends ? `, until ${day(p.ends)}` : ''}` : `${name}${ed}, ${off} at ${p.final}`;
  });
  const rest = sorted.length - lines.length + unnamed;
  const total = sales.length + unnamed;
  const head = `${plural(total, 'game')} on ${your} Steam wishlist ${total === 1 ? 'is' : 'are'} on sale`;
  if (text) return `${head}:\n${lines.map((l) => `- ${l}`).join('\n')}${rest ? `\n…and ${rest} more.` : ''}`;
  return `${head}: ${lines.join('; ')}${rest ? `; and ${rest} more` : ''}.`;
}

// ---------------------------------------------------------------- tools

const MEMBER = {
  type: 'string',
  description: "Only when they ask about someone else's Steam: that member's name or <@id>. Leave out for their own.",
};

/** Store names in capitals ("ELDEN RING") read as words, not letters. */
export function softenCaps(s: string): string {
  return s.replace(/\b[A-Z]{4,}\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());
}

/** Friends and wishlists only once an account is linked: with none, they
 *  could only answer "not linked", and "is anyone playing X" belongs to
 *  game_night then. Store prices need no account. */
export function steamTools(steam: Steam): Tool[] {
  const said = (_a: Record<string, unknown>, result: string) => result;
  const voice = (ctx: ToolContext) => async (p: Promise<string>) => (ctx.text ? p : softenCaps(await p));
  const needsAccount = new Set(['steam_friends', 'steam_wishlist_sales']);
  const tools: Tool[] = [
    {
      spec: {
        name: 'steam_friends',
        description:
          "The person's own Steam friends list: which of their Steam friends are online now and the games they're in (\"are any of my Steam friends on\", \"which of my Steam friends are playing Elden Ring\"). game: only friends playing that game. Not for people in this Discord server (game_night who_playing) or on a Minecraft server (game_server_status).",
        parameters: { type: 'object', properties: { game: { type: 'string' }, member: MEMBER }, additionalProperties: false },
      },
      slow: true,
      timeoutMs: 9_000,
      run: (a, signal, ctx) => voice(ctx)(steam.friends(ctx, a.game, a.member, signal)),
      speak: said,
    },
    {
      spec: {
        name: 'steam_wishlist_sales',
        description: "Games on the person's Steam wishlist that are on sale now, biggest discount first.",
        parameters: { type: 'object', properties: { member: MEMBER }, additionalProperties: false },
      },
      slow: true,
      timeoutMs: 10_000,
      run: (a, signal, ctx) => voice(ctx)(steam.wishlistSales(ctx, a.member, signal)),
      speak: said,
    },
    {
      spec: {
        name: 'steam_price',
        description: 'What a game costs on the Steam store now, and whether it is on sale, free, or not out yet.',
        parameters: { type: 'object', properties: { game: { type: 'string', description: 'The game, as they said it.' } }, required: ['game'], additionalProperties: false },
      },
      slow: true,
      timeoutMs: 9_000,
      run: (a, signal, ctx) => voice(ctx)(steam.price(ctx, a.game, signal)),
      speak: said,
    },
  ];
  return steam.linked ? tools : tools.filter((t) => !needsAccount.has(t.spec.name));
}
