import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, readSecrets } from '../src/config.js';

const dir = mkdtempSync(join(tmpdir(), 'adrian-cfg-'));
const write = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe('config', () => {
  it('accepts a valid config and fills defaults', () => {
    const p = write('ok.json', JSON.stringify({
      guildId: '123456789012345678', channelId: '223456789012345678',
      testClip: 'assets/test-clip.ogg', secretsFile: '/tmp/s.env',
    }));
    const c = loadConfig(p);
    expect(c.playbackVolume).toBe(0.7);
    expect(c.silenceMs).toBe(800);
  });

  it('fails fast with readable messages', () => {
    const p = write('bad.json', JSON.stringify({ guildId: 'abc', channelId: '1', testClip: '', playbackVolume: 3 }));
    expect(() => loadConfig(p)).toThrowError(/guildId: must be a Discord ID[\s\S]*playbackVolume/);
  });

  it('reads KEY=value secrets and ignores comments', () => {
    const p = write('s.env', '# comment\nDISCORD_TOKEN="abc.def"\n  OTHER = x \n');
    const s = readSecrets(p);
    expect(s.get('DISCORD_TOKEN')).toBe('abc.def');
    expect(s.get('OTHER')).toBe('x');
    expect(s.size).toBe(2);
  });
});
