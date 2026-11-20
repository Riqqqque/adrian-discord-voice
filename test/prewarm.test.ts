import { describe, expect, it, vi } from 'vitest';
import { AnthropicLlm, toClaude } from '../src/brain/anthropic.js';
import { FallbackLlm } from '../src/brain/fallback.js';
import { LlmHttpError } from '../src/brain/openai-compatible.js';
import { ConversationOrchestrator } from '../src/brain/orchestrator.js';
import { CacheWarmer, type Prefix, prefixKey, WARM_PLACEHOLDER } from '../src/brain/prewarm.js';
import { SessionMemory } from '../src/brain/sessions.js';
import { timeTool } from '../src/brain/tools.js';
import { PocConfigSchema } from '../src/config.js';
import type { ChatMessage, LlmEvent, LlmProvider, ToolSpec, WarmUsage } from '../src/core/interfaces.js';

const WROTE: WarmUsage = { inputTokens: 1_010, cachedTokens: 0, cacheWriteTokens: 1_000, outputTokens: 0 };
const flush = () => new Promise((r) => setTimeout(r, 0));

/** An LLM whose warm-ups wait for `release()` (or `fail()`), and whose answers read the cache. */
function fakeLlm() {
  const warms: { messages: ChatMessage[]; tools?: ToolSpec[]; signal?: AbortSignal; resolve: (u: WarmUsage) => void; reject: (e: Error) => void }[] = [];
  const asks: { messages: ChatMessage[]; tools?: ToolSpec[] }[] = [];
  const llm: LlmProvider & { warm: NonNullable<LlmProvider['warm']> } = {
    model: 'claude-test',
    warm: vi.fn(
      (messages: ChatMessage[], opts: { tools?: ToolSpec[]; signal?: AbortSignal }) =>
        new Promise<WarmUsage>((resolve, reject) => {
          warms.push({ messages, ...opts, resolve, reject });
          opts.signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')), { once: true });
        }),
    ),
    async *stream(messages, opts): AsyncIterable<LlmEvent> {
      asks.push({ messages, ...(opts.tools ? { tools: opts.tools } : {}) });
      yield { type: 'text', delta: 'Canberra.' };
      yield { type: 'usage', inputTokens: 1_100, cachedTokens: 1_000, cacheWriteTokens: 0, outputTokens: 3 };
    },
  };
  return { llm, warms, asks };
}

const prefix = (key = 'k1'): Prefix => ({ key, messages: [{ role: 'system', content: 'rules', cache: true }, { role: 'user', content: WARM_PLACEHOLDER }], tools: [] });

describe('CacheWarmer', () => {
  it('sends nothing when it is off, and does not even build the prefix', () => {
    const { llm } = fakeLlm();
    const build = vi.fn(() => prefix());
    const w = new CacheWarmer(llm, { enabled: false, maxPerHour: 20 });
    expect(w.warm(build, 'heard')).toBe('off');
    expect(build).not.toHaveBeenCalled();
    expect(llm.warm).not.toHaveBeenCalled();
  });

  it('says unsupported for a provider without a cache', () => {
    const plain: LlmProvider = { model: 'x', stream: fakeLlm().llm.stream };
    expect(new CacheWarmer(plain, { enabled: true, maxPerHour: 20 }).warm(() => prefix(), 'heard')).toBe('unsupported');
  });

  it('keeps one warm-up in flight per prefix, then skips while the prefix is warm', async () => {
    let now = 1_000_000;
    const { llm, warms } = fakeLlm();
    const onUsage = vi.fn();
    const w = new CacheWarmer(llm, { enabled: true, maxPerHour: 20, onUsage, now: () => now });
    expect(w.warm(() => prefix(), 'heard')).toBe('sent');
    expect(w.warm(() => prefix(), 'ptt')).toBe('in-flight');
    expect(w.warm(() => prefix('other'), 'heard')).toBe('sent'); // another prefix is its own
    expect(llm.warm).toHaveBeenCalledTimes(2);
    warms[0]!.resolve(WROTE);
    await flush();
    expect(onUsage).toHaveBeenCalledWith(WROTE);
    expect(w.warm(() => prefix(), 'heard')).toBe('warm');
    now += 269_000; // under the 5-minute TTL less the 30 s margin
    expect(w.warm(() => prefix(), 'heard')).toBe('warm');
    now += 2_000;
    expect(w.warm(() => prefix(), 'heard')).toBe('sent');
    expect(llm.warm).toHaveBeenCalledTimes(3);
  });

  it('a failed or stopped warm-up is not warm, and a stopped one counts its estimated cost', async () => {
    const { llm, warms } = fakeLlm();
    const onUsage = vi.fn();
    const warn = vi.fn();
    const w = new CacheWarmer(llm, { enabled: true, maxPerHour: 20, onUsage, log: { debug() {}, warn } });
    expect(w.warm(() => prefix(), 'heard')).toBe('sent');
    warms[0]!.reject(new LlmHttpError(529, 'Claude API 529: overloaded'));
    await flush();
    expect(onUsage).not.toHaveBeenCalled(); // an HTTP error bills nothing
    expect(warn).toHaveBeenCalledWith('cache warm failed', expect.objectContaining({ reason: 'heard' }));
    expect(w.warm(() => prefix(), 'heard')).toBe('sent');
    warms[1]!.reject(new Error('socket hang up'));
    await flush();
    expect(onUsage).toHaveBeenCalledTimes(1);
    const est = onUsage.mock.calls[0]![0] as WarmUsage;
    expect(est.cacheWriteTokens).toBeGreaterThan(0);
    expect(est.outputTokens).toBe(0);
    expect(w.isWarm('k1')).toBe(false);
  });

  it('stops a warm-up that takes too long', async () => {
    const { llm, warms } = fakeLlm();
    const onUsage = vi.fn();
    const w = new CacheWarmer(llm, { enabled: true, maxPerHour: 20, timeoutMs: 20, onUsage });
    w.warm(() => prefix(), 'heard');
    await new Promise((r) => setTimeout(r, 60));
    expect(warms[0]!.signal?.aborted).toBe(true);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(w.isWarm('k1')).toBe(false);
    expect(w.warm(() => prefix(), 'heard')).toBe('sent'); // not stuck in flight
  });

  it('close() stops what is in flight', async () => {
    const { llm, warms } = fakeLlm();
    const w = new CacheWarmer(llm, { enabled: true, maxPerHour: 20 });
    w.warm(() => prefix(), 'heard');
    w.close();
    expect(warms[0]!.signal?.aborted).toBe(true);
    await flush();
    expect(w.isWarm('k1')).toBe(false);
  });

  it('caps warm-ups per hour and respects the spend caps', async () => {
    let now = 5_000_000;
    let allowed = true;
    const { llm, warms } = fakeLlm();
    const w = new CacheWarmer(llm, { enabled: true, maxPerHour: 2, allowed: () => allowed, now: () => now });
    for (const k of ['a', 'b']) {
      expect(w.warm(() => prefix(k), 'heard')).toBe('sent');
    }
    expect(w.warm(() => prefix('c'), 'heard')).toBe('capped');
    for (const x of warms) x.reject(new LlmHttpError(500, 'x'));
    await flush();
    now += 3_600_001;
    allowed = false;
    expect(w.warm(() => prefix('c'), 'heard')).toBe('refused');
    allowed = true;
    expect(w.warm(() => prefix('c'), 'heard')).toBe('sent');
    expect(llm.warm).toHaveBeenCalledTimes(3);
  });
});

describe('orchestrator prewarm', () => {
  const opts = { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'America/Denver', firstEventTimeoutMs: 1_000, maxTokens: 200, maxToolRounds: 2, stablePrefix: true, stableLines: ['A cached rule.'] };

  it('warms exactly the prefix an answer sends', async () => {
    const { llm, warms, asks } = fakeLlm();
    const warmer = new CacheWarmer(llm, { enabled: true, maxPerHour: 20 });
    const tools = [timeTool('America/Denver')];
    const o = new ConversationOrchestrator(llm, new SessionMemory(), tools, { ...opts, warmer });
    expect(o.prewarm('heard')).toBe('sent');
    const sent = warms[0]!;
    // The placeholder turn follows the cached system block and is never answered.
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: WARM_PLACEHOLDER });
    sent.reject(new LlmHttpError(500, 'x')); // not warm: the answer below is a cold one
    await flush();
    for await (const _ of o.ask('u1', 'Sam', 'capital of australia?', new AbortController().signal)) void _;
    const ask = asks[0]!;
    expect(toClaude(sent.messages).system).toEqual(toClaude(ask.messages).system);
    expect(sent.tools).toEqual(ask.tools);
    expect(prefixKey('claude-test', [sent.messages[0]!.content], sent.tools ?? [])).toBe(prefixKey('claude-test', [ask.messages[0]!.content], ask.tools ?? []));
  });

  it('an answer that read the cache makes the next warm-up unnecessary', async () => {
    const { llm } = fakeLlm();
    const warmer = new CacheWarmer(llm, { enabled: true, maxPerHour: 20 });
    const o = new ConversationOrchestrator(llm, new SessionMemory(), [timeTool('America/Denver')], { ...opts, warmer });
    const dm = new ConversationOrchestrator(llm, new SessionMemory(), [timeTool('America/Denver')], { ...opts, warmer });
    for await (const _ of dm.ask('u1', 'Sam', 'hi', new AbortController().signal, undefined, undefined, { text: true })) void _;
    expect(o.prewarm('heard')).toBe('warm'); // shared warmer, same prefix
    expect(llm.warm).not.toHaveBeenCalled();
  });

  it('a new tool (a home server joining) is a new prefix', async () => {
    const { llm } = fakeLlm();
    const warmer = new CacheWarmer(llm, { enabled: true, maxPerHour: 20 });
    const tools = [timeTool('America/Denver')];
    const o = new ConversationOrchestrator(llm, new SessionMemory(), tools, { ...opts, warmer });
    for await (const _ of o.ask('u1', 'Sam', 'hi', new AbortController().signal)) void _;
    expect(o.prewarm('heard')).toBe('warm');
    tools.push({ ...timeTool('America/Denver'), spec: { ...timeTool('America/Denver').spec, name: 'lights' } });
    expect(o.prewarm('heard')).toBe('sent');
  });

  it('sends nothing without a warmer or without the stable prefix', () => {
    const { llm } = fakeLlm();
    expect(new ConversationOrchestrator(llm, new SessionMemory(), [], opts).prewarm('heard')).toBe('off');
    const warmer = new CacheWarmer(llm, { enabled: true, maxPerHour: 20 });
    expect(new ConversationOrchestrator(llm, new SessionMemory(), [], { ...opts, stablePrefix: false, warmer }).prewarm('heard')).toBe('off');
    expect(llm.warm).not.toHaveBeenCalled();
  });
});

describe('warm-ups on the providers', () => {
  it('the fallback warms only the primary, and never falls back', async () => {
    const a = fakeLlm();
    const b = fakeLlm();
    const f = new FallbackLlm(a.llm, b.llm);
    const run = f.warm!(prefix().messages, { tools: [] });
    a.warms[0]!.reject(new LlmHttpError(529, 'overloaded'));
    await expect(run).rejects.toThrow('overloaded');
    expect(b.llm.warm).not.toHaveBeenCalled();
    expect(new FallbackLlm({ model: 'x', stream: a.llm.stream }, b.llm).warm).toBeUndefined();
  });

  it("Claude's warm-up is the answer's request with max_tokens 0 and the placeholder turn", async () => {
    const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: 'test', effort: 'low' });
    const client = (llm as unknown as { client: { messages: { create: unknown; stream: unknown } } }).client;
    const bodies: Record<string, unknown>[] = [];
    client.messages.create = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return { usage: { input_tokens: 9, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 0, output_tokens: 0 }, content: [] };
    });
    client.messages.stream = vi.fn((body: Record<string, unknown>) => {
      bodies.push(body);
      return {
        async *[Symbol.asyncIterator]() {},
        finalMessage: async () => ({ content: [], usage: { input_tokens: 9, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, output_tokens: 2 } }),
      };
    });
    const tools: ToolSpec[] = [timeTool('America/Denver').spec];
    const stable: ChatMessage = { role: 'system', content: 'rules', cache: true };
    const u = await llm.warm([stable, { role: 'user', content: WARM_PLACEHOLDER }], { tools });
    expect(u).toEqual({ inputTokens: 1_009, cachedTokens: 0, cacheWriteTokens: 1_000, outputTokens: 0 });
    for await (const _ of llm.stream([stable, { role: 'user', content: '[This turn]\nYou are talking with Sam.\n\nhi' }], { tools, maxTokens: 200 })) void _;
    const [warm, answer] = bodies as [Record<string, unknown>, Record<string, unknown>];
    expect(warm.max_tokens).toBe(0);
    expect(warm.messages).toEqual([{ role: 'user', content: WARM_PLACEHOLDER }]);
    const same = (b: Record<string, unknown>) => ({ ...b, max_tokens: undefined, messages: undefined });
    expect(same(warm)).toEqual(same(answer)); // model, system (with its breakpoint), tools, effort
    expect('stream' in warm).toBe(false);
  });
});

describe('config', () => {
  it('warm-ups are on by default and can be turned off', () => {
    const base = { guildId: '123456789012345678', channelId: '223456789012345678', testClip: 'assets/test-clip.ogg', secretsFile: '/tmp/s.env' };
    const brain = { provider: 'anthropic', model: 'claude-haiku-5-5' };
    expect(PocConfigSchema.parse({ ...base, brain }).brain?.prewarm).toEqual({ enabled: true, maxPerHour: 20 });
    expect(PocConfigSchema.parse({ ...base, brain: { ...brain, prewarm: { enabled: false } } }).brain?.prewarm).toEqual({ enabled: false, maxPerHour: 20 });
  });
});
