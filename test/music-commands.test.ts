import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Events } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { PlaybackHandle } from '../src/core/interfaces.js';
import { buttons, MUSIC_COMMANDS, nowCard, parseTextCommand, playedText, queueCard, registerMusicCommands, safe, suggestions, textHelp, trackLine } from '../src/app/music-commands.js';
import type { Seat, VoiceSpot } from '../src/app/commands.js';
import { MusicPlayer, type MusicOutput, type MusicSource, type Track } from '../src/features/music.js';
import { MusicTaste } from '../src/features/taste.js';

const GUILD = '100000000000000010';
const OTHER_GUILD = '100000000000000011';
const CALL = '100000000000000020';
const ELSEWHERE = '100000000000000021';
const USER = '100000000000000030';
const FRIEND = '100000000000000031';
const OWNER = '100000000000000032';
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A source that finds anything at once: "x" becomes the song "x" by Artist. */
class Instant implements MusicSource {
  readonly name = 'youtube' as const;
  finds: string[] = [];
  async find(q: string): Promise<Track | undefined> {
    this.finds.push(q);
    if (q.startsWith('missing')) return undefined;
    return { title: q, artist: 'Artist', durationS: 200, source: 'youtube', ref: `https://stream/${q}`, id: `id${q.replace(/\W/g, '').padEnd(9, '0').slice(0, 9)}` };
  }
  async open(t: Track) {
    return { url: t.ref };
  }
}

function player() {
  const src = new Instant();
  let paused = false;
  const out: MusicOutput = {
    playMusic: () => {
      let end!: (o: 'finished') => void;
      const done = new Promise<'finished' | 'stopped' | 'error'>((r) => (end = r));
      return { done, stop: () => end('finished') } as PlaybackHandle;
    },
    pauseMusic: () => void (paused = true),
    resumeMusic: () => void (paused = false),
    setMusicVolume() {},
    musicPlaying: true,
    get musicPaused() {
      return paused;
    },
  };
  const p = new MusicPlayer({ sources: [src], output: out, decode: () => ({ pcm: new PassThrough(), kill() {} }), log: quietLog, autoplay: false });
  return { p, src };
}

describe('the player additions', () => {
  it('removes a queued song by position and skips ahead to one', async () => {
    const { p } = player();
    await p.play('one', 'now', AbortSignal.timeout(2000));
    for (const s of ['two', 'three', 'four', 'five']) await p.play(s, 'queue', AbortSignal.timeout(2000));
    expect(p.upNext.map((t) => t.title)).toEqual(['two', 'three', 'four', 'five']);
    expect(p.remove(2)?.title).toBe('three');
    expect(p.remove(0)).toBeUndefined();
    expect(p.remove(9)).toBeUndefined();
    expect(p.upNext.map((t) => t.title)).toEqual(['two', 'four', 'five']);
    expect(await p.skipTo(7)).toBe('none');
    expect((await p.skipTo(2)) as Track).toMatchObject({ title: 'four' });
    expect(p.nowPlaying?.title).toBe('four');
    expect(p.upNext.map((t) => t.title)).toEqual(['five']);
  });

  it('reports its level', () => {
    const { p } = player();
    p.setVolume(0.3);
    expect(p.level).toBe(0.3);
    p.setVolume(0);
    expect(p.level).toBe(0.05);
  });

  it('skipTo with nothing playing is false', async () => {
    expect(await player().p.skipTo(1)).toBe(false);
  });
});

describe('the command definitions', () => {
  it('are guild-only, short enough for Discord, and within its limits', () => {
    expect(MUSIC_COMMANDS.map((c) => c.name)).toEqual(['play', 'music']);
    const check = (o: { name: string; description: string; choices?: { name: string }[]; options?: unknown[] }) => {
      expect(o.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(o.description.length).toBeGreaterThan(0);
      expect(o.description.length).toBeLessThanOrEqual(100);
      for (const ch of o.choices ?? []) expect(ch.name.length).toBeLessThanOrEqual(100);
      expect((o.options ?? []).length).toBeLessThanOrEqual(25);
      for (const sub of (o.options ?? []) as Parameters<typeof check>[0][]) check(sub);
    };
    for (const c of MUSIC_COMMANDS) {
      expect(c.contexts).toEqual([0]);
      expect(c.integration_types).toEqual([0]);
      check(c as never);
    }
  });
});

describe('cards and text', () => {
  it('keeps uploaders from formatting or pinging', () => {
    expect(safe('**@everyone** <@123> #general')).not.toMatch(/(?<!\\)\*\*|@everyone|<@1/);
    expect(trackLine({ title: 'Song_name', artist: 'A*B', durationS: 125, source: 'youtube', ref: '' })).toBe('**Song\\_name** by A\\*B (2:05)');
  });

  it('draws now playing, the queue and the buttons', async () => {
    const { p } = player();
    expect(nowCard(p).toJSON().title).toBe('Nothing playing');
    await p.play('one', 'now', AbortSignal.timeout(2000), undefined, p.ask('Sam'));
    for (let k = 0; k < 12; k++) await p.play(`song ${k}`, 'queue', AbortSignal.timeout(2000));
    const card = nowCard(p).toJSON();
    expect(card.title).toBe('Now playing');
    expect(card.url).toContain('music.youtube.com/watch?v=');
    expect(card.fields?.find((f) => f.name === 'Asked by')?.value).toBe('Sam');
    expect(card.fields?.find((f) => f.name === 'Up next')?.value).toContain('11 songs more');
    const q2 = queueCard(p, 2).toJSON();
    expect(q2.description).toContain('`11.`');
    expect(q2.footer?.text).toContain('Page 2/2');
    expect(queueCard(p, 99).toJSON().footer?.text).toContain('Page 2/2');
    const ids = buttons(p).toJSON().components.map((b) => (b as { custom_id: string }).custom_id);
    expect(ids).toEqual(['music:back', 'music:pause', 'music:skip', 'music:stop', 'music:queue']);
    p.pause();
    expect(nowCard(p).toJSON().title).toBe('Paused');
    expect(buttons(p).toJSON().components.map((b) => (b as { custom_id: string }).custom_id)).toContain('music:resume');
  });

  it('says what a request did', () => {
    const t: Track = { title: 'Get Lucky', artist: 'Daft Punk', source: 'youtube', ref: '' };
    expect(playedText({ ok: true, started: t, added: 4, label: 'Random Access Memories' }, 'Sam')).toBe('▶ Sam started **Get Lucky** by Daft Punk (Random Access Memories), with 4 songs queued.');
    expect(playedText({ ok: true, added: 1, queuedAs: { track: t, position: 3 } }, 'Sam')).toContain('queued **Get Lucky** by Daft Punk at #3');
    expect(playedText({ ok: true, added: 25, artist: 'Daft Punk' }, 'Sam')).toBe('➕ Sam queued 25 songs by Daft Punk.');
    expect(playedText({ ok: false, message: "I couldn't find that." }, 'Sam')).toBe("I couldn't find that.");
  });

  it('suggests what was typed, recent songs and their artists', async () => {
    const { p } = player();
    await p.play('Blinding Lights', 'now', AbortSignal.timeout(2000));
    const taste = new MusicTaste(undefined);
    taste.played(USER, 'The Weeknd');
    expect(suggestions('', p.recent, taste, USER).map((s) => s.value)).toEqual(['Blinding Lights - Artist', 'The Weeknd']);
    expect(suggestions('weeknd', p.recent, taste, USER).map((s) => s.value)).toEqual(['weeknd', 'The Weeknd']);
    expect(suggestions('https://youtu.be/x', p.recent, taste, USER)).toHaveLength(1);
    // Too long for a suggestion: nothing offered, so what they typed is sent whole.
    expect(suggestions('x'.repeat(300), p.recent, taste, USER)).toEqual([]);
  });
});

/** The commands against a fake client: who is where, and the player. */
function rig(o: { spot?: VoiceSpot; seat?: Seat; owners?: string[]; limited?: boolean; ready?: boolean; moves?: () => Promise<void> } = {}) {
  const { p, src } = player();
  const client = new EventEmitter();
  let spot = o.spot;
  const moveTo = vi.fn(async (s: VoiceSpot) => {
    // As the stack's moveTo does: the music stops at once, the move takes a while.
    p.stop();
    await o.moves?.();
    spot = s;
  });
  const seat = vi.fn(() => o.seat ?? ({ refused: 'Join a voice channel first, then use /play.' } as Seat));
  const taste = new MusicTaste(undefined);
  const started = vi.fn();
  registerMusicCommands({
    client: client as never,
    log: quietLog as never,
    player: () => p,
    current: () => spot,
    voiceReady: () => o.ready ?? true,
    seat,
    mayLeave: () => undefined,
    moveTo,
    leave: async () => undefined,
    prefix: '!',
    isOwner: (id) => (o.owners ?? []).includes(id),
    allow: () => (o.limited ? "You've asked for a lot in the last hour. Give it a bit." : undefined),
    nameOf: (id) => (id === USER ? 'Sam' : id === OWNER ? 'Rique' : 'Alex'),
    taste,
    started,
  });

  type Sent = { content?: string; embeds?: unknown[]; components?: unknown[]; flags?: number; private?: boolean };
  const out: Sent[] = [];
  const keep = (r: Sent | string) => out.push(typeof r === 'string' ? { content: r } : { ...r, private: r.flags !== undefined });
  /** One interaction from `user` in voice channel `from` (null: not in voice). */
  const send = async (kind: 'slash' | 'button' | 'auto', name: string, opts: Record<string, unknown> = {}, user = USER, from: string | null = CALL, guildId = GUILD) => {
    out.length = 0;
    const i = {
      guildId,
      user: { id: user },
      commandName: kind === 'button' ? undefined : name.split(' ')[0],
      customId: kind === 'button' ? name : undefined,
      deferred: false,
      replied: false,
      inCachedGuild: () => true,
      isAutocomplete: () => kind === 'auto',
      isChatInputCommand: () => kind === 'slash',
      isButton: () => kind === 'button',
      isRepliable: () => kind !== 'auto',
      guild: { voiceStates: { cache: new Map(from ? [[user, { channelId: from }]] : []) } },
      options: {
        getString: (k: string) => (opts[k] as string | undefined) ?? null,
        getBoolean: (k: string) => (opts[k] as boolean | undefined) ?? null,
        getInteger: (k: string) => (opts[k] as number | undefined) ?? null,
        getSubcommand: () => name.split(' ')[1],
        getFocused: () => ({ name: 'query', value: opts.query ?? '' }),
      },
      reply: async (r: Sent) => ((i.replied = true), keep(r)),
      deferReply: async () => void (i.deferred = true),
      deferUpdate: async () => void (i.deferred = true),
      editReply: async (r: Sent) => keep(r),
      update: async (r: Sent) => ((i.replied = true), keep(r)),
      followUp: async (r: Sent) => keep(r),
      deleteReply: async () => undefined,
      message: undefined as { flags: { has(f: number): boolean } } | undefined,
      respond: async (list: unknown[]) => void out.push({ content: JSON.stringify(list) }),
    };
    if (opts.privateCard) i.message = { flags: { has: () => true } };
    client.emit(Events.InteractionCreate, i);
    await vi.waitFor(() => expect(out.length).toBeGreaterThan(0));
    await flush();
    return out[out.length - 1]!;
  };
  return { p, src, send, moveTo, seat, taste, started, out, spot: () => spot };
}

const at = (channelId: string, guildId = GUILD): VoiceSpot => ({ guildId, channelId });

describe('/play', () => {
  it('plays for someone in her call and shows the card with buttons', async () => {
    const r = rig({ spot: at(CALL) });
    const sent = await r.send('slash', 'play', { query: 'Get Lucky' });
    expect(sent.content).toContain('▶ Sam started **Get Lucky**');
    expect(sent.embeds).toHaveLength(1);
    expect(sent.components).toHaveLength(1);
    expect(sent.private).toBe(false);
    expect(r.p.nowPlaying?.by).toBe('Sam');
    expect(r.started).toHaveBeenCalledWith(USER);
    expect(r.moveTo).not.toHaveBeenCalled();
  });

  it('queues with queue:true, and says where', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    const sent = await r.send('slash', 'play', { query: 'two', queue: true });
    expect(sent.content).toBe('➕ Sam queued **two** by Artist (3:20) at #1.');
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it('comes to the caller when she is free, by /join rules', async () => {
    const r = rig({ seat: { move: at(ELSEWHERE), channel: {} as never } });
    const sent = await r.send('slash', 'play', { query: 'one' }, USER, ELSEWHERE);
    expect(r.moveTo).toHaveBeenCalledWith(at(ELSEWHERE));
    expect(sent.content).toContain('started');
  });

  it("won't pull her out of someone else's call", async () => {
    const r = rig({ spot: at(CALL), seat: { refused: "I'm in another channel here right now. Try again when that call is over." } });
    const sent = await r.send('slash', 'play', { query: 'one' }, FRIEND, ELSEWHERE);
    expect(sent.private).toBe(true);
    expect(sent.content).toContain('another channel');
    expect(r.p.nowPlaying).toBeUndefined();
  });

  it('lets an owner play into her call from outside it', async () => {
    const r = rig({ spot: at(CALL), owners: [OWNER] });
    const sent = await r.send('slash', 'play', { query: 'one' }, OWNER, null);
    expect(sent.content).toContain('Rique started');
    expect(r.moveTo).not.toHaveBeenCalled();
  });

  it('refuses links it would not fetch, and empty requests', async () => {
    const r = rig({ spot: at(CALL) });
    expect((await r.send('slash', 'play', { query: 'http://192.168.1.5/x.mp3' })).content).toContain('I can play YouTube');
    expect((await r.send('slash', 'play', {})).content).toContain('What should I play?');
    expect(r.src.finds).toEqual([]);
  });

  it('keeps to the hourly limit, and to a quiz', async () => {
    expect((await rig({ spot: at(CALL), limited: true }).send('slash', 'play', { query: 'one' })).content).toContain('a lot in the last hour');
    const r = rig({ spot: at(CALL) });
    r.p.lend({ reason: 'A music quiz is on.', stop() {}, skip() {} });
    expect((await r.send('slash', 'play', { query: 'one' })).content).toBe('A music quiz is on.');
  });

  it('says so when nothing was found', async () => {
    const r = rig({ spot: at(CALL) });
    expect((await r.send('slash', 'play', { query: 'missing song' })).content).toContain("couldn't find");
  });

  it('remembers the artist they asked for', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'Get Lucky', type: 'song' });
    expect(r.taste.top(USER)).toEqual(['Artist']);
  });

  it('says what it needs for favorites before anything is known', async () => {
    const r = rig({ spot: at(CALL) });
    expect((await r.send('slash', 'play', { type: 'favorites' })).content).toContain("don't know what you like yet");
  });

  it('autocompletes from memory', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'Song A' });
    const list = JSON.parse((await r.send('auto', 'play', { query: 'song' })).content!) as { value: string }[];
    expect(list.map((s) => s.value)).toEqual(['song', 'Song A - Artist']);
  });
});

describe('/music', () => {
  it('takes being in her call to change the music, but not to look', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    expect((await r.send('slash', 'music skip', {}, FRIEND, ELSEWHERE)).content).toBe('Join my voice channel to change the music.');
    expect((await r.send('slash', 'music now', {}, FRIEND, null)).embeds).toHaveLength(1);
    expect((await r.send('slash', 'music now', {}, FRIEND, null, OTHER_GUILD)).content).toContain("I'm not in a voice call in this server");
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it('pauses, resumes, sets the volume and shuffles, saying who did it', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    expect((await r.send('slash', 'music pause')).content).toBe('⏸ Sam paused the music.');
    expect((await r.send('slash', 'music pause')).content).toBe("It's already paused.");
    expect((await r.send('slash', 'music resume')).content).toBe('▶ Sam resumed the music.');
    expect((await r.send('slash', 'music volume', { level: 30 })).content).toBe('🔊 Sam set the music volume to 30%.');
    expect((await r.send('slash', 'music volume', {}, FRIEND, null)).content).toBe('Music volume is 30%.');
    expect((await r.send('slash', 'music shuffle')).content).toBe('The queue is empty.');
  });

  it('skips, skips ahead, removes and clears', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    for (const s of ['two', 'three', 'four']) await r.send('slash', 'play', { query: s, queue: true });
    expect((await r.send('slash', 'music remove', { position: 2 })).content).toBe('➖ Sam removed **three** by Artist (3:20) from the queue.');
    expect((await r.send('slash', 'music remove', { position: 5 })).content).toContain('no song #5');
    expect((await r.send('slash', 'music skip', { to: 2 })).content).toBe('⏭ Sam skipped to #2.');
    expect(r.p.nowPlaying?.title).toBe('four');
    expect((await r.send('slash', 'music skip')).content).toContain('Nothing else is queued');
    expect((await r.send('slash', 'music clear')).content).toBe('The queue is already empty.');
  });

  it('goes back and stops', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    await r.send('slash', 'play', { query: 'two' });
    expect((await r.send('slash', 'music back')).content).toBe('⏮ Sam went back.');
    expect(r.p.nowPlaying?.title).toBe('one');
    expect((await r.send('slash', 'music stop')).content).toBe('⏹ Sam stopped the music.');
    expect((await r.send('slash', 'music stop')).content).toBe('Nothing is playing.');
  });

  it('tells who asked', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    expect((await r.send('slash', 'music who', {}, FRIEND, null)).content).toBe('Sam asked for **one** by Artist (3:20).');
  });

  it('hands skip and stop to a quiz', async () => {
    const r = rig({ spot: at(CALL) });
    const quiz = { reason: 'A music quiz is on.', stop: vi.fn(), skip: vi.fn() };
    r.p.lend(quiz);
    expect((await r.send('slash', 'music skip')).content).toBe('⏭ Sam skipped this round.');
    expect(quiz.skip).toHaveBeenCalledOnce();
    expect((await r.send('slash', 'music shuffle')).content).toBe('A music quiz is on.');
    expect((await r.send('slash', 'music stop')).content).toBe('⏹ Sam stopped the quiz.');
    expect(quiz.stop).toHaveBeenCalledOnce();
  });
});

describe('the buttons', () => {
  it('act on the music and redraw the card', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    await r.send('slash', 'play', { query: 'two', queue: true });
    expect(((await r.send('button', 'music:pause')).embeds![0] as { toJSON(): { title: string } }).toJSON().title).toBe('Paused');
    expect(r.p.paused).toBe(true);
    await r.send('button', 'music:resume');
    expect(r.p.paused).toBe(false);
    await r.send('button', 'music:skip');
    expect(r.p.nowPlaying?.title).toBe('two');
    expect((await r.send('button', 'music:queue', {}, FRIEND, null)).private).toBe(true);
    expect((await r.send('button', 'music:skip', {}, FRIEND, ELSEWHERE)).content).toBe('Join my voice channel to change the music.');
    const stopped = await r.send('button', 'music:stop');
    expect(stopped.content).toBe('⏹ Sam stopped the music.');
    expect(stopped.components).toEqual([]);
  });
});

describe('the review fixes', () => {
  it('escapes masked links and headings in titles and names', () => {
    // An escaped "[" is shown as text, so Discord draws no link.
    expect(safe('[Free Nitro](https://evil.example)').startsWith('\\[Free Nitro]')).toBe(true);
    // "# " starting a line is a heading; "#" gets a zero-width break, so it never is.
    expect(safe('# Big').startsWith('# ')).toBe(false);
    expect(safe('- item').startsWith('\\-')).toBe(true);
    // Capped before escaping: no escape is cut in half.
    expect(safe('a'.repeat(99) + '*', 100).endsWith('\\*')).toBe(true);
  });

  it('rebuilds a dropped voice link for someone in her channel', async () => {
    const r = rig({ spot: at(CALL), ready: false, seat: { move: at(CALL), channel: {} as never } });
    await r.send('slash', 'play', { query: 'one' });
    expect(r.seat).toHaveBeenCalledOnce();
    expect(r.moveTo).toHaveBeenCalledWith(at(CALL));
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it('shows only the asker why a request failed', async () => {
    const r = rig({ spot: at(CALL) });
    const sent = await r.send('slash', 'play', { query: 'missing [x](https://evil.example)' });
    expect(sent.private).toBe(true);
    expect(sent.content).toContain("couldn't find");
  });

  it('a stop while she is still moving calls the request off', async () => {
    let arrive!: () => void;
    const r = rig({ seat: { move: at(ELSEWHERE), channel: {} as never }, moves: () => new Promise<void>((ok) => (arrive = ok)) });
    const i = r.send('slash', 'play', { query: 'one' }, USER, ELSEWHERE);
    await vi.waitFor(() => expect(r.moveTo).toHaveBeenCalled());
    r.p.stop(); // a /leave or "stop the music" meanwhile
    arrive();
    expect((await i).content).toBe('Stopped.');
    expect(r.p.nowPlaying).toBeUndefined();
  });

  it("doesn't offer the call's songs in another server", async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'Song A' });
    const list = JSON.parse((await r.send('auto', 'play', { query: 'song' }, FRIEND, null, OTHER_GUILD)).content!) as { value: string }[];
    expect(list.map((s) => s.value)).toEqual(['song']);
  });

  it('keeps skip and back failures private', async () => {
    const r = rig({ spot: at(CALL) });
    expect(await r.send('slash', 'music skip')).toMatchObject({ content: 'Nothing is playing.', private: true });
    expect(await r.send('slash', 'music back')).toMatchObject({ content: 'Nothing played before this one.', private: true });
    await r.send('slash', 'play', { query: 'one' });
    expect(await r.send('slash', 'music skip', { to: 3 })).toMatchObject({ private: true });
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it('says in the channel who pressed a button on a private card', async () => {
    const r = rig({ spot: at(CALL) });
    await r.send('slash', 'play', { query: 'one' });
    await r.send('button', 'music:pause', { privateCard: true });
    expect(r.out.map((m) => m.content)).toContain('⏸ Sam paused the music.');
  });
});

describe('typed commands', () => {
  const BOT = '100000000000000040';
  const parse = (s: string, prefix = '!') => parseTextCommand(s, prefix, BOT);

  it('reads plays, with or without an @mention of her first', () => {
    expect(parse('!play Get Lucky')).toEqual({ kind: 'play', query: 'Get Lucky', type: 'auto', mode: 'now' });
    expect(parse(`<@${BOT}> !p get lucky`)).toMatchObject({ kind: 'play', query: 'get lucky' });
    expect(parse(`<@!${BOT}>!PLAY x`)).toMatchObject({ kind: 'play', query: 'x' });
    expect(parse('!playnext Humble')).toMatchObject({ mode: 'queue', query: 'Humble' });
    expect(parse('!queue Humble')).toMatchObject({ kind: 'play', mode: 'queue' });
    expect(parse('!album Graduation')).toMatchObject({ type: 'album', query: 'Graduation' });
    expect(parse('!plex Thriller')).toMatchObject({ source: 'plex' });
    expect(parse('!similar')).toMatchObject({ type: 'similar', query: '' });
    expect(parse('!favorites')).toMatchObject({ type: 'favorites' });
  });

  it('reads controls and their numbers', () => {
    expect(parse('!play')).toEqual({ kind: 'music', sub: 'resume' });
    expect(parse('!queue')).toEqual({ kind: 'music', sub: 'queue' });
    expect(parse('!q 2')).toEqual({ kind: 'music', sub: 'queue', n: 2 });
    expect(parse('!skip')).toEqual({ kind: 'music', sub: 'skip' });
    expect(parse('!s 3')).toEqual({ kind: 'music', sub: 'skip', n: 3 });
    expect(parse('!vol 30')).toEqual({ kind: 'music', sub: 'volume', n: 30 });
    expect(parse('!volume')).toEqual({ kind: 'music', sub: 'volume' });
    expect(parse('!autoplay off')).toEqual({ kind: 'music', sub: 'autoplay', on: false });
    expect(parse('!autoplay')).toEqual({ kind: 'music', sub: 'autoplay' });
    expect(parse('!remove 2')).toEqual({ kind: 'music', sub: 'remove', n: 2 });
    expect(parse('!np')).toEqual({ kind: 'music', sub: 'now' });
    expect(parse('!join')).toEqual({ kind: 'join' });
    expect(parse('!dc')).toEqual({ kind: 'leave' });
    expect(parse(`<@${BOT}> !help`)).toEqual({ kind: 'help' });
  });

  it("leaves everything else alone: other bots' commands, chat, odd arguments, someone else's mention", () => {
    // Other bots answer !help too, and her words with more after them aren't hers.
    for (const s of ['!help', '!leave me alone', '!clear 50', '!stop the count', '!remove x', '!np pls', '!roll d20', 'play Get Lucky', 'hey !play x', '!vol loud', '!skip the intro', '!autoplay maybe', '!', '!constructor', '!toString x', '<@100000000000000099> !play x']) expect(parse(s)).toBeUndefined();
    expect(parse('!play x', '')).toBeUndefined();
    expect(parse('?play x', '?')).toMatchObject({ kind: 'play' });
  });

  it('lists the commands with the prefix in use', () => {
    expect(textHelp('?')).toContain('`?play <song, artist or link>`');
  });
});

/** Typed commands against a fake client. */
function textRig(o: { spot?: VoiceSpot; seat?: Seat; owners?: string[]; leaveRefused?: string; ready?: boolean; noHistory?: boolean } = {}) {
  const { p } = player();
  const client = Object.assign(new EventEmitter(), { user: { id: '100000000000000040' } });
  let spot = o.spot;
  const moveTo = vi.fn(async (s: VoiceSpot) => {
    p.stop();
    spot = s;
  });
  const leave = vi.fn(async () => {
    p.stop();
    spot = undefined;
  });
  const seat = vi.fn(() => o.seat ?? ({ refused: 'Join a voice channel first, then use !play.' } as Seat));
  const cmds = registerMusicCommands({
    client: client as never,
    log: quietLog as never,
    player: () => p,
    current: () => spot,
    voiceReady: () => o.ready ?? true,
    seat,
    mayLeave: () => o.leaveRefused,
    moveTo,
    leave,
    isOwner: (id) => (o.owners ?? []).includes(id),
    allow: () => undefined,
    nameOf: (id) => (id === USER ? 'Sam' : id === OWNER ? 'Rique' : 'Alex'),
    prefix: '!',
  });
  const replies: { content?: string; embeds?: unknown[]; components?: unknown[] }[] = [];
  /** A message from `user`, who is in voice channel `from` (null: not in voice). */
  const say = async (content: string, user = USER, from: string | null = CALL) => {
    replies.length = 0;
    const m = {
      content,
      author: { id: user, bot: false },
      system: false,
      guildId: GUILD,
      inGuild: () => true,
      guild: { voiceStates: { cache: new Map(from ? [[user, { channelId: from }]] : []) } },
      channel: { sendTyping: async () => undefined },
      reply: async (r: { content?: string }) => {
        if (o.noHistory) throw new Error('Missing Permissions');
        replies.push(r);
      },
    };
    (m.channel as Record<string, unknown>).send = async (r: { content?: string }) => void replies.push({ ...r, plain: true } as never);
    const mine = cmds.isCommand(m as never);
    client.emit(Events.MessageCreate, m);
    if (mine) await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    await flush();
    return { mine, reply: replies.at(-1) };
  };
  return { p, say, seat, moveTo, leave, spot: () => spot };
}

describe('typed commands in a server', () => {
  it('play for someone in her call, with the card', async () => {
    const r = textRig({ spot: at(CALL) });
    const { mine, reply } = await r.say('!play one');
    expect(mine).toBe(true);
    expect(reply?.content).toContain('▶ Sam started **one**');
    expect(reply?.embeds).toHaveLength(1);
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it("join the asker's call when she's free", async () => {
    const r = textRig({ spot: at(CALL), seat: { move: at(ELSEWHERE), channel: {} as never } });
    await r.say('!play one', FRIEND, ELSEWHERE);
    expect(r.moveTo).toHaveBeenCalledWith(at(ELSEWHERE));
    expect(r.spot()).toEqual(at(ELSEWHERE));
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it("go to an owner's call too, not only play into hers", async () => {
    const r = textRig({ spot: at(CALL), owners: [OWNER], seat: { move: at(ELSEWHERE), channel: {} as never } });
    await r.say('!play one', OWNER, ELSEWHERE);
    expect(r.seat).toHaveBeenCalledOnce();
    expect(r.spot()).toEqual(at(ELSEWHERE));
  });

  it('play into her call for an owner who is in no call', async () => {
    const r = textRig({ spot: at(CALL), owners: [OWNER] });
    await r.say('!play one', OWNER, null);
    expect(r.seat).not.toHaveBeenCalled();
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it("say why when she can't come", async () => {
    const r = textRig({ spot: at(CALL), seat: { refused: "I'm in another channel here right now. Try again when that call is over." } });
    expect((await r.say('!play one', FRIEND, ELSEWHERE)).reply?.content).toContain('another channel');
    expect(r.p.nowPlaying).toBeUndefined();
  });

  it('control the music only from her call', async () => {
    const r = textRig({ spot: at(CALL) });
    await r.say('!play one');
    await r.say('!add two');
    expect((await r.say('!skip', FRIEND, ELSEWHERE)).reply?.content).toBe('Join my voice channel to change the music.');
    expect((await r.say('!skip')).reply?.content).toContain('⏭ Sam skipped');
    expect(r.p.nowPlaying?.title).toBe('two');
    expect((await r.say('!q', FRIEND, null)).reply?.embeds).toHaveLength(1);
    expect((await r.say('!remove')).reply?.content).toContain('Which one?');
    expect((await r.say('!pause')).reply?.content).toBe('⏸ Sam paused the music.');
    expect((await r.say('!play')).reply?.content).toBe('▶ Sam resumed the music.');
  });

  it('join and leave', async () => {
    const r = textRig({ seat: { move: at(ELSEWHERE), channel: { name: 'gaming' } as never } });
    expect((await r.say('!join', USER, ELSEWHERE)).reply?.content).toContain('Joined gaming');
    expect((await r.say('!leave', USER, ELSEWHERE)).reply?.content).toContain('Left the voice channel');
    expect(r.leave).toHaveBeenCalledOnce();
    const busy = textRig({ spot: at(CALL), leaveRefused: "I'm in a call with other people right now. Try again when it's over." });
    expect((await busy.say('!leave', FRIEND, null)).reply?.content).toContain('other people');
    expect(busy.leave).not.toHaveBeenCalled();
  });

  it("answer with a plain message where she can't reply, and never say it failed after it worked", async () => {
    const r = textRig({ spot: at(CALL), noHistory: true });
    const { reply } = await r.say('!play one');
    expect(reply).toMatchObject({ plain: true });
    expect(reply?.content).toContain('started');
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it('play for an owner in no call while the link is being rebuilt', async () => {
    const r = textRig({ spot: at(CALL), owners: [OWNER], ready: false });
    await r.say('!play one', OWNER, null);
    expect(r.seat).not.toHaveBeenCalled();
    expect(r.p.nowPlaying?.title).toBe('one');
  });

  it("don't answer what isn't hers", async () => {
    const r = textRig({ spot: at(CALL) });
    expect((await r.say('!roll d20')).mine).toBe(false);
    expect((await r.say('hello')).mine).toBe(false);
  });
});
