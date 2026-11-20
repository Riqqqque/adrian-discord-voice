// Game night: "who's free for Valorant?", "who's playing right now?", "get
// the squad on" / "ping everyone for Valorant in 10".
//
// Who's in voice comes from voice states, which she always sees. Who's online
// and what they're playing needs Discord's Presence intent; without it she
// answers from voice and says once that she can't see games.
//
// Pings reach only people who signed up ("ping me for game night", or the
// config's gameNight.optIn), never @everyone or roles, at most ten at a time,
// once per game per cooldown, in a fixed message she writes herself. Each
// person is pinged at most once per cooldown, whatever the game is called.

import { readFileSync } from 'node:fs';
import { ActivityType, escapeMarkdown, type Guild, type GuildMember } from 'discord.js';
import { PendingYes } from '../brain/tools.js';
import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import { writeJsonFile } from '../web/secrets-file.js';
import { canSee, pickTextChannel, plainText } from './textchannel.js';
import { WindowLimiter } from './handoff.js';

// --- who signed up ----------------------------------------------------------

interface Signup {
  /** Pinged at all. False: they said stop (this beats the config's list). */
  on: boolean;
  /** Only these games; empty: every game. */
  games: string[];
  /** Every game but these. */
  except: string[];
}

const MAX_PEOPLE = 1_000;
const MAX_GAMES = 20;
/** A game as kept and compared: lower case, plain words. */
export const gameKey = (g: string) =>
  g
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .trim()
    .slice(0, 40);

/** "valorant" matches "VALORANT", "League" matches "League of Legends". */
export const sameGame = (asked: string, playing: string) => {
  const a = gameKey(asked);
  const p = gameKey(playing);
  return !!a && !!p && (a === p || p.startsWith(`${a} `) || a.startsWith(`${p} `) || p.replace(/ /g, '') === a.replace(/ /g, ''));
};

/** Who wants game-night pings, kept in `game-night.json`. */
export class GameNightSignups {
  private data: Record<UserId, Signup> = {};

  constructor(
    private readonly file: string | undefined,
    /** The config's list: signed up for every game unless they said stop. */
    private readonly always: readonly UserId[] = [],
  ) {
    if (!file) return;
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as { people?: Record<UserId, Signup> };
      if (d?.people && typeof d.people === 'object') this.data = d.people;
    } catch {
      /* none yet */
    }
  }

  private save(): void {
    const ids = Object.keys(this.data);
    if (ids.length > MAX_PEOPLE) for (const id of ids.slice(0, ids.length - MAX_PEOPLE)) delete this.data[id];
    if (this.file) writeJsonFile(this.file, { people: this.data });
  }

  /** Signed up for this game (or for game nights in general, with no game). */
  wants(userId: UserId, game?: string): boolean {
    const s = this.data[userId];
    if (!s) return this.always.includes(userId);
    if (!s.on) return false;
    const g = game ? gameKey(game) : '';
    if (g && s.except.some((x) => sameGame(x, g))) return false;
    return !s.games.length || !g || s.games.some((x) => sameGame(x, g));
  }

  /** Everyone who might want this game's pings: the stored and the config's. */
  everyone(): UserId[] {
    return [...new Set([...Object.keys(this.data), ...this.always])];
  }

  join(userId: UserId, game?: string): string {
    const g = game ? gameKey(game) : '';
    const had = this.data[userId];
    const allBefore = had ? had.on && !had.games.length && !had.except.length : this.always.includes(userId);
    let s: Signup;
    if (!g || allBefore) s = { on: true, games: [], except: [] };
    // Every game but some: this one counts again.
    else if (had?.on && !had.games.length) s = { ...had, except: had.except.filter((x) => !sameGame(x, g)) };
    else if (had?.on) s = { ...had, games: [...new Set([...had.games, g])].slice(-MAX_GAMES) };
    else s = { on: true, games: [g], except: [] };
    this.data[userId] = s;
    this.save();
    if (g && allBefore) return `They were already signed up for every game, ${game} included.`;
    return g ? `Signed them up for ${game} pings.` : 'Signed them up for game-night pings, every game.';
  }

  leave(userId: UserId, game?: string): string {
    const g = game ? gameKey(game) : '';
    const s = this.data[userId] ?? { on: this.always.includes(userId), games: [], except: [] };
    if (!g || !s.on) Object.assign(s, { on: false, games: [], except: [] });
    else if (s.games.length) {
      s.games = s.games.filter((x) => !sameGame(x, g));
      if (!s.games.length) s.on = false;
    } else s.except = [...new Set([...s.except, g])].slice(-MAX_GAMES);
    this.data[userId] = s;
    this.save();
    return g && s.on ? `No more ${game} pings for them; other games still ping them.` : 'No more game-night pings for them.';
  }
}

// --- what people are doing ----------------------------------------------------

export interface ActivityLike {
  type: number;
  name: string;
  details?: string | null;
  state?: string | null;
}

/** Where a game's rich presence puts them. A guess from its words. */
export function matchState(a: ActivityLike): 'match' | 'menus' | 'playing' {
  const words = [a.details, a.state].filter(Boolean).join(' ');
  if (/\b(lobby|menus?|main menu|in queue|queued|queueing|searching|matchmaking|agent select|champ(?:ion)? select|character select|loading|afk|idle|waiting)\b/i.test(words)) return 'menus';
  if (/\b(in (?:a )?(?:match|game|round|raid)|competitive|ranked|unrated|deathmatch|swiftplay|spike rush|team deathmatch|battle royale|playing (?:solo|duo|trio|squads?)|round \d+|\d+\s*[-–:]\s*\d+)\b/i.test(words)) return 'match';
  return 'playing';
}

interface Person {
  id: UserId;
  name: string;
  status?: 'online' | 'idle' | 'dnd' | 'offline';
  game?: { name: string; where: 'match' | 'menus' | 'playing'; words: string };
  voice?: { channel: string; afk: boolean; muted: boolean; deafened: boolean };
}

export interface GameNightDeps {
  /** Guilds she's in, as discord.js gives them. */
  guild(id: string): Guild | undefined;
  allowedGuilds: readonly string[];
  /** The server a PC or a DM means. */
  homeGuild?: string;
  /** The Presence intent is on: online status and games are visible. */
  presences: boolean;
  signups: GameNightSignups;
  /** Where to post pings: config first, see pickTextChannel. */
  channelId?: string;
  /** The text channel she last wrote in, per server. */
  lastText(guildId: string): string | undefined;
  /** The voice channel she's in, if in this server. */
  voiceChannel(guildId: string): string | undefined;
  cooldownMs: number;
  maxMentions: number;
  perUserPerHour: number;
  now?(): number;
}

const NO_PRESENCE = "I can't see who's online or what people are playing: that needs Discord's Presence intent, which is off for me. I can only see who's in voice.";

/** Their words asked for the pings: "ping everyone", "get the squad on". */
const PING_ORDER =
  /\b(?:ping|tag|notify|alert|summon|rally|round up|gather|call (?:up|in)|get)\b(?:\s+\S+){0,3}?\s+(?:everyone|everybody|the (?:squad|boys|guys|girls|team|crew|gang|group|homies|lads)|squad|people|the others|them|y'?all)\b/i;
/** Words that never send pings without a yes: "don't ping anyone yet". */
const NOT_ORDER = /\b(?:don'?t|do not|never|not|no need to|stop|shouldn'?t|won'?t|wouldn'?t|cancel)\b/i;
/** "ping me for valorant" is signing up (join), not pinging others. */
const PING_ME = /\b(?:ping|tag|notify|alert|remind)\s+me\b/i;

export function gameNightTool(d: GameNightDeps): Tool {
  const now = d.now ?? Date.now;
  const told = new Set<UserId>();
  const cooldown = new Map<string, number>();
  /** guild:person → when they were last pinged, for any game. */
  const pinged = new Map<string, number>();
  const limiter = new WindowLimiter(d.perUserPerHour, 3_600_000, now);
  const waiting = new PendingYes<{ guildId: string; game: string; minutes: number | undefined }>(now);

  async function place(ctx: ToolContext): Promise<{ guild: Guild; asker: GuildMember }> {
    const id = ctx.guildId ?? d.homeGuild;
    const guild = id ? d.guild(id) : undefined;
    if (!guild || (d.allowedGuilds.length && !d.allowedGuilds.includes(guild.id))) throw new Error('not in a server here');
    const asker = await guild.members.fetch(ctx.userId).catch(() => undefined);
    if (!asker) throw new Error("you're not in that server");
    return { guild, asker };
  }

  /** The display names of these people, fetching the ones not seen since the
   *  restart (the member cache only fills as people speak or join voice). */
  async function named(guild: Guild, ids: UserId[]): Promise<{ names: string[]; unknown: number }> {
    const missing = ids.filter((id) => !guild.members.cache.has(id)).slice(0, 100);
    let failed = false;
    if (missing.length)
      await guild.members.fetch({ user: missing, time: 5_000 }).catch(() => {
        failed = true;
      });
    const names: string[] = [];
    let unknown = 0;
    for (const id of ids) {
      const m = guild.members.cache.get(id);
      if (m && !m.user.bot) names.push(m.displayName);
      // Not found after a fetch that worked: they left the server.
      else if (!m && (failed || !missing.includes(id))) unknown++;
    }
    return { names, unknown };
  }
  const unknownNote = (n: number) => (n ? ` (and ${n} more I couldn't look up right now)` : '');

  /** Everyone she can say something about, as the asker could see it. */
  function people(guild: Guild, asker: GuildMember): Person[] {
    const out = new Map<UserId, Person>();
    const nameOf = (id: UserId, m?: GuildMember | null) => m?.displayName ?? guild.members.cache.get(id)?.displayName ?? 'someone';
    for (const vs of guild.voiceStates.cache.values()) {
      const ch = vs.channel;
      const m = vs.member ?? guild.members.cache.get(vs.id);
      if (!ch || m?.user.bot || !canSee(asker, ch)) continue;
      out.set(vs.id, {
        id: vs.id,
        name: nameOf(vs.id, m),
        voice: { channel: ch.name, afk: ch.id === guild.afkChannelId, muted: !!(vs.selfMute || vs.serverMute), deafened: !!(vs.selfDeaf || vs.serverDeaf) },
      });
    }
    if (d.presences) {
      for (const p of guild.presences.cache.values()) {
        const m = p.member ?? guild.members.cache.get(p.userId);
        if (m?.user.bot || !p.status || p.status === 'offline' || p.status === 'invisible') continue;
        const game = p.activities.find((a) => a.type === ActivityType.Playing);
        const person = out.get(p.userId) ?? { id: p.userId, name: nameOf(p.userId, m) };
        person.status = p.status;
        if (game) person.game = { name: game.name, where: matchState(game), words: [game.details, game.state].filter(Boolean).join(' - ').slice(0, 80) };
        out.set(p.userId, person);
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  const voiceBit = (p: Person) =>
    p.voice ? (p.voice.afk ? `AFK in ${p.voice.channel}` : `in voice ${p.voice.channel}${p.voice.deafened ? ', deafened' : p.voice.muted ? ', muted' : ''}`) : '';
  const gameBit = (p: Person) =>
    p.game ? `playing ${p.game.name}${p.game.where === 'match' ? ' (in a match, going by their status)' : p.game.where === 'menus' ? ' (in the menus or a queue, going by their status)' : ''}` : '';
  const line = (p: Person, extra: string[] = []) => {
    const bits = [p.status === 'dnd' ? 'do not disturb' : (p.status ?? ''), gameBit(p), voiceBit(p), ...extra].filter(Boolean);
    return `${p.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  };
  const list = (ps: Person[], max = 20, extra?: (p: Person) => string[]) => ps.slice(0, max).map((p) => line(p, extra?.(p))).join('; ') + (ps.length > max ? `; and ${ps.length - max} more` : '');

  /** The notice, the first time this person asks; a note to the model after. */
  const blind = (ctx: ToolContext) => {
    if (told.has(ctx.userId)) return '(Presence still off; you already told them, so leave it out.)';
    told.add(ctx.userId);
    if (told.size > 500) told.delete(told.values().next().value!);
    return `Tell them once: ${NO_PRESENCE}`;
  };

  function whoPlaying(guild: Guild, asker: GuildMember, game: string, ctx: ToolContext): string {
    const all = people(guild, asker);
    const inVoice = all.filter((p) => p.voice && !p.voice.afk);
    const voice = inVoice.length ? `In voice: ${list(inVoice)}.` : 'Nobody is in voice.';
    if (!d.presences) return `${voice} ${blind(ctx)}`;
    const playing = all.filter((p) => p.game && (!game || sameGame(game, p.game.name)));
    const what = playing.length ? `Playing${game ? ` ${game}` : ''} now: ${list(playing)}.` : `Nobody is showing ${game || 'a game'} right now.`;
    return `${what} ${voice}`;
  }

  async function whoFree(guild: Guild, asker: GuildMember, game: string, ctx: ToolContext): Promise<string> {
    const signedUp = await named(
      guild,
      d.signups.everyone().filter((id) => id !== ctx.userId && d.signups.wants(id, game || undefined)),
    );
    const all = people(guild, asker).filter((p) => p.id !== ctx.userId);
    const signed = (p: Person) => (d.signups.wants(p.id, game || undefined) ? ['signed up for game-night pings'] : []);
    const signedNames = signedUp.names;
    const signedLine = signedNames.length
      ? `Signed up for ${game || 'game-night'} pings: ${signedNames.slice(0, 20).join(', ')}${unknownNote(signedUp.unknown)}.`
      : signedUp.unknown
        ? `${signedUp.unknown} signed up for ${game || 'game-night'} pings, but I couldn't look up who right now.`
        : `Nobody has signed up for ${game || 'game-night'} pings.`;
    if (!d.presences) {
      const here = all.filter((p) => p.voice && !p.voice.afk && !p.voice.deafened);
      const away = all.filter((p) => p.voice && (p.voice.afk || p.voice.deafened));
      return [
        here.length ? `In voice and around: ${list(here, 20, signed)}.` : 'Nobody is in voice.',
        away.length ? `AFK or deafened: ${list(away)}.` : '',
        signedLine,
        blind(ctx),
      ]
        .filter(Boolean)
        .join(' ');
    }
    const free: Person[] = [];
    const busy: Person[] = [];
    const dnd: Person[] = [];
    for (const p of all) {
      if (p.status === 'dnd') dnd.push(p);
      else if (p.game && (p.game.where === 'match' || (game && !sameGame(game, p.game.name) && p.game.where !== 'menus'))) busy.push(p);
      else if (p.status === 'online' || p.status === 'idle' || p.voice) free.push(p);
    }
    const away = free.filter((p) => p.voice?.afk || p.voice?.deafened || p.status === 'idle');
    const ready = free.filter((p) => !away.includes(p));
    return [
      ready.length ? `Free now: ${list(ready, 20, signed)}.` : 'Nobody looks free right now.',
      away.length ? `Idle, AFK or deafened (maybe away): ${list(away, 20, signed)}.` : '',
      busy.length ? `Busy: ${list(busy)}.` : '',
      dnd.length ? `Do not disturb: ${dnd.slice(0, 20).map((p) => p.name).join(', ')}.` : '',
      signedLine,
      'Match states are a guess from their game status.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  async function ping(guild: Guild, asker: GuildMember, game: string, minutes: number | undefined, ctx: ToolContext): Promise<string> {
    const key = `${guild.id}:${gameKey(game)}`;
    const last = cooldown.get(key);
    if (last !== undefined && now() - last < d.cooldownMs) {
      const left = Math.ceil((d.cooldownMs - (now() - last)) / 60_000);
      return `Not sent: ${game} pings already went out ${Math.max(1, Math.round((now() - last) / 60_000))} minutes ago. The next one can go in ${left} minute${left === 1 ? '' : 's'}.`;
    }
    // Taken now, before anything waits: a second ask arriving meanwhile (the
    // call and a chat at once) finds it and sends nothing. Given back below
    // when nothing went out.
    cooldown.set(key, now());
    const sent = await send(guild, asker, game, minutes, ctx).catch((e: unknown) => ({ ok: false, text: `Not sent: ${(e as Error).message}` }));
    if (!sent.ok) cooldown.delete(key);
    return sent.text;
  }

  async function send(guild: Guild, asker: GuildMember, game: string, minutes: number | undefined, ctx: ToolContext): Promise<{ ok: boolean; text: string }> {
    const no = (text: string) => ({ ok: false, text });
    const where = pickTextChannel(guild, asker, { configured: d.channelId, current: ctx.channelId, lastUsed: d.lastText(guild.id), voice: d.voiceChannel(guild.id) });
    if ('error' in where) return no(`Not sent: ${where.error}`);
    const ch = where.channel;
    const ids = d.signups.everyone().filter((id) => id !== ctx.userId && d.signups.wants(id, game));
    // The ones not seen yet, in one request (works without the Server Members intent).
    const missing = ids.filter((id) => !guild.members.cache.has(id)).slice(0, 100);
    if (missing.length) await guild.members.fetch({ user: missing, time: 5_000 }).catch(() => undefined);
    const found = ids.map((id) => guild.members.cache.get(id));
    const present = d.presences ? (id: UserId) => guild.presences.cache.get(id)?.status : () => undefined;
    let skippedVoice = 0;
    let skippedDnd = 0;
    let hidden = 0;
    let recent = 0;
    const targets: GuildMember[] = [];
    for (const [k, t] of pinged) if (now() - t >= d.cooldownMs) pinged.delete(k);
    for (const m of found) {
      if (!m || m.user.bot) continue;
      // Pinged for any game within the cooldown: a new game name doesn't ping them again.
      if (pinged.has(`${guild.id}:${m.id}`)) {
        recent++;
        continue;
      }
      const vs = guild.voiceStates.cache.get(m.id);
      if (vs?.channelId && vs.channelId !== guild.afkChannelId) {
        skippedVoice++;
        continue;
      }
      if (present(m.id) === 'dnd') {
        skippedDnd++;
        continue;
      }
      if (!canSee(m, ch)) {
        hidden++;
        continue;
      }
      targets.push(m);
    }
    const recentNote = `${recent} pinged in the last ${Math.round(d.cooldownMs / 60_000)} minutes`;
    if (!targets.length) {
      if (!ids.length) return no(`Nobody has signed up for ${game} pings. Anyone can say "ping me for game night" to sign up.`);
      return no(`Nobody to ping: ${[skippedVoice ? `${skippedVoice} already in voice` : '', skippedDnd ? `${skippedDnd} on do not disturb` : '', hidden ? `${hidden} can't see #${ch.name}` : '', recent ? recentNote : ''].filter(Boolean).join(', ') || "the people signed up aren't in this server"}.`);
    }
    // Online people first, when that's visible.
    const rank = (m: GuildMember) => ({ online: 0, idle: 1 })[present(m.id) as 'online' | 'idle'] ?? 2;
    targets.sort((a, b) => rank(a) - rank(b));
    const sending = targets.slice(0, d.maxMentions);
    if (limiter.take(ctx.userId) !== undefined) return no(`Not sent: that's ${d.perUserPerHour} game-night pings from you in the last hour.`);
    const when = minutes === undefined || minutes <= 0 ? 'now' : minutes === 1 ? 'in 1 minute' : `in ${minutes} minutes`;
    const content = `**${escapeMarkdown(asker.displayName)}** is getting ${escapeMarkdown(game)} going ${when}. Who's in? ${sending.map((m) => `<@${m.id}>`).join(' ')}`;
    // Theirs before the send waits, so a second ping meanwhile skips them.
    for (const m of sending) pinged.set(`${guild.id}:${m.id}`, now());
    try {
      await ch.send({ content, allowedMentions: { users: sending.map((m) => m.id), parse: [] } });
    } catch {
      limiter.release(ctx.userId);
      for (const m of sending) pinged.delete(`${guild.id}:${m.id}`);
      return no(`Not sent: I couldn't post in #${ch.name}.`);
    }
    for (const [k, t] of cooldown) if (now() - t > d.cooldownMs) cooldown.delete(k);
    const left = targets.length - sending.length;
    const notes = [
      left ? `${left} more signed up weren't pinged: ${d.maxMentions} is the most at once` : '',
      skippedVoice ? `left out ${skippedVoice} already in voice` : '',
      skippedDnd ? `${skippedDnd} on do not disturb` : '',
      hidden ? `${hidden} who can't see #${ch.name}` : '',
      recent ? `left out ${recentNote}` : '',
    ].filter(Boolean);
    return { ok: true, text: `Pinged ${sending.length} ${sending.length === 1 ? 'person' : 'people'} in #${ch.name} for ${game}${notes.length ? ` (${notes.join('; ')})` : ''}.` };
  }

  return {
    spec: {
      name: 'game_night',
      description:
        "Game nights in this Discord server. who_free: who's around to play (game: for that game). who_playing: who in this Discord server is playing what right now (their Discord status) and who's in voice; not Steam friends (steam_friends) or players on a Minecraft server (game_server_status). ping: post one message pinging the people who signed up for game-night pings (\"get the squad on\", \"ping everyone for Valorant in 10\"): game is required, in_minutes is when it starts (the ping goes out now). join / leave: the person asking signs up for or stops game-night pings (\"ping me for game night\", \"stop pinging me\"), for one game or all. signed_up: who gets pings.",
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['who_free', 'who_playing', 'ping', 'join', 'leave', 'signed_up'] },
          game: { type: 'string', description: 'The game, as they said it.' },
          in_minutes: { type: 'number', description: 'For ping: minutes until it starts.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    timeoutMs: 12_000,
    // "Which game?" is a question back: their answer must still be heard.
    acts: (a) => (a.action === 'ping' && !!String(a.game ?? '').trim()) || a.action === 'join' || a.action === 'leave',
    speak: (a, raw) => (raw.startsWith('Ping ') && raw.endsWith('?') ? raw : a.action === 'ping' && raw.startsWith('Pinged ') && !raw.includes('(') ? 'Pinged them.' : undefined),
    asks: (raw) => raw.startsWith('Ping ') && raw.endsWith('?'),
    run: async (a, _signal, ctx) => {
      const action = String(a.action ?? '');
      const game = plainText(String(a.game ?? ''), 40).replace(/[@#:]/g, '');
      const { guild, asker } = await place(ctx);
      switch (action) {
        case 'join':
          return d.signups.join(ctx.userId, game || undefined);
        case 'leave':
          return d.signups.leave(ctx.userId, game || undefined);
        case 'signed_up': {
          const { names, unknown } = await named(guild, d.signups.everyone().filter((id) => d.signups.wants(id, game || undefined)));
          if (names.length) return `Signed up for ${game || 'game-night'} pings: ${names.slice(0, 30).join(', ')}${unknownNote(unknown)}.`;
          return unknown ? `${unknown} signed up for ${game || 'game-night'} pings, but I couldn't look up who right now.` : `Nobody has signed up for ${game || 'game-night'} pings yet.`;
        }
        case 'who_playing':
          return whoPlaying(guild, asker, game, ctx);
        case 'who_free':
          return whoFree(guild, asker, game, ctx);
        case 'ping': {
          const agreed = waiting.take(ctx);
          if (agreed && agreed.guildId === guild.id) return ping(guild, asker, agreed.game, agreed.minutes, ctx);
          if (!game) return 'Which game? Ask them.';
          const n = Number(a.in_minutes);
          const minutes = Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 240) : undefined;
          const said = ctx.said ?? '';
          if (PING_ME.test(said) && !PING_ORDER.test(said)) return 'Nothing sent: "ping me" is them signing up (join), not pinging others.';
          if (PING_ORDER.test(said) && !NOT_ORDER.test(said)) return ping(guild, asker, game, minutes, ctx);
          const line = `Ping the people signed up for ${game}?`;
          return waiting.hold(ctx, { guildId: guild.id, game, minutes }, ['ping', 'them', 'do', 'it', 'send'], line.length * 70) ? line : 'Not sent: one thing at a time.';
        }
        default:
          return `Unknown action "${action}".`;
      }
    },
  };
}

/** Prompt line: when to use it. */
export const GAME_NIGHT_RULE =
  "game_night is for who's free or playing in this server, game-night pings, and signing up for them (\"ping me for game night\" is join, \"stop pinging me\" is leave, only ever for the person asking). Don't @mention people yourself for game nights: ping does it, only for those who signed up.";
