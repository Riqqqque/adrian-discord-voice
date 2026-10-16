// Validated configuration. Invalid config fails fast with a readable message.
// The bot token is never part of the config file; it comes from the secrets
// file (or environment) and is read only by the transport.

import { readFileSync } from 'node:fs';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');

/** Keys with one fixed job. A setting may only name a key meant for its own
 *  purpose, so an endpoint changed in the config (or the admin UI) can never
 *  be handed the bot token or another service's key. */
export const SECRET_PURPOSE: Readonly<Record<string, 'discord' | 'search' | 'voice' | 'media'>> = {
  DISCORD_TOKEN: 'discord',
  TAVILY_API_KEY: 'search',
  SPEECHIFY_API_KEY: 'voice',
  PLEX_TOKEN: 'media',
  SONARR_API_KEY: 'media',
  RADARR_API_KEY: 'media',
};
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A secret name for one purpose: llm keys may be empty (local servers). */
export function keyName(purpose: 'llm' | 'search' | 'voice') {
  return z.string().refine(
    (n) => (n === '' ? purpose === 'llm' : SECRET_NAME.test(n) && (SECRET_PURPOSE[n] === undefined || SECRET_PURPOSE[n] === purpose)),
    `not a key for ${purpose === 'llm' ? 'a language model' : purpose}`,
  );
}

export const PocConfigSchema = z.object({
  guildId: snowflake,
  channelId: snowflake,
  /** Ogg/Opus test clip played after joining (POC runner only). */
  testClip: z.string().min(1).optional(),
  /** Playback gain 0..1. The clip is already at about −16 LUFS. */
  playbackVolume: z.number().min(0).max(1).default(0.7),
  /** Milliseconds of silence that end an utterance. */
  silenceMs: z.number().int().min(100).max(5000).default(800),
  secretsFile: z.string().min(1),
  listen: z
    .object({
      vadModel: z.string().min(1),
      asrModelDir: z.string().min(1),
      /** Parakeet threads; 4 matches the CPUQuota budget. */
      asrThreads: z.number().int().min(1).max(8).default(4),
      vadThreshold: z.number().min(0.1).max(0.95).default(0.5),
      /** Silence that ends a phrase, seconds. */
      minSilence: z.number().min(0.1).max(3).default(0.5),
      minSpeech: z.number().min(0.05).max(2).default(0.25),
      maxSpeech: z.number().min(2).max(60).default(20),
      /** Spoken name used for the wake check. */
      wakeName: z.string().min(2).default('adrian'),
      /** Dev only: log full transcripts. Off means only wake/latency info. */
      logTranscripts: z.boolean().default(false),
    })
    .optional(),
  timezone: z.string().min(1).default('UTC'),
  /** Members with any of these role IDs may interrupt anyone's answer. */
  priorityRoleIds: z.array(z.string().regex(/^\d{17,20}$/)).default([]),
  /** Servers where /join works (empty: any server the bot was invited to). */
  allowedGuilds: z.array(z.string().regex(/^\d{17,20}$/)).max(50).default([]),
  brain: z
    .object({
      /** "anthropic" (Claude, official SDK) or "openai" (any OpenAI-compatible API: Groq, Gemini, local servers). */
      provider: z.enum(['openai', 'anthropic']).default('openai'),
      /** OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1 (unused for anthropic). */
      baseUrl: z.url().default('https://api.anthropic.com'),
      model: z.string().min(1),
      /** Claude only: low | medium | high. Lower answers faster; voice wants low. */
      effort: z.enum(['low', 'medium', 'high']).default('low'),
      /** Name of the secret holding the API key (empty for local servers). */
      apiKeySecret: keyName('llm').default('LLM_API_KEY'),
      extraBody: z.record(z.string(), z.unknown()).optional(),
      maxTokens: z.number().int().min(32).max(2000).default(500),
      firstEventTimeoutMs: z.number().int().min(500).max(30_000).default(8_000),
      totalTimeoutMs: z.number().int().min(1_000).max(60_000).default(20_000),
      /** USD per 1M tokens, for spend tracking. */
      priceInPerM: z.number().min(0).default(0),
      priceCachedInPerM: z.number().min(0).optional(),
      priceOutPerM: z.number().min(0).default(0),
      search: z
        .object({ apiKeySecret: keyName('search').default('TAVILY_API_KEY'), maxResults: z.number().int().min(1).max(8).default(4) })
        .optional(),
      /** Used when the primary fails before answering (rate limit, outage). */
      fallback: z
        .object({
          provider: z.enum(['openai', 'anthropic']).default('openai'),
          baseUrl: z.url().default('https://api.anthropic.com'),
          model: z.string().min(1),
          effort: z.enum(['low', 'medium', 'high']).default('low'),
          apiKeySecret: keyName('llm').default(''),
          extraBody: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
  /** Answer in Spanish, Chinese, Japanese and Vietnamese too (needs the Whisper model). */
  languages: z.boolean().default(true),
  /** Save facts about each person automatically from their conversations (private to them). */
  autoMemory: z.boolean().default(true),
  /** Swearing, crude humor and adult topics: off, only in age-restricted voice channels, or always. */
  mature: z.enum(['off', 'age-restricted', 'always']).default('age-restricted'),
  /** Discord user IDs with owner rights (the bot's app owner always has them):
   *  stop anyone, go to the front of the line, no per-person hourly limit. */
  owners: z.array(snowflake).max(10).default([]),
  /** Said after an owner stops an answer ("Yes boss."); empty: say nothing. */
  ownerStopReply: z.string().max(80).default(''),
  /** What an owner hears instead of "Yes?" (picked in turn), and how every
   *  answer to them starts. Empty: the normal "Yes?". */
  ownerAck: z.array(z.string().min(1).max(40)).max(10).default([]),
  /** Be extra affectionate and devoted with owners. */
  ownerAffection: z.boolean().default(false),
  identity: z
    .object({
      /** The person who set the bot up; it answers "who made you" with this name. Unset: no creator. */
      creator: z.string().min(1).max(64).optional(),
      /** How the voice should say the name, if spelled unusually (e.g. "Shawn"). */
      creatorSpoken: z.string().min(1).max(64).optional(),
      /** How speech recognition tends to spell the name when people say it. */
      creatorHeardAs: z.array(z.string().min(1).max(64)).max(20).default([]),
      /** The creator's Discord account IDs. Empty: the owners (and the app owner). */
      creatorIds: z.array(z.string().regex(/^\d{15,22}$/)).max(5).default([]),
    })
    .default({ creatorHeardAs: [], creatorIds: [] }),
  /** Game servers A.D.R.I.A.N. may check (read-only status ping). */
  gameServers: z
    .array(z.object({ name: z.string().min(1).max(60), host: z.string().min(1), port: z.number().int().min(1).max(65535), kind: z.literal('minecraft').default('minecraft') }))
    .max(20)
    .default([]),
  /** Local media apps (read-only). Each is used only if its key is in the secrets file:
   *  PLEX_TOKEN, SONARR_API_KEY, RADARR_API_KEY. */
  media: z
    .object({
      plexUrl: z.string().url().default('http://127.0.0.1:32400'),
      sonarrUrl: z.string().url().default('http://127.0.0.1:8989'),
      radarrUrl: z.string().url().default('http://127.0.0.1:7878'),
    })
    .default({ plexUrl: 'http://127.0.0.1:32400', sonarrUrl: 'http://127.0.0.1:8989', radarrUrl: 'http://127.0.0.1:7878' }),
  /** Admin web UI. Loopback only unless the installer was told otherwise. */
  server: z
    .object({
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8790),
      /** Host names the admin UI answers to besides IPs and localhost (DNS-rebinding guard). */
      allowedHosts: z.array(z.string().min(1).max(253)).max(20).default([]),
      /** PEM files; when set the UI is served over HTTPS with Secure cookies. */
      tls: z.object({ cert: z.string().min(1), key: z.string().min(1) }).optional(),
    })
    .optional(),
  /** Spend caps and per-user rate limit (0 = unlimited). */
  limits: z
    .object({
      perUserPerHour: z.number().int().min(0).default(30),
      dailyUsd: z.number().min(0).default(1),
      monthlyUsd: z.number().min(0).default(10),
      /** Where daily totals are kept, so caps survive restarts. */
      usageFile: z.string().min(1).optional(),
      /** Longest question passed to the model, characters. */
      maxRequestChars: z.number().int().min(20).max(4000).default(600),
    })
    .default({ perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10, maxRequestChars: 600 }),
  voice: z
    .object({
      modelDir: z.string().min(1),
      voice: z.string().default('af_heart'),
      speed: z.number().min(0.5).max(2).default(1.0),
      threads: z.number().int().min(1).max(8).default(4),
    })
    .optional(),
  /** Music in the call: YouTube via yt-dlp, Plex music library as backup. */
  music: z
    .object({
      enabled: z.boolean().default(true),
      /** yt-dlp binary; default: next to the models. */
      ytdlp: z.string().min(1).optional(),
      ffmpeg: z.string().min(1).default('ffmpeg'),
      plexBackup: z.boolean().default(true),
      /** Music level (0.05-1) and its level while the bot listens or talks. */
      volume: z.number().min(0.05).max(1).default(0.5),
      duckLevel: z.number().min(0).max(1).default(0.2),
      maxQueue: z.number().int().min(1).max(100).default(25),
      /** When the queue runs out, keep playing similar songs. */
      autoplay: z.boolean().default(true),
    })
    .default({ enabled: true, ffmpeg: 'ffmpeg', plexBackup: true, volume: 0.5, duckLevel: 0.2, maxQueue: 25, autoplay: true }),
  /** Cloud voice for English replies; the local voice stays as fallback. */
  cloudVoice: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.literal('speechify').default('speechify'),
      voiceId: z.string().min(1).default('sabrina'),
      model: z.string().min(1).default('simba-3.2'),
      apiKeySecret: keyName('voice').default('SPEECHIFY_API_KEY'),
      /** Characters per month before switching to the local voice (0 = unlimited). */
      monthlyChars: z.number().int().min(0).default(1_900_000),
      timeoutMs: z.number().int().min(500).max(15_000).default(4000),
    })
    .optional(),
});
export type PocConfig = z.infer<typeof PocConfigSchema>;

export function loadConfig(path: string): PocConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read config ${path}: ${(e as Error).message}`);
  }
  const parsed = PocConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid config ${path}:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

/** Minimal KEY=value reader for the secrets file (mode 0600). Values are
 *  never logged. */
export function readSecrets(path: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ''));
  }
  return out;
}
