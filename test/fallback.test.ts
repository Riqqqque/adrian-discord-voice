import { describe, expect, it } from 'vitest';
import type { LlmEvent, LlmProvider } from '../src/core/interfaces.js';
import { FallbackLlm } from '../src/brain/fallback.js';
import { ConversationOrchestrator } from '../src/brain/orchestrator.js';
import { SessionMemory } from '../src/brain/sessions.js';

const provider = (name: string, events: LlmEvent[], failAfter?: number): LlmProvider => ({
  model: name,
  async *stream() {
    let i = 0;
    for (const e of events) {
      if (failAfter !== undefined && i === failAfter) throw new Error(`${name} failed`);
      i++;
      yield e;
    }
    if (failAfter !== undefined && i === failAfter) throw new Error(`${name} failed`);
  },
});
const collect = async (it: AsyncIterable<LlmEvent>) => {
  const out: string[] = [];
  for await (const e of it) if (e.type === 'text') out.push(e.delta);
  return out;
};

/** Never sends anything, and rejects when its request is aborted (as the real ones do). */
const hanging = (): LlmProvider & { calls: number } => ({
  model: 'hung',
  calls: 0,
  async *stream(_m, opts) {
    this.calls++;
    await new Promise((_, rej) => {
      if (opts.signal?.aborted) rej(new Error('aborted'));
      opts.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
    });
  },
});
const counted = (name: string, events: LlmEvent[]): LlmProvider & { calls: number } => ({
  model: name,
  calls: 0,
  async *stream() {
    this.calls++;
    yield* events;
  },
});
const answer: LlmEvent[] = [{ type: 'text', delta: 'B' }];

describe('fallback LLM', () => {
  it('uses the primary when it works', async () => {
    const f = new FallbackLlm(provider('a', [{ type: 'text', delta: 'A' }]), provider('b', [{ type: 'text', delta: 'B' }]));
    expect(await collect(f.stream([], {}))).toEqual(['A']);
  });

  it('falls back when the primary fails before streaming', async () => {
    let reason = '';
    const f = new FallbackLlm(
      provider('a', [{ type: 'text', delta: 'A' }], 0),
      provider('b', [{ type: 'text', delta: 'B' }]),
      (e) => (reason = e.message),
    );
    expect(await collect(f.stream([], {}))).toEqual(['B']);
    expect(reason).toBe('a failed');
  });

  it('does not switch mid-answer', async () => {
    const f = new FallbackLlm(
      provider('a', [{ type: 'text', delta: 'A1' }, { type: 'text', delta: 'A2' }], 1),
      provider('b', [{ type: 'text', delta: 'B' }]),
    );
    await expect(collect(f.stream([], {}))).rejects.toThrow('a failed');
  });

  it('moves on when the primary hangs, and leaves the request to the secondary', async () => {
    const primary = hanging();
    const secondary = counted('b', answer);
    let reason = '';
    const f = new FallbackLlm(primary, secondary, (e) => (reason = e.message), 20);
    expect(await collect(f.stream([], {}))).toEqual(['B']);
    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(1);
    expect(reason).toMatch(/20 ms/);
  });

  it('a hanging primary reaches the secondary before the answer times out', async () => {
    const primary = hanging();
    const secondary = counted('b', [{ type: 'text', delta: 'From the backup.' }]);
    const brain = new ConversationOrchestrator(new FallbackLlm(primary, secondary, undefined, 30), new SessionMemory(), [], {
      spokenName: 'Adrian',
      writtenName: 'A.D.R.I.A.N.',
      timezone: 'UTC',
      firstEventTimeoutMs: 1000,
      maxTokens: 200,
      maxToolRounds: 1,
    });
    const said: string[] = [];
    for await (const s of brain.ask('u', 'Sean', 'hello', AbortSignal.timeout(5000))) said.push(s);
    expect(said).toEqual(['From the backup.']);
    expect(primary.calls).toBe(1);
  });

  it('a real stop while the primary hangs stays a stop', async () => {
    const primary = hanging();
    const secondary = counted('b', answer);
    const ctl = new AbortController();
    const f = new FallbackLlm(primary, secondary, undefined, 5000);
    setTimeout(() => ctl.abort(), 10);
    await expect(collect(f.stream([], { signal: ctl.signal }))).rejects.toThrow('aborted');
    expect(secondary.calls).toBe(0);
  });

  it('a stop that came before the call stays a stop', async () => {
    const primary = hanging();
    const secondary = counted('b', answer);
    const ctl = new AbortController();
    ctl.abort();
    const f = new FallbackLlm(primary, secondary, undefined, 5000);
    const quick = new Promise((_, rej) => setTimeout(() => rej(new Error('still waiting')), 500));
    await expect(Promise.race([collect(f.stream([], { signal: ctl.signal })), quick])).rejects.toThrow('aborted');
    expect(secondary.calls).toBe(0);
  });

  it('a slow primary that has started keeps going past the limit', async () => {
    const primary: LlmProvider = {
      model: 'a',
      async *stream(_m, opts) {
        yield { type: 'text', delta: 'A1' };
        await new Promise((res, rej) => {
          setTimeout(res, 60);
          opts.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        });
        yield { type: 'text', delta: 'A2' };
      },
    };
    const secondary = counted('b', answer);
    const f = new FallbackLlm(primary, secondary, undefined, 20);
    expect(await collect(f.stream([], {}))).toEqual(['A1', 'A2']);
    expect(secondary.calls).toBe(0);
  });
});
