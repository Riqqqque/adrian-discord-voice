import { describe, expect, it } from 'vitest';
import { questionText, splitReply } from '../src/app/textchat.js';

describe('text chat', () => {
  it('drops the bot mention from the question', () => {
    expect(questionText('<@123> what time is it', '123')).toBe('what time is it');
    expect(questionText('hey <@!123>, play humble', '123')).toBe('hey , play humble');
    expect(questionText('<@123>', '123')).toBe('');
  });

  it("splits long replies under Discord's limit at a sentence or line end", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const parts = splitReply(long, 500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.every((p) => p.endsWith('.'))).toBe(true);
    expect(parts.join(' ')).toBe(long);
    expect(splitReply('short')).toEqual(['short']);
  });
});
