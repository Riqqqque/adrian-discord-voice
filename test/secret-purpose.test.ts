import { describe, expect, it } from 'vitest';
import { PocConfigSchema } from '../src/config.js';
import { CustomLlmSchema } from '../src/web/settings.js';

const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/etc/adrian/secrets.env' };
const custom = (keySecret: string) => ({ preset: 'custom', baseUrl: 'https://llm.example', model: 'm', keySecret, priceInPerM: 0, priceOutPerM: 0 });

describe('a setting can only name a key meant for its own job', () => {
  it('an LLM endpoint can never be given the bot token or another service key', () => {
    for (const k of ['DISCORD_TOKEN', 'PLEX_TOKEN', 'SONARR_API_KEY', 'RADARR_API_KEY', 'SPEECHIFY_API_KEY', 'TAVILY_API_KEY', 'HELIX_TOKEN', 'STEAM_API_KEY']) {
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

describe('calendar addresses and home control tokens', () => {
  const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/etc/adrian/secrets.env' };
  const cal = (urlSecret: string) => ({ ...base, calendar: { calendars: [{ name: 'personal', urlSecret }] } });
  const home = (tokenSecret: string) => ({ ...base, mcp: { servers: [{ name: 'home', url: 'http://127.0.0.1:8123/api/mcp', tokenSecret, allow: ['HassTurnOn'] }] } });

  it('a calendar can never be handed a key or token of another job, and the reverse', () => {
    for (const k of ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'HOME_ASSISTANT_TOKEN', 'PLEX_TOKEN']) expect(PocConfigSchema.safeParse(cal(k)).success, k).toBe(false);
    for (const k of ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'CALENDAR_ICS_URL', 'TAVILY_API_KEY']) expect(PocConfigSchema.safeParse(home(k)).success, k).toBe(false);
    expect(PocConfigSchema.safeParse({ ...base, brain: { model: 'm', apiKeySecret: 'HOME_ASSISTANT_TOKEN' } }).success).toBe(false);
    expect(PocConfigSchema.safeParse({ ...base, brain: { model: 'm', background: { model: 'qwen', apiKeySecret: 'CALENDAR_ICS_URL' } } }).success).toBe(false);
    expect(PocConfigSchema.safeParse(cal('CALENDAR_ICS_URL')).success).toBe(true);
    expect(PocConfigSchema.safeParse(cal('WORK_CALENDAR_URL')).success).toBe(true);
    expect(PocConfigSchema.safeParse(home('HOME_ASSISTANT_TOKEN')).success).toBe(true);
  });

  it('the new sections default to off, and doors and locks ask first', () => {
    const c = PocConfigSchema.parse(base);
    expect(c.briefing.enabled).toBe(false);
    expect(c.calendar.calendars).toEqual([]);
    expect(c.mcp.servers).toEqual([]);
    expect(c.news.feeds).toEqual(['https://feeds.npr.org/1001/rss.xml']);
    const h = PocConfigSchema.parse(home('HOME_ASSISTANT_TOKEN'));
    expect(h.mcp.servers[0]!.confirmWords).toContain('unlock');
    expect(h.mcp.servers[0]!.people).toEqual([]);
    expect(PocConfigSchema.safeParse({ ...base, weather: { latitude: 40 } }).success).toBe(false);
    expect(PocConfigSchema.safeParse({ ...base, news: { feeds: ['http://insecure.example/rss'] } }).success).toBe(false);
    expect(PocConfigSchema.safeParse({ ...base, briefing: { fromHour: 12, untilHour: 9 } }).success).toBe(false);
  });
});
