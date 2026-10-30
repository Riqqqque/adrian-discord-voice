import { describe, expect, it } from 'vitest';
import { ConversationController, DEFAULT_CONTROLLER_OPTIONS } from '../src/conversation/controller.js';
import type { PlaybackHandle, ToolContext } from '../src/core/interfaces.js';
import { deezerTopTracks, MusicPlayer, type MusicOutput, musicTools, type Runner, type TopTracks, YoutubeSource } from '../src/features/music.js';
import { MusicTaste } from '../src/features/taste.js';
import { FRAME_BYTES, Mixer } from '../src/voice/mixer.js';
import { PassThrough } from 'node:stream';

const quiet = { info() {}, warn() {} };
const sig = () => AbortSignal.timeout(2000);
const ctx: ToolContext = { userId: 'u1', speaker: 'Sam' };

function player(topTracks?: TopTracks) {
  const looked: string[] = [];
  const run: Runner = async (_cmd, args) => {
    const url = args.at(-1)!;
    looked.push(url);
    if (url.includes('#songs')) return 'vidsong0001\n';
    if (url.includes('list=RDAMVM')) return '';
    if (url.includes('watch?v=')) return `Artist - Song\tArtist\t200\thttps://stream/x\n`;
    return '';
  };
  const out: MusicOutput = {
    playMusic: () => ({ done: new Promise(() => {}), stop() {} }) as PlaybackHandle,
    pauseMusic() {},
    resumeMusic() {},
    setMusicVolume() {},
    musicPlaying: true,
    musicPaused: false,
  };
  const p = new MusicPlayer({
    sources: [new YoutubeSource({ ytdlp: 'yt-dlp' }, run)],
    output: out,
    decode: () => ({ pcm: new PassThrough(), kill() {} }),
    log: quiet,
    autoplay: false,
    ...(topTracks ? { topTracks } : {}),
  });
  return { p, looked };
}

const songs = (n: number) => Array.from({ length: n }, (_, i) => `Song ${i + 1}`);
const known = (artist: string, n = 30): TopTracks => async () => ({ artist, titles: songs(n), known: true });

describe('artist requests', () => {
  it('shuffles the top songs and looks up only the first until its turn', async () => {
    const { p, looked } = player(known('Drake'));
    const r = await p.request('artist', 'drake', 'now', sig());
    expect(r).toMatchObject({ ok: true, artist: 'Drake', added: 24 });
    expect(p.upNext).toHaveLength(24);
    expect(p.upNext.every((t) => t.artist === 'Drake' && !t.ref && t.query?.endsWith(' Drake'))).toBe(true);
    expect(looked.filter((u) => u.includes('#songs'))).toHaveLength(2); // the first, and the next one getting ready
  });

  it('changes the order between requests', async () => {
    const orders = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const { p } = player(known('Drake'));
      await p.request('artist', 'drake', 'now', sig());
      orders.add(p.upNext.map((t) => t.title).join());
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('falls back to the top song when the lookup fails', async () => {
    const { p } = player(async () => {
      throw new Error('down');
    });
    const r = await p.request('artist', 'drake', 'now', sig());
    expect(r.ok).toBe(true);
    expect(p.nowPlaying).toBeDefined();
  });

  it('a bare "play X" shuffles only a well-known exact artist', async () => {
    const a = player(known('Drake'));
    expect(await a.p.playNamed('some drake', 'now', sig())).toMatchObject({ ok: true, artist: 'Drake' });
    const b = player(async () => ({ artist: 'Get Lucky', titles: songs(10), known: false }));
    const r = await b.p.playNamed('get lucky', 'now', sig());
    expect(r.ok && r.artist).toBeFalsy();
    expect(b.p.upNext).toHaveLength(0);
  });

  it('a song asked for from a named source stays a song', async () => {
    const { p } = player(known('Drake'));
    const r = await p.playNamed('drake', 'now', sig(), 'youtube');
    expect(r.ok && r.artist).toBeFalsy();
  });
});

describe('deezerTopTracks', () => {
  const api =
    (artists: object[], top: object[]): typeof fetch =>
    (async (u: string) => new Response(JSON.stringify({ data: String(u).includes('/search/') ? artists : top }))) as unknown as typeof fetch;

  it('keeps the artist\'s own songs, one version of each', async () => {
    const f = api(
      [{ id: 2, name: 'Tame Impala', nb_fan: 2_000_000 }],
      [
        { title: 'Dracula', artist: { id: 2 } },
        { title: 'Flower In A Hurricane', artist: { id: 9 } },
        { title: 'Dracula (with JENNIE)', artist: { id: 2 } },
        { title: 'Let It Happen', artist: { id: 2 } },
      ],
    );
    expect(await deezerTopTracks(f)('tame impala', sig())).toEqual({ artist: 'Tame Impala', titles: ['Dracula', 'Let It Happen'], known: true });
  });

  it('picks the biggest of several artists with the name', async () => {
    const f = api(
      [
        { id: 1, name: 'Drake', nb_fan: 191 },
        { id: 2, name: 'Drake', nb_fan: 24_000_000 },
      ],
      [{ title: 'Hit', artist: { id: 2 } }],
    );
    expect((await deezerTopTracks(f)('drake', sig()))?.titles).toEqual(['Hit']);
  });

  it('is not sure about a small act or a near match', async () => {
    const small = api([{ id: 1, name: 'Get Lucky', nb_fan: 12 }], [{ title: 'x', artist: { id: 1 } }]);
    expect((await deezerTopTracks(small)('get lucky', sig()))?.known).toBe(false);
    const near = api([{ id: 1, name: 'Queen Latifah', nb_fan: 900_000 }], [{ title: 'x', artist: { id: 1 } }]);
    expect((await deezerTopTracks(near)('queen of hearts', sig()))?.known).toBe(false);
  });
});

describe('music taste', () => {
  const day = 24 * 3_600_000;

  it('ranks what someone asks for, and fades old plays', () => {
    let now = 0;
    const t = new MusicTaste(undefined, () => now);
    for (let i = 0; i < 4; i++) t.played('u', 'Old Band');
    now = 365 * day;
    t.played('u', 'New Band');
    expect(t.top('u')).toEqual(['New Band', 'Old Band']);
  });

  it('counts a name however it is written, and keeps people apart', () => {
    const t = new MusicTaste(undefined);
    t.played('u', 'Drake');
    t.played('u', ' drake ');
    t.played('u', 'SZA');
    expect(t.top('u')).toEqual(['Drake', 'SZA']);
    expect(t.top('someone else')).toEqual([]);
    expect(t.context('someone else', 'Pat').join()).not.toContain('Drake');
  });

  it('saves opinions, and a new one replaces the old', async () => {
    const t = new MusicTaste(undefined);
    const tool = t.tools()[0]!;
    await tool.run({ who: 'them', what: 'dislike', name: 'Drake' }, sig(), ctx);
    t.played('u1', 'Drake');
    expect(t.top('u1')).toEqual([]);
    await tool.run({ who: 'them', what: 'like', name: 'Drake' }, sig(), ctx);
    expect(t.top('u1')).toEqual(['Drake']);
  });

  it('her own taste is hers: everyone sees it, and it is not the asker\'s', async () => {
    const t = new MusicTaste(undefined);
    await t.tools()[0]!.run({ who: 'you', what: 'like', name: 'Portishead' }, sig(), ctx);
    expect(t.hers()).toEqual(['Portishead']);
    expect(t.top('u1')).toEqual([]);
    expect(t.context('anyone', 'Pat').join()).toContain('Portishead');
  });

  it('play_music learns from artists asked for and plays favorites from them', async () => {
    const t = new MusicTaste(undefined);
    const { p } = player(known('Drake'));
    const play = musicTools(p, t)[0]!;
    expect(await play.run({ request_type: 'favorites' }, sig(), ctx)).toContain("don't know what Sam likes");
    await play.run({ request_type: 'artist', query: 'drake' }, sig(), ctx);
    expect(t.top('u1')).toEqual(['Drake']);
    expect(await play.run({ request_type: 'favorites' }, sig(), ctx)).toContain('music Sam likes');
    expect(t.top('u1')).toEqual(['Drake']); // a favorites mix isn't a new vote
  });
});

describe('listening after an order', () => {
  function rig(result: 'done' | undefined) {
    let now = 0;
    const heard: string[] = [];
    const changes: number[] = [];
    const c: ConversationController = new ConversationController(
      {
        now: () => now,
        respond: async (_u, command) => {
          heard.push(command);
          return result;
        },
        say: async () => {},
        isPriority: () => false,
        listenChanged: () => changes.push(c.listenLeftMs('a')),
      },
      DEFAULT_CONTROLLER_OPTIONS,
    );
    const tick = async (ms = 0) => {
      now += ms;
      await new Promise((r) => setTimeout(r, 0));
    };
    return { c, heard, changes, tick };
  }

  it('an order carried out closes the window', async () => {
    const r = rig('done');
    r.c.heard({ userId: 'a', text: 'Adrian play drake', woke: true, command: 'play drake' });
    await r.tick();
    expect(r.c.listeningTo('a')).toBe(false);
    r.c.heard({ userId: 'a', text: 'yeah i told him that', woke: false, command: '' });
    await r.tick();
    expect(r.heard).toEqual(['play drake']);
  });

  it('a normal answer keeps it open, and reports how long', async () => {
    const r = rig(undefined);
    r.c.heard({ userId: 'a', text: 'Adrian who is drake', woke: true, command: 'who is drake' });
    await r.tick();
    expect(r.c.listeningTo('a')).toBe(true);
    expect(r.c.listenLeftMs('a')).toBe(DEFAULT_CONTROLLER_OPTIONS.followUpMs);
    expect(r.changes.at(-1)).toBe(DEFAULT_CONTROLLER_OPTIONS.followUpMs);
    await r.tick(DEFAULT_CONTROLLER_OPTIONS.followUpMs + 1);
    expect(r.c.listenLeftMs('a')).toBe(0);
  });

  it('"shut up" still works right after an order', async () => {
    const said: string[] = [];
    const c = new ConversationController(
      { now: () => performance.now(), respond: async () => 'done', say: async () => {}, isPriority: () => false, onStopped: (u) => said.push(u) },
      DEFAULT_CONTROLLER_OPTIONS,
    );
    c.heard({ userId: 'a', text: 'Adrian play drake', woke: true, command: 'play drake' });
    await new Promise((r) => setTimeout(r, 0));
    c.heard({ userId: 'a', text: 'shut up', woke: false, command: '' });
    expect(said).toEqual(['a']);
  });
});

describe('the mixer says when her voice is playing', () => {
  it('reports voice, not music', async () => {
    let now = 0;
    const voice: boolean[] = [];
    const m = new Mixer(
      {
        start: (s) => {
          s.on('data', () => {});
          return { done: new Promise(() => {}), stop() {} };
        },
        onVoice: (on) => voice.push(on),
        setInterval: () => 1,
        clearInterval: () => {},
      },
      () => now,
    );
    const run = async (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 20;
        m.tick();
        await new Promise((r) => setImmediate(r));
      }
    };
    const music = new PassThrough();
    m.playMusic(music, 0.5);
    music.write(Buffer.alloc(FRAME_BYTES * 100));
    await run(5);
    expect(voice).toEqual([]);
    const speech = new PassThrough();
    m.playPcm(speech);
    speech.end(Buffer.alloc(FRAME_BYTES * 3));
    await run(10);
    expect(voice).toEqual([true, false]);
  });
});
