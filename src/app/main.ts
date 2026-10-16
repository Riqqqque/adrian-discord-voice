// A.D.R.I.A.N. Discord voice service. Always starts the admin web UI; the
// voice stack starts once setup is complete (and restarts from the UI).
//
// Usage: node dist/app/main.js [config.json]
//   config   ADRIAN_CONFIG or /etc/adrian/config.json
//   secrets  config.secretsFile, ADRIAN_SECRETS, or secrets.env next to the config
//   state    ADRIAN_STATE or /var/lib/adrian (usage, admin account, setup code)
//   models   ADRIAN_MODELS or <state>/models

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_LAYOUT } from '../web/checks.js';
import { createLogger } from '../core/logger.js';
import { UsageLedger } from '../limits/usage-ledger.js';
import { AdminAuth } from '../web/auth.js';
import { readJsonFile, SecretsFile } from '../web/secrets-file.js';
import { createAdminServer } from '../web/server.js';
import { toWav } from '../audio/wav.js';
import { StackManager } from './manager.js';

const log = createLogger(process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info');
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string }).version;

const configFile = resolve(process.argv[2] ?? process.env.ADRIAN_CONFIG ?? '/etc/adrian/config.json');
const raw = readJsonFile<Record<string, unknown>>(configFile) ?? {};
const secretsFile = resolve(
  (typeof raw.secretsFile === 'string' && raw.secretsFile) || process.env.ADRIAN_SECRETS || join(dirname(configFile), 'secrets.env'),
);
const stateDir = resolve(process.env.ADRIAN_STATE ?? '/var/lib/adrian');
const modelsDir = resolve(process.env.ADRIAN_MODELS ?? join(stateDir, 'models'));
const timezone = typeof raw.timezone === 'string' ? raw.timezone : 'UTC';
const limitsRaw = (raw.limits ?? {}) as { usageFile?: string };

const secrets = new SecretsFile(secretsFile);
const ledger = new UsageLedger(limitsRaw.usageFile ?? join(stateDir, 'usage.json'), { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, timezone);
const auth = new AdminAuth(stateDir);
const stack = new StackManager(configFile, secrets, ledger, log, { secretsFile, stateDir, modelsDir });

// --- voice preview for the wizard (cached; shares the loaded TTS) --------
const previews = new Map<string, Buffer>();
async function voicePreview(voice: string, speed: number): Promise<Buffer> {
  const key = `${voice}@${speed}`;
  const hit = previews.get(key);
  if (hit) return hit;
  const voiceCfg = (stack.rawConfig().voice ?? {}) as { modelDir?: string; threads?: number };
  const tts = stack.models.ttsFor(voiceCfg.modelDir ?? join(modelsDir, MODEL_LAYOUT.tts), voiceCfg.threads ?? 4);
  const a = await tts.synthesize("Hi, I'm Adrian. Ask me anything by saying hey Adrian.", { voice, speed });
  const wav = toWav(a.samples, a.sampleRate);
  previews.set(key, wav);
  if (previews.size > 12) previews.delete(previews.keys().next().value!);
  return wav;
}

// --- admin UI ------------------------------------------------------------
const server = (raw.server ?? {}) as { host?: string; port?: number; tls?: { cert: string; key: string }; allowedHosts?: unknown[] };
const host = server.host ?? '127.0.0.1';
const port = server.port ?? 8790;
const web = createAdminServer({
  paths: { configFile, secretsFile, stateDir, modelsDir, webDir: join(pkgRoot, 'web') },
  version,
  log,
  auth,
  secrets,
  ledger,
  stack,
  voicePreview,
  allowedHosts: Array.isArray(server.allowedHosts) ? server.allowedHosts.filter((x: unknown): x is string => typeof x === 'string') : [],
  ...(server.tls ? { tls: server.tls } : {}),
});
web.on('error', (e) => {
  log.error('admin UI failed to start', { error: e.message, host, port });
  process.exitCode = 1;
});
web.listen(port, host, () => {
  log.info('admin UI listening', { url: `${server.tls ? 'https' : 'http'}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`, version });
  const codeFile = auth.ensureSetupCode();
  if (codeFile) log.info('waiting for setup: open the admin UI and enter the setup code (`sudo adrian setup-code` shows it)');
});

await stack.restart();

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal: sig });
  web.close();
  try {
    await stack.stop();
  } finally {
    ledger.flush();
    process.exit(0);
  }
};
// A stray rejection (a dropped connection, a failed write) is logged, not
// fatal: one bad request must not take the whole bot down.
process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: e instanceof Error ? e.message : String(e) }));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
