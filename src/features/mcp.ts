// Tools from MCP servers (Model Context Protocol, streamable HTTP), first of
// all Home Assistant's own MCP server for lights, switches and the like.
//
// Nothing a server offers reaches the model by itself: each server lists the
// tool names it may use (`allow`), and tools in `confirm`, or any call that
// names a lock, door or the like (`confirmWords`), need the person's own yes first. Only the people allowed (the owners, by default) can use them.
// A server's tool descriptions and results are its words, so they're cut short
// and given to the model as data.

import type { Logger, Tool, ToolContext, UserId } from '../core/interfaces.js';
import { PendingYes } from '../brain/tools.js';

type Fetch = typeof fetch;

const PROTOCOL = '2025-06-18';
const MAX_BYTES = 1024 * 1024;
const MAX_DESCRIPTION = 400;
const MAX_RESULT = 4_000;
const MAX_PAGES = 5;
/** Requests that may be about the house. */
export const HOME_WORDS = /\b(lights?|lamps?|turn(ed)? (it |them |the |everything )?(on|off|up|down)|switch(es)?|dim|brighten|bright(er|ness)?|thermostat|heat(ing|er)?|a\/?c|air|fans?|lock(ed)?|unlock|doors?|garage|blinds?|curtains?|shades?|scenes?|plugs?|outlets?|temperature|warmer|cooler|degrees|rooms?|kitchen|bedroom|living room|office|bathroom|hallway|porch|yard|house|home|devices?|vacuum|sensor|humidity|is (the|my) .+ (on|off|open|closed))\b/i;

export interface McpServer {
  /** Short name; tool names start with it ("home_HassTurnOn"). */
  name: string;
  url: string;
  /** Bearer token (Home Assistant: a long-lived access token). */
  token?: string | undefined;
  /** Tool names it may use; nothing else is offered to the model. */
  allow: readonly string[];
  /** Of those, tools that always need the person's yes first. */
  confirm: readonly string[];
  /** Any call whose arguments hold one of these words needs a yes too (Home
   *  Assistant locks and unlocks with the same turn on/off tools as lights). */
  confirmWords: readonly string[];
  /** Who may use them. */
  people: (id: UserId) => boolean;
  timeoutMs: number;
}

export interface McpToolInfo {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

export class McpError extends Error {}

/** JSON-RPC answers from a reply that is either JSON or an SSE stream. */
export function rpcMessages(body: string, contentType: string): unknown[] {
  if (!/text\/event-stream/i.test(contentType)) {
    const v = JSON.parse(body) as unknown;
    return Array.isArray(v) ? v : [v];
  }
  const out: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* a keep-alive or partial line */
    }
  }
  return out;
}

/** A minimal MCP client: initialize, list tools, call a tool. */
export class McpClient {
  private session: string | undefined;
  private ready: Promise<void> | undefined;
  private nextId = 1;

  constructor(
    private readonly server: Pick<McpServer, 'url' | 'token' | 'timeoutMs'>,
    private readonly fetchFn: Fetch = fetch,
    private readonly version = '0',
  ) {}

  private async post(payload: object, signal?: AbortSignal): Promise<{ status: number; body: string; type: string; session: string | null }> {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.server.timeoutMs)]) : AbortSignal.timeout(this.server.timeoutMs);
    const res = await this.fetchFn(this.server.url, {
      method: 'POST',
      // The token goes only to this address.
      redirect: 'error',
      signal: sig,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(this.server.token ? { authorization: `Bearer ${this.server.token}` } : {}),
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify(payload),
    });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new McpError('answer too big');
    return { status: res.status, body: new TextDecoder().decode(buf), type: res.headers.get('content-type') ?? '', session: res.headers.get('mcp-session-id') };
  }

  private async rpc(method: string, params: object, signal?: AbortSignal, retry = true): Promise<Record<string, unknown>> {
    if (method !== 'initialize') await this.start(signal);
    const id = this.nextId++;
    const r = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    // The server forgot the session (it restarted): start a new one, once.
    if (r.status === 404 && this.session && retry && method !== 'initialize') {
      this.session = undefined;
      this.ready = undefined;
      return this.rpc(method, params, signal, false);
    }
    if (r.status === 401 || r.status === 403) throw new McpError('the server refused the token');
    if (r.status < 200 || r.status >= 300) throw new McpError(`the server answered ${r.status}`);
    if (method === 'initialize' && r.session) this.session = r.session;
    const msg = rpcMessages(r.body, r.type).find((m) => (m as { id?: unknown })?.id === id) as { result?: Record<string, unknown>; error?: { message?: unknown } } | undefined;
    if (!msg) throw new McpError('no answer');
    if (msg.error) throw new McpError(typeof msg.error.message === 'string' ? msg.error.message.slice(0, 200) : 'error');
    return msg.result ?? {};
  }

  private start(signal?: AbortSignal): Promise<void> {
    this.ready ??= (async () => {
      await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'adrian', version: this.version } }, signal);
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
    })().catch((e: unknown) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.rpc('tools/list', cursor ? { cursor } : {}, signal);
      for (const t of Array.isArray(r.tools) ? r.tools : []) {
        const x = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof x.name !== 'string') continue;
        out.push({
          name: x.name,
          description: typeof x.description === 'string' ? x.description : undefined,
          inputSchema: x.inputSchema && typeof x.inputSchema === 'object' ? (x.inputSchema as Record<string, unknown>) : undefined,
        });
      }
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** The tool's text answer; an error from the tool comes back as text too. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; error: boolean }> {
    const r = await this.rpc('tools/call', { name, arguments: args }, signal);
    const parts = Array.isArray(r.content) ? r.content : [];
    const text = parts
      .map((p) => {
        const c = p as { type?: unknown; text?: unknown };
        return c.type === 'text' && typeof c.text === 'string' ? c.text : c.type ? `[${String(c.type)}]` : '';
      })
      .filter(Boolean)
      .join('\n');
    const structured = !text && r.structuredContent ? JSON.stringify(r.structuredContent) : '';
    return { text: (text || structured || 'Done.').slice(0, MAX_RESULT), error: r.isError === true };
  }
}

/** A model-safe tool name: letters, digits, _ and -, at most 64. */
export const toolName = (server: string, tool: string) => `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

/** The schema as given if it's an object schema; else an empty one. */
function schema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!s || s.type !== 'object') return { type: 'object', properties: {} };
  const { $schema: _drop, ...rest } = s;
  return rest;
}

const stable = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
        .join(',')}}`
    : JSON.stringify(v);

/** "turn off the kitchen light"-style words from a call, for the question. */
const VERBS: Record<string, string> = { HassTurnOn: 'turn on', HassTurnOff: 'turn off', HassToggle: 'toggle', HassLightSet: 'set', HassSetPosition: 'move' };
const argWords = (args: Record<string, unknown>) =>
  Object.values(args)
    .flat()
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);

/** "turn off front door lock", for the question. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
  const what = argWords(args);
  const verb = VERBS[tool] ?? tool.replace(/^Hass/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `${verb}${what ? ` ${what}` : ''}`;
}

/** The model's tools for one server: only the allowed ones it really has. */
export function serverTools(server: McpServer, client: McpClient, listed: readonly McpToolInfo[], log?: Logger, now: () => number = Date.now): Tool[] {
  const yes = new PendingYes<string>(now);
  const asked = new Set<string>();
  const out: Tool[] = [];
  for (const t of listed) {
    if (!server.allow.includes(t.name)) continue;
    const always = server.confirm.includes(t.name);
    const words = server.confirmWords.map((w) => w.toLowerCase());
    const needsYes = (a: Record<string, unknown>) => always || (words.length > 0 && (argWords(a).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).some((w) => words.includes(w)));
    const confirm = always || words.length > 0;
    const name = toolName(server.name, t.name);
    out.push({
      slow: true,
      timeoutMs: server.timeoutMs + 1_000,
      route: HOME_WORDS,
      spec: {
        name,
        description: `${server.name} (home control): ${(t.description ?? t.name).replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION)}${confirm ? ` ${always ? 'It' : 'For locks, doors and the like it'} asks the person by itself before acting; when they say yes, call it again with the same arguments.` : ''}`,
        parameters: schema(t.inputSchema),
      },
      acts: true,
      run: async (a, signal, ctx: ToolContext) => {
        if (!server.people(ctx.userId)) return `Only the household's owners can use ${server.name}.`;
        const key = `${t.name}:${stable(a)}`;
        if (needsYes(a)) {
          // Their next turn settles any question, whatever it turns out to be.
          const ok = yes.take(ctx) === key;
          if (!ok) {
            if (!yes.hold(ctx, key, ['it', 'do', 'that'], 3000)) return 'A question is already waiting for their answer.';
            const q = `Okay to ${describeCall(t.name, a)}?`;
            asked.add(q);
            return q;
          }
        }
        try {
          const r = await client.call(t.name, a, signal);
          log?.info('home action', { server: server.name, tool: t.name, error: r.error });
          return r.error ? `It didn't work: ${r.text}` : r.text;
        } catch (e) {
          log?.warn('home action failed', { server: server.name, tool: t.name, error: (e as Error).message.slice(0, 120) });
          return `I couldn't reach ${server.name} just now.`;
        }
      },
      ...(confirm ? { asks: (r: string) => asked.has(r), speak: (_a: Record<string, unknown>, r: string) => (asked.has(r) ? r : undefined) } : {}),
    });
  }
  return out;
}

/** Connect to each server and add its allowed tools to `into`. A server that
 *  is down is tried again every few minutes, its tools added once it answers. */
export function connectMcp(servers: readonly McpServer[], into: Tool[], log: Logger, o: { fetchFn?: Fetch; version?: string; retryMs?: number; onAdded?: (names: string[]) => void } = {}): { stop: () => void } {
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;
  for (const s of servers) {
    const client = new McpClient(s, o.fetchFn, o.version);
    const attempt = async () => {
      if (stopped) return;
      try {
        const listed = await client.listTools();
        const tools = serverTools(s, client, listed, log);
        const missing = s.allow.filter((n) => !listed.some((t) => t.name === n));
        for (const t of tools) if (!into.some((x) => x.spec.name === t.spec.name)) into.push(t);
        log.info('home control ready', { server: s.name, tools: tools.map((t) => t.spec.name), ...(missing.length ? { notOffered: missing } : {}) });
        o.onAdded?.(tools.map((t) => t.spec.name));
      } catch (e) {
        log.warn('home control unreachable; trying again later', { server: s.name, error: (e as Error).message.slice(0, 120) });
        const t = setTimeout(() => (timers.delete(t), void attempt()), o.retryMs ?? 5 * 60_000);
        t.unref();
        timers.add(t);
      }
    };
    void attempt();
  }
  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
    },
  };
}
