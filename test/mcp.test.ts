import { describe, expect, it, vi } from 'vitest';
import { routeTools } from '../src/brain/tool-router.js';
import type { Tool } from '../src/core/interfaces.js';
import { connectMcp, HOME_WORDS, McpClient, rpcMessages, serverTools, toolName, type McpServer } from '../src/features/mcp.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

/** A small streamable-HTTP MCP server like Home Assistant's: sessions, SSE answers, a token. */
function fakeHa(o: { sse?: boolean; token?: string } = {}) {
  const calls: { method: string; params: unknown; headers: Record<string, string> }[] = [];
  let sessions = 0;
  let live = new Set<string>();
  const tools = [
    { name: 'HassTurnOn', description: 'Turns on/opens a device or entity', inputSchema: { $schema: 'x', type: 'object', properties: { name: { type: 'string' }, area: { type: 'string' } } } },
    { name: 'HassTurnOff', description: 'Turns off a device', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'HassLockUnlock', description: 'Unlocks a lock', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'HassShellRun', description: 'Not allowed anywhere', inputSchema: { type: 'object' } },
  ];
  const fetchFn = (async (_url: URL | string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (o.token && headers.authorization !== `Bearer ${o.token}`) return new Response('no', { status: 401 });
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: unknown };
    calls.push({ method: msg.method, params: msg.params, headers });
    if (msg.method === 'initialize') {
      const sid = `s${++sessions}`;
      live.add(sid);
      return reply(msg.id!, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ha' } }, { 'mcp-session-id': sid });
    }
    if (!msg.id) return new Response(null, { status: 202 });
    if (!live.has(headers['mcp-session-id'] ?? '')) return new Response('gone', { status: 404 });
    if (msg.method === 'tools/list') {
      const p = msg.params as { cursor?: string };
      return reply(msg.id, p.cursor ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: 'page2' });
    }
    if (msg.method === 'tools/call') {
      const p = msg.params as { name: string; arguments: { name?: string } };
      if (p.arguments.name === 'broken') return reply(msg.id, { content: [{ type: 'text', text: 'no device called broken' }], isError: true });
      return reply(msg.id, { content: [{ type: 'text', text: `${p.name} ${p.arguments.name ?? ''}: done` }] });
    }
    return reply(msg.id, undefined, {}, { code: -32601, message: 'unknown method' });
  }) as typeof fetch;
  function reply(id: number, result: unknown, extra: Record<string, string> = {}, error?: unknown) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
    return o.sse
      ? new Response(`event: message\ndata: ${body}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', ...extra } })
      : new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...extra } });
  }
  return { fetchFn, calls, restart: () => (live = new Set()) };
}

const server = (over: Partial<McpServer> = {}): McpServer => ({
  name: 'home',
  url: 'http://ha.local:8123/api/mcp',
  token: 'tok',
  allow: ['HassTurnOn', 'HassTurnOff', 'HassLockUnlock'],
  confirm: ['HassLockUnlock'],
  confirmWords: ['lock', 'door', 'garage'],
  people: (id) => id === 'owner',
  timeoutMs: 2000,
  ...over,
});
const ctx = (userId: string, turn: number, said = '') => ({ userId, speaker: 'Sean', channelId: 'c', turn, said });
const signal = () => AbortSignal.timeout(5000);

describe('MCP client', () => {
  it('reads JSON and SSE answers', () => {
    expect(rpcMessages('{"id":1,"result":{}}', 'application/json')).toEqual([{ id: 1, result: {} }]);
    expect(rpcMessages('event: message\ndata: {"id":2}\n\n: ping\n\ndata: {"id":3}\n\n', 'text/event-stream; charset=utf-8')).toEqual([{ id: 2 }, { id: 3 }]);
  });

  for (const sse of [false, true])
    it(`starts a session, lists every page of tools and calls one (${sse ? 'SSE' : 'JSON'})`, async () => {
      const ha = fakeHa({ sse, token: 'tok' });
      const c = new McpClient(server(), ha.fetchFn);
      expect((await c.listTools(signal())).map((t) => t.name)).toEqual(['HassTurnOn', 'HassTurnOff', 'HassLockUnlock', 'HassShellRun']);
      expect(await c.call('HassTurnOn', { name: 'kitchen' }, signal())).toEqual({ text: 'HassTurnOn kitchen: done', error: false });
      expect(ha.calls.map((x) => x.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
      expect(ha.calls.at(-1)!.headers['mcp-session-id']).toBe('s1');
      expect(ha.calls.at(-1)!.headers.authorization).toBe('Bearer tok');
    });

  it('starts over once when the server forgot the session', async () => {
    const ha = fakeHa();
    const c = new McpClient(server(), ha.fetchFn);
    await c.listTools(signal());
    ha.restart();
    expect((await c.call('HassTurnOff', { name: 'fan' }, signal())).text).toBe('HassTurnOff fan: done');
    expect(ha.calls.filter((x) => x.method === 'initialize')).toHaveLength(2);
  });

  it('a wrong token is a clear error', async () => {
    const c = new McpClient(server({ token: 'bad' }), fakeHa({ token: 'tok' }).fetchFn);
    await expect(c.listTools(signal())).rejects.toThrow(/refused the token/);
  });
});

describe('home control tools', () => {
  const build = async (over: Partial<McpServer> = {}) => {
    const ha = fakeHa();
    const s = server(over);
    const c = new McpClient(s, ha.fetchFn);
    return { tools: serverTools(s, c, await c.listTools(signal()), log), ha };
  };

  it('offers only the allowed tools the server really has, with safe names and schemas', async () => {
    const { tools } = await build({ allow: ['HassTurnOn', 'HassLockUnlock', 'NotThere'] });
    expect(tools.map((t) => t.spec.name)).toEqual(['home_HassTurnOn', 'home_HassLockUnlock']);
    expect(tools[0]!.spec.parameters).toEqual({ type: 'object', properties: { name: { type: 'string' }, area: { type: 'string' } } });
    expect(toolName('my home!', 'a.b')).toBe('my_home__a_b');
  });

  it('only owners can use them', async () => {
    const { tools, ha } = await build();
    const on = tools.find((t) => t.spec.name === 'home_HassTurnOn')!;
    expect(await on.run({ name: 'kitchen' }, signal(), ctx('friend', 1))).toMatch(/Only the household's owners/);
    expect(ha.calls.some((x) => x.method === 'tools/call')).toBe(false);
    expect(await on.run({ name: 'kitchen' }, signal(), ctx('owner', 1))).toBe('HassTurnOn kitchen: done');
    expect(await on.run({ name: 'broken' }, signal(), ctx('owner', 2))).toBe("It didn't work: no device called broken");
  });

  it('asks first for a tool that needs a yes, and acts only on their next turn\'s yes', async () => {
    const { tools, ha } = await build();
    const unlock = tools.find((t) => t.spec.name === 'home_HassLockUnlock')!;
    const q = String(await unlock.run({ name: 'front door' }, signal(), ctx('owner', 1, 'unlock the front door')));
    expect(q).toBe('Okay to lock unlock front door?');
    expect(unlock.asks?.(q)).toBe(true);
    expect(unlock.speak?.({}, q, ctx('owner', 1))).toBe(q);
    // A no: nothing happens, and the next try asks again.
    expect(await unlock.run({ name: 'front door' }, signal(), ctx('owner', 2, 'no wait'))).toBe(q);
    expect(ha.calls.some((x) => x.method === 'tools/call')).toBe(false);
    expect(await unlock.run({ name: 'front door' }, signal(), ctx('owner', 3, 'yes'))).toBe('HassLockUnlock front door: done');
  });

  it('a yes to one door does not open another', async () => {
    const { tools, ha } = await build();
    const unlock = tools.find((t) => t.spec.name === 'home_HassLockUnlock')!;
    await unlock.run({ name: 'front door' }, signal(), ctx('owner', 1));
    expect(String(await unlock.run({ name: 'garage' }, signal(), ctx('owner', 2, 'yes')))).toMatch(/^Okay to/);
    expect(ha.calls.some((x) => x.method === 'tools/call')).toBe(false);
  });

  it('are offered only for requests about the house', async () => {
    const { tools } = await build();
    const all: Tool[] = [{ spec: { name: 'get_time', description: '', parameters: {} }, run: async () => '' }, ...tools];
    expect(routeTools(all, 'turn off the kitchen lights').map((t) => t.spec.name)).toContain('home_HassTurnOff');
    expect(routeTools(all, 'what time is it').map((t) => t.spec.name)).toEqual(['get_time']);
    expect(HOME_WORDS.test('is the garage door open')).toBe(true);
  });
});

describe('connecting at start', () => {
  it('adds the tools once the server answers, and keeps trying while it is down', async () => {
    const ha = fakeHa();
    let up = false;
    const flaky = (async (u: URL | string, i?: RequestInit) => (up ? ha.fetchFn(u, i) : Promise.reject(new Error('ECONNREFUSED')))) as typeof fetch;
    const into: Tool[] = [];
    const added: string[][] = [];
    const c = connectMcp([server()], into, log, { fetchFn: flaky, retryMs: 20, onAdded: (n) => added.push(n) });
    await new Promise((r) => setTimeout(r, 30));
    expect(into).toEqual([]);
    up = true;
    await vi.waitFor(() => expect(into.map((t) => t.spec.name)).toEqual(['home_HassTurnOn', 'home_HassTurnOff', 'home_HassLockUnlock']), { timeout: 10_000, interval: 2 });
    expect(added).toHaveLength(1);
    c.stop();
  });
});

describe('the yes for doors and locks', () => {
  it('a light just happens; a door or lock through the same tool asks first', async () => {
    const ha = fakeHa();
    const s = server();
    const c = new McpClient(s, ha.fetchFn);
    const tools = serverTools(s, c, await c.listTools(signal()), log);
    const off = tools.find((t) => t.spec.name === 'home_HassTurnOff')!;
    expect(await off.run({ name: 'living room lamp' }, signal(), ctx('owner', 1))).toBe('HassTurnOff living room lamp: done');
    expect(await off.run({ name: 'Front Door Lock' }, signal(), ctx('owner', 2))).toBe('Okay to turn off Front Door Lock?');
    expect(await off.run({ name: 'Front Door Lock' }, signal(), ctx('owner', 3, 'yes'))).toBe('HassTurnOff Front Door Lock: done');
    // "doorbell" is not "door".
    expect(await off.run({ name: 'doorbell chime' }, signal(), ctx('owner', 4))).toBe('HassTurnOff doorbell chime: done');
  });
});
