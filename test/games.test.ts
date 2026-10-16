import { describe, expect, it } from 'vitest';
import { PartyGames, rollDice } from '../src/features/games.js';

const sig = () => AbortSignal.timeout(1000);
const rique = { userId: 'a', speaker: 'Sean', channelId: 'c1' };
const sam = { userId: 'b', speaker: 'Sam', channelId: 'c1' };

describe('party games', () => {
  it('rolls real dice within range', () => {
    for (let i = 0; i < 200; i++) {
      const r = rollDice('2d6+1')!;
      expect(r.rolls).toHaveLength(2);
      expect(r.total).toBeGreaterThanOrEqual(3);
      expect(r.total).toBeLessThanOrEqual(13);
    }
    expect(rollDice('d20')!.rolls[0]).toBeLessThanOrEqual(20);
    expect(rollDice('100d6')).toBeUndefined();
    expect(rollDice('banana')).toBeUndefined();
  });

  it('shares one trivia game and scoreboard across the call', async () => {
    const g = new PartyGames();
    const game = g.tools().find((t) => t.spec.name === 'game')!;
    await game.run({ action: 'start', kind: 'trivia' }, sig(), rique);
    await game.run({ action: 'ask', question: 'What is the capital of Australia?', answer: 'Canberra' }, sig(), rique);
    // Sam, in the same call, sees the open question and the secret answer.
    const ctx = g.context(sam).join('\n');
    expect(ctx).toContain('capital of Australia');
    expect(ctx).toContain('Canberra');
    expect(await game.run({ action: 'award', player: 'Sam' }, sig(), sam)).toBe('Sam now has 1 point.');
    expect(g.context(sam).join('\n')).toContain('No question is open');
    // A different call has no game.
    expect(g.context({ ...sam, channelId: 'c2' })).toEqual([]);
    expect(await game.run({ action: 'end' }, sig(), rique)).toContain('Winner: Sam');
    expect(g.context(sam)).toEqual([]);
  });

  it('ends idle games after 30 minutes', async () => {
    let now = 0;
    const g = new PartyGames(() => now);
    await g.tools().find((t) => t.spec.name === 'game')!.run({ action: 'start' }, sig(), rique);
    now += 31 * 60_000;
    expect(g.context(rique)).toEqual([]);
  });
});
