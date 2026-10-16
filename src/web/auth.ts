// Admin authentication: a one-time setup code claims the single admin
// account (argon2id hash), then password login with per-IP and global rate
// limits, in-memory sessions and a per-session CSRF token.

import { hash, verify } from '@node-rs/argon2';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from './secrets-file.js';

// OWASP minimum for argon2id: 19 MiB, 2 passes, 1 lane.
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const SETUP_CODE_TTL_MS = 60 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

interface AdminRecord {
  username: string;
  hash: string;
  createdAt: string;
}

export interface Session {
  username: string;
  csrf: string;
  created: number;
  lastSeen: number;
}

export function validPassword(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 10 && p.length <= 256;
}

export function validUsername(u: unknown): u is string {
  return typeof u === 'string' && /^[A-Za-z0-9._-]{2,32}$/.test(u);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sliding-window failure counter. */
class Window {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  blocked(key: string, now: number): boolean {
    const h = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.hits.set(key, h);
    return h.length >= this.max;
  }
  hit(key: string, now: number): void {
    const h = this.hits.get(key) ?? [];
    h.push(now);
    this.hits.set(key, h);
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}

export class AdminAuth {
  private readonly adminFile: string;
  private readonly codeFile: string;
  private readonly sessions = new Map<string, Session>();
  private readonly perIp = new Window(5, 15 * 60_000);
  private readonly global = new Window(30, 15 * 60_000);
  private readonly codeTries = new Window(10, 15 * 60_000);

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
    private readonly sessionIdleMs = 12 * 3_600_000,
    private readonly sessionMaxMs = 7 * 24 * 3_600_000,
  ) {
    this.adminFile = join(stateDir, 'admin.json');
    this.codeFile = join(stateDir, 'setup-code');
  }

  hasAdmin(): boolean {
    return !!readJsonFile<AdminRecord>(this.adminFile)?.hash;
  }

  /** Make sure an unexpired setup code exists while there is no admin.
   *  Returns the code file path (the code itself is read by the CLI). */
  ensureSetupCode(): string | undefined {
    if (this.hasAdmin()) return undefined;
    const cur = readJsonFile<{ code: string; expiresAt: number }>(this.codeFile);
    if (!cur || cur.expiresAt <= this.now()) this.newSetupCode();
    return this.codeFile;
  }

  newSetupCode(): string {
    let s = '';
    for (let i = 0; i < 10; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `${s.slice(0, 5)}-${s.slice(5)}`;
    writeJsonFile(this.codeFile, { code, expiresAt: this.now() + SETUP_CODE_TTL_MS });
    return code;
  }

  /** Claim the admin account with the setup code. */
  async claim(
    ip: string,
    code: unknown,
    username: unknown,
    password: unknown,
  ): Promise<{ ok: true; token: string; session: Session } | { ok: false; status: number; error: string }> {
    const now = this.now();
    if (this.hasAdmin()) return { ok: false, status: 404, error: 'not found' };
    if (this.codeTries.blocked('setup', now)) return { ok: false, status: 429, error: 'too many attempts; try again later' };
    const cur = readJsonFile<{ code: string; expiresAt: number }>(this.codeFile);
    const given = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!cur || cur.expiresAt <= now || !sameText(given, cur.code)) {
      this.codeTries.hit('setup', now);
      if (this.codeTries.blocked('setup', now)) this.newSetupCode(); // burn the code
      return { ok: false, status: 403, error: 'setup code is wrong or expired' };
    }
    if (!validUsername(username)) return { ok: false, status: 400, error: 'username: 2-32 letters, digits, . _ -' };
    if (!validPassword(password)) return { ok: false, status: 400, error: 'password: at least 10 characters' };
    const rec: AdminRecord = { username, hash: await hash(password, ARGON), createdAt: new Date(now).toISOString() };
    writeJsonFile(this.adminFile, rec);
    if (existsSync(this.codeFile)) unlinkSync(this.codeFile);
    void ip;
    return { ok: true, ...this.createSession(username) };
  }

  async login(
    ip: string,
    username: unknown,
    password: unknown,
  ): Promise<{ ok: true; token: string; session: Session } | { ok: false; status: number; error: string }> {
    const now = this.now();
    if (this.perIp.blocked(ip, now) || this.global.blocked('all', now)) {
      return { ok: false, status: 429, error: 'too many failed logins; try again in 15 minutes' };
    }
    const rec = readJsonFile<AdminRecord>(this.adminFile);
    let good = false;
    if (rec && typeof username === 'string' && typeof password === 'string' && password.length <= 256) {
      // Always run the hash check so timing doesn't reveal the username.
      const pwOk = await verify(rec.hash, password).catch(() => false);
      good = pwOk && sameText(username, rec.username);
    }
    if (!good) {
      this.perIp.hit(ip, now);
      this.global.hit('all', now);
      return { ok: false, status: 401, error: 'wrong username or password' };
    }
    this.perIp.clear(ip);
    return { ok: true, ...this.createSession(rec!.username) };
  }

  async changePassword(username: string, current: unknown, next: unknown): Promise<string | undefined> {
    const rec = readJsonFile<AdminRecord>(this.adminFile);
    if (!rec || rec.username !== username || typeof current !== 'string') return 'not allowed';
    if (!(await verify(rec.hash, current).catch(() => false))) return 'current password is wrong';
    if (!validPassword(next)) return 'password: at least 10 characters';
    writeJsonFile(this.adminFile, { ...rec, hash: await hash(next, ARGON) });
    this.sessions.clear();
    return undefined;
  }

  private createSession(username: string): { token: string; session: Session } {
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const session: Session = { username, csrf: randomBytes(24).toString('base64url'), created: now, lastSeen: now };
    this.sessions.set(token, session);
    return { token, session };
  }

  session(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    const now = this.now();
    if (now - s.lastSeen > this.sessionIdleMs || now - s.created > this.sessionMaxMs) {
      this.sessions.delete(token);
      return undefined;
    }
    s.lastSeen = now;
    return s;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
