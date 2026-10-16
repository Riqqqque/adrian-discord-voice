import { describe, expect, it } from 'vitest';
import type { LlmEvent, LlmProvider } from '../src/core/interfaces.js';
import { FallbackLlm } from '../src/brain/fallback.js';

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
});
