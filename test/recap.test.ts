import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PocConfigSchema } from '../src/config.js';
import type { Sources } from '../src/features/digest.js';
import { Recap, slotAtOrBefore, weekOf, weekdayIndex, type RecapDeps } from '../src/features/recap.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TZ = 'America/Denver';
const OWNER = '123456789012345678';
const FAN = '223456789012345678';
/** 18:00 local on a date in Denver, as epoch ms. */
const denver = (ymd: string, hour = 18) => {
  const d = new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00Z`).getTime();
  // MDT (UTC-6) until 2026-11-01 02:00, MST (UTC-7) after; MDT again from 2027-03-14.
  const mst = ymd >= '2026-11-01' && ymd < '2027-03-14';
  return d + (mst ? 7 : 6) * HOUR;
};

function setup(o: { file?: string; start?: number; post?: (c: string) => Promise<void>; media?: Partial<Sources> } = {}) {
  const clock = { t: o.start ?? denver('2026-11-02', 12) };
  const posts: string[] = [];
  const deps: RecapDeps = {
    sources: { media: { timezone: TZ }, servers: [], ping: async () => ({ online: true }), ...o.media },
    post: o.post ?? (async (c) => void posts.push(c)),
    nameOf: (id) => (id === FAN ? 'Alex' : 'Sam'),
    named: (id) => id === FAN,
    isOwner: (id) => id === OWNER,
    now: () => clock.t,
  };
  const r = new Recap(o.file, { enabled: true, timezone: TZ, day: weekdayIndex('sunday'), hour: 18 }, deps);
  return { r, clock, posts };
}

describe('recap schedule', () => {
  it('finds the last Sunday 18:00 in the household time zone', () => {
    // Wednesday 2026-11-04: last Sunday was 2026-11-01 (MST since that morning).
    expect(slotAtOrBefore(denver('2026-11-04', 9), TZ, 0, 18)).toEqual({ at: denver('2026-11-01'), key: '2026-11-01' });
    // Sunday before 18:00: the week before.
    expect(slotAtOrBefore(denver('2026-11-08', 17), TZ, 0, 18).key).toBe('2026-11-01');
    expect(slotAtOrBefore(denver('2026-11-08', 18), TZ, 0, 18).key).toBe('2026-11-08');
  });

  it('stays at 18:00 local across both DST changes', () => {
    const fall = [slotAtOrBefore(denver('2026-10-25', 19), TZ, 0, 18).at, slotAtOrBefore(denver('2026-11-01', 19), TZ, 0, 18).at];
    expect(new Date(fall[0]!).toISOString()).toBe('2026-10-26T00:00:00.000Z'); // 18:00 MDT
    expect(new Date(fall[1]!).toISOString()).toBe('2026-11-02T01:00:00.000Z'); // 18:00 MST
    expect((fall[1]! - fall[0]!) / HOUR).toBe(169);
    const spring = [slotAtOrBefore(denver('2027-03-07', 19), TZ, 0, 18).at, slotAtOrBefore(denver('2027-03-14', 19), TZ, 0, 18).at];
    expect((spring[1]! - spring[0]!) / HOUR).toBe(167);
  });

  it('files what happens in a week under the recap that covers it', () => {
    expect(weekOf(denver('2026-11-04', 9), TZ, 0, 18)).toBe('2026-11-08');
    expect(weekOf(denver('2026-11-08', 17), TZ, 0, 18)).toBe('2026-11-08');
    expect(weekOf(denver('2026-11-08', 18), TZ, 0, 18)).toBe('2026-11-15');
  });

  it('works for other days and hours', () => {
    expect(slotAtOrBefore(Date.UTC(2026, 10, 8, 12), 'UTC', weekdayIndex('friday'), 9).key).toBe('2026-11-06');
    expect(slotAtOrBefore(Date.UTC(2026, 10, 6, 9), 'UTC', weekdayIndex('friday'), 9).key).toBe('2026-11-06');
  });
});

describe('weekly recap', () => {
  it('posts once at the hour, never twice, and survives a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'recap-')), 'weekly-recap.json');
    const t = setup({ file });
    t.r.played('Song A', 'Artist');
    t.r.played('Song A', 'Artist');
    t.r.played('Song B');
    t.r.answered('call', OWNER);
    t.clock.t = denver('2026-11-08', 17);
    expect(await t.r.tick()).toBe('not due');
    t.clock.t = denver('2026-11-08', 18) + 60_000;
    expect(await t.r.tick()).toBe('posted');
    expect(await t.r.tick()).toBe('not due');
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toContain('**Weekly recap** (Nov 1 to Nov 8)');
    expect(t.posts[0]).toContain('Most played in the call: Song A by Artist (2), Song B (1)');
    expect(t.posts[0]).toContain('Questions answered: 1');
    t.r.flush();
    // Restarted later the same evening: already posted.
    const again = setup({ file, start: denver('2026-11-08', 20) });
    expect(await again.r.tick()).toBe('not due');
    expect(again.posts).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).lastPosted).toBe('2026-11-08');
  });

  it('posts a missed week once when back within a day, with that week\'s numbers', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'recap-')), 'weekly-recap.json');
    const t = setup({ file, start: denver('2026-11-07', 12) });
    t.r.played('Last Week Song');
    t.r.flush();
    // Down over Sunday 18:00, back Monday 09:00 (15 hours late).
    const back = setup({ file, start: denver('2026-11-09', 9) });
    back.r.played('This Week Song');
    expect(await back.r.tick()).toBe('posted');
    expect(back.posts[0]).toContain('Last Week Song');
    expect(back.posts[0]).not.toContain('This Week Song');
    expect(await back.r.tick()).toBe('not due');
  });

  it('skips a week missed by more than a day', async () => {
    const t = setup({ start: denver('2026-11-07', 12) });
    t.r.played('Song');
    t.clock.t = denver('2026-11-09', 19);
    expect(await t.r.tick()).toBe('not due');
    expect(t.posts).toHaveLength(0);
  });

  it('retries a failed post after 10 minutes, and only while it is still that day', async () => {
    let fail = true;
    const posts: string[] = [];
    const t = setup({ post: async (c) => (fail ? Promise.reject(new Error('Missing Access')) : void posts.push(c)) });
    t.r.played('Song');
    t.clock.t = denver('2026-11-08', 18);
    expect(await t.r.tick()).toBe('failed');
    t.clock.t += 60_000;
    expect(await t.r.tick()).toBe('not due');
    fail = false;
    t.clock.t += 10 * 60_000;
    expect(await t.r.tick()).toBe('posted');
    expect(posts).toHaveLength(1);
    expect(t.r.lastPosted).toBe('2026-11-08');
  });

  it('does not post a week with nothing to report, and does not try again', async () => {
    const t = setup();
    t.clock.t = denver('2026-11-08', 18);
    expect(await t.r.tick()).toBe('quiet week');
    expect(await t.r.tick()).toBe('not due');
    expect(t.posts).toHaveLength(0);
  });

  it('keeps the numbers small: songs, weeks, named people', () => {
    const t = setup();
    for (let i = 0; i < 500; i++) t.r.played(`Song ${i}`);
    t.r.played('Song 499');
    const w = t.r.week()!;
    expect(Object.keys(w.songs).length).toBeLessThanOrEqual(200);
    expect(w.songs['song 499|']!.n).toBe(2);
    for (let i = 0; i < 6; i++) {
      t.clock.t += 7 * DAY;
      t.r.answered('text', OWNER);
    }
    const weeks = (t.r as unknown as { data: { weeks: object } }).data.weeks;
    expect(Object.keys(weeks)).toHaveLength(3);
  });

  it('names only people who asked to be named, and never pings', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) t.r.answered('call', FAN);
    t.r.answered('pc', OWNER);
    t.r.answered('text', OWNER);
    t.r.played('@everyone *bold*');
    const w = t.r.week()!;
    expect(Object.keys(w.named)).toEqual([FAN]);
    t.clock.t = denver('2026-11-08', 18);
    await t.r.tick();
    const post = t.posts[0]!;
    expect(post).toContain('Questions answered: 5 (3 in the call, 1 at PCs, 1 in text chat). Most asked: Alex (3)');
    expect(post).not.toContain('Sam');
    expect(post).toContain('\\@everyone \\*bold\\*');
  });

  it('adds game server uptime and peak players from the samples', async () => {
    let up = true;
    const t = setup({ media: { servers: [{ name: 'Survival', host: 'h', port: 1, kind: 'minecraft' }], ping: async () => (up ? { online: true, players: 4 } : { online: false }) } });
    await t.r.sample();
    await t.r.sample();
    await t.r.sample();
    up = false;
    await t.r.sample();
    t.clock.t = denver('2026-11-08', 18);
    await t.r.tick();
    expect(t.posts[0]).toContain('Game servers: Survival up 75% of the time, peak 4 players');
  });

  it('adds new episodes and movies from that week, top 3 titles', async () => {
    const end = denver('2026-11-08');
    const shows = ['Frieren', 'One Piece', 'The Bear', 'Severance'];
    const eps = ['Frieren', 'Frieren', 'Frieren', 'One Piece', 'One Piece', 'The Bear', 'Severance'].map((title, i) => ({ episodeId: i, seriesId: shows.indexOf(title), date: new Date(end - ((i + 1) * DAY) / 2).toISOString() }));
    const movies = [{ movieId: 1, date: new Date(end - DAY).toISOString() }, { movieId: 2, date: new Date(end - 9 * DAY).toISOString() }];
    const f = (async (u: string) => {
      const one = /\/(series|movie)\/(\d+)$/.exec(String(u));
      if (one) return Response.json({ title: one[1] === 'series' ? shows[+one[2]!] : ['', 'Dune', 'Too Old'][+one[2]!] });
      return Response.json({ records: String(u).includes(':8989') ? eps : movies });
    }) as typeof fetch;
    const t = setup({ media: { media: { sonarr: { url: 'http://127.0.0.1:8989', apiKey: 'k' }, radarr: { url: 'http://127.0.0.1:7878', apiKey: 'k' }, timezone: TZ }, fetch: f } });
    t.clock.t = end;
    await t.r.tick();
    expect(t.posts[0]).toContain('New on Plex: 7 episodes (Frieren, One Piece, The Bear, and more) and 1 movie (Dune)');
  });

  it('leaves the media line out when the apps are down', async () => {
    const f = (async () => new Response('', { status: 500 })) as typeof fetch;
    const t = setup({ media: { media: { sonarr: { url: 'http://127.0.0.1:8989', apiKey: 'k' }, timezone: TZ }, fetch: f } });
    t.r.played('Song');
    t.clock.t = denver('2026-11-08', 18);
    await t.r.tick();
    expect(t.posts[0]).not.toContain('New on Plex');
  });

  it('stays within a Discord message', async () => {
    const t = setup();
    for (let i = 0; i < 200; i++) t.r.played(`${'x'.repeat(60)} ${i}`, 'y'.repeat(60));
    const text = await t.r.compose(weekOf(t.clock.t, TZ, 0, 18), t.clock.t, true);
    expect(text!.length).toBeLessThanOrEqual(1900);
  });

  it('lets an owner post it now, not anyone else, and not twice in a row', async () => {
    const t = setup();
    const tool = t.r.tools()[0]!;
    expect(await tool.run({}, AbortSignal.timeout(1000), { userId: FAN, speaker: 'Alex' })).toBe('Only an owner can post the recap.');
    expect(await tool.run({}, AbortSignal.timeout(1000), { userId: OWNER, speaker: 'Sam' })).toBe('Nothing to report this week yet.');
    t.r.played('Song');
    const raw = await tool.run({}, AbortSignal.timeout(1000), { userId: OWNER, speaker: 'Sam' });
    expect(tool.speak!({}, raw, { userId: OWNER, speaker: 'Sam' })).toBe('Posted.');
    expect(t.posts[0]).toContain('**This week so far** (since Nov 1)');
    expect(await tool.run({}, AbortSignal.timeout(1000), { userId: OWNER, speaker: 'Sam' })).toMatch(/just posted/);
    // The scheduled one still goes out.
    t.clock.t = denver('2026-11-08', 18);
    expect(await t.r.tick()).toBe('posted');
  });

  it('counts nothing and posts nothing while off', async () => {
    const posts: string[] = [];
    const r = new Recap(undefined, { enabled: false, timezone: TZ, day: 0, hour: 18 }, {
      sources: { media: { timezone: TZ }, servers: [], ping: async () => ({ online: true }) },
      post: async (c) => void posts.push(c),
      nameOf: () => '',
      named: () => false,
      isOwner: () => true,
      now: () => denver('2026-11-08', 18),
    });
    r.played('Song');
    expect(r.week()).toBeUndefined();
    expect(await r.tick()).toBe('not due');
    expect(posts).toHaveLength(0);
  });
});

describe('recap and heads-up config', () => {
  const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/x' };
  it('is on only once a channel is set; heads-ups are off by default', () => {
    const c = PocConfigSchema.parse(base);
    expect(c.recap).toEqual({ enabled: false, day: 'sunday', hour: 18 });
    expect(c.headsUp).toEqual({ enabled: false, people: [], awayHours: 4, minHours: 6 });
    expect(PocConfigSchema.parse({ ...base, recap: { channelId: '123456789012345670' } }).recap.enabled).toBe(true);
    expect(PocConfigSchema.parse({ ...base, recap: { channelId: '123456789012345670', enabled: false } }).recap.enabled).toBe(false);
    expect(PocConfigSchema.safeParse({ ...base, recap: { day: 'someday' } }).success).toBe(false);
  });
});
