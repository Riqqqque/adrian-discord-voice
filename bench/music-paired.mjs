// The paired run: the corpus's `paired` requests, each asked of two builds
// back to back (which goes first alternates), so network and machine drift
// fall on both alike. Rows land in <out>-a.jsonl and <out>-b.jsonl.
//
//   node bench/music-paired.mjs --ytdlp <yt-dlp> --a <dist> --b <dist> --out <prefix> [--gap 2500]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? d : args[i + 1];
};
const [ytdlp, a, b, out] = ['ytdlp', 'a', 'b', 'out'].map((k) => opt(k));
if (!ytdlp || !a || !b || !out) throw new Error('--ytdlp, --a, --b and --out are required');
const gap = Number(opt('gap', 2500));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const paired = JSON.parse(readFileSync(join(here, 'music-corpus.json'), 'utf8')).requests.filter((r) => r.paired);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [i, item] of paired.entries()) {
  const order = i % 2 ? [['b', b], ['a', a]] : [['a', a], ['b', b]];
  for (const [name, dist] of order) {
    if (i || name !== order[0][0]) await sleep(gap);
    const r = spawnSync(process.execPath, [join(here, 'music-corpus.mjs'), '--ytdlp', ytdlp, '--dist', dist, '--only', `^${escape(item.say)}$`, '--out', `${out}-${name}.json`], { encoding: 'utf8' });
    const line = r.stdout.split('\n').find((l) => /^(HIT|MISS)/.test(l)) ?? r.stdout.trim().split('\n').at(-1);
    console.log(`${name} ${line}`);
    if (/bot check/.test(r.stdout)) process.exit(1);
  }
}
