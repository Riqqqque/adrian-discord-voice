// The sound of a ringing alarm in one room (her call or a PC): a tone, a saved
// clip or music, with her voice saying the time now and then.

import type { PlaybackHandle, UserId } from '../core/interfaces.js';
import type { Mixer } from '../voice/mixer.js';
import { DEFAULT_TONE, ringStream, tonePattern } from '../features/alarm-tones.js';
import { type Alarm, type RingHandle, type RingPlan, clockText, ringWord, soundKind, timerName } from '../features/alarms.js';
import { spokenDuration } from '../features/reminders.js';

/** Seconds of quiet after each repeat of a tone. */
const GAPS: Record<string, number> = { classic: 0.6, digital: 0.35, chime: 1.0, bells: 0.9, marimba: 0.8, gentle: 0.4, birds: 1.4, pulse: 0.5, buzzer: 0.45 };

export interface RingRoom {
  key: string;
  mixer: Mixer;
  music?: { playNamed(q: string, mode: 'now' | 'queue', signal: AbortSignal): Promise<{ ok: boolean }>; stop(): unknown; readonly nowPlaying: unknown; readonly paused: boolean } | undefined;
}

export interface RingerDeps {
  soundOf(a: Alarm): string;
  /** A saved clip's sound, if its file is there. */
  clip(userId: UserId, name: string): Float32Array | undefined;
  /** Say a line in that room, over the alarm (which turns down for it). */
  speak(room: RingRoom, text: string, signal: AbortSignal): Promise<unknown>;
  name(userId: UserId): string;
  log(event: string, fields: Record<string, unknown>): void;
  /** The volume her speech plays at, so alarms sit at the same level. */
  level: number;
}

/** What she says while it rings. */
export function ringLine(alarms: Alarm[], opts: { name?: string; now: number; lateMs?: number }): string {
  const parts: string[] = [];
  const alarm = alarms.find((a) => a.kind === 'alarm');
  if (alarm) {
    const labels = alarms.filter((a) => a.kind === 'alarm' && a.label).map((a) => a.label);
    parts.push(`It's ${clockText(opts.now, alarm.tz)}.`);
    // A label that is itself an order ("stop", "snooze") is never said bare: her own voice
    // coming back through a PC mic must not turn the alarm off.
    if (labels.length) parts.push(`${labels.map((l) => (ringWord(l) ? `Your ${l} alarm` : l.charAt(0).toUpperCase() + l.slice(1))).join('. ')}.`);
  }
  const timers = alarms.filter((a) => a.kind === 'timer');
  if (timers.length) parts.push(`Your ${timers.map(timerName).join(' and ')} ${timers.length > 1 ? 'are' : 'is'} done.`);
  if (opts.lateMs && opts.lateMs > 90_000) parts.push(`Sorry, this is ${spokenDuration(opts.lateMs)} late; I was offline.`);
  const line = parts.join(' ');
  return opts.name ? `${opts.name}, ${line.charAt(0).toLowerCase()}${line.slice(1)}` : line;
}

function toneFor(sound: string, d: RingerDeps, userId: UserId): { pattern: Float32Array; gap: number } {
  const kind = soundKind(sound);
  if (kind === 'clip') {
    const p = d.clip(userId, sound.slice(5));
    if (p) return { pattern: p, gap: 1 };
    d.log('alarm clip missing; using the classic tone', { user: userId, sound });
  }
  const name = kind === 'tone' ? sound : sound === 'voice' ? 'chime' : DEFAULT_TONE;
  return { pattern: tonePattern(name), gap: sound === 'voice' ? 6 : (GAPS[name] ?? 0.8) };
}

/** Start ringing in `room`. `named`: say their name first (a call, not their own PC). */
export function ringIn(room: RingRoom, plan: RingPlan, d: RingerDeps, named: boolean): RingHandle {
  const ac = new AbortController();
  const list = plan.alarms();
  const lead = list[0]!;
  const sound = d.soundOf(lead);
  const timersOnly = list.every((a) => a.kind === 'timer');
  const volume = Math.max(0.1, Math.min(1, plan.prefs.volume)) * Math.min(1, Math.max(0.5, d.level + 0.2));
  const fadeIn = timersOnly ? 0 : plan.fresh ? plan.prefs.fadeIn : 5;
  let tone: PlaybackHandle | undefined;
  let toneEnded = false;
  let music = false;

  const startTone = (name = sound, level = 0.3) => {
    tone?.stop();
    const t = toneFor(name, d, plan.userId);
    const h = room.mixer.playAlarm(ringStream({ pattern: t.pattern, gap: t.gap, fadeIn, startLevel: level }), volume);
    tone = h;
    toneEnded = false;
    void h.done.then(() => {
      if (tone === h && !ac.signal.aborted) toneEnded = true;
    });
  };

  if (soundKind(sound) === 'music' && room.music) {
    // The tone rings softly while the music is looked up, and comes back if it fails or ends.
    startTone(DEFAULT_TONE, 0.15);
    const q = sound.slice(6);
    void room.music
      .playNamed(q, 'now', ac.signal)
      .then((r) => {
        if (ac.signal.aborted) {
          if (r.ok) room.music?.stop();
          return;
        }
        if (!r.ok) {
          d.log('alarm music failed; ringing a tone', { user: plan.userId, query: q });
          return;
        }
        music = true;
        tone?.stop();
        tone = undefined;
        const watch = setInterval(() => {
          if (ac.signal.aborted) return clearInterval(watch);
          // Ended, or someone paused it: the tone takes over, so the alarm never goes quiet.
          if (!room.music?.nowPlaying || room.music.paused) {
            clearInterval(watch);
            music = false;
            startTone(DEFAULT_TONE, 0.6);
          }
        }, 2_000);
        watch.unref?.();
      })
      .catch(() => undefined);
  } else startTone(soundKind(sound) === 'music' ? DEFAULT_TONE : sound);

  // Her voice: the time and what it's for, a moment in, then every minute
  // (every 20 s when the sound is her voice).
  if (plan.prefs.voice || sound === 'voice') {
    const every = sound === 'voice' ? 20_000 : 60_000;
    let first = true;
    const say = () => {
      if (ac.signal.aborted) return;
      const now = Date.now();
      const line = ringLine(plan.alarms(), { ...(named ? { name: d.name(plan.userId) } : {}), now, ...(first ? { lateMs: plan.lateMs } : {}) });
      first = false;
      if (line) void d.speak(room, line, ac.signal).catch(() => undefined);
    };
    const t1 = setTimeout(say, timersOnly ? 1_500 : 3_000);
    const t2 = setInterval(say, every);
    t1.unref?.();
    t2.unref?.();
    ac.signal.addEventListener('abort', () => {
      clearTimeout(t1);
      clearInterval(t2);
    });
  }

  return {
    stop: () => {
      if (ac.signal.aborted) return;
      ac.abort();
      tone?.stop();
      if (music) room.music?.stop();
    },
    alive: () => !ac.signal.aborted && (music ? true : !!tone && !toneEnded),
  };
}

/** A few seconds of a sound, for "let me hear it". */
export function previewIn(room: RingRoom, sound: string, d: RingerDeps, userId: UserId, volume: number): void {
  const t = toneFor(sound, d, userId);
  room.mixer.playAlarm(ringStream({ pattern: t.pattern, gap: Math.min(t.gap, 1), seconds: 6 }), Math.max(0.1, Math.min(1, volume)) * Math.min(1, Math.max(0.5, d.level + 0.2)));
}
