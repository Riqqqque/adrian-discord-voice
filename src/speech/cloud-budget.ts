// The cloud second listen's rate limit (config cloudStt; Groq's free tier takes
// about 20 transcriptions a minute per account). Every call counts, including an
// early one whose clip was then dropped: the request already reached Groq. Early
// calls (started before the clip closed, on a guess that it will be used) only go
// out while there's room for the calls someone is waiting on.

import type { UserId } from '../core/interfaces.js';

export interface CloudBudgetOptions {
  /** The provider's limit, calls a minute. */
  perMinute?: number;
  /** Calls a minute kept for clips someone waits on: early calls stop at perMinute − reserve. */
  reserve?: number;
  /** After a rate limit or an outage (HTTP 429 / 5xx): no calls at all, ms. */
  pauseMs?: number;
  /** After a rate limit: no early calls, ms. */
  earlyOffMs?: number;
  /** After one of this person's early calls was dropped (they went on talking): none for them, ms. 0 = off. */
  afterDropMs?: number;
}

const DEFAULTS: Required<CloudBudgetOptions> = { perMinute: 20, reserve: 6, pauseMs: 60_000, earlyOffMs: 10 * 60_000, afterDropMs: 0 };

export interface CloudBudgetStats {
  /** Calls in the last minute. */
  lastMinute: number;
  sent: number;
  early: number;
  /** Early calls whose clip was dropped: spent for nothing. */
  earlyDropped: number;
  /** Early calls not sent because of this budget. */
  earlySkipped: number;
  limited: number;
}

export class CloudBudget {
  private readonly o: Required<CloudBudgetOptions>;
  private readonly times: number[] = [];
  private pausedUntil = 0;
  private earlyOffUntil = 0;
  private readonly droppedAt = new Map<UserId, number>();
  private readonly counts = { sent: 0, early: 0, earlyDropped: 0, earlySkipped: 0, limited: 0 };

  constructor(o: CloudBudgetOptions = {}, private readonly now: () => number = () => performance.now()) {
    this.o = { ...DEFAULTS, ...o };
  }

  /** Calls may go out (not paused after a 429 or an outage). */
  usable(): boolean {
    return this.now() >= this.pausedUntil;
  }

  /** May an early call go out for this person now? Counts it as skipped if not. */
  earlyOk(userId: UserId): boolean {
    const t = this.now();
    const ok =
      t >= this.pausedUntil &&
      t >= this.earlyOffUntil &&
      this.lastMinute(t) < this.o.perMinute - this.o.reserve &&
      !(this.o.afterDropMs > 0 && t - (this.droppedAt.get(userId) ?? -Infinity) < this.o.afterDropMs);
    if (!ok) this.counts.earlySkipped++;
    return ok;
  }

  /** A call is going out. `dropped` (early calls): aborts if its clip is dropped. */
  sent(userId?: UserId, dropped?: AbortSignal): void {
    const t = this.now();
    this.times.push(t);
    this.counts.sent++;
    if (!dropped) return;
    this.counts.early++;
    dropped.addEventListener(
      'abort',
      () => {
        this.counts.earlyDropped++;
        if (userId !== undefined) this.droppedAt.set(userId, this.now());
      },
      { once: true },
    );
  }

  /** A call failed with this message. A rate limit or outage pauses calls; true if it did. */
  failed(message: string): boolean {
    const m = /HTTP (429|5\d\d)/.exec(message);
    if (!m) return false;
    const t = this.now();
    this.pausedUntil = t + this.o.pauseMs;
    if (m[1] === '429') {
      this.counts.limited++;
      this.earlyOffUntil = t + this.o.earlyOffMs;
    }
    return true;
  }

  stats(): CloudBudgetStats {
    return { lastMinute: this.lastMinute(this.now()), ...this.counts };
  }

  private lastMinute(t: number): number {
    while (this.times.length && t - this.times[0]! >= 60_000) this.times.shift();
    return this.times.length;
  }
}
