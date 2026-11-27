// Primary/secondary LLM: if the primary fails before producing anything
// (rate limit, outage, bad key, network), the same request goes to the
// secondary. If it is only slow to start, the secondary is asked too and the
// primary keeps going: whichever sends something first answers, and the other
// is ended. So a secondary that refuses the request (a free tier's size
// limit, say) costs nothing, and a primary that turns up late still answers.
// Once one has streamed an event, its errors propagate: switching mid-answer
// would make Adrian repeat himself.
// A request carrying a picture (pc_screen) gets no stall deadline: the
// upload and the look take longer than text, and the fallback can't see the
// picture, so it would only say it couldn't see the screen. A primary that
// fails outright still falls back; one that hangs is ended by the answer's
// own time limit.

import type { ChatMessage, LlmEvent, LlmProvider, ToolSpec, WarmUsage } from '../core/interfaces.js';

type Next = IteratorResult<LlmEvent>;
/** One model's request: its stream, its own stop, and the next event it's waiting on. */
interface Lane {
  it: AsyncIterator<LlmEvent>;
  stop: AbortController;
  next: Promise<Next>;
  fallback: boolean;
}

export class FallbackLlm implements LlmProvider {
  constructor(
    private readonly primary: LlmProvider,
    private readonly secondary: LlmProvider,
    private readonly onFallback?: (err: Error) => void,
    /** No first event from the primary within this → ask the secondary too (ms). */
    private readonly firstEventMs?: number,
  ) {
    // Only the primary's cache is warmed: answers go there first, and a
    // warm-up that fails never moves to the secondary.
    const p = primary;
    if (p.warm) this.warm = (messages, opts) => p.warm!(messages, opts);
  }

  warm?: (messages: ChatMessage[], opts: { tools?: ToolSpec[]; signal?: AbortSignal }) => Promise<WarmUsage>;

  get model(): string {
    return this.primary.model;
  }

  async *stream(
    messages: ChatMessage[],
    opts: { tools?: ToolSpec[]; signal?: AbortSignal; maxTokens?: number },
  ): AsyncIterable<LlmEvent> {
    const open = (p: LlmProvider, fallback: boolean): Lane => {
      const stop = new AbortController();
      const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
      const it = p.stream(messages, { ...opts, signal })[Symbol.asyncIterator]();
      return { it, stop, next: it.next(), fallback };
    };
    const end = (l: Lane) => {
      l.stop.abort();
      l.next.catch(() => {});
      void l.it.return?.()?.catch(() => {});
    };
    const picture = messages.some((m) => m.role === 'tool' && !!m.image);
    const first = open(this.primary, false);
    let lanes: Lane[] = [first];
    let winner: Lane | undefined;
    let first1: Next | undefined;
    let lastError: unknown;
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = this.firstEventMs && !picture ? new Promise<'stall'>((res) => (timer = setTimeout(() => res('stall'), this.firstEventMs))) : undefined;
    try {
      // Until one of them sends something.
      while (!winner) {
        if (!lanes.length) throw lastError;
        const races: Promise<{ lane: Lane; r?: Next; e?: unknown } | 'stall'>[] = lanes.map((lane) =>
          lane.next.then(
            (r) => ({ lane, r }),
            (e: unknown) => ({ lane, e }),
          ),
        );
        if (stall && !stalled) races.push(stall);
        const got = await Promise.race(races);
        if (got === 'stall') {
          stalled = true;
          if (opts.signal?.aborted) continue;
          this.onFallback?.(new Error(`no first event in ${this.firstEventMs} ms; asking the fallback too`));
          lanes.push(open(this.secondary, true));
          continue;
        }
        if (got.e !== undefined || got.r === undefined) {
          if (opts.signal?.aborted) throw got.e;
          lastError = got.e;
          lanes = lanes.filter((l) => l !== got.lane);
          // The primary failed outright: the secondary is next, if it isn't asked yet.
          if (!got.lane.fallback && !lanes.length) {
            clearTimeout(timer);
            stalled = true;
            this.onFallback?.(got.e as Error);
            lanes.push(open(this.secondary, true));
          }
          continue;
        }
        winner = got.lane;
        first1 = got.r;
      }
    } finally {
      clearTimeout(timer);
      for (const l of lanes) if (l !== winner) end(l);
    }
    // Marked, so what the secondary read from its own cache isn't taken as
    // the primary's cache being warm.
    const w = winner!;
    const mark = (ev: LlmEvent): LlmEvent => (w.fallback && ev.type === 'usage' ? { ...ev, fallback: true } : ev);
    let done = false;
    try {
      for (let r = first1!; !r.done; r = await w.it.next()) yield mark(r.value);
      done = true;
    } finally {
      // Cut short (the caller stopped reading): end its request too.
      if (!done) w.stop.abort();
    }
  }
}
