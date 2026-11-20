// Automatic per-person memory: every few exchanges, the model reads that
// person's recent conversation and saves anything worth remembering about
// them (games, pets, plans, likes) to their own notes. Runs in the
// background after an answer, so it never slows a reply down. Notes stay
// private to the person they're about; "forget everything" clears them.

import type { ChatMessage, LlmProvider, Logger, UserId } from '../core/interfaces.js';
import type { SessionMemory } from '../brain/sessions.js';
import type { UserNotes } from './notes.js';

/** Pull a JSON array of short strings out of a model reply. */
export function parseFacts(text: string): string[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  try {
    return facts(JSON.parse(m[0]) as unknown);
  } catch {
    return [];
  }
}

const facts = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length >= 3 && x.length <= 160).slice(0, 3)
    : [];

/** What one run changes: new facts, notes rewritten because they're out of
 *  date (by their number in the list it was shown), notes no longer true. */
export interface Changes {
  add: string[];
  update: { n: number; note: string }[];
  drop: number[];
}

/** The model's changes. `known`: how many notes it was shown, numbered from 1.
 *  A bare array (the old reply shape) is all new facts. */
export function parseChanges(text: string, known: number): Changes {
  const none: Changes = { add: [], update: [], drop: [] };
  const obj = /\{[\s\S]*\}/.exec(text);
  if (!obj || (text.indexOf('[') >= 0 && text.indexOf('[') < text.indexOf('{'))) return { ...none, add: parseFacts(text) };
  let v: unknown;
  try {
    v = JSON.parse(obj[0]);
  } catch {
    return none;
  }
  if (!v || typeof v !== 'object') return none;
  const o = v as { add?: unknown; update?: unknown; drop?: unknown };
  const n = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= known ? x : undefined);
  const update: Changes['update'] = [];
  for (const u of Array.isArray(o.update) ? o.update : []) {
    const at = n((u as { n?: unknown })?.n);
    const note = facts([(u as { note?: unknown })?.note])[0];
    if (at && note && !update.some((x) => x.n === at)) update.push({ n: at, note });
  }
  const drop = [...new Set((Array.isArray(o.drop) ? o.drop : []).map(n).filter((x): x is number => x !== undefined))].filter((d) => !update.some((u) => u.n === d));
  return { add: facts(o.add), update: update.slice(0, 3), drop: drop.slice(0, 3) };
}

export class AutoMemory {
  private readonly counts = new Map<UserId, number>();
  private running = false;

  constructor(
    private readonly llm: LlmProvider,
    private readonly notes: UserNotes,
    private readonly sessions: SessionMemory,
    private readonly log: Logger,
    /** Called with the tokens each run used, the model that used them and whose memory it was, for spend tracking. */
    private readonly onUsage: (inputTokens: number, outputTokens: number, model: string, userId: UserId) => void,
    private readonly everyTurns = 4,
    /** Used when `llm` fails before it answers (a local model that's off). */
    private readonly backup?: LlmProvider,
  ) {
    // "Forget everything" covers what was said, not only what's saved: this
    // reads the last turns, and they'd come straight back as new facts.
    notes.onForgotAll = (id) => {
      sessions.clear(id);
      this.counts.delete(id);
    };
  }

  /** Count an exchange; every few, learn from the conversation in the background. */
  afterTurn(userId: UserId, speaker: string): void {
    const n = (this.counts.get(userId) ?? 0) + 1;
    if (n < this.everyTurns) {
      this.counts.set(userId, n);
      return;
    }
    this.counts.set(userId, 0);
    if (this.running) return; // one at a time is plenty
    this.running = true;
    void this.learn(userId, speaker)
      .catch((e: Error) => this.log.warn('auto memory failed', { error: e.message.slice(0, 120) }))
      .finally(() => (this.running = false));
  }

  async learn(userId: UserId, speaker: string): Promise<string[]> {
    const turns = this.sessions.history(userId).slice(-10);
    if (!turns.some((t) => t.role === 'user')) return [];
    const known = this.notes.of(userId);
    const forgets = this.notes.forgets(userId);
    const transcript = turns.map((t) => `${t.role === 'user' ? speaker : 'Adrian'}: ${t.content}`).join('\n');
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          `You keep a short memory of facts about ${speaker}, a person who talks to a voice assistant. Read the conversation and keep the memory true. ` +
          `add: up to 3 NEW facts about ${speaker} worth remembering for weeks: preferences, games they play, people or pets in their life, plans, their job or school, things they asked to be remembered. ` +
          `update: when something ${speaker} said makes a remembered note out of date or wrong (they moved, quit a game, changed jobs, a plan happened or was called off), rewrite that note by its number to what is true now ("used to play Valorant", "moved to Chicago"). ` +
          `drop: numbers of notes ${speaker} said are no longer true, when nothing about them is worth keeping. ` +
          `Change or drop a note only when ${speaker} clearly says that it is no longer true of them; someone else doing, having or quitting the same thing changes nothing. Leave every note the conversation doesn't speak to alone. Only things ${speaker} said about themselves; no guesses, nothing about other people, no passwords or account details, nothing they asked to keep secret. Never save anything they asked you to forget or delete in this conversation. Write each note short, without their name ("plays Minecraft with Sam", "has a dog named Biscuit"). ` +
          `Reply with only JSON: {"add": ["..."], "update": [{"n": 2, "note": "..."}], "drop": [3]}. Use empty lists when nothing changes.`,
      },
      { role: 'user', content: `Already remembered:\n${known.map((k, i) => `${i + 1}. ${k}`).join('\n') || '(nothing yet)'}\n\nConversation:\n${transcript}` },
    ];
    const text = await this.ask(messages, userId);
    // They said to forget something while the model was reading: this may be it.
    if (this.notes.forgets(userId) !== forgets) return [];
    const c = parseChanges(text, known.length);
    let updated = 0;
    let dropped = 0;
    // By the text it was shown: the list may have changed while it read.
    for (const u of c.update) if (this.notes.replace(userId, known[u.n - 1]!, u.note)) updated++;
    for (const d of c.drop) if (this.notes.dropLearned(userId, known[d - 1]!)) dropped++;
    const saved = c.add.filter((f) => this.notes.add(userId, f, 'learned').startsWith('Remembered'));
    if (saved.length || updated || dropped) this.log.info('auto memory', { user: userId, saved: saved.length, updated, dropped });
    return saved;
  }

  /** One model reply; the backup answers if the first fails before saying anything. */
  private async ask(messages: ChatMessage[], userId: UserId): Promise<string> {
    const run = async (llm: LlmProvider) => {
      let text = '';
      let inTok = 0;
      let outTok = 0;
      try {
        for await (const ev of llm.stream(messages, { maxTokens: 300, signal: AbortSignal.timeout(30_000) })) {
          if (ev.type === 'text') text += ev.delta;
          else if (ev.type === 'usage') {
            inTok += ev.inputTokens;
            outTok += ev.outputTokens;
          }
        }
      } finally {
        if (inTok || outTok) this.onUsage(inTok, outTok, llm.model, userId);
      }
      return text;
    };
    if (!this.backup) return run(this.llm);
    try {
      return await run(this.llm);
    } catch (e) {
      this.log.info('memory model failed; using the main one', { error: (e as Error).message.slice(0, 120) });
      return run(this.backup);
    }
  }
}
