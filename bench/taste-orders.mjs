// Music requests through the real model: does "play some music" mean the
// person's own taste, does an artist get the artist request, does she save
// opinions? Plus the live artist lookup: Deezer's ranking found on YouTube Music.
//   node bench/taste-orders.mjs <bot.json> [yt-dlp path]
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import * as music from '../dist/features/music.js';
import { MusicTaste } from '../dist/features/taste.js';

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

const CASES = [
  ['play some music', 'play_music', { request_type: 'favorites' }],
  ['put something on that I would like', 'play_music', { request_type: 'favorites' }],
  ['play my music', 'play_music', { request_type: 'favorites' }],
  ['play something you like', 'play_music', { request_type: 'hers' }],
  ['play your favorite music', 'play_music', { request_type: 'hers' }],
  ['play some Frank Ocean', 'play_music', { request_type: 'artist' }],
  ['put on Kendrick', 'play_music', { request_type: 'artist' }],
  ['play Nights by Frank Ocean', 'play_music', { request_type: 'song' }],
  ['play something chill for late night', 'play_music', { request_type: 'vibe' }],
  ['I love Radiohead by the way', 'music_taste', { who: 'them', what: 'like' }],
  ['I can\'t stand country music, don\'t ever play that', 'music_taste', { who: 'them', what: 'dislike' }],
];

let good = 0;
for (const [text, want, args] of CASES) {
  const calls = [];
  const taste = new MusicTaste(undefined);
  for (const a of ['Frank Ocean', 'SZA', 'Tyler, The Creator']) taste.played('u', a);
  await taste.tools()[0].run({ who: 'you', what: 'like', name: 'Portishead' }, AbortSignal.timeout(1000), { userId: 'u', speaker: 'Sam' });
  const stub = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'nowPlaying') return undefined;
      if (k === 'upNext' || k === 'recent') return [];
      if (k === 'paused') return false;
      if (k === 'autoplay') return true;
      return async () => ({ ok: true, started: { title: 'Nights', artist: 'Frank Ocean', source: 'youtube', ref: '' }, added: 3 });
    },
  });
  const spy = (t) => ({ ...t, run: (a, sig, ctx) => (calls.push({ name: t.spec.name, args: a }), t.run(a, sig, ctx)) });
  const tools = [...music.musicTools(stub, taste), ...taste.tools()].map(spy);
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 3_600_000), tools, {
    spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
    stablePrefix: true,
    stableLines: music.musicRules(),
    context: () => [music.musicState(stub), ...taste.context('u', 'Sam')],
  });
  let said = '';
  for await (const chunk of o.ask('u', 'Sam', text, AbortSignal.timeout(30_000))) said += `${chunk} `;
  const hit = calls.find((x) => x.name === want && Object.entries(args).every(([k, v]) => x.args[k] === v));
  if (hit) good++;
  console.log(hit ? 'PASS' : 'FAIL', JSON.stringify(text), JSON.stringify(calls), JSON.stringify(said.trim().slice(0, 90)));
}
console.log(`model: ${good}/${CASES.length}`);

const top = music.deezerTopTracks();
for (const name of ['drake', 'tame impala', 'queen', 'get lucky', 'the weeknd']) {
  const t0 = performance.now();
  const r = await top(name, AbortSignal.timeout(8000));
  console.log(name, '->', r?.artist, `known=${r?.known}`, `${r?.titles.length} songs`, `${Math.round(performance.now() - t0)} ms:`, r?.titles.slice(0, 5).join(' | '));
}
if (process.argv[3]) {
  const yt = new music.YoutubeSource({ ytdlp: process.argv[3], node: process.execPath });
  const r = await top('tame impala', AbortSignal.timeout(8000));
  for (const title of r.titles.slice(0, 3)) {
    const t = { title, artist: r.artist, source: 'youtube', ref: '', query: `${title} ${r.artist}` };
    const t0 = performance.now();
    await yt.prepare(t, AbortSignal.timeout(25_000));
    console.log('found', title, '->', t.id, `${t.durationS}s`, `${Math.round(performance.now() - t0)} ms`);
  }
}
