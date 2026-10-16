import { describe, expect, it } from 'vitest';
import { matureContext } from '../src/brain/mature.js';

describe('mature mode', () => {
  it('turns on only in age-restricted channels, and never when off', () => {
    expect(matureContext('age-restricted', true).join(' ')).toContain('swear freely');
    expect(matureContext('age-restricted', false)).toEqual([]);
    expect(matureContext('off', true)).toEqual([]);
  });

  it('keeps the hard limits in the prompt', () => {
    const p = matureContext('age-restricted', true).join(' ');
    expect(p).toContain('sexual involving minors');
    expect(p).toContain('slurs');
  });
});

describe('mature mode always', () => {
  it('is on in every channel, with the same limits', () => {
    expect(matureContext('always', false).join(' ')).toContain('swear freely');
    expect(matureContext('always', false).join(' ')).toContain('sexual involving minors');
  });
});
