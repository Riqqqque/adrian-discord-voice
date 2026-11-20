// Alarms and timers that ring: a sound that repeats until it's turned off,
// where the person is (her call, their PC, else a message), with snooze.
//
// What's ringing is kept on disk, not in an audio handle: a restart, a move
// to another call or a PC that drops its link ends the sound, and the next
// tick starts it again wherever the person is now. Nothing rings out silently:
// an alarm nobody answers snoozes itself and rings again, twice, then sends a
// "you missed it" message. One due while she was offline rings when she's
// back, if it's still within its ring time, else that message goes out.

import { readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { UserId } from '../core/interfaces.js';
import { dateFormat } from '../core/time.js';
import { writeJsonFile } from '../web/secrets-file.js';
import { localToEpoch, spokenDuration } from './reminders.js';
import { DEFAULT_TIMER_TONE, DEFAULT_TONE, isTone } from './alarm-tones.js';

export type AlarmKind = 'alarm' | 'timer';
export type DismissMode = 'stop' | 'firm' | 'math';

export interface Alarm {
  id: string;
  userId: UserId;
  speaker: string;
  kind: AlarmKind;
  /** What it's for ("gym", "pizza"), or ''. */
  label: string;
  /** A tone name, `voice`, `clip:<name>` or `music:<what to play>`; unset = their default. */
  sound?: string;
  /** When it rings next (a snooze moves this). Epoch ms. */
  at: number;
  /** When this occurrence was set for, before any snooze. */
  base: number;
  /** Alarms: the clock time, "07:00", in `tz`. */
  time?: string;
  /** Weekdays it repeats on (0 = Sunday), in `tz`. Unset: once. */
  days?: number[];
  /** The time zone it was set in. */
  tz: string;
  enabled: boolean;
  /** Days it won't ring on, "YYYY-MM-DD" in `tz` ("skip Friday's"). */
  skip?: string[];
  snoozeMin?: number;
  /** Timers: how long it was set for. */
  durationMs?: number;
  createdAt: number;
  guildId?: string;
  /** The PC it was set at (`sat:<device id>`). */
  room?: string;
  /** Ringing since then (epoch ms). */
  ringingSince?: number;
  /** Rings in a row that nobody answered, this occurrence. */
  unanswered?: number;
  /** `at` is a snooze, not the planned time. */
  snoozed?: boolean;
  /** The ring round a "nobody could hear it" message went out for. */
  dmRound?: number;
}

export interface AlarmPrefs {
  /** Default sound for alarms, and for timers. */
  sound?: string | undefined;
  timerSound?: string | undefined;
  snoozeMin?: number | undefined;
  /** How long one ring lasts before it snoozes itself (alarms) or stops (timers), minutes. */
  ringMin?: number | undefined;
  timerRingMin?: number | undefined;
  /** Seconds for an alarm to rise from soft to full. */
  fadeIn?: number | undefined;
  /** 0.1 to 1. */
  volume?: number | undefined;
  dismiss?: DismissMode | undefined;
  /** Her voice says the time and what it's for while it rings. */
  voice?: boolean | undefined;
  timezone?: string | undefined;
}

export interface SavedSound {
  name: string;
  owner: UserId;
  /** File name in the sounds folder. */
  file: string;
  title?: string;
  seconds: number;
}

interface FileShape {
  version: 1;
  alarms: Alarm[];
  prefs: Record<UserId, AlarmPrefs>;
  sounds: SavedSound[];
}

export const LIMITS = {
  perUser: 30,
  aheadMs: 366 * 24 * 3_600_000,
  timerMaxMs: 7 * 24 * 3_600_000,
  snoozeMin: [1, 60] as const,
  ringMin: [1, 30] as const,
  fadeIn: [0, 300] as const,
  /** Rings an alarm gets before it counts as missed: the first plus two snoozes. */
  rounds: 3,
  /** "Snooze" right after a stop puts it back, this long. */
  undoMs: 3 * 60_000,
};

export const DEFAULTS = { snoozeMin: 9, ringMin: 10, timerRingMin: 5, fadeIn: 30, volume: 1, dismiss: 'stop' as DismissMode, voice: true };

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// --- time ---------------------------------------------------------------------

interface LocalParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  wd: number;
}

export function localParts(ms: number, tz: string): LocalParts {
  const p = Object.fromEntries(
    dateFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const y = +p.year!, m = +p.month!, d = +p.day!;
  return { y, m, d, hh: +p.hour! % 24, mm: +p.minute!, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-20": the day `ms` falls on in `tz`. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "7", "7:30", "07:30", "7am", "7:30 pm", "19:05" → "HH:MM" (24 h). */
export function parseClock(v: string): string | undefined {
  const m = /^\s*(\d{1,2})(?:[:.h](\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(v);
  if (!m) return undefined;
  let h = +m[1]!;
  const min = m[2] ? +m[2] : 0;
  const ap = m[3]?.toLowerCase();
  if (min > 59) return undefined;
  if (ap) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  } else if (h > 23) return undefined;
  return `${pad(h)}:${pad(min)}`;
}

/** The first time `time` (on one of `days`, if given) comes after `after`. */
export function nextAt(time: string, days: readonly number[] | undefined, tz: string, after: number, date?: string): number | undefined {
  if (date) {
    const t = existing(localToEpoch(`${date}T${time}`, tz), time, tz);
    return t !== undefined && t > after ? t : undefined;
  }
  const p = localParts(after, tz);
  for (let k = 0; k <= 8; k++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + k));
    if (days?.length && !days.includes(day.getUTCDay())) continue;
    const t = existing(localToEpoch(`${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${time}`, tz), time, tz);
    if (t !== undefined && t > after) return t;
  }
  return undefined;
}

/** 2:30 on the night the clocks jump from 2 to 3 doesn't exist: it rings at
 *  3:30, an hour on, like a phone's alarm, not at 1:30. */
function existing(t: number | undefined, time: string, tz: string): number | undefined {
  if (t === undefined) return t;
  const p = localParts(t, tz);
  return `${pad(p.hh)}:${pad(p.mm)}` === time ? t : t + 3_600_000;
}

/** "weekdays", "daily", "mon,wed,fri", ["monday", "tuesday"] → weekday numbers;
 *  "once" or nothing → undefined. Null: not understood. */
export function parseDays(v: unknown): number[] | undefined | null {
  if (v === undefined || v === null || v === '') return undefined;
  const parts = (Array.isArray(v) ? v.map(String) : String(v).split(/[,\s/&]+|\band\b/))
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const out = new Set<number>();
  for (const x of parts) {
    if (x === 'once' || x === 'never' || x === 'none') continue;
    if (x === 'daily' || x === 'everyday' || x === 'every' || x === 'day' || x === 'days') [0, 1, 2, 3, 4, 5, 6].forEach((d) => out.add(d));
    else if (x === 'weekdays' || x === 'weekday') [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (x === 'weekends' || x === 'weekend') [0, 6].forEach((d) => out.add(d));
    else {
      const i = DAY_NAMES.findIndex((d) => d.startsWith(x.replace(/s$/, '').slice(0, 3)) && x.length >= 2);
      if (i < 0) return null;
      out.add(i);
    }
  }
  return out.size ? [...out].sort() : undefined;
}

export function daysText(days: readonly number[] | undefined): string {
  if (!days?.length) return '';
  const k = [...days].sort().join('');
  if (k === '0123456') return 'every day';
  if (k === '12345') return 'on weekdays';
  if (k === '06') return 'on weekends';
  const names = days.map((d) => DAY_NAMES[d]!.charAt(0).toUpperCase() + DAY_NAMES[d]!.slice(1) + 's');
  return `on ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
}

/** "7 AM", "7:30 PM". */
export function clockText(ms: number, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p.minute === '00' ? p.hour : `${p.hour}:${p.minute}`} ${p.dayPeriod}`;
}

/** "today", "tomorrow, Thursday", "Saturday", "Saturday, March 4". */
export function dayText(ms: number, tz: string, now: number): string {
  const a = localParts(now, tz);
  const b = localParts(ms, tz);
  const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
  const wd = DAY_NAMES[b.wd]!.charAt(0).toUpperCase() + DAY_NAMES[b.wd]!.slice(1);
  if (days === 0) return 'today';
  if (days === 1) return `tomorrow, ${wd}`;
  if (days < 7) return wd;
  const month = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long' }).format(ms);
  return `${wd}, ${month} ${b.d}`;
}

// --- words ---------------------------------------------------------------------

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** The first number in the words: "15", "fifteen", "twenty two", "a hundred and five". */
export function firstNumber(text: string): number | undefined {
  const digits = /-?\d+/.exec(text);
  const words = text.toLowerCase().replace(/-/g, ' ').match(/[a-z]+/g) ?? [];
  let wordValue: number | undefined;
  let cur = 0;
  let any = false;
  for (const w of words) {
    if (w === 'and' && any) continue;
    if (w === 'hundred' && any) {
      cur *= 100;
      continue;
    }
    const v = SMALL[w];
    // "a" / "an" / "for" / "oh" only count inside a number ("a hundred"), never alone.
    if (v === undefined || (!any && ['a', 'an', 'for', 'oh', 'ate'].includes(w) && !/\bhundred\b/.test(text.toLowerCase()))) {
      if (any) break;
      continue;
    }
    any = true;
    cur += v;
  }
  if (any) wordValue = cur;
  if (digits && (wordValue === undefined || text.indexOf(digits[0]) < text.toLowerCase().search(/[a-z]/))) return +digits[0];
  return wordValue ?? (digits ? +digits[0] : undefined);
}

const clean = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    // Speech-to-text slips: a stray letter ("stop the t timer") or a word said twice ("stop the the alarm").
    .replace(/(?<=^|\s)[b-hj-z](?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(\w+)(?: \1\b)+/g, '$1')
    .trim();

const FILL = /^(?:(?:hey|ok|okay|yo|um+|uh+|oh|ah+|alright|all right|please|just|so|god|ugh|man|bro|dude|adrian|adriane|adrien|aiden|adrianne)\s+)*/;
const TAIL = /(?:\s+(?:please|now|already|adrian|thanks|thank you|for me|ok|okay|man|bro|dude))*$/;

export type RingWord = { action: 'stop' } | { action: 'up' } | { action: 'snooze'; minutes?: number } | { action: 'back' };

const STOP_WORDS = new Set([
  'stop', 'stop it', 'stop that', 'stop the alarm', 'stop alarm', 'stop my alarm', 'stop the timer', 'stop timer', 'stop my timer', 'stop the sound', 'stop ringing',
  'off', 'turn it off', 'turn that off', 'turn off', 'turn off the alarm', 'turn the alarm off', 'turn off my alarm', 'turn my alarm off', 'alarm off', 'timer off',
  'turn off the timer', 'turn the timer off', 'shut it off', 'switch it off', 'cancel', 'cancel it', 'cancel the alarm', 'cancel the timer', 'dismiss', 'dismiss it',
  'dismiss alarm', 'dismiss the alarm', 'cancel my alarm', 'cancel my timer', 'stop my alarm', 'stop my timer', 'turn off my timer', 'turn my timer off', 'shut up', 'be quiet', 'quiet', 'enough', 'thats enough', 'end it', 'kill it', 'kill the alarm', 'silence', 'mute it', 'stop stop',
]);
const UP_WORDS = new Set([
  'im up', 'i am up', 'im awake', 'i am awake', 'im getting up', 'i am getting up', 'im out of bed', 'i got up', 'im up now', 'ok im up', 'okay im up', 'yes im up',
  'im awake now', 'got it im up', 'alright im up', 'all right im up', 'i heard it', 'i hear it',
]);
const SNOOZE = /^(?:snooze(?: it| the alarm| my alarm| that)?(?: (?:for )?(.+?) (?:more )?minutes?)?|(.+?) more minutes?|give me (.+?)(?: more)? minutes?|(?:wake me|ring|remind me)(?: again)? in (.+?) minutes?|later|not yet|not now|in a bit|five more|10 more|ten more|(?:snooze(?: it| that)? )?(?:for )?a (?:bit|while|little(?: bit| while)?)(?: longer| more)?)$/;
/** "a few", "a couple": snooze, for their usual length. */
const VAGUE = /^(?:give me )?(?:a )?(?:few|couple(?: of)?|bit|little|little bit|while)$/;
const BACK = /^(?:wait|no|oh no|oops|whoops)?\s*(?:turn (?:it|the alarm) back on|put (?:it|the alarm) back|i wasnt (?:up|awake)|im not (?:up|awake)|undo( that)?|snooze( it| that)?)$/;

/** What a whole utterance means to a ringing alarm, if anything. Only whole
 *  utterances count: "stop by the store later" or a song title isn't a stop. */
export function ringWord(text: string): RingWord | undefined {
  const whole = clean(text).replace(FILL, '').trim();
  if (/^not (yet|now)$/.test(whole)) return { action: 'snooze' };
  const t = whole.replace(TAIL, '').trim();
  if (!t) return undefined;
  if (UP_WORDS.has(t)) return { action: 'up' };
  if (STOP_WORDS.has(t) || STOP_WORDS.has(t.replace(/^(?:can you |could you |please )/, ''))) return { action: 'stop' };
  const m = SNOOZE.exec(t);
  if (m) {
    const n = m[1] ?? m[2] ?? m[3] ?? m[4];
    const minutes = n ? firstNumber(n) : /^(five|10|ten) more$/.test(t) ? firstNumber(t) : undefined;
    if (n && minutes === undefined) return VAGUE.test(n) ? { action: 'snooze' } : undefined; // "snooze for banana minutes"?
    return { action: 'snooze', ...(minutes !== undefined ? { minutes } : {}) };
  }
  return undefined;
}

/** After a stop: "wait, I'm not up", "turn it back on", "snooze". */
export function backWord(text: string): boolean {
  return BACK.test(clean(text).replace(FILL, '').replace(TAIL, '').trim());
}

// --- the clock -------------------------------------------------------------------

export interface RingPlan {
  userId: UserId;
  /** Every alarm ringing for them now. */
  alarms: () => Alarm[];
  prefs: AlarmPrefs & typeof DEFAULTS;
  /** The first ring of this round (not a restart in a new place). */
  fresh: boolean;
  /** How late the first of them is, for "sorry, I was offline". */
  lateMs: number;
}

export interface RingHandle {
  stop(): void;
  /** False once the sound ended by itself (the call was left, the PC dropped). */
  alive(): boolean;
}

export interface AlarmDeps {
  /** Where it can ring for them now: a room key, or undefined. */
  placeFor(userId: UserId): string | undefined;
  /** They'll hear it there but can't be heard saying stop (muted in her call): send the buttons too. */
  needsButtons?(userId: UserId): boolean;
  /** Start ringing there. */
  ring(place: string, plan: RingPlan): RingHandle | undefined;
  /** A Discord message to them. `buttons`: Stop / Snooze on the message, for that ring of that alarm. */
  dm(userId: UserId, text: string, buttons?: { alarmId: string; base: number }): Promise<boolean>;
  /** A saved sound's file is no longer used (replaced or deleted): delete it. */
  soundGone?(file: string): void;
  /** Something changed (set, ringing, stopped): for the PC copies and windows. */
  changed?(userId: UserId): void;
  log?(event: string, fields: Record<string, unknown>): void;
}

interface Session {
  place: string | undefined;
  handle: RingHandle | undefined;
  /** Don't start again before this (a place that keeps failing). */
  retryAt: number;
  startedAt: number;
  /** Math mode: the question asked, and its answer. */
  math?: { q: string; answer: number };
}

export interface ControlResult {
  /** Something was done (or answered): the words are for it. */
  done: boolean;
  /** What she says. */
  say: string;
}

export class AlarmClock {
  private data: FileShape = { version: 1, alarms: [], prefs: {}, sounds: [] };
  private timer: NodeJS.Timeout | undefined;
  private readonly sessions = new Map<UserId, Session>();
  /** Stopped in the last few minutes, for "wait, I'm not up". */
  private readonly lastOff = new Map<UserId, { at: number; alarms: Alarm[] }>();
  /** The last save failed: said when setting one. */
  saveFailed = false;
  /** The file is there but couldn't be read: never written over. */
  private locked = false;
  /** Snoozed by "stop" in firm mode, for "I'm up" right after. */
  private readonly firmSnooze = new Map<UserId, { at: number; ids: string[] }>();

  constructor(
    private readonly file: string | undefined,
    private readonly timezone: string,
    private readonly deps: AlarmDeps,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  // --- storage -------------------------------------------------------------

  private load(): void {
    if (!this.file) return;
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // none yet
      // There but unreadable (permissions after an upgrade, say): saving would wipe it.
      this.locked = true;
      this.deps.log?.('alarms file unreadable; not saving over it', { error: (e as Error).message });
      return;
    }
    try {
      const d = JSON.parse(text) as Partial<FileShape>;
      const alarms = Array.isArray(d.alarms) ? d.alarms.filter(isAlarm) : [];
      const dropped = (Array.isArray(d.alarms) ? d.alarms.length : 0) - alarms.length;
      if (dropped) this.deps.log?.('alarms skipped', { count: dropped });
      this.data = {
        version: 1,
        alarms,
        prefs: d.prefs && typeof d.prefs === 'object' ? (d.prefs as Record<UserId, AlarmPrefs>) : {},
        sounds: Array.isArray(d.sounds) ? d.sounds.filter(isSaved) : [],
      };
    } catch (e) {
      // Never start empty over a file that's there: the next save would wipe it.
      const aside = `${this.file}.unreadable-${this.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {
        /* left where it is */
      }
      this.deps.log?.('alarms file unreadable; moved aside', { file: aside, error: (e as Error).message });
    }
  }

  private save(): boolean {
    if (!this.file) return true;
    if (this.locked) {
      this.saveFailed = true;
      return false;
    }
    try {
      writeJsonFile(this.file, this.data);
      this.saveFailed = false;
      return true;
    } catch (e) {
      this.saveFailed = true;
      this.deps.log?.('alarms save failed', { error: (e as Error).message });
      return false;
    }
  }

  // --- reading ---------------------------------------------------------------

  prefs(userId: UserId): AlarmPrefs & typeof DEFAULTS {
    const p = this.data.prefs[userId] ?? {};
    // Anything missing or out of range (a hand-edited file) falls back to the default.
    const n = (v: unknown, [lo, hi]: readonly [number, number], d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    return {
      ...p,
      snoozeMin: n(p.snoozeMin, LIMITS.snoozeMin, DEFAULTS.snoozeMin),
      ringMin: n(p.ringMin, LIMITS.ringMin, DEFAULTS.ringMin),
      timerRingMin: n(p.timerRingMin, LIMITS.ringMin, DEFAULTS.timerRingMin),
      fadeIn: n(p.fadeIn, LIMITS.fadeIn, DEFAULTS.fadeIn),
      volume: n(p.volume, [0.1, 1], DEFAULTS.volume),
      dismiss: p.dismiss === 'firm' || p.dismiss === 'math' || p.dismiss === 'stop' ? p.dismiss : DEFAULTS.dismiss,
      voice: typeof p.voice === 'boolean' ? p.voice : DEFAULTS.voice,
    };
  }

  zone(userId: UserId): string {
    const tz = this.data.prefs[userId]?.timezone;
    return tz && validZone(tz) ? tz : this.timezone;
  }

  forUser(userId: UserId, kind?: AlarmKind): Alarm[] {
    return this.data.alarms.filter((a) => a.userId === userId && (!kind || a.kind === kind)).sort((a, b) => a.at - b.at);
  }

  all(): readonly Alarm[] {
    return this.data.alarms;
  }

  ringingFor(userId: UserId): Alarm[] {
    return this.data.alarms.filter((a) => a.userId === userId && a.ringingSince !== undefined);
  }

  /** Who has something ringing, and where. */
  ringing(): { userId: UserId; place: string | undefined }[] {
    return [...this.sessions].map(([userId, s]) => ({ userId, place: s.place }));
  }

  /** Ringing, snoozed, or due within `ms`: a bad moment for a restart. */
  busySoon(ms = 5 * 60_000): boolean {
    const now = this.now();
    return this.data.alarms.some((a) => a.enabled && (a.ringingSince !== undefined || a.snoozed || a.at - now <= ms));
  }

  sounds(userId: UserId): SavedSound[] {
    return this.data.sounds.filter((s) => s.owner === userId);
  }

  savedSound(userId: UserId, name: string): SavedSound | undefined {
    const n = name.trim().toLowerCase();
    return this.data.sounds.find((s) => s.owner === userId && s.name.toLowerCase() === n);
  }

  addSound(s: SavedSound): void {
    const old = this.savedSound(s.owner, s.name);
    this.data.sounds = this.data.sounds.filter((x) => x !== old);
    this.data.sounds.push(s);
    this.save();
    if (old && old.file !== s.file) this.soundGone(old.file);
  }

  removeSound(userId: UserId, name: string): SavedSound | undefined {
    const s = this.savedSound(userId, name);
    if (!s) return undefined;
    this.data.sounds = this.data.sounds.filter((x) => x !== s);
    // Alarms that used it go back to the default sound.
    for (const a of this.data.alarms) if (a.userId === userId && a.sound === `clip:${s.name}`) delete a.sound;
    const p = this.data.prefs[userId];
    if (p?.sound === `clip:${s.name}`) delete p.sound;
    if (p?.timerSound === `clip:${s.name}`) delete p.timerSound;
    this.save();
    this.soundGone(s.file);
    return s;
  }

  private soundGone(file: string): void {
    try {
      this.deps.soundGone?.(file);
    } catch (e) {
      this.deps.log?.('alarm sound file not deleted', { error: (e as Error).message });
    }
  }

  setPrefs(userId: UserId, change: AlarmPrefs): void {
    const p = { ...(this.data.prefs[userId] ?? {}), ...change };
    for (const k of Object.keys(p) as (keyof AlarmPrefs)[]) if (p[k] === undefined) delete p[k];
    this.data.prefs[userId] = p;
    this.save();
    this.deps.changed?.(userId);
  }

  /** The sound it will really use. */
  soundOf(a: Alarm): string {
    const p = this.prefs(a.userId);
    return a.sound ?? (a.kind === 'timer' ? (p.timerSound ?? DEFAULT_TIMER_TONE) : (p.sound ?? DEFAULT_TONE));
  }

  // --- changes -----------------------------------------------------------------

  add(a: Omit<Alarm, 'id' | 'createdAt' | 'enabled' | 'base'> & { base?: number }): Alarm | string {
    const now = this.now();
    if (!(a.at > now)) return 'That time has already passed.';
    if (a.at - now > LIMITS.aheadMs) return 'That is too far ahead; the limit is a year.';
    if (this.forUser(a.userId).length >= LIMITS.perUser) return `You already have ${LIMITS.perUser} alarms and timers; delete some first.`;
    const full: Alarm = { ...a, id: randomUUID().slice(0, 8), createdAt: now, enabled: true, base: a.base ?? a.at, label: a.label.trim().slice(0, 80) };
    this.data.alarms.push(full);
    this.save();
    this.deps.changed?.(a.userId);
    return full;
  }

  update(a: Alarm): void {
    this.save();
    this.deps.changed?.(a.userId);
  }

  remove(ids: readonly string[]): Alarm[] {
    const set = new Set(ids);
    const gone = this.data.alarms.filter((a) => set.has(a.id));
    if (!gone.length) return gone;
    this.data.alarms = this.data.alarms.filter((a) => !set.has(a.id));
    this.save();
    for (const u of new Set(gone.map((a) => a.userId))) this.deps.changed?.(u);
    return gone;
  }

  /** Move a repeating alarm to its next planned time, or take a one-off away. */
  private finish(a: Alarm, now: number): void {
    delete a.ringingSince;
    delete a.unanswered;
    delete a.snoozed;
    delete a.dmRound;
    if (a.kind === 'alarm' && a.days?.length && a.time) {
      const next = nextAt(a.time, a.days, a.tz, Math.max(now, a.base));
      if (next !== undefined) {
        a.at = a.base = next;
        // Skipped days already behind it are done with.
        const day = localDate(next, a.tz);
        if (a.skip) a.skip = a.skip.filter((x) => x >= day);
        if (!a.skip?.length) delete a.skip;
        return;
      }
    }
    this.data.alarms = this.data.alarms.filter((x) => x !== a);
  }

  // --- the clock ---------------------------------------------------------------

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 1_000);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.sessions.values()) s.handle?.stop();
    this.sessions.clear();
  }

  ringMs(a: Alarm): number {
    const p = this.prefs(a.userId);
    return (a.kind === 'timer' ? p.timerRingMin : p.ringMin) * 60_000;
  }

  snoozeMs(a: Alarm): number {
    return (a.snoozeMin ?? this.prefs(a.userId).snoozeMin) * 60_000;
  }

  tick(): void {
    const now = this.now();
    let changed = false;
    const touched = new Set<UserId>();
    for (const a of [...this.data.alarms]) {
      if (!a.enabled) continue;
      if (a.ringingSince !== undefined) {
        // A ring nobody answered: snooze itself, or give up with a message.
        if (now - a.ringingSince >= this.ringMs(a)) {
          changed = true;
          touched.add(a.userId);
          this.unanswered(a, now);
        }
        continue;
      }
      if (a.at > now) continue;
      changed = true;
      touched.add(a.userId);
      const day = localDate(a.base, a.tz);
      if (a.skip?.includes(day) && !a.snoozed) {
        a.skip = a.skip.filter((x) => x > day);
        if (!a.skip.length) delete a.skip;
        this.deps.log?.('alarm skipped', { user: a.userId, id: a.id });
        this.finish(a, now);
        continue;
      }
      const late = now - a.at;
      if (late > this.ringMs(a)) {
        // Due while she was offline, and its ring time is over too.
        this.missed(a, late);
        continue;
      }
      a.ringingSince = now;
      this.deps.log?.('alarm ringing', { user: a.userId, id: a.id, kind: a.kind, lateMs: late, snoozed: !!a.snoozed });
    }
    if (changed) this.save();
    for (const u of touched) this.deps.changed?.(u);
    this.drive(now);
  }

  private unanswered(a: Alarm, now: number): void {
    const n = (a.unanswered ?? 0) + 1;
    if (a.kind === 'alarm' && n < LIMITS.rounds) {
      delete a.ringingSince;
      a.unanswered = n;
      a.snoozed = true;
      a.at = now + this.snoozeMs(a);
      this.deps.log?.('alarm unanswered; snoozed', { user: a.userId, id: a.id, round: n });
      return;
    }
    this.deps.log?.('alarm unanswered; missed', { user: a.userId, id: a.id, kind: a.kind });
    const tz = a.tz;
    const what = a.kind === 'timer' ? `Your ${timerName(a)} went off and nobody stopped it.` : `You missed your ${clockText(a.base, tz)} alarm${a.label ? ` (${a.label})` : ''}: it rang ${n === 1 ? 'once' : `${n} times`} and nobody answered.`;
    void this.deps.dm(a.userId, `${what}${this.nextLine(a, now)}`).catch(() => false);
    this.finish(a, now);
  }

  private missed(a: Alarm, lateMs: number): void {
    const now = this.now();
    this.deps.log?.('alarm missed while offline', { user: a.userId, id: a.id, lateMs });
    const what =
      a.kind === 'timer'
        ? `Your ${timerName(a)} was due ${spokenDuration(lateMs)} ago, while I was offline. Sorry.`
        : `Your ${clockText(a.base, a.tz)} alarm${a.label ? ` (${a.label})` : ''} was due while I was offline, so it didn't ring. Sorry.`;
    void this.deps.dm(a.userId, `${what}${this.nextLine(a, now)}`).catch(() => false);
    this.finish(a, now);
  }

  private nextLine(a: Alarm, now: number): string {
    if (a.kind !== 'alarm' || !a.days?.length || !a.time) return '';
    const next = nextAt(a.time, a.days, a.tz, Math.max(now, a.base));
    return next ? ` It rings next ${dayText(next, a.tz, now)} at ${clockText(next, a.tz)}.` : '';
  }

  /** Keep each ringing person's sound going in the right place. */
  private drive(now: number): void {
    const people = new Set(this.data.alarms.filter((a) => a.ringingSince !== undefined).map((a) => a.userId));
    for (const [u, s] of this.sessions) {
      if (!people.has(u)) {
        s.handle?.stop();
        this.sessions.delete(u);
      }
    }
    for (const u of people) {
      const ringing = () => this.ringingFor(u);
      const list = ringing();
      let s = this.sessions.get(u);
      const fresh = !s;
      const place = this.deps.placeFor(u);
      if (s && s.place === place && s.handle?.alive()) continue;
      if (s && s.retryAt > now && s.place === place) continue;
      s?.handle?.stop();
      if (!s) {
        s = { place, handle: undefined, retryAt: 0, startedAt: now };
        this.sessions.set(u, s);
      }
      s.place = place;
      s.handle = undefined;
      if (place) {
        const lateMs = Math.max(0, ...list.map((a) => (a.ringingSince ?? now) - a.at));
        s.handle = this.deps.ring(place, { userId: u, alarms: ringing, prefs: this.prefs(u), fresh, lateMs });
        // A place that ends at once (or fails) is tried again in a few seconds.
        s.retryAt = now + 5_000;
        if (s.handle) this.deps.log?.('alarm sound', { user: u, place, alarms: list.length });
      } else {
        s.retryAt = now + 5_000;
      }
      // Nowhere to ring, or nobody can hear them say stop: a message with buttons, once per round.
      if (!s.handle || this.deps.needsButtons?.(u)) {
        for (const a of list) {
          const round = (a.unanswered ?? 0) + 1;
          if (a.dmRound === round) continue;
          a.dmRound = round;
          this.save();
          const line = a.kind === 'timer' ? `⏰ Your ${timerName(a)} is done.` : `⏰ ${clockText(a.base, a.tz)} alarm${a.label ? `: ${a.label}` : ''}.`;
          const why = s.handle ? "It's ringing in the call, and you're muted there." : "I couldn't ring it anywhere you are, so this is it.";
          void this.deps.dm(u, `${line} ${why}`, { alarmId: a.id, base: a.base }).catch(() => false);
        }
      }
    }
  }

  // --- turning it off --------------------------------------------------------------

  /** Stop or snooze what's ringing for `userId`.
   *  `only`: a button on the message for one ring of one alarm (id and its `base`);
   *  it does nothing to anything else that rings now.
   *  `typed`: /alarm or a button, which stop a snoozed alarm too (a spoken stop
   *  between snoozes isn't one: firm mode would be skipped). */
  control(userId: UserId, action: 'stop' | 'snooze', minutes?: number, o: { only?: { id: string; base?: number }; typed?: boolean } = {}): ControlResult {
    const now = this.now();
    const list = this.ringingFor(userId);
    const only = o.only;
    const same = (a: Alarm) => !!only && a.id === only.id && (only.base === undefined || a.base === only.base);
    const snoozed = () => this.data.alarms.filter((a) => a.userId === userId && a.enabled && a.snoozed && a.ringingSince === undefined && (!only || same(a)));
    if (only && !list.some(same)) {
      const waiting = snoozed();
      if (waiting.length) return action === 'stop' ? this.offSnoozed(userId, waiting, now) : { done: false, say: `It's snoozed until ${clockText(waiting[0]!.at, waiting[0]!.tz)}.` };
      // Snooze just after a stop: the same "put it back" as saying it.
      if (action === 'snooze' && this.lastOff.get(userId)?.alarms.some(same)) {
        const r = this.putBack(userId, minutes);
        if (r) return r;
      }
      return { done: false, say: "That one isn't ringing any more." };
    }
    if (!list.length) {
      if (action === 'snooze') return this.putBack(userId, minutes) ?? { done: false, say: 'Nothing is ringing.' };
      const waiting = o.typed ? snoozed() : [];
      if (waiting.length) return this.offSnoozed(userId, waiting, now);
      return { done: false, say: 'Nothing is ringing.' };
    }
    const s = this.sessions.get(userId);
    if (s) delete s.math;
    if (action === 'snooze') {
      const min = clampInt(minutes, LIMITS.snoozeMin, undefined);
      for (const a of list) {
        delete a.ringingSince;
        delete a.dmRound;
        a.unanswered = 0;
        a.snoozed = true;
        a.at = now + (min !== undefined ? min * 60_000 : this.snoozeMs(a));
      }
      this.save();
      this.drive(now);
      this.deps.changed?.(userId);
      const first = list[0]!;
      const timer = list.every((a) => a.kind === 'timer');
      this.deps.log?.('alarm snoozed', { user: userId, alarms: list.length, minutes: Math.round((first.at - now) / 60_000) });
      return { done: true, say: timer ? `Okay, ${spokenDuration(first.at - now)} more.` : `Snoozed until ${clockText(first.at, first.tz)}.` };
    }
    this.lastOff.set(userId, { at: now, alarms: list.map((a) => ({ ...a })) });
    const say = offLine(list, now, (a) => this.nextLine(a, now));
    for (const a of list) this.finish(a, now);
    this.save();
    this.drive(now);
    this.deps.changed?.(userId);
    this.deps.log?.('alarm stopped', { user: userId, alarms: list.length });
    return { done: true, say };
  }

  /** Turn off alarms waiting out a snooze, as if they were ringing. */
  private offSnoozed(userId: UserId, list: Alarm[], now: number): ControlResult {
    this.firmSnooze.delete(userId);
    this.lastOff.set(userId, { at: now, alarms: list.map((a) => ({ ...a })) });
    const say = offLine(list, now, (a) => this.nextLine(a, now));
    for (const a of list) this.finish(a, now);
    this.save();
    this.deps.changed?.(userId);
    this.deps.log?.('alarm stopped', { user: userId, alarms: list.length, after: 'snooze' });
    return { done: true, say };
  }

  /** A PC rang this one by itself (the link was down) and it was answered
   *  there. Applied only if it's still that occurrence. */
  answeredElsewhere(userId: UserId, r: { id: string; base: number; action: 'stop' | 'snooze'; at: number; minutes?: number }): boolean {
    const a = this.data.alarms.find((x) => x.id === r.id && x.userId === userId);
    if (!a || a.base !== r.base) return false;
    const now = this.now();
    if (r.action === 'stop') this.finish(a, now);
    else {
      delete a.ringingSince;
      delete a.dmRound;
      a.unanswered = 0;
      a.snoozed = true;
      const min = clampInt(r.minutes, LIMITS.snoozeMin, undefined);
      a.at = Math.max(now + 1_000, Math.min(now + 60 * 60_000, r.at + (min !== undefined ? min * 60_000 : this.snoozeMs(a))));
    }
    this.save();
    this.drive(now);
    this.deps.changed?.(userId);
    return true;
  }

  /** Stop the sound of one ringing alarm without finishing it (it's being changed). */
  unring(a: Alarm): void {
    if (a.ringingSince === undefined) return;
    delete a.ringingSince;
    delete a.unanswered;
    delete a.dmRound;
    delete a.snoozed;
    this.save();
    this.drive(this.now());
    this.deps.changed?.(a.userId);
  }

  /** "Wait, I'm not up": what was just stopped comes back, snoozed. */
  private putBack(userId: UserId, minutes?: number): ControlResult | undefined {
    const off = this.lastOff.get(userId);
    const now = this.now();
    if (!off || now - off.at > LIMITS.undoMs) return undefined;
    this.lastOff.delete(userId);
    const min = clampInt(minutes, LIMITS.snoozeMin, undefined);
    let first: Alarm | undefined;
    for (const was of off.alarms) {
      const live = this.data.alarms.find((a) => a.id === was.id);
      const at = now + (min !== undefined ? min * 60_000 : this.snoozeMs(was));
      if (live) {
        // A repeating one already moved on: ring this occurrence again, then carry on.
        const { days: _days, ringingSince: _r, dmRound: _d, skip: _s, ...rest } = was;
        const copy: Alarm = { ...rest, id: randomUUID().slice(0, 8), at, snoozed: true, unanswered: 0 };
        this.data.alarms.push(copy);
        first ??= copy;
      } else {
        const back: Alarm = { ...was, at, snoozed: true, unanswered: 0 };
        delete back.ringingSince;
        delete back.dmRound;
        this.data.alarms.push(back);
        first ??= back;
      }
    }
    this.save();
    this.deps.changed?.(userId);
    return first ? { done: true, say: `Okay, it's back on. It rings again at ${clockText(first.at, first.tz)}.` } : undefined;
  }

  /** Words heard from `userId` while something of theirs is ringing (or was just
   *  stopped). Returns what to say when the words were for the alarm. */
  heard(userId: UserId, text: string): ControlResult | undefined {
    const list = this.ringingFor(userId);
    if (!list.length) {
      if (this.lastOff.has(userId) && backWord(text)) return this.putBack(userId);
      // Firm mode: "stop" snoozed it and told them to say "I'm up". Now they have.
      const firm = this.firmSnooze.get(userId);
      if (firm && this.now() - firm.at < 15 * 60_000 && ringWord(text)?.action === 'up') {
        this.firmSnooze.delete(userId);
        const now = this.now();
        const snoozed = this.data.alarms.filter((a) => firm.ids.includes(a.id) && a.snoozed && a.ringingSince === undefined);
        if (!snoozed.length) return undefined;
        const say = offLine(snoozed, now, (a) => this.nextLine(a, now));
        for (const a of snoozed) this.finish(a, now);
        this.save();
        this.deps.changed?.(userId);
        this.deps.log?.('alarm stopped', { user: userId, alarms: snoozed.length, after: 'firm snooze' });
        return { done: true, say };
      }
      return undefined;
    }
    const s = this.sessions.get(userId);
    const mode = this.prefs(userId).dismiss;
    const timersOnly = list.every((a) => a.kind === 'timer');
    if (s?.math && !timersOnly) {
      // Only a short answer counts: her own words coming back through a mic
      // ("What's 5 plus 7?", "It's 7 AM.") are not one.
      if (/\b(plus|its|it s|am|pm|alarm|timer|quite)\b/i.test(text.replace(/[’']/g, ' ')) || text.split(/\s+/).length > 5) {
        const w = ringWord(text);
        return w?.action === 'snooze' ? this.control(userId, 'snooze', w.minutes) : undefined;
      }
      const n = firstNumber(text);
      if (n === s.math.answer) return this.control(userId, 'stop');
      const w = ringWord(text);
      if (w?.action === 'snooze') return this.control(userId, 'snooze', w.minutes);
      if (n !== undefined) return { done: true, say: `Not quite. ${s.math.q}` };
      if (w) return { done: true, say: s.math.q };
      return undefined;
    }
    const w = ringWord(text);
    if (!w || w.action === 'back') return undefined;
    if (w.action === 'snooze') return this.control(userId, 'snooze', w.minutes);
    // Timers stop on any stop. Alarms follow the person's choice.
    if (timersOnly || mode === 'stop') return this.control(userId, 'stop');
    if (mode === 'firm') {
      if (w.action === 'up') return this.control(userId, 'stop');
      const ids = list.filter((a) => a.kind === 'alarm').map((a) => a.id);
      const r = this.control(userId, 'snooze');
      this.firmSnooze.set(userId, { at: this.now(), ids });
      return { done: true, say: `${r.say} Say "I'm up" to turn it off.` };
    }
    // Math: a sum to answer first.
    const q = mathQuestion(this.now());
    if (s) s.math = q;
    return { done: true, say: q.q };
  }

  /** The question waiting in math mode, if any. */
  mathFor(userId: UserId): string | undefined {
    return this.sessions.get(userId)?.math?.q;
  }
}

function clampInt(v: number | undefined, [lo, hi]: readonly [number, number], dflt: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function mathQuestion(seed: number): { q: string; answer: number } {
  // Not random-random: tests can predict it from the clock.
  const a = 3 + (Math.floor(seed / 1000) % 7);
  const b = 4 + (Math.floor(seed / 7000) % 6);
  return { q: `What's ${a} plus ${b}?`, answer: a + b };
}

export function timerName(a: Alarm): string {
  const l = a.label.replace(/\s*timer$/i, '').trim();
  if (l) return `${l} timer`;
  return a.durationMs ? `${spokenDuration(a.durationMs)} timer` : 'timer';
}

function offLine(list: Alarm[], now: number, next: (a: Alarm) => string): string {
  if (list.every((a) => a.kind === 'timer')) return list.length > 1 ? 'Timers stopped.' : 'Timer stopped.';
  const a = list.find((x) => x.kind === 'alarm')!;
  const n = next(a).replace(/^ It rings next /, ' Next one is ').replace(/\.$/, '.');
  return `Alarm off.${n}`;
}

function isAlarm(a: unknown): a is Alarm {
  const x = a as Alarm;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.userId === 'string' &&
    typeof x.speaker === 'string' &&
    (x.kind === 'alarm' || x.kind === 'timer') &&
    typeof x.label === 'string' &&
    typeof x.at === 'number' &&
    Number.isFinite(x.at) &&
    typeof x.base === 'number' &&
    typeof x.tz === 'string' &&
    typeof x.enabled === 'boolean' &&
    (x.days === undefined || (Array.isArray(x.days) && x.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) &&
    (x.time === undefined || /^\d{2}:\d{2}$/.test(x.time)) &&
    (x.sound === undefined || typeof x.sound === 'string') &&
    (x.skip === undefined || (Array.isArray(x.skip) && x.skip.every((d) => typeof d === 'string')))
  );
}

function isSaved(s: unknown): s is SavedSound {
  const x = s as SavedSound;
  return !!x && typeof x.name === 'string' && typeof x.owner === 'string' && typeof x.file === 'string' && /^[\w.-]+$/.test(x.file) && typeof x.seconds === 'number';
}

/** Is this a sound name we can ring? */
export function soundKind(name: string): 'tone' | 'voice' | 'clip' | 'music' | undefined {
  if (isTone(name)) return 'tone';
  if (name === 'voice') return 'voice';
  if (name.startsWith('clip:')) return 'clip';
  if (name.startsWith('music:') && name.length > 6) return 'music';
  return undefined;
}
