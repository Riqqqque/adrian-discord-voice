import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SatelliteConnection } from '../src/satellite/connection.js';
import { SatelliteDevices } from '../src/satellite/devices.js';
import { startSatelliteServer } from '../src/satellite/server.js';
import { PC_RULE, pcTools, PowerDownWindow, webUrl } from '../src/satellite/tools.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const OWNER = '123456789012345678';

function devices() {
  return new SatelliteDevices(mkdtempSync(join(tmpdir(), 'sat-')));
}

/** A server on a free port, and a client helper that collects what it receives. */
async function rig() {
  const d = devices();
  const { token, device } = d.add('Desk PC', OWNER);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const conns: SatelliteConnection[] = [];
  const server = startSatelliteServer({ bind: '127.0.0.1', port, devices: d, log: quiet as never, welcome: () => ({ owner: 'Rique' }), onConnect: (c) => conns.push(c) });
  await new Promise((r) => setTimeout(r, 50));
  const client = (hello: unknown) =>
    new Promise<{ ws: WebSocket; got: unknown[]; bins: Buffer[]; closed: Promise<number> }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/satellite`);
      const got: unknown[] = [];
      const bins: Buffer[] = [];
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      ws.on('message', (data, bin) => (bin ? bins.push(data as Buffer) : got.push(JSON.parse(String(data)))));
      ws.on('open', () => {
        ws.send(JSON.stringify(hello));
        setTimeout(() => resolve({ ws, got, bins, closed }), 80);
      });
    });
  return { d, token, device, server, conns, client, port };
}

/** Frames the ws client refuses to send, so they go out over a plain socket. */
const BAD_FRAMES = {
  unmasked: Buffer.from([0x81, 0x01, 0x41]),
  'a reserved opcode': Buffer.from([0x83, 0x80, 0, 0, 0, 0]),
  // Declares 16 MiB, past the 2 MiB limit (room for one screen picture).
  'more than the size limit': Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x01, 0, 0, 0]),
  'broken UTF-8': Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xff, 0xff]),
};

/** A correct text frame, masked with zeros. */
const textFrame = (text: string) => Buffer.concat([Buffer.from([0x81, 0x80 | text.length, 0, 0, 0, 0]), Buffer.from(text)]);

/** A plain TCP client past the upgrade: it sends whatever bytes it's given. */
function rawClient(port: number) {
  return new Promise<{ write: (b: Buffer) => void; closed: () => boolean }>((resolve, reject) => {
    let closed = false;
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET /satellite HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => (closed = true));
    socket.once('data', (d) => (String(d).startsWith('HTTP/1.1 101') ? resolve({ write: (b) => socket.write(b), closed: () => closed }) : reject(new Error(String(d)))));
  });
}

const settle = () => new Promise((res) => setTimeout(res, 150));

describe('satellite pairing', () => {
  it('keeps only a hash, and checks tokens', () => {
    const d = devices();
    const { token, device } = d.add('Desk PC', OWNER);
    expect(token.startsWith('sat_')).toBe(true);
    expect(JSON.stringify(d.list())).not.toContain(token);
    expect(d.verify(token)?.id).toBe(device.id);
    expect(d.verify(`${token}x`)).toBeUndefined();
    expect(d.verify(42)).toBeUndefined();
    expect(() => d.add('Laptop', 'not-an-id')).toThrow(/Discord user ID/);
    expect(d.remove('desk pc')).toBe(true);
    expect(d.verify(token)).toBeUndefined();
  });
});

describe('satellite connection', () => {
  it('rejects a bad token and accepts a good one', async () => {
    const r = await rig();
    const bad = await r.client({ type: 'hello', token: 'sat_nope' });
    expect(bad.got).toContainEqual({ type: 'denied', reason: 'bad token' });
    expect(await bad.closed).toBe(1008);
    const good = await r.client({ type: 'hello', token: r.token, version: '0.1.0' });
    expect(good.got[0]).toMatchObject({ type: 'welcome', name: 'Desk PC', owner: 'Rique' });
    expect(r.conns).toHaveLength(1);
    good.ws.close();
    await r.server.close();
  });

  it('shuts out more guesses from an address after repeated bad tokens, but never the real PC', async () => {
    const r = await rig();
    for (let i = 0; i < 5; i++) await (await r.client({ type: 'hello', token: 'sat_wrong' })).closed;
    const guess = await r.client({ type: 'hello', token: 'sat_wrong' });
    await guess.closed;
    expect(guess.got).not.toContainEqual(expect.objectContaining({ type: 'denied' })); // closed without a reply
    // Behind a proxy every PC has the same address: a stranger's guesses mustn't lock the owner out.
    const good = await r.client({ type: 'hello', token: r.token });
    expect(good.got).toContainEqual(expect.objectContaining({ type: 'welcome' }));
    await r.server.close();
  });

  it('turns microphone audio into transport events and plays mono audio back', async () => {
    const r = await rig();
    const c = await r.client({ type: 'hello', token: r.token });
    const conn = r.conns[0]!;
    const events: string[] = [];
    let samples: Int16Array | undefined;
    conn.on('speechStart', (u) => events.push(`start:${u}`));
    conn.on('audio', (u, chunk) => ((samples = chunk.samples), events.push(`audio:${u}:${chunk.sampleRate}`)));
    conn.on('speechEnd', (u) => events.push(`end:${u}`));
    c.ws.send(JSON.stringify({ type: 'speech_start' }));
    const pcm = Buffer.alloc(8);
    [100, -200, 300, -400].forEach((v, i) => pcm.writeInt16LE(v, i * 2));
    c.ws.send(pcm);
    c.ws.send(JSON.stringify({ type: 'speech_end' }));
    await new Promise((res) => setTimeout(res, 80));
    expect(events).toEqual([`start:${OWNER}`, `audio:${OWNER}:48000`, `end:${OWNER}`]);
    expect([...samples!]).toEqual([100, -200, 300, -400]);

    // Stereo frames (L, R) in, their average out; a half frame waits for the rest.
    const out = new PassThrough();
    const h = conn.playPcm(out);
    const st = Buffer.alloc(10);
    [1000, 3000, -2000, -4000].forEach((v, i) => st.writeInt16LE(v, i * 2));
    out.write(st);
    await new Promise((res) => setTimeout(res, 80));
    const got = Buffer.concat(c.bins);
    expect([got.readInt16LE(0), got.readInt16LE(2)]).toEqual([2000, -3000]);
    h.stop();
    expect(await h.done).toBe('stopped');
    await new Promise((res) => setTimeout(res, 50));
    expect(c.got).toContainEqual({ type: 'audio_stop' });
    c.ws.close();
    await r.server.close();
  });

  it('round-trips PC actions, and answers when the PC goes away', async () => {
    const r = await rig();
    const c = await r.client({ type: 'hello', token: r.token });
    c.ws.on('message', (data, bin) => {
      if (bin) return;
      const m = JSON.parse(String(data));
      if (m.type === 'action' && m.name === 'pc_media') c.ws.send(JSON.stringify({ type: 'action_result', id: m.id, ok: true, result: 'Spotify is playing “Nights”.' }));
    });
    const conn = r.conns[0]!;
    expect(await conn.action('pc_media', { action: 'status' })).toEqual({ ok: true, result: 'Spotify is playing “Nights”.' });
    expect(await conn.action('pc_info', {}, 100)).toEqual({ ok: false, result: "The PC didn't answer in time." });
    const pending = conn.action('pc_info', {});
    c.ws.close();
    expect(await pending).toEqual({ ok: false, result: 'The PC disconnected.' });
    await r.server.close();
  });
});

describe('satellite bad frames', () => {
  // Vitest carries on after an uncaught throw; the bot wouldn't, so catch it here.
  const crashes: string[] = [];
  const crashed = (e: Error) => crashes.push(e.message);
  beforeEach(() => {
    crashes.length = 0;
    process.on('uncaughtException', crashed);
  });
  afterEach(() => {
    process.off('uncaughtException', crashed);
  });

  it.each(Object.entries(BAD_FRAMES))('%s before the hello closes that socket and nothing else', async (_name, frame) => {
    const r = await rig();
    const other = await r.client({ type: 'hello', token: r.token });
    const raw = await rawClient(r.port);
    raw.write(frame);
    await settle();
    expect(crashes).toEqual([]);
    expect(raw.closed()).toBe(true);

    other.ws.send(JSON.stringify({ type: 'ping' }));
    await settle();
    expect(other.got).toContainEqual({ type: 'pong' });
    const { token } = r.d.add('Laptop', OWNER);
    const good = await r.client({ type: 'hello', token });
    expect(good.got[0]).toMatchObject({ type: 'welcome', name: 'Laptop' });
    expect(r.server.connections()).toHaveLength(2);
    other.ws.close();
    good.ws.close();
    await r.server.close();
  });

  it('survives one sent after a rejected hello', async () => {
    const r = await rig();
    const raw = await rawClient(r.port);
    raw.write(textFrame(JSON.stringify({ type: 'hello', token: 'sat_nope' })));
    await settle();
    raw.write(BAD_FRAMES.unmasked);
    await settle();
    expect(crashes).toEqual([]);
    expect(raw.closed()).toBe(true);
    const good = await r.client({ type: 'hello', token: r.token });
    expect(good.got[0]).toMatchObject({ type: 'welcome' });
    good.ws.close();
    await r.server.close();
  });

  it('survives one from an address that is shut out', async () => {
    const r = await rig();
    const other = await r.client({ type: 'hello', token: r.token });
    for (let i = 0; i < 5; i++) await (await r.client({ type: 'hello', token: 'sat_wrong' })).closed;
    const raw = await rawClient(r.port);
    raw.write(BAD_FRAMES.unmasked);
    await settle();
    expect(crashes).toEqual([]);
    expect(raw.closed()).toBe(true);
    other.ws.send(JSON.stringify({ type: 'ping' }));
    await settle();
    expect(other.got).toContainEqual({ type: 'pong' });
    other.ws.close();
    await r.server.close();
  });

  it('drops a connected PC at once, closes its room, and lets it come back', async () => {
    const r = await rig();
    const raw = await rawClient(r.port);
    raw.write(textFrame(JSON.stringify({ type: 'hello', token: r.token })));
    await settle();
    let closed = 0;
    r.conns[0]!.on('closed', () => closed++);
    raw.write(BAD_FRAMES.unmasked);
    await settle();
    expect(crashes).toEqual([]);
    expect(closed).toBe(1);
    expect(raw.closed()).toBe(true);
    expect(r.server.connections()).toEqual([]);
    const good = await r.client({ type: 'hello', token: r.token });
    expect(good.got[0]).toMatchObject({ type: 'welcome' });
    good.ws.close();
    await r.server.close();
  });

  it('treats the text "null" before the hello as a failed hello', async () => {
    const r = await rig();
    const bad = await r.client(null);
    expect(crashes).toEqual([]);
    expect(bad.got).toContainEqual({ type: 'denied', reason: 'bad token' });
    expect(await bad.closed).toBe(1008);
    await r.server.close();
  });

  it('ignores the text "null" after the hello', async () => {
    const r = await rig();
    const good = await r.client({ type: 'hello', token: r.token });
    good.ws.send('null');
    good.ws.send(JSON.stringify({ type: 'ping' }));
    await settle();
    expect(crashes).toEqual([]);
    expect(good.got).toContainEqual({ type: 'pong' });
    good.ws.close();
    await r.server.close();
  });
});

describe('PC tools', () => {
  const ctx = { userId: OWNER, speaker: 'Rique' };

  it('say so when no PC is connected', async () => {
    const [apps] = pcTools({ pcFor: () => undefined });
    expect(await apps!.run({ action: 'open', name: 'spotify' }, AbortSignal.timeout(1000), ctx)).toMatch(/No PC is connected for Rique/);
  });

  it("send the action to the asker's PC, and resolve YouTube videos first", async () => {
    const sent: { name: string; args: Record<string, unknown> }[] = [];
    const pc = { action: async (name: string, args: Record<string, unknown>) => (sent.push({ name, args }), { ok: true, result: 'done' }) };
    const tools = pcTools({ pcFor: (c) => (c.userId === OWNER ? (pc as never) : undefined), findVideo: async () => 'dQw4w9WgXcQ' });
    const open = tools.find((t) => t.spec.name === 'pc_open')!;
    expect(await open.run({ youtube: 'never gonna give you up', play: true }, AbortSignal.timeout(1000), ctx)).toBe('done');
    expect(sent[0]).toEqual({ name: 'pc_open', args: { video_id: 'dQw4w9WgXcQ' } });
    expect(await open.run({ youtube: 'lofi' }, AbortSignal.timeout(1000), { userId: '999999999999999999', speaker: 'Sam' })).toMatch(/No PC/);
    expect(tools.map((t) => t.spec.name)).toEqual(['pc_apps', 'pc_open', 'pc_media', 'pc_volume', 'pc_system', 'pc_info', 'pc_clipboard', 'pc_screen']);
  });
});

describe('PC confirmations', () => {
  it('say done things directly and leave questions and failures to the model', async () => {
    const { confirmation } = await import('../src/satellite/tools.js');
    expect(confirmation('pc_apps', { action: 'open', name: 'spotify' }, 'Opening Spotify (app).')).toBe('Opening Spotify.');
    expect(confirmation('pc_open', { url: 'https://www.reddit.com/r/pcgaming' }, 'Opened the page.')).toBe('Opening reddit.com.');
    expect(confirmation('pc_volume', { action: 'set', level: 30 }, 'Volume 30%.')).toBe('Volume 30 percent.');
    expect(confirmation('pc_media', { action: 'pause' }, 'Spotify is paused on “Nights”.')).toBe('Paused.');
    expect(confirmation('pc_media', { action: 'status' }, 'Spotify is playing “Nights”.')).toBeUndefined();
    expect(confirmation('pc_info', { action: 'summary' }, 'CPU 12%.')).toBeUndefined();
    expect(confirmation('pc_apps', { action: 'open', name: 'minecraft' }, "Didn't happen: Several match")).toBeUndefined();
    expect(confirmation('pc_system', { action: 'shutdown' }, "Didn't happen: Not done: shutdown needs")).toBeUndefined();
  });

  it('name the host a browser would really go to', async () => {
    const { confirmation } = await import('../src/satellite/tools.js');
    expect(confirmation('pc_open', { url: 'https://good.example@evil.example/x' }, 'Opened the page.')).toBe('Opening evil.example.');
    expect(confirmation('pc_open', { url: 'https://good.example:pw@evil.example:8443/x' }, 'Opened the page.')).toBe('Opening evil.example.');
    expect(confirmation('pc_open', { url: 'not a url' }, 'Opened the page.')).toBe('Opening it.');
  });

  it('say when the video itself opened, and when only the results did', async () => {
    const { confirmation } = await import('../src/satellite/tools.js');
    expect(confirmation('pc_open', { youtube: 'lofi', play: true }, 'Opened the YouTube video.')).toBe('Opening it on YouTube.');
    expect(confirmation('pc_open', { youtube: 'lofi', play: true }, 'Opened YouTube results for “lofi”.')).toBe("Here's YouTube for lofi.");
    expect(confirmation('pc_open', { youtube: 'lofi' }, 'Opened YouTube results for “lofi”.')).toBe("Here's YouTube for lofi.");
  });
});

// The same lists as the tests in crates/pc-control/src/win/open.rs: a PC too old
// to have that rule gets it here, and a new one gets it twice, so they must agree.
describe('what counts as a public web address', () => {
  it.each([
    'https://example.com/a?b=c',
    'https://example.com',
    'http://example.com/a?b=c#d',
    'HTTPS://Example.COM/Path',
    'https://www.reddit.com/r/pcgaming',
    'https://modrinth.com:443/mod/jei',
    'https://example.com./x',
    'https://xn--bcher-kva.example/',
    'https://example.de/',
    'https://example.ca/',
    'https://example.cc/',
    'https://example.cafe/',
  ])('opens %s', (u) => {
    expect(webUrl(u)).toBe(true);
  });

  it.each([
    'file:///C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'https://x.com/" --evil',
    'http://localhost/',
    'http://localhost:3000/',
    'http://LOCALHOST/',
    'http://localhost./',
    'http://app.localhost/',
    'http://printer.local/',
    'http://printer.local./',
    'http://router.lan/',
    'http://nas.home/',
    'http://nas.home.arpa/',
    'http://db.internal/',
    'http://intranet/',
    'http://printer/',
    'http://printer.LOCAL/',
    'https://example.com:80x/',
    'http://127.0.0.1/',
    'http://192.168.1.1/admin',
    'http://192.168.1.1:8080/',
    'http://8.8.8.8/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0x7f000001/',
    'http://[::1]/',
    'http://[fe80::1]:8080/',
    'https://steamcommunity.com@evil.example/',
    'https://user:pw@evil.example/',
    'https://evil.example\\@good.example/',
    'https://good.example\\.evil.example/',
    'https://evil.example%2f@good.example/',
    'http://127%2e0%2e0%2e1/',
    'http://a.loc%61l/',
    'http://１２７.０.０.１/',
    'https://exa_mple.com:80x/',
    'https://exa..mple.com/',
    'https:///example.com',
    'https://',
  ])('refuses %s', (u) => {
    expect(webUrl(u)).toBe(false);
  });

  it('counts bytes, as the PC does, and stops at 300', () => {
    const atLimit = `https://example.com/${'a'.repeat(280)}`;
    expect(atLimit).toHaveLength(300);
    expect(webUrl(atLimit)).toBe(true);
    expect(webUrl(`${atLimit}a`)).toBe(false);
    expect(webUrl(`https://example.com/${'é'.repeat(141)}`)).toBe(false);
  });

  it('a look-alike letter stays a look-alike: lowercasing must not turn it into its ASCII twin', () => {
    expect(webUrl('https://example.\u212Az/')).toBe(false);
  });
});

describe('an address on its way to a PC', () => {
  function rig(found?: string) {
    const sent: Record<string, unknown>[] = [];
    const seen: string[] = [];
    const pc = { action: async (_n: string, args: Record<string, unknown>) => (sent.push(args), { ok: true, result: 'Opened the page.' }) };
    const open = pcTools({ pcFor: () => pc as never, onCall: (_n, _a, r) => seen.push(r), ...(found ? { findUrl: async () => found } : {}) }).find((t) => t.spec.name === 'pc_open')!;
    const run = (a: Record<string, unknown>) => open.run(a, AbortSignal.timeout(1000), { userId: OWNER, speaker: 'Rique' });
    return { sent, seen, open, run };
  }
  const REFUSED = "Didn't happen: Only public http and https web addresses can be opened.";

  it.each(['http://192.168.1.1/admin', 'http://localhost:3000/', 'https://user:pw@evil.example/', `https://example.com/${'a'.repeat(300)}`])('stops at the server, for a PC of any age: %s', async (url) => {
    const r = rig();
    expect(await r.run({ url })).toBe(REFUSED);
    expect(r.sent).toEqual([]);
    expect(r.seen).toEqual([REFUSED]);
    expect(r.open.speak!({ url }, REFUSED, { userId: OWNER, speaker: 'Rique' })).toBeUndefined();
  });

  it('a public one goes through, spaces and all, since the PC trims them too', async () => {
    const r = rig();
    await r.run({ url: ' https://example.com/x ' });
    expect(r.sent).toEqual([{ url: ' https://example.com/x ' }]);
  });

  it('a blank address is no address: the PC still gets what else was asked', async () => {
    const r = rig();
    await r.run({ url: ' ', folder: 'downloads' });
    expect(r.sent).toEqual([{ url: ' ', folder: 'downloads' }]);
  });

  it('a search result the rule refuses falls back to the results page', async () => {
    const r = rig('http://192.168.1.1/admin');
    await r.run({ search: 'router login' });
    expect(r.sent).toEqual([{ url: 'https://www.google.com/search?q=router%20login' }]);
  });

  it('a search too long for the results page stops there as well', async () => {
    const r = rig();
    expect(await r.run({ search: 'x'.repeat(400) })).toBe(REFUSED);
    expect(r.sent).toEqual([]);
  });
});

describe('pc_open with a search', () => {
  it('says the host that really opened, and sends it to the PC as the address', async () => {
    const sent: Record<string, unknown>[] = [];
    const pc = { action: async (_n: string, args: Record<string, unknown>) => (sent.push(args), { ok: true, result: 'Opened the page.' }) };
    const open = pcTools({ pcFor: () => pc as never, findUrl: async () => 'https://www.evil.example/x' }).find((t) => t.spec.name === 'pc_open')!;
    // The orchestrator hands run and speak the same object.
    const args: Record<string, unknown> = { search: 'steam login' };
    const raw = await open.run(args, AbortSignal.timeout(1000), { userId: OWNER, speaker: 'Rique' });
    expect(sent).toEqual([{ url: 'https://www.evil.example/x' }]);
    expect(open.speak?.(args, raw, { userId: OWNER, speaker: 'Rique' })).toBe('Opening evil.example.');
  });

  it('says the search page when no search service finds one', async () => {
    const pc = { action: async () => ({ ok: true, result: 'Opened the page.' }) };
    const open = pcTools({ pcFor: () => pc as never }).find((t) => t.spec.name === 'pc_open')!;
    const args: Record<string, unknown> = { search: 'jei mod' };
    const raw = await open.run(args, AbortSignal.timeout(1000), { userId: OWNER, speaker: 'Rique' });
    expect(open.speak?.(args, raw, { userId: OWNER, speaker: 'Rique' })).toBe('Opening google.com.');
  });
});

describe('power actions need their own yes', () => {
  function rig(result: { ok: boolean; result: string } = { ok: true, result: 'Restarting in 30 seconds.' }) {
    let now = 0;
    let turn = 0;
    const sent: { name: string; args: Record<string, unknown> }[] = [];
    const down: string[] = [];
    const pc = { action: async (name: string, args: Record<string, unknown>) => (sent.push({ name, args }), result) };
    const tools = pcTools({ pcFor: (c) => (c.userId === OWNER ? (pc as never) : undefined), now: () => now, onPowerDown: (id, on) => (on === (pc as never) ? down.push(id) : undefined) });
    const sys = tools.find((t) => t.spec.name === 'pc_system')!;
    const ctx = (said: string, o: Record<string, unknown> = {}) => ({ userId: OWNER, speaker: 'Rique', channelId: 'c1', said, turn: ++turn, ...o });
    const say = (a: Record<string, unknown>, said: string, o: Record<string, unknown> = {}) => sys.run(a, AbortSignal.timeout(1000), ctx(said, o));
    return { sys, sent, down, ctx, say, tick: (ms: number) => (now += ms) };
  }
  const restart = { name: 'pc_system', args: { action: 'restart', confirmed: true } };

  it("doesn't take the model's word for it", async () => {
    const r = rig();
    expect(await r.say({ action: 'restart', confirmed: true }, 'lol')).toBe('Restart the PC?');
    expect(r.sent).toEqual([]);
  });

  it('goes through on the next turn when they say yes', async () => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    expect(await r.say({ action: 'restart' }, 'yes')).toBe('Restarting in 30 seconds.');
    expect(r.sent).toEqual([restart]);
  });

  it.each(['yeah do it', 'go ahead', 'yes restart it', 'Yes, restart the PC.'])('takes "%s"', async (said) => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    await r.say({ action: 'restart' }, said);
    expect(r.sent).toEqual([restart]);
  });

  it.each(['no', 'lol', 'yes but wait', 'not yet', 'restart it', 'yes shut it down', 'yes I was thinking we could do it later'])('asks again after "%s"', async (said) => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    expect(await r.say({ action: 'restart' }, said)).toBe('Restart the PC?');
    expect(r.sent).toEqual([]);
  });

  it('asks again after 20 seconds', async () => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    r.tick(21_000);
    expect(await r.say({ action: 'restart' }, 'yes')).toBe('Restart the PC?');
    expect(r.sent).toEqual([]);
  });

  it('takes no yes from somewhere else', async () => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    await r.say({ action: 'restart' }, 'yes', { channelId: 'c2' });
    expect(r.sent).toEqual([]);
  });

  it("takes no yes from someone else's turn", async () => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    expect(await r.say({ action: 'restart' }, 'yes', { userId: '999999999999999999' })).toMatch(/No PC/);
    expect(r.sent).toEqual([]);
  });

  it('never confirms inside the turn that asked', async () => {
    const r = rig();
    const turn = r.ctx('yes'); // a yes meant for something else, and the same call twice
    await r.sys.run({ action: 'restart' }, AbortSignal.timeout(1000), turn);
    await r.sys.run({ action: 'restart' }, AbortSignal.timeout(1000), turn);
    expect(r.sent).toEqual([]);
  });

  it('is for the very next turn only', async () => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    r.ctx('something else'); // a turn with no tool call at all
    await r.say({ action: 'restart' }, 'yes');
    expect(r.sent).toEqual([]);
  });

  it('asks again when the yes turn wants something else', async () => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    expect(await r.say({ action: 'shutdown' }, 'yes')).toBe('Shut down the PC?');
    expect(r.sent).toEqual([]);
  });

  it.each([
    ['sleep', 'Put the PC to sleep?'],
    ['restart', 'Restart the PC?'],
    ['shutdown', 'Shut down the PC?'],
  ])('%s asks with fixed words the model cannot change', async (action, line) => {
    const r = rig();
    const raw = await r.say({ action }, 'hm');
    expect(raw).toBe(line);
    expect(r.sys.speak?.({ action }, raw, r.ctx('hm'))).toBe(line);
    expect(r.sys.asks?.(raw)).toBe(true);
    expect(r.sys.asks?.('Restarting in 30 seconds.')).toBe(false);
  });

  it('leaves the rest of pc_system alone, and never passes the flag on', async () => {
    const r = rig();
    await r.say({ action: 'lock', confirmed: true }, 'lock it');
    await r.say({ action: 'cancel_shutdown' }, 'cancel the shutdown');
    expect(r.sent.map((s) => s.args)).toEqual([{ action: 'lock' }, { action: 'cancel_shutdown' }]);
  });

  it('offers the model no flag to set', () => {
    const r = rig();
    expect(JSON.stringify(r.sys.spec)).not.toContain('confirmed');
    expect(PC_RULE).not.toContain('confirmed');
  });

  it('reports a restart or shutdown the PC took, so a spoken cancel can reach it', async () => {
    const r = rig();
    await r.say({ action: 'restart' }, 'restart the pc');
    await r.say({ action: 'restart' }, 'yes');
    expect(r.down).toEqual([OWNER]);
    await r.say({ action: 'shutdown' }, 'shut it down');
    await r.say({ action: 'shutdown' }, 'yes');
    expect(r.down).toEqual([OWNER, OWNER]);
  });

  it('reports nothing for sleep, a refusal or a question', async () => {
    const r = rig();
    await r.say({ action: 'sleep' }, 'go to sleep');
    await r.say({ action: 'sleep' }, 'yes');
    expect(r.down).toEqual([]);
    const no = rig({ ok: false, result: "Couldn't: access denied" });
    await no.say({ action: 'restart' }, 'restart the pc');
    expect(no.down).toEqual([]);
    await no.say({ action: 'restart' }, 'yes');
    expect(no.down).toEqual([]);
  });
});

describe('calling off a restart or shutdown', () => {
  const OTHER = '999999999999999999';
  function rig() {
    let now = 0;
    const sent: { name: string; args: Record<string, unknown> }[] = [];
    const replies: { ok: boolean; result: string }[] = [];
    const makePc = () => ({ action: async (name: string, args: Record<string, unknown>) => (sent.push({ name, args }), replies.shift() ?? { ok: true, result: 'Cancelled.' }) });
    return { sent, replies, makePc, pc: makePc() as never, power: new PowerDownWindow(() => now), tick: (ms: number) => (now += ms) };
  }
  const cancel = [{ name: 'pc_system', args: { action: 'cancel_shutdown' } }];
  const COULD_NOT = "I couldn't cancel it.";

  it('works once, up to the moment it happens', async () => {
    const r = rig();
    r.power.started(OWNER, r.pc);
    r.tick(29_000);
    expect(await r.power.cancel(OWNER)).toBe('Cancelled.');
    expect(await r.power.cancel(OWNER)).toBeUndefined();
    expect(r.sent).toEqual(cancel);
  });

  it('does nothing once the time is up', async () => {
    const r = rig();
    r.power.started(OWNER, r.pc);
    r.tick(31_000);
    expect(await r.power.cancel(OWNER)).toBeUndefined();
    expect(r.sent).toEqual([]);
  });

  it("does nothing for someone else's words, or with nothing counting down", async () => {
    const r = rig();
    expect(await r.power.cancel(OWNER)).toBeUndefined();
    r.power.started(OWNER, r.pc);
    expect(await r.power.cancel(OTHER)).toBeUndefined();
    expect(r.sent).toEqual([]);
    expect(await r.power.cancel(OWNER)).toBe('Cancelled.');
  });

  it('says so when the PC refuses or has gone away', async () => {
    const r = rig();
    r.replies.push({ ok: false, result: 'The PC disconnected.' });
    r.power.started(OWNER, r.pc);
    expect(await r.power.cancel(OWNER)).toBe(COULD_NOT);
  });

  it('goes to the PC that took it, and only that one', async () => {
    const r = rig();
    const sentTo: string[] = [];
    const named = (n: string) => ({ action: async () => (sentTo.push(n), { ok: true, result: 'Cancelled.' }) }) as never;
    r.power.started(OWNER, named('desk'));
    expect(await r.power.cancel(OWNER)).toBe('Cancelled.');
    expect(sentTo).toEqual(['desk']);
  });

  it('calls off every PC counting down, and "Cancelled." means all of them', async () => {
    const r = rig();
    r.power.started(OWNER, r.pc);
    r.tick(5_000);
    r.power.started(OWNER, r.makePc() as never);
    r.replies.push({ ok: true, result: 'Cancelled.' }, { ok: false, result: "The PC didn't answer in time." });
    expect(await r.power.cancel(OWNER)).toBe(COULD_NOT);
    expect(r.sent).toEqual([...cancel, ...cancel]);
  });

  it('leaves out a PC whose time has already run out', async () => {
    const r = rig();
    r.power.started(OWNER, r.pc);
    r.tick(25_000);
    r.power.started(OWNER, r.makePc() as never);
    r.tick(10_000);
    expect(await r.power.cancel(OWNER)).toBe('Cancelled.');
    expect(r.sent).toEqual(cancel);
  });

  it('one PC asked twice is one countdown: the second cancel would be refused', async () => {
    const r = rig();
    r.power.started(OWNER, r.pc);
    r.tick(5_000);
    r.power.started(OWNER, r.pc);
    r.tick(1_000);
    expect(await r.power.cancel(OWNER)).toBe('Cancelled.');
    expect(r.sent).toEqual(cancel);
  });

  it('and that countdown runs from the later order', async () => {
    const r = rig();
    r.power.started(OWNER, r.pc);
    r.tick(5_000);
    r.power.started(OWNER, r.pc);
    r.tick(29_000);
    expect(await r.power.cancel(OWNER)).toBe('Cancelled.');
  });

  it('forgets what the model called off itself', async () => {
    const r = rig();
    const other = r.makePc() as never;
    r.power.started(OWNER, r.pc);
    r.power.started(OWNER, other);
    r.power.calledOff(OWNER, r.pc);
    expect(await r.power.cancel(OWNER)).toBe('Cancelled.');
    expect(r.sent).toEqual(cancel);
  });
});

describe('the PC tool and the countdown', () => {
  function rig(result = { ok: true, result: 'Cancelled.' }) {
    const events: unknown[][] = [];
    const pc = { action: async () => result };
    const sys = pcTools({ pcFor: () => pc as never, onPowerDown: (id, p) => events.push(['down', id, p]), onPowerCancelled: (id, p) => events.push(['off', id, p]) }).find((t) => t.spec.name === 'pc_system')!;
    return { sys, events, pc };
  }
  const ctx = { userId: OWNER, speaker: 'Rique' };

  it('reports a cancel the model made, with the PC that took it', async () => {
    const r = rig();
    await r.sys.run({ action: 'cancel_shutdown' }, AbortSignal.timeout(1000), ctx);
    expect(r.events).toEqual([['off', OWNER, r.pc]]);
  });

  it('a cancel the PC refused changes nothing', async () => {
    const r = rig({ ok: false, result: 'There was no restart or shutdown to cancel.' });
    await r.sys.run({ action: 'cancel_shutdown' }, AbortSignal.timeout(1000), ctx);
    expect(r.events).toEqual([]);
  });
});
