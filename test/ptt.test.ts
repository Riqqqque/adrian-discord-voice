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
    expect(p.said(now)).toEqual({ ptt: true, first: true });
    later(1_500);
    expect(p.said(now)).toEqual({ ptt: true, first: false });
    expect(p.open()).toBe(true);
    p.up();
    expect(p.done()).toBe(true);
    later(PTT_RELEASE_MS - 10);
    expect(p.said(now)).toEqual({ ptt: true, first: false }); // the last words, still on their way
    later(10);
    expect(cuts).toBe(2);
    expect(p.open()).toBe(false);
    const cutAt = now;
    later(800);
    expect(p.said(cutAt)).toEqual({ ptt: true, first: false }); // closed by the release cut, heard later
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
    expect(p.said(now - 5_000)).toEqual({ ptt: true, first: true }); // whenever it began
    expect(p.said(now)).toEqual({ ptt: false, first: false });
    p.down(false);
    later(PTT_ONE_SHOT_MS + 1);
    expect(p.said(now)).toEqual({ ptt: false, first: false });
    p.up(); // nothing to end
    expect(p.done()).toBe(false);
  });

  it('a new press starts over, and a closed PC forgets it', () => {
    const p = make();
    p.down(true);
    later(100);
    p.said(now);
    p.down(true);
    later(100);
    expect(p.said(now)).toEqual({ ptt: true, first: true });
    p.close();
    expect(p.open()).toBe(false);
    expect(p.said(now)).toEqual({ ptt: false, first: false });
  });
});
