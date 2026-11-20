// Memory at start: the numbers read from /proc/meminfo, when a first start
// fits, and the manager waiting (with its usual backoff) when it doesn't.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canRecover, StackManager } from '../src/app/manager.js';
import { LowMemoryError, memoryFields, parseMemInfo, startNeedMb, tooLittleMemory, type MemInfo } from '../src/app/memory.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import { ParakeetStt } from '../src/speech/sherpa.js';
import { SecretsFile } from '../src/web/secrets-file.js';
import { applySettings } from '../src/web/settings.js';

const MEMINFO = `MemTotal:       32775168 kB
MemFree:          366592 kB
MemAvailable:    1594368 kB
Buffers:          102400 kB
SwapTotal:       8387584 kB
SwapFree:              0 kB
`;
/** 2026-11-12, while the bot was killed at every start: 32007 MB, ~1557 available, swap full. */
const starved: MemInfo = { totalMb: 32007, availableMb: 1557, swapTotalMb: 8191, swapFreeMb: 0 };
/** A usual evening on the same machine. */
const usual: MemInfo = { totalMb: 32007, availableMb: 4731, swapTotalMb: 8191, swapFreeMb: 0 };

describe('reading /proc/meminfo', () => {
  it('takes the totals in MB', () => {
    expect(parseMemInfo(MEMINFO)).toEqual({ totalMb: 32007, availableMb: 1557, swapTotalMb: 8191, swapFreeMb: 0 });
  });

  it('gives nothing for text without the numbers it needs', () => {
    expect(parseMemInfo('')).toBeUndefined();
    expect(parseMemInfo('MemTotal: 1000 kB\n')).toBeUndefined();
  });

  it('log fields: rss always, the machine only when known', () => {
    expect(Object.keys(memoryFields(undefined))).toEqual(['rssMb']);
    expect(memoryFields(usual)).toMatchObject({ availMb: 4731, swapFreeMb: 0 });
  });
});

describe('whether a first start fits', () => {
  it('needs the local voice only when it loads at start', () => {
    expect(startNeedMb(true) - startNeedMb(false)).toBe(520);
  });

  it('waits on the memory the kill loop had', () => {
    expect(tooLittleMemory(startNeedMb(false), starved)).toMatch(/1557 MB available/);
    expect(tooLittleMemory(startNeedMb(false), starved)).toMatch(/0 MB swap free/);
  });

  it('goes ahead on a usual evening', () => {
    expect(tooLittleMemory(startNeedMb(false), usual)).toBeUndefined();
  });

  it('counts swap above the guard’s own floor', () => {
    const swappy = { ...starved, swapFreeMb: 6000 };
    expect(tooLittleMemory(startNeedMb(false), swappy)).toBeUndefined();
    const nearFloor = { ...starved, swapFreeMb: 900 }; // under 10% of swap is no room
    expect(tooLittleMemory(startNeedMb(false), nearFloor)).toBeDefined();
  });

  it('goes ahead when memory can not be read (not Linux)', () => {
    expect(tooLittleMemory(startNeedMb(false), undefined)).toBeUndefined();
  });

  it('a start put off for memory is one the manager tries again', () => {
    expect(canRecover(new LowMemoryError('x'))).toBe(true);
  });
});

describe('the manager waiting for memory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrian-memory-'));
  const paths = { secretsFile: '/etc/adrian/secrets.env', stateDir: '/var/lib/adrian', modelsDir: '/var/lib/adrian/models' };
  const configFile = join(dir, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify(applySettings({}, { guildId: '100000000000000010', channelId: '100000000000000020', llm: { preset: 'groq' }, fallback: { preset: 'none' }, search: false }, paths)),
  );
  const secrets = new SecretsFile(`${configFile}.secrets`);
  secrets.set('DISCORD_TOKEN', 'x');
  secrets.set('GROQ_API_KEY', 'y');
  type StartFn = NonNullable<ConstructorParameters<typeof StackManager>[5]>;

  function rig(mem: () => MemInfo | undefined) {
    const running = { stop: async () => undefined };
    const start = vi.fn(async () => running);
    const lines: { m: string; f?: Record<string, unknown> }[] = [];
    const push = (m: string, f?: Record<string, unknown>) => void lines.push({ m, ...(f ? { f } : {}) });
    const log = { debug() {}, info: push, warn: push, error: push };
    const ledger = new UsageLedger(undefined, { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, 'UTC');
    const m = new StackManager(configFile, secrets, ledger, log, paths, start as unknown as StartFn, mem, () => Date.now());
    return { m, start, lines };
  }

  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts when there is room, and logs the memory before and after', async () => {
    const r = rig(() => usual);
    await expect(r.m.restart()).resolves.toBe('running');
    expect(r.lines.find((l) => l.m === 'voice stack starting')?.f).toMatchObject({ needMb: startNeedMb(true), availMb: 4731 });
    expect(r.lines.find((l) => l.m === 'voice stack ready')?.f).toMatchObject({ availMb: 4731 });
  });

  it('puts the start off while memory is short, and starts once it frees up', async () => {
    let mem = starved;
    const r = rig(() => mem);
    // Still starting, not failed: `adrian update` keeps waiting instead of rolling back.
    await expect(r.m.restart()).resolves.toBe('starting');
    expect(r.m.waitingFor).toBe('memory');
    expect(r.m.error).toMatch(/Too little free memory/);
    expect(r.start).not.toHaveBeenCalled();
    expect(r.lines.map((l) => l.m)).toContain('waiting for memory before loading the speech models');
    expect(r.lines.map((l) => l.m)).not.toContain('voice stack failed to start');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.start).not.toHaveBeenCalled(); // still short: it looks again every 30 s
    expect(r.m.state).toBe('starting');
    mem = usual;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.m.state).toBe('running');
    expect(r.m.waitingFor).toBeUndefined();
  });

  it('loads anyway after a quarter of an hour of waiting, in case the estimate is wrong', async () => {
    const r = rig(() => starved);
    await r.m.restart();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(r.start).not.toHaveBeenCalled();
    expect(r.m.state).toBe('starting');
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.lines.map((l) => l.m)).toContain('starting anyway after waiting for memory');
    expect(r.m.state).toBe('running');
  }, 30_000); // 30 looks at memory, each a start attempt that reads the config

  /** The recognizer this config loads. */
  const asrOf = (r: ReturnType<typeof rig>) => (r.m as unknown as { config(): { listen: { asrModelDir: string; asrThreads: number } } }).config().listen;

  it('a restart with the speech models already loaded does not wait', async () => {
    vi.spyOn(ParakeetStt, 'load').mockResolvedValue({} as ParakeetStt);
    const r = rig(() => starved);
    const asr = asrOf(r);
    await r.m.models.sttFor(asr.asrModelDir, asr.asrThreads);
    await expect(r.m.restart()).resolves.toBe('running');
    expect(r.lines.some((l) => l.m === 'voice stack starting')).toBe(false);
  });

  it('a restart that loads another recognizer (threads, folder) checks memory first', async () => {
    vi.spyOn(ParakeetStt, 'load').mockResolvedValue({} as ParakeetStt);
    const r = rig(() => starved);
    const asr = asrOf(r);
    await r.m.models.sttFor(asr.asrModelDir, asr.asrThreads + 1);
    await expect(r.m.restart()).resolves.toBe('starting');
    expect(r.m.waitingFor).toBe('memory');
    await r.m.stop();
  });

  it('does not check without a memory reader (tests, Windows)', async () => {
    const r = rig(() => undefined);
    await expect(r.m.restart()).resolves.toBe('running');
  });
});
