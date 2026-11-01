import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dueMessage, localToEpoch, reminderRoute, Reminders, type Reminder } from '../src/features/reminders.js';

const ctx = { userId: 'u1', speaker: 'Sean' };
const tool = (r: Reminders, name: string) => r.tools().find((t) => t.spec.name === name)!;

describe('timers and reminders', () => {
  it('converts household clock times, including across DST', () => {
    expect(new Date(localToEpoch('2026-10-16T07:30', 'America/Denver')!).toISOString()).toBe('2026-10-16T13:30:00.000Z'); // MDT
    expect(new Date(localToEpoch('2026-12-01T07:30', 'America/Denver')!).toISOString()).toBe('2026-12-01T14:30:00.000Z'); // MST
    expect(localToEpoch('tomorrow at 7', 'UTC')).toBeUndefined();
  });

  it('fires timers when due, then forgets them', async () => {
    let now = Date.UTC(2026, 9, 16, 12);
    const fired: string[] = [];
    const r = new Reminders(undefined, 'UTC', (x, late) => fired.push(dueMessage(x, late)), () => now);
    expect(await tool(r, 'set_timer').run({ minutes: 5 }, AbortSignal.timeout(1000), ctx)).toContain('5 minute timer');
    await tool(r, 'set_timer').run({ minutes: 10, label: 'pizza' }, AbortSignal.timeout(1000), ctx);
    now += 5 * 60_000;
    r.tick();
    expect(fired).toEqual(['Sean, your 5 minute timer is done.']);
    expect(await tool(r, 'list_timers').run({}, AbortSignal.timeout(1000), ctx)).toContain('pizza');
    now += 5 * 60_000;
    r.tick();
    expect(fired[1]).toBe('Sean, your pizza timer is done.');
    expect(r.forUser('u1')).toHaveLength(0);
  });

  it('keeps reminders per person, cancels by name, and survives a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rem-')), 'reminders.json');
    const now = () => Date.UTC(2026, 9, 16, 12);
    const a = new Reminders(file, 'UTC', () => {}, now);
    await tool(a, 'set_reminder').run({ text: 'take out the trash', in_minutes: 60 }, AbortSignal.timeout(1000), ctx);
    await tool(a, 'set_reminder').run({ text: 'call mom', at: '2026-10-16T18:00' }, AbortSignal.timeout(1000), ctx);
    await tool(a, 'set_timer').run({ minutes: 3 }, AbortSignal.timeout(1000), { userId: 'u2', speaker: 'Sam' });
    expect(await tool(a, 'list_timers').run({}, AbortSignal.timeout(1000), { userId: 'u2', speaker: 'Sam' })).not.toContain('trash');
    const b = new Reminders(file, 'UTC', () => {}, now);
    expect(b.forUser('u1').map((x) => x.text)).toEqual(['take out the trash', 'call mom']);
    expect(await tool(b, 'cancel_timer').run({ which: 'trash' }, AbortSignal.timeout(1000), ctx)).toContain('take out the trash');
    expect(b.forUser('u1').map((x) => x.text)).toEqual(['call mom']);
  });

  it('refuses past times and says when a reminder fires late', async () => {
    const now = Date.UTC(2026, 9, 16, 12);
    const r = new Reminders(undefined, 'UTC', () => {}, () => now);
    expect(await tool(r, 'set_reminder').run({ text: 'x', at: '2026-10-16T11:00' }, AbortSignal.timeout(1000), ctx)).toContain('already passed');
    expect(dueMessage({ id: '1', userId: 'u', speaker: 'Sean', kind: 'reminder', text: 'stretch', dueAt: 0, createdAt: 0 }, 10 * 60_000)).toBe(
      'Sean, reminder: stretch. Sorry, this is 10 minutes late; I was offline.',
    );
  });

  describe('saying it was done', () => {
    const signal = AbortSignal.timeout(1000);
    const now = () => Date.UTC(2026, 9, 16, 12);
    /** What the tool says for itself after this call. */
    const said = async (r: Reminders, name: string, args: Record<string, unknown>) => {
      const t = r.tools().find((x) => x.spec.name === name)!;
      return t.speak!(args, await t.run(args, signal, ctx), ctx);
    };

    it('confirms in a few words', async () => {
      const r = new Reminders(undefined, 'UTC', () => {}, now);
      expect(await said(r, 'set_timer', { minutes: 5 })).toBe('Timer set for 5 minutes.');
      expect(await said(r, 'set_timer', { hours: 1, minutes: 30, label: 'pizza' })).toBe('Timer set for 1 hour 30 minutes.');
      expect(await said(r, 'set_reminder', { text: 'stretch', in_minutes: 60 })).toBe('Reminder set for Friday at 1 PM.');
      expect(await said(r, 'set_reminder', { text: 'call mom', at: '2026-10-16T18:00' })).toBe('Reminder set for Friday at 6 PM.');
      expect(await said(r, 'set_reminder', { text: 'call dad', at: '2026-10-17T19:30' })).toBe('Reminder set for Saturday at 7:30 PM.');
      expect(await said(r, 'cancel_timer', { which: 'pizza' })).toBe('Cancelled.');
    });

    it('says the time in the household time zone', async () => {
      const r = new Reminders(undefined, 'America/Denver', () => {}, now);
      expect(await said(r, 'set_reminder', { text: 'call mom', at: '2026-10-17T19:00' })).toBe('Reminder set for Saturday at 7 PM.');
    });

    it('gives the date from a week out, where a weekday alone would be wrong', async () => {
      const r = new Reminders(undefined, 'UTC', () => {}, now);
      expect(await said(r, 'set_reminder', { text: 'dentist', at: '2026-10-22T09:00' })).toBe('Reminder set for Thursday at 9 AM.');
      expect(await said(r, 'set_reminder', { text: 'dentist', at: '2026-10-26T09:00' })).toBe('Reminder set for Monday, October 26 at 9 AM.');
    });

    it('is not fooled by what the timer is for', async () => {
      const r = new Reminders(undefined, 'UTC', () => {}, now);
      expect(await said(r, 'set_timer', { minutes: 5, label: 'tea (in 2 cups).' })).toBe('Timer set for 5 minutes.');
      expect(await said(r, 'set_reminder', { text: 'bill due Sunday (in 3 days).', in_minutes: 60 })).toBe('Reminder set for Friday at 1 PM.');
      expect(await said(r, 'set_reminder', { text: 'two\nlines', in_minutes: 60 })).toBe('Reminder set for Friday at 1 PM.');
    });

    it('leaves anything that went wrong to the model', async () => {
      const r = new Reminders(undefined, 'UTC', () => {}, now);
      expect(await said(r, 'set_timer', {})).toBeUndefined();
      expect(await said(r, 'set_reminder', { text: '' })).toBeUndefined();
      expect(await said(r, 'set_reminder', { text: 'x' })).toBeUndefined();
      expect(await said(r, 'set_reminder', { text: 'x', at: '2026-10-16T11:00' })).toBeUndefined();
      expect(await said(r, 'cancel_timer', { which: 'nothing like this' })).toBeUndefined();
    });

    it('leaves the words to the model for someone speaking another language', async () => {
      const r = new Reminders(undefined, 'UTC', () => {}, now);
      const tools = r.tools((id) => id !== ctx.userId);
      for (const [name, args] of [['set_timer', { minutes: 5 }], ['set_reminder', { text: 'x', in_minutes: 5 }], ['cancel_timer', { which: 'x' }]] as const) {
        const t = tools.find((x) => x.spec.name === name)!;
        expect(t.speak!(args, await t.run(args, signal, ctx), ctx)).toBeUndefined();
      }
    });
  });
});

describe('a timer set at a PC', () => {
  const now = () => Date.UTC(2026, 9, 16, 12);
  const set = async (r: Reminders, channelId?: string) =>
    tool(r, 'set_timer').run({ minutes: 5 }, AbortSignal.timeout(1000), { ...ctx, ...(channelId ? { channelId } : {}) });

  it('remembers which PC, across a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rem-')), 'reminders.json');
    await set(new Reminders(file, 'UTC', () => {}, now), 'sat:desk');
    expect(new Reminders(file, 'UTC', () => {}, now).forUser('u1')[0]!.room).toBe('sat:desk');
  });

  it('a timer set in the Discord call has no room', async () => {
    const r = new Reminders(undefined, 'UTC', () => {}, now);
    await set(r, '100000000000000020');
    await set(r);
    expect(r.forUser('u1').map((x) => x.room)).toEqual([undefined, undefined]);
  });

  it('an old file without rooms still loads', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rem-')), 'reminders.json');
    await set(new Reminders(file, 'UTC', () => {}, now));
    expect(new Reminders(file, 'UTC', () => {}, now).forUser('u1')).toHaveLength(1);
  });

  it.each([
    // audible in the call, in the channel, its PC connected
    [true, true, true, { speak: 'call', dm: false }],
    [true, true, false, { speak: 'call', dm: false }],
    [false, true, true, { speak: 'pc', dm: true }],
    [false, false, true, { speak: 'pc', dm: true }],
    [false, true, false, { speak: 'call', dm: false }],
    [false, false, false, { dm: true }],
  ])('audible in her call %s, in the channel %s, PC up %s', (audibleInCall, inChannel, pcUp, route) => {
    expect(reminderRoute({ audibleInCall, inChannel, pcUp })).toEqual(route);
  });
});

describe('getting one delivered', () => {
  const start = Date.UTC(2026, 9, 16, 12);
  const onFile = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as Reminder[]).map((x) => x.text);
  function rig(onDue: (r: Reminder, lateMs: number) => void | Promise<unknown>) {
    const file = join(mkdtempSync(join(tmpdir(), 'rem-')), 'reminders.json');
    const clock = { now: start };
    const r = new Reminders(file, 'UTC', onDue, () => clock.now);
    return { r, file, clock };
  }
  const setPizza = async (r: Reminders) => tool(r, 'set_timer').run({ minutes: 5, label: 'pizza' }, AbortSignal.timeout(1000), ctx);
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it('stays on disk until it has been delivered', async () => {
    let delivered!: () => void;
    const t = rig(() => new Promise<void>((done) => (delivered = done)));
    await setPizza(t.r);
    t.clock.now += 5 * 60_000;
    t.r.tick();
    expect(onFile(t.file)).toEqual(['pizza']);
    delivered();
    await settle();
    expect(onFile(t.file)).toEqual([]);
  });

  it('comes back after a crash in the middle of it', async () => {
    const fired: string[] = [];
    const t = rig(() => new Promise<void>(() => {})); // the process dies with this still open
    await setPizza(t.r);
    t.clock.now += 5 * 60_000;
    t.r.tick();
    const after = new Reminders(t.file, 'UTC', (x, late) => void fired.push(dueMessage(x, late)), () => t.clock.now + 60 * 60_000);
    after.tick();
    expect(fired).toEqual(['Sean, your pizza timer is done. Sorry, this is 1 hour late; I was offline.']);
  });

  it('fires once, however long the delivery takes', async () => {
    let fired = 0;
    const t = rig(() => {
      fired++;
      return new Promise<void>(() => {});
    });
    await setPizza(t.r);
    t.clock.now += 5 * 60_000;
    t.r.tick();
    t.clock.now += 10 * 60_000;
    t.r.tick();
    expect(fired).toBe(1);
  });

  it('a delivery that fails is tried again in a minute, and is gone once it works', async () => {
    const tries: number[] = [];
    const t = rig((_x, late) => {
      tries.push(late);
      return tries.length < 3 ? Promise.reject(new Error('Discord is down')) : Promise.resolve();
    });
    await setPizza(t.r);
    t.clock.now += 5 * 60_000;
    t.r.tick();
    await settle();
    t.clock.now += 59_000;
    t.r.tick();
    expect(tries).toHaveLength(1);
    t.clock.now += 1_000;
    t.r.tick();
    await settle();
    expect(tries).toHaveLength(2);
    t.clock.now += 60_000;
    t.r.tick();
    await settle();
    expect(tries).toEqual([0, 60_000, 120_000]);
    expect(onFile(t.file)).toEqual([]);
  });

  it('gives up after a day of failures, so closed DMs do not fire for ever', async () => {
    let tries = 0;
    const t = rig(() => {
      tries++;
      return Promise.reject(new Error('Cannot send messages to this user'));
    });
    await setPizza(t.r);
    t.clock.now += 5 * 60_000;
    for (let i = 0; i < 24 * 60 + 5; i++) {
      t.r.tick();
      await settle();
      t.clock.now += 60_000;
    }
    expect(tries).toBe(24 * 60);
    expect(onFile(t.file)).toEqual([]);
  }, 30_000);

  it('a delivery that throws does not stop the others', async () => {
    const fired: string[] = [];
    const t = rig((x) => {
      fired.push(x.text);
      if (x.text === 'pizza') throw new Error('nope');
    });
    await setPizza(t.r);
    await tool(t.r, 'set_timer').run({ minutes: 5, label: 'tea' }, AbortSignal.timeout(1000), ctx);
    t.clock.now += 5 * 60_000;
    t.r.tick();
    expect(fired).toEqual(['pizza', 'tea']);
    expect(onFile(t.file)).toEqual(['pizza']);
  });

  it('one on its way is not listed', async () => {
    const t = rig(() => new Promise<void>(() => {}));
    await setPizza(t.r);
    t.clock.now += 5 * 60_000;
    t.r.tick();
    expect(await tool(t.r, 'list_timers').run({}, AbortSignal.timeout(1000), ctx)).toBe('No timers or reminders.');
  });
});
