// Every request type against real YouTube: what starts and what gets queued.
// Audio isn't decoded (the output is a stub).
//   node bench/music-kinds.mjs <yt-dlp>
import { MusicPlayer, YoutubeSource, describe } from '../dist/features/music.js';

const [ytdlp] = process.argv.slice(2);
const ends = [];
const out = {
  playMusic: () => {
    let end;
    const done = new Promise((r) => (end = r));
    ends.push(end);
    return { done, stop: () => end('stopped') };
  },
  pauseMusic() {},
  resumeMusic() {},
  setMusicVolume() {},
  musicPlaying: true,
  musicPaused: false,
};
const log = { info() {}, warn: (m, f) => console.log(`   WARN ${m}`, f ?? '') };
const p = new MusicPlayer({ sources: [new YoutubeSource({ ytdlp, node: process.execPath })], output: out, decode: () => ({ pcm: { on() {}, pipe() {} }, kill() {} }), log });

const asks = [
  ['song', 'round 2 jaeybxrd'],
  ['similar', ''],
  ['artist', 'travis scott'],
  ['album', 'graduation kanye west'],
  ['vibe', 'chill late night r&b'],
  ['vibe', 'hype gaming'],
  ['playlist', 'today\'s top hits'],
  ['podcast', 'joe rogan experience'],
  ['video', 'rain sounds 10 hours'],
];
for (const [kind, q] of asks) {
  const t0 = performance.now();
  const r = await p.request(kind, q, 'now', AbortSignal.timeout(60_000));
  const s = ((performance.now() - t0) / 1000).toFixed(1);
  const next = p.upNext.slice(0, 3).map((t) => t.title).join(' / ');
  console.log(`${kind.padEnd(8)} ${JSON.stringify(q).padEnd(26)} ${s}s  ${r.ok ? `${r.started ? describe(r.started) : '-'}${r.label ? ` [${r.label}]` : ''} | ${p.upNext.length} queued: ${next}` : `FAIL ${r.message}`}`);
}
await new Promise((res) => setTimeout(res, 4000)); // let autoplay finish
console.log(`after autoplay: ${p.upNext.length} queued`);
p.stop();
process.exit(0);
