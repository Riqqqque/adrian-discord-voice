// Real YouTube → ffmpeg → mixer check, with a "voice" in the middle.
//   node bench/music-check.mjs <yt-dlp> "<query>" [out.wav]
import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { integratedLoudness } from '../dist/audio/loudness.js';
import { ffmpegDecoder, MusicPlayer, YoutubeSource } from '../dist/features/music.js';
import { Mixer } from '../dist/voice/mixer.js';

const [ytdlp, query = 'daft punk get lucky', out] = process.argv.slice(2);
const chunks = [];
let firstSoundAt = 0;
const t0 = performance.now();
const mixer = new Mixer({
  start: (s) => {
    s.on('data', (b) => {
      chunks.push(b);
      if (!firstSoundAt && b.some((x) => x !== 0)) firstSoundAt = performance.now();
    });
    return { done: new Promise(() => {}), stop: () => {} };
  },
  duckLevel: 0.2,
});
const log = { info: (m, f) => console.log(`  ${m}`, f ?? ''), warn: (m, f) => console.log(`  WARN ${m}`, f ?? '') };
const player = new MusicPlayer({ sources: [new YoutubeSource({ ytdlp, node: process.execPath })], output: mixer, decode: ffmpegDecoder(), log, volume: 0.5 });

const r = await player.play(query, 'now', AbortSignal.timeout(30_000));
console.log(r.ok ? `found: ${r.track.title} | ${r.track.artist} | ${r.track.durationS}s (${Math.round(performance.now() - t0)} ms)` : r.message);
if (!r.ok) process.exit(1);

// A 2 s "voice" (220 Hz tone, about speech level) at 6 s.
await new Promise((res) => setTimeout(res, 6_000));
const tone = Buffer.alloc(48_000 * 2 * 4);
for (let i = 0; i < 96_000; i++) {
  const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / 48_000) * 7000);
  tone.writeInt16LE(v, i * 4);
  tone.writeInt16LE(v, i * 4 + 2);
}
const speech = new PassThrough();
const h = mixer.playPcm(speech, { volume: 1 });
speech.end(tone);
console.log(`voice done: ${await h.done}`);
await new Promise((res) => setTimeout(res, 4_000));
player.stop();
mixer.stopAll();

const all = Buffer.concat(chunks);
const left = (a, b) => {
  const s = all.subarray(Math.round(a * 48_000) * 4, Math.round(b * 48_000) * 4);
  const f = new Float32Array(s.length / 4);
  for (let i = 0; i < f.length; i++) f[i] = s.readInt16LE(i * 4) / 32768;
  return integratedLoudness(f, 48_000);
};
const startS = (firstSoundAt - t0) / 1000;
console.log(`first music after ${startS.toFixed(2)} s; ${(all.length / 192_000).toFixed(1)} s mixed`);
const rel = (x) => Math.max(0, x - (all.length / 192_000 - (performance.now() - t0) / 1000));
console.log(`music alone (one channel): ${left(rel(startS + 1), rel(6)).toFixed(1)} LUFS; under the voice it drops ~14 dB`);
console.log(`rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
if (out) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + all.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(48_000, 24); hdr.writeUInt32LE(192_000, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(all.length, 40);
  writeFileSync(out, Buffer.concat([hdr, all]));
}
process.exit(0);
