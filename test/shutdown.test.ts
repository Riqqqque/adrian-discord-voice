// A signal is always logged, and while the models load it ends the process at
// once instead of waiting for the load (the memory guard wants the memory now).
import { describe, expect, it, vi } from 'vitest';
import type { StackState } from '../src/app/manager.js';
import { reraise, shutdownOnSignal, type ShutdownDeps } from '../src/app/shutdown.js';

function deps(state: StackState, over: Partial<ShutdownDeps> = {}) {
  const calls: string[] = [];
  const lines: { m: string; f?: Record<string, unknown> }[] = [];
  const d: ShutdownDeps = {
    log: { info: (m, f) => void lines.push({ m, ...(f ? { f } : {}) }), warn: (m, f) => void lines.push({ m, ...(f ? { f } : {}) }) },
    state: () => state,
    uptimeS: () => 12,
    closeWeb: () => void calls.push('closeWeb'),
    stopStack: async () => void calls.push('stopStack'),
    flush: () => void calls.push('flush'),
    exit: (code) => void calls.push(`exit ${code}`),
    exitNow: (sig) => void calls.push(`exitNow ${sig}`),
    memory: () => ({ rssMb: 425, availMb: 1557, swapFreeMb: 0 }),
    ...over,
  };
  return { d, calls, lines };
}

describe('a signal', () => {
  it('while running: logged with the state and memory, then a clean stop', async () => {
    const r = deps('running');
    await shutdownOnSignal(r.d)('SIGTERM');
    expect(r.lines).toEqual([{ m: 'shutting down', f: { signal: 'SIGTERM', state: 'running', uptimeS: 12, rssMb: 425, availMb: 1557, swapFreeMb: 0 } }]);
    expect(r.calls).toEqual(['closeWeb', 'stopStack', 'flush', 'exit 0']);
  });

  it('while the models load: logged too, then out at once, without waiting for the start', async () => {
    const stopStack = vi.fn(() => new Promise<void>(() => {})); // a start that never ends
    const r = deps('starting', { stopStack });
    await shutdownOnSignal(r.d)('SIGTERM');
    expect(r.lines[0]).toMatchObject({ m: 'shutting down', f: { signal: 'SIGTERM', state: 'starting' } });
    expect(stopStack).not.toHaveBeenCalled();
    expect(r.calls).toEqual(['closeWeb', 'flush', 'exitNow SIGTERM']);
  });

  it('in setup mode or after a failed start: a clean stop, like running', async () => {
    for (const s of ['setup', 'failed'] as const) {
      const r = deps(s);
      await shutdownOnSignal(r.d)('SIGINT');
      expect(r.calls).toEqual(['closeWeb', 'stopStack', 'flush', 'exit 0']);
    }
  });

  it('a stop that hangs ends after its time, with the ledger saved', async () => {
    vi.useFakeTimers();
    try {
      const r = deps('running', { stopStack: () => new Promise<void>(() => {}), stopTimeoutMs: 1_000 });
      const done = shutdownOnSignal(r.d)('SIGTERM');
      await vi.advanceTimersByTimeAsync(999);
      expect(r.calls).toEqual(['closeWeb']);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(r.calls).toEqual(['closeWeb', 'flush', 'exit 0']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stop that fails is logged and still exits', async () => {
    const r = deps('running', { stopStack: async () => Promise.reject(new Error('disconnect failed')) });
    await shutdownOnSignal(r.d)('SIGTERM');
    expect(r.lines.map((l) => l.m)).toEqual(['shutting down', 'stop failed']);
    expect(r.calls.slice(-2)).toEqual(['flush', 'exit 0']);
  });

  it('a second one during a slow stop ends it at once', async () => {
    const r = deps('running', { stopStack: () => new Promise<void>(() => {}) });
    const on = shutdownOnSignal(r.d);
    void on('SIGTERM');
    await on('SIGTERM');
    expect(r.lines.map((l) => l.m)).toEqual(['shutting down', 'second signal; exiting now']);
    expect(r.calls).toEqual(['closeWeb', 'flush', 'exitNow SIGTERM']);
  });

  it('logs the machine memory by default (rss everywhere)', async () => {
    const r = deps('running', { memory: undefined });
    await shutdownOnSignal(r.d)('SIGTERM');
    expect(typeof r.lines[0]!.f!.rssMb).toBe('number');
  });
});

describe('ending at once', () => {
  const proc = (platform: NodeJS.Platform) => {
    const calls: string[] = [];
    return {
      calls,
      p: {
        platform,
        pid: 42,
        removeAllListeners: (s: string) => (calls.push(`remove ${s}`), undefined as never),
        kill: (pid: number, s: string) => (calls.push(`kill ${pid} ${s}`), true),
        exit: (c: number) => void calls.push(`exit ${c}`) as never,
      } as unknown as Parameters<typeof reraise>[1],
    };
  };

  it('re-raises the signal with its default action, so the exit status names it', () => {
    const x = proc('linux');
    reraise('SIGTERM', x.p);
    expect(x.calls).toEqual(['remove SIGTERM', 'kill 42 SIGTERM', 'exit 0']);
  });

  it('is a plain exit on Windows', () => {
    const x = proc('win32');
    reraise('SIGTERM', x.p);
    expect(x.calls).toEqual(['exit 0']);
  });
});
