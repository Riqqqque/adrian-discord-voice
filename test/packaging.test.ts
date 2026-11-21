// The shell side of restores and updates, run for real in bash: `adrian restore`
// against throwaway archives, the limits on model downloads, and the checksums and
// mirrors they are fetched with. `adrian update` itself is in packaging-update*.test.ts.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bash, entry, hasBash, hasXz, link, moved, pack, packaging, sandbox, server, sh, work } from './packaging-shell.js';

// Every test here starts bash (and tar, curl stand-ins...) several times, which
// is slow on Windows and on a busy machine: the default 5 s is too short.
vi.setConfig({ testTimeout: 60_000 });

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

describe('pinned model sizes', () => {
  it('are there for every model, so the disk checks count it', () => {
    const block = /^MODELS=\(([\s\S]*?)^\)$/m.exec(readFileSync(`${packaging}downloads.sh`, 'utf8'))![1]!;
    const entries = block.split('\n').filter((l) => l.trim().startsWith('"'));
    expect(entries.length).toBeGreaterThan(5);
    for (const e of entries) expect(e, e).toMatch(/\|\d+:\d+:\d+"$/);
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
