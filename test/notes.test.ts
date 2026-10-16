import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserNotes } from '../src/features/notes.js';

const sig = () => AbortSignal.timeout(1000);

describe('per-person memory', () => {
  it('keeps notes per person and only puts them in that person\'s prompt', async () => {
    const n = new UserNotes(undefined);
    const [remember] = n.tools();
    await remember!.run({ note: 'birthday is March 3' }, sig(), { userId: 'a', speaker: 'Sean' });
    await remember!.run({ note: 'likes pineapple pizza' }, sig(), { userId: 'b', speaker: 'Sam' });
    expect(n.context('a', 'Sean').join('\n')).toContain('birthday is March 3');
    expect(n.context('a', 'Sean').join('\n')).not.toContain('pineapple');
    expect(n.context('c', 'Kim')).toEqual([]);
  });

  it('dedupes, forgets by words or all, and survives a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json');
    const a = new UserNotes(file);
    expect(a.add('a', 'wifi is on the router sticker')).toContain('Remembered');
    expect(a.add('a', 'WiFi is on the router sticker')).toBe('Already remembered.');
    a.add('a', 'dog is named Biscuit');
    const b = new UserNotes(file);
    expect(b.of('a')).toHaveLength(2);
    expect(b.remove('a', 'biscuit')).toEqual(['dog is named Biscuit']);
    expect(b.remove('a', '')).toEqual([]);
    expect(b.remove('a', 'all')).toHaveLength(1);
    expect(new UserNotes(file).of('a')).toEqual([]);
  });

  it('caps the number of notes', () => {
    const n = new UserNotes(undefined);
    for (let i = 0; i < 30; i++) n.add('a', `note ${i}`);
    expect(n.add('a', 'one more')).toContain('the most I keep');
  });
});
