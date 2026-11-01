import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator } from '../src/brain/orchestrator.js';
import type { ChatMessage, LlmProvider } from '../src/core/interfaces.js';
import { SessionMemory } from '../src/brain/sessions.js';
import { AutoMemory, parseFacts } from '../src/features/automemory.js';
import { UserNotes } from '../src/features/notes.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const fakeLlm = (reply: string): LlmProvider => ({
  model: 'fake',
  async *stream() {
    yield { type: 'text', delta: reply };
    yield { type: 'usage', inputTokens: 300, cachedTokens: 0, outputTokens: 20 };
  },
});
/** A model that saves whatever it can still find in what it's given. */
const replaysCancun = (seen: string[] = []): LlmProvider => ({
  model: 'fake',
  async *stream(messages: ChatMessage[]) {
    const all = messages.map((m) => m.content).join('\n');
    seen.push(all);
    yield { type: 'text', delta: /Conversation:[\s\S]*Cancun/.test(all) ? '["flying to Cancun on Friday"]' : '[]' };
  },
});
const base = { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'UTC', firstEventTimeoutMs: 2000, maxTokens: 200, maxToolRounds: 2 };
/** A real turn in which the model calls forget, and the tool has the last word. */
async function saysForget(notes: UserNotes, sessions: SessionMemory, what: string) {
  const llm: LlmProvider = {
    model: 'fake',
    async *stream() {
      yield { type: 'toolCalls', calls: [{ id: 't1', name: 'forget', arguments: JSON.stringify({ what }) }] };
    },
  };
  const o = new ConversationOrchestrator(llm, sessions, notes.tools(), base);
  const said: string[] = [];
  for await (const c of o.ask('a', 'Sean', 'forget everything about me', AbortSignal.timeout(5000), undefined, { channelId: 'dm1' })) said.push(c);
  return said;
}

describe('automatic memory', () => {
  it('parses facts from a model reply, ignoring junk', () => {
    expect(parseFacts('Sure! ["plays Minecraft with Sam", "has a dog named Biscuit"]')).toEqual(['plays Minecraft with Sam', 'has a dog named Biscuit']);
    expect(parseFacts('[]')).toEqual([]);
    expect(parseFacts('no json here')).toEqual([]);
    expect(parseFacts('["a", 5, "likes pizza"]')).toEqual(['likes pizza']);
  });

  it('learns every few exchanges into that person\'s own notes, and counts the cost', async () => {
    const sessions = new SessionMemory();
    const notes = new UserNotes(undefined);
    let cost = 0;
    const am = new AutoMemory(fakeLlm('["has a dog named Biscuit"]'), notes, sessions, log, (i, o) => (cost += i + o), 2);
    sessions.append('a', { role: 'user', content: 'my dog Biscuit just ate my sandwich' });
    sessions.append('a', { role: 'assistant', content: 'Biscuit is a menace.' });
    am.afterTurn('a', 'Sean');
    expect(notes.of('a')).toEqual([]);
    am.afterTurn('a', 'Sean'); // second exchange: learns in the background
    await new Promise((r) => setTimeout(r, 10));
    expect(notes.of('a')).toEqual(['has a dog named Biscuit']);
    expect(notes.of('b')).toEqual([]);
    expect(cost).toBe(320);
  });

  it('makes room among what it picked up itself, never what was asked for', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    notes.add('a', "mom's birthday is March 3", 'told');
    for (let i = 0; i < 29; i++) notes.add('a', `old guess ${i}`, 'learned');
    sessions.append('a', { role: 'user', content: 'my dog Biscuit just ate my sandwich' });
    const am = new AutoMemory(fakeLlm('["has a dog named Biscuit"]'), notes, sessions, log, () => undefined);
    expect(await am.learn('a', 'Sean')).toEqual(['has a dog named Biscuit']);
    expect(notes.of('a')).toHaveLength(30);
    expect(notes.of('a')).toContain("mom's birthday is March 3");
    expect(notes.of('a')).not.toContain('old guess 0');
  });

  it('counts what it saves as its own, for the next one to replace', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    for (let i = 0; i < 29; i++) notes.add('a', `note ${i}`, 'told');
    sessions.append('a', { role: 'user', content: 'my dog Biscuit just ate my sandwich' });
    await new AutoMemory(fakeLlm('["has a dog named Biscuit"]'), notes, sessions, log, () => undefined).learn('a', 'Sean');
    await new AutoMemory(fakeLlm('["has a cat named Mochi"]'), notes, sessions, log, () => undefined).learn('a', 'Sean');
    expect(notes.of('a')).toContain('has a cat named Mochi');
    expect(notes.of('a')).not.toContain('has a dog named Biscuit');
  });

  it('saves nothing, and reports nothing saved, when every note was asked for', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    for (let i = 0; i < 30; i++) notes.add('a', `note ${i}`, 'told');
    sessions.append('a', { role: 'user', content: 'my dog Biscuit just ate my sandwich' });
    const am = new AutoMemory(fakeLlm('["has a dog named Biscuit"]'), notes, sessions, log, () => undefined);
    expect(await am.learn('a', 'Sean')).toEqual([]);
    expect(notes.of('a')).not.toContain('has a dog named Biscuit');
  });

  it('keeps what it picks up out of a server, since it can\'t tell where a turn was said', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    sessions.append('a', { role: 'user', content: 'my landlord is evicting me' });
    await new AutoMemory(fakeLlm('["being evicted"]'), notes, sessions, log, () => undefined).learn('a', 'Sean');
    expect(notes.context('a', 'Sean', { userId: 'a', speaker: 'Sean', guildId: 'g', channelId: 'c', said: 'hey' })).toEqual([]);
    expect(notes.context('a', 'Sean', { userId: 'a', speaker: 'Sean', channelId: 'dm', said: 'hey' }).join('\n')).toContain('being evicted');
  });
});

describe('"forget everything"', () => {
  it('has a rule against saving what they asked to forget', async () => {
    const seen: string[] = [];
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    sessions.append('a', { role: 'user', content: 'hello' });
    await new AutoMemory(replaysCancun(seen), notes, sessions, log, () => undefined).learn('a', 'Sean');
    expect(seen[0]).toContain('Never save anything they asked you to forget or delete in this conversation.');
  });

  it('is not undone by the next run', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    const am = new AutoMemory(replaysCancun(), notes, sessions, log, () => undefined);
    sessions.append('a', { role: 'user', content: "I'm flying to Cancun on Friday" });
    sessions.append('a', { role: 'assistant', content: 'Have fun.' });
    expect(await am.learn('a', 'Sean')).toEqual(['flying to Cancun on Friday']);
    // The turn keeps going after the tool: its words go into memory afterwards.
    expect(await saysForget(notes, sessions, 'all')).toEqual(['Forgot 1 note.']);
    expect(notes.of('a')).toEqual([]);
    expect(await am.learn('a', 'Sean')).toEqual([]);
    expect(notes.of('a')).toEqual([]);
  });

  it('counts even with no notes yet: what was said is on its way to being one', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    const am = new AutoMemory(replaysCancun(), notes, sessions, log, () => undefined);
    sessions.append('a', { role: 'user', content: "I'm flying to Cancun on Friday" });
    await saysForget(notes, sessions, 'everything');
    expect(await am.learn('a', 'Sean')).toEqual([]);
    expect(notes.of('a')).toEqual([]);
  });

  it('starts the count over', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    const am = new AutoMemory(fakeLlm('["has a dog named Biscuit"]'), notes, sessions, log, () => undefined, 2);
    sessions.append('a', { role: 'user', content: 'hello' });
    am.afterTurn('a', 'Sean');
    notes.remove('a', 'all');
    sessions.append('a', { role: 'user', content: 'hello again' });
    am.afterTurn('a', 'Sean');
    await new Promise((r) => setTimeout(r, 10));
    expect(notes.of('a')).toEqual([]);
  });

  it('wins over a run already under way', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let cost = 0;
    const llm: LlmProvider = {
      model: 'fake',
      async *stream() {
        await held;
        yield { type: 'text', delta: '["flying to Cancun on Friday"]' };
        yield { type: 'usage', inputTokens: 300, cachedTokens: 0, outputTokens: 20 };
      },
    };
    sessions.append('a', { role: 'user', content: "I'm flying to Cancun on Friday" });
    const am = new AutoMemory(llm, notes, sessions, log, (i, o) => (cost += i + o));
    const run = am.learn('a', 'Sean');
    notes.remove('a', 'cancun');
    release();
    expect(await run).toEqual([]);
    expect(notes.of('a')).toEqual([]);
    expect(cost).toBe(320); // the model was still paid for
  });

  it('leaves a run alone after someone else forgets', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    sessions.append('a', { role: 'user', content: 'my dog Biscuit just ate my sandwich' });
    const am = new AutoMemory(fakeLlm('["has a dog named Biscuit"]'), notes, sessions, log, () => undefined);
    const run = am.learn('a', 'Sean');
    notes.remove('b', 'all');
    expect(await run).toEqual(['has a dog named Biscuit']);
  });

  it('keeps the conversation after forgetting one thing', async () => {
    const notes = new UserNotes(undefined);
    const sessions = new SessionMemory();
    new AutoMemory(fakeLlm('[]'), notes, sessions, log, () => undefined);
    sessions.append('a', { role: 'user', content: 'tell me about Rome' });
    notes.add('a', 'dog is named Biscuit');
    notes.remove('a', 'biscuit');
    expect(sessions.history('a')).toHaveLength(1);
  });
});
