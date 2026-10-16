// Automatic per-person memory: every few exchanges, the model reads that
// person's recent conversation and saves anything worth remembering about
// them (games, pets, plans, likes) to their own notes. Runs in the
// background after an answer, so it never slows a reply down. Notes stay
// private to the person they're about; "forget everything" clears them.

import type { LlmProvider, Logger, UserId } from '../core/interfaces.js';
import type { SessionMemory } from '../brain/sessions.js';
import type { UserNotes } from './notes.js';

/** Pull a JSON array of short strings out of a model reply. */
export function parseFacts(text: string): string[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x.length >= 3 && x.length <= 160).slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

export class AutoMemory {
  private readonly counts = new Map<UserId, number>();
  private running = false;

  constructor(
    private readonly llm: LlmProvider,
    private readonly notes: UserNotes,
    private readonly sessions: SessionMemory,
    private readonly log: Logger,
    /** Called with the tokens each run used, for spend tracking. */
    private readonly onUsage: (inputTokens: number, outputTokens: number) => void,
    private readonly everyTurns = 4,
  ) {}

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
    const transcript = turns.map((t) => `${t.role === 'user' ? speaker : 'Adrian'}: ${t.content}`).join('\n');
    let text = '';
    let inTok = 0;
    let outTok = 0;
    for await (const ev of this.llm.stream(
      [
        {
          role: 'system',
          content:
            `You keep a short memory of facts about ${speaker}, a person who talks to a voice assistant. From the conversation, list up to 3 NEW facts about ${speaker} worth remembering for weeks: preferences, games they play, people or pets in their life, plans, their job or school, things they asked to be remembered. Only things ${speaker} said about themselves; no guesses, nothing about other people, no passwords or account details, nothing they asked to keep secret. Write each as a short note without their name ("plays Minecraft with Sam", "has a dog named Biscuit"). Reply with only a JSON array of strings, or [] if there's nothing new.`,
        },
        { role: 'user', content: `Already remembered:\n${known.map((k) => `- ${k}`).join('\n') || '(nothing yet)'}\n\nConversation:\n${transcript}` },
      ],
      { maxTokens: 200, signal: AbortSignal.timeout(20_000) },
    )) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'usage') {
        inTok += ev.inputTokens;
        outTok += ev.outputTokens;
      }
    }
    this.onUsage(inTok, outTok);
    const facts = parseFacts(text);
    const saved = facts.filter((f) => this.notes.add(userId, f, true).startsWith('Remembered'));
    if (saved.length) this.log.info('auto memory', { user: userId, saved: saved.length });
    return saved;
  }
}
