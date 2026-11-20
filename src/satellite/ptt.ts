// A PC's push-to-talk, as the server keeps it.
//
// Apps from 0.17.2 send the key going down with `hold` and then going up: what
// is said from the press to the release is the owner's, however many pauses it
// has, and nothing before or after it. The press and the release each cut what
// is being heard right then, so audio from before the press (someone in a call
// through the speakers, already talking) and after the release never joins it.
// Older apps send only the press: then the next thing heard within 15 s is theirs.

export interface PttHooks {
  /** A segment that closed at `closedAt` (performance.now()) was said with the
   *  key. `first`: the first in this press, which needs no name. A one-shot
   *  press (older apps) is used up by whatever comes next. */
  said(closedAt: number): { ptt: boolean; first: boolean };
  /** The key is down now, or a one-shot press is waiting. */
  open(): boolean;
  /** The key went up a moment ago: what they said is complete. */
  done(): boolean;
}

/** Older apps: how long a press waits for something to be said. */
export const PTT_ONE_SHOT_MS = 15_000;
/** A key-up that never comes (the app died) ends the press here. */
export const PTT_MAX_HOLD_MS = 60_000;
/** After the key-up, the last audio from before it is still on its way. */
export const PTT_RELEASE_MS = 150;
/** How long "they just let go" lasts. */
const DONE_MS = 2_000;
/** The call's copy of words said at the PC can come this much later. */
const CALL_COPY_MS = 3_000;

export interface PcPushToTalkDeps {
  /** End what is being heard from the PC now, and keep it from joining what comes next. */
  cut(): void;
  /** Their words belong to the PC until then (the call hears them too). */
  wordsHereUntil(until: number): void;
  now?: () => number;
}

interface Press {
  at: number;
  /** The key went up (before the release cut). */
  upAt?: number;
  /** Segments closing after this aren't part of it. */
  end?: number;
  used: boolean;
}

export class PcPushToTalk implements PttHooks {
  private oneShotUntil = 0;
  private press: Press | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: PcPushToTalkDeps) {}

  private now(): number {
    return (this.d.now ?? (() => performance.now()))();
  }

  /** The key went down. `hold`: a key-up will follow. */
  down(hold: boolean): void {
    if (!hold) {
      this.oneShotUntil = this.now() + PTT_ONE_SHOT_MS;
      this.d.wordsHereUntil(this.oneShotUntil);
      return;
    }
    clearTimeout(this.timer);
    // Whatever was being heard before the press closes now, as not theirs.
    this.d.cut();
    const p: Press = { at: this.now(), used: false };
    this.press = p;
    this.d.wordsHereUntil(p.at + PTT_MAX_HOLD_MS);
    this.timer = setTimeout(() => this.up(), PTT_MAX_HOLD_MS);
  }

  /** The key went up. */
  up(): void {
    const p = this.press;
    if (!p || p.upAt !== undefined) return;
    p.upAt = this.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // What they were saying as they let go closes now.
      this.d.cut();
      p.end = this.now();
      this.d.wordsHereUntil(p.end + CALL_COPY_MS);
    }, PTT_RELEASE_MS);
  }

  said(closedAt: number): { ptt: boolean; first: boolean } {
    const now = this.now();
    const p = this.press;
    if (p && closedAt > p.at && (p.end === undefined || closedAt <= p.end)) {
      const first = !p.used;
      p.used = true;
      // Still held: the press's own time stands.
      if (p.end !== undefined) this.d.wordsHereUntil(now + CALL_COPY_MS);
      return { ptt: true, first };
    }
    const on = now < this.oneShotUntil;
    this.oneShotUntil = 0;
    if (on) this.d.wordsHereUntil(now + CALL_COPY_MS);
    return { ptt: on, first: on };
  }

  open(): boolean {
    const p = this.press;
    return (!!p && p.end === undefined) || this.now() < this.oneShotUntil;
  }

  done(): boolean {
    const p = this.press;
    return !!p && p.upAt !== undefined && this.now() < p.upAt + PTT_RELEASE_MS + DONE_MS;
  }

  /** The PC went away. */
  close(): void {
    clearTimeout(this.timer);
    this.press = undefined;
    this.oneShotUntil = 0;
  }
}
