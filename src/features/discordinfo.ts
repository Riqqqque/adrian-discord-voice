// What it can see of the Discord server, and passing messages on.
//
// server_info: the server, its members (roles, status, what they're playing,
// who's in which call), channels and roles. Only what the asker could see in
// Discord themselves: channels hidden from them stay hidden. The full member
// list and statuses need the Server Members and Presence intents.
//
// message_member: "tell Sam dinner's ready" → a DM to Sam, or a post in a text
// channel that @mentions Sam. Always says who it's from, pings only that
// person, and is rate limited per sender and per recipient.

import { ActivityType, ChannelType, type Client, type Guild, type GuildBasedChannel, type GuildMember, PermissionFlagsBits } from 'discord.js';
import type { Tool, ToolContext } from '../core/interfaces.js';

export interface DiscordInfoDeps {
  client: Client;
  allowedGuilds: readonly string[];
  /** Server Members intent: the whole member list. */
  members: boolean;
  /** Presence intent: online status and activities. */
  presences: boolean;
  timezone: string;
}

export interface Activity {
  type: number;
  name: string;
  details?: string | null;
  state?: string | null;
}

/** "playing Valorant", "listening to Spotify: Humble by Kendrick Lamar". */
export function describeActivity(a: Activity): string {
  const extra = [a.details, a.state].filter(Boolean).join(' - ');
  switch (a.type) {
    case ActivityType.Playing:
      return `playing ${a.name}${extra ? ` (${extra})` : ''}`;
    case ActivityType.Streaming:
      return `streaming ${a.details ?? a.name}`;
    case ActivityType.Listening:
      return `listening to ${a.name}${a.details ? `: ${a.details}${a.state ? ` by ${a.state}` : ''}` : ''}`;
    case ActivityType.Watching:
      return `watching ${a.name}${extra ? ` (${extra})` : ''}`;
    case ActivityType.Custom:
      return a.state ? `status "${a.state}"` : '';
    case ActivityType.Competing:
      return `competing in ${a.name}`;
    default:
      return a.name;
  }
}

export interface Named {
  id: string;
  displayName: string;
  username: string;
  nickname?: string | null;
}

/** Members matching a name or mention: exact matches first, else partial. */
export function matchMembers<T>(all: T[], query: string, named: (m: T) => Named = (m) => m as Named): T[] {
  const q = query.trim().replace(/^@/, '').toLowerCase();
  const id = /^<@!?(\d+)>$/.exec(query.trim())?.[1] ?? (/^\d{15,22}$/.test(q) ? q : undefined);
  if (id) return all.filter((m) => named(m).id === id);
  if (!q) return [];
  const names = (x: T) => {
    const m = named(x);
    return [m.displayName, m.username, m.nickname ?? ''].map((n) => n.toLowerCase()).filter(Boolean);
  };
  const exact = all.filter((m) => names(m).includes(q));
  if (exact.length) return exact;
  return all.filter((m) => names(m).some((n) => n.includes(q)));
}

/** User ids a reply may ping: mentioned in it, in the allowed set, at most `max`. */
export function allowedPings(text: string, isMember: (id: string) => boolean, max = 5): string[] {
  const ids = [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]!))];
  return ids.filter(isMember).slice(0, max);
}

/** Sliding one-hour windows per sender and per recipient. */
export class RelayLimiter {
  private readonly sent = new Map<string, number[]>();
  constructor(
    private readonly perSender: number,
    private readonly perTarget: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const hourAgo = this.now() - 3_600_000;
    const l = (this.sent.get(key) ?? []).filter((t) => t > hourAgo);
    this.sent.set(key, l);
    return l;
  }

  /** A reason it can't send, or undefined (and the send is counted). */
  take(sender: string, target: string, exempt = false): string | undefined {
    const s = this.recent(`s:${sender}`);
    const t = this.recent(`t:${target}`);
    if (!exempt && s.length >= this.perSender) return `you've sent ${this.perSender} messages through me in the last hour`;
    if (!exempt && t.length >= this.perTarget) return 'that person has had enough messages through me this hour';
    s.push(this.now());
    t.push(this.now());
    return undefined;
  }
}

const day = (d: Date | null | undefined, timeZone: string) =>
  d ? d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown';

const KINDS = ['overview', 'members', 'member', 'online', 'voice', 'channels', 'roles'] as const;

export function discordTools(d: DiscordInfoDeps, relay?: { limiter: RelayLimiter; isOwner: (id: string) => boolean; maxChars: number }): Tool[] {
  const { client } = d;
  const allowed = (g: Guild) => !d.allowedGuilds.length || d.allowedGuilds.includes(g.id);

  /** The server this is about, and the asker as a member of it. */
  async function place(ctx: ToolContext, serverName?: unknown): Promise<{ guild: Guild; asker: GuildMember }> {
    if (!/^\d{15,22}$/.test(ctx.userId)) throw new Error('unknown asker');
    if (ctx.guildId) {
      const guild = client.guilds.cache.get(ctx.guildId);
      if (!guild || !allowed(guild)) throw new Error('not in a server here');
      return { guild, asker: await guild.members.fetch(ctx.userId) };
    }
    // A DM: servers both share, picked by name when there are several.
    const shared: { guild: Guild; asker: GuildMember }[] = [];
    for (const guild of client.guilds.cache.values()) {
      if (!allowed(guild)) continue;
      const asker = await guild.members.fetch(ctx.userId).catch(() => undefined);
      if (asker) shared.push({ guild, asker });
    }
    if (!shared.length) throw new Error("you're not in any server with me");
    const want = typeof serverName === 'string' ? serverName.trim().toLowerCase() : '';
    const hit = want ? shared.filter((s) => s.guild.name.toLowerCase().includes(want)) : shared;
    if (hit.length === 1) return hit[0]!;
    throw new Error(`which server? ${shared.map((s) => s.guild.name).join(', ')}`);
  }

  const fetchedAt = new Map<string, number>();
  /** Everyone in the server: fetched at most every 10 minutes (needs the intent). */
  async function everyone(guild: Guild): Promise<GuildMember[]> {
    if (d.members && Date.now() - (fetchedAt.get(guild.id) ?? 0) > 600_000) {
      await guild.members.fetch({ time: 8_000 }).catch(() => undefined);
      fetchedAt.set(guild.id, Date.now());
    }
    return [...guild.members.cache.values()];
  }

  const asNamed = (m: GuildMember): Named => ({ id: m.id, displayName: m.displayName, username: m.user.username, nickname: m.nickname });
  async function find(guild: Guild, query: string): Promise<GuildMember[]> {
    const local = matchMembers(await everyone(guild), query, asNamed);
    if (local.length || d.members) return local;
    // No member list: Discord's name search works without the intent.
    const found = await guild.members.search({ query: query.replace(/^@/, '').slice(0, 32), limit: 10 }).catch(() => undefined);
    return found ? matchMembers([...found.values()], query, asNamed) : [];
  }

  const canSee = (asker: GuildMember, ch: GuildBasedChannel) => ch.permissionsFor(asker)?.has(PermissionFlagsBits.ViewChannel) ?? false;

  function status(m: GuildMember): string {
    if (!d.presences) return '';
    const p = m.presence;
    if (!p || p.status === 'offline') return 'offline';
    const acts = p.activities.map((a) => describeActivity(a)).filter(Boolean);
    return [p.status === 'dnd' ? 'do not disturb' : p.status, ...acts].join(', ');
  }

  function line(m: GuildMember, asker: GuildMember): string {
    const voice = m.voice.channel && canSee(asker, m.voice.channel) ? `in voice ${m.voice.channel.name}` : '';
    const bits = [m.user.bot ? 'bot' : '', status(m), voice].filter(Boolean).join('; ');
    return `${m.displayName} (@${m.user.username}, ping code <@${m.id}>)${bits ? `: ${bits}` : ''}`;
  }

  function detail(m: GuildMember, asker: GuildMember): string {
    const roles = [...m.roles.cache.values()].filter((r) => r.id !== m.guild.id).sort((a, b) => b.position - a.position).map((r) => r.name);
    return [
      line(m, asker),
      `joined the server ${day(m.joinedAt, d.timezone)}, account made ${day(m.user.createdAt, d.timezone)}`,
      roles.length ? `roles: ${roles.join(', ')}` : 'no roles',
      m.premiumSince ? `boosting since ${day(m.premiumSince, d.timezone)}` : '',
      m.id === m.guild.ownerId ? 'owns the server' : '',
    ]
      .filter(Boolean)
      .join('. ');
  }

  const info: Tool = {
    spec: {
      name: 'server_info',
      description:
        "Look up this Discord server: overview (name, size, owner, boosts), members (list or search, with name filter), member (one person's details: roles, join date, status, what they're playing or listening to, which call they're in), online (who's online and doing what), voice (who's in which voice channel), channels, roles. Results include each person's ping code for @mentioning them in text.",
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: [...KINDS] },
          name: { type: 'string', description: 'A person (for member/members) or a filter.' },
          server: { type: 'string', description: 'Server name, only in DMs when the person shares several servers with you.' },
        },
        required: ['what'],
        additionalProperties: false,
      },
    },
    timeoutMs: 12_000,
    run: async (a, _signal, ctx) => {
      const what = String(a.what ?? 'overview');
      const name = typeof a.name === 'string' ? a.name.trim().slice(0, 64) : '';
      const { guild, asker } = await place(ctx, a.server);
      const gaps = [
        !d.members && ['members', 'online', 'roles'].includes(what) ? '(Only people I have seen recently are listed: the full member list needs the Server Members intent.)' : '',
        !d.presences && ['online', 'member', 'members'].includes(what) ? "(Online status and activities aren't available: that needs the Presence intent.)" : '',
      ].filter(Boolean);
      const out = (lines: string[]) => [...lines, ...gaps].join('\n').slice(0, 6_000);
      switch (what) {
        case 'overview': {
          const owner = await guild.fetchOwner().catch(() => undefined);
          const chans = [...guild.channels.cache.values()].filter((c) => canSee(asker, c));
          return out([
            `${guild.name}${guild.description ? `: ${guild.description}` : ''}`,
            `${guild.memberCount} members, made ${day(guild.createdAt, d.timezone)}, owner ${owner?.displayName ?? 'unknown'}`,
            `boost level ${guild.premiumTier} with ${guild.premiumSubscriptionCount ?? 0} boosts`,
            `${chans.filter((c) => c.isTextBased() && !c.isVoiceBased()).length} text and ${chans.filter((c) => c.isVoiceBased()).length} voice channels you can see, ${guild.roles.cache.size - 1} roles`,
          ]);
        }
        case 'member': {
          if (!name) return 'Say which person.';
          const hits = await find(guild, name);
          if (!hits.length) return `Nobody called "${name}" here.`;
          if (hits.length > 4) return out([`${hits.length} people match "${name}":`, ...hits.slice(0, 15).map((m) => line(m, asker))]);
          return out(hits.map((m) => detail(m, asker)));
        }
        case 'members':
        case 'online': {
          let list = name ? await find(guild, name) : await everyone(guild);
          if (what === 'online') list = list.filter((m) => m.presence && m.presence.status !== 'offline');
          list.sort((x, y) => Number(x.user.bot) - Number(y.user.bot) || x.displayName.localeCompare(y.displayName));
          if (!list.length) return out([what === 'online' ? 'Nobody is shown as online.' : 'Nobody found.']);
          return out([`${list.length} ${what === 'online' ? 'online' : 'members'}${name ? ` matching "${name}"` : ''}:`, ...list.slice(0, 60).map((m) => line(m, asker)), ...(list.length > 60 ? [`and ${list.length - 60} more`] : [])]);
        }
        case 'voice': {
          const rooms = [...guild.channels.cache.values()].filter((c) => c.isVoiceBased() && canSee(asker, c) && c.members.size) as (GuildBasedChannel & { members: Map<string, GuildMember> })[];
          if (!rooms.length) return 'Nobody is in a voice channel.';
          return out(rooms.map((c) => `${c.name}: ${[...c.members.values()].map((m) => `${m.displayName}${m.voice.selfMute || m.voice.serverMute ? ' (muted)' : ''}${m.voice.streaming ? ' (streaming)' : ''}`).join(', ')}`));
        }
        case 'channels': {
          const chans = [...guild.channels.cache.values()].filter((c) => c.type !== ChannelType.GuildCategory && canSee(asker, c));
          chans.sort((x, y) => ('position' in x && 'position' in y ? (x.position as number) - (y.position as number) : 0));
          return out(
            chans.slice(0, 80).map((c) => {
              const kind = c.isVoiceBased() ? 'voice' : c.type === ChannelType.GuildForum ? 'forum' : c.isThread() ? 'thread' : 'text';
              const topic = 'topic' in c && c.topic ? `: ${String(c.topic).slice(0, 100)}` : '';
              return `${kind === 'voice' ? '' : '#'}${c.name} (${kind}${c.parent ? `, in ${c.parent.name}` : ''})${topic}`;
            }),
          );
        }
        case 'roles': {
          if (d.members) await everyone(guild);
          const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((x, y) => y.position - x.position);
          return out(roles.slice(0, 60).map((r) => `${r.name}${d.members ? ` (${r.members.size} people)` : ''}`));
        }
        default:
          return `Unknown lookup "${what}".`;
      }
    },
  };
  if (!relay) return [info];

  const message: Tool = {
    spec: {
      name: 'message_member',
      description:
        'Pass a message on to someone in this server when asked ("tell Sam dinner\'s ready", "let Kim know we\'re starting", "ping Alex in general"). how: dm (a private message, the default) or channel (posts in a text channel and @mentions them; channel defaults to the current chat). The message is sent as from the asker, in your words. Don\'t use it for someone in the same voice call: just say it.',
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', description: 'Who: their name or ping code.' },
          message: { type: 'string', description: 'What to tell them, written to them. Who it is from is added automatically.' },
          how: { type: 'string', enum: ['dm', 'channel'] },
          channel: { type: 'string', description: 'Text channel name, for how=channel when it should go somewhere else.' },
          server: { type: 'string', description: 'Server name, only in DMs when needed.' },
        },
        required: ['member', 'message'],
        additionalProperties: false,
      },
    },
    timeoutMs: 12_000,
    run: async (a, _signal, ctx) => {
      const text = String(a.message ?? '').replace(/@(everyone|here)/gi, '@​$1').trim().slice(0, relay.maxChars);
      if (!text) return 'What should I tell them?';
      const { guild, asker } = await place(ctx, a.server);
      const hits = await find(guild, String(a.member ?? ''));
      if (!hits.length) return `Nobody called "${String(a.member)}" here.`;
      if (hits.length > 1) return `Which one? ${hits.slice(0, 8).map((m) => `${m.displayName} (@${m.user.username})`).join(', ')}`;
      const target = hits[0]!;
      if (target.user.bot) return "That's a bot; it won't read it.";
      if (target.id === ctx.userId) return "That's the person asking.";
      const how = a.how === 'channel' ? 'channel' : 'dm';

      let where: GuildBasedChannel | undefined;
      if (how === 'channel') {
        const want = typeof a.channel === 'string' ? a.channel.trim().replace(/^#/, '').toLowerCase() : '';
        const chans = [...guild.channels.cache.values()].filter((c) => c.isTextBased() && canSee(asker, c));
        where = want ? (chans.find((c) => c.name.toLowerCase() === want) ?? chans.find((c) => c.name.toLowerCase().includes(want))) : chans.find((c) => c.id === ctx.channelId);
        if (!where) return want ? `No text channel called "${want}" that you can see.` : 'Which channel?';
        const me = guild.members.me;
        const ok = (m: GuildMember | null | undefined) => !!m && !!where!.permissionsFor(m)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
        if (!ok(asker)) return `You can't post in #${where.name}.`;
        if (!ok(me)) return `I can't post in #${where.name}.`;
      }
      const why = relay.limiter.take(ctx.userId, target.id, relay.isOwner(ctx.userId));
      if (why) return `Not sent: ${why}.`;
      const from = asker.displayName;
      if (how === 'dm') {
        try {
          await target.send({ content: `**${from}** (in ${guild.name}) asked me to tell you: ${text}`, allowedMentions: { parse: [] } });
        } catch {
          return `Couldn't DM ${target.displayName}: their DMs are closed to me. Try how=channel.`;
        }
        return `Sent ${target.displayName} a DM.`;
      }
      await (where as GuildBasedChannel & { send(o: object): Promise<unknown> }).send({ content: `<@${target.id}> from **${from}**: ${text}`, allowedMentions: { users: [target.id], parse: [] } });
      return `Posted in #${where!.name} and pinged ${target.displayName}.`;
    },
  };
  return [info, message];
}
