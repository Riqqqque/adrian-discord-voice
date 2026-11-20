// The model's tools for alarms and timers, and the list/cancel tools that also
// cover reminders.

import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import { asksMore, PendingYes } from '../brain/tools.js';
import { localToEpoch, spokenDuration, type Reminders } from './reminders.js';
import { TONES, isTone } from './alarm-tones.js';
import {
  type Alarm,
  type AlarmClock,
  type AlarmPrefs,
  type DismissMode,
  type SavedSound,
  clockText,
  dayText,
  daysText,
  DEFAULTS,
  LIMITS,
  localDate,
  localParts,
  nextAt,
  parseClock,
  parseDays,
  timerName,
  validZone,
} from './alarms.js';

/** Prompt line: how alarms behave, so she describes them right. */
export const ALARM_RULE =
  'Alarms and timers ring with a sound until the person says stop (or snooze); she says nothing over them. For "wake me up at", "alarm at" use set_alarm; for "in N minutes" use set_timer; for a spoken note later use set_reminder. When someone asks what alarm sounds there are, call alarm_options with action sounds and offer a few by name; to let them hear one, action preview. Never invent sounds that aren\'t listed. If they didn\'t say AM or PM and it isn\'t obvious, pick the next one and the read-back will say which.';

export interface AlarmToolDeps {
  clock: AlarmClock;
  reminders: Reminders;
  english: (userId: UserId) => boolean;
  /** Where it would ring for them right now, for the read-back. */
  reach: (userId: UserId) => 'call' | 'pc' | 'none';
  /** Play a few seconds of a sound where they asked. False: nowhere to play it. */
  preview: (ctx: ToolContext, sound: string) => Promise<boolean>;
  /** Find a clip on YouTube and keep it as a named alarm sound. */
  saveClip?: (ctx: ToolContext, query: string, name: string, signal: AbortSignal) => Promise<SavedSound | string>;
  /** Music can play (YouTube or Plex is set up). */
  musicOk: boolean;
  now?: () => number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function alarmTools(d: AlarmToolDeps): Tool[] {
  const now = d.now ?? Date.now;
  const c = d.clock;
  const yes = new PendingYes<string>(now);
  const asked = new Set<string>();
  /** What she says for a change that went through, by the result it came with:
   *  a confirmation needs no second model call. Taken once. */
  const lines = new Map<string, string>();
  const keep = (raw: string, line: string): string => {
    lines.set(raw, line);
    if (lines.size > 20) lines.delete(lines.keys().next().value!);
    return raw;
  };
  /** The line kept for this result, once, in English only (anything else the model says). */
  const lineFor = (raw: string, ctx: ToolContext): string | undefined => {
    const line = lines.get(raw);
    lines.delete(raw);
    // They also asked or ordered something else: the model answers the whole of it.
    return line && d.english(ctx.userId) && !asksMore(ctx.said) ? line : undefined;
  };
  const sentence = (parts: string[]) => `${parts.join(', ').replace(/^./, (x) => x.toUpperCase())}.`;
  /** A sound as she'd name it out loud. */
  const spokenSound = (s: string) => (s.startsWith('clip:') ? `your ${s.slice(5)} sound` : s.startsWith('music:') ? s.slice(6) : s === 'voice' ? 'my voice' : `the ${s} sound`);
  /** A time left, said to the minute once it's more than a couple. */
  const roughly = (ms: number) => spokenDuration(ms > 120_000 ? Math.round(ms / 60_000) * 60_000 : ms);

  /** A sound the person named → what's stored, or a reason. */
  const pickSound = (userId: UserId, raw: unknown, play: unknown): string | { error: string } | undefined => {
    const p = str(play);
    if (p) return d.musicOk ? `music:${p.slice(0, 120)}` : { error: "Music isn't set up here, so an alarm can't play a song. Pick a sound instead." };
    let s = str(raw).toLowerCase().replace(/\s+sound$/, '');
    if (!s || s === 'default') return undefined;
    if (/^(your|her|my|a)?\s*voice$|^you( talking)?$|^speech$/.test(s)) return 'voice';
    if (isTone(s)) return s;
    s = s.replace(/^clip:/, '');
    const saved = c.savedSound(userId, s);
    if (saved) return `clip:${saved.name}`;
    // "the rising marimba tune", "chirping birds": the one name in it.
    const named = TONES.filter((t) => new RegExp(`\\b${t.name}\\b`).test(s));
    if (named.length === 1) return named[0]!.name;
    const savedIn = c.sounds(userId).filter((x) => s.includes(x.name.toLowerCase()));
    if (savedIn.length === 1) return `clip:${savedIn[0]!.name}`;
    return { error: `There's no sound called "${s}". ${soundList(userId)}` };
  };

  const soundName = (s: string): string => (s.startsWith('clip:') ? `your "${s.slice(5)}" sound` : s.startsWith('music:') ? `"${s.slice(6)}" (music)` : s === 'voice' ? 'her voice' : s);

  const soundList = (userId: UserId): string => {
    const saved = c.sounds(userId).map((s) => s.name);
    const p = c.prefs(userId);
    return [
      `Built-in sounds: ${TONES.map((t) => `${t.name} (${t.about})`).join(', ')}.`,
      'Also: voice (she says the time and what it\'s for, between soft chimes)' + (d.musicOk ? ', any song, artist or playlist (music), or a sound found on YouTube and saved under a name (save_sound).' : '.'),
      saved.length ? `Their saved sounds: ${saved.join(', ')}.` : '',
      `Their default for alarms: ${soundName(p.sound ?? 'classic')}; for timers: ${soundName(p.timerSound ?? 'chime')}.`,
    ]
      .filter(Boolean)
      .join(' ');
  };

  const where = (userId: UserId, kind: Alarm['kind']): string => {
    const r = d.reach(userId);
    if (r !== 'none' || kind === 'timer') return '';
    return " Right now you're not in my call or at your PC, so if that's still true then, I'll message you.";
  };

  const describe = (a: Alarm): string => {
    const t = now();
    const tz = a.tz;
    const sound = soundName(c.soundOf(a));
    const state = !a.enabled ? ' (turned off)' : a.ringingSince !== undefined ? ' (ringing now)' : a.snoozed ? ` (snoozed until ${clockText(a.at, tz)})` : '';
    if (a.kind === 'timer') return `${timerName(a)}: ${spokenDuration(Math.max(0, a.at - t))} left, rings ${clockText(a.at, tz)}, sound ${sound}${state} [id ${a.id}]`;
    const when = a.days?.length ? `${clockText(a.base, tz)} ${daysText(a.days)}, next ${dayText(a.base, tz, t)}` : `${clockText(a.base, tz)} ${dayText(a.base, tz, t)}`;
    const skip = a.skip?.length ? ` (skipped on ${a.skip.map((x) => dayText(localToEpoch(`${x}T12:00`, tz) ?? t, tz, t)).join(', ')})` : '';
    return `alarm${a.label ? ` "${a.label}"` : ''} at ${when}${skip}, sound ${sound}${state} [id ${a.id}]`;
  };

  /** Exactly one of their alarms or timers, from what they said. */
  const pick = (userId: UserId, which: string, kind?: Alarm['kind']): { hit?: Alarm; many?: Alarm[] } => {
    const raw = which.trim().toLowerCase();
    const said = /\balarms?\b/.test(raw) && !/\btimers?\b/.test(raw) ? 'alarm' : /\btimers?\b/.test(raw) && !/\balarms?\b/.test(raw) ? 'timer' : undefined;
    const mine = c.forUser(userId, kind ?? said);
    const w = raw.replace(/\b(my|the|alarms?|timers?|one)\b/g, '').replace(/\s+/g, ' ').trim();
    if (!mine.length) return {};
    // "the 10 minute timer", "my 1 hour one": a timer by its length.
    const len = /^(\d+(?:\.\d+)?)\s*(sec|second|min|minute|hour|hr)s?$/.exec(w);
    if (len) {
      const ms = +len[1]! * (len[2]!.startsWith('h') ? 3_600_000 : len[2]!.startsWith('s') ? 1000 : 60_000);
      const hits = mine.filter((a) => a.kind === 'timer' && a.durationMs === ms);
      if (hits.length === 1) return { hit: hits[0]! };
      return { many: hits.length ? hits : mine };
    }
    if (!w) return mine.length === 1 ? { hit: mine[0]! } : { many: mine };
    if (w === 'next' || w === 'next one') return { hit: mine.filter((a) => a.enabled)[0] ?? mine[0]! };
    const byId = mine.find((a) => a.id === w);
    if (byId) return { hit: byId };
    const clock = parseClock(w.replace(/o ?clock/, ''));
    let hits = clock
      ? mine.filter((a) => {
          const [h, m] = clock.split(':').map(Number) as [number, number];
          // A timer by when it rings; an alarm by its set time.
          const lp = localParts(a.kind === 'timer' ? a.at : a.base, a.tz);
          const [ah, am] = a.time ? (a.time.split(':').map(Number) as [number, number]) : [lp.hh, lp.mm];
          // "7" can be 7 AM or 7 PM; "7 am" is only 7 AM.
          return am === m && (ah === h || (!/[ap]\.? ?m\b/.test(w) && ah === h + 12));
        })
      : [];
    if (!hits.length) hits = mine.filter((a) => a.label && (a.label.toLowerCase().includes(w) || w.includes(a.label.toLowerCase())));
    if (hits.length === 1) return { hit: hits[0]! };
    return { many: hits.length ? hits : mine };
  };

  const choose = (many: Alarm[] | undefined, what: string) =>
    many?.length ? `Which one? They have: ${many.map(describe).join('; ')}.` : `They have no ${what}.`;

  const saveNote = () => (c.saveFailed ? ' (Note: saving to disk failed just now, so tell them it may not survive a restart.)' : '');

  const setAlarm: Tool = {
    spec: {
      name: 'set_alarm',
      description:
        'Set an alarm that rings with a sound until they stop it. time: clock time as "HH:MM" 24-hour in their time zone. date "YYYY-MM-DD" only for a specific day; repeat for repeating ones: "daily", "weekdays", "weekends" or day names like "mon,wed,fri". With neither, it rings at the next time that comes. sound: a sound name from alarm_options (leave empty for their default); play: a song, artist or playlist to wake up to instead.',
      parameters: {
        type: 'object',
        properties: {
          time: { type: 'string' },
          date: { type: 'string' },
          repeat: { type: 'string' },
          label: { type: 'string', description: 'what it is for, e.g. "gym"; empty if none' },
          sound: { type: 'string' },
          play: { type: 'string' },
        },
        required: ['time'],
        additionalProperties: false,
      },
    },
    acts: true,
    run: async (a, _s, ctx) => {
      const time = parseClock(str(a.time));
      if (!time) return 'No clear time given; ask what time.';
      const days = parseDays(a.repeat);
      if (days === null) return `Didn't understand the repeat "${str(a.repeat)}"; ask which days.`;
      const date = str(a.date);
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'The date must be YYYY-MM-DD.';
      const sound = pickSound(ctx.userId, a.sound, a.play);
      if (sound && typeof sound === 'object') return sound.error;
      const tz = c.zone(ctx.userId);
      const at = nextAt(time, days, tz, now(), days ? undefined : date || undefined);
      if (at === undefined) return date ? 'That time has already passed.' : 'Could not work out when that is.';
      const r = c.add({
        userId: ctx.userId,
        speaker: ctx.speaker,
        kind: 'alarm',
        label: str(a.label),
        at,
        time,
        tz,
        ...(days ? { days } : {}),
        ...(sound ? { sound } : {}),
        ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
        ...(ctx.channelId?.startsWith('sat:') ? { room: ctx.channelId } : {}),
      });
      if (typeof r === 'string') return r;
      return `Alarm set: ${describe(r)}.${where(ctx.userId, 'alarm')}${saveNote()}`;
    },
    speak: (_a, raw, ctx) => {
      if (!d.english(ctx.userId) || asksMore(ctx.said) || !raw.startsWith('Alarm set:') || raw.includes('(Note:')) return undefined;
      const r = c.forUser(ctx.userId, 'alarm').find((x) => raw.includes(`[id ${x.id}]`));
      if (!r) return undefined;
      const when = r.days?.length ? `${clockText(r.base, r.tz)} ${daysText(r.days)}` : `${clockText(r.base, r.tz)} ${dayText(r.base, r.tz, now())}`;
      return `Alarm set for ${when}.${where(ctx.userId, 'alarm')}`;
    },
  };

  const setTimer: Tool = {
    spec: {
      name: 'set_timer',
      description: 'Start a countdown timer that rings until they stop it. Give the duration; label is what it is for. sound: a sound name from alarm_options, empty for their default.',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'number' },
          minutes: { type: 'number' },
          seconds: { type: 'number' },
          label: { type: 'string', description: 'e.g. "pizza"; empty if none' },
          sound: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    acts: true,
    run: async (a, _s, ctx) => {
      const ms = Math.round((num(a.hours) * 3600 + num(a.minutes) * 60 + num(a.seconds)) * 1000);
      if (ms < 1000) return 'No duration given; ask how long.';
      if (ms > LIMITS.timerMaxMs) return 'Timers go up to 7 days; use an alarm for longer.';
      const sound = pickSound(ctx.userId, a.sound, undefined);
      if (sound && typeof sound === 'object') return sound.error;
      const r = c.add({
        userId: ctx.userId,
        speaker: ctx.speaker,
        kind: 'timer',
        label: str(a.label),
        at: now() + ms,
        durationMs: ms,
        tz: c.zone(ctx.userId),
        ...(sound ? { sound } : {}),
        ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
        ...(ctx.channelId?.startsWith('sat:') ? { room: ctx.channelId } : {}),
      });
      if (typeof r === 'string') return r;
      return `Timer set: ${describe(r)}.${saveNote()}`;
    },
    speak: (a, raw, ctx) => {
      if (!d.english(ctx.userId) || asksMore(ctx.said) || !raw.startsWith('Timer set:') || raw.includes('(Note:')) return undefined;
      const ms = Math.round((num(a.hours) * 3600 + num(a.minutes) * 60 + num(a.seconds)) * 1000);
      return `Timer set for ${spokenDuration(ms)}.`;
    },
  };

  const editAlarm: Tool = {
    spec: {
      name: 'edit_alarm',
      description:
        'Change one of their alarms or timers. which: its time ("7:00"), label, or "next". Only give what changes: time ("HH:MM"), date ("YYYY-MM-DD", to move a one-off to another day), repeat ("daily", "weekdays", "once", day names), label, sound, play (music instead), on (false turns it off without deleting, true back on), skip_next (true skips only the next time it rings; false un-skips), skip_date ("YYYY-MM-DD": it stays quiet that one day, e.g. tomorrow), snooze_minutes, add_minutes (timers).',
      parameters: {
        type: 'object',
        properties: {
          which: { type: 'string' },
          time: { type: 'string' },
          repeat: { type: 'string' },
          label: { type: 'string' },
          sound: { type: 'string' },
          play: { type: 'string' },
          date: { type: 'string' },
          on: { type: 'boolean' },
          skip_next: { type: 'boolean' },
          skip_date: { type: 'string' },
          snooze_minutes: { type: 'number' },
          add_minutes: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    acts: true,
    speak: (_a, raw, ctx) => lineFor(raw, ctx),
    run: async (a, _s, ctx) => {
      const { hit, many } = pick(ctx.userId, str(a.which));
      if (!hit) return choose(many, 'alarms or timers');
      const t = now();
      const said: string[] = [];
      // The same, as she says it to them.
      const spoken: string[] = [];
      // Moving one that rings now: it stops ringing and keeps its new time.
      if (hit.ringingSince !== undefined && (str(a.time) || a.repeat !== undefined || typeof a.add_minutes === 'number')) c.unring(hit);
      if (typeof a.add_minutes === 'number' && a.add_minutes !== 0) {
        if (hit.kind !== 'timer') return 'add_minutes is for timers; change an alarm with time.';
        hit.at = Math.max(t + 1000, hit.at + a.add_minutes * 60_000);
        hit.base = hit.at;
        hit.durationMs = (hit.durationMs ?? 0) + a.add_minutes * 60_000;
        said.push(`${spokenDuration(hit.at - t)} left`);
        spoken.push(`${roughly(hit.at - t)} left on ${hit.label ? `the ${hit.label} timer` : 'it'}`);
      }
      if (hit.kind === 'alarm') {
        let time = hit.time;
        let days = hit.days;
        if (str(a.time)) {
          const p = parseClock(str(a.time));
          if (!p) return 'No clear time given.';
          time = p;
        }
        if (a.repeat !== undefined) {
          const p = parseDays(a.repeat);
          if (p === null) return `Didn't understand the repeat "${str(a.repeat)}".`;
          days = p;
        }
        // A one-off keeps its day ("make it 9:30" for tomorrow's), unless a new date is given.
        const date = str(a.date);
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'The date must be YYYY-MM-DD.';
        if (time !== hit.time || days !== hit.days || date) {
          const keep = !days?.length ? date || localDate(hit.base, hit.tz) : undefined;
          let at = nextAt(time!, days, hit.tz, t, keep);
          if (at === undefined && keep && !date) at = nextAt(time!, days, hit.tz, t);
          if (at === undefined && date) return 'That time has already passed.';
          if (at === undefined) return 'Could not work out when that is.';
          if (time) hit.time = time;
          if (days) hit.days = days;
          else delete hit.days;
          hit.at = hit.base = at;
          delete hit.snoozed;
          delete hit.skip;
          said.push(`set for ${clockText(at, hit.tz)} ${days?.length ? daysText(days) : dayText(at, hit.tz, t)}`);
          spoken.push(`it's set for ${clockText(at, hit.tz)} ${days?.length ? daysText(days) : dayText(at, hit.tz, t)}`);
        }
        const skipDay = a.skip_next === true ? localDate(hit.base, hit.tz) : str(a.skip_date);
        if (skipDay) {
          if (!hit.days?.length) return 'That alarm only rings once; turn it off or delete it instead.';
          if (!/^\d{4}-\d{2}-\d{2}$/.test(skipDay)) return 'skip_date must be YYYY-MM-DD.';
          const that = localToEpoch(`${skipDay}T${hit.time}`, hit.tz);
          if (that === undefined || !hit.days.includes(new Date(`${skipDay}T12:00:00Z`).getUTCDay())) return `It doesn't ring that day; it rings ${daysText(hit.days)}.`;
          if (that < t && skipDay !== localDate(hit.base, hit.tz)) return 'That day is already over.';
          hit.skip = [...new Set([...(hit.skip ?? []), skipDay])].sort();
          // The next one it really rings.
          let after = hit.base;
          for (let i = 0; i < 14 && hit.skip.includes(localDate(after, hit.tz)); i++) after = nextAt(hit.time!, hit.days, hit.tz, after) ?? after;
          said.push(`it won't ring ${dayText(that, hit.tz, t)}; next it rings ${dayText(after, hit.tz, t)} at ${clockText(after, hit.tz)}`);
          spoken.push(`it won't ring ${dayText(that, hit.tz, t)}, next it rings ${dayText(after, hit.tz, t)} at ${clockText(after, hit.tz)}`);
        } else if (a.skip_next === false && hit.skip?.length) {
          delete hit.skip;
          said.push('nothing skipped any more');
          spoken.push("it's not skipping any days now");
        }
      }
      // An empty label or sound is the model filling in a field, not a change.
      if (str(a.label) && str(a.label).slice(0, 80) !== (hit.label ?? '')) {
        hit.label = str(a.label).slice(0, 80);
        said.push(`label "${hit.label}"`);
        spoken.push(`it's called ${hit.label} now`);
      }
      if (str(a.sound) || str(a.play)) {
        const s = pickSound(ctx.userId, a.sound, a.play);
        if (s && typeof s === 'object') return s.error;
        if (s) hit.sound = s;
        else delete hit.sound;
        said.push(`sound ${soundName(c.soundOf(hit))}`);
        spoken.push(`it'll ring with ${spokenSound(c.soundOf(hit))}`);
      }
      if (typeof a.snooze_minutes === 'number') {
        hit.snoozeMin = Math.max(LIMITS.snoozeMin[0], Math.min(LIMITS.snoozeMin[1], Math.round(a.snooze_minutes)));
        said.push(`snooze ${hit.snoozeMin} minutes`);
        spoken.push(`its snooze is ${hit.snoozeMin} minutes`);
      }
      if (a.on === false && hit.enabled) {
        if (hit.ringingSince !== undefined) return "That one is ringing right now. Tell them to say stop or snooze; it can be turned off after that.";
        hit.enabled = false;
        said.push('turned off');
        spoken.push('turned it off');
      } else if (a.on === true && !hit.enabled) {
        hit.enabled = true;
        if (hit.kind === 'alarm' && hit.time && !(hit.at > t)) hit.at = hit.base = nextAt(hit.time, hit.days, hit.tz, t) ?? hit.at;
        said.push(`back on, next ${dayText(hit.base, hit.tz, t)} at ${clockText(hit.base, hit.tz)}`);
        spoken.push(`it's back on, next ${dayText(hit.base, hit.tz, t)} at ${clockText(hit.base, hit.tz)}`);
      }
      c.update(hit);
      const raw = `Changed: ${said.join(', ') || 'nothing'}. Now: ${describe(hit)}.${saveNote()}`;
      // A change that saved says itself; nothing changed, or a failed save, is the model's to explain.
      return spoken.length && !c.saveFailed ? keep(raw, sentence(spoken)) : raw;
    },
  };

  const list: Tool = {
    spec: {
      name: 'list_timers',
      description: "List the asking person's alarms, timers and reminders.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: async (_a, _s, ctx) => {
      const alarms = c.forUser(ctx.userId).map(describe);
      const rem = d.reminders.forUser(ctx.userId).map((r) => d.reminders.describe(r));
      const all = [...alarms, ...rem];
      return all.length ? all.join('\n') : 'No alarms, timers or reminders.';
    },
  };

  const cancel: Tool = {
    spec: {
      name: 'cancel_timer',
      description:
        'Delete alarms, timers or reminders of the person asking: by time, what it is for, or "all". Deleting a repeating alarm or several at once asks them first; when they say yes, call it again with the same which. To stop one that is ringing now, use alarm_control instead.',
      parameters: {
        type: 'object',
        properties: { which: { type: 'string', description: 'e.g. "7am", "pizza", "gym", "all"; empty if they have only one' } },
        additionalProperties: false,
      },
    },
    acts: true,
    run: async (a, _s, ctx) => {
      const which = str(a.which);
      const w = which.toLowerCase();
      const alarms = c.forUser(ctx.userId);
      const rem = d.reminders.forUser(ctx.userId);
      let hitAlarms: Alarm[] = [];
      let hitRem = rem.filter(() => false);
      if (w === 'all' || w === 'everything') {
        hitAlarms = alarms;
        hitRem = rem;
      } else if (/^all (my )?alarms?$/.test(w)) hitAlarms = c.forUser(ctx.userId, 'alarm');
      else if (/^all (my )?timers?$/.test(w)) hitAlarms = c.forUser(ctx.userId, 'timer');
      else if (/^all (my )?reminders?$/.test(w)) hitRem = rem;
      else {
        const p = pick(ctx.userId, which);
        if (p.hit) hitAlarms = [p.hit];
        const rmatch = w ? rem.filter((r) => r.text.toLowerCase().includes(w) || r.id === w) : rem.length === 1 && !alarms.length ? rem : [];
        if (!p.hit && rmatch.length) hitRem = rmatch;
        if (!p.hit && !rmatch.length) {
          if (!alarms.length && !rem.length) return 'They have no alarms, timers or reminders.';
          return `Which one? They have: ${[...alarms.map(describe), ...rem.map((r) => d.reminders.describe(r))].join('; ')}.`;
        }
      }
      if (!hitAlarms.length && !hitRem.length) return 'Nothing matched.';
      if (hitAlarms.some((x) => x.ringingSince !== undefined))
        return "That one is ringing right now. Tell them to say stop or snooze; it can be deleted after that.";
      const key = [...hitAlarms.map((x) => x.id), ...hitRem.map((r) => r.id)].sort().join(',');
      const risky = hitAlarms.length + hitRem.length > 1 || hitAlarms.some((x) => x.kind === 'alarm' && x.days?.length);
      if (risky && yes.take(ctx) !== key) {
        if (!yes.hold(ctx, key, ['delete', 'it', 'them', 'all', 'that'], 3000)) return 'A question is already waiting for their answer.';
        const what =
          hitAlarms.length + hitRem.length > 1
            ? `all ${hitAlarms.length + hitRem.length} of them`
            : `your ${clockText(hitAlarms[0]!.base, hitAlarms[0]!.tz)} alarm ${daysText(hitAlarms[0]!.days)}`;
        const q = `Delete ${what}?`;
        asked.add(q);
        return q;
      }
      c.remove(hitAlarms.map((x) => x.id));
      for (const r of hitRem) d.reminders.cancel(ctx.userId, r.id);
      const names = [...hitAlarms.map((x) => (x.kind === 'timer' ? timerName(x) : `${clockText(x.base, x.tz)} alarm`)), ...hitRem.map((r) => `reminder "${r.text}"`)];
      return `Deleted: ${names.join(', ')}.`;
    },
    asks: (r) => asked.has(r),
    speak: (_a, raw, ctx) => (asked.has(raw) ? raw : d.english(ctx.userId) && raw.startsWith('Deleted:') ? (raw.includes(',') ? 'Deleted them.' : raw.replace(/^Deleted: /, 'Deleted your ').replace(/reminder "(.*)"/, '$1 reminder')) : undefined),
  };

  const control: Tool = {
    spec: {
      name: 'alarm_control',
      description: 'Stop or snooze the alarm or timer ringing for the person asking right now. minutes: snooze length if they said one.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['stop', 'snooze'] }, minutes: { type: 'number' } },
        required: ['action'],
        additionalProperties: false,
      },
    },
    acts: true,
    run: async (a, _s, ctx) => {
      if (a.action === 'snooze') return c.control(ctx.userId, 'snooze', typeof a.minutes === 'number' ? a.minutes : undefined).say;
      if (!c.ringingFor(ctx.userId).length) return c.control(ctx.userId, 'stop').say;
      // Typed (a DM, a channel) is a deliberate stop; spoken goes through their dismiss setting.
      if (ctx.text) return c.control(ctx.userId, 'stop').say;
      return (c.heard(ctx.userId, ctx.said ?? '') ?? c.heard(ctx.userId, 'stop'))?.say ?? 'Nothing is ringing.';
    },
    speak: (_a, raw, ctx) => (d.english(ctx.userId) ? raw : undefined),
  };

  const options: Tool = {
    spec: {
      name: 'alarm_options',
      description:
        'Alarm sounds and settings. action: "sounds" lists the sounds and their defaults; "preview" plays a few seconds of sound; "save_sound" finds query on YouTube and keeps it as an alarm sound called name; "delete_sound" removes a saved one; "settings" shows their settings; "set" changes any of: default_sound, timer_sound, snooze_minutes, ring_minutes (how long one ring lasts), fade_in_seconds (0 = full volume at once), volume (10-100), dismiss ("stop": saying stop turns it off; "firm": saying stop just snoozes it and only "I\'m up" turns it off, snooze still works; "math": answer a sum first), voice (she says the time while it rings), timezone (IANA, e.g. "America/New_York").',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['sounds', 'preview', 'save_sound', 'delete_sound', 'settings', 'set'] },
          sound: { type: 'string' },
          query: { type: 'string' },
          name: { type: 'string' },
          default_sound: { type: 'string' },
          timer_sound: { type: 'string' },
          snooze_minutes: { type: 'number' },
          ring_minutes: { type: 'number' },
          fade_in_seconds: { type: 'number' },
          volume: { type: 'number' },
          dismiss: { type: 'string', enum: ['stop', 'firm', 'math'] },
          voice: { type: 'boolean' },
          timezone: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    timeoutMs: 40_000,
    slow: true,
    acts: (a) => a.action !== 'sounds' && a.action !== 'settings',
    run: async (a, signal, ctx) => {
      const u = ctx.userId;
      switch (a.action) {
        case 'sounds':
          return soundList(u);
        case 'preview': {
          const s = pickSound(u, a.sound || 'classic', undefined);
          if (s && typeof s === 'object') return s.error;
          return (await d.preview(ctx, s ?? 'classic')) ? `Playing a few seconds of ${soundName(s ?? 'classic')}.` : 'Previews play in my voice call or at their PC; they are in neither.';
        }
        case 'save_sound': {
          const q = str(a.query);
          const name = str(a.name).toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 30).trim() || q.toLowerCase().slice(0, 30);
          if (!q) return 'Ask what sound to look for.';
          if (isTone(name) || name === 'voice' || name === 'default') return `"${name}" is taken by a built-in sound; pick another name.`;
          if (!d.saveClip) return "Saving sounds from YouTube isn't set up here.";
          if (c.sounds(u).length >= 10 && !c.savedSound(u, name)) return 'They have 10 saved sounds; delete one first.';
          const r = await d.saveClip(ctx, q, name, signal);
          if (typeof r === 'string') return r;
          return keep(`Saved "${r.name}" (${Math.round(r.seconds)} seconds, from "${r.title ?? q}"). It can be used as sound "${r.name}".`, `Saved it as your ${r.name} sound.`);
        }
        case 'delete_sound': {
          const s = c.removeSound(u, str(a.name) || str(a.sound));
          return s ? keep(`Deleted the "${s.name}" sound; alarms that used it are back on their default.`, `Deleted your ${s.name} sound.`) : `No saved sound called that. ${soundList(u)}`;
        }
        case 'settings':
          return settingsText(c.prefs(u), u);
        case 'set': {
          const change: AlarmPrefs = {};
          for (const [k, key] of [
            ['default_sound', 'sound'],
            ['timer_sound', 'timerSound'],
          ] as const) {
            // Empty is the model filling in a field; "default" puts the default back.
            if (!str(a[k])) continue;
            const s = pickSound(u, a[k], undefined);
            if (s && typeof s === 'object') return s.error;
            change[key] = s;
          }
          const clamp = (v: unknown, [lo, hi]: readonly [number, number]) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : undefined);
          if (a.snooze_minutes !== undefined) change.snoozeMin = clamp(a.snooze_minutes, LIMITS.snoozeMin);
          if (a.ring_minutes !== undefined) change.ringMin = clamp(a.ring_minutes, LIMITS.ringMin);
          if (a.fade_in_seconds !== undefined) change.fadeIn = clamp(a.fade_in_seconds, LIMITS.fadeIn);
          if (a.volume !== undefined) {
            const v = typeof a.volume === 'number' ? (a.volume > 1 ? a.volume / 100 : a.volume) : NaN;
            change.volume = Number.isFinite(v) ? Math.max(0.1, Math.min(1, v)) : undefined;
          }
          if (a.dismiss === 'stop' || a.dismiss === 'firm' || a.dismiss === 'math') change.dismiss = a.dismiss as DismissMode;
          if (typeof a.voice === 'boolean') change.voice = a.voice;
          if (str(a.timezone)) {
            const tz = str(a.timezone);
            if (!validZone(tz)) return `"${tz}" isn't a time zone name; use one like America/Chicago.`;
            change.timezone = tz;
          }
          if (!Object.keys(change).length) return `Nothing to change. ${settingsText(c.prefs(u), u)}`;
          c.setPrefs(u, change);
          const raw = `Saved. ${settingsText(c.prefs(u), u)}${change.timezone ? ' Alarms already set keep the time zone they were set in.' : ''}`;
          // What they now have, read from what was stored (a 90 minute snooze is kept at the most there is).
          const p = c.prefs(u);
          const parts = (Object.keys(change) as (keyof AlarmPrefs)[]).flatMap((k): string[] => {
            if (change[k] === undefined && k !== 'sound' && k !== 'timerSound') return [];
            switch (k) {
              case 'sound':
                return [`alarms ring with ${spokenSound(p.sound ?? 'classic')}`];
              case 'timerSound':
                return [`timers ring with ${spokenSound(p.timerSound ?? 'chime')}`];
              case 'snoozeMin':
                return [`snooze is ${p.snoozeMin} minutes`];
              case 'ringMin':
                return [`each ring lasts ${p.ringMin} minutes`];
              case 'fadeIn':
                return [p.fadeIn ? `they fade in over ${p.fadeIn} seconds` : 'they start at full volume'];
              case 'volume':
                return [`alarm volume is ${Math.round(p.volume * 100)} percent`];
              case 'dismiss':
                return [p.dismiss === 'firm' ? 'only "I\'m up" turns them off now, stop just snoozes' : p.dismiss === 'math' ? "you'll answer a sum to turn them off" : 'saying stop turns them off'];
              case 'voice':
                return [p.voice ? "I'll say the time while they ring" : "I won't talk while they ring"];
              case 'timezone':
                return [`your time zone is ${c.zone(u)}, and alarms already set keep theirs`];
              default:
                return [];
            }
          });
          return parts.length && !c.saveFailed ? keep(raw, sentence(parts)) : raw;
        }
        default:
          return 'Unknown action.';
      }
    },
    speak: (a, raw, ctx) => (a.action === 'preview' && raw.startsWith('Playing') ? '' : lineFor(raw, ctx)),
  };

  const settingsText = (p: AlarmPrefs & typeof DEFAULTS, u: UserId) =>
    `Settings: alarm sound ${soundName(p.sound ?? 'classic')}, timer sound ${soundName(p.timerSound ?? 'chime')}, snooze ${p.snoozeMin} minutes, each ring lasts ${p.ringMin} minutes (timers ${p.timerRingMin}) and an unanswered alarm rings ${LIMITS.rounds} times, fades in over ${p.fadeIn} seconds, volume ${Math.round(p.volume * 100)}%, turn off by ${p.dismiss === 'stop' ? 'saying stop' : p.dismiss === 'firm' ? 'saying "I\'m up" only (stop and snooze both snooze it)' : 'answering a sum'}, her voice ${p.voice ? 'on' : 'off'}, time zone ${c.zone(u)}.`;

  return [setAlarm, setTimer, editAlarm, list, cancel, control, options];
}
