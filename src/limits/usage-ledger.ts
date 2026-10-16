// Spend caps and per-user rate limits (brief §5.3 step 10, §6). Costs are
// recorded per local day (household timezone) and persisted, so caps
// survive restarts. Checked before every model call.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dateFormat } from '../core/time.js';
import { dirname } from 'node:path';
import type { UserId } from '../core/interfaces.js';

export interface Limits {
  /** Requests one user may make per rolling hour (0 = unlimited). */
  perUserPerHour: number;
  /** USD per local day (0 = unlimited). */
  dailyUsd: number;
  /** USD per local calendar month (0 = unlimited). */
  monthlyUsd: number;
}

export type LimitCheck = { ok: true } | { ok: false; reason: 'user-rate' | 'daily' | 'monthly' };

interface DayRecord {
  costUsd: number;
  requests: number;
}

interface LedgerFile {
  version: 1;
  days: Record<string, DayRecord>; // YYYY-MM-DD → totals
}

export class UsageLedger {
  private data: LedgerFile;
  private readonly recent = new Map<UserId, number[]>(); // request times (ms)
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly file: string | undefined,
    private limits: Limits,
    private timezone: string,
    private readonly now: () => number = Date.now,
  ) {
    this.data = { version: 1, days: {} };
    if (file) {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8')) as LedgerFile;
        if (d?.version === 1 && d.days) this.data = d;
      } catch {
        /* first run or unreadable: start empty */
      }
    }
  }

  setLimits(l: Limits): void {
    this.limits = l;
  }

  setTimezone(tz: string): void {
    this.timezone = tz;
  }

  private day(ts = this.now()): string {
    // en-CA formats as YYYY-MM-DD.
    return dateFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
  }

  todayUsd(): number {
    return this.data.days[this.day()]?.costUsd ?? 0;
  }

  monthUsd(): number {
    const month = this.day().slice(0, 7);
    return Object.entries(this.data.days)
      .filter(([d]) => d.startsWith(month))
      .reduce((s, [, r]) => s + r.costUsd, 0);
  }

  /** May this user start a paid request now? */
  /** `exempt`: skip the per-person hourly limit (owners); spend caps still apply. */
  check(userId: UserId, exempt = false): LimitCheck {
    const l = this.limits;
    if (l.monthlyUsd > 0 && this.monthUsd() >= l.monthlyUsd) return { ok: false, reason: 'monthly' };
    if (l.dailyUsd > 0 && this.todayUsd() >= l.dailyUsd) return { ok: false, reason: 'daily' };
    if (l.perUserPerHour > 0 && !exempt) {
      const hourAgo = this.now() - 3_600_000;
      const times = (this.recent.get(userId) ?? []).filter((t) => t > hourAgo);
      this.recent.set(userId, times);
      if (times.length >= l.perUserPerHour) return { ok: false, reason: 'user-rate' };
    }
    return { ok: true };
  }

  /** Count a request for the rate limit (call when it starts). */
  noteRequest(userId: UserId): void {
    const hourAgo = this.now() - 3_600_000;
    const t = (this.recent.get(userId) ?? []).filter((x) => x > hourAgo);
    t.push(this.now());
    this.recent.set(userId, t);
    const d = (this.data.days[this.day()] ??= { costUsd: 0, requests: 0 });
    d.requests++;
    this.scheduleSave();
  }

  /** Add the cost of a finished request. */
  addCost(usd: number): void {
    if (!(usd > 0)) return;
    const d = (this.data.days[this.day()] ??= { costUsd: 0, requests: 0 });
    d.costUsd += usd;
    this.scheduleSave();
  }

  summary(days = 31): { today: DayRecord; monthUsd: number; limits: Limits; history: { day: string; costUsd: number; requests: number }[] } {
    const history = Object.entries(this.data.days)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, days)
      .map(([day, r]) => ({ day, costUsd: Number(r.costUsd.toFixed(6)), requests: r.requests }));
    return {
      today: this.data.days[this.day()] ?? { costUsd: 0, requests: 0 },
      monthUsd: Number(this.monthUsd().toFixed(6)),
      limits: this.limits,
      history,
    };
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 2_000);
    this.saveTimer.unref();
  }

  flush(): void {
    if (!this.file) return;
    // Keep ~13 months.
    const keys = Object.keys(this.data.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete this.data.days[k];
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export const LIMIT_MESSAGES: Record<'user-rate' | 'daily' | 'monthly', string> = {
  'user-rate': "You've asked a lot this hour. I'm pausing your questions for a bit.",
  daily: "I'm paused for the rest of today because the daily spending limit was reached.",
  monthly: "I'm paused for the rest of the month because the monthly spending limit was reached.",
};
