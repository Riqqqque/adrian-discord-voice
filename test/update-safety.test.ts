// `adrian update` when things go wrong around it: an update that was cut off
// halfway (power cut, killed), a full disk, GitHub's rate limit, two updates at
// once, and a dropped SSH connection. Run for real in bash; systemctl, curl and
// the rest are stand-ins (as in packaging.test.ts).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packaging = (process.env.ADRIAN_PACKAGING_UNDER_TEST ?? fileURLToPath(new URL('../packaging/', import.meta.url))).replaceAll('\\', '/').replace(/\/?$/, '/');
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const hasBash = spawnSync(bash, ['-c', 'tar --version && gzip --version'], { stdio: 'ignore' }).status === 0;
const has = (cmd: string) => hasBash && spawnSync(bash, ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const work = mkdtempSync(join(tmpdir(), 'adrian-upd-')).replaceAll('\\', '/');
const OLD = '1.0.0';
const NEW = '9.9.9';
const healthy = JSON.stringify({ ok: true, state: 'running', voiceReady: true, busy: false });

interface Opts {
  /** The version current points at. */
  current?: string;
  /** What /opt/adrian/update-in-progress says, if anything. */
  mark?: string;
  /** Health of each version; missing = no answer. */
  health?: Record<string, string>;
  /** The API is rate limited (the web page still redirects). */
  rateLimited?: boolean;
  /** MB free under /opt. */
  freeMb?: number;
  /** systemctl restart takes this long, for real. */
  restartSeconds?: number;
}

function machine(o: Opts = {}) {
  const root = mkdtempSync(join(work, 'm-')).replaceAll('\\', '/');
  const put = (name: string, text: string, mode = 0o644) => {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text, { mode });
  };
  const sh = (script: string, args: string[] = [], env: Record<string, string> = {}) => {
    const r = spawnSync(bash, ['-c', script, 'test', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, MSYS: 'winsymlinks:lnk', MSYS_NO_PATHCONV: '1', ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  expect(sh(`set -e; mkdir -p opt/releases/${OLD} opt/releases/${NEW} opt/node/bin etc var/models published; ln -sfn releases/${o.current ?? OLD} opt/current`).code).toBe(0);
  put('opt/node/bin/node', `#!/usr/bin/env bash\nexec "${process.execPath.replaceAll('\\', '/')}" "$@"\n`, 0o755);
  put('etc/secrets.env', '');
  put('adrian-voice.service', `unit of ${o.current ?? OLD}\n`);
  if (o.mark) {
    put('opt/update-in-progress', `${o.mark}\n`);
    put('opt/update-in-progress.unit', `unit of ${OLD}\n`);
  }
  for (const [v, h] of Object.entries(o.health ?? { [OLD]: healthy, [NEW]: healthy })) put(`health.${v}`, h);
  const moved = readFileSync(`${packaging}adrian`, 'utf8')
    .replace(/^OPT=.*$/m, `OPT=${root}/opt`)
    .replace(/^ETC=.*$/m, `ETC=${root}/etc`)
    .replace(/^VAR=.*$/m, `VAR=${root}/var`)
    .replace(/^UNIT=.*$/m, `UNIT=${root}/adrian-voice.service`);
  put('adrian', moved);
  const stubs = `
    id() { echo 0; }
    chown() { :; }
    chmod() { :; }
    journalctl() { :; }
    sleep() { SECONDS=$((SECONDS + $1 * 10)); }
    install() { if [ "$1" = -d ]; then shift 7; mkdir -p "$@"; return; fi; cp "$3" "$4"; }
    df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfs 1 1 %s 1%% /\\n' $(( ${o.freeMb ?? 50_000} * 1024 )); }
    systemctl() {
      echo "systemctl $*" >>"${root}/log"
      [ "$1" = restart ] && [ ${o.restartSeconds ?? 0} -gt 0 ] && command sleep ${o.restartSeconds ?? 0}
      [ "$1" = show ] && echo 0
      return 0
    }
    runuser() { case "$*" in *" port") echo "http 127.0.0.1 8790" ;; *" check") echo "Config is complete." ;; esac; }
    curl() {
      local url= a; for a; do case "$a" in http*) url=$a ;; esac; done
      echo "curl $url" >>"${root}/log"
      case "$url" in
        https://github.com/*/releases/latest) printf 'https://github.com/x/y/releases/tag/v${NEW}' ;;
        */releases/latest) ${o.rateLimited ? 'return 22' : `printf '{"tag_name":"v${NEW}"}'`} ;;
        */api/health) local f="${root}/health.$(basename "$(readlink -f "${root}/opt/current")")"; [ -f "$f" ] && cat "$f" || return 22 ;;
        *) return 22 ;;
      esac
    }
    export -f id chown chmod journalctl sleep install df systemctl runuser curl`;
  return {
    root,
    put,
    run: (args: string[], env: Record<string, string> = {}) => sh(`${stubs}; exec bash adrian "$@"`, args, env),
    /** The same, started in the background: for killing the terminal halfway. */
    start: (args: string[], env: Record<string, string> = {}) =>
      spawn(bash, ['-c', `${stubs}; exec bash adrian "$@"`, 'test', ...args], { cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    log: () => (existsSync(join(root, 'log')) ? readFileSync(join(root, 'log'), 'utf8') : ''),
    read: (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : ''),
    exists: (name: string) => existsSync(join(root, name)),
    version: () => sh('basename "$(readlink -f opt/current)"').out.trim(),
  };
}

describe.skipIf(!hasBash)('an update that was cut off', { timeout: 60_000 }, () => {
  it('after the switch, with the new version healthy: it stays, and the note goes', () => {
    const m = machine({ current: NEW, mark: `${OLD} ${NEW} switched` });
    const r = m.run(['update', '--auto']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${NEW} is running and healthy, so it stays`);
    expect(m.version()).toBe(NEW);
    expect(m.exists('opt/update-in-progress')).toBe(false);
  });

  it('after the switch, with the new version down: back to the old one, under its own service file', () => {
    const m = machine({ current: NEW, mark: `${OLD} ${NEW} switched`, health: { [OLD]: healthy } });
    m.put('adrian-voice.service', `unit of ${NEW}\n`);
    const r = m.run(['update', '--auto']);
    expect(r.err).toContain(`isn't healthy. Going back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.read('adrian-voice.service')).toBe(`unit of ${OLD}\n`);
    expect(m.log()).toMatch(/^systemctl restart adrian-voice$/m);
    expect(m.read('opt/update-failed').trim()).toBe(NEW);
    expect(m.exists(`opt/releases/${NEW}`)).toBe(false);
    expect(m.exists('opt/update-in-progress')).toBe(false);
  });

  it('before the switch: what it changed goes back, and the old one keeps running', () => {
    const m = machine({ mark: `${OLD} ${NEW} prep` });
    m.put('adrian-voice.service', `unit of ${NEW}\n`);
    const r = m.run(['update', '--check']);
    expect(r.code).toBe(0); // --check only looks
    expect(m.exists('opt/update-in-progress')).toBe(true);
    m.run(['update', '--auto']);
    expect(m.version()).toBe(OLD);
    expect(m.read('adrian-voice.service')).toBe(`unit of ${OLD}\n`);
    expect(m.exists(`opt/releases/${NEW}`)).toBe(false);
    expect(m.exists('opt/update-in-progress')).toBe(false);
    expect(m.log()).not.toMatch(/^systemctl restart/m);
  });

  it('shows in adrian status and doctor until then', () => {
    const m = machine({ current: NEW, mark: `${OLD} ${NEW} switched` });
    expect(m.run(['status']).out).toContain(`an update (${OLD} -> ${NEW}) was cut off`);
    expect(m.run(['doctor']).out).toMatch(/FAIL {2}an update \(1\.0\.0 -> 9\.9\.9\) was cut off/);
  });
});

describe.skipIf(!hasBash)('adrian update around it', { timeout: 60_000 }, () => {
  it("finds the newest release on the web page when GitHub's API is rate limited", () => {
    const r = machine({ rateLimited: true }).run(['update', '--check']);
    expect(r.out).toContain(`Version ${NEW} is available`);
  });

  it('waits, downloading nothing, when the disk is too full', () => {
    const m = machine({ freeMb: 100 });
    const r = m.run(['update', '--auto']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('waits: only 100 MB free');
    expect(m.log()).not.toContain('releases/download');
  });

  it('says what to do about a full disk by hand, and changes nothing', () => {
    const m = machine({ freeMb: 100 });
    const r = m.run(['update'], { ADRIAN_DETACH: '0' });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('Free some space');
    expect(m.version()).toBe(OLD);
  });

  it.runIf(has('flock'))('lets only one update run at a time', () => {
    const m = machine();
    const held = spawn('flock', [`${m.root}/opt/update.lock`, 'sleep', '5']);
    spawnSync('sleep', ['0.5']);
    try {
      const r = m.run(['update', '--auto']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('another update is running');
      expect(m.log()).not.toContain('releases/latest');
      const byHand = m.run(['update'], { ADRIAN_DETACH: '0' });
      expect(byHand.code).not.toBe(0);
      expect(byHand.err).toContain('another update is already running');
    } finally {
      held.kill();
    }
  });

  it.runIf(has('flock'))('while one runs, its note reads "under way", not "cut off", and rollback waits for it', () => {
    const m = machine({ current: NEW, mark: `${OLD} ${NEW} switched` });
    const held = spawn('flock', [`${m.root}/opt/update.lock`, 'sleep', '5']);
    spawnSync('sleep', ['0.5']);
    try {
      expect(m.run(['status']).out).toContain('is under way right now');
      const doctor = m.run(['doctor']).out;
      expect(doctor).toMatch(/warn {2}an update \(1\.0\.0 -> 9\.9\.9\) is under way/);
      expect(doctor).not.toContain('cut off');
      const r = m.run(['rollback']);
      expect(r.err).toContain('another update is already running');
      expect(m.version()).toBe(NEW);
      expect(m.exists('opt/update-in-progress')).toBe(true);
      // --check only looks: no lock, and it leaves the one running alone.
      expect(m.run(['update', '--check']).code).toBe(0);
    } finally {
      held.kill();
    }
  });

  // A dropped SSH connection sends SIGHUP to everything in the terminal's session.
  it.runIf(has('setsid') && process.platform !== 'win32')('by hand, carries on when the terminal goes away', async () => {
    // Work that takes a while: undoing a cut-off update restarts her (3 s here).
    const m = machine({ current: NEW, mark: `${OLD} ${NEW} switched`, health: { [OLD]: healthy }, restartSeconds: 3 });
    const child = m.start(['update'], { ADRIAN_DETACH: '1' });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((r) => setTimeout(r, 1500));
    expect(m.log()).toMatch(/^systemctl restart/m); // halfway
    process.kill(-child.pid!, 'SIGHUP'); // the terminal goes away
    await new Promise((r) => setTimeout(r, 6000));
    expect(out).toContain('Updating in the background');
    // It finished in its own session, and its log says so.
    expect(m.read('opt/update.log')).toContain(`Back on ${OLD}.`);
    expect(m.version()).toBe(OLD);
  }, 30_000);
});
