import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdminAuth } from '../src/web/auth.js';

// The real argon2, plus a count of the guesses that reach it and a one-shot
// gate that keeps one verify unfinished while the test does something else.
const argon = vi.hoisted(() => ({ verifies: 0, hold: undefined as Promise<void> | undefined }));
vi.mock('@node-rs/argon2', async (original) => {
  const real = await original<typeof import('@node-rs/argon2')>();
  return {
    ...real,
    verify: async (...args: Parameters<typeof real.verify>) => {
      argon.verifies++;
      const hold = argon.hold;
      argon.hold = undefined;
      const ok = await real.verify(...args);
      await hold;
      return ok;
    },
  };
});

const USER = 'owner';
const PASSWORD = 'correct horse battery';
const NEXT = 'a brand new password';
const WRONG = 'not the password';
const WRONG_CODE = 'WRONG-CODE0';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'adrian-auth-'));
  const clock = { now: 1_000_000 };
  return { dir, clock, auth: new AdminAuth(dir, () => clock.now) };
}

/** A claimed account, logged out, and a clock the test moves by hand. */
async function account() {
  const f = fresh();
  const claimed = await f.auth.claim('10.0.0.1', f.auth.newSetupCode(), USER, PASSWORD);
  if (!claimed.ok) throw new Error(claimed.error);
  f.auth.logout(claimed.token);
  argon.verifies = 0;
  return f;
}

const statusOf = (r: { ok: true } | { ok: false; status: number }) => (r.ok ? 200 : r.status);
const tally = (statuses: number[]) => statuses.reduce<Record<number, number>>((n, s) => ({ ...n, [s]: (n[s] ?? 0) + 1 }), {});
const codeOnDisk = (dir: string) => (JSON.parse(readFileSync(join(dir, 'setup-code'), 'utf8')) as { code: string }).code;

async function burst(auth: AdminAuth, n: number, ip: (i: number) => string) {
  const all = await Promise.all(Array.from({ length: n }, (_, i) => auth.login(ip(i), USER, WRONG)));
  return tally(all.map(statusOf));
}

describe('login limits', () => {
  it('counts a burst of guesses before checking any of them', async () => {
    const { auth } = await account();
    expect(await burst(auth, 20, () => '10.0.0.9')).toEqual({ 401: 5, 429: 15 });
    expect(argon.verifies).toBe(5);
    expect((await auth.login('10.0.0.8', USER, PASSWORD)).ok).toBe(true);
  });

  it('holds a burst from many addresses to the overall limit', async () => {
    const { auth } = await account();
    expect(await burst(auth, 40, (i) => `10.0.1.${i}`)).toEqual({ 401: 30, 429: 10 });
    expect(argon.verifies).toBe(30);
  });

  it('never counts a good login against the overall limit', { timeout: 30_000 }, async () => {
    const { auth } = await account();
    for (let i = 0; i < 31; i++) expect((await auth.login(`10.0.2.${i}`, USER, PASSWORD)).ok).toBe(true);
  });

  it('lets the owner back in soon after failures from the same address', async () => {
    const { auth, clock } = await account();
    for (let i = 0; i < 5; i++) await auth.login('127.0.0.1', USER, WRONG);
    expect(statusOf(await auth.login('127.0.0.1', USER, PASSWORD))).toBe(429);
    clock.now += 11_000;
    expect((await auth.login('127.0.0.1', USER, PASSWORD)).ok).toBe(true);
  });

  it('lets the owner back in soon after failures from everywhere else', async () => {
    const { auth, clock } = await account();
    await burst(auth, 30, (i) => `10.0.3.${i}`);
    expect(statusOf(await auth.login('10.0.0.8', USER, PASSWORD))).toBe(429);
    clock.now += 11_000;
    expect((await auth.login('10.0.0.8', USER, PASSWORD)).ok).toBe(true);
  });

  it('over the limit, lets one try through every 10 seconds, shared by everyone', async () => {
    const { auth, clock } = await account();
    await burst(auth, 30, (i) => `10.0.4.${i}`);
    argon.verifies = 0;
    clock.now += 11_000;
    expect(await burst(auth, 5, (i) => `10.0.5.${i}`)).toEqual({ 401: 1, 429: 4 });
    clock.now += 5_000;
    expect(await burst(auth, 5, (i) => `10.0.5.${i}`)).toEqual({ 429: 5 });
    clock.now += 6_000;
    expect(await burst(auth, 5, (i) => `10.0.5.${i}`)).toEqual({ 401: 1, 429: 4 });
    expect(argon.verifies).toBe(2);
  });

  it('gives no session to a login in flight when the password changes', async () => {
    const { auth } = await account();
    let open = () => {};
    argon.hold = new Promise((r) => (open = r));
    const late = auth.login('10.0.0.9', USER, PASSWORD);
    expect(await auth.changePassword(USER, PASSWORD, NEXT)).toBeUndefined();
    open();
    const r = await late;
    expect(statusOf(r)).toBe(401);
    expect(r.ok && auth.session(r.token)).toBeFalsy();
    expect((await auth.login('10.0.0.8', USER, NEXT)).ok).toBe(true);
  });
});

describe('setup code limits', () => {
  async function failTen(auth: AdminAuth, ip: string) {
    const all = await Promise.all(Array.from({ length: 10 }, () => auth.claim(ip, WRONG_CODE, USER, PASSWORD)));
    expect(all.map(statusOf)).toEqual(Array(10).fill(403));
  }

  it('blocks and burns on one address without shutting out the others', async () => {
    const { dir, auth } = fresh();
    const first = auth.newSetupCode();
    await failTen(auth, '10.0.0.9');
    expect(statusOf(await auth.claim('10.0.0.9', WRONG_CODE, USER, PASSWORD))).toBe(429);
    const burned = codeOnDisk(dir);
    expect(burned).not.toBe(first);
    expect(statusOf(await auth.claim('10.0.0.8', first, USER, PASSWORD))).toBe(403);
    expect((await auth.claim('10.0.0.8', burned, USER, PASSWORD)).ok).toBe(true);
  });

  it('keeps an address blocked through the code the service burned itself', async () => {
    const { dir, auth } = fresh();
    auth.newSetupCode();
    await failTen(auth, '127.0.0.1');
    expect(statusOf(await auth.claim('127.0.0.1', codeOnDisk(dir), USER, PASSWORD))).toBe(429);
  });

  it('gives a new code from the command line a fresh start', async () => {
    const { dir, clock, auth } = fresh();
    auth.newSetupCode();
    await failTen(auth, '127.0.0.1');
    const code = new AdminAuth(dir, () => clock.now).newSetupCode();
    expect((await auth.claim('127.0.0.1', code, USER, PASSWORD)).ok).toBe(true);
  });
});

describe('password change limits', () => {
  it('takes five wrong guesses, then refuses even the right password', async () => {
    const { auth, clock } = await account();
    for (let i = 0; i < 5; i++) expect(await auth.changePassword(USER, WRONG, NEXT)).toEqual({ status: 400, error: 'current password is wrong' });
    expect((await auth.changePassword(USER, PASSWORD, NEXT))?.status).toBe(429);
    clock.now += 15 * 60_000 + 1;
    expect(await auth.changePassword(USER, PASSWORD, NEXT)).toBeUndefined();
  });

  it('counts guesses made at once', async () => {
    const { auth } = await account();
    const all = await Promise.all(Array.from({ length: 8 }, () => auth.changePassword(USER, WRONG, NEXT)));
    expect(tally(all.map((r) => r?.status ?? 200))).toEqual({ 400: 5, 429: 3 });
    expect(argon.verifies).toBe(5);
  });

  it('starts the count again after the right password', async () => {
    const { auth } = await account();
    for (let i = 0; i < 4; i++) await auth.changePassword(USER, WRONG, NEXT);
    expect((await auth.changePassword(USER, PASSWORD, 'short'))?.error).toContain('at least 10');
    for (let i = 0; i < 4; i++) await auth.changePassword(USER, WRONG, NEXT);
    expect(await auth.changePassword(USER, PASSWORD, NEXT)).toBeUndefined();
  });

  it('does not run the hash on a password longer than any allowed', async () => {
    const { auth } = await account();
    expect((await auth.changePassword(USER, 'x'.repeat(257), NEXT))?.status).toBe(400);
    expect(argon.verifies).toBe(0);
  });
});
