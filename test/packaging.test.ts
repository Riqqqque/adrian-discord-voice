// The shell side of restores and updates, run for real in bash: `adrian restore`
// against throwaway archives, and the limits on model downloads.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// ADRIAN_PACKAGING_UNDER_TEST points these tests at another copy (an older release's, say).
const packaging = (process.env.ADRIAN_PACKAGING_UNDER_TEST ?? fileURLToPath(new URL('../packaging/', import.meta.url))).replaceAll('\\', '/').replace(/\/?$/, '/');
// On Windows a plain `bash` may be WSL's launcher.
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const hasBash = spawnSync(bash, ['-c', 'tar --version && gzip --version'], { stdio: 'ignore' }).status === 0;
const hasXz = hasBash && spawnSync(bash, ['-c', 'xz --version'], { stdio: 'ignore' }).status === 0;
const work = mkdtempSync(join(tmpdir(), 'adrian-packaging-'));

/** One tar entry. Built by hand so a test can hold names a real backup never would. */
function entry(name: string, type = '0', link = ''): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, at: number) => h.write(s, at, 'latin1');
  put(name, 0);
  put('0000600\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put('00000000000\0', 124);
  put('00000000000\0', 136);
  put('        ', 148);
  put(type, 156);
  put(link, 157);
  put('ustar\x0000', 257);
  put(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const pack = (entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
// Enough listing to overflow the pipe to grep on Linux too (64 KB there).
const state = Array.from({ length: 5000 }, (_, i) => entry(`var/lib/adrian/state/file-${String(i).padStart(4, '0')}`));

function restore(backup: Buffer): { code: number | null; err: string; stopped: boolean } {
  writeFileSync(join(work, 'backup.tar.gz'), backup);
  const log = join(work, 'systemctl.log');
  rmSync(log, { force: true });
  // `id` says root. `systemctl` logs and fails, so a check that misses stops
  // the script at `systemctl stop`, before tar extracts anything.
  const script = 'id() { echo 0; }; systemctl() { echo "$*" >>systemctl.log; return 1; }; export -f id systemctl; exec bash "$1" restore backup.tar.gz';
  const r = spawnSync(bash, ['-c', script, 'test', `${packaging}adrian`], { cwd: work, encoding: 'utf8' });
  return { code: r.status, err: r.stderr, stopped: existsSync(log) };
}

describe.skipIf(!hasBash)('adrian restore', () => {
  it.each([
    ['a path outside her folders', entry('etc/cron.d/adrian-test'), 'outside'],
    ['an absolute path', entry('/etc/cron.d/adrian-test'), 'outside'],
    ['a .. path inside her folders', entry('etc/adrian/../../etc/cron.d/adrian-test'), '..'],
    ['a symbolic link', entry('etc/adrian/link', '2', '/etc/shadow'), 'links'],
    ['a hard link', entry('etc/adrian/link', '1', 'etc/shadow'), 'links'],
  ])('refuses %s at the head of a big backup', (_, bad, why) => {
    const r = restore(pack([bad, ...state]));
    expect(r.err).toContain('refusing');
    expect(r.err).toContain(why);
    expect(r.code).not.toBe(0);
    expect(r.stopped).toBe(false);
  }, 60_000);

  it('still refuses it in a small backup', () => {
    const r = restore(pack([entry('etc/cron.d/adrian-test'), ...state.slice(0, 5)]));
    expect(r.err).toContain('refusing');
    expect(r.stopped).toBe(false);
  }, 60_000);

  it('refuses a truncated backup before stopping anything', () => {
    const whole = pack([entry('etc/adrian/config.json'), ...state]);
    const r = restore(whole.subarray(0, Math.floor(whole.length / 2)));
    expect(r.err).toContain("can't read");
    expect(r.code).not.toBe(0);
    expect(r.stopped).toBe(false);
  }, 60_000);

  it('lets a clean backup through to the restore itself', () => {
    const r = restore(pack([entry('etc/adrian/', '5'), entry('etc/adrian/config.json'), entry('var/lib/adrian/', '5'), ...state]));
    expect(r.err).not.toContain('refusing');
    expect(r.stopped).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasBash)('model downloads', () => {
  it('give up on a stalled connection, but have no limit on total time', () => {
    const script = '. "$1"; curl() { printf "%s\\n" "$@" >curl.args; }; fetch https://example.invalid/model.bin 00 model.bin';
    spawnSync(bash, ['-c', script, 'test', `${packaging}downloads.sh`], { cwd: work, stdio: 'ignore' });
    const args = readFileSync(join(work, 'curl.args'), 'utf8').trim().split('\n');
    const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    expect(value('--connect-timeout')).toBe('30');
    expect(value('--speed-time')).toBe('60');
    expect(value('--speed-limit')).toBe('1024');
    expect(args).not.toContain('--max-time');
  });

  // About 4 minutes with the real limits (4 tries of 60 s), so only on request:
  // ADRIAN_SLOW_TESTS=1 npx vitest run test/packaging.test.ts
  it.runIf(process.env.ADRIAN_SLOW_TESTS)('stop with an error when the server goes silent', async () => {
    const pem = spawnSync(bash, ['-c', 'openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 -subj /CN=localhost'], {
      cwd: work,
      stdio: 'ignore',
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
    expect(pem.status).toBe(0);
    writeFileSync(join(work, '.curlrc'), 'insecure\n'); // the throwaway cert
    let requests = 0;
    const server = createServer({ key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) }, (_req, res) => {
      requests++;
      res.writeHead(200, { 'content-length': '1000000' });
      res.write(Buffer.alloc(2048)); // and then nothing, with the connection left open
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const script = `set -euo pipefail; . "$1"; fetch https://127.0.0.1:${port}/model.bin 00 model.bin`;
    const child = spawn(bash, ['-c', script, 'test', `${packaging}downloads.sh`], { cwd: work, stdio: 'ignore', env: { ...process.env, CURL_HOME: work } });
    const started = Date.now();
    const closed = new Promise<number | null>((done) => child.on('close', done));
    const limit = new Promise<'hung'>((done) => setTimeout(done, 5 * 60_000, 'hung').unref());
    const code = await Promise.race([closed, limit]);
    child.kill();
    server.closeAllConnections();
    server.close();
    expect(code).toBe(28);
    expect(requests).toBe(4);
    expect(Date.now() - started).toBeGreaterThan(3 * 60_000);
  }, 6 * 60_000);
});

describe('adrian-update.service', () => {
  it('has a start limit, generous enough for a model download on a slow line', () => {
    const service = readFileSync(`${packaging}adrian-update.service`, 'utf8').split('[Service]')[1]!;
    const m = /^TimeoutStartSec=(\d+)(min|h)$/m.exec(service);
    expect(m).not.toBeNull();
    expect(Number(m![1]) * (m![2] === 'h' ? 60 : 1)).toBeGreaterThanOrEqual(120);
  });
});

describe('pinned downloads', () => {
  const pins = readFileSync(`${packaging}downloads.sh`, 'utf8');

  it('are the releases with the security fixes, with the hashes upstream publishes', () => {
    expect(pins).toContain('NODE_VERSION=22.23.4\n');
    expect(pins).toContain('NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce\n');
    expect(pins).toContain('yt-dlp/releases/download/2026.08.19/yt-dlp_linux|58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a|bin');
  });
});

const sandbox = (name: string) => mkdtempSync(join(work, `${name}-`)).replaceAll('\\', '/');
/** A script's fixed paths, moved into a sandbox. */
const moved = (script: string, root: string) =>
  script.replace(/^OPT=.*$/m, `OPT=${root}/opt`).replace(/^ETC=.*$/m, `ETC=${root}/etc`).replace(/^VAR=.*$/m, `VAR=${root}/var`).replace(/^UNIT=.*$/m, `UNIT=${root}/adrian-voice.service`);
const sh =(root: string, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(bash, ['-c', script, 'test', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, MSYS: 'winsymlinks:lnk', MSYS_NO_PATHCONV: '1', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const link = (root: string, path: string) => sh(root, 'readlink "$1"', [path]).out.trim();
/** Stand-ins for what a script expects of a real server. */
const server = 'id() { echo 0; }; install() { :; }; chown() { :; }; chmod() { :; }; systemctl() { :; }; export -f id install chown chmod systemctl;';

describe.skipIf(!hasXz)('the Node runtime', () => {
  /** /opt/adrian with an older Node running, and the new one's archive in the download cache. */
  function installed(newNode = 'echo v9.9.9') {
    const root = sandbox('node');
    const setup = [
      'set -e',
      'mkdir -p opt/node-v1.0.0/bin opt/node-v0.9.0/bin cache new/node-v9.9.9/bin',
      'printf "#!/bin/sh\\necho v1.0.0\\n" >opt/node-v1.0.0/bin/node',
      'chmod +x opt/node-v1.0.0/bin/node',
      'ln -sfn node-v1.0.0 opt/node',
      `printf '#!/bin/sh\\n%s\\n' "$1" >new/node-v9.9.9/bin/node`,
      'chmod +x new/node-v9.9.9/bin/node',
      'tar -cJf cache/node-v9.9.9-linux-x64.tar.xz -C new node-v9.9.9',
      'sha256sum cache/node-v9.9.9-linux-x64.tar.xz | cut -d" " -f1',
    ].join('\n');
    const made = sh(root, setup, [newNode]);
    expect(made.code).toBe(0);
    return { root, sha: made.out.trim() };
  }
  const pinned = (sha: string) => `NODE_VERSION=9.9.9; NODE_SHA256=${sha}; NODE_URL=https://example.invalid/node-v9.9.9-linux-x64.tar.xz; curl() { return 7; };`;
  const step = (root: string, sha: string) =>
    sh(root, `set -euo pipefail; . "${packaging}downloads.sh"; ${pinned(sha)} mkdir -p tmp; install_node "$PWD/opt" "$PWD/tmp"`, [], { ADRIAN_DOWNLOAD_CACHE: `${root}/cache` });

  it('moves to the pinned version', () => {
    const { root, sha } = installed();
    const r = step(root, sha);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(link(root, 'opt/node')).toBe('node-v9.9.9');
    expect(sh(root, 'opt/node/bin/node').out.trim()).toBe('v9.9.9');
  });

  it('keeps the one it replaced, and nothing older', () => {
    const { root, sha } = installed();
    step(root, sha);
    expect(existsSync(join(root, 'opt/node-v1.0.0/bin/node'))).toBe(true);
    expect(existsSync(join(root, 'opt/node-v0.9.0'))).toBe(false);
  });

  it('a failed download leaves the old one running', () => {
    const { root } = installed();
    rmSync(join(root, 'cache/node-v9.9.9-linux-x64.tar.xz'));
    const r = step(root, '0'.repeat(64));
    expect(r.code).not.toBe(0);
    expect(link(root, 'opt/node')).toBe('node-v1.0.0');
    expect(sh(root, 'opt/node/bin/node').out.trim()).toBe('v1.0.0');
  });

  it('a file that fails its hash leaves the old one running', () => {
    const { root } = installed();
    const r = step(root, '0'.repeat(64));
    expect(r.code).not.toBe(0);
    expect(link(root, 'opt/node')).toBe('node-v1.0.0');
    expect(existsSync(join(root, 'opt/node-v9.9.9'))).toBe(false);
  });

  it('a new one that will not run on this system leaves the old one running', () => {
    const { root, sha } = installed('exit 1');
    const r = step(root, sha);
    expect(r.code).not.toBe(0);
    expect(link(root, 'opt/node')).toBe('node-v1.0.0');
    expect(existsSync(join(root, 'opt/node-v9.9.9'))).toBe(false);
  });

  it('downloads nothing when it is already there', () => {
    const { root, sha } = installed();
    step(root, sha);
    rmSync(join(root, 'cache/node-v9.9.9-linux-x64.tar.xz'));
    expect(step(root, sha).code).toBe(0);
    expect(link(root, 'opt/node')).toBe('node-v9.9.9');
  });

  /** The release's own upgrade-prep.sh, with models that are `model` and a Node to move to. */
  function prepare(model: string, sha: string, root: string, before = '') {
    mkdirSync(join(root, 'release'));
    const pins = readFileSync(`${packaging}downloads.sh`, 'utf8')
      .replace(/^NODE_VERSION=.*$/m, 'NODE_VERSION=9.9.9')
      .replace(/^NODE_SHA256=.*$/m, `NODE_SHA256=${sha}`)
      .replace(/^NODE_URL=.*$/m, 'NODE_URL=https://example.invalid/node-v9.9.9-linux-x64.tar.xz')
      .replace(/^MODELS=\([\s\S]*?^\)$/m, `MODELS=(${model})`);
    writeFileSync(join(root, 'release/downloads.sh'), pins);
    writeFileSync(join(root, 'release/upgrade-prep.sh'), moved(readFileSync(`${packaging}upgrade-prep.sh`, 'utf8'), root));
    return sh(root, `${server} curl() { return 7; }; export -f curl; ${before} exec bash release/upgrade-prep.sh`, [], { ADRIAN_DOWNLOAD_CACHE: `${root}/cache` });
  }

  // The service isn't root: if it can't get into the new folder it can't start,
  // and rolling back the release doesn't bring the old Node back.
  it.each(['umask 027;', 'umask 077;'])('upgrade-prep.sh leaves Node open to the service under %s', (umask) => {
    const { root, sha } = installed();
    // What mkdir runs under, as Git Bash's temp folder fakes the modes it reports.
    const r = prepare('', sha, root, `${umask} mkdir() { umask >>"${root}/umask.log"; command mkdir "$@"; }; export -f mkdir;`);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, 'umask.log'), 'utf8').trim().split('\n')).toEqual(['0022']);
  });

  it('upgrade-prep.sh brings it up to date, which a release alone never did', () => {
    const { root, sha } = installed();
    const r = prepare('', sha, root);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(link(root, 'opt/node')).toBe('node-v9.9.9');
  });

  it('upgrade-prep.sh failing on a model leaves Node alone: `adrian update` says nothing was switched', () => {
    const { root, sha } = installed();
    const r = prepare('"model.bin|https://example.invalid/model.bin|00|file"', sha, root);
    expect(r.code).not.toBe(0);
    expect(link(root, 'opt/node')).toBe('node-v1.0.0');
  });

  it('install.sh uses the same step', () => {
    expect(readFileSync(`${packaging}install.sh`, 'utf8')).toMatch(/^install_node "\$OPT" "\$TMP"$/m);
  });
});

describe.skipIf(!hasBash)('auto-update', () => {
  /** `adrian update ARGS` on a server with a newer release out; `check` is what `adrian check` exits with. */
  function update(args: string[], check: number) {
    const root = sandbox('cli');
    mkdirSync(join(root, 'opt/node/bin'), { recursive: true });
    writeFileSync(join(root, 'opt/node/bin/node'), `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "$@"\n`, { mode: 0o755 });
    writeFileSync(join(root, 'adrian'), moved(readFileSync(`${packaging}adrian`, 'utf8'), root));
    const stubs = `${server}
      curl() {
        case "$*" in
          *releases/latest*) printf '{"tag_name":"v9.9.9"}' ;;
          */api/health*) return 22 ;;
          *) echo "$*" >>downloads.log; return 22 ;;
        esac
      }
      runuser() {
        case "$*" in
          *" check"*) [ ${check} = 1 ] && echo "/etc/adrian/config.json is not valid JSON: Expected double-quoted property name." >&2; return ${check} ;;
          *" port"*) echo "http 127.0.0.1 8790" ;;
        esac
      }
      export -f curl runuser
      exec bash adrian update "$@"`;
    const r = sh(root, stubs, args);
    return { ...r, downloaded: existsSync(join(root, 'downloads.log')) };
  }

  it('skips a broken config.json with a line in the log, and downloads nothing', () => {
    const r = update(['--auto'], 1);
    expect(r.code).toBe(0);
    expect(r.downloaded).toBe(false);
    expect(r.out).toContain('update 9.9.9 waits');
    expect(r.out).toContain('config.json is not valid JSON');
  });

  it('goes ahead for a config that is fine', () => {
    expect(update(['--auto'], 0).downloaded).toBe(true);
  });

  it('goes ahead while setup is unfinished: that is healthy, and it can update', () => {
    expect(update(['--auto'], 3).downloaded).toBe(true);
  });

  it('never stands in the way of an update by hand', () => {
    expect(update([], 1).downloaded).toBe(true);
  });
});

describe.skipIf(!hasBash)('adrian update, judged against the version it replaces', () => {
  const OLD = '1.0.0';
  const NEW = '9.9.9';
  const health = (fields: object = {}) => JSON.stringify({ ok: true, state: 'running', voiceReady: true, busy: false, ...fields });
  const noVoice = health({ voiceReady: false });
  const setupMode = health({ state: 'setup', voiceReady: false });

  /** What each version does. A health of null: nothing answers. */
  interface Release {
    before?: string | null;
    after?: string | null;
    /** The old version's health once upgrade-prep.sh is done. */
    afterPrep?: string;
    /** The new version's health once the minute's watch is over. */
    afterAMinute?: string;
    /** When that passes and its normal health is back, on the fake clock. */
    backAfter?: number;
    /** Seconds after the update starts before the new version answers. */
    comesUpAfter?: number;
    /** systemd restarted it by itself during that minute. */
    crashes?: boolean;
    /** Systemd can't start it under its new service file. */
    badUnit?: boolean;
    /** Systemd won't start anything. */
    noStarts?: boolean;
    /** The old service file can't be put back. */
    unitStuck?: boolean;
    /** Nothing can be written where the failed version is remembered. */
    markerStuck?: boolean;
    /** Exit code and words of the new release's `check`. */
    check?: [number, string];
    /** upgrade-prep.sh fails on its last step, after the service file. */
    prepFails?: boolean;
    /** What's already in /opt/adrian/update-failed. */
    failed?: string;
    /** And how long ago it was written. */
    failedHoursAgo?: number;
    /** The update is killed (a power cut) during this restart: 1 is the switch's, 2 the rollback's. */
    cutAtRestart?: number;
    /** MB free on the disk (df), instead of the real figure. */
    freeMb?: number;
    /** The MODELS entries of the new release's downloads.sh (none by default). */
    models?: string;
  }

  // The fake clock runs ten times as fast, so the waits can keep their real lengths.
  const stubs = `${server}
    install() {
      if [ "$1" = -d ]; then shift 7; mkdir -p "$@"; return; fi
      case "$3" in *adrian-voice.service) ;; *) [ ! -f unit-stuck ] || return 1 ;; esac
      cp "$3" "$4"
    }
    sleep() { echo "sleep $1" >>log; SECONDS=$((SECONDS + $1 * 10)); [ "$1" = 1 ] || : >watched; }
    journalctl() { cat journal 2>/dev/null || :; } # her log, when a test gives her one
    # Something else listening on her port (ss), when a test says so.
    ss() { [ ! -f port-taken ] || echo 'LISTEN 0 511 127.0.0.1:8790 0.0.0.0:*'; }
    # A restore extracts to /: never here.
    tar() { if [ "$1" = -xzf ] && [ "$3" = -C ] && [ "$4" = / ]; then echo "restore extracted" >>log; return 0; fi; command tar "$@"; }
    systemctl() {
      case "$1" in
        show) [ -f watched ] && cat restarts 2>/dev/null || echo 0 ;;
        restart) echo "restart under: $(cat adrian-voice.service)" >>log
          local n=$(( $(cat restarts.n 2>/dev/null || echo 0) + 1 )); echo $n >restarts.n
          [ "$(cat cut-at 2>/dev/null)" != "$n" ] || kill -9 $$
          [ ! -f no-starts ] && { [ ! -f bad-unit ] || ! grep -q ${NEW} adrian-voice.service; } ;;
        daemon-reload) echo reload >>log; : >prepared ;;
      esac
    }
    curl() {
      local out=
      while [ $# -gt 1 ]; do [ "$1" != -o ] || out=$2; shift; done
      case "$1" in
        *releases/latest) printf '{"tag_name":"v${NEW}"}' ;;
        */api/health)
          echo "$1" >>health.urls
          # An IPv6 address without brackets is no address curl can reach.
          case "$1" in *://[[]*) ;; *://*:*:*) return 3 ;; esac
          local f; f=health.$(basename "$(readlink -f opt/current)")
          [ ! -f prepared ] || [ ! -f "$f.prepared" ] || f=$f.prepared
          [ ! -f watched ] || [ ! -f "$f.watched" ] || { [ -f "$f.back" ] && [ $SECONDS -ge "$(cat "$f.back")" ]; } || f=$f.watched
          [ -f "$f" ] && [ $SECONDS -ge "$(cat "$f.from" 2>/dev/null || echo 0)" ] && cat "$f" || return 22 ;;
        *nodejs.org*) return 7 ;;
        *) echo "download $1" >>log; cp "published/$(basename "$1")" "$out" ;;
      esac
    }
    runuser() {
      case "$*" in
        *" port") cat port.says 2>/dev/null || echo "http 127.0.0.1 8790" ;;
        *"releases/${NEW}/dist/cli/tool.js check") echo "asked ${NEW}" >>log; cat check.says; return "$(cat check.exit)" ;;
        *" check") echo "Config is complete." ;;
      esac
    }
    df() {
      [ -f free-mb ] || { command df "$@"; return; }
      printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfs 1 1 %s 1%% /\\n' $(( $(cat free-mb) * 1024 ))
    }
    export -f install sleep journalctl ss tar systemctl curl runuser df
    exec bash adrian "$@"`;

  /** A server on the old version, with the new one out. */
  function machine(r: Release = {}) {
    const root = sandbox('update');
    const put = (name: string, text: string) => writeFileSync(join(root, name), text);
    const setup = [
      'set -e',
      `mkdir -p opt/releases/${OLD} opt/releases/0.9.0 opt/node-v${OLD}/bin etc var/models published new/packaging`,
      `ln -sfn releases/${OLD} opt/current`,
      'ln -sfn releases/0.9.0 opt/previous',
      `ln -sfn node-v${OLD} opt/node`,
    ].join('\n');
    expect(sh(root, setup).code).toBe(0);
    // node.exe can't read the /tmp path a release is unpacked in, in Git Bash.
    const node = `#!/usr/bin/env bash
if [ "$1" = -p ]; then sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$(sed -E "s/.*require\\('([^']+)'\\).*/\\1/" <<<"$2")"; exit; fi
exec "${process.execPath.replaceAll('\\', '/')}" "$@"\n`;
    writeFileSync(join(root, `opt/node-v${OLD}/bin/node`), node, { mode: 0o755 });
    put('adrian', moved(readFileSync(`${packaging}adrian`, 'utf8'), root));
    put('adrian-voice.service', `unit of ${OLD}\n`);
    put('etc/secrets.env', '');
    put('new/package.json', `{"version":"${NEW}"}\n`);
    put('new/packaging/adrian-voice.service', `unit of ${NEW}\n`);
    put('new/packaging/upgrade-prep.sh', moved(readFileSync(`${packaging}upgrade-prep.sh`, 'utf8'), root));
    put(
      'new/packaging/downloads.sh',
      readFileSync(`${packaging}downloads.sh`, 'utf8')
        .replace(/^NODE_VERSION=.*$/m, `NODE_VERSION=${r.prepFails ? NEW : OLD}`)
        .replace(/^MODELS=\([\s\S]*?^\)$/m, `MODELS=(${r.models ?? ''})`),
    );
    const name = `adrian-voice-${NEW}-linux-x64.tar.gz`;
    expect(sh(root, `set -e; tar -czf "published/${name}" -C new .; cd published; sha256sum "${name}" >"${name}.sha256"`).code).toBe(0);
    if (r.before !== null) put(`health.${OLD}`, r.before ?? health());
    if (r.after !== null) put(`health.${NEW}`, r.after ?? health());
    if (r.afterPrep) put(`health.${OLD}.prepared`, r.afterPrep);
    if (r.afterAMinute !== undefined) put(`health.${NEW}.watched`, r.afterAMinute);
    if (r.backAfter) put(`health.${NEW}.back`, String(r.backAfter));
    if (r.comesUpAfter) put(`health.${NEW}.from`, String(r.comesUpAfter));
    if (r.crashes) put('restarts', '1\n');
    if (r.badUnit) put('bad-unit', '');
    if (r.noStarts) put('no-starts', '');
    if (r.unitStuck) put('unit-stuck', '');
    if (r.markerStuck) mkdirSync(join(root, 'opt/update-failed'));
    if (r.cutAtRestart) put('cut-at', String(r.cutAtRestart));
    if (r.freeMb !== undefined) put('free-mb', String(r.freeMb));
    put('check.exit', String(r.check?.[0] ?? 0));
    put('check.says', r.check?.[1] ?? 'Config is complete.\n');
    const marker = join(root, 'opt/update-failed');
    if (r.failed) put('opt/update-failed', `${r.failed}\n`);
    if (r.failedHoursAgo) utimesSync(marker, new Date(), new Date(Date.now() - r.failedHoursAgo * 3_600_000));
    const log = () => (existsSync(join(root, 'log')) ? readFileSync(join(root, 'log'), 'utf8') : '');
    return {
      root,
      marker: () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined),
      run: (...args: string[]) => sh(root, stubs, args),
      /** One run of the hourly timer. */
      hourly: () => sh(root, stubs, ['update', '--auto']),
      log,
      restarts: () => log().match(/^restart under: .*$/gm) ?? [],
      downloads: () => log().match(/^download .*\.tar\.gz$/gm) ?? [],
      unit: () => readFileSync(join(root, 'adrian-voice.service'), 'utf8').trim(),
      version: () => link(root, 'opt/current').replace('releases/', ''),
      previous: () => link(root, 'opt/previous').replace('releases/', ''),
      unpacked: (version: string) => existsSync(join(root, 'opt/releases', version)),
    };
  }

  it('keeps a good release, after watching it for a minute', () => {
    const m = machine();
    const r = m.hourly();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Updated to ${NEW}`);
    expect(m.version()).toBe(NEW);
    expect(m.previous()).toBe(OLD);
    expect(m.log()).toContain('sleep 60');
    expect(m.restarts()).toEqual([`restart under: unit of ${NEW}`]);
  }, 60_000);

  it('gives it up to two minutes to come up', () => {
    const m = machine({ comesUpAfter: 100 });
    expect(m.hourly().code).toBe(0);
    expect(m.version()).toBe(NEW);
  }, 60_000);

  it.each([
    ['lands in setup mode, when her config was running', { after: setupMode }],
    ['lands in setup mode, when she was running but not in a call', { before: noVoice, after: setupMode }],
    ['logs in but never joins her call', { after: noVoice }],
    ['never answers', { after: null }],
    ['crashes after a good start', { crashes: true }],
    ['stops answering during the minute', { afterAMinute: '' }],
    ['leaves her call during the minute', { afterAMinute: noVoice }],
    ['has a service file systemd can\'t start', { badUnit: true }],
  ] as [string, Release][])('rolls back a release that %s', (_, release) => {
    const m = machine(release);
    const r = m.hourly();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`rolled back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.previous()).toBe('0.9.0');
    expect(m.unpacked(NEW)).toBe(false);
    expect(m.restarts().at(-1)).toBe(`restart under: unit of ${OLD}`);
  }, 60_000);

  it('rides out a voice drop during the last check: a drop can take most of a minute to come back', () => {
    const m = machine({ afterAMinute: noVoice, backAfter: 640 }); // the check starts at 600
    const r = m.hourly();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(m.version()).toBe(NEW);
    expect(m.marker()).toBeUndefined();
  }, 60_000);

  it('asks for no more than the old version managed: voice already down', () => {
    const m = machine({ before: noVoice, after: noVoice });
    expect(m.hourly().code).toBe(0);
    expect(m.version()).toBe(NEW);
  }, 60_000);

  it('can always update out of a version that does not answer: ok is enough', () => {
    const m = machine({ before: null, after: setupMode });
    expect(m.hourly().code).toBe(0);
    expect(m.version()).toBe(NEW);
  }, 60_000);

  it('still rolls back one that does not come up either', () => {
    const m = machine({ before: null, after: null });
    expect(m.hourly().code).not.toBe(0);
    expect(m.version()).toBe(OLD);
  }, 60_000);

  it('finishes rolling back when systemd won\'t start the old version either', () => {
    const m = machine({ noStarts: true, before: null });
    const r = m.hourly();
    expect(r.err).toContain('not healthy either');
    expect(m.version()).toBe(OLD);
    expect(m.previous()).toBe('0.9.0');
    expect(m.unpacked(NEW)).toBe(false);
    expect(m.marker()).toBe(NEW);
  }, 60_000);

  it('restarts the old version even if its service file will not go back', () => {
    const m = machine({ after: null, unitStuck: true });
    const r = m.hourly();
    expect(r.err).toContain(`rolled back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.restarts()).toHaveLength(2);
    expect(m.previous()).toBe('0.9.0');
    expect(m.unpacked(NEW)).toBe(false);
    expect(m.marker()).toBe(NEW);
  }, 60_000);

  it('finishes rolling back with nowhere to remember the failure: a full disk may be why it failed', () => {
    const m = machine({ after: null, markerStuck: true });
    const r = m.hourly();
    expect(r.err).toContain(`rolled back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.previous()).toBe('0.9.0');
    expect(m.unpacked(NEW)).toBe(false);
  }, 60_000);

  it('adrian help lists every command', () => {
    const r = machine().run('help');
    for (const cmd of ['adrian status', 'adrian update', 'adrian auto-update', 'adrian rollback', 'adrian uninstall', 'adrian version']) expect(r.out).toContain(cmd);
  }, 60_000);

  it('leaves the other commands needing only a healthy answer', () => {
    for (const [cmd, ok] of [['restart', setupMode], ['start', noVoice]] as const) {
      const m = machine({ before: ok });
      expect(m.run(cmd).code).toBe(0);
    }
    const down = machine({ before: null });
    const r = down.run('restart');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('not healthy after 60 s');
  }, 60_000);

  describe('a bot that was already failing before the update', () => {
    const failing = JSON.stringify({ ok: false, state: 'failed', voiceReady: false, busy: false });

    it('is still rolled back, but not called worse: there was nothing to compare with', () => {
      const m = machine({ before: failing, after: failing });
      const r = m.run('update');
      expect(r.code).not.toBe(0);
      expect(r.err).not.toContain('did worse');
      expect(r.err).toContain(`Version ${NEW} didn't come up healthy, but ${OLD} wasn't healthy before the update either (it was failed), so this doesn't show ${NEW} is worse.`);
      expect(r.err).toContain(`rolled back to ${OLD}, but it is not healthy either, as before the update: sudo adrian doctor says why`);
      expect(m.version()).toBe(OLD);
      expect(m.unpacked(NEW)).toBe(false);
      // Remembered, so the hourly check doesn't churn, and doctor says it couldn't be judged.
      expect(m.marker()).toBe(NEW);
      const d = m.run('doctor');
      expect(d.out).toContain(`update ${NEW} was tried here on `);
      expect(d.out).toContain("couldn't be judged: the bot wasn't healthy before it either");
      expect(d.out).not.toContain('failed here');
    }, 60_000);

    it('one that was healthy is still said to have done worse', () => {
      const m = machine({ after: failing });
      const r = m.run('update');
      expect(r.err).toContain(`Version ${NEW} did worse than ${OLD}; rolling back.`);
      expect(m.run('doctor').out).toContain(`update ${NEW} failed here on `);
    }, 60_000);

    it('updates when the new version comes up healthy', () => {
      const m = machine({ before: failing });
      expect(m.run('update').code).toBe(0);
      expect(m.version()).toBe(NEW);
      expect(existsSync(join(m.root, 'opt/update-failed.unjudged'))).toBe(false);
    }, 60_000);
  });

  it('adrian rollback with no older version says so, and changes nothing', () => {
    const m = machine();
    expect(sh(m.root, 'rm opt/previous').code).toBe(0);
    const r = m.run('rollback');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no previous version to roll back to');
    expect(m.version()).toBe(OLD);
    expect(m.restarts()).toEqual([]);
  }, 60_000);

  describe('a taken admin port', () => {
    const inUse = 'admin UI failed to start {"error":"listen EADDRINUSE: address already in use 127.0.0.1:8790","host":"127.0.0.1","port":8790}\n';

    it('is named by adrian doctor, with what to do', () => {
      const m = machine({ before: null });
      writeFileSync(join(m.root, 'journal'), inUse);
      const r = m.run('doctor');
      expect(r.out).toContain('FAIL  admin UI not responding: port 8790 is taken by another program');
      expect(r.out).toMatch(/what to do: See what holds it: sudo ss -ltnp 'sport = :8790'\. .*--port N/);
      // Without it in her log, doctor says only what it knows.
      const plain = machine({ before: null }).run('doctor');
      expect(plain.out).toContain('FAIL  admin UI not responding\n');
    }, 60_000);

    function backup(root: string) {
      writeFileSync(join(root, 'backup.tar.gz'), pack([entry('etc/adrian/', '5'), entry('etc/adrian/config.json'), entry('var/lib/adrian/', '5')]));
      return 'backup.tar.gz'; // relative: tar takes C:/... for a remote host
    }

    it('stops a restore before it starts her onto a port another program holds', () => {
      const m = machine();
      writeFileSync(join(m.root, 'port-taken'), '');
      const r = m.run('restore', backup(m.root));
      expect(r.code).toBe(1);
      expect(r.err).toContain('restored, but not started: port 8790, the admin port the backup brought, is already used by another program here.');
      expect(m.log()).toContain('restore extracted');
    }, 60_000);

    it('is named when a restore can not start her', () => {
      const m = machine({ before: null });
      writeFileSync(join(m.root, 'journal'), inUse);
      const r = m.run('restore', backup(m.root));
      expect(r.code).toBe(1);
      expect(r.err).toContain("restored, but she can't start: port 8790 is taken by another program");
    }, 60_000);

    it('lets a restore onto a free port through', () => {
      const m = machine();
      const r = m.run('restore', backup(m.root));
      expect(r.out).toContain('Restored and running.');
      expect(r.code).toBe(0);
    }, 60_000);
  });

  it('takes "latest" for the newest release even next to a file of that name', () => {
    const m = machine();
    writeFileSync(join(m.root, 'latest'), 'a page wget saved\n');
    const r = m.run('update');
    expect(r.err).not.toContain('NOT CHECKED');
    expect(r.code).toBe(0);
    expect(m.version()).toBe(NEW);
    // A bundle that isn't there is named as such.
    const missing = m.run('update', 'nope.tar.gz');
    expect(missing.err).toContain("there's no bundle file nope.tar.gz");
  }, 60_000);

  it.each([
    ['::', 'http://[::1]:8790/api/health', 'http://[::]:8790/'],
    ['fd00::5', 'http://[fd00::5]:8790/api/health', 'http://[fd00::5]:8790/'],
    ['0.0.0.0', 'http://127.0.0.1:8790/api/health', 'http://0.0.0.0:8790/'],
  ])('reaches her on an admin address of %s', (host, probe, shown) => {
    const m = machine();
    writeFileSync(join(m.root, 'port.says'), `http ${host} 8790\n`);
    const r = m.hourly();
    expect(r.code).toBe(0);
    expect(m.version()).toBe(NEW);
    expect(readFileSync(join(m.root, 'health.urls'), 'utf8')).toContain(probe);
    expect(m.run('url').out.trim()).toBe(shown);
  }, 60_000);

  describe('the service file', () => {
    it('goes with a release that stays', () => {
      const m = machine();
      m.hourly();
      expect(m.unit()).toBe(`unit of ${NEW}`);
    }, 60_000);

    it('goes back with a rollback, before the old version starts', () => {
      const m = machine({ after: noVoice });
      m.hourly();
      expect(m.unit()).toBe(`unit of ${OLD}`);
      expect(m.log().match(/^reload$/gm)).toHaveLength(2); // the release's, then the old one's
      expect(m.restarts()).toEqual([`restart under: unit of ${NEW}`, `restart under: unit of ${OLD}`]);
    }, 60_000);

    it('goes back when upgrade-prep.sh fails after replacing it: nothing was switched', () => {
      const m = machine({ prepFails: true });
      const r = m.hourly();
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('nothing was switched');
      expect(m.unit()).toBe(`unit of ${OLD}`);
      expect(m.restarts()).toEqual([]);
      expect(m.version()).toBe(OLD);
    }, 60_000);
  });

  describe('someone joining while upgrade-prep.sh runs', () => {
    const busy = health({ busy: true });

    it('stops the timer before it restarts her, and leaves nothing of the release', () => {
      const m = machine({ afterPrep: busy });
      const r = m.hourly();
      expect(r.code).toBe(0);
      expect(r.out).toContain(`update ${NEW} waits`);
      expect(m.restarts()).toEqual([]);
      expect(m.version()).toBe(OLD);
      expect(m.unit()).toBe(`unit of ${OLD}`);
      expect(m.unpacked(NEW)).toBe(false);
      expect(m.marker()).toBeUndefined();
    }, 60_000);

    it('does not stop an update by hand', () => {
      const m = machine({ afterPrep: busy });
      expect(m.run('update').code).toBe(0);
      expect(m.version()).toBe(NEW);
    }, 60_000);
  });

  describe('a version that failed', () => {
    it('is left alone by the timer: one download and two restarts, not one of each every hour', () => {
      const m = machine({ after: noVoice });
      expect(m.hourly().code).not.toBe(0);
      expect(m.marker()).toBe(NEW);
      for (let i = 0; i < 2; i++) {
        const r = m.hourly();
        expect(r.code).toBe(0);
        expect(r.out).toContain(`update ${NEW} skipped`);
      }
      expect(m.downloads()).toHaveLength(1);
      expect(m.restarts()).toHaveLength(2);
    }, 60_000);

    it('gets another try a day later: a passing outage can fail a good release', () => {
      const m = machine({ failed: NEW, failedHoursAgo: 25 });
      expect(m.hourly().code).toBe(0);
      expect(m.version()).toBe(NEW);
      expect(m.marker()).toBeUndefined();
    }, 60_000);

    it('stays alone until then', () => {
      const m = machine({ failed: NEW, failedHoursAgo: 23 });
      expect(m.hourly().code).toBe(0);
      expect(m.downloads()).toEqual([]);
    }, 60_000);

    it('does not hold back a different version', () => {
      const m = machine({ failed: '9.9.8' });
      expect(m.hourly().code).toBe(0);
      expect(m.version()).toBe(NEW);
    }, 60_000);

    it('does not stop an update by hand, and a success clears it', () => {
      const m = machine({ failed: NEW });
      expect(m.run('update').code).toBe(0);
      expect(m.version()).toBe(NEW);
      expect(m.marker()).toBeUndefined();
    }, 60_000);

    it('shows up in adrian doctor', () => {
      const r = machine({ failed: NEW }).run('doctor');
      expect(r.out).toMatch(new RegExp(`warn +update ${NEW.replaceAll('.', '\\.')} failed here on \\d{4}-\\d\\d-\\d\\d`));
      expect(machine().run('doctor').out).not.toContain('failed here');
    }, 60_000);
  });

  describe('asking the new code about the live config', () => {
    const refused: [number, string] = [3, '- Config brain.model: Required\n'];

    it('stops a release that refuses it before anything changes', () => {
      const m = machine({ check: refused });
      const r = m.hourly();
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(`version ${NEW} can't run this config`);
      expect(r.err).toContain('Config brain.model: Required');
      expect(m.log()).toContain(`asked ${NEW}`);
      expect(m.restarts()).toEqual([]);
      expect(m.log()).not.toContain('reload');
      expect(m.unit()).toBe(`unit of ${OLD}`);
      expect(m.version()).toBe(OLD);
      expect(m.unpacked(NEW)).toBe(false);
      expect(m.marker()).toBe(NEW);
    }, 60_000);

    it('takes a crash for no answer: it runs under the old Node, and the health check still judges it', () => {
      const m = machine({ check: [1, "SyntaxError: Unexpected token '#'\n"] });
      expect(m.hourly().code).toBe(0);
      expect(m.version()).toBe(NEW);
    }, 60_000);

    it.each([
      ['in setup mode', setupMode],
      ['not answering', null],
    ] as [string, string | null][])('leaves unfinished setup alone: not asked while %s', (_, before) => {
      const m = machine({ before, after: before ?? setupMode, check: refused });
      expect(m.hourly().code).toBe(0);
      expect(m.log()).not.toContain(`asked ${NEW}`);
      expect(m.version()).toBe(NEW);
    }, 60_000);
  });

  // A power cut in the middle of the rollback itself: the next run must still
  // know the release failed, and never offer it as the one to go back to.
  describe('cut off during its own rollback', () => {
    it('is finished by the next run: the failure remembered, "previous" as before, no retry at once', () => {
      const m = machine({ after: null, cutAtRestart: 2 });
      const cut = m.hourly();
      expect(cut.code).not.toBe(0); // killed
      expect(m.version()).toBe(OLD);
      expect(m.marker()).toBe(NEW); // written before the rollback's restart
      // The power comes back; the next hourly run finds the note.
      rmSync(join(m.root, 'cut-at'));
      const next = m.hourly();
      expect(next.err).toContain(`was being undone when it was cut off. Finishing that: back to ${OLD}`);
      expect(next.out).toContain(`update ${NEW} skipped: it failed here in the last day`);
      expect(m.downloads()).toHaveLength(1);
      expect(m.version()).toBe(OLD);
      expect(m.previous()).toBe('0.9.0');
      expect(m.unpacked(NEW)).toBe(false);
      expect(m.unit()).toBe(`unit of ${OLD}`);
      expect(existsSync(join(m.root, 'opt/update-in-progress'))).toBe(false);
      // And a rollback by hand goes to the release before, not onto the failed one.
      expect(m.run('rollback').out).toContain(`Switching ${OLD} -> 0.9.0`);
    }, 60_000);
  });

  describe('the disk', () => {
    // Bundled with the new release: one model it doesn't have yet, 3 GB to stage and 4 GB unpacked.
    const big = '"big|https://example.invalid/big.tar.bz2|00|tar.bz2||3000:4000:4000"';

    it("waits when the new release's models won't fit, before fetching any or switching", () => {
      const m = machine({ models: big, freeMb: 5000 });
      const r = m.hourly();
      expect(r.code).toBe(0);
      expect(r.out).toMatch(new RegExp(`update ${NEW} waits: only 5000 MB free on the disk that holds .*, and the downloads still to do need about 7100 MB`));
      expect(m.log()).not.toContain('big.tar.bz2');
      expect(m.version()).toBe(OLD);
      expect(m.unpacked(NEW)).toBe(false);
      expect(m.marker()).toBeUndefined(); // waiting isn't failing
      expect(m.unit()).toBe(`unit of ${OLD}`);
    }, 60_000);

    it('says so by hand, and changes nothing', () => {
      const m = machine({ models: big, freeMb: 5000 });
      const r = m.run('update');
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(`not enough disk for ${NEW}`);
      expect(r.err).toContain('Nothing was changed');
      expect(m.version()).toBe(OLD);
    }, 60_000);

    it('checks the room for a bundle given by hand too', () => {
      const m = machine({ freeMb: 100 });
      const r = m.run('update', `${m.root}/published/adrian-voice-${NEW}-linux-x64.tar.gz`);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('only 100 MB free under');
      expect(m.version()).toBe(OLD);
    }, 60_000);
  });

  describe('a bundle given by hand', () => {
    const bare = (m: ReturnType<typeof machine>) => {
      mkdirSync(join(m.root, 'byhand'));
      sh(m.root, `cp published/adrian-voice-${NEW}-linux-x64.tar.gz byhand/`);
      return `${m.root}/byhand/adrian-voice-${NEW}-linux-x64.tar.gz`;
    };

    it('says plainly when it has no .sha256 to be checked against', () => {
      const m = machine();
      const r = m.run('update', bare(m));
      expect(r.err).toContain('NOT CHECKED');
      expect(m.version()).toBe(NEW);
    }, 60_000);

    it('is refused without one under --require-checksum, and nothing changes', () => {
      const m = machine();
      const r = m.run('update', bare(m), '--require-checksum');
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('--require-checksum');
      expect(m.version()).toBe(OLD);
      expect(m.unpacked(NEW)).toBe(false);
    }, 60_000);

    it('goes ahead under --require-checksum when its .sha256 matches', () => {
      const m = machine();
      const r = m.run('update', `${m.root}/published/adrian-voice-${NEW}-linux-x64.tar.gz`, '--require-checksum');
      expect(r.code).toBe(0);
      expect(m.version()).toBe(NEW);
    }, 60_000);
  });
});

describe('pinned model sizes', () => {
  it('are there for every model, so the disk checks count it', () => {
    const block = /^MODELS=\(([\s\S]*?)^\)$/m.exec(readFileSync(`${packaging}downloads.sh`, 'utf8'))![1]!;
    const entries = block.split('\n').filter((l) => l.trim().startsWith('"'));
    expect(entries.length).toBeGreaterThan(5);
    for (const e of entries) expect(e, e).toMatch(/\|\d+:\d+:\d+"$/);
  });
});

describe.skipIf(!hasBash)('package.sh', () => {
  /** A checkout with `npm` and friends stood in for; `broken` is the step that fails. */
  function build(broken?: string) {
    const root = sandbox('build');
    for (const d of ['packaging', 'scripts', 'src', 'test', 'web']) mkdirSync(join(root, d));
    for (const f of ['packaging/adrian', 'packaging/install.sh', 'packaging/upgrade-prep.sh', 'package.json', 'package-lock.json', 'tsconfig.json', 'test/a.test.ts']) writeFileSync(join(root, f), '{}\n');
    writeFileSync(join(root, 'packaging/package.sh'), readFileSync(`${packaging}package.sh`));
    const stubs = `
      uname() { [ "$1" = -s ] && echo Linux || echo x86_64; }
      node() { [ "$1" = -p ] && echo 1.2.3; return 0; }
      npm() {
        echo "npm $*" >>"$LOG"
        case "$*" in
          ci*) mkdir -p node_modules/@discordjs/opus/build-tmp-napi-v3 node_modules/@discordjs/opus/prebuild
               echo "/home/someone/app" >node_modules/@discordjs/opus/build-tmp-napi-v3/Makefile
               echo keep >node_modules/@discordjs/opus/prebuild/opus.node ;;
          *typecheck*) [ "$BROKEN" != typecheck ] ;;
          *test*) mkdir -p node_modules/.vite && echo cache >node_modules/.vite/results.json; [ "$BROKEN" != test ] ;;
        esac
      }
      export -f uname node npm
      exec bash packaging/package.sh "$PWD/out"`;
    const r = sh(root, stubs, [], { LOG: `${root}/npm.log`, BROKEN: broken ?? '' });
    const bundle = join(root, 'out/adrian-voice-1.2.3-linux-x64.tar.gz');
    return { ...r, root, bundle, built: existsSync(bundle), steps: readFileSync(join(root, 'npm.log'), 'utf8') };
  }

  it('refuses to build when the typecheck fails', () => {
    const r = build('typecheck');
    expect(r.code).not.toBe(0);
    expect(r.built).toBe(false);
  });

  it('refuses to build when the tests fail', () => {
    const r = build('test');
    expect(r.code).not.toBe(0);
    expect(r.built).toBe(false);
  });

  it('checks before dev tools are pruned, and ships neither tests nor the opus build folder', () => {
    const r = build();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.steps.indexOf('typecheck')).toBeGreaterThan(-1);
    expect(r.steps.indexOf('test')).toBeGreaterThan(r.steps.indexOf('typecheck'));
    expect(r.steps.indexOf('prune')).toBeGreaterThan(r.steps.indexOf('test'));
    const files = sh(r.root, 'tar -tzf out/adrian-voice-1.2.3-linux-x64.tar.gz').out;
    expect(files).toContain('node_modules/@discordjs/opus/prebuild/opus.node');
    expect(files).not.toContain('build-tmp');
    expect(files).not.toContain('./test/');
    expect(files).not.toContain('.vite');
  });
});

describe('what memory she needs', () => {
  it('reads the same in the service file and the installer as in the README', () => {
    expect(readFileSync(new URL('../README.md', import.meta.url), 'utf8')).toContain('4 GB free (about 3.5 GB once the language voices load');
    const service = readFileSync(`${packaging}adrian-voice.service`, 'utf8');
    expect(service).toContain('about 3.5 GiB by default');
    expect(service).not.toContain('in English');
    const install = readFileSync(`${packaging}install.sh`, 'utf8');
    expect(install).toContain('-gt $((4 * 1024 * 1024))');
    expect(install).toContain('less than 4 GB of memory');
  });
});

// Upstream replaces files in place now and then (both speech models did in
// 2026). Every file still has to match a checksum listed in downloads.sh.
describe.skipIf(!hasBash)('model checksums and mirrors', () => {
  const OLD_FILE = 'the 2025 upload\n';
  const NEW_FILE = 'the 2026 re-upload\n';
  const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
  const BOTH = `${sha(NEW_FILE)},${sha(OLD_FILE)}`;
  // Serves served/<host>/<file name>, whatever the path; logs every URL asked for.
  const curl = `curl() {
    local out= src= h
    while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; https://*|http://*) src=$1 ;; esac; shift; done
    echo "$src" >>curl.log
    h=$(sed -E 's#^https?://([^/]+)/.*#\\1#' <<<"$src")
    [ -f "served/$h/$(basename "$src")" ] || return 22
    cp "served/$h/$(basename "$src")" "$out"
  };`;
  function site(files: Record<string, string | Buffer>) {
    const root = sandbox('dl');
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, 'served', path, '..'), { recursive: true });
      writeFileSync(join(root, 'served', path), body);
    }
    return root;
  }
  const run = (root: string, script: string, env: NodeJS.ProcessEnv = {}) =>
    sh(root, `set -euo pipefail; . "${packaging}downloads.sh"; ${curl} ${script}`, [], { ADRIAN_MIRRORS_FILE: `${root}/no-mirrors`, ...env });
  const asked = (root: string) => (existsSync(join(root, 'curl.log')) ? readFileSync(join(root, 'curl.log'), 'utf8').trim().split('\n') : []);

  it('take a file matching any of the checksums listed, and say which one', () => {
    const root = site({ 'up.example/m.bin': OLD_FILE });
    const r = run(root, `fetch https://up.example/m.bin ${BOTH} m.bin; echo "matched $FETCHED_SHA"`);
    expect(r.err).toBe('');
    expect(r.out).toContain(`matched ${sha(OLD_FILE)}`);
    expect(readFileSync(join(root, 'm.bin'), 'utf8')).toBe(OLD_FILE);
  });

  it('refuse a full-size file no checksum knows, and say plainly that running it again will not help', () => {
    const changed = Buffer.alloc(2 * 1048576, 1); // 2 MB, as big as it should be
    const root = site({ 'up.example/m.bin': changed });
    const r = run(root, `fetch https://up.example/m.bin ${BOTH} m.bin 2`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('m.bin downloaded at full size but doesn\'t match any checksum this version knows');
    expect(r.err).toContain('the file on the download site is not one this version of A.D.R.I.A.N. knows (most likely it was replaced by a new upload)');
    expect(r.err).toContain("Running the command again won't change that.");
    expect(r.err).toContain('install the newest A.D.R.I.A.N. release');
    expect(r.err).toContain(`SHA-256 ${sha(changed)}`);
    expect(r.err).not.toContain('something between you and the site');
    expect(existsSync(join(root, 'm.bin'))).toBe(false); // nothing of it is kept
  });

  it('say a download that came up short is worth one more try', () => {
    const root = site({ 'up.example/m.bin': 'half a model' });
    const r = run(root, `fetch https://up.example/m.bin ${BOTH} m.bin 300`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("m.bin doesn't match its checksum, and it's smaller than it should be (0 MB of about 300 MB).");
    expect(r.err).toContain('Running the same command again fixes a download that was cut short');
    expect(r.err).toContain('If it fails the same way twice, the file on the download site is not one this version');
  });

  it('try the mirrors in order after the original site, https only, and take only a known file from them', () => {
    const root = site({ 'up.example/m.bin': NEW_FILE + 'changed', 'bad.example/m.bin': 'not it either', 'good.example/m.bin': OLD_FILE });
    const r = run(root, `fetch https://up.example/models/m.bin ${BOTH} m.bin; echo "matched $FETCHED_SHA"`, {
      ADRIAN_DOWNLOAD_MIRRORS: 'http://plain.example/x https://bad.example/x https://good.example/models/',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`matched ${sha(OLD_FILE)}`);
    expect(r.out).toContain('Downloading m.bin from the mirror good.example');
    expect(r.err).toContain('ignoring download mirror http://plain.example/x: only https:// mirrors are used');
    expect(asked(root)).toEqual(['https://up.example/models/m.bin', 'https://bad.example/x/m.bin', 'https://good.example/models/m.bin']);
  });

  it('give up when no place has a known file, naming each', () => {
    const root = site({ 'up.example/m.bin': 'changed', 'bad.example/m.bin': 'not it either' });
    const r = run(root, `fetch https://up.example/m.bin ${BOTH} m.bin`, { ADRIAN_DOWNLOAD_MIRRORS: 'https://bad.example/x https://gone.example/x' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('up.example gave 0 MB with SHA-256');
    expect(r.err).toContain('bad.example gave 0 MB with SHA-256');
    expect(r.err).toContain('downloading m.bin from gone.example stopped (curl error 22');
  });

  it("keep curl's exit code when nothing could be downloaded at all", () => {
    const root = site({});
    const r = run(root, `fetch https://up.example/m.bin ${BOTH} m.bin`);
    expect(r.code).toBe(22);
    expect(r.err).toContain('m.bin could not be downloaded (tried: up.example)');
  });

  it('read the mirrors from a file too, for the hourly update', () => {
    const root = site({ 'up.example/m.bin': 'changed', 'good.example/m.bin': NEW_FILE });
    writeFileSync(join(root, 'mirrors'), '# our own copy\nhttps://good.example/x\n');
    const r = run(root, `fetch https://up.example/m.bin ${BOTH} m.bin`, { ADRIAN_MIRRORS_FILE: `${root}/mirrors` });
    expect(r.code).toBe(0);
    expect(asked(root)).toEqual(['https://up.example/m.bin', 'https://good.example/x/m.bin']);
  });

  it('take a cached file with any known checksum', () => {
    const root = site({});
    mkdirSync(join(root, 'cache'));
    writeFileSync(join(root, 'cache/m.bin'), OLD_FILE);
    const r = run(root, `fetch https://up.example/m.bin ${BOTH} m.bin; echo "matched $FETCHED_SHA"`, { ADRIAN_DOWNLOAD_CACHE: `${root}/cache` });
    expect(r.out).toContain(`matched ${sha(OLD_FILE)}`);
    expect(asked(root)).toEqual([]);
  });

  it('keep a model installed from either upload, and record the one each install got', () => {
    const root = site({ 'up.example/m.bin': NEW_FILE });
    mkdirSync(join(root, 'models'));
    mkdirSync(join(root, 'tmp'));
    writeFileSync(join(root, 'models/m.bin'), OLD_FILE);
    writeFileSync(join(root, 'models/.m.bin.sha256'), `${sha(OLD_FILE)}\n`);
    const models = `MODELS=("m.bin|https://up.example/m.bin|${BOTH}|file||400:400:400");`;
    // Installed from the 2025 upload: kept, nothing downloaded, nothing left to make room for.
    const kept = run(root, `${models} install_models "$PWD/models" "$PWD/tmp"; disk_needed "$PWD/opt" "$PWD/models"`);
    expect(kept.code).toBe(0);
    expect(asked(root)).toEqual([]);
    expect(kept.out.trim().split(' ')[1]).toBe('0');
    // A fresh install gets the 2026 one, and its marker says so.
    rmSync(join(root, 'models/m.bin'));
    const fresh = run(root, `${models} install_models "$PWD/models" "$PWD/tmp"`);
    expect(fresh.code).toBe(0);
    expect(readFileSync(join(root, 'models/m.bin'), 'utf8')).toBe(NEW_FILE);
    expect(readFileSync(join(root, 'models/.m.bin.sha256'), 'utf8').trim()).toBe(sha(NEW_FILE));
    // A marker from a file no list knows (an older pin) still means: fetch it again.
    writeFileSync(join(root, 'models/.m.bin.sha256'), `${'0'.repeat(64)}\n`);
    expect(run(root, `${models} disk_needed "$PWD/opt" "$PWD/models"`).out.trim().split(' ')[1]).toBe('400');
  });

  it('list both uploads of the two speech models that upstream replaced', () => {
    const pins = readFileSync(`${packaging}downloads.sh`, 'utf8');
    const entry = (name: string) => pins.split('\n').find((l) => l.trim().startsWith(`"${name}|`)) ?? '';
    const shas = (name: string) => entry(name).split('|')[2]?.split(',') ?? [];
    expect(shas('sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')).toEqual([
      '1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9',
      '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    ]);
    expect(shas('kokoro-multi-lang-v1_0')).toEqual([
      '60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4',
      'c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298',
    ]);
    for (const l of pins.split('\n').filter((x) => /^\s+"[^"|]+\|https:/.test(x))) {
      for (const s of l.split('|')[2]!.split(',')) expect(s, l).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
