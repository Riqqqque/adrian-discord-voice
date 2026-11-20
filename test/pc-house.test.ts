import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/core/interfaces.js';
import { houseOrder, pcTools } from '../src/satellite/tools.js';

function kit(connected = true) {
  const sent: { name: string; args: Record<string, unknown> }[] = [];
  const pc = { version: '0.17.1', action: async (name: string, args: Record<string, unknown>) => (sent.push({ name, args }), { ok: true, result: 'Done.' }) };
  const tools = pcTools({ pcFor: () => (connected ? (pc as never) : undefined) });
  const run = (name: string, args: Record<string, unknown>, said: string) => {
    const ctx: ToolContext = { userId: 'u1', speaker: 'Alex', said, turn: 1, channelId: 'sat:x' };
    return tools.find((t) => t.spec.name === name)!.run(args, AbortSignal.timeout(1000), ctx) as Promise<string>;
  };
  return { sent, run };
}

describe('house orders are not the PC', () => {
  it('finds the house thing an order is about', () => {
    expect(houseOrder('lock the front door')?.thing).toBe('door');
    expect(houseOrder('can you lock the doors')?.thing).toBe('doors');
    expect(houseOrder('make sure the house is locked up')?.thing).toBe('house');
    expect(houseOrder('kill the lights')?.thing).toBe('lights');
    expect(houseOrder('lights off please')?.thing).toBe('lights');
    expect(houseOrder('shut the garage')?.thing).toBe('garage');
    expect(houseOrder('turn the TV down')?.thing).toBe('tv');
    expect(houseOrder('turn the heat down')?.thing).toBe('heat');
    expect(houseOrder('set the thermostat to seventy')?.thing).toBe('thermostat');
    expect(houseOrder('turn off the fan')?.thing).toBe('fan');
    expect(houseOrder('turn down my music and turn off the lights')).toMatchObject({ thing: 'lights', media: true });
  });

  it('leaves PC orders and passing mentions alone', () => {
    for (const s of [
      'open doordash',
      'open garageband',
      'play the doors on youtube',
      'mute the tv show',
      'pause the tv series',
      'open the apple tv app',
      'pause the music, my mom is at the front door',
      'someone is at the door',
      'turn off my monitors',
      'put this window in the top right corner',
      'close this window',
      undefined,
      '',
    ])
      expect(houseOrder(s), String(s)).toBeUndefined();
    expect(houseOrder("lock my pc, I'm heading out the front door")).toBeUndefined();
    expect(houseOrder('turn off my pc and turn off the lights')).toMatchObject({ thing: 'lights', pc: true });
  });

  it('leaves every PC order of the pc-orders bench alone', () => {
    const orders = [
      'open spotify', 'close discord', 'turn it down a little', 'turn down my music', 'can you turn the music up a bit', 'mute the video',
      'turn the whole pc volume down', 'set the volume to 30', 'mute discord', 'skip this song', 'pause it', "what's playing right now",
      'how much ram am i using', "what's eating up my memory", 'open my downloads folder', 'go to reddit', 'open the JEI Mod Drinth page',
      'pull up the wiki page for the ender dragon', 'put on some lofi on youtube', 'lock my pc', 'snap discord to the left',
      'put spotify on my other monitor', 'move chrome to my main screen', 'maximize notepad', 'put this window in the top right corner',
      'snap discord to the right side of my main monitor', "what's on each of my monitors", 'snap discord to the right', 'actually put it back',
      'switch to chrome', 'shut down my computer', 'restart my pc', 'put my computer to sleep', 'yes', 'yes restart it', 'yeah go ahead', 'no wait',
      'open valorant and turn my music down', 'why is my pc so slow right now', 'how hot is my gpu', 'translate what i copied',
      "what's this error on my screen", 'send that link to my pc', 'open that on my pc', 'put that video on my pc', 'play this on my pc instead',
      'move the music to my pc', "put what i'm watching into the call",
    ];
    for (const s of orders) {
      const h = houseOrder(s);
      expect(!h || h.pc, s).toBe(true);
    }
  });

  it('refuses before anything reaches the PC, connected or not', async () => {
    for (const connected of [true, false]) {
      const { sent, run } = kit(connected);
      expect(await run('pc_system', { action: 'lock' }, 'lock the front door')).toMatch(/^Didn't happen: .*door.*not their PC/);
      expect(await run('pc_system', { action: 'screen_off' }, 'kill the lights')).toMatch(/lights/);
      expect(await run('pc_system', { action: 'screen_off' }, 'turn off the TV')).toMatch(/tv/);
      expect(await run('pc_volume', { action: 'down', playing: true }, 'turn the tv down')).toMatch(/^Didn't happen/);
      expect(await run('pc_volume', { action: 'down', playing: true }, 'turn the heat down')).toMatch(/heat/);
      expect(await run('pc_media', { action: 'pause' }, 'pause the tv')).toMatch(/^Didn't happen/);
      expect(await run('pc_apps', { action: 'open', name: 'garage' }, 'open the garage')).toMatch(/garage/);
      expect(await run('pc_apps', { action: 'close', name: 'the front door' }, 'close it')).toMatch(/front door/);
      expect(sent).toEqual([]);
    }
  });

  it('ties the order to the thing it is about, so a PC verb next to a house word stays a PC order', () => {
    for (const s of [
      "pause someone's at the door",
      'mute my mom is at the front door',
      'pause the doorbell just rang',
      'stop the pizza guy is at the gate',
      'pause my mom is at the front door',
      'open the tv app',
    ])
      expect(houseOrder(s), s).toBeUndefined();
    expect(houseOrder('mute the tv')?.thing).toBe('tv');
    expect(houseOrder('mute the doorbell')?.thing).toBe('doorbell');
    expect(houseOrder('pause the tv')?.thing).toBe('tv');
    expect(houseOrder('turn off the living room lights')?.thing).toBe('lights');
    expect(houseOrder('pause, gotta open the door')).toMatchObject({ thing: 'door', rest: ['pause'] });
  });

  it('does a PC order said next to a house errand', async () => {
    const { sent, run } = kit();
    const orders: [string, Record<string, unknown>, string][] = [
      ['pc_media', { action: 'pause' }, 'pause, gotta open the door'],
      ['pc_media', { action: 'pause' }, 'pause, I need to turn off the stove'],
      ['pc_volume', { action: 'mute' }, 'mute, let me open the garage'],
      ['pc_media', { action: 'next' }, 'skip and turn the lights on'],
      ['pc_media', { action: 'pause' }, "pause someone's at the door"],
      ['pc_volume', { action: 'mute' }, 'mute my mom is at the front door'],
      ['pc_media', { action: 'pause' }, 'pause the doorbell just rang'],
      ['pc_media', { action: 'stop' }, 'stop the pizza guy is at the gate'],
      ['pc_system', { action: 'cancel_shutdown' }, 'cancel the shutdown and turn the lights back on'],
      ['pc_system', { action: 'cancel_shutdown' }, 'wait, turn the lights back on'],
      ['pc_system', { action: 'lock' }, 'lock it and turn off the lights'],
      ['pc_apps', { action: 'open', name: 'TV' }, 'open the tv app'],
    ];
    for (const [name, args, said] of orders) expect(await run(name, args, said), said).not.toMatch(/^Didn't happen/);
    expect(sent.map((s) => s.name)).toEqual(orders.map(([n]) => n));
  });

  it('still refuses the house half when nothing else asked the PC', async () => {
    const { sent, run } = kit();
    expect(await run('pc_system', { action: 'lock' }, 'lock up and turn off the lights')).toMatch(/^Didn't happen/);
    expect(await run('pc_system', { action: 'lock' }, 'lock up for the night')).toMatch(/^Didn't happen/);
    expect(await run('pc_media', { action: 'pause' }, 'open the door')).toMatch(/^Didn't happen/);
    expect(await run('pc_system', { action: 'lock' }, 'lock the screen door')).toMatch(/door/);
    expect(await run('pc_system', { action: 'screen_off' }, 'turn off the tvs')).toMatch(/tvs/);
    expect(await run('pc_system', { action: 'screen_off' }, 'apaga las luces')).toMatch(/luces/);
    expect(await run('pc_system', { action: 'lock' }, 'cierra la puerta del garaje')).toMatch(/puerta/);
    expect(sent).toEqual([]);
  });

  it("asks nothing about a power-down for the garage, so a yes can't do one", async () => {
    const { sent, run } = kit();
    expect(await run('pc_system', { action: 'shutdown' }, 'shut the garage')).toMatch(/^Didn't happen/);
    expect(await run('pc_system', { action: 'shutdown' }, 'yes')).toBe('Shut down the PC?');
    expect(sent).toEqual([]);
  });

  it('still does PC orders that mention the house', async () => {
    const { sent, run } = kit();
    await run('pc_system', { action: 'lock' }, "lock my pc, I'm heading out the front door");
    await run('pc_volume', { action: 'mute', playing: true }, 'mute the tv show');
    await run('pc_volume', { action: 'down', playing: true }, 'turn down my music and turn off the lights');
    await run('pc_media', { action: 'pause' }, 'pause the music, my mom is at the front door');
    await run('pc_apps', { action: 'open', name: 'doordash' }, 'open doordash');
    await run('pc_info', { action: 'summary' }, 'is my pc slower with the heat on');
    expect(sent.map((s) => s.name)).toEqual(['pc_system', 'pc_volume', 'pc_volume', 'pc_media', 'pc_apps', 'pc_info']);
  });
});
