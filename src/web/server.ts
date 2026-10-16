// Admin web server (node:http, no framework). Serves the single-page setup
// wizard and dashboard from web/ and a small JSON API.
//
// Security model:
// - Loopback by default; LAN only when the installer was told so.
// - Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie
//   (Secure when served over TLS), 12 h idle / 7 day max.
// - CSRF: every non-GET request must come from this origin (Origin or
//   Sec-Fetch-Site) and, once logged in, carry the session's X-CSRF-Token.
// - Secrets are write-only: the API reports names, never values.
// - Login and setup-code attempts are rate limited.

import { readFileSync } from 'node:fs';
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { isIP } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { StackManager } from '../app/manager.js';
import type { Logger } from '../core/interfaces.js';
import { recentLogLines } from '../core/logger.js';
import type { UsageLedger } from '../limits/usage-ledger.js';
import { KOKORO_VOICES } from '../speech/voices.js';
import type { AdminAuth, Session } from './auth.js';
import { checkDiscordToken, checkHardware, checkLlm, checkTavily, LLM_PRESETS, listVoiceChannels } from './checks.js';
import { SECRET_NAME, type SecretsFile, writeJsonFile } from './secrets-file.js';
import { applySettings, CustomLlmSchema, type InstallPaths, SettingsPatchSchema, settingsView } from './settings.js';

export interface WebDeps {
  /** Host names (besides IP addresses and localhost) the UI answers to. */
  allowedHosts?: string[];
  paths: InstallPaths & { configFile: string; webDir: string };
  version: string;
  log: Logger;
  auth: AdminAuth;
  secrets: SecretsFile;
  ledger: UsageLedger;
  stack: StackManager;
  /** Normalized WAV of a short sentence in the given voice. */
  voicePreview(voice: string, speed: number): Promise<Buffer>;
  tls?: { cert: string; key: string };
  fetch?: typeof fetch;
}

const COOKIE = 'adrian_session';
const MAX_BODY = 64 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'expected JSON');
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(413, 'request too large');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function securityHeaders(res: ServerResponse, tls: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (tls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/** Host header check: IP literals, localhost, or an allowed name. */
export function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');
  if (isIP(name) || name === 'localhost') return true;
  return allowed.some((a) => a.toLowerCase() === name);
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const b = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export function createAdminServer(d: WebDeps): Server {
  const tls = !!d.tls;
  const f = d.fetch ?? fetch;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    securityHeaders(res, tls);
    // DNS rebinding: a web page on some other domain pointed at this address
    // arrives with that domain as Host. Answer only to IPs, localhost and
    // names set in server.allowedHosts.
    if (!hostAllowed(req.headers.host, d.allowedHosts ?? [])) {
      res.writeHead(421, { 'Content-Type': 'text/plain' });
      res.end('Unknown host name. Add it to server.allowedHosts in the config to use it.');
      return;
    }
    route(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) d.log.error('admin api error', { error: (e as Error).message.slice(0, 200), path: req.url?.split('?')[0] });
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
      else res.end();
    });
  };

  const setCookie = (res: ServerResponse, token: string, maxAge: number) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${tls ? '; Secure' : ''}`);
  };

  /** Non-GET requests must come from this origin. */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return site === 'same-origin'; // browsers send one or the other
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const clientIp = (req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown';

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return serveStatic(path, res);
    }
    if (method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'cross-origin request refused');

    // --- public ---------------------------------------------------------
    if (path === '/api/health' && method === 'GET') {
      const s = d.stack;
      return json(res, s.state === 'failed' ? 503 : 200, {
        ok: s.state === 'running' || s.state === 'setup',
        state: s.state,
        voiceReady: s.current?.voiceReady() ?? false,
        version: d.version,
      });
    }

    const token = cookies(req)[COOKIE];
    const session = d.auth.session(token);

    if (path === '/api/session' && method === 'GET') {
      return json(res, 200, {
        setupNeeded: !d.auth.hasAdmin(),
        loggedIn: !!session,
        ...(session ? { username: session.username, csrf: session.csrf } : {}),
      });
    }
    if (path === '/api/setup/claim' && method === 'POST') {
      const b = await body(req);
      const r = await d.auth.claim(clientIp(req), b.code, b.username, b.password);
      if (!r.ok) {
        if (r.status !== 404) d.log.warn('setup claim refused', { status: r.status });
        throw new HttpError(r.status, r.error);
      }
      d.log.info('admin account created', { username: r.session.username });
      setCookie(res, r.token, 7 * 24 * 3600);
      return json(res, 200, { ok: true, username: r.session.username, csrf: r.session.csrf });
    }
    if (path === '/api/login' && method === 'POST') {
      const b = await body(req);
      const r = await d.auth.login(clientIp(req), b.username, b.password);
      if (!r.ok) {
        d.log.warn('login failed', { status: r.status });
        throw new HttpError(r.status, r.error);
      }
      setCookie(res, r.token, 7 * 24 * 3600);
      return json(res, 200, { ok: true, username: r.session.username, csrf: r.session.csrf });
    }
    if (path === '/api/logout' && method === 'POST') {
      d.auth.logout(token);
      setCookie(res, '', 0);
      return json(res, 200, { ok: true });
    }

    // --- everything else needs a session (+ CSRF token for changes) -----
    if (!session) throw new HttpError(401, 'log in first');
    if (method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) throw new HttpError(403, 'missing or bad CSRF token');
    return authed(req, res, url, session);
  }

  async function authed(req: IncomingMessage, res: ServerResponse, url: URL, session: Session): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const s = d.stack;

    if (path === '/api/status' && method === 'GET') {
      const ans = s.current?.answers() ?? [];
      const col = (k: 'sttLatencyMs' | 'llmFirstChunkMs' | 'ttsFirstMs' | 'speechEndToAudioMs') =>
        ans.map((a) => a[k]).filter((v): v is number => typeof v === 'number');
      const stage = (k: Parameters<typeof col>[0]) => ({ p50: pct(col(k), 50), p95: pct(col(k), 95), n: col(k).length });
      return json(res, 200, {
        version: d.version,
        state: s.state,
        error: s.error ?? null,
        problems: s.state === 'setup' ? s.problems() : [],
        voiceReady: s.current?.voiceReady() ?? false,
        botTag: s.current?.botTag() ?? null,
        uptimeS: s.uptimeS,
        latency: { stt: stage('sttLatencyMs'), llmFirst: stage('llmFirstChunkMs'), ttsFirst: stage('ttsFirstMs'), speechEndToAudio: stage('speechEndToAudioMs') },
        lastAnswers: ans.slice(-10).map(({ at, outcome, speechEndToAudioMs, costUsd }) => ({ at, outcome, speechEndToAudioMs, costUsd })),
        spend: d.ledger.summary(),
      });
    }
    if (path === '/api/settings' && method === 'GET') {
      return json(res, 200, { settings: settingsView(s.rawConfig()), presets: LLM_PRESETS, voices: KOKORO_VOICES });
    }
    if (path === '/api/settings' && method === 'PUT') {
      const parsed = SettingsPatchSchema.safeParse(await body(req));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const next = applySettings(s.rawConfig(), parsed.data, d.paths);
      writeJsonFile(d.paths.configFile, next, 0o640);
      d.log.info('settings changed', { by: session.username, keys: Object.keys(parsed.data) });
      return json(res, 200, { ok: true, settings: settingsView(next), problems: s.problems() });
    }
    if (path === '/api/secrets' && method === 'GET') {
      return json(res, 200, { secrets: d.secrets.names().map((name) => ({ name, configured: true })) });
    }
    const sm = /^\/api\/secrets\/([A-Z][A-Z0-9_]{1,63})$/.exec(path);
    if (sm && method === 'PUT') {
      const name = sm[1]!;
      const b = await body(req);
      if (typeof b.value !== 'string' || !SECRET_NAME.test(name)) throw new HttpError(400, 'value required');
      try {
        d.secrets.set(name, b.value);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      d.log.info('secret set', { name, by: session.username });
      return json(res, 200, { ok: true, name, configured: true });
    }
    if (sm && method === 'DELETE') {
      const had = d.secrets.delete(sm[1]!);
      d.log.info('secret deleted', { name: sm[1], by: session.username });
      return json(res, 200, { ok: true, name: sm[1], configured: false, existed: had });
    }

    // --- wizard checks --------------------------------------------------
    if (path === '/api/check/discord' && method === 'POST') {
      // Verify a pasted token (saved only if valid) or the stored one.
      const b = await body(req);
      const given = typeof b.token === 'string' ? b.token.trim() : '';
      const tok = given || d.secrets.read().get('DISCORD_TOKEN');
      if (!tok) throw new HttpError(400, 'paste the bot token first');
      const r = await checkDiscordToken(tok, f);
      if (r.ok && given) {
        d.secrets.set('DISCORD_TOKEN', given);
        d.log.info('secret set', { name: 'DISCORD_TOKEN', by: session.username });
      }
      return json(res, 200, r);
    }
    if (path === '/api/check/channels' && method === 'GET') {
      const tok = d.secrets.read().get('DISCORD_TOKEN');
      if (!tok) throw new HttpError(400, 'Discord token not set');
      const guild = url.searchParams.get('guild') ?? '';
      try {
        return json(res, 200, { channels: await listVoiceChannels(tok, guild, f) });
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    }
    if (path === '/api/check/llm' && method === 'POST') {
      // Test a provider with a pasted key (saved only if it works) or the stored one.
      const b = await body(req);
      const preset = LLM_PRESETS.find((p) => p.id === b.preset);
      const custom = b.preset === 'custom' ? CustomLlmSchema.safeParse({ ...b, key: undefined }) : undefined;
      if (!preset && !custom?.success) throw new HttpError(400, 'unknown provider');
      const c = custom?.success ? custom.data : undefined;
      const keySecret = preset?.keySecret ?? c!.keySecret;
      const given = typeof b.key === 'string' ? b.key.trim() : '';
      const key = given || (keySecret ? d.secrets.read().get(keySecret) : undefined);
      const r = await checkLlm(
        {
          ...(preset?.provider ? { provider: preset.provider } : {}),
          baseUrl: preset?.baseUrl ?? c!.baseUrl,
          model: preset?.model ?? c!.model,
          ...(key ? { key } : {}),
          ...(preset?.extraBody ? { extraBody: preset.extraBody } : {}),
          priceInPerM: preset?.priceInPerM ?? c!.priceInPerM,
          priceOutPerM: preset?.priceOutPerM ?? c!.priceOutPerM,
        },
        f,
      );
      if (r.ok && given && keySecret) {
        d.secrets.set(keySecret, given);
        d.log.info('secret set', { name: keySecret, by: session.username });
      }
      return json(res, 200, r);
    }
    if (path === '/api/check/search' && method === 'POST') {
      const b = await body(req);
      const given = typeof b.key === 'string' ? b.key.trim() : '';
      const key = given || d.secrets.read().get('TAVILY_API_KEY');
      if (!key) throw new HttpError(400, 'paste the Tavily key first');
      const r = await checkTavily(key, f);
      if (r.ok && given) {
        d.secrets.set('TAVILY_API_KEY', given);
        d.log.info('secret set', { name: 'TAVILY_API_KEY', by: session.username });
      }
      return json(res, 200, r);
    }
    if (path === '/api/check/hardware' && method === 'GET') {
      return json(res, 200, checkHardware(d.paths.modelsDir, d.paths.stateDir));
    }
    if (path === '/api/voice-preview' && method === 'GET') {
      const voice = url.searchParams.get('voice') ?? '';
      const speed = Number(url.searchParams.get('speed') ?? '1');
      if (!(KOKORO_VOICES as readonly string[]).includes(voice) || !(speed >= 0.7 && speed <= 1.4)) throw new HttpError(400, 'bad voice');
      const wav = await d.voicePreview(voice, speed);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'private, max-age=3600' });
      res.end(wav);
      return;
    }

    // --- operations -----------------------------------------------------
    if (path === '/api/restart' && method === 'POST') {
      d.log.info('restart requested', { by: session.username });
      const state = await s.restart();
      return json(res, 200, { state, error: s.error ?? null, problems: state === 'setup' ? s.problems() : [] });
    }
    if (path === '/api/logs' && method === 'GET') {
      return json(res, 200, { lines: recentLogLines().slice(-200) });
    }
    if (path === '/api/password' && method === 'POST') {
      const b = await body(req);
      const err = await d.auth.changePassword(session.username, b.current, b.next);
      if (err) throw new HttpError(400, err);
      d.log.info('password changed', { by: session.username });
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not found');
  }

  function serveStatic(path: string, res: ServerResponse): void {
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const root = normalize(d.paths.webDir + sep);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root) || !MIME[extname(file)]) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)]!, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  }

  return tls ? createHttps({ cert: readFileSync(d.tls!.cert), key: readFileSync(d.tls!.key) }, handler) : createHttp(handler);
}
