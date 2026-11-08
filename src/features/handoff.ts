// Between the PC and Discord.
//
// "Send that link to my PC", "put that video on my PC": "that" is the newest
// thing in a small per-person memory of links and media (what they posted,
// what she wrote to them, links others posted where they can see), or the
// song playing in the call. Two close together: she asks which.
//
// "Move the music to my PC": the call's song opens on their PC, and stops in
// the call if they started it (or are an owner). "Put what I'm watching into
// the call": what their PC is playing, found on YouTube and played in the call.
//
// "Tell the call I'll be on in five": said in the voice call she's in, as from
// them, or posted in a text channel when nobody there would hear it.
//
// Everything goes to the asker's own PC only, and nothing here can ping.

import { escapeMarkdown } from 'discord.js';
import { PendingYes } from '../brain/tools.js';
import type { Tool, ToolContext, UserId } from '../core/interfaces.js';
import { webUrl } from '../satellite/tools.js';
import { parseMediaLink } from './links.js';
import type { RequestKind, RequestResult, Track } from './music.js';
import { plainText } from './textchannel.js';

// --- the last things ------------------------------------------------------

export type ThingKind = 'link' | 'video' | 'song';

export interface Thing {
  kind: ThingKind;
  url: string;
  /** A YouTube video, when it is one. */
  videoId?: string;
  /** Who it came from: them, her (a reply to them), or someone else. */
  by: 'self' | 'her' | 'other';
  /** The other person's name, when by is other. */
  who?: string;
  whoId?: string;
  guildId?: string;
  channelId?: string;
  at: number;
  /** Order noted in, for things from the same moment. */
  seq?: number;
}

export interface LastThingsOptions {
  /** Forget things after this long (default 30 minutes). */
  keepMs?: number;
  /** Most kept per person (default 10). */
  perPerson?: number;
  /** Most people kept at once (default 200). */
  people?: number;
  /** Others' links count for this long (default 10 minutes). */
  othersMs?: number;
}

/** Every public web link in a message, in order, as things. Discord's
 *  `<link>` (no preview) counts too. */
export function linksIn(text: string): Pick<Thing, 'kind' | 'url' | 'videoId'>[] {
  const out: Pick<Thing, 'kind' | 'url' | 'videoId'>[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    // A sentence's own punctuation isn't part of the link: "see https://x.com/a."
    let url = m[0].replace(/[.,!?;:'*_~]+$/, '');
    if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
    if (!webUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const media = parseMediaLink(url);
    if (media?.kind === 'youtube') out.push({ kind: 'video', url: media.url, videoId: media.id });
    else if (media && media.kind !== 'youtube-list') out.push({ kind: 'song', url });
    else out.push({ kind: 'link', url });
  }
  return out.slice(0, 5);
}

/** Bounded memory of links and media, per person and per server. */
export class LastThings {
  private readonly mine = new Map<UserId, Thing[]>();
  private others: Thing[] = [];
  private seq = 0;
  /** Messages she couldn't read (no Message Content intent), per server. */
  private readonly hidden = new Map<string, { at: number; channelId: string; userId: UserId }[]>();
  readonly keepMs: number;
  private readonly perPerson: number;
  private readonly people: number;
  readonly othersMs: number;

  constructor(
    o: LastThingsOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.keepMs = o.keepMs ?? 30 * 60_000;
    this.perPerson = o.perPerson ?? 10;
    this.people = o.people ?? 200;
    this.othersMs = o.othersMs ?? 10 * 60_000;
  }

  /** Theirs: something they posted, or that she wrote to them. */
  addFor(userId: UserId, t: Omit<Thing, 'at'>): void {
    const list = (this.mine.get(userId) ?? []).filter((x) => x.url !== t.url);
    list.push({ ...t, at: this.now(), seq: ++this.seq });
    if (list.length > this.perPerson) list.splice(0, list.length - this.perPerson);
    this.mine.delete(userId); // newest last, so the oldest person goes first
    this.mine.set(userId, list);
    while (this.mine.size > this.people) this.mine.delete(this.mine.keys().next().value!);
  }

  /** Posted in a server channel: others there can mean it too. */
  addShared(t: Omit<Thing, 'at'> & { whoId: UserId; guildId: string; channelId: string }): void {
    this.others = this.others.filter((x) => !(x.url === t.url && x.whoId === t.whoId));
    this.others.push({ ...t, by: 'other', at: this.now(), seq: ++this.seq });
    if (this.others.length > this.perPerson * 5) this.others.splice(0, this.others.length - this.perPerson * 5);
  }

  /** A message she got without its words (Discord hides them without the intent). */
  unreadable(guildId: string, channelId: string, userId: UserId): void {
    const list = (this.hidden.get(guildId) ?? []).filter((h) => h.at >= this.now() - this.keepMs).slice(-19);
    list.push({ at: this.now(), channelId, userId });
    this.hidden.set(guildId, list);
    while (this.hidden.size > 50) this.hidden.delete(this.hidden.keys().next().value!);
  }

  /** The newest message in this server she couldn't read, from someone else, after `since`. */
  hiddenSince(guildId: string | undefined, userId: UserId, since: number): { channelId: string } | undefined {
    if (!guildId) return undefined;
    const h = (this.hidden.get(guildId) ?? []).filter((x) => x.at > since && x.at >= this.now() - this.keepMs && x.userId !== userId).at(-1);
    return h ? { channelId: h.channelId } : undefined;
  }

  /** What "that" can be for them, newest first: their own and hers (anywhere),
   *  and others' in this server from the last few minutes. */
  candidates(userId: UserId, guildId?: string): Thing[] {
    const t = this.now();
    const fresh = (x: Thing) => x.at >= t - this.keepMs;
    for (const [id, list] of this.mine) {
      const keep = list.filter(fresh);
      if (keep.length) this.mine.set(id, keep);
      else this.mine.delete(id);
    }
    this.others = this.others.filter(fresh);
    const own = this.mine.get(userId) ?? [];
    const shared = guildId ? this.others.filter((x) => x.guildId === guildId && x.whoId !== userId && x.at >= t - this.othersMs) : [];
    // Newest first; within the same moment, the one noted last.
    return [...own, ...shared].sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0));
  }
}

/** One Discord message, as the store needs it. */
export interface SeenMessage {
  authorId: UserId;
  authorName: string;
  bot: boolean;
  /** Her own message. */
  mine: boolean;
  /** Text and embed links, as received (empty without Message Content). */
  text: string;
  hasAttachments: boolean;
  guildId?: string;
  channelId: string;
  /** Who her message answers: the replied-to person, or the DM's other end. */
  to?: UserId;
}

/** Remember what's in a message. `readable`: Discord gives this bot the words
 *  of every message (Message Content intent); without it only messages that
 *  mention her and DMs have any. */
export function noteMessage(things: LastThings, m: SeenMessage, readable: boolean): void {
  if (m.mine) {
    if (m.to) for (const l of linksIn(m.text)) things.addFor(m.to, { ...l, by: 'her', ...(m.guildId ? { guildId: m.guildId } : {}), channelId: m.channelId });
    return;
  }
  if (m.bot) return;
  const found = linksIn(m.text);
  for (const l of found) {
    const where = { ...(m.guildId ? { guildId: m.guildId } : {}), channelId: m.channelId };
    things.addFor(m.authorId, { ...l, by: 'self', ...where });
    if (m.guildId) things.addShared({ ...l, by: 'other', who: m.authorName, whoId: m.authorId, guildId: m.guildId, channelId: m.channelId });
  }
  if (!readable && m.guildId && !m.text.trim() && !m.hasAttachments) things.unreadable(m.guildId, m.channelId, m.authorId);
}

// --- who started the music ------------------------------------------------

/** Who started what's playing in a room. A track nobody picked (radio after
 *  the queue ran out) still belongs to whoever started the session. */
export class MusicStarts {
  private readonly by = new Map<string, { userId: UserId; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  started(roomKey: string, userId: UserId): void {
    this.by.set(roomKey, { userId, at: this.now() });
  }

  starter(roomKey: string): { userId: UserId; at: number } | undefined {
    return this.by.get(roomKey);
  }

  stopped(roomKey: string): void {
    this.by.delete(roomKey);
  }
}

/** play_music, noting who started music in a room when it starts playing now
 *  (not when it only queued something behind what's on). */
export function notingStarts(t: Tool, starts: MusicStarts, roomOf: (ctx: ToolContext) => string): Tool {
  if (t.spec.name !== 'play_music') return t;
  return {
    ...t,
    run: async (a, signal, ctx) => {
      const r = await t.run(a, signal, ctx);
      if ((typeof r === 'string' ? r : r.text).startsWith('Now playing')) starts.started(roomOf(ctx), ctx.userId);
      return r;
    },
  };
}

// --- what a PC is playing ---------------------------------------------------

export interface PcPlayer {
  app: string;
  state: 'playing' | 'paused' | 'stopped' | 'other';
  title: string;
  artist?: string;
}

/** pc_media status, back into players: "Spotify is playing “Nights” by Frank
 *  Ocean." (several players: those sentences, one after another). Mirrors
 *  describe() in crates/pc-control/src/win/media.rs. */
export function parsePlayers(status: string): PcPlayer[] {
  const out: PcPlayer[] = [];
  const re = /(\S+) is (playing|paused on|stopped on|has) “(.+?)”(?: by (.+?))?\.(?=\s+\S+ is |\s*$)/g;
  for (const m of status.matchAll(re)) {
    const state = m[2] === 'playing' ? 'playing' : m[2] === 'paused on' ? 'paused' : m[2] === 'stopped on' ? 'stopped' : 'other';
    out.push({ app: m[1]!, state, title: m[3]!.trim(), ...(m[4] ? { artist: m[4].trim() } : {}) });
  }
  return out;
}

const BROWSER = /^(chrome|edge|firefox|opera|brave|vivaldi|arc|browser|msedge)$/i;
/** Sites and apps whose shows can't be found and played from YouTube. */
const STREAMING = /\b(netflix|disney\+?|hulu|prime video|amazon|max|hbo|crunchyroll|apple tv|paramount\+?|peacock|twitch|kick|plex|jellyfin)\b/i;

/** What to play in the call for a PC player: a song search, a YouTube video
 *  search, or why it can't be. */
export function callRequestFor(p: PcPlayer): { kind: RequestKind; query: string; label: string } | { refuse: string } {
  const where = `${p.app} ${p.title}`;
  const service = STREAMING.exec(where)?.[1];
  if (service) return { refuse: `That's ${service.replace(/^\w/, (c) => c.toUpperCase())}: I can only play things I can find on YouTube or Plex in the call.` };
  const title = p.title.replace(/\s+[-|–]\s+YouTube(?: Music)?$/i, '').trim();
  if (!title) return { refuse: "I can't tell what's playing on your PC." };
  if (BROWSER.test(p.app)) {
    // A browser tab without a channel name could be anything, a streaming site included.
    if (!p.artist) return { refuse: `I can't tell what that ${p.app} tab is playing well enough to find it. Tell me what it is and I'll play it.` };
    return { kind: 'video', query: `${title} ${p.artist}`.slice(0, 200), label: title };
  }
  return { kind: 'song', query: (p.artist ? `${title} ${p.artist}` : title).slice(0, 200), label: p.artist ? `${title} by ${p.artist}` : title };
}

// --- the tools --------------------------------------------------------------

export interface PcLike {
  action(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: string }>;
}

export interface CallMusic {
  readonly nowPlaying: Track | undefined;
  stop(): boolean;
  request(kind: RequestKind, query: string, mode: 'now' | 'queue', signal: AbortSignal): Promise<RequestResult>;
}

export interface HandoffDeps {
  things: LastThings;
  starts: MusicStarts;
  /** The room key of the Discord call, for `starts`. */
  callRoom: string;
  pcFor(ctx: ToolContext): PcLike | undefined;
  /** The call's music player, if music is on. */
  callMusic(): CallMusic | undefined;
  /** Her voice call: whether she's connected, and the people in it (no bots). */
  call(): { ready: boolean; humans: UserId[] } | undefined;
  /** In her voice channel. */
  inCall(userId: UserId): boolean;
  isOwner(userId: UserId): boolean;
  /** Could they see that channel (another person's link)? */
  canSee(userId: UserId, guildId: string, channelId: string): Promise<boolean>;
  /** The server a PC or a DM means (the home one). */
  homeGuild?: string;
  /** Message Content is on: she sees links in every message. */
  readable: boolean;
  /** A YouTube video for a search, so a Plex song opens as a video. */
  findVideo?(query: string, signal: AbortSignal): Promise<string | undefined>;
  now?(): number;
}

const NOT_DONE = "Didn't happen: ";
const noPc = (ctx: ToolContext) => `No PC is connected for ${ctx.speaker}. Their A.D.R.I.A.N. satellite app has to be running on it.`;
/** Two things this close together: "that" could be either, so she asks. */
const CLOSE_MS = 90_000;
/** How long a numbered list of choices can be answered. */
const CHOICE_MS = 3 * 60_000;

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'a page';
  }
};

/** The PC refused: its words, and a hint when it's an app that doesn't know the action yet. */
function refused(result: string): string {
  const old = /\bUnknown PC action\b|\baction must be\b/i.test(result) ? ' Their PC app may be too old for this: updating it should fix that.' : '';
  return `${NOT_DONE}${result}${old}`;
}

interface Candidate {
  /** How she names it in a list. */
  label: string;
  url?: string;
  videoId?: string;
  /** No link to hand over: a search on YouTube. */
  search?: string;
  kind: ThingKind;
  at: number;
  thing?: Thing;
  live?: boolean;
}

function describeThing(t: Thing): string {
  const what = t.kind === 'video' ? 'YouTube video' : t.kind === 'song' ? `${host(t.url)} song` : `link to ${host(t.url)}`;
  if (t.by === 'her') return `the ${what} you sent them`;
  if (t.by === 'self') return `their own ${what}`;
  return `${JSON.stringify(t.who ?? 'someone')}'s ${what}`;
}

/** "Which one? 1: "Kim"'s link to example.com; 2: their own YouTube video. Ask
 *  them..." as she asks it: "Which one: Kim's link to example.com, or your own
 *  YouTube video?" */
export function whichLine(raw: string): string {
  const body = raw.replace(/^Which one\? /, '').replace(/\. Ask them, then call .*$/s, '');
  const items = body
    .split(/;\s*(?=\d+: )/)
    .map((x) =>
      x
        .replace(/^\d+: /, '')
        .replace(/"([^"]*)"/g, '$1')
        .replace(/^the (.+) you sent them$/, 'the $1 I sent you')
        .replace(/^their own /, 'your own '),
    );
  if (items.length < 2) return 'Which one?';
  return `Which one: ${items.slice(0, -1).join(', ')}, or ${items.at(-1)}?`;
}

/** Their PC's tools for the PC and the call together. */
export function handoffTools(d: HandoffDeps): Tool[] {
  const now = d.now ?? Date.now;
  const choices = new Map<UserId, { list: Candidate[]; until: number }>();

  /** The call's song. `at`: when that session started, or now when they asked
   *  for a song (it's the one playing as they speak). */
  const liveSong = (current = false): Candidate | undefined => {
    const n = d.callMusic()?.nowPlaying;
    if (!n) return undefined;
    const name = `${n.title}${n.artist ? ` by ${n.artist}` : ''}`;
    const at = current ? now() : (d.starts.starter(d.callRoom)?.at ?? now() - d.things.keepMs);
    const base = { label: `${JSON.stringify(name)}, playing in the call`, kind: 'song' as const, at, live: true };
    return n.source === 'youtube' && n.id ? { ...base, url: `https://www.youtube.com/watch?v=${n.id}`, videoId: n.id } : { ...base, search: n.artist ? `${n.title} ${n.artist}` : n.title };
  };

  async function candidates(ctx: ToolContext, want: string, hint: string): Promise<Candidate[]> {
    const guildId = ctx.guildId ?? d.homeGuild;
    const out: Candidate[] = [];
    for (const t of d.things.candidates(ctx.userId, guildId)) {
      if (t.by === 'other' && !(t.guildId && t.channelId && (await d.canSee(ctx.userId, t.guildId, t.channelId).catch(() => false)))) continue;
      out.push({ label: describeThing(t), url: t.url, ...(t.videoId ? { videoId: t.videoId } : {}), kind: t.kind, at: t.at, thing: t });
    }
    const live = want !== 'link' ? liveSong(want === 'song') : undefined;
    if (live) out.push(live);
    const fits = out.filter((c) => (want === 'video' ? c.kind === 'video' || !!c.live : want === 'song' ? c.kind !== 'link' : true));
    const h = hint.trim().toLowerCase();
    const hinted = h
      ? fits.filter((c) => {
          const t = c.thing;
          if (/^(me|my|mine|i)$/.test(h)) return t?.by === 'self';
          if (/^(you|yours|your|her|adrian)$/.test(h)) return t?.by === 'her';
          if (/\b(call|playing|music|song)\b/.test(h)) return !!c.live;
          return [t?.who ?? '', c.url ? host(c.url) : '', c.label].some((s) => s.toLowerCase().includes(h));
        })
      : fits;
    return hinted.sort((a, b) => b.at - a.at || Number(!!b.live) - Number(!!a.live));
  }

  /** Open one on the PC. */
  async function open(pc: PcLike, c: Candidate, signal: AbortSignal): Promise<{ ok: boolean; result: string }> {
    let args: Record<string, unknown>;
    if (c.url) args = { url: c.url };
    else {
      const id = d.findVideo ? await d.findVideo(c.search!, signal).catch(() => undefined) : undefined;
      args = id ? { video_id: id } : { youtube: c.search };
    }
    if (typeof args.url === 'string' && !webUrl(args.url)) return { ok: false, result: 'Only public http and https web addresses can be opened.' };
    return pc.action('pc_open', args);
  }

  async function sendToPc(a: Record<string, unknown>, signal: AbortSignal, ctx: ToolContext): Promise<string> {
    const pc = d.pcFor(ctx);
    if (!pc) return noPc(ctx);
    // An answer to "which one?"
    const offered = choices.get(ctx.userId);
    const pick = Number(a.choice);
    if (Number.isInteger(pick) && pick > 0) {
      choices.delete(ctx.userId);
      const c = offered && offered.until >= now() ? offered.list[pick - 1] : undefined;
      if (!c) return 'That list is gone. Ask them which one again, in their words (who sent it, or what site).';
      return opened(await open(pc, c, signal), c);
    }
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    if (url) {
      if (!webUrl(url)) return `${NOT_DONE}Only public http and https web addresses can be opened.`;
      return opened(await pc.action('pc_open', { url }), { label: `the link to ${host(url)}`, url, kind: 'link', at: now() });
    }
    const want = ['link', 'video', 'song'].includes(String(a.what)) ? String(a.what) : 'any';
    const hint = typeof a.from === 'string' ? a.from.slice(0, 40) : '';
    const list = await candidates(ctx, want, hint);
    const guildId = ctx.guildId ?? d.homeGuild;
    if (!list.length) {
      const what = want === 'any' ? 'link or video' : want;
      const blind = d.readable ? '' : " I only see messages that @mention me or are sent to me directly, so if someone posted it without @mentioning me, I can't see it: they can post it again with an @mention, or paste it to me.";
      return `There's no ${what}${hint ? ` from ${JSON.stringify(hint)}` : ''} in the last ${Math.round(d.things.keepMs / 60_000)} minutes I can send.${blind} If they mean a page you only talked about, use pc_open with search instead.`;
    }
    const [first, second] = list;
    if (second && first!.at - second.at < CLOSE_MS && first!.url !== second.url) {
      const offer = list.slice(0, 4);
      choices.set(ctx.userId, { list: offer, until: now() + CHOICE_MS });
      return `Which one? ${offer.map((c, i) => `${i + 1}: ${c.label}`).join('; ')}. Ask them, then call send_to_pc again with choice set to the number.`;
    }
    const r = await open(pc, first!, signal);
    // A newer message she couldn't read may be the one they mean.
    const hidden = !d.readable && first!.thing?.by !== 'self' ? d.things.hiddenSince(guildId, ctx.userId, first!.at) : undefined;
    const caveat = hidden && r.ok ? ' (There are newer messages I can\'t read because they didn\'t @mention me: if they meant one of those, it needs an @mention.)' : '';
    return opened(r, first!) + caveat;
  }

  const opened = (r: { ok: boolean; result: string }, c: Candidate) => (r.ok ? `Opened ${c.label} on their PC.` : refused(r.result));

  async function musicToPc(signal: AbortSignal, ctx: ToolContext): Promise<string> {
    const pc = d.pcFor(ctx);
    if (!pc) return noPc(ctx);
    const music = d.callMusic();
    const n = music?.nowPlaying;
    if (!music || !n) return 'Nothing is playing in the call.';
    const live = liveSong()!;
    const r = await open(pc, live, signal);
    if (!r.ok) return `${refused(r.result)} The music is still playing in the call.`;
    const name = `${n.title}${n.artist ? ` by ${n.artist}` : ''}`;
    const who = d.starts.starter(d.callRoom)?.userId;
    // Theirs to stop: they started it, they're an owner, or whoever did has left the call.
    const theirs = d.isOwner(ctx.userId) || who === ctx.userId || (!!who && !d.inCall(who) && d.inCall(ctx.userId));
    if (!theirs) return `Opened ${JSON.stringify(name)} on their PC. It's still playing in the call: someone else started it there, so only they or an owner can stop it.`;
    music.stop();
    d.starts.stopped(d.callRoom);
    return `Moved ${JSON.stringify(name)} to their PC${live.url ? '' : ' (found on YouTube)'} and stopped it in the call.`;
  }

  async function pcToCall(signal: AbortSignal, ctx: ToolContext): Promise<string> {
    const pc = d.pcFor(ctx);
    if (!pc) return noPc(ctx);
    const call = d.call();
    if (!call?.ready) return "I'm not in a voice call right now. Someone can bring me in with /join.";
    if (!call.humans.length) return "Nobody's in the call to hear it.";
    if (!d.isOwner(ctx.userId) && !d.inCall(ctx.userId)) return 'Only people in the voice call can play music there.';
    const music = d.callMusic();
    if (!music) return "Music isn't available in the call.";
    const st = await pc.action('pc_media', { action: 'status' });
    if (!st.ok) return refused(st.result);
    const players = parsePlayers(st.result);
    const p = players.find((x) => x.state === 'playing') ?? players.find((x) => x.state === 'paused');
    if (!p) return "I can't tell what's playing on their PC.";
    const want = callRequestFor(p);
    if ('refuse' in want) return want.refuse;
    const r = await music.request(want.kind, want.query, 'now', signal);
    if (!r.ok) return r.message;
    if (r.started) d.starts.started(d.callRoom, ctx.userId);
    // Two copies at once would echo: the PC's goes quiet.
    const paused = p.state === 'playing' ? await pc.action('pc_media', { action: 'pause', app: p.app }).catch(() => ({ ok: false, result: '' })) : { ok: true, result: '' };
    return `Now playing ${want.label} in the call${p.state === 'playing' ? (paused.ok ? ', and paused it on their PC' : '; it is still playing on their PC') : ''}.`;
  }

  const handoff: Tool = {
    spec: {
      name: 'pc_handoff',
      description:
        'Between their PC and Discord. send_to_pc: open "that" link, video or song on their PC ("send that link to my PC", "open that on my PC", "put that video on my PC"): the newest one they posted, you wrote them, someone posted in this server, or the song playing in the call. what: link, video or song if they said; from: whose or which ("Sam", "me", "you", "reddit", "the call") if they said. If it answers with a numbered list, ask them which and call again with choice. url: only for a link you wrote yourself in this conversation. music_to_pc: "play this on my PC instead", "move the music to my PC". pc_to_call: "put what I\'m watching on my PC into the call".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['send_to_pc', 'music_to_pc', 'pc_to_call'] },
          what: { type: 'string', enum: ['link', 'video', 'song', 'any'] },
          from: { type: 'string', description: 'Whose or which one, in their words.' },
          choice: { type: 'number', description: 'Their pick from the numbered list.' },
          url: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    timeoutMs: 25_000,
    acts: true,
    speak: (a, raw) => {
      if (raw.startsWith('Which one?')) return whichLine(raw);
      if (raw.startsWith(NOT_DONE) || raw.startsWith('No PC')) return undefined;
      if (a.action === 'send_to_pc' && raw.startsWith('Opened ') && !raw.includes('(There are')) return 'Opening it on your PC.';
      if (a.action === 'music_to_pc' && raw.startsWith('Moved ')) return "It's on your PC now.";
      if (a.action === 'pc_to_call' && raw.startsWith('Now playing')) return '';
      return undefined;
    },
    // Said as is, and their next words are the answer (the list waits for them).
    asks: (raw) => raw.startsWith('Which one?'),
    run: async (a, signal, ctx) => {
      if (a.action === 'music_to_pc') return musicToPc(signal, ctx);
      if (a.action === 'pc_to_call') return pcToCall(signal, ctx);
      return sendToPc(a, signal, ctx);
    },
  };
  return [handoff];
}

// --- telling the call -------------------------------------------------------

/** Sliding window per person: at most `max` in `windowMs`. */
export class WindowLimiter {
  private readonly sent = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Undefined and counted, or how long until the next one is allowed (ms). */
  take(key: string): number | undefined {
    const t = this.now();
    const l = (this.sent.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (l.length >= this.max) {
      this.sent.set(key, l);
      return l[0]! + this.windowMs - t;
    }
    l.push(t);
    this.sent.set(key, l);
    if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value!);
    return undefined;
  }

  release(key: string): void {
    this.sent.get(key)?.pop();
  }
}

export interface TellCallDeps {
  /** Their name as the call knows it (a nickname from the config first). */
  nameOf(userId: UserId): string;
  /** Already audible in her call: they can say it themselves. */
  inHerCall(userId: UserId): boolean;
  /** Her voice call, if she's in one: the people in it (no bots). */
  call(): { ready: boolean; guildId: string; channelId: string; humans: UserId[] } | undefined;
  /** Is this person in that server? */
  isMember(guildId: string, userId: UserId): Promise<boolean>;
  /** Said in the call, as from them (they may stop it). True once heard. */
  announce(userId: UserId, text: string): Promise<boolean>;
  /** Post where the call would read it; resolves to the channel name, or rejects with why not. */
  post(userId: UserId, ctx: ToolContext, text: string): Promise<string>;
  limiter: WindowLimiter;
  maxChars: number;
  /** For the voice: names said right. */
  speakable?(text: string): string;
  /** How long to wait for the call to hear it before saying it's queued (default 8 s). */
  heardWithinMs?: number;
  now?(): number;
}

/** Their own words asked to tell the call: "tell the call", "ask them",
 *  "let everyone know". Anything else gets read back first. */
const TO_THE_CALL =
  /\b(?:tell|ask|let|warn|remind|say to|announce to|shout to)\b(?:\s+\S+){0,3}?\s+(?:the call|call|them|everyone|everybody|the (?:guys|boys|girls|squad|group|lobby|vc|team|crew|gang|server|chat)|y'?all|people|voice chat|the others)\b|\b(?:announce|broadcast)\b/i;

const READ_BACK = 'Tell the call: ';

/** Messages from the PC (or a DM) to the voice call she's in. */
export function tellCallTool(d: TellCallDeps): Tool {
  const now = d.now ?? Date.now;
  const waiting = new PendingYes<{ said: string; text: string }>(now);

  async function deliver(ctx: ToolContext, said: string, text: string): Promise<string> {
    const wait = d.limiter.take(ctx.userId);
    if (wait !== undefined) return `Not sent: that's the most messages for the call in a few minutes. Try again in ${Math.max(1, Math.ceil(wait / 60_000))} minute${wait > 60_000 ? 's' : ''}.`;
    const call = d.call();
    const others = call?.ready ? call.humans.filter((id) => id !== ctx.userId) : [];
    if (call && others.length) {
      if (!(await d.isMember(call.guildId, ctx.userId).catch(() => false))) {
        d.limiter.release(ctx.userId);
        return "Not sent: you're not in the server I'm in a call in.";
      }
      const heard = d.announce(ctx.userId, d.speakable ? d.speakable(said) : said);
      const quick = await Promise.race([heard, new Promise<'later'>((r) => setTimeout(() => r('later'), d.heardWithinMs ?? 8_000).unref?.())]);
      if (quick === 'later') return "It's queued in the call: I'll say it as soon as I'm done talking.";
      return quick ? 'Said it in the call.' : 'Someone stopped me before I finished saying it in the call.';
    }
    try {
      const where = await d.post(ctx.userId, ctx, text);
      return `Nobody's in a voice call with me, so I posted it in #${where}.`;
    } catch (e) {
      d.limiter.release(ctx.userId);
      return `Not sent: ${(e as Error).message}`;
    }
  }

  return {
    spec: {
      name: 'tell_call',
      description:
        'Pass a message from them to the people in your voice call ("tell the call I\'ll be on in 5", "ask them if they want to play Valorant"). You say it there, or post it in a text channel if nobody\'s in a call with you. message: what they want said, in their words. spoken: how you say it to the call, starting with their name ("Alex says he\'ll be on in five", "Alex wants to know if you want to play Valorant"). Not for someone who is in the call themselves.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Their message, in their words.' },
          spoken: { type: 'string', description: 'The line for the call, starting with their name.' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
    acts: true,
    timeoutMs: 12_000,
    speak: (_a, raw) => (raw.startsWith(READ_BACK) ? raw : raw === 'Said it in the call.' ? 'Told them.' : undefined),
    asks: (raw) => raw.startsWith(READ_BACK),
    run: async (a, _signal, ctx) => {
      // Their yes: what was read back goes, whatever the model asks for now.
      const agreed = waiting.take(ctx);
      if (agreed) return deliver(ctx, agreed.said, agreed.text);
      if (d.inHerCall(ctx.userId)) return "They're in the call with you, so the call can already hear them. Don't relay it.";
      const name = d.nameOf(ctx.userId);
      const message = plainText(String(a.message ?? ''), d.maxChars);
      if (!message) return 'What should I tell them?';
      let spoken = plainText(String(a.spoken ?? ''), d.maxChars + 40);
      // Always from them, by name: a line without it reads as hers. The model
      // may use their Discord name rather than the one the call knows.
      if (!spoken || ![name, ctx.speaker].some((n) => !!n && spoken.toLowerCase().includes(n.toLowerCase()))) spoken = `${name} says: ${message}`;
      const text = `**${escapeMarkdown(name)}** asked me to tell you: ${message}`;
      if (TO_THE_CALL.test(ctx.said ?? '')) return deliver(ctx, spoken, text);
      // Their words never asked for it: only their yes sends it.
      const line = `${READ_BACK}"${spoken}"?`;
      return waiting.hold(ctx, { said: spoken, text }, ['tell', 'them', 'say', 'it', 'send'], line.length * 70) ? line : 'Not sent: one thing at a time, ask me again after this one.';
    },
  };
}

/** Prompt line: when to use these. */
export const HANDOFF_RULE =
  "pc_handoff moves things between someone's PC and Discord: \"send that link to my PC\", \"open that on my PC\" and \"put that video on my PC\" are send_to_pc (it works out what \"that\" is; don't ask first, and if it lists choices, ask which); \"play this on my PC instead\" or \"move the music to my PC\" is music_to_pc; \"put what I'm watching into the call\" is pc_to_call. \"Tell the call ...\" or \"ask them if ...\" from someone who isn't in your voice call is tell_call. Say what it did in a few words.";
