// Primary/secondary LLM: if the primary fails before producing anything
// (rate limit, outage, bad key, network) or hangs without answering, the same
// request goes to the secondary. Once the primary has streamed an event, its
// errors propagate: switching mid-answer would make Adrian repeat himself.

import type { ChatMessage, LlmEvent, LlmProvider, ToolSpec } from '../core/interfaces.js';

export class FallbackLlm implements LlmProvider {
  constructor(
    private readonly primary: LlmProvider,
    private readonly secondary: LlmProvider,
    private readonly onFallback?: (err: Error) => void,
    /** No first event from the primary within this → try the secondary (ms). */
    private readonly firstEventMs?: number,
  ) {}

  get model(): string {
    return this.primary.model;
  }

  async *stream(
    messages: ChatMessage[],
    opts: { tools?: ToolSpec[]; signal?: AbortSignal; maxTokens?: number },
  ): AsyncIterable<LlmEvent> {
    let started = false;
    // Only this request is ended by the deadline, not the caller's.
    const stall = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
    const timer = this.firstEventMs ? setTimeout(() => stall.abort(), this.firstEventMs) : undefined;
    try {
      for await (const ev of this.primary.stream(messages, { ...opts, signal })) {
        started = true;
        clearTimeout(timer);
        yield ev;
      }
      return;
    } catch (e) {
      if (started || opts.signal?.aborted) throw e;
      this.onFallback?.(stall.signal.aborted ? new Error(`no first event in ${this.firstEventMs} ms`) : (e as Error));
    } finally {
      clearTimeout(timer);
    }
    yield* this.secondary.stream(messages, opts);
  }
}
