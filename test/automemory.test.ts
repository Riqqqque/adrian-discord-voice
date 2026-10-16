import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '../src/core/interfaces.js';
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

  it('makes room by dropping the oldest note when full', () => {
    const n = new UserNotes(undefined);
    for (let i = 0; i < 30; i++) n.add('a', `note ${i}`);
    expect(n.add('a', 'new fact', true)).toContain('Remembered');
    expect(n.of('a')).toHaveLength(30);
    expect(n.of('a')[0]).toBe('note 1');
  });
});
