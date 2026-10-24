// Real links through the real tools: what each pasted link would play.
//   node bench/link-check.mjs <yt-dlp>
import { parseMediaLink, spotifyItem } from '../dist/features/links.js';
import { YoutubeSource } from '../dist/features/music.js';

const yt = new YoutubeSource({ ytdlp: process.argv[2], node: process.execPath });
const LINKS = [
  'https://youtu.be/fHI8X4OXluQ',
  'https://www.youtube.com/watch?v=4NRXx6U8ABQ&t=12s',
  'https://music.youtube.com/watch?v=4NRXx6U8ABQ',
  'https://soundcloud.com/octobersveryown/drake-gods-plan',
  'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
  'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj',
];
for (const url of LINKS) {
  const t0 = performance.now();
  const sig = AbortSignal.timeout(30_000);
  const l = parseMediaLink(url);
  let what;
  try {
    if (l.kind === 'youtube') what = await yt.resolve(l.id, sig);
    else if (l.kind === 'spotify') {
      const s = await spotifyItem(l.url, sig);
      what = s.kind === 'album' ? { title: `album "${(await yt.album(s.query, sig))?.title}"`, artist: s.query } : await yt.find(s.query, sig);
    } else what = await yt.resolveUrl(l.url, sig);
  } catch (e) {
    what = { title: `ERROR ${e.message.slice(0, 120)}` };
  }
  console.log(`${l.kind.padEnd(10)} ${String(Math.round(performance.now() - t0)).padStart(5)} ms  ${what?.title ?? 'nothing'}${what?.artist ? ` - ${what.artist}` : ''}${what?.ref ? '  (stream ok)' : ''}`);
}
