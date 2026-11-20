// Song requests against real YouTube, judged against answers written down
// before running (bench/music-corpus.json). Nothing is played: the first
// seconds of each stream are decoded by ffmpeg and thrown away.
//
//   node bench/music-corpus.mjs --ytdlp <yt-dlp> [--dist dist] [--out run.json]
//        [--only <regex>] [--gap 2500] [--no-audio] [--record cache.json | --replay cache.json]
//
// --record keeps every search answer; --replay answers from it (no network for
// what it has, resolves included, and no audio), for trying matching changes
// without asking YouTube again. Counts: `yt` is every request to YouTube
// (YouTube Music searches and yt-dlp runs), `deezer` its artist lookups.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const dist = resolve(opt('dist', join(here, '..', 'dist')));
const ytdlp = opt('ytdlp');
if (!ytdlp) throw new Error('--ytdlp <path> is required');
const only = opt('only') && new RegExp(opt('only'), 'i');
const gap = Number(opt('gap', 2500));
const recordTo = opt('record');
const replayFrom = opt('replay');
const audio = !flag('no-audio') && !replayFrom;
const out = opt('out');

const music = await import(pathUrl(join(dist, 'features', 'music.js')));
const { classifyMusic } = await import(pathUrl(join(dist, 'conversation', 'intents.js')));
function pathUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

const corpus = JSON.parse(readFileSync(join(here, 'music-corpus.json'), 'utf8')).requests.filter((r) => (!only || only.test(r.say) || only.test(r.class)) && (!flag('paired') || r.paired));
if (flag('routes')) {
  // Where each request goes, without asking anything.
  for (const r of corpus) {
    const m = classifyMusic(r.say);
    console.log(`${(m?.kind === 'play' ? `local "${m.query}"` : r.model ? `model ${r.model.kind} "${r.model.query}"` : 'NONE').padEnd(56)} ${r.say}`);
  }
  process.exit(0);
}

// --- counting and replay ------------------------------------------------------
const cache = replayFrom ? JSON.parse(readFileSync(replayFrom, 'utf8')) : {};
/** A replay never asks the network: what it doesn't have fails. */
class ReplayMiss extends Error {}
let count = { yt: 0, ytm: 0, ytdlp: 0, deezer: 0, web: 0, missed: 0 };
const kinds = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const host = new URL(u).hostname;
  let body = '';
  if (host.endsWith('youtube.com')) {
    count.yt++;
    count.ytm++;
    const b = JSON.parse(init?.body ?? '{}');
    body = `${b.query ?? ''}|${b.params ?? ''}`;
    kinds.push(`${host.startsWith('music') ? 'ytm' : 'web'}:${b.query}`);
  } else if (host === 'api.deezer.com') count.deezer++;
  else count.web++;
  const key = `fetch ${u} ${body}`;
  if (replayFrom) {
    const hit = cache[key];
    if (hit) return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
    count.missed++;
    throw new ReplayMiss(`not recorded: ${key.slice(0, 120)}`);
  }
  const r = await realFetch(url, init);
  if (recordTo) {
    const text = await r.clone().text();
    if (r.ok) cache[key] = { status: r.status, body: text };
  }
  return r;
};

const runKey = (a, target) => `run ${target} ${a.join(' ').includes('%(url)s') ? 'url' : 'flat'} ${a[a.indexOf('--print') + 1] ?? ''}`;
const live = music.runProgram;
/** Every yt-dlp run goes through here (when the build takes a runner). A run
 *  started ahead (its address comes on stdin) counts once it has one: until
 *  then it hasn't asked YouTube anything. */
const run = async (cmd, a, signal, enough, input) => {
  let target = input ? undefined : a.at(-1);
  const counted = (t) => {
    count.yt++;
    count.ytdlp++;
    kinds.push(`ytdlp:${input ? 'early:' : ''}${t.replace(/^https:\/\/(www|music)\.youtube\.com\//, '')}`);
  };
  if (input)
    input = input.then((u) => {
      target = u?.trim();
      if (target) counted(target);
      return u;
    });
  else counted(target);
  if (replayFrom) {
    if (input) await input;
    if (!target) throw new Error('dropped');
    const key = runKey(a, target);
    if (cache[key] !== undefined) return cache[key];
    count.missed++;
    throw new ReplayMiss(`not recorded: ${key.slice(0, 120)}`);
  }
  const o = await live(cmd, a, signal, enough, input);
  if (recordTo && target) cache[runKey(a, target)] = o;
  return o;
};

// --- a mixer that only listens ----------------------------------------------------
let firstAudio;
let onAudio;
const output = {
  playing: false,
  playMusic(stream) {
    this.playing = true;
    let stop;
    const done = new Promise((r) => (stop = r));
    let bytes = 0;
    stream.on('data', (b) => {
      bytes += b.length;
      if (!firstAudio && b.some((x) => x !== 0)) {
        firstAudio = performance.now();
        onAudio?.();
      }
    });
    stream.on('end', () => stop('finished'));
    stream.on('error', () => stop('error'));
    return {
      done: done.then((x) => ((this.playing = false), x)),
      stop: () => {
        stream.destroy();
        stop('stopped');
      },
    };
  },
  pauseMusic() {},
  resumeMusic() {},
  setMusicVolume() {},
  get musicPlaying() {
    return this.playing;
  },
  get musicPaused() {
    return false;
  },
};

/** Replay: no stream to open. A moment of sound stands in, then nothing. */
const silentDecoder = () => {
  const pcm = new Readable({ read() {} });
  pcm.push(Buffer.alloc(3840, 1));
  return { pcm, kill: () => pcm.destroy() };
};

/** The real decoder's arguments. An ffmpeg built without soxr (Windows
 *  "essentials" builds) gets ffmpeg's own resampler instead. */
const decoder = (ffmpeg) => {
  const soxr = /--enable-libsoxr/.test(spawnSync(ffmpeg, ['-hide_banner', '-buildconf'], { encoding: 'utf8' }).stdout ?? '');
  return (input) => {
    const a = music.decoderArgs(input).map((x) => (soxr ? x : x.replace(':resampler=soxr:precision=28', '')));
    const p = spawn(ffmpeg, a, { stdio: ['ignore', 'pipe', 'ignore'] });
    p.on('error', () => p.stdout.destroy());
    return { pcm: p.stdout, kill: () => p.kill('SIGKILL') };
  };
};

let logs = [];
const log = { info: (m, f) => logs.push({ m, ...f }), warn: (m, f) => logs.push({ warn: true, m, ...f }) };

// startEarly: what production gets with the real yt-dlp (this runner only counts and records).
const yt = new music.YoutubeSource({ ytdlp, node: process.execPath, searchApi: music.YTM_API, startEarly: true }, run);
let urlAt;
const open = yt.open.bind(yt);
yt.open = async (t, s) => {
  const r = await open(t, s);
  urlAt ??= performance.now();
  return r;
};
const player = new music.MusicPlayer({
  sources: [yt],
  output,
  decode: audio ? decoder(opt('ffmpeg', 'ffmpeg')) : silentDecoder,
  log,
  autoplay: false,
  topTracks: music.deezerTopTracks(),
});
// Songs after the first aren't looked up ahead: the run is about the first one.
player.prepareNext = () => {};

// --- judging ------------------------------------------------------------------------
const REMAKE = /\b(karaoke|cover|instrumental|nightcore|sped[\s-]*up|slowed|reverb|8d|live|remix|acoustic|tiny desk|open mic)\b/i;
const rx = (s) => new RegExp(s, 'i');
function judgeOne(e, r, t) {
  if (!r.ok || !t) return false;
  const full = `${t.fullTitle ?? ''} ${t.title ?? ''}`;
  const who = `${t.artist ?? ''} ${t.fullTitle ?? ''}`;
  if (e.label) {
    const many = (r.added ?? 0) >= 4 || (t.durationS ?? 0) >= 20 * 60;
    const named = `${r.artist ? '' : (r.label ?? '')} ${full}`;
    return many && rx(e.label).test(named) && (!e.artist || rx(e.artist).test(`${who} ${r.label ?? ''}`));
  }
  if (e.title && !rx(e.title).test(full)) return false;
  if (e.artist && !rx(e.artist).test(who)) return false;
  return e.version ? rx(e.version).test(full) : !REMAKE.test(t.fullTitle ?? t.title);
}
const judge = (item, r, t) => [item.expect, ...(item.alt ?? [])].some((e) => judgeOne(e, r, t));

// --- the run --------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
for (const [n, item] of corpus.entries()) {
  if (n && !replayFrom) await sleep(gap);
  count = { yt: 0, ytm: 0, ytdlp: 0, deezer: 0, web: 0, missed: 0 };
  kinds.length = 0;
  logs = [];
  firstAudio = urlAt = undefined;
  const m = classifyMusic(item.say);
  const route = m?.kind === 'play' ? 'local' : item.model ? 'model' : 'none';
  const t0 = performance.now();
  let r;
  let error;
  const heard = new Promise((res) => (onAudio = res));
  const ctl = new AbortController();
  try {
    const signal = AbortSignal.any([ctl.signal, AbortSignal.timeout(30_000)]);
    r = route === 'local' ? await player.playNamed(m.query, 'now', signal) : route === 'model' ? await player.request(item.model.kind, item.model.query, 'now', signal) : { ok: false, message: 'not a music request' };
    if (r.ok && audio) await Promise.race([heard, sleep(15_000)]);
  } catch (e) {
    error = e.message;
    r = { ok: false, message: e.message };
  }
  const doneAt = performance.now();
  player.stop();
  ctl.abort();
  const t = r.ok ? r.started : undefined;
  const hit = judge(item, r, t);
  const ms = (x) => (x === undefined ? undefined : Math.round(x - t0));
  const timing = logs.find((l) => l.m === 'music timing');
  const row = {
    class: item.class,
    say: item.say,
    route,
    query: route === 'local' ? m.query : item.model?.query,
    hit,
    id: t?.id,
    got: t ? `${t.fullTitle ?? t.title} | ${t.artist ?? '-'} | ${t.durationS ?? '?'}s` : (r.message ?? error),
    label: r.label,
    urlMs: ms(urlAt),
    audioMs: ms(firstAudio),
    totalMs: ms(doneAt),
    ...count,
    calls: [...kinds],
    timing: timing && { via: timing.via, searchMs: timing.searchMs, resolveMs: timing.resolveMs, pcmMs: timing.pcmMs, deezerMs: timing.deezerMs },
    matched: logs.filter((l) => l.m === 'music matched').map(({ m: _m, ...f }) => f),
    warns: logs.filter((l) => l.warn).map((l) => `${l.m} ${l.error ?? ''}`.trim()),
  };
  if (logs.some((l) => l.m === 'youtube paused') || /paused after a bot check/.test(error ?? '')) {
    console.log('YouTube asked for a bot check: stopping the run, this row is not scored.');
    break;
  }
  results.push(row);
  if (out) appendFileSync(`${out}l`, `${JSON.stringify(row)}
`);
  console.log(`${hit ? 'HIT ' : 'MISS'} ${String(row.urlMs ?? '-').padStart(5)}ms ${String(row.audioMs ?? '-').padStart(5)}ms yt=${row.yt} ${item.say.padEnd(48).slice(0, 48)} → ${row.got}`);
  await sleep(50);
}

const pct = (xs, p) => {
  const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : undefined;
};
const sum = (k) => results.reduce((a, r) => a + (r[k] ?? 0), 0);
const summary = {
  dist,
  at: new Date().toISOString(),
  replay: !!replayFrom,
  hits: results.filter((r) => r.hit).length,
  n: results.length,
  urlMedian: pct(results.map((r) => r.urlMs), 50),
  urlP90: pct(results.map((r) => r.urlMs), 90),
  audioMedian: pct(results.map((r) => r.audioMs), 50),
  audioP90: pct(results.map((r) => r.audioMs), 90),
  ytPerRequest: +(sum('yt') / results.length).toFixed(2),
  ytTotal: sum('yt'),
  deezerTotal: sum('deezer'),
  missed: sum('missed'),
};
console.log(JSON.stringify(summary));
if (out) writeFileSync(out, JSON.stringify({ summary, results }, null, 1));
if (recordTo) writeFileSync(recordTo, JSON.stringify(cache));
process.exit(0);
