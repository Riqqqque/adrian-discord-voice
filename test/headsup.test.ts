import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sources } from '../src/features/digest.js';
import { HeadsUp, headsUpGate, wentDown, type HeadsUpDeps } from '../src/features/headsup.js';

const HOUR = 3_600_000;
const OWNER = '123456789012345678';
const GUEST = '223456789012345678';
const ctx = { userId: OWNER, speaker: 'Alex' };

/** A fake Sonarr that has `eps` imports `hoursAgo` before the clock's current time. */
function sonarr(clock: { t: number }, eps: { title: string; hoursAgo: number }[], opts: { fail?: boolean } = {}) {
  let calls = 0;
  const titles = [...new Set(eps.map((e) => e.title))];
  const f = (async (u: string) => {
    calls++;
    if (opts.fail) return new Response('down', { status: 503 });
    const one = /\/series\/(\d+)$/.exec(String(u));
    if (one) return Response.json({ title: titles[+one[1]!] });
    return Response.json({ records: eps.map((e, i) => ({ episodeId: i + 1, seriesId: titles.indexOf(e.title), date: new Date(clock.t - e.hoursAgo * HOUR).toISOString() })) });
  }) as typeof fetch;
  return { f, calls: () => calls };
}

function setup(o: { eps?: { title: string; hoursAgo: number }[]; quiet?: () => boolean; enabled?: boolean; people?: string[]; fail?: boolean; heard?: boolean; servers?: Record<string, boolean>; file?: string } = {}) {
  const clock = { t: Date.UTC(2026, 10, 8, 18) };
  const s = sonarr(clock, o.eps ?? [], { fail: o.fail ?? false });
  const said: { id: string; line: string }[] = [];
  const audible = new Set<string>();
  const servers = o.servers ?? {};
  const sources: Sources = {
    media: { sonarr: { url: 'http://127.0.0.1:8989', apiKey: 'k' }, timezone: 'UTC' },
    servers: Object.keys(servers).map((name) => ({ name, host: name, port: 1, kind: 'minecraft' as const })),
    ping: async (host) => ({ online: servers[host] ?? false }),
    fetch: s.f,
  };
  const deps: HeadsUpDeps = {
    sources,
    timezone: 'UTC',
    isOwner: (id) => id === OWNER,
    audible: (id) => audible.has(id),
    quiet: o.quiet ?? (() => true),
    name: () => 'Alex',
    say: async (id, line) => (said.push({ id, line }), o.heard ?? true),
    now: () => clock.t,
    // Fake sleep: time moves on, nothing waits.
    sleep: async (ms) => void (clock.t += ms),
  };
  const h = new HeadsUp(o.file, { enabled: o.enabled ?? true, awayHours: 4, minHours: 6, people: o.people ?? [] }, deps);
  /** Join, and wait for the heads-up to finish. */
  const join = async (...ids: string[]) => {
    for (const id of ids) audible.add(id);
    h.members(new Set([...present, ...ids]));
    ids.forEach((id) => present.add(id));
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 100 && (h as unknown as { pending: Set<string> }).pending.size; i++) await new Promise((r) => setTimeout(r, 1));
  };
  const present = new Set<string>();
  const leave = (id: string) => {
    present.delete(id);
    audible.delete(id);
    h.members(new Set(present));
  };
  return { h, clock, said, join, leave, audible, sonarr: s, servers };
}

describe('heads-up gate', () => {
  const base = { enabled: true, tracked: true, now: 100 * HOUR, awayHours: 4, minHours: 6, pending: false };
  it('needs it on, a tracked person, a first visit seen, a long enough absence, and no recent one', () => {
    expect(headsUpGate({ ...base, person: { seen: 90 * HOUR } })).toBe('ok');
    expect(headsUpGate({ ...base, enabled: false, person: { seen: 0 } })).toBe('off');
    expect(headsUpGate({ ...base, tracked: false, person: { seen: 0 } })).toBe('not tracked');
    expect(headsUpGate({ ...base, person: undefined })).toBe('first visit');
    expect(headsUpGate({ ...base, person: { seen: 97 * HOUR } })).toBe('not away long enough');
    expect(headsUpGate({ ...base, person: { seen: 90 * HOUR, told: 95 * HOUR } })).toBe('told recently');
    expect(headsUpGate({ ...base, person: { seen: 90 * HOUR, told: 93 * HOUR } })).toBe('ok');
    expect(headsUpGate({ ...base, person: { seen: 0, off: true } })).toBe('opted out');
    expect(headsUpGate({ ...base, pending: true, person: { seen: 0 } })).toBe('already pending');
  });

  it('counts a server as gone down only if it was up when they last heard', () => {
    expect(wentDown({ servers: { A: false, B: false, C: true } }, { A: true, B: false })).toEqual(['A']);
    expect(wentDown({ servers: { A: false } }, undefined)).toEqual([]);
  });
});

describe('heads-up on joining', () => {
  it('says one line after a long absence, about what is new since then', async () => {
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 2 }, { title: 'Frieren', hoursAgo: 3 }, { title: 'Old', hoursAgo: 30 }] });
    await t.join(OWNER);
    expect(t.said).toEqual([]); // first visit: nothing to compare with
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(1);
    expect(t.said[0]!.line).toMatch(/^Alex, since yesterday: (a new|\d+ new) Frieren episode/);
    expect(t.said[0]!.line).not.toContain('Old');
  });

  it('stays quiet when they were away only a short while, and at most once per minHours', async () => {
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }] });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 2 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(0);
    t.leave(OWNER);
    t.clock.t += 5 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(1);
    // Away 4 h more, but only 4 h since the last one (minHours 6).
    t.leave(OWNER);
    t.clock.t += 4 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(1);
    t.leave(OWNER);
    t.clock.t += 4 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(2);
  });

  it('is only for owners by default, or the people listed', async () => {
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }] });
    await t.join(GUEST);
    t.leave(GUEST);
    t.clock.t += 24 * HOUR;
    await t.join(GUEST);
    expect(t.said).toHaveLength(0);
    const u = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }], people: [GUEST] });
    await u.join(GUEST);
    u.leave(GUEST);
    u.clock.t += 24 * HOUR;
    await u.join(GUEST);
    expect(u.said.map((s) => s.id)).toEqual([GUEST]);
  });

  it('does nothing while it is switched off, and does not fetch', async () => {
    const t = setup({ enabled: false, eps: [{ title: 'Frieren', hoursAgo: 1 }] });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(0);
    expect(t.sonarr.calls()).toBe(0);
  });

  it('skips when nothing is new, without using up the once-per-6-hours', async () => {
    const t = setup({ eps: [] });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(0);
    expect(t.sonarr.calls()).toBe(1); // one history page, no titles needed
  });

  it('skips when the media app is down', async () => {
    const t = setup({ fail: true });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(0);
  });

  it('waits for a quiet moment, and gives up on a busy call', async () => {
    let quietAfter = Infinity;
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }], quiet: () => t.clock.t >= quietAfter });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER); // never quiet
    expect(t.said).toHaveLength(0);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    quietAfter = t.clock.t + 30_000; // a gap after half a minute of talk
    await t.join(OWNER);
    expect(t.said).toHaveLength(1);
  });

  it('drops it if they leave or deafen before a quiet moment', async () => {
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }] });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    t.audible.delete(OWNER);
    t.h.members(new Set([OWNER]));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.said).toHaveLength(0);
  });

  it('does not greet people who were already there when she joined', async () => {
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }] });
    await t.join(OWNER);
    t.h.left();
    t.clock.t += 24 * HOUR;
    t.audible.add(OWNER);
    t.h.members(new Set([OWNER]), true);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.said).toHaveLength(0);
  });

  it('remembers "stop telling me that" across restarts', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hu-')), 'heads-up.json');
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }], file });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(1);
    expect(t.h.context(OWNER, 'Alex')[0]).toContain('digest_prefs');
    const prefs = t.h.tools().find((x) => x.spec.name === 'digest_prefs')!;
    const raw = await prefs.run({ heads_up: false }, AbortSignal.timeout(1000), ctx);
    expect(prefs.speak!({}, raw, ctx)).toBe("Okay, I won't tell you that when you join anymore.");
    expect(t.h.context(OWNER, 'Alex')).toEqual([]);
    t.h.flush();
    const again = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }], file });
    await again.join(OWNER);
    again.leave(OWNER);
    again.clock.t += 48 * HOUR;
    await again.join(OWNER);
    expect(again.said).toHaveLength(0);
    // And back on.
    await again.h.tools().find((x) => x.spec.name === 'digest_prefs')!.run({ heads_up: true }, AbortSignal.timeout(1000), ctx);
    again.leave(OWNER);
    again.clock.t += 48 * HOUR;
    await again.join(OWNER);
    expect(again.said).toHaveLength(1);
  });

  it('tells about a server that went down since they were last told', async () => {
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }], servers: { Survival: true } });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER); // learns it's up
    expect(t.said[0]!.line).not.toContain('Survival');
    t.leave(OWNER);
    t.servers.Survival = false;
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    expect(t.said[1]!.line).toContain('the Survival server is down');
  });

  it('does not count it as told when nobody heard it', async () => {
    const t = setup({ eps: [{ title: 'Frieren', hoursAgo: 1 }], heard: false });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 5 * HOUR;
    await t.join(OWNER);
    expect(t.said).toHaveLength(2);
  });
});

describe('what did I miss', () => {
  it('answers from when they were last in the call, heads-up on or off', async () => {
    const t = setup({ enabled: false, eps: [{ title: 'Frieren', hoursAgo: 2 }, { title: 'One Piece', hoursAgo: 40 }] });
    await t.join(OWNER);
    t.leave(OWNER);
    t.clock.t += 24 * HOUR;
    await t.join(OWNER);
    const tool = t.h.tools().find((x) => x.spec.name === 'whats_new')!;
    const raw = await tool.run({}, AbortSignal.timeout(1000), ctx);
    expect(raw).toBe('Since yesterday: a new Frieren episode.');
    expect(tool.speak!({}, raw, ctx)).toBe(raw);
    // Someone never seen: the last day.
    expect(await tool.run({}, AbortSignal.timeout(1000), { userId: GUEST, speaker: 'Sam' })).toBe('Since yesterday: a new Frieren episode.');
    expect(await tool.run({ hours: 72 }, AbortSignal.timeout(1000), ctx)).toContain('2 new episodes of Frieren and One Piece');
  });

  it('says plainly when nothing is new or the apps are down', async () => {
    const t = setup({ eps: [] });
    const tool = t.h.tools().find((x) => x.spec.name === 'whats_new')!;
    expect(await tool.run({}, AbortSignal.timeout(1000), ctx)).toBe('Nothing new since yesterday.');
    const d = setup({ fail: true });
    const dt = d.h.tools().find((x) => x.spec.name === 'whats_new')!;
    const raw = await dt.run({}, AbortSignal.timeout(1000), ctx);
    expect(raw).toBe("I couldn't reach Sonarr just now.");
  });

  it('says when nothing is set up', async () => {
    const h = new HeadsUp(undefined, { enabled: true, awayHours: 4, minHours: 6, people: [] }, {
      sources: { media: { timezone: 'UTC' }, servers: [], ping: async () => ({ online: true }) },
      timezone: 'UTC',
      isOwner: () => true,
      audible: () => true,
      quiet: () => true,
      say: async () => true,
    });
    expect(await h.tools()[0]!.run({}, AbortSignal.timeout(1000), ctx)).toMatch(/^No media apps/);
  });
});

describe('remembering people', () => {
  it('keeps at most 200 people and never forgets a choice', async () => {
    const t = setup();
    const prefs = t.h.tools().find((x) => x.spec.name === 'digest_prefs')!;
    await prefs.run({ name_in_recap: true }, AbortSignal.timeout(1000), ctx);
    expect(t.h.named(OWNER)).toBe(true);
    for (let i = 0; i < 300; i++) {
      t.h.members(new Set([`${100000000000000000 + i}`]));
      t.clock.t += 1000;
    }
    t.h.members(new Set());
    const people = (t.h as unknown as { people: Record<string, unknown> }).people;
    expect(Object.keys(people).length).toBeLessThanOrEqual(200);
    expect(t.h.named(OWNER)).toBe(true);
  });
});
