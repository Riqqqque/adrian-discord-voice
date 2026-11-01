import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, ThreadChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { toSpeakable } from '../src/brain/speech-text.js';
import type { ToolContext } from '../src/core/interfaces.js';
import { discordTools, namesMember, RelayLimiter } from '../src/features/discordinfo.js';

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
  let now = 0;
  let turns = 0;
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
    { limiter, isOwner: () => o.owner ?? false, maxChars: o.maxChars ?? 600, now: () => now },
  );
  /** A turn: the orchestrator makes a fresh context for each. */
  const turn = (said: string, extra: Partial<ToolContext> = {}): ToolContext => ({ userId: ASKER, speaker: 'Dana', guildId: GUILD, channelId: GENERAL, said, turn: ++turns, ...extra });
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
    message: message!,
    turn,
    tick: (ms: number) => (now += ms),
    /** An order that names the target in the asker's own words, unless told otherwise. */
    tell: (a: Record<string, unknown>, said = `tell ${String(a.member).replace(/^@/, '')} something`) => message!.run(a, signal, turn(said)),
    /** A call inside a turn already under way. */
    within: (ctx: ToolContext, a: Record<string, unknown>) => message!.run(a, signal, ctx),
    ask: (a: Record<string, unknown>) => info!.run(a, signal, turn('tell me about the server')),
    sends: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
  };
}

const dm = (text: string) => ({ content: `**Dana (@danad)** (in Test Server) asked me to tell you: ${text}`, allowedMentions: { parse: [] } });
const post = (target: string, text: string) => ({ content: `<@${target}> from **Dana (@danad)**: ${text}`, allowedMentions: { users: [target], parse: [] } });

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

  it('lets an owner past a spent sender limit', async () => {
    const r = rig({ limiter: spent(ASKER, KIM), owner: true });
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe('Sent Sam a DM.');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('hi')]]);
    expect(r.take).toHaveBeenLastCalledWith(ASKER, SAM, true);
  });

  it('stops an owner at 30 an hour too', async () => {
    let now = 0;
    const r = rig({ limiter: new RelayLimiter(10, 1000, () => now), owner: true });
    for (let i = 0; i < 30; i++) expect(await r.tell({ member: 'Sam', message: `${i}` })).toBe('Sent Sam a DM.');
    expect(await r.tell({ member: 'Sam', message: 'one more' })).toBe("Not sent: you've sent 30 messages through me in the last hour.");
    expect(r.sends()).toBe(30);
    now = 3_600_001;
    expect(await r.tell({ member: 'Sam', message: 'later' })).toBe('Sent Sam a DM.');
  });

  it('keeps the per-target limit for an owner', async () => {
    const r = rig({ limiter: spent(OUTSIDER, SAM, 5, 1), owner: true });
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe('Not sent: that person has had enough messages through me this hour.');
    expect(r.sends()).toBe(0);
  });

  it('never lowers a limit set above 30', () => {
    const l = new RelayLimiter(40, 1000);
    for (let i = 0; i < 40; i++) expect(l.take(ASKER, SAM, true)).toBeUndefined();
    expect(l.take(ASKER, SAM, true)).toBe("you've sent 40 messages through me in the last hour");
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

describe('a failed send costs nothing', () => {
  it('a failed DM spends no sender slot: the suggested how=channel retry works', async () => {
    const r = rig({ limiter: new RelayLimiter(1, 5) });
    r.sam.send.mockRejectedValueOnce(new Error('Cannot send messages to this user'));
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe("Couldn't DM Sam: their DMs are closed to me. Try how=channel.");
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe('Posted in #general and pinged Sam.');
  });

  it('a failed DM spends no target slot', async () => {
    const r = rig({ limiter: new RelayLimiter(5, 1) });
    r.sam.send.mockRejectedValueOnce(new Error('Cannot send messages to this user'));
    await r.tell({ member: 'Sam', message: 'hi' });
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe('Posted in #general and pinged Sam.');
  });

  it('a failed channel post spends no slot', async () => {
    const r = rig({ limiter: new RelayLimiter(1, 5) });
    r.general.send.mockRejectedValueOnce(new Error('Missing Access'));
    await r.tell({ member: 'Sam', message: 'hi', how: 'channel' });
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe('Posted in #general and pinged Sam.');
  });

  it('a failed channel post gives a reply, not a throw', async () => {
    const r = rig();
    r.general.send.mockRejectedValueOnce(new Error('Missing Access'));
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel' })).toBe("Couldn't post in #general.");
  });

  it('a failed send takes back only its own slot', () => {
    const l = new RelayLimiter(2, 5);
    l.take(ASKER, SAM);
    l.take(ASKER, SAM);
    l.release(ASKER, SAM);
    expect(l.take(ASKER, SAM)).toBeUndefined();
    expect(l.take(ASKER, SAM)).toBe("you've sent 2 messages through me in the last hour");
  });
});

describe('threads', () => {
  type Rig = ReturnType<typeof rig>;
  function privateThread(r: Rig, o: { in?: string[]; ownerId?: string; perms?: bigint[] } = {}) {
    const t = {
      ...channel({ id: '800000000000000099', name: 'secret-plans', position: 9 }),
      type: ChannelType.PrivateThread,
      parent: o.perms ? { ...r.general, permissionsFor: () => new PermissionsBitField(o.perms) } : r.general,
      ownerId: o.ownerId ?? KIM,
      members: { cache: new Collection((o.in ?? []).map((id) => [id, {}])) },
      isThread: () => true,
    };
    // The real discord.js method: a thread answers with its parent's permissions.
    (t as { permissionsFor: unknown }).permissionsFor = function (this: unknown, m: unknown, c: unknown) {
      return ThreadChannel.prototype.permissionsFor.call(this as never, m as never, c as never);
    };
    r.guild.channels.cache.set(t.id, t as never);
    return t;
  }
  function publicThread(r: Rig, asker: bigint[], bot: bigint[]) {
    const t = { ...channel({ id: '800000000000000098', name: 'build-thread', position: 10, asker, bot }), type: ChannelType.PublicThread, parent: r.general, isThread: () => true };
    r.guild.channels.cache.set(t.id, t as never);
    return t;
  }
  const THREAD = [...POST, PermissionFlagsBits.SendMessagesInThreads];

  it('channels hides a private thread the asker is not in', async () => {
    const r = rig();
    privateThread(r);
    expect(await r.ask({ what: 'channels' })).not.toContain('secret-plans');
  });

  it('message_member cannot post into a private thread the asker is not in', async () => {
    const r = rig();
    const t = privateThread(r);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel', channel: 'secret-plans' })).toBe('No text channel called "secret-plans" that you can see.');
    expect(t.send).not.toHaveBeenCalled();
  });

  it.each([
    ['a member', { in: [ASKER] }],
    ['the one who made it', { ownerId: ASKER }],
    ['a moderator', { perms: [...POST, PermissionFlagsBits.ManageThreads] }],
  ])('channels shows a private thread to %s', async (_who, o) => {
    const r = rig();
    privateThread(r, o);
    expect(await r.ask({ what: 'channels' })).toContain('secret-plans');
  });

  it('a public thread shows to anyone who can see its parent', async () => {
    const r = rig();
    publicThread(r, POST, POST);
    expect(await r.ask({ what: 'channels' })).toContain('build-thread');
  });

  it('a thread post needs Send Messages in Threads from the asker', async () => {
    const r = rig();
    const t = publicThread(r, POST, THREAD);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel', channel: 'build-thread' })).toBe("You can't post in #build-thread.");
    expect(t.send).not.toHaveBeenCalled();
  });

  it('a thread post needs Send Messages in Threads from the bot', async () => {
    const r = rig();
    const t = publicThread(r, THREAD, POST);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel', channel: 'build-thread' })).toBe("I can't post in #build-thread.");
    expect(t.send).not.toHaveBeenCalled();
  });

  it('a thread post goes out with the right permission, even without Send Messages', async () => {
    const r = rig();
    const noSend = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads];
    const t = publicThread(r, noSend, noSend);
    t.permissionsFor = () => new PermissionsBitField(noSend);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel', channel: 'build-thread' })).toBe('Posted in #build-thread and pinged Sam.');
    expect(t.send).toHaveBeenCalledTimes(1);
  });
});

describe('a ping nobody can see', () => {
  it('refuses a post the target cannot see, and says why', async () => {
    const r = rig();
    r.sideChat.permissionsFor = (m: { id: string }) => new PermissionsBitField(m.id === SAM ? [] : POST);
    expect(await r.tell({ member: 'Sam', message: 'hi', how: 'channel', channel: 'side-chat' })).toBe("Sam can't see #side-chat, so I didn't post it there. A DM would reach them.");
    expect(r.sends()).toBe(0);
    expect(r.take).not.toHaveBeenCalled();
  });
});

describe('who the asker really named', () => {
  const sam = { id: SAM, displayName: 'Sam Rivers', username: 'samthegreat', nickname: null };

  it.each([
    ['tell sam dinner is ready', sam],
    ['Tell SAM dinner is ready', sam],
    ['let Rivers know', sam],
    ['ping sam rivers', sam],
    ['message @samthegreat', sam],
    ['tell samthegreat', sam],
    ['hey adrian can you tell sam dinner is ready', sam],
    ['dm sam', sam],
    ['ask sam if he is coming', sam],
    ['send sam the link', sam],
    ['send a message to sam', sam],
    ['send this to sam', sam],
    ['say hi to sam', sam],
    ['reply to sam', sam],
    ['tell kim and sam hi', sam],
    ['let kim and sam know', sam],
    ['tell my sam', sam],
    ['dile a sam que voy tarde', sam],
    ['tell jo', { ...sam, displayName: 'Jo', username: 'x' }],
    ['tell jose', { ...sam, displayName: 'José', username: 'x' }],
    ['tell slayer', { ...sam, displayName: 'xX_Slayer_Xx', username: 'x' }],
    ['tell mike', { ...sam, displayName: 'BigMike', username: 'x' }],
    ['tell mo', { ...sam, displayName: 'x', username: 'x', nickname: 'Mo' }],
    ['tell xX_Slayer_Xx', { ...sam, displayName: 'xX_Slayer_Xx', username: 'x' }],
    ['tell big mike', { ...sam, displayName: 'Big Mike', username: 'x' }],
  ])('%s', (said, m) => {
    expect(namesMember(said, m)).toBe(true);
  });

  // A nickname is whatever its owner likes, so one can sit waiting on a word the
  // asker says all the time. Saying a word isn't naming someone.
  const nick = (displayName: string) => ({ ...sam, displayName, username: 'x' });
  it.each([
    ["what's the weather", nick('Weather')],
    ['tell me the weather', nick('Weather')],
    ['let me know the weather', nick('Weather')],
    ['send me the weather', nick('Weather')],
    ['what is the score', nick('Score')],
    ['restart the pc', nick('Restart')],
    ['open spotify', nick('Spotify')],
    ['mute my mic', nick('Michael')],
    ['turn it up on my car', nick('Carl')],
    ["don't do that", nick('Don')],
    ["don't do that", nick('Donovan')],
    ['what did @Eve say', nick('Eve')],
    ['tell me what eve said', nick('Eve')],
    ['tell the group we are on', nick('Group')],
    ['ping the server', nick('Server')],
    ['send this to the chat', nick('Chat')],
    ['tell me', nick('me')],
    ['remind me to call', nick('me')],
    ['tell him dinner is ready', nick('him')],
    ['ask what time it is', nick('what')],
    ["sam's dinner is ready, tell him", sam],
  ])('a word that names nobody: %j', (said, m) => {
    expect(namesMember(said, m)).toBe(false);
  });

  // "Sam" could be someone she hasn't seen, or just not who they meant.
  it.each([
    ['tell chris', { ...sam, displayName: 'Christopher', username: 'x' }],
    ['tell sam', { ...sam, displayName: 'Samantha', username: 'x' }],
    ['tell rob', { ...sam, displayName: 'x', username: 'robert99' }],
    ['tell ann', { ...sam, displayName: 'Joanna', username: 'x' }],
  ])('a name that only begins or contains theirs: %j', (said, m) => {
    expect(namesMember(said, m)).toBe(false);
  });

  it.each([
    ['lol', sam],
    ['tell him dinner is ready', sam],
    ['tell the guys', sam],
    ['same here', { ...sam, displayName: 'Samuel', username: 'x' }],
    ['what time is it', { ...sam, displayName: 'what', username: 'x' }],
    ['the', { ...sam, displayName: 'The Best', username: 'x' }],
    ['adrian you there', { ...sam, displayName: 'Adrian', username: 'x' }],
    ['hey you there', { ...sam, displayName: 'hey', username: 'x' }],
    ['what is it', { ...sam, displayName: 'whatever', username: 'x' }],
    ['k thanks', { ...sam, displayName: 'K', username: 'x' }],
  ])('not by %j', (said, m) => {
    expect(namesMember(said, m)).toBe(false);
  });

  it('nothing said names nobody', () => {
    expect(namesMember(undefined, sam)).toBe(false);
    expect(namesMember('', sam)).toBe(false);
  });
});

describe('a name that only partly fits', () => {
  const RILEY = '100000000000000011';
  const JOANNA = '100000000000000012';
  /** One more person she has seen. */
  const seen = (r: ReturnType<typeof rig>, p: Person) => r.guild.members.cache.set(p.id, p as never);
  const said = (p: Person) => p.send.mock.calls.length;

  it('looks further before settling on the only person she has seen', async () => {
    const riley = person(OUTSIDER, 'Riley', 'rileyr');
    const rileyanne = person(RILEY, 'Rileyanne', 'ra');
    const r = rig({ members: false, searchFinds: [riley] });
    seen(r, rileyanne);
    expect(await r.tell({ member: 'Riley', message: 'party is at 8' })).toBe('Sent Riley a DM.');
    expect(r.search).toHaveBeenCalledWith({ query: 'Riley', limit: 10 });
    expect(said(riley)).toBe(1);
    expect(said(rileyanne)).toBe(0);
  });

  it('sees both when the search finds someone it had cached too', async () => {
    const rileyanne = person(RILEY, 'Rileyanne', 'ra');
    const r = rig({ members: false, searchFinds: [rileyanne] });
    seen(r, rileyanne);
    expect(await r.tell({ member: 'Riley', message: 'hi' })).toBe('Send Rileyanne: "hi"?');
    expect(said(rileyanne)).toBe(0);
  });

  it('asks which when the search turns up a second partial match', async () => {
    const rileyanne = person(RILEY, 'Rileyanne', 'ra');
    const rileyson = person(OUTSIDER, 'Rileyson', 'rs');
    const r = rig({ members: false, searchFinds: [rileyson] });
    seen(r, rileyanne);
    expect(await r.tell({ member: 'Riley', message: 'hi' })).toBe('Which one? Rileyanne (@ra), Rileyson (@rs)');
    expect(said(rileyanne) + said(rileyson)).toBe(0);
  });

  it('needs no search once someone cached has exactly that name', async () => {
    const r = rig({ members: false });
    expect(await r.tell({ member: 'Sam', message: 'hi' })).toBe('Sent Sam a DM.');
    expect(r.search).not.toHaveBeenCalled();
  });

  it('falls back on who it has seen when the search fails, and still checks', async () => {
    const rileyanne = person(RILEY, 'Rileyanne', 'ra');
    const r = rig({ members: false });
    seen(r, rileyanne);
    r.search.mockRejectedValue(new Error('rate limited'));
    expect(await r.tell({ member: 'Riley', message: 'hi' })).toBe('Send Rileyanne: "hi"?');
    expect(said(rileyanne)).toBe(0);
  });

  it('reads back a name that only contains what they said, and sends nothing yet', async () => {
    const joanna = person(JOANNA, 'Joanna', 'jo99');
    const r = rig();
    seen(r, joanna);
    expect(await r.tell({ member: 'Ann', message: 'surprise party is at 8' })).toBe('Send Joanna: "surprise party is at 8"?');
    expect(said(joanna)).toBe(0);
    expect(r.take).not.toHaveBeenCalled();
    expect(r.search).not.toHaveBeenCalled(); // with the member list there's nobody else to find
    expect(await r.tell({ member: 'Ann', message: 'surprise party is at 8' }, 'yes')).toBe('Sent Joanna a DM.');
    expect(said(joanna)).toBe(1);
  });

  it('reads back a name that only begins with what they said', async () => {
    const riley = person(RILEY, 'Rileyanne', 'ra');
    const r = rig();
    seen(r, riley);
    expect(await r.tell({ member: 'Riley', message: 'hi' })).toBe('Send Rileyanne: "hi"?');
    expect(said(riley)).toBe(0);
  });

  it('will not let the model finish the name for them', async () => {
    const riley = person(RILEY, 'Rileyanne', 'ra');
    const r = rig();
    seen(r, riley);
    expect(await r.tell({ member: 'Rileyanne', message: 'hi' }, 'tell riley hi')).toBe('Send Rileyanne: "hi"?');
    expect(said(riley)).toBe(0);
  });

  it('sends once they say the whole name', async () => {
    const riley = person(RILEY, 'Rileyanne', 'ra');
    const r = rig();
    seen(r, riley);
    expect(await r.tell({ member: 'Rileyanne', message: 'hi' }, 'tell rileyanne hi')).toBe('Sent Rileyanne a DM.');
  });

  it('takes one whole word of a longer name as naming them', async () => {
    const riley = person(RILEY, 'Riley Jones', 'ra');
    const r = rig();
    seen(r, riley);
    expect(await r.tell({ member: 'Riley', message: 'hi' })).toBe('Sent Riley Jones a DM.');
  });

  it('still sends straight to a ping code for the person they named', async () => {
    const r = rig();
    expect(await r.tell({ member: `<@${SAM}>`, message: 'hi' }, 'tell sam hi')).toBe('Sent Sam a DM.');
  });

  it('still finds partial matches when someone is only asking about a person', async () => {
    const r = rig();
    seen(r, person(RILEY, 'Rileyanne', 'ra'));
    expect(await r.ask({ what: 'members', name: 'riley' })).toContain('Rileyanne');
  });
});

describe('a message to someone the asker never mentioned', () => {
  const planted = { member: 'Sam', message: 'click this' };

  it('sends nothing, and reads it back', async () => {
    const r = rig();
    expect(await r.tell(planted, 'lol')).toBe('Send Sam: "click this"?');
    expect(r.sends()).toBe(0);
    expect(r.take).not.toHaveBeenCalled();
  });

  it('applies to an owner the same', async () => {
    const r = rig({ owner: true });
    await r.tell(planted, 'lol');
    expect(r.sends()).toBe(0);
  });

  it('counts their name only as who the message is for', async () => {
    const r = rig();
    expect(await r.tell(planted, 'sam is so late lol')).toBe('Send Sam: "click this"?');
    expect(r.sends()).toBe(0);
    expect(await r.tell(planted, 'tell sam we are on')).toBe('Sent Sam a DM.');
  });

  it('goes out on their yes, on the next turn', async () => {
    const r = rig();
    await r.tell(planted, 'tell my brother to click this');
    expect(await r.tell(planted, 'yes')).toBe('Sent Sam a DM.');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('click this')]]);
  });

  it('sends what was read back, whatever the model asks for on the yes', async () => {
    const r = rig();
    await r.tell(planted, 'lol');
    expect(await r.tell({ member: 'Kim', message: 'something else', how: 'channel' }, 'yes send it')).toBe('Sent Sam a DM.');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('click this')]]);
    expect(r.sends()).toBe(1);
  });

  it('keeps the channel it read back', async () => {
    const r = rig();
    expect(await r.tell({ ...planted, how: 'channel', channel: 'side-chat' }, 'lol')).toBe('Send Sam in #side-chat: "click this"?');
    expect(await r.tell(planted, 'go ahead')).toBe('Posted in #side-chat and pinged Sam.');
    expect(r.sideChat.send.mock.calls).toStrictEqual([[post(SAM, 'click this')]]);
  });

  it.each(['no', 'lol', 'yes but wait', 'not him'])('goes nowhere after "%s"', async (said) => {
    const r = rig();
    await r.tell(planted, 'lol');
    expect(await r.tell(planted, said)).toBe('Send Sam: "click this"?');
    expect(r.sends()).toBe(0);
  });

  it('never takes a yes from the turn that asked', async () => {
    const r = rig();
    const turn = r.turn('yes');
    await r.within(turn, planted);
    await r.within(turn, planted);
    expect(r.sends()).toBe(0);
  });

  it('is for the very next turn only', async () => {
    const r = rig();
    await r.tell(planted, 'lol');
    r.turn('something else');
    await r.tell(planted, 'yes');
    expect(r.sends()).toBe(0);
  });

  it('runs out 20 seconds after she finishes asking', async () => {
    const r = rig();
    await r.tell(planted, 'lol');
    r.tick(22_000);
    await r.tell(planted, 'yes');
    expect(r.sends()).toBe(0);
  });

  it('takes no yes from anyone else, or from another channel', async () => {
    const r = rig();
    await r.tell(planted, 'lol');
    await r.within(r.turn('yes', { userId: KIM, speaker: 'Kim' }), planted);
    await r.within(r.turn('yes', { channelId: r.sideChat.id }), planted);
    expect(r.sends()).toBe(0);
  });

  it('counts the send against the limits', async () => {
    const r = rig({ limiter: spent(ASKER) });
    await r.tell(planted, 'lol');
    expect(await r.tell(planted, 'yes')).toBe("Not sent: you've sent 1 messages through me in the last hour.");
    expect(r.sends()).toBe(0);
  });

  it('puts one to them per turn', async () => {
    const r = rig();
    const turn = r.turn('lol');
    expect(await r.within(turn, planted)).toBe('Send Sam: "click this"?');
    expect(await r.within(turn, { member: 'Kim', message: 'and this' })).not.toContain('and this');
    expect(await r.tell(planted, 'yes')).toBe('Sent Sam a DM.');
    expect(r.sends()).toBe(1);
  });

  it('never reads a ping back', async () => {
    const r = rig();
    expect(await r.tell({ member: 'Sam', message: `ask <@${KIM}> and <@!${KIM}> and <@&700000000000000001>` }, 'lol')).toBe('Send Sam: "ask @someone and @someone and @someone"?');
  });

  it.each([
    ['a link at the end', 'see https://evil.example/x?a=1', 'Send Sam: "see a link to evil.example"?'],
    ['a link that has someone inside it', 'log in https://steamcommunity.com@evil.example/', 'Send Sam: "log in a link to evil.example"?'],
    ['a link behind other words', '[free nitro](https://evil.example/x)', 'Send Sam: "free nitro (a link to evil.example)"?'],
    ['a code block her voice would skip', '```click https://evil.example```', 'Send Sam: "click a link to evil.example"?'],
  ])('reads back %s so it can be heard, and stays a question', async (_name, text, line) => {
    const r = rig();
    const raw = await r.tell({ member: 'Sam', message: text }, 'lol');
    expect(raw).toBe(line);
    expect(toSpeakable(raw)).toBe(line);
    await r.tell(planted, 'yes');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm(text)]]);
  });

  it('sends only as much as it read back', async () => {
    const r = rig();
    const long = 'x'.repeat(300);
    expect(await r.tell({ member: 'Sam', message: long }, 'lol')).toBe(`Send Sam: "${'x'.repeat(200)}…"?`);
    await r.tell(planted, 'yes');
    expect(r.sam.send.mock.calls).toStrictEqual([[dm(`${'x'.repeat(200)}…`)]]);
  });

  it('leaves time to hear a long one', async () => {
    const r = rig();
    await r.tell({ member: 'Sam', message: 'x'.repeat(200) }, 'lol');
    r.tick(30_000);
    await r.tell(planted, 'yes');
    expect(r.sends()).toBe(1);
  });

  it('is the one line the model cannot reword, and it stays a question', async () => {
    const r = rig();
    const raw = await r.tell(planted, 'lol');
    expect(raw.endsWith('?')).toBe(true);
    expect(r.message.asks?.(raw)).toBe(true);
    expect(r.message.speak?.(planted, raw, r.turn('lol'))).toBe(raw);
    expect(r.message.asks?.('Sent Sam a DM.')).toBe(false);
    expect(r.message.speak?.(planted, 'Sent Sam a DM.', r.turn('lol'))).toBeUndefined();
  });
});

describe('sends in one turn', () => {
  const to = (member: string) => ({ member, message: 'hi' });

  it('stops at three, for an owner too', async () => {
    const r = rig({ owner: true });
    const turn = r.turn('tell sam and kim');
    await r.within(turn, to('Sam'));
    await r.within(turn, to('Kim'));
    await r.within(turn, { ...to('Sam'), how: 'channel' });
    expect(await r.within(turn, to('Kim'))).toBe('Not sent: three messages is the most I send in one go.');
    expect(r.sends()).toBe(3);
  });

  it('starts fresh on the next turn', async () => {
    const r = rig();
    const turn = r.turn('tell sam');
    for (let i = 0; i < 3; i++) await r.within(turn, to('Sam'));
    expect(await r.tell(to('Sam'))).toBe('Sent Sam a DM.');
  });

  it("doesn't count a send that failed", async () => {
    const r = rig();
    const turn = r.turn('tell sam');
    r.sam.send.mockRejectedValueOnce(new Error('closed'));
    await r.within(turn, to('Sam'));
    await r.within(turn, to('Sam'));
    await r.within(turn, to('Sam'));
    expect(await r.within(turn, to('Sam'))).toBe('Sent Sam a DM.');
    expect(r.sam.send).toHaveBeenCalledTimes(4);
  });
});

describe('the from line', () => {
  it('shows the account behind a copied nickname', async () => {
    const r = rig();
    await r.tell({ member: 'Sam', message: 'hi' });
    await r.tell({ member: 'Sam', message: 'hi', how: 'channel' });
    expect(r.sam.send.mock.calls).toStrictEqual([[dm('hi')]]);
    expect(r.general.send.mock.calls).toStrictEqual([[post(SAM, 'hi')]]);
  });

  it("doesn't let a name's markdown hide the account", async () => {
    const r = rig();
    r.guild.members.cache.get(ASKER)!.displayName = 'Rique** ||';
    await r.tell({ member: 'Sam', message: 'hi' });
    const line = JSON.stringify(r.sam.send.mock.calls);
    expect(line).not.toContain('Rique** ||');
    expect(line).toContain('(@danad)');
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
