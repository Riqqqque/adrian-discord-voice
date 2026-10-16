// Short-term, per-user conversation memory (in memory only). Keyed by
// Discord user ID; one user's turns are never visible to another user.
// Interface is ready for A.D.R.I.A.N.'s persistent memory later.

import type { MemoryStore, UserId } from '../core/interfaces.js';

type Turn = { role: 'user' | 'assistant'; content: string };

export class SessionMemory implements MemoryStore {
  private readonly turns = new Map<UserId, { turns: Turn[]; lastUsed: number }>();

  constructor(
    /** Keep at most this many turns (user + assistant) per user. */
    private readonly maxTurns = 8,
    /** Forget a user's context after this much inactivity, ms. */
    private readonly idleMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  history(userId: UserId): Turn[] {
    const s = this.turns.get(userId);
    if (!s) return [];
    if (this.now() - s.lastUsed > this.idleMs) {
      this.turns.delete(userId);
      return [];
    }
    return s.turns.map((t) => ({ ...t }));
  }

  append(userId: UserId, turn: Turn): void {
    const s = this.turns.get(userId) ?? { turns: [], lastUsed: 0 };
    s.turns.push({ ...turn });
    if (s.turns.length > this.maxTurns) s.turns.splice(0, s.turns.length - this.maxTurns);
    s.lastUsed = this.now();
    this.turns.set(userId, s);
  }

  /** The last answer was stopped (told to shut up, or a new question came in):
   *  mark it so the model drops that topic instead of picking it back up. */
  markCutOff(userId: UserId): void {
    const s = this.turns.get(userId);
    const last = s?.turns[s.turns.length - 1];
    if (!s || !last) return;
    const note = '[Cut off here: they stopped you. Drop this topic; do not continue or repeat it unless they ask.]';
    if (last.role === 'assistant') last.content = `${last.content} ${note}`;
    else s.turns.push({ role: 'assistant', content: note });
  }

  clear(userId: UserId): void {
    this.turns.delete(userId);
  }
}
