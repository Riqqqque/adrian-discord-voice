import { describe, expect, it } from 'vitest';
import { COMMANDS, humansIn } from '../src/app/commands.js';

describe('slash commands', () => {
  it('defines guild-only /join and /leave', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['join', 'leave']);
    for (const c of COMMANDS) {
      expect(c.contexts).toEqual([0]); // guild only, not DMs
      expect(c.integration_types).toEqual([0]); // server install
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('counts people, not bots, in a channel', () => {
    const members = new Map([
      ['1', { id: '1', user: { bot: false } }],
      ['2', { id: '2', user: { bot: true } }],
      ['3', { id: '3', user: { bot: false } }],
    ]);
    const ch = { members: { filter: (f: (m: unknown) => boolean) => ({ size: [...members.values()].filter(f).length }) } };
    expect(humansIn(ch as never)).toBe(2);
    expect(humansIn(ch as never, '1')).toBe(1);
    expect(humansIn(undefined)).toBe(0);
  });
});
