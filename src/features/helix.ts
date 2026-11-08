// Client for Helix's token Automation API (POST /api/v1/automation/server and
// the job wait route). Only the bearer token and a JSON content type are sent:
// Helix refuses token requests that carry a Cookie or an Origin header. One
// request at a time, a local rate ceiling far under Helix's 600 a minute, and
// changes are never repeated after a lost answer (Helix may have done them).

export type HelixFailure =
  /** Nothing reached Helix (refused, no route, bad name). */
  | { kind: 'unreachable' }
  /** A change was sent but no answer came back: it may or may not have happened. */
  | { kind: 'lost' }
  /** 401: the token is unknown, expired, revoked, or a password change voided it. */
  | { kind: 'auth' }
  /** 403 from Helix: the server isn't on the token or the token lacks the permission. */
  | { kind: 'denied' }
  /** 429, from Helix or from the local ceiling. */
  | { kind: 'rate'; retryAfterSec: number }
  /** 503 request_capacity_exhausted after a few tries. */
  | { kind: 'busy' }
  /** 503 host_broker_unavailable. */
  | { kind: 'broker' }
  /** 400 broker_operation_rejected: Helix accepted the request but refused the operation. */
  | { kind: 'rejected'; message: string }
  /** 400 invalid_json: this Helix doesn't know the operation or a field. */
  | { kind: 'invalid' }
  /** Not Helix's JSON: the gateway answered (421 wrong Host, 403 client address, 404, 5xx page). */
  | { kind: 'gateway'; status: number }
  | { kind: 'other'; status: number; code: string };

export class HelixError extends Error {
  constructor(readonly failure: HelixFailure) {
    super(`helix ${failure.kind}${'status' in failure ? ` ${failure.status}` : ''}`);
  }
}

export interface HelixJob {
  id?: string;
  kind?: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  stage?: string | null;
  progress_percent?: number | null;
  result?: { instance_id?: string; action?: string; accepted?: boolean; detail?: Record<string, unknown> | null } | null;
  error?: string | null;
  /** Wait route only. */
  finished?: boolean;
}

export interface HelixDetail {
  id?: string;
  name?: string;
  status?: 'online' | 'starting' | 'stopped' | string;
  ready?: boolean;
  busy_with?: string | null;
  players_online?: number;
  max_players?: number;
  pending_changes?: number;
  container_state?: { Status?: string; Running?: boolean; Restarting?: boolean; OOMKilled?: boolean; ExitCode?: number; StartedAt?: string; FinishedAt?: string } | null;
}

export interface HelixClientOptions {
  /** Dashboard address (the gateway), e.g. http://192.168.1.50:3100. */
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** Per request; the gateway gives up at 15 s. */
  timeoutMs?: number;
  /** Local ceiling, requests a minute (Helix allows 600). */
  perMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ERR_INVALID_URL']);
const MAX_BODY = 1 << 20;
const MAX_PAUSE_SEC = 15 * 60;

/** Helix's wait route is capped at 12 s so it stays inside the gateway's 15 s. */
export const MAX_WAIT_SEC = 12;

/** The body as text, or undefined once it passes `max` bytes: read in
 *  pieces and dropped there, so an oversized answer is never held whole. */
export async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

export class HelixClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly perMinute: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** One automation request at a time: Helix runs two across all tokens and refuses a third. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Waits have their own limit of four; two leave room for other tools. */
  private waiting = 0;
  private readonly waitQueue: (() => void)[] = [];
  private readonly sent: number[] = [];
  private pausedUntil = 0;

  constructor(private readonly o: HelixClientOptions) {
    this.base = o.url.replace(/\/+$/, '');
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 14_000;
    this.perMinute = o.perMinute ?? 120;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Run one operation. `changes`: it does something, so a lost answer is
   *  never retried. Reads may be cut short by `signal`; changes never are. */
  run<T = Record<string, unknown>>(body: Record<string, unknown>, changes: boolean, signal?: AbortSignal): Promise<T> {
    const go = this.chain.then(() => this.send<T>('POST', '/api/v1/automation/server', body, changes, signal));
    this.chain = go.catch(() => undefined);
    return go;
  }

  detail(instanceId: string, signal?: AbortSignal): Promise<HelixDetail> {
    return this.run({ operation: 'server_detail', instance_id: instanceId }, false, signal);
  }

  capabilities(instanceId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.run({ operation: 'server_capabilities', instance_id: instanceId }, false, signal);
  }

  /** start, stop or restart: a job. */
  action(instanceId: string, action: 'start' | 'stop' | 'restart'): Promise<{ job_id?: string; reused?: boolean }> {
    return this.run({ operation: 'server_action', instance_id: instanceId, action }, true);
  }

  /** One console line. `changes` false only for commands that just read (list). */
  async console(instanceId: string, command: string, changes: boolean, signal?: AbortSignal): Promise<string> {
    const r = await this.run<{ response?: unknown }>({ operation: 'server_console', instance_id: instanceId, command }, changes, signal);
    return typeof r.response === 'string' ? r.response : '';
  }

  jobStatus(jobId: string, signal?: AbortSignal): Promise<HelixJob> {
    return this.run({ operation: 'job_status', job_id: jobId }, false, signal);
  }

  /** The jobs this token started (newest 256): job and server IDs. */
  async jobs(): Promise<{ job_id: string; server_id: string }[]> {
    const go = this.chain.then(() => this.send<{ jobs?: unknown }>('GET', '/api/v1/automation/jobs', undefined, false));
    this.chain = go.catch(() => undefined);
    const r = await go;
    return Array.isArray(r.jobs) ? r.jobs.filter((j): j is { job_id: string; server_id: string } => !!j && typeof j.job_id === 'string' && typeof j.server_id === 'string') : [];
  }

  /** Wait up to `seconds` (max 12) for a job to finish. Doesn't hold the request line. */
  async waitJob(jobId: string, seconds: number, signal?: AbortSignal): Promise<HelixJob> {
    const s = Math.max(1, Math.min(MAX_WAIT_SEC, Math.round(seconds)));
    while (this.waiting >= 2) await new Promise<void>((r) => this.waitQueue.push(r));
    this.waiting++;
    try {
      return await this.send<HelixJob>('GET', `/api/v1/automation/jobs/${encodeURIComponent(jobId)}/wait?timeout_seconds=${s}`, undefined, false, signal, (s + 4) * 1000);
    } finally {
      this.waiting--;
      this.waitQueue.shift()?.();
    }
  }

  private async send<T>(method: 'GET' | 'POST', path: string, body: unknown, changes: boolean, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const now = this.now();
      if (now < this.pausedUntil) throw new HelixError({ kind: 'rate', retryAfterSec: Math.ceil((this.pausedUntil - now) / 1000) });
      while (this.sent.length && now - this.sent[0]! > 60_000) this.sent.shift();
      if (this.sent.length >= this.perMinute) throw new HelixError({ kind: 'rate', retryAfterSec: Math.ceil((this.sent[0]! + 60_000 - now) / 1000) });
      this.sent.push(now);

      const limit = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await this.f(this.base + path, {
          method,
          // Exactly these: Helix refuses a token request with a Cookie or an Origin.
          headers: { Authorization: `Bearer ${this.o.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // A redirect would carry the token somewhere else.
          redirect: 'manual',
          credentials: 'omit',
          signal: !changes && signal ? AbortSignal.any([limit, signal]) : limit,
        });
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code ?? '';
        if (NOT_SENT.has(code) || !changes) throw new HelixError({ kind: 'unreachable' });
        throw new HelixError({ kind: 'lost' });
      }
      let text: string | undefined;
      try {
        text = await readCapped(res, MAX_BODY);
      } catch {
        if (changes) throw new HelixError({ kind: 'lost' });
        throw new HelixError({ kind: 'unreachable' });
      }
      if (text === undefined) throw new HelixError({ kind: 'other', status: res.status, code: 'too_large' });
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = undefined;
      }
      if (res.status === 200 && json && typeof json === 'object') return json as T;
      const code = json && typeof json === 'object' && typeof (json as { code?: unknown }).code === 'string' ? (json as { code: string }).code : '';
      const message = json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : '';
      const after = Number(res.headers.get('retry-after'));
      const retryAfterSec = Number.isFinite(after) && after > 0 ? Math.min(after, MAX_PAUSE_SEC) : 60;
      if (!code) {
        // A gateway timeout is a lost answer: the request may be running.
        if (changes && (res.status === 504 || res.status === 502)) throw new HelixError({ kind: 'lost' });
        throw new HelixError({ kind: 'gateway', status: res.status });
      }
      if (res.status === 401) throw new HelixError({ kind: 'auth' });
      if (res.status === 403) throw new HelixError({ kind: 'denied' });
      if (res.status === 429) {
        this.pausedUntil = this.now() + retryAfterSec * 1000;
        throw new HelixError({ kind: 'rate', retryAfterSec });
      }
      if (code === 'request_capacity_exhausted') {
        // Refused before Helix looked at it: safe to send again, a few times.
        if (attempt < 3) {
          await this.sleep(Math.min(retryAfterSec, 2) * 1000);
          continue;
        }
        throw new HelixError({ kind: 'busy' });
      }
      if (code === 'host_broker_unavailable') {
        if (!changes && attempt < 1) {
          await this.sleep(2000);
          continue;
        }
        throw new HelixError({ kind: 'broker' });
      }
      if (code === 'broker_operation_rejected') throw new HelixError({ kind: 'rejected', message });
      if (code === 'invalid_json') throw new HelixError({ kind: 'invalid' });
      if (changes && (res.status === 504 || code === 'request_timeout')) throw new HelixError({ kind: 'lost' });
      throw new HelixError({ kind: 'other', status: res.status, code: code.slice(0, 60) });
    }
  }
}
