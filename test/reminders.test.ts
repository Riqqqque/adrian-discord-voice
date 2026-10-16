import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dueMessage, localToEpoch, Reminders } from '../src/features/reminders.js';

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
});
