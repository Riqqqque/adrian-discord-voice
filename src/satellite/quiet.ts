// Quiet while gaming (config satellite.quietWhileGaming). A PC app from 0.15.6
// says when its owner is playing (`activity` messages, docs/satellite.md).
// While they are, that PC's room only answers to her name, keeps answers
// short, and holds what can wait: reminders (never timers, which they set to
// ring). A reminder's DM, the record, is held with it, so no Discord
// notification pops up over the game. When the match ends the DMs go and they
// hear one line about what came in. Held items are kept on disk, per owner, at
// most 50 for at most 12 hours, and never dropped without going out some
// other way: an item leaves the file only once its release has run, so one
// cut short by a restart goes out again after it (its DM only if that hadn't
// gone yet).

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { UserId } from '../core/interfaces.js';
import { writeJsonFile } from '../web/secrets-file.js';

export interface Activity {
  gaming: boolean;
  /** The game's name, when the PC could tell. */
  game?: string;
}

/** An `activity` message from a PC, or undefined if it isn't a valid one. */
export function parseActivity(m: Record<string, unknown>): Activity | undefined {
  if (m.type !== 'activity' || typeof m.gaming !== 'boolean') return undefined;
  // It goes into the prompt: printable text only, and short.
  const game = typeof m.game === 'string' ? m.game.replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} .:'&+\-!]/gu, '').replace(/ {2,}/g, ' ').trim().slice(0, 60) : '';
  return m.gaming && game ? { gaming: true, game } : { gaming: m.gaming };
}

export interface HeldItem {
  id: string;
  owner: UserId;
  kind: 'reminder' | 'message';
  /** What she'd have said ("Reminder: take out the laundry."). */
  line: string;
  /** For the summary ("your laundry reminder came up"). */
  brief: string;
  at: number;
  /** A DM with it already went out (the record), so none is needed later. */
  dmSent: boolean;
  /** The DM to send when it's released (the record, worded as it was due). */
  dm?: string;
  /** Being released now. Still on disk until that's done; a restart in
   *  between releases it again. */
  releasing?: boolean;
}

/** Most items held per owner. */
export const HELD_MAX = 50;
/** Most held for everyone together, so the file stays small. */
export const HELD_TOTAL_MAX = 500;
export const HELD_TTL_MS = 12 * 3_600_000;

/** Held items, saved to disk on every change. */
export class HeldItems {
  private list: HeldItem[] = [];

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(d)) {
        // Newest kept, HELD_MAX per owner. One that was being released when
        // the process stopped waits to be released again.
        const per = new Map<UserId, number>();
        const kept: HeldItem[] = [];
        for (const i of d.filter(isItem).reverse()) {
          const n = per.get(i.owner) ?? 0;
          if (n >= HELD_MAX || kept.length >= HELD_TOTAL_MAX) continue;
          per.set(i.owner, n + 1);
          delete i.releasing;
          kept.push(i);
        }
        this.list = kept.reverse();
      }
    } catch {
      /* none yet */
    }
  }

  /** Undefined when their list is full: then it goes out the normal way. */
  add(i: Omit<HeldItem, 'id' | 'at'>): HeldItem | undefined {
    if (this.count(i.owner) >= HELD_MAX || this.list.length >= HELD_TOTAL_MAX) return undefined;
    const item: HeldItem = { ...i, id: randomUUID().slice(0, 8), at: this.now() };
    this.list.push(item);
    this.save();
    return item;
  }

  /** Waiting for this person (not counting what is being released). */
  count(owner: UserId): number {
    return this.list.filter((i) => i.owner === owner && !i.releasing).length;
  }

  owners(): UserId[] {
    return [...new Set(this.list.filter((i) => !i.releasing).map((i) => i.owner))];
  }

  /** Take everything held for this person, oldest first. They stay on disk,
   *  marked as being released, until `done`. */
  take(owner: UserId): HeldItem[] {
    const mine = this.list.filter((i) => i.owner === owner && !i.releasing);
    if (!mine.length) return [];
    for (const i of mine) i.releasing = true;
    this.save();
    return mine;
  }

  /** Take what has waited too long, by owner (marked like `take`). */
  takeExpired(): Map<UserId, HeldItem[]> {
    const cutoff = this.now() - HELD_TTL_MS;
    const out = new Map<UserId, HeldItem[]>();
    const old = this.list.filter((i) => i.at <= cutoff && !i.releasing);
    if (!old.length) return out;
    for (const i of old) {
      i.releasing = true;
      out.set(i.owner, [...(out.get(i.owner) ?? []), i]);
    }
    this.save();
    return out;
  }

  /** A taken item changed (its DM went): saved, so a restart won't send it twice. */
  changed(): void {
    this.save();
  }

  /** Their release has run: off the disk. */
  done(items: readonly HeldItem[]): void {
    const ids = new Set(items.map((i) => i.id));
    const before = this.list.length;
    this.list = this.list.filter((i) => !ids.has(i.id));
    if (this.list.length !== before) this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeJsonFile(this.file, this.list);
    } catch {
      /* still held in memory */
    }
  }
}

function isItem(x: unknown): x is HeldItem {
  const i = x as HeldItem;
  return !!i && typeof i.id === 'string' && typeof i.owner === 'string' && (i.kind === 'reminder' || i.kind === 'message') && typeof i.line === 'string' && typeof i.brief === 'string' && typeof i.at === 'number' && typeof i.dmSent === 'boolean' && (i.dm === undefined || typeof i.dm === 'string') && (i.releasing === undefined || typeof i.releasing === 'boolean');
}

const GENERIC_REMINDER = 'a reminder came up';

/** "your laundry reminder came up", or a plain one when the text is long. */
export function reminderBrief(text: string): string {
  const t = text.trim().replace(/[.!?]+$/, '');
  return t && t.length <= 24 && t.split(/\s+/).length <= 3 && !/\breminder\b/i.test(t) ? `your ${t} reminder came up` : GENERIC_REMINDER;
}

export function messageBrief(from: string): string {
  return `${from} sent a message`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The one line she says when the match ends. One or two items: what they were.
 *  More: a summary, and the details when asked. */
export function releaseText(items: readonly HeldItem[]): string {
  if (!items.length) return '';
  if (items.length <= 2) return `While you were playing: ${items.map((i) => upper(i.line.trim())).join(' ')}`;
  const parts: string[] = [];
  const generic = items.filter((i) => i.brief === GENERIC_REMINDER).length;
  for (const i of items) if (i.brief !== GENERIC_REMINDER && !parts.includes(i.brief)) parts.push(i.brief);
  if (generic) parts.push(generic === 1 ? GENERIC_REMINDER : `${generic} reminders came up`);
  const shown = parts.length > 3 ? [...parts.slice(0, 2), `${parts.length - 2} more things came in`] : parts;
  return `While you were playing: ${list(shown)}. Ask me if you want the details.`;
}

/** What a PC looks like to quiet mode. */
export interface QuietPc {
  readonly device: { id: string };
  readonly owner: UserId;
  isReady(): boolean;
}

export interface GameQuietDeps {
  enabled(): boolean;
  /** Connected PCs. */
  pcs(): readonly QuietPc[];
  /** Say it at that PC (or in her call, if that's where they are). Resolves whether it was heard. */
  sayAt(pc: QuietPc, owner: UserId, text: string): Promise<boolean>;
  /** No PC to say it at: her call if they're in it, else a DM of what didn't have one yet. */
  elsewhere(owner: UserId, items: HeldItem[], text: string): Promise<void>;
  /** Send a held item's own DM (its `dm`). Resolves whether it went. */
  dm?(owner: UserId, text: string): Promise<boolean>;
  now?(): number;
  log?(event: string, fields: Record<string, unknown>): void;
}

/** A PC just connected: give it this long to say it's in a game. */
export const SETTLE_MS = 5_000;
/** Their playing PC went away: wait this long for it to come back before
 *  sending what's held some other way. */
export const LOST_MS = 2 * 60_000;
/** What came in stays in the prompt this long, for "what was it?". */
const TOLD_MS = 30 * 60_000;
const SWEEP_MS = 30_000;

export class GameQuiet {
  private readonly playing = new Map<string, { pc: QuietPc; game?: string }>();
  /** When each PC connected. */
  private readonly seen = new Map<string, number>();
  /** When an owner's playing PC went away, and which one. */
  private readonly lost = new Map<UserId, { at: number; device: string }>();
  private readonly recent = new Map<UserId, { items: HeldItem[]; until: number }>();
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly held: HeldItems,
    private readonly d: GameQuietDeps,
  ) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    this.timer ??= setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** That PC is in a game right now, and quiet mode is on. */
  playingAt(pc: QuietPc): boolean {
    return this.d.enabled() && this.playing.has(pc.device.id);
  }

  gameAt(pc: QuietPc): string | undefined {
    return this.playingAt(pc) ? this.playing.get(pc.device.id)?.game : undefined;
  }

  private ownerPlaying(owner: UserId): boolean {
    return this.d.enabled() && [...this.playing.values()].some((p) => p.pc.owner === owner);
  }

  connected(pc: QuietPc): void {
    this.seen.set(pc.device.id, this.now());
    if (this.held.count(pc.owner)) setTimeout(() => this.sweep(), SETTLE_MS + 50).unref();
  }

  disconnected(pc: QuietPc): void {
    this.seen.delete(pc.device.id);
    if (this.playing.delete(pc.device.id)) this.lost.set(pc.owner, { at: this.now(), device: pc.device.id });
  }

  /** Connected long enough to have said whether it's in a game. */
  private settled(p: QuietPc, now: number): boolean {
    return p.isReady() && now - (this.seen.get(p.device.id) ?? -Infinity) >= SETTLE_MS;
  }

  /** Their PC dropped mid-game under LOST_MS ago and isn't back and settled:
   *  they may still be playing there, so nothing goes out at another PC yet. */
  private waitingForLost(owner: UserId, now = this.now()): boolean {
    const l = this.lost.get(owner);
    return !!l && now - l.at < LOST_MS && !this.d.pcs().some((p) => p.device.id === l.device && this.settled(p, now));
  }

  /** An `activity` message. True when it changed whether that PC is playing. */
  activity(pc: QuietPc, a: Activity): boolean {
    const was = this.playing.has(pc.device.id);
    if (a.gaming) {
      this.playing.set(pc.device.id, { pc, ...(a.game ? { game: a.game } : {}) });
      this.lost.delete(pc.owner);
    } else this.playing.delete(pc.device.id);
    if (was === a.gaming) return false;
    this.d.log?.(a.gaming ? 'pc game started' : 'pc game ended', { device: pc.device.id, held: this.held.count(pc.owner) });
    if (!a.gaming && !this.ownerPlaying(pc.owner) && !this.waitingForLost(pc.owner)) this.release(pc.owner, pc);
    return true;
  }

  /** Keep this for after the match, if that PC is playing. False: deliver it now. */
  hold(pc: QuietPc, item: Omit<HeldItem, 'id' | 'at' | 'owner'>): boolean {
    if (!this.playingAt(pc)) return false;
    const kept = this.held.add({ ...item, owner: pc.owner });
    this.d.log?.(kept ? 'held for after the game' : 'hold list full; delivering now', { kind: item.kind });
    return !!kept;
  }

  /** For the prompt: what came in during the match, while it's fresh. */
  told(owner: UserId): HeldItem[] {
    const t = this.recent.get(owner);
    if (t && t.until > this.now()) return t.items;
    this.recent.delete(owner);
    return [];
  }

  /** The DMs held with these items go now, whatever happens to the spoken
   *  line: they're the record. One that fails is left for `elsewhere`. */
  private async records(owner: UserId, items: HeldItem[]): Promise<void> {
    for (const i of items) {
      if (i.dmSent || !i.dm || !this.d.dm) continue;
      i.dmSent = await this.d.dm(owner, i.dm).catch(() => false);
      if (i.dmSent) this.held.changed();
    }
  }

  private release(owner: UserId, pc: QuietPc): void {
    const items = this.held.take(owner);
    if (!items.length) return;
    const text = releaseText(items);
    this.recent.set(owner, { items, until: this.now() + TOLD_MS });
    this.d.log?.('held items released', { count: items.length, at: 'pc' });
    const sent = this.records(owner, items);
    void this.d
      .sayAt(pc, owner, text)
      .catch(() => false)
      .then(async (heard) => {
        await sent;
        if (!heard) await this.d.elsewhere(owner, items, text);
      })
      .catch(() => undefined)
      .finally(() => this.held.done(items));
  }

  private away(owner: UserId, items: HeldItem[]): void {
    if (!items.length) return;
    const text = releaseText(items);
    this.recent.set(owner, { items, until: this.now() + TOLD_MS });
    this.d.log?.('held items released', { count: items.length, at: 'elsewhere' });
    void this.records(owner, items)
      .then(() => this.d.elsewhere(owner, items, text))
      .catch(() => undefined)
      .finally(() => this.held.done(items));
  }

  /** Expired items, owners no longer playing, PCs that went away. Runs every
   *  30 s (nothing to do while nothing is held) and after a PC connects. */
  sweep(): void {
    const now = this.now();
    for (const [owner, items] of this.held.takeExpired()) this.away(owner, items);
    for (const [owner, l] of this.lost) if (now - l.at > LOST_MS * 4) this.lost.delete(owner);
    for (const [id, t] of this.recent) if (t.until <= now) this.recent.delete(id);
    for (const owner of this.held.owners()) {
      if (this.ownerPlaying(owner)) continue;
      // The PC they were playing on dropped: give it LOST_MS to come back,
      // even when another of their PCs is here (it would pop the DMs up over the game).
      if (this.waitingForLost(owner, now)) continue;
      // A PC of theirs that has had time to say whether it's in a game: the
      // one that dropped first, if it's back.
      const lostAt = this.lost.get(owner)?.device;
      const mine = this.d.pcs().filter((p) => p.owner === owner && this.settled(p, now));
      const pc = mine.find((p) => p.device.id === lostAt) ?? mine[0];
      if (pc) {
        this.release(owner, pc);
        continue;
      }
      if (this.d.pcs().some((p) => p.owner === owner && p.isReady())) continue; // one is settling
      if (now - (this.lost.get(owner)?.at ?? this.startedAt) >= LOST_MS) this.away(owner, this.held.take(owner));
    }
  }
}

/** The prompt line for a room whose PC is in a game. */
export function gamingLine(speaker: string, game: string | undefined): string {
  return `${speaker} is playing ${game ?? 'a game'} at this PC right now. Keep every answer to one short sentence and ask nothing back unless you have to: they're in a match. If they ask whether they're in a game, say so.`;
}

/** The prompt line for what came in during their last match. */
export function toldLine(speaker: string, items: readonly HeldItem[]): string[] {
  return items.length ? [`While ${speaker} was playing, these came in (they've heard a one-line summary; give details if asked): ${items.map((i) => i.line.trim()).join(' ')}`] : [];
}
