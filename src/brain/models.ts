// Several models, and which one answers. Off unless `brain.models` lists some:
// then the main model (`brain`) is one choice among them, each kind of job
// (chat, writing, background) has its own pick, and people can switch for a
// while ("use the smart model for this", "/model use smart").
//
// Who may switch, and to what, is checked here, not by the model: owners
// choose by default, and a model marked ownersOnly is theirs alone. When the
// day's or month's spend is nearly used up, guests move to the cheaper pick
// by themselves. A model marked local runs on this machine or this network
// (checked when the config loads), and a job pinned to local models never
// moves to one in the cloud.

import { isIP } from 'node:net';
import type { Tool, UserId } from '../core/interfaces.js';

export type ModelJob = 'chat' | 'writing' | 'background';

export interface ModelInfo {
  /** What people call it: "smart", "fast", "private". */
  name: string;
  /** The provider's model id, for logs and "what model are you on". */
  model: string;
  /** One line on what it's good for, said when someone asks for the list. */
  about?: string;
  local: boolean;
  ownersOnly: boolean;
}

export interface ModelPickerOptions {
  /** Which model each job uses by default (names; missing: the main model). */
  routes?: Partial<Record<ModelJob, string>>;
  /** Who may switch: owners (default), everyone, or nobody (routes only). */
  switching?: 'owners' | 'everyone' | 'off';
  /** Spend this share of the daily or monthly cap (0-1) and guests use `lowBudget.model`. */
  lowBudget?: { model: string; at: number };
  /** A switch ends this long after it was last used (ms). */
  holdMs?: number;
  now?: () => number;
}

interface Held {
  name: string;
  until: number;
}

const HOLD_MS = 30 * 60_000;

export class ModelPicker {
  private readonly byName = new Map<string, ModelInfo>();
  private readonly held = new Map<UserId, Held>();
  private readonly now: () => number;

  /** `models[0]` is the main model. */
  constructor(
    readonly models: ModelInfo[],
    private readonly o: ModelPickerOptions = {},
  ) {
    if (!models.length) throw new Error('ModelPicker needs at least the main model');
    for (const m of models) this.byName.set(m.name.toLowerCase(), m);
    this.now = o.now ?? Date.now;
  }

  get main(): ModelInfo {
    return this.models[0]!;
  }

  find(name: string): ModelInfo | undefined {
    const q = name.trim().toLowerCase().replace(/\s+model$/, '');
    return this.byName.get(q) ?? this.models.find((m) => m.model.toLowerCase() === q);
  }

  /** The model for this person's next `job`. `spent`: share of the tightest cap used (0-1). */
  pick(userId: UserId, job: ModelJob, owner: boolean, spent = 0): ModelInfo {
    const h = this.current(userId);
    if (h && (owner || !h.ownersOnly)) return h;
    const route = this.find(this.o.routes?.[job] ?? '') ?? this.main;
    const low = this.o.lowBudget && !owner && spent >= this.o.lowBudget.at ? this.find(this.o.lowBudget.model) : undefined;
    return low ?? route;
  }

  /** Their switch, if one is running (each use keeps it going). */
  current(userId: UserId): ModelInfo | undefined {
    const h = this.held.get(userId);
    if (!h) return undefined;
    if (h.until <= this.now()) {
      this.held.delete(userId);
      return undefined;
    }
    h.until = this.now() + (this.o.holdMs ?? HOLD_MS);
    return this.find(h.name);
  }

  /** Why `userId` may not switch to `m`, if they may not. */
  refusal(m: ModelInfo, owner: boolean): string | undefined {
    const who = this.o.switching ?? 'owners';
    if (who === 'off') return 'Not done: switching models is turned off here.';
    if (who === 'owners' && !owner) return "Not done: only the bot's owners switch models.";
    if (m.ownersOnly && !owner) return `Not done: the ${m.name} model is for the bot's owners.`;
    return undefined;
  }

  use(userId: UserId, m: ModelInfo): void {
    this.held.set(userId, { name: m.name, until: this.now() + (this.o.holdMs ?? HOLD_MS) });
  }

  reset(userId: UserId): boolean {
    return this.held.delete(userId);
  }
}

/** True for loopback, private (RFC 1918, ULA, link-local), CGNAT, .local and
 *  .internal hosts and bare names: places that aren't the public internet. */
export function isLocalBase(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || (host.startsWith('::ffff:') && isLocalBase(`http://${host.slice(7)}`));
  // A bare name ("ollama", "gpu-box") resolves on this network only.
  return !host.includes('.');
}

export interface ModelToolDeps {
  picker: ModelPicker;
  isOwner(id: UserId): boolean;
  onSwitch?(userId: UserId, m: ModelInfo | undefined): void;
}

const label = (m: ModelInfo) => `${m.name}${m.local ? ' (runs here)' : ''}`;

export function modelTool(d: ModelToolDeps): Tool {
  const p = d.picker;
  return {
    spec: {
      name: 'use_model',
      description:
        "Switch which of your language models answers this person, switch back, say which one is answering, or list them. Call it when someone asks you to use a smarter, faster, cheaper, local or named model (\"use the smart model for this\", \"switch to private\"), to go back to normal, or asks what model you're on or which ones you have. The tool checks who may switch: never refuse yourself, just call it and say its answer. A switch lasts until they switch back or stop talking to you for half an hour.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['use', 'reset', 'which', 'list'] },
          model: { type: 'string', description: `For use: one of ${p.models.map((m) => m.name).join(', ')}, or how they described it.` },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    route: /\b(models?|smart(er)?|fast(er)?|cheap(er)?|local|private|switch|(go|switch) back|normal)\b/i,
    acts: (a) => a.action === 'use' || a.action === 'reset',
    async run(args, _signal, ctx) {
      const owner = d.isOwner(ctx.userId);
      if (args.action === 'list') return `Models: ${p.models.map((m) => `${label(m)}${m.about ? `, ${m.about}` : ''}${m.ownersOnly ? ', owners only' : ''}`).join('; ')}.`;
      if (args.action === 'which') {
        const m = p.current(ctx.userId);
        return m ? `Right now you're on ${label(m)} (${m.model}).` : `You're on the usual one, ${label(p.main)} (${p.main.model}).`;
      }
      if (args.action === 'reset') {
        const had = p.reset(ctx.userId);
        d.onSwitch?.(ctx.userId, undefined);
        return had ? `Okay, back to ${p.main.name}.` : `You're already on ${p.main.name}.`;
      }
      if (args.action !== 'use') return 'Not done: unknown action.';
      const said = typeof args.model === 'string' ? args.model : '';
      const m = p.find(said);
      if (!m) return `Not done: I don't have a model called ${said.slice(0, 40) || 'that'}. I have ${p.models.map((x) => x.name).join(', ')}.`;
      const no = p.refusal(m, owner);
      if (no) return no;
      p.use(ctx.userId, m);
      d.onSwitch?.(ctx.userId, m);
      return `Okay, using ${label(m)} for you now.`;
    },
    speak: (_a, result) => result,
  };
}
