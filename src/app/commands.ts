// Slash commands: /join brings A.D.R.I.A.N. into the caller's voice channel
// (in any server the bot has been added to), /leave takes it out. One call
// at a time: the bot won't be pulled out of a call where other people are,
// except by the app owner.

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
  moveTo(spot: VoiceSpot): Promise<void>;
  leave(): Promise<void>;
  /** Servers where /join works; empty: any server the bot is in. */
  allowedGuilds?: readonly string[];
}

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

export function registerVoiceCommands(d: CommandDeps): { ownerId(): string | undefined } {
  const { client, log } = d;
  let ownerId: string | undefined;

  client.once(Events.ClientReady, async (c) => {
    try {
      await c.application.commands.set(COMMANDS);
      const app = await c.application.fetch();
      ownerId = app.owner && 'ownerId' in app.owner ? (app.owner.ownerId ?? undefined) : app.owner?.id;
      log.info('slash commands ready', { commands: COMMANDS.map((x) => x.name), guilds: c.guilds.cache.size });
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

  async function join(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    if (d.allowedGuilds?.length && !d.allowedGuilds.includes(i.guildId)) {
      await i.reply({ content: "I'm not set up to join calls in this server.", flags: MessageFlags.Ephemeral });
      return;
    }
    const ch = i.guild.voiceStates.cache.get(i.user.id)?.channel;
    if (!ch) {
      await i.reply({ content: 'Join a voice channel first, then use /join.', flags: MessageFlags.Ephemeral });
      return;
    }
    const me = i.guild.members.me;
    const perms = me ? ch.permissionsFor(me) : null;
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
    if (!perms || !perms.has(need)) {
      await i.reply({ content: `I don't have permission to connect and speak in ${ch.name}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const cur = d.current();
    if (cur?.guildId === i.guildId && cur.channelId === ch.id) {
      await i.reply({ content: `I'm already here. Say "Hey Adrian" to talk to me.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (cur && i.user.id !== ownerId) {
      const busy = humansIn(client.channels.cache.get(cur.channelId) as VoiceBasedChannel | undefined, i.user.id);
      if (busy > 0) {
        const where = cur.guildId === i.guildId ? 'another channel here' : 'a call in another server';
        await i.reply({ content: `I'm in ${where} right now. Try again when that call is over.`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    await i.deferReply();
    log.info('join requested', { user: i.user.id, guildId: i.guildId, channelId: ch.id });
    await d.moveTo({ guildId: i.guildId, channelId: ch.id });
    await i.editReply(`Joined ${ch.name}. Say "Hey Adrian" and ask me anything.`);
  }

  async function leave(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const cur = d.current();
    if (!cur || cur.guildId !== i.guildId) {
      await i.reply({ content: "I'm not in a voice channel in this server.", flags: MessageFlags.Ephemeral });
      return;
    }
    log.info('leave requested', { user: i.user.id, guildId: i.guildId });
    await i.deferReply();
    await d.leave();
    await i.editReply('Left the voice channel. Use /join to bring me back.');
  }

  return { ownerId: () => ownerId };
}
