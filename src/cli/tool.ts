// Helper for the `adrian` shell CLI: the parts that touch config, secrets
// and the admin account, so they share code (and tests) with the service.
//
// Usage: node dist/cli/tool.js <command> [args]
//   secret-set NAME        value read from stdin (never from argv)
//   secret-delete NAME
//   secret-list
//   setup-code [--new]     show the one-time setup code (new one if asked or expired)
//   reset-admin            delete the admin account; a new setup code is made
//   check                  list what's missing before the bot can start
//   port                   print the admin UI port from the config
//   voice [NAME [SPEED]]   show or set the voice (Kokoro name, speed 0.7-1.4)
//   config KEY [VALUE]     show or set a setting by dotted path (validated)

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configProblems } from '../app/manager.js';
import { AdminAuth } from '../web/auth.js';
import { KOKORO_VOICES } from '../speech/voices.js';
import { readJsonFile, SecretsFile, writeJsonFile } from '../web/secrets-file.js';
import { baseConfig } from '../web/settings.js';

const configFile = resolve(process.env.ADRIAN_CONFIG ?? '/etc/adrian/config.json');
const stateDir = resolve(process.env.ADRIAN_STATE ?? '/var/lib/adrian');
const raw = readJsonFile<Record<string, unknown>>(configFile) ?? {};
const secrets = new SecretsFile(
  resolve((typeof raw.secretsFile === 'string' && raw.secretsFile) || process.env.ADRIAN_SECRETS || join(dirname(configFile), 'secrets.env')),
);

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const [cmd, arg] = process.argv.slice(2);
const auth = new AdminAuth(stateDir);

switch (cmd) {
  case 'secret-set': {
    if (!arg) fail('usage: secret-set NAME  (value on stdin)');
    const v = await stdin();
    if (!v) fail('no value given');
    try {
      secrets.set(arg, v);
    } catch (e) {
      fail((e as Error).message);
    }
    console.log(`${arg} saved. Restart to apply: sudo adrian restart`);
    break;
  }
  case 'secret-delete':
    if (!arg) fail('usage: secret-delete NAME');
    console.log(secrets.delete(arg) ? `${arg} deleted.` : `${arg} was not set.`);
    break;
  case 'secret-list':
    for (const n of secrets.names()) console.log(n);
    break;
  case 'setup-code': {
    if (auth.hasAdmin()) fail('The admin account already exists. Forgot the password? sudo adrian reset-admin');
    if (arg === '--new') auth.newSetupCode();
    else auth.ensureSetupCode();
    const c = readJsonFile<{ code: string; expiresAt: number }>(join(stateDir, 'setup-code'));
    if (!c) fail('could not create a setup code');
    const mins = Math.max(0, Math.round((c.expiresAt - Date.now()) / 60_000));
    console.log(`Setup code: ${c.code}  (expires in ${mins} min)`);
    break;
  }
  case 'reset-admin': {
    const f = join(stateDir, 'admin.json');
    if (existsSync(f)) unlinkSync(f);
    auth.newSetupCode();
    console.log('Admin account removed. Restart the service, then open the admin UI and use: sudo adrian setup-code');
    break;
  }
  case 'check': {
    const modelsDir = resolve(process.env.ADRIAN_MODELS ?? join(stateDir, 'models'));
    const p = configProblems(baseConfig({ secretsFile: secrets.path, stateDir, modelsDir }, { secretsFile: secrets.path, ...raw }), secrets.read());
    if (!p.length) console.log('Config is complete.');
    for (const x of p) console.log(`- ${x}`);
    process.exitCode = p.length ? 3 : 0;
    break;
  }
  case 'port': {
    const s = (raw.server ?? {}) as { port?: number; host?: string; tls?: unknown };
    console.log(`${s.tls ? 'https' : 'http'} ${s.host ?? '127.0.0.1'} ${s.port ?? 8790}`);
    break;
  }
  case 'voice': {
    const cur = (raw.voice ?? {}) as { voice?: string; speed?: number };
    if (!arg) {
      console.log(`${cur.voice ?? 'af_heart'} at speed ${cur.speed ?? 1}`);
      break;
    }
    if (!(KOKORO_VOICES as readonly string[]).includes(arg)) fail(`unknown voice "${arg}". English voices: ${KOKORO_VOICES.filter((v) => /^[ab][fm]_/.test(v)).join(' ')}`);
    const speed = process.argv[4] === undefined ? (cur.speed ?? 1) : Number(process.argv[4]);
    if (!(speed >= 0.7 && speed <= 1.4)) fail('speed must be between 0.7 and 1.4');
    writeJsonFile(configFile, { ...raw, voice: { ...cur, voice: arg, speed } }, 0o640);
    console.log(`Voice set to ${arg} at speed ${speed}.`);
    break;
  }
  case 'config': {
    // config KEY            show a value      config KEY VALUE      set it
    // KEY is a dotted path (brain.extraBody.reasoning_effort, gameServers.2.name).
    if (!arg) fail('usage: config KEY [VALUE]');
    const path = arg.split('.');
    const ALLOWED = ['brain', 'voice', 'limits', 'identity', 'gameServers', 'timezone', 'priorityRoleIds', 'playbackVolume', 'guildId', 'channelId', 'media', 'silenceMs', 'listen', 'mature', 'languages', 'owners', 'ownerStopReply', 'ownerAck', 'ownerAffection', 'nicknames', 'autoMemory', 'cloudVoice', 'music'];
    if (!ALLOWED.includes(path[0]!) || /(file|dir)$|^vadmodel$|^secrets/i.test(path[path.length - 1]!)) fail(`"${arg}" can't be changed here (file paths belong to the installer).`);
    const get = (o: unknown, p: string[]): unknown => p.reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
    const rawValue = process.argv[4];
    if (rawValue === undefined) {
      console.log(JSON.stringify(get(raw, path) ?? null, null, 2));
      break;
    }
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue); // numbers, true/false, arrays, objects
    } catch {
      /* plain string */
    }
    const next = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    let o: Record<string, unknown> = next;
    for (const k of path.slice(0, -1)) {
      if (!o[k] || typeof o[k] !== 'object') o[k] = {};
      o = o[k] as Record<string, unknown>;
    }
    o[path[path.length - 1]!] = value;
    const modelsDir = resolve(process.env.ADRIAN_MODELS ?? join(stateDir, 'models'));
    const full = baseConfig({ secretsFile: secrets.path, stateDir, modelsDir }, { secretsFile: secrets.path, ...next });
    const problems = configProblems(full, secrets.read()).filter((p) => p.startsWith('Config '));
    if (problems.length) fail(`Not saved:\n${problems.join('\n')}`);
    writeJsonFile(configFile, next, 0o640);
    console.log(`${arg} = ${JSON.stringify(value)}. Restart to apply: sudo adrian restart`);
    break;
  }
  case 'version':
    console.log((JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version);
    break;
  default:
    fail('unknown command');
}
