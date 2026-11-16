// The morning briefing: one spoken paragraph with the weather, what's on the
// owner's calendar and reminders for the rest of today, and a couple of
// headlines. Said on the first join of the morning (features/headsup.ts) or
// when asked ("good morning", "brief me"). Built from the sources without a
// model call. Calendar and reminder details are private: with other people in
// the call she only says how many there are.

import { dateFormat } from '../core/time.js';
import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import { addDays, dayKey, dayStart, type Calendars } from './calendar.js';
import type { Headlines } from './headlines.js';
import type { Reminder } from './reminders.js';
import type { Weather } from './weather.js';

/** Each source gets this long; a slow one is left out rather than waited for. */
const PART_TIMEOUT_MS = 5_000;
const MAX_ITEMS = 3;
/** Headlines are cut to this many words in speech. */
const HEADLINE_WORDS = 14;

export interface BriefingDeps {
  weather?: Weather | undefined;
  calendars?: Calendars | undefined;
  headlines?: Headlines | undefined;
  /** Their timers and reminders, soonest first. */
  reminders: (id: UserId) => readonly Reminder[];
  /** May this person hear the calendar (it's the owner's)? */
  calendarFor: (id: UserId) => boolean;
  timezone: string;
  /** Headlines in the briefing, 0 for none. */
  headlineCount: number;
  now?: () => number;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);

const short = (s: string, words: number) => {
  const w = s.replace(/[.!?…]+$/, '').split(/\s+/);
  return w.length > words ? `${w.slice(0, words).join(' ')}…` : w.join(' ');
};

/** "a, b and c". */
export const listWords = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export class Briefing {
  private readonly now: () => number;

  constructor(private readonly d: BriefingDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Is there anything to brief with? */
  get usable(): boolean {
    return !!(this.d.weather?.usable || this.d.calendars?.count || (this.d.headlines?.usable && this.d.headlineCount > 0));
  }

  private clock(ms: number): string {
    return dateFormat('en-US', { timeZone: this.d.timezone, hour: 'numeric', minute: '2-digit' }).format(ms).replace(':00', '');
  }

  /** The briefing for one person. `private`: nobody else can hear it, so
   *  calendar and reminder details may be said. */
  async line(id: UserId, o: { name?: string | undefined; private: boolean; signal?: AbortSignal | undefined }): Promise<string | undefined> {
    const now = this.now();
    const tz = this.d.timezone;
    const today = dayKey(now, tz);
    const end = dayStart(addDays(today, 1), tz)!;
    const cal = this.d.calendars?.count && this.d.calendarFor(id) ? this.d.calendars : undefined;
    const [weather, events, news] = await Promise.all([
      this.d.weather?.usable ? within(this.d.weather.brief(o.signal), PART_TIMEOUT_MS) : undefined,
      cal ? within(cal.events(now - 15 * 60_000, end, o.signal), PART_TIMEOUT_MS) : undefined,
      this.d.headlines?.usable && this.d.headlineCount > 0 ? within(this.d.headlines.top(this.d.headlineCount, o.signal), PART_TIMEOUT_MS) : undefined,
    ]);
    const hour = Number(dateFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
    const parts: string[] = [];
    const greet = hour >= 4 && hour < 12 ? 'Good morning' : hour < 17 && hour >= 12 ? 'Good afternoon' : 'Good evening';
    parts.push(`${greet}${o.name ? `, ${o.name}` : ''}.`);
    if (weather) parts.push(`It's ${weather}.`);

    if (events && !events.failed.length) {
      const left = events.events.filter((e) => e.allDay || e.start >= now - 15 * 60_000);
      if (!left.length) parts.push('Nothing else on your calendar today.');
      else if (!o.private) parts.push(`You have ${left.length} thing${left.length === 1 ? '' : 's'} on your calendar today.`);
      else {
        const items = left.slice(0, MAX_ITEMS).map((e) => (e.allDay ? e.title : `${e.title} at ${this.clock(e.start)}`));
        parts.push(`Today: ${listWords(items)}${left.length > MAX_ITEMS ? `, plus ${left.length - MAX_ITEMS} more` : ''}.`);
      }
    }

    const due = this.d.reminders(id).filter((r) => r.kind === 'reminder' && r.dueAt > now && r.dueAt < end);
    if (due.length) {
      if (!o.private) parts.push(`You have ${due.length} reminder${due.length === 1 ? '' : 's'} today.`);
      else parts.push(`Reminder${due.length === 1 ? '' : 's'}: ${listWords(due.slice(0, MAX_ITEMS).map((r) => `${short(r.text, 8)} at ${this.clock(r.dueAt)}`))}.`);
    }

    if (news?.length) parts.push(`In the news: ${news.map((h) => short(h, HEADLINE_WORDS)).join('. ')}.`);
    // Only a greeting: nothing worth saying.
    return parts.length > 1 ? parts.join(' ') : undefined;
  }

  /** `english`: the briefing is English; for anyone else the model says it. */
  tool(english: (id: UserId) => boolean, alone: (ctx: ToolContext) => boolean): Tool {
    return {
      slow: true,
      timeoutMs: 9_000,
      route: /\b(good morning|morning|brief(ing)?( me)?|my day|day look like|rundown)\b/i,
      spec: {
        name: 'briefing',
        description:
          'A short briefing for the person asking: the weather, what is left on their calendar and reminders today, and top headlines. For "good morning", "brief me", "what does my day look like".',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      run: async (_a, signal, ctx) => (await this.line(ctx.userId, { private: alone(ctx), signal })) ?? 'Nothing to brief: no weather place, calendar or news feeds are set up.',
      speak: (_a, raw, ctx) => (english(ctx.userId) && !raw.startsWith('Nothing to brief') ? raw : undefined),
    };
  }
}
