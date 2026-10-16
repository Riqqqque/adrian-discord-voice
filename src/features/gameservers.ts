// Read-only game server status (Minecraft Java server-list ping). Reports
// up/down, player counts, who's on and the version. The server's own message
// of the day is never passed on: it's free text set by whoever runs it.

import net from 'node:net';
import type { Tool } from '../core/interfaces.js';

export interface GameServer {
  name: string;
  host: string;
  port: number;
  kind: 'minecraft';
}

export interface McStatus {
  online: boolean;
  players?: number;
  max?: number;
  names?: string[];
  version?: string;
  error?: string;
}

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

function mcString(s: string): Buffer {
  const d = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(d.length), d]);
}

/** Minecraft Java "server list ping" (protocol-independent status request). */
export function pingMinecraft(host: string, port: number, timeoutMs = 3000): Promise<McStatus> {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let buf = Buffer.alloc(0);
    const done = (s: McStatus) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(s);
    };
    const timer = setTimeout(() => done({ online: false, error: 'no answer' }), timeoutMs);
    sock.on('connect', () => {
      const hs = Buffer.concat([varint(0), varint(767), mcString(host), Buffer.from([port >> 8, port & 255]), varint(1)]);
      sock.write(Buffer.concat([varint(hs.length), hs, Buffer.from([1, 0])]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 256 * 1024) return done({ online: true, error: 'reply too large' });
      let i = 0;
      const rd = () => {
        let n = 0;
        let shift = 0;
        let b: number | undefined;
        do {
          b = buf[i++];
          if (b === undefined) throw new RangeError('short');
          n |= (b & 0x7f) << shift;
          shift += 7;
        } while (b & 0x80);
        return n;
      };
      try {
        const len = rd();
        if (buf.length < i + len) return; // wait for more
        rd(); // packet id
        const sl = rd();
        const j = JSON.parse(buf.subarray(i, i + sl).toString('utf8')) as {
          version?: { name?: string };
          players?: { online?: number; max?: number; sample?: { name?: string }[] };
        };
        done({
          online: true,
          ...(typeof j.players?.online === 'number' ? { players: j.players.online } : {}),
          ...(typeof j.players?.max === 'number' ? { max: j.players.max } : {}),
          names: (j.players?.sample ?? []).map((p) => String(p.name ?? '')).filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n)).slice(0, 12),
          ...(j.version?.name ? { version: String(j.version.name).replace(/§./g, '').slice(0, 40) } : {}),
        });
      } catch (e) {
        if (!(e instanceof RangeError)) done({ online: true, error: 'unreadable reply' });
      }
    });
    sock.on('error', (e: NodeJS.ErrnoException) => done({ online: false, error: e.code === 'ECONNREFUSED' ? 'offline' : 'unreachable' }));
  });
}

export function describeStatus(name: string, s: McStatus): string {
  if (!s.online) return `${name}: down (${s.error ?? 'offline'})`;
  const who = s.names?.length ? `; on now: ${s.names.join(', ')}` : '';
  return `${name}: up, ${s.players ?? '?'} of ${s.max ?? '?'} players${who}${s.version ? `; version ${s.version}` : ''}`;
}

export function gameServerTool(servers: GameServer[], ping = pingMinecraft): Tool {
  return {
    spec: {
      name: 'game_server_status',
      description: `Check whether the household's Minecraft servers are up and who is playing. Servers: ${servers.map((s) => s.name).join(', ')}. Leave server empty to check all.`,
      parameters: { type: 'object', properties: { server: { type: 'string' } }, additionalProperties: false },
    },
    run: async (a) => {
      const q = typeof a.server === 'string' ? a.server.trim().toLowerCase() : '';
      const pick = q ? servers.filter((s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase())) : servers;
      const list = pick.length ? pick : servers;
      const res = await Promise.all(list.map(async (s) => describeStatus(s.name, await ping(s.host, s.port))));
      return (q && !pick.length ? `No server matched "${q}"; all servers:\n` : '') + res.join('\n');
    },
  };
}
