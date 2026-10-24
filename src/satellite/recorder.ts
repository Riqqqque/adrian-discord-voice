// Opt-in recordings of what's said to her at a PC (config satellite.recordDays),
// for testing speech-to-text on the owner's real voice and mic. Only speech
// already judged as meant for her is kept, never side talk. Files live in the
// state folder and are deleted after recordDays.

import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wav } from '../speech/cloud-stt.js';

const DAY_MS = 86_400_000;

export class PcRecorder {
  private lastPrune = 0;

  constructor(
    private readonly dir: string,
    private readonly days: number,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.prune();
  }

  /** Saves one segment (16 kHz) and what each listener heard. */
  save(room: string, samples: Float32Array, heard: { local: string; cloud?: string }): void {
    const t = this.now();
    const day = new Date(t).toISOString().slice(0, 10);
    const dayDir = join(this.dir, day);
    mkdirSync(dayDir, { recursive: true, mode: 0o700 });
    const file = `${t}.wav`;
    writeFileSync(join(dayDir, file), wav(samples, 16_000), { mode: 0o600 });
    appendFileSync(join(dayDir, 'index.jsonl'), JSON.stringify({ file, at: new Date(t).toISOString(), room, ...heard }) + '\n', { mode: 0o600 });
    if (t - this.lastPrune > 3_600_000) this.prune();
  }

  /** Deletes day folders older than `days`. */
  prune(): void {
    this.lastPrune = this.now();
    const cutoff = new Date(this.now() - this.days * DAY_MS).toISOString().slice(0, 10);
    for (const d of readdirSync(this.dir)) if (/^\d{4}-\d\d-\d\d$/.test(d) && d < cutoff) rmSync(join(this.dir, d), { recursive: true, force: true });
  }
}
