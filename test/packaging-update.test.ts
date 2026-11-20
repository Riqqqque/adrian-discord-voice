// `adrian update`, run for real in bash against the version it replaces: keeping, rolling back, the other commands.
// Apart from packaging.test.ts so the slow shell tests run in parallel workers.

import { describe, expect, it, vi } from 'vitest';
import { hasBash, machine, NEW, noVoice, OLD, type Release, setupMode } from './packaging-shell.js';

// Each test starts bash dozens of times: seconds on Windows, and minutes when the
// machine is busy and these files run side by side. Hours on the fake clock run in no time.
vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!hasBash)('adrian update, judged against the version it replaces', () => {
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
  });

  it('gives it up to two minutes to come up', () => {
    const m = machine({ comesUpAfter: 100 });
    expect(m.hourly().code).toBe(0);
    expect(m.version()).toBe(NEW);
  });

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
  });

  it('rides out a voice drop during the last check: a drop can take most of a minute to come back', () => {
    const m = machine({ afterAMinute: noVoice, backAfter: 640 }); // the check starts at 600
    const r = m.hourly();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(m.version()).toBe(NEW);
    expect(m.marker()).toBeUndefined();
  });

  it('asks for no more than the old version managed: voice already down', () => {
    const m = machine({ before: noVoice, after: noVoice });
    expect(m.hourly().code).toBe(0);
    expect(m.version()).toBe(NEW);
  });

  it('can always update out of a version that does not answer: ok is enough', () => {
    const m = machine({ before: null, after: setupMode });
    expect(m.hourly().code).toBe(0);
    expect(m.version()).toBe(NEW);
  });

  it('still rolls back one that does not come up either', () => {
    const m = machine({ before: null, after: null });
    expect(m.hourly().code).not.toBe(0);
    expect(m.version()).toBe(OLD);
  });

  it('finishes rolling back when systemd won\'t start the old version either', () => {
    const m = machine({ noStarts: true, before: null });
    const r = m.hourly();
    expect(r.err).toContain('not healthy either');
    expect(m.version()).toBe(OLD);
    expect(m.previous()).toBe('0.9.0');
    expect(m.unpacked(NEW)).toBe(false);
    expect(m.marker()).toBe(NEW);
  });

  it('restarts the old version even if its service file will not go back', () => {
    const m = machine({ after: null, unitStuck: true });
    const r = m.hourly();
    expect(r.err).toContain(`rolled back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.restarts()).toHaveLength(2);
    expect(m.previous()).toBe('0.9.0');
    expect(m.unpacked(NEW)).toBe(false);
    expect(m.marker()).toBe(NEW);
  });

  it('finishes rolling back with nowhere to remember the failure: a full disk may be why it failed', () => {
    const m = machine({ after: null, markerStuck: true });
    const r = m.hourly();
    expect(r.err).toContain(`rolled back to ${OLD}`);
    expect(m.version()).toBe(OLD);
    expect(m.previous()).toBe('0.9.0');
    expect(m.unpacked(NEW)).toBe(false);
  });

  it('adrian help lists every command', () => {
    const r = machine().run('help');
    for (const cmd of ['adrian status', 'adrian update', 'adrian auto-update', 'adrian rollback', 'adrian uninstall', 'adrian version']) expect(r.out).toContain(cmd);
  });

  it('leaves the other commands needing only a healthy answer', () => {
    for (const [cmd, ok] of [['restart', setupMode], ['start', noVoice]] as const) {
      const m = machine({ before: ok });
      expect(m.run(cmd).code).toBe(0);
    }
    const down = machine({ before: null });
    const r = down.run('restart');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('not healthy after 60 s');
  });
});
