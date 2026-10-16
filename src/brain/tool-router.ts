// Pick the tools a request plausibly needs, so each model call carries only
// a few tool descriptions instead of all of them (each one costs tokens on
// every call, and free tiers limit tokens per minute). Generous on purpose:
// a false match only costs a little; a miss means the model can't help.

import type { Tool } from '../core/interfaces.js';

export interface RouteHints {
  /** A party game is running in the caller's channel. */
  gameRunning?: boolean;
  /** The caller has timers or reminders set. */
  hasTimers?: boolean;
  /** Music is playing in the call. */
  musicPlaying?: boolean;
}

const GROUPS: { tools: string[]; words: RegExp; when?: (h: RouteHints) => boolean }[] = [
  {
    tools: ['set_timer', 'set_reminder', 'list_timers', 'cancel_timer'],
    words: /\b(timers?|remind(er|ers|me)?|alarms?|wake me|in \d+ ?(sec|second|min|minute|hour)s?|minutes?|hours?|countdown|tomorrow at|tonight at|at \d|o'?clock|how long|time left)\b/i,
    when: (h) => !!h.hasTimers,
  },
  {
    tools: ['remember', 'forget'],
    words: /\b(remember|forget|note (that|down)|don'?t forget|keep in mind|save (that|this))\b/i,
  },
  {
    tools: ['roll_dice', 'flip_coin', 'game'],
    words: /\b(roll|dice|die|d\d+|coin|flip|heads|tails|trivia|quiz|riddles?|game|play|score|points?|would you rather|guess|random|pick (one|a number)|answer|winner|round)\b/i,
    when: (h) => !!h.gameRunning,
  },
  {
    tools: ['game_server_status'],
    words: /\b(servers?|minecraft|mc|online|on now|playing|players?|who'?s on|up\b|down\b)\b/i,
  },
  {
    tools: ['plex_recently_added', 'plex_search', 'downloads', 'upcoming_episodes'],
    words: /\b(plex|movies?|shows?|episodes?|series|download(ing|s|ed)?|added|watch|library|airing|comes? out|new on|anime|film)\b/i,
  },
];

/** Tools for this request: the always-on ones plus any matching group. */
export function routeTools(all: Tool[], text: string, hints: RouteHints = {}): Tool[] {
  const grouped = new Set(GROUPS.flatMap((g) => g.tools));
  const want = new Set(all.map((t) => t.spec.name).filter((n) => !grouped.has(n))); // get_time, web_search
  for (const g of GROUPS) if (g.words.test(text) || g.when?.(hints)) for (const n of g.tools) want.add(n);
  return all.filter((t) => want.has(t.spec.name));
}
