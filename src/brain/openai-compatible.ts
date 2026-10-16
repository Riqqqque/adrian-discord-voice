// LLM provider for any OpenAI-compatible Chat Completions endpoint with
// streaming and tool calls: OpenAI, Gemini (its /v1beta/openai endpoint),
// DeepSeek, Groq, Mistral, or a local server (llama.cpp, vLLM, Ollama).

import type { ChatMessage, LlmEvent, LlmProvider, ToolCall, ToolSpec } from '../core/interfaces.js';

export interface OpenAiCompatibleOptions {
  /** e.g. https://generativelanguage.googleapis.com/v1beta/openai */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Extra body fields some models need (e.g. {"reasoning_effort": "none"}). */
  extraBody?: Record<string, unknown>;
}

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  /** Worth one retry (rate limit or server-side failure). */
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

function wire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
        ...(c.extra !== undefined ? { extra_content: c.extra } : {}),
      })),
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  return { role: m.role, content: m.content };
}

export class OpenAiCompatibleLlm implements LlmProvider {
  readonly model: string;
  private readonly url: string;

  constructor(private readonly o: OpenAiCompatibleOptions) {
    this.model = o.model;
    this.url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  async *stream(
    messages: ChatMessage[],
    opts: { tools?: ToolSpec[]; toolChoice?: 'none'; signal?: AbortSignal; maxTokens?: number },
  ): AsyncIterable<LlmEvent> {
    const body: Record<string, unknown> = {
      model: this.o.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: messages.map(wire),
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.tools?.length && opts.toolChoice !== 'none'
        ? {
            tools: opts.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto',
          }
        : {}),
      ...this.o.extraBody,
    };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new LlmHttpError(res.status, `LLM HTTP ${res.status}: ${text}`);
    }

    const calls = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let v: any;
        try {
          v = JSON.parse(data);
        } catch {
          continue;
        }
        if (v.error) throw new LlmHttpError(500, `LLM error: ${v.error.message ?? 'unknown'}`);
        if (v.usage) {
          yield {
            type: 'usage',
            inputTokens: v.usage.prompt_tokens ?? 0,
            cachedTokens: v.usage.prompt_tokens_details?.cached_tokens ?? 0,
            outputTokens: v.usage.completion_tokens ?? 0,
          };
        }
        const delta = v.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const i: number = tc.index ?? 0;
          const cur = calls.get(i) ?? { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          if (tc.extra_content !== undefined) cur.extra = tc.extra_content;
          calls.set(i, cur);
        }
      }
    }
    if (calls.size) {
      yield {
        type: 'toolCalls',
        calls: [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }))
          .filter((c) => c.name),
      };
    }
  }
}
