// What YouTube search picks for a set of requests (no audio played).
//   node bench/music-search.mjs <yt-dlp> ["query" ...]
import { YoutubeSource } from '../dist/features/music.js';

const [ytdlp, ...given] = process.argv.slice(2);
const queries = given.length
  ? given
  : ['get lucky', 'humble kendrick lamar', 'blinding lights', 'sicko mode', 'bohemian rhapsody', 'lose yourself eminem', 'mr brightside', 'chill lofi beats', 'drake', 'nightcall kavinsky'];
const yt = new YoutubeSource({ ytdlp, node: process.execPath });
for (const q of queries) {
  const t0 = performance.now();
  try {
    const t = await yt.find(q, AbortSignal.timeout(30_000));
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`${q.padEnd(24)} ${s}s  ${t ? `${t.title} | ${t.artist ?? '-'} | ${t.durationS ?? 'live/NA'}s` : 'NOTHING'}`);
  } catch (e) {
    console.log(`${q.padEnd(24)} ERROR ${e.message}`);
  }
}
