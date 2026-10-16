import { describe, expect, it } from 'vitest';
import { configProblems } from '../src/app/manager.js';
import { applySettings } from '../src/web/settings.js';

const paths = { secretsFile: '/etc/adrian/secrets.env', stateDir: '/var/lib/adrian', modelsDir: '/var/lib/adrian/models' };

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
