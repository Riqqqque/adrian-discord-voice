import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PcPushToTalk, PTT_MAX_HOLD_MS, PTT_ONE_SHOT_MS, PTT_RELEASE_MS } from '../src/satellite/ptt.js';

describe("a PC's push-to-talk", () => {
  let now = 1_000;
  let cuts = 0;
  let words = 0;
  const make = () => new PcPushToTalk({ cut: () => void cuts++, wordsHereUntil: (u) => void (words = u), now: () => now });
  const later = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000;
    cuts = 0;
    words = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('held: everything closed between the press and the release cut is theirs, only the first needs no name', () => {
    const p = make();
    p.down(true);
    expect(cuts).toBe(1);
    expect(p.said(now)).toEqual({ ptt: false, first: false }); // closed by the press's own cut
    later(2_000);
    expect(p.said(now)).toMatchObject({ ptt: true, first: true });
    later(1_500);
    expect(p.said(now)).toMatchObject({ ptt: true, first: false });
    expect(p.open()).toBe(true);
    p.up();
    expect(p.done()).toBe(true);
    later(PTT_RELEASE_MS - 10);
    expect(p.said(now)).toMatchObject({ ptt: true, first: false }); // the last words, still on their way
    later(10);
    expect(cuts).toBe(2);
    expect(p.open()).toBe(false);
    const cutAt = now;
    later(800);
    expect(p.said(cutAt)).toMatchObject({ ptt: true, first: false }); // closed by the release cut, heard later
    expect(p.said(now)).toEqual({ ptt: false, first: false }); // anything after it
    expect(words).toBe(now + 3_000);
    later(3_000);
    expect(p.done()).toBe(false);
  });

  it('a key-up that never comes ends the press after a minute', () => {
    const p = make();
    p.down(true);
    expect(words).toBe(now + PTT_MAX_HOLD_MS);
    later(PTT_MAX_HOLD_MS + PTT_RELEASE_MS);
    expect(p.open()).toBe(false);
    later(10);
    expect(p.said(now)).toEqual({ ptt: false, first: false });
  });

  it('older apps (no hold): the next thing heard within 15 s, once', () => {
    const p = make();
    p.down(false);
    expect(cuts).toBe(0);
    expect(p.open()).toBe(true);
    later(2_000);
    expect(p.said(now - 1_000)).toMatchObject({ ptt: true, first: true }); // whenever it began, if it closed after the press
    expect(p.said(now)).toEqual({ ptt: false, first: false });
    p.down(false);
    later(PTT_ONE_SHOT_MS + 1);
    expect(p.said(now)).toEqual({ ptt: false, first: false });
    p.up(); // nothing to end
    expect(p.done()).toBe(false);
  });

  it('older apps: what had closed before the press is not theirs, and leaves the press waiting', () => {
    const p = make();
    const before = now;
    later(500);
    p.down(false);
    // Someone in a call, held by Smart Turn or queued for recognition: heard after the tap.
    expect(p.said(before)).toEqual({ ptt: false, first: false });
    later(1_000);
    expect(p.said(now)).toMatchObject({ ptt: true, first: true });
  });

  it('words of a press heard after the next press began are still that press', () => {
    const p = make();
    p.down(true);
    later(1_000);
    const spoke = now;
    p.up();
    later(PTT_RELEASE_MS);
    later(200);
    p.down(true); // again, before the first press's words came back
    later(300);
    const r = p.said(spoke);
    expect(r).toMatchObject({ ptt: true, first: true });
    const s = p.said(now);
    expect(s).toMatchObject({ ptt: true, first: true });
    expect(s.press).not.toBe(r.press);
  });

  it('pressed again within the release cut: the last words close as the first press', () => {
    const p = make();
    p.down(true);
    later(1_000);
    p.up();
    later(PTT_RELEASE_MS - 50);
    p.down(true);
    const cutAt = now; // the second press's cut closed what they were saying as they let go
    later(400);
    expect(p.said(cutAt)).toMatchObject({ ptt: true, first: true });
    expect(p.said(now)).toMatchObject({ ptt: true, first: true }); // the second press's own words
  });

  it('segments of one press share its id', () => {
    const p = make();
    p.down(true);
    later(500);
    const a = p.said(now);
    later(500);
    const b = p.said(now);
    expect(a.press).toBeDefined();
    expect(b.press).toBe(a.press);
  });

  it('a new press starts over, and a closed PC forgets it', () => {
    const p = make();
    p.down(true);
    later(100);
    p.said(now);
    p.down(true);
    later(100);
    expect(p.said(now)).toMatchObject({ ptt: true, first: true });
    p.close();
    expect(p.open()).toBe(false);
    expect(p.said(now)).toEqual({ ptt: false, first: false });
  });
});
