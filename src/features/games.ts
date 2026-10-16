// Party games: real randomness for dice and coins (models are bad at it),
// and a shared game per voice call (trivia, would-you-rather, riddles) with
// a scoreboard everyone in the call can play into.

import { randomInt } from 'node:crypto';
import type { Tool, ToolContext } from '../core/interfaces.js';

/** "2d6+1", "d20", "3d8-2" → rolls. */
export function rollDice(notation: string): { rolls: number[]; total: number; text: string } | undefined {
  const m = /^\s*(\d{0,2})\s*d\s*(\d{1,4})\s*(?:([+-])\s*(\d{1,4}))?\s*$/i.exec(notation);
  if (!m) return undefined;
  const n = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  if (n < 1 || n > 20 || sides < 2 || sides > 1000) return undefined;
  const mod = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  const rolls = Array.from({ length: n }, () => randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  const text = `${n}d${sides}${mod ? (mod > 0 ? `+${mod}` : mod) : ''}: ${rolls.join(', ')}${n > 1 || mod ? ` (total ${total})` : ''}`;
  return { rolls, total, text };
}

interface Game {
  kind: string;
  startedBy: string;
  question?: string;
  answer?: string;
  asked: number;
  scores: Map<string, number>;
  lastActive: number;
}

const IDLE_MS = 30 * 60_000;

export class PartyGames {
  private readonly games = new Map<string, Game>(); // per voice channel

  constructor(private readonly now: () => number = Date.now) {}

  private key(ctx: ToolContext): string {
    return ctx.channelId ?? `user:${ctx.userId}`;
  }

  private game(ctx: ToolContext): Game | undefined {
    const g = this.games.get(this.key(ctx));
    if (g && this.now() - g.lastActive > IDLE_MS) {
      this.games.delete(this.key(ctx));
      return undefined;
    }
    return g;
  }

  /** Prompt lines so everyone in the call can play the same game. */
  context(ctx: ToolContext): string[] {
    const g = this.game(ctx);
    if (!g) return [];
    const scores = [...g.scores].sort((a, b) => b[1] - a[1]).map(([p, s]) => `${p} ${s}`).join(', ') || 'none yet';
    return [
      `A ${g.kind} game is running in this call (started by ${g.startedBy}; ${g.asked} questions so far). Scores: ${scores}.`,
      ...(g.question
        ? [
            `Current question: ${g.question}`,
            `Correct answer (secret: never reveal it unless someone answers it, asks you to reveal it, or gives up): ${g.answer ?? 'no single answer'}.`,
            `If ${ctx.speaker} gives an actual answer: say whether it's right (be lenient with spelling and close answers), call game with action "award" only if it is right, then ask a new question with action "ask". If they don't name a real answer, ask them for one and award nothing. Never say the answer to a question that is still open.`,
          ]
        : ['No question is open; ask one with game action "ask" when someone wants to play.']),
      'Keep game talk short and fun. Anyone in the call may answer.',
    ];
  }

  tools(): Tool[] {
    return [
      {
        spec: {
          name: 'roll_dice',
          description: 'Roll dice with real randomness, e.g. "d20", "2d6", "3d8+2". Also use "d2" style for picking at random.',
          parameters: { type: 'object', properties: { dice: { type: 'string' } }, required: ['dice'], additionalProperties: false },
        },
        run: async (a) => rollDice(typeof a.dice === 'string' ? a.dice : '')?.text ?? 'Use dice like d20 or 2d6 (up to 20 dice).',
      },
      {
        spec: {
          name: 'flip_coin',
          description: 'Flip a coin with real randomness.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        run: async () => (randomInt(2) ? 'heads' : 'tails'),
      },
      {
        spec: {
          name: 'game',
          description:
            'Run a shared party game for the whole call. action "start" with kind (trivia, riddles, would you rather...) plus the first question and its answer; "ask" the next question with its answer; "award" points to a player; "scores"; "end".',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['start', 'ask', 'award', 'scores', 'end'] },
              kind: { type: 'string' },
              question: { type: 'string' },
              answer: { type: 'string' },
              player: { type: 'string', description: 'display name for award' },
              points: { type: 'number' },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
        run: async (a, _s, ctx) => {
          const k = this.key(ctx);
          const g = this.game(ctx);
          const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
          switch (a.action) {
            case 'start': {
              const ng: Game = { kind: str(a.kind) || 'trivia', startedBy: ctx.speaker, asked: 0, scores: new Map(), lastActive: this.now() };
              this.games.set(k, ng);
              if (str(a.question)) {
                ng.question = str(a.question);
                if (str(a.answer)) ng.answer = str(a.answer);
                ng.asked = 1;
                return `Started a ${ng.kind} game; question 1 is open. Say one short line of welcome, then read the question exactly as written.`;
              }
              return `Started a ${ng.kind} game. Now ask the first question with action "ask".`;
            }
            case 'ask': {
              if (!g) return 'No game running; start one first.';
              if (!str(a.question)) return 'Give the question.';
              g.question = str(a.question);
              if (str(a.answer)) g.answer = str(a.answer);
              else delete g.answer;
              g.asked++;
              g.lastActive = this.now();
              return `Question ${g.asked} is open. Read the question exactly as written, nothing else.`;
            }
            case 'award': {
              if (!g) return 'No game running.';
              const p = str(a.player) || ctx.speaker;
              const pts = typeof a.points === 'number' && Number.isFinite(a.points) ? Math.max(-10, Math.min(10, Math.round(a.points))) : 1;
              g.scores.set(p, (g.scores.get(p) ?? 0) + pts);
              delete g.question;
              delete g.answer;
              g.lastActive = this.now();
              return `${p} now has ${g.scores.get(p)} point${g.scores.get(p) === 1 ? '' : 's'}.`;
            }
            case 'scores': {
              if (!g) return 'No game running.';
              const s = [...g.scores].sort((x, y) => y[1] - x[1]);
              return s.length ? s.map(([p, n]) => `${p}: ${n}`).join(', ') : 'No points yet.';
            }
            case 'end': {
              if (!g) return 'No game running.';
              this.games.delete(k);
              const s = [...g.scores].sort((x, y) => y[1] - x[1]);
              return s.length ? `Game over. Final scores: ${s.map(([p, n]) => `${p} ${n}`).join(', ')}. Winner: ${s[0]![0]}.` : 'Game over. Nobody scored.';
            }
            default:
              return 'Unknown action.';
          }
        },
      },
    ];
  }
}
