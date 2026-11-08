// Which text channel she posts in when a feature needs one (a message for the
// call when nobody's in it, game-night pings): the configured one, else the
// chat it's asked from, else the one she last wrote in, else the voice
// channel's own chat, else the server's system channel. Each must be one the
// asker can see and both can post in.

import { ChannelType, type Guild, type GuildBasedChannel, type GuildMember, PermissionFlagsBits } from 'discord.js';

export type PostableChannel = GuildBasedChannel & { send(o: object): Promise<unknown> };

/** What Discord would show them: a private thread only to its members and moderators. */
export function canSee(m: GuildMember, ch: GuildBasedChannel): boolean {
  const perms = ch.permissionsFor(m);
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) return false;
  return ch.type !== ChannelType.PrivateThread || ch.ownerId === m.id || ch.members.cache.has(m.id) || perms.has(PermissionFlagsBits.ManageThreads);
}

/** They can see it and write in it. */
export function canPost(m: GuildMember | null | undefined, ch: GuildBasedChannel): boolean {
  if (!m || !canSee(m, ch)) return false;
  const post = ch.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  return !!ch.permissionsFor(m)?.has(post);
}

export interface ChannelChoice {
  /** Set in the config: only this one, or an error saying why not. */
  configured?: string | undefined;
  /** Where the request came from (a text chat), if in this server. */
  current?: string | undefined;
  /** Where she last wrote in this server. */
  lastUsed?: string | undefined;
  /** The voice channel she's in: it has a chat of its own. */
  voice?: string | undefined;
}

/** The channel to post in, or why there's none. */
export function pickTextChannel(guild: Guild, asker: GuildMember, c: ChannelChoice): { channel: PostableChannel } | { error: string } {
  const me = guild.members.me;
  const usable = (id: string | undefined): PostableChannel | undefined => {
    const ch = id ? guild.channels.cache.get(id) : undefined;
    if (!ch || !ch.isTextBased()) return undefined;
    return canPost(me, ch) && canSee(asker, ch) ? (ch as PostableChannel) : undefined;
  };
  if (c.configured) {
    const ch = usable(c.configured);
    return ch ? { channel: ch } : { error: "I can't post in the channel set for this, or you can't see it." };
  }
  for (const id of [c.current, c.lastUsed, c.voice, guild.systemChannelId ?? undefined]) {
    const ch = usable(id);
    if (ch) return { channel: ch };
  }
  return { error: "I don't have a text channel here that we can both use." };
}

/** Text that can't ping, link or style anything: mentions and links become
 *  words, @everyone and @here are broken, markdown is plain. */
export function plainText(text: string, maxChars: number): string {
  return text
    .replace(/<@[!&]?\d+>/g, '@someone')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/https?:\/\/[^\s<>"]+/gi, (u) => {
      try {
        return `(a link to ${new URL(u).hostname.replace(/^www\./, '')})`;
      } catch {
        return '(a link)';
      }
    })
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '​' ? ch : ' '))
    .replace(/[*_~`|>[\]\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}
