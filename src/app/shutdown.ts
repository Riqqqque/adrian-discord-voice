// Exit on a signal, and say so. The handlers go in before the voice stack
// starts: a SIGTERM while the models were loading (the server's memory guard
// sends them) used to end the process without a word in the log, so a loop of
// kills at start looked like a loop of quiet restarts.

import type { Logger } from '../core/interfaces.js';
import type { StackState } from './manager.js';
import { memoryFields } from './memory.js';

export interface ShutdownDeps {
  log: Pick<Logger, 'info' | 'warn'>;
  /** The voice stack's state when the signal came. */
  state(): StackState;
  /** Seconds since the process started. */
  uptimeS(): number;
  closeWeb(): void;
  /** Stops a running voice stack (waits for a start in progress). */
  stopStack(): Promise<void>;
  /** Saves what must survive (the usage ledger). */
  flush(): void;
  /** The end of a clean stop. */
  exit(code: number): void;
  /** Ends the process at once, without waiting for native work in flight.
   *  process.exit waits for a model load running on libuv's pool to finish
   *  (seconds), so main.ts re-raises the signal with its default action. */
  exitNow(signal: string): void;
  memory?(): Record<string, number>;
  /** Longest a clean stop may take before the process goes anyway. */
  stopTimeoutMs?: number;
}

/** Ends the process the way the signal's default action would: at once, with
 *  the exit status saying which signal it was. Windows has no such default, so
 *  there it's a plain exit. */
export function reraise(signal: string, proc: Pick<NodeJS.Process, 'platform' | 'pid' | 'removeAllListeners' | 'kill' | 'exit'> = process): void {
  if (proc.platform === 'win32') {
    proc.exit(0);
    return;
  }
  proc.removeAllListeners(signal); // back to the default action
  proc.kill(proc.pid, signal);
  proc.exit(0); // only if the signal somehow didn't end it
}

/** The function to call with each signal's name. */
export function shutdownOnSignal(d: ShutdownDeps): (signal: string) => Promise<void> {
  let stopping = false;
  return async (signal) => {
    if (stopping) {
      d.log.warn('second signal; exiting now', { signal });
      d.flush();
      d.exitNow(signal);
      return;
    }
    stopping = true;
    const state = d.state();
    d.log.info('shutting down', { signal, state, uptimeS: d.uptimeS(), ...(d.memory ?? memoryFields)() });
    // While the models load, stopping would wait for the load to finish, and
    // whoever sent the signal wants the memory back now. Nothing has started
    // that needs a clean stop yet.
    if (state === 'starting') {
      try {
        d.closeWeb();
      } finally {
        d.flush();
        d.exitNow(signal);
      }
      return;
    }
    try {
      d.closeWeb();
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<void>((r) => (timer = setTimeout(r, d.stopTimeoutMs ?? 20_000)));
      await Promise.race([d.stopStack().catch((e: Error) => d.log.warn('stop failed', { error: e.message })), late]);
      clearTimeout(timer);
    } finally {
      d.flush();
      d.exit(0);
    }
  };
}
