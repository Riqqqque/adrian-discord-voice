// The shell side of restores and updates, run for real in bash: `adrian restore`
// against throwaway archives, and the limits on model downloads.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
