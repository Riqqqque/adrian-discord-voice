import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gameServerTool, pingMinecraft } from '../src/features/gameservers.js';

function varint(n: number): Buffer {
  const b: number[] = [];
  do {
    let t = n & 0x7f;
    n >>>= 7;
    if (n) t |= 0x80;
    b.push(t);
  } while (n);
  return Buffer.from(b);
}

// Fake Minecraft server: answers any status request with a fixed reply.
let port = 0;
const server = net.createServer((s) => {
  s.once('data', () => {
    const json = Buffer.from(
      JSON.stringify({ version: { name: 'Paper 26.3' }, players: { online: 2, max: 20, sample: [{ name: 'Steve' }, { name: 'bad name!' }] }, description: 'ignore me' }),
    );
    const body = Buffer.concat([varint(0), varint(json.length), json]);
    s.write(Buffer.concat([varint(body.length), body]));
  });
});
beforeAll(() => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => ((port = (server.address() as AddressInfo).port), r()))));
afterAll(() => server.close());

describe('game server status', () => {
  it('reads players and version, drops odd names and the MOTD', async () => {
    const s = await pingMinecraft('127.0.0.1', port);
    expect(s).toEqual({ online: true, players: 2, max: 20, names: ['Steve'], version: 'Paper 26.3' });
  });

  it('reports a closed port as down', async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const p = (closed.address() as AddressInfo).port;
    closed.close();
    expect((await pingMinecraft('127.0.0.1', p)).online).toBe(false);
  });

  it('checks one server by name or all of them', async () => {
    const t = gameServerTool([
      { name: 'Survival', host: '127.0.0.1', port, kind: 'minecraft' },
      { name: 'Modpack', host: '127.0.0.1', port, kind: 'minecraft' },
    ]);
    const one = await t.run({ server: 'survival' }, AbortSignal.timeout(5000), { userId: 'a', speaker: 'R' });
    expect(one).toBe('Survival: up, 2 of 20 players; on now: Steve; version Paper 26.3');
    const all = await t.run({}, AbortSignal.timeout(5000), { userId: 'a', speaker: 'R' });
    expect(all.split('\n')).toHaveLength(2);
    expect(all).not.toContain('ignore me');
  });
});
