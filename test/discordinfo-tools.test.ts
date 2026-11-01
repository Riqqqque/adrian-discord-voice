import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { discordTools, RelayLimiter } from '../src/features/discordinfo.js';

const ASKER = '100000000000000001';
const SAM = '100000000000000002';
const KIM = '100000000000000003';
const ALEX_ONE = '100000000000000004';
const ALEX_TWO = '100000000000000005';
const BEEP = '100000000000000006';
const ME = '100000000000000007';
const OUTSIDER = '100000000000000008';
const GUILD = '900000000000000001';
const GENERAL = '800000000000000001';

const SEE = [PermissionFlagsBits.ViewChannel];
const POST = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

const person = (id: string, displayName: string, username: string, bot = false) => ({
  id,
  displayName,
  nickname: null,
  user: { id, username, bot },
  voice: { channel: null as unknown, selfMute: false, serverMute: false, streaming: false },
  send: vi.fn(async () => ({})),
});
type Person = ReturnType<typeof person>;

interface ChannelOpts {
  id?: string;
  name: string;
  type?: ChannelType;
  position?: number;
  topic?: string;
  parent?: { name: string };
  /** What permissionsFor answers for the asker and for the bot. */
  asker?: bigint[];
  bot?: bigint[];
  people?: Person[];
}

function channel(o: ChannelOpts) {
  const type = o.type ?? ChannelType.GuildText;
  return {
    id: o.id ?? `80000000000000${String(o.position ?? 0).padStart(4, '0')}`,
    name: o.name,
    type,
    position: o.position ?? 0,
    topic: o.topic ?? null,
    parent: o.parent ?? null,
    members: new Collection((o.people ?? []).map((m) => [m.id, m])),
    send: vi.fn(async () => ({})),
    isTextBased: () => type !== ChannelType.GuildCategory && type !== ChannelType.GuildForum,
    isVoiceBased: () => type === ChannelType.GuildVoice,
    isThread: () => false,
    permissionsFor: (m: { id: string }) => new PermissionsBitField(m.id === ASKER ? (o.asker ?? POST) : m.id === ME ? (o.bot ?? POST) : POST),
  };
}

/** A server with one of everything. Built fresh: the limiter and the member fetch keep state. */
function rig(o: { limiter?: RelayLimiter; owner?: boolean; maxChars?: number; members?: boolean; searchFinds?: Person[] } = {}) {
  const dana = person(ASKER, 'Dana', 'danad');
  const sam = person(SAM, 'Sam', 'samthegreat');
  const kim = person(KIM, 'Kim', 'kimk');
  const alexOne = person(ALEX_ONE, 'Alex', 'alexone');
  const alexTwo = person(ALEX_TWO, 'Alex', 'alextwo');
  const beep = person(BEEP, 'Beep', 'beepbot', true);
  const me = person(ME, 'Helper', 'helperbot', true);
  sam.voice.selfMute = true;
  kim.voice.streaming = true;

  const lobby = channel({ name: 'Lobby', type: ChannelType.GuildCategory, position: 90 });
  const general = channel({ id: GENERAL, name: 'general', position: 1, topic: 'Anything goes', parent: { name: 'Lobby' } });
  const sideChat = channel({ name: 'side-chat', position: 2 });
  const announcements = channel({ name: 'announcements', position: 3, asker: SEE });
  const noBots = channel({ name: 'no-bots', position: 4, bot: SEE });
  const ideas = channel({ name: 'ideas', type: ChannelType.GuildForum, position: 5 });
  const lounge = channel({ name: 'Lounge', type: ChannelType.GuildVoice, position: 6, people: [sam, kim] });
  const vault = channel({ name: 'vault', position: 7, asker: [], topic: 'Passwords and plans' });
  const staffRoom = channel({ name: 'Staff Room', type: ChannelType.GuildVoice, position: 8, asker: [], people: [alexOne] });
  sam.voice.channel = lounge;
  kim.voice.channel = lounge;
  alexOne.voice.channel = staffRoom;

  const everyone = [dana, sam, kim, alexOne, alexTwo, beep, me];
  const members = new Collection(everyone.map((m) => [m.id, m]));
  const channels = new Collection([lobby, general, sideChat, announcements, noBots, ideas, lounge, vault, staffRoom].map((c) => [c.id, c]));
  const search = vi.fn(async () => new Collection((o.searchFinds ?? []).map((m) => [m.id, m])));
  const guild = {
    id: GUILD,
    name: 'Test Server',
    channels: { cache: channels },
    members: {
      cache: members,
      me: me as Person | null,
      search,
      fetch: async (x: unknown) => (typeof x === 'string' ? members.get(x) : members),
    },
  };
  const client = { guilds: { cache: new Collection([[GUILD, guild]]) } };

  const limiter = o.limiter ?? new RelayLimiter(10, 5);
  const take = vi.spyOn(limiter, 'take');
  const [info, message] = discordTools(
    { client: client as never, allowedGuilds: [], members: o.members ?? true, presences: false, timezone: 'UTC' },
    { limiter, isOwner: () => o.owner ?? false, maxChars: o.maxChars ?? 600 },
  );
  const ctx = { userId: ASKER, speaker: 'Dana', guildId: GUILD, channelId: GENERAL };
  const signal = new AbortController().signal;
  const spies = [...everyone, ...channels.values()].map((x) => x.send);
  return {
    sam,
    general,
    sideChat,
    lounge,
    guild,
    take,
    search,
    tell: (a: Record<string, unknown>) => message!.run(a, signal, ctx),
    ask: (a: Record<string, unknown>) => info!.run(a, signal, ctx),
    sends: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
  };
}

const dm = (text: string) => ({ content: `**Dana** (in Test Server) asked me to tell you: ${text}`, allowedMentions: { parse: [] } });
const post = (target: string, text: string) => ({ content: `<@${target}> from **Dana**: ${text}`, allowedMentions: { users: [target], parse: [] } });

/** The limiter already holds one send from this sender or to this target. */
function spent(sender = OUTSIDER, target = KIM, perSender = 1, perTarget = 1): RelayLimiter {
  const l = new RelayLimiter(perSender, perTarget);
  l.take(sender, target);
  return l;
}

const refusals: [string, Record<string, unknown>, string][] = [
  ['a channel hidden from the asker', { member: 'Sam', message: 'hi', how: 'channel', channel: 'vault' }, 'No text channel called "vault" that you can see.'],
  ['a channel the asker can read but not post in', { member: 'Sam', message: 'hi', how: 'channel', channel: 'announcements' }, "You can't post in #announcements."],
  ['a channel the bot can read but not post in', { member: 'Sam', message: 'hi', how: 'channel', channel: 'no-bots' }, "I can't post in #no-bots."],
  ['a bot as the target', { member: 'Beep', message: 'hi' }, "That's a bot; it won't read it."],
  ['the asker themselves', { member: 'Dana', message: 'hi' }, "That's the person asking."],
  ['the asker by ping code', { member: `<@${ASKER}>`, message: 'hi' }, "That's the person asking."],
  ['a name that matches two people', { member: 'Alex', message: 'hi' }, 'Which one? Alex (@alexone), Alex (@alextwo)'],
  ['a name that matches nobody', { member: 'Zed', message: 'hi' }, 'Nobody called "Zed" here.'],
  ['a blank message', { member: 'Sam', message: '   ' }, 'What should I tell them?'],
];

describe('message_member', () => {
  it('sends a DM that names the sender and pings nobody', async () => {
    const r = rig();
    expect(await r.tell({ member: 'Sam', message: "dinner's ready" })).toBe('Sent Sam a DM.');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm("dinner's ready")]]);
    expect(r.sends()).toBe(1);
  });

  it('posts in the current channel and pings only the target', async () => {
    const r = rig();
    expect(await r.tell({ member: 'Sam', message: "dinner's ready", how: 'channel' })).toBe('Posted in #general and pinged Sam.');
    expect(r.general.send.mock.calls).toStrictEqual([[post(SAM, "dinner's ready")]]);
    expect(r.sends()).toBe(1);
  });

  it('posts in a channel named by the asker', async () => {
    const r = rig();
    expect(await r.tell({ member: 'Sam', message: 'over here', how: 'channel', channel: '#Side-Chat' })).toBe('Posted in #side-chat and pinged Sam.');
    expect(r.sideChat.send.mock.calls).toStrictEqual([[post(SAM, 'over here')]]);
    expect(r.sends()).toBe(1);
  });

  it('never lets other ping codes in the text ping anyone', async () => {
    const r = rig();
    const text = `ask <@${KIM}> and <@&700000000000000001> too`;
    await r.tell({ member: 'Sam', message: text, how: 'channel' });
    expect(r.general.send.mock.calls).toStrictEqual([[post(SAM, text)]]);
    await r.tell({ member: 'Sam', message: text });
    expect(r.sam.send.mock.calls).toStrictEqual([[dm(text)]]);
  });

  it('defuses @everyone and @here in a DM and in a channel, in any case', async () => {
    const r = rig();
    await r.tell({ member: 'Sam', message: '@everyone and @here and @EveryOne' });
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('@​everyone and @​here and @​EveryOne')]]);
    await r.tell({ member: 'Sam', message: 'hey @HERE, @everyone', how: 'channel' });
    expect(r.general.send.mock.calls).toStrictEqual([[post(SAM, 'hey @​HERE, @​everyone')]]);
  });

  it('cuts the message to the set length', async () => {
    const r = rig({ maxChars: 50 });
    await r.tell({ member: 'Sam', message: 'x'.repeat(80) });
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('x'.repeat(50))]]);
  });

  it('says so when the DM fails', async () => {
    const r = rig();
    r.sam.send.mockRejectedValueOnce(new Error('Cannot send messages to this user'));
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe("Couldn't DM Sam: their DMs are closed to me. Try how=channel.");
  });

  it('asks which channel when the current one is hidden from the asker', async () => {
    const r = rig();
    r.general.permissionsFor = () => new PermissionsBitField([]);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe('Which channel?');
    expect(r.sends()).toBe(0);
    expect(r.take).not.toHaveBeenCalled();
  });

  it('refuses to post when the bot is not a known member of the server', async () => {
    const r = rig();
    r.guild.members.me = null;
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe("I can't post in #general.");
    expect(r.sends()).toBe(0);
    expect(r.take).not.toHaveBeenCalled();
  });

  it.each(refusals)('refuses %s and sends nothing', async (_name, args, reply) => {
    const r = rig();
    expect(await r.tell(args)).toBe(reply);
    expect(r.sends()).toBe(0);
    expect(r.take).not.toHaveBeenCalled();
  });

  it('uses Discord name search without the Server Members intent', async () => {
    const stranger = person(OUTSIDER, 'Riley', 'rileyr');
    const r = rig({ members: false, searchFinds: [stranger] });
    expect(await r.tell({ member: '@Riley', message: 'hi' })).toBe('Sent Riley a DM.');
    expect(r.search).toHaveBeenCalledWith({ query: 'Riley', limit: 10 });
    expect(stranger.send.mock.calls).toStrictEqual([[dm('hi')]]);
  });

  it('finds nobody when Discord name search comes back empty', async () => {
    const r = rig({ members: false });
    expect(await r.tell({ member: 'Zed', message: 'hi' })).toBe('Nobody called "Zed" here.');
    expect(r.sends()).toBe(0);
    expect(r.take).not.toHaveBeenCalled();
  });
});

describe('message_member rate limit', () => {
  it('sends nothing once the sender is spent', async () => {
    const r = rig({ limiter: spent(ASKER) });
    const why = "Not sent: you've sent 1 messages through me in the last hour.";
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe(why);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe(why);
    expect(r.sends()).toBe(0);
  });

  it('sends nothing once the target is spent', async () => {
    const r = rig({ limiter: spent(OUTSIDER, SAM, 5, 1) });
    const why = 'Not sent: that person has had enough messages through me this hour.';
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe(why);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe(why);
    expect(r.sends()).toBe(0);
  });

  it('lets an owner past a spent limiter', async () => {
    const r = rig({ limiter: spent(ASKER, SAM), owner: true });
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe('Sent Sam a DM.');
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe('Posted in #general and pinged Sam.');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('hi')]]);
    expect(r.general.send.mock.calls).toStrictEqual([[post(SAM, 'hi')]]);
    expect(r.take).toHaveBeenLastCalledWith(ASKER, SAM, true);
  });

  it('charges a send to the asker and the target, with no exemption', async () => {
    const r = rig();
    await r.tell({ member: 'Sam', message: 'hi' });
    expect(r.take.mock.calls).toStrictEqual([[ASKER, SAM, false]]);
  });

  it('counts each send that went out', async () => {
    const r = rig({ limiter: new RelayLimiter(2, 5) });
    expect(await r.tell({ member: 'Sam', message: 'one' })).toBe('Sent Sam a DM.');
    expect(await r.tell({ member: 'Kim', message: 'two', how: 'channel' })).toBe('Posted in #general and pinged Kim.');
    expect(await r.tell({ member: 'Sam', message: 'three' })).toBe("Not sent: you've sent 2 messages through me in the last hour.");
    expect(r.sends()).toBe(2);
  });

  it('spends nothing on a refusal', async () => {
    const r = rig({ limiter: new RelayLimiter(1, 1) });
    for (const [, args] of refusals) await r.tell(args);
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe('Sent Sam a DM.');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('hi')]]);
  });

  it('asks the limiter before sending', async () => {
    const r = rig();
    await r.tell({ member: 'Sam', message: 'hi' });
    await r.tell({ member: 'Kim', message: 'hi', how: 'channel' });
    const [forDm, forPost] = r.take.mock.invocationCallOrder;
    expect(forDm).toBeLessThan(r.sam.send.mock.invocationCallOrder[0]!);
    expect(forPost).toBeLessThan(r.general.send.mock.invocationCallOrder[0]!);
  });

  it('holds a second message back while the first is still sending', async () => {
    const r = rig({ limiter: new RelayLimiter(1, 5) });
    let finish = (_v: object) => {};
    r.sam.send.mockImplementationOnce(() => new Promise((res) => (finish = res)));
    const first = r.tell({ member: 'Sam', message: 'one' });
    await vi.waitFor(() => expect(r.sam.send).toHaveBeenCalledTimes(1));
    expect(await r.tell({ member: 'Kim', message: 'two' })).toBe("Not sent: you've sent 1 messages through me in the last hour.");
    finish({});
    expect(await first).toBe('Sent Sam a DM.');
    expect(r.sends()).toBe(1);
  });
});

describe('server_info', () => {
  it('channels leaves out what the asker cannot see', async () => {
    const r = rig();
    expect(await r.ask({ what: 'channels' })).toBe(
      ['#general (text, in Lobby): Anything goes', '#side-chat (text)', '#announcements (text)', '#no-bots (text)', '#ideas (forum)', 'Lounge (voice)'].join('\n'),
    );
  });

  it('voice leaves out rooms the asker cannot see', async () => {
    const r = rig();
    expect(await r.ask({ what: 'voice' })).toBe('Lounge: Sam (muted), Kim (streaming)');
  });

  it('voice says nobody is there when only a hidden room has people', async () => {
    const r = rig();
    r.lounge.members.clear();
    expect(await r.ask({ what: 'voice' })).toBe('Nobody is in a voice channel.');
  });

  it("members doesn't say who is in a hidden voice room", async () => {
    const r = rig();
    const list = await r.ask({ what: 'members' });
    expect(list).toContain(`Sam (@samthegreat, ping code <@${SAM}>): in voice Lounge`);
    expect(list).toContain(`Alex (@alexone, ping code <@${ALEX_ONE}>)\n`);
    expect(list).not.toContain('Staff Room');
  });
});
