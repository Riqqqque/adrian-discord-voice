import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SatelliteConnection } from '../src/satellite/connection.js';
import { SatelliteDevices } from '../src/satellite/devices.js';
import { startSatelliteServer } from '../src/satellite/server.js';
import { pcTools } from '../src/satellite/tools.js';

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
  return { d, token, device, server, conns, client };
}

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

  it('shuts out an address after repeated bad tokens', async () => {
    const r = await rig();
    for (let i = 0; i < 5; i++) await (await r.client({ type: 'hello', token: 'sat_wrong' })).closed;
    const good = await r.client({ type: 'hello', token: r.token });
    expect(good.got).not.toContainEqual(expect.objectContaining({ type: 'welcome' }));
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
    expect(tools.map((t) => t.spec.name)).toEqual(['pc_apps', 'pc_open', 'pc_media', 'pc_volume', 'pc_system', 'pc_info']);
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
});
