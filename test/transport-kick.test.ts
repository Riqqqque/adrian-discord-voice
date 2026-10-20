import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DiscordVoiceTransport } from '../src/transport/discord.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function rig() {
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' }, guilds: { cache: new Map() } });
  const t = new DiscordVoiceTransport({ client: client as never, logger: quiet as never, silenceMs: 800 });
  // Pretend it's connected to G/C (no real Discord connection).
  Object.assign(t as unknown as Record<string, unknown>, { target: { guildId: 'G', channelId: 'C' }, closing: false });
  const events: string[] = [];
  t.on('kicked', () => events.push('kicked'));
  t.on('moved', (_g, c) => events.push(`moved:${c}`));
  const state = (channelId: string | null, id = 'bot') => ({ id, channelId }) as never;
  const change = (oldS: unknown, newS: unknown) => (t as unknown as { voiceStateChanged(a: unknown, b: unknown): void }).voiceStateChanged(oldS, newS);
  return { t, events, state, change };
}

describe('voice disconnects', () => {
  it('someone disconnecting the bot: it stays out and says so (no fighting back in)', async () => {
    const r = rig();
    r.change(r.state('C'), r.state(null));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.events).toEqual(['kicked']);
    expect((r.t as unknown as { closing: boolean }).closing).toBe(true); // no automatic rejoin
  });

  it('being dragged to another channel follows it', () => {
    const r = rig();
    r.change(r.state('C'), r.state('C2'));
    expect(r.events).toEqual(['moved:C2']);
  });

  it('its own leave is not a kick', async () => {
    const r = rig();
    await r.t.disconnect(); // /leave or a move
    r.change(r.state('C'), r.state(null));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.events).toEqual([]);
  });

  it('other people leaving is not a kick', async () => {
    const r = rig();
    r.change(r.state('C', 'someone'), r.state(null, 'someone'));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.events).toEqual([]);
  });
});
