import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator } from '../src/brain/orchestrator.js';
import { SessionMemory } from '../src/brain/sessions.js';
import type { ChatMessage, LlmEvent, LlmProvider } from '../src/core/interfaces.js';
import { AutoMemory } from '../src/features/automemory.js';
import { UserNotes } from '../src/features/notes.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const base = { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'UTC', firstEventTimeoutMs: 2000, maxTokens: 200, maxToolRounds: 2 };

class FakeLlm implements LlmProvider {
  readonly model = 'fake';
  seen: string[] = [];
  async *stream(messages: ChatMessage[]): AsyncIterable<LlmEvent> {
    this.seen.push(messages.map((m) => m.content).join('\n'));
    yield { type: 'text', delta: 'Okay.' };
  }
}

const say = async (o: ConversationOrchestrator, text: string, place: { guildId?: string; channelId?: string }) => {
  for await (const _ of o.ask('a', 'Sean', text, AbortSignal.timeout(5000), undefined, place)) void _;
};

/** The same brain twice, with DM talk in its own memory. */
function rig() {
  const llm = new FakeLlm();
  const sessions = new SessionMemory();
  return { llm, sessions, open: new ConversationOrchestrator(llm, sessions, [], base), dm: new ConversationOrchestrator(llm, sessions.dms(), [], base) };
}

describe('DM talk', () => {
  it('stays out of what a public answer can see', async () => {
    const r = rig();
    await say(r.dm, 'my landlord is evicting me', { channelId: 'dm1' });
    await say(r.open, 'any weekend ideas', { guildId: 'g', channelId: 'c' });
    expect(r.llm.seen).toHaveLength(2);
    expect(r.llm.seen[1]).not.toContain('landlord');
  });

  it('carries on in the DM', async () => {
    const r = rig();
    await say(r.dm, 'my landlord is evicting me', { channelId: 'dm1' });
    await say(r.dm, 'what should I do', { channelId: 'dm1' });
    expect(r.llm.seen[1]).toContain('landlord');
  });

  it('stays out of a public conversation in the other direction too', async () => {
    const r = rig();
    await say(r.open, 'the plan is pizza', { guildId: 'g', channelId: 'c' });
    await say(r.dm, 'hello', { channelId: 'dm1' });
    expect(r.llm.seen[1]).not.toContain('pizza');
  });

  it('never reaches the automatic memory', async () => {
    const r = rig();
    const seen: string[] = [];
    const llm: LlmProvider = {
      model: 'fake',
      async *stream(messages: ChatMessage[]) {
        seen.push(messages.map((m) => m.content).join('\n'));
        yield { type: 'text', delta: '[]' };
      },
    };
    await say(r.dm, 'my landlord is evicting me', { channelId: 'dm1' });
    await say(r.open, 'any weekend ideas', { guildId: 'g', channelId: 'c' });
    await new AutoMemory(llm, new UserNotes(undefined), r.sessions, log, () => undefined).learn('a', 'Sean');
    expect(seen[0]).toContain('weekend');
    expect(seen[0]).not.toContain('landlord');
  });

  it('goes with "forget everything", said anywhere', async () => {
    const r = rig();
    await say(r.dm, 'my landlord is evicting me', { channelId: 'dm1' });
    await say(r.open, 'any weekend ideas', { guildId: 'g', channelId: 'c' });
    r.sessions.clear('a');
    expect(r.sessions.history('a')).toEqual([]);
    expect(r.sessions.dms().history('a')).toEqual([]);
  });

  it('forgets one person at a time, and goes idle like any other talk', () => {
    let t = 0;
    const sessions = new SessionMemory(8, 1_000, () => t);
    const dms = sessions.dms();
    dms.append('a', { role: 'user', content: 'mine' });
    dms.append('b', { role: 'user', content: 'theirs' });
    dms.clear('a');
    expect(dms.history('a')).toEqual([]);
    expect(dms.history('b')).toHaveLength(1);
    t = 5_000;
    expect(dms.history('b')).toEqual([]);
  });
});
