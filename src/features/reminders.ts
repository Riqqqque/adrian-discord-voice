// Timers and reminders. Saved to disk so they survive restarts; when one is
// due the stack announces it in the call (or by DM if the person isn't there).

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
}

const MAX_PER_USER = 20;
const MAX_AHEAD_MS = 31 * 24 * 3_600_000;

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

export class Reminders {
  private list: Reminder[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly file: string | undefined,
    private readonly timezone: string,
    private readonly onDue: (r: Reminder, lateMs: number) => void,
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
    const due = this.list.filter((r) => r.dueAt <= now);
    if (!due.length) return;
    this.list = this.list.filter((r) => r.dueAt > now);
    this.save();
    for (const r of due) this.onDue(r, now - r.dueAt);
  }

  forUser(userId: UserId): Reminder[] {
    return this.list.filter((r) => r.userId === userId).sort((a, b) => a.dueAt - b.dueAt);
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
    const at = new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(r.dueAt);
    return `${r.kind} "${r.text}" due ${at} (in ${left})`;
  }

  tools(): Tool[] {
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
        run: async (a, _s, ctx) => {
          const ms = (num(a.hours) * 3600 + num(a.minutes) * 60 + num(a.seconds)) * 1000;
          if (ms < 1000) return 'No duration given; ask how long.';
          const label = typeof a.label === 'string' && a.label.trim() ? a.label : `${spokenDuration(ms).replace(/(\d+) (\w+?)s\b/g, '$1 $2')} timer`;
          const r = this.add(ctx, 'timer', label, this.now() + ms);
          return typeof r === 'string' ? r : `Timer set: ${this.describe(r)}.`;
        },
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
        run: async (a, _s, ctx) => {
          const hit = this.cancel(ctx.userId, typeof a.which === 'string' ? a.which : '');
          return hit.length ? `Cancelled: ${hit.map((r) => `${r.kind} "${r.text}"`).join(', ')}.` : 'Nothing matched; list them first.';
        },
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
