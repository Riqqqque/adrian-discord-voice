import { EventEmitter } from 'node:events';
import { ChannelType, Collection, Events } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { pcDiscordTools, type PcDiscordOptions, watchDiscord } from '../src/features/handoff-discord.js';
import { MusicStarts } from '../src/features/handoff.js';

const ME = '100000000000000099';
const RIQUE = '100000000000000001';
const SAM = '100000000000000002';
const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const GENERAL = '800000000000000001';

function client() {
  const c = new EventEmitter() as EventEmitter & { user: { id: string }; guilds: { cache: Collection<string, unknown> }; channels: { cache: Collection<string, unknown> } };
  c.user = { id: ME };
  c.guilds = { cache: new Collection() };
  c.channels = { cache: new Collection() };
  return c;
}

const message = (o: { author: string; bot?: boolean; content?: string; guildId?: string | null; channelId?: string; dm?: boolean; repliedTo?: string; recipient?: string; embeds?: string[] }) => ({
  system: false,
  author: { id: o.author, bot: o.bot ?? false, username: 'u', globalName: null },
  member: { displayName: o.author === SAM ? 'Sam' : 'Rique' },
  content: o.content ?? '',
  embeds: (o.embeds ?? []).map((url) => ({ url })),
  attachments: new Collection(),
  stickers: new Collection(),
  guildId: o.dm ? null : (o.guildId ?? GUILD),
  channelId: o.channelId ?? GENERAL,
  channel: { type: o.dm ? ChannelType.DM : ChannelType.GuildText, ...(o.recipient ? { recipientId: o.recipient } : {}) },
  mentions: { repliedUser: o.repliedTo ? { id: o.repliedTo } : null },
});

describe('watchDiscord', () => {
  it('keeps pasted links, her replies for who she answered, and where she wrote last', () => {
    const c = client();
    const w = watchDiscord(c as never, { readable: true, allowedGuilds: [], keepMs: 30 * 60_000 });
    c.emit(Events.MessageCreate, message({ author: SAM, content: 'look https://example.com/sam' }));
    c.emit(Events.MessageCreate, message({ author: ME, bot: true, content: 'Here you go: https://example.com/guide', repliedTo: RIQUE, channelId: '800000000000000005' }));
    expect(w.things.candidates(RIQUE, GUILD).map((t) => [t.by, t.url])).toEqual([
      ['her', 'https://example.com/guide'],
      ['other', 'https://example.com/sam'],
    ]);
    expect(w.lastText(GUILD)).toBe('800000000000000005');
  });

  it('DMs: her answers count for the person on the other end', () => {
    const c = client();
    const w = watchDiscord(c as never, { readable: false, allowedGuilds: [], keepMs: 30 * 60_000 });
    c.emit(Events.MessageCreate, message({ author: ME, bot: true, dm: true, recipient: RIQUE, content: 'https://example.com/dm' }));
    c.emit(Events.MessageCreate, message({ author: RIQUE, dm: true, content: 'https://youtu.be/dQw4w9WgXcQ' }));
    expect(w.things.candidates(RIQUE).map((t) => t.kind)).toEqual(['video', 'link']);
  });

  it('ignores servers it isn\'t allowed in, and links in embeds count', () => {
    const c = client();
    const w = watchDiscord(c as never, { readable: true, allowedGuilds: [GUILD], keepMs: 30 * 60_000 });
    c.emit(Events.MessageCreate, message({ author: SAM, guildId: OTHER_GUILD, content: 'https://example.com/no' }));
    c.emit(Events.MessageCreate, message({ author: SAM, embeds: ['https://example.com/embed'] }));
    expect(w.things.candidates(SAM, GUILD).map((t) => t.url)).toEqual(['https://example.com/embed']);
  });

  it('without Message Content, a wordless message is noted as unread', () => {
    const c = client();
    const w = watchDiscord(c as never, { readable: false, allowedGuilds: [], keepMs: 30 * 60_000 });
    c.emit(Events.MessageCreate, message({ author: SAM, content: '' }));
    expect(w.things.hiddenSince(GUILD, RIQUE, -1)).toEqual({ channelId: GENERAL });
  });
});

describe('pcDiscordTools', () => {
  const base = (o: Partial<PcDiscordOptions> = {}): PcDiscordOptions => {
    const c = client();
    return {
      client: c as never,
      watch: watchDiscord(c as never, { readable: true, allowedGuilds: [], keepMs: 60_000 }),
      allowedGuilds: [],
      homeGuild: GUILD,
      presences: false,
      readable: true,
      handoff: true,
      tellCall: { enabled: true, max: 3, windowMinutes: 5, maxChars: 200 },
      gameNight: { enabled: true, optIn: [], cooldownMinutes: 15, maxMentions: 10, perUserPerHour: 4 },
      starts: new MusicStarts(),
      callRoom: 'discord',
      pcFor: () => undefined,
      callMusic: () => undefined,
      spot: () => undefined,
      voiceReady: () => false,
      isOwner: () => false,
      inHerCall: () => false,
      nameOf: () => 'Rique',
      announce: async () => true,
      ...o,
    };
  };

  it('offers each tool only when it is on', () => {
    const all = pcDiscordTools(base());
    expect(all.tools.map((t) => t.spec.name)).toEqual(['pc_handoff', 'tell_call', 'game_night']);
    expect(all.rules).toHaveLength(2);
    const none = pcDiscordTools(base({ handoff: false, tellCall: { enabled: false, max: 3, windowMinutes: 5, maxChars: 200 }, gameNight: { enabled: false, optIn: [], cooldownMinutes: 15, maxMentions: 10, perUserPerHour: 4 } }));
    expect(none.tools).toEqual([]);
    expect(none.rules).toEqual([]);
  });

  it('every tool schema is closed and names its action', () => {
    for (const t of pcDiscordTools(base()).tools) {
      expect(t.spec.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.spec.description.length).toBeLessThan(900);
    }
  });

  it('tell_call with no call and no server posts nowhere and says why', async () => {
    const [, tell] = pcDiscordTools(base()).tools;
    const out = await tell!.run({ message: 'on in 5' }, new AbortController().signal, { userId: RIQUE, speaker: 'Rique', channelId: 'sat:desk', said: 'tell the call on in 5', turn: 1 });
    expect(out).toBe("Not sent: you're not in a server I'm in.");
  });
});
