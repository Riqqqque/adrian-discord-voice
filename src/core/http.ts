// One pool of HTTPS connections to the cloud providers (Claude, Groq,
// Speechify, Tavily). Node's own fetch closes a connection after 4 s idle,
// so nearly every request paid for a new TLS handshake. Here an idle
// connection to a provider stays open for a little less than that provider's
// server keeps it (`IDLE_MS`), and when someone starts talking after a longer
// quiet, `wake()` opens a fresh one to each provider ahead of the request.
//
// A request that went out on a kept-alive connection which broke before any
// answer came back (the server closing it unseen just as it was sent) is
// sent once more, on a new connection. A new connection that breaks is a
// real failure and is left to the caller.

import { Agent, Pool } from 'undici';

/** How long an idle connection stays open, per provider (ms). Measured on
 *  2026-11-20: Cloudflare (Claude, Groq) closes one after 400 s, Tavily after
 *  245 s, Speechify's Google front end after 610 s. A little under each. */
export const IDLE_MS: Record<string, number> = {
  'https://api.anthropic.com': 360_000,
  'https://api.groq.com': 360_000,
  'https://api.speechify.ai': 540_000,
  'https://api.tavily.com': 210_000,
};
/** Anything else (a local model server, say) is left as Node has it: 4 s,
 *  or what the server's Keep-Alive header asks for. */
const OTHER_IDLE_MS = 4_000;
/** `wake()` keeps a provider that isn't registered ready this long after its last use. */
const RECENT_MS = 3_600_000;

/** What a pre-open asks for: a GET without credentials, which every provider
 *  answers at once (401) and which leaves the connection open. HEAD and
 *  unknown paths get `connection: close`. */
const OPEN_PATHS: Record<string, string> = {
  'https://api.anthropic.com': '/v1/models',
  'https://api.groq.com': '/openai/v1/models',
  'https://api.speechify.ai': '/v1/voices',
  'https://api.tavily.com': '/',
};

/** Socket failures that mean the connection broke, not that the server answered. */
const DROPPED = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNABORTED']);

/** fetch reports a broken connection as a TypeError caused by the socket error. */
export function connectionDropped(e: unknown): boolean {
  const code = (e as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return e instanceof TypeError && typeof code === 'string' && DROPPED.has(code);
}

export interface ConnectionsOptions {
  /** Idle limit per origin (ms); default `IDLE_MS`. */
  idleMs?: Record<string, number>;
  /** Idle limit for any other origin (ms). Default: Node's own (4 s, or the server's Keep-Alive hint). */
  otherIdleMs?: number;
  /** HTTP/2 where the server offers it. */
  allowH2?: boolean;
  /** A connection counts as gone this long before its idle limit (ms): `wake()` opens a new one. */
  marginMs?: number;
  /** Longest wait for a pre-open (ms). */
  openTimeoutMs?: number;
  /** Underneath every request (tests, benches); default the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  log?: { debug(msg: string, f?: Record<string, unknown>): void };
}

export class Connections {
  private agent: Agent;
  /** Origin → when a request to it last ended (or started, while it runs). */
  private readonly lastUsed = new Map<string, number>();
  /** Providers kept ready by `wake()` even after a long quiet. */
  private readonly registered = new Set<string>();
  private readonly opening = new Set<string>();
  /** Origin → its pool, to see whether a request goes out on a kept-alive connection. */
  private readonly pools = new Map<string, Pool>();
  private readonly now: () => number;

  constructor(private readonly o: ConnectionsOptions = {}) {
    this.now = o.now ?? Date.now;
    this.agent = this.makeAgent();
  }

  private makeAgent(): Agent {
    return new Agent({
      ...(this.o.allowH2 ? { allowH2: true } : {}),
      factory: (origin, opts) => {
        const key = originOf(String(origin));
        const idle = (key && (this.o.idleMs ?? IDLE_MS)[key]) || this.o.otherIdleMs;
        const pool = new Pool(origin, idle ? { ...opts, keepAliveTimeout: idle, keepAliveMaxTimeout: idle } : opts);
        if (key) this.pools.set(key, pool);
        return pool;
      },
    });
  }

  /** How long an idle connection to this origin stays open (ms). */
  idleFor(url: string): number {
    const origin = originOf(url);
    return (origin && (this.o.idleMs ?? IDLE_MS)[origin]) || (this.o.otherIdleMs ?? OTHER_IDLE_MS);
  }

  private send(input: string | URL | Request, init: RequestInit | undefined, resend: boolean): Promise<Response> {
    const origin = originOf(input);
    const once = async () => {
      const r = await (this.o.fetch ?? globalThis.fetch)(input, { ...init, dispatcher: this.agent } as unknown as RequestInit);
      if (origin) this.lastUsed.set(origin, this.now());
      return r;
    };
    if (origin) this.lastUsed.set(origin, this.now());
    // Only a connection that sat in the pool can have been closed by the
    // server unseen; a new one that breaks is a real failure, left to the caller.
    const kept = !!origin && (this.pools.get(origin)?.stats.free ?? 0) > 0;
    const body = init?.body;
    if (!resend || !kept || body instanceof ReadableStream || input instanceof Request) return once();
    return once().catch((e: unknown) => {
      if (!connectionDropped(e) || init?.signal?.aborted) throw e;
      this.o.log?.debug('kept-alive connection broke; sending again', { origin, error: String((e as { cause?: Error }).cause?.message ?? '') });
      return once();
    });
  }

  /** fetch through the pool. A request that went out on a kept-alive
   *  connection which broke before any answer is sent once more. */
  readonly fetch = ((input: string | URL | Request, init?: RequestInit) => this.send(input, init, true)) as typeof fetch;

  /** fetch through the pool, never sent twice (for a caller with its own retry). */
  readonly fetchOnce = ((input: string | URL | Request, init?: RequestInit) => this.send(input, init, false)) as typeof fetch;

  /** A provider every answer may need (Claude, the cloud listen, the cloud
   *  voice): `wake()` opens a connection to it whenever none is open. Others
   *  (web search) only within an hour of their last use. */
  register(url: string): void {
    const origin = originOf(url);
    if (origin) this.registered.add(origin);
  }

  /** A new stack is starting: it registers the providers it uses again, and
   *  one turned off in the settings stops being opened on every wake. */
  forgetProviders(): void {
    this.registered.clear();
  }

  /** Whether a connection to this origin is probably still open. */
  isOpen(url: string): boolean {
    const origin = originOf(url);
    const last = origin ? this.lastUsed.get(origin) : undefined;
    return last !== undefined && this.now() - last < this.idleFor(url) - (this.o.marginMs ?? 5_000);
  }

  /** Open a connection to this origin now unless one is probably still open.
   *  Never throws; true when it sent a pre-open. */
  preconnect(url: string): boolean {
    const origin = originOf(url);
    if (!origin || this.opening.has(origin) || this.isOpen(origin)) return false;
    this.opening.add(origin);
    const t0 = performance.now();
    void (this.o.fetch ?? globalThis.fetch)(origin + (OPEN_PATHS[origin] ?? '/'), {
      dispatcher: this.agent,
      signal: AbortSignal.timeout(this.o.openTimeoutMs ?? 5_000),
    } as unknown as RequestInit)
      // Read to the end, so the connection goes back to the pool.
      .then((r) => r.arrayBuffer())
      .then(
        () => {
          this.lastUsed.set(origin, this.now());
          this.o.log?.debug('connection opened', { origin, ms: Math.round(performance.now() - t0) });
        },
        () => undefined,
      )
      .finally(() => this.opening.delete(origin));
    return true;
  }

  /** Someone started talking: open a connection to every provider that has
   *  none, so the first request after a quiet spell doesn't wait for one. */
  wake(): void {
    const t = this.now();
    const recent = [...this.lastUsed].filter(([, at]) => t - at < RECENT_MS).map(([o]) => o);
    // Only providers with a known idle limit: a local model server, say, gets nothing.
    const limits = this.o.idleMs ?? IDLE_MS;
    for (const origin of new Set([...this.registered, ...recent])) if (limits[origin]) this.preconnect(origin);
  }

  /** Close every connection (tests; the process ends with them idle anyway). */
  async close(): Promise<void> {
    const a = this.agent;
    this.agent = this.makeAgent();
    this.lastUsed.clear();
    await a.close();
  }
}

function originOf(input: string | URL | Request): string | undefined {
  try {
    return new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin;
  } catch {
    return undefined;
  }
}

/** The process-wide pool every cloud provider uses. */
export const cloud = new Connections();
