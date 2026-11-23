// /model list | which | use NAME | reset: the same switch as "use the smart
// model for this", by command. Registered only when brain.models lists more
// than one model and switching isn't off. Answers are private to the asker,
// and every rule (owners only, ownersOnly models) is the tool's own.

import { ApplicationIntegrationType, type Client, Events, InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Logger, Tool, UserId } from '../core/interfaces.js';
import type { ModelPicker } from '../brain/models.js';

export function modelCommands(picker: ModelPicker) {
  return [
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Which language model answers you')
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
      .addSubcommand((s) => s.setName('list').setDescription('The models there are'))
      .addSubcommand((s) => s.setName('which').setDescription('The model answering you now'))
      .addSubcommand((s) =>
        s
          .setName('use')
          .setDescription('Switch for a while (until you switch back or stop for half an hour)')
          .addStringOption((o) =>
            o
              .setName('name')
              .setDescription('Which one')
              .setRequired(true)
              .addChoices(...picker.models.slice(0, 25).map((m) => ({ name: m.about ? `${m.name}: ${m.about}`.slice(0, 100) : m.name, value: m.name }))),
          ),
      )
      .addSubcommand((s) => s.setName('reset').setDescription('Back to the usual model')),
  ].map((c) => c.toJSON());
}

export interface ModelCommandDeps {
  client: Client;
  log: Logger;
  /** The use_model tool: the command runs it, so the rules are the same. */
  tool: Tool;
  /** Someone an owner told her to ignore gets this instead. */
  ignored?(userId: UserId): string | undefined;
}

export function registerModelCommands(d: ModelCommandDeps): void {
  d.client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand() || i.commandName !== 'model') return;
    const no = d.ignored?.(i.user.id);
    const sub = i.options.getSubcommand();
    const run = async () => {
      const out = no ?? (await d.tool.run({ action: sub, ...(sub === 'use' ? { model: i.options.getString('name', true) } : {}) }, AbortSignal.timeout(5_000), { userId: i.user.id, speaker: i.user.displayName, ...(i.guildId ? { guildId: i.guildId } : {}), ...(i.channelId ? { channelId: i.channelId } : {}), text: true }));
      await i.reply({ content: typeof out === 'string' ? out : out.text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    };
    run().catch((e: unknown) => d.log.warn('model command failed', { error: (e as Error).message }));
  });
}
