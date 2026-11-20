// Memory at start. The server is shared with game servers and media jobs, and
// its memory guard (earlyoom: at 5% available with swap full) prefers to kill
// node. Loading the speech models while memory is that low used to end in a
// loop: load, get killed, restart 20 s later, load again (40 kills in 22 min on
// 2026-11-12, with about 1.55 GB of 32 GB available and no swap left). So a
// first start waits, with the manager's backoff, until the models fit, and the
// start's log lines say how much memory there was.

import { readFileSync } from 'node:fs';

const MB = 1024 * 1024;

export const rssMb = (): number => Math.round(process.memoryUsage.rss() / MB);

export interface MemInfo {
  totalMb: number;
  availableMb: number;
  swapTotalMb: number;
  swapFreeMb: number;
}

/** /proc/meminfo's numbers, or undefined when they can't be read (not Linux). */
export function parseMemInfo(text: string): MemInfo | undefined {
  const kb = (k: string) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(text);
    return m ? Math.round(Number(m[1]) / 1024) : undefined;
  };
  const totalMb = kb('MemTotal');
  const availableMb = kb('MemAvailable');
  if (totalMb === undefined || availableMb === undefined) return undefined;
  return { totalMb, availableMb, swapTotalMb: kb('SwapTotal') ?? 0, swapFreeMb: kb('SwapFree') ?? 0 };
}

export function readMemInfo(file = '/proc/meminfo'): MemInfo | undefined {
  try {
    return parseMemInfo(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** For log lines: this process and, on Linux, the machine. */
export function memoryFields(info: MemInfo | undefined = readMemInfo()): Record<string, number> {
  return { rssMb: rssMb(), ...(info ? { availMb: info.availableMb, swapFreeMb: info.swapFreeMb } : {}) };
}

/** What a first start adds, MB, measured with bench/mem-start.mjs (rounded up):
 *  Parakeet with its first long decodes ~900, Smart Turn ~80, the rest ~50, and
 *  the local voice ~520 when it loads at start. */
export function startNeedMb(localVoiceAtStart: boolean): number {
  return 900 + 80 + 50 + (localVoiceAtStart ? 520 : 0);
}

/** Room left after the load: available memory, plus swap above the guard's own
 *  floor, must stay above this share of the machine's memory. */
const KEEP_SHARE = 0.06;
const SWAP_FLOOR_SHARE = 0.1;

/** Undefined when the load fits (or memory can't be read), else why not. */
export function tooLittleMemory(needMb: number, info: MemInfo | undefined): string | undefined {
  if (!info) return undefined;
  const swapRoom = Math.max(0, info.swapFreeMb - SWAP_FLOOR_SHARE * info.swapTotalMb);
  const keep = Math.round(KEEP_SHARE * info.totalMb);
  const left = info.availableMb + swapRoom - needMb;
  if (left >= keep) return undefined;
  return `Too little free memory to load the speech models: ${info.availableMb} MB available, ${info.swapFreeMb} MB swap free, about ${needMb} MB needed with ${keep} MB to spare.`;
}

/** A start put off for memory: the manager tries again later (see canRecover). */
export class LowMemoryError extends Error {
  override readonly name = 'LowMemoryError';
}
