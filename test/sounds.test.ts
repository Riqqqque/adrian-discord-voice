import { describe, expect, it } from 'vitest';
import { pickShort } from '../src/features/music.js';
import { soundTool } from '../src/features/sounds.js';
import type { Track } from '../src/features/music.js';

describe('sound effects', () => {
  it('picks a short clip, skipping long and live ones', () => {
    const out = 'AAAAAAAAAAA\t3600\tNA\nBBBBBBBBBBB\tNA\tis_live\nCCCCCCCCCCC\t9\tNA\n';
    expect(pickShort(out, 30)).toBe('CCCCCCCCCCC');
    expect(pickShort('AAAAAAAAAAA\t90\tNA\n', 30)).toBeUndefined();
    expect(pickShort('AAAAAAAAAAA\t90\tNA\n', 120)).toBe('AAAAAAAAAAA');
  });

  it('finds and plays the sound; says so when there is none', async () => {
    const played: string[] = [];
    const t = soundTool({
      find: async (q) => (q === 'nothing' ? undefined : ({ title: q, source: 'youtube', ref: `https://x/${q}` } as Track)),
      play: async (tr) => void played.push(tr.ref),
    });
    const sig = AbortSignal.timeout(1000);
    const ctx = { userId: 'u', speaker: 'Sam' };
    expect(await t.run({ query: 'airhorn' }, sig, ctx)).toContain('airhorn');
    expect(played).toEqual(['https://x/airhorn']);
    await expect(t.run({ query: 'nothing' }, sig, ctx)).rejects.toThrow('no "nothing" sound');
    expect(t.endsTurn).toBe(true);
    expect(t.timeoutMs).toBeGreaterThan(5_000);
  });
});
