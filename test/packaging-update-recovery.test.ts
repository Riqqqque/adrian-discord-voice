// `adrian update` when things around it go wrong, run for real in bash: a bot that was
// already failing, a taken admin port (doctor, restore), a cut-off rollback, the disk,
// bundles given by hand and IPv6 admin addresses. Apart from the other update tests
// so the slow shell tests run in parallel workers.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { entry, hasBash, machine, NEW, OLD, pack, sh } from './packaging-shell.js';

// Each test starts bash dozens of times: seconds on Windows, and minutes when the
// machine is busy and these files run side by side.
vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!hasBash)('adrian update, when things around it go wrong', () => {
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
    });

    it('one that was healthy is still said to have done worse', () => {
      const m = machine({ after: failing });
      const r = m.run('update');
      expect(r.err).toContain(`Version ${NEW} did worse than ${OLD}; rolling back.`);
      expect(m.run('doctor').out).toContain(`update ${NEW} failed here on `);
    });

    it('updates when the new version comes up healthy', () => {
      const m = machine({ before: failing });
      expect(m.run('update').code).toBe(0);
      expect(m.version()).toBe(NEW);
      expect(existsSync(join(m.root, 'opt/update-failed.unjudged'))).toBe(false);
    });
  });

  it('adrian rollback with no older version says so, and changes nothing', () => {
    const m = machine();
    expect(sh(m.root, 'rm opt/previous').code).toBe(0);
    const r = m.run('rollback');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no previous version to roll back to');
    expect(m.version()).toBe(OLD);
    expect(m.restarts()).toEqual([]);
  });

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
    });

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
    });

    it('is named when a restore can not start her', () => {
      const m = machine({ before: null });
      writeFileSync(join(m.root, 'journal'), inUse);
      const r = m.run('restore', backup(m.root));
      expect(r.code).toBe(1);
      expect(r.err).toContain("restored, but she can't start: port 8790 is taken by another program");
    });

    it('lets a restore onto a free port through', () => {
      const m = machine();
      const r = m.run('restore', backup(m.root));
      expect(r.out).toContain('Restored and running.');
      expect(r.code).toBe(0);
    });
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
  });

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
    });
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
    });

    it('says so by hand, and changes nothing', () => {
      const m = machine({ models: big, freeMb: 5000 });
      const r = m.run('update');
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(`not enough disk for ${NEW}`);
      expect(r.err).toContain('Nothing was changed');
      expect(m.version()).toBe(OLD);
    });

    it('checks the room for a bundle given by hand too', () => {
      const m = machine({ freeMb: 100 });
      const r = m.run('update', `${m.root}/published/adrian-voice-${NEW}-linux-x64.tar.gz`);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('only 100 MB free under');
      expect(m.version()).toBe(OLD);
    });
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
    });

    it('is refused without one under --require-checksum, and nothing changes', () => {
      const m = machine();
      const r = m.run('update', bare(m), '--require-checksum');
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('--require-checksum');
      expect(m.version()).toBe(OLD);
      expect(m.unpacked(NEW)).toBe(false);
    });

    it('goes ahead under --require-checksum when its .sha256 matches', () => {
      const m = machine();
      const r = m.run('update', `${m.root}/published/adrian-voice-${NEW}-linux-x64.tar.gz`, '--require-checksum');
      expect(r.code).toBe(0);
      expect(m.version()).toBe(NEW);
    });
  });
});
