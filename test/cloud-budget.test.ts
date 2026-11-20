import { describe, expect, it } from 'vitest';
import { CloudBudget } from '../src/speech/cloud-budget.js';

function clock() {
  let t = 1_000_000;
  return { now: () => t, add: (ms: number) => void (t += ms) };
}

describe('the cloud listen budget', () => {
  it('early calls stop while the last minute is near the limit; calls someone waits on still go', () => {
    const c = clock();
    const b = new CloudBudget({ perMinute: 20, reserve: 6 }, c.now);
    let early = 0;
    for (let i = 0; i < 20; i++)
      if (b.earlyOk('u1')) {
        b.sent('u1', new AbortController().signal);
        early++;
      }
    expect(early).toBe(14);
    expect(b.usable()).toBe(true); // heard's own calls aren't held back
    c.add(60_000);
    expect(b.earlyOk('u1')).toBe(true); // the minute rolled over
    expect(b.stats()).toMatchObject({ sent: 14, early: 14, earlySkipped: 6 });
  });

  it('every call counts, dropped early ones too', () => {
    const c = clock();
    const b = new CloudBudget({ perMinute: 4, reserve: 1 }, c.now);
    const ctl = new AbortController();
    b.sent('u1', ctl.signal);
    ctl.abort(); // its clip went on: the call was spent all the same
    b.sent();
    b.sent();
    expect(b.earlyOk('u1')).toBe(false);
    expect(b.stats()).toMatchObject({ lastMinute: 3, sent: 3, early: 1, earlyDropped: 1 });
  });

  it('a 429 pauses every call for a minute and early ones for ten', () => {
    const c = clock();
    const b = new CloudBudget({}, c.now);
    expect(b.failed('Groq STT HTTP 429')).toBe(true);
    expect(b.usable()).toBe(false);
    expect(b.earlyOk('u1')).toBe(false);
    c.add(60_000);
    expect(b.usable()).toBe(true);
    expect(b.earlyOk('u1')).toBe(false);
    c.add(9 * 60_000);
    expect(b.earlyOk('u1')).toBe(true);
    expect(b.stats().limited).toBe(1);
  });

  it('an outage pauses calls for a minute but leaves early ones after it', () => {
    const c = clock();
    const b = new CloudBudget({}, c.now);
    expect(b.failed('Groq STT HTTP 503')).toBe(true);
    expect(b.earlyOk('u1')).toBe(false);
    c.add(60_000);
    expect(b.earlyOk('u1')).toBe(true);
  });

  it('other failures (a timeout, a bad answer) pause nothing', () => {
    const b = new CloudBudget();
    expect(b.failed('The operation was aborted due to timeout')).toBe(false);
    expect(b.failed('Groq STT HTTP 400')).toBe(false);
    expect(b.usable()).toBe(true);
    expect(b.earlyOk('u1')).toBe(true);
  });

  it('afterDropMs: no early call for someone whose last one was dropped a moment ago', () => {
    const c = clock();
    const b = new CloudBudget({ afterDropMs: 10_000 }, c.now);
    const ctl = new AbortController();
    b.sent('u1', ctl.signal);
    ctl.abort();
    expect(b.earlyOk('u1')).toBe(false);
    expect(b.earlyOk('u2')).toBe(true); // only them
    c.add(10_000);
    expect(b.earlyOk('u1')).toBe(true);
  });
});
