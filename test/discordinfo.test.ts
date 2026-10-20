import { ActivityType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { allowedPings, describeActivity, matchMembers, RelayLimiter } from '../src/features/discordinfo.js';

const people = [
  { id: '111111111111111111', displayName: 'Sam', username: 'samthegreat' },
  { id: '222222222222222222', displayName: 'Samantha', username: 'sammy' },
  { id: '333333333333333333', displayName: 'Kim', username: 'kimk', nickname: 'Kimmy' },
];

describe('discord info', () => {
  it('finds people by name, username, nickname or ping code; exact names first', () => {
    expect(matchMembers(people, 'sam').map((m) => m.displayName)).toEqual(['Sam']);
    expect(matchMembers(people, '@sammy').map((m) => m.displayName)).toEqual(['Samantha']);
    expect(matchMembers(people, 'kimmy').map((m) => m.displayName)).toEqual(['Kim']);
    expect(matchMembers(people, 'sa').length).toBe(2);
    expect(matchMembers(people, '<@333333333333333333>').map((m) => m.displayName)).toEqual(['Kim']);
    expect(matchMembers(people, 'nobody')).toEqual([]);
    expect(matchMembers(people, '  ')).toEqual([]);
  });

  it('pings only members it was told to, capped', () => {
    const isMember = (id: string) => id !== '999';
    expect(allowedPings('hey <@1> and <@!2>, also <@999> and <@1>', isMember)).toEqual(['1', '2']);
    expect(allowedPings('<@1> <@2> <@3>', isMember, 2)).toEqual(['1', '2']);
    expect(allowedPings('@everyone <@&5>', isMember)).toEqual([]);
  });

  it('describes what people are doing', () => {
    expect(describeActivity({ type: ActivityType.Playing, name: 'Valorant' })).toBe('playing Valorant');
    expect(describeActivity({ type: ActivityType.Listening, name: 'Spotify', details: 'HUMBLE.', state: 'Kendrick Lamar' })).toBe('listening to Spotify: HUMBLE. by Kendrick Lamar');
    expect(describeActivity({ type: ActivityType.Custom, name: 'Custom Status', state: 'grinding' })).toBe('status "grinding"');
  });

  it('limits messages per sender and per recipient each hour; owners skip it', () => {
    let t = 0;
    const l = new RelayLimiter(3, 2, () => t);
    expect(l.take('a', 'x')).toBeUndefined();
    expect(l.take('a', 'x')).toBeUndefined();
    expect(l.take('b', 'x')).toContain('that person');
    expect(l.take('a', 'y')).toBeUndefined();
    expect(l.take('a', 'z')).toContain('last hour');
    expect(l.take('a', 'z', true)).toBeUndefined();
    t += 3_600_001;
    expect(l.take('a', 'x')).toBeUndefined();
  });
});
