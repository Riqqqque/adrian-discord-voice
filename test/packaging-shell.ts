// What the packaging tests share: bash, a sandbox per test, and a server on
// the old version with a new release out for `adrian update`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const packaging = fileURLToPath(new URL('../packaging/', import.meta.url)).replaceAll('\\', '/');
// On Windows a plain `bash` may be WSL's launcher.
export const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
export const hasBash = spawnSync(bash, ['-c', 'tar --version && gzip --version'], { stdio: 'ignore' }).status === 0;
export const hasXz = hasBash && spawnSync(bash, ['-c', 'xz --version'], { stdio: 'ignore' }).status === 0;
export const work = mkdtempSync(join(tmpdir(), 'adrian-packaging-'));

export const sandbox = (name: string) => mkdtempSync(join(work, `${name}-`)).replaceAll('\\', '/');
/** A script's fixed paths, moved into a sandbox. */
export const moved = (script: string, root: string) =>
  script.replace(/^OPT=.*$/m, `OPT=${root}/opt`).replace(/^ETC=.*$/m, `ETC=${root}/etc`).replace(/^VAR=.*$/m, `VAR=${root}/var`).replace(/^UNIT=.*$/m, `UNIT=${root}/adrian-voice.service`);
export const sh =(root: string, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(bash, ['-c', script, 'test', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, MSYS: 'winsymlinks:lnk', MSYS_NO_PATHCONV: '1', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
export const link = (root: string, path: string) => sh(root, 'readlink "$1"', [path]).out.trim();
/** Stand-ins for what a script expects of a real server. */
export const server = 'id() { echo 0; }; install() { :; }; chown() { :; }; chmod() { :; }; systemctl() { :; }; export -f id install chown chmod systemctl;';

// `adrian update`, judged against the version it replaces.
export const OLD = '1.0.0';
export const NEW = '9.9.9';
export const health = (fields: object = {}) => JSON.stringify({ ok: true, state: 'running', voiceReady: true, busy: false, ...fields });
export const noVoice = health({ voiceReady: false });
export const setupMode = health({ state: 'setup', voiceReady: false });

/** What each version does. A health of null: nothing answers. */
export interface Release {
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
  /** Until then the new version says it is waiting for memory to start. */
  waitsForMemoryUntil?: number;
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
}

// The fake clock runs ten times as fast, so the waits can keep their real lengths.
export const stubs = `${server}
  install() {
    if [ "$1" = -d ]; then shift 7; mkdir -p "$@"; return; fi
    case "$3" in *adrian-voice.service) ;; *) [ ! -f unit-stuck ] || return 1 ;; esac
    cp "$3" "$4"
  }
  sleep() { echo "sleep $1" >>log; SECONDS=$((SECONDS + $1 * 10)); [ "$1" = 1 ] || : >watched; }
  journalctl() { :; }
  systemctl() {
    case "$1" in
      show) [ -f watched ] && cat restarts 2>/dev/null || echo 0 ;;
      restart) echo "restart under: $(cat adrian-voice.service)" >>log; [ ! -f no-starts ] && { [ ! -f bad-unit ] || ! grep -q ${NEW} adrian-voice.service; } ;;
      daemon-reload) echo reload >>log; : >prepared ;;
    esac
  }
  curl() {
    local out=
    while [ $# -gt 1 ]; do [ "$1" != -o ] || out=$2; shift; done
    case "$1" in
      *releases/latest) printf '{"tag_name":"v${NEW}"}' ;;
      */api/health)
        local f; f=health.$(basename "$(readlink -f opt/current)")
        if [ -f "$f.memory" ] && [ $SECONDS -lt "$(cat "$f.memory")" ]; then printf '%s' '{"ok":false,"state":"starting","waitingFor":"memory","voiceReady":false,"busy":false}'; return 0; fi
        [ ! -f prepared ] || [ ! -f "$f.prepared" ] || f=$f.prepared
        [ ! -f watched ] || [ ! -f "$f.watched" ] || { [ -f "$f.back" ] && [ $SECONDS -ge "$(cat "$f.back")" ]; } || f=$f.watched
        [ -f "$f" ] && [ $SECONDS -ge "$(cat "$f.from" 2>/dev/null || echo 0)" ] && cat "$f" || return 22 ;;
      *nodejs.org*) return 7 ;;
      *) echo "download $1" >>log; cp "published/$(basename "$1")" "$out" ;;
    esac
  }
  runuser() {
    case "$*" in
      *" port") echo "http 127.0.0.1 8790" ;;
      *"releases/${NEW}/dist/cli/tool.js check") echo "asked ${NEW}" >>log; cat check.says; return "$(cat check.exit)" ;;
      *" check") echo "Config is complete." ;;
    esac
  }
  export -f install sleep journalctl systemctl curl runuser
  exec bash adrian "$@"`;

/** A server on the old version, with the new one out. */
export function machine(r: Release = {}) {
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
      .replace(/^MODELS=\([\s\S]*?^\)$/m, 'MODELS=()'),
  );
  const name = `adrian-voice-${NEW}-linux-x64.tar.gz`;
  expect(sh(root, `set -e; tar -czf "published/${name}" -C new .; cd published; sha256sum "${name}" >"${name}.sha256"`).code).toBe(0);
  if (r.before !== null) put(`health.${OLD}`, r.before ?? health());
  if (r.after !== null) put(`health.${NEW}`, r.after ?? health());
  if (r.afterPrep) put(`health.${OLD}.prepared`, r.afterPrep);
  if (r.afterAMinute !== undefined) put(`health.${NEW}.watched`, r.afterAMinute);
  if (r.backAfter) put(`health.${NEW}.back`, String(r.backAfter));
  if (r.comesUpAfter) put(`health.${NEW}.from`, String(r.comesUpAfter));
  if (r.waitsForMemoryUntil) put(`health.${NEW}.memory`, String(r.waitsForMemoryUntil));
  if (r.crashes) put('restarts', '1\n');
  if (r.badUnit) put('bad-unit', '');
  if (r.noStarts) put('no-starts', '');
  if (r.unitStuck) put('unit-stuck', '');
  if (r.markerStuck) mkdirSync(join(root, 'opt/update-failed'));
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
