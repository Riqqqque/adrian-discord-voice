// Timers and reminders. Saved to disk so they survive restarts, and kept there
// until delivered; when one is due the stack announces it in the call, at the
// PC it was set at, or by DM (see reminderRoute).

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import { writeJsonFile } from '../web/secrets-file.js';

export interface Reminder {
  id: string;
  userId: UserId;
  speaker: string;
  kind: 'timer' | 'reminder';
  /** What it's for ("pizza", "take out the trash"). */
  text: string;
  dueAt: number; // epoch ms
  createdAt: number;
  guildId?: string;
  /** The PC it was set at (`sat:<device id>`). */
  room?: string;
}

const MAX_PER_USER = 20;
const MAX_AHEAD_MS = 31 * 24 * 3_600_000;
/** A delivery that failed goes again after this long... */
const RETRY_MS = 60_000;
/** ...for about a day. Closed DMs never work, and must not try for ever. */
const MAX_TRIES = 24 * 60;
/** From this far ahead a weekday alone could mean the wrong week. */
const WEEK_MS = 7 * 24 * 3_600_000;

/** Offset of `tz` from UTC at instant `ms`, in ms. */
function tzOffset(ms: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** "2026-10-16T07:30" in the household time zone → epoch ms. */
export function localToEpoch(local: string, tz: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return undefined;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz); // second pass handles DST edges
  return Number.isFinite(t) ? t : undefined;
}

export function spokenDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const parts: string[] = [];
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) parts.push(`${d} day${d > 1 ? 's' : ''}`);
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
  if (sec && !d && !h) parts.push(`${sec} second${sec > 1 ? 's' : ''}`);
  return parts.join(' ') || 'a moment';
}

/** What she says when a timer or reminder is set: what she understood, so a
 *  misheard "fifty" gets noticed. Anything else (a refusal) is left to the model. */
function setLine(raw: string): string | undefined {
  const m = /^(Timer|Reminder) set: .* due (.+?) \(in (.+)\)\.$/s.exec(raw);
  return m ? (m[1] === 'Timer' ? `Timer set for ${m[3]}.` : `Reminder set for ${m[2]}.`) : undefined;
}

export interface ReminderRoute {
  /** Where she says it, if anywhere. */
  speak?: 'call' | 'pc';
  dm: boolean;
}

/** Where a due reminder goes. Someone audible in her call hears it there. Else
 *  the PC it was set at says it, with a DM as well: that PC can be on with
 *  nobody at it, and spoken words leave no record. Else her call, for someone
 *  who's in it but muted. Else a DM. */
export function reminderRoute(w: { audibleInCall: boolean; inChannel: boolean; pcUp: boolean }): ReminderRoute {
  if (w.audibleInCall) return { speak: 'call', dm: false };
  if (w.pcUp) return { speak: 'pc', dm: true };
  return w.inChannel ? { speak: 'call', dm: false } : { dm: true };
}

export class Reminders {
  private list: Reminder[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** Due ones on their way out: how many tries, and when the next one may start. */
  private readonly sending = new Map<string, { tries: number; nextAt: number }>();

  constructor(
    private readonly file: string | undefined,
    private readonly timezone: string,
    /** Return a promise if delivery takes time: it stays on disk until that's
     *  done, and goes again if it rejects. */
    private readonly onDue: (r: Reminder, lateMs: number) => void | Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8')) as Reminder[];
        if (Array.isArray(d)) this.list = d;
      } catch {
        /* none yet */
      }
    }
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 1_000);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const now = this.now();
    for (const r of this.list) {
      if (r.dueAt <= now && (this.sending.get(r.id)?.nextAt ?? 0) <= now) this.deliver(r, now - r.dueAt);
    }
  }

  /** It leaves the file only once it's out: a crash, a restart or a failed DM
   *  in the meantime must not lose it. A crash can mean hearing it twice. */
  private deliver(r: Reminder, lateMs: number): void {
    const s = this.sending.get(r.id) ?? { tries: 0, nextAt: 0 };
    s.tries++;
    s.nextAt = Infinity; // nothing new until this try is over
    this.sending.set(r.id, s);
    const done = () => {
      this.sending.delete(r.id);
      this.list = this.list.filter((x) => x.id !== r.id);
      this.save();
    };
    const failed = () => {
      if (s.tries >= MAX_TRIES) done();
      else s.nextAt = this.now() + RETRY_MS;
    };
    try {
      const sent = this.onDue(r, lateMs);
      if (sent instanceof Promise) void sent.then(done, failed);
      else done();
    } catch {
      failed();
    }
  }

  forUser(userId: UserId): Reminder[] {
    return this.list.filter((r) => r.userId === userId && !this.sending.has(r.id)).sort((a, b) => a.dueAt - b.dueAt);
  }

  add(ctx: ToolContext, kind: Reminder['kind'], text: string, dueAt: number): Reminder | string {
    const now = this.now();
    if (!(dueAt > now)) return 'That time has already passed.';
    if (dueAt - now > MAX_AHEAD_MS) return 'That is too far ahead; the limit is 31 days.';
    if (this.forUser(ctx.userId).length >= MAX_PER_USER) return `You already have ${MAX_PER_USER} timers and reminders; cancel some first.`;
    const r: Reminder = {
      id: randomUUID().slice(0, 8),
      userId: ctx.userId,
      speaker: ctx.speaker,
      kind,
      text: text.trim().slice(0, 160),
      dueAt,
      createdAt: now,
      ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
      ...(ctx.channelId?.startsWith('sat:') ? { room: ctx.channelId } : {}),
    };
    this.list.push(r);
    this.save();
    return r;
  }

  /** Cancel by what it's for (substring), "all", or the only one. */
  cancel(userId: UserId, which: string): Reminder[] {
    const mine = this.forUser(userId);
    const w = which.trim().toLowerCase();
    const hit =
      w === 'all' || (w === '' && mine.length === 1)
        ? mine
        : mine.filter((r) => r.text.toLowerCase().includes(w) || r.id === w || (w === 'timer' && r.kind === 'timer'));
    if (hit.length) {
      const ids = new Set(hit.map((r) => r.id));
      this.list = this.list.filter((r) => !ids.has(r.id));
      this.save();
    }
    return hit;
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeJsonFile(this.file, this.list);
    } catch {
      /* kept in memory; saved again on the next change */
    }
  }

  describe(r: Reminder): string {
    const left = spokenDuration(r.dueAt - this.now());
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        .formatToParts(r.dueAt)
        .map((x) => [x.type, x.value]),
    ) as Record<string, string>;
    const date = r.dueAt - this.now() >= WEEK_MS ? `, ${p.month} ${p.day}` : '';
    const clock = p.minute === '00' ? p.hour : `${p.hour}:${p.minute}`;
    return `${r.kind} "${r.text}" due ${p.weekday}${date} at ${clock} ${p.dayPeriod} (in ${left})`;
  }

  /** `english`: does this person speak English to her? The tools' short
   *  confirmations are in English, so for anyone else the model says them. */
  tools(english: (userId: UserId) => boolean = () => true): Tool[] {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return [
      {
        spec: {
          name: 'set_timer',
          description: 'Start a countdown timer for the person asking. Give the duration; label is what it is for.',
          parameters: {
            type: 'object',
            properties: {
              hours: { type: 'number' },
              minutes: { type: 'number' },
              seconds: { type: 'number' },
              label: { type: 'string', description: 'e.g. "pizza"; empty if none' },
            },
            additionalProperties: false,
          },
        },
        acts: true,
        run: async (a, _s, ctx) => {
          const ms = (num(a.hours) * 3600 + num(a.minutes) * 60 + num(a.seconds)) * 1000;
          if (ms < 1000) return 'No duration given; ask how long.';
          const label = typeof a.label === 'string' && a.label.trim() ? a.label : `${spokenDuration(ms).replace(/(\d+) (\w+?)s\b/g, '$1 $2')} timer`;
          const r = this.add(ctx, 'timer', label, this.now() + ms);
          return typeof r === 'string' ? r : `Timer set: ${this.describe(r)}.`;
        },
        speak: (_a, raw, ctx) => (english(ctx.userId) ? setLine(raw) : undefined),
      },
      {
        spec: {
          name: 'set_reminder',
          description:
            'Remind the person asking about something later. Use in_minutes for relative times, or at for a clock time as local "YYYY-MM-DDTHH:MM" (household time zone; work it out from today\'s date).',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'what to remind them of, e.g. "take out the trash"' },
              in_minutes: { type: 'number' },
              at: { type: 'string' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        acts: true,
        run: async (a, _s, ctx) => {
          const text = typeof a.text === 'string' ? a.text : '';
          if (!text.trim()) return 'Ask what the reminder is for.';
          let due: number | undefined;
          if (typeof a.in_minutes === 'number' && a.in_minutes > 0) due = this.now() + a.in_minutes * 60_000;
          else if (typeof a.at === 'string') due = localToEpoch(a.at, this.timezone);
          if (due === undefined) return 'No time given; ask when.';
          const r = this.add(ctx, 'reminder', text, due);
          return typeof r === 'string' ? r : `Reminder set: ${this.describe(r)}.`;
        },
        speak: (_a, raw, ctx) => (english(ctx.userId) ? setLine(raw) : undefined),
      },
      {
        spec: {
          name: 'list_timers',
          description: "List the asking person's timers and reminders, with time left.",
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        run: async (_a, _s, ctx) => {
          const mine = this.forUser(ctx.userId);
          return mine.length ? mine.map((r) => this.describe(r)).join('\n') : 'No timers or reminders.';
        },
      },
      {
        spec: {
          name: 'cancel_timer',
          description: 'Cancel timers or reminders of the person asking: by what it is for, or "all".',
          parameters: {
            type: 'object',
            properties: { which: { type: 'string', description: 'e.g. "pizza", "trash", "all"; empty if they have only one' } },
            additionalProperties: false,
          },
        },
        acts: true,
        run: async (a, _s, ctx) => {
          const hit = this.cancel(ctx.userId, typeof a.which === 'string' ? a.which : '');
          return hit.length ? `Cancelled: ${hit.map((r) => `${r.kind} "${r.text}"`).join(', ')}.` : 'Nothing matched; list them first.';
        },
        speak: (_a, raw, ctx) => (english(ctx.userId) && raw.startsWith('Cancelled:') ? 'Cancelled.' : undefined),
      },
    ];
  }
}

/** What to say when one is due. */
export function dueMessage(r: Reminder, lateMs: number): string {
  const late = lateMs > 90_000 ? ` Sorry, this is ${spokenDuration(lateMs)} late; I was offline.` : '';
  return r.kind === 'timer'
    ? `${r.speaker}, your ${r.text.replace(/ timer$/, '')} timer is done.${late}`
    : `${r.speaker}, reminder: ${r.text}.${late}`;
}
