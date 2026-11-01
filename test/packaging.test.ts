// The shell side of restores and updates, run for real in bash: `adrian restore`
// against throwaway archives, and the limits on model downloads.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const packaging = fileURLToPath(new URL('../packaging/', import.meta.url)).replaceAll('\\', '/');
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
    expect(pins).toContain('yt-dlp/releases/download/2026.10.26/yt-dlp_linux|767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795|bin');
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
