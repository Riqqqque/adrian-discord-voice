// Conversation rules (brief section 3): one answer at a time with a short
// queue, duplicate-wake suppression, a follow-up window, interruption by
// the asker (or a priority role), and cancellation. Pure logic with an
// injected clock and responder so every rule is unit-tested.

import type { UserId } from '../core/interfaces.js';
import { classify } from './intents.js';

export interface ControllerOptions {
  /** Requests that may wait while one is answered. */
  queueMax: number;
  /** Waited longer than this → "Sorry, I missed that." instead. */
  maxWaitMs: number;
  /** Wakes from different people within this window: first one wins. */
  dedupeMs: number;
  /** After an answer, the same user may continue without the wake phrase. */
  followUpMs: number;
  /** The asker talking over the answer for this long stops it. */
  bargeInMs: number;
}

export const DEFAULT_CONTROLLER_OPTIONS: ControllerOptions = {
  queueMax: 2,
  maxWaitMs: 10_000,
  dedupeMs: 1_500,
  followUpMs: 8_000,
  bargeInMs: 2500, // laughs, reactions, side talk and echo stay under this; "stop" works at once
};

export interface ControllerDeps {
  now(): number;
  /** Answer one request; must stop promptly when `signal` aborts. */
  /** Answer one request. `followUp`: said without the wake phrase right after
   *  an answer. Return "silent" if it wasn't meant for the bot. */
  respond(userId: UserId, command: string, signal: AbortSignal, followUp?: boolean): Promise<void | 'silent'>;
  /** A stop for the bot while it isn't talking (stops the music). */
  stopOther?: (userId: UserId) => void;
  /** Short fixed reply (apologies, "Yes?", announcements); stops when `signal` aborts. */
  say(text: string, signal?: AbortSignal): Promise<void>;
  isPriority(userId: UserId): boolean;
  /** May stop anyone's answer with a stop phrase (but not just by talking). */
  canStop?(userId: UserId): boolean;
  /** Goes to the front: a new request stops someone else's answer. */
  preempts?(userId: UserId): boolean;
  /** Someone stopped an answer with a stop phrase. */
  onStopped?(userId: UserId): void;
  /** What to say to a bare wake (default "Yes?"). */
  ack?(userId: UserId): string;
  log?(event: string, fields: Record<string, unknown>): void;
}

export interface HeardInput {
  userId: UserId;
  text: string;
  woke: boolean;
  command: string;
  /** Woken loosely (bare name / mid-sentence): the model decides. */
  loose?: boolean;
}

interface Request {
  userId: UserId;
  command: string;
  at: number;
  /** A fixed announcement (timer done) instead of a question. */
  announce?: string;
  /** Said without the wake phrase, in the follow-up window. */
  followUp?: boolean;
}

export class ConversationController {
  private active: (Request & { ctl: AbortController; started: number }) | undefined;
  private readonly queue: Request[] = [];
  private readonly followUpUntil = new Map<UserId, number>();
  /** Users who just heard "Yes?": their next words are certainly for the bot. */
  /** After "Yes?": who it is waiting for, until when. */
  private readonly expecting = new Map<UserId, number>();
  /** When the bot last finished saying something (for "shut up" right after). */
  private lastSpoke = -Infinity;
  private lastAcceptedWake: { userId: UserId; at: number } | undefined;

  constructor(
    private readonly d: ControllerDeps,
    private readonly o: ControllerOptions = DEFAULT_CONTROLLER_OPTIONS,
  ) {}

  get busy(): boolean {
    return this.active !== undefined;
  }

  /** Drop everything: the current answer, the queue, open follow-ups
   *  (leaving or moving the call, restarting). */
  cancelAll(): void {
    this.queue.splice(0);
    this.followUpUntil.clear();
    this.expecting.clear();
    this.active?.ctl.abort();
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Would words from this person (without the wake phrase) be taken as a request? */
  listeningTo(userId: UserId): boolean {
    const now = this.d.now();
    return (this.expecting.get(userId) ?? 0) > now || (this.followUpUntil.get(userId) ?? 0) > now;
  }

  /** Say something unprompted (a timer going off) as soon as nothing else is
   *  being said. It goes ahead of waiting questions and can be stopped like
   *  an answer by the person it's for. */
  announce(userId: UserId, text: string): void {
    const req: Request = { userId, command: '', at: this.d.now(), announce: text };
    if (!this.active) void this.run(req);
    else this.queue.unshift(req);
  }

  /** A transcript arrived for a user. */
  heard(e: HeardInput): void {
    const now = this.d.now();
    const text = e.text.trim();

    // "stop", "shut up", "never mind", "stop listening", or just the name:
    // - from someone with a queued request (who isn't being answered):
    //   removes their request;
    // - a stop phrase from anyone (or the name from the asker, a priority
    //   role or the owner): stops the answer and ends the follow-up;
    // - with nothing to stop: silence (a bare "Hey Adrian" is still a wake).
    const intent = (e.woke && e.command.trim() ? classify(e.command) : undefined) ?? classify(text);
    if (intent?.kind === 'stop' || intent?.kind === 'name') {
      const a = this.active;
      const i = this.queue.findIndex((r) => r.userId === e.userId);
      if (i >= 0 && a?.userId !== e.userId) {
        this.queue.splice(i, 1);
        this.d.log?.('dequeued', { user: e.userId });
        if (intent.kind === 'stop') this.d.onStopped?.(e.userId);
        return;
      }
      const mayStop = this.d.isPriority(e.userId) || (this.d.canStop?.(e.userId) ?? false);
      // Anyone may stop it with a clear stop ("stop", "shut up") or with the
      // name; an everyday word ("done", "quiet") only counts from the asker.
      const clearStop = intent.kind === 'stop' && (!intent.weak || e.woke);
      if (a && (a.userId === e.userId || mayStop || clearStop)) {
        this.d.log?.('cancelled', { user: e.userId, by: intent.kind === 'stop' ? 'stop phrase' : 'name' });
        a.ctl.abort();
        this.followUpUntil.delete(a.userId);
        this.followUpUntil.delete(e.userId);
        if (intent.kind === 'stop') this.d.onStopped?.(e.userId);
        return;
      }
      if (intent.kind === 'stop') {
        // Nothing playing. Still acknowledge when it was clearly meant for the
        // bot: said with the name, during a follow-up, or right after it spoke.
        const forBot = e.woke || this.listeningTo(e.userId) || now - this.lastSpoke < 15_000;
        this.followUpUntil.delete(e.userId); // "stop listening" after an answer
        this.expecting.delete(e.userId);
        // Nothing being said, but music on: "stop" meant the music.
        // Music only stops when the stop was clearly for the bot: said with the
        // name, or by someone it's talking with, and not just an everyday word.
        if ((e.woke || this.listeningTo(e.userId)) && (!intent.weak || e.woke)) this.d.stopOther?.(e.userId);
        if (forBot) this.d.onStopped?.(e.userId);
        return;
      }
      if (!e.woke) return;
    }

    const inFollowUp = (this.followUpUntil.get(e.userId) ?? 0) > now;
    if (!e.woke && !inFollowUp) return;
    const command = e.woke ? e.command : text;

    // Several people waking at once: only the first valid wake counts.
    if (
      e.woke &&
      this.lastAcceptedWake &&
      now - this.lastAcceptedWake.at < this.o.dedupeMs &&
      this.lastAcceptedWake.userId !== e.userId &&
      !this.d.preempts?.(e.userId) // owners always get through
    ) {
      this.d.log?.('wake ignored (duplicate)', { user: e.userId });
      return;
    }
    if (e.woke) this.lastAcceptedWake = { userId: e.userId, at: now };
    this.followUpUntil.delete(e.userId);

    const wasExpecting = (this.expecting.get(e.userId) ?? 0) > now;
    this.expecting.delete(e.userId);
    const direct = wasExpecting && !e.woke;
    const judge = (e.woke && e.loose) || (!e.woke && !direct);
    const req: Request = { userId: e.userId, command, at: now, ...(judge ? { followUp: true } : {}) };
    if (!this.active) {
      void this.run(req);
    } else if (this.active.userId === e.userId) {
      // The asker spoke again: their newest request replaces what's running.
      this.d.log?.('replaced by newer request', { user: e.userId });
      this.queue.unshift(req);
      this.active.ctl.abort();
    } else if (e.woke && this.d.preempts?.(e.userId)) {
      // An owner who says the name cuts the line. Their side talk during a
      // follow-up doesn't, and whoever was cut off is answered right after.
      const bumped = this.active;
      this.d.log?.('owner first', { user: e.userId, over: bumped.userId });
      const i = this.queue.findIndex((r) => r.userId === e.userId);
      if (i >= 0) this.queue.splice(i, 1);
      if (!bumped.announce && bumped.command && !this.queue.some((r) => r.userId === bumped.userId)) {
        this.queue.unshift({ userId: bumped.userId, command: bumped.command, at: this.d.now(), ...(bumped.followUp ? { followUp: true } : {}) });
      }
      this.queue.unshift(req);
      bumped.ctl.abort();
    } else if (this.queue.length < this.o.queueMax && !this.queue.some((r) => r.userId === e.userId)) {
      this.queue.push(req);
      this.d.log?.('queued', { user: e.userId, position: this.queue.length });
    } else {
      this.d.log?.('dropped (queue full)', { user: e.userId });
    }
  }

  /** Continuous speech from a user, ms so far (from the VAD). */
  voiceActivity(userId: UserId, voicedMs: number): void {
    const a = this.active;
    if (!a || a.ctl.signal.aborted || voicedMs < this.o.bargeInMs) return; // already stopping: once is enough
    if (a.userId !== userId && !this.d.isPriority(userId)) return;
    // Ignore the tail of the request itself: barge-in only counts once the
    // answer has started.
    if (this.d.now() - a.started < this.o.bargeInMs) return;
    this.d.log?.('interrupted', { user: userId, voicedMs });
    a.ctl.abort();
    // Whatever they say next continues their conversation without the wake.
    this.followUpUntil.set(userId, this.d.now() + this.o.followUpMs);
  }

  private async run(req: Request): Promise<void> {
    if (!req.announce && this.d.now() - req.at > this.o.maxWaitMs) {
      this.d.log?.('expired in queue', { user: req.userId });
      const ctl = new AbortController();
      this.active = { ...req, ctl, started: this.d.now() };
      try {
        await this.d.say('Sorry, I missed that.', ctl.signal);
      } catch (e) {
        if (!ctl.signal.aborted) this.d.log?.('answer failed', { user: req.userId, error: (e as Error).message });
      } finally {
        this.active = undefined;
        this.next();
      }
      return;
    }
    const ctl = new AbortController();
    this.active = { ...req, ctl, started: this.d.now() };
    let silent = false;
    try {
      if (req.announce) await this.d.say(req.announce, ctl.signal);
      else if (req.command) silent = (await this.d.respond(req.userId, req.command, ctl.signal, req.followUp)) === 'silent';
      else {
        await this.d.say(this.d.ack?.(req.userId) ?? 'Yes?', ctl.signal);
        this.expecting.set(req.userId, this.d.now() + 20_000);
      }
    } catch (e) {
      if (!ctl.signal.aborted) {
        this.d.log?.('answer failed', { user: req.userId, error: (e as Error).message });
        try {
          await this.d.say("Sorry, I couldn't get an answer just now.");
        } catch {
          /* nothing more to do */
        }
      }
    } finally {
      this.active = undefined;
      this.lastSpoke = this.d.now();
      if (silent) {
        this.d.log?.('not for me', { user: req.userId });
        this.followUpUntil.delete(req.userId);
      } else if (!ctl.signal.aborted || req.command === '') {
        this.followUpUntil.set(req.userId, this.d.now() + this.o.followUpMs);
      }
      this.next();
    }
  }

  private next(): void {
    const r = this.queue.shift();
    if (r) void this.run(r);
  }
}
