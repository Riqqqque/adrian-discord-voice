import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PcRecorder } from '../src/satellite/recorder.js';

describe('PC recorder', () => {
  it('saves a WAV and what was heard, and deletes days past the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    mkdirSync(join(dir, '2026-01-01'));
    let now = Date.parse('2026-10-21T12:00:00Z');
    const rec = new PcRecorder(dir, 3, () => now);
    expect(existsSync(join(dir, '2026-01-01'))).toBe(false);

    rec.save('sat:x', new Float32Array(1600).fill(0.1), { local: 'pause the shoes', cloud: 'Pause the show.' });
    const day = join(dir, '2026-10-21');
    const wav = readdirSync(day).find((f) => f.endsWith('.wav'))!;
    expect(readFileSync(join(day, wav)).length).toBe(44 + 1600 * 2);
    expect(JSON.parse(readFileSync(join(day, 'index.jsonl'), 'utf8'))).toMatchObject({ file: wav, room: 'sat:x', local: 'pause the shoes', cloud: 'Pause the show.' });

    now += 4 * 86_400_000;
    rec.prune();
    expect(existsSync(day)).toBe(false);
  });
});
