// Primary/secondary LLM: if the primary fails before producing anything
// (rate limit, outage, bad key, network), the same request goes to the
// secondary. Once the primary has streamed an event, its errors propagate:
// switching mid-answer would make Adrian repeat himself.

import type { ChatMessage, LlmEvent, LlmProvider, ToolSpec } from '../core/interfaces.js';

export class FallbackLlm implements LlmProvider {
  constructor(
    private readonly primary: LlmProvider,
    private readonly secondary: LlmProvider,
    private readonly onFallback?: (err: Error) => void,
  ) {}

  get model(): string {
    return this.primary.model;
  }

  async *stream(
    messages: ChatMessage[],
    opts: { tools?: ToolSpec[]; signal?: AbortSignal; maxTokens?: number },
  ): AsyncIterable<LlmEvent> {
    let started = false;
    try {
      for await (const ev of this.primary.stream(messages, opts)) {
        started = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (started || opts.signal?.aborted) throw e;
      this.onFallback?.(e as Error);
    }
    yield* this.secondary.stream(messages, opts);
  }
}
