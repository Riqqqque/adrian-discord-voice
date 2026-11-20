import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Connections, connectionDropped, IDLE_MS } from '../src/core/http.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A local server that records every request and the client port it came on. */
async function server(handle?: (req: IncomingMessage, res: ServerResponse, n: number) => void) {
  const seen: { method: string; path: string; port: number; auth?: string }[] = [];
  const srv: Server = createServer((req, res) => {
    seen.push({ method: req.method!, path: req.url!, port: req.socket.remotePort!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    req.resume();
    req.on('end', () => (handle ? handle(req, res, seen.length) : res.end('ok')));
  });
  // The server would keep a connection a minute; the client decides.
  srv.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  servers.push(srv);
  return { srv, origin, seen };
}
const servers: Server[] = [];
const pools: Connections[] = [];
const pool = (o: ConstructorParameters<typeof Connections>[0]) => {
  const c = new Connections(o);
  pools.push(c);
  return c;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

describe('provider connections', () => {
  it('keeps an idle connection for the origin its limit, and no longer', async () => {
    const { origin, seen } = await server();
    const long = pool({ idleMs: { [origin]: 10_000 } });
    const short = pool({ idleMs: { [origin]: 100 } });
    for (const p of [long, short]) {
      await (await p.fetch(`${origin}/a`)).text();
      await sleep(400);
      await (await p.fetch(`${origin}/b`)).text();
    }
    expect(seen[1]!.port).toBe(seen[0]!.port); // kept
    expect(seen[3]!.port).not.toBe(seen[2]!.port); // closed after 100 ms
    expect(long.idleFor(origin)).toBe(10_000);
    expect(pool({}).idleFor(origin)).toBe(4_000); // unknown origins: Node's default
  });

  it('idle limits stay under what each provider measured (400 s Cloudflare, 245 s Tavily, 610 s Speechify)', () => {
    expect(IDLE_MS['https://api.anthropic.com']).toBeLessThan(400_000);
    expect(IDLE_MS['https://api.groq.com']).toBeLessThan(400_000);
    expect(IDLE_MS['https://api.tavily.com']).toBeLessThan(245_000);
    expect(IDLE_MS['https://api.speechify.ai']).toBeLessThan(610_000);
  });

  it('opens a new connection after the server closed the idle one, without an error or a second request', async () => {
    const { srv, origin, seen } = await server();
    const p = pool({ idleMs: { [origin]: 10_000 } });
    expect(await (await p.fetch(`${origin}/a`, { method: 'POST', body: 'x' })).text()).toBe('ok');
    srv.closeIdleConnections(); // the server's own idle limit ran out
    await sleep(50);
    expect(await (await p.fetch(`${origin}/b`, { method: 'POST', body: 'y' })).text()).toBe('ok');
    expect(seen.map((s) => s.path)).toEqual(['/a', '/b']);
    expect(seen[1]!.port).not.toBe(seen[0]!.port);
  });

  it('sends once more when a kept-alive connection breaks before any answer', async () => {
    // The second request arrives on the kept connection and the server drops it unanswered.
    const { origin, seen } = await server((req, res, n) => (n === 2 ? req.socket.destroy() : res.end(`ok${n}`)));
    const p = pool({ idleMs: { [origin]: 10_000 } });
    await (await p.fetch(`${origin}/a`)).text();
    await sleep(20); // back in the pool
    const r = await p.fetch(`${origin}/b`, { method: 'POST', body: 'same' });
    expect(await r.text()).toBe('ok3');
    expect(seen.map((s) => s.path)).toEqual(['/a', '/b', '/b']);
    expect(seen[2]!.port).not.toBe(seen[1]!.port);
  });

  it('a new connection that breaks is not sent again, and neither is fetchOnce or a stopped request', async () => {
    const { origin, seen } = await server((req) => req.socket.destroy());
    const p = pool({ idleMs: { [origin]: 10_000 } });
    const err = await p.fetch(`${origin}/new`, { method: 'POST', body: 'x' }).catch((e: unknown) => e);
    expect(connectionDropped(err)).toBe(true);
    expect(seen).toHaveLength(1);

    const { origin: o2, seen: seen2 } = await server((req, res, n) => (n === 1 ? res.end('ok') : req.socket.destroy()));
    const q = pool({ idleMs: { [o2]: 10_000 } });
    await (await q.fetch(`${o2}/a`)).text();
    await sleep(20);
    await expect(q.fetchOnce(`${o2}/b`, { method: 'POST', body: 'x' })).rejects.toThrow();
    expect(seen2).toHaveLength(2);
  });

  it('a request already stopped is not sent again', async () => {
    const ctl = new AbortController();
    const { origin, seen } = await server((req, res, n) => (n === 1 ? res.end('ok') : (ctl.abort(), req.socket.destroy())));
    const p = pool({ idleMs: { [origin]: 10_000 } });
    await (await p.fetch(`${origin}/a`)).text();
    await sleep(20);
    await expect(p.fetch(`${origin}/b`, { method: 'POST', body: 'x', signal: ctl.signal })).rejects.toThrow();
    await sleep(50);
    expect(seen).toHaveLength(2);
  });

  it('pre-opens with a credential-free GET when no connection is open, and the next request uses it', async () => {
    const { origin, seen } = await server();
    let now = 1_000_000;
    const p = pool({ idleMs: { [origin]: 60_000 }, now: () => now });
    expect(p.preconnect(origin)).toBe(true);
    expect(p.preconnect(origin)).toBe(false); // one at a time
    await sleep(100);
    expect(seen).toEqual([{ method: 'GET', path: '/', port: seen[0]!.port }]); // no key
    expect(p.isOpen(origin)).toBe(true);
    expect(p.preconnect(origin)).toBe(false); // still open
    await (await p.fetch(`${origin}/ask`, { method: 'POST', body: 'x', headers: { authorization: 'Bearer k' } })).text();
    expect(seen[1]).toMatchObject({ path: '/ask', port: seen[0]!.port, auth: 'Bearer k' });
    now += 56_000; // within 5 s of the limit: counts as gone
    expect(p.isOpen(origin)).toBe(false);
    expect(p.preconnect(origin)).toBe(true);
  });

  it('wake() opens registered providers and ones used within the hour, and never throws', async () => {
    const a = await server();
    const b = await server();
    let now = 1_000_000;
    const p = pool({ idleMs: { [a.origin]: 60_000, [b.origin]: 60_000, 'http://127.0.0.1:9': 60_000 }, now: () => now });
    p.register(`${a.origin}/v1/x`);
    p.register('http://127.0.0.1:9/'); // nothing listens: the failure is swallowed
    await (await p.fetch(`${b.origin}/search`)).text();
    now += 120_000;
    p.wake();
    await sleep(150);
    expect(a.seen.map((s) => s.path)).toEqual(['/']);
    expect(b.seen.map((s) => s.path)).toEqual(['/search', '/']);
    now += 3_700_000; // b not used for over an hour: left closed
    p.wake();
    await sleep(150);
    expect(a.seen).toHaveLength(2);
    expect(b.seen).toHaveLength(2);
  });

  it('wake() leaves origins without a known idle limit alone (a local model server)', async () => {
    const local = await server();
    const p = pool({ idleMs: {} });
    await (await p.fetch(`${local.origin}/v1/chat/completions`, { method: 'POST', body: '{}' })).text();
    await sleep(20);
    p.register(local.origin);
    p.wake();
    await sleep(100);
    expect(local.seen).toHaveLength(1);
  });
});
