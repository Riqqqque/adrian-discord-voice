// Music commands: /play and /music (now, queue, skip, back, pause, resume,
// stop, volume, shuffle, clear, remove, autoplay, who), the same typed with a
// prefix ("!play x", or "@A.D.R.I.A.N. !play x" without the Message Content
// intent), !join and !leave, and buttons on the now-playing card. They drive
// the same player as "Hey Adrian, play ...": the Discord call's. Playing from a
// voice channel she isn't in brings her there (by /join's rules). Changing the
// music takes being in her call (owners may from anywhere); looking at it only
// takes being in that server.

import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  type AutocompleteInteraction,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  escapeMarkdown,
  Events,
  InteractionContextType,
  type Message,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { Logger } from '../core/interfaces.js';
import { describe as trackName, type MusicPlayer, type RequestKind, type RequestResult, type Track } from '../features/music.js';
import { parseMediaLink } from '../features/links.js';
import type { MusicTaste } from '../features/taste.js';
import type { Asking, Seat, VoiceSpot } from './commands.js';

/** What /play's type option offers; auto lets her work it out like a spoken "play X". */
export const PLAY_TYPES = [
  ['auto', 'Work it out (a song, or an artist’s top songs)'],
  ['song', 'One song'],
  ['artist', 'An artist: their best-known songs, shuffled'],
  ['album', 'An album'],
  ['playlist', 'A playlist'],
  ['vibe', 'A mood or genre, like "chill late night r&b"'],
  ['similar', 'Songs like what’s playing (or like what you type)'],
  ['podcast', 'A podcast or episode'],
  ['video', 'Any YouTube audio: a mix, rain sounds, a live stream'],
  ['favorites', 'Music you like (from what you’ve played)'],
  ['hers', 'Music A.D.R.I.A.N. likes'],
] as const;
export type PlayType = (typeof PLAY_TYPES)[number][0];

const KINDS: readonly RequestKind[] = ['song', 'artist', 'album', 'playlist', 'vibe', 'similar', 'podcast', 'video'];
/** Types that need nothing typed. */
const NO_QUERY: readonly PlayType[] = ['similar', 'favorites', 'hers'];

const guildOnly = <T extends SlashCommandBuilder>(b: T) => b.setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

export const MUSIC_COMMANDS = [
  guildOnly(new SlashCommandBuilder().setName('play').setDescription('Play music in the voice call'))
    .addStringOption((o) => o.setName('query').setDescription('A song, artist, album, mood, or a YouTube/Spotify/SoundCloud/Bandcamp link').setMaxLength(500).setAutocomplete(true))
    .addStringOption((o) => o.setName('type').setDescription('What it is (default: work it out)').addChoices(...PLAY_TYPES.map(([value, name]) => ({ name, value }))))
    .addBooleanOption((o) => o.setName('queue').setDescription('Add it to the queue instead of playing it now'))
    .addStringOption((o) => o.setName('source').setDescription('Where to look (default: YouTube Music, then Plex)').addChoices({ name: 'YouTube Music', value: 'youtube' }, { name: 'Plex library', value: 'plex' }))
    .toJSON(),
  guildOnly(new SlashCommandBuilder().setName('music').setDescription('Control the music in the voice call'))
    .addSubcommand((s) => s.setName('now').setDescription("What's playing, with buttons"))
    .addSubcommand((s) =>
      s
        .setName('queue')
        .setDescription("What's coming up")
        .addIntegerOption((o) => o.setName('page').setDescription('Page (10 songs each)').setMinValue(1).setMaxValue(10)),
    )
    .addSubcommand((s) =>
      s
        .setName('skip')
        .setDescription('Skip this song')
        .addIntegerOption((o) => o.setName('to').setDescription('Skip ahead to this queue position').setMinValue(1).setMaxValue(100)),
    )
    .addSubcommand((s) => s.setName('back').setDescription('Play the song before this one again'))
    .addSubcommand((s) => s.setName('pause').setDescription('Pause the music'))
    .addSubcommand((s) => s.setName('resume').setDescription('Resume the music'))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the music and clear the queue'))
    .addSubcommand((s) =>
      s
        .setName('volume')
        .setDescription('Show or set the music volume')
        .addIntegerOption((o) => o.setName('level').setDescription('Percent, 5-100').setMinValue(5).setMaxValue(100)),
    )
    .addSubcommand((s) => s.setName('shuffle').setDescription('Shuffle the queue'))
    .addSubcommand((s) => s.setName('clear').setDescription('Clear the queue (the song playing keeps going)'))
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Take a song out of the queue')
        .addIntegerOption((o) => o.setName('position').setDescription('Its place in /music queue').setRequired(true).setMinValue(1).setMaxValue(100)),
    )
    .addSubcommand((s) =>
      s
        .setName('autoplay')
        .setDescription('Keep similar songs coming when the queue runs out')
        .addBooleanOption((o) => o.setName('on').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('who').setDescription('Who asked for this song'))
    .toJSON(),
];

export interface MusicCommandDeps {
  client: Client;
  log: Logger;
  /** The Discord call's player (undefined: music is off). */
  player(): MusicPlayer | undefined;
  /** Where she is now. */
  current(): VoiceSpot | undefined;
  /** /join's checks, for a play from someone she isn't with yet. */
  seat(i: Asking, verb: string): Seat;
  /** /leave's checks, for !leave. */
  mayLeave(i: Asking): string | undefined;
  moveTo(spot: VoiceSpot): Promise<void>;
  leave(): Promise<void>;
  isOwner(userId: string): boolean;
  /** The voice link works right now. */
  voiceReady(): boolean;
  /** The hourly limit: what to tell them if they've asked for too much, else
   *  undefined (and this request is counted). */
  allow(userId: string): string | undefined;
  nameOf(userId: string): string;
  taste?: MusicTaste;
  /** Someone's request started the music (the PC handoff wants to know whose it is). */
  started?(userId: string): void;
  /** What starts a typed command ("!play x"); empty: typed commands are off. */
  prefix: string;
  /** Servers where commands work; empty: any. */
  allowedGuilds?: readonly string[];
}

const NO_MUSIC = "Music isn't set up on this bot.";
const JOIN_ME = 'Join my voice channel to change the music.';
/** How long a play may look things up (an album or podcast takes 5-8 s). */
const PLAY_TIMEOUT_MS = 60_000;
const PAGE = 10;

/** Text from uploaders and names, safe in a message: no markdown (masked links
 *  and headings too), no mentions, capped before escaping so no escape is cut in half. */
export const safe = (s: string, max = 100) =>
  escapeMarkdown(s.slice(0, max).replace(/[@#<>]/g, (c) => `${c}\u200b`), { maskedLink: true, heading: true, bulletedList: true, numberedList: true });

const length = (s?: number) => (s && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : undefined);
const songs = (n: number) => `${n} song${n === 1 ? '' : 's'}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const link = (t: Track) => (t.source === 'youtube' && t.id ? `https://music.youtube.com/watch?v=${t.id}` : undefined);
/** One line for a track: "**Title** by Artist (3:45)". */
export function trackLine(t: Track): string {
  const len = length(t.durationS);
  return `**${safe(t.title, 90)}**${t.artist ? ` by ${safe(t.artist, 60)}` : ''}${len ? ` (${len})` : ''}`;
}

/** The now-playing card. */
export function nowCard(p: MusicPlayer): EmbedBuilder {
  const t = p.nowPlaying;
  const e = new EmbedBuilder().setColor(0x8ab4f8);
  if (!t) {
    return e
      .setTitle(p.lent ? 'A music quiz has the music' : 'Nothing playing')
      .setDescription(p.lent ? 'The songs stay secret until the round ends.' : 'Use /play to start something.');
  }
  e.setTitle(p.paused ? 'Paused' : 'Now playing').setDescription(trackLine(t));
  const url = link(t);
  if (url) e.setURL(url).setThumbnail(`https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`);
  const next = p.upNext[0];
  e.addFields(
    { name: 'Asked by', value: t.by ? safe(t.by, 60) : t.auto ? 'Autoplay' : '—', inline: true },
    { name: 'Volume', value: pct(p.level), inline: true },
    { name: 'Autoplay', value: p.autoplay ? 'On' : 'Off', inline: true },
    { name: 'Up next', value: next ? `${trackLine(next)}${p.upNext.length > 1 ? `\n+ ${songs(p.upNext.length - 1)} more` : ''}` : 'Nothing queued' },
  );
  return e.setFooter({ text: t.source === 'plex' ? 'From the Plex library' : t.id ? 'From YouTube Music' : 'From the link' });
}

/** One page of the queue. */
export function queueCard(p: MusicPlayer, page = 1): EmbedBuilder {
  const q = p.upNext;
  const pages = Math.max(1, Math.ceil(q.length / PAGE));
  const at = Math.min(Math.max(1, page), pages);
  const rows = q.slice((at - 1) * PAGE, at * PAGE).map((t, k) => `\`${(at - 1) * PAGE + k + 1}.\` ${trackLine(t)}${t.by ? ` · ${safe(t.by, 40)}` : t.auto ? ' · autoplay' : ''}`);
  const now = p.nowPlaying;
  return new EmbedBuilder()
    .setColor(0x8ab4f8)
    .setTitle(`Queue · ${songs(q.length)}`)
    .setDescription(
      [now ? `${p.paused ? 'Paused' : 'Playing'}: ${trackLine(now)}` : p.lent ? 'A music quiz has the music.' : 'Nothing playing.', '', ...(rows.length ? rows : ['Nothing queued.'])].join('\n').slice(0, 4000),
    )
    .setFooter({ text: `Page ${at}/${pages} · autoplay ${p.autoplay ? 'on' : 'off'} · volume ${pct(p.level)}` });
}

/** The buttons under the card: back, pause or resume, skip, stop, queue. */
export function buttons(p: MusicPlayer): ActionRowBuilder<ButtonBuilder> {
  const b = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`music:${id}`).setLabel(label).setStyle(style);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    b('back', '⏮ Back'),
    p.paused ? b('resume', '▶ Resume', ButtonStyle.Primary) : b('pause', '⏸ Pause'),
    b('skip', '⏭ Skip'),
    b('stop', '⏹ Stop', ButtonStyle.Danger),
    b('queue', '📃 Queue'),
  );
}

/** What a /play result says. */
export function playedText(r: RequestResult, by: string): string {
  if (!r.ok) return r.message;
  const label = r.label ? ` (${safe(r.label, 80)})` : '';
  if (r.started) return `▶ ${safe(by, 60)} started ${trackLine(r.started)}${label}${r.added ? `, with ${songs(r.added)} queued` : ''}.`;
  if (r.queuedAs) return `➕ ${safe(by, 60)} queued ${trackLine(r.queuedAs.track)} at #${r.queuedAs.position}.`;
  if (r.artist) return `➕ ${safe(by, 60)} queued ${songs(r.added)} by ${safe(r.artist, 60)}.`;
  return `➕ ${safe(by, 60)} queued ${songs(r.added)}${label}.`;
}

/** Autocomplete for /play: what they typed, then songs played lately and the
 *  artists they play most. All from memory: it must answer within 3 s. */
export function suggestions(typed: string, recent: readonly Track[], taste: MusicTaste | undefined, userId: string): { name: string; value: string }[] {
  const t = typed.trim();
  // Longer than a suggestion can hold (a long link): what they typed is sent as it is.
  if (t.length > 100) return [];
  const want = t.toLowerCase();
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: string) => {
    const v = value.slice(0, 100);
    const key = v.toLowerCase();
    if (!v || seen.has(key) || out.length >= 25) return;
    seen.add(key);
    out.push({ name: name.slice(0, 100), value: v });
  };
  if (t) add(t, t);
  // A link is played as it is: nothing else fits.
  if (/^https?:\/\//i.test(t)) return out;
  const fits = (s: string) => !want || s.toLowerCase().includes(want);
  for (const tr of recent) {
    const label = tr.artist ? `${tr.title} - ${tr.artist}` : tr.title;
    if (tr.kind !== 'podcast' && fits(label)) add(`↺ ${label}`, label);
  }
  for (const a of taste?.top(userId, 10) ?? []) if (fits(a)) add(`★ ${a}`, a);
  return out;
}

// --- typed commands ("!play x") ------------------------------------------------

type Sub = 'now' | 'queue' | 'skip' | 'back' | 'pause' | 'resume' | 'stop' | 'volume' | 'shuffle' | 'clear' | 'remove' | 'autoplay' | 'who';

/** A typed command, as read from a message. */
export type TextCommand =
  | { kind: 'play'; query: string; type: PlayType; mode: 'now' | 'queue'; source?: Track['source'] }
  | { kind: 'music'; sub: Sub; n?: number; on?: boolean }
  | { kind: 'join' }
  | { kind: 'leave' }
  | { kind: 'help' };

/** A whole number from what follows a command, or undefined. */
const num = (s: string): number | undefined => (/^\d{1,4}$/.test(s) ? Number(s) : undefined);
const play = (query: string, type: PlayType = 'auto', mode: 'now' | 'queue' = 'now', source?: Track['source']): TextCommand => ({ kind: 'play', query, type, mode, ...(source ? { source } : {}) });
const music = (sub: Sub, extra: { n?: number | undefined; on?: boolean } = {}): TextCommand => ({ kind: 'music', sub, ...(extra.n === undefined ? {} : { n: extra.n }), ...(extra.on === undefined ? {} : { on: extra.on }) });

/** Each command word and what it does with the rest of the message. */
const WORDS: Record<string, (rest: string) => TextCommand | undefined> = {};
const word = (names: string[], f: (rest: string) => TextCommand | undefined) => names.forEach((n) => (WORDS[n] = f));
/** A command that takes nothing: with more after it ("!leave me alone", a mod
 *  bot's "!clear 50") it isn't hers. */
const bare = (c: TextCommand) => (r: string) => (r ? undefined : c);
/** Words other bots use too ("!help"): only hers after an @mention of her. */
const NEEDS_MENTION = new Set(['help', 'commands', 'music']);
// "!play" alone carries on with what's paused, as most music bots do.
word(['play', 'p'], (r) => (r ? play(r) : music('resume')));
word(['playnext', 'pn', 'add'], (r) => (r ? play(r, 'auto', 'queue') : undefined));
// "!queue" shows it, "!queue 2" its second page, "!queue x" adds x.
word(['queue', 'q'], (r) => (!r ? music('queue') : num(r) !== undefined && num(r)! <= 10 ? music('queue', { n: num(r) }) : play(r, 'auto', 'queue')));
word(['plex'], (r) => (r ? play(r, 'auto', 'now', 'plex') : undefined));
for (const t of ['song', 'artist', 'album', 'playlist', 'podcast', 'video'] as const) word([t], (r) => (r ? play(r, t) : undefined));
word(['vibe', 'mood'], (r) => (r ? play(r, 'vibe') : undefined));
word(['similar', 'radio', 'more'], (r) => play(r, 'similar'));
word(['favorites', 'favourites', 'favs', 'mine'], bare(play('', 'favorites')));
word(['hers'], bare(play('', 'hers')));
word(['skip', 's', 'next', 'fs'], (r) => (r && num(r) === undefined ? undefined : music('skip', { n: num(r) })));
word(['back', 'prev', 'previous'], bare(music('back')));
word(['pause'], bare(music('pause')));
word(['resume', 'unpause', 'continue'], bare(music('resume')));
word(['stop'], bare(music('stop')));
word(['np', 'now', 'nowplaying', 'playing'], bare(music('now')));
word(['volume', 'vol', 'v'], (r) => (r && num(r) === undefined ? undefined : music('volume', { n: num(r) })));
word(['shuffle'], bare(music('shuffle')));
word(['clear'], bare(music('clear')));
word(['remove', 'rm'], (r) => (r && num(r) === undefined ? undefined : music('remove', { n: num(r) })));
word(['autoplay'], (r) => {
  const on = /^(on|yes|true)$/i.test(r) ? true : /^(off|no|false)$/i.test(r) ? false : undefined;
  return r && on === undefined ? undefined : music('autoplay', { ...(on === undefined ? {} : { on }) });
});
word(['who'], bare(music('who')));
word(['join', 'summon', 'come'], bare({ kind: 'join' }));
word(['leave', 'dc', 'disconnect'], bare({ kind: 'leave' }));
word(['help', 'commands', 'music'], bare({ kind: 'help' }));

/** "!play x" or "@A.D.R.I.A.N. !play x": what it asks for, or undefined if it isn't a command of hers. */
export function parseTextCommand(content: string, prefix: string, botId: string): TextCommand | undefined {
  if (!prefix) return undefined;
  let t = content.trim();
  const at = /^<@!?(\d+)>\s*/.exec(t);
  const mentioned = at?.[1] === botId;
  if (mentioned) t = t.slice(at![0].length);
  if (!t.startsWith(prefix)) return undefined;
  const m = /^(\S+)\s*([\s\S]*)$/.exec(t.slice(prefix.length));
  if (!m) return undefined;
  const w = m[1]!.toLowerCase();
  if (!Object.hasOwn(WORDS, w) || (NEEDS_MENTION.has(w) && !mentioned)) return undefined;
  return WORDS[w]!(m[2]!.trim().slice(0, 500));
}

/** What "!help" lists. */
export function textHelp(prefix: string): string {
  const c = (s: string) => `\`${prefix}${s}\``;
  return [
    '**Music commands** (`/play` and `/music` do the same):',
    `${c('play <song, artist or link>')} plays it now; ${c('play')} alone resumes. ${c('queue <song>')} or ${c('playnext <song>')} adds it after what's queued.`,
    `${c('album')}, ${c('playlist')}, ${c('artist')}, ${c('podcast')}, ${c('vibe')}, ${c('video')} say what it is. ${c('similar')} plays songs like this one, ${c('favorites')} plays what you like, ${c('plex <song>')} looks in Plex.`,
    `${c('skip [n]')}, ${c('back')}, ${c('pause')}, ${c('resume')}, ${c('stop')}, ${c('np')}, ${c('queue')}, ${c('volume [5-100]')}, ${c('shuffle')}, ${c('clear')}, ${c('remove <n>')}, ${c('autoplay on|off')}, ${c('who')}.`,
    `${c('join')} brings me to your voice channel, ${c('leave')} takes me out. Playing something from a voice channel I'm not in brings me there too.`,
  ].join('\n');
}

// --- answering, the same way for slash commands and typed ones ------------------

type Out = { content?: string; embeds?: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] };

/** Who asked, where, and how to answer them. */
interface Asker extends Asking {
  /** Their voice channel in this server, if they're in one. */
  channelId: string | undefined;
  /** How a command is written here: "/play" or "!play". */
  verb(command: string): string;
  /** Slow work ahead (a lookup, a move): acknowledge it now. */
  hold(): Promise<void>;
  /** For everyone in the channel. */
  say(o: Out): Promise<void>;
  /** For them alone where that's possible (a slash command), else a reply to them. */
  only(text: string): Promise<void>;
  /** A card or list for them (alone where possible). */
  view(o: Out): Promise<void>;
}

const quiet = { allowedMentions: { parse: [] as never[], repliedUser: false } };
const secret = (content: string) => ({ content, flags: MessageFlags.Ephemeral, ...quiet }) as const;

function slashAsker(i: ChatInputCommandInteraction<'cached'>): Asker {
  let held = false;
  return {
    guildId: i.guildId,
    guild: i.guild,
    user: i.user,
    channelId: i.guild.voiceStates.cache.get(i.user.id)?.channelId ?? undefined,
    verb: (c) => `/${c}`,
    hold: async () => {
      if (!i.deferred && !i.replied) await i.deferReply();
      held = true;
    },
    say: async (o) => void (held ? await i.editReply({ content: o.content ?? '', embeds: o.embeds ?? [], components: o.components ?? [], ...quiet }) : await i.reply({ ...o, ...quiet })),
    only: async (t) => {
      if (!held) return void (await i.reply(secret(t)));
      // The deferred reply is public: drop it and answer them alone.
      await i.deleteReply().catch(() => undefined);
      await i.followUp(secret(t));
    },
    view: async (o) => void (await i.reply({ ...o, flags: MessageFlags.Ephemeral, ...quiet })),
  };
}

function textAsker(m: Message<true>, prefix: string, log: Logger): Asker {
  // A reply needs Read Message History and the message still there: without
  // them, a plain message in the channel. Never throws, so a done action is
  // never followed by "that didn't work".
  const reply = async (o: Out) => {
    try {
      await m.reply({ ...o, ...quiet });
    } catch (e) {
      try {
        if (!('send' in m.channel)) throw e;
        await m.channel.send({ ...o, allowedMentions: { parse: [] } });
      } catch (e2) {
        log.warn('music reply failed', { error: (e2 as Error).message });
      }
    }
  };
  return {
    guildId: m.guildId,
    guild: m.guild,
    user: m.author,
    channelId: m.guild.voiceStates.cache.get(m.author.id)?.channelId ?? undefined,
    verb: (c) => `${prefix}${c}`,
    hold: async () => {
      if ('sendTyping' in m.channel) await m.channel.sendTyping().catch(() => undefined);
    },
    say: reply,
    only: (t) => reply({ content: t }),
    view: reply,
  };
}

export function registerMusicCommands(d: MusicCommandDeps): { isCommand(m: Message): boolean } {
  const { client, log } = d;
  const allowedHere = (guildId: string) => !d.allowedGuilds?.length || d.allowedGuilds.includes(guildId);

  client.on(Events.InteractionCreate, (i) => {
    // Only music's own: /join, /leave and anything else are someone else's.
    const name = 'commandName' in i ? i.commandName : undefined;
    const custom = 'customId' in i ? i.customId : undefined;
    if (name !== 'play' && name !== 'music' && !custom?.startsWith('music:')) return;
    if (!i.inCachedGuild()) return;
    if (i.isAutocomplete() && i.commandName === 'play') {
      void complete(i);
      return;
    }
    let run: Promise<void> | undefined;
    if (i.isChatInputCommand() && i.commandName === 'play') run = slashPlay(i);
    else if (i.isChatInputCommand() && i.commandName === 'music') run = slashMusic(i);
    else if (i.isButton() && i.customId.startsWith('music:')) run = button(i);
    run?.catch(async (e: unknown) => {
      log.warn('music command failed', { error: (e as Error).message });
      if (!i.isRepliable()) return;
      const msg = "Sorry, that didn't work. Try again in a moment.";
      await (i.deferred || i.replied ? i.editReply({ content: msg, embeds: [], components: [] }) : i.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(() => undefined);
    });
  });

  /** A typed command in a server message, if this is one. */
  const typed = (m: Message): TextCommand | undefined =>
    m.guildId && m.guild && !m.author?.bot && !m.system && client.user && allowedHere(m.guildId) ? parseTextCommand(m.content ?? '', d.prefix, client.user.id) : undefined;

  client.on(Events.MessageCreate, (m) => {
    const c = typed(m);
    if (!c) return;
    const a = textAsker(m as Message<true>, d.prefix, log);
    run(c, a).catch(async (e: unknown) => {
      log.warn('music command failed', { error: (e as Error).message, via: 'text' });
      await a.say({ content: "Sorry, that didn't work. Try again in a moment." }).catch(() => undefined);
    });
  });

  /** Why this person can't change the music right now, if they can't. */
  function refusal(a: { guildId: string; userId: string; channelId: string | undefined; verb(c: string): string }): string | undefined {
    if (!d.player()) return NO_MUSIC;
    const cur = d.current();
    if (!cur || cur.guildId !== a.guildId) return notHere(a);
    if (!d.isOwner(a.userId) && a.channelId !== cur.channelId) return JOIN_ME;
    return undefined;
  }
  const notHere = (a: { verb(c: string): string }) => `I'm not in a voice call in this server. Use ${a.verb('play')} from a voice channel and I'll join.`;

  /** Looking at the music: anyone in the server she's in. */
  function viewer(a: { guildId: string; verb(c: string): string }): MusicPlayer | string {
    const p = d.player();
    if (!p) return NO_MUSIC;
    const cur = d.current();
    if (!cur || cur.guildId !== a.guildId) return notHere(a);
    return p;
  }

  async function complete(i: AutocompleteInteraction<'cached'>): Promise<void> {
    const focused = i.options.getFocused(true);
    // The call's songs only for people in her server; their own artists anywhere.
    const recent = d.current()?.guildId === i.guildId ? (d.player()?.recent ?? []) : [];
    const list = focused.name === 'query' ? suggestions(String(focused.value ?? ''), recent, d.taste, i.user.id) : [];
    await i.respond(list).catch(() => undefined);
  }

  const slashPlay = (i: ChatInputCommandInteraction<'cached'>) =>
    run(
      play((i.options.getString('query') ?? '').trim(), (i.options.getString('type') ?? 'auto') as PlayType, i.options.getBoolean('queue') ? 'queue' : 'now', (i.options.getString('source') ?? undefined) as Track['source'] | undefined),
      slashAsker(i),
    );

  const slashMusic = (i: ChatInputCommandInteraction<'cached'>) => {
    const sub = i.options.getSubcommand() as Sub;
    const n = i.options.getInteger(sub === 'skip' ? 'to' : sub === 'remove' ? 'position' : sub === 'queue' ? 'page' : 'level') ?? undefined;
    const on = sub === 'autoplay' ? (i.options.getBoolean('on') ?? undefined) : undefined;
    return run(music(sub, { n, ...(on === undefined ? {} : { on }) }), slashAsker(i));
  };

  /** One command, from either place. */
  async function run(c: TextCommand, a: Asker): Promise<void> {
    if (c.kind === 'play') return playFor(a, c);
    if (c.kind === 'join') return joinFor(a);
    if (c.kind === 'leave') return leaveFor(a);
    if (c.kind === 'help') return a.say({ content: textHelp(d.prefix || '!') });
    return musicFor(a, c.sub, c.n, c.on);
  }

  async function joinFor(a: Asker): Promise<void> {
    const s = d.seat(a, a.verb('join'));
    if ('refused' in s) return a.only(s.refused);
    if ('here' in s) return a.only(`I'm already here. Say "Hey Adrian" to talk to me, or ${a.verb('play')} something.`);
    await a.hold();
    log.info('join requested', { user: a.user.id, guildId: a.guildId, channelId: s.channel.id, via: 'text' });
    await d.moveTo(s.move);
    await a.say({ content: `Joined ${safe(s.channel.name, 100)}. Say "Hey Adrian" and ask me anything.` });
  }

  async function leaveFor(a: Asker): Promise<void> {
    const no = d.mayLeave(a);
    if (no) return a.only(no);
    log.info('leave requested', { user: a.user.id, guildId: a.guildId, via: 'text' });
    await a.hold();
    await d.leave();
    await a.say({ content: `Left the voice channel. Use ${a.verb('join')} to bring me back.` });
  }

  async function playFor(a: Asker, c: Extract<TextCommand, { kind: 'play' }>): Promise<void> {
    const p = d.player();
    if (!p) return a.only(NO_MUSIC);
    const { type, mode, source } = c;
    const raw = c.query;
    const pasted = /^https?:\/\//i.test(raw) ? parseMediaLink(raw) : undefined;
    if (/^https?:\/\//i.test(raw) && !pasted) return a.only('I can play YouTube, YouTube Music, Spotify, SoundCloud and Bandcamp links.');
    if (!raw && !NO_QUERY.includes(type)) return a.only('What should I play? Give a song, an artist, a mood or a link.');
    if ((type === 'favorites' || type === 'hers') && !d.taste) return a.only("I don't keep track of music taste on this bot.");

    // She plays in the asker's call: someone she isn't with brings her over, by
    // /join's rules (she won't leave a call with other people in it, except for
    // an owner). An owner who isn't in voice plays into her call as it is. A
    // dropped link is rebuilt the way /join rebuilds it.
    const cur = d.current();
    const userId = a.user.id;
    const stay = !!cur && cur.guildId === a.guildId && ((a.channelId === cur.channelId && d.voiceReady()) || (!a.channelId && d.isOwner(userId)));
    let move: VoiceSpot | undefined;
    if (!stay) {
      const s = d.seat(a, a.verb('play'));
      if ('refused' in s) return a.only(s.refused);
      if ('move' in s) move = s.move;
    }
    if (p.lent) return a.only(p.lent.reason);
    const limited = d.allow(userId);
    if (limited) return a.only(limited);

    const by = d.nameOf(userId);
    // The request starts now: a stop or /leave from here on calls it off. A move
    // stops the music first, so with one it starts once the move is under way.
    let asked = p.ask(by);
    await a.hold();
    if (move) {
      log.info('join requested', { user: userId, guildId: a.guildId, channelId: move.channelId, via: 'play' });
      const moving = d.moveTo(move);
      asked = p.ask(by);
      await moving;
    }
    log.info('music command', { user: userId, command: 'play', type, mode, ...(source ? { source } : {}) });
    const signal = AbortSignal.timeout(PLAY_TIMEOUT_MS);
    let r: RequestResult;
    if (pasted) r = await p.request('link', pasted.url, mode, signal, undefined, asked);
    else if (type === 'favorites' || type === 'hers') {
      const artists = type === 'hers' ? d.taste!.hers() : d.taste!.top(userId);
      const artistCmd = a.verb('artist');
      r = artists.length
        ? await p.mix(artists, mode, signal, type === 'hers' ? 'music A.D.R.I.A.N. likes' : `music ${by} likes`, by, asked)
        : { ok: false, message: type === 'hers' ? "I haven't picked any favorites yet. Ask for an artist instead." : `I don't know what you like yet. Play a few artists first${a.verb('x').startsWith('/') ? ', or try /play type:artist' : `, like ${artistCmd} Drake`}.` };
    } else if (type === 'auto') r = await p.playNamed(raw, mode, signal, source, by, asked);
    else r = await p.request(KINDS.includes(type as RequestKind) ? (type as RequestKind) : 'song', raw, mode, signal, source, asked);

    if (r.ok) {
      // What they ask to hear is what they like, as when they say it.
      const artist = type === 'artist' ? (r.artist ?? raw) : type === 'auto' ? (r.artist ?? (r.started ?? r.queuedAs?.track)?.artist) : type === 'song' || type === 'album' ? r.started?.artist : undefined;
      if (artist && !pasted) d.taste?.played(userId, artist);
      if (r.started) d.started?.(userId);
    }
    log.info('music command done', { user: userId, ok: r.ok, started: r.ok && !!r.started });
    // Didn't work: only they see why where possible (it may repeat what they typed).
    if (!r.ok) return a.only(r.message);
    // The card when it started; a line when it was queued.
    const card = !!r.started && !!p.nowPlaying;
    await a.say({ content: playedText(r, by), embeds: card ? [nowCard(p)] : [], components: card ? [buttons(p)] : [] });
  }

  async function musicFor(a: Asker, sub: Sub, n?: number, on?: boolean): Promise<void> {
    if (sub === 'now' || sub === 'queue' || sub === 'who' || (sub === 'volume' && n === undefined)) {
      const v = viewer(a);
      if (typeof v === 'string') return a.only(v);
      if (sub === 'now') return a.view({ embeds: [nowCard(v)], components: v.nowPlaying ? [buttons(v)] : [] });
      if (sub === 'queue') return a.view({ embeds: [queueCard(v, n ?? 1)] });
      if (sub === 'volume') return a.only(`Music volume is ${pct(v.level)}.`);
      const t = v.nowPlaying;
      return a.only(v.lent ? 'A music quiz has the music.' : !t ? 'Nothing is playing.' : t.by ? `${safe(t.by, 60)} asked for ${trackLine(t)}.` : t.auto ? `Autoplay picked ${trackLine(t)}.` : `Nobody I know of asked for ${trackLine(t)}.`);
    }
    const no = refusal({ guildId: a.guildId, userId: a.user.id, channelId: a.channelId, verb: a.verb });
    if (no) return a.only(no);
    const p = d.player()!;
    const who = safe(d.nameOf(a.user.id), 60);
    log.info('music command', { user: a.user.id, command: sub });
    // A quiz has the music: skip and stop are its own, the volume is the clip's.
    if (p.lent && sub !== 'volume') {
      if (sub === 'skip') return (p.lent.skip(), a.say({ content: `⏭ ${who} skipped this round.` }));
      if (sub === 'stop') return (p.lent.stop(), a.say({ content: `⏹ ${who} stopped the quiz.` }));
      return a.only(p.lent.reason);
    }
    const noSong = (at: number) => `There's no song #${at} in the queue (${songs(p.upNext.length)} queued).`;
    switch (sub) {
      case 'skip': {
        if (!p.nowPlaying) return a.only('Nothing is playing.');
        if (n !== undefined && n > Math.max(1, p.upNext.length)) return a.only(noSong(n));
        await a.hold();
        const next = n === undefined || n <= 1 ? await p.skip() : await p.skipTo(n);
        if (next === 'none') return a.only(noSong(n!));
        if (next === false) return a.only('Nothing is playing.');
        if (!next) return a.say({ content: p.youtubePaused ? "⏭ Skipped. I can't reach YouTube right now." : `⏭ ${who} skipped. Nothing else is queued.` });
        return a.say({ content: `⏭ ${who} skipped${n && n > 1 ? ` to #${n}` : ''}.`, embeds: [nowCard(p)], components: [buttons(p)] });
      }
      case 'back': {
        if (!p.recent.some((t) => t !== p.nowPlaying)) return a.only('Nothing played before this one.');
        await a.hold();
        const b = await p.back();
        if (b === false) return a.only('Nothing played before this one.');
        if (!b) return a.only("I couldn't play that one again.");
        return a.say({ content: `⏮ ${who} went back.`, embeds: [nowCard(p)], components: [buttons(p)] });
      }
      case 'pause':
        return p.pause() ? a.say({ content: `⏸ ${who} paused the music.` }) : a.only(p.paused ? "It's already paused." : 'Nothing is playing.');
      case 'resume':
        return p.resume() ? a.say({ content: `▶ ${who} resumed the music.` }) : a.only(p.nowPlaying ? "It's already playing." : 'Nothing is paused.');
      case 'stop':
        return p.stop() ? a.say({ content: `⏹ ${who} stopped the music.` }) : a.only('Nothing is playing.');
      case 'volume': {
        const to = p.setVolume(Math.min(100, Math.max(5, n!)) / 100);
        return a.say({ content: `🔊 ${who} set the music volume to ${pct(to)}.` });
      }
      case 'shuffle':
        if (!p.upNext.length) return a.only('The queue is empty.');
        return a.say({ content: `🔀 ${who} shuffled ${songs(p.shuffle())}.` });
      case 'clear':
        if (!p.upNext.length) return a.only('The queue is already empty.');
        return a.say({ content: `🧹 ${who} cleared ${songs(p.clearQueue())} from the queue.` });
      case 'remove': {
        if (n === undefined) return a.only(`Which one? Give its number from ${a.verb('queue')}, like ${a.verb('remove')} 2.`);
        const t = p.remove(n);
        if (!t) return a.only(noSong(n));
        return a.say({ content: `➖ ${who} removed ${trackLine(t)} from the queue.` });
      }
      case 'autoplay':
        p.setAutoplay(on ?? !p.autoplay);
        return a.say({ content: `🔁 ${who} turned autoplay ${p.autoplay ? 'on' : 'off'}.` });
      default:
        return a.only('I don’t know that one.');
    }
  }

  /** A button on a now-playing card: acts on what plays now, then redraws the card. */
  async function button(i: ButtonInteraction<'cached'>): Promise<void> {
    const action = i.customId.slice('music:'.length);
    const verb = (c: string) => `/${c}`;
    if (action === 'queue') {
      const v = viewer({ guildId: i.guildId, verb });
      return void (await i.reply(typeof v === 'string' ? secret(v) : { embeds: [queueCard(v)], flags: MessageFlags.Ephemeral, ...quiet }));
    }
    const no = refusal({ guildId: i.guildId, userId: i.user.id, channelId: i.guild.voiceStates.cache.get(i.user.id)?.channelId ?? undefined, verb });
    if (no) return void (await i.reply(secret(no)));
    const p = d.player()!;
    log.info('music command', { user: i.user.id, command: action, via: 'button' });
    if (p.lent) {
      if (action === 'skip') p.lent.skip();
      else if (action === 'stop') p.lent.stop();
      else return void (await i.reply(secret(p.lent.reason)));
      return void (await i.reply({ content: action === 'skip' ? 'Skipped this round.' : 'Quiz stopped.', flags: MessageFlags.Ephemeral }));
    }
    const card = () => ({ embeds: [nowCard(p)], components: p.nowPlaying ? [buttons(p)] : [], ...quiet });
    // A private card's click is seen by nobody else: say in the channel who did it.
    const who = safe(d.nameOf(i.user.id), 60);
    const tell = async (line: string) => {
      if (i.message?.flags?.has(MessageFlags.Ephemeral)) await i.followUp({ content: line, ...quiet }).catch(() => undefined);
    };
    switch (action) {
      case 'pause':
      case 'resume':
        // Either way the card is redrawn as things are now (an old card may be out of date).
        if (action === 'pause' ? p.pause() : p.resume()) {
          await i.update(card());
          return void (await tell(action === 'pause' ? `⏸ ${who} paused the music.` : `▶ ${who} resumed the music.`));
        }
        return void (await i.update(card()));
      case 'skip': {
        await i.deferUpdate();
        const n = await p.skip();
        await i.editReply(card());
        if (n !== false) await tell(`⏭ ${who} skipped.`);
        return;
      }
      case 'back': {
        await i.deferUpdate();
        const b = await p.back();
        if (b === false) return void (await i.followUp(secret('Nothing played before this one.')));
        await i.editReply(card());
        return void (await tell(`⏮ ${who} went back.`));
      }
      case 'stop': {
        const had = p.stop();
        await i.update({ content: had ? `⏹ ${who} stopped the music.` : 'Nothing is playing.', embeds: [], components: [], ...quiet });
        if (had) await tell(`⏹ ${who} stopped the music.`);
        return;
      }
      default:
        return void (await i.reply(secret('That button is from an older version. Use /music now for a fresh one.')));
    }
  }

  return { isCommand: (m) => typed(m) !== undefined };
}
