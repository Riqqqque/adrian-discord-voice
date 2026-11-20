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
/** Her health answer, as the process of version `v` gives it. */
const healthy = (v: string) => JSON.stringify({ ok: true, state: 'running', voiceReady: true, busy: false, version: v });

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
  /** Where opt/previous points, if anywhere. */
  previous?: string;
  /** The version whose process is running (default: where current points); a restart starts current's. */
  running?: string;
  /** systemd runs here (a systemd-run stand-in starts the unit), or systemd-run refuses. */
  systemdRun?: 'works' | 'fails';
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
  expect(sh(`set -e; mkdir -p opt/releases/${OLD} opt/releases/${NEW} opt/releases/0.9.0 opt/node/bin etc var/models published; ln -sfn releases/${o.current ?? OLD} opt/current`).code).toBe(0);
  if (o.previous) expect(sh(`ln -sfn releases/${o.previous} opt/previous`).code).toBe(0);
  put('running', `${o.running ?? o.current ?? OLD}\n`);
  if (o.systemdRun) mkdirSync(join(root, 'run-systemd'));
  if (o.systemdRun === 'fails') put('systemd-run-fails', '');
  put('opt/node/bin/node', `#!/usr/bin/env bash\nexec "${process.execPath.replaceAll('\\', '/')}" "$@"\n`, 0o755);
  put('etc/secrets.env', '');
  put('adrian-voice.service', `unit of ${o.current ?? OLD}\n`);
  if (o.mark) {
    put('opt/update-in-progress', `${o.mark}\n`);
    put('opt/update-in-progress.unit', `unit of ${OLD}\n`);
  }
  for (const [v, h] of Object.entries(o.health ?? { [OLD]: healthy(OLD), [NEW]: healthy(NEW) })) put(`health.${v}`, h);
  const moved = readFileSync(`${packaging}adrian`, 'utf8')
    .replace(/^OPT=.*$/m, `OPT=${root}/opt`)
    .replace(/^ETC=.*$/m, `ETC=${root}/etc`)
    .replace(/^VAR=.*$/m, `VAR=${root}/var`)
    .replace(/^UNIT=.*$/m, `UNIT=${root}/adrian-voice.service`)
    .replace(/^RUN_SYSTEMD=.*$/m, `RUN_SYSTEMD=${root}/run-systemd`);
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
      case "$1" in
        restart) [ ${o.restartSeconds ?? 0} -gt 0 ] && command sleep ${o.restartSeconds ?? 0}; basename "$(readlink -f "${root}/opt/current")" >"${root}/running" ;;
        show) case "$*" in *MainPID*) cat "${root}/unit.pid" 2>/dev/null || echo 0 ;; *) echo 0 ;; esac ;;
        is-active) case "$*" in *adrian-update.service*) [ -f "${root}/timer-running" ] ;; esac; return ;;
      esac
      return 0
    }
    # A unit of its own: started in the background, with the environment it was given.
    systemd-run() {
      echo "systemd-run $*" >>"${root}/log"
      [ ! -f "${root}/systemd-run-fails" ] || return 1
      local envs=() e
      while [ $# -gt 0 ]; do case "$1" in -E) envs+=("$2"); shift 2 ;; --*) shift ;; *) break ;; esac; done
      ( for e in "\${envs[@]}"; do export "$e"; done; exec "$@" ) </dev/null >/dev/null 2>&1 &
      echo $! >"${root}/unit.pid"
    }
    runuser() { case "$*" in *" port") echo "http 127.0.0.1 8790" ;; *" check") echo "Config is complete." ;; esac; }
    curl() {
      local url= a; for a; do case "$a" in http*) url=$a ;; esac; done
      echo "curl $url" >>"${root}/log"
      case "$url" in
        https://github.com/*/releases/latest) printf 'https://github.com/x/y/releases/tag/v${NEW}' ;;
        */releases/latest) ${o.rateLimited ? 'return 22' : `printf '{"tag_name":"v${NEW}"}'`} ;;
        */api/health) local f="${root}/health.$(cat "${root}/running")"; [ -f "$f" ] && cat "$f" || return 22 ;;
        *) return 22 ;;
      esac
    }
    export -f id chown chmod journalctl sleep install df systemctl systemd-run runuser curl`;
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
    previous: () => sh('[ -L opt/previous ] && basename "$(readlink -f opt/previous)" || true').out.trim(),
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
    const m = machine({ current: NEW, mark: `${OLD} ${NEW} switched`, health: { [OLD]: healthy(OLD) } });
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

  it('during its own rollback, before it switched back: finished, the failure remembered, "previous" as before the update', () => {
    // Cut off right after the rollback began: still on the new one, which "previous" doesn't name.
    const m = machine({ current: NEW, previous: OLD, mark: `${OLD} ${NEW} rollback releases/0.9.0`, health: { [OLD]: healthy(OLD) } });
    m.put('adrian-voice.service', `unit of ${NEW}\n`);
    const r = m.run(['update', '--auto']);
    expect(r.err).toContain(`was being undone when it was cut off. Finishing that: back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.read('adrian-voice.service')).toBe(`unit of ${OLD}\n`);
    expect(m.read('opt/update-failed').trim()).toBe(NEW);
    expect(m.previous()).toBe('0.9.0');
    expect(m.exists(`opt/releases/${NEW}`)).toBe(false);
    expect(m.exists('opt/update-in-progress')).toBe(false);
    // And the hourly check doesn't try the failed one again at once.
    expect(r.out).toContain(`update ${NEW} skipped: it failed here in the last day`);
  });

  it('during its own rollback, after it switched back: adrian rollback never goes onto the failed release', () => {
    // The state the review found: back on the old one, the failed one as "previous", a note that still says "switched".
    const m = machine({ current: OLD, previous: NEW, mark: `${OLD} ${NEW} switched` });
    const r = m.run(['rollback']);
    expect(r.out + r.err).not.toContain(`Switching ${OLD} -> ${NEW}`);
    expect(m.version()).toBe(OLD);
    expect(m.read('opt/update-failed').trim()).toBe(NEW);
    expect(m.exists(`opt/releases/${NEW}`)).toBe(false);
    expect(m.previous()).not.toBe(NEW);
  });

  it('between the switch and the restart: the old process still answering doesn\'t pass for the new version', () => {
    // current points at the new one, but the process answering is still the old one's.
    const m = machine({ current: NEW, running: OLD, mark: `${OLD} ${NEW} switched releases/0.9.0`, health: { [OLD]: healthy(OLD) } });
    const r = m.run(['update', '--auto']);
    expect(r.out).toContain(`Starting ${NEW} to check it`);
    expect(r.err).toContain(`isn't healthy. Going back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.read('opt/update-failed').trim()).toBe(NEW);
    expect(m.previous()).toBe('0.9.0');
  });

  it('between the switch and the restart, with a good new version: it is started, checked and kept', () => {
    const m = machine({ current: NEW, running: OLD, mark: `${OLD} ${NEW} switched releases/0.9.0` });
    const r = m.run(['update', '--auto']);
    expect(r.out).toContain(`${NEW} is running and healthy, so it stays`);
    expect(m.log()).toMatch(/^systemctl restart adrian-voice$/m);
    expect(m.version()).toBe(NEW);
    expect(m.exists('opt/update-failed')).toBe(false);
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
    const m = machine({ current: NEW, mark: `${OLD} ${NEW} switched`, health: { [OLD]: healthy(OLD) }, restartSeconds: 3 });
    const child = m.start(['update'], { ADRIAN_DETACH: '1' });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((r) => setTimeout(r, 1500));
    expect(m.log()).toMatch(/^systemctl restart/m); // halfway
    process.kill(-child.pid!, 'SIGHUP'); // the terminal goes away
    for (let i = 0; i < 150 && !m.read('opt/update.log').includes(`Back on ${OLD}.`); i++) await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain('Updating in the background');
    // It finished in its own session, and its log says so.
    expect(m.read('opt/update.log')).toContain(`Back on ${OLD}.`);
    expect(m.version()).toBe(OLD);
  }, 30_000);

  // The natural move after a dropped connection: run it again.
  it.runIf(has('flock'))('run again while one runs: follows its log and never wipes it', () => {
    const m = machine({ systemdRun: 'works' });
    m.put('opt/update.log', '== Update started earlier\nDownloading 9.9.9\n');
    const held = spawn('flock', [`${m.root}/opt/update.lock`, 'sleep', '3']);
    spawnSync('sleep', ['0.5']);
    try {
      const r = m.run(['update'], { ADRIAN_DETACH: '1' });
      expect(r.out).toContain(`Another update is already running. Following its log, ${m.root}/opt/update.log`);
      expect(r.out).toContain('Downloading 9.9.9'); // what it had written so far, shown
      expect(m.read('opt/update.log')).toBe('== Update started earlier\nDownloading 9.9.9\n');
      expect(m.log()).not.toContain('systemd-run');
    } finally {
      held.kill();
    }
  }, 30_000);

  it.runIf(has('flock'))('names the right log when it refuses: the hourly check\'s journal, or update.log', () => {
    const m = machine();
    const held = spawn('flock', [`${m.root}/opt/update.lock`, 'sleep', '5']);
    spawnSync('sleep', ['0.5']);
    try {
      expect(m.run(['update'], { ADRIAN_DETACH: '0' }).err).toContain(`follow it: sudo tail -f ${m.root}/opt/update.log`);
      m.put('timer-running', '');
      expect(m.run(['update'], { ADRIAN_DETACH: '0' }).err).toContain('follow it: sudo journalctl -u adrian-update -f');
    } finally {
      held.kill();
    }
  }, 30_000);

  // logind ends the whole login session at logout where KillUserProcesses=yes
  // (upstream's default): only a unit of its own is out of its reach.
  it('by hand, runs as a systemd unit of its own where systemd can, and says where its log is', () => {
    const m = machine({ systemdRun: 'works' });
    m.put('opt/update.log', 'an earlier run\n');
    const r = m.run(['update'], { ADRIAN_DETACH: '1', ADRIAN_UPDATE_REPO: 'example/repo', https_proxy: 'http://proxy.invalid:3128' });
    expect(r.out).toContain('Updating in the background (as its own service, adrian-update-by-hand-');
    expect(r.out).toContain(`Its log: ${m.root}/opt/update.log (follow it from anywhere: sudo tail -f ${m.root}/opt/update.log)`);
    const call = m.log().split('\n').find((l) => l.startsWith('systemd-run ')) ?? '';
    expect(call).toMatch(/--unit=adrian-update-by-hand-\S+ --collect/);
    // A unit starts with systemd's environment: what the update needs is handed over.
    expect(call).toContain('-E ADRIAN_UPDATE_REPO=example/repo');
    expect(call).toContain('-E https_proxy=http://proxy.invalid:3128');
    // It ran (the download fails here), its log is its own, and its exit code is this command's.
    const log = m.read('opt/update.log');
    expect(log).toMatch(/^== Update started /);
    expect(log).not.toContain('an earlier run');
    expect(log).toContain(`the download of ${NEW} failed`);
    expect(r.out).toContain(`the download of ${NEW} failed`);
    expect(r.code).toBe(1);
  }, 30_000);

  it.runIf(has('setsid'))('by hand, falls back to a session of its own where systemd-run is refused', () => {
    const m = machine({ systemdRun: 'fails' });
    const r = m.run(['update'], { ADRIAN_DETACH: '1' });
    expect(r.out).toContain('Updating in the background (in a session of its own)');
    expect(m.read('opt/update.log')).toContain(`the download of ${NEW} failed`);
    expect(r.code).toBe(1);
  }, 30_000);
});
