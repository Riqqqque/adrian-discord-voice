// The WebSocket endpoint PC satellites connect to. A connection must send a
// valid `hello` within 5 seconds; addresses that keep failing are shut out
// for a while.

import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Logger } from '../core/interfaces.js';
import { SatelliteConnection } from './connection.js';
import type { SatelliteDevices } from './devices.js';

export interface SatelliteServerOptions {
  bind: string;
  port: number;
  devices: SatelliteDevices;
  log: Logger;
  /** Accent color and owner name for the window. */
  welcome: (c: SatelliteConnection) => Record<string, unknown>;
  onConnect: (c: SatelliteConnection) => void;
}

const HELLO_MS = 5_000;
/** Failed hellos per address before it's shut out, and for how long. */
const MAX_FAILS = 5;
const LOCKOUT_MS = 10 * 60_000;

export function startSatelliteServer(o: SatelliteServerOptions): { close(): Promise<void>; connections(): SatelliteConnection[] } {
  const live = new Set<SatelliteConnection>();
  const fails = new Map<string, { n: number; until: number }>();
  // Audio frames are small; anything big is not a satellite.
  const wss = new WebSocketServer({ host: o.bind, port: o.port, path: '/satellite', maxPayload: 256 * 1024 });

  wss.on('listening', () => o.log.info('satellite server listening', { bind: o.bind, port: o.port }));
  wss.on('error', (e) => o.log.error('satellite server error', { error: e.message }));

  wss.on('connection', (ws, req: IncomingMessage) => {
    const addr = req.socket.remoteAddress ?? '?';
    const f = fails.get(addr);
    if (f && f.until > Date.now()) {
      ws.close(1008, 'too many failed attempts');
      return;
    }
    const fail = (reason: string) => {
      const prev = fails.get(addr);
      const n = (prev && prev.until < Date.now() && prev.n >= MAX_FAILS ? 0 : (prev?.n ?? 0)) + 1;
      fails.set(addr, { n, until: n >= MAX_FAILS ? Date.now() + LOCKOUT_MS : 0 });
      o.log.warn('satellite rejected', { addr, reason });
      try {
        ws.send(JSON.stringify({ type: 'denied', reason }));
      } catch {
        /* closing anyway */
      }
      ws.close(1008, reason);
    };
    const timer = setTimeout(() => fail('no hello'), HELLO_MS);
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      let m: Record<string, unknown> = {};
      try {
        if (!isBinary) m = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        /* falls through to the check below */
      }
      const device = m.type === 'hello' ? o.devices.verify(m.token) : undefined;
      if (!device) return fail('bad token');
      fails.delete(addr);
      // One live connection per device: a reconnect replaces the old one.
      for (const c of live) if (c.device.id === device.id) void c.disconnect();
      const conn = new SatelliteConnection(ws, device);
      live.add(conn);
      conn.on('closed', () => {
        live.delete(conn);
        o.log.info('satellite disconnected', { device: device.name });
      });
      o.log.info('satellite connected', { device: device.name, version: typeof m.version === 'string' ? m.version.slice(0, 20) : undefined, addr });
      conn.send({ type: 'welcome', name: device.name, ...o.welcome(conn) });
      o.onConnect(conn);
      conn.start();
    });
  });

  // Keep-alive: drop connections that stop answering.
  const alive = new WeakSet<object>();
  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  });
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30_000);
  beat.unref();

  return {
    connections: () => [...live],
    close: () =>
      new Promise((resolve) => {
        clearInterval(beat);
        for (const c of live) void c.disconnect();
        wss.close(() => resolve());
      }),
  };
}
