// GET /api/dashboard: what she costs, how fast she answers, how reliable she
// is, and what needs attention, in one answer. The counters come from
// metrics.ts; the rest is read here, from things this process already has
// (the ledger, the config) or can see on this machine (the cloud voice's
// character count, free disk and memory, the updater's notes). The one outside
// request is the same newest-release lookup the updater makes, and only while
// someone has this page open, at most every 6 hours.

import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import type { PocConfig } from '../config.js';
import { dateFormat } from '../core/time.js';
import type { UsageLedger } from '../limits/usage-ledger.js';
import type { Metrics } from './metrics.js';

/** Tavily's free plan, per month (the wizard says the same). */
export const TAVILY_FREE = 1000;
/** Groq bills Whisper at $0.04 an hour of audio, 10 s at least per request. */
export const GROQ_USD_PER_REQUEST = 0.04 / 360;
const MiB = 2 ** 20;
const GiB = 2 ** 30;

export interface Attention {
  level: 'bad' | 'warn';
  text: string;
}

// --- this machine -------------------------------------------------------------

export interface SystemInfo {
  diskFreeGiB: number | null;
  diskTotalGiB: number | null;
  memAvailableMiB: number;
  memTotalMiB: number;
  rssMiB: number;
  /** The service's memory cap (systemd MemoryMax), when one is set. */
  memLimitMiB: number | null;
}

export function systemInfo(stateDir: string): SystemInfo {
  let free: number | null = null;
  let total: number | null = null;
  try {
    const s = statfsSync(stateDir);
    free = (s.bavail * s.bsize) / GiB;
    total = (s.blocks * s.bsize) / GiB;
  } catch {
    /* not there yet */
  }
  const p = process as NodeJS.Process & { availableMemory?: () => number; constrainedMemory?: () => number };
  // Not freemem() alone: that leaves out the page cache on some systems, so it
  // reads low on any busy Linux box. availableMemory() also respects a cgroup cap.
  const avail = p.availableMemory?.() ?? freemem();
  const limit = p.constrainedMemory?.() ?? 0;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    diskFreeGiB: free === null ? null : r1(free),
    diskTotalGiB: total === null ? null : r1(total),
    memAvailableMiB: Math.round(Math.min(avail, totalmem()) / MiB),
    memTotalMiB: Math.round(totalmem() / MiB),
    rssMiB: Math.round(process.memoryUsage.rss() / MiB),
    memLimitMiB: limit > 0 && limit < totalmem() ? Math.round(limit / MiB) : null,
  };
}

// --- updates ----------------------------------------------------------------

export interface UpdatePaths {
  /** The version the last update gave up on (packaging/adrian FAILED). */
  failed: string;
  /** An update that was cut off (packaging/adrian MARK). */
  inProgress: string;
  /** Present when auto-update is on. */
  timer: string;
}

export const LINUX_UPDATE_PATHS: UpdatePaths = {
  failed: '/opt/adrian/update-failed',
  inProgress: '/opt/adrian/update-in-progress',
  timer: '/etc/systemd/system/timers.target.wants/adrian-update.timer',
};

/** a > b, for versions like 0.17.1 (a pre-release tag counts as older). */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((x) => Number(x) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

const CHECK_EVERY_MS = 6 * 3_600_000;
const RETRY_MS = 3_600_000;

/** The newest release, looked up while the dashboard is open, cached. */
export class ReleaseCheck {
  private latest: string | undefined;
  private checkedAt = 0;
  private nextAt = 0;
  private error: string | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly repo: string,
    private readonly f: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** What's known now; starts a lookup in the background when it's due. */
  get(): { latest: string | null; checkedAt: string | null; error: string | null } {
    if (this.now() >= this.nextAt && !this.running) {
      this.running = this.lookup().finally(() => (this.running = undefined));
    }
    return { latest: this.latest ?? null, checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null, error: this.error ?? null };
  }

  /** For tests: the lookup in flight, if any. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async lookup(): Promise<void> {
    this.nextAt = this.now() + RETRY_MS;
    try {
      const r = await this.f(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const tag = ((await r.json()) as { tag_name?: unknown }).tag_name;
      if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+/.test(tag)) throw new Error('no version in the answer');
      this.latest = tag.replace(/^v/, '').slice(0, 32);
      this.checkedAt = this.now();
      this.error = undefined;
      this.nextAt = this.now() + CHECK_EVERY_MS;
    } catch (e) {
      this.error = e instanceof Error && e.name !== 'TimeoutError' ? e.message.slice(0, 120) : "couldn't reach GitHub";
    }
  }
}

function readSmall(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').slice(0, 200).trim();
  } catch {
    return undefined;
  }
}

// --- the answer ---------------------------------------------------------------

export interface DashboardInput {
  metrics: ReturnType<Metrics['snapshot']>;
  spend: ReturnType<UsageLedger['summary']>;
  /** Parsed config, when complete. */
  config: PocConfig | undefined;
  secretNames: string[];
  stateDir: string;
  timezone: string;
  version: string;
  stackState: string;
  voiceReady: boolean;
  system: SystemInfo;
  release: ReturnType<ReleaseCheck['get']>;
  updatePaths?: UpdatePaths;
  docker: boolean;
  now?: number;
}

/** Characters the cloud voice spoke this month (its own file, saved every few seconds). */
export function cloudVoiceChars(stateDir: string, timezone: string, now = Date.now()): number {
  try {
    const d = JSON.parse(readFileSync(join(stateDir, 'voice-usage.json'), 'utf8')) as { months?: Record<string, unknown> };
    const month = dateFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).format(now).slice(0, 7);
    const v = d.months?.[month];
    return typeof v === 'number' && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}

function providersOf(i: DashboardInput) {
  const m = i.metrics;
  const c = i.config;
  const has = (n: string | undefined) => !!n && i.secretNames.includes(n);
  const cv = c?.cloudVoice;
  const voiceOn = !!cv?.enabled && has(cv.apiKeySecret);
  const sttOn = !!c?.cloudStt.enabled && has(c.cloudStt.apiKeySecret);
  const search = c?.brain?.search;
  const searchOn = !!search && has(search.apiKeySecret);
  const chars = cloudVoiceChars(i.stateDir, i.timezone, i.now);

  const providers = {
    llm: {
      todayUsd: Number(i.spend.today.costUsd.toFixed(6)),
      monthUsd: i.spend.monthUsd,
      dailyCapUsd: i.spend.limits.dailyUsd,
      monthlyCapUsd: i.spend.limits.monthlyUsd,
      requestsToday: i.spend.today.requests,
      fallbacksDay: m.day.counts.llmFallback,
    },
    cloudVoice: {
      on: voiceOn,
      monthChars: chars,
      monthlyChars: cv?.monthlyChars ?? 0,
      fellBackDay: m.day.counts.cloudVoiceFail + m.day.counts.cloudVoiceRefused,
    },
    cloudStt: {
      on: sttOn,
      today: m.calls.today.groq,
      month: m.calls.month.groq,
      failedDay: m.day.counts.sttCloudFail,
      rateLimitedDay: m.day.counts.sttRateLimited,
      estMonthUsd: Number((m.calls.month.groq * GROQ_USD_PER_REQUEST).toFixed(4)),
    },
    search: {
      on: searchOn,
      today: m.calls.today.tavily,
      month: m.calls.month.tavily,
      failedMonth: m.calls.month.tavilyFailed,
      freePlan: TAVILY_FREE,
    },
  };
  return providers;
}
type Providers = ReturnType<typeof providersOf>;

export function buildDashboard(i: DashboardInput) {
  const m = i.metrics;
  const providers = providersOf(i);
  const updates = updateState(i);
  return {
    version: i.version,
    since: m.since,
    providers,
    costPerAnswerUsd: { day: m.day.costPerAnswerUsd, week: m.week.costPerAnswerUsd },
    answers: { day: answerCounts(m.day.counts), week: answerCounts(m.week.counts) },
    speed: { day: m.day.speed, week: m.week.speed },
    reliability: {
      voiceReady: i.voiceReady,
      voiceDownForS: m.voiceDownForS,
      pcsOnline: m.pcsOnline,
      day: links(m.day),
      week: links(m.week),
    },
    errors: m.errors.map(({ at, level, msg, detail, n }) => ({ at, level, msg, ...(detail ? { detail } : {}), n })),
    restarts: m.restarts.map(({ at, kind, why, version }) => ({ at, kind, why, ...(version ? { version } : {}) })),
    system: i.system,
    updates,
    attention: attention(i, providers, updates),
  };
}

function answerCounts(c: Record<string, number>) {
  return { answers: c.answers!, errors: c.errors!, timedOut: c.timedOut!, interrupted: c.interrupted!, costUsd: c.costUsd! };
}

function links(w: ReturnType<Metrics['snapshot']>['day']) {
  const k = w.counts;
  return {
    voiceDrops: k.voiceDrops,
    voiceBack: w.voiceBack,
    voiceFailed: k.voiceFailed,
    pcDrops: k.pcDrops,
    pcBack: w.pcBack,
    pcAway: k.pcAway,
    startFailed: k.startFailed,
    unclean: k.unclean,
    unhandled: k.unhandled,
  };
}

function updateState(i: DashboardInput) {
  const p = i.updatePaths;
  const failed = p ? readSmall(p.failed) : undefined;
  const cut = p ? readSmall(p.inProgress) : undefined;
  const latest = i.release.latest;
  return {
    current: i.version,
    latest,
    available: !!latest && newer(latest, i.version),
    checkedAt: i.release.checkedAt,
    checkError: i.release.error,
    autoUpdate: p ? existsSync(p.timer) : null,
    failedVersion: failed ? failed.split(/\s/)[0]!.slice(0, 32) : null,
    cutOff: !!cut,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (x: number) => `$${x.toFixed(x < 0.1 ? 4 : 2)}`;
const pctOf = (a: number, b: number) => Math.round((a / b) * 100);

export function attention(i: DashboardInput, p: Providers, u: ReturnType<typeof updateState>): Attention[] {
  const out: Attention[] = [];
  const day = i.metrics.day.counts;
  const add = (level: Attention['level'], text: string) => out.push({ level, text });

  // Money first: a cap that's reached means she's paused.
  const cap = (label: string, spent: number, limit: number, until: string) => {
    if (!(limit > 0)) return;
    if (spent >= limit) add('bad', `The ${label} spending cap is reached (${usd(spent)} of ${usd(limit)}): she doesn't answer questions that need the model until ${until}. Raise it under Settings, Limits.`);
    else if (spent >= 0.8 * limit) add('warn', `${pctOf(spent, limit)}% of the ${label} spending cap is used (${usd(spent)} of ${usd(limit)}).`);
  };
  cap('daily', p.llm.todayUsd, p.llm.dailyCapUsd, 'tomorrow');
  cap('monthly', p.llm.monthUsd, p.llm.monthlyCapUsd, 'next month');
  if (p.cloudVoice.on && p.cloudVoice.monthlyChars > 0) {
    const { monthChars: used, monthlyChars: of } = p.cloudVoice;
    if (used >= of) add('warn', `The cloud voice has used all ${of.toLocaleString('en-US')} characters for this month: the local voice speaks until next month.`);
    else if (used >= 0.8 * of) add('warn', `The cloud voice has used ${pctOf(used, of)}% of its characters for this month (${used.toLocaleString('en-US')} of ${of.toLocaleString('en-US')}).`);
  }
  if (p.search.on && p.search.month >= 0.8 * TAVILY_FREE) {
    add('warn', `${p.search.month.toLocaleString('en-US')} web searches this month. Tavily's free plan has ${TAVILY_FREE.toLocaleString('en-US')}; past that, searches fail until next month unless the plan is bigger.`);
  }

  // Links.
  const down = i.metrics.voiceDownForS;
  if (down !== null && down >= 30) add('bad', `The voice connection dropped ${fmtSecs(down)} ago and isn't back yet.`);
  if (day.voiceFailed) add('warn', `The voice connection failed to come back after several tries ${plural(day.voiceFailed, 'time')} in the last day.`);
  if (day.pcDrops >= 3) add('warn', `PC links dropped ${day.pcDrops} times in the last day. Check the PC's network or Wi-Fi.`);

  // Providers falling back.
  if (day.llmFallback) add('warn', `The main language model failed ${plural(day.llmFallback, 'time')} in the last day; the fallback answered instead.`);
  const failed = day.errors + day.timedOut;
  if (failed) add('warn', `${plural(failed, 'answer')} failed or timed out in the last day. The errors below say why.`);
  if (day.cloudVoiceFail) add('warn', `The cloud voice failed ${plural(day.cloudVoiceFail, 'time')} in the last day; the local voice stood in.`);
  if (day.sttRateLimited) add('warn', `Groq rate-limited the second listen ${plural(day.sttRateLimited, 'time')} in the last day; she used her own words meanwhile.`);
  else if (day.sttCloudFail >= 3) add('warn', `The second listen (Groq) failed ${day.sttCloudFail} times in the last day; she used her own words meanwhile.`);

  // The service itself.
  if (day.unclean) add('warn', `The service did not shut down cleanly in the last day (${i.metrics.restarts.find((r) => r.kind === 'start')?.why ?? 'see Restarts'}).`);
  if (day.startFailed) add('warn', `The bot failed to start ${plural(day.startFailed, 'time')} in the last day.`);
  if (day.unhandled) add('warn', `${plural(day.unhandled, 'unexpected error')} in the last day (unhandled rejection). The errors below have the latest.`);

  // This machine.
  const s = i.system;
  if (s.diskFreeGiB !== null) {
    if (s.diskFreeGiB < 1) add('bad', `Only ${s.diskFreeGiB} GiB of disk is free where she keeps her data. Updates need about 0.5 GB, and saving stops when it's full.`);
    else if (s.diskFreeGiB < 3) add('warn', `Disk space is low: ${s.diskFreeGiB} GiB free.`);
  }
  if (s.memAvailableMiB < 300) add('bad', `Memory is nearly full: ${s.memAvailableMiB} MiB available of ${s.memTotalMiB} MiB.`);
  else if (s.memAvailableMiB < 0.1 * s.memTotalMiB) add('warn', `Memory is low: ${s.memAvailableMiB} MiB available of ${s.memTotalMiB} MiB.`);
  if (s.memLimitMiB && s.rssMiB > 0.85 * s.memLimitMiB) add('warn', `She is using ${s.rssMiB} MiB of the ${s.memLimitMiB} MiB the service may use; near the cap it slows down, then restarts.`);

  // Updates.
  const how = i.docker ? 'build the new image, set ADRIAN_VERSION in .env and run docker compose up -d' : 'run: sudo adrian update';
  // Only the native install leaves these notes (packaging/adrian).
  if (u.cutOff) add('warn', 'An update was cut off before it finished. To finish or undo it, run: sudo adrian update.');
  if (u.failedVersion) add('warn', `The update to ${u.failedVersion} failed its checks here and was undone.${u.autoUpdate ? ' Auto-update tries it again after a day.' : ''}`);
  if (u.available && u.latest !== u.failedVersion) add('warn', `Version ${u.latest} is available (this is ${u.current}). ${u.autoUpdate ? 'Auto-update installs it when nobody is in her call.' : `To install it, ${how}.`}`);
  return out;
}

function fmtSecs(s: number): string {
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}
