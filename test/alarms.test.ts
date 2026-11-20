import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AlarmClock, type AlarmDeps, backWord, firstNumber, nextAt, parseClock, parseDays, type RingHandle, type RingPlan, ringWord } from '../src/features/alarms.js';
import { alarmTools } from '../src/features/alarm-tools.js';
import { Reminders } from '../src/features/reminders.js';
import { ringStream, TONES, tonePattern } from '../src/features/alarm-tones.js';
import { ringLine } from '../src/app/alarm-ring.js';
import { alarmState } from '../src/app/alarm-commands.js';
import { FRAME_BYTES, Mixer } from '../src/voice/mixer.js';

const TZ = 'America/Boise';
const ctx = { userId: 'u1', speaker: 'Sean', turn: 1 };
const sig = () => AbortSignal.timeout(2000);

/** A clock, a fake world, and the alarm tools on top. */
function rig(opts: { place?: string | undefined; file?: string; start?: number } = {}) {
  let now = opts.start ?? Date.UTC(2026, 10, 18, 20, 0); // Wed Nov 18 2026, 1 PM in Chicago
  const rings: { place: string; plan: RingPlan; handle: RingHandle & { stopped: boolean; dead: boolean } }[] = [];
  const dms: { user: string; text: string; buttons: boolean }[] = [];
  const logs: string[] = [];
  let place: string | undefined = 'place' in opts ? opts.place : 'discord';
  const deps: AlarmDeps = {
    placeFor: () => place,
    ring: (p, plan) => {
      const h = { stopped: false, dead: false, stop() { this.stopped = true; }, alive() { return !this.stopped && !this.dead; } };
      rings.push({ place: p, plan, handle: h });
      return h;
    },
    dm: async (user, text, b) => (dms.push({ user, text, buttons: !!b }), true),
    log: (e) => void logs.push(e),
  };
  const clock = new AlarmClock(opts.file, TZ, deps, () => now);
  const reminders = new Reminders(undefined, TZ, () => {}, () => now);
  const previews: string[] = [];
  const tools = alarmTools({ clock, reminders, english: () => true, reach: () => (place ? 'call' : 'none'), preview: async (_c, s) => (previews.push(s), true), musicOk: true, now: () => now });
  const tool = (n: string) => tools.find((t) => t.spec.name === n)!;
  const call = async (n: string, a: Record<string, unknown>, c: Record<string, unknown> = {}) => {
    const t = tool(n);
    const raw = (await t.run(a, sig(), { ...ctx, ...c })) as string;
    return { raw, said: t.speak?.(a, raw, { ...ctx, ...c }) };
  };
  return {
    clock,
    reminders,
    rings,
    dms,
    logs,
    previews,
    call,
    tool,
    now: () => now,
    advance(ms: number) {
      now += ms;
      clock.tick();
    },
    setPlace(p: string | undefined) {
      place = p;
    },
  };
}

describe('alarm words', () => {
  it('reads clock times and repeats', () => {
    expect(parseClock('7')).toBe('07:00');
    expect(parseClock('7:30 pm')).toBe('19:30');
    expect(parseClock('12am')).toBe('00:00');
    expect(parseClock('12:15 p.m.')).toBe('12:15');
    expect(parseClock('19:05')).toBe('19:05');
    expect(parseClock('25:00')).toBeUndefined();
    expect(parseClock('13pm')).toBeUndefined();
    expect(parseDays('weekdays')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays('mon,wed,fri')).toEqual([1, 3, 5]);
    expect(parseDays(['Saturday', 'sunday'])).toEqual([0, 6]);
    expect(parseDays('daily')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseDays('once')).toBeUndefined();
    expect(parseDays('someday')).toBeNull();
  });

  it('finds the next time, across both DST changes', () => {
    // Spring forward: Sunday March 8 2026, 2 AM → 3 AM in Chicago.
    const sat = Date.UTC(2026, 2, 7, 20); // Sat 1 PM MST
    const sun7 = nextAt('07:00', undefined, TZ, Date.UTC(2026, 2, 8, 12))!;
    expect(new Date(sun7).toISOString()).toBe('2026-03-08T13:00:00.000Z'); // 7 AM MDT
    expect(new Date(nextAt('07:00', [0], TZ, sat)!).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    // Fall back: Sunday Nov 1 2026, 2 AM → 1 AM.
    expect(new Date(nextAt('07:00', [0], TZ, Date.UTC(2026, 9, 31, 20))!).toISOString()).toBe('2026-11-01T14:00:00.000Z'); // 7 AM MST
    // Weekdays from a Friday evening → Monday.
    const fri = Date.UTC(2026, 10, 21, 3); // Fri Nov 20, 8 PM MST
    expect(new Date(nextAt('06:30', [1, 2, 3, 4, 5], TZ, fri)!).toISOString()).toBe('2026-11-23T13:30:00.000Z');
  });

  it('only whole utterances stop or snooze', () => {
    expect(ringWord('stop')).toEqual({ action: 'stop' });
    expect(ringWord('Okay, stop the alarm please.')).toEqual({ action: 'stop' });
    expect(ringWord("I'm up")).toEqual({ action: 'up' });
    expect(ringWord('okay okay im awake')).toEqual({ action: 'up' });
    expect(ringWord('snooze')).toEqual({ action: 'snooze' });
    expect(ringWord('snooze for ten minutes')).toEqual({ action: 'snooze', minutes: 10 });
    expect(ringWord('five more minutes')).toEqual({ action: 'snooze', minutes: 5 });
    expect(ringWord('give me 15 minutes')).toEqual({ action: 'snooze', minutes: 15 });
    // Heard at the PC on 0.17.0's first live ring: the local model's slip.
    expect(ringWord('Hey Adrian, stop the t timer.')).toEqual({ action: 'stop' });
    expect(ringWord('stop the the alarm')).toEqual({ action: 'stop' });
    expect(ringWord('i am up')).toEqual({ action: 'up' });
    expect(ringWord('give me a few more minutes')).toEqual({ action: 'snooze' });
    expect(ringWord('snooze for a couple minutes')).toEqual({ action: 'snooze' });
    expect(ringWord('snooze for a bit')).toEqual({ action: 'snooze' });
    expect(ringWord('a little longer')).toEqual({ action: 'snooze' });
    expect(ringWord('snooze for banana minutes')).toBeUndefined();
    expect(ringWord('stop by the store later')).toBeUndefined();
    expect(ringWord('play stop and stare')).toBeUndefined();
    expect(ringWord("what's the weather")).toBeUndefined();
    expect(ringWord('the alarm is off in the other room')).toBeUndefined();
    expect(backWord("wait I'm not up")).toBe(true);
    expect(backWord('turn it back on')).toBe(true);
    expect(backWord('thanks')).toBe(false);
  });

  it('reads numbers in words and digits', () => {
    expect(firstNumber('fifteen')).toBe(15);
    expect(firstNumber('it is twenty two')).toBe(22);
    expect(firstNumber('12')).toBe(12);
    expect(firstNumber('a hundred and five')).toBe(105);
    expect(firstNumber('no idea')).toBeUndefined();
  });
});

describe('alarm clock', () => {
  it('sets an alarm, rings it where they are, and a stop moves a repeating one to the next day', async () => {
    const r = rig();
    const set = await r.call('set_alarm', { time: '07:00', repeat: 'weekdays', label: 'gym' });
    expect(set.said).toBe('Alarm set for 7 AM on weekdays.');
    r.advance(17 * 3_600_000); // Thu 6 AM
    expect(r.rings).toHaveLength(0);
    r.advance(3_600_000); // Thu 7 AM
    expect(r.rings).toHaveLength(1);
    expect(r.rings[0]!.place).toBe('discord');
    expect(r.rings[0]!.plan.fresh).toBe(true);
    expect(r.clock.busySoon()).toBe(true);
    const out = r.clock.heard('u1', 'stop');
    expect(out?.say).toBe('Alarm off. Next one is tomorrow, Friday at 7 AM.');
    expect(r.rings[0]!.handle.stopped).toBe(true);
    const a = r.clock.forUser('u1')[0]!;
    expect(new Date(a.at).toISOString()).toBe('2026-11-20T14:00:00.000Z');
    expect(a.ringingSince).toBeUndefined();
  });

  it('snoozes, rings again, and someone else saying stop does nothing', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '13:05' });
    r.advance(5 * 60_000);
    expect(r.rings).toHaveLength(1);
    expect(r.clock.heard('u2', 'stop')).toBeUndefined();
    expect(r.clock.heard('u1', 'snooze for 5 minutes')?.say).toBe('Snoozed until 1:10 PM.');
    r.advance(4 * 60_000);
    expect(r.rings).toHaveLength(1);
    r.advance(60_000);
    expect(r.rings).toHaveLength(2);
    r.clock.heard('u1', 'turn it off');
    expect(r.clock.forUser('u1')).toHaveLength(0); // a one-off is gone
  });

  it('an alarm nobody answers snoozes itself twice, then sends a missed message', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '13:01', repeat: 'daily' });
    r.advance(60_000);
    for (let round = 1; round <= 3; round++) {
      expect(r.rings).toHaveLength(round);
      r.advance(10 * 60_000); // the ring time runs out
      if (round < 3) r.advance(9 * 60_000); // the self-snooze
    }
    expect(r.dms.at(-1)!.text).toContain('You missed your 1:01 PM alarm');
    expect(r.dms.at(-1)!.text).toContain('rang 3 times');
    expect(r.dms.at(-1)!.text).toContain('It rings next tomorrow');
    const a = r.clock.forUser('u1')[0]!;
    expect(a.ringingSince).toBeUndefined();
    expect(a.unanswered).toBeUndefined();
  });

  it('keeps ringing through a restart, and survives a move to another place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alarms-'));
    const file = join(dir, 'alarms.json');
    const r = rig({ file });
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    expect(r.rings).toHaveLength(1);
    // The person leaves the call while it rings: it follows them to their PC.
    r.setPlace('sat:pc1');
    r.advance(1_000);
    expect(r.rings.at(-1)!.place).toBe('sat:pc1');
    expect(r.rings[0]!.handle.stopped).toBe(true);
    // The sound dies by itself (the PC dropped): rung again a few seconds later.
    r.rings.at(-1)!.handle.dead = true;
    r.advance(1_000);
    const n = r.rings.length;
    r.advance(5_000);
    expect(r.rings.length).toBe(n + 1);
    // A restart mid-ring: the new process rings it at once.
    const r2 = rig({ file, start: r.now() + 30_000 });
    r2.clock.tick();
    expect(r2.rings).toHaveLength(1);
    expect(r2.rings[0]!.plan.alarms()[0]!.ringingSince).toBeDefined();
  });

  it('one due while offline rings late within its ring time, else a message says it was missed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alarms-'));
    const file = join(dir, 'alarms.json');
    const r = rig({ file });
    await r.call('set_alarm', { time: '14:00' });
    await r.call('set_timer', { minutes: 5, label: 'tea' });
    // Back 4 minutes after the alarm: within the 10 minute ring.
    const late = rig({ file, start: Date.UTC(2026, 10, 18, 21, 4) });
    late.clock.tick();
    expect(late.rings).toHaveLength(1);
    expect(late.rings[0]!.plan.lateMs).toBeGreaterThan(200_000);
    expect(ringLine(late.rings[0]!.plan.alarms(), { now: late.now(), lateMs: late.rings[0]!.plan.lateMs })).toContain("I was offline");
    // The timer was due an hour before that: its 5 minute ring is long over.
    expect(late.dms.some((d) => d.text.includes('tea timer') && d.text.includes('offline'))).toBe(true);
    expect(late.clock.forUser('u1', 'timer')).toHaveLength(0);
  });

  it('with nowhere to ring, sends a message with buttons once per round', async () => {
    const r = rig({ place: undefined });
    const set = await r.call('set_alarm', { time: '13:30' });
    expect(set.said).toContain("I'll message you");
    r.advance(30 * 60_000);
    r.advance(1_000);
    r.advance(1_000);
    expect(r.dms.filter((d) => d.buttons)).toHaveLength(1);
    // They join the call while it's still ringing: it rings there.
    r.setPlace('discord');
    r.advance(5_000);
    expect(r.rings).toHaveLength(1);
  });

  it('firm mode: stop only snoozes; "I\'m up" turns it off', async () => {
    const r = rig();
    r.clock.setPrefs('u1', { dismiss: 'firm' });
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    expect(r.clock.heard('u1', 'stop')?.say).toBe(`Snoozed until 1:10 PM. Say "I'm up" to turn it off.`);
    r.advance(9 * 60_000);
    expect(r.clock.heard('u1', "okay I'm up")?.say).toBe('Alarm off.');
  });

  it('math mode: a sum before it goes off, and timers just stop', async () => {
    const r = rig();
    r.clock.setPrefs('u1', { dismiss: 'math' });
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    const q = r.clock.heard('u1', 'stop')!.say;
    const [, a, b] = /What's (\d+) plus (\d+)\?/.exec(q)!;
    expect(r.clock.heard('u1', 'um two')?.say).toBe(`Not quite. ${q}`);
    expect(r.clock.heard('u1', 'what time is it')).toBeUndefined(); // not for the alarm
    expect(r.clock.heard('u1', String(+a! + +b!))?.say).toBe('Alarm off.');
    await r.call('set_timer', { minutes: 1 });
    r.advance(60_000);
    expect(r.clock.heard('u1', 'stop')?.say).toBe('Timer stopped.');
  });

  it('"wait, I\'m not up" right after a stop puts it back, snoozed', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    r.clock.heard('u1', 'stop');
    expect(r.clock.forUser('u1')).toHaveLength(0);
    expect(r.clock.heard('u1', "wait I'm not up")?.say).toBe("Okay, it's back on. It rings again at 1:10 PM.");
    r.advance(9 * 60_000);
    expect(r.rings).toHaveLength(2);
    // Too late to undo after a few minutes.
    r.clock.heard('u1', 'stop');
    r.advance(4 * 60_000);
    expect(r.clock.heard('u1', 'turn it back on')).toBeUndefined();
  });

  it('several due at once ring together and one stop turns them all off', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '13:01', label: 'meds' });
    await r.call('set_timer', { minutes: 1, label: 'pasta' });
    r.advance(60_000);
    expect(r.rings).toHaveLength(1);
    expect(ringLine(r.rings[0]!.plan.alarms(), { now: r.now(), name: 'Sean' })).toBe("Sean, it's 1:01 PM. Meds. Your pasta timer is done.");
    r.clock.heard('u1', 'stop');
    expect(r.clock.forUser('u1')).toHaveLength(0);
    // A label that is an order isn't said bare: her echo mustn't stop it.
    await r.call('set_alarm', { time: '13:05', label: 'stop' });
    r.advance(4 * 60_000);
    const line = ringLine(r.clock.ringingFor('u1'), { now: r.now() });
    expect(line).toBe("It's 1:05 PM. Your stop alarm.");
    expect(ringWord(line)).toBeUndefined();
  });

  it('never starts empty over a file it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alarms-'));
    const file = join(dir, 'alarms.json');
    writeFileSync(file, '{"version":1,"alarms":[{"id":');
    const r = rig({ file });
    expect(r.logs).toContain('alarms file unreadable; moved aside');
    expect(readdirSync(dir).some((f) => f.startsWith('alarms.json.unreadable-'))).toBe(true);
    expect(existsSync(file)).toBe(false);
    // Bad records are skipped, good ones kept.
    writeFileSync(file, JSON.stringify({ version: 1, alarms: [{ id: 'x' }, { id: 'a1', userId: 'u1', speaker: 'S', kind: 'timer', label: '', at: 1, base: 1, tz: TZ, enabled: true }], prefs: {}, sounds: [] }));
    const r2 = rig({ file });
    expect(r2.clock.all()).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).alarms).toHaveLength(2); // untouched until a change
  });

  it('a PC that rang it by itself while offline settles that occurrence only', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00', repeat: 'daily' });
    const a = r.clock.forUser('u1')[0]!;
    expect(r.clock.answeredElsewhere('u1', { id: a.id, base: a.base - 86_400_000, action: 'stop', at: r.now() })).toBe(false);
    const base = a.base;
    r.advance(base - r.now() + 2 * 60_000);
    expect(r.clock.answeredElsewhere('u1', { id: a.id, base, action: 'stop', at: r.now() })).toBe(true);
    expect(r.clock.forUser('u1')[0]!.base).toBe(base + 86_400_000);
    expect(r.rings.at(-1)!.handle.stopped).toBe(true);
  });
});

describe('review fixes', () => {
  it('a snooze from a DM rings again with a new DM, not silence', async () => {
    const r = rig({ place: undefined });
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    expect(r.dms.filter((d) => d.buttons)).toHaveLength(1);
    r.clock.control('u1', 'snooze');
    r.advance(9 * 60_000);
    expect(r.dms.filter((d) => d.buttons)).toHaveLength(2);
  });

  it('moving an alarm while it rings stops the ring and keeps the new time', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    expect((await r.call('edit_alarm', { which: '1:01', time: '14:00' })).raw).toContain('set for 2 PM today');
    const a = r.clock.forUser('u1')[0]!;
    expect(a.ringingSince).toBeUndefined();
    expect(r.rings[0]!.handle.stopped).toBe(true);
    expect(new Date(a.at).toISOString()).toBe('2026-11-18T21:00:00.000Z');
  });

  it("moving a one-off's time keeps its day, and a date moves it", async () => {
    const r = rig(); // Wed 1 PM
    await r.call('set_alarm', { time: '09:00', date: '2026-11-19' });
    expect((await r.call('edit_alarm', { which: '9', time: '09:30' })).raw).toContain('set for 9:30 AM tomorrow, Thursday');
    expect((await r.call('edit_alarm', { which: '9:30', date: '2026-11-21' })).raw).toContain('set for 9:30 AM Saturday');
    // Set for later today, moved to a time already gone today: the next one comes.
    await r.call('set_alarm', { time: '15:00' });
    expect((await r.call('edit_alarm', { which: '3 pm', time: '12:00' })).raw).toContain('set for 12 PM tomorrow');
  });

  it('a skipped day is not in the PC copy', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00', repeat: 'daily' });
    expect((alarmState(r.clock, 'u1', r.now()).list as unknown[]).length).toBe(1);
    await r.call('edit_alarm', { which: '7', skip_next: true });
    expect((alarmState(r.clock, 'u1', r.now()).list as unknown[]).length).toBe(0);
  });

  it('ringing ones are never deleted or turned off through the model', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    expect((await r.call('cancel_timer', { which: '1:01' })).raw).toContain('ringing right now');
    expect((await r.call('edit_alarm', { which: '1:01', on: false })).raw).toContain('ringing right now');
    expect(r.clock.ringingFor('u1')).toHaveLength(1);
  });

  it("firm mode holds through the model too, and I'm up after the snooze turns it off", async () => {
    const r = rig();
    r.clock.setPrefs('u1', { dismiss: 'firm' });
    await r.call('set_alarm', { time: '13:01', repeat: 'daily' });
    r.advance(60_000);
    const said = (await r.call('alarm_control', { action: 'stop' }, { said: 'turn that thing off' })).raw;
    expect(said).toContain('Snoozed until');
    expect(r.clock.forUser('u1')[0]!.snoozed).toBe(true);
    expect(r.clock.heard('u1', "okay I'm up")?.say).toBe('Alarm off. Next one is tomorrow, Thursday at 1:01 PM.');
    expect(r.clock.forUser('u1')[0]!.snoozed).toBeUndefined();
    // Typed is deliberate: it stops.
    r.advance(24 * 3_600_000);
    expect((await r.call('alarm_control', { action: 'stop' }, { text: true })).raw).toContain('Alarm off');
  });

  it('math mode ignores her own words coming back', async () => {
    const r = rig();
    r.clock.setPrefs('u1', { dismiss: 'math' });
    await r.call('set_alarm', { time: '13:01' });
    r.advance(60_000);
    const q = r.clock.heard('u1', 'stop')!.say;
    expect(r.clock.heard('u1', q)).toBeUndefined();
    expect(r.clock.heard('u1', "It's 1:01 PM.")).toBeUndefined();
    expect(r.clock.ringingFor('u1')).toHaveLength(1);
  });

  it('"alarm" and "timer" pick the kind, and times compare in full', async () => {
    const r = rig(); // 1 PM
    await r.call('set_alarm', { time: '07:00' });
    await r.call('set_timer', { minutes: 30 }); // rings 1:30 PM
    expect((await r.call('edit_alarm', { which: 'next alarm', on: false })).raw).toContain('turned off');
    expect(r.clock.forUser('u1', 'timer')[0]!.enabled).toBe(true);
    expect((await r.call('cancel_timer', { which: '1 pm timer' })).raw).toMatch(/^Which one\?|Nothing matched|no alarms/);
    expect((await r.call('cancel_timer', { which: '30 minute timer' })).raw).toBe('Deleted: 30 minutes timer.');
  });

  it('a file that is there but unreadable is never saved over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alarms-'));
    const r = rig({ file: dir }); // a folder: reading it fails with EISDIR
    expect(r.logs).toContain('alarms file unreadable; not saving over it');
    return r.call('set_timer', { minutes: 5 }).then((x) => expect(x.raw).toContain('saving to disk failed'));
  });

  it('muted in her call: it rings there and the buttons come by DM', async () => {
    const dms: boolean[] = [];
    let now = Date.UTC(2026, 10, 18, 20, 0);
    const c = new AlarmClock(undefined, TZ, { placeFor: () => 'discord', needsButtons: () => true, ring: () => ({ stop() {}, alive: () => true }), dm: async (_u, _t, b) => (dms.push(!!b), true) }, () => now);
    c.add({ userId: 'u1', speaker: 'S', kind: 'timer', label: '', at: now + 30_000, tz: TZ });
    now += 60_000;
    c.tick();
    c.tick();
    expect(dms).toEqual([true]);
  });

  it('"not now" snoozes, and 2:30 on the spring-forward night rings at 3:30', () => {
    expect(ringWord('not now')).toEqual({ action: 'snooze' });
    expect(ringWord('not yet')).toEqual({ action: 'snooze' });
    expect(new Date(nextAt('02:30', undefined, TZ, Date.UTC(2027, 2, 14, 7))!).toISOString()).toBe('2027-03-14T09:30:00.000Z'); // 3:30 MDT
  });

  it("two people's alarms in one room both sound", async () => {
    let now = 0;
    const outs: Buffer[] = [];
    const m = new Mixer({ start: (st) => (st.on('data', (b: Buffer) => outs.push(b)), { done: new Promise(() => {}), stop: () => {} }), setInterval: () => 1, clearInterval: () => {} }, () => now);
    const frame = (v: number) => {
      const b = Buffer.alloc(FRAME_BYTES * 100);
      for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(v, i * 2);
      return b;
    };
    const a1 = new PassThrough();
    const a2 = new PassThrough();
    m.playAlarm(a1, 1);
    m.playAlarm(a2, 1);
    a1.write(frame(1000));
    a2.write(frame(2000));
    for (let i = 0; i < 6; i++) {
      now += 20;
      m.tick();
      await new Promise((r) => setImmediate(r));
    }
    expect(outs.at(-1)!.readInt16LE(0)).toBe(3000);
  });
});

describe('alarm tools', () => {
  it('reads back day and AM/PM, and a bare hour picks the next one', async () => {
    const r = rig(); // 1 PM
    expect((await r.call('set_alarm', { time: '7' })).said).toBe('Alarm set for 7 AM tomorrow, Thursday.');
    expect((await r.call('set_alarm', { time: '19:00' })).said).toBe('Alarm set for 7 PM today.');
    expect((await r.call('set_alarm', { time: '8:15', date: '2026-11-28' })).said).toBe('Alarm set for 8:15 AM Saturday, November 28.');
    expect((await r.call('set_timer', { minutes: 90 })).said).toBe('Timer set for 1 hour 30 minutes.');
    expect((await r.call('set_alarm', { time: 'noonish' })).raw).toContain('ask what time');
  });

  it('asks before deleting a repeating alarm or several, and the yes must be their next turn', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '06:30', repeat: 'weekdays' });
    const q = await r.call('cancel_timer', { which: '6:30' }, { turn: 1, said: 'delete my 6:30 alarm' });
    expect(q.said).toBe('Delete your 6:30 AM alarm on weekdays?');
    expect(r.tool('cancel_timer').asks!(q.raw)).toBe(true);
    const done = await r.call('cancel_timer', { which: '6:30' }, { turn: 2, said: 'yes' });
    expect(done.raw).toBe('Deleted: 6:30 AM alarm.');
    expect(r.clock.forUser('u1')).toHaveLength(0);
    // A one-off timer goes without asking.
    await r.call('set_timer', { minutes: 5, label: 'pizza' });
    expect((await r.call('cancel_timer', { which: 'pizza' }, { turn: 3 })).said).toBe('Deleted your pizza timer.');
  });

  it('never guesses which one: several matches get a question', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00' });
    await r.call('set_alarm', { time: '19:00' });
    expect((await r.call('edit_alarm', { which: '7', time: '07:30' })).raw).toMatch(/^Which one\?/);
    expect((await r.call('edit_alarm', { which: '7pm', time: '19:30' })).raw).toContain('Changed: set for 7:30 PM');
  });

  it('skips the next one, turns one off and back on, and changes its sound', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00', repeat: 'daily', label: 'work' });
    expect((await r.call('edit_alarm', { which: 'work', skip_next: true })).raw).toContain("it won't ring tomorrow, Thursday; next it rings Friday at 7 AM");
    r.advance(18 * 3_600_000 + 60_000); // Thu 7:01
    expect(r.rings).toHaveLength(0);
    r.advance(24 * 3_600_000); // Fri 7:01
    expect(r.rings).toHaveLength(1);
    r.clock.heard('u1', 'stop');
    expect((await r.call('edit_alarm', { which: 'work', on: false })).raw).toContain('turned off');
    r.advance(24 * 3_600_000);
    expect(r.rings).toHaveLength(1);
    expect((await r.call('edit_alarm', { which: 'work', on: true })).raw).toContain('back on');
    expect((await r.call('edit_alarm', { which: 'work', sound: 'birds' })).raw).toContain('sound birds');
    expect((await r.call('edit_alarm', { which: 'work', sound: 'kazoo' })).raw).toContain('no sound called "kazoo"');
    expect((await r.call('edit_alarm', { which: 'work', play: 'lofi beats' })).raw).toContain('"lofi beats" (music)');
  });

  it('skips a day by date, and refuses days it never rings', async () => {
    const r = rig(); // Wed Nov 18, 1 PM
    await r.call('set_alarm', { time: '07:00', repeat: 'weekdays' });
    expect((await r.call('edit_alarm', { which: '7', skip_date: '2026-11-20' })).raw).toContain("it won't ring Friday; next it rings tomorrow, Thursday at 7 AM");
    expect((await r.call('edit_alarm', { which: '7', skip_date: '2026-11-21' })).raw).toContain("It doesn't ring that day");
    r.advance(18 * 3_600_000 + 60_000); // Thu 7:01
    expect(r.rings).toHaveLength(1);
    r.clock.heard('u1', 'stop');
    r.advance(24 * 3_600_000); // Fri 7:01: skipped
    expect(r.rings).toHaveLength(1);
    r.advance(3 * 24 * 3_600_000); // Mon 7:01
    expect(r.rings).toHaveLength(2);
    expect(r.clock.forUser('u1')[0]!.skip).toBeUndefined();
  });

  it('takes sound names inside longer words', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00' });
    expect((await r.call('edit_alarm', { which: '7', sound: 'the rising marimba tune' })).raw).toContain('sound marimba');
    expect((await r.call('alarm_options', { action: 'preview', sound: 'chirping birds' })).said).toBe('');
    expect(r.previews).toEqual(['birds']);
  });

  it('lists the sounds and settings, previews, and validates changes', async () => {
    const r = rig();
    const list = (await r.call('alarm_options', { action: 'sounds' })).raw;
    for (const t of TONES) expect(list).toContain(t.name);
    expect((await r.call('alarm_options', { action: 'preview', sound: 'marimba' })).said).toBe('');
    expect(r.previews).toEqual(['marimba']);
    const s = (await r.call('alarm_options', { action: 'set', snooze_minutes: 500, volume: 40, dismiss: 'firm', default_sound: 'gentle', timezone: 'America/New_York' })).raw;
    expect(s).toContain('snooze 60 minutes');
    expect(s).toContain('volume 40%');
    expect(s).toContain('alarm sound gentle');
    expect(s).toContain('America/New_York');
    expect((await r.call('alarm_options', { action: 'set', timezone: 'Mars/Olympus' })).raw).toContain("isn't a time zone");
    // Their own zone is used from now on.
    expect((await r.call('set_alarm', { time: '07:00' })).said).toBe('Alarm set for 7 AM tomorrow, Thursday.');
    expect(r.clock.forUser('u1')[0]!.tz).toBe('America/New_York');
  });

  it('lists alarms, timers and reminders together', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00', label: 'gym' });
    await r.call('set_timer', { minutes: 10, label: 'pizza' });
    const out = (await r.call('list_timers', {})).raw;
    expect(out).toContain('pizza timer: 10 minutes left');
    expect(out).toContain('alarm "gym" at 7 AM tomorrow, Thursday');
  });

  it('tells the PC what is coming and what is ringing', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '13:01' });
    await r.call('set_alarm', { time: '07:00', date: '2026-12-25' });
    const s = alarmState(r.clock, 'u1', r.now());
    expect((s.list as unknown[]).length).toBe(1); // only the next 48 hours
    r.advance(60_000);
    expect((alarmState(r.clock, 'u1', r.now()).ringing as unknown[]).length).toBe(1);
  });
});

describe('alarm sounds', () => {
  it('every tone renders, loud but never clipping', () => {
    for (const t of TONES) {
      const p = tonePattern(t.name);
      let peak = 0;
      for (const v of p) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.3);
      expect(peak).toBeLessThanOrEqual(0.9); // -1 dBFS
      expect(p.length).toBeGreaterThan(10_000);
    }
  });

  it('streams on demand, rising from soft to full', async () => {
    const s = ringStream({ pattern: new Float32Array(4800).fill(0.5), fadeIn: 1, startLevel: 0.25, seconds: 2 });
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    const all = Buffer.concat(chunks);
    expect(all.length).toBe(2 * 48_000 * 4);
    const at = (sec: number) => all.readInt16LE(Math.floor(sec * 48_000) * 4);
    expect(at(0)).toBeCloseTo(0.125 * 32767, -2);
    expect(at(0.5)).toBeCloseTo(0.25 * 32767, -2); // halfway in dB
    expect(at(1.5)).toBe(Math.round(0.5 * 32767));
    expect(all.readInt16LE(4)).toBe(all.readInt16LE(6)); // stereo
  });

  it('mixer: her voice plays over a ringing alarm, which turns down for it and comes back', async () => {
    let now = 0;
    const outs: Buffer[] = [];
    const m = new Mixer({ start: (st) => (st.on('data', (b: Buffer) => outs.push(b)), { done: new Promise(() => {}), stop: () => {} }), setInterval: () => 1, clearInterval: () => {} }, () => now);
    const alarm = new PassThrough();
    const frame = (v: number, n: number) => {
      const b = Buffer.alloc(FRAME_BYTES * n);
      for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(v, i * 2);
      return b;
    };
    const h = m.playAlarm(alarm, 1);
    alarm.write(frame(4000, 400));
    const run = async (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 20;
        m.tick();
        await new Promise((r) => setImmediate(r));
      }
    };
    await run(5);
    expect(outs.at(-1)!.readInt16LE(FRAME_BYTES - 2)).toBe(4000);
    const speech = new PassThrough();
    const sp = m.playPcm(speech, { volume: 1 });
    speech.write(frame(1000, 10));
    speech.end();
    await run(4);
    expect(outs.at(-1)!.readInt16LE(FRAME_BYTES - 2)).toBe(1000 + 1000); // speech + alarm at a quarter
    await run(12);
    expect(await sp.done).toBe('finished');
    expect(outs.at(-1)!.readInt16LE(FRAME_BYTES - 2)).toBe(4000);
    h.stop();
    expect(m.alarmRinging).toBe(false);
  });
});

describe('changes that say themselves (no second model call)', () => {
  it('reads back what an edit changed, from what was stored', async () => {
    const r = rig();
    await r.call('set_timer', { minutes: 12, label: 'pizza' });
    expect((await r.call('edit_alarm', { which: 'pizza', add_minutes: 5 })).said).toBe('17 minutes left on the pizza timer.');
    await r.call('set_alarm', { time: '06:30', repeat: 'weekdays' });
    expect((await r.call('edit_alarm', { which: '6:30', time: '06:45' })).said).toBe("It's set for 6:45 AM on weekdays.");
    expect((await r.call('edit_alarm', { which: '6:45', skip_next: true })).said).toMatch(/^It won't ring tomorrow, Thursday, next it rings Friday at 6:45 AM\.$/);
    expect((await r.call('edit_alarm', { which: '6:45', sound: 'birds', snooze_minutes: 15 })).said).toBe("It'll ring with the birds sound, its snooze is 15 minutes.");
    expect((await r.call('edit_alarm', { which: '6:45', on: false })).said).toBe('Turned it off.');
  });

  it('leaves the model what it has to explain', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00' });
    await r.call('set_alarm', { time: '08:00' });
    expect((await r.call('edit_alarm', { which: '', time: '09:00' })).said).toBeUndefined(); // which one?
    expect((await r.call('edit_alarm', { which: '7', on: true })).said).toBeUndefined(); // already on: nothing changed
    expect((await r.call('edit_alarm', { which: '7', add_minutes: 5 })).said).toBeUndefined(); // timers only
    const other = await r.call('edit_alarm', { which: '7', time: '07:30' }, { userId: 'u1' });
    expect(other.said).toBeDefined();
    // Asked again with the same result: the line went with the first one.
    expect(r.tool('edit_alarm').speak?.({}, other.raw, ctx)).toBeUndefined();
  });

  it("doesn't take an empty label or sound for a change", async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00', label: 'gym', sound: 'birds' });
    const { said } = await r.call('edit_alarm', { which: 'gym', time: '07:15', label: '', sound: '', play: '' });
    expect(said).toBe("It's set for 7:15 AM tomorrow, Thursday.");
    const a = r.clock.all()[0]!;
    expect(a.label).toBe('gym');
    expect(a.sound).toBe('birds');
  });

  it('takes the label off with "none" and puts the default sound back with "default" (review S6)', async () => {
    const r = rig();
    await r.call('set_alarm', { time: '07:00', label: 'gym', sound: 'birds' });
    expect((await r.call('edit_alarm', { which: 'gym', label: 'none' })).said).toBe('It has no label now.');
    expect(r.clock.all()[0]!.label).toBe('');
    expect((await r.call('edit_alarm', { which: '7:00', sound: 'default' })).said).toMatch(/^It'll ring with /);
    expect(r.clock.all()[0]!.sound).toBeUndefined();
    await r.call('alarm_options', { action: 'set', default_sound: 'birds' });
    expect(r.clock.prefs('u1').sound).toBe('birds');
    expect((await r.call('alarm_options', { action: 'set', default_sound: 'default' })).said).toBeDefined();
    expect(r.clock.prefs('u1').sound).toBeUndefined();
    const about = (n: string, k: string) => (r.tool(n).spec.parameters as { properties: Record<string, { description?: string }> }).properties[k]?.description;
    expect(about('edit_alarm', 'label')).toMatch(/"none" takes it off/);
    expect(about('alarm_options', 'default_sound')).toMatch(/"default" goes back/);
  });

  it('reads back settings as stored, and leaves lists and mistakes to the model', async () => {
    const r = rig();
    expect((await r.call('alarm_options', { action: 'set', snooze_minutes: 15 })).said).toBe('Snooze is 15 minutes.');
    expect((await r.call('alarm_options', { action: 'set', snooze_minutes: 500, default_sound: '' })).said).toMatch(/^Snooze is \d+ minutes\.$/);
    expect(r.clock.prefs('u1').sound).toBeUndefined();
    expect((await r.call('alarm_options', { action: 'set', default_sound: 'birds' })).said).toBe('Alarms ring with the birds sound.');
    expect((await r.call('alarm_options', { action: 'set', dismiss: 'firm' })).said).toBe('Only "I\'m up" turns them off now, stop just snoozes.');
    expect((await r.call('alarm_options', { action: 'set', default_sound: 'kazoo' })).said).toBeUndefined();
    expect((await r.call('alarm_options', { action: 'set' })).said).toBeUndefined();
    expect((await r.call('alarm_options', { action: 'sounds' })).said).toBeUndefined();
    expect((await r.call('alarm_options', { action: 'settings' })).said).toBeUndefined();
  });

  it('says nothing in English to someone who speaks another language', async () => {
    const clock = new AlarmClock(undefined, TZ, { placeFor: () => 'discord', ring: () => ({ stop() {}, alive: () => true }), dm: async () => true });
    const tools = alarmTools({ clock, reminders: new Reminders(undefined, TZ, () => {}), english: () => false, reach: () => 'call', preview: async () => true, musicOk: true });
    const set = tools.find((t) => t.spec.name === 'alarm_options')!;
    const raw = (await set.run({ action: 'set', snooze_minutes: 15 }, sig(), ctx)) as string;
    expect(set.speak?.({ action: 'set' }, raw, ctx)).toBeUndefined();
  });
});
