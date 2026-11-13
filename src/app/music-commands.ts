// Music slash commands: /play and /music (now, queue, skip, back, pause,
// resume, stop, volume, shuffle, clear, remove, autoplay, who), plus buttons
// on the now-playing card. They drive the same player as "Hey Adrian, play ...":
// the Discord call's. Changing the music takes being in her call (owners may
// from anywhere); looking at it only takes being in that server.

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
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { Logger } from '../core/interfaces.js';
import { describe as trackName, type MusicPlayer, type RequestKind, type RequestResult, type Track } from '../features/music.js';
import { parseMediaLink } from '../features/links.js';
import type { MusicTaste } from '../features/taste.js';
import type { Seat, VoiceSpot } from './commands.js';

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
  /** /join's checks, for /play from someone she isn't with yet. */
  seat(i: ChatInputCommandInteraction<'cached'>, verb: string): Seat;
  moveTo(spot: VoiceSpot): Promise<void>;
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
}

const NO_MUSIC = "Music isn't set up on this bot.";
const NOT_HERE = "I'm not in a voice call in this server. Use /play from a voice channel and I'll join.";
const JOIN_ME = 'Join my voice channel to change the music.';
/** How long a /play may look things up (an album or podcast takes 5-8 s). */
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

export function registerMusicCommands(d: MusicCommandDeps): void {
  const { client, log } = d;

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
    if (i.isChatInputCommand() && i.commandName === 'play') run = play(i);
    else if (i.isChatInputCommand() && i.commandName === 'music') run = music(i);
    else if (i.isButton() && i.customId.startsWith('music:')) run = button(i);
    run?.catch(async (e: unknown) => {
      log.warn('music command failed', { error: (e as Error).message });
      if (!i.isRepliable()) return;
      const msg = "Sorry, that didn't work. Try again in a moment.";
      await (i.deferred || i.replied ? i.editReply({ content: msg, embeds: [], components: [] }) : i.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(() => undefined);
    });
  });

  const quiet = { allowedMentions: { parse: [] as never[] } };
  const secret = (content: string) => ({ content, flags: MessageFlags.Ephemeral, ...quiet }) as const;

  /** The voice channel this person is in, in this server. */
  const channelOf = (i: { guild: { voiceStates: { cache: Map<string, { channelId: string | null }> } }; user: { id: string } }) =>
    i.guild.voiceStates.cache.get(i.user.id)?.channelId ?? undefined;

  /** Why this person can't change the music right now, if they can't. */
  function refusal(i: ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>): string | undefined {
    if (!d.player()) return NO_MUSIC;
    const cur = d.current();
    if (!cur || cur.guildId !== i.guildId) return NOT_HERE;
    if (!d.isOwner(i.user.id) && channelOf(i) !== cur.channelId) return JOIN_ME;
    return undefined;
  }

  /** Looking at the music: anyone in the server she's in. */
  function viewer(i: ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>): MusicPlayer | string {
    const p = d.player();
    if (!p) return NO_MUSIC;
    const cur = d.current();
    if (!cur || cur.guildId !== i.guildId) return NOT_HERE;
    return p;
  }

  async function complete(i: AutocompleteInteraction<'cached'>): Promise<void> {
    const focused = i.options.getFocused(true);
    // The call's songs only for people in her server; their own artists anywhere.
    const recent = d.current()?.guildId === i.guildId ? (d.player()?.recent ?? []) : [];
    const list = focused.name === 'query' ? suggestions(String(focused.value ?? ''), recent, d.taste, i.user.id) : [];
    await i.respond(list).catch(() => undefined);
  }

  async function play(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const p = d.player();
    if (!p) return void (await i.reply(secret(NO_MUSIC)));
    const type = (i.options.getString('type') ?? 'auto') as PlayType;
    const raw = (i.options.getString('query') ?? '').trim();
    const mode = i.options.getBoolean('queue') ? 'queue' : 'now';
    const source = (i.options.getString('source') ?? undefined) as Track['source'] | undefined;
    const pasted = /^https?:\/\//i.test(raw) ? parseMediaLink(raw) : undefined;
    if (/^https?:\/\//i.test(raw) && !pasted) return void (await i.reply(secret('I can play YouTube, YouTube Music, Spotify, SoundCloud and Bandcamp links.')));
    if (!raw && !NO_QUERY.includes(type)) return void (await i.reply(secret('What should I play? Type a song, an artist, a mood or a link.')));
    if ((type === 'favorites' || type === 'hers') && !d.taste) return void (await i.reply(secret("I don't keep track of music taste on this bot.")));

    // She plays where she is. Someone who isn't with her brings her over, by /join's rules.
    const cur = d.current();
    let move: VoiceSpot | undefined;
    // A dropped link is rebuilt the way /join rebuilds it.
    const withHer = !!cur && cur.guildId === i.guildId && (channelOf(i) === cur.channelId || d.isOwner(i.user.id));
    if (!withHer || (channelOf(i) === cur?.channelId && !d.voiceReady())) {
      const s = d.seat(i, '/play');
      if ('refused' in s) return void (await i.reply(secret(s.refused)));
      if ('move' in s) move = s.move;
    }
    if (p.lent) return void (await i.reply(secret(p.lent.reason)));
    const limited = d.allow(i.user.id);
    if (limited) return void (await i.reply(secret(limited)));

    const by = d.nameOf(i.user.id);
    // The request starts now: a stop or /leave from here on calls it off. A move
    // stops the music first, so with one it starts once the move is under way.
    let asked = p.ask(by);
    await i.deferReply();
    if (move) {
      log.info('join requested', { user: i.user.id, guildId: i.guildId, channelId: move.channelId, via: 'play' });
      const moving = d.moveTo(move);
      asked = p.ask(by);
      await moving;
    }
    log.info('music command', { user: i.user.id, command: 'play', type, mode, ...(source ? { source } : {}) });
    const signal = AbortSignal.timeout(PLAY_TIMEOUT_MS);
    let r: RequestResult;
    if (pasted) r = await p.request('link', pasted.url, mode, signal, undefined, asked);
    else if (type === 'favorites' || type === 'hers') {
      const artists = type === 'hers' ? d.taste!.hers() : d.taste!.top(i.user.id);
      r = artists.length
        ? await p.mix(artists, mode, signal, type === 'hers' ? 'music A.D.R.I.A.N. likes' : `music ${by} likes`, by, asked)
        : { ok: false, message: type === 'hers' ? "I haven't picked any favorites yet. Try /play type:artist." : "I don't know what you like yet. Play a few artists first, or try /play type:artist." };
    } else if (type === 'auto') r = await p.playNamed(raw, mode, signal, source, by, asked);
    else r = await p.request(KINDS.includes(type as RequestKind) ? (type as RequestKind) : 'song', raw, mode, signal, source, asked);

    if (r.ok) {
      // What they ask to hear is what they like, as when they say it.
      const artist = type === 'artist' ? (r.artist ?? raw) : type === 'auto' ? (r.artist ?? (r.started ?? r.queuedAs?.track)?.artist) : type === 'song' || type === 'album' ? r.started?.artist : undefined;
      if (artist && !pasted) d.taste?.played(i.user.id, artist);
      if (r.started) d.started?.(i.user.id);
    }
    log.info('music command done', { user: i.user.id, ok: r.ok, started: r.ok && !!r.started });
    // Didn't work: only they see why (the reason may repeat what they typed).
    if (!r.ok) {
      await i.deleteReply().catch(() => undefined);
      await i.followUp(secret(r.message));
      return;
    }
    // The card when it started; a line when it was queued.
    const card = !!r.started && !!p.nowPlaying;
    await i.editReply({ content: playedText(r, by), embeds: card ? [nowCard(p)] : [], components: card ? [buttons(p)] : [], ...quiet });
  }

  async function music(i: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const sub = i.options.getSubcommand();
    if (sub === 'now' || sub === 'queue' || sub === 'who' || (sub === 'volume' && i.options.getInteger('level') === null)) {
      const v = viewer(i);
      if (typeof v === 'string') return void (await i.reply(secret(v)));
      if (sub === 'now') return void (await i.reply({ embeds: [nowCard(v)], components: v.nowPlaying ? [buttons(v)] : [], flags: MessageFlags.Ephemeral, ...quiet }));
      if (sub === 'queue') return void (await i.reply({ embeds: [queueCard(v, i.options.getInteger('page') ?? 1)], flags: MessageFlags.Ephemeral, ...quiet }));
      if (sub === 'volume') return void (await i.reply(secret(`Music volume is ${pct(v.level)}.`)));
      const t = v.nowPlaying;
      return void (await i.reply(secret(v.lent ? 'A music quiz has the music.' : !t ? 'Nothing is playing.' : t.by ? `${safe(t.by, 60)} asked for ${trackLine(t)}.` : t.auto ? `Autoplay picked ${trackLine(t)}.` : `Nobody I know of asked for ${trackLine(t)}.`)));
    }
    const no = refusal(i);
    if (no) return void (await i.reply(secret(no)));
    const p = d.player()!;
    const who = safe(d.nameOf(i.user.id), 60);
    log.info('music command', { user: i.user.id, command: sub });
    // A quiz has the music: skip and stop are its own, the volume is the clip's.
    if (p.lent && sub !== 'volume') {
      if (sub === 'skip') return void (p.lent.skip(), await i.reply({ content: `⏭ ${who} skipped this round.`, ...quiet }));
      if (sub === 'stop') return void (p.lent.stop(), await i.reply({ content: `⏹ ${who} stopped the quiz.`, ...quiet }));
      return void (await i.reply(secret(p.lent.reason)));
    }
    switch (sub) {
      case 'skip': {
        const to = i.options.getInteger('to');
        if (!p.nowPlaying) return void (await i.reply(secret('Nothing is playing.')));
        if (to !== null && to > Math.max(1, p.upNext.length)) return void (await i.reply(secret(`There's no song #${to} in the queue (${songs(p.upNext.length)} queued).`)));
        await i.deferReply();
        const n = to === null || to === 1 ? await p.skip() : await p.skipTo(to);
        if (n === 'none') return void (await i.editReply({ content: `There's no song #${to} in the queue (${songs(p.upNext.length)} queued).`, ...quiet }));
        if (n === false) return void (await i.editReply({ content: 'Nothing is playing.', ...quiet }));
        if (!n) return void (await i.editReply({ content: p.youtubePaused ? "⏭ Skipped. I can't reach YouTube right now." : `⏭ ${who} skipped. Nothing else is queued.`, ...quiet }));
        return void (await i.editReply({ content: `⏭ ${who} skipped${to && to > 1 ? ` to #${to}` : ''}.`, embeds: [nowCard(p)], components: [buttons(p)], ...quiet }));
      }
      case 'back': {
        if (!p.recent.some((t) => t !== p.nowPlaying)) return void (await i.reply(secret('Nothing played before this one.')));
        await i.deferReply();
        const b = await p.back();
        if (b === false) return void (await i.editReply({ content: 'Nothing played before this one.', ...quiet }));
        if (!b) return void (await i.editReply({ content: "I couldn't play that one again.", ...quiet }));
        return void (await i.editReply({ content: `⏮ ${who} went back.`, embeds: [nowCard(p)], components: [buttons(p)], ...quiet }));
      }
      case 'pause':
        return void (await i.reply(p.pause() ? { content: `⏸ ${who} paused the music.`, ...quiet } : secret(p.paused ? "It's already paused." : 'Nothing is playing.')));
      case 'resume':
        return void (await i.reply(p.resume() ? { content: `▶ ${who} resumed the music.`, ...quiet } : secret(p.nowPlaying ? "It's already playing." : 'Nothing is paused.')));
      case 'stop':
        return void (await i.reply(p.stop() ? { content: `⏹ ${who} stopped the music.`, ...quiet } : secret('Nothing is playing.')));
      case 'volume': {
        const level = i.options.getInteger('level', true);
        const to = p.setVolume(Math.min(100, Math.max(5, level)) / 100);
        return void (await i.reply({ content: `🔊 ${who} set the music volume to ${pct(to)}.`, ...quiet }));
      }
      case 'shuffle': {
        if (!p.upNext.length) return void (await i.reply(secret('The queue is empty.')));
        return void (await i.reply({ content: `🔀 ${who} shuffled ${songs(p.shuffle())}.`, ...quiet }));
      }
      case 'clear': {
        if (!p.upNext.length) return void (await i.reply(secret('The queue is already empty.')));
        return void (await i.reply({ content: `🧹 ${who} cleared ${songs(p.clearQueue())} from the queue.`, ...quiet }));
      }
      case 'remove': {
        const at = i.options.getInteger('position', true);
        const t = p.remove(at);
        if (!t) return void (await i.reply(secret(`There's no song #${at} in the queue (${songs(p.upNext.length)} queued).`)));
        return void (await i.reply({ content: `➖ ${who} removed ${trackLine(t)} from the queue.`, ...quiet }));
      }
      case 'autoplay': {
        p.setAutoplay(i.options.getBoolean('on', true));
        return void (await i.reply({ content: `🔁 ${who} turned autoplay ${p.autoplay ? 'on' : 'off'}.`, ...quiet }));
      }
      default:
        return void (await i.reply(secret('I don’t know that one.')));
    }
  }

  /** A button on a now-playing card: acts on what plays now, then redraws the card. */
  async function button(i: ButtonInteraction<'cached'>): Promise<void> {
    const action = i.customId.slice('music:'.length);
    if (action === 'queue') {
      const v = viewer(i);
      return void (await i.reply(typeof v === 'string' ? secret(v) : { embeds: [queueCard(v)], flags: MessageFlags.Ephemeral, ...quiet }));
    }
    const no = refusal(i);
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
}
