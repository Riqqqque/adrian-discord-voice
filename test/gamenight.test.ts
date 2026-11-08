import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityType, ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/core/interfaces.js';
import { GameNightSignups, gameNightTool, matchState, sameGame } from '../src/features/gamenight.js';

const GUILD = '900000000000000001';
const ASKER = '100000000000000001';
const ME = '100000000000000099';
const SEE = [PermissionFlagsBits.ViewChannel];
const POST = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

const id = (n: number) => `1000000000000001${String(n).padStart(2, '0')}`;
const member = (mid: string, displayName: string, bot = false) => ({ id: mid, displayName, user: { id: mid, username: displayName.toLowerCase(), bot } });
type Member = ReturnType<typeof member>;

function channel(cid: string, name: string, o: { type?: ChannelType; hiddenFrom?: string[]; botCant?: boolean; send?: () => Promise<unknown> } = {}) {
  const type = o.type ?? ChannelType.GuildText;
  return {
    id: cid,
    name,
    type,
    members: new Collection(),
    send: vi.fn(o.send ?? (async () => ({}))),
    isTextBased: () => true,
    isVoiceBased: () => type === ChannelType.GuildVoice,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => new PermissionsBitField(o.hiddenFrom?.includes(m.id) ? [] : m.id === ME && o.botCant ? SEE : POST),
  };
}

interface Voice {
  who: string;
  in: ReturnType<typeof channel>;
  muted?: boolean;
  deaf?: boolean;
}
interface Pres {
  who: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  game?: { name: string; details?: string; state?: string };
}

function rig(o: { presences?: boolean; voice?: (c: Record<string, ReturnType<typeof channel>>) => Voice[]; pres?: Pres[]; optIn?: string[]; people?: Member[]; channelId?: string; file?: string; maxMentions?: number; perUserPerHour?: number; lastText?: string } = {}) {
  let now = 1_000_000;
  let turns = 0;
  const asker = member(ASKER, 'Dana');
  const me = member(ME, 'Helper', true);
  const people = o.people ?? [member(id(1), 'Alex'), member(id(2), 'Sam'), member(id(3), 'Kim'), member(id(4), 'Lee'), member(id(5), 'Beep', true)];
  const all = [asker, me, ...people];
  const chans = {
    general: channel('800000000000000001', 'general'),
    games: channel('800000000000000002', 'games'),
    secret: channel('800000000000000003', 'secret', { hiddenFrom: [ASKER] }),
    lounge: channel('800000000000000004', 'Lounge', { type: ChannelType.GuildVoice }),
    staff: channel('800000000000000005', 'Staff', { type: ChannelType.GuildVoice, hiddenFrom: [ASKER] }),
    afk: channel('800000000000000006', 'AFK', { type: ChannelType.GuildVoice }),
    readonly: channel('800000000000000007', 'readonly', { botCant: true }),
  };
  const members = new Collection(all.map((m) => [m.id, m]));
  const voiceStates = new Collection(
    (o.voice?.(chans) ?? []).map((v) => [v.who, { id: v.who, channelId: v.in.id, channel: v.in, selfMute: !!v.muted, serverMute: false, selfDeaf: !!v.deaf, serverDeaf: false, member: members.get(v.who) }]),
  );
  const presences = new Collection(
    (o.pres ?? []).map((p) => [p.who, { userId: p.who, status: p.status, member: members.get(p.who), activities: p.game ? [{ type: ActivityType.Playing, name: p.game.name, details: p.game.details ?? null, state: p.game.state ?? null }] : [] }]),
  );
  const guild = {
    id: GUILD,
    name: 'Test Server',
    afkChannelId: chans.afk.id,
    systemChannelId: chans.general.id,
    channels: { cache: new Collection(Object.values(chans).map((c) => [c.id, c])) },
    members: { cache: members, me, fetch: async (x: string) => members.get(x) },
    voiceStates: { cache: voiceStates },
    presences: { cache: presences },
  };
  const signups = new GameNightSignups(o.file, o.optIn ?? []);
  const tool = gameNightTool({
    guild: (g) => (g === GUILD ? (guild as never) : undefined),
    allowedGuilds: [],
    homeGuild: GUILD,
    presences: o.presences ?? false,
    signups,
    ...(o.channelId ? { channelId: o.channelId } : {}),
    lastText: () => o.lastText,
    voiceChannel: () => chans.lounge.id,
    cooldownMs: 15 * 60_000,
    maxMentions: o.maxMentions ?? 10,
    perUserPerHour: o.perUserPerHour ?? 4,
    now: () => now,
  });
  const ctx = (said: string, extra: Partial<ToolContext> = {}): ToolContext => ({ userId: ASKER, speaker: 'Dana', guildId: GUILD, channelId: chans.general.id, said, turn: ++turns, ...extra });
  const signal = new AbortController().signal;
  return {
    chans,
    signups,
    tick: (ms: number) => (now += ms),
    run: (a: Record<string, unknown>, said = 'hey', extra: Partial<ToolContext> = {}) => tool.run(a, signal, ctx(said, extra)),
    tool,
    sent: () => Object.values(chans).flatMap((c) => c.send.mock.calls.map((x) => ({ channel: c.name, msg: (x as unknown[])[0] as { content: string; allowedMentions: { users: string[]; parse: string[] } } }))),
  };
}

describe('matchState and sameGame', () => {
  it('reads a rich presence as a match, the menus, or just playing', () => {
    expect(matchState({ type: 0, name: 'VALORANT', details: 'Competitive', state: 'In a Party' })).toBe('match');
    expect(matchState({ type: 0, name: 'VALORANT', details: 'Competitive', state: 'In Queue' })).toBe('menus');
    expect(matchState({ type: 0, name: 'Apex', state: 'In Lobby' })).toBe('menus');
    expect(matchState({ type: 0, name: 'CS2', details: 'Dust II', state: '7 - 5' })).toBe('match');
    expect(matchState({ type: 0, name: 'Minecraft' })).toBe('playing');
  });

  it('matches game names loosely but not by any shared word', () => {
    expect(sameGame('valorant', 'VALORANT')).toBe(true);
    expect(sameGame('league', 'League of Legends')).toBe(true);
    expect(sameGame('rocket league', 'Rocket League')).toBe(true);
    expect(sameGame('Counter Strike', 'counterstrike')).toBe(true);
    expect(sameGame('legends', 'League of Legends')).toBe(false);
    expect(sameGame('', 'Minecraft')).toBe(false);
  });
});

describe('who is around, without the Presence intent', () => {
  const voice = (c: Record<string, ReturnType<typeof channel>>): Voice[] => [
    { who: id(1), in: c.lounge! },
    { who: id(2), in: c.lounge!, muted: true },
    { who: id(3), in: c.afk! },
    { who: id(4), in: c.staff! },
    { who: id(5), in: c.lounge! },
  ];

  it('answers from voice states and says once that games are invisible', async () => {
    const r = rig({ voice });
    const first = await r.run({ action: 'who_playing' });
    expect(first).toContain('In voice: Alex (in voice Lounge); Sam (in voice Lounge, muted)');
    expect(first).toContain("Presence intent");
    // The AFK channel isn't "in voice", a channel hidden from the asker isn't shown, and bots never are.
    expect(first).not.toMatch(/Kim|Lee|Beep/);
    const second = await r.run({ action: 'who_playing' });
    expect(second).not.toContain('Tell them once');
    expect(second).toContain('leave it out');
  });

  it('who_free lists voice, the AFK ones apart, and who signed up', async () => {
    const r = rig({ voice, optIn: [id(1)] });
    const out = await r.run({ action: 'who_free', game: 'Valorant' });
    expect(out).toContain('In voice and around: Alex (in voice Lounge, signed up for game-night pings); Sam (in voice Lounge, muted)');
    expect(out).toContain('AFK or deafened: Kim (AFK in AFK)');
    expect(out).toContain('Signed up for Valorant pings: Alex.');
    expect(out).toContain('Presence intent');
  });

  it('says nobody is in voice when nobody is', async () => {
    const r = rig();
    expect(await r.run({ action: 'who_playing' })).toMatch(/^Nobody is in voice\./);
  });
});

describe('who is around, with the Presence intent', () => {
  const pres: Pres[] = [
    { who: id(1), status: 'online', game: { name: 'VALORANT', details: 'Competitive', state: 'In a Match' } },
    { who: id(2), status: 'online', game: { name: 'VALORANT', state: 'In Lobby' } },
    { who: id(3), status: 'dnd' },
    { who: id(4), status: 'idle', game: { name: 'Minecraft' } },
    { who: id(5), status: 'online', game: { name: 'VALORANT' } },
  ];

  it('who_playing lists games and guesses the match state', async () => {
    const r = rig({ presences: true, pres });
    const out = await r.run({ action: 'who_playing', game: 'valorant' });
    expect(out).toContain('Alex (online, playing VALORANT (in a match, going by their status))');
    expect(out).toContain('Sam (online, playing VALORANT (in the menus or a queue, going by their status))');
    expect(out).not.toContain('Lee'); // Minecraft, filtered out
    expect(out).not.toContain('Beep'); // a bot
    expect(out).not.toContain('Presence intent');
    expect(await r.run({ action: 'who_playing', game: 'fortnite' })).toContain('Nobody is showing fortnite');
  });

  it('who_free splits free, busy and do not disturb', async () => {
    const r = rig({ presences: true, pres, voice: (c) => [{ who: id(4), in: c.lounge!, deaf: true }] });
    const out = await r.run({ action: 'who_free', game: 'Valorant' });
    expect(out).toContain('Free now: Sam (online, playing VALORANT (in the menus');
    expect(out).toContain('Busy: Alex (online, playing VALORANT (in a match');
    expect(out).toContain('Do not disturb: Kim.');
    // Idle and deafened: around, maybe away. Playing Minecraft isn't busy for Valorant? It is: another game.
    expect(out).toMatch(/Busy: .*Lee \(idle, playing Minecraft, in voice Lounge, deafened\)/);
    expect(out).toContain('a guess');
  });
});

describe('game-night pings', () => {
  const five = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => member(id(n), `P${n}`));

  it('pings only people who signed up, never the asker or a bot, with nothing parsed', async () => {
    const r = rig({ optIn: [id(1), id(2), id(5), ASKER] });
    const out = await r.run({ action: 'ping', game: 'Valorant', in_minutes: 10 }, 'ping everyone for valorant in 10');
    expect(out).toBe('Pinged 2 people in #general for Valorant.');
    const [s] = r.sent();
    expect(s!.channel).toBe('general');
    expect(s!.msg.content).toBe(`**Dana** is getting Valorant going in 10 minutes. Who's in? <@${id(1)}> <@${id(2)}>`);
    expect(s!.msg.allowedMentions).toEqual({ users: [id(1), id(2)], parse: [] });
    expect(r.tool.speak!({ action: 'ping' }, out, {} as never)).toBe('Pinged them.');
  });

  it('a game name can never ping or link', async () => {
    const r = rig({ optIn: [id(1)] });
    await r.run({ action: 'ping', game: '@everyone <@&123456789012345678> https://evil.example/x' }, 'ping the squad');
    const [s] = r.sent();
    expect(s!.msg.content).not.toMatch(/@everyone|<@&|https?:/);
    expect(s!.msg.allowedMentions.parse).toEqual([]);
  });

  it('reads it back when their own words did not ask for pings, and sends on their yes', async () => {
    const r = rig({ optIn: [id(1)] });
    const q = await r.run({ action: 'ping', game: 'Valorant' }, 'is anyone up for valorant');
    expect(q).toBe('Ping the people signed up for Valorant?');
    expect(r.tool.asks!(q)).toBe(true);
    expect(r.sent()).toHaveLength(0);
    expect(await r.run({ action: 'ping', game: 'Valorant' }, 'yes')).toMatch(/^Pinged 1 person/);
    expect(r.sent()).toHaveLength(1);
  });

  it('a no does nothing', async () => {
    const r = rig({ optIn: [id(1)] });
    await r.run({ action: 'ping', game: 'Valorant' }, 'is anyone up for valorant');
    expect(await r.run({ action: 'ping', game: 'Valorant' }, 'no')).toBe('Ping the people signed up for Valorant?');
    expect(r.sent()).toHaveLength(0);
  });

  it('asks which game when none was given', async () => {
    const r = rig({ optIn: [id(1)] });
    expect(await r.run({ action: 'ping' }, 'get the squad on')).toBe('Which game? Ask them.');
  });

  it('leaves out people already in voice, on do not disturb, or who cannot see the channel', async () => {
    const r = rig({
      presences: true,
      optIn: [id(1), id(2), id(3), id(4)],
      pres: [{ who: id(2), status: 'dnd' }],
      voice: (c) => [{ who: id(1), in: c.lounge! }, { who: id(4), in: c.afk! }],
    });
    // Kim can't see #games.
    r.chans.games.permissionsFor = (m: { id: string }) => new PermissionsBitField(m.id === id(3) ? [] : POST);
    const out = await r.run({ action: 'ping', game: 'Valorant' }, 'ping everyone', { channelId: r.chans.games.id });
    expect(out).toBe("Pinged 1 person in #games for Valorant (left out 1 already in voice; 1 on do not disturb; 1 who can't see #games).");
    expect(r.sent()[0]!.msg.allowedMentions.users).toEqual([id(4)]); // AFK isn't in the call
  });

  it('pings at most ten, online people first', async () => {
    const r = rig({ presences: true, people: five, optIn: five.map((m) => m.id), pres: [{ who: id(13), status: 'online' }] });
    const out = await r.run({ action: 'ping', game: 'Valorant' }, 'ping everyone');
    expect(out).toContain("2 more signed up weren't pinged: 10 is the most at once");
    const users = r.sent()[0]!.msg.allowedMentions.users;
    expect(users).toHaveLength(10);
    expect(users[0]).toBe(id(13));
  });

  it('one ping per game per cooldown; another game can go', async () => {
    const r = rig({ optIn: [id(1)] });
    await r.run({ action: 'ping', game: 'Valorant' }, 'ping everyone');
    r.tick(5 * 60_000);
    expect(await r.run({ action: 'ping', game: 'VALORANT' }, 'ping everyone')).toMatch(/^Not sent: VALORANT pings already went out 5 minutes ago\. The next one can go in 10 minutes\./);
    expect(await r.run({ action: 'ping', game: 'Minecraft' }, 'ping everyone')).toMatch(/^Pinged/);
    r.tick(10 * 60_000);
    expect(await r.run({ action: 'ping', game: 'Valorant' }, 'ping everyone')).toMatch(/^Pinged/);
    expect(r.sent()).toHaveLength(3);
  });

  it('one person can only send so many an hour', async () => {
    const r = rig({ optIn: [id(1)], perUserPerHour: 2 });
    await r.run({ action: 'ping', game: 'A' }, 'ping everyone');
    await r.run({ action: 'ping', game: 'B' }, 'ping everyone');
    expect(await r.run({ action: 'ping', game: 'C' }, 'ping everyone')).toBe("Not sent: that's 2 game-night pings from you in the last hour.");
  });

  it('says so when nobody signed up, or everyone signed up is already on', async () => {
    expect(await rig().run({ action: 'ping', game: 'Valorant' }, 'ping everyone')).toContain('Nobody has signed up for Valorant pings');
    const r = rig({ optIn: [id(1)], voice: (c) => [{ who: id(1), in: c.lounge! }] });
    expect(await r.run({ action: 'ping', game: 'Valorant' }, 'ping everyone')).toBe('Nobody to ping: 1 already in voice.');
  });

  it('a failed post costs nothing: no cooldown, no hourly count', async () => {
    const r = rig({ optIn: [id(1)], perUserPerHour: 1 });
    r.chans.general.send.mockRejectedValueOnce(new Error('nope'));
    expect(await r.run({ action: 'ping', game: 'Valorant' }, 'ping everyone')).toBe("Not sent: I couldn't post in #general.");
    expect(await r.run({ action: 'ping', game: 'Valorant' }, 'ping everyone')).toMatch(/^Pinged/);
  });

  it('picks the channel: configured, else this chat, else her last one, else the voice chat or system channel', async () => {
    const configured = rig({ optIn: [id(1)], channelId: '800000000000000002' });
    await configured.run({ action: 'ping', game: 'X' }, 'ping everyone');
    expect(configured.sent()[0]!.channel).toBe('games');
    // From a PC: no chat of its own, so her last channel.
    const pc = rig({ optIn: [id(1)], lastText: '800000000000000002' });
    await pc.run({ action: 'ping', game: 'X' }, 'ping everyone', { guildId: undefined, channelId: 'sat:desk' });
    expect(pc.sent()[0]!.channel).toBe('games');
    // A configured channel she can't post in is an error, not a fallback.
    const bad = rig({ optIn: [id(1)], channelId: '800000000000000007' });
    expect(await bad.run({ action: 'ping', game: 'X' }, 'ping everyone')).toBe("Not sent: I can't post in the channel set for this, or you can't see it.");
    // A chat the asker can't see is skipped.
    const hidden = rig({ optIn: [id(1)] });
    await hidden.run({ action: 'ping', game: 'X' }, 'ping everyone', { channelId: '800000000000000003' });
    expect(hidden.sent()[0]!.channel).toBe('Lounge');
  });
});

describe('signing up', () => {
  it('join and leave only ever change the asker', async () => {
    const r = rig();
    expect(await r.run({ action: 'join' })).toBe('Signed them up for game-night pings, every game.');
    expect(r.signups.wants(ASKER, 'Valorant')).toBe(true);
    expect(r.signups.wants(id(1))).toBe(false);
    expect(await r.run({ action: 'leave', game: 'Minecraft' })).toBe('No more Minecraft pings for them; other games still ping them.');
    expect(r.signups.wants(ASKER, 'minecraft')).toBe(false);
    expect(r.signups.wants(ASKER, 'Valorant')).toBe(true);
    expect(await r.run({ action: 'join', game: 'Minecraft' })).toBe('Signed them up for Minecraft pings.');
    expect(r.signups.wants(ASKER, 'minecraft')).toBe(true);
    expect(await r.run({ action: 'leave' })).toBe('No more game-night pings for them.');
    expect(r.signups.wants(ASKER, 'Valorant')).toBe(false);
  });

  it('one game at a time, and leaving the last one ends it', () => {
    const s = new GameNightSignups(undefined);
    s.join(ASKER, 'Valorant');
    s.join(ASKER, 'Minecraft');
    expect(s.wants(ASKER, 'valorant')).toBe(true);
    expect(s.wants(ASKER, 'Fortnite')).toBe(false);
    s.leave(ASKER, 'valorant');
    expect(s.wants(ASKER, 'Valorant')).toBe(false);
    expect(s.leave(ASKER, 'minecraft')).toBe('No more game-night pings for them.');
    expect(s.wants(ASKER)).toBe(false);
  });

  it('someone on the config list can still say stop, and it sticks over restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gn-')), 'game-night.json');
    const s = new GameNightSignups(file, [ASKER]);
    expect(s.wants(ASKER, 'Valorant')).toBe(true);
    expect(s.join(ASKER, 'Valorant')).toBe('They were already signed up for every game, Valorant included.');
    s.leave(ASKER);
    expect(new GameNightSignups(file, [ASKER]).wants(ASKER, 'Valorant')).toBe(false);
    new GameNightSignups(file, [ASKER]).join(ASKER);
    expect(new GameNightSignups(file, [ASKER]).wants(ASKER, 'Valorant')).toBe(true);
  });

  it('signed_up lists names, no pings', async () => {
    const r = rig({ optIn: [id(1), id(2)] });
    const out = await r.run({ action: 'signed_up' });
    expect(out).toBe('Signed up for game-night pings: Alex, Sam.');
    expect(out).not.toContain('<@');
  });

  it('a PC with no server of its own uses the home server; someone not in it gets nothing', async () => {
    const r = rig({ voice: (c) => [{ who: id(1), in: c.lounge! }] });
    expect(await r.run({ action: 'who_playing' }, 'who is on', { guildId: undefined, channelId: 'sat:desk' })).toContain('Alex');
    await expect(r.run({ action: 'who_playing' }, 'who is on', { userId: '100000000000000777' })).rejects.toThrow("you're not in that server");
  });
});
