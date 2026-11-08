import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/core/interfaces.js';
import { callRequestFor, handoffTools, LastThings, linksIn, MusicStarts, noteMessage, notingStarts, parsePlayers, tellCallTool, WindowLimiter, type CallMusic, type HandoffDeps, type PcLike, type SeenMessage, type TellCallDeps } from '../src/features/handoff.js';
import type { RequestResult, Track } from '../src/features/music.js';

const RIQUE = '100000000000000001';
const SAM = '100000000000000002';
const KIM = '100000000000000003';
const GUILD = '900000000000000001';
const GENERAL = '800000000000000001';
const SECRET = '800000000000000002';

describe('linksIn', () => {
  it('finds public links and leaves the sentence around them', () => {
    expect(linksIn('look https://example.com/a. and (https://news.example.org/b) <https://x.example/c>!')).toEqual([
      { kind: 'link', url: 'https://example.com/a' },
      { kind: 'link', url: 'https://news.example.org/b' },
      { kind: 'link', url: 'https://x.example/c' },
    ]);
  });

  it('knows videos and songs', () => {
    expect(linksIn('https://youtu.be/dQw4w9WgXcQ')).toEqual([{ kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ' }]);
    expect(linksIn('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')[0]!.kind).toBe('song');
  });

  it('never keeps anything on the PC or its network, or overlong', () => {
    expect(linksIn('http://localhost:8080 http://192.168.1.50/admin https://router.lan/ http://user@example.com/ file:///c:/x')).toEqual([]);
    expect(linksIn(`https://example.com/${'a'.repeat(400)}`)).toEqual([]);
  });

  it('keeps one of each and at most five', () => {
    const many = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`).join(' ');
    expect(linksIn(`${many} https://example.com/0`)).toHaveLength(5);
  });
});

describe('LastThings and noteMessage', () => {
  const msg = (o: Partial<SeenMessage>): SeenMessage => ({ authorId: SAM, authorName: 'Sam', bot: false, mine: false, text: '', hasAttachments: false, guildId: GUILD, channelId: GENERAL, ...o });

  it('a pasted link is the poster\'s own and, in a server, everyone\'s there', () => {
    let now = 0;
    const t = new LastThings({}, () => now);
    noteMessage(t, msg({ text: 'https://example.com/sam' }), true);
    expect(t.candidates(SAM, GUILD).map((x) => x.by)).toEqual(['self']);
    expect(t.candidates(RIQUE, GUILD).map((x) => [x.by, x.who])).toEqual([['other', 'Sam']]);
    expect(t.candidates(RIQUE, undefined)).toEqual([]); // no server, no others' links
    now += 11 * 60_000; // others' links count for 10 minutes, your own for 30
    expect(t.candidates(RIQUE, GUILD)).toEqual([]);
    expect(t.candidates(SAM, GUILD)).toHaveLength(1);
    now += 20 * 60_000;
    expect(t.candidates(SAM, GUILD)).toEqual([]);
  });

  it('her own replies count for the person she answered; other bots never count', () => {
    const t = new LastThings();
    noteMessage(t, msg({ authorId: '100000000000000099', mine: true, bot: true, text: 'Here: https://example.com/guide', to: RIQUE }), true);
    noteMessage(t, msg({ authorId: '100000000000000098', bot: true, text: 'https://example.com/spam' }), true);
    expect(t.candidates(RIQUE, GUILD).map((x) => [x.by, x.url])).toEqual([['her', 'https://example.com/guide']]);
    expect(t.candidates(SAM, GUILD)).toEqual([]);
  });

  it('notes messages it got without their words, only when it can\'t read them', () => {
    let now = 0;
    const t = new LastThings({}, () => now);
    noteMessage(t, msg({ text: '' }), false);
    now += 1000;
    expect(t.hiddenSince(GUILD, RIQUE, -1)).toEqual({ channelId: GENERAL });
    expect(t.hiddenSince(GUILD, RIQUE, 0)).toBeUndefined(); // only newer than what it found
    expect(t.hiddenSince(GUILD, SAM, -1)).toBeUndefined(); // their own doesn't count
    const readable = new LastThings();
    noteMessage(readable, msg({ text: '' }), true);
    expect(readable.hiddenSince(GUILD, RIQUE, -1)).toBeUndefined();
  });

  it('stays small', () => {
    let now = 0;
    const t = new LastThings({ perPerson: 3, people: 2 }, () => now++);
    for (let i = 0; i < 6; i++) t.addFor(RIQUE, { kind: 'link', url: `https://example.com/${i}`, by: 'self' });
    expect(t.candidates(RIQUE).map((x) => x.url)).toEqual(['https://example.com/5', 'https://example.com/4', 'https://example.com/3']);
    t.addFor(SAM, { kind: 'link', url: 'https://example.com/s', by: 'self' });
    t.addFor(KIM, { kind: 'link', url: 'https://example.com/k', by: 'self' });
    expect(t.candidates(RIQUE)).toEqual([]); // the oldest person went first
  });
});

describe('parsePlayers and callRequestFor', () => {
  it('reads one player or several', () => {
    expect(parsePlayers('Spotify is playing \u201cNights\u201d by Frank Ocean.')).toEqual([{ app: 'Spotify', state: 'playing', title: 'Nights', artist: 'Frank Ocean' }]);
    const two = parsePlayers('Chrome is paused on \u201cMr. Brightside - YouTube\u201d by The Killers. Spotify is playing \u201cStill D.R.E.\u201d by Dr. Dre.');
    expect(two).toEqual([
      { app: 'Chrome', state: 'paused', title: 'Mr. Brightside - YouTube', artist: 'The Killers' },
      { app: 'Spotify', state: 'playing', title: 'Still D.R.E.', artist: 'Dr. Dre' },
    ]);
    expect(parsePlayers('Spotify is open but not playing.')).toEqual([]);
  });

  it('a song from a player, a video from a browser, and never a streaming show', () => {
    expect(callRequestFor({ app: 'Spotify', state: 'playing', title: 'Nights', artist: 'Frank Ocean' })).toEqual({ kind: 'song', query: 'Nights Frank Ocean', label: 'Nights by Frank Ocean' });
    expect(callRequestFor({ app: 'Chrome', state: 'playing', title: 'Big Mix - YouTube', artist: 'DJ Someone' })).toEqual({ kind: 'video', query: 'Big Mix DJ Someone', label: 'Big Mix' });
    expect(callRequestFor({ app: 'Chrome', state: 'playing', title: 'Stranger Things | Netflix' })).toEqual({ refuse: expect.stringContaining("That's Netflix") });
    expect(callRequestFor({ app: 'Netflix', state: 'playing', title: 'Episode 1' })).toEqual({ refuse: expect.stringContaining('Netflix') });
    expect(callRequestFor({ app: 'Edge', state: 'playing', title: 'Some show' })).toEqual({ refuse: expect.stringContaining("can't tell") });
  });
});

/** A call, a PC per person, and the music. */
function rig(o: { pcs?: string[]; playing?: Track; starter?: string; inCall?: string[]; owner?: string[]; readable?: boolean; canSee?: (u: string, ch: string) => boolean; pcAnswer?: (name: string, args: Record<string, unknown>) => { ok: boolean; result: string }; request?: () => RequestResult; ready?: boolean; findVideo?: boolean } = {}) {
  let now = 10_000_000;
  let turns = 0;
  const actions: { pc: string; name: string; args: Record<string, unknown> }[] = [];
  const pcs = new Map<string, PcLike>(
    (o.pcs ?? [RIQUE]).map((owner) => [
      owner,
      {
        action: async (name: string, args: Record<string, unknown>) => {
          actions.push({ pc: owner, name, args });
          return o.pcAnswer?.(name, args) ?? { ok: true, result: name === 'pc_media' ? 'Spotify is playing \u201cNights\u201d by Frank Ocean.' : 'Opened the page.' };
        },
      },
    ]),
  );
  let playing = o.playing;
  const music: CallMusic & { stop: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> } = {
    get nowPlaying() {
      return playing;
    },
    stop: vi.fn(() => {
      const was = !!playing;
      playing = undefined;
      return was;
    }),
    request: vi.fn(async () => o.request?.() ?? { ok: true as const, started: { title: 'Nights', artist: 'Frank Ocean', source: 'youtube' as const, ref: '' }, added: 0 }),
  };
  const things = new LastThings({}, () => now);
  const starts = new MusicStarts(() => now);
  if (o.starter) starts.started('discord', o.starter);
  const inCall = new Set(o.inCall ?? []);
  const deps: HandoffDeps = {
    things,
    starts,
    callRoom: 'discord',
    pcFor: (ctx) => pcs.get(ctx.userId),
    callMusic: () => music,
    call: () => ({ ready: o.ready ?? true, humans: [...inCall] }),
    inCall: (id) => inCall.has(id),
    isOwner: (id) => (o.owner ?? []).includes(id),
    canSee: async (u, _g, ch) => o.canSee?.(u, ch) ?? true,
    homeGuild: GUILD,
    readable: o.readable ?? true,
    ...(o.findVideo ? { findVideo: async () => 'aaaaaaaaaaa' } : {}),
    now: () => now,
  };
  const [tool] = handoffTools(deps);
  const ctx = (userId = RIQUE, extra: Partial<ToolContext> = {}): ToolContext => ({ userId, speaker: userId === RIQUE ? 'Rique' : 'Sam', guildId: GUILD, channelId: GENERAL, said: 'x', turn: ++turns, ...extra });
  const run = (a: Record<string, unknown>, userId = RIQUE, extra: Partial<ToolContext> = {}) => tool!.run(a, new AbortController().signal, ctx(userId, extra));
  const post = (who: string, name: string, text: string, channelId = GENERAL) => noteMessage(things, { authorId: who, authorName: name, bot: false, mine: false, text, hasAttachments: false, guildId: GUILD, channelId }, true);
  return { tool: tool!, run, actions, music, things, starts, post, inCall, tick: (ms: number) => (now += ms), speak: (a: Record<string, unknown>, r: string) => tool!.speak!(a, r, ctx()) };
}

const song = (o: Partial<Track> = {}): Track => ({ title: 'Nights', artist: 'Frank Ocean', source: 'youtube', ref: '', id: 'bbbbbbbbbbb', ...o });

describe('send_to_pc', () => {
  it('opens the newest link on the asker\'s own PC', async () => {
    const r = rig();
    r.post(RIQUE, 'Rique', 'https://example.com/old');
    r.tick(5 * 60_000);
    r.post(RIQUE, 'Rique', 'https://example.com/new');
    const out = await r.run({ action: 'send_to_pc' });
    expect(out).toBe('Opened their own link to example.com on their PC.');
    expect(r.actions).toEqual([{ pc: RIQUE, name: 'pc_open', args: { url: 'https://example.com/new' } }]);
    expect(r.speak({ action: 'send_to_pc' }, out)).toBe('Opening it on your PC.');
  });

  it('never reaches someone else\'s PC', async () => {
    const r = rig({ pcs: [RIQUE] });
    r.post(SAM, 'Sam', 'https://example.com/sam');
    expect(await r.run({ action: 'send_to_pc' }, SAM)).toMatch(/^No PC is connected for Sam/);
    expect(r.actions).toEqual([]);
  });

  it('takes another person\'s link only from a channel the asker can see', async () => {
    const r = rig({ canSee: (_u, ch) => ch !== SECRET });
    r.post(SAM, 'Sam', 'https://example.com/hidden', SECRET);
    expect(await r.run({ action: 'send_to_pc' })).toMatch(/^There's no link or video/);
    r.post(SAM, 'Sam', 'https://example.com/seen');
    expect(await r.run({ action: 'send_to_pc' })).toBe('Opened "Sam"\'s link to example.com on their PC.');
  });

  it('two close together: asks which, and the answer picks it', async () => {
    const r = rig();
    r.post(SAM, 'Sam', 'https://youtu.be/dQw4w9WgXcQ');
    r.tick(30_000);
    r.post(KIM, 'Kim', 'https://example.com/kim');
    const q = await r.run({ action: 'send_to_pc' });
    expect(q).toBe('Which one? 1: "Kim"\'s link to example.com; 2: "Sam"\'s YouTube video. Ask them, then call send_to_pc again with choice set to the number.');
    expect(r.speak({ action: 'send_to_pc' }, q)).toBeUndefined(); // the model asks in its own words
    expect(r.actions).toEqual([]);
    expect(await r.run({ action: 'send_to_pc', choice: 2 })).toBe('Opened "Sam"\'s YouTube video on their PC.');
    expect(r.actions[0]!.args).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    // Used up.
    expect(await r.run({ action: 'send_to_pc', choice: 1 })).toMatch(/^That list is gone/);
  });

  it('the list expires', async () => {
    const r = rig();
    r.post(SAM, 'Sam', 'https://example.com/a');
    r.post(KIM, 'Kim', 'https://example.com/b');
    await r.run({ action: 'send_to_pc' });
    r.tick(4 * 60_000);
    expect(await r.run({ action: 'send_to_pc', choice: 1 })).toMatch(/^That list is gone/);
  });

  it('far apart: the newest, no question', async () => {
    const r = rig();
    r.post(SAM, 'Sam', 'https://example.com/a');
    r.tick(3 * 60_000);
    r.post(KIM, 'Kim', 'https://example.com/b');
    expect(await r.run({ action: 'send_to_pc' })).toBe('Opened "Kim"\'s link to example.com on their PC.');
  });

  it('from narrows it down: a name, "me", or a site', async () => {
    const r = rig();
    r.post(SAM, 'Sam', 'https://reddit.com/r/x');
    r.post(KIM, 'Kim', 'https://example.com/b');
    r.post(RIQUE, 'Rique', 'https://mine.example/c');
    expect(await r.run({ action: 'send_to_pc', from: 'sam' })).toContain('"Sam"\'s link to reddit.com');
    expect(await r.run({ action: 'send_to_pc', from: 'me' })).toContain('their own link to mine.example');
    expect(await r.run({ action: 'send_to_pc', from: 'reddit' })).toContain('reddit.com');
    expect(await r.run({ action: 'send_to_pc', from: 'nobody' })).toMatch(/^There's no link or video from "nobody"/);
  });

  it('"that song" is the one playing in the call, unless a song link is just as new', async () => {
    const r = rig({ playing: song() });
    r.post(SAM, 'Sam', 'https://example.com/page');
    expect(await r.run({ action: 'send_to_pc', what: 'song' })).toBe('Opened "Nights by Frank Ocean", playing in the call on their PC.');
    expect(r.actions[0]!.args).toEqual({ url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' });
    r.post(SAM, 'Sam', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    expect(await r.run({ action: 'send_to_pc', what: 'song' })).toMatch(/^Which one\? 1: "Nights by Frank Ocean", playing in the call; 2: "Sam"'s open\.spotify\.com song/);
  });

  it('"that link" is never the call\'s song', async () => {
    const r = rig({ playing: song() });
    expect(await r.run({ action: 'send_to_pc', what: 'link' })).toMatch(/^There's no link in the last 30 minutes/);
  });

  it('a Plex song has no link: found on YouTube, or YouTube\'s search without a finder', async () => {
    const plex = song({ source: 'plex' });
    delete plex.id;
    const found = rig({ playing: plex, findVideo: true });
    await found.run({ action: 'send_to_pc', what: 'song' });
    expect(found.actions[0]!.args).toEqual({ video_id: 'aaaaaaaaaaa' });
    const searched = rig({ playing: plex });
    await searched.run({ action: 'send_to_pc', what: 'song' });
    expect(searched.actions[0]!.args).toEqual({ youtube: 'Nights Frank Ocean' });
  });

  it('nothing to send: says so, and why it might not see one', async () => {
    expect(await rig().run({ action: 'send_to_pc' })).not.toContain('@mention');
    const blind = await rig({ readable: false }).run({ action: 'send_to_pc', what: 'video' });
    expect(blind).toMatch(/^There's no video in the last 30 minutes I can send\. I only see messages that @mention me/);
    expect(blind).toContain('pc_open with search');
  });

  it('warns when newer messages it could not read may be the one', async () => {
    const r = rig({ readable: false });
    r.post(SAM, 'Sam', 'https://example.com/a');
    r.tick(1000);
    noteMessage(r.things, { authorId: KIM, authorName: 'Kim', bot: false, mine: false, text: '', hasAttachments: false, guildId: GUILD, channelId: GENERAL }, false);
    const out = await r.run({ action: 'send_to_pc' });
    expect(out).toContain("newer messages I can't read");
    expect(r.speak({ action: 'send_to_pc' }, out)).toBeUndefined(); // the model passes that on
  });

  it('a link the model gives must be a public web address', async () => {
    const r = rig();
    expect(await r.run({ action: 'send_to_pc', url: 'http://192.168.1.50/' })).toMatch(/^Didn't happen: Only public/);
    expect(await r.run({ action: 'send_to_pc', url: 'javascript:alert(1)' })).toMatch(/^Didn't happen/);
    expect(r.actions).toEqual([]);
    expect(await r.run({ action: 'send_to_pc', url: 'https://example.com/guide' })).toBe('Opened the link to example.com on their PC.');
  });

  it('passes on what the PC said, and spots a PC app too old for the action', async () => {
    const lan = rig({ pcAnswer: () => ({ ok: false, result: "That address leads to this PC or the home network, so it wasn't opened." }) });
    lan.post(RIQUE, 'Rique', 'https://example.com/a');
    expect(await lan.run({ action: 'send_to_pc' })).toBe("Didn't happen: That address leads to this PC or the home network, so it wasn't opened.");
    const old = rig({ pcAnswer: () => ({ ok: false, result: 'Unknown PC action pc_open.' }) });
    old.post(RIQUE, 'Rique', 'https://example.com/a');
    expect(await old.run({ action: 'send_to_pc' })).toContain('may be too old');
  });
});

describe('music_to_pc', () => {
  it('the one who started it: opens on the PC, then stops it in the call', async () => {
    const r = rig({ playing: song(), starter: RIQUE, inCall: [RIQUE, SAM] });
    const out = await r.run({ action: 'music_to_pc' });
    expect(out).toBe('Moved "Nights by Frank Ocean" to their PC and stopped it in the call.');
    expect(r.actions[0]).toEqual({ pc: RIQUE, name: 'pc_open', args: { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' } });
    expect(r.music.stop).toHaveBeenCalledOnce();
    expect(r.speak({ action: 'music_to_pc' }, out)).toBe("It's on your PC now.");
  });

  it('someone else started it: opens it, leaves the call alone', async () => {
    const r = rig({ playing: song(), starter: SAM, inCall: [RIQUE, SAM] });
    expect(await r.run({ action: 'music_to_pc' })).toContain("It's still playing in the call: someone else started it there");
    expect(r.music.stop).not.toHaveBeenCalled();
  });

  it('an owner may stop anyone\'s; so may anyone in the call once the starter left', async () => {
    const owner = rig({ playing: song(), starter: SAM, inCall: [SAM], owner: [RIQUE] });
    expect(await owner.run({ action: 'music_to_pc' })).toMatch(/^Moved/);
    const left = rig({ playing: song(), starter: SAM, inCall: [RIQUE] });
    expect(await left.run({ action: 'music_to_pc' })).toMatch(/^Moved/);
    // Nobody known started it: only an owner.
    const unknown = rig({ playing: song({ auto: true }), inCall: [RIQUE] });
    expect(await unknown.run({ action: 'music_to_pc' })).toContain('still playing in the call');
  });

  it('a PC that fails leaves the music playing in the call', async () => {
    const r = rig({ playing: song(), starter: RIQUE, pcAnswer: () => ({ ok: false, result: "The PC didn't answer in time." }) });
    expect(await r.run({ action: 'music_to_pc' })).toBe("Didn't happen: The PC didn't answer in time. The music is still playing in the call.");
    expect(r.music.stop).not.toHaveBeenCalled();
  });

  it('no PC, or nothing playing', async () => {
    expect(await rig({ pcs: [] }).run({ action: 'music_to_pc' })).toMatch(/^No PC is connected/);
    expect(await rig().run({ action: 'music_to_pc' })).toBe('Nothing is playing in the call.');
  });
});

describe('pc_to_call', () => {
  it('finds what the PC plays, plays it in the call, pauses the PC', async () => {
    const r = rig({ inCall: [RIQUE, SAM] });
    const out = await r.run({ action: 'pc_to_call' });
    expect(out).toBe('Now playing Nights by Frank Ocean in the call, and paused it on their PC.');
    expect(r.music.request).toHaveBeenCalledWith('song', 'Nights Frank Ocean', 'now', expect.anything());
    expect(r.actions.map((a) => [a.name, a.args])).toEqual([
      ['pc_media', { action: 'status' }],
      ['pc_media', { action: 'pause', app: 'Spotify' }],
    ]);
    expect(r.starts.starter('discord')?.userId).toBe(RIQUE);
    expect(r.speak({ action: 'pc_to_call' }, out)).toBe('');
  });

  it('paused on the PC: plays it, nothing to pause', async () => {
    const r = rig({ inCall: [RIQUE], pcAnswer: () => ({ ok: true, result: 'Spotify is paused on \u201cNights\u201d by Frank Ocean.' }) });
    expect(await r.run({ action: 'pc_to_call' })).toBe('Now playing Nights by Frank Ocean in the call.');
    expect(r.actions).toHaveLength(1);
  });

  it('refuses Netflix and the like, and says what the PC said when nothing plays', async () => {
    const nf = rig({ inCall: [RIQUE], pcAnswer: () => ({ ok: true, result: 'Chrome is playing \u201cStranger Things | Netflix\u201d.' }) });
    expect(await nf.run({ action: 'pc_to_call' })).toContain("That's Netflix");
    expect(nf.music.request).not.toHaveBeenCalled();
    const none = rig({ inCall: [RIQUE], pcAnswer: () => ({ ok: false, result: 'Nothing on this PC is playing media I can control.' }) });
    expect(await none.run({ action: 'pc_to_call' })).toBe("Didn't happen: Nothing on this PC is playing media I can control.");
  });

  it('needs her in a call with people, and the asker there (or an owner)', async () => {
    expect(await rig({ ready: false, inCall: [RIQUE] }).run({ action: 'pc_to_call' })).toMatch(/^I'm not in a voice call/);
    expect(await rig({ inCall: [] }).run({ action: 'pc_to_call' })).toBe("Nobody's in the call to hear it.");
    expect(await rig({ inCall: [SAM] }).run({ action: 'pc_to_call' })).toBe('Only people in the voice call can play music there.');
    expect(await rig({ inCall: [SAM], owner: [RIQUE] }).run({ action: 'pc_to_call' })).toMatch(/^Now playing/);
  });

  it('a song it can\'t find is said, and the PC keeps playing', async () => {
    const r = rig({ inCall: [RIQUE], request: () => ({ ok: false, message: "I couldn't find Nights Frank Ocean." }) });
    expect(await r.run({ action: 'pc_to_call' })).toBe("I couldn't find Nights Frank Ocean.");
    expect(r.actions).toHaveLength(1);
  });
});

describe('notingStarts', () => {
  it('notes who started music only when it started now', async () => {
    const starts = new MusicStarts();
    let result = 'Now playing X.';
    const t = notingStarts({ spec: { name: 'play_music', description: '', parameters: {} }, run: async () => result }, starts, () => 'discord');
    await t.run({}, new AbortController().signal, { userId: SAM, speaker: 'Sam' });
    expect(starts.starter('discord')?.userId).toBe(SAM);
    result = 'Added 1 to the queue.';
    await t.run({}, new AbortController().signal, { userId: RIQUE, speaker: 'Rique' });
    result = "I couldn't find Y.";
    await t.run({}, new AbortController().signal, { userId: RIQUE, speaker: 'Rique' });
    expect(starts.starter('discord')?.userId).toBe(SAM);
    // Other tools pass through untouched.
    const other = { spec: { name: 'music_control', description: '', parameters: {} }, run: async () => 'Now playing Z.' };
    expect(notingStarts(other, starts, () => 'discord')).toBe(other);
  });
});

describe('tell_call', () => {
  function call(o: { humans?: string[]; ready?: boolean; inHerCall?: boolean; member?: boolean; heard?: () => Promise<boolean>; post?: () => Promise<string>; limiter?: WindowLimiter; spot?: boolean } = {}) {
    let now = 0;
    let turns = 0;
    const announce = vi.fn(o.heard ?? (async () => true));
    const post = vi.fn(o.post ?? (async () => 'general'));
    const d: TellCallDeps = {
      nameOf: () => 'Rique',
      inHerCall: () => o.inHerCall ?? false,
      call: () => (o.spot === false ? undefined : { ready: o.ready ?? true, guildId: GUILD, channelId: '800000000000000009', humans: o.humans ?? [SAM, KIM] }),
      isMember: async () => o.member ?? true,
      announce,
      post: (_u, _c, text) => post(text as never),
      limiter: o.limiter ?? new WindowLimiter(3, 5 * 60_000, () => now),
      maxChars: 200,
      speakable: (t) => t.replace('Rique', 'Ree-kay'),
      heardWithinMs: 20,
      now: () => now,
    };
    const tool = tellCallTool(d);
    const run = (a: Record<string, unknown>, said: string) => tool.run(a, new AbortController().signal, { userId: RIQUE, speaker: 'Rique', channelId: 'sat:desk', said, turn: ++turns });
    return { tool, run, announce, post, tick: (ms: number) => (now += ms) };
  }

  it('says it in the call, attributed, in her voice', async () => {
    const c = call();
    const out = await c.run({ message: "I'll be on in 5", spoken: "Rique says he'll be on in five." }, "tell the call I'll be on in 5");
    expect(out).toBe('Said it in the call.');
    expect(c.announce).toHaveBeenCalledWith(RIQUE, "Ree-kay says he'll be on in five.");
    expect(c.tool.speak!({}, out, {} as never)).toBe('Told them.');
  });

  it('a line without their name gets it, so it never sounds like hers', async () => {
    const c = call();
    await c.run({ message: 'want to play Valorant?', spoken: 'Anyone want to play Valorant?' }, 'ask them if they want to play valorant');
    expect(c.announce).toHaveBeenCalledWith(RIQUE, 'Ree-kay says: want to play Valorant?');
  });

  it('no pings, no links, no markdown, and a length cap', async () => {
    const c = call({ humans: [] });
    await c.run({ message: `@everyone <@123456789012345678> join https://evil.example/x **now** ${'a'.repeat(300)}` }, 'tell everyone to join');
    const text = c.post.mock.calls[0]![0] as string;
    expect(text).toMatch(/^\*\*Rique\*\* asked me to tell you: @\u200beveryone @someone join \(a link to evil\.example\) now a+$/);
    expect(text.length).toBeLessThan(260);
  });

  it('someone already in the call is told to just say it', async () => {
    const c = call({ inHerCall: true });
    expect(await c.run({ message: 'hi' }, 'tell the call hi')).toMatch(/can already hear them/);
    expect(c.announce).not.toHaveBeenCalled();
  });

  it('their own words didn\'t ask for it: read back, then their yes sends it', async () => {
    const c = call();
    const q = await c.run({ message: 'gg', spoken: 'Rique says gg.' }, 'that was a good game');
    expect(q).toBe('Tell the call: "Rique says gg."?');
    expect(c.tool.asks!(q)).toBe(true);
    expect(c.announce).not.toHaveBeenCalled();
    expect(await c.run({ message: 'something else' }, 'yes')).toBe('Said it in the call.');
    expect(c.announce).toHaveBeenCalledWith(RIQUE, 'Ree-kay says gg.');
  });

  it('nobody to hear it, or she\'s in no call: posted in text instead', async () => {
    const empty = call({ humans: [RIQUE] });
    expect(await empty.run({ message: 'on in 5' }, 'tell the call on in 5')).toBe("Nobody's in a voice call with me, so I posted it in #general.");
    expect(empty.announce).not.toHaveBeenCalled();
    const away = call({ spot: false });
    expect(await away.run({ message: 'on in 5' }, 'tell the call on in 5')).toMatch(/posted it in #general/);
    const down = call({ ready: false });
    expect(await down.run({ message: 'on in 5' }, 'tell the call on in 5')).toMatch(/posted it in #general/);
  });

  it('a post that fails says why and costs nothing', async () => {
    const limiter = new WindowLimiter(1, 60_000);
    const c = call({ humans: [], limiter, post: async () => Promise.reject(new Error("I don't have a text channel here that we can both use.")) });
    expect(await c.run({ message: 'x' }, 'tell the call x')).toBe("Not sent: I don't have a text channel here that we can both use.");
    expect(limiter.take(RIQUE)).toBeUndefined();
  });

  it('three every five minutes per person', async () => {
    const c = call();
    for (let i = 0; i < 3; i++) expect(await c.run({ message: `m${i}` }, 'tell the call something')).toBe('Said it in the call.');
    expect(await c.run({ message: 'm3' }, 'tell the call something')).toMatch(/^Not sent: that's the most messages for the call in a few minutes\. Try again in 5 minutes\./);
    c.tick(5 * 60_000 + 1);
    expect(await c.run({ message: 'm4' }, 'tell the call something')).toBe('Said it in the call.');
  });

  it('busy talking: queued, and said so', async () => {
    const c = call({ heard: () => new Promise(() => undefined) });
    expect(await c.run({ message: 'x' }, 'tell the call x')).toBe("It's queued in the call: I'll say it as soon as I'm done talking.");
  });

  it('not in the server she\'s in a call in: not sent', async () => {
    const c = call({ member: false });
    expect(await c.run({ message: 'x' }, 'tell the call x')).toBe("Not sent: you're not in the server I'm in a call in.");
  });
});
