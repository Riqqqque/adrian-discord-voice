// install.sh run for real in bash, in a sandbox: its fixed paths are moved into
// a temp folder and the system commands it calls (systemctl, useradd, curl, df,
// ...) are stand-ins that record what they were asked. These cover what a
// person sees when the machine isn't ready, and running it again on a live install.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADRIAN_PACKAGING_UNDER_TEST points these tests at another copy (an older release's, say).
const packaging = (process.env.ADRIAN_PACKAGING_UNDER_TEST ?? fileURLToPath(new URL('../packaging/', import.meta.url))).replaceAll('\\', '/').replace(/\/?$/, '/');
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const hasBash = spawnSync(bash, ['-c', 'tar --version && gzip --version'], { stdio: 'ignore' }).status === 0;
const work = mkdtempSync(join(tmpdir(), 'adrian-install-')).replaceAll('\\', '/');
const node = process.execPath.replaceAll('\\', '/');

/** Where each basic tool really is, so a test can leave PATH empty and still have them. */
const BASIC = ['dirname', 'sed', 'cat', 'grep', 'awk', 'sort', 'tr', 'head', 'tail', 'basename', 'readlink', 'rm', 'mv', 'mkdir', 'ln', 'cp', 'date', 'mktemp', 'seq', 'nproc', 'env', 'cmp', 'find', 'cut', 'touch'];
const TOOLS = ['tar', 'gzip', 'xz', 'bzip2', 'sha256sum'];
const where: Record<string, string> = hasBash
  ? Object.fromEntries(
      spawnSync(bash, ['-c', 'for t in "$@"; do printf "%s=%s\\n" "$t" "$(command -v "$t")"; done', 'x', ...BASIC, ...TOOLS], { encoding: 'utf8' })
        .stdout.trim()
        .split('\n')
        .map((l) => l.split('=') as [string, string]),
    )
  : {};

/** Stand-ins for the parts of a real server the installer talks to. */
const STUBS = readFileSync(new URL('./install-stubs.sh', import.meta.url), 'utf8');

interface Machine {
  /** Commands that exist; everything else is missing (PATH is empty). Default: all of them. */
  tools?: string[];
  env?: Record<string, string>;
  systemd?: boolean;
}

/** A sandbox machine with a release bundle of `version` next to the installer. */
function machine(m: Machine = {}) {
  const root = mkdtempSync(join(work, 'm-')).replaceAll('\\', '/');
  const put = (name: string, text: string, mode = 0o644) => {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text, { mode });
  };
  const moved = readFileSync(`${packaging}install.sh`, 'utf8')
    .replace(/^OPT=.*$/m, `OPT=${root}/opt`)
    .replace(/^ETC=.*$/m, `ETC=${root}/etc`)
    .replace(/^VAR=.*$/m, `VAR=${root}/var`)
    .replace(/^UNIT=.*$/m, `UNIT=${root}/adrian-voice.service`)
    .replace(/^CLI=.*$/m, `CLI=${root}/adrian-cli`)
    .replace(/^RUN_SYSTEMD=.*$/m, `RUN_SYSTEMD=${root}/run-systemd`)
    // Older copies test /run/systemd/system directly.
    .replaceAll('[ -d /run/systemd/system ]', `[ -d ${root}/run-systemd ]`);
  put('inst/install.sh', moved);
  const pins = readFileSync(`${packaging}downloads.sh`, 'utf8').replace(/^MODELS=\([\s\S]*?^\)$/m, 'MODELS=()');
  // install_node has its own tests (packaging.test.ts). Its swap of the opt/node
  // link can't be done twice with Git Bash's stand-in links, so here it only
  // puts a Node in place.
  const nodeStub = `\ninstall_node() { mkdir -p "$1/node/bin"; printf '#!/usr/bin/env bash\\nexec "%s" "$@"\\n' "${node}" >"$1/node/bin/node"; }\n`;
  put('inst/downloads.sh', pins + nodeStub);
  if (m.systemd !== false) mkdirSync(join(root, 'run-systemd'));
  const nodeVersion = /^NODE_VERSION=(.*)$/m.exec(pins)![1]!;
  return {
    root,
    nodeVersion,
    put,
    read: (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : ''),
    exists: (name: string) => existsSync(join(root, name)),
    /** Node "already installed", so nothing is downloaded. */
    withNode() {
      put(`opt/node-v${nodeVersion}/bin/node`, `#!/usr/bin/env bash\nexec "${node}" "$@"\n`, 0o755);
    },
    /** A bundle of the app at `version`, with its .sha256 unless told otherwise. */
    bundle(version: string, { sha = true, damaged = false } = {}) {
      put('new/package.json', `${JSON.stringify({ name: 'adrian', version }, null, 2)}\n`);
      put('new/packaging/adrian', '#!/usr/bin/env bash\necho "Setup code: TEST-CODE"\n', 0o755);
      put('new/packaging/adrian-voice.service', `unit of ${version}\n`);
      const name = `adrian-voice-${version}-linux-x64.tar.gz`;
      const r = run(root, `set -e; rm -f "${name}" "${name}.sha256"; tar -czf "${name}" -C new .; ${sha ? `sha256sum "${name}" >"${name}.sha256"` : ':'}; ${damaged ? `printf x >>"${name}"` : ':'}`);
      expect(r.code).toBe(0);
      // Relative: GNU tar reads "C:/..." as a remote host.
      return name;
    },
    install(args: string[], env: Record<string, string> = {}) {
      const tools = m.tools ?? [...BASIC, ...TOOLS];
      // With PATH empty, each tool that "exists" is a function calling the real one.
      const fns = m.tools ? tools.map((t) => `${t}() { "${where[t]}" "$@"; }; export -f ${t};`).join(' ') : '';
      const path = m.tools ? 'PATH=/nonexistent;' : '';
      return run(root, `${STUBS} ${fns} ${path} exec "${where.bash ?? 'bash'}" inst/install.sh "$@"`, args, { ...m.env, ...env });
    },
  };
}

function run(cwd: string, script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(bash, ['-c', script, 'test', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MSYS: 'winsymlinks:lnk', MSYS_NO_PATHCONV: '1', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
where.bash = spawnSync(bash, ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

const serverOf = (config: string) => (JSON.parse(config) as { server: { host: string; port: number } }).server;

describe.skipIf(!hasBash)('install.sh on a machine that is not ready', () => {
  it('lists every problem at once, with what to do, and changes nothing', () => {
    const m = machine({ tools: BASIC.concat(['tar', 'gzip', 'sha256sum']), systemd: false, env: { ARCH: 'aarch64', OPT_MB: '600' } });
    const r = m.install(['--yes', '--bundle', m.bundle('1.0.0')]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('Nothing was changed');
    expect(r.err).toContain('ARM processor (aarch64)');
    expect(r.err).toContain("systemd isn't running");
    expect(r.err).toMatch(/missing\. Install them with: .*bzip2.*/);
    expect(r.err).toMatch(/Install them with: [^\n]*\bxz\b/);
    expect(r.err).toContain('Not enough free disk: 0.6 GB free');
    expect(m.exists('opt')).toBe(false);
    expect(m.exists('users')).toBe(false);
  }, 60_000);

  it('names the package manager line when it can', () => {
    const m = machine({ tools: [...BASIC, 'tar', 'gzip', 'sha256sum', 'apt-get'] });
    const r = m.install(['--check']);
    expect(r.err).toContain('Install them with: sudo apt-get install -y bzip2 xz-utils\n');
  }, 60_000);

  it('says how to turn systemd on in a container instead of only that it is off', () => {
    const m = machine({ systemd: false, env: { container: 'docker' } });
    const r = m.install(['--check']);
    expect(r.err).toContain('Docker install');
  }, 60_000);

  it('says which site it cannot reach before downloading anything', () => {
    const m = machine();
    m.put('offline', 'nodejs.org\n');
    const r = m.install(['--yes', '--bundle', m.bundle('1.0.0')]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("Can't reach nodejs.org");
    expect(r.err).toContain('https_proxy');
    expect(m.exists('opt')).toBe(false);
  }, 60_000);

  it('counts the folders that share a disk together', () => {
    const m = machine({ env: { OPT_MB: '2500', VAR_MB: '2500' } });
    mkdirSync(join(m.root, 'var'));
    // 2.5 GB each would pass on two disks; on one disk it's 2.5 GB in all.
    expect(m.install(['--check']).err).toContain('Not enough free disk: 2.4 GB free on the disk that holds /opt and /var/lib');
    const apart = machine({ env: { OPT_MB: '2500', VAR_MB: '2500', VAR_MOUNT: '/var' } });
    mkdirSync(join(apart.root, 'var'));
    expect(apart.install(['--check']).code).toBe(0);
  }, 60_000);

  it('--check on a ready machine says so, without root and without changing anything', () => {
    const m = machine({ env: { UID_IS: '1000' } });
    const r = m.install(['--check']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ready for A.D.R.I.A.N.');
    expect(m.exists('opt')).toBe(false);
  }, 60_000);

  it('refuses a damaged bundle before creating anything', () => {
    const m = machine();
    m.withNode();
    const r = m.install(['--yes', '--bundle', m.bundle('1.0.0', { damaged: true })]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("doesn't match its checksum");
    expect(m.exists('users')).toBe(false);
    expect(m.exists('opt/releases')).toBe(false);
  }, 60_000);
});

describe.skipIf(!hasBash)('install.sh run again on a live install', () => {
  /** Installed once and running on 8790, as a first install leaves it. */
  function live(extra: string[] = []) {
    const m = machine();
    m.withNode();
    const first = m.install(['--yes', '--bundle', m.bundle('1.0.0'), ...extra]);
    expect(first.err).not.toContain('error:');
    expect(first.code, first.err + first.out).toBe(0);
    m.put('listening', `${serverOf(m.read('etc/config.json')).port}\n`);
    m.put('calls.log', '');
    return m;
  }

  it('a first install takes the first free port, on this machine only', () => {
    const m = live();
    expect(serverOf(m.read('etc/config.json'))).toEqual({ host: '127.0.0.1', port: 8790 });
  }, 60_000);

  it('keeps her port: her own service holding it is no reason to move', () => {
    const m = live();
    const r = m.install(['--yes', '--bundle', m.bundle('1.0.1')]);
    expect(r.err).not.toContain('error:');
    expect(r.code).toBe(0);
    expect(serverOf(m.read('etc/config.json')).port).toBe(8790);
  }, 60_000);

  it('keeps a network-wide admin page network-wide unless told otherwise', () => {
    const m = live(['--lan']);
    expect(serverOf(m.read('etc/config.json')).host).toBe('0.0.0.0');
    m.install(['--yes', '--bundle', m.bundle('1.0.1')]);
    expect(serverOf(m.read('etc/config.json')).host).toBe('0.0.0.0');
    m.install(['--yes', '--no-lan', '--bundle', m.bundle('1.0.2')]);
    expect(serverOf(m.read('etc/config.json')).host).toBe('127.0.0.1');
  }, 60_000);

  it('restarts the running service, so the new files are what runs', () => {
    const m = live();
    m.install(['--yes', '--bundle', m.bundle('1.0.1')]);
    expect(m.read('calls.log')).toMatch(/^systemctl restart adrian-voice$/m);
  }, 60_000);

  it('finishes over a bot that failed to start (a bad token, say): the admin page is up to fix it', () => {
    const m = live();
    m.put('health-code', '503');
    const r = m.install(['--yes', '--bundle', m.bundle('1.0.1')]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("the bot itself didn't start");
  }, 60_000);

  it('keeps everything else in the config', () => {
    const m = live();
    const c = JSON.parse(m.read('etc/config.json')) as Record<string, unknown>;
    m.put('etc/config.json', JSON.stringify({ ...c, guildId: '100000000000000000', voice: { voice: 'am_michael' } }, null, 2));
    m.install(['--yes', '--bundle', m.bundle('1.0.1')]);
    const after = JSON.parse(m.read('etc/config.json')) as Record<string, unknown>;
    expect(after.guildId).toBe('100000000000000000');
    expect(after.voice).toEqual({ voice: 'am_michael' });
  }, 60_000);

  it('refuses an older bundle and says how to go back or update instead', () => {
    const m = live();
    m.install(['--yes', '--bundle', m.bundle('2.0.0')]);
    const r = m.install(['--yes', '--bundle', m.bundle('1.5.0')]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('older than the 2.0.0 already installed');
    expect(r.err).toContain('sudo adrian rollback');
    expect(m.read('opt/releases/2.0.0/packaging/adrian-voice.service')).toBe('unit of 2.0.0\n');
    expect(m.exists('opt/releases/1.5.0')).toBe(false);
    expect(m.install(['--yes', '--allow-downgrade', '--bundle', m.bundle('1.5.0')]).code).toBe(0);
  }, 60_000);
});

describe.skipIf(!hasBash)('downloads that stop halfway', () => {
  it('say to run the same command again, keep curl\'s exit code, and keep what finished', () => {
    const dir = mkdtempSync(join(work, 'dl-')).replaceAll('\\', '/');
    const r = run(dir, `set -euo pipefail; . "${packaging}downloads.sh"; curl() { return 28; }; fetch https://example.invalid/model.bin 00 model.bin`);
    expect(r.code).toBe(28);
    expect(r.err).toContain('model.bin');
    expect(r.err).toContain('run the same command again');
  });
});
