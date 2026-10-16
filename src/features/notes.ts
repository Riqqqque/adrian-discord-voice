// Per-person memory: "remember that my birthday is in March". Notes belong
// to one Discord user, are stored only on this server, and are put into that
// user's own prompt; nobody else's conversation sees them.

import { readFileSync } from 'node:fs';
import type { Tool, UserId } from '../core/interfaces.js';
import { writeJsonFile } from '../web/secrets-file.js';

const MAX_NOTES = 30;
const MAX_CHARS = 200;

interface Note {
  text: string;
  at: number;
}

export class UserNotes {
  private data: Record<UserId, Note[]> = {};

  constructor(
    private readonly file: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8')) as Record<UserId, Note[]>;
        if (d && typeof d === 'object') this.data = d;
      } catch {
        /* none yet */
      }
    }
  }

  of(userId: UserId): string[] {
    return (this.data[userId] ?? []).map((n) => n.text);
  }

  /** `evictOldest`: when full, drop the oldest note instead of refusing (automatic saves). */
  add(userId: UserId, text: string, evictOldest = false): string {
    const t = text.trim().replace(/\s+/g, ' ').slice(0, MAX_CHARS);
    if (!t) return 'Nothing to remember.';
    const list = (this.data[userId] ??= []);
    if (list.some((n) => n.text.toLowerCase() === t.toLowerCase())) return 'Already remembered.';
    if (list.length >= MAX_NOTES) {
      if (!evictOldest) return `You have ${MAX_NOTES} notes, the most I keep; ask them to remove some first.`;
      list.shift();
    }
    list.push({ text: t, at: this.now() });
    this.save();
    return `Remembered: ${t}`;
  }

  /** Remove notes containing `what` (case-insensitive), or "all". */
  remove(userId: UserId, what: string): string[] {
    const list = this.data[userId] ?? [];
    const w = what.trim().toLowerCase();
    const gone = w === 'all' || w === 'everything' ? list : list.filter((n) => n.text.toLowerCase().includes(w));
    if (!gone.length || !w) return [];
    this.data[userId] = list.filter((n) => !gone.includes(n));
    if (!this.data[userId]!.length) delete this.data[userId];
    this.save();
    return gone.map((n) => n.text);
  }

  /** Prompt lines for this person's own requests. */
  context(userId: UserId, speaker: string): string[] {
    const mine = this.of(userId);
    return mine.length
      ? [`What you remember about ${speaker} (some they told you to remember, some you picked up from talking; use it naturally when relevant, and only ever share it with ${speaker}):`, ...mine.map((t) => `- ${t}`)]
      : [];
  }

  private save(): void {
    if (this.file) writeJsonFile(this.file, this.data);
  }

  tools(): Tool[] {
    return [
      {
        spec: {
          name: 'remember',
          description:
            'Save a fact the person asking wants you to remember for later (their preferences, dates, details). Write it as a short note in third person, e.g. "birthday is March 3".',
          parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
        },
        run: async (a, _s, ctx) => this.add(ctx.userId, typeof a.note === 'string' ? a.note : ''),
      },
      {
        spec: {
          name: 'forget',
          description: 'Delete saved notes of the person asking that contain the given words, or "all".',
          parameters: { type: 'object', properties: { what: { type: 'string' } }, required: ['what'], additionalProperties: false },
        },
        run: async (a, _s, ctx) => {
          const gone = this.remove(ctx.userId, typeof a.what === 'string' ? a.what : '');
          return gone.length ? `Forgot: ${gone.join('; ')}` : 'No matching notes.';
        },
      },
    ];
  }
}
