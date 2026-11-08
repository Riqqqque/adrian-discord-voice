// What it can see of the Discord server, and passing messages on.
//
// server_info: the server, its members (roles, status, what they're playing,
// who's in which call), channels and roles. Only what the asker could see in
// Discord themselves: channels hidden from them stay hidden. The full member
// list and statuses need the Server Members and Presence intents.
//
// message_member: "tell Sam dinner's ready" → a DM to Sam, or a post in a text
// channel that @mentions Sam. Always says who it's from, pings only that
// person, and is rate limited per sender and per recipient. It goes straight
// out only when the asker's own words said it's for Sam ("tell Sam"); otherwise
// it's read back and waits for their yes, so text planted in the prompt can't
// pick a recipient.

import { ActivityType, ChannelType, type Client, escapeMarkdown, type Guild, type GuildBasedChannel, type GuildMember, PermissionFlagsBits } from 'discord.js';
import { PendingYes } from '../brain/tools.js';
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

const plainQuery = (query: string) => query.trim().replace(/^@/, '').toLowerCase();
const idIn = (query: string) => /^<@!?(\d+)>$/.exec(query.trim())?.[1] ?? (/^\d{15,22}$/.test(plainQuery(query)) ? plainQuery(query) : undefined);
const wholeNames = (m: Named) => [m.displayName, m.username, m.nickname ?? ''].map((n) => n.toLowerCase()).filter(Boolean);

/** Their ping code, their id, or one of their names in full. */
function isExactMatch(m: Named, query: string): boolean {
  const id = idIn(query);
  return id ? m.id === id : wholeNames(m).includes(plainQuery(query));
}

/** Members matching a name or mention: exact matches first, else partial. */
export function matchMembers<T>(all: T[], query: string, named: (m: T) => Named = (m) => m as Named): T[] {
  const exact = all.filter((m) => isExactMatch(named(m), query));
  if (exact.length || idIn(query)) return exact;
  const q = plainQuery(query);
  return q ? all.filter((m) => wholeNames(named(m)).some((n) => n.includes(q))) : [];
}

/** Words too common to name anyone: a member nicknamed "what" (or "Adrian")
 *  isn't named by "what time is it, Adrian". */
const EVERYDAY = new Set(
  ('a about adrian after again all also am an and any are as ask at be because been before best big bot bro but by call can come could day did do does dude everybody everyone for from game get give go going gonna good got great guys had has have he hello her here hers hey hi him his how i if im in is it its just know let like lol make man me message more music my need new nice no not now of off ok okay on one or our out over people ping play please really right said same say see send she should so some someone somebody tell thanks that the their them then there they think this time to today tomorrow tonight too two up us very wanna want was we well were what when where which who why will with would yeah yes yo you your').split(' '),
);
/** A name's words, without case, accents or fancy lettering; "BigMike" is two. */
const nameWords = (s: string) => s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Where a request says who it's for, in the words from nameWords: "tell Sam",
 *  "message to my Sam", "say hi to Sam", "let Sam know". Anyone can take a
 *  nickname the asker says all the time ("Weather"), so a name anywhere else in
 *  their words counts for nothing, and a miss only costs a yes. */
const WHO = [
  /\b(?:tell|ask|remind|ping|tag|poke|dm|pm|msg|message|text|notify|inform|warn|send|dile|avisale|mandale|escribele|preguntale)(?: (?:\S|to|my|our|big|little|lil|old))* (\S+(?: and \S+)*)/g,
  /\b(?:send|say|pass|forward|give|write|reply|relay)\b.*? to(?: my| our)* (\S+(?: and \S+)*)/g,
  /\blet ((?:\S+ ){1,3})know\b/g,
];

/** Did these words say it's for this person, by a whole word of a name? The
 *  start of one isn't enough: "tell Sam" isn't Samantha, whoever the model picks. */
export function namesMember(said: string | undefined, m: Named): boolean {
  const words = nameWords(said ?? '').join(' ');
  const heard = WHO.flatMap((re) => [...words.matchAll(re)].flatMap((hit) => hit[1]!.trim().split(' '))).filter((w) => w.length > 1 && !EVERYDAY.has(w));
  const names = [m.displayName, m.username, m.nickname ?? ''].flatMap(nameWords);
  return heard.some((w) => names.includes(w));
}

/** User ids a reply may ping: mentioned in it, in the allowed set, at most `max`. */
export function allowedPings(text: string, isMember: (id: string) => boolean, max = 5): string[] {
  const ids = [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]!))];
  return ids.filter(isMember).slice(0, max);
}

/** Owners send more, but not without limit: an owner's turn can be the one
 *  that was talked into it. */
const OWNER_PER_HOUR = 30;

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
  take(sender: string, target: string, owner = false): string | undefined {
    const s = this.recent(`s:${sender}`);
    const t = this.recent(`t:${target}`);
    const most = owner ? Math.max(this.perSender, OWNER_PER_HOUR) : this.perSender;
    if (s.length >= most) return `you've sent ${most} messages through me in the last hour`;
    if (t.length >= this.perTarget) return 'that person has had enough messages through me this hour';
    s.push(this.now());
    t.push(this.now());
    return undefined;
  }

  /** That send never went out: it doesn't count. */
  release(sender: string, target: string): void {
    this.sent.get(`s:${sender}`)?.pop();
    this.sent.get(`t:${target}`)?.pop();
  }
}

/** Most sends in one turn, for anyone. */
const MAX_PER_TURN = 3;
/** How much of a message is read back: all of what would be sent. */
const READ_BACK_CHARS = 200;
const READ_BACK = 'Send ';
/** About how long her voice takes per character, so a long read-back still
 *  leaves the full wait for the answer. */
const SPEAK_MS_PER_CHAR = 70;
/** What a yes to a read-back may say about it ("yes send it"). */
const SEND_WORDS = ['send', 'tell', 'him', 'her', 'them'];

/** A link as she can say it: where it really goes. */
function linkTo(url: string): string {
  try {
    return `a link to ${new URL(url).hostname}`;
  } catch {
    return 'a link';
  }
}

/** A message as a read-back: where links go, and nothing her voice would skip
 *  (a code block, the words over a link) or a reply would ping. */
const asHeard = (text: string) =>
  text
    .replace(/https?:\/\/[^\s"<>)\]`]+/gi, linkTo)
    .replace(/<@[!&]?\d+>/g, '@someone')
    .replace(/[`[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** One message on its way: to `where` with a ping, or by DM. */
interface Outgoing {
  target: GuildMember;
  text: string;
  from: string;
  guildName: string;
  where?: GuildBasedChannel | undefined;
}

const day = (d: Date | null | undefined, timeZone: string) =>
  d ? d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }) : 'unknown';

const KINDS = ['overview', 'members', 'member', 'online', 'voice', 'channels', 'roles'] as const;

export function discordTools(d: DiscordInfoDeps, relay?: { limiter: RelayLimiter; isOwner: (id: string) => boolean; maxChars: number; now?: () => number }): Tool[] {
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
    const known = await everyone(guild);
    const local = matchMembers(known, query, asNamed);
    if (d.members || local.some((m) => isExactMatch(asNamed(m), query))) return local;
    // No member list, so a partial hit is only the best of who she's seen: the
    // real Sam may be someone else. Discord's name search works without the intent.
    const found = await guild.members.search({ query: query.replace(/^@/, '').slice(0, 32), limit: 10 }).catch(() => undefined);
    if (!found) return local;
    return matchMembers([...new Map([...known, ...found.values()].map((m) => [m.id, m])).values()], query, asNamed);
  }

  /** What Discord would show them. A thread answers with its parent's
   *  permissions, but a private one is only for its members and moderators.
   *  Membership is what's cached: unknown counts as no. */
  const canSee = (m: GuildMember, ch: GuildBasedChannel) => {
    const perms = ch.permissionsFor(m);
    if (!perms?.has(PermissionFlagsBits.ViewChannel)) return false;
    return ch.type !== ChannelType.PrivateThread || ch.ownerId === m.id || ch.members.cache.has(m.id) || perms.has(PermissionFlagsBits.ManageThreads);
  };

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
        "Look up this Discord server: overview (name, size, owner, boosts), members (list or search, with name filter), member (one person's details: roles, join date, status, what they're playing or listening to, which call they're in), online (who's online and doing what; who's free or playing for a game night is game_night, if you have it), voice (who's in which voice channel), channels, roles. Results include each person's ping code for @mentioning them in text.",
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

  const waiting = new PendingYes<Outgoing>(relay.now);
  /** Sends so far in a turn: each ask() makes one fresh context. */
  const sends = new WeakMap<ToolContext, number>();

  const deliver = async (o: Outgoing, ctx: ToolContext): Promise<string> => {
    const why = relay.limiter.take(ctx.userId, o.target.id, relay.isOwner(ctx.userId));
    if (why) return `Not sent: ${why}.`;
    sends.set(ctx, (sends.get(ctx) ?? 0) + 1);
    const { target, text, from, where } = o;
    try {
      if (where) {
        await (where as GuildBasedChannel & { send(o: object): Promise<unknown> }).send({ content: `<@${target.id}> from **${from}**: ${text}`, allowedMentions: { users: [target.id], parse: [] } });
        return `Posted in #${where.name} and pinged ${target.displayName}.`;
      }
      await target.send({ content: `**${from}** (in ${o.guildName}) asked me to tell you: ${text}`, allowedMentions: { parse: [] } });
      return `Sent ${target.displayName} a DM.`;
    } catch {
      // It never went out: it costs nothing, so the suggested retry works.
      relay.limiter.release(ctx.userId, target.id);
      sends.set(ctx, sends.get(ctx)! - 1);
      return where ? `Couldn't post in #${where.name}.` : `Couldn't DM ${target.displayName}: their DMs are closed to me. Try how=channel.`;
    }
  };

  const message: Tool = {
    spec: {
      name: 'message_member',
      description:
        'Pass a message on to someone in this server when asked ("tell Sam dinner\'s ready", "let Kim know we\'re starting", "ping Alex in general"). how: dm (a private message, the default) or channel (posts in a text channel and @mentions them; channel defaults to the current chat). The message is sent as from the asker, in your words. If they didn\'t name the person themselves, it asks them first by itself: call it again once they say yes. Don\'t use it for someone in the same voice call: just say it.',
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
    acts: true,
    timeoutMs: 12_000,
    speak: (_a, raw) => (raw.startsWith(READ_BACK) ? raw : undefined),
    asks: (raw) => raw.startsWith(READ_BACK),
    run: async (a, _signal, ctx) => {
      if ((sends.get(ctx) ?? 0) >= MAX_PER_TURN) return 'Not sent: three messages is the most I send in one go.';
      // Their yes: what was read back goes out, whatever the model asks for now.
      const agreed = waiting.take(ctx);
      if (agreed) return deliver(agreed, ctx);
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
        const post = where.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
        const ok = (m: GuildMember | null | undefined) => !!m && canSee(m, where!) && !!where!.permissionsFor(m)?.has(post);
        if (!ok(asker)) return `You can't post in #${where.name}.`;
        if (!ok(guild.members.me)) return `I can't post in #${where.name}.`;
        if (!canSee(target, where)) return `${target.displayName} can't see #${where.name}, so I didn't post it there. A DM would reach them.`;
      }
      // Markdown in a name could hide the account beside it.
      const from = `${escapeMarkdown(asker.displayName)} (@${escapeMarkdown(asker.user.username)})`;
      if (namesMember(ctx.said, asNamed(target))) return deliver({ target, text, from, guildName: guild.name, where }, ctx);
      // Their words never named this person: only their yes can send it.
      const short = text.length > READ_BACK_CHARS ? `${text.slice(0, READ_BACK_CHARS)}…` : text;
      const line = `${READ_BACK}${target.displayName}${where ? ` in #${where.name}` : ''}: "${asHeard(short)}"?`;
      const about = [...SEND_WORDS, ...nameWords(target.displayName)];
      return waiting.hold(ctx, { target, text: short, from, guildName: guild.name, where }, about, line.length * SPEAK_MS_PER_CHAR) ? line : 'Not sent: one thing at a time, ask me again after this one.';
    },
  };
  return [info, message];
}
