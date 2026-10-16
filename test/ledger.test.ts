import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageLedger } from '../src/limits/usage-ledger.js';

const limits = { perUserPerHour: 3, dailyUsd: 0.01, monthlyUsd: 0.02 };

describe('usage ledger', () => {
  it('enforces per-user hourly requests, independent per user', () => {
    let now = Date.UTC(2026, 9, 15, 12);
    const l = new UsageLedger(undefined, limits, 'UTC', () => now);
    for (let i = 0; i < 3; i++) {
      expect(l.check('a').ok).toBe(true);
      l.noteRequest('a');
    }
    expect(l.check('a')).toEqual({ ok: false, reason: 'user-rate' });
    expect(l.check('b').ok).toBe(true);
    now += 3_600_001;
    expect(l.check('a').ok).toBe(true);
  });

  it('pauses at the daily cap, resumes the next local day, and stops at the monthly cap', () => {
    let now = Date.UTC(2026, 9, 15, 12);
    const l = new UsageLedger(undefined, { ...limits, perUserPerHour: 0 }, 'America/Denver', () => now);
    l.addCost(0.006);
    expect(l.check('a').ok).toBe(true);
    l.addCost(0.005);
    expect(l.check('a')).toEqual({ ok: false, reason: 'daily' });
    now += 24 * 3_600_000; // next day
    expect(l.check('a').ok).toBe(true);
    l.addCost(0.0095);
    expect(l.check('a')).toEqual({ ok: false, reason: 'monthly' }); // 0.0205 this month
    now = Date.UTC(2026, 10, 2, 12); // November
    expect(l.check('a').ok).toBe(true);
  });

  it('day boundaries follow the household timezone', () => {
    // 2026-10-16 03:00 UTC is still Oct 15 in Denver.
    const now = Date.UTC(2026, 9, 16, 3);
    const l = new UsageLedger(undefined, limits, 'America/Denver', () => now);
    l.addCost(0.001);
    expect(l.summary().history[0]?.day).toBe('2026-10-15');
  });

  it('persists across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const file = join(dir, 'usage.json');
    const now = () => Date.UTC(2026, 9, 15, 12);
    const a = new UsageLedger(file, limits, 'UTC', now);
    a.addCost(0.004);
    a.noteRequest('x');
    a.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).days['2026-10-15'].requests).toBe(1);
    const b = new UsageLedger(file, limits, 'UTC', now);
    expect(b.todayUsd()).toBeCloseTo(0.004);
  });
});

describe('owner exemption', () => {
  it('skips the hourly limit but not the spend caps', () => {
    const l = new UsageLedger(undefined, { perUserPerHour: 1, dailyUsd: 0.01, monthlyUsd: 1 }, 'UTC', () => Date.UTC(2026, 9, 15, 12));
    l.noteRequest('o');
    expect(l.check('o').ok).toBe(false);
    expect(l.check('o', true).ok).toBe(true);
    l.addCost(0.02);
    expect(l.check('o', true)).toEqual({ ok: false, reason: 'daily' });
  });
});
