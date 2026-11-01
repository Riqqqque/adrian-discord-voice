import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator, type Usage } from '../src/brain/orchestrator.js';
import { LlmHttpError } from '../src/brain/openai-compatible.js';
import { SessionMemory } from '../src/brain/sessions.js';
import type { ChatMessage, LlmEvent, LlmProvider, Tool, ToolSpec } from '../src/core/interfaces.js';
import { Reminders } from '../src/features/reminders.js';

/** Round 1 calls `toolName`; round 2 answers with the tool's result. */
class FakeLlm implements LlmProvider {
  readonly model = 'fake';
  seen: { tools?: string[]; toolChoice?: string; system: { content: string; cache?: boolean }[]; firstUser?: string; cachedHistory?: boolean }[] = [];
  constructor(
    private readonly toolName: string,
    private readonly args = '{}',
  ) {}
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
    yield { type: 'toolCalls', calls: [{ id: 't1', name: this.toolName, arguments: this.args }] };
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

  it('passes the asker to speak', async () => {
    let who: string | undefined;
    const speak: Tool['speak'] = (_a, _r, ctx) => {
      who = ctx.userId;
      return 'Done.';
    };
    await ask(new ConversationOrchestrator(new FakeLlm('pc_apps'), new SessionMemory(), [tool('pc_apps', 1, { speak })], base));
    expect(who).toBe('u');
  });

  it('a timer confirms itself; a refused one goes back to the model', async () => {
    const tools = () => new Reminders(undefined, 'UTC', () => {}).tools();
    const ok = new FakeLlm('set_timer', '{"minutes":5}');
    expect(await ask(new ConversationOrchestrator(ok, new SessionMemory(), tools(), base))).toEqual(['Timer set for 5 minutes.']);
    expect(ok.seen).toHaveLength(1);
    const refused = new FakeLlm('set_timer');
    await ask(new ConversationOrchestrator(refused, new SessionMemory(), tools(), base));
    expect(refused.seen).toHaveLength(2);
    const other = new FakeLlm('set_timer', '{"minutes":5}');
    await ask(new ConversationOrchestrator(other, new SessionMemory(), new Reminders(undefined, 'UTC', () => {}).tools(() => false), base));
    expect(other.seen).toHaveLength(2); // only the model can say it in their language
  });

  it('says a filler line before a slow tool, not before a quick one', async () => {
    const slow = new ConversationOrchestrator(new FakeLlm('play_music'), new SessionMemory(), [tool('play_music', 30, { slow: true })], { ...base, filler: () => 'One sec.', fillerAfterMs: 1 });
    expect(await ask(slow)).toEqual(['One sec.', 'Result: done.']);
    const fast = new ConversationOrchestrator(new FakeLlm('play_music'), new SessionMemory(), [tool('play_music', 1, { slow: true })], { ...base, filler: () => 'One sec.', fillerAfterMs: 200 });
    expect(await ask(fast)).toEqual(['Result: done.']);
    const quick = new ConversationOrchestrator(new FakeLlm('get_time'), new SessionMemory(), [tool('get_time', 10)], { ...base, filler: () => 'One sec.' });
    expect(await ask(quick)).toEqual(['Result: done.']);
  });

  it('an empty line from a tool means nothing more is said', async () => {
    const llm = new FakeLlm('play_music');
    const o = new ConversationOrchestrator(llm, new SessionMemory(), [tool('play_music', 1, { speak: () => '' })], base);
    expect(await ask(o)).toEqual([]);
    expect(llm.seen).toHaveLength(1);
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

describe('a stop', () => {
  /** Round 1 asks for each named tool; later rounds answer. */
  class Scripted implements LlmProvider {
    readonly model = 'fake';
    calls = 0;
    constructor(private readonly names: string[]) {}
    async *stream(): AsyncIterable<LlmEvent> {
      if (++this.calls > 1) {
        yield { type: 'text', delta: 'Answer.' };
        return;
      }
      yield { type: 'toolCalls', calls: this.names.map((name, i) => ({ id: `t${i}`, name, arguments: '{}' })) };
      yield { type: 'usage', inputTokens: 1000, cachedTokens: 0, outputTokens: 100 };
    }
  }
  const run = async (o: ConversationOrchestrator, signal: AbortSignal, onUsage?: (u: Usage) => void) => {
    for await (const _ of o.ask('u', 'Sean', 'do both', signal, onUsage));
  };

  it('during a tool ends the answer: no next tool, no next model call', async () => {
    const llm = new Scripted(['first', 'second']);
    let second = 0;
    const o = new ConversationOrchestrator(llm, new SessionMemory(), [tool('first', 1000), { ...tool('second', 1), run: async () => (second++, 'done') }], base);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    await expect(run(o, ctl.signal)).rejects.toThrow('cancelled');
    expect(llm.calls).toBe(1);
    expect(second).toBe(0);
  });

  it('during the wait before a retry sends nothing more', async () => {
    let calls = 0;
    const llm: LlmProvider = {
      model: 'fake',
      async *stream() {
        calls++;
        throw new LlmHttpError(503, 'busy');
      },
    };
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    await expect(run(new ConversationOrchestrator(llm, new SessionMemory(), [], base), ctl.signal)).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });

  it("doesn't wait for a tool that ignores it, and still reports the round already paid for", async () => {
    let release!: (v: string) => void;
    const stuck = new Promise<string>((r) => (release = r));
    const o = new ConversationOrchestrator(new Scripted(['pc_info']), new SessionMemory(), [{ ...tool('pc_info', 1), run: () => stuck }], base);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    let usage: Usage | undefined;
    await expect(run(o, ctl.signal, (u) => (usage = u))).rejects.toThrow('cancelled');
    release('done'); // the answer ended while the tool was still out
    expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
  });

  /** Says `said`, then hangs until stopped; `before` is a round that comes first. */
  const cutOff = (said: string, before?: LlmEvent[]): LlmProvider => ({
    model: 'fake',
    async *stream(_m, opts) {
      if (before) {
        const events = before;
        before = undefined;
        yield* events;
        return;
      }
      yield { type: 'text', delta: said };
      await new Promise((_, rej) => opts.signal!.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
    },
  });

  it('partway through a stream counts an estimate, since usage never arrives', async () => {
    const o = new ConversationOrchestrator(cutOff('x'.repeat(400)), new SessionMemory(), [], base);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    let usage: Usage | undefined;
    await expect(run(o, ctl.signal, (u) => (usage = u))).rejects.toThrow();
    expect(usage!.outputTokens).toBe(100); // about four characters a token
    expect(usage!.inputTokens).toBeGreaterThan(100); // the prompt itself
  });

  it('adds that estimate to what the rounds before it really cost', async () => {
    const round: LlmEvent[] = [
      { type: 'toolCalls', calls: [{ id: 't1', name: 'lookup', arguments: '{}' }] },
      { type: 'usage', inputTokens: 1000, cachedTokens: 0, outputTokens: 100 },
    ];
    const o = new ConversationOrchestrator(cutOff('x'.repeat(40), round), new SessionMemory(), [tool('lookup', 1)], base);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    let usage: Usage | undefined;
    await expect(run(o, ctl.signal, (u) => (usage = u))).rejects.toThrow();
    expect(usage!.outputTokens).toBe(110);
    expect(usage!.inputTokens).toBeGreaterThan(1000);
  });

  it("doesn't estimate a round that already reported its usage", async () => {
    const llm: LlmProvider = {
      model: 'fake',
      async *stream(_m, opts) {
        yield { type: 'text', delta: 'x'.repeat(400) };
        yield { type: 'usage', inputTokens: 1000, cachedTokens: 0, outputTokens: 100 };
        await new Promise((_, rej) => opts.signal!.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
      },
    };
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    let usage: Usage | undefined;
    await expect(run(new ConversationOrchestrator(llm, new SessionMemory(), [], base), ctl.signal, (u) => (usage = u))).rejects.toThrow();
    expect(usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
  });

  it("estimates nothing for a model error: that wasn't a stop, and it isn't charged", async () => {
    const llm: LlmProvider = {
      model: 'fake',
      async *stream() {
        throw new LlmHttpError(400, 'bad request');
      },
    };
    let usage: Usage | undefined;
    await expect(run(new ConversationOrchestrator(llm, new SessionMemory(), [], base), new AbortController().signal, (u) => (usage = u))).rejects.toThrow('bad request');
    expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});
