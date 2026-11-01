// Reconnects against the real @discordjs/voice VoiceConnection, with a fake
// adapter and gateway: no network. Its state machine is the thing under test,
// because the bugs here came from what it does when nobody is watching.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordVoiceTransport } from '../src/transport/discord.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const STUCK_MS = 30_000;
const SLOW_RETRY_MS = 5 * 60_000;
const JOIN_LIMIT_MS = 20_000;

interface Conn {
  state: { status: string };
  onNetworkingClose(code: number): void;
}
interface Inner {
  connection: Conn | undefined;
  closing: boolean;
}

let guilds = 0;

/** A transport joined (or joining) channel C of a guild of its own. `echoLeave`: the
 *  gateway reports the bot's own leave back, as it really does for a destroy. */
function rig(echoLeave = true) {
  const guildId = `G${++guilds}`;
  const payloads: (string | null)[] = [];
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' } }) as EventEmitter & Record<string, unknown>;
  /** What the gateway says about the bot: a voice state change. */
  const gateway = (from: string | null, to: string | null, id = 'bot') => client.emit('voiceStateUpdate', { id, channelId: from }, { id, channelId: to });
  const guild = {
    voiceAdapterCreator: () => ({
      sendPayload: (p: { d: { channel_id: string | null } }) => {
        payloads.push(p.d.channel_id);
        if (echoLeave && p.d.channel_id === null) setTimeout(() => gateway('C', null), 30);
        return true;
      },
      destroy() {},
    }),
  };
  client.guilds = { fetch: async () => guild, cache: new Map() };
  const t = new DiscordVoiceTransport({ client: client as never, logger: quiet as never, silenceMs: 800 });
  const inner = t as unknown as Inner;
  const events: string[] = [];
  for (const e of ['ready', 'disconnected', 'failed', 'kicked'] as const) t.on(e, () => events.push(e));
  /** The library's own path from Signalling to a working connection. */
  const toReady = async () => {
    const conn = inner.connection as unknown as Record<string, unknown> & { state: Record<string, unknown> };
    const networking = Object.assign(new EventEmitter(), { state: { code: 4 }, destroy() {} });
    conn.state = { ...conn.state, status: 'connecting', networking };
    conn.state = { ...conn.state, status: 'ready' };
    await vi.advanceTimersByTimeAsync(0);
  };
  const joined = async () => {
    const p = t.connect(guildId, 'C');
    await vi.advanceTimersByTimeAsync(0);
    await toReady();
    await p;
    return inner.connection!;
  };
  return { t, inner, events, payloads, gateway, toReady, joined, guildId };
}

const count = (list: string[], what: string) => list.filter((x) => x === what).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter in the rejoin delays
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a connection that stops coming back', () => {
  it('stuck in Signalling after a failed resume: rebuilt, and not taken for a kick', async () => {
    const r = rig();
    const conn = await r.joined();
    r.payloads.length = 0;
    conn.onNetworkingClose(1006); // Ready to Signalling, with no time limit in the library
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.state.status).toBe('signalling');
    expect(r.events).toEqual(['ready', 'disconnected']);
    expect(r.t.isReady()).toBe(false);

    await vi.advanceTimersByTimeAsync(STUCK_MS - 1);
    expect(conn.state.status).toBe('signalling'); // the library still has its chance

    await vi.advanceTimersByTimeAsync(3_000);
    expect(conn.state.status).toBe('destroyed');
    expect(r.payloads).toEqual(['C', null, 'C']); // its resend, the leave, the rejoin
    expect(r.events).not.toContain('kicked');
    expect(r.inner.closing).toBe(false);

    await r.toReady();
    expect(r.t.isReady()).toBe(true);
    expect(r.events.at(-1)).toBe('ready');
    await r.t.disconnect();
  });

  it('stuck in Connecting (a lost discovery packet): rebuilt too', async () => {
    const r = rig();
    const conn = (await r.joined()) as unknown as Conn & { state: Record<string, unknown> };
    r.payloads.length = 0;
    conn.state = { ...conn.state, status: 'connecting' };
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000);
    expect(r.events).toEqual(['ready', 'disconnected']);
    expect(conn.state.status).toBe('destroyed');
    expect(r.payloads).toEqual([null, 'C']);
    await r.t.disconnect();
  });

  it('a resume that finishes in time is left alone', async () => {
    const r = rig();
    const conn = await r.joined();
    r.payloads.length = 0;
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS - 5_000);
    await r.toReady();
    await vi.advanceTimersByTimeAsync(2 * STUCK_MS);
    expect(conn.state.status).toBe('ready');
    expect(r.payloads).toEqual(['C']);
    expect(r.events).toEqual(['ready', 'disconnected', 'ready']);
    await r.t.disconnect();
  });

  it('a second drop after a resume is watched as well', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await r.toReady();
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000);
    expect(conn.state.status).toBe('ready');
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000);
    expect(conn.state.status).toBe('destroyed');
    await r.t.disconnect();
  });

  it('a drop that starts reconnecting and then hangs is rebuilt, not trusted', async () => {
    const r = rig();
    const conn = (await r.joined()) as unknown as Conn & { state: Record<string, unknown> };
    r.payloads.length = 0;
    conn.state = { ...conn.state, status: 'disconnected', reason: 0 };
    await vi.advanceTimersByTimeAsync(1_000);
    conn.state = { ...conn.state, status: 'signalling' }; // "the library is reconnecting by itself"
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000);
    expect(conn.state.status).toBe('destroyed');
    expect(r.payloads).toEqual([null, 'C']);
    await r.t.disconnect();
  });

  it('a new connection is watched even while the old watch is still running out', async () => {
    const r = rig();
    const old = await r.joined();
    old.onNetworkingClose(1006);
    await r.t.disconnect(); // /leave, with the old wait still going
    await vi.advanceTimersByTimeAsync(100);
    const conn = await r.joined(); // /join
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000);
    expect(conn.state.status).toBe('destroyed');
    await r.t.disconnect();
  });

  it('stops watching after a deliberate leave', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await r.t.disconnect();
    r.payloads.length = 0;
    await vi.advanceTimersByTimeAsync(2 * STUCK_MS);
    expect(r.payloads).toEqual([]);
  });
});

describe('a real kick still counts', () => {
  it('in a working call', async () => {
    const r = rig();
    await r.joined();
    r.gateway('C', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events).toContain('kicked');
    expect(r.inner.closing).toBe(true);
  });

  it('while the library is reconnecting: nothing fights its way back in', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    r.gateway('C', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events).toContain('kicked');
    r.payloads.length = 0;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.payloads).toEqual([]);
  });

  it('as soon as the gateway has seen her back in the channel, before the connection is up', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000); // rebuilt, rejoin sent
    r.gateway(null, 'C');
    r.gateway('C', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events).toContain('kicked');
    r.payloads.length = 0;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.payloads).toEqual([]);
  });

  it('after a rebuild has finished', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000);
    await r.toReady();
    r.gateway('C', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events).toContain('kicked');
  });

  it('after a stale join gives up behind a newer connection', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000); // a rejoin is waiting on its 20 s limit
    r.gateway(null, 'C');
    r.gateway('C', null); // kicked during it
    await vi.advanceTimersByTimeAsync(100);
    await r.joined(); // /join brings her back
    await vi.advanceTimersByTimeAsync(JOIN_LIMIT_MS); // the old limit runs out now
    r.events.length = 0;
    r.gateway('C', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.events).toContain('kicked');
  });
});

describe('leaving on her own terms', () => {
  it('her leave for a rejoin, reported late by the gateway, is not a kick', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS);
    expect(conn.state.status).toBe('destroyed');
    await vi.advanceTimersByTimeAsync(5_000); // the 30 ms echo has long landed
    expect(r.events).not.toContain('kicked');
  });

  it('a rejoin that times out does not end the loop', async () => {
    const r = rig();
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + 3_000);
    r.gateway(null, 'C'); // in the channel, but the connection never comes up
    await vi.advanceTimersByTimeAsync(JOIN_LIMIT_MS - 1_000); // it gave up, and its leave was echoed back
    expect(r.events).not.toContain('kicked');
    r.payloads.length = 0;
    await vi.advanceTimersByTimeAsync(3_000); // the next try, 2 s after that one
    expect(r.payloads).toEqual(['C']);
    await r.t.disconnect();
  });

  it('/join to the channel she is stuck in: disconnect, connect, and the late report of that leave', async () => {
    const r = rig();
    await r.joined();
    await r.t.disconnect();
    const p = r.t.connect(r.guildId, 'C');
    await vi.advanceTimersByTimeAsync(100); // the 30 ms echo lands after connect()
    expect(r.events).not.toContain('kicked');
    await r.toReady();
    await p;
    expect(r.t.isReady()).toBe(true);
    await r.t.disconnect();
  });
});

describe('a long outage', () => {
  /** Every rejoin times out. Enough time for all the quick ones. */
  const quickRoundsMs = 31_000 + 5 * 500 + 5 * JOIN_LIMIT_MS + 1_000;

  it('fails once, then keeps trying slowly, and comes back by itself', async () => {
    const r = rig(false);
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + quickRoundsMs);
    expect(count(r.events, 'failed')).toBe(1);
    r.payloads.length = 0;

    await vi.advanceTimersByTimeAsync(SLOW_RETRY_MS);
    expect(r.payloads).toEqual(['C']);
    await vi.advanceTimersByTimeAsync(JOIN_LIMIT_MS + SLOW_RETRY_MS); // still out: leave, and another go
    expect(r.payloads).toEqual(['C', null, 'C']);
    expect(count(r.events, 'failed')).toBe(1);

    await r.toReady();
    expect(r.t.isReady()).toBe(true);
    expect(r.events.at(-1)).toBe('ready');
    r.payloads.length = 0;
    await vi.advanceTimersByTimeAsync(2 * SLOW_RETRY_MS);
    expect(r.payloads).toEqual([]);
    await r.t.disconnect();
  });

  it('a deliberate leave ends the slow retry', async () => {
    const r = rig(false);
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + quickRoundsMs);
    await r.t.disconnect();
    r.payloads.length = 0;
    await vi.advanceTimersByTimeAsync(3 * SLOW_RETRY_MS);
    expect(r.payloads).toEqual([]);
  });

  it('counts the quick rejoins again after she has been back', async () => {
    const r = rig(false);
    const conn = await r.joined();
    conn.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + quickRoundsMs + SLOW_RETRY_MS);
    await r.toReady();
    const again = r.inner.connection!;
    again.onNetworkingClose(1006);
    await vi.advanceTimersByTimeAsync(STUCK_MS + 2_000);
    expect(again.state.status).toBe('destroyed');
    expect(r.inner.connection).toBeDefined(); // the first rejoin came after a second, not five minutes
    await r.t.disconnect();
  });
});

describe('a join that fails at startup', () => {
  it('connect() still says so, and retry() keeps at it', async () => {
    const r = rig(false);
    const failed = r.t.connect(r.guildId, 'C').catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(JOIN_LIMIT_MS);
    expect(await failed).toBe('AbortError');
    expect(r.inner.connection).toBeUndefined();
    r.payloads.length = 0;

    r.t.retry();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.payloads).toEqual(['C']);
    await r.toReady();
    expect(r.t.isReady()).toBe(true);
    await r.t.disconnect();
  });

  it('retry() does nothing after a deliberate leave, or while connected', async () => {
    const r = rig();
    await r.joined();
    r.payloads.length = 0;
    r.t.retry();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.payloads).toEqual([]);
    await r.t.disconnect();
    r.payloads.length = 0;
    r.t.retry();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.payloads).toEqual([]);
  });
});
