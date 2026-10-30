// Music taste, remembered: what each person asks to hear (so "play some music
// I like" means something) and what she has come to like herself. Stored only
// on this server. A person's taste goes into that person's own prompt; hers
// goes into everyone's, since it's part of who she is.

import { readFileSync } from 'node:fs';
import type { Tool, UserId } from '../core/interfaces.js';
import { writeJsonFile } from '../web/secrets-file.js';

const MAX_ARTISTS = 200;
const MAX_LIST = 30;
const MAX_CHARS = 60;
/** A play counts half as much after this long: taste changes. */
const HALF_LIFE_MS = 60 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** Saying you like an artist counts as this many plays. */
const LIKED = 3;
/** Most artists in a "music I like" mix. */
const MIX_ARTISTS = 6;

interface Played {
  name: string;
  /** Plays, already faded to `at`. */
  score: number;
  at: number;
}

interface Person {
  played: Record<string, Played>;
  likes: string[];
  dislikes: string[];
}

interface Data {
  people: Record<UserId, Person>;
  her: { likes: string[]; dislikes: string[] };
}

const key = (s: string) => s.trim().toLowerCase();
const clean = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, MAX_CHARS);
const has = (list: string[], s: string) => list.some((x) => key(x) === key(s));
const without = (list: string[], s: string) => list.filter((x) => key(x) !== key(s));

export class MusicTaste {
  private data: Data = { people: {}, her: { likes: [], dislikes: [] } };

  constructor(
    private readonly file: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const d = JSON.parse(readFileSync(file, 'utf8')) as Partial<Data>;
        if (d && typeof d === 'object') this.data = { people: d.people ?? {}, her: { likes: d.her?.likes ?? [], dislikes: d.her?.dislikes ?? [] } };
      } catch {
        /* none yet */
      }
    }
  }

  private person(userId: UserId): Person {
    return (this.data.people[userId] ??= { played: {}, likes: [], dislikes: [] });
  }

  private faded(p: Played): number {
    return p.score * 0.5 ** ((this.now() - p.at) / HALF_LIFE_MS);
  }

  /** They asked to hear this artist. */
  played(userId: UserId, artist: string): void {
    const name = clean(artist);
    if (!name) return;
    const p = this.person(userId);
    const old = p.played[key(name)];
    p.played[key(name)] = { name: old?.name ?? name, score: (old ? this.faded(old) : 0) + 1, at: this.now() };
    const all = Object.entries(p.played);
    if (all.length > MAX_ARTISTS) {
      all.sort((a, b) => this.faded(a[1]) - this.faded(b[1]));
      for (const [k] of all.slice(0, all.length - MAX_ARTISTS)) delete p.played[k];
    }
    this.save();
  }

  /** The artists they like most, best first (not the ones they said they don't). */
  top(userId: UserId, n = MIX_ARTISTS): string[] {
    const p = this.data.people[userId];
    if (!p) return [];
    const score = new Map<string, { name: string; score: number }>();
    for (const [k, e] of Object.entries(p.played)) score.set(k, { name: e.name, score: this.faded(e) });
    for (const l of p.likes) {
      const e = score.get(key(l));
      score.set(key(l), { name: e?.name ?? l, score: (e?.score ?? 0) + LIKED });
    }
    return [...score.entries()]
      .filter(([k]) => !p.dislikes.some((d) => key(d) === k))
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, n)
      .map(([, e]) => e.name);
  }

  /** The artists she likes, a different few each time when she has many. */
  hers(n = MIX_ARTISTS): string[] {
    const l = this.data.her.likes;
    if (l.length <= n) return [...l];
    const start = Math.floor(this.now() / DAY_MS) % l.length;
    return [...l.slice(start), ...l.slice(0, start)].slice(0, n);
  }

  /** Remember a like or dislike; a new opinion replaces the opposite one. */
  private set(list: { likes: string[]; dislikes: string[] }, what: 'like' | 'dislike' | 'forget', name: string): string {
    const n = clean(name);
    if (!n) return 'Nothing to remember.';
    list.likes = without(list.likes, n);
    list.dislikes = without(list.dislikes, n);
    if (what === 'like') list.likes = [...list.likes, n].slice(-MAX_LIST);
    if (what === 'dislike') list.dislikes = [...list.dislikes, n].slice(-MAX_LIST);
    this.save();
    return what === 'forget' ? `Forgot ${n}.` : `Remembered: ${what}s ${n}.`;
  }

  /** Prompt lines: this person's taste (theirs alone) and hers. */
  context(userId: UserId, speaker: string): string[] {
    const lines: string[] = [];
    const { likes, dislikes } = this.data.her;
    if (likes.length || dislikes.length) {
      lines.push(`Your own taste in music: ${[likes.length ? `you like ${likes.join(', ')}` : '', dislikes.length ? `you don't like ${dislikes.join(', ')}` : ''].filter(Boolean).join('; ')}.`);
    } else {
      lines.push('You have not settled on your own taste in music yet: when it comes up, say what you actually like and save it with music_taste.');
    }
    const top = this.top(userId, 10);
    const no = this.data.people[userId]?.dislikes ?? [];
    if (top.length || no.length) {
      lines.push(`${speaker}'s taste in music: ${[top.length ? `likes ${top.join(', ')}` : '', no.length ? `doesn't like ${no.join(', ')}` : ''].filter(Boolean).join('; ')}. Pick music for them with this in mind, and only ever share it with ${speaker}.`);
    }
    return lines;
  }

  private save(): void {
    if (this.file) writeJsonFile(this.file, this.data);
  }

  tools(): Tool[] {
    return [
      {
        spec: {
          name: 'music_taste',
          description:
            'Save a music opinion for good. who: them (the person asking: "I love Frank Ocean", "I hate country") or you (your own taste, when you settle on what you like or go off something). what: like, dislike, or forget. name: an artist or a genre.',
          parameters: {
            type: 'object',
            properties: {
              who: { type: 'string', enum: ['them', 'you'] },
              what: { type: 'string', enum: ['like', 'dislike', 'forget'] },
              name: { type: 'string', description: 'The artist or genre, e.g. "Frank Ocean", "country".' },
            },
            required: ['who', 'what', 'name'],
            additionalProperties: false,
          },
        },
        run: async (a, _s, ctx) => {
          const what = a.what === 'dislike' || a.what === 'forget' ? a.what : 'like';
          const name = typeof a.name === 'string' ? a.name : '';
          return this.set(a.who === 'you' ? this.data.her : this.person(ctx.userId), what, name);
        },
      },
    ];
  }
}
