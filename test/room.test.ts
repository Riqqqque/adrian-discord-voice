import { describe, expect, it } from 'vitest';
import { RoomTalk } from '../src/conversation/room.js';

describe('room talk', () => {
  it('shows recent lines from the call, minus the asker\'s current words', () => {
    let now = 0;
    const r = new RoomTalk(() => now);
    r.add('c', 'b', 'Sam', 'I think the creeper got me');
    now += 1000;
    r.add('c', 'a', 'Sean', 'Hey Adrian, what do you think about what Sam said?');
    const ctx = r.context('c', 'a').join('\n');
    expect(ctx).toContain('Sam: I think the creeper got me');
    expect(ctx).not.toContain('what Sam said');
    expect(r.context('other', 'a')).toEqual([]);
  });

  it('forgets after 5 minutes and keeps at most 24 lines', () => {
    let now = 0;
    const r = new RoomTalk(() => now);
    for (let i = 0; i < 30; i++) r.add('c', 'b', 'Sam', `line ${i}`);
    expect(r.context('c', 'a')).toHaveLength(25); // header + 24
    now += 5 * 60_000 + 1;
    expect(r.context('c', 'a')).toEqual([]);
  });
});
