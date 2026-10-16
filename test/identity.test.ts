import { describe, expect, it } from 'vitest';
import { creatorLines, memberLabel } from '../src/app/identity.js';

describe('creator identity', () => {
  it('marks the creator in the roster', () => {
    expect(memberLabel('sean_92', { creator: 'Sean', isCreator: true, isAsker: true })).toBe("sean_92 (sean_92 is Sean's own Discord account: this is definitely Sean, your creator; talking to you now)");
    expect(memberLabel('Sam', { creator: 'Sean', isCreator: false, isAsker: false })).toBe('Sam');
  });

  it('tells the model the Discord account is the developer, and others are not', () => {
    const mine = creatorLines('sean_92', { creator: 'Sean', isCreator: true }).join(' ');
    expect(mine).toContain('Discord name sean_92');
    expect(mine).toContain('is Sean, your creator');
    expect(mine).toContain('developer');
    const theirs = creatorLines('Sam', { creator: 'Sean', isCreator: false }).join(' ');
    expect(theirs).toContain("that isn't true");
    expect(theirs).not.toContain('Sam');
  });
});

describe('nicknames', () => {
  it('shows what someone goes by in the roster', () => {
    expect(memberLabel('mike_77', { creator: 'Sean', isCreator: false, isAsker: true, nickname: 'Big Mike' })).toBe('mike_77 (goes by "Big Mike"; talking to you now)');
  });
});
