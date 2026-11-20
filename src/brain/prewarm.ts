// Cache warm-up. Claude caches the tools and the stable prompt for five
// minutes from the last request that used them, and people talk to her in
// bursts with long gaps, so most first questions find the cache expired and
// pay for writing it again before their first word. When someone has just
// spoken to her and the words still go to the cloud listen (or push-to-talk
// is held), a `max_tokens: 0` request writes the prefix meanwhile, and the
// answer a moment later reads it.
//
// At most one warm-up per prefix is in flight; none is sent while the prefix
// is known to be warm, past the hourly cap, or past the spend caps. A failed
// or stopped warm-up never counts as warm and never throws. What it bills
// goes to `onUsage` like any other model call.

import { createHash } from 'node:crypto';
import type { ChatMessage, LlmProvider, ToolSpec, WarmUsage } from '../core/interfaces.js';
import { LlmHttpError } from './openai-compatible.js';

export interface WarmerOptions {
  /** Off: never sends anything. */
  enabled: boolean;
  /** Warm-ups allowed in any hour (a run of false wakes costs at most this many writes). */
  maxPerHour: number;
  /** How long the provider keeps the prefix after a request that used it starts (Claude: 5 minutes). */
  ttlMs?: number;
  /** Treated as expired this long before the TTL ends: the answer comes a few seconds after the warm-up. */
  marginMs?: number;
  /** A warm-up still out after this is stopped. */
  timeoutMs?: number;
  /** false: the spend caps are reached, send nothing. */
  allowed?: () => boolean;
  /** What a warm-up billed (an estimate when it was stopped partway). */
  onUsage?: (u: WarmUsage) => void;
  log?: { debug(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void };
  now?: () => number;
}

/** The cached part of a request, as the orchestrator sends it. */
export interface Prefix {
  /** Same key, same bytes: model, cached system blocks and tool specs. */
  key: string;
  /** The cached system blocks, then a placeholder user turn. */
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export type WarmResult = 'sent' | 'warm' | 'in-flight' | 'off' | 'unsupported' | 'capped' | 'refused';

/** Read during the warm-up's prefill, never answered. */
export const WARM_PLACEHOLDER = 'warmup';

export function prefixKey(model: string, system: string[], tools: ToolSpec[]): string {
  return createHash('sha256').update(JSON.stringify([model, system, tools])).digest('hex').slice(0, 32);
}

export class CacheWarmer {
  /** Prefix key → when the last request that wrote or read it started. */
  private readonly used = new Map<string, number>();
  private readonly flying = new Map<string, AbortController>();
  /** Every warm-up still out, settled once its cost is in. */
  private readonly settling = new Set<Promise<void>>();
  private closed = false;
  private sent: number[] = [];
  private readonly now: () => number;

  constructor(
    private readonly llm: LlmProvider,
    private readonly o: WarmerOptions,
  ) {
    this.now = o.now ?? Date.now;
  }

  /** Warm the prefix unless there's no need. `build` runs only when the
   *  warmer is on. Returns at once; the request runs in the background. */
  warm(build: () => Prefix, reason: string): WarmResult {
    if (!this.o.enabled || this.closed) return 'off';
    if (!this.llm.warm) return 'unsupported';
    const p = build();
    if (this.flying.has(p.key)) return 'in-flight';
    if (this.isWarm(p.key)) return 'warm';
    const t = this.now();
    this.sent = this.sent.filter((x) => x > t - 3_600_000);
    if (this.sent.length >= this.o.maxPerHour) return 'capped';
    if (this.o.allowed && !this.o.allowed()) return 'refused';
    this.sent.push(t);
    const ctl = new AbortController();
    this.flying.set(p.key, ctl);
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 5_000);
    const t0 = performance.now();
    const run: Promise<void> = this.llm
      .warm(p.messages, { tools: p.tools, signal: ctl.signal })
      .then(
        (u) => {
          this.note(p.key, performance.now() - t0);
          this.o.onUsage?.(u);
          this.o.log?.debug('cache warm', { reason, ms: Math.round(performance.now() - t0), written: u.cacheWriteTokens, read: u.cachedTokens });
        },
        (e: Error) => {
          // An HTTP error bills nothing. Stopped or cut off, the prefill may
          // still have run: count it as a full write, which errs high.
          if (!(e instanceof LlmHttpError)) {
            const written = Math.ceil(JSON.stringify([p.messages, p.tools]).length / 4);
            this.o.onUsage?.({ inputTokens: written, cachedTokens: 0, cacheWriteTokens: written, outputTokens: 0 });
          }
          this.o.log?.warn('cache warm failed', { reason, ms: Math.round(performance.now() - t0), error: e.message.slice(0, 200) });
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (this.flying.get(p.key) === ctl) this.flying.delete(p.key);
        this.settling.delete(run);
      });
    this.settling.add(run);
    return 'sent';
  }

  /** A request that started `agoMs` ago wrote or read the prefix. */
  note(key: string, agoMs = 0): void {
    const at = this.now() - agoMs;
    if (at > (this.used.get(key) ?? -Infinity)) this.used.set(key, at);
  }

  isWarm(key: string): boolean {
    const last = this.used.get(key);
    return last !== undefined && this.now() - last < (this.o.ttlMs ?? 300_000) - (this.o.marginMs ?? 30_000);
  }

  /** Shutdown: send no more, stop any warm-up still out, and resolve once
   *  what they billed has gone to `onUsage`, so it is in before the spend
   *  file is saved. */
  async close(): Promise<void> {
    this.closed = true;
    for (const ctl of this.flying.values()) ctl.abort();
    this.flying.clear();
    await Promise.allSettled([...this.settling]);
  }
}
