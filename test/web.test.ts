import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StackManager } from '../src/app/manager.js';
import { createLogger } from '../src/core/logger.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import { AdminAuth } from '../src/web/auth.js';
import { SecretsFile } from '../src/web/secrets-file.js';
import { createAdminServer } from '../src/web/server.js';
import { Metrics } from '../src/web/metrics.js';
import { applySettings, type SettingsPatch } from '../src/web/settings.js';

// Fake values with the real prefixes, so the redaction patterns are tested.
const FAKE = {
  // Token-shaped test value, assembled so secret scanners don't flag it.
  DISCORD_TOKEN: ['MTAwMDAwMDAwMDAwMDAwMDMw', 'Gabcde', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12'].join('.'),
  GROQ_API_KEY: 'gsk_testtesttesttesttesttest1234',
  GEMINI_API_KEY: 'AIzaTESTtestTESTtestTESTtest12345',
  TAVILY_API_KEY: 'tvly-testtesttesttest1234',
};
// An endpoint an attacker with a session might name, with a key they don't have.
const CUSTOM = { preset: 'custom', baseUrl: 'https://sink.example/v1', model: 'm', keySecret: 'GROQ_API_KEY', priceInPerM: 0, priceOutPerM: 0 };

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
const metrics = new Metrics();
const log = createLogger('debug', (l) => logLines.push(l), metrics.observe);
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
    if (url.endsWith('/guilds/100000000000000010')) return ok({ id: '100000000000000010', owner_id: '9', roles: [{ id: '100000000000000010', permissions: '0' }] });
    if (url.endsWith('/guilds/100000000000000010/members/1')) return ok({ roles: [] });
    if (url.endsWith('/channels/100000000000000020')) return ok({ id: '100000000000000020', name: 'general', type: 2, permission_overwrites: [] });
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
  metrics,
  updatePaths: { failed: join(dir, 'update-failed'), inProgress: join(dir, 'update-in-progress'), timer: join(dir, 'timer') },
  docker: false, // the same answers on a build machine that happens to be a container
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
    expect((await call('GET', '/api/dashboard')).status).toBe(401);
  });

  it('health says when a start waits for memory, as packaging/adrian looks for it', async () => {
    const s = stack as unknown as { state: string; waitingFor?: string };
    s.state = 'starting';
    s.waitingFor = 'memory';
    try {
      const h = await call('GET', '/api/health');
      expect(h.status).toBe(200);
      expect(JSON.stringify(h.data)).toContain('"waitingFor":"memory"');
      expect(readFileSync(new URL('../packaging/adrian', import.meta.url), 'utf8')).toContain(`'"waitingFor":"memory"'`);
    } finally {
      s.state = 'setup';
      delete s.waitingFor;
    }
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
    const wrong = await call('POST', '/api/setup/claim', { code: 'WRONG-CODE0', username: 'rique', password: 'correct horse battery' });
    expect(wrong.status).toBe(403);
    // Says where the right one is: the code is printed once, at install.
    expect(wrong.data.error).toContain('sudo adrian setup-code');
    expect((await call('GET', '/api/session')).data.setupCodeCommand).toBe('sudo adrian setup-code');
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
    expect(String(good.data.inviteUrl)).toContain('permissions=274914675712');
    expect(secrets.has('DISCORD_TOKEN')).toBe(true);
    const ch = await call('GET', '/api/check/channels?guild=100000000000000010');
    expect(ch.data.channels).toEqual([{ id: '100000000000000020', name: 'general' }]);
    for (const u of upstream) {
      if (u.auth?.includes(FAKE.DISCORD_TOKEN)) expect(u.url.startsWith('https://discord.com/')).toBe(true);
      if (u.auth?.includes(FAKE.GROQ_API_KEY)) expect(u.url.startsWith('https://api.groq.com/')).toBe(true);
    }
  });

  it('saves a pasted "Bot ..." token the way Discord wants it', async () => {
    const r = await call('POST', '/api/check/discord', { token: `Bot ${FAKE.DISCORD_TOKEN}` });
    expect(r.data.ok).toBe(true);
    expect(secrets.read().get('DISCORD_TOKEN')).toBe(FAKE.DISCORD_TOKEN);
  });

  it("says when the bot can't speak in the chosen channel", async () => {
    const r = await call('GET', '/api/check/voice-access?guild=100000000000000010&channel=100000000000000020');
    expect(r.data.ok).toBe(false);
    expect(r.data.missing).toEqual(['View Channel', 'Connect', 'Speak']);
  });

  it("refuses another service's key without sending it anywhere", async () => {
    const before = upstream.length;
    const r = await call('POST', '/api/check/llm', { preset: 'groq', key: 'sk-ant-api03-notreal' });
    expect(r.data.ok).toBe(false);
    expect(String(r.data.error)).toContain('looks like an Anthropic (Claude) key');
    expect(upstream.length).toBe(before);
    expect(secrets.read().get('GROQ_API_KEY')).not.toBe('sk-ant-api03-notreal');
  });

  it('puts what to do beside a failed start', async () => {
    const s = stack as unknown as { state: string; error: string | undefined };
    s.state = 'failed';
    s.error = 'An invalid token was provided.';
    try {
      const r = await call('GET', '/api/status');
      expect(r.data.error).toBe('An invalid token was provided.');
      expect(String(r.data.fix)).toContain('Reset Token');
    } finally {
      s.state = 'setup';
      s.error = undefined;
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

  it('sends a custom endpoint only a key pasted for the test, never a stored one', async () => {
    const from = upstream.length;
    expect((await call('POST', '/api/check/llm', CUSTOM)).status).toBe(200);
    expect(upstream.slice(from)).toEqual([{ url: 'https://sink.example/v1/chat/completions', auth: null }]);
    await call('POST', '/api/check/llm', { ...CUSTOM, key: 'pasted-for-this-test' });
    expect(upstream.at(-1)).toEqual({ url: 'https://sink.example/v1/chat/completions', auth: 'Bearer pasted-for-this-test' });
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
      limits: { perUserPerHour: 20, dailyUsd: 0.5, monthlyUsd: 5, guestDailyUsd: 0.3, maxRequestChars: 600 },
    });
    expect(r.status).toBe(200);
    const saved = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, any>;
    expect(saved.secretsFile).toBe(secrets.path);
    expect(saved.brain).toMatchObject({ model: 'openai/gpt-oss-120b', apiKeySecret: 'GROQ_API_KEY', search: { apiKeySecret: 'TAVILY_API_KEY' } });
    expect(saved.brain.fallback).toMatchObject({ model: 'gemini-3.1-flash-lite', apiKeySecret: 'GEMINI_API_KEY' });
    expect(saved.limits.usageFile).toBe(join(stateDir, 'usage.json'));
    expect(saved.limits.guestDailyUsd).toBe(0.3);
    // A page that doesn't send it keeps what was set.
    expect((await call('PUT', '/api/settings', { limits: { perUserPerHour: 20, dailyUsd: 0.5, monthlyUsd: 5, maxRequestChars: 600 } })).status).toBe(200);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).limits.guestDailyUsd).toBe(0.3);
    expect(saved.voice.modelDir).toContain('kokoro-multi-lang-v1_0');
    expect((await call('PUT', '/api/settings', { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await call('POST', '/api/restart', {})).status).toBe(200);
    expect(restarts).toBe(1);
  });

  it('says which room each answer came from, and why the total reads higher now', async () => {
    const running = stack as unknown as { current: unknown };
    const answer = { at: 'now', room: 'sat:d1', outcome: 'finished', sttLatencyMs: 90, groqMs: 400, closedBy: 'vad', turnCheckMs: 120, holdMs: 0, llmFirstChunkMs: 2_000, ttsFirstMs: 500, speechEndToAudioMs: 4_850, costUsd: 0.001 };
    running.current = { answers: () => [answer], voiceReady: () => true, botTag: () => 'bot#0' };
    const r = await call('GET', '/api/status');
    running.current = undefined;
    const status = r.data as { latency: Record<string, unknown>; lastAnswers: unknown[] };
    expect(status.lastAnswers).toEqual([{ at: 'now', room: 'sat:d1', outcome: 'finished', speechEndToAudioMs: 4_850, costUsd: 0.001 }]);
    expect(status.latency.speechEndToAudio).toMatchObject({ p50: 4_850, n: 1 });
    expect(status.latency.note).toContain('about 1 s');
  });

  it('puts cost, speed, links and what went wrong on the dashboard, without IDs or secrets', async () => {
    // As the voice stack logs them: a user ID and a PC's name and address ride along.
    const user = '100000000000000099';
    log.info('answered', { user, room: 'sat:d1', outcome: 'finished', sttLatencyMs: 90, groqMs: 400, turnCheckMs: 120, holdMs: 0, llmFirstChunkMs: 900, ttsFirstMs: 300, speechEndToAudioMs: 1_850, costUsd: 0.002 });
    log.info('answered', { user, room: 'discord', outcome: 'error', speechEndToAudioMs: null, costUsd: 0 });
    log.info('satellite connected', { device: 'Desk PC', addr: '192.0.2.7' });
    log.warn('cloud voice failed; local voice for a minute', { status: 401, error: `speechify HTTP 401: key ${FAKE.GROQ_API_KEY} for ${user}` });
    writeFileSync(join(dir, 'update-failed'), '9.9.9\n');
    const r = await call('GET', '/api/dashboard');
    expect(r.status).toBe(200);
    const d = r.data as any;
    expect(d.answers.day).toMatchObject({ answers: 2, errors: 1 });
    expect(d.speed.day.total.n).toBe(1);
    expect(d.speed.day.pc.p50).toBeGreaterThan(1_850 * 0.9);
    expect(d.speed.day.pc.p50).toBeLessThan(1_850 * 1.1);
    expect(d.costPerAnswerUsd.day).toBe(0.001);
    expect(d.reliability.pcsOnline).toBe(1);
    expect(d.providers.llm).toMatchObject({ dailyCapUsd: 1, monthlyCapUsd: 10 });
    expect(d.errors[0]).toMatchObject({ msg: 'cloud voice failed; local voice for a minute', n: 1 });
    expect(d.updates.failedVersion).toBe('9.9.9');
    const said = d.attention.map((a: { text: string }) => a.text).join('\n');
    expect(said).toContain('1 answer failed or timed out in the last day');
    expect(said).toContain('The cloud voice failed 1 time in the last day');
    expect(said).toContain('The update to 9.9.9 failed its checks here');
    for (const leak of [user, 'Desk PC', '192.0.2.7', FAKE.GROQ_API_KEY]) expect(r.text).not.toContain(leak);
  });

  describe('a saved fallback', () => {
    const withConfig = async (config: unknown, run: () => Promise<void>) => {
      const before = readFileSync(configFile, 'utf8');
      writeFileSync(configFile, typeof config === 'string' ? config : JSON.stringify(config));
      try {
        await run();
      } finally {
        writeFileSync(configFile, before);
      }
    };

    it('warns on the status page when it has no key, without stopping the bot starting', async () => {
      await withConfig({ brain: { model: 'm', fallback: { model: 'spare-model', apiKeySecret: 'NOT_STORED_KEY' } } }, async () => {
        const r = await call('GET', '/api/status');
        expect(r.data.warnings).toEqual(['The fallback model (spare-model) has no key, so it will not be used. Save NOT_STORED_KEY on the Keys tab, or choose No fallback.']);
        expect(r.data.problems).toEqual(['Discord bot token is not set']); // not a reason to hold the bot back
      });
    });

    it('shows a brain with no preset as custom, and will not save an empty choice', async () => {
      await withConfig({ brain: { model: 'by-hand' } }, async () => {
        expect((await call('GET', '/api/settings')).data.settings).toMatchObject({ llm: { preset: 'custom', model: 'by-hand' } });
        expect((await call('PUT', '/api/settings', { llm: {} })).status).toBe(400);
      });
    });

    it('warns about nothing when its key is stored, it needs none, or there is none', async () => {
      for (const brain of [{ fallback: { model: 'spare', apiKeySecret: 'GROQ_API_KEY' } }, { fallback: { model: 'local' } }, {}]) {
        await withConfig({ brain }, async () => expect((await call('GET', '/api/status')).data.warnings).toEqual([]));
      }
    });

    it('keeps the status page up when the config cannot be read', async () => {
      await withConfig('{ not json', async () => {
        const r = await call('GET', '/api/status');
        expect(r.status).toBe(200);
        expect(r.data.warnings).toEqual([]);
      });
    });
  });

  it('will not point a stored key at a new address', async () => {
    const before = readFileSync(configFile, 'utf8');
    const groq = 'https://api.groq.com/openai/v1';
    const gemini = 'https://generativelanguage.googleapis.com/v1beta/openai';
    try {
      for (const patch of [{ llm: CUSTOM }, { fallback: CUSTOM }, { llm: { ...CUSTOM, baseUrl: gemini } }]) {
        const r = await call('PUT', '/api/settings', patch);
        expect(r.status).toBe(400);
        expect(r.data.error).toContain('sudo adrian config');
        expect(readFileSync(configFile, 'utf8')).toBe(before);
      }
      // A pair the config already has, and a local server that takes no key.
      expect((await call('PUT', '/api/settings', { llm: { ...CUSTOM, baseUrl: groq } })).status).toBe(200);
      expect((await call('PUT', '/api/settings', { fallback: { ...CUSTOM, baseUrl: 'http://127.0.0.1:11434/v1', keySecret: '' } })).status).toBe(200);
    } finally {
      writeFileSync(configFile, before);
    }
  });

  it('will not save over a config file that does not parse', async () => {
    const real = new StackManager(configFile, secrets, ledger, log, { secretsFile: secrets.path, stateDir, modelsDir: join(dir, 'models') });
    const fake = { rawConfig: stack.rawConfig, problems: stack.problems };
    stack.rawConfig = () => real.rawConfig();
    stack.problems = () => real.problems();
    const good = readFileSync(configFile, 'utf8');
    const broken = good.replace(/\n}\n$/, ',\n}\n');
    expect(broken).not.toBe(good);
    writeFileSync(configFile, broken);
    try {
      const put = await call('PUT', '/api/settings', { timezone: 'UTC' });
      expect(put.status).toBe(409);
      expect(put.data.error).toContain('config.json');
      expect(readFileSync(configFile, 'utf8')).toBe(broken);
      const get = await call('GET', '/api/settings');
      expect(get.status).toBe(409);
      expect(get.data.error).toContain('config.json');
      const status = await call('GET', '/api/status');
      expect(status.status).toBe(200);
      expect(String(status.data.problems)).toContain('config.json');
      const restart = await call('POST', '/api/restart', {});
      expect(restart.status).toBe(200);
      expect(String(restart.data.problems)).toContain('config.json');
    } finally {
      Object.assign(stack, fake);
      writeFileSync(configFile, good);
    }
    expect((await call('PUT', '/api/settings', { timezone: 'UTC' })).status).toBe(200);
  });

  it('never returns or logs a secret value', async () => {
    // Touch every GET endpoint once more.
    for (const p of ['/api/status', '/api/dashboard', '/api/settings', '/api/secrets', '/api/logs', '/api/session', '/api/health']) {
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

  it('is not thrown by a stray cookie from another port on this host', async () => {
    expect((await call('GET', '/api/session', undefined, { cookie: 'somethingelse=100%' })).status).toBe(200);
    const mine = await call('GET', '/api/session', undefined, { cookie: `somethingelse=100%; ${cookie}` });
    expect(mine.status).toBe(200);
    expect(mine.data.loggedIn).toBe(true);
  });

  it('keeps a static file in memory once it has been read', async () => {
    const file = join(webDir, 'kept.css');
    expect((await call('GET', '/kept.css')).status).toBe(404); // a miss isn't remembered
    writeFileSync(file, 'a{}');
    expect((await call('GET', '/kept.css')).text).toBe('a{}');
    writeFileSync(file, 'b{}');
    expect((await call('GET', '/kept.css')).text).toBe('a{}');
  });

  it('answers at most 100 requests on one connection', async () => {
    const got = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const s = connect(Number(host.split(':')[1]), '127.0.0.1', () => s.write(`GET /api/health HTTP/1.1\r\nHost: ${host}\r\n\r\n`.repeat(150)));
      const end = setTimeout(() => s.destroy(), 1500);
      s.on('data', (d) => (seen += d.toString('latin1')));
      s.on('error', reject);
      s.on('close', () => {
        clearTimeout(end);
        resolve(seen);
      });
    });
    expect(got.match(/HTTP\/1\.1 200/g)).toHaveLength(100);
  });

  it('answers 429 once the guesses at the current password run out', async () => {
    const wrong = { current: 'wrong password!', next: 'another good password' };
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/password', wrong)).status).toBe(400);
    expect((await call('POST', '/api/password', wrong)).status).toBe(429);
  });

  it('tells people in the wizard where their words and music requests go', () => {
    const page = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    expect(page).not.toContain('never saved or sent anywhere');
    for (const word of ['cloudStt', 'satellite.recordDays', 'YouTube', 'Deezer']) expect(page).toContain(word);
  });

  it('rate limits failed logins per client', async () => {
    await call('POST', '/api/logout', {});
    cookie = '';
    csrf = '';
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/login', { username: 'rique', password: 'wrong password!' })).status).toBe(401);
    expect((await call('POST', '/api/login', { username: 'rique', password: 'correct horse battery' })).status).toBe(429);
  });

  it('logs a run of refused logins once, so it cannot flush the dashboard log', async () => {
    // The status field: a 401's timestamp can hold those digits too (".429Z").
    const refused = () => logLines.filter((l) => l.includes('login failed') && l.includes('"status":429')).length;
    expect(refused()).toBe(1);
    await Promise.all(Array.from({ length: 20 }, () => call('POST', '/api/login', { username: 'rique', password: 'wrong password!' })));
    expect(refused()).toBe(1);
  });
});

describe('saving a provider', () => {
  const paths = { secretsFile: 's', stateDir: 'state', modelsDir: 'models' };
  const search = { apiKeySecret: 'TAVILY_API_KEY', maxResults: 4 };
  const fallback = { preset: 'gemini', model: 'spare' };
  const raw = {
    brain: {
      preset: 'groq',
      provider: 'openai',
      effort: 'high',
      baseUrl: 'https://old.example/v1',
      model: 'old-model',
      apiKeySecret: 'GROQ_API_KEY',
      extraBody: { reasoning_effort: 'high' },
      priceInPerM: 9,
      priceCachedInPerM: 8,
      priceOutPerM: 7,
      maxTokens: 800,
      firstEventTimeoutMs: 9_000,
      totalTimeoutMs: 30_000,
      search,
      fallback,
    },
  };
  const saved = (patch: SettingsPatch) => applySettings(raw, patch, paths).brain as Record<string, unknown>;

  it('keeps every brain setting this page has no say over', () => {
    expect(saved({ llm: { preset: 'claude' } })).toMatchObject({ maxTokens: 800, firstEventTimeoutMs: 9_000, totalTimeoutMs: 30_000, search, fallback });
  });

  it('replaces everything about the old provider', () => {
    const claude = saved({ llm: { preset: 'claude' } });
    expect(claude).toMatchObject({ preset: 'claude', provider: 'anthropic', effort: 'low', apiKeySecret: 'ANTHROPIC_API_KEY', priceCachedInPerM: 0.01 });
    expect(claude).not.toHaveProperty('extraBody');
    const groq = applySettings({ brain: claude }, { llm: { preset: 'groq' } }, paths).brain as Record<string, unknown>;
    expect(groq).toMatchObject({ provider: 'openai', apiKeySecret: 'GROQ_API_KEY' });
    for (const gone of ['effort', 'priceCachedInPerM']) expect(groq).not.toHaveProperty(gone);
  });

  it('leaves the provider alone when only the fallback changes', () => {
    expect(saved({ fallback: { preset: 'none' } })).toMatchObject({ preset: 'groq', model: 'old-model', extraBody: { reasoning_effort: 'high' }, maxTokens: 800 });
  });
});
