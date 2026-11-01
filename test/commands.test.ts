import { EventEmitter } from 'node:events';
import { Events, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, humansIn, registerVoiceCommands, type VoiceSpot } from '../src/app/commands.js';

const GUILD = '100000000000000010';
const HOME = '100000000000000020';
const OTHER = '100000000000000021';
const USER = '100000000000000030';
const FRIEND = '100000000000000031';
const BOT = '100000000000000040';

/** A voice channel with these people in it. */
const channel = (id: string, people: string[] = []) => ({
  id,
  name: id === HOME ? 'drag' : 'other',
  members: { filter: (f: (m: unknown) => boolean) => ({ size: people.map((p) => ({ id: p, user: { bot: false } })).filter(f).length }) },
  permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
});

/** /join and /leave against a fake client. `seated`: the channel Discord shows her in. */
function rig(o: { spot?: VoiceSpot; ready?: boolean; seated?: string | null; moves?: () => Promise<void>; people?: string[]; unwired?: boolean }) {
  const home = channel(HOME, o.people ?? []);
  const other = channel(OTHER);
  const guild = { id: GUILD, voiceStates: { cache: new Map(o.seated === undefined ? [] : [[BOT, { channelId: o.seated }]]) } };
  const client = Object.assign(new EventEmitter(), {
    user: { id: BOT },
    guilds: { cache: new Map([[GUILD, guild]]) },
    channels: { cache: new Map([[HOME, home], [OTHER, other]]) },
  });
  const moveTo = vi.fn(o.moves ?? (async () => undefined));
  const leave = vi.fn(async () => undefined);
  let spot = o.spot;
  /** The app's owner, as Discord reports it once she's logged in. */
  const ownerIs = async (id: string) => {
    client.emit(Events.ClientReady, { application: { commands: { set: async () => undefined }, fetch: async () => ({ owner: { id } }) }, guilds: { cache: new Map() } });
    await new Promise((r) => setTimeout(r, 0));
  };
  registerVoiceCommands({
    client: client as never,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
    current: () => spot,
    moveTo: async (s) => {
      await moveTo(s);
      spot = s;
    },
    leave: async () => {
      await leave();
      spot = undefined;
    },
    ...(o.unwired ? {} : { voiceReady: () => o.ready ?? true }),
  });
  /** One slash command from someone in `from` (a channel, or null: not in voice); the replies it got. */
  const slash = async (name: string, from: string | null) => {
    const replies: string[] = [];
    const i = {
      commandName: name,
      guildId: GUILD,
      user: { id: USER },
      deferred: false,
      replied: false,
      isChatInputCommand: () => true,
      inCachedGuild: () => true,
      guild: { voiceStates: { cache: new Map(from ? [[USER, { channel: from === HOME ? home : other }]] : []) }, members: { me: {} } },
      reply: async (r: { content: string }) => {
        i.replied = true;
        replies.push(r.content);
      },
      deferReply: async () => {
        i.deferred = true;
      },
      editReply: async (r: string) => {
        replies.push(r);
      },
    };
    client.emit(Events.InteractionCreate, i);
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    return replies;
  };
  return { slash, moveTo, leave, ownerIs };
}

const at = (channelId: string): VoiceSpot => ({ guildId: GUILD, channelId });

describe('slash commands', () => {
  it('defines guild-only /join and /leave', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['join', 'leave']);
    for (const c of COMMANDS) {
      expect(c.contexts).toEqual([0]); // guild only, not DMs
      expect(c.integration_types).toEqual([0]); // server install
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('counts people, not bots, in a channel', () => {
    const members = new Map([
      ['1', { id: '1', user: { bot: false } }],
      ['2', { id: '2', user: { bot: true } }],
      ['3', { id: '3', user: { bot: false } }],
    ]);
    const ch = { members: { filter: (f: (m: unknown) => boolean) => ({ size: [...members.values()].filter(f).length }) } };
    expect(humansIn(ch as never)).toBe(2);
    expect(humansIn(ch as never, '1')).toBe(1);
    expect(humansIn(undefined)).toBe(0);
  });
});

describe('/join on a link that is down', () => {
  it('says she is already here when she really is', async () => {
    const r = rig({ spot: at(HOME), ready: true, seated: HOME });
    expect((await r.slash('join', HOME))[0]).toContain("I'm already here");
    expect(r.moveTo).not.toHaveBeenCalled();
  });

  it('retries after a join that failed', async () => {
    const r = rig({ spot: at(OTHER), ready: false, seated: null });
    expect(await r.slash('join', OTHER)).toEqual(['Joined other. Say "Hey Adrian" and ask me anything.']);
    expect(r.moveTo).toHaveBeenCalledExactlyOnceWith(at(OTHER));
  });

  it('rebuilds a call stuck in the channel she shows up in', async () => {
    const r = rig({ spot: at(HOME), ready: false, seated: HOME });
    expect((await r.slash('join', HOME))[0]).toContain('Joined drag');
    expect(r.moveTo).toHaveBeenCalledExactlyOnceWith(at(HOME));
  });

  it('rebuilds with other people in that call: they want her back too', async () => {
    const r = rig({ spot: at(HOME), ready: false, seated: HOME, people: [USER, FRIEND] });
    expect((await r.slash('join', HOME))[0]).toContain('Joined drag');
    expect(r.moveTo).toHaveBeenCalledOnce();
  });

  it('says so if the retry fails too, and can go again', async () => {
    let fails = 1;
    const moves = async () => {
      if (fails-- > 0) throw new Error('timed out');
    };
    const r = rig({ spot: at(HOME), ready: false, seated: null, moves });
    expect((await r.slash('join', HOME))[0]).toContain("didn't work");
    expect((await r.slash('join', HOME))[0]).toContain('Joined drag');
    expect(r.moveTo).toHaveBeenCalledTimes(2);
  });

  it('lets someone elsewhere bring her over from a call she is not in', async () => {
    const r = rig({ spot: at(HOME), ready: false, seated: null, people: [FRIEND] });
    expect((await r.slash('join', OTHER))[0]).toContain('Joined other');
    expect(r.moveTo).toHaveBeenCalledExactlyOnceWith(at(OTHER));
  });

  it('counts a voice state with no channel as not being there', async () => {
    const r = rig({ spot: at(HOME), ready: false, people: [FRIEND] });
    expect((await r.slash('join', OTHER))[0]).toContain('Joined other');
  });

  it('keeps her in a busy call during a drop she may recover from', async () => {
    const r = rig({ spot: at(HOME), ready: false, seated: HOME, people: [FRIEND] });
    expect((await r.slash('join', OTHER))[0]).toContain('another channel here');
    expect(r.moveTo).not.toHaveBeenCalled();
  });

  it('keeps her in a busy call while the link is up, whatever Discord showed last', async () => {
    const r = rig({ spot: at(HOME), ready: true, seated: null, people: [FRIEND] });
    expect((await r.slash('join', OTHER))[0]).toContain('another channel here');
    expect(r.moveTo).not.toHaveBeenCalled();
  });

  it('acts as before when nothing says how the link is', async () => {
    const r = rig({ spot: at(HOME), seated: null, unwired: true });
    expect((await r.slash('join', HOME))[0]).toContain("I'm already here");
    expect(r.moveTo).not.toHaveBeenCalled();
  });

  it('still lets /leave clear a spot with no call behind it', async () => {
    const r = rig({ spot: at(HOME), ready: false, seated: null });
    expect((await r.slash('leave', HOME))[0]).toContain('Left the voice channel');
    expect(r.leave).toHaveBeenCalledOnce();
  });
});

describe('/leave from outside a call with people in it', () => {
  const REFUSED = "I'm in a call with other people right now.";

  it.each([
    ['another channel', OTHER],
    ['no channel at all', null],
  ])('is refused from %s', async (_n, from) => {
    const r = rig({ spot: at(HOME), ready: true, seated: HOME, people: [FRIEND] });
    expect((await r.slash('leave', from))[0]).toContain(REFUSED);
    expect(r.leave).not.toHaveBeenCalled();
  });

  it('is refused during a drop she may recover from, like /join', async () => {
    const r = rig({ spot: at(HOME), ready: false, seated: HOME, people: [FRIEND] });
    expect((await r.slash('leave', OTHER))[0]).toContain(REFUSED);
    expect(r.leave).not.toHaveBeenCalled();
  });

  it('works for someone in the call', async () => {
    const r = rig({ spot: at(HOME), ready: true, seated: HOME, people: [USER, FRIEND] });
    expect((await r.slash('leave', HOME))[0]).toContain('Left the voice channel');
    expect(r.leave).toHaveBeenCalledOnce();
  });

  it('works with nobody in the call', async () => {
    const r = rig({ spot: at(HOME), ready: true, seated: HOME });
    expect((await r.slash('leave', OTHER))[0]).toContain('Left the voice channel');
  });

  it('works for the owner, from anywhere', async () => {
    const r = rig({ spot: at(HOME), ready: true, seated: HOME, people: [FRIEND] });
    await r.ownerIs(USER);
    expect((await r.slash('leave', null))[0]).toContain('Left the voice channel');
  });

  it('works on a spot with no call behind it', async () => {
    const r = rig({ spot: at(HOME), ready: false, seated: null, people: [FRIEND] });
    expect((await r.slash('leave', OTHER))[0]).toContain('Left the voice channel');
  });
});
