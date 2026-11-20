// One job at a time on a shared model (Parakeet serves every room). Jobs run
// in the order they were handed in, except that background ones (a PC's early
// decode, which nobody waits on yet) let every other waiting job go first. A
// running job can't be stopped; one cancelled while it waits leaves at once.

import type { DecodeOptions } from '../core/interfaces.js';

interface Job {
  work: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  signal: AbortSignal | undefined;
  background: (() => boolean) | undefined;
  onAbort?: () => void;
}

export class DecodeQueue {
  private readonly waiting: Job[] = [];
  private busy = false;

  run<T>(work: () => Promise<T>, signal?: AbortSignal, o: DecodeOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('cancelled'));
      const job: Job = { work, resolve: resolve as (v: unknown) => void, reject, signal, background: o.background };
      if (signal) {
        job.onAbort = () => {
          const i = this.waiting.indexOf(job);
          if (i < 0) return; // running or done
          this.waiting.splice(i, 1);
          reject(new Error('cancelled'));
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.waiting.push(job);
      this.next();
    });
  }

  /** Jobs waiting, for tests and logs. */
  get length(): number {
    return this.waiting.length;
  }

  private next(): void {
    if (this.busy || !this.waiting.length) return;
    // Asked now, not when it was queued: an early clip someone now waits on is a real one.
    let i = this.waiting.findIndex((j) => !j.background?.());
    if (i < 0) i = 0;
    const job = this.waiting.splice(i, 1)[0]!;
    if (job.onAbort) job.signal!.removeEventListener('abort', job.onAbort);
    this.busy = true;
    job
      .work()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.busy = false;
        this.next();
      });
  }
}
