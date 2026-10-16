// Music through the mixer into a consumer that behaves like Discord's player
// (one 20 ms frame per cycle, catching up after a late cycle), while the
// event loop is blocked now and then. Counts frames the player found missing.
//   node bench/mixer-stall.mjs <mixer.js> <music.js> <yt-dlp> [seconds]
const [mixerPath, musicPath, ytdlp, secs = '20'] = process.argv.slice(2);
const { Mixer } = await import(mixerPath);
const { ffmpegDecoder, MusicPlayer, YoutubeSource } = await import(musicPath);

const FRAME = 3840;
let missed = 0;
let played = 0;
let started = false;
const mixer = new Mixer({
  start: (stream) => {
    // Player: wants a frame every 20 ms; late cycles run back to back.
    let next = performance.now() + 20;
    const t = setInterval(() => {
      while (performance.now() >= next) {
        const f = stream.read(FRAME);
        if (f) {
          played++;
          started = true;
        } else if (started) missed++;
        next += 20;
      }
    }, 5);
    stream.on('end', () => clearInterval(t));
    return { done: new Promise(() => {}), stop: () => clearInterval(t) };
  },
});
const log = { info() {}, warn: (m, f) => console.log('WARN', m, f ?? '') };
const player = new MusicPlayer({ sources: [new YoutubeSource({ ytdlp, node: process.execPath })], output: mixer, decode: ffmpegDecoder(), log, volume: 0.5 });
const r = await player.play('daft punk get lucky', 'now', AbortSignal.timeout(30_000));
if (!r.ok) throw new Error(r.message);

// Block the event loop 80-150 ms every 1.5-2.5 s (ASR, TTS buffers, GC).
let stalls = 0;
const stall = setInterval(() => {
  const until = performance.now() + 80 + Math.random() * 70;
  while (performance.now() < until);
  stalls++;
}, 1500 + Math.random() * 1000);
await new Promise((res) => setTimeout(res, Number(secs) * 1000));
clearInterval(stall);
player.stop();
mixer.stopAll();
console.log(`stalls ${stalls}, frames played ${played}, missing ${missed} (${((missed / Math.max(1, played + missed)) * 100).toFixed(1)}%)`);
process.exit(0);
