// The WebSocket endpoint PC satellites connect to. A connection must send a
// valid `hello` within 5 seconds; addresses that keep failing are shut out
// for a while.

import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Logger } from '../core/interfaces.js';
import { capFrames, frameBytes, MAX_FRAME, SatelliteConnection, SMALL_FRAME } from './connection.js';
import { SatelliteDevices } from './devices.js';

export interface SatelliteServerOptions {
  bind: string;
  port: number;
  devices: SatelliteDevices;
  log: Logger;
  /** Accent color and owner name for the window. */
  welcome: (c: SatelliteConnection) => Record<string, unknown>;
  onConnect: (c: SatelliteConnection) => void;
  /** How often live connections are checked against the pairings, ms (tests). */
  recheckMs?: number;
}

const HELLO_MS = 5_000;
/** Failed hellos per address before it's shut out, and for how long. */
const MAX_FAILS = 5;
const LOCKOUT_MS = 10 * 60_000;

export function startSatelliteServer(o: SatelliteServerOptions): { close(): Promise<void>; connections(): SatelliteConnection[] } {
  const live = new Set<SatelliteConnection>();
  const fails = new Map<string, { n: number; until: number }>();
  // Audio frames are small; anything big is not a satellite. The cap leaves room
  // for one screen picture, and only a welcomed satellite gets that far.
  const wss = new WebSocketServer({ host: o.bind, port: o.port, path: '/satellite', maxPayload: MAX_FRAME });

  wss.on('listening', () => o.log.info('satellite server listening', { bind: o.bind, port: o.port }));
  wss.on('error', (e) => o.log.error('satellite server error', { error: e.message }));

  wss.on('connection', (ws, req: IncomingMessage) => {
    const addr = req.socket.remoteAddress ?? '?';
    // Until it's welcomed, a socket gets audio-sized frames only.
    capFrames(ws, SMALL_FRAME);
    // A bad frame arrives as 'error', even before a hello or after a refusal.
    // With nobody listening that throws and takes the whole bot down.
    ws.on('error', (e) => {
      o.log.warn('satellite socket error', { addr, error: e.message });
      ws.terminate();
    });
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
      // Not a token guess, so it doesn't count toward the lockout.
      if (frameBytes(data) > SMALL_FRAME) {
        o.log.warn('satellite rejected', { addr, reason: 'frame too big' });
        ws.close(1009, 'frame too big');
        return;
      }
      let m: Record<string, unknown> = {};
      try {
        // "null" parses fine, and reading m.type off it would throw.
        if (!isBinary) m = (JSON.parse(String(data)) ?? {}) as Record<string, unknown>;
      } catch {
        /* falls through to the check below */
      }
      const device = m.type === 'hello' ? o.devices.verify(m.token) : undefined;
      if (!device) {
        // The lockout is for wrong tokens only: behind a proxy every PC shares an
        // address, and a stranger's guesses mustn't keep the real one out.
        const f = fails.get(addr);
        if (f && f.until > Date.now()) {
          ws.close(1008, 'too many failed attempts');
          return;
        }
        if (fails.size > 1000) for (const [k, v] of fails) if (v.until < Date.now()) fails.delete(k);
        return fail('bad token');
      }
      fails.delete(addr);
      // One live connection per device: a reconnect replaces the old one.
      for (const c of live) if (c.device.id === device.id) void c.disconnect();
      const conn = new SatelliteConnection(ws, device, typeof m.version === 'string' ? m.version.slice(0, 20) : undefined);
      // Welcomed: room for a picture now (connection.ts lets only action_result be big).
      capFrames(ws, MAX_FRAME);
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

  // `adrian satellite remove` runs in another process: a PC unpaired while
  // connected would keep its owner's rights (alarms, reminders, PC tools,
  // its mic) until a restart. Checked here instead. A file that can't be read
  // says nothing about any one PC: the pairings stand as they were (new
  // hellos are still refused while it lasts), and the log says so loudly.
  let unreadable = 0;
  const recheck = setInterval(() => {
    if (!live.size) return;
    const now = o.devices.read();
    if (!now) {
      if (unreadable++ % 20 === 0) o.log.error("satellites.json can't be read; keeping connected PCs as they were, refusing new ones", { pcs: live.size, rounds: unreadable });
      return;
    }
    if (unreadable) o.log.info('satellites.json readable again', { rounds: unreadable });
    unreadable = 0;
    for (const c of live) {
      if (SatelliteDevices.stillPaired(c.device, now)) continue;
      o.log.warn('satellite unpaired; dropping it', { device: c.device.name });
      c.send({ type: 'denied', reason: 'unpaired' });
      c.refuse('unpaired');
    }
  }, o.recheckMs ?? 30_000);
  recheck.unref();

  return {
    connections: () => [...live],
    close: () =>
      new Promise((resolve) => {
        clearInterval(beat);
        clearInterval(recheck);
        for (const c of live) void c.disconnect();
        wss.close(() => resolve());
      }),
  };
}
