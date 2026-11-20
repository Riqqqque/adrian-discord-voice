// packaging/get.sh, the one-step installer, run for real in bash against a
// fake GitHub: curl is a stand-in that serves a local folder of releases, and
// the bundle's install.sh only records how it was called.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packaging = fileURLToPath(new URL('../packaging/', import.meta.url)).replaceAll('\\', '/');
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const hasBash = spawnSync(bash, ['-c', 'tar --version && gzip --version && sha256sum --version'], { stdio: 'ignore' }).status === 0;
const work = mkdtempSync(join(tmpdir(), 'adrian-get-')).replaceAll('\\', '/');

interface Site {
  /** Versions published, newest last. */
  versions?: string[];
  /** The API answers 403 (rate limited), but the web page still redirects. */
  rateLimited?: boolean;
  offline?: boolean;
  /** This version's bundle doesn't match its .sha256. */
  tampered?: string;
  /** This version has no .sha256. */
  noChecksum?: string;
  /** Already installed at this version. */
  installed?: string;
  /** Commands that are missing (the stand-in `command -v` says so). */
  missing?: string[];
  /** The bundle's install.sh exits with this. */
  installExit?: number;
}

function site(s: Site = {}) {
  const root = mkdtempSync(join(work, 's-')).replaceAll('\\', '/');
  const put = (name: string, text: string, mode = 0o644) => {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text, { mode });
  };
  const versions = s.versions ?? ['1.0.0', '1.1.0'];
  for (const v of versions) {
    put(`build/${v}/package.json`, `{"version":"${v}"}\n`);
    put(`build/${v}/packaging/install.sh`, `printf '%s\\n' "${v}" "$@" >"${root}/installed-with"\nexit ${s.installExit ?? 0}\n`, 0o755);
    const name = `adrian-voice-${v}-linux-x64.tar.gz`;
    const sha = s.noChecksum === v ? ':' : `sha256sum "${name}" >"${name}.sha256"`;
    const r = sh(root, `set -e; mkdir -p "pub/v${v}"; tar -czf "pub/v${v}/${name}" -C "build/${v}" .; cd "pub/v${v}"; ${sha}; ${s.tampered === v ? `printf x >>"${name}"` : ':'}`);
    expect(r.code).toBe(0);
  }
  if (s.installed) {
    put(`opt/releases/${s.installed}/x`, '');
    sh(root, `ln -sfn releases/${s.installed} opt/current`);
    put('adrian-cli', `#!/usr/bin/env bash\necho "adrian $*" >"${root}/cli-ran"\n`, 0o755);
  }
  const latest = versions[versions.length - 1];
  const stubs = `
    id() { echo 0; }
    uname() { echo Linux; }
    install() { mkdir -p "\${@: -1}"; }
    apt-get() { echo "apt-get $*" >>"${root}/apt.log"; }
    ss() { :; }
    command() {
      if [ "$1" = -v ]; then case " ${(s.missing ?? []).join(' ')} " in *" $2 "*) return 1 ;; esac; [ "$2" = dnf ] && return 1; [ "$2" = apt-get ] && return 0; fi
      builtin command "$@"
    }
    curl() {
      local out= url= a prev=
      for a; do [ "$prev" = -o ] && out=$a; case "$a" in http*) url=$a ;; esac; prev=$a; done
      echo "$url" >>"${root}/curl.log"
      ${s.offline ? 'return 6' : ':'}
      case "$url" in
        https://github.com/*/releases/latest) printf 'https://github.com/x/y/releases/tag/v${latest}' ;;
        */releases/latest) ${s.rateLimited ? 'return 22' : `printf '{"tag_name": "v${latest}"}'`} ;;
        */releases/download/*) local f="${root}/pub/\${url#*/releases/download/}"; [ -f "$f" ] || return 22; cp "$f" "$out" ;;
        *) return 22 ;;
      esac
    }
    export -f id uname install apt-get ss command curl`;
  const script = readFileSync(`${packaging}get.sh`, 'utf8')
    .replace(/^CLI=.*$/m, `CLI=${root}/adrian-cli`)
    .replace(/^OPT=.*$/m, `OPT=${root}/opt`)
    .replace(/^WORK=.*$/m, `WORK=${root}/work`);
  put('get.sh', script);
  return {
    root,
    run: (...args: string[]) => sh(root, `${stubs}; exec bash get.sh "$@"`, args),
    read: (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : ''),
    exists: (name: string) => existsSync(join(root, name)),
  };
}

function sh(cwd: string, script: string, args: string[] = []) {
  const r = spawnSync(bash, ['-c', script, 'test', ...args], { cwd, encoding: 'utf8', env: { ...process.env, MSYS: 'winsymlinks:lnk', MSYS_NO_PATHCONV: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!hasBash)('get.sh', { timeout: 60_000 }, () => {
  it('installs the newest release, checked, passing the installer its own options', () => {
    const s = site();
    const r = s.run('--yes', '--lan');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const [version, ...args] = s.read('installed-with').trim().split('\n');
    expect(version).toBe('1.1.0');
    expect(args).toEqual(['--bundle', `${s.root}/work/adrian-voice-1.1.0-linux-x64.tar.gz`, '--yes', '--lan']);
    expect(s.exists('work')).toBe(false); // cleaned up once it worked
  });

  it('finds the newest release from the web page when the API is rate limited', () => {
    const s = site({ rateLimited: true });
    expect(s.run('--yes').code).toBe(0);
    expect(s.read('installed-with').split('\n')[0]).toBe('1.1.0');
  });

  it('installs a version asked for', () => {
    const s = site();
    expect(s.run('--yes', '--version', '1.0.0').code).toBe(0);
    expect(s.read('installed-with').split('\n')[0]).toBe('1.0.0');
  });

  it('refuses a bundle that does not match its checksum, and runs nothing', () => {
    const s = site({ tampered: '1.1.0' });
    const r = s.run('--yes');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("doesn't match its published checksum");
    expect(s.exists('installed-with')).toBe(false);
  });

  it('refuses a release with no checksum to check against', () => {
    const s = site({ noChecksum: '1.1.0' });
    const r = s.run('--yes');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("can't download the checksum");
    expect(s.exists('installed-with')).toBe(false);
  });

  it('says plainly when GitHub cannot be reached', () => {
    const r = site({ offline: true }).run('--yes');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("can't reach GitHub");
    expect(r.err).toContain('run the same command again');
  });

  it('installs the missing system packages first, by their package names', () => {
    const s = site({ missing: ['xz', 'bzip2', 'ss', 'ffmpeg'] });
    expect(s.run('--yes').code).toBe(0);
    expect(s.read('apt.log')).toContain('apt-get install -y -qq xz-utils bzip2 iproute2 ffmpeg');
  });

  it('installs no packages when told not to', () => {
    const s = site({ missing: ['ffmpeg'] });
    const r = s.run('--yes', '--no-packages');
    expect(r.code).toBe(0);
    expect(s.read('apt.log')).toBe('');
    expect(r.out).toContain('missing system packages: ffmpeg');
  });

  it('keeps the download when the install fails, and uses it next time', () => {
    const s = site({ installExit: 1 });
    expect(s.run('--yes').code).toBe(1);
    expect(s.exists('work/adrian-voice-1.1.0-linux-x64.tar.gz')).toBe(true);
    const before = s.read('curl.log').split('\n').filter((l) => l.endsWith('.tar.gz')).length;
    s.run('--yes');
    expect(s.read('curl.log').split('\n').filter((l) => l.endsWith('.tar.gz')).length).toBe(before);
  });

  it('updates an existing install instead of installing over it', () => {
    const s = site({ installed: '1.0.0' });
    const r = s.run('--yes');
    expect(r.code).toBe(0);
    expect(r.out).toContain('already installed (version 1.0.0)');
    expect(s.read('cli-ran').trim()).toBe('adrian update');
    expect(s.exists('installed-with')).toBe(false);
  });

  it('reinstalls when asked, to repair', () => {
    const s = site({ installed: '1.1.0' });
    expect(s.run('--yes', '--reinstall').code).toBe(0);
    expect(s.exists('installed-with')).toBe(true);
  });
});
