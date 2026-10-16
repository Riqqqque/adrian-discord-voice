import { describe, expect, it } from 'vitest';
import { PocConfigSchema } from '../src/config.js';
import { CustomLlmSchema } from '../src/web/settings.js';

const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/etc/adrian/secrets.env' };
const custom = (keySecret: string) => ({ preset: 'custom', baseUrl: 'https://llm.example', model: 'm', keySecret, priceInPerM: 0, priceOutPerM: 0 });

describe('a setting can only name a key meant for its own job', () => {
  it('an LLM endpoint can never be given the bot token or another service key', () => {
    for (const k of ['DISCORD_TOKEN', 'PLEX_TOKEN', 'SONARR_API_KEY', 'RADARR_API_KEY', 'SPEECHIFY_API_KEY', 'TAVILY_API_KEY']) {
      expect(CustomLlmSchema.safeParse(custom(k)).success, k).toBe(false);
      expect(PocConfigSchema.safeParse({ ...base, brain: { model: 'm', apiKeySecret: k } }).success, k).toBe(false);
      expect(PocConfigSchema.safeParse({ ...base, brain: { model: 'm', fallback: { model: 'f', apiKeySecret: k } } }).success, k).toBe(false);
    }
    for (const k of ['LLM_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY', '']) expect(CustomLlmSchema.safeParse(custom(k)).success, k).toBe(true);
  });

  it('search and cloud voice only take their own (or unassigned) keys', () => {
    expect(PocConfigSchema.safeParse({ ...base, brain: { model: 'm', search: { apiKeySecret: 'DISCORD_TOKEN' } } }).success).toBe(false);
    expect(PocConfigSchema.safeParse({ ...base, brain: { model: 'm', search: { apiKeySecret: 'TAVILY_API_KEY' } } }).success).toBe(true);
    expect(PocConfigSchema.safeParse({ ...base, cloudVoice: { apiKeySecret: 'PLEX_TOKEN' } }).success).toBe(false);
    expect(PocConfigSchema.safeParse({ ...base, cloudVoice: { apiKeySecret: 'SPEECHIFY_API_KEY' } }).success).toBe(true);
  });
});

it('the sample config itself is valid (so the rejections above are about the key)', () => {
  const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/etc/adrian/secrets.env' };
  expect(PocConfigSchema.safeParse({ ...base, brain: { model: 'm' } }).success).toBe(true);
});
