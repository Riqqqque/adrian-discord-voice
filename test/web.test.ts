import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StackManager } from '../src/app/manager.js';
import { createLogger } from '../src/core/logger.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import { AdminAuth } from '../src/web/auth.js';
import { SecretsFile } from '../src/web/secrets-file.js';
import { createAdminServer } from '../src/web/server.js';

// Fake values with the real prefixes, so the redaction patterns are tested.
const FAKE = {
  // Token-shaped test value, assembled so secret scanners don't flag it.
  DISCORD_TOKEN: ['MTAwMDAwMDAwMDAwMDAwMDMw', 'Gabcde', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12'].join('.'),
  GROQ_API_KEY: 'gsk_testtesttesttesttesttest1234',
  GEMINI_API_KEY: 'AIzaTESTtestTESTtestTESTtest12345',
  TAVILY_API_KEY: 'tvly-testtesttesttest1234',
};

const dir = mkdtempSync(join(tmpdir(), 'adrian-web-'));
const stateDir = join(dir, 'state');
const webDir = join(dir, 'web');
mkdirSync(webDir, { recursive: true });
mkdirSync(join(dir, 'web-evil'), { recursive: true });
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>A.D.R.I.A.N.</title>');
writeFileSync(join(dir, 'web-evil', 'x.html'), 'secret');
const configFile = join(dir, 'config.json');
writeFileSync(configFile, '{}');
const secrets = new SecretsFile(join(dir, 'secrets.env'));
const logLines: string[] = [];
const log = createLogger('debug', (l) => logLines.push(l));
const auth = new AdminAuth(stateDir);
const ledger = new UsageLedger(undefined, { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, 'UTC');

let restarts = 0;
const stack = {
  state: 'setup',
  error: undefined,
  current: undefined,
  uptimeS: null,
  rawConfig: () => JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>,
  problems: () => ['Discord bot token is not set'],
  restart: async () => {
    restarts++;
    return 'setup';
  },
} as unknown as StackManager;

// Fake upstreams: record what each one was sent.
const upstream: { url: string; auth: string | null }[] = [];
const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const h = new Headers(init?.headers);
  upstream.push({ url, auth: h.get('authorization') });
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('discord.com')) {
    if (h.get('authorization') !== `Bot ${FAKE.DISCORD_TOKEN}`) return new Response('{}', { status: 401 });
    if (url.endsWith('/users/@me')) return ok({ id: '1', username: 'A.D.R.I.A.N.', discriminator: '0671' });
    if (url.endsWith('/oauth2/applications/@me')) return ok({ id: '100000000000000030', bot_public: false });
    if (url.endsWith('/users/@me/guilds')) return ok([{ id: '100000000000000010', name: 'Test' }]);
    if (url.endsWith('/channels')) return ok([{ id: '100000000000000020', name: 'general', type: 2 }, { id: '2', name: 'text', type: 0 }]);
  }
  if (url.includes('groq.com')) {
    if (h.get('authorization') !== `Bearer ${FAKE.GROQ_API_KEY}`) return new Response('{}', { status: 401 });
    return ok({ choices: [{ message: { content: 'Two plus two is four.' } }] });
  }
  if (url.includes('tavily.com')) return ok({ results: [{}] });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

const server = createAdminServer({
  paths: { configFile, secretsFile: secrets.path, stateDir, modelsDir: join(dir, 'models'), webDir },
  version: '0.1.0-test',
  log,
  auth,
  secrets,
  ledger,
  stack,
  voicePreview: async () => Buffer.from('RIFF'),
  fetch: fakeFetch,
});
let base = '';
let host = '';
let cookie = '';
let csrf = '';
const bodies: string[] = [];

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...extra };
  if (method !== 'GET') {
    headers.origin ??= `http://${host}`;
    if (csrf && !('x-csrf-token' in extra)) headers['x-csrf-token'] = csrf;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  bodies.push(text);
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* static */
  }
  return { status: r.status, data, text, headers: r.headers };
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
});
afterAll(() => {
  server.close();
});

describe('admin web server', () => {
  it('serves health without login and refuses the API without a session', async () => {
    const h = await call('GET', '/api/health');
    expect(h.status).toBe(200);
    expect(h.data.state).toBe('setup');
    expect(h.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(h.headers.get('x-frame-options')).toBe('DENY');
    expect((await call('GET', '/api/status')).status).toBe(401);
    expect((await call('GET', '/api/secrets')).status).toBe(401);
  });

  it('serves the page but nothing outside web/', async () => {
    expect((await call('GET', '/')).text).toContain('A.D.R.I.A.N.');
    expect((await call('GET', '/../web-evil/x.html')).status).toBe(404);
    expect((await call('GET', '/%2e%2e/web-evil/x.html')).status).toBe(404);
    expect((await call('GET', '/../config.json')).status).toBe(404);
  });

  it('claims the admin account only with the setup code, once', async () => {
    auth.ensureSetupCode();
    const code = (JSON.parse(readFileSync(join(stateDir, 'setup-code'), 'utf8')) as { code: string }).code;
    expect((await call('GET', '/api/session')).data.setupNeeded).toBe(true);
    expect((await call('POST', '/api/setup/claim', { code: 'WRONG-CODE0', username: 'rique', password: 'correct horse battery' })).status).toBe(403);
    // Cross-origin claim refused even with the right code.
    expect((await call('POST', '/api/setup/claim', { code, username: 'rique', password: 'correct horse battery' }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/setup/claim', { code, username: 'rique', password: 'short' })).status).toBe(400);
    const ok = await call('POST', '/api/setup/claim', { code, username: 'rique', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
    expect(ok.headers.get('set-cookie')).not.toMatch(/Secure/); // plain HTTP on loopback
    csrf = String(ok.data.csrf);
    const again = await call('POST', '/api/setup/claim', { code, username: 'x', password: 'correct horse battery' });
    expect(again.status).toBe(404);
    expect(readFileSync(join(stateDir, 'admin.json'), 'utf8')).toContain('$argon2id$');
  });

  it('requires the CSRF token and same origin for changes', async () => {
    expect((await call('PUT', '/api/secrets/GROQ_API_KEY', { value: FAKE.GROQ_API_KEY }, { 'x-csrf-token': 'nope' })).status).toBe(403);
    expect((await call('PUT', '/api/secrets/GROQ_API_KEY', { value: FAKE.GROQ_API_KEY }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call('PUT', '/api/secrets/GROQ_API_KEY', { value: FAKE.GROQ_API_KEY }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(secrets.has('GROQ_API_KEY')).toBe(false);
  });

  it('stores secrets write-only', async () => {
    for (const [k, v] of Object.entries(FAKE)) {
      if (k === 'DISCORD_TOKEN') continue;
      expect((await call('PUT', `/api/secrets/${k}`, { value: v })).status).toBe(200);
    }
    const list = await call('GET', '/api/secrets');
    expect(list.data.secrets).toEqual(
      expect.arrayContaining([{ name: 'GROQ_API_KEY', configured: true }, { name: 'TAVILY_API_KEY', configured: true }]),
    );
    expect((await call('PUT', '/api/secrets/bad-name', { value: 'x' })).status).toBe(404);
    expect((await call('PUT', '/api/secrets/OTHER', { value: 'a\nB=c' })).status).toBe(400);
  });

  it('verifies a Discord token before saving it and only sends it to Discord', async () => {
    const bad = await call('POST', '/api/check/discord', { token: 'x'.repeat(59) + '.abcdef.' + 'y'.repeat(27) });
    expect(bad.data.ok).toBe(false);
    expect(secrets.has('DISCORD_TOKEN')).toBe(false);
    const good = await call('POST', '/api/check/discord', { token: FAKE.DISCORD_TOKEN });
    expect(good.data).toMatchObject({ ok: true, botTag: 'A.D.R.I.A.N.#0671', publicBot: false });
    expect(String(good.data.inviteUrl)).toContain('permissions=36701184');
    expect(secrets.has('DISCORD_TOKEN')).toBe(true);
    const ch = await call('GET', '/api/check/channels?guild=100000000000000010');
    expect(ch.data.channels).toEqual([{ id: '100000000000000020', name: 'general' }]);
    for (const u of upstream) {
      if (u.auth?.includes(FAKE.DISCORD_TOKEN)) expect(u.url.startsWith('https://discord.com/')).toBe(true);
      if (u.auth?.includes(FAKE.GROQ_API_KEY)) expect(u.url.startsWith('https://api.groq.com/')).toBe(true);
    }
  });

  it('tests the LLM with the stored key and reports cost', async () => {
    const r = await call('POST', '/api/check/llm', { preset: 'groq' });
    expect(r.data).toMatchObject({ ok: true, reply: 'Two plus two is four.' });
    expect(Number(r.data.estCostPerAnswerUsd)).toBeGreaterThan(0);
    const wrong = await call('POST', '/api/check/llm', { preset: 'groq', key: 'gsk_wrongwrongwrongwrong' });
    expect(wrong.data.ok).toBe(false);
    expect(secrets.read().get('GROQ_API_KEY')).toBe(FAKE.GROQ_API_KEY); // bad key not saved
  });

  it('applies settings without letting the browser set file paths', async () => {
    const bad = await call('PUT', '/api/settings', { voice: { voice: 'am_michael', speed: 1 }, secretsFile: '/etc/shadow' });
    expect(bad.status).toBe(400);
    const r = await call('PUT', '/api/settings', {
      guildId: '100000000000000010',
      channelId: '100000000000000020',
      timezone: 'America/Denver',
      llm: { preset: 'groq' },
      fallback: { preset: 'gemini' },
      search: true,
      voice: { voice: 'am_michael', speed: 1 },
      limits: { perUserPerHour: 20, dailyUsd: 0.5, monthlyUsd: 5, maxRequestChars: 600 },
    });
    expect(r.status).toBe(200);
    const saved = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
    expect(saved.secretsFile).toBe(secrets.path);
    expect(saved.brain).toMatchObject({ model: 'openai/gpt-oss-120b', apiKeySecret: 'GROQ_API_KEY', search: { apiKeySecret: 'TAVILY_API_KEY' } });
    expect(saved.brain.fallback).toMatchObject({ model: 'gemini-3.1-flash-lite', apiKeySecret: 'GEMINI_API_KEY' });
    expect(saved.limits.usageFile).toBe(join(stateDir, 'usage.json'));
    expect(saved.voice.modelDir).toContain('kokoro-multi-lang-v1_0');
    expect((await call('PUT', '/api/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await call('POST', '/api/restart', {})).status).toBe(200);
    expect(restarts).toBe(1);
  });

  it('never returns or logs a secret value', async () => {
    // Touch every GET endpoint once more.
    for (const p of ['/api/status', '/api/settings', '/api/secrets', '/api/logs', '/api/session', '/api/health']) {
      expect((await call('GET', p)).status).toBe(200);
    }
    // A careless log call is still redacted.
    log.warn('oops', { key: FAKE.GROQ_API_KEY, token: FAKE.DISCORD_TOKEN });
    const logs = await call('GET', '/api/logs');
    const everything = [...bodies, ...logLines, logs.text].join('\n');
    for (const v of Object.values(FAKE)) expect(everything).not.toContain(v);
    expect(everything).not.toContain('$argon2id$');
    expect(logLines.join('\n')).toContain('[redacted]');
  });

  it('rate limits failed logins per client', async () => {
    await call('POST', '/api/logout', {});
    cookie = '';
    csrf = '';
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/login', { username: 'rique', password: 'wrong password!' })).status).toBe(401);
    expect((await call('POST', '/api/login', { username: 'rique', password: 'correct horse battery' })).status).toBe(429);
  });
});
