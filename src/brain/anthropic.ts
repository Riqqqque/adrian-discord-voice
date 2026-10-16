// Claude through the official Anthropic SDK, behind the same LlmProvider
// interface as the OpenAI-compatible adapter: streamed text, tool calls and
// token usage. The orchestrator keeps running the tool loop.

import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, LlmEvent, LlmProvider, ToolCall, ToolSpec } from '../core/interfaces.js';
import { LlmHttpError } from './openai-compatible.js';

export interface AnthropicOptions {
  model: string;
  apiKey: string;
  /** low | medium | high | xhigh | max. Lower is faster; voice wants low. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** ChatMessage[] → Claude's system + messages. Tool results go back in one
 *  user message per round; assistant turns that called tools are replayed
 *  exactly as Claude sent them (thinking blocks included), which tool use
 *  with thinking requires. */
export function toClaude(messages: ChatMessage[]): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  // One text block per system message; a cache breakpoint after the stable
  // ones (tools and the stable prompt are cached, the per-request part isn't).
  const system: Anthropic.TextBlockParam[] = messages
    .filter((m) => m.role === 'system' && !!m.content)
    .map((m) => {
      const sm = m as { content: string; cache?: boolean };
      return { type: 'text' as const, text: sm.content, ...(sm.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) };
    });
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const raw = m.toolCalls?.[0]?.extra as { claudeContent?: Anthropic.ContentBlockParam[] } | undefined;
      const cc = m.cache ? { cache_control: { type: 'ephemeral' as const } } : {};
      if (raw?.claudeContent) {
        const blocks = [...raw.claudeContent];
        if (m.cache && blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1]!, ...cc } as Anthropic.ContentBlockParam;
        out.push({ role: 'assistant', content: blocks });
      } else if (m.toolCalls?.length) {
        const blocks: Anthropic.ContentBlockParam[] = [
          ...(m.content.trim() ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: safeJson(c.arguments) })),
        ];
        out.push({ role: 'assistant', content: blocks });
      } else if (m.content.trim()) {
        out.push({ role: 'assistant', content: m.cache ? [{ type: 'text', text: m.content, ...cc }] : m.content });
      }
    } else if (m.role === 'tool') {
      const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return { system, messages: out };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class AnthropicLlm implements LlmProvider {
  private readonly client: Anthropic;

  constructor(private readonly o: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: o.apiKey, maxRetries: 0, timeout: 20_000 });
  }

  get model(): string {
    return this.o.model;
  }

  async *stream(messages: ChatMessage[], opts: { tools?: ToolSpec[]; toolChoice?: 'none'; signal?: AbortSignal; maxTokens?: number }): AsyncIterable<LlmEvent> {
    const { system, messages: msgs } = toClaude(messages);
    const tools: Anthropic.Tool[] | undefined = opts.tools?.length
      ? opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }))
      : undefined;
    let stream;
    let final: Anthropic.Message;
    try {
      stream = this.client.messages.stream(
        {
          model: this.o.model,
          // Thinking tokens count against max_tokens, so leave room beyond the spoken answer.
          max_tokens: Math.max(2048, (opts.maxTokens ?? 500) * 4),
          ...(system.length ? { system } : {}),
          messages: msgs,
          ...(tools ? { tools, ...(opts.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}) } : {}),
          output_config: { effort: this.o.effort ?? 'low' },
        },
        { signal: opts.signal },
      );
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield { type: 'text', delta: ev.delta.text };
      }
      final = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        const status = e.status ?? 0;
        throw new LlmHttpError(status || 503, `Claude API ${status}: ${e.message.slice(0, 200)}`);
      }
      throw e;
    }
    const calls: ToolCall[] = final.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
    if (calls.length) {
      // Replay this turn exactly (thinking + tool_use blocks) on the next round.
      calls[0]!.extra = { claudeContent: final.content as unknown as Anthropic.ContentBlockParam[] };
      yield { type: 'toolCalls', calls };
    }
    const u = final.usage;
    yield {
      type: 'usage',
      inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cachedTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      outputTokens: u.output_tokens,
    };
  }
}
