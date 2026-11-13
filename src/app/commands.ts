// Slash commands: /join brings A.D.R.I.A.N. into the caller's voice channel
// (in any server the bot has been added to), /leave takes it out. One call
// at a time: nobody outside a call with other people in it can pull the bot
// out of it, except the app owner.

import {
  ApplicationIntegrationType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type VoiceBasedChannel,
} from 'discord.js';
import type { Logger } from '../core/interfaces.js';

export interface VoiceSpot {
  guildId: string;
  channelId: string;
}

export interface CommandDeps {
  client: Client;
  log: Logger;
  /** Where the bot is now (undefined: not in voice). */
  current(): VoiceSpot | undefined;
  /** The voice link works right now. Not given: taken as working. */
  voiceReady?(): boolean;
  moveTo(spot: VoiceSpot): Promise<void>;
  leave(): Promise<void>;
  /** Servers where /join works; empty: any server the bot is in. */
  allowedGuilds?: readonly string[];
  /** More slash commands to register with these (Discord replaces the whole set at once). */
  extraCommands?: readonly object[];
}

/** Where someone's command would take her: refused (and why), already in
 *  their call, or a move to it. */
export type Seat = { refused: string } | { here: VoiceBasedChannel } | { move: VoiceSpot; channel: VoiceBasedChannel };

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Bring A.D.R.I.A.N. into your voice channel')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect A.D.R.I.A.N. from voice')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall),
].map((c) => c.toJSON());

/** People (not bots) in a voice channel, optionally ignoring one user. */
export function humansIn(ch: VoiceBasedChannel | null | undefined, except?: string): number {
  if (!ch) return 0;
  return ch.members.filter((m) => !m.user.bot && m.id !== except).size;
}

export function registerVoiceCommands(d: CommandDeps): { ownerId(): string | undefined; seat(i: ChatInputCommandInteraction<'cached'>, verb: string): Seat } {
  const { client, log } = d;
  let ownerId: string | undefined;

  client.once(Events.ClientReady, async (c) => {
    try {
      await c.application.commands.set([...COMMANDS, ...(d.extraCommands ?? [])] as typeof COMMANDS);
      const app = await c.application.fetch();
      ownerId = app.owner && 'ownerId' in app.owner ? (app.owner.ownerId ?? undefined) : app.owner?.id;
      log.info('slash commands ready', { commands: [...COMMANDS, ...((d.extraCommands ?? []) as { name?: string }[])].map((x) => x.name), guilds: c.guilds.cache.size });
    } catch (e) {
      log.error('slash command registration failed', { error: (e as Error).message });
    }
  });
  client.on(Events.GuildCreate, (g) => log.info('added to a server', { guildId: g.id, members: g.memberCount }));
  client.on(Events.GuildDelete, (g) => log.info('removed from a server', { guildId: g.id }));

  client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand() || !i.inCachedGuild()) return;
    const run = i.commandName === 'join' ? join(i) : i.commandName === 'leave' ? leave(i) : undefined;
    run?.catch(async (e: unknown) => {
      log.warn('command failed', { command: i.commandName, error: (e as Error).message });
      const msg = { content: "Sorry, that didn't work. Try again in a moment.", flags: MessageFlags.Ephemeral } as const;
      await (i.deferred || i.replied ? i.editReply(msg.content) : i.reply(msg)).catch(() => undefined);
    });
  });

  /** Discord still has her in that channel, whatever the link is doing. */
  const seatedIn = (s: VoiceSpot) => client.guilds.cache.get(s.guildId)?.voiceStates.cache.get(client.user?.id ?? '')?.channelId === s.channelId;
  /** People in the call she'd be pulled out of, leaving out `userId`. She stays
   *  through a drop, but a spot with no call behind it protects nobody. */
  const peopleAt = (s: VoiceSpot, userId: string) =>
    userId !== ownerId && ((d.voiceReady?.() ?? true) || seatedIn(s)) ? humansIn(client.channels.cache.get(s.channelId) as VoiceBasedChannel | undefined, userId) : 0;

  /** The checks /join makes, for any command that brings her into the caller's call. */
  function seat(i: ChatInputCommandInteraction<'cached'>, verb: string): Seat {
    if (d.allowedGuilds?.length && !d.allowedGuilds.includes(i.guildId)) return { refused: "I'm not set up to join calls in this server." };
    const ch = i.guild.voiceStates.cache.get(i.user.id)?.channel;
    if (!ch) return { refused: `Join a voice channel first, then use ${verb}.` };
    const me = i.guild.members.me;
    const perms = me ? ch.permissionsFor(me) : null;
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
    if (!perms || !perms.has(need)) return { refused: `I don't have permission to connect and speak in ${ch.name}.` };
    const cur = d.current();
    const here = cur?.guildId === i.guildId && cur.channelId === ch.id;
    if (here && (d.voiceReady?.() ?? true)) return { here: ch };
    // Asked from the call she's lost: moveTo rebuilds it.
    if (cur && !here && peopleAt(cur, i.user.id) > 0) {
      const where = cur.guildId === i.guildId ? 'another channel here' : 'a call in another server';
      return { refused: `I'm in ${where} right now. Try again when that call is over.` };
    }
    return { move: { guildId: i.guildId, channelId: ch.id }, channel: ch };
  }

  async function join(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const s = seat(i, '/join');
    if ('refused' in s) {
      await i.reply({ content: s.refused, flags: MessageFlags.Ephemeral });
      return;
    }
    if ('here' in s) {
      await i.reply({ content: `I'm already here. Say "Hey Adrian" to talk to me.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.deferReply();
    log.info('join requested', { user: i.user.id, guildId: i.guildId, channelId: s.channel.id });
    await d.moveTo(s.move);
    await i.editReply(`Joined ${s.channel.name}. Say "Hey Adrian" and ask me anything.`);
  }

  async function leave(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const cur = d.current();
    if (!cur || cur.guildId !== i.guildId) {
      await i.reply({ content: "I'm not in a voice channel in this server.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.guild.voiceStates.cache.get(i.user.id)?.channel?.id !== cur.channelId && peopleAt(cur, i.user.id) > 0) {
      await i.reply({ content: "I'm in a call with other people right now. Try again when it's over.", flags: MessageFlags.Ephemeral });
      return;
    }
    log.info('leave requested', { user: i.user.id, guildId: i.guildId });
    await i.deferReply();
    await d.leave();
    await i.editReply('Left the voice channel. Use /join to bring me back.');
  }

  return { ownerId: () => ownerId, seat };
}
