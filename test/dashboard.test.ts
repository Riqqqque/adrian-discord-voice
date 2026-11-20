// The dashboard's counters (src/web/metrics.ts) and what it makes of them
// (src/web/dashboard.ts): fed log lines exactly as the service writes them.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { topResultUrl, webYoutubeVideos } from '../src/brain/tools.js';
import { noteCall, onCall } from '../src/core/calls.js';
import { createLogger } from '../src/core/logger.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import { groqTranscribe } from '../src/speech/cloud-stt.js';
import { attention, buildDashboard, type DashboardInput, newer, ReleaseCheck, type SystemInfo } from '../src/web/dashboard.js';
import { BINS, binOf, binValue, Metrics, PC_DROP_MS, WATCHED } from '../src/web/metrics.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

/** Every temp folder this file made; each test's go after it. */
const made: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

/** Metrics on a clock the test moves. */
function clocked(o: { file?: string; version?: string } = {}) {
  let now = T0;
  const m = new Metrics({ ...o, timezone: 'UTC', now: () => now });
  const log = (msg: string, f?: Record<string, unknown>, level = 'info') => m.observe(level, msg, f);
  return {
    m,
    log,
    at: (t: number) => (now = t),
    step: (ms: number) => (now += ms),
    answer: (total: number | null, more: Record<string, unknown> = {}) =>
      log('answered', { user: '100000000000000001', room: 'discord', outcome: 'finished', speechEndToAudioMs: total, costUsd: 0.001, ...more }),
  };
}

const within = (got: number | null, want: number, tol = 0.065) => {
  expect(got).not.toBeNull();
  expect(Math.abs(got! - want) / want).toBeLessThanOrEqual(tol);
};

describe('latency histograms', () => {
  it('read every value back within 6%', () => {
    for (let v = 10; v < 600_000; v *= 1.07) within(binValue(binOf(v)), v);
    expect(binOf(0)).toBe(0);
    expect(binValue(binOf(0))).toBe(0);
    expect(binOf(20 * 60_000)).toBe(BINS - 1);
    expect(binOf(Number.NaN)).toBe(0);
  });

  it('give the median and 90th of the last day and week, by room and stage', () => {
    const c = clocked();
    // 100 answers: call ones 1.0-1.99 s, PC ones 2.0-2.99 s.
    for (let i = 0; i < 50; i++) c.answer(1000 + i * 20, { sttLatencyMs: 100, llmFirstChunkMs: 600 + i * 4, ttsFirstMs: 250, holdMs: 0 });
    for (let i = 0; i < 50; i++) c.answer(2000 + i * 20, { room: 'sat:abc', groqMs: 450, turnCheckMs: 120 });
    const s = c.m.snapshot();
    expect(s.day.speed.total.n).toBe(100);
    within(s.day.speed.total.p50, 2000);
    within(s.day.speed.total.p90, 2800);
    within(s.day.speed.call.p50, 1500);
    within(s.day.speed.pc.p50, 2500);
    within(s.day.speed.stages.stt.p50, 100);
    within(s.day.speed.stages.groq.p50, 450);
    within(s.day.speed.stages.llmFirst.p90, 780);
    expect(s.day.speed.stages.hold.p50).toBe(0);
    expect(s.week.speed.total.n).toBe(100);
    expect(s.day.counts.answers).toBe(100);
    expect(s.day.costPerAnswerUsd).toBe(0.001);
  });

  it('let a day go out of the last-day window, and a week out of the week', () => {
    const c = clocked();
    c.answer(1000);
    c.step(25 * H);
    c.answer(3000);
    let s = c.m.snapshot();
    expect(s.day.speed.total.n).toBe(1);
    within(s.day.speed.total.p50, 3000);
    expect(s.week.speed.total.n).toBe(2);
    c.step(8 * 24 * H);
    s = c.m.snapshot();
    expect(s.day.speed.total.n).toBe(0);
    expect(s.week.speed.total.n).toBe(0);
    expect(s.day.speed.total.p50).toBeNull();
  });

  it('count outcomes, and answers that never got to speak', () => {
    const c = clocked();
    c.answer(null, { outcome: 'error', costUsd: 0 });
    c.answer(null, { outcome: 'timed out', costUsd: 0 });
    c.answer(900, { outcome: 'interrupted' });
    const k = c.m.snapshot().day.counts;
    expect([k.answers, k.errors, k.timedOut, k.interrupted, k.paid]).toEqual([3, 1, 1, 1, 1]);
  });
});

describe('links', () => {
  it('time a voice drop until the connection is ready again', () => {
    const c = clocked();
    c.log('voice disconnected', { reason: 'voice connection dropped' }, 'warn');
    c.step(4_000);
    expect(c.m.snapshot().voiceDownForS).toBe(4);
    c.log('voice state', { from: 'connecting', to: 'ready' });
    const s = c.m.snapshot();
    expect(s.voiceDownForS).toBeNull();
    expect(s.day.counts.voiceDrops).toBe(1);
    within(s.day.voiceBack.p50, 4_000);
    expect(s.day.voiceBack.n).toBe(1);
    // Ready after a /join, with nothing dropped, isn't a recovery.
    c.log('voice state', { from: 'connecting', to: 'ready' });
    expect(c.m.snapshot().day.counts.voiceDrops).toBe(1);
  });

  it('does not count leaving on purpose, or a restart, as a drop', () => {
    const c = clocked();
    for (const leave of [WATCHED.kicked, WATCHED.leftEmpty, WATCHED.leave, WATCHED.restartRequested]) {
      c.log('voice disconnected', {}, 'warn');
      c.step(1_000);
      c.log(leave);
      c.step(60_000);
      c.log('voice state', { to: 'ready' });
    }
    // Stopping on purpose: the transport's own drop line during the stop doesn't start one.
    c.log('shutting down', { signal: 'SIGTERM' });
    c.log('voice disconnected', {}, 'warn');
    c.log('voice state', { to: 'ready' });
    const s = c.m.snapshot();
    expect(s.day.counts.voiceDrops).toBe(0);
    expect(s.voiceDownForS).toBeNull();
  });

  it('counts drops again once a restarted stack is starting', () => {
    const c = clocked();
    c.log('restart requested', { by: 'admin' });
    c.log('asr loaded', { ms: 900 }); // no satellites: nothing else says it's up
    c.log('voice disconnected', {}, 'warn');
    c.step(2_000);
    c.log('voice state', { to: 'ready' });
    expect(c.m.snapshot().day.counts.voiceDrops).toBe(1);
  });

  it('does not count being dragged to another channel as a drop, whichever line comes first', () => {
    const c = clocked();
    c.log('moved to another channel', { channelId: '1' });
    c.log('voice disconnected', {}, 'warn');
    c.step(1_000);
    c.log('voice state', { to: 'ready' });
    c.step(60_000);
    c.log('voice disconnected', {}, 'warn');
    c.log('moved to another channel', { channelId: '2' });
    c.step(1_000);
    c.log('voice state', { to: 'ready' });
    expect(c.m.snapshot().day.counts.voiceDrops).toBe(0);
  });

  it('times a PC link back within 10 minutes, and calls a longer gap away', () => {
    const c = clocked();
    c.log('satellite connected', { device: 'A', addr: '192.0.2.1' });
    c.step(60_000);
    c.log('satellite disconnected', { device: 'A' });
    c.step(3_000);
    c.log('satellite connected', { device: 'A' });
    c.step(60_000);
    c.log('satellite disconnected', { device: 'A' });
    c.step(PC_DROP_MS + 1);
    c.log('satellite connected', { device: 'A' });
    const s = c.m.snapshot();
    expect(s.day.counts.pcDrops).toBe(1);
    within(s.day.pcBack.p50, 3_000);
    expect(s.day.counts.pcAway).toBe(1);
    expect(s.pcsOnline).toBe(1);
  });

  it("doesn't count a reconnect whose old link closes after the new one is welcomed", () => {
    const c = clocked();
    c.log('satellite connected', { device: 'A' });
    c.log('satellite connected', { device: 'A' }); // replaces the first
    c.step(500);
    c.log('satellite disconnected', { device: 'A' }); // the first one's close
    c.step(10_000);
    const s = c.m.snapshot();
    expect(s.day.counts.pcDrops).toBe(0);
    expect(s.pcsOnline).toBe(1);
  });

  it("doesn't count PCs reconnecting after a restart from the page", () => {
    const c = clocked();
    c.log('satellite connected', { device: 'A' });
    c.log('restart requested', { by: 'admin' });
    c.log('satellite disconnected', { device: 'A' });
    c.step(20_000);
    c.log('satellite server listening', { bind: '127.0.0.1', port: 1 });
    c.log('satellite connected', { device: 'A' });
    expect(c.m.snapshot().day.counts.pcDrops).toBe(0);
    // ...but a drop after that is one.
    c.log('satellite disconnected', { device: 'A' });
    c.step(2_000);
    c.log('satellite connected', { device: 'A' });
    expect(c.m.snapshot().day.counts.pcDrops).toBe(1);
  });
});

describe('errors and restarts', () => {
  it('keeps the latest problems with a count, without IDs or secrets', () => {
    const c = clocked();
    const key = 'gsk_abcdefghijklmnopqrstuvwxyz123456';
    c.log('answer failed', { user: '100000000000000001', error: `HTTP 401 for key ${key}` }, 'warn');
    c.step(1000);
    c.log('voice failed', { reason: 'not back after 5 rejoin attempts; still trying' }, 'error');
    c.log('answer failed', { user: '100000000000000001', error: `HTTP 401 for key ${key}` }, 'warn');
    c.log('reminder DM failed', { user: '100000000000000002', error: 'Cannot send messages to 100000000000000002' }, 'warn');
    const e = c.m.snapshot().errors;
    expect(e.map((x) => [x.msg, x.n])).toEqual([
      ['reminder DM failed', 1],
      ['answer failed', 2],
      ['voice failed', 1],
    ]);
    const text = JSON.stringify(e);
    expect(text).not.toContain(key);
    expect(text).not.toContain('100000000000000001');
    expect(text).not.toContain('100000000000000002');
    expect(text).toContain('[redacted]');
    expect(c.m.snapshot().day.counts.voiceFailed).toBe(1);
  });

  it('says why the service restarted: a clean stop, an update, a crash, or no clean stop at all', () => {
    const dir = tmp('adrian-metrics-');
    const file = join(dir, 'dashboard.json');
    const run = (version: string) => {
      const c = clocked({ file, version });
      c.m.begin();
      return c;
    };
    let c = run('0.17.1');
    expect(c.m.snapshot().restarts[0]).toMatchObject({ kind: 'start', why: 'first start with these counters', version: '0.17.1' });
    c.answer(1200);
    c.m.flush(); // SIGTERM
    c = run('0.17.1');
    expect(c.m.snapshot().restarts[0]!.why).toBe('service restarted');
    expect(c.m.snapshot().day.speed.total.n).toBe(1); // kept across the restart
    c.m.flush();
    c = run('0.18.0');
    expect(c.m.snapshot().restarts[0]!.why).toBe('updated from 0.17.1');
    // The power goes: only begin()'s save is on disk.
    c = run('0.18.0');
    expect(c.m.snapshot().restarts[0]!.why).toMatch(/did not shut down cleanly/);
    expect(c.m.snapshot().day.counts.unclean).toBe(1);
    c.m.crashed(new TypeError('Cannot read properties of undefined (reading "x")'));
    c = run('0.18.0');
    expect(c.m.snapshot().restarts[0]!.why).toBe('crashed: Cannot read properties of undefined (reading "…")');
    c.m.flush();
    expect(readdirSync(dir)).toEqual(['dashboard.json']);
  });

  it('notes a failed start and a restart from the page', () => {
    const c = clocked();
    c.log('restart requested', { by: 'admin' });
    c.log('voice stack failed to start', { error: 'An invalid token was provided.' }, 'error');
    const r = c.m.snapshot().restarts;
    expect(r.map((x) => x.kind)).toEqual(['failed', 'restart']);
    expect(r[0]!.why).toBe('An invalid token was provided.');
  });

  it('starts over from a damaged or foreign file', () => {
    const dir = tmp('adrian-metrics-');
    const file = join(dir, 'dashboard.json');
    for (const bad of ['not json', '{"version":1,"hourly":{"keys":[1],"hist":"AAAA","counts":[]},"errors":[{"msg":5}],"days":{"x":[1]}}', 'null']) {
      writeFileSync(file, bad);
      const m = new Metrics({ file });
      m.begin();
      expect(m.snapshot().day.speed.total.n).toBe(0);
      m.flush();
    }
  });

  it('keeps what failed and its code, but no address, host, link, ID, email, key or quoted words', () => {
    const file = join(tmp('adrian-metrics-'), 'dashboard.json');
    const c = clocked({ file });
    const cases: [msg: string, error: string, want: string][] = [
      ['admin UI failed to start', 'listen EADDRINUSE: address already in use 192.0.2.50:8787', 'listen EADDRINUSE: address already in use [address]:8787'],
      ['satellite server error', 'listen EADDRINUSE: address already in use [2001:db8::50]:8788', 'listen EADDRINUSE: address already in use [address]:8788'],
      ['satellite server error', 'listen EADDRINUSE: address already in use :::8789', 'listen EADDRINUSE: address already in use [address]:8789'],
      ['lights failed', 'connect ECONNREFUSED 2001:db8:0:0:0:0:0:7', 'connect ECONNREFUSED [address]'],
      ['lights failed', 'connect ECONNREFUSED ::ffff:192.0.2.7', 'connect ECONNREFUSED [address]'],
      ['lights failed', 'connect ECONNREFUSED ::1:8123', 'connect ECONNREFUSED [address]'],
      ['lights failed', 'connect ETIMEDOUT hass.example.lan:8123', 'connect ETIMEDOUT [host]:8123'],
      ['lights failed', 'connect ETIMEDOUT nas-box:8124', 'connect ETIMEDOUT [host]:8124'],
      ['webhook failed', 'request to https://hooks.example.com/hook/abc?id=5 failed, reason: getaddrinfo ENOTFOUND hooks.example.com', 'request to https://[host] failed, reason: getaddrinfo ENOTFOUND [host]'],
      ['reminder DM failed', 'Cannot send messages to user_100000000000000002', 'Cannot send messages to user_[id]'],
      ['mail failed', 'rejected recipient sam.sample+x@example.com', 'rejected recipient [email]'],
      ['sound failed', 'no "my made-up sound words" sound found', 'no "…" sound found'],
      ['sound failed', "couldn't find 'another made-up phrase' anywhere, isn't that odd", `couldn't find "…" anywhere, isn't that odd`],
      ['sound failed', 'no sound called “a curly phrase” here', 'no sound called "…" here'],
      ['sound failed', "the line was cut: 'and then it never clos", 'the line was cut: "…"'],
      ['answer failed', 'HTTP 401 for key gsk_abcdefghijklmnopqrstuvwxyz123456', 'HTTP 401 for key [redacted]'],
      ['token failed', 'refused eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij0123456789xyz', 'refused [redacted]'],
      ['file failed', "ENOENT: no such file or directory, open 'C:\\Users\\Sam\\x.json'", 'ENOENT: no such file or directory, open "…"'],
      ['file failed', 'EACCES: permission denied, mkdir /home/sam/.adrian', 'EACCES: permission denied, mkdir /home/[user]/.adrian'],
      ['clock failed', 'skipped 12:30:45 and status 503', 'skipped 12:30:45 and status 503'],
      ['answer timed out', 'This operation was aborted', 'This operation was aborted'],
    ];
    for (const [msg, error] of cases) c.log(msg, { error }, 'warn');
    const got = new Map(c.m.snapshot().errors.map((e) => [e.detail, e.msg]));
    for (const [msg, , want] of cases) expect(got.get(want), want).toBe(msg);
    c.m.flush();
    const saved = readFileSync(file, 'utf8');
    for (const leak of ['192.0.2', '2001:db8', 'ffff', 'example', 'nas-box', '100000000000000002', 'sam', 'Sam', 'made-up', 'curly', 'never clos', 'gsk_', 'eyJ']) {
      expect(saved, leak).not.toContain(leak);
      expect(JSON.stringify(c.m.snapshot()), leak).not.toContain(leak);
    }
  });

  it('masks a file written before this, crash and restart reasons included', () => {
    const file = join(tmp('adrian-metrics-'), 'dashboard.json');
    const c = clocked({ file, version: '0.17.1' });
    c.m.begin();
    c.m.flush();
    const f = JSON.parse(readFileSync(file, 'utf8'));
    f.running = true;
    f.crash = 'listen EADDRINUSE: address already in use 192.0.2.60:8787';
    f.errors = [{ t: T0, level: 'error', msg: 'admin UI failed to start', detail: 'connect ECONNREFUSED 192.0.2.61:8123', n: 1 }];
    f.restarts = [{ t: T0, kind: 'failed', why: 'no "old made-up words" here 192.0.2.62' }];
    writeFileSync(file, JSON.stringify(f));
    const d = clocked({ file, version: '0.17.1' });
    d.m.begin();
    const s = d.m.snapshot();
    expect(s.restarts.map((r) => r.why)).toEqual(['crashed: listen EADDRINUSE: address already in use [address]:8787', 'no "…" here [address]']);
    expect(s.errors[0]!.detail).toBe('connect ECONNREFUSED [address]:8123');
    d.m.flush();
    expect(readFileSync(file, 'utf8')).not.toMatch(/192\.0\.2|made-up/);
  });

  it('records a crash from whatever was thrown, even null', () => {
    const file = join(tmp('adrian-metrics-'), 'dashboard.json');
    const crash = (thrown: unknown) => {
      const c = clocked({ file });
      expect(() => c.m.crashed(thrown)).not.toThrow();
      const next = clocked({ file });
      next.m.begin();
      const why = next.m.snapshot().restarts[0]!.why;
      next.m.flush();
      return why;
    };
    expect(crash(new RangeError('Invalid array length'))).toBe('crashed: Invalid array length');
    expect(crash(null)).toBe('crashed: threw null');
    expect(crash(undefined)).toBe('crashed: threw undefined');
    expect(crash('plain words')).toBe('crashed: plain words');
    expect(crash(Object.create(null))).toBe('crashed: unknown error');
  });
});

describe('paid calls the dollar ledger misses', () => {
  it('counts Tavily searches and Groq listens per day and month', () => {
    const c = clocked();
    onCall(c.m.noteCall);
    try {
      noteCall('tavily', 200);
      noteCall('tavily', 432);
      noteCall('groq-stt', 200);
      c.at(Date.UTC(2026, 10, 1, 9)); // earlier this month
      noteCall('groq-stt', 200);
      c.at(Date.UTC(2026, 9, 31, 9)); // last month
      noteCall('groq-stt', 200);
      c.at(T0);
      const k = c.m.snapshot().calls;
      expect(k.today).toEqual({ tavily: 1, tavilyFailed: 1, groq: 1, groqFailed: 0 });
      expect(k.month).toEqual({ tavily: 1, tavilyFailed: 1, groq: 2, groqFailed: 0 });
    } finally {
      onCall(undefined);
    }
  });

  it('counts a call that got no answer at all as failed, but not one she called off', async () => {
    const c = clocked();
    onCall(c.m.noteCall);
    const fail = (e: unknown) => vi.fn(async () => Promise.reject(e));
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const abort = new DOMException('This operation was aborted', 'AbortError');
    const sig = new AbortController().signal;
    try {
      vi.stubGlobal('fetch', fail(new TypeError('fetch failed')));
      await expect(topResultUrl('k', 'q', sig)).rejects.toThrow('fetch failed');
      await expect(webYoutubeVideos('k', 'q', sig)).rejects.toThrow('fetch failed');
      await expect(groqTranscribe('k', new Float32Array(160), 16_000)).rejects.toThrow('fetch failed');
      vi.stubGlobal('fetch', fail(timeout));
      await expect(groqTranscribe('k', new Float32Array(160), 16_000)).rejects.toBe(timeout);
      vi.stubGlobal('fetch', fail(abort));
      await expect(groqTranscribe('k', new Float32Array(160), 16_000)).rejects.toBe(abort);
      await expect(topResultUrl('k', 'q', sig)).rejects.toBe(abort);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{"text":"hi"}', { status: 200 })));
      await expect(groqTranscribe('k', new Float32Array(160), 16_000)).resolves.toBe('hi');
      // Only answered calls count against the quota; the ones that never got an answer are failures.
      expect(c.m.snapshot().calls.today).toEqual({ tavily: 0, tavilyFailed: 2, groq: 1, groqFailed: 2 });
    } finally {
      vi.unstubAllGlobals();
      onCall(undefined);
    }
  });

  it('counts the second listen failing and being rate limited', () => {
    const c = clocked();
    c.log('cloud speech-to-text failed; using local words', { error: 'Groq STT HTTP 429' }, 'warn');
    c.log('cloud speech-to-text failed; using local words', { error: 'This operation was aborted' }, 'warn');
    const k = c.m.snapshot().day.counts;
    expect([k.sttCloudFail, k.sttRateLimited]).toEqual([2, 1]);
  });
});

describe('the logger feeding it', () => {
  it('hands every line to the observer, and a throwing one breaks nothing', () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const log = createLogger('info', (l) => lines.push(l), (_level, msg) => {
      seen.push(msg);
      throw new Error('boom');
    });
    log.info('answered', { costUsd: 0.1 });
    log.debug('below the level');
    log.warn('voice failed');
    expect(seen).toEqual(['answered', 'voice failed']);
    expect(lines).toHaveLength(2);
  });

  it('counts on log lines that the service itself still writes', () => {
    const src = join(import.meta.dirname, '..', 'src');
    // The proof of concept and the benches aren't the service: a copy of a line there proves nothing.
    const notService = new Set([join(src, 'poc'), join(src, 'bench'), join(src, 'web', 'metrics.ts')]);
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (notService.has(p)) return [];
        return statSync(p).isDirectory() ? files(p) : f.endsWith('.ts') ? [p] : [];
      });
    const code = files(src).map((f) => readFileSync(f, 'utf8')).join('\n');
    const esc = (m: string) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    for (const msg of Object.values(WATCHED)) expect(code, msg).toMatch(new RegExp(`\\.(?:debug|info|warn|error)\\(\\s*'${esc(msg)}'`));
  });
});

describe('memory', () => {
  it('stays the same size whatever it is fed', () => {
    const dir = tmp('adrian-metrics-');
    const file = join(dir, 'dashboard.json');
    const c = clocked({ file, version: '1.0.0' });
    const before = c.m.bytes();
    const huge = 'x'.repeat(10_000);
    for (let i = 0; i < 300_000; i++) {
      c.step(37_000); // about 4.5 months of answers, one every 37 s
      c.answer(500 + (i % 9000), { room: i % 2 ? 'discord' : `sat:${i}`, sttLatencyMs: i % 300, groqMs: i % 700, llmFirstChunkMs: i % 5000, costUsd: 0.0011 });
      if (i % 2 === 0) c.m.noteCall('tavily', 200);
      if (i % 30 !== 0) continue;
      // Every line different, and long: nothing may grow with them.
      c.log('some warning', { error: `${huge}${i}`, user: String(1e17 + i) }, 'warn');
      c.log(`warning number ${i} ${huge}`, {}, 'error');
      c.log('satellite connected', { device: `pc-${i}-${huge}` });
      c.log('satellite disconnected', { device: `pc-${i - 60}-${huge}` });
      c.log('voice stack failed to start', { error: `${i}${huge}` }, 'error');
    }
    expect(c.m.bytes()).toEqual(before);
    const s = c.m.snapshot();
    expect(s.errors.length).toBeLessThanOrEqual(20);
    expect(s.restarts.length).toBeLessThanOrEqual(12);
    for (const e of s.errors) expect((e.msg + (e.detail ?? '')).length).toBeLessThanOrEqual(320);
    c.m.flush();
    const size = statSync(file).size;
    // The histograms (base64) and the rings at their longest.
    expect(size).toBeLessThan(120_000);
    // 32 slots: 11 histograms of 96 two-byte bins, 19 counters, a key.
    expect(before.fixed).toBe(32 * (11 * 96 * 2 + 19 * 8 + 8));
    expect(before.fixed + before.ringsMax).toBeLessThan(128 * 1024);
  });
});

// --- what the page is told -----------------------------------------------------

const SYS: SystemInfo = { diskFreeGiB: 40, diskTotalGiB: 100, memAvailableMiB: 8000, memTotalMiB: 16000, rssMiB: 1500, memLimitMiB: 5120 };

function input(over: Partial<DashboardInput> = {}, feed?: (c: ReturnType<typeof clocked>) => void): DashboardInput {
  const c = clocked();
  feed?.(c);
  const ledger = new UsageLedger(undefined, { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, 'UTC', () => T0);
  return {
    metrics: c.m.snapshot(),
    spend: ledger.summary(),
    config: undefined,
    secretNames: [],
    stateDir: tmp('adrian-dash-'),
    timezone: 'UTC',
    version: '0.17.1',
    stackState: 'running',
    voiceReady: true,
    system: SYS,
    release: { latest: null, checkedAt: null, error: null },
    docker: false,
    now: T0,
    ...over,
  };
}
const texts = (i: DashboardInput) => buildDashboard(i).attention.map((a) => `${a.level}: ${a.text}`);

describe('needs attention', () => {
  it('is empty on a quiet day', () => {
    expect(texts(input())).toEqual([]);
  });

  it('names caps near or at their limit', () => {
    const ledger = new UsageLedger(undefined, { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, 'UTC', () => T0);
    ledger.addCost(0.85);
    expect(texts(input({ spend: ledger.summary() }))).toEqual(['warn: 85% of the daily spending cap is used ($0.85 of $1.00).']);
    ledger.addCost(0.2);
    expect(texts(input({ spend: ledger.summary() }))[0]).toMatch(/^bad: The daily spending cap is reached \(\$1\.05 of \$1\.00\)/);
  });

  it('names the cloud voice and search quotas', () => {
    const i = input({
      config: {
        cloudVoice: { enabled: true, apiKeySecret: 'SPEECHIFY_API_KEY', monthlyChars: 100_000 },
        cloudStt: { enabled: false, apiKeySecret: 'GROQ_API_KEY' },
        brain: { search: { apiKeySecret: 'TAVILY_API_KEY' } },
      } as never,
      secretNames: ['SPEECHIFY_API_KEY', 'TAVILY_API_KEY'],
    });
    writeFileSync(join(i.stateDir, 'voice-usage.json'), JSON.stringify({ version: 1, months: { '2026-11': 91_000, '2026-10': 5 } }));
    i.metrics.calls.month.tavily = 850;
    const d = buildDashboard(i);
    expect(d.providers.cloudVoice).toMatchObject({ on: true, monthChars: 91_000, monthlyChars: 100_000 });
    expect(d.attention.map((a) => a.text)).toEqual([
      'The cloud voice has used 91% of its characters for this month (91,000 of 100,000).',
      "850 web searches this month. Tavily's free plan has 1,000; past that, searches fail until next month unless the plan is bigger.",
    ]);
  });

  it('names a voice link that is down, fallbacks and failures', () => {
    const i = input({}, (c) => {
      c.log('primary LLM failed; using fallback', { error: 'HTTP 529' }, 'warn');
      c.log('cloud voice failed; local voice for a minute', { status: 503 }, 'warn');
      c.log('cloud speech-to-text failed; using local words', { error: 'Groq STT HTTP 429' }, 'warn');
      c.answer(null, { outcome: 'timed out' });
      c.log('voice disconnected', {}, 'warn');
      c.step(120_000);
    });
    expect(texts(i)).toEqual([
      "bad: The voice connection dropped 2 min ago and isn't back yet.",
      'warn: The main language model failed 1 time in the last day; the fallback answered instead.',
      'warn: 1 answer failed or timed out in the last day. The errors below say why.',
      'warn: The cloud voice failed 1 time in the last day; the local voice stood in.',
      'warn: Groq rate-limited the second listen 1 time in the last day; she used her own words meanwhile.',
    ]);
  });

  it('names low disk and memory, and memory near the service cap', () => {
    expect(texts(input({ system: { ...SYS, diskFreeGiB: 0.6, memAvailableMiB: 200, rssMiB: 4600 } }))).toEqual([
      "bad: Only 0.6 GiB of disk is free where she keeps her data. Updates need about 0.5 GB, and saving stops when it's full.",
      'bad: Memory is nearly full: 200 MiB available of 16000 MiB.',
      'warn: She is using 4600 MiB of the 5120 MiB the service may use; near the cap it slows down, then restarts.',
    ]);
  });

  it('names an available, failed or cut-off update', () => {
    const dir = tmp('adrian-upd-');
    const updatePaths = { failed: join(dir, 'failed'), inProgress: join(dir, 'mark'), timer: join(dir, 'timer') };
    const release = { latest: '0.18.0', checkedAt: 'now', error: null };
    expect(texts(input({ release, updatePaths }))).toEqual(['warn: Version 0.18.0 is available (this is 0.17.1). To install it, run: sudo adrian update.']);
    writeFileSync(updatePaths.timer, '');
    expect(texts(input({ release, updatePaths }))[0]).toContain('Auto-update installs it when nobody is in her call.');
    expect(texts(input({ release, updatePaths, docker: true }))[0]).toContain('is available');
    writeFileSync(updatePaths.failed, '0.18.0\n');
    writeFileSync(updatePaths.inProgress, '0.17.1 0.18.0 switched\n');
    expect(texts(input({ release, updatePaths }))).toEqual([
      'warn: An update was cut off before it finished. To finish or undo it, run: sudo adrian update.',
      'warn: The update to 0.18.0 failed its checks here and was undone. Auto-update tries it again after a day.',
    ]);
    expect(texts(input({ release: { ...release, latest: '0.17.1' } }))).toEqual([]);
  });

  it('is a pure function of what it is given', () => {
    const i = input();
    expect(attention(i, buildDashboard(i).providers, buildDashboard(i).updates)).toEqual([]);
  });
});

describe('the release check', () => {
  it('asks GitHub at most every 6 hours, and again an hour after a failure', async () => {
    let now = T0;
    const asked: string[] = [];
    let fail = true;
    const f = (async (url: string) => {
      asked.push(String(url));
      return fail ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ tag_name: 'v0.18.0' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = new ReleaseCheck('owner/repo', f, () => now);
    expect(r.get().latest).toBeNull();
    await r.settled();
    expect(r.get()).toMatchObject({ latest: null, error: 'GitHub answered 503' });
    fail = false;
    now += 30 * 60_000;
    r.get();
    await r.settled();
    expect(asked).toHaveLength(1);
    now += 31 * 60_000;
    r.get();
    await r.settled();
    expect(r.get()).toMatchObject({ latest: '0.18.0', error: null });
    now += 5 * H;
    r.get();
    await r.settled();
    expect(asked).toEqual(['https://api.github.com/repos/owner/repo/releases/latest', 'https://api.github.com/repos/owner/repo/releases/latest']);
  });

  it('compares versions', () => {
    expect(newer('0.18.0', '0.17.1')).toBe(true);
    expect(newer('0.17.10', '0.17.9')).toBe(true);
    expect(newer('0.17.1', '0.17.1')).toBe(false);
    expect(newer('0.17.0', '0.17.1')).toBe(false);
    expect(newer('v1.0.0', '0.99.99')).toBe(true);
  });
});

describe('temp folders', () => {
  it('leaves none of the ones made above behind', () => {
    expect(made.length).toBeGreaterThan(4);
    expect(made.filter((d) => existsSync(d))).toEqual([]);
  });
});
