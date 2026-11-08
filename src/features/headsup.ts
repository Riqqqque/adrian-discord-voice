// A heads-up when someone joins her call after a while away: one short line
// about what's new since they were last there ("Since yesterday: 14 new
// episodes, mostly Frieren and One Piece, and Dune finished downloading.").
// Off by default. Never more than one line, never per item, at most once per
// person every few hours, only in a quiet moment, and never for anyone who
// asked her to stop. "What did I miss?" uses the same digest, on or off.

import { readFileSync } from 'node:fs';
import type { Tool, UserId } from '../core/interfaces.js';
import { writeJsonFile } from '../web/secrets-file.js';
import { digestLine, gatherNews, hasSources, sinceWords, type News, type Sources } from './digest.js';

const HOUR = 3_600_000;
/** People remembered (when they were last in the call, their choices). */
const MAX_PEOPLE = 200;
/** Settle after a join before saying anything: Discord's join chime, hellos. */
const SETTLE_MS = 3_000;
/** How long a heads-up waits for a quiet moment before it's dropped. */
const QUIET_WAIT_MS = 90_000;
const POLL_MS = 2_000;
/** Longest the media apps and servers get to answer. */
const NEWS_TIMEOUT_MS = 6_000;
/** "What did I miss" from someone never seen: the last day. */
const DEFAULT_SINCE_MS = 24 * HOUR;
const MAX_SINCE_MS = 30 * 24 * HOUR;
/** A heads-up stays in the asker's prompt this long, so "stop telling me that" makes sense. */
const RECENT_MS = 10 * 60_000;

interface Person {
  /** Last time they were seen in the call. */
  seen: number;
  /** When the visit they're on now began; `prev` is `seen` from before it. */
  since?: number;
  prev?: number;
  /** Last heads-up. */
  told?: number;
  off?: boolean;
  /** Named in the weekly recap's question count. */
  named?: boolean;
  /** Game servers up (true) or down when they were last told or checked. */
  known?: Record<string, boolean>;
}

export interface HeadsUpSettings {
  enabled: boolean;
  awayHours: number;
  minHours: number;
  /** Who gets them; empty: owners. */
  people: readonly string[];
}

export interface HeadsUpDeps {
  sources: Sources;
  timezone: string;
  isOwner: (id: UserId) => boolean;
  /** In her call and able to hear her. */
  audible: (id: UserId) => boolean;
  /** Nobody talking, no music, nothing being said or waiting to be. */
  quiet: () => boolean;
  /** What to call them at the start of the line, if anything. */
  name?: (id: UserId) => string | undefined;
  /** Say it in the call; resolves true once heard. */
  say: (id: UserId, line: string) => Promise<boolean>;
  log?: { info(m: string, f?: object): void; warn(m: string, f?: object): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type Gate = 'ok' | 'off' | 'not tracked' | 'opted out' | 'first visit' | 'not away long enough' | 'told recently' | 'already pending';

/** Whether a join gets a heads-up. */
export function headsUpGate(w: {
  enabled: boolean;
  tracked: boolean;
  person: Pick<Person, 'seen' | 'told' | 'off'> | undefined;
  now: number;
  awayHours: number;
  minHours: number;
  pending: boolean;
}): Gate {
  if (!w.enabled) return 'off';
  if (!w.tracked) return 'not tracked';
  if (w.person?.off) return 'opted out';
  if (!w.person) return 'first visit';
  if (w.pending) return 'already pending';
  if (w.now - w.person.seen < w.awayHours * HOUR) return 'not away long enough';
  if (w.person.told !== undefined && w.now - w.person.told < w.minHours * HOUR) return 'told recently';
  return 'ok';
}

/** Game servers that are down now and were up the last time this person heard. */
export function wentDown(news: Pick<News, 'servers'>, known: Record<string, boolean> | undefined): string[] {
  return Object.entries(news.servers)
    .filter(([name, up]) => !up && known?.[name] === true)
    .map(([name]) => name);
}

export class HeadsUp {
  private people: Record<UserId, Person> = {};
  private present = new Set<UserId>();
  private pending = new Set<UserId>();
  private recent = new Map<UserId, { line: string; at: number }>();
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly file: string | undefined,
    private readonly settings: HeadsUpSettings,
    private readonly d: HeadsUpDeps,
  ) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
    if (file) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as { people?: Record<UserId, Person> };
        if (j && typeof j.people === 'object' && j.people) this.people = j.people;
      } catch {
        /* none yet */
      }
    }
  }

  private tracked(id: UserId): boolean {
    return this.settings.people.length ? this.settings.people.includes(id) : this.d.isOwner(id);
  }

  /** Who's in her call now. `baseline`: she just joined or moved, so nobody here is arriving. */
  members(ids: ReadonlySet<UserId>, baseline = false): void {
    const now = this.now();
    const joined: { id: UserId; before: Person | undefined }[] = [];
    for (const id of ids) {
      const p = this.people[id];
      if (!this.present.has(id)) {
        const before = p ? { ...p } : undefined;
        this.people[id] = { ...p, seen: now, since: now, ...(p ? { prev: p.seen } : {}) };
        if (!baseline) joined.push({ id, before });
      } else if (p) {
        p.seen = now;
      }
    }
    for (const id of this.present) if (!ids.has(id) && this.people[id]) this.people[id]!.seen = now;
    this.present = new Set(ids);
    this.trim();
    this.saveSoon();
    for (const j of joined) this.joined(j.id, j.before);
  }

  /** She left the call: everyone there was last seen now. */
  left(): void {
    this.members(new Set(), true);
  }

  private joined(id: UserId, before: Person | undefined): void {
    const gate = headsUpGate({
      enabled: this.settings.enabled,
      tracked: this.tracked(id),
      person: before,
      now: this.now(),
      awayHours: this.settings.awayHours,
      minHours: this.settings.minHours,
      pending: this.pending.has(id),
    });
    if (gate !== 'ok') {
      if (gate !== 'off' && gate !== 'not tracked') this.d.log?.info('heads-up skipped', { user: id, reason: gate });
      return;
    }
    if (!hasSources(this.d.sources)) return;
    this.pending.add(id);
    void this.tell(id, before!).finally(() => this.pending.delete(id));
  }

  /** Exposed for tests: the whole heads-up for one join. */
  async tell(id: UserId, before: Person): Promise<string> {
    const since = Math.max(before.seen, before.told ?? 0);
    const news = gatherNews(this.d.sources, since, this.now(), NEWS_TIMEOUT_MS);
    await this.sleep(SETTLE_MS);
    const n = await news;
    const p = this.people[id];
    const down = wentDown(n, before.known);
    // Servers seen up are learned now; one seen down only once they have heard it, or it would never be said.
    if (p) p.known = { ...before.known, ...Object.fromEntries(Object.entries(n.servers).filter(([, up]) => up)) };
    this.saveSoon();
    const name = this.d.name?.(id);
    const line = digestLine(n, down, { since: sinceWords(since, this.now(), this.d.timezone), ...(name ? { lead: name } : {}) });
    const skip = (reason: string) => (this.d.log?.info('heads-up skipped', { user: id, reason }), reason);
    if (!line) return skip(n.failed.length ? 'sources down' : 'nothing new');
    const end = this.now() + QUIET_WAIT_MS;
    for (;;) {
      if (!this.present.has(id) || !this.d.audible(id)) return skip('left or deafened');
      if (this.d.quiet()) break;
      if (this.now() >= end) return skip('busy');
      await this.sleep(POLL_MS);
    }
    // Opted out or told elsewhere while it waited.
    if (this.people[id]?.off) return skip('opted out');
    const heard = await this.d.say(id, line);
    if (!heard) return skip('not heard');
    const q = this.people[id];
    if (q) {
      q.told = this.now();
      q.known = { ...q.known, ...n.servers };
    }
    this.recent.set(id, { line, at: this.now() });
    this.saveSoon();
    this.d.log?.info('heads-up', { user: id, episodes: n.episodes, movies: n.movies.length, serversDown: down.length });
    return 'told';
  }

  /** For their prompt: the heads-up they just heard, so "stop telling me that" has a "that". */
  context(id: UserId, speaker: string): string[] {
    const r = this.recent.get(id);
    if (!r || this.now() - r.at > RECENT_MS) return [];
    return [`When ${speaker} joined the call you gave them a heads-up: "${r.line}" If they say to stop telling them that, call digest_prefs with heads_up false.`];
  }

  /** Did this person agree to be named in the weekly recap? */
  named(id: UserId): boolean {
    return !!this.people[id]?.named;
  }

  /** When "what did I miss" starts for this person. */
  sinceFor(id: UserId): number {
    const p = this.people[id];
    const now = this.now();
    const at = p ? (this.present.has(id) ? p.prev : p.seen) : undefined;
    const t = Math.max(at ?? now - DEFAULT_SINCE_MS, p?.told ?? 0);
    return Math.max(t, now - MAX_SINCE_MS);
  }

  private trim(): void {
    const ids = Object.keys(this.people);
    if (ids.length <= MAX_PEOPLE) return;
    // Keep the choices people made; drop the longest gone first.
    const order = ids.sort((a, b) => Number(!!this.people[b]!.off || !!this.people[b]!.named) - Number(!!this.people[a]!.off || !!this.people[a]!.named) || this.people[b]!.seen - this.people[a]!.seen);
    for (const id of order.slice(MAX_PEOPLE)) if (!this.present.has(id)) delete this.people[id];
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
      writeJsonFile(this.file, { people: this.people });
    } catch {
      /* kept in memory; saved again on the next change */
    }
  }

  private pref(id: UserId): Person {
    return (this.people[id] ??= { seen: this.now() });
  }

  /** `english`: the short confirmations are English; for anyone else the model says them. */
  tools(english: (id: UserId) => boolean = () => true): Tool[] {
    const s = this.d.sources;
    return [
      {
        spec: {
          name: 'whats_new',
          description:
            'What the person asking missed: new episodes and movies since they were last in the call (or in the last `hours`), and game servers that are down. For "what did I miss?", "anything new?", "catch me up".',
          parameters: { type: 'object', properties: { hours: { type: 'number' } }, additionalProperties: false },
        },
        run: async (a, signal, ctx) => {
          if (!hasSources(s)) return 'No media apps or game servers are set up, so there is nothing to check.';
          const now = this.now();
          const hours = typeof a.hours === 'number' && a.hours > 0 ? Math.min(a.hours, 30 * 24) : undefined;
          const since = hours ? now - hours * HOUR : this.sinceFor(ctx.userId);
          const n = await gatherNews(s, since, now, NEWS_TIMEOUT_MS, signal);
          const down = Object.entries(n.servers).filter(([, up]) => !up).map(([name]) => name);
          const when = sinceWords(since, now, this.d.timezone);
          const line = digestLine(n, down, { since: when });
          if (!line) return n.failed.length ? `I couldn't reach ${n.failed.join(' or ')} just now.` : `Nothing new ${when}.`;
          return n.failed.length ? `${line} (Couldn't check ${n.failed.join(' or ')}.)` : line;
        },
        speak: (_a, raw, ctx) => (english(ctx.userId) && !raw.includes("Couldn't check") && !raw.startsWith('No media') ? raw : undefined),
      },
      {
        spec: {
          name: 'digest_prefs',
          description:
            'The asking person\'s own choices: heads_up false stops the short "since yesterday: ..." line when they join the call ("stop telling me that"), true turns it back on. name_in_recap true lets the weekly recap name them in its question count, false keeps them out.',
          parameters: { type: 'object', properties: { heads_up: { type: 'boolean' }, name_in_recap: { type: 'boolean' } }, additionalProperties: false },
        },
        acts: true,
        run: async (a, _s, ctx) => {
          const said: string[] = [];
          if (typeof a.heads_up === 'boolean') {
            const p = this.pref(ctx.userId);
            if (a.heads_up) delete p.off;
            else p.off = true;
            this.recent.delete(ctx.userId);
            said.push(a.heads_up ? (this.tracked(ctx.userId) && this.settings.enabled ? "Okay, I'll catch you up when you join." : 'Okay. Heads-ups are only for owners here, or are switched off.') : "Okay, I won't tell you that when you join anymore.");
          }
          if (typeof a.name_in_recap === 'boolean') {
            const p = this.pref(ctx.userId);
            if (a.name_in_recap) p.named = true;
            else delete p.named;
            said.push(a.name_in_recap ? "Okay, the weekly recap can name you." : "Okay, I'll leave your name out of the recap.");
          }
          if (!said.length) return 'Ask whether they want heads-ups on joining, or to be named in the weekly recap.';
          this.flush();
          return said.join(' ');
        },
        speak: (_a, raw, ctx) => (english(ctx.userId) && raw.startsWith('Okay') ? raw : undefined),
      },
    ];
  }
}
