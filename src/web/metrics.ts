// The dashboard's counters: how fast she answers, how often a link drops and
// how long it takes to come back, what went wrong lately, and how many paid
// calls the dollar ledger doesn't see. Fed by the service's own log lines (the
// logger's observer) and core/calls.ts, so the voice stack, the transport and
// the satellite code carry no metrics code at all.
//
// Fixed size whatever happens: latency histograms in 24 hourly and 8 daily
// slots, short rings for errors and restarts, at most 32 PCs tracked. Saved in
// the state folder every few minutes and at shutdown, so an update doesn't wipe
// the week. Nothing here leaves the server, and nothing kept names a person:
// no user IDs, device names, addresses or words.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CountedService } from '../core/calls.js';
import { redact } from '../core/logger.js';
import { dateFormat } from '../core/time.js';

// --- histograms -----------------------------------------------------------

/** Bin 0 is under 10 ms, the last is 10 minutes and over; the 94 between grow
 *  by about 12% each, so a percentile read from them is within about 6%. */
export const BINS = 96;
const LO = 10;
const HI = 600_000;
const RATIO = (HI / LO) ** (1 / (BINS - 2));
const LOG_RATIO = Math.log(RATIO);

export function binOf(ms: number): number {
  if (!(ms >= LO)) return 0;
  if (ms >= HI) return BINS - 1;
  return Math.min(BINS - 2, 1 + Math.floor(Math.log(ms / LO) / LOG_RATIO));
}

/** The middle of a bin (geometric), as the value it stands for. */
export function binValue(b: number): number {
  if (b <= 0) return 0;
  if (b >= BINS - 1) return HI;
  return LO * RATIO ** (b - 0.5);
}

const SERIES = ['total', 'totalCall', 'totalPc', 'stt', 'groq', 'turnCheck', 'hold', 'llmFirst', 'ttsFirst', 'voiceBack', 'pcBack'] as const;
type Series = (typeof SERIES)[number];
const S = SERIES.length;
const SI = Object.fromEntries(SERIES.map((s, i) => [s, i])) as Record<Series, number>;

export const COUNTS = [
  'answers', 'errors', 'timedOut', 'interrupted', 'costUsd', 'paid',
  'llmFallback', 'sttCloudFail', 'sttRateLimited', 'cloudVoiceFail', 'cloudVoiceRefused', 'cloudVoiceBudget',
  'voiceDrops', 'voiceFailed', 'pcDrops', 'pcAway', 'startFailed', 'unhandled', 'unclean',
] as const;
export type CountName = (typeof COUNTS)[number];
const C = COUNTS.length;
const CI = Object.fromEntries(COUNTS.map((c, i) => [c, i])) as Record<CountName, number>;

/** One answer's stage times, as the `answered` log line has them. */
const ANSWER_STAGES: [string, Series][] = [
  ['sttLatencyMs', 'stt'],
  ['groqMs', 'groq'],
  ['turnCheckMs', 'turnCheck'],
  ['holdMs', 'hold'],
  ['llmFirstChunkMs', 'llmFirst'],
  ['ttsFirstMs', 'ttsFirst'],
];

/** A ring of time slots, each with a histogram per series and the counters. */
class Slots {
  readonly keys: Float64Array;
  /** Counts per bin, saturating: 65,535 answers in one bin in one hour or day. */
  readonly hist: Uint16Array;
  readonly counts: Float64Array;
  private readonly max: number;

  constructor(
    readonly n: number,
    readonly widthMs: number,
  ) {
    this.keys = new Float64Array(n).fill(-1);
    this.hist = new Uint16Array(n * S * BINS);
    this.max = 0xffff;
    this.counts = new Float64Array(n * C);
  }

  private slot(t: number): number {
    const k = Math.floor(t / this.widthMs);
    const i = k % this.n;
    if (this.keys[i] !== k) {
      this.keys[i] = k;
      this.hist.fill(0, i * S * BINS, (i + 1) * S * BINS);
      this.counts.fill(0, i * C, (i + 1) * C);
    }
    return i;
  }

  sample(t: number, s: Series, ms: number): void {
    const j = (this.slot(t) * S + SI[s]) * BINS + binOf(ms);
    if (this.hist[j]! < this.max) this.hist[j]!++;
  }

  add(t: number, c: CountName, v = 1): void {
    this.counts[this.slot(t) * C + CI[c]]! += v;
  }

  /** The slots of the last `span` widths, this one included, added up. */
  window(now: number, span: number): { hist: Float64Array; counts: Float64Array } {
    const k = Math.floor(now / this.widthMs);
    const hist = new Float64Array(S * BINS);
    const counts = new Float64Array(C);
    for (let i = 0; i < this.n; i++) {
      const key = this.keys[i]!;
      if (key < 0 || key > k || key <= k - span) continue;
      for (let j = 0; j < S * BINS; j++) hist[j]! += this.hist[i * S * BINS + j]!;
      for (let j = 0; j < C; j++) counts[j]! += this.counts[i * C + j]!;
    }
    return { hist, counts };
  }

  bytes(): number {
    return this.keys.byteLength + this.hist.byteLength + this.counts.byteLength;
  }

  toJSON(): SlotsFile {
    return { keys: [...this.keys], hist: Buffer.from(this.hist.buffer, this.hist.byteOffset, this.hist.byteLength).toString('base64'), counts: [...this.counts] };
  }

  load(f: SlotsFile | undefined): void {
    if (!f || !Array.isArray(f.keys) || f.keys.length !== this.n || !Array.isArray(f.counts) || f.counts.length !== this.n * C || typeof f.hist !== 'string') return;
    const raw = Buffer.from(f.hist, 'base64');
    if (raw.length !== this.hist.byteLength) return; // another layout: start over
    this.keys.set(f.keys.map((x) => (Number.isFinite(x) ? x : -1)));
    this.counts.set(f.counts.map((x) => (Number.isFinite(x) ? x : 0)));
    new Uint8Array(this.hist.buffer, this.hist.byteOffset, this.hist.byteLength).set(raw);
  }
}

interface SlotsFile {
  keys: number[];
  hist: string;
  counts: number[];
}

export interface Pct {
  p50: number | null;
  p90: number | null;
  n: number;
}

function percentiles(hist: Float64Array, s: Series): Pct & { max: number | null } {
  const off = SI[s] * BINS;
  let n = 0;
  let top = -1;
  for (let b = 0; b < BINS; b++) {
    n += hist[off + b]!;
    if (hist[off + b]! > 0) top = b;
  }
  const at = (p: number) => {
    if (!n) return null;
    const rank = Math.min(n - 1, Math.floor((p / 100) * n)); // as /api/status reads its samples
    let seen = 0;
    for (let b = 0; b < BINS; b++) {
      seen += hist[off + b]!;
      if (seen > rank) return round(binValue(b));
    }
    return null;
  };
  return { p50: at(50), p90: at(90), n, max: top < 0 ? null : round(binValue(top)) };
}

const round = (ms: number) => (ms >= 1000 ? Math.round(ms / 10) * 10 : Math.round(ms));

// --- rings ------------------------------------------------------------------

export interface ErrorEntry {
  t: number;
  level: 'warn' | 'error';
  msg: string;
  detail?: string;
  /** Times it happened; t is the latest. */
  n: number;
}

export interface RestartEntry {
  t: number;
  kind: 'start' | 'restart' | 'failed';
  why: string;
  version?: string;
}

const MAX_ERRORS = 20;
const MAX_RESTARTS = 12;
const MAX_PCS = 32;
const MAX_DAYS = 62;
const TEXT = 160;
/** A PC back within this long had a dropped link; later, it was off or asleep. */
export const PC_DROP_MS = 10 * 60_000;
const SAVE_EVERY_MS = 5 * 60_000;
/** A disconnect this soon after a channel move is the move itself. */
const MOVE_MS = 5_000;

/** Discord IDs (17-20 digit snowflakes) and secrets out, length capped. */
function clean(s: unknown): string | undefined {
  if (typeof s !== 'string' && typeof s !== 'number') return undefined;
  // Only the first characters are ever shown, so a cut past them can't leave a secret in view.
  const t = redact(String(s).slice(0, 4000)).replace(/\b\d{17,20}\b/g, '…');
  return t.length > TEXT ? `${t.slice(0, TEXT - 1)}…` : t;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

type DayCounts = [tavily: number, tavilyFail: number, groq: number, groqFail: number];

interface MetricsFile {
  version: 1;
  savedAt: number;
  /** Still running when this was saved: no clean shutdown followed. */
  running: boolean;
  crash?: string;
  appVersion?: string;
  since: number;
  hourly: SlotsFile;
  daily: SlotsFile;
  days: Record<string, DayCounts>;
  errors: ErrorEntry[];
  restarts: RestartEntry[];
}

export interface MetricsOptions {
  /** Where they're kept between runs; in memory only if unset. */
  file?: string;
  timezone?: string;
  /** This run's version, to tell an update from a plain restart. */
  version?: string;
  now?: () => number;
}

// Log lines this counts on. test/dashboard.test.ts checks each still exists in src/.
export const WATCHED = {
  answered: 'answered',
  voiceDropped: 'voice disconnected',
  voiceState: 'voice state',
  voiceFailed: 'voice failed',
  kicked: 'disconnected from voice by someone; staying out until /join',
  leftEmpty: 'left an empty channel',
  leave: 'leave requested',
  moved: 'moved to another channel',
  /** The first line of every stack start. */
  stackStarting: 'asr loaded',
  pcUp:'satellite connected',
  pcDown: 'satellite disconnected',
  satListening: 'satellite server listening',
  llmFallback: 'primary LLM failed; using fallback',
  sttFail: 'cloud speech-to-text failed; using local words',
  cloudVoiceFail: 'cloud voice failed; local voice for a minute',
  cloudVoiceRefused: 'cloud voice refused a line; local voice for it',
  cloudVoiceBudget: 'cloud voice budget used up for this month; using the local voice',
  startFailed: 'voice stack failed to start',
  setupMode: 'setup mode',
  restartRequested: 'restart requested',
  shuttingDown: 'shutting down',
  unhandled: 'unhandled rejection',
} as const;

export class Metrics {
  private readonly hourly = new Slots(24, 3_600_000);
  private readonly daily = new Slots(8, 86_400_000);
  private days: Record<string, DayCounts> = {};
  private errors: ErrorEntry[] = [];
  private restarts: RestartEntry[] = [];
  private since: number;
  private crash: string | undefined;
  /** Voice link down since (a drop, not a leave). */
  private voiceDownSince: number | undefined;
  /** Live links per PC, and when the last one went. Keys stay in memory only. */
  private readonly pcs = new Map<string, { live: number; goneAt?: number | undefined }>();
  /** The stack is being stopped on purpose: links closing now aren't drops. */
  private stopping = false;
  private movedAt = -Infinity;
  private readonly now: () => number;
  private readonly tz: string;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly prev: MetricsFile | undefined;

  constructor(private readonly o: MetricsOptions = {}) {
    this.now = o.now ?? Date.now;
    this.tz = o.timezone ?? 'UTC';
    this.since = this.now();
    if (o.file) {
      try {
        const f = JSON.parse(readFileSync(o.file, 'utf8')) as MetricsFile;
        if (f?.version === 1) {
          this.prev = f;
          this.hourly.load(f.hourly);
          this.daily.load(f.daily);
          if (f.days && typeof f.days === 'object') {
            for (const [d, v] of Object.entries(f.days).slice(-MAX_DAYS)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Array.isArray(v) && v.length === 4) this.days[d] = v.map((x) => num(x) ?? 0) as DayCounts;
          }
          if (Array.isArray(f.errors)) {
            this.errors = f.errors
              .slice(-MAX_ERRORS)
              .filter((e) => typeof e?.msg === 'string' && num(e.t) !== undefined)
              .map((e) => {
                const detail = clean(e.detail);
                return { t: e.t, level: e.level === 'error' ? 'error' : 'warn', msg: clean(e.msg) ?? '', ...(detail ? { detail } : {}), n: num(e.n) ?? 1 };
              });
          }
          if (Array.isArray(f.restarts)) this.restarts = f.restarts.slice(-MAX_RESTARTS).filter((r) => typeof r?.why === 'string');
          if (num(f.since)) this.since = f.since;
        }
      } catch {
        /* first run, or unreadable: start empty */
      }
    }
  }

  /** Call once at service start: notes why it (re)started, and saves now and then. */
  begin(): void {
    const p = this.prev;
    const v = this.o.version;
    let why: string;
    if (!p) why = 'first start with these counters';
    else if (p.running) {
      why = p.crash ? `crashed: ${p.crash}` : 'did not shut down cleanly (killed, out of memory, a power cut or a crash)';
      this.daily.add(this.now(), 'unclean');
      this.hourly.add(this.now(), 'unclean');
    } else if (v && p.appVersion && p.appVersion !== v) why = `updated from ${p.appVersion}`;
    else why = 'service restarted';
    this.pushRestart({ t: this.now(), kind: 'start', why, ...(v ? { version: v } : {}) });
    this.save(true);
    if (this.o.file) {
      this.saveTimer = setInterval(() => this.save(true), SAVE_EVERY_MS);
      this.saveTimer.unref();
    }
  }

  /** Every log line goes through here: keep the common case one lookup. */
  readonly observe = (level: string, msg: string, f: Record<string, unknown> | undefined): void => {
    const t = this.now();
    switch (msg) {
      case WATCHED.answered:
        this.answered(t, f ?? {});
        break;
      case WATCHED.voiceDropped:
        // Being dragged to another channel passes through a disconnect too.
        if (!this.stopping && t - this.movedAt > MOVE_MS) this.voiceDownSince ??= t;
        break;
      case WATCHED.moved:
        this.movedAt = t;
        this.voiceDownSince = undefined;
        break;
      case WATCHED.stackStarting:
        this.stopping = false;
        break;
      case WATCHED.voiceState:
        if (f?.to === 'ready' && this.voiceDownSince !== undefined) {
          this.count(t, 'voiceDrops');
          this.sample(t, 'voiceBack', t - this.voiceDownSince);
          this.voiceDownSince = undefined;
        }
        break;
      case WATCHED.voiceFailed:
        this.count(t, 'voiceFailed');
        break;
      case WATCHED.kicked:
      case WATCHED.leftEmpty:
      case WATCHED.leave:
        this.voiceDownSince = undefined; // out of voice on purpose
        break;
      case WATCHED.pcUp:
        this.pcUp(t, f);
        break;
      case WATCHED.pcDown:
        this.pcDown(t, f);
        break;
      case WATCHED.satListening:
        this.stopping = false;
        break;
      case WATCHED.llmFallback:
        this.count(t, 'llmFallback');
        break;
      case WATCHED.sttFail:
        this.count(t, 'sttCloudFail');
        if (/HTTP 429/.test(String(f?.error ?? ''))) this.count(t, 'sttRateLimited');
        break;
      case WATCHED.cloudVoiceFail:
        this.count(t, 'cloudVoiceFail');
        break;
      case WATCHED.cloudVoiceRefused:
        this.count(t, 'cloudVoiceRefused');
        break;
      case WATCHED.cloudVoiceBudget:
        this.count(t, 'cloudVoiceBudget');
        break;
      case WATCHED.startFailed:
        this.count(t, 'startFailed');
        this.pushRestart({ t, kind: 'failed', why: clean(f?.error) ?? 'failed to start' });
        this.stopping = false;
        this.voiceDownSince = undefined;
        break;
      case WATCHED.setupMode:
        this.stopping = false;
        break;
      case WATCHED.restartRequested:
        this.pushRestart({ t, kind: 'restart', why: 'Restart bot on this page' });
        this.stopping = true;
        this.voiceDownSince = undefined;
        break;
      case WATCHED.shuttingDown:
        this.stopping = true;
        this.voiceDownSince = undefined;
        break;
      case WATCHED.unhandled:
        this.count(t, 'unhandled');
        break;
    }
    if (level === 'warn' || level === 'error') this.noteError(t, level, msg, f);
  };

  /** A counted outside call (core/calls.ts) got an answer with this status. */
  readonly noteCall = (service: CountedService, status: number): void => {
    const d = (this.days[this.day(this.now())] ??= [0, 0, 0, 0]);
    const ok = status >= 200 && status < 300;
    if (service === 'tavily') d[ok ? 0 : 1]++;
    else d[ok ? 2 : 3]++;
    const keys = Object.keys(this.days);
    if (keys.length > MAX_DAYS) for (const k of keys.sort().slice(0, keys.length - MAX_DAYS)) delete this.days[k];
  };

  /** An exception is about to end the process: say so in the file. */
  crashed(message: string): void {
    this.crash = clean(message) ?? 'unknown error';
    this.save(true);
  }

  /** Save now; `clean` at a normal shutdown. */
  flush(clean = true): void {
    clearInterval(this.saveTimer);
    this.saveTimer = undefined;
    this.save(!clean);
  }

  private save(running: boolean): void {
    if (!this.o.file) return;
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      const tmp = `${this.o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.toFile(running)), { mode: 0o600 });
      renameSync(tmp, this.o.file);
    } catch {
      /* a full disk shows on the dashboard; counting carries on in memory */
    }
  }

  toFile(running: boolean): MetricsFile {
    return {
      version: 1,
      savedAt: this.now(),
      running,
      ...(this.crash ? { crash: this.crash } : {}),
      ...(this.o.version ? { appVersion: this.o.version } : {}),
      since: this.since,
      hourly: this.hourly.toJSON(),
      daily: this.daily.toJSON(),
      days: this.days,
      errors: this.errors,
      restarts: this.restarts,
    };
  }

  private day(t: number): string {
    return dateFormat('en-CA', { timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  }

  private count(t: number, c: CountName, v = 1): void {
    this.hourly.add(t, c, v);
    this.daily.add(t, c, v);
  }

  private sample(t: number, s: Series, ms: number): void {
    this.hourly.sample(t, s, ms);
    this.daily.sample(t, s, ms);
  }

  private answered(t: number, f: Record<string, unknown>): void {
    this.count(t, 'answers');
    const outcome = f.outcome;
    if (outcome === 'error') this.count(t, 'errors');
    else if (outcome === 'timed out') this.count(t, 'timedOut');
    else if (outcome === 'interrupted') this.count(t, 'interrupted');
    const cost = num(f.costUsd);
    if (cost) {
      this.count(t, 'costUsd', cost);
      this.count(t, 'paid');
    }
    const total = num(f.speechEndToAudioMs);
    if (total !== undefined) {
      this.sample(t, 'total', total);
      this.sample(t, typeof f.room === 'string' && f.room.startsWith('sat:') ? 'totalPc' : 'totalCall', total);
    }
    for (const [field, s] of ANSWER_STAGES) {
      const v = num(f[field]);
      if (v !== undefined) this.sample(t, s, v);
    }
  }

  private pcKey(f: Record<string, unknown> | undefined): string {
    return String(f?.device ?? '?').slice(0, 64);
  }

  private pcUp(t: number, f: Record<string, unknown> | undefined): void {
    const key = this.pcKey(f);
    let e = this.pcs.get(key);
    if (!e) {
      if (this.pcs.size >= MAX_PCS) {
        // Forget one that's offline (the oldest), or else the oldest of all.
        const off = [...this.pcs].find(([, v]) => v.live === 0)?.[0] ?? this.pcs.keys().next().value!;
        this.pcs.delete(off);
      }
      e = { live: 0 };
      this.pcs.set(key, e);
    }
    if (e.live === 0 && e.goneAt !== undefined) {
      const gap = t - e.goneAt;
      if (gap <= PC_DROP_MS) {
        this.count(t, 'pcDrops');
        this.sample(t, 'pcBack', gap);
      } else this.count(t, 'pcAway');
    }
    e.live++;
    e.goneAt = undefined;
  }

  private pcDown(t: number, f: Record<string, unknown> | undefined): void {
    const e = this.pcs.get(this.pcKey(f));
    if (!e) return;
    e.live = Math.max(0, e.live - 1);
    // A reconnect replaces the old link, whose close can land after the new
    // one's welcome: only the last one going counts. So does a planned stop.
    if (e.live === 0) e.goneAt = this.stopping ? undefined : t;
  }

  private noteError(t: number, level: 'warn' | 'error', msg: string, f: Record<string, unknown> | undefined): void {
    const m = clean(msg) ?? '';
    const detail = clean(f?.error ?? f?.reason ?? (f?.status !== undefined ? `status ${String(f.status)}` : undefined));
    // The same thing again moves to the top with its count, so a burst of one
    // error can't push every other one out.
    const i = this.errors.findIndex((e) => e.msg === m && e.detail === detail);
    if (i >= 0) {
      const [e] = this.errors.splice(i, 1);
      this.errors.push({ ...e!, t, level: e!.level === 'error' ? 'error' : level, n: e!.n + 1 });
      return;
    }
    this.errors.push({ t, level, msg: m, ...(detail ? { detail } : {}), n: 1 });
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
  }

  private pushRestart(r: RestartEntry): void {
    this.restarts.push(r);
    if (this.restarts.length > MAX_RESTARTS) this.restarts.shift();
  }

  /** What the dashboard shows from these counters. */
  snapshot() {
    const t = this.now();
    const view = (w: { hist: Float64Array; counts: Float64Array }) => {
      const c = Object.fromEntries(COUNTS.map((k, i) => [k, k === 'costUsd' ? Number(w.counts[i]!.toFixed(6)) : w.counts[i]!])) as Record<CountName, number>;
      const p = (s: Series) => {
        const { max: _max, ...rest } = percentiles(w.hist, s);
        return rest;
      };
      const back = (s: Series) => {
        const r = percentiles(w.hist, s);
        return { p50: r.p50, max: r.max, n: r.n };
      };
      return {
        counts: c,
        costPerAnswerUsd: c.answers ? Number((c.costUsd / c.answers).toFixed(6)) : null,
        speed: {
          total: p('total'),
          call: p('totalCall'),
          pc: p('totalPc'),
          stages: { stt: p('stt'), groq: p('groq'), turnCheck: p('turnCheck'), hold: p('hold'), llmFirst: p('llmFirst'), ttsFirst: p('ttsFirst') },
        },
        voiceBack: back('voiceBack'),
        pcBack: back('pcBack'),
      };
    };
    const today = this.day(t);
    const month = today.slice(0, 7);
    const sum = (pick: (d: string) => boolean) => {
      const out = { tavily: 0, tavilyFailed: 0, groq: 0, groqFailed: 0 };
      for (const [d, v] of Object.entries(this.days)) {
        if (!pick(d)) continue;
        out.tavily += v[0];
        out.tavilyFailed += v[1];
        out.groq += v[2];
        out.groqFailed += v[3];
      }
      return out;
    };
    return {
      since: new Date(this.since).toISOString(),
      day: view(this.hourly.window(t, 24)),
      week: view(this.daily.window(t, 7)),
      calls: { today: sum((d) => d === today), month: sum((d) => d.startsWith(month)) },
      voiceDownForS: this.voiceDownSince === undefined ? null : Math.round((t - this.voiceDownSince) / 1000),
      pcsOnline: [...this.pcs.values()].filter((e) => e.live > 0).length,
      errors: [...this.errors].reverse().map((e) => ({ ...e, at: new Date(e.t).toISOString() })),
      restarts: [...this.restarts].reverse().map((r) => ({ ...r, at: new Date(r.t).toISOString() })),
    };
  }

  /** Memory held: the fixed arrays exactly, the rings at their largest. */
  bytes(): { fixed: number; ringsMax: number } {
    const fixed = this.hourly.bytes() + this.daily.bytes();
    // A JS string is 2 bytes a character at most; an object about 80 bytes.
    const entry = 80 + 2 * (TEXT * 2 + 40);
    const ringsMax = (MAX_ERRORS + MAX_RESTARTS) * entry + MAX_PCS * (80 + 2 * 64) + MAX_DAYS * (80 + 4 * 8 + 2 * 10);
    return { fixed, ringsMax };
  }
}
