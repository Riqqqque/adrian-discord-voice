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
  /** This PC took a restart or shutdown: it can be called off for 30 seconds. */
  onPowerDown?(userId: UserId, pc: SatelliteConnection): void;
  /** This PC called one off, because the model asked it to. */
  onPowerCancelled?(userId: UserId, pc: SatelliteConnection): void;
  /** Clock for the wait on a yes. */
  now?(): number;
}

const NAMES = ['pc_apps', 'pc_windows', 'pc_open', 'pc_media', 'pc_volume', 'pc_system', 'pc_info'] as const;

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

/** What's counting down, by person and PC, so a plain "cancel" reaches it:
 *  that's a stop phrase, which never gets as far as the model. It goes to the
 *  PC that took the order: the one seen or used last can be another. */
export class PowerDownWindow {
  private readonly running = new Map<UserId, { pc: SatelliteConnection; until: number }[]>();

  constructor(private readonly now: () => number = Date.now) {}

  started(userId: UserId, pc: SatelliteConnection): void {
    this.calledOff(userId, pc);
    this.running.set(userId, [...(this.running.get(userId) ?? []), { pc, until: this.now() + POWER_DOWN_MS }]);
  }

  /** That PC has nothing counting down any more. */
  calledOff(userId: UserId, pc: SatelliteConnection): void {
    const left = (this.running.get(userId) ?? []).filter((w) => w.pc !== pc);
    if (left.length) this.running.set(userId, left);
    else this.running.delete(userId);
  }

  /** Call theirs off, if any is still counting down: what to tell them, which
   *  they need most if it failed. Undefined when there was nothing to call off. */
  async cancel(userId: UserId): Promise<string | undefined> {
    const live = (this.running.get(userId) ?? []).filter((w) => this.now() < w.until);
    this.running.delete(userId);
    if (!live.length) return undefined;
    const answers = await Promise.all(live.map((w) => w.pc.action('pc_system', { action: 'cancel_shutdown' })));
    return answers.every((r) => r.ok) ? 'Cancelled.' : "I couldn't cancel it.";
  }
}

/** Prompt line: when to use them. */
export const PC_RULE =
  "If the person has their PC connected (the PC satellite), you can control it with the pc_ tools: open, close or switch to apps and games, arrange their windows (snap to a side or corner, maximize, move to another monitor), open websites, YouTube and folders, control what's playing, set volume (also per app), lock it, turn the screens off, sleep, restart or shut it down, and check CPU, memory and disk. When someone talks to you through their PC, short orders are about that PC: \"pause\", \"skip\", \"what's playing\", \"turn it down\" mean pc_media and pc_volume, unless your own music is the thing playing (see Music now). \"Turn my music down\" or \"turn it down\" is pc_volume with playing true: it lowers just what they're listening to and leaves their game and Discord alone. Change the master volume only when they ask for the PC's own or overall volume. Act right away, then confirm in a few words (\"Done.\", \"Spotify's open.\", \"Down to 30.\"); don't describe how you did it and don't offer more help. Do every part of a combined order. For sleep, restart and shutdown, just call pc_system: it asks them itself, so don't ask first. If they answer yes, call it again with the same action. \"Put it back\" right after you moved a window is pc_windows back. If a tool says no PC is connected, tell them.";

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
    pc_windows: {
      description:
        'Arrange app windows on the PC. snap: to a side (left, right, top, bottom) or a corner (top_left, top_right, bottom_left, bottom_right). maximize. restore: out of maximized or minimized. center. move: to another monitor. back: undo the last change ("put it back"). monitors: the screens and what is on each. name: the app as they said it; leave it out for "it", "this" or "this window" (the window in front). monitor: the screen they named (main, other, left, right, or a number), also with snap, maximize and center ("snap Discord to the left of my main monitor"). Games and full-screen windows are never moved.',
      properties: {
        action: { type: 'string', enum: ['snap', 'maximize', 'restore', 'center', 'move', 'back', 'monitors'] },
        name: { type: 'string', description: 'The app, as they said it. Leave out for "it" or "this window".' },
        side: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'top_left', 'top_right', 'bottom_left', 'bottom_right'] },
        monitor: { type: 'string', description: 'main, other, left, right, or a number like "2". Only when they named a screen.' },
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
      description:
        'PC volume: get, set (level 0-100), up / down (by level, default 10), mute, unmute. playing true: only the apps making sound right now that could be music or video (Spotify, a YouTube tab, any player), never a game, Discord or other voice chat. Use playing for "my music", "the music", "this song", "the video", "turn it down" and anything else that means what they are listening to. app: only the app they named ("spotify", "discord", "chrome"). Neither: the master volume, only when they ask for the PC\'s own or overall volume ("set the volume to 30", "turn everything down"). If an app they named isn\'t found, try playing.',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'up', 'down', 'mute', 'unmute'] },
        level: { type: 'number' },
        playing: { type: 'boolean', description: 'What they are listening to, not the game or voice chat.' },
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
        args.url = found && webUrl(found) ? found : `https://www.google.com/search?q=${encodeURIComponent(a.search)}`;
        delete args.search;
        // `a` is what speak reads: she names the page that really opens.
        a.url = args.url;
        delete a.search;
      }
      delete args.play;
      if (name === 'pc_open' && typeof args.url === 'string' && args.url.trim() && !webUrl(args.url.trim())) {
        const refused = `${NOT_DONE}Only public http and https web addresses can be opened.`;
        d.onCall?.(name, args, refused);
        return refused;
      }
      const r = await pc.action(name, args);
      const result = r.ok ? r.result : `${NOT_DONE}${r.result}`;
      d.onCall?.(name, args, result);
      if (r.ok && name === 'pc_system' && (a.action === 'restart' || a.action === 'shutdown')) d.onPowerDown?.(ctx.userId, pc);
      if (r.ok && name === 'pc_system' && a.action === 'cancel_shutdown') d.onPowerCancelled?.(ctx.userId, pc);
      return result;
    },
    speak: (a, result) => confirmation(name, a, result),
    asks: (result) => name === 'pc_system' && QUESTIONS.has(result),
    acts: (a) => !LOOKUPS.has(`${name}.${String(a.action ?? '')}`) && name !== 'pc_info',
  }));
}

const NOT_DONE = "Didn't happen: ";
/** pc_ calls that only look something up (the conversation may go on). */
const LOOKUPS = new Set(['pc_apps.running', 'pc_apps.list', 'pc_windows.monitors', 'pc_media.status', 'pc_volume.get']);

/** Say it in words: "40%" → "40 percent". */
const spoken = (s: string) => s.replace(/(\d+)\s?%/g, '$1 percent');

/** Longest address that opens: a long query string is how a page gets handed
 *  what she knows. This and the rest of webUrl mirror web_url in
 *  crates/pc-control/src/win/open.rs, so PCs older than that rule get it too.
 *  Change them together. */
const MAX_URL = 300;
/** Last labels that never reach the public web. */
const PRIVATE_SUFFIXES = new Set(['localhost', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'arpa']);

/** A name on the public web, from `host` or `host:port`. Only plain hostname
 *  characters pass, so a user@ part, a backslash, an escape or a look-alike
 *  digit can't make the browser go somewhere other than what this reads. */
function publicHost(authority: string): boolean {
  const colon = authority.lastIndexOf(':');
  if (colon >= 0 && !/^[0-9]*$/.test(authority.slice(colon + 1))) return false;
  const host = (colon >= 0 ? authority.slice(0, colon) : authority).replace(/\.$/, '');
  if (!/^[A-Za-z0-9.-]*$/.test(host)) return false;
  const labels = host.split('.');
  const last = labels.at(-1)!.toLowerCase();
  // No top-level domain starts with a digit, but 127.0.0.1, 127.1 and 0x7f.0.0.1 do.
  return labels.length > 1 && labels.every(Boolean) && !/^[0-9]/.test(last) && !PRIVATE_SUFFIXES.has(last);
}

/** A plain web page on the public web: no file:, javascript: or app protocols,
 *  and nothing on the PC or its network. */
export function webUrl(url: string): boolean {
  const scheme = /^https?:\/\//i.exec(url);
  if (!scheme || Buffer.byteLength(url) > MAX_URL || /[\p{White_Space}\p{Cc}"]/u.test(url)) return false;
  return publicHost(url.slice(scheme[0].length).split(/[/?#]/, 1)[0]!);
}

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
    case 'pc_windows':
      return action === 'monitors' ? undefined : spoken(result); // monitors: worth an answer
    case 'pc_open':
      if (typeof a.url === 'string' && a.url) {
        const host = hostOf(a.url);
        return host ? `Opening ${host}.` : 'Opening it.';
      }
      if (typeof a.folder === 'string' && a.folder) return `Opening ${a.folder}.`;
      if (a.play === true && /YouTube video/.test(result)) return 'Opening it on YouTube.';
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

