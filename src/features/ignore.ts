// "Adrian, ignore Sam": an owner tells her to stop listening to someone. While
// it lasts, nothing that person says, types or clicks reaches her: no wake, no
// stop, no follow-up, no text chat, no /play or !play. Or only their music
// requests are refused ("don't take Sam's music requests").
//
// Only owners decide this, and only an owner undoes it. Nobody can ignore the
// app owner, and only the app owner can ignore another owner. The list is kept
// in the state folder, so a restart doesn't hand someone their voice back.

import { readFileSync, renameSync } from 'node:fs';
import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import { writeJsonFile } from '../web/secrets-file.js';

/** everything: she doesn't hear them at all. music: she won't play, skip,
 *  pause or change music for them; everything else still works. */
export type IgnoreScope = 'everything' | 'music';

export interface Ignored {
  userId: UserId;
  /** Their name when it was set, for listing them. */
  name: string;
  scope: IgnoreScope;
  /** The owner who said so. */
  by: UserId;
  at: number;
  /** Ends by itself at this time; missing: until an owner says otherwise. */
  until?: number;
}

/** Longest a timed ignore may run: a week. Longer means "until I say so". */
export const MAX_MINUTES = 7 * 24 * 60;

export class IgnoreList {
  private people = new Map<UserId, Ignored>();

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
    private readonly log?: (msg: string, data?: Record<string, unknown>) => void,
  ) {
    if (!file) return;
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as { people?: unknown };
      for (const p of Array.isArray(d.people) ? d.people : []) {
        const e = clean(p);
        if (e) this.people.set(e.userId, e);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      // Unreadable: kept aside, so a broken file isn't silently written over.
      try {
        renameSync(file, `${file}.bad-${this.now()}`);
      } catch {
        // nothing more to do; it starts empty
      }
      this.log?.('ignore list unreadable, starting empty', { error: (err as Error).message });
    }
  }

  /** Who is ignored right now (expired ones dropped). */
  list(): Ignored[] {
    this.prune();
    return [...this.people.values()];
  }

  get(userId: UserId): Ignored | undefined {
    this.prune();
    return this.people.get(userId);
  }

  /** Does this person's `what` get refused? `music` is refused by either scope. */
  blocks(userId: UserId, what: IgnoreScope): boolean {
    const e = this.get(userId);
    return !!e && (e.scope === 'everything' || what === 'music');
  }

  set(e: Ignored): void {
    this.people.set(e.userId, e);
    this.save();
  }

  /** True when they were on the list. */
  clear(userId: UserId): boolean {
    const had = this.people.delete(userId);
    if (had) this.save();
    return had;
  }

  private prune(): void {
    const t = this.now();
    let changed = false;
    for (const [id, e] of this.people)
      if (e.until !== undefined && e.until <= t) {
        this.people.delete(id);
        changed = true;
      }
    if (changed) this.save();
  }

  private save(): void {
    if (this.file) writeJsonFile(this.file, { people: [...this.people.values()] });
  }
}

function clean(p: unknown): Ignored | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Record<string, unknown>;
  if (typeof o.userId !== 'string' || !o.userId || typeof o.by !== 'string') return undefined;
  const scope: IgnoreScope = o.scope === 'music' ? 'music' : 'everything';
  return {
    userId: o.userId,
    name: typeof o.name === 'string' ? o.name.slice(0, 64) : 'someone',
    scope,
    by: o.by,
    at: typeof o.at === 'number' ? o.at : 0,
    ...(typeof o.until === 'number' ? { until: o.until } : {}),
  };
}

export interface Person {
  id: UserId;
  name: string;
  bot?: boolean;
}

export interface IgnoreToolDeps {
  list: IgnoreList;
  /** Owners: config owners and the app owner. */
  isOwner(id: UserId): boolean;
  /** The Discord application's owner: can't be ignored, and may ignore other owners. */
  isAppOwner(id: UserId): boolean;
  /** People this name or ping code could be, closest first (the call, then the server). */
  find(name: string, ctx: ToolContext): Promise<Person[]>;
  /** Someone was just put on the list: drop what of theirs is waiting. */
  onIgnored?(userId: UserId, scope: IgnoreScope): void;
  now?: () => number;
}

const NOT_OWNER = "Not done: only the bot's owners choose who I ignore.";

function left(until: number | undefined, now: number): string {
  if (until === undefined) return 'until an owner says otherwise';
  const min = Math.max(1, Math.round((until - now) / 60_000));
  if (min < 60) return `for ${min} more minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return h < 48 ? `for about ${h} more hour${h === 1 ? '' : 's'}` : `for about ${Math.round(h / 24)} more days`;
}

const what = (scope: IgnoreScope) => (scope === 'music' ? 'music requests from' : '');

export function ignoreTool(d: IgnoreToolDeps): Tool {
  const now = d.now ?? Date.now;
  return {
    spec: {
      name: 'ignore_person',
      description:
        "Stop listening to someone, or listen to them again. Call it whenever someone tells you to ignore a person, stop listening to them, not take or do their commands or requests, or not play music for them; to listen to them again; or asks who you're ignoring. \"If Sam tells you to do X, ignore him\" counts too: call it (scope everything) instead of promising to remember, because only the tool makes it stick. The tool itself checks that the asker is one of your owners and says so if not: never refuse or decide that yourself, just call it and say its answer. scope everything: you don't hear their voice, messages or commands at all. scope music: only their music requests are refused. Not for \"ignore that\" or \"never mind\" about your own last answer.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['ignore', 'listen_again', 'list'] },
          person: { type: 'string', description: 'Who, as the owner said it, or their ping code <@id>. Not needed for list.' },
          scope: { type: 'string', enum: ['everything', 'music'], description: 'Default everything. music when the owner only means their music requests.' },
          minutes: { type: 'number', description: `Only if the owner gave a time ("for an hour" = 60). Leave out for "until I say so". Up to ${MAX_MINUTES}.` },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    acts: (a) => a.action !== 'list',
    async run(args, _signal, ctx) {
      if (!d.isOwner(ctx.userId)) return NOT_OWNER;
      const t = now();
      if (args.action === 'list') {
        const all = d.list.list();
        if (!all.length) return "I'm not ignoring anyone.";
        return `Ignoring: ${all.map((e) => `${e.name} (${e.scope === 'music' ? 'music requests only' : 'everything'}, ${left(e.until, t)})`).join('; ')}.`;
      }
      const said = typeof args.person === 'string' ? args.person.trim().slice(0, 64) : '';
      if (!said) return 'Not done: say who.';
      const found = (await d.find(said, ctx)).filter((p) => !p.bot);
      if (!found.length) return `Not done: I can't find anyone called ${said} here.`;
      if (found.length > 1 && found[0]!.name.toLowerCase() !== said.toLowerCase().replace(/^@/, ''))
        return `Not done: which one? ${found
          .slice(0, 5)
          .map((p) => p.name)
          .join(', ')}.`;
      const p = found[0]!;
      if (args.action === 'listen_again') {
        const had = d.list.get(p.id);
        if (!d.list.clear(p.id)) return `I wasn't ignoring ${p.name}.`;
        return had?.scope === 'music' ? `Okay, I'll take ${p.name}'s music requests again.` : `Okay, I'm listening to ${p.name} again.`;
      }
      if (args.action !== 'ignore') return 'Not done: unknown action.';
      if (p.id === ctx.userId) return "Not done: you can't ignore yourself.";
      if (d.isAppOwner(p.id)) return `Not done: ${p.name} owns me, so I can't ignore them.`;
      if (d.isOwner(p.id) && !d.isAppOwner(ctx.userId)) return `Not done: ${p.name} is an owner too; only the app owner can make me ignore an owner.`;
      const scope: IgnoreScope = args.scope === 'music' ? 'music' : 'everything';
      const m = typeof args.minutes === 'number' && Number.isFinite(args.minutes) && args.minutes > 0 ? Math.min(MAX_MINUTES, Math.ceil(args.minutes)) : undefined;
      d.list.set({ userId: p.id, name: p.name, scope, by: ctx.userId, at: t, ...(m ? { until: t + m * 60_000 } : {}) });
      d.onIgnored?.(p.id, scope);
      const how = m ? ` ${left(t + m * 60_000, t)}` : '';
      return scope === 'music' ? `Okay, no ${what(scope)} ${p.name}${how}.` : `Okay, ignoring ${p.name}${how}.`;
    },
    // Her answer is the tool's line: no second model call.
    speak: (_a, result) => result,
  };
}

/** A refusal for a music change from someone an owner put on the list, if they're on it. */
export function musicRefusal(list: IgnoreList | undefined, userId: UserId): string | undefined {
  return list?.blocks(userId, 'music') ? "An owner asked me not to take music requests from you." : undefined;
}
