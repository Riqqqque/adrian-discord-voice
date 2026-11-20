// Alarms outside her voice: /alarm, the Stop / Snooze buttons on her alarm
// messages, what each PC is told about its owner's alarms, and saving a
// sound from YouTube as an alarm sound.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { Logger, Tool, ToolContext, UserId } from '../core/interfaces.js';
import type { DecoderFactory, Track } from '../features/music.js';
import { TONES } from '../features/alarm-tones.js';
import { type AlarmClock, type SavedSound, clockText, LIMITS, localDate } from '../features/alarms.js';

// --- the PC's copy -----------------------------------------------------------------

/** How far ahead a PC keeps alarms to ring by itself (it's sent again every hour). */
const PC_AHEAD_MS = 8 * 24 * 3_600_000;

/** Sent to the owner's PCs on every change: what's ringing (for the buttons)
 *  and what's coming (to ring by itself if the server is gone at that time). */
export function alarmState(clock: AlarmClock, userId: UserId, now = Date.now()): Record<string, unknown> {
  const mine = clock.forUser(userId);
  const p = clock.prefs(userId);
  return {
    type: 'alarms',
    ringing: mine.filter((a) => a.ringingSince !== undefined).map((a) => ({ id: a.id, kind: a.kind, label: a.label, base: a.base })),
    list: mine
      // A skipped day isn't sent: the PC would ring it if the server were down.
      .filter((a) => a.enabled && a.ringingSince === undefined && a.at - now <= PC_AHEAD_MS && !(a.skip?.includes(localDate(a.base, a.tz)) && !a.snoozed))
      .map((a) => ({ id: a.id, kind: a.kind, label: a.label, at: a.at, base: a.base, sound: clock.soundOf(a) })),
    snoozeMin: p.snoozeMin,
    ringMin: p.ringMin,
    now,
  };
}

// --- buttons -------------------------------------------------------------------------

/** Stop / Snooze for one ring of one alarm: `alarm:<action>:<owner>:<alarm id>:<its base, base 36>`.
 *  An older message's buttons then can't stop what rings now. Messages sent
 *  before 0.17.2 carry only `alarm:<action>:<owner>`, and still work. */
export function alarmButtons(userId: UserId, ring?: { alarmId: string; base: number }): ActionRowBuilder<ButtonBuilder> {
  const tail = ring ? `:${ring.alarmId}:${ring.base.toString(36)}` : '';
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`alarm:stop:${userId}${tail}`).setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`alarm:snooze:${userId}${tail}`).setLabel('Snooze').setStyle(ButtonStyle.Secondary),
  );
}

/** What a button's custom id says. */
export function parseAlarmButton(id: string): { action: 'stop' | 'snooze'; owner: string; only?: { id: string; base?: number } } | undefined {
  const [kind, action, owner = '', alarmId, base] = id.split(':');
  if (kind !== 'alarm' || (action !== 'stop' && action !== 'snooze')) return undefined;
  const b = base !== undefined ? parseInt(base, 36) : undefined;
  return { action, owner, ...(alarmId ? { only: { id: alarmId, ...(b !== undefined && Number.isFinite(b) ? { base: b } : {}) } } : {}) };
}

// --- saving a clip -------------------------------------------------------------------

const CLIP_MAX_S = 30;

export async function saveClip(d: {
  find: (q: string, signal: AbortSignal) => Promise<Track | undefined>;
  decode: DecoderFactory;
  dir: string;
  clock: AlarmClock;
  userId: UserId;
  query: string;
  name: string;
  signal: AbortSignal;
  log: Logger;
}): Promise<SavedSound | string> {
  let t: Track | undefined;
  try {
    t = await d.find(d.query.slice(0, 80), d.signal);
  } catch (e) {
    d.log.warn('alarm sound search failed', { error: (e as Error).message.slice(0, 120) });
    return "YouTube didn't answer just now; try again in a minute.";
  }
  if (!t) return `Found no short "${d.query}" sound on YouTube.`;
  // 48 kHz stereo from ffmpeg, kept as 24 kHz mono: half a minute is 1.4 MB.
  if (d.signal.aborted) return 'That took too long.';
  let dec: ReturnType<DecoderFactory>;
  try {
    dec = d.decode({ url: t.ref });
  } catch (e) {
    d.log.warn('alarm sound decode failed', { error: (e as Error).message.slice(0, 120) });
    return "Couldn't read that sound.";
  }
  const want = CLIP_MAX_S * 48_000 * 4;
  const parts: Buffer[] = [];
  let got = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => (dec.kill(), resolve());
      d.signal.addEventListener('abort', () => (dec.kill(), reject(new Error('aborted'))), { once: true });
      dec.pcm.on('data', (b: Buffer) => {
        parts.push(b);
        got += b.length;
        if (got >= want) stop();
      });
      dec.pcm.on('end', () => resolve());
      // An ffmpeg that never started closes its output with no end and no error.
      dec.pcm.on('close', () => resolve());
      dec.pcm.on('error', (e) => reject(e));
    });
  } catch (e) {
    return (e as Error).message === 'aborted' ? 'That took too long.' : "Couldn't read that sound.";
  }
  // Not a byte: ffmpeg couldn't open or decode it.
  if (!got) return "Couldn't read that sound.";
  const pcm = Buffer.concat(parts).subarray(0, Math.min(got, want));
  const frames = Math.floor(pcm.length / 8); // two stereo frames → one mono sample
  if (frames < 24_000 / 4) return 'That sound came out empty; try another.';
  const out = new Int16Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const o = i * 8;
    const v = (pcm.readInt16LE(o) + pcm.readInt16LE(o + 2) + pcm.readInt16LE(o + 4) + pcm.readInt16LE(o + 6)) / 4;
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  // Silence, or a hiss under -50 dB, would ring as nothing at all once raised.
  if (peak < 100) return 'That sound came out empty; try another.';
  // Leading and trailing silence off, and the same peak as the built-in tones.
  let a = 0;
  let b = frames;
  while (a < b && Math.abs(out[a]!) < peak * 0.02) a++;
  while (b > a && Math.abs(out[b - 1]!) < peak * 0.02) b--;
  if (b - a < 24_000 / 4) return 'That sound came out empty; try another.';
  const k = (0.5 * 32767) / peak;
  const trimmed = Int16Array.from(out.subarray(a, b), (v) => Math.round(v * k));
  const file = `${randomUUID().slice(0, 12)}.pcm`;
  try {
    mkdirSync(d.dir, { recursive: true, mode: 0o750 });
    writeFileSync(join(d.dir, file), Buffer.from(trimmed.buffer, trimmed.byteOffset, trimmed.byteLength), { mode: 0o640 });
  } catch (e) {
    // A full disk can leave part of the file behind.
    rmSync(join(d.dir, file), { force: true });
    d.log.warn('alarm sound save failed', { error: (e as Error).message });
    return "Couldn't save it on the server.";
  }
  const s: SavedSound = { name: d.name, owner: d.userId, file, seconds: trimmed.length / 24_000, ...(t.title ? { title: t.title.slice(0, 100) } : {}) };
  d.clock.addSound(s);
  d.log.info('alarm sound saved', { user: d.userId, seconds: Math.round(s.seconds) });
  return s;
}

// --- /alarm --------------------------------------------------------------------------

const both = <T extends SlashCommandBuilder>(b: T) =>
  b.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

const REPEATS = [
  ['once', 'Once'],
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekends', 'Weekends'],
] as const;

export const ALARM_COMMANDS = [
  both(new SlashCommandBuilder().setName('alarm').setDescription('Alarms and timers that ring'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set an alarm')
        .addStringOption((o) => o.setName('time').setDescription('e.g. 7:00, 6:30am, 18:45').setRequired(true).setMaxLength(12))
        .addStringOption((o) => o.setName('repeat').setDescription('How often').addChoices(...REPEATS.map(([value, name]) => ({ name, value }))))
        .addStringOption((o) => o.setName('days').setDescription('Or exact days, e.g. mon,wed,fri').setMaxLength(60))
        .addStringOption((o) => o.setName('date').setDescription('A date for a one-off, YYYY-MM-DD').setMaxLength(10))
        .addStringOption((o) => o.setName('label').setDescription('What it is for').setMaxLength(80))
        .addStringOption((o) => o.setName('sound').setDescription('Which sound').setAutocomplete(true).setMaxLength(40)),
    )
    .addSubcommand((s) =>
      s
        .setName('timer')
        .setDescription('Start a timer')
        .addNumberOption((o) => o.setName('minutes').setDescription('How long').setRequired(true).setMinValue(0.1).setMaxValue(10_080))
        .addStringOption((o) => o.setName('label').setDescription('What it is for').setMaxLength(80))
        .addStringOption((o) => o.setName('sound').setDescription('Which sound').setAutocomplete(true).setMaxLength(40)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Your alarms, timers and reminders'))
    .addSubcommand((s) => s.setName('stop').setDescription('Turn off what is ringing'))
    .addSubcommand((s) =>
      s
        .setName('snooze')
        .setDescription('Snooze what is ringing')
        .addIntegerOption((o) => o.setName('minutes').setDescription('How long (default: your snooze)').setMinValue(LIMITS.snoozeMin[0]).setMaxValue(LIMITS.snoozeMin[1])),
    )
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Delete an alarm or timer')
        .addStringOption((o) => o.setName('which').setDescription('Which one').setRequired(true).setAutocomplete(true).setMaxLength(40)),
    )
    .addSubcommand((s) =>
      s
        .setName('off')
        .setDescription('Turn an alarm off or back on without deleting it')
        .addStringOption((o) => o.setName('which').setDescription('Which one').setRequired(true).setAutocomplete(true).setMaxLength(40))
        .addBooleanOption((o) => o.setName('on').setDescription('True turns it back on')),
    )
    .addSubcommand((s) =>
      s
        .setName('skip')
        .setDescription('Skip only the next time a repeating alarm rings')
        .addStringOption((o) => o.setName('which').setDescription('Which one').setRequired(true).setAutocomplete(true).setMaxLength(40)),
    )
    .addSubcommand((s) => s.setName('sounds').setDescription('The alarm sounds you can pick'))
    .addSubcommand((s) =>
      s
        .setName('settings')
        .setDescription('Your alarm settings (leave everything empty to see them)')
        .addStringOption((o) => o.setName('sound').setDescription('Default alarm sound').setAutocomplete(true).setMaxLength(40))
        .addStringOption((o) => o.setName('timer_sound').setDescription('Default timer sound').setAutocomplete(true).setMaxLength(40))
        .addIntegerOption((o) => o.setName('snooze').setDescription('Snooze minutes').setMinValue(LIMITS.snoozeMin[0]).setMaxValue(LIMITS.snoozeMin[1]))
        .addIntegerOption((o) => o.setName('ring').setDescription('Minutes one ring lasts').setMinValue(LIMITS.ringMin[0]).setMaxValue(LIMITS.ringMin[1]))
        .addIntegerOption((o) => o.setName('fade_in').setDescription('Seconds to rise to full volume (0 = at once)').setMinValue(LIMITS.fadeIn[0]).setMaxValue(LIMITS.fadeIn[1]))
        .addIntegerOption((o) => o.setName('volume').setDescription('Percent').setMinValue(10).setMaxValue(100))
        .addStringOption((o) =>
          o
            .setName('turn_off_by')
            .setDescription('What turns an alarm off')
            .addChoices({ name: 'Saying stop', value: 'stop' }, { name: 'Saying "I\'m up" (stop only snoozes)', value: 'firm' }, { name: 'Answering a sum', value: 'math' }),
        )
        .addBooleanOption((o) => o.setName('voice').setDescription('She says the time while it rings'))
        .addStringOption((o) => o.setName('timezone').setDescription('e.g. America/New_York').setMaxLength(40)),
    ),
];

export interface AlarmCommandDeps {
  client: Client;
  log: Logger;
  clock: AlarmClock;
  /** The model's alarm tools, so typed and spoken requests behave the same. */
  tools: readonly Tool[];
  name: (userId: UserId) => string;
  isOwner: (userId: UserId) => boolean;
  /** Something they did here should be said where it rings (Stop from a phone while the PC rings). */
  said?: (userId: UserId, text: string) => void;
}

/** The tools answer the model ("ask what time", "they have"); /alarm shows the
 *  same words to the person, so they're turned to face them. */
export function forPerson(raw: string): string {
  return raw
    .replace(/ \[id [\w-]+\]/g, '')
    .replace(/ \(Note: saving to disk failed[^)]*\)/, ' Saving it to disk failed just now, so it may not survive a restart.')
    .replace(/ \(Note:.*\)$/, '')
    .replace(/; ask what time\./, '. Try a time like 7:00, 6:30am or 18:45.')
    .replace(/; ask which days\./, '. Use daily, weekdays, weekends, or days like mon,wed,fri.')
    .replace(/ Tell them to say stop or snooze; it can be (.+?) after that\./, ' Stop or snooze it first; it can be $1 after that.')
    .replace(/\bThey have\b/g, 'You have')
    .replace(/\bTheir\b/g, 'Your')
    .replace(/\bthey are in neither\b/g, "you're in neither")
    .trim();
}

export function registerAlarmCommands(d: AlarmCommandDeps): void {
  const tool = (n: string) => d.tools.find((t) => t.spec.name === n);
  const run = async (n: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
    const t = tool(n);
    if (!t) return "Alarms aren't available right now.";
    const raw = await t.run(args, AbortSignal.timeout(40_000), ctx);
    const text = typeof raw === 'string' ? raw : raw.text;
    return forPerson(t.speak?.(args, text, ctx) || text);
  };

  const sounds = (userId: UserId, typed: string) => {
    const mine = d.clock.sounds(userId).map((s) => ({ name: `${s.name} (saved)`, value: s.name }));
    const all = [...TONES.map((t) => ({ name: `${t.name}: ${t.about}`.slice(0, 100), value: t.name })), { name: 'voice: she says the time, with soft chimes', value: 'voice' }, ...mine];
    const q = typed.toLowerCase();
    return all.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, 25);
  };

  const which = (userId: UserId, typed: string) => {
    const q = typed.toLowerCase();
    return d.clock
      .forUser(userId)
      .map((a) => ({ name: `${a.kind === 'timer' ? 'Timer' : 'Alarm'} ${clockText(a.at, a.tz)}${a.label ? `: ${a.label}` : ''}${a.enabled ? '' : ' (off)'}`.slice(0, 100), value: a.id }))
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .slice(0, 25);
  };

  const complete = async (i: AutocompleteInteraction) => {
    const f = i.options.getFocused(true);
    const list = f.name === 'which' ? which(i.user.id, f.value) : sounds(i.user.id, f.value);
    await i.respond(list).catch(() => undefined);
  };

  const slash = async (i: ChatInputCommandInteraction) => {
    const u = i.user.id;
    const ctx: ToolContext = { userId: u, speaker: d.name(u), text: true, ...(i.guildId ? { guildId: i.guildId } : {}) };
    const o = i.options;
    const sub = o.getSubcommand();
    let out: string;
    switch (sub) {
      case 'set':
        // set_alarm drops a date once there's a repeat: say so instead.
        if (o.getString('date') && (o.getString('days') || (o.getString('repeat') && o.getString('repeat') !== 'once'))) {
          out = 'Give a date for a one-off, or repeat or days for one that repeats, not both.';
          break;
        }
        out = await run(
          'set_alarm',
          {
            time: o.getString('time', true),
            ...(o.getString('days') ? { repeat: o.getString('days') } : o.getString('repeat') && o.getString('repeat') !== 'once' ? { repeat: o.getString('repeat') } : {}),
            ...(o.getString('date') ? { date: o.getString('date') } : {}),
            ...(o.getString('label') ? { label: o.getString('label') } : {}),
            ...(o.getString('sound') ? { sound: o.getString('sound') } : {}),
          },
          ctx,
        );
        break;
      case 'timer':
        out = await run('set_timer', { minutes: o.getNumber('minutes', true), ...(o.getString('label') ? { label: o.getString('label') } : {}), ...(o.getString('sound') ? { sound: o.getString('sound') } : {}) }, ctx);
        break;
      case 'list':
        out = await run('list_timers', {}, ctx);
        break;
      case 'stop':
      case 'snooze': {
        const r = d.clock.control(u, sub, o.getInteger('minutes') ?? undefined, { typed: true });
        if (r.done) d.said?.(u, r.say);
        out = r.say;
        break;
      }
      case 'delete': {
        // Picked by hand from the list: no "are you sure" needed.
        const id = o.getString('which', true);
        const a = d.clock.forUser(u).find((x) => x.id === id);
        if (!a) {
          out = 'No alarm or timer like that. Pick one from the list.';
          break;
        }
        // Not a stop: a snooze right after must not bring it back.
        d.clock.unring(a);
        d.clock.remove([a.id]);
        out = `Deleted your ${a.kind === 'timer' ? 'timer' : `${clockText(a.base, a.tz)} alarm`}${a.label ? ` (${a.label})` : ''}.`;
        break;
      }
      case 'off':
        out = await run('edit_alarm', { which: o.getString('which', true), on: o.getBoolean('on') ?? false }, ctx);
        break;
      case 'skip':
        out = await run('edit_alarm', { which: o.getString('which', true), skip_next: true }, ctx);
        break;
      case 'sounds':
        out = await run('alarm_options', { action: 'sounds' }, ctx);
        break;
      case 'settings': {
        const set: Record<string, unknown> = {};
        if (o.getString('sound')) set.default_sound = o.getString('sound');
        if (o.getString('timer_sound')) set.timer_sound = o.getString('timer_sound');
        if (o.getInteger('snooze') !== null) set.snooze_minutes = o.getInteger('snooze');
        if (o.getInteger('ring') !== null) set.ring_minutes = o.getInteger('ring');
        if (o.getInteger('fade_in') !== null) set.fade_in_seconds = o.getInteger('fade_in');
        if (o.getInteger('volume') !== null) set.volume = o.getInteger('volume');
        if (o.getString('turn_off_by')) set.dismiss = o.getString('turn_off_by');
        if (o.getBoolean('voice') !== null) set.voice = o.getBoolean('voice');
        if (o.getString('timezone')) set.timezone = o.getString('timezone');
        out = await run('alarm_options', Object.keys(set).length ? { action: 'set', ...set } : { action: 'settings' }, ctx);
        break;
      }
      default:
        out = 'Unknown command.';
    }
    await i.reply({ content: out.slice(0, 1900), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  };

  const button = async (i: ButtonInteraction) => {
    const b = parseAlarmButton(i.customId);
    if (!b) return;
    const { action, owner, only } = b;
    if (i.user.id !== owner && !d.isOwner(i.user.id)) {
      await i.reply({ content: "That's someone else's alarm.", flags: MessageFlags.Ephemeral });
      return;
    }
    const r = d.clock.control(owner, action, undefined, { typed: true, ...(only ? { only } : {}) });
    d.log.info('alarm button', { user: i.user.id, for: owner, action, done: r.done });
    if (r.done) {
      d.said?.(owner, r.say);
      // The message keeps what it said, without the buttons, plus what happened.
      await i.update({ content: `${i.message.content}\n→ ${r.say}`.slice(0, 1900), components: [] });
      return;
    }
    // Still waiting out a snooze: the buttons stay for later.
    if (only && d.clock.forUser(owner).some((a) => a.id === only.id && (only.base === undefined || a.base === only.base))) {
      await i.reply({ content: r.say, flags: MessageFlags.Ephemeral });
      return;
    }
    // Over already (a second press, or stopped some other way): the buttons go,
    // and the text stays as it is, which may already say how it ended.
    await i.update({ components: [] });
    await i.followUp({ content: r.say, flags: MessageFlags.Ephemeral });
  };

  d.client.on(Events.InteractionCreate, (i) => {
    const name = 'commandName' in i ? i.commandName : undefined;
    const custom = 'customId' in i ? i.customId : undefined;
    if (name !== 'alarm' && !custom?.startsWith('alarm:')) return;
    let p: Promise<void> | undefined;
    if (i.isAutocomplete()) p = complete(i);
    else if (i.isChatInputCommand()) p = slash(i);
    else if (i.isButton()) p = button(i);
    p?.catch(async (e: unknown) => {
      d.log.warn('alarm command failed', { error: (e as Error).message });
      if (!i.isRepliable()) return;
      const sorry = { content: "Sorry, that didn't work.", flags: MessageFlags.Ephemeral } as const;
      // A button's answer is its own message: never write over that.
      await (i.replied || i.deferred ? (i.isButton() ? i.followUp(sorry) : i.editReply({ content: sorry.content })) : i.reply(sorry)).catch(() => undefined);
    });
  });
}
