// Music in the call: YouTube first (yt-dlp), the household Plex music
// library as the backup. Tracks are decoded by ffmpeg to 48 kHz stereo PCM,
// leveled, and played through the mixer under the bot's voice.

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { PlaybackHandle, Tool, ToolContext } from '../core/interfaces.js';
import { parseMediaLink, spotifyItem } from './links.js';
import type { MusicTaste } from './taste.js';

export interface Track {
  /** Song name, cleaned for speaking. */
  title: string;
  artist?: string;
  durationS?: number;
  source: 'youtube' | 'plex';
  /** Where the audio comes from (stream URL or Plex part path); empty until resolved. */
  ref: string;
  /** YouTube video id (radio seeds, repeats). */
  id?: string;
  kind?: 'podcast';
  /** The title as published (podcast episodes are spoken in full). */
  fullTitle?: string;
  /** Found on YouTube Music by these words when its turn comes (an artist's top songs). */
  query?: string;
}

export interface MusicSource {
  readonly name: Track['source'];
  find(query: string, signal: AbortSignal): Promise<Track | undefined>;
  /** Encoded audio for ffmpeg: a URL it can open, or a byte stream. */
  open(t: Track, signal: AbortSignal): Promise<{ url: string } | { stream: Readable }>;
  /** Get a queued track ready ahead of its turn. */
  prepare?(t: Track, signal: AbortSignal): Promise<void>;
}

/** The parts of the mixer the player uses. */
export interface MusicOutput {
  playMusic(stream: NodeJS.ReadableStream, volume: number): PlaybackHandle;
  pauseMusic(): void;
  resumeMusic(): void;
  setMusicVolume(v: number): void;
  readonly musicPlaying: boolean;
  readonly musicPaused: boolean;
  takeStats?(): object;
}

type Log = { info(m: string, f?: object): void; warn(m: string, f?: object): void };

// --- titles ---------------------------------------------------------------

const JUNK = /\s*[([](?:[^)\]]*\b(?:official|audio|video|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|explicit|clean|music video|mv|topic)\b[^)\]]*)[)\]]/gi;

/** "Daft Punk - Get Lucky (Official Audio) ft. Pharrell" by "Daft Punk"
 *  → { title: "Get Lucky", artist: "Daft Punk" }. */
export function cleanTitle(raw: string, uploader?: string): { title: string; artist?: string } {
  let t = raw.replace(JUNK, '').replace(/\s+(?:ft\.?|feat\.?|featuring)\s.*$/i, '').replace(/\s*\|.*$/, '').trim();
  let artist = uploader?.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim() || undefined;
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/) ?? t.match(/^(.+?)\s+["“](.+?)["”]$/); // "Artist - Song", 'Artist "Song"'
  if (dash) {
    artist = dash[1]!.trim();
    t = dash[2]!.trim();
  }
  t = t.replace(/^["“']|["”']$/g, '').trim();
  return { title: t || raw.trim(), ...(artist && artist.toLowerCase() !== t.toLowerCase() ? { artist } : {}) };
}

export function describe(t: Track): string {
  if (t.kind === 'podcast') return t.fullTitle ?? t.title;
  return t.artist ? `${t.title} by ${t.artist}` : t.title;
}

// --- YouTube ----------------------------------------------------------------

export type Runner = (cmd: string, args: string[], signal: AbortSignal) => Promise<string>;

/** Run a program and return its stdout. */
export const runProgram: Runner = (cmd, args, signal) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (b: Buffer) => (out += b.toString()));
    p.stderr.on('data', (b: Buffer) => (err += b.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop()?.slice(0, 200) || `exit ${code}`))));
  });

/** Words that mean the person wants a long mix or stream, not a song. */
const NOT_A_SONG = /\b(mix|live|radio|playlist|lofi|lo-fi|beats|podcast|stream|hours?|ambient|study|sleep|compilation|album|full album)\b/i;
const VIDEO_ID = /^[\w-]{11}$/;
/** A YouTube Music search page for one kind of result. */
const ytm = (q: string, kind: 'songs' | 'albums' | 'community playlists' | 'episodes') =>
  `https://music.youtube.com/search?q=${encodeURIComponent(q)}#${kind.replace(/ /g, '+')}`;

/** A list of tracks (album, playlist, radio, podcast show). */
export interface Collection {
  title?: string;
  tracks: Track[];
}

export class YoutubeSource implements MusicSource {
  readonly name = 'youtube' as const;
  constructor(
    private readonly o: { ytdlp: string; node?: string; timeoutMs?: number },
    private readonly run: Runner = runProgram,
  ) {}

  private base(): string[] {
    return [...(this.o.node ? ['--js-runtimes', `node:${this.o.node}`] : []), '--no-warnings', '--no-progress', '--no-cache-dir', '--ignore-config'];
  }

  private sig(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(this.o.timeoutMs ?? 25_000)]);
  }

  /** First result id on a search or listing page. */
  private async firstId(url: string, sig: AbortSignal): Promise<string | undefined> {
    const out = await this.run(this.o.ytdlp, [...this.base(), '--flat-playlist', '-I', '1:3', '--print', '%(id)s', url], sig).catch((e: Error) => {
      if (sig.aborted) throw e;
      return '';
    });
    return out.split('\n').map((l) => l.trim()).find((l) => l && l !== 'NA');
  }

  /** One song: YouTube Music's song catalog (real tracks, never hour-long
   *  loops or compilations); regular YouTube for mixes, or as a fallback. */
  async find(query: string, signal: AbortSignal): Promise<Track | undefined> {
    const sig = this.sig(signal);
    const long = NOT_A_SONG.test(query);
    let id = long ? undefined : await this.firstId(ytm(query, 'songs'), sig);
    if (id && !VIDEO_ID.test(id)) id = undefined;
    if (!id) {
      const out = await this.run(this.o.ytdlp, [...this.base(), '--flat-playlist', '--print', '%(id)s\t%(duration)s\t%(live_status)s', `ytsearch5:${query}`], sig);
      id = pickVideo(out, long);
    }
    return id ? this.resolve(id, sig) : undefined;
  }

  /** A short sound-effect clip: the first result under 30 s (else under 2 min). */
  async soundEffect(query: string, signal: AbortSignal): Promise<Track | undefined> {
    const sig = this.sig(signal);
    const out = await this.run(this.o.ytdlp, [...this.base(), '--flat-playlist', '--print', '%(id)s\t%(duration)s\t%(live_status)s', `ytsearch8:${query} sound effect`], sig);
    const id = pickShort(out, 30) ?? pickShort(out, 120);
    return id ? this.resolve(id, sig) : undefined;
  }

  /** Any YouTube video, any length (a 10-hour rain loop, a live radio). */
  async video(query: string, signal: AbortSignal): Promise<Track | undefined> {
    const sig = this.sig(signal);
    const out = await this.run(this.o.ytdlp, [...this.base(), '--flat-playlist', '--print', '%(id)s\t%(duration)s\t%(live_status)s', `ytsearch5:${query}`], sig);
    const id = pickVideo(out, true);
    return id ? this.resolve(id, sig) : undefined;
  }

  /** Stream URL and names for one video. */
  async resolve(id: string, signal: AbortSignal): Promise<Track | undefined> {
    const out = await this.run(
      this.o.ytdlp,
      [...this.base(), '--no-playlist', '-f', 'bestaudio/best', '--print', '%(title)s\t%(artist,creator,uploader)s\t%(duration)s\t%(url)s', `https://www.youtube.com/watch?v=${id}`],
      this.sig(signal),
    );
    const t = parseYtdlp(out);
    return t && { ...t, id };
  }

  /** A SoundCloud or Bandcamp page (already checked by parseMediaLink). */
  async resolveUrl(url: string, signal: AbortSignal): Promise<Track | undefined> {
    const out = await this.run(
      this.o.ytdlp,
      [...this.base(), '--no-playlist', '-f', 'bestaudio/best', '--print', '%(title)s	%(artist,creator,uploader)s	%(duration)s	%(url)s', url],
      this.sig(signal),
    );
    return parseYtdlp(out);
  }

  /** A playlist-like page as tracks; each is resolved when it's played. */
  async list(url: string, signal: AbortSignal, limit = 25): Promise<Collection> {
    const out = await this.run(this.o.ytdlp, [...this.base(), '--flat-playlist', '-I', `1:${limit}`, '--print', '%(playlist_title)s\t%(id)s\t%(title)s\t%(duration)s', url], this.sig(signal));
    return parseList(out);
  }

  async album(query: string, signal: AbortSignal): Promise<Collection | undefined> {
    const id = await this.firstId(ytm(query, 'albums'), this.sig(signal));
    return id ? this.list(`https://music.youtube.com/browse/${id}`, signal, 40) : undefined;
  }

  /** A public playlist matching the words (a vibe, genre, mood or name). */
  async playlist(query: string, signal: AbortSignal): Promise<Collection | undefined> {
    const id = await this.firstId(ytm(query, 'community playlists'), this.sig(signal));
    if (!id) return undefined;
    const list = id.startsWith('VL') ? id.slice(2) : id;
    return this.list(`https://music.youtube.com/playlist?list=${list}`, signal, 30);
  }

  /** A podcast: the show's recent episodes, or one episode. */
  async podcast(query: string, signal: AbortSignal): Promise<Collection | undefined> {
    const id = await this.firstId(ytm(query, 'episodes'), this.sig(signal));
    if (!id) return undefined;
    if (VIDEO_ID.test(id)) {
      const t = await this.resolve(id, signal);
      return t ? { tracks: [{ ...t, kind: 'podcast' }] } : undefined;
    }
    const url = id.startsWith('MPSP') ? `https://music.youtube.com/playlist?list=${id.slice(4)}` : `https://music.youtube.com/browse/${id}`;
    const c = await this.list(url, signal, 5);
    return { ...c, tracks: c.tracks.map((t) => ({ ...t, kind: 'podcast' as const })) };
  }

  /** YouTube Music's radio for a song: similar songs, the seed first. */
  async radio(seedId: string, signal: AbortSignal, limit = 25): Promise<Track[]> {
    return (await this.list(`https://music.youtube.com/watch?v=${seedId}&list=RDAMVM${seedId}`, signal, limit)).tracks;
  }

  /** Fill in the stream URL ahead of time (a track from a list). */
  async prepare(t: Track, signal: AbortSignal): Promise<void> {
    if (t.ref) return;
    if (!t.id && t.query) {
      // Named but not looked up yet: the top song result for its words.
      const f = await this.find(t.query, signal);
      if (!f?.id) throw new Error('not found on YouTube');
      t.id = f.id;
      t.ref = f.ref;
      if (f.durationS) t.durationS = f.durationS;
      if (!t.artist && f.artist) t.artist = f.artist;
      return;
    }
    if (!t.id) return;
    const r = await this.resolve(t.id, signal);
    if (!r) throw new Error('that one is unavailable');
    t.ref = r.ref;
    t.title = r.title;
    if (r.fullTitle) t.fullTitle = r.fullTitle;
    if (r.artist) t.artist = r.artist;
    if (r.durationS) t.durationS = r.durationS;
  }

  async open(t: Track, signal: AbortSignal): Promise<{ url: string }> {
    await this.prepare(t, signal);
    if (!t.ref) throw new Error('nothing to play');
    return { url: t.ref };
  }
}

/** `playlist_title \t id \t title \t duration` lines → tracks. */
export function parseList(out: string): Collection {
  let title: string | undefined;
  const tracks: Track[] = [];
  for (const line of out.split('\n')) {
    const [pl, rawId, name, dur] = line.split('\t');
    const id = rawId?.trim();
    if (!id || !VIDEO_ID.test(id)) continue;
    if (!title && pl && pl !== 'NA') title = pl.replace(/^(Album|Playlist)\s*-\s*/i, '').trim();
    const d = Number(dur);
    tracks.push({
      title: name && name !== 'NA' ? cleanTitle(name).title : 'an episode',
      ...(Number.isFinite(d) && d > 0 ? { durationS: d } : {}),
      source: 'youtube',
      ref: '',
      id,
    });
  }
  return { ...(title ? { title } : {}), tracks };
}

/** From search lines (id, duration, live status): the first clip no longer than max seconds. */
export function pickShort(out: string, max: number): string | undefined {
  for (const line of out.split('\n')) {
    const [id, dur, live] = line.trim().split('\t');
    const d = Number(dur);
    if (id && VIDEO_ID.test(id) && live !== 'is_live' && Number.isFinite(d) && d > 0 && d <= max) return id;
  }
  return undefined;
}

/** Longest regular video taken for a song request (seconds). */
const MAX_SONG_S = 15 * 60;

/** From `ytsearch5` lines (id, duration, live status): the first that fits.
 *  Songs skip anything over 15 min and live streams; mixes take any. */
export function pickVideo(out: string, long: boolean): string | undefined {
  for (const line of out.split('\n')) {
    const [id, dur, live] = line.trim().split('\t');
    if (!id || !/^[\w-]{11}$/.test(id)) continue;
    if (long) return id;
    const d = Number(dur);
    if (live === 'is_live' || live === 'is_upcoming' || !Number.isFinite(d) || d > MAX_SONG_S) continue;
    return id;
  }
  return undefined;
}

export function parseYtdlp(out: string): Track | undefined {
  const line = out.split('\n').find((l) => l.includes('\thttp'));
  if (!line) return undefined;
  const [title, uploader, duration, url] = line.split('\t');
  if (!title || !url?.startsWith('http')) return undefined;
  const d = Number(duration);
  // "JaeyBxrd, JaeyBxrd" (one artist listed twice) → "JaeyBxrd".
  const artists = uploader && uploader !== 'NA' ? [...new Set(uploader.split(/,\s*/).map((x) => x.trim()).filter(Boolean))].join(', ') : undefined;
  return { ...cleanTitle(title, artists), fullTitle: title.trim(), ...(Number.isFinite(d) && d > 0 ? { durationS: d } : {}), source: 'youtube', ref: url.trim() };
}

// --- an artist's most popular songs ----------------------------------------------

/** An artist's best-known songs, most popular first. `known`: that name really
 *  is a well-known artist, not just the nearest match. */
export type TopTracks = (artist: string, signal: AbortSignal) => Promise<{ artist: string; titles: string[]; known: boolean } | undefined>;

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "Dracula (with JENNIE)", "Song - Remastered 2011" → "dracula", "song": versions of one song. */
const songKey = (title: string) => fold(title.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, ''));

/** Fans an exact name match needs before a bare "play X" counts as the artist:
 *  below this, X is more likely a song that some small act is also called. */
const KNOWN_FANS = 5_000;

/** Deezer's public catalog (no key): the artist by name, then their top
 *  tracks by popularity. Only the artist's name is sent. */
export function deezerTopTracks(f: typeof fetch = fetch): TopTracks {
  const get = async (url: string, signal: AbortSignal) => {
    const r = await f(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`Deezer answered ${r.status}`);
    return (await r.json()) as { data?: unknown[] };
  };
  return async (name, signal) => {
    const q = name.trim().slice(0, 100);
    if (!q) return undefined;
    const found = (await get(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=5`, signal)).data as
      | { id?: number; name?: string; nb_fan?: number }[]
      | undefined;
    const exact = (found ?? []).filter((a) => a.name && fold(a.name) === fold(q)).sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0));
    const artist = exact[0] ?? found?.[0];
    if (!artist?.id || !artist.name) return undefined;
    const top = (await get(`https://api.deezer.com/artist/${artist.id}/top?limit=50`, signal)).data as { title?: string; artist?: { id?: number } }[] | undefined;
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const t of top ?? []) {
      // Their own songs (not someone else's that features them), one version each.
      if (!t.title || t.artist?.id !== artist.id) continue;
      const k = songKey(t.title);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      titles.push(t.title);
    }
    return { artist: artist.name, titles, known: artist === exact[0] && (artist.nb_fan ?? 0) >= KNOWN_FANS };
  };
}

/** Fewer than this many top songs: not worth a shuffle, use the old way. */
const MIN_TOP = 5;

// --- Plex -------------------------------------------------------------------

interface PlexTrack {
  type?: string;
  title?: string;
  grandparentTitle?: string;
  originalTitle?: string;
  duration?: number;
  Media?: { Part?: { key?: string }[] }[];
}

export class PlexMusicSource implements MusicSource {
  readonly name = 'plex' as const;
  constructor(
    private readonly o: { url: string; token: string },
    private readonly f: typeof fetch = fetch,
  ) {}

  async find(query: string, signal: AbortSignal): Promise<Track | undefined> {
    const r = await this.f(`${this.o.url}/hubs/search?query=${encodeURIComponent(query)}&limit=10`, {
      headers: { Accept: 'application/json', 'X-Plex-Token': this.o.token },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (!r.ok) throw new Error(`Plex answered ${r.status}`);
    const j = (await r.json()) as { MediaContainer?: { Hub?: { type?: string; Metadata?: PlexTrack[] }[] } };
    const tracks = (j.MediaContainer?.Hub ?? []).filter((h) => h.type === 'track').flatMap((h) => h.Metadata ?? []);
    const t = tracks.find((m) => m.Media?.[0]?.Part?.[0]?.key);
    if (!t) return undefined;
    const artist = t.originalTitle || t.grandparentTitle;
    return {
      title: t.title ?? query,
      ...(artist ? { artist } : {}),
      ...(t.duration ? { durationS: Math.round(t.duration / 1000) } : {}),
      source: 'plex',
      ref: t.Media![0]!.Part![0]!.key!,
    };
  }

  /** The token goes in a header, never in a URL or a program's arguments. */
  async open(t: Track, signal: AbortSignal): Promise<{ stream: Readable }> {
    // The part path comes from Plex: it must stay on the Plex server, or the
    // token could be sent somewhere else.
    const url = new URL(t.ref, this.o.url);
    if (url.origin !== new URL(this.o.url).origin || !url.pathname.startsWith('/library/parts/')) throw new Error('not a Plex track');
    // The signal only covers getting the response: the song itself plays for
    // minutes, long after the request that started it is over.
    const ctl = new AbortController();
    const stopWaiting = () => ctl.abort();
    signal.addEventListener('abort', stopWaiting, { once: true });
    const timer = setTimeout(stopWaiting, 15_000);
    try {
      const r = await this.f(url.href, { headers: { 'X-Plex-Token': this.o.token }, signal: ctl.signal });
      if (!r.ok || !r.body) throw new Error(`Plex answered ${r.status}`);
      return { stream: Readable.fromWeb(r.body as never) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stopWaiting);
    }
  }
}

// --- decoding ----------------------------------------------------------------

export interface Decoder {
  /** 48 kHz stereo s16le. */
  readonly pcm: Readable;
  kill(): void;
}

export type DecoderFactory = (input: { url: string } | { stream: Readable }) => Decoder;

/** High-quality resampling (Plex MP3s are often 44.1 kHz), a fixed gain and a
 *  transparent peak limiter. A fixed gain keeps the song's own dynamics; a
 *  live loudness normalizer audibly pumps the volume. */
const MUSIC_FILTER = 'aresample=48000:resampler=soxr:precision=28,volume=-6dB,alimiter=limit=0.89:attack=5:release=50:level=0';

/** ffmpeg decoder (music sits a bit under speech). */
export function ffmpegDecoder(ffmpeg = 'ffmpeg'): DecoderFactory {
  return (input) => {
    // Web streams only: a URL can never make ffmpeg read a local file or use
    // another protocol (file:, concat:, subfile:...).
    const src = 'url' in input ? ['-protocol_whitelist', 'http,https,tls,tcp,crypto', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-i', input.url] : ['-i', 'pipe:0'];
    const p = spawn(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-loglevel', 'error', ...src, '-vn', '-af', MUSIC_FILTER, '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'],
      { stdio: ['stream' in input ? 'pipe' : 'ignore', 'pipe', 'ignore'] },
    );
    if ('stream' in input) {
      input.stream.pipe(p.stdin!);
      p.stdin!.on('error', () => {}); // ffmpeg exiting early closes its input
      input.stream.on('error', () => p.kill('SIGKILL'));
    }
    p.on('error', () => p.stdout!.destroy());
    return {
      pcm: p.stdout!,
      kill: () => {
        if ('stream' in input) input.stream.destroy();
        p.kill('SIGKILL');
      },
    };
  };
}

// --- the player ----------------------------------------------------------------

export interface PlayerOptions {
  sources: MusicSource[];
  output: MusicOutput;
  decode: DecoderFactory;
  log: Log;
  volume?: number;
  maxQueue?: number;
  /** When the queue runs out, keep going with similar songs (YouTube Music radio). */
  autoplay?: boolean;
  /** An artist's top songs, for artist requests and mixes (off: their top song, then radio). */
  topTracks?: TopTracks;
}

export type PlayResult = { ok: true; track: Track; queued: number } | { ok: false; message: string };

/** What someone asked for, as the model understood it. */
export type RequestKind = 'song' | 'artist' | 'album' | 'playlist' | 'vibe' | 'similar' | 'podcast' | 'video' | 'link';

export type RequestResult =
  | { ok: true; started?: Track; label?: string; added: number; artist?: string; queuedAs?: { track: Track; position: number } }
  | { ok: false; message: string };

/** Unplayable tracks in a row before giving up (like Yusic). */
/** Unplayable tracks in a row before giving up (private or removed videos). */
const MAX_FAILS = 5;
const HISTORY = 50;

export class MusicPlayer {
  private queue: Track[] = [];
  private current: { track: Track; handle: PlaybackHandle; decoder: Decoder } | undefined;
  private volume: number;
  /** Bumped on every change, so a finished track only advances its own turn. */
  private turn = 0;
  /** Played tracks, oldest first. */
  private played: Track[] = [];
  private autoplayOn: boolean;
  private refill: Promise<void> | undefined;
  /** Bumped by stop(): a refill that lands afterwards is dropped. */
  private epoch = 0;
  /** Songs in a row that ended within seconds of starting (broken streams). */
  private quickEnds = 0;
  /** Radio seeds already used, so one song doesn't seed twice. */
  private seeded = new Set<string>();

  constructor(private readonly o: PlayerOptions) {
    this.volume = o.volume ?? 0.5;
    this.autoplayOn = o.autoplay ?? true;
  }

  get nowPlaying(): Track | undefined {
    return this.current && this.o.output.musicPlaying ? this.current.track : undefined;
  }

  get upNext(): readonly Track[] {
    return this.queue;
  }

  get paused(): boolean {
    return this.o.output.musicPaused;
  }

  /** Recently played, newest first. */
  get recent(): readonly Track[] {
    return [...this.played].reverse();
  }

  get autoplay(): boolean {
    return this.autoplayOn;
  }

  setAutoplay(on: boolean): void {
    this.autoplayOn = on;
    if (on) void this.topUp();
  }

  private get yt(): YoutubeSource | undefined {
    return this.o.sources.find((s): s is YoutubeSource => s instanceof YoutubeSource);
  }

  /** Look a song up: the named source first (if any), then the others. */
  async find(query: string, signal: AbortSignal, prefer?: Track['source']): Promise<Track | undefined> {
    const order = [...this.o.sources].sort((a, b) => Number(b.name === prefer) - Number(a.name === prefer));
    for (const s of order) {
      try {
        const t = await s.find(query, signal);
        if (t) return t;
      } catch (e) {
        if (signal.aborted) throw e;
        this.o.log.warn('music search failed', { source: s.name, error: (e as Error).message });
      }
    }
    return undefined;
  }

  /** Play one song now (replacing the current song) or add it to the queue. */
  async play(query: string, mode: 'now' | 'queue', signal: AbortSignal, prefer?: Track['source']): Promise<PlayResult> {
    const q = query.trim().slice(0, 200);
    if (!q) return { ok: false, message: 'What should I play?' };
    this.o.log.info('music search', { query: q, mode, ...(prefer ? { prefer } : {}) });
    const track = await this.find(q, signal, prefer);
    if (!track) return { ok: false, message: `I couldn't find ${q}.` };
    if (mode === 'queue' && this.nowPlaying) {
      if (this.queue.length >= (this.o.maxQueue ?? 25)) return { ok: false, message: 'The queue is full.' };
      this.queue.push(track);
      this.o.log.info('music queued', { source: track.source, title: track.title, position: this.queue.length });
      return { ok: true, track, queued: this.queue.length };
    }
    this.queue = [];
    await this.start(track, signal);
    return { ok: true, track, queued: 0 };
  }

  /** Anything someone might ask to hear, by kind. */
  async request(kind: RequestKind, query: string, mode: 'now' | 'queue', signal: AbortSignal, prefer?: Track['source']): Promise<RequestResult> {
    const q = query.trim().slice(0, kind === 'link' ? 500 : 200);
    this.o.log.info('music request', { kind, query: q, mode, ...(prefer ? { prefer } : {}) });
    const yt = prefer === 'plex' ? undefined : this.yt;
    const one = async (t: Track | undefined, label?: string): Promise<RequestResult> =>
      t ? this.playList([t], mode, signal, label) : { ok: false, message: `I couldn't find ${q || 'that'}.` };
    const many = async (c: Collection | undefined, label?: string): Promise<RequestResult> =>
      c?.tracks.length ? this.playList(c.tracks, mode, signal, c.title ?? label) : { ok: false, message: `I couldn't find ${q || 'that'}.` };

    if (kind === 'similar') {
      if (!yt) return { ok: false, message: "I can only find similar songs on YouTube, and it isn't available." };
      let seed: Track | undefined;
      if (q) seed = await yt.find(q, signal);
      else seed = this.nowPlaying ?? this.recent[0];
      if (!seed?.id) return { ok: false, message: q ? `I couldn't find ${q}.` : "Nothing's been played yet, so tell me a song or artist to base it on." };
      const radio = this.fresh(await yt.radio(seed.id, signal), { skip: seed.id, replacing: mode === 'now' });
      return radio.length ? this.playList(radio, mode, signal, `songs like ${describe(seed)}`) : { ok: false, message: "I couldn't find anything similar." };
    }
    if (!q) return { ok: false, message: 'What should I play?' };
    if (!yt) {
      // Plex only (or asked for Plex): best effort as a song search.
      const r = await this.play(q, mode, signal, prefer);
      return r.ok ? { ok: true, ...(r.queued ? {} : { started: r.track }), added: r.queued ? 1 : 0 } : r;
    }
    switch (kind) {
      case 'artist': {
        // Their best-known songs, shuffled; then autoplay carries on with similar ones.
        const best = await this.topOf([q], 25, signal);
        if (best.tracks.length >= MIN_TOP) return this.artistList(best, mode, signal);
        const top = await yt.find(q, signal);
        if (!top?.id) return one(await this.find(q, signal));
        const radio = this.fresh(await yt.radio(top.id, signal).catch(() => []), { skip: top.id, replacing: mode === 'now' });
        return this.playList([top, ...radio], mode, signal, `${top.artist ?? q} radio`);
      }
      case 'album':
        return many(await yt.album(q, signal), q);
      case 'playlist':
      case 'vibe': {
        const c = await yt.playlist(q, signal);
        if (c?.tracks.length) {
          // A vibe wants songs: drop hour-long mixes when enough songs remain.
          const songs = c.tracks.filter((t) => !t.durationS || t.durationS <= MAX_SONG_S);
          return many({ ...c, tracks: kind === 'vibe' ? shuffle(songs.length >= 5 ? songs : c.tracks) : c.tracks }, q);
        }
        return one(await yt.video(`${q} mix`, signal), q);
      }
      case 'podcast': {
        const c = await yt.podcast(q, signal);
        // The newest episode that plays; the rest wait in the list.
        return c?.tracks.length ? this.playList(c.tracks.slice(0, 3), mode, signal, c.title ?? q) : one(await yt.video(`${q} podcast`, signal), q);
      }
      case 'video':
        return one(await yt.video(q, signal), q);
      case 'link': {
        const l = parseMediaLink(q);
        if (!l) return { ok: false, message: "That isn't a link I can play. YouTube, SoundCloud, Bandcamp and Spotify links work." };
        if (l.kind === 'youtube') return one(await yt.resolve(l.id, signal), 'that link');
        if (l.kind === 'youtube-list') return many(await yt.list(l.url, signal, 40), 'that playlist');
        if (l.kind === 'spotify') {
          const s = await spotifyItem(l.url, signal).catch((e: Error) => (signal.aborted ? Promise.reject(e) : undefined));
          if (!s) return { ok: false, message: "I couldn't read that Spotify link." };
          if (s.kind === 'album') return many(await yt.album(s.query, signal), s.query);
          if (s.kind === 'playlist') return many(await yt.playlist(s.query, signal), s.query);
          return one(await yt.find(s.query, signal), s.query);
        }
        const t = await yt.resolveUrl(l.url, signal);
        // SoundCloud Go+ songs only stream a 30 s preview: play the full song from YouTube.
        if (t && /\/preview\//.test(t.ref)) return one((await yt.find(`${t.title} ${t.artist ?? ''}`.trim(), signal)) ?? t, 'that link');
        return one(t, 'that link');
      }
      default: {
        const r = await this.play(q, mode, signal, prefer);
        return r.ok ? { ok: true, ...(r.queued ? {} : { started: r.track }), added: r.queued ? 1 : 0 } : r;
      }
    }
  }

  private async artistList(best: { names: string[]; tracks: Track[] }, mode: 'now' | 'queue', signal: AbortSignal): Promise<RequestResult> {
    const artist = best.names[0]!;
    const r = await this.playList(best.tracks, mode, signal, `${artist}'s top songs, shuffled`);
    return r.ok ? { ...r, artist } : r;
  }

  /** A bare "play X" (no model to say what X is): a well-known artist's name
   *  shuffles their top songs, anything else is one song. */
  async playNamed(query: string, mode: 'now' | 'queue', signal: AbortSignal, prefer?: Track['source']): Promise<RequestResult> {
    const name = query
      .trim()
      .replace(/^(?:some|a little|a bit of|more)\s+/i, '')
      .replace(/^(?:music|songs)\s+(?:by|from)\s+/i, '')
      .replace(/\s+(?:music|songs)$/i, '');
    if (!prefer && name) {
      const best = await this.topOf([name], 25, signal, true);
      if (best.tracks.length >= MIN_TOP) return this.artistList(best, mode, signal);
    }
    const r = await this.play(query, mode, signal, prefer);
    if (!r.ok) return r;
    return r.queued ? { ok: true, added: 1, queuedAs: { track: r.track, position: r.queued } } : { ok: true, started: r.track, added: 0 };
  }

  /** Several artists' top songs mixed and shuffled ("music I like"). */
  async mix(artists: string[], mode: 'now' | 'queue', signal: AbortSignal, label: string): Promise<RequestResult> {
    const names = artists.map((a) => a.trim()).filter(Boolean).slice(0, 8);
    if (!names.length) return { ok: false, message: 'Which artists?' };
    this.o.log.info('music mix', { artists: names.length, mode });
    const each = Math.max(4, Math.ceil(30 / names.length));
    const best = await this.topOf(names, each, signal);
    if (best.tracks.length) return this.playList(best.tracks.slice(0, 25), mode, signal, label);
    // No song lists: the first artist the usual way.
    return this.request('artist', names[0]!, mode, signal);
  }

  /** The named artists' top songs (up to `each` per artist), shuffled together, as tracks found when played. */
  private async topOf(artists: string[], each: number, signal: AbortSignal, knownOnly = false): Promise<{ names: string[]; tracks: Track[] }> {
    const top = this.o.topTracks;
    if (!top || !this.yt) return { names: [], tracks: [] };
    const lists = await Promise.all(
      artists.map((a) =>
        top(a, signal).catch((e: Error) => {
          if (signal.aborted) throw e;
          this.o.log.warn('top songs lookup failed', { error: e.message.slice(0, 120) });
          return undefined;
        }),
      ),
    );
    const names: string[] = [];
    const tracks: Track[] = [];
    const recent = new Set(this.played.slice(-20).map((t) => songKey(t.title)));
    for (const l of lists) {
      if (!l?.titles.length || (knownOnly && !l.known)) continue;
      names.push(l.artist);
      // Skip what just played when there's enough else.
      const fresh = l.titles.filter((t) => !recent.has(songKey(t)));
      const pick = (fresh.length >= MIN_TOP ? fresh : l.titles).slice(0, each);
      tracks.push(...pick.map((title): Track => ({ title, artist: l.artist, source: 'youtube', ref: '', query: `${title} ${l.artist}` })));
    }
    return { names, tracks: shuffle(tracks) };
  }

  /** Tracks not played lately (and not already queued, unless the queue is
   *  about to be replaced). */
  private fresh(tracks: Track[], o: { skip?: string; replacing?: boolean } = {}): Track[] {
    const queued = o.replacing ? [] : this.queue.map((t) => t.id);
    const seen = new Set([o.skip, ...this.played.map((t) => t.id), ...queued, this.current?.track.id].filter(Boolean) as string[]);
    const out: Track[] = [];
    for (const t of tracks) {
      if (!t.id || seen.has(t.id)) continue;
      if (t.durationS && t.durationS > MAX_SONG_S) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }

  /** Play a list now (first one starts, the rest queue up) or add it to the queue. */
  private async playList(tracks: Track[], mode: 'now' | 'queue', signal: AbortSignal, label?: string): Promise<RequestResult> {
    const max = this.o.maxQueue ?? 25;
    if (mode === 'queue' && this.current) {
      const add = tracks.slice(0, Math.max(0, max - this.queue.length));
      if (!add.length) return { ok: false, message: 'The queue is full.' };
      this.queue.push(...add);
      this.o.log.info('music queued', { count: add.length, ...(label ? { label } : {}) });
      return { ok: true, ...(label ? { label } : {}), added: add.length };
    }
    const list = [...tracks];
    this.queue = [];
    for (let fails = 0; list.length && fails < MAX_FAILS; fails++) {
      const t = list.shift()!;
      try {
        this.queue = list.slice(0, max);
        await this.start(t, signal);
        return { ok: true, started: t, ...(label ? { label } : {}), added: this.queue.length };
      } catch (e) {
        if (signal.aborted) throw e;
        this.o.log.warn('music track failed', { error: (e as Error).message });
      }
    }
    this.queue = [];
    return { ok: false, message: "I found it, but it wouldn't play." };
  }

  private async start(track: Track, signal?: AbortSignal): Promise<void> {
    this.stopCurrent();
    const turn = ++this.turn;
    const source = this.o.sources.find((s) => s.name === track.source)!;
    const input = await source.open(track, signal ?? AbortSignal.timeout(20_000));
    if (turn !== this.turn) {
      // Something else started meanwhile: close what was opened for this one.
      if ('stream' in input) input.stream.destroy();
      return;
    }
    const decoder = this.o.decode(input);
    const handle = this.o.output.playMusic(decoder.pcm, this.volume);
    this.current = { track, handle, decoder };
    this.played.push(track);
    if (this.played.length > HISTORY) this.played.shift();
    this.o.output.takeStats?.();
    this.o.log.info('music playing', { source: track.source, title: track.title, artist: track.artist, durationS: track.durationS });
    const startedAt = performance.now();
    void handle.done.then((outcome) => {
      if (turn !== this.turn) return;
      decoder.kill();
      this.current = undefined;
      this.o.log.info('music ended', { outcome, source: track.source, ...this.o.output.takeStats?.() });
      if (outcome === 'error') this.o.log.warn('music stream failed', { source: track.source });
      // A song that ends seconds after starting didn't really play (a dead
      // stream link): after a few in a row, stop instead of looping forever.
      const quick = performance.now() - startedAt < 3_000 && (track.durationS ?? 60) > 10;
      this.quickEnds = quick ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= MAX_FAILS) {
        this.o.log.warn('music keeps failing; stopping', { source: track.source });
        this.quickEnds = 0;
        this.queue = [];
        return;
      }
      void this.advance();
    });
    void this.topUp();
    this.prepareNext();
  }

  /** Resolve the next track while this one plays, so songs change without a wait. */
  private prepareNext(): void {
    const next = this.queue[0];
    const src = next && this.o.sources.find((s) => s.name === next.source);
    if (next && src?.prepare) void src.prepare(next, AbortSignal.timeout(30_000)).catch(() => undefined);
  }

  /** Autoplay: with fewer than 3 songs left, add similar ones (YouTube Music
   *  radio of the last song), skipping anything played lately. */
  private topUp(): Promise<void> {
    if (this.refill) return this.refill;
    const yt = this.yt;
    const seed = this.queue.at(-1) ?? this.current?.track ?? this.played.at(-1);
    if (!this.autoplayOn || !yt || this.queue.length >= 3 || !seed?.id || seed.kind === 'podcast' || this.seeded.has(seed.id)) return Promise.resolve();
    this.seeded.add(seed.id);
    const epoch = this.epoch;
    this.refill = (async () => {
      try {
        const radio = await yt.radio(seed.id!, AbortSignal.timeout(30_000));
        if (epoch !== this.epoch) return; // stopped meanwhile
        const more = this.fresh(radio).slice(0, 10);
        this.queue.push(...more.slice(0, Math.max(0, (this.o.maxQueue ?? 25) - this.queue.length)));
        if (more.length) this.o.log.info('music autoplay', { added: more.length });
        if (this.queue.length === more.length) this.prepareNext();
      } catch (e) {
        this.seeded.delete(seed.id!); // try again later
        this.o.log.warn('music autoplay failed', { error: (e as Error).message });
      } finally {
        this.refill = undefined;
      }
    })();
    return this.refill;
  }

  private async advance(fails = 0): Promise<void> {
    if (!this.queue.length) await this.topUp();
    const turn = this.turn;
    const next = this.queue.shift();
    if (!next || turn !== this.turn) return;
    try {
      await this.start(next);
    } catch (e) {
      this.o.log.warn('music next failed', { error: (e as Error).message });
      if (fails + 1 < MAX_FAILS) void this.advance(fails + 1);
    }
  }

  private stopCurrent(): void {
    const c = this.current;
    this.current = undefined;
    this.turn++;
    if (c) {
      c.handle.stop();
      c.decoder.kill();
    }
  }

  /** Skip to the next song; false if nothing was playing. */
  async skip(): Promise<Track | false | undefined> {
    if (!this.current) return false;
    this.stopCurrent();
    if (!this.queue.length) await this.topUp();
    for (let fails = 0; this.queue.length && fails < MAX_FAILS; fails++) {
      const next = this.queue.shift()!;
      try {
        await this.start(next);
        return next;
      } catch (e) {
        this.o.log.warn('music next failed', { error: (e as Error).message });
      }
    }
    return undefined;
  }

  shuffle(): number {
    this.queue = shuffle(this.queue);
    this.prepareNext();
    return this.queue.length;
  }

  clearQueue(): number {
    const n = this.queue.length;
    this.queue = [];
    return n;
  }

  pause(): boolean {
    if (!this.nowPlaying || this.paused) return false;
    this.o.output.pauseMusic();
    return true;
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.o.output.resumeMusic();
    return true;
  }

  /** Stop the music and clear the queue; false if nothing was playing. */
  stop(): boolean {
    const had = !!this.current || this.queue.length > 0;
    this.epoch++;
    this.queue = [];
    this.stopCurrent();
    return had;
  }

  /** Louder (+1) or quieter (-1); returns the new level, 0.05-1. */
  nudgeVolume(dir: 1 | -1): number {
    this.volume = Math.min(1, Math.max(0.05, Number((this.volume * (dir > 0 ? 1.4 : 0.7)).toFixed(3))));
    this.o.output.setMusicVolume(this.volume);
    return this.volume;
  }
}

function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
}

// --- model tools --------------------------------------------------------------

/** What the model needs to know to use music well (prompt lines). */
export function musicPromptLines(p: MusicPlayer): string[] {
  return [...musicRules(), musicState(p)];
}

/** How to use the music tools: the same on every request. */
export function musicRules(): string[] {
  return [
    'You can play audio in this voice call with play_music and music_control: songs, artists, albums, playlists, moods and vibes, songs similar to what was just playing, podcasts, and any YouTube video (YouTube Music, plus the household Plex library). ' +
      'Whenever anyone asks to hear anything, even vaguely ("something chill", "a playlist like that last song", "keep it going", "put on Joe Rogan"), call play_music right away with your best guess of request_type and a good search query you write yourself. ' +
      "Infer what they mean from the conversation and what's been playing. Never say you can't play something or have no music access without trying the tool first, and never say something is playing unless the tool says it started. " +
      'After it starts, say what is playing in a few words. Never sing, recite or quote song lyrics. ' +
      'An artist request shuffles their best-known songs by itself. "Play some music", "something I would like", "my music" with nothing more specific means request_type favorites (what they like); "play something you like", "your favorites" means hers (what you like). ' +
      'You have your own taste in music. Keep it consistent, let it grow, and save it with music_taste: when someone tells you what they like or hate, or you settle on what you like yourself.',
  ];
}

/** What's playing, queued and played before: changes all the time. */
export function musicState(p: MusicPlayer): string {
  const now = p.nowPlaying;
  const recent = p.recent.filter((t) => t !== now).slice(0, 5).map(describe);
  return `Music now: ${now ? `${p.paused ? 'paused' : 'playing'} ${describe(now)}` : 'nothing playing'}; ${p.upNext.length} queued; autoplay ${p.autoplay ? 'on (similar songs keep coming)' : 'off'}.${recent.length ? ` Played before: ${recent.join('; ')}.` : ''}`;
}

const KINDS: RequestKind[] = ['song', 'artist', 'album', 'playlist', 'vibe', 'similar', 'podcast', 'video', 'link'];
/** Requests answered from remembered taste. */
const TASTE_KINDS = ['favorites', 'hers'] as const;

/** `player` is the one music player, or picks the player for where a request came from. */
export function musicTools(player: MusicPlayer | ((ctx: ToolContext) => MusicPlayer | undefined), taste?: MusicTaste): Tool[] {
  const get = typeof player === 'function' ? player : () => player;
  const NONE = "Music isn't available here.";
  return [
    {
      spec: {
        name: 'play_music',
        description:
          'Play audio in the voice call. Pick request_type from what they mean: ' +
          'song (one specific song), artist (an artist: their best-known songs, shuffled, then similar ones), album, ' +
          'playlist (a named or public playlist), vibe (a mood, genre, activity or era: "chill late night", "hype gaming", "90s r&b"; write query as a playlist search like "chill late night r&b"), ' +
          'similar (songs like what is playing or was just played, including "a playlist like that song", "more like this", "keep it going"; leave query empty, or name the song or artist to base it on), ' +
          'podcast (a show or episode), video (any other YouTube audio: a long mix, rain sounds, a live stream, a specific video), ' +
          'link (a YouTube, SoundCloud, Bandcamp or Spotify link someone pasted, e.g. "play that link", "play the song Sam sent": query is the exact URL). ' +
          (taste ? 'favorites (music the person asking likes: "play some music", "something I would like", "my music"; no query), hers (music you like yourself: "play something you like"; no query). ' : '') +
          'when: now (default) starts it, next adds it to the queue.',
        parameters: {
          type: 'object',
          properties: {
            request_type: { type: 'string', enum: taste ? [...KINDS, ...TASTE_KINDS] : KINDS },
            query: { type: 'string', description: 'Search words you choose, e.g. "get lucky daft punk", "graduation kanye west", "chill late night r&b". Empty for similar-to-current.' },
            when: { type: 'string', enum: ['now', 'next'] },
            source: { type: 'string', enum: ['youtube', 'plex'], description: 'Only if they named one.' },
          },
          required: ['request_type'],
          additionalProperties: false,
        },
      },
      timeoutMs: 25_000,
      slow: true,
      acts: true,
      run: async (a, signal, ctx) => {
        const p = get(ctx);
        if (!p) return NONE;
        const mode = a.when === 'next' ? 'queue' : 'now';
        const said = (r: RequestResult) => {
          if (!r.ok) return r.message;
          const what = r.label ? ` (${r.label})` : '';
          if (r.started) return `Now playing ${describe(r.started)}${what}${r.added ? `, with ${r.added} more queued` : ''}. Tell them in a few words; don't describe or quote the song.`;
          return `Added ${r.added} to the queue${what}.`;
        };
        if (taste && (a.request_type === 'favorites' || a.request_type === 'hers')) {
          const hers = a.request_type === 'hers';
          const artists = hers ? taste.hers() : taste.top(ctx.userId);
          if (!artists.length) {
            return hers
              ? 'You have no favorites saved yet. Pick an artist you like, save it with music_taste, and play them with request_type artist.'
              : `You don't know what ${ctx.speaker} likes yet. Ask them who they like, or play something popular with request_type vibe.`;
          }
          return said(await p.mix(artists, mode, signal, hers ? 'music you like' : `music ${ctx.speaker} likes`));
        }
        const kind = KINDS.includes(a.request_type as RequestKind) ? (a.request_type as RequestKind) : 'song';
        const query = String(a.query ?? '');
        const r = await p.request(kind, query, mode, signal, a.source === 'plex' || a.source === 'youtube' ? a.source : undefined);
        // What they ask to hear is what they like. The asked-for artist, not the
        // first song's: a "similar" list or a playlist says nothing about them.
        if (r.ok) {
          const artist = kind === 'artist' ? (r.artist ?? query) : kind === 'song' || kind === 'album' || kind === 'link' ? r.started?.artist : undefined;
          if (artist) taste?.played(ctx.userId, artist);
        }
        return said(r);
      },
    },
    {
      spec: {
        name: 'music_control',
        description: 'Control the music: pause, resume, skip, stop, louder, quieter, shuffle (the queue), clear_queue, autoplay_on / autoplay_off (similar songs after the queue ends), or status (what is playing, queued, and was played).',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['pause', 'resume', 'skip', 'stop', 'louder', 'quieter', 'shuffle', 'clear_queue', 'autoplay_on', 'autoplay_off', 'status'] } },
          required: ['action'],
          additionalProperties: false,
        },
      },
      timeoutMs: 25_000,
      acts: (a) => a.action !== 'status',
      run: async (a, _signal, ctx) => {
        const p = get(ctx);
        if (!p) return NONE;
        switch (a.action) {
          case 'pause':
            return p.pause() ? 'Paused.' : 'Nothing is playing.';
          case 'resume':
            return p.resume() ? 'Resumed.' : 'Nothing is paused.';
          case 'skip': {
            const n = await p.skip();
            return n === false ? 'Nothing is playing.' : n ? `Skipped. Now playing ${describe(n)}.` : 'Skipped. Nothing else is queued.';
          }
          case 'stop':
            return p.stop() ? 'Music stopped.' : 'Nothing is playing.';
          case 'louder':
          case 'quieter':
            return `Music volume ${Math.round(p.nudgeVolume(a.action === 'louder' ? 1 : -1) * 100)}%.`;
          case 'shuffle':
            return `Shuffled ${p.shuffle()} songs.`;
          case 'clear_queue':
            return `Cleared ${p.clearQueue()} songs from the queue.`;
          case 'autoplay_on':
          case 'autoplay_off':
            p.setAutoplay(a.action === 'autoplay_on');
            return `Autoplay ${p.autoplay ? 'on' : 'off'}.`;
          default: {
            const n = p.nowPlaying;
            const q = p.upNext.slice(0, 5).map(describe);
            const r = p.recent.filter((t) => t !== n).slice(0, 3).map(describe);
            return `${n ? `${p.paused ? 'Paused' : 'Playing'}: ${describe(n)}.` : 'Nothing is playing.'}${q.length ? ` Up next: ${q.join('; ')}${p.upNext.length > 5 ? ` and ${p.upNext.length - 5} more` : ''}.` : ''}${r.length ? ` Played before: ${r.join('; ')}.` : ''} Autoplay ${p.autoplay ? 'on' : 'off'}.`;
          }
        }
      },
    },
  ];
}
