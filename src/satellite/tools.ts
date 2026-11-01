// The model's PC tools. Each one goes to the asker's own connected PC (never
// one named in the arguments), which checks it against its own settings.

import { PendingYes } from '../brain/tools.js';
import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import type { SatelliteConnection } from './connection.js';

export interface PcToolDeps {
  /** The asker's connected PC: the one they're talking through, else their most recently active one. */
  pcFor(ctx: ToolContext): SatelliteConnection | undefined;
  /** A YouTube video ID for a search, so "play X on YouTube" opens the video itself. */
  findVideo?(query: string, signal: AbortSignal): Promise<string | undefined>;
  /** The address of the best web page for a description ("JEI mod on modrinth"). */
  findUrl?(query: string, signal: AbortSignal): Promise<string | undefined>;
  /** Every action sent to a PC (for the optional transcript log). */
  onCall?(name: string, args: Record<string, unknown>, result: string): void;
  /** The PC took a restart or shutdown: it can be called off for 30 seconds. */
  onPowerDown?(userId: UserId): void;
  /** Clock for the wait on a yes. */
  now?(): number;
}

const NAMES = ['pc_apps', 'pc_open', 'pc_media', 'pc_volume', 'pc_system', 'pc_info'] as const;

/** pc_system actions that need the person's own yes: the question, and what
 *  a yes may say about it ("yes restart it"). */
const NEEDS_YES = new Map([
  ['sleep', { ask: 'Put the PC to sleep?', about: ['sleep', 'put', 'to', 'the', 'pc', 'computer'] }],
  ['restart', { ask: 'Restart the PC?', about: ['restart', 'reboot', 'the', 'pc', 'computer'] }],
  ['shutdown', { ask: 'Shut down the PC?', about: ['shut', 'down', 'shutdown', 'turn', 'off', 'the', 'pc', 'computer'] }],
]);
const QUESTIONS = new Set([...NEEDS_YES.values()].map((n) => n.ask));

/** How long a restart or shutdown waits on the PC (system.rs). */
const POWER_DOWN_MS = 30_000;

/** Who has a restart or shutdown counting down, so a plain "cancel" reaches it:
 *  that's a stop phrase, which never gets as far as the model. */
export class PowerDownWindow {
  private readonly until = new Map<UserId, number>();

  constructor(
    private readonly pcFor: (userId: UserId) => SatelliteConnection | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  started(userId: UserId): void {
    this.until.set(userId, this.now() + POWER_DOWN_MS);
  }

  /** Call theirs off if it's still counting down. True if it was. */
  async cancel(userId: UserId): Promise<boolean> {
    const until = this.until.get(userId);
    if (until === undefined) return false;
    this.until.delete(userId);
    if (this.now() >= until) return false;
    const r = await this.pcFor(userId)?.action('pc_system', { action: 'cancel_shutdown' });
    return r?.ok ?? false;
  }
}

/** Prompt line: when to use them. */
export const PC_RULE =
  "If the person has their PC connected (the PC satellite), you can control it with the pc_ tools: open, close or switch to apps and games, open websites, YouTube and folders, control what's playing, set volume (also per app), lock it, turn the screens off, sleep, restart or shut it down, and check CPU, memory and disk. When someone talks to you through their PC, short orders are about that PC: \"pause\", \"skip\", \"what's playing\", \"turn it down\" mean pc_media and pc_volume, unless your own music is the thing playing (see Music now). Act right away, then confirm in a few words (\"Done.\", \"Spotify's open.\", \"Down to 30.\"); don't describe how you did it and don't offer more help. Do every part of a combined order. For sleep, restart and shutdown, just call pc_system: it asks them itself, so don't ask first. If they answer yes, call it again with the same action. If a tool says no PC is connected, tell them.";

export function pcTools(d: PcToolDeps): Tool[] {
  const yes = new PendingYes<string>(d.now);
  const specs: Record<(typeof NAMES)[number], { description: string; properties: Record<string, unknown>; required: string[] }> = {
    pc_apps: {
      description:
        'Apps and games on their PC. open: any installed app, Steam/Epic/Riot game or the PC\'s own shortcut, by name ("valorant", "spotify", "fl studio"). close: ask it to close. focus: switch to it. minimize. running: what is open. show_desktop. list: installed apps or games matching name (no name lists the games). Running games are never closed or switched to.',
      properties: {
        action: { type: 'string', enum: ['open', 'close', 'focus', 'minimize', 'running', 'show_desktop', 'list'] },
        name: { type: 'string', description: 'The app or game, as they said it.' },
      },
      required: ['action'],
    },
    pc_open: {
      description:
        'Open something in the PC\'s browser or Explorer. Use exactly one of: url (a page whose exact address you know, like a site\'s home page), search (a specific page you don\'t know the address of: a mod, product, article, profile, wiki page; the best web result opens), youtube (a search; with play true it opens the top video itself), spotify (a search in their Spotify app: a song, artist, album or playlist; it opens the results, they press play), or folder (downloads, documents, desktop, pictures, music, videos).',
      properties: {
        url: { type: 'string' },
        search: { type: 'string', description: 'The page to find, e.g. "JEI mod modrinth", "RTX 5070 review tom\'s hardware".' },
        youtube: { type: 'string', description: 'What to look up on YouTube.' },
        play: { type: 'boolean', description: 'With youtube: open the top video instead of the results.' },
        spotify: { type: 'string', description: 'What to find in Spotify, e.g. "blinding lights the weeknd". Only when they ask for Spotify.' },
        folder: { type: 'string', enum: ['downloads', 'documents', 'desktop', 'pictures', 'music', 'videos'] },
      },
      required: [],
    },
    pc_media: {
      description:
        "Media players on the PC (Spotify, a YouTube/Netflix/Twitch tab in the browser, any player): play_pause, play, pause, next, previous, stop, or status. app: the one they named (\"spotify\", \"youtube\", \"chrome\"); leave it out to act on whatever is playing (pause/skip/stop) or was playing last (play). status without app lists every player.",
      properties: {
        action: { type: 'string', enum: ['play_pause', 'play', 'pause', 'next', 'previous', 'stop', 'status'] },
        app: { type: 'string', description: 'Only if they named the app or site.' },
      },
      required: ['action'],
    },
    pc_volume: {
      description: 'PC volume: get, set (level 0-100), up / down (by level, default 10), mute, unmute. With app, only that app ("spotify", "discord", "chrome").',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'up', 'down', 'mute', 'unmute'] },
        level: { type: 'number' },
        app: { type: 'string' },
      },
      required: ['action'],
    },
    pc_system: {
      description:
        'lock, screen_off, sleep, restart, shutdown, cancel_shutdown. sleep, restart and shutdown ask the person first by themselves: call again with the same action once they say yes. Restart and shutdown wait 30 seconds and can be cancelled.',
      properties: {
        action: { type: 'string', enum: ['lock', 'screen_off', 'sleep', 'restart', 'shutdown', 'cancel_shutdown'] },
      },
      required: ['action'],
    },
    pc_info: {
      description: 'PC status: summary (CPU, memory, disk space, uptime, battery) or processes (what uses the most memory).',
      properties: { action: { type: 'string', enum: ['summary', 'processes'] } },
      required: ['action'],
    },
  };

  return NAMES.map((name) => ({
    spec: {
      name,
      description: specs[name].description,
      parameters: { type: 'object', properties: specs[name].properties, required: specs[name].required, additionalProperties: false },
    },
    timeoutMs: name === 'pc_open' ? 20_000 : 15_000,
    run: async (a, signal, ctx) => {
      const pc = d.pcFor(ctx);
      if (!pc) return `No PC is connected for ${ctx.speaker}. Their A.D.R.I.A.N. satellite app has to be running on it.`;
      const args: Record<string, unknown> = { ...a };
      delete args.confirmed; // only their own yes sets it, below
      const need = name === 'pc_system' ? NEEDS_YES.get(String(a.action ?? '')) : undefined;
      if (need) {
        if (yes.take(ctx) !== a.action) return yes.hold(ctx, a.action as string, need.about) ? need.ask : `${NOT_DONE}a question is already waiting for their answer.`;
        args.confirmed = true;
      }
      if (name === 'pc_open' && a.play === true && typeof a.youtube === 'string' && d.findVideo) {
        const id = await d.findVideo(a.youtube, signal).catch(() => undefined);
        if (id) {
          args.video_id = id;
          delete args.youtube;
        }
      }
      if (name === 'pc_open' && typeof a.search === 'string' && a.search.trim()) {
        // Find the actual page; without a search service, the search results themselves.
        const found = d.findUrl ? await d.findUrl(a.search, signal).catch(() => undefined) : undefined;
        args.url = found ?? `https://www.google.com/search?q=${encodeURIComponent(a.search)}`;
        delete args.search;
        // `a` is what speak reads: she names the page that really opens.
        a.url = args.url;
        delete a.search;
      }
      delete args.play;
      const r = await pc.action(name, args);
      const result = r.ok ? r.result : `${NOT_DONE}${r.result}`;
      d.onCall?.(name, args, result);
      if (r.ok && name === 'pc_system' && (a.action === 'restart' || a.action === 'shutdown')) d.onPowerDown?.(ctx.userId);
      return result;
    },
    speak: (a, result) => confirmation(name, a, result),
    asks: (result) => name === 'pc_system' && QUESTIONS.has(result),
    acts: (a) => !LOOKUPS.has(`${name}.${String(a.action ?? '')}`) && name !== 'pc_info',
  }));
}

const NOT_DONE = "Didn't happen: ";
/** pc_ calls that only look something up (the conversation may go on). */
const LOOKUPS = new Set(['pc_apps.running', 'pc_apps.list', 'pc_media.status', 'pc_volume.get']);

/** Say it in words: "40%" → "40 percent". */
const spoken = (s: string) => s.replace(/(\d+)\s?%/g, '$1 percent');

/** The host a browser really goes to (past any user@ part), without www. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to say when a PC action worked, without asking the model again.
 * Undefined: something to explain or answer (a failure, "which one?", a
 * status question), so the model words it.
 */
export function confirmation(name: string, a: Record<string, unknown>, result: string): string | undefined {
  if (result.startsWith(NOT_DONE) || result.startsWith('No PC is connected')) return undefined;
  const action = String(a.action ?? '');
  switch (name) {
    case 'pc_apps':
      if (action === 'open') return result.replace(/\s*\((app|game|shortcut)\)\.$/, '.');
      if (action === 'close') return typeof a.name === 'string' && a.name ? `Closing ${a.name.charAt(0).toUpperCase()}${a.name.slice(1)}.` : 'Done.';
      if (action === 'focus' || action === 'minimize' || action === 'show_desktop') return result;
      return undefined; // running, list: worth an answer
    case 'pc_open':
      if (typeof a.url === 'string' && a.url) {
        const host = hostOf(a.url);
        return host ? `Opening ${host}.` : 'Opening it.';
      }
      if (typeof a.folder === 'string' && a.folder) return `Opening ${a.folder}.`;
      if (a.video_id) return 'Opening it on YouTube.';
      if (typeof a.youtube === 'string' && a.youtube) return `Here's YouTube for ${a.youtube}.`;
      if (typeof a.spotify === 'string' && a.spotify) return `Here's ${a.spotify} in Spotify.`;
      return 'Opening it.';
    case 'pc_media':
      if (action === 'status') return undefined;
      if (action === 'pause') return 'Paused.';
      if (action === 'stop') return 'Stopped.';
      return spoken(result);
    case 'pc_volume':
      return spoken(result);
    case 'pc_system':
      return action === 'lock' ? 'Locked.' : spoken(result);
    default:
      return undefined; // pc_info: numbers worth putting in words
  }
}

