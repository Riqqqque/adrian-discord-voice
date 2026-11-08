// Minecraft server control through Helix: start, stop, restart, whitelist,
// in-game chat, and a status that knows starting, stopped and crashed. The
// model names a server; the config maps it to a Helix instance, so the model
// never sees or sends an instance ID. Console commands are built only from
// checked parts. Stop and restart wait for the person's own yes.

import { PendingYes } from '../brain/tools.js';
import type { Logger, Tool, ToolContext, UserId } from '../core/interfaces.js';
import { describeStatus, pingMinecraft, type GameServer, type McStatus } from './gameservers.js';
import { HelixError, type HelixClient, type HelixDetail, type HelixFailure, type HelixJob } from './helix.js';

export interface ControlledServer extends GameServer {
  helix?: { instanceId: string; bedrock: boolean; bedrockPrefix: string } | undefined;
}

export type ServerAction = 'start' | 'stop' | 'restart' | 'whitelist' | 'say';
type Lifecycle = 'start' | 'stop' | 'restart';

export interface ControlSettings {
  /** Discord user or role IDs per action, besides the owners. */
  allow: Record<ServerAction, readonly string[]>;
  startWaitSec: number;
  stopWaitSec: number;
  sayMaxChars: number;
}

/** Who asked, and where: where the answer goes when the job is done. */
export interface Asker {
  userId: UserId;
  speaker: string;
  channelId?: string;
  guildId?: string;
}

export interface ServerControlDeps {
  servers: ControlledServer[];
  /** Undefined when the HELIX_TOKEN key is missing. */
  client?: HelixClient | undefined;
  settings: ControlSettings;
  isOwner(userId: UserId): boolean;
  /** Has the person one of these roles (in this guild, or the bot's own)? */
  hasRole(userId: UserId, guildId: string | undefined, roleIds: readonly string[]): boolean;
  /** Tell them later (in the call, at their PC, in the chat they asked in, or by DM). */
  announce(to: Asker, text: string): void | Promise<unknown>;
  log: Logger;
  ping?: (host: string, port: number) => Promise<McStatus>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** For tests: how long the tool itself waits for a job, the poll gap, and so on. */
  timing?: Partial<{ inlineSec: number; pollMs: number; retryMs: number; verifyMs: number; statusCacheMs: number }>;
}

export const TOKEN_MISSING = "Server control isn't set up: the HELIX_TOKEN key is missing.";

const JAVA_NAME = /^[A-Za-z0-9_]{3,16}$/;
const GAMERTAG = /^[A-Za-z0-9](?:[A-Za-z0-9]| (?! ))*$/;
/** The only console lines this file ever sends. */
const SAFE_COMMANDS = [/^whitelist (?:add|remove) [A-Za-z0-9_]{3,16}$/, /^whitelist list$/, /^fwhitelist (?:add|remove) "[A-Za-z0-9 ]{1,16}"$/, /^list$/, /^say [^\r\n§]{1,480}$/];

/** Last check before a line goes to a console: one line, nothing hidden, one of the shapes above. */
export function safeCommand(cmd: string): boolean {
  return !/[\p{C}§]/u.test(cmd) && Buffer.byteLength(cmd, 'utf8') < 500 && SAFE_COMMANDS.some((r) => r.test(cmd));
}

/** Text from Helix or a game console, made fit to say: no color codes, no
 *  control characters, one line, capped, ending in a full stop. */
export function clean(text: unknown, max = 160): string {
  const s = String(text ?? '')
    .replace(/§./g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
  return !cut ? '' : /[.!?…]$/.test(cut) ? cut : `${cut}.`;
}

/** Their chat message as the game will show it: one line, no color codes,
 *  no target selectors, capped. */
export function chatText(text: unknown, max: number): string {
  const s = String(text ?? '')
    .normalize('NFKC')
    .replace(/§./gu, '')
    .replace(/[\p{C}§@]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let out = s.length > max ? s.slice(0, max).trimEnd() : s;
  while (Buffer.byteLength(out, 'utf8') > 400) out = out.slice(0, -1);
  return out;
}

const FILLER = new Set(['the', 'server', 'servers', 'minecraft', 'mc', 'world', 'one', 'our', 'my', 'a']);
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const words = (s: string) => norm(s).split(' ').filter((w) => w && !FILLER.has(w));
const compact = (s: string) => words(s).join('') || norm(s).replace(/ /g, '');

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** "A", "A or B", "A, B or C". */
export function either(names: string[], word = 'or'): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`;
}

/** The server they mean: exact name, then part of it, a shared word, then a
 *  near miss (speech recognition: "survivor" for "Survival"). One server is
 *  the default; more than one equally good match is a question. */
export function resolveServer<T extends { name: string }>(query: unknown, servers: readonly T[]): { server: T } | { reply: string; ask?: boolean } {
  if (!servers.length) return { reply: 'No game servers are set up.' };
  const q = typeof query === 'string' ? query.trim() : '';
  // Only filler ("the server") names no server in particular.
  const qc = words(q).join('');
  if (!qc) return servers.length === 1 ? { server: servers[0]! } : { reply: `Which server: ${either(servers.map((s) => s.name))}?`, ask: true };
  const qw = words(q);
  const tiers: ((s: T) => boolean)[] = [
    (s) => compact(s.name) === qc,
    (s) => qc.length >= 3 && (compact(s.name).includes(qc) || qc.includes(compact(s.name))),
    (s) => words(s.name).some((w) => w.length >= 3 && qw.includes(w)),
    (s) => {
      const n = compact(s.name);
      return lev(n, qc) <= Math.max(1, Math.floor(n.length / 4)) || words(s.name).some((w) => w.length >= 5 && qw.some((x) => lev(w, x) <= Math.floor(w.length / 4)));
    },
  ];
  for (const t of tiers) {
    const hit = servers.filter(t);
    if (hit.length === 1) return { server: hit[0]! };
    if (hit.length > 1) return { reply: `Which one: ${either(hit.map((s) => s.name))}?`, ask: true };
  }
  const said = q.replace(/["\p{C}]/gu, '').slice(0, 40);
  return { reply: `There's no server called "${said}". The servers are ${either(servers.map((s) => s.name), 'and')}.` };
}

const VERB: Record<Lifecycle, { verb: string; ing: string; when: string; past: string; fail: string }> = {
  start: { verb: 'start', ing: 'starting', when: "it's up", past: 'started', fail: "didn't start" },
  stop: { verb: 'stop', ing: 'stopping', when: "it's down", past: 'stopped', fail: "didn't stop" },
  restart: { verb: 'restart', ing: 'restarting', when: "it's back", past: 'restarted', fail: "didn't come back after the restart" },
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const PERMISSION: Record<ServerAction | 'view', string> = { start: 'Start', stop: 'Stop', restart: 'Restart', whitelist: 'Console', say: 'Console', view: 'View' };

/** One sentence for a Helix failure. */
export function failText(f: HelixFailure, name: string, need: ServerAction | 'view'): string {
  switch (f.kind) {
    case 'unreachable':
      return "I can't reach Helix right now.";
    case 'lost':
      return `I didn't hear back from Helix, so I can't tell whether that happened on ${name}. Check the panel before asking again.`;
    case 'auth':
      return 'Helix turned down my token: it expired, was revoked, or a password change voided it. Make a new one and save it as HELIX_TOKEN.';
    case 'denied':
      return `The Helix token isn't allowed to do that on ${name}: it needs ${name} on its server list and the ${PERMISSION[need]} permission.`;
    case 'rate':
      return `Helix asked me to slow down. Try again in ${f.retryAfterSec >= 90 ? `${Math.ceil(f.retryAfterSec / 60)} minutes` : 'a minute'}.`;
    case 'busy':
      return 'Helix is busy with other requests. Try again in a moment.';
    case 'broker':
      return "Helix's host service isn't answering right now.";
    case 'invalid':
      return "This Helix doesn't understand the request; it may need an update.";
    case 'rejected':
      return rejectedText(f.message, name);
    case 'gateway':
      if (f.status === 421) return "Helix doesn't accept the address I use: helix.url must be the dashboard address exactly as Helix was installed with.";
      if (f.status === 403) return "Helix's gateway won't let this machine in: its address isn't in Helix's allowed clients.";
      if (f.status === 404) return 'There is no Helix automation API at that address. Check helix.url (it needs Helix 1.10 or later).';
      return `Helix answered with an error (${f.status}).`;
    default:
      return `Helix answered with an error (${f.status}).`;
  }
}

/** Helix accepted the request and refused the operation: say why. */
export function rejectedText(message: string, name: string): string {
  const busy = /^(.{1,120}?) is still running on this server/.exec(message);
  if (busy) return `Helix is busy with ${clean(busy[1], 80).replace(/\.$/, '')} on ${name}. Try again when it finishes.`;
  if (/start the server before using its console/i.test(message)) return `${name} isn't running, so it can't take commands.`;
  if (/deep management is available only/i.test(message)) return `${name} isn't a Helix-managed server, so Helix can only start and stop it.`;
  if (/host reboot is scheduled/i.test(message)) return "The host is about to reboot, so Helix isn't taking new jobs.";
  if (/console command must be one/i.test(message)) return 'That command was too long for the console.';
  if (/does not expose a command console/i.test(message)) return `${name} has no console.`;
  return `Helix refused: ${clean(message) || 'no reason given.'}`;
}

const crashNote = (d: HelixDetail): string => {
  const cs = d.container_state;
  if (!cs) return '';
  if (cs.Restarting) return ', and restarting by itself after a crash';
  if (cs.OOMKilled) return '; it ran out of memory last time';
  if (typeof cs.ExitCode === 'number' && ![0, 130, 143].includes(cs.ExitCode)) return `; it crashed last time (exit code ${cs.ExitCode})`;
  return '';
};

interface Running {
  action: Lifecycle;
  name: string;
  by: string;
  at: number;
  stage?: string;
  askers: Asker[];
}

export class ServerControl {
  private readonly yes: PendingYes<string>;
  /** One job per server: whoever else asks waits for the same one. */
  private readonly running = new Map<string, Running>();
  /** Questions this tool asked, so the next turn is taken as the answer. */
  private readonly asked = new Set<string>();
  private readonly statusCache = new Map<string, { at: number; line: string }>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ping: (host: string, port: number) => Promise<McStatus>;
  private readonly t: { inlineSec: number; pollMs: number; retryMs: number; verifyMs: number; statusCacheMs: number };

  constructor(private readonly d: ServerControlDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ping = d.ping ?? ((h, p) => pingMinecraft(h, p));
    this.yes = new PendingYes<string>(this.now);
    this.t = { inlineSec: 4, pollMs: 3000, retryMs: 5000, verifyMs: 2500, statusCacheMs: 10_000, ...d.timing };
  }

  /** Is a job running on this server (for tests and the status line)? */
  busyWith(instanceId: string): Lifecycle | undefined {
    return this.running.get(instanceId)?.action;
  }

  /** At start: one read per linked server, so a wrong address or a server
   *  missing from the token shows in the log before anyone asks. */
  async check(): Promise<void> {
    const linked = this.d.servers.filter((s) => s.helix);
    if (!linked.length) return;
    if (!this.d.client) return void this.d.log.warn('helix token missing; server control is off', { secret: 'HELIX_TOKEN' });
    for (const s of linked) {
      try {
        await this.d.client.capabilities(s.helix!.instanceId);
        this.d.log.info('helix server ok', { server: s.name });
      } catch (e) {
        this.d.log.warn('helix server check failed', { server: s.name, problem: e instanceof HelixError ? e.failure.kind : 'error', ...(e instanceof HelixError && 'status' in e.failure ? { status: e.failure.status } : {}) });
      }
    }
  }

  private remember(question: string): string {
    this.asked.add(question);
    if (this.asked.size > 100) this.asked.delete(this.asked.values().next().value!);
    return question;
  }

  private may(action: ServerAction, a: Asker): boolean {
    if (this.d.isOwner(a.userId)) return true;
    const ids = this.d.settings.allow[action];
    return ids.includes(a.userId) || (ids.length > 0 && this.d.hasRole(a.userId, a.guildId, ids));
  }

  private refused(action: ServerAction, name: string): string {
    const what = action === 'whitelist' ? `change ${name}'s whitelist` : action === 'say' ? `send messages to ${name}` : `${action} ${name}`;
    return this.d.settings.allow[action].length ? `You're not on the list of people who can ${what}.` : `Only the owners can ${what}.`;
  }

  private audit(action: string, s: ControlledServer, a: Asker, result: string, extra: Record<string, unknown> = {}): void {
    this.d.log.info('game server action', { action, server: s.name, by: a.userId, result, ...extra });
  }

  /** The server, linked to Helix, with a token and the person's right to do it. */
  private target(query: unknown, action: ServerAction, a: Asker): { s: ControlledServer; id: string } | string {
    const r = resolveServer(query, this.d.servers);
    if ('reply' in r) return r.ask ? this.remember(r.reply) : r.reply;
    const s = r.server;
    if (!s.helix) return `${s.name} isn't linked to Helix, so I can only check whether it's up.`;
    if (!this.d.client) return TOKEN_MISSING;
    if (!this.may(action, a)) {
      this.audit(action, s, a, 'not allowed');
      return this.refused(action, s.name);
    }
    return { s, id: s.helix.instanceId };
  }

  // --- start, stop, restart ---------------------------------------------

  async lifecycle(action: Lifecycle, query: unknown, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
    const a: Asker = { userId: ctx.userId, speaker: ctx.speaker, ...(ctx.channelId ? { channelId: ctx.channelId } : {}), ...(ctx.guildId ? { guildId: ctx.guildId } : {}) };
    // Their next turn settles any question, whatever this turn turns out to be.
    const yesFor = this.yes.take(ctx);
    const t = this.target(query, action, a);
    if (typeof t === 'string') return t;
    const { s, id } = t;
    const client = this.d.client!;

    const joined = this.join(id, action, a);
    if (joined) return joined;

    let detail: HelixDetail;
    try {
      detail = await client.detail(id, signal);
    } catch (e) {
      const f = e instanceof HelixError ? e.failure : ({ kind: 'unreachable' } as const);
      if (f.kind === 'rejected' && /deep management is available only/i.test(f.message)) {
        // An imported server: Helix can start and stop it but has no detail. Ask the game itself.
        const p = await this.ping(s.host, s.port);
        detail = p.online ? { status: 'online', ...(typeof p.players === 'number' ? { players_online: p.players } : {}) } : { status: 'stopped' };
      } else {
        this.audit(action, s, a, `read failed: ${f.kind}`);
        return failText(f, s.name, 'view');
      }
    }
    const state = detail.status;
    const players = typeof detail.players_online === 'number' ? detail.players_online : undefined;
    if (detail.busy_with) {
      this.audit(action, s, a, 'helix busy');
      return `Helix is busy with ${clean(detail.busy_with, 80).replace(/\.$/, '')} on ${s.name}. Try again when it finishes.`;
    }
    let doing: Lifecycle = action;
    let lead = '';
    if (action === 'start' && state === 'online') return `${s.name} is already up${players ? `, with ${players} on` : ''}.`;
    if (action === 'start' && state === 'starting') return `${s.name} is already starting.`;
    if (action === 'stop' && state === 'stopped') return `${s.name} is already stopped.`;
    if (action !== 'start' && state === 'starting') return `${s.name} is still starting. Try again once it's up.`;
    if (action === 'restart' && state === 'stopped') {
      // Nobody's on a stopped server: starting it needs no yes.
      doing = 'start';
      lead = `${s.name} was stopped, so I'm starting it.`;
    }

    if (doing !== 'start') {
      const key = `${doing}:${id}`;
      if (yesFor !== key) {
        const n = players ?? 0;
        const q = n > 0 ? `${n} ${n === 1 ? 'person is' : 'people are'} on ${s.name}. ${cap(VERB[doing].verb)} it anyway?` : `${cap(VERB[doing].verb)} ${s.name}?`;
        const about = [...new Set([...(doing === 'stop' ? ['stop', 'shut', 'down', 'turn', 'off'] : ['restart', 'reboot']), 'it', 'the', 'server', 'anyway', ...words(s.name)])];
        if (!this.yes.hold(ctx, key, about, 4000)) return 'A question is already waiting for their answer.';
        this.audit(doing, s, a, 'asked', { players: n });
        return this.remember(q);
      }
    }

    // Two yeses at once: the first one through runs it, the other joins it.
    const again = this.join(id, doing, a);
    if (again) return again;
    const entry: Running = { action: doing, name: s.name, by: a.speaker, at: this.now(), askers: [a] };
    this.running.set(id, entry);
    this.statusCache.delete(id);
    const started = this.now();

    // What this token already started, so a lost answer can still find its job.
    let before: Set<string> | undefined;
    try {
      before = new Set((await client.jobs()).filter((j) => j.server_id === id).map((j) => j.job_id));
    } catch {
      before = undefined;
    }
    let jobId: string | undefined;
    let reused = false;
    try {
      const r = await client.action(id, doing);
      jobId = typeof r.job_id === 'string' ? r.job_id : undefined;
      reused = r.reused === true;
    } catch (e) {
      const f = e instanceof HelixError ? e.failure : ({ kind: 'lost' } as const);
      if (f.kind === 'lost' && before) {
        // Don't send it again: Helix may have taken it. Look for the job instead.
        const found = await client.jobs().then(
          (all) => all.find((j) => j.server_id === id && !before!.has(j.job_id))?.job_id,
          () => undefined,
        );
        if (found) jobId = found;
      }
      if (!jobId) {
        this.running.delete(id);
        this.audit(doing, s, a, `failed: ${f.kind}`);
        return f.kind === 'lost' ? `I didn't hear back from Helix, so I can't tell whether ${s.name} ${VERB[doing].past}. Check the panel before asking again.` : failText(f, s.name, doing);
      }
    }
    if (!jobId) {
      this.running.delete(id);
      this.audit(doing, s, a, 'sent, no job');
      return `${lead ? `${lead} ` : ''}Sent to ${s.name}.`;
    }
    this.audit(doing, s, a, reused ? 'joined running job' : 'started', { job: jobId });

    // Quick ones are answered now; the rest are announced when they finish.
    let job: HelixJob | undefined;
    try {
      job = await client.waitJob(jobId, this.t.inlineSec);
    } catch {
      job = undefined;
    }
    if (job && (job.status === 'complete' || job.status === 'failed')) {
      this.running.delete(id);
      this.statusCache.delete(id);
      const text = this.outcome(doing, s.name, job);
      this.audit(doing, s, a, job.status, { job: jobId, ms: this.now() - started });
      return lead && job.status === 'complete' ? `${lead} ${text}` : text;
    }
    if (job?.stage) entry.stage = job.stage;
    const limit = (doing === 'stop' ? this.d.settings.stopWaitSec : this.d.settings.startWaitSec) * 1000;
    void this.watch(id, s, entry, jobId, started + limit);
    const tell = `I'll tell you when ${VERB[doing].when}.`;
    if (lead) return `${lead} ${tell}`;
    return reused ? `${s.name} is already ${VERB[doing].ing}. ${tell}` : `${cap(VERB[doing].ing)} ${s.name}. ${tell}`;
  }

  /** A job already running on this server: the same one joins it, anything else waits. */
  private join(id: string, action: Lifecycle, a: Asker): string | undefined {
    const r = this.running.get(id);
    if (!r) return undefined;
    if (r.action === action) {
      if (!r.askers.some((x) => x.userId === a.userId && x.channelId === a.channelId)) r.askers.push(a);
      return `${r.name} is already ${VERB[action].ing}. I'll tell you when ${VERB[action].when}.`;
    }
    const mins = Math.floor((this.now() - r.at) / 60_000);
    return `${r.name} is busy: ${r.by} asked to ${r.action} it ${mins < 1 ? 'just now' : mins === 1 ? 'a minute ago' : `${mins} minutes ago`}. Try again when that's done.`;
  }

  private outcome(action: Lifecycle, name: string, job: HelixJob): string {
    if (job.status === 'failed') {
      const why = typeof job.error === 'string' && job.error ? job.error : 'Helix gave no reason';
      const busy = /is still running on this server/.test(why) ? rejectedText(why, name) : '';
      return busy || `${name} ${VERB[action].fail}: ${clean(why)}`;
    }
    const d = job.result?.detail ?? {};
    const pending = typeof d.pending_error === 'string' && d.pending_error ? ` Staged file changes didn't install: ${clean(d.pending_error, 120)}` : '';
    if (action === 'start') return (d.already_running === true ? `${name} was already up.` : `${name} is up.`) + pending;
    if (action === 'stop') return d.already_stopped === true ? `${name} was already stopped.` : `${name} is stopped.`;
    return (d.previously_running === false ? `${name} is up.` : `${name} is back up.`) + pending;
  }

  /** One loop per job, never past `deadline`: Helix's wait route, or plain
   *  job_status polling where the wait route is refused (Helix 1.10.0). */
  private async watch(id: string, s: ControlledServer, entry: Running, jobId: string, deadline: number): Promise<void> {
    const client = this.d.client!;
    let useWait = true;
    let text: string | undefined;
    let result = 'gave up';
    try {
      while (this.now() < deadline && !text) {
        try {
          let job: HelixJob;
          if (useWait) {
            job = await client.waitJob(jobId, Math.min(12, Math.max(1, Math.ceil((deadline - this.now()) / 1000))));
          } else {
            await this.sleep(this.t.pollMs);
            job = await client.jobStatus(jobId);
          }
          if (job.stage) entry.stage = job.stage;
          if (job.status === 'complete' || job.status === 'failed') {
            text = this.outcome(entry.action, s.name, job);
            result = job.status;
          }
        } catch (e) {
          const f = e instanceof HelixError ? e.failure : undefined;
          if (useWait && (f?.kind === 'denied' || (f?.kind === 'gateway' && (f.status === 403 || f.status === 404)))) {
            useWait = false;
            continue;
          }
          if (f?.kind === 'auth' || f?.kind === 'denied') {
            text = `I lost access to Helix while ${s.name} was ${VERB[entry.action].ing}, so I can't tell how it went. Check the panel.`;
            result = `lost access: ${f.kind}`;
            break;
          }
          await this.sleep(f?.kind === 'rate' ? Math.min(f.retryAfterSec * 1000, Math.max(0, deadline - this.now())) : this.t.retryMs);
        }
      }
      if (!text) {
        // Out of time: look once more before calling it.
        const d = await client.detail(id).catch(() => undefined);
        const done = entry.action === 'stop' ? d?.status === 'stopped' : d?.status === 'online';
        const mins = Math.max(1, Math.round((deadline - entry.at) / 60_000));
        text = done
          ? entry.action === 'stop'
            ? `${s.name} is stopped.`
            : `${s.name} is up.`
          : `${s.name} still isn't ${entry.action === 'stop' ? 'down' : 'up'} after ${mins} minute${mins === 1 ? '' : 's'}. I've stopped watching; check the Helix panel.`;
        if (done) result = 'complete';
      }
    } finally {
      this.running.delete(id);
      this.statusCache.delete(id);
    }
    this.d.log.info('game server action', { action: entry.action, server: s.name, by: entry.askers[0]?.userId, result, job: jobId, ms: this.now() - entry.at });
    for (const a of entry.askers) {
      try {
        await this.d.announce(a, text);
      } catch (e) {
        this.d.log.warn('game server announcement failed', { server: s.name, user: a.userId, error: (e as Error).message.slice(0, 120) });
      }
    }
  }

  // --- status -----------------------------------------------------------

  private async statusLine(s: ControlledServer, signal?: AbortSignal): Promise<string> {
    const id = s.helix?.instanceId;
    const hit = id ? this.statusCache.get(id) : undefined;
    if (id && hit && this.now() - hit.at < this.t.statusCacheMs) return hit.line;
    const pinged = this.ping(s.host, s.port);
    let d: HelixDetail | undefined;
    if (id && this.d.client) d = await this.d.client.detail(id, signal).catch(() => undefined);
    const p = await pinged;
    if (!id || !d) return describeStatus(s.name, p);
    const r = this.running.get(id);
    const doing = r ? `; ${VERB[r.action].ing} now${r.stage ? ` (${clean(r.stage, 60).replace(/\.$/, '')})` : ''}` : d.busy_with ? `; Helix is busy with ${clean(d.busy_with, 80).replace(/\.$/, '')}` : '';
    let line: string;
    if (d.status === 'online') {
      let st = p.online ? p : { online: true, ...(typeof d.players_online === 'number' ? { players: d.players_online } : {}), ...(typeof d.max_players === 'number' ? { max: d.max_players } : {}) };
      if ((st.players ?? 0) > 0 && !st.names?.length) {
        const names = await this.whoIsOn(id, signal);
        if (names.length) st = { ...st, names };
      }
      line = describeStatus(s.name, st) + doing;
    } else if (d.status === 'starting') {
      const since = Date.parse(d.container_state?.StartedAt ?? '');
      const mins = Number.isFinite(since) ? Math.floor((this.now() - since) / 60_000) : 0;
      line = `${s.name}: starting${mins >= 10 ? `, for ${mins} minutes now, so it may be stuck` : ''}${doing}`;
    } else {
      line = `${s.name}: stopped${crashNote(d)}${doing}`;
    }
    this.statusCache.set(id, { at: this.now(), line });
    if (this.statusCache.size > 40) this.statusCache.delete(this.statusCache.keys().next().value!);
    return line;
  }

  /** Names from the console's `list`, when the status ping hides them. Needs Console; quiet without it. */
  private async whoIsOn(id: string, signal?: AbortSignal): Promise<string[]> {
    const out = await this.d.client!.console(id, 'list', false, signal).catch(() => '');
    return playerNames(out).slice(0, 20);
  }

  async status(query: unknown, signal?: AbortSignal): Promise<string> {
    const servers = this.d.servers;
    const q = typeof query === 'string' ? query.trim() : '';
    let list = servers;
    let lead = '';
    if (q) {
      const r = resolveServer(q, servers);
      if ('server' in r) list = [r.server];
      else if (!r.ask) lead = `No server matched "${q.replace(/["\p{C}]/gu, '').slice(0, 40)}"; all servers:\n`;
    }
    return lead + (await Promise.all(list.map((s) => this.statusLine(s, signal)))).join('\n');
  }

  // --- whitelist and chat ------------------------------------------------

  async whitelist(args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
    const a: Asker = { userId: ctx.userId, speaker: ctx.speaker, ...(ctx.guildId ? { guildId: ctx.guildId } : {}) };
    const action = args.action;
    if (action !== 'add' && action !== 'remove' && action !== 'list') return 'Say add, remove or list.';
    const t = this.target(args.server, 'whitelist', a);
    if (typeof t === 'string') return t;
    const { s, id } = t;
    const client = this.d.client!;
    const fail = (e: unknown) => failText(e instanceof HelixError ? e.failure : { kind: action === 'list' ? 'unreachable' : 'lost' }, s.name, 'whitelist');

    if (action === 'list') {
      try {
        const names = playerNames(await this.send(client, id, 'whitelist list', false, signal));
        this.audit('whitelist list', s, a, 'ok', { count: names.length });
        if (!names.length) return `Nobody is on ${s.name}'s whitelist.`;
        return `${names.length} on ${s.name}'s whitelist: ${names.slice(0, 15).join(', ')}${names.length > 15 ? `, and ${names.length - 15} more` : ''}.`;
      } catch (e) {
        this.audit('whitelist list', s, a, 'failed');
        return fail(e);
      }
    }

    const who = playerTarget(args.player, args.bedrock === true, s);
    if (typeof who === 'string') return who;
    const cmd = `${who.bedrock ? 'fwhitelist' : 'whitelist'} ${action} ${who.bedrock ? `"${who.name}"` : who.name}`;
    let reply: string;
    try {
      reply = await this.send(client, id, cmd, true);
    } catch (e) {
      this.audit(`whitelist ${action}`, s, a, 'failed', { player: who.shown });
      return fail(e);
    }
    let text = whitelistReply(reply, action, who.shown, s.name, who.bedrock);
    if (who.bedrock && !text) {
      // Floodgate looks the gamertag up with Xbox Live and answers later, so check the list itself.
      await this.sleep(this.t.verifyMs);
      const names = await this.send(client, id, 'whitelist list', false).then(playerNames, () => undefined);
      const there = names?.some((n) => n.toLowerCase() === who.listed.toLowerCase());
      text =
        names === undefined
          ? `Sent to ${s.name}; I couldn't check the whitelist afterwards.`
          : action === 'add'
            ? there
              ? `Added ${who.shown} to ${s.name}'s whitelist.`
              : `Sent to ${s.name}, but ${who.shown} isn't on the whitelist yet. Floodgate may not have found that gamertag.`
            : there
              ? `Sent to ${s.name}, but ${who.shown} is still on the whitelist.`
              : `Removed ${who.shown} from ${s.name}'s whitelist.`;
    }
    this.audit(`whitelist ${action}`, s, a, text.startsWith('Added') || text.startsWith('Removed') ? 'ok' : 'sent', { player: who.shown });
    return text || `Sent to ${s.name}.`;
  }

  async say(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const a: Asker = { userId: ctx.userId, speaker: ctx.speaker, ...(ctx.guildId ? { guildId: ctx.guildId } : {}) };
    const t = this.target(args.server, 'say', a);
    if (typeof t === 'string') return t;
    const { s, id } = t;
    const msg = chatText(args.message, this.d.settings.sayMaxChars);
    if (!msg) return "There's nothing to send.";
    const from = chatText(ctx.speaker, 24).replace(/[^\p{L}\p{N} _.-]/gu, '').trim();
    try {
      await this.send(this.d.client!, id, `say ${from ? `${from}: ` : ''}${msg}`, true);
      this.audit('say', s, a, 'ok', { chars: msg.length });
      return `Sent to ${s.name}'s chat.`;
    } catch (e) {
      this.audit('say', s, a, 'failed', { chars: msg.length });
      return failText(e instanceof HelixError ? e.failure : { kind: 'lost' }, s.name, 'say');
    }
  }

  private send(client: HelixClient, id: string, cmd: string, changes: boolean, signal?: AbortSignal): Promise<string> {
    if (!safeCommand(cmd)) return Promise.reject(new Error('refused an unsafe console line'));
    return client.console(id, cmd, changes, signal);
  }

  // --- tools ------------------------------------------------------------

  tools(): Tool[] {
    const names = this.d.servers.map((s) => s.name).join(', ');
    const pick = 'server: the name as they said it. If they did not say which and there is more than one server, ask which; never guess, and never make up a server or an ID.';
    const says = (_a: Record<string, unknown>, result: string) => result;
    const asks = (result: string) => this.asked.has(result);
    return [
      {
        spec: {
          name: 'game_server_status',
          description: `Check the household's Minecraft servers: up, starting, stopped or crashed, and who is playing. Servers: ${names}. Leave server empty to check all.`,
          parameters: { type: 'object', properties: { server: { type: 'string' } }, additionalProperties: false },
        },
        timeoutMs: 8000,
        run: (a, signal) => this.status(a.server, signal),
      },
      {
        spec: {
          name: 'game_server_control',
          description: `Start, stop or restart one of the household's Minecraft servers (${names}). Only game servers: the PC itself is pc_system. ${pick} stop and restart ask the person by themselves, so don't ask first; when they say yes, call again with the same action and server. A start or restart can take minutes: the tool says it will tell them when it's done.`,
          parameters: {
            type: 'object',
            properties: { action: { type: 'string', enum: ['start', 'stop', 'restart'] }, server: { type: 'string' } },
            required: ['action'],
            additionalProperties: false,
          },
        },
        timeoutMs: 30_000,
        slow: true,
        run: (a, signal, ctx) => (a.action === 'start' || a.action === 'stop' || a.action === 'restart' ? this.lifecycle(a.action, a.server, ctx, signal) : Promise.resolve('Say start, stop or restart.')),
        speak: says,
        asks,
        acts: (a) => a.action === 'start' || a.action === 'stop' || a.action === 'restart',
      },
      {
        spec: {
          name: 'game_server_whitelist',
          description: `A Minecraft server's whitelist (${names}): add or remove a player, or list who is on it. ${pick} player: their Minecraft name exactly as spelled (Java: 3-16 letters, numbers, underscores). bedrock true for a Bedrock player (phone, tablet, console, Windows edition) on a server that takes them; their gamertag is the player.`,
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'remove', 'list'] },
              server: { type: 'string' },
              player: { type: 'string' },
              bedrock: { type: 'boolean' },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
        timeoutMs: 20_000,
        run: (a, signal, ctx) => this.whitelist(a, ctx, signal),
        speak: says,
        asks,
        acts: (a) => a.action === 'add' || a.action === 'remove',
      },
      {
        spec: {
          name: 'game_server_say',
          description: `Post a short message in a Minecraft server's in-game chat (${names}), shown with the asker's name. ${pick} message: only the words they want sent.`,
          parameters: {
            type: 'object',
            properties: { server: { type: 'string' }, message: { type: 'string' } },
            required: ['message'],
            additionalProperties: false,
          },
        },
        timeoutMs: 15_000,
        run: (a, _signal, ctx) => this.say(a, ctx),
        speak: says,
        asks,
        acts: true,
      },
    ];
  }
}

/** Player names from a `list` or `whitelist list` answer ("There are 2 ...: a, b"). */
export function playerNames(text: string): string[] {
  const s = clean(text, 4000).replace(/\.$/, '');
  const i = s.indexOf(':');
  if (i < 0) return [];
  return s
    .slice(i + 1)
    .split(/,\s*|\s+and\s+/)
    .map((n) => n.trim())
    .filter((n) => /^[^\sA-Za-z0-9]{0,3}[A-Za-z0-9_]{1,16}$/.test(n));
}

/** The player as a console argument: a Java name, or a Bedrock gamertag
 *  (prefix optional, Floodgate's underscores read as spaces). */
export function playerTarget(player: unknown, bedrock: boolean, s: ControlledServer): { name: string; shown: string; listed: string; bedrock: boolean } | string {
  const raw = typeof player === 'string' ? player.trim() : '';
  if (!raw) return 'Which player?';
  const prefix = s.helix?.bedrockPrefix ?? '.';
  const hasPrefix = !!prefix && raw.startsWith(prefix);
  if (bedrock || (hasPrefix && s.helix?.bedrock)) {
    if (!s.helix?.bedrock) return `${s.name} isn't set up for Bedrock players.`;
    const tag = (hasPrefix ? raw.slice(prefix.length) : raw).replace(/_/g, ' ').trim();
    if (!tag || tag.length > 16 || !GAMERTAG.test(tag)) return "That isn't a gamertag I can use: letters, numbers and single spaces, up to 16.";
    return { name: tag, shown: tag, listed: prefix + tag.replace(/ /g, '_'), bedrock: true };
  }
  if (!JAVA_NAME.test(raw)) return "That isn't a valid Minecraft name: Java names are 3 to 16 letters, numbers or underscores.";
  return { name: raw, shown: raw, listed: raw, bedrock: false };
}

/** What the server said to a whitelist change, in a sentence; '' when it said nothing useful. */
export function whitelistReply(reply: string, action: 'add' | 'remove', who: string, name: string, bedrock: boolean): string {
  const r = clean(reply, 300);
  if (!r) return '';
  if (/unknown or incomplete command|unknown command/i.test(r)) return bedrock ? `${name} doesn't have Floodgate, so it can't whitelist Bedrock players.` : `${name} doesn't have a whitelist command.`;
  if (/does not exist|unknown player|no player was found|not found|couldn't find|could not find/i.test(r)) return `Minecraft doesn't know a player called ${who}. Check the spelling.`;
  if (/already whitelisted|already on the whitelist|already in the whitelist/i.test(r)) return `${who} is already on ${name}'s whitelist.`;
  if (/not whitelisted|isn't whitelisted|is not on the whitelist|not in the whitelist/i.test(r)) return `${who} isn't on ${name}'s whitelist.`;
  if (/\badded\b/i.test(r) && action === 'add') return `Added ${who} to ${name}'s whitelist.`;
  if (/\bremoved\b/i.test(r) && action === 'remove') return `Removed ${who} from ${name}'s whitelist.`;
  // Floodgate answers later, or in words of its own: the list will tell.
  if (bedrock) return '';
  return `${name} said: ${clean(r, 120)}`;
}
