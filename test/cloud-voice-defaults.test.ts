import { describe, expect, it } from 'vitest';
import { PocConfigSchema } from '../src/config.js';

const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/etc/adrian/secrets.env' };
const voice = (cloudVoice: object) => PocConfigSchema.parse({ ...base, cloudVoice }).cloudVoice!;

describe('cloud voice defaults follow the model', () => {
  it('a new install speaks simba-3.5 at its own pace, capped at what the plan covers', () => {
    expect(voice({})).toMatchObject({ model: 'simba-3.5', speed: 1, monthlyChars: 950_000 });
  });

  it('simba-3.2 keeps its quicker rate and the full plan', () => {
    expect(voice({ model: 'simba-3.2' })).toMatchObject({ speed: 1.2, monthlyChars: 1_900_000 });
  });

  it('settings someone chose are kept', () => {
    expect(voice({ model: 'simba-3.5', speed: 0.9, monthlyChars: 0 })).toMatchObject({ speed: 0.9, monthlyChars: 0 });
  });
});
