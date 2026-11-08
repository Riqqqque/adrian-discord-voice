// The Discord side of handoff.ts and gamenight.ts: what it reads from
// messages, and the tools wired to the real client. Kept apart so stack.ts
// only hands over what it already has.

import { ChannelType, type Client, Events, type Guild, type Message, type VoiceBasedChannel } from 'discord.js';
import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import { GAME_NIGHT_RULE, GameNightSignups, gameNightTool } from './gamenight.js';
import { type CallMusic, HANDOFF_RULE, handoffTools, LastThings, MusicStarts, noteMessage, type PcLike, tellCallTool, WindowLimiter } from './handoff.js';
import { canSee, pickTextChannel } from './textchannel.js';

export interface DiscordWatch {
  things: LastThings;
  /** The text channel she last wrote in, per server. */
  lastText(guildId: string): string | undefined;
}

/** Remember links in messages, and where she writes. `readable`: the Message
 *  Content intent is on. */
export function watchDiscord(client: Client, o: { readable: boolean; allowedGuilds: readonly string[]; keepMs: number; now?: () => number }): DiscordWatch {
  const things = new LastThings({ keepMs: o.keepMs }, o.now);
  const lastText = new Map<string, string>();
  client.on(Events.MessageCreate, (m: Message) => {
    try {
      if (m.system) return;
      const dm = m.channel.type === ChannelType.DM;
      if (!dm && o.allowedGuilds.length && !o.allowedGuilds.includes(m.guildId ?? '')) return;
      const mine = m.author.id === client.user?.id;
      if (mine && m.guildId) {
        lastText.set(m.guildId, m.channelId);
        if (lastText.size > 50) lastText.delete(lastText.keys().next().value!);
      }
      const to = mine ? (m.mentions?.repliedUser?.id ?? (dm ? (m.channel as { recipientId?: string }).recipientId : undefined)) : undefined;
      noteMessage(
        things,
        {
          authorId: m.author.id,
          authorName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
          bot: m.author.bot,
          mine,
          text: `${m.content ?? ''} ${m.embeds.map((e) => e.url ?? '').join(' ')}`.trim(),
          hasAttachments: m.attachments.size > 0 || m.stickers.size > 0,
          ...(m.guildId ? { guildId: m.guildId } : {}),
          channelId: m.channelId,
          ...(to ? { to } : {}),
        },
        o.readable || dm,
      );
    } catch {
      /* a message it can't read is one it can't use */
    }
  });
  return { things, lastText: (g) => lastText.get(g) };
}

export interface PcDiscordOptions {
  client: Client;
  watch: DiscordWatch;
  allowedGuilds: readonly string[];
  homeGuild: string;
  presences: boolean;
  readable: boolean;
  /** Turn each feature on: the PC handoff needs satellites. */
  handoff: boolean;
  tellCall: { enabled: boolean; max: number; windowMinutes: number; maxChars: number; channelId?: string | undefined } | undefined;
  gameNight: { enabled: boolean; channelId?: string | undefined; optIn: string[]; cooldownMinutes: number; maxMentions: number; perUserPerHour: number } | undefined;
  stateFile?: string | undefined;
  starts: MusicStarts;
  callRoom: string;
  pcFor(ctx: ToolContext): PcLike | undefined;
  callMusic(): CallMusic | undefined;
  /** Where she is in voice. */
  spot(): { guildId: string; channelId: string } | undefined;
  voiceReady(): boolean;
  isOwner(id: UserId): boolean;
  inHerCall(id: UserId): boolean;
  nameOf(id: UserId): string;
  announce(id: UserId, text: string): Promise<boolean>;
  speakable?(text: string): string;
  findVideo?(q: string, signal: AbortSignal): Promise<string | undefined>;
}

/** The tools and their prompt lines. */
export function pcDiscordTools(o: PcDiscordOptions): { tools: Tool[]; rules: string[] } {
  const { client } = o;
  const guild = (id: string): Guild | undefined => client.guilds.cache.get(id);
  const voiceChannel = (): VoiceBasedChannel | undefined => {
    const s = o.spot();
    const ch = s ? client.channels.cache.get(s.channelId) : undefined;
    return ch?.isVoiceBased() ? (ch as VoiceBasedChannel) : undefined;
  };
  const humans = () => [...(voiceChannel()?.members.values() ?? [])].filter((m) => !m.user.bot).map((m) => m.id);
  const inCall = (id: UserId) => !!voiceChannel()?.members.has(id);
  const tools: Tool[] = [];
  const rules: string[] = [];

  if (o.handoff) {
    tools.push(
      ...handoffTools({
        things: o.watch.things,
        starts: o.starts,
        callRoom: o.callRoom,
        pcFor: o.pcFor,
        callMusic: o.callMusic,
        call: () => (o.spot() ? { ready: o.voiceReady(), humans: humans() } : undefined),
        inCall,
        isOwner: o.isOwner,
        canSee: async (userId, guildId, channelId) => {
          const g = guild(guildId);
          const ch = g?.channels.cache.get(channelId);
          const m = g ? await g.members.fetch(userId).catch(() => undefined) : undefined;
          return !!ch && !!m && canSee(m, ch);
        },
        homeGuild: o.homeGuild,
        readable: o.readable,
        ...(o.findVideo ? { findVideo: o.findVideo } : {}),
      }),
    );
    rules.push(HANDOFF_RULE);
  }

  const tc = o.tellCall;
  if (tc?.enabled) {
    tools.push(
      tellCallTool({
        nameOf: o.nameOf,
        inHerCall: o.inHerCall,
        call: () => {
          const s = o.spot();
          return s ? { ready: o.voiceReady(), guildId: s.guildId, channelId: s.channelId, humans: humans() } : undefined;
        },
        isMember: async (guildId, userId) => !!(await guild(guildId)?.members.fetch(userId).catch(() => undefined)),
        announce: o.announce,
        post: async (userId, ctx, text) => {
          const g = guild(o.spot()?.guildId ?? ctx.guildId ?? o.homeGuild);
          const asker = g ? await g.members.fetch(userId).catch(() => undefined) : undefined;
          if (!g || !asker) throw new Error("you're not in a server I'm in.");
          const where = pickTextChannel(g, asker, { configured: tc.channelId, current: ctx.guildId === g.id ? ctx.channelId : undefined, lastUsed: o.watch.lastText(g.id), voice: o.spot()?.guildId === g.id ? o.spot()!.channelId : undefined });
          if ('error' in where) throw new Error(where.error);
          await where.channel.send({ content: text, allowedMentions: { parse: [] } });
          return where.channel.name;
        },
        limiter: new WindowLimiter(tc.max, tc.windowMinutes * 60_000),
        maxChars: tc.maxChars,
        ...(o.speakable ? { speakable: o.speakable } : {}),
      }),
    );
  }

  const gn = o.gameNight;
  if (gn?.enabled) {
    tools.push(
      gameNightTool({
        guild,
        allowedGuilds: o.allowedGuilds,
        homeGuild: o.homeGuild,
        presences: o.presences,
        signups: new GameNightSignups(o.stateFile, gn.optIn),
        ...(gn.channelId ? { channelId: gn.channelId } : {}),
        lastText: o.watch.lastText,
        voiceChannel: (g) => (o.spot()?.guildId === g ? o.spot()!.channelId : undefined),
        cooldownMs: gn.cooldownMinutes * 60_000,
        maxMentions: gn.maxMentions,
        perUserPerHour: gn.perUserPerHour,
      }),
    );
    rules.push(GAME_NIGHT_RULE);
  }
  return { tools, rules };
}
