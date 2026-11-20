// `adrian update`, run for real in bash against the version it replaces: the service file, a busy call, failed versions, the config check.
// Apart from packaging.test.ts so the slow shell tests run in parallel workers.

import { describe, expect, it, vi } from 'vitest';
import { hasBash, health, machine, NEW, noVoice, OLD, setupMode } from './packaging-shell.js';

// Each test starts bash dozens of times: seconds on Windows, and minutes when the
// machine is busy and these files run side by side. Hours on the fake clock run in no time.
vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!hasBash)('adrian update, judged against the version it replaces', () => {
  describe('the service file', () => {
    it('goes with a release that stays', () => {
      const m = machine();
      m.hourly();
      expect(m.unit()).toBe(`unit of ${NEW}`);
    });

    it('goes back with a rollback, before the old version starts', () => {
      const m = machine({ after: noVoice });
      m.hourly();
      expect(m.unit()).toBe(`unit of ${OLD}`);
      expect(m.log().match(/^reload$/gm)).toHaveLength(2); // the release's, then the old one's
      expect(m.restarts()).toEqual([`restart under: unit of ${NEW}`, `restart under: unit of ${OLD}`]);
    });

    it('goes back when upgrade-prep.sh fails after replacing it: nothing was switched', () => {
      const m = machine({ prepFails: true });
      const r = m.hourly();
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('nothing was switched');
      expect(m.unit()).toBe(`unit of ${OLD}`);
      expect(m.restarts()).toEqual([]);
      expect(m.version()).toBe(OLD);
    });
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
    });

    it('does not stop an update by hand', () => {
      const m = machine({ afterPrep: busy });
      expect(m.run('update').code).toBe(0);
      expect(m.version()).toBe(NEW);
    });
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
    });

    it('gets another try a day later: a passing outage can fail a good release', () => {
      const m = machine({ failed: NEW, failedHoursAgo: 25 });
      expect(m.hourly().code).toBe(0);
      expect(m.version()).toBe(NEW);
      expect(m.marker()).toBeUndefined();
    });

    it('stays alone until then', () => {
      const m = machine({ failed: NEW, failedHoursAgo: 23 });
      expect(m.hourly().code).toBe(0);
      expect(m.downloads()).toEqual([]);
    });

    it('does not hold back a different version', () => {
      const m = machine({ failed: '9.9.8' });
      expect(m.hourly().code).toBe(0);
      expect(m.version()).toBe(NEW);
    });

    it('does not stop an update by hand, and a success clears it', () => {
      const m = machine({ failed: NEW });
      expect(m.run('update').code).toBe(0);
      expect(m.version()).toBe(NEW);
      expect(m.marker()).toBeUndefined();
    });

    it('shows up in adrian doctor', () => {
      const r = machine({ failed: NEW }).run('doctor');
      expect(r.out).toMatch(new RegExp(`warn +update ${NEW.replaceAll('.', '\\.')} failed here on \\d{4}-\\d\\d-\\d\\d`));
      expect(machine().run('doctor').out).not.toContain('failed here');
    });
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
    });

    it('takes a crash for no answer: it runs under the old Node, and the health check still judges it', () => {
      const m = machine({ check: [1, "SyntaxError: Unexpected token '#'\n"] });
      expect(m.hourly().code).toBe(0);
      expect(m.version()).toBe(NEW);
    });

    it.each([
      ['in setup mode', setupMode],
      ['not answering', null],
    ] as [string, string | null][])('leaves unfinished setup alone: not asked while %s', (_, before) => {
      const m = machine({ before, after: before ?? setupMode, check: refused });
      expect(m.hourly().code).toBe(0);
      expect(m.log()).not.toContain(`asked ${NEW}`);
      expect(m.version()).toBe(NEW);
    });
  });
});
