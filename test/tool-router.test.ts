import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/core/interfaces.js';
import { routeTools } from '../src/brain/tool-router.js';

const names = ['get_time', 'web_search', 'set_timer', 'set_reminder', 'list_timers', 'cancel_timer', 'remember', 'forget', 'roll_dice', 'flip_coin', 'game', 'game_server_status', 'plex_recently_added', 'plex_search', 'downloads', 'upcoming_episodes'];
const all = names.map((name) => ({ spec: { name, description: '', parameters: {} }, run: async () => '' }) as Tool);
const pick = (t: string, h = {}) => routeTools(all, t, h).map((x) => x.spec.name);

describe('tool router', () => {
  it('sends only the always-on tools for a plain question', () => {
    expect(pick('what is the capital of Peru')).toEqual(['get_time', 'web_search']);
  });

  it('adds the group a request needs', () => {
    expect(pick('set a timer for five minutes')).toContain('set_timer');
    expect(pick('remind me to stretch in ten minutes')).toContain('set_reminder');
    expect(pick('remember my favorite color is green')).toContain('remember');
    expect(pick('roll a d20')).toContain('roll_dice');
    expect(pick("let's play trivia")).toContain('game');
    expect(pick('is the season of the king server up')).toEqual(['get_time', 'web_search', 'game_server_status']);
    expect(pick("what's downloading")).toContain('downloads');
    expect(pick('what episodes come out this week')).toContain('upcoming_episodes');
  });

  it('keeps game and timer tools while they are in use', () => {
    expect(pick('is it Paris', { gameRunning: true })).toContain('game');
    expect(pick('cancel the pizza one', { hasTimers: true })).toContain('cancel_timer');
    expect(pick('is it Paris')).not.toContain('game');
  });
});
