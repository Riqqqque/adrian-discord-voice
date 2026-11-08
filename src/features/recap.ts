// The weekly recap, posted in a text channel once a week: the songs played
// most in the call, what's new on Plex, how the game servers did, and how
// many questions she answered. Counts only: no transcripts, no quotes, and
// nobody named unless they asked to be. The numbers are kept per week in a
// small file, so they survive restarts; the week a recap was last posted is
// kept too, so it never goes out twice, and one missed while the bot was down
// goes out once when it's back (within a day).

import { readFileSync } from 'node:fs';
import type { Tool, UserId } from '../core/interfaces.js';
import { dateFormat } from '../core/time.js';
import { writeJsonFile } from '../web/secrets-file.js';
import { cleanTitle, newMedia, type Media, type Sources } from './digest.js';
import { localToEpoch } from './reminders.js';

const DAY = 86_400_000;
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** A recap missed by more than this is skipped: next week's covers it. */
const LATE_MS = DAY;
const RETRY_MS = 10 * 60_000;
/** Game servers are checked this often while the bot runs. */
export const SAMPLE_MS = 10 * 60_000;
const MAX_SONGS = 200;
const MAX_NAMED = 50;
const KEEP_WEEKS = 3;
const MEDIA_TIMEOUT_MS = 10_000;
/** Below Discord's 2,000. */
const MAX_CHARS = 1_900;
const NOW_COOLDOWN_MS = 10 * 60_000;

export interface Week {
  songs: Record<string, { title: string; artist?: string; n: number }>;
  answers: { call: number; pc: number; text: number };
  /** Only people who asked to be named. */
  named: Record<UserId, number>;
  servers: Record<string, { samples: number; up: number; peak: number }>;
}

interface Saved {
  weeks: Record<string, Week>;
  lastPosted?: string;
}

const emptyWeek = (): Week => ({ songs: {}, answers: { call: 0, pc: 0, text: 0 }, named: {}, servers: {} });

// --- when ---------------------------------------------------------------------

function localYmd(ms: number, tz: string): string {
  const p = Object.fromEntries(dateFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(ymd: string, n: number): string {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const at = (ymd: string, hour: number, tz: string) => localToEpoch(`${ymd}T${String(hour).padStart(2, '0')}:00`, tz)!;

/** The latest recap time at or before `now`: that day at that hour, household time. Keyed by its local date. */
export function slotAtOrBefore(now: number, tz: string, day: number, hour: number): { at: number; key: string } {
  let ymd = localYmd(now, tz);
  ymd = addDays(ymd, -((weekdayOf(ymd) - day + 7) % 7));
  let t = at(ymd, hour, tz);
  if (t > now) {
    ymd = addDays(ymd, -7);
    t = at(ymd, hour, tz);
  }
  return { at: t, key: ymd };
}

/** The recap that will cover something happening at `t`: the first one after it. */
export function weekOf(t: number, tz: string, day: number, hour: number): string {
  return addDays(slotAtOrBefore(t, tz, day, hour).key, 7);
}

// --- the numbers ------------------------------------------------------------

export interface RecapSettings {
  enabled: boolean;
  timezone: string;
  day: number;
  hour: number;
}

export interface RecapDeps {
  sources: Sources;
  /** Post it; rejects if it didn't go. */
  post: (content: string) => Promise<void>;
  /** Display name, only for people who asked to be named. */
  nameOf: (id: UserId) => string;
  named: (id: UserId) => boolean;
  isOwner: (id: UserId) => boolean;
  log?: { info(m: string, f?: object): void; warn(m: string, f?: object): void };
  now?: () => number;
}

const md = (s: string) => s.replace(/([\\*_~`|>#[\]<@])/g, '\\$1');

export class Recap {
  private data: Saved = { weeks: {} };
  private tickTimer: NodeJS.Timeout | undefined;
  private sampleTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private posting = false;
  private retryAt = 0;
  private lastNow = -Infinity;
  private readonly now: () => number;

  constructor(
    private readonly file: string | undefined,
    private readonly s: RecapSettings,
    private readonly d: RecapDeps,
  ) {
    this.now = d.now ?? Date.now;
    if (file) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>;
        if (j && typeof j.weeks === 'object' && j.weeks) this.data = { weeks: j.weeks, ...(typeof j.lastPosted === 'string' ? { lastPosted: j.lastPosted } : {}) };
      } catch {
        /* none yet */
      }
    }
  }

  get lastPosted(): string | undefined {
    return this.data.lastPosted;
  }

  /** This week's numbers so far (for tests and the admin). */
  week(key = weekOf(this.now(), this.s.timezone, this.s.day, this.s.hour)): Week | undefined {
    return this.data.weeks[key];
  }

  private current(): Week {
    const key = weekOf(this.now(), this.s.timezone, this.s.day, this.s.hour);
    let w = this.data.weeks[key];
    if (!w) {
      w = this.data.weeks[key] = emptyWeek();
      const keys = Object.keys(this.data.weeks).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_WEEKS))) delete this.data.weeks[k];
    }
    this.saveSoon();
    return w;
  }

  /** A song started in the call. */
  played(title: string, artist?: string): void {
    if (!this.s.enabled) return;
    const t = cleanTitle(title);
    if (!t) return;
    const a = artist ? cleanTitle(artist) : undefined;
    const songs = this.current().songs;
    const key = `${t}|${a ?? ''}`.toLowerCase();
    const e = (songs[key] ??= { title: t, ...(a ? { artist: a } : {}), n: 0 });
    e.n++;
    const keys = Object.keys(songs);
    if (keys.length > MAX_SONGS) {
      // The least played goes, never the one just counted.
      const drop = keys.filter((k) => k !== key).sort((x, y) => songs[x]!.n - songs[y]!.n)[0];
      if (drop) delete songs[drop];
    }
  }

  /** She answered someone. */
  answered(where: 'call' | 'pc' | 'text', userId: UserId): void {
    if (!this.s.enabled) return;
    const w = this.current();
    w.answers[where]++;
    if (this.d.named(userId) && (userId in w.named || Object.keys(w.named).length < MAX_NAMED)) w.named[userId] = (w.named[userId] ?? 0) + 1;
  }

  /** One check of every game server. */
  async sample(): Promise<void> {
    const list = this.d.sources.servers;
    if (!this.s.enabled || !list.length) return;
    const res = await Promise.all(list.map(async (g) => [g.name, await this.d.sources.ping(g.host, g.port).catch(() => ({ online: false }))] as const));
    const w = this.current();
    for (const [name, st] of res) {
      const e = (w.servers[name] ??= { samples: 0, up: 0, peak: 0 });
      e.samples++;
      if (st.online) e.up++;
      if ('players' in st && typeof st.players === 'number') e.peak = Math.max(e.peak, st.players);
    }
  }

  start(): void {
    if (!this.s.enabled) return;
    this.tickTimer ??= setInterval(() => void this.tick(), 60_000);
    this.tickTimer.unref();
    if (this.d.sources.servers.length && !this.sampleTimer) {
      this.sampleTimer = setInterval(() => void this.sample().catch(() => undefined), SAMPLE_MS);
      this.sampleTimer.unref();
      void this.sample().catch(() => undefined);
    }
    void this.tick();
  }

  stop(): void {
    clearInterval(this.tickTimer);
    clearInterval(this.sampleTimer);
    this.tickTimer = this.sampleTimer = undefined;
    this.flush();
  }

  /** Post this week's recap if it's due and hasn't gone. Returns what happened. */
  async tick(): Promise<'posted' | 'quiet week' | 'not due' | 'failed'> {
    if (!this.s.enabled || this.posting) return 'not due';
    const now = this.now();
    // The clock went back (a fixed clock, a bad NTP step): wait for a fresh retry.
    if (now < this.lastNow) this.retryAt = 0;
    this.lastNow = now;
    const slot = slotAtOrBefore(now, this.s.timezone, this.s.day, this.s.hour);
    if (now - slot.at >= LATE_MS || this.data.lastPosted === slot.key || now < this.retryAt) return 'not due';
    this.posting = true;
    // Claimed before it goes: a crash mid-post can lose a week, never post one twice.
    const before = this.data.lastPosted;
    this.data.lastPosted = slot.key;
    this.flush();
    try {
      const text = await this.compose(slot.key, slot.at, false);
      if (!text) {
        this.d.log?.info('weekly recap skipped', { week: slot.key, reason: 'nothing to report' });
        return 'quiet week';
      }
      await this.d.post(text);
      this.d.log?.info('weekly recap posted', { week: slot.key, lateMin: Math.round((now - slot.at) / 60_000), chars: text.length });
      return 'posted';
    } catch (e) {
      if (before === undefined) delete this.data.lastPosted;
      else this.data.lastPosted = before;
      this.flush();
      this.retryAt = now + RETRY_MS;
      this.d.log?.warn('weekly recap failed; trying again in 10 minutes', { error: (e as Error).message.slice(0, 160) });
      return 'failed';
    } finally {
      this.posting = false;
    }
  }

  /** The recap for the week ending `end` (key `key`). `soFar`: an owner asked mid-week. Undefined when there's nothing to say. */
  async compose(key: string, end: number, soFar: boolean): Promise<string | undefined> {
    const tz = this.s.timezone;
    const start = soFar ? slotAtOrBefore(end, tz, this.s.day, this.s.hour).at : end - 7 * DAY;
    const w = this.data.weeks[key] ?? emptyWeek();
    const lines: string[] = [];

    const songs = Object.values(w.songs).sort((a, b) => b.n - a.n || a.title.localeCompare(b.title)).slice(0, 5);
    if (songs.length) lines.push(`Most played in the call: ${songs.map((x) => `${md(x.title)}${x.artist ? ` by ${md(x.artist)}` : ''} (${x.n})`).join(', ')}`);

    let media: (Media & { failed: string[] }) | undefined;
    const m = this.d.sources.media;
    if (m.plex || m.sonarr || m.radarr) {
      try {
        media = await newMedia(this.d.sources, start, end, AbortSignal.timeout(MEDIA_TIMEOUT_MS));
      } catch {
        media = undefined;
      }
    }
    if (media && (media.episodes || media.movies.length)) {
      const parts: string[] = [];
      const more = media.capped ? '+' : '';
      const named = (titles: string[], total: number) => {
        const t = titles.slice(0, 3).filter(Boolean).map(md);
        return t.length ? ` (${t.join(', ')}${total > t.length ? ', and more' : ''})` : '';
      };
      if (media.episodes) parts.push(`${media.episodes}${more} episode${media.episodes === 1 ? '' : 's'}${named(media.shows.map((x) => x.title), media.shows.length)}`);
      if (media.movies.length) parts.push(`${media.movies.length}${more} movie${media.movies.length === 1 ? '' : 's'}${named(media.movies, media.movies.length)}`);
      lines.push(`New on Plex: ${parts.join(' and ')}`);
    }

    const servers = Object.entries(w.servers).filter(([, x]) => x.samples > 0);
    if (servers.length)
      lines.push(`Game servers: ${servers.map(([name, x]) => `${md(name)} up ${Math.round((100 * x.up) / x.samples)}% of the time${x.peak ? `, peak ${x.peak} player${x.peak === 1 ? '' : 's'}` : ''}`).join('; ')}`);

    const a = w.answers;
    const total = a.call + a.pc + a.text;
    if (total) {
      const where = [a.call && `${a.call} in the call`, a.pc && `${a.pc} at PCs`, a.text && `${a.text} in text chat`].filter(Boolean);
      const top = Object.entries(w.named).filter(([id]) => this.d.named(id)).sort((x, y) => y[1] - x[1]).slice(0, 3);
      lines.push(`Questions answered: ${total}${where.length > 1 ? ` (${where.join(', ')})` : ''}${top.length ? `. Most asked: ${top.map(([id, n]) => `${md(this.d.nameOf(id))} (${n})`).join(', ')}` : ''}`);
    }

    if (!lines.length) return undefined;
    const day = (t: number) => dateFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(t);
    const head = soFar ? `**This week so far** (since ${day(start)})` : `**Weekly recap** (${day(start)} to ${day(end)})`;
    let text = [head, ...lines].join('\n');
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1).trimEnd()}…`;
    return text;
  }

  private saveSoon(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 30_000);
    this.saveTimer.unref();
  }

  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.file) return;
    try {
      writeJsonFile(this.file, this.data);
    } catch {
      /* kept in memory; saved again on the next change */
    }
  }

  tools(): Tool[] {
    let lastManual = -Infinity;
    return [
      {
        spec: {
          name: 'post_recap',
          description: 'Owners only: post the weekly recap (this week so far) in the recap text channel now.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        acts: true,
        run: async (_a, _s, ctx) => {
          if (!this.d.isOwner(ctx.userId)) return 'Only an owner can post the recap.';
          if (!this.s.enabled) return 'The weekly recap is off: it needs recap.channelId set in the config.';
          const now = this.now();
          if (now - lastManual < NOW_COOLDOWN_MS) return 'I just posted it; try again in a few minutes.';
          const text = await this.compose(weekOf(now, this.s.timezone, this.s.day, this.s.hour), now, true);
          if (!text) return 'Nothing to report this week yet.';
          try {
            await this.d.post(text);
          } catch (e) {
            return `Couldn't post it: ${(e as Error).message.slice(0, 120)}`;
          }
          lastManual = now;
          return 'Posted the recap.';
        },
        speak: (_a, raw) => (raw === 'Posted the recap.' ? 'Posted.' : undefined),
      },
    ];
  }
}

export const weekdayIndex = (d: Weekday) => WEEKDAYS.indexOf(d);
