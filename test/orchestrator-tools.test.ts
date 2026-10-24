import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator } from '../src/brain/orchestrator.js';
import { SessionMemory } from '../src/brain/sessions.js';
import type { ChatMessage, LlmEvent, LlmProvider, Tool, ToolSpec } from '../src/core/interfaces.js';

/** Round 1 calls `toolName`; round 2 answers with the tool's result. */
class FakeLlm implements LlmProvider {
  readonly model = 'fake';
  seen: { tools?: string[]; toolChoice?: string; system: { content: string; cache?: boolean }[]; firstUser?: string; cachedHistory?: boolean }[] = [];
  constructor(private readonly toolName: string) {}
  async *stream(messages: ChatMessage[], opts: { tools?: ToolSpec[]; toolChoice?: 'none' }): AsyncIterable<LlmEvent> {
    this.seen.push({
      ...(opts.tools ? { tools: opts.tools.map((t) => t.name) } : {}),
      ...(opts.toolChoice ? { toolChoice: opts.toolChoice } : {}),
      system: messages.filter((m) => m.role === 'system') as { content: string; cache?: boolean }[],
      firstUser: (messages.filter((m) => m.role === 'user').at(-1) as { content: string } | undefined)?.content,
      cachedHistory: messages.some((m) => m.role === 'assistant' && (m as { cache?: boolean }).cache),
    });
    const last = messages[messages.length - 1]!;
    if (last.role === 'tool') {
      yield { type: 'text', delta: `Result: ${last.content.includes('done') ? 'done' : 'failed'}.` };
      return;
    }
    yield { type: 'toolCalls', calls: [{ id: 't1', name: this.toolName, arguments: '{}' }] };
  }
}

const tool = (name: string, waitMs: number, o: Partial<Tool> = {}): Tool => ({
  spec: { name, description: name, parameters: { type: 'object', properties: {} } },
  run: (_a, signal) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => res('done'), waitMs);
      signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))));
    }),
  ...o,
});

async function ask(o: ConversationOrchestrator): Promise<string[]> {
  const out: string[] = [];
  for await (const c of o.ask('u', 'Sean', 'play something', AbortSignal.timeout(5000))) out.push(c);
  return out;
}

const base = { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'UTC', firstEventTimeoutMs: 2000, maxTokens: 200, maxToolRounds: 2 };

describe('tool rounds', () => {
  it('says a tool\'s own confirmation without a second model call, unless it has none', async () => {
    const llm = new FakeLlm('pc_apps');
    const says = new ConversationOrchestrator(llm, new SessionMemory(), [tool('pc_apps', 5, { speak: () => "Spotify's open." })], base);
    expect(await ask(says)).toEqual(["Spotify's open."]);
    expect(llm.seen).toHaveLength(1);
    const llm2 = new FakeLlm('pc_info');
    const asks = new ConversationOrchestrator(llm2, new SessionMemory(), [tool('pc_info', 5, { speak: () => undefined })], base);
    expect(await ask(asks)).toEqual(['Result: done.']);
    expect(llm2.seen).toHaveLength(2);
  });

  it('says a filler line before a slow tool, not before a quick one', async () => {
    const slow = new ConversationOrchestrator(new FakeLlm('play_music'), new SessionMemory(), [tool('play_music', 10, { slow: true })], { ...base, filler: () => 'One sec.' });
    expect(await ask(slow)).toEqual(['One sec.', 'Result: done.']);
    const quick = new ConversationOrchestrator(new FakeLlm('get_time'), new SessionMemory(), [tool('get_time', 10)], { ...base, filler: () => 'One sec.' });
    expect(await ask(quick)).toEqual(['Result: done.']);
  });

  it('gives each tool its own time limit', async () => {
    const short = new ConversationOrchestrator(new FakeLlm('lookup'), new SessionMemory(), [tool('lookup', 120, { timeoutMs: 30 })], base);
    expect(await ask(short)).toEqual(['Result: failed.']);
    const long = new ConversationOrchestrator(new FakeLlm('lookup'), new SessionMemory(), [tool('lookup', 120, { timeoutMs: 1000 })], base);
    expect(await ask(long)).toEqual(['Result: done.']);
  });

  it('with a stable prefix: all tools every round, kept on the last round, and a cached system block first', async () => {
    const llm = new FakeLlm('a');
    const o = new ConversationOrchestrator(llm, new SessionMemory(), [tool('a', 1), tool('b', 1)], {
      ...base,
      maxToolRounds: 1,
      stablePrefix: true,
      selectTools: (_t, _c, all) => all.slice(0, 1), // ignored with a stable prefix
    });
    await ask(o);
    expect(llm.seen[0]).toMatchObject({ tools: ['a', 'b'] });
    expect(llm.seen[1]).toMatchObject({ tools: ['a', 'b'], toolChoice: 'none' }); // last round
    expect(llm.seen[0]!.system[0]!.cache).toBe(true);
    expect(llm.seen[0]!.system[0]!.content).not.toContain('Sean'); // per-request bits stay out of the cached part
    expect(llm.seen[0]!.system).toHaveLength(1); // only the cached block
    expect(llm.seen[0]!.firstUser).toContain('You are talking with Sean'); // per-request part rides with the question
    expect(llm.seen[0]!.firstUser).toContain('play something');
    expect(llm.seen[0]!.system[0]!.content).toBe(llm.seen[1]!.system[0]!.content);
  });

  it('marks the end of the conversation so far for caching, and keeps context out of saved history', async () => {
    const llm = new FakeLlm('a');
    const memory = new SessionMemory();
    const o = new ConversationOrchestrator(llm, memory, [tool('a', 1)], { ...base, stablePrefix: true });
    await ask(o); // first turn: no history yet
    expect(llm.seen[0]!.cachedHistory).toBe(false);
    llm.seen.length = 0;
    await ask(o); // second turn: the first one is history now
    expect(llm.seen[0]!.cachedHistory).toBe(true);
    const saved = memory.history('u').filter((m) => m.role === 'user').map((m) => m.content);
    expect(saved.every((c) => c === 'play something')).toBe(true); // raw words only
  });
});

describe('tools that end the turn', () => {
  it('a sound that played is the whole answer: no words after it', async () => {
    const llm = new FakeLlm('play_sound');
    const o = new ConversationOrchestrator(llm, new SessionMemory(), [tool('play_sound', 1, { endsTurn: true })], { ...base, filler: () => 'One sec.' });
    expect(await ask(o)).toEqual([]); // no filler, no follow-up words
    expect(llm.seen).toHaveLength(1); // and no second model call
  });

  it('if it failed, the model still answers', async () => {
    const o = new ConversationOrchestrator(new FakeLlm('play_sound'), new SessionMemory(), [tool('play_sound', 200, { endsTurn: true, timeoutMs: 20 })], base);
    expect(await ask(o)).toEqual(['Result: failed.']);
  });
});
