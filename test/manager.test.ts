import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configProblems, StackManager } from '../src/app/manager.js';
import { createLogger } from '../src/core/logger.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import { SecretsFile } from '../src/web/secrets-file.js';
import { applySettings } from '../src/web/settings.js';

const paths = { secretsFile: '/etc/adrian/secrets.env', stateDir: '/var/lib/adrian', modelsDir: '/var/lib/adrian/models' };

function manager(configFile: string): StackManager {
  const ledger = new UsageLedger(undefined, { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, 'UTC');
  return new StackManager(configFile, new SecretsFile(`${configFile}.secrets`), ledger, createLogger('error', () => undefined), paths);
}

describe('starting from the config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrian-manager-'));

  it('fails with the reason when the file does not parse, and leaves it alone', async () => {
    const configFile = join(dir, 'config.json');
    const broken = '{\n  "guildId": "100000000000000010",\n}\n';
    writeFileSync(configFile, broken);
    const m = manager(configFile);
    await expect(m.restart()).resolves.toBe('failed');
    expect(m.error).toContain('config.json');
    expect(m.error).toContain('line 3');
    expect(() => m.rawConfig()).toThrow(/config\.json/);
    expect(readFileSync(configFile, 'utf8')).toBe(broken);
  });

  it('is plain setup mode when there is no file yet', async () => {
    const m = manager(join(dir, 'none.json'));
    await expect(m.restart()).resolves.toBe('setup');
    expect(m.error).toBeUndefined();
    expect(m.rawConfig().secretsFile).toBeDefined();
  });
});

describe('setup readiness', () => {
  it('lists what is missing in plain words', () => {
    const p = configProblems({ secretsFile: paths.secretsFile }, new Map());
    expect(p).toEqual([
      'The Discord bot token is not set.',
      'No Discord server and voice channel chosen.',
      'No language model chosen.',
      expect.stringContaining('Speech models are not configured'),
    ]);
  });

  it('is ready once the wizard has filled everything in', () => {
    const raw = applySettings(
      {},
      { guildId: '100000000000000010', channelId: '100000000000000020', llm: { preset: 'groq' }, fallback: { preset: 'none' }, search: false },
      paths,
    );
    expect(configProblems(raw, new Map([['DISCORD_TOKEN', 'x']]))).toEqual(['The language model key (GROQ_API_KEY) is not set.']);
    expect(configProblems(raw, new Map([['DISCORD_TOKEN', 'x'], ['GROQ_API_KEY', 'y']]))).toEqual([]);
  });

  it('still reports a malformed section that is present', () => {
    const raw = applySettings({}, { guildId: '100000000000000010', channelId: '100000000000000020', llm: { preset: 'groq' } }, paths);
    (raw.brain as Record<string, unknown>).baseUrl = 'not a url';
    const p = configProblems(raw, new Map([['DISCORD_TOKEN', 'x'], ['GROQ_API_KEY', 'y']]));
    expect(p.some((x) => x.startsWith('Config brain.baseUrl'))).toBe(true);
  });
});
