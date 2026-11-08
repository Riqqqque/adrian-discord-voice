// Validated configuration. Invalid config fails fast with a readable message.
// The bot token is never part of the config file; it comes from the secrets
// file (or environment) and is read only by the transport.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseSteamAccount } from './features/steam.js';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');

/** Keys with one fixed job. A setting may only name a key meant for its own
 *  purpose, so an endpoint changed in the config (or the admin UI) can never
 *  be handed the bot token or another service's key. */
export const SECRET_PURPOSE: Readonly<Record<string, 'discord' | 'search' | 'voice' | 'media' | 'steam' | 'helix'>> = {
  DISCORD_TOKEN: 'discord',
  TAVILY_API_KEY: 'search',
  SPEECHIFY_API_KEY: 'voice',
  PLEX_TOKEN: 'media',
  SONARR_API_KEY: 'media',
  RADARR_API_KEY: 'media',
  STEAM_API_KEY: 'steam',
  /** Helix server API token: starts, stops and restarts game servers. */
  HELIX_TOKEN: 'helix',
};
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** A secret name for one purpose: llm keys may be empty (local servers). */
export function keyName(purpose: 'llm' | 'search' | 'voice') {
  return z.string().refine(
    (n) => (n === '' ? purpose === 'llm' : SECRET_NAME.test(n) && (SECRET_PURPOSE[n] === undefined || SECRET_PURPOSE[n] === purpose)),
    `not a key for ${purpose === 'llm' ? 'a language model' : purpose}`,
  );
}

/** simba-3.2 speaks 133 words a minute, slow for a conversation; 1.2 brings it to
 *  about 165. simba-3.5 already speaks about 200. */
export const cloudVoiceSpeed = (model: string) => (model.startsWith('simba-3.2') ? 1.2 : 1);
/** The Starter plan's 1.9M characters a month; simba-3.5 counts each one twice
 *  from 21 Nov 2026. */
export const cloudVoiceChars = (model: string) => (model.startsWith('simba-3.5') ? 950_000 : 1_900_000);

/** Who else may do a server action: Discord user or role IDs. */
const allowList = z.array(snowflake).max(50).default([]);
/** True for addresses that never leave the home network. */
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}
/** Helix's dashboard address: the token goes with every request, so plain
 *  http only to an address on the home network, and nothing but the origin. */
const helixUrl = z
  .string()
  .url()
  .refine((u) => {
    if (!URL.canParse(u)) return false;
    const x = new URL(u);
    return (x.protocol === 'https:' || (x.protocol === 'http:' && privateHost(x.hostname))) && !x.username && !x.password && !x.search && !x.hash && (x.pathname === '/' || x.pathname === '');
  }, 'must be the Helix dashboard address, like http://192.168.1.50:3100 (https, or http on your own network; no path)');

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
  /** Text chat: answer when @mentioned or replied to in a server, and in DMs. */
  textChat: z
    .object({
      enabled: z.boolean().default(true),
      dms: z.boolean().default(true),
      maxReplyChars: z.number().int().min(200).max(6000).default(1800),
      /** With the Message Content intent on: read channels for context and carry on conversations without an @. */
      readChannels: z.boolean().default(true),
      /** Earlier messages read as context for each answer. */
      historyMessages: z.number().int().min(0).max(100).default(30),
      /** Minutes after an answer that people can keep talking to it without an @. */
      followUpMinutes: z.number().min(0).max(30).default(3),
      /** Most people one text reply may ping (only when asked). 0: never. */
      maxPings: z.number().int().min(0).max(20).default(5),
    })
    .default({ enabled: true, dms: true, maxReplyChars: 1800, readChannels: true, historyMessages: 30, followUpMinutes: 3, maxPings: 5 }),
  /** server_info: the server, members, channels, roles, who's in voice. members/presences
   *  use the Server Members and Presence intents when they're switched on in the Developer Portal. */
  serverInfo: z
    .object({ enabled: z.boolean().default(true), members: z.boolean().default(true), presences: z.boolean().default(true) })
    .default({ enabled: true, members: true, presences: true }),
  /** A more accurate second listen (Whisper large v3 turbo on Groq) for speech
   *  meant for her; the local model still does all the listening. */
  cloudStt: z
    .object({
      enabled: z.boolean().default(false),
      apiKeySecret: keyName('llm').default('GROQ_API_KEY'),
      model: z.string().min(1).default('whisper-large-v3-turbo'),
      /** pc: PCs, and anyone in the call with a PC connected; all: everyone in the call too. */
      rooms: z.enum(['pc', 'all']).default('pc'),
      /** Longest wait before using the local transcript instead. */
      timeoutMs: z.number().int().min(300).max(5000).default(1500),
    })
    .default({ enabled: false, apiKeySecret: 'GROQ_API_KEY', model: 'whisper-large-v3-turbo', rooms: 'pc', timeoutMs: 1500 }),
  /** PC satellites (docs/satellite.md): a WebSocket for paired PCs. Use it on a private network or behind TLS. */
  satellite: z
    .object({
      enabled: z.boolean().default(false),
      bind: z.string().default('0.0.0.0'),
      port: z.number().int().min(1024).max(65535).default(8791),
      /** Log what PCs hear and what she answers (for fixing misunderstandings). Off by default. */
      logTranscripts: z.boolean().default(false),
      /** Keep recordings of requests made at a PC (not side talk) for this many days, for testing speech-to-text. 0 = off. */
      recordDays: z.number().int().min(0).max(14).default(0),
      /** At a PC, when a pause sounds mid-sentence (Smart Turn), wait this much longer before answering, ms. 0 = off. */
      unfinishedWaitMs: z.number().int().min(0).max(3000).default(1200),
      /** While the PC app says its owner is in a game: her name for every turn there, short answers, reminders kept for after. */
      quietWhileGaming: z.boolean().default(true),
    })
    .default({ enabled: false, bind: '0.0.0.0', port: 8791, logTranscripts: false, recordDays: 0, unfinishedWaitMs: 1200, quietWhileGaming: true }),
  /** message_member: passing messages on by DM or an @mention in a channel. */
  messaging: z
    .object({
      enabled: z.boolean().default(true),
      perUserPerHour: z.number().int().min(1).max(100).default(10),
      perTargetPerHour: z.number().int().min(1).max(100).default(5),
      maxChars: z.number().int().min(50).max(1500).default(600),
    })
    .default({ enabled: true, perUserPerHour: 10, perTargetPerHour: 5, maxChars: 600 }),
  /** Between a PC and Discord: "send that link to my PC", "move the music to my PC", "tell the call I'll be on in 5". */
  handoff: z
    .object({
      enabled: z.boolean().default(true),
      /** How long links and songs count as "that", minutes. */
      keepMinutes: z.number().int().min(5).max(120).default(30),
      tellCall: z
        .object({
          enabled: z.boolean().default(true),
          /** Most messages per person per window. */
          max: z.number().int().min(1).max(10).default(3),
          windowMinutes: z.number().int().min(1).max(60).default(5),
          maxChars: z.number().int().min(50).max(500).default(200),
          /** Text channel for when nobody's in a call with her. Unset: the one she last wrote in, else the voice channel's chat. */
          channelId: snowflake.optional(),
        })
        .default({ enabled: true, max: 3, windowMinutes: 5, maxChars: 200 }),
    })
    .default({ enabled: true, keepMinutes: 30, tellCall: { enabled: true, max: 3, windowMinutes: 5, maxChars: 200 } }),
  /** Game nights: who's free or playing, and pings for the people who signed up. */
  gameNight: z
    .object({
      enabled: z.boolean().default(true),
      /** Where pings go. Unset: the chat it's asked from, else the one she last wrote in, else the voice channel's chat. */
      channelId: snowflake.optional(),
      /** Always signed up for every game (until they say "stop pinging me"). */
      optIn: z.array(snowflake).max(100).default([]),
      /** Minutes between pings for the same game. */
      cooldownMinutes: z.number().int().min(1).max(240).default(15),
      /** Most people one ping mentions. */
      maxMentions: z.number().int().min(1).max(10).default(10),
      /** Pings one person may send per hour. */
      perUserPerHour: z.number().int().min(1).max(20).default(4),
    })
    .default({ enabled: true, optIn: [], cooldownMinutes: 15, maxMentions: 10, perUserPerHour: 4 }),
  /** Who the bot is: female (she/her), male (he/him) or none (doesn't say). */
  botGender: z.enum(['female', 'male', 'none']).default('none'),
  /** What to call particular people, by Discord user ID: {"123…": "Big Mike"}. */
  nicknames: z.record(snowflake, z.string().min(1).max(40)).default({}),
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
  /** Game servers A.D.R.I.A.N. may check (status ping), and with `helix`
   *  set and the server linked, start, stop, restart, whitelist and message. */
  gameServers: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        kind: z.literal('minecraft').default('minecraft'),
        /** The same server in Helix (its Advanced tab shows the ID). */
        helix: z
          .object({
            instanceId: z.string().regex(/^[a-z][a-z0-9]{0,15}:[A-Za-z0-9._-]{1,128}$/, 'must be the exact Helix server ID, like helix:0b9a6c7e-...'),
            /** Geyser and Floodgate let Bedrock players join. */
            bedrock: z.boolean().default(false),
            /** Floodgate's username-prefix: Bedrock names start with it in game. */
            bedrockPrefix: z.string().regex(/^[^\sA-Za-z0-9§]{0,3}$/, 'must be up to 3 symbols, like "."').default('.'),
          })
          .optional(),
      }),
    )
    .max(20)
    .default([]),
  /** Steam (read-only): friends online, wishlist sales, store prices. Friends need STEAM_API_KEY. */
  steam: z
    .object({
      enabled: z.boolean().default(true),
      /** Discord user ID → that person's SteamID64 (in quotes), profile link or custom profile name. */
      accounts: z
        .record(snowflake, z.string({ error: 'must be a SteamID64 in quotes, a steamcommunity.com profile link, or a profile name' }).refine((v) => parseSteamAccount(v) !== undefined, 'must be a SteamID64 (17 digits starting 7656119), a steamcommunity.com profile link, or a profile name'))
        .refine((r) => Object.keys(r).length <= 50, 'at most 50 accounts')
        .default({}),
      /** Store country (two letters); prices come in its currency. */
      country: z.string().regex(/^[A-Za-z]{2}$/, 'must be a two-letter country code').transform((c) => c.toUpperCase()).default('US'),
      /** Let members ask about each other's Steam (only members with an account linked). */
      shareWithServer: z.boolean().default(false),
    })
    .default({ enabled: true, accounts: {}, country: 'US', shareWithServer: false }),
  /** Server control through Helix's automation API. The token is the
   *  HELIX_TOKEN key. Owners may do everything; `allow` adds Discord user or
   *  role IDs per action. */
  helix: z
    .object({
      url: helixUrl,
      allow: z
        .object({ start: allowList, stop: allowList, restart: allowList, whitelist: allowList, say: allowList })
        .default({ start: [], stop: [], restart: [], whitelist: [], say: [] }),
      /** Longest wait for a start or restart to finish (Helix itself gives up after 6 minutes, 20 for modpacks). */
      startWaitSec: z.number().int().min(30).max(1500).default(420),
      /** Longest wait for a stop (it saves the world first). */
      stopWaitSec: z.number().int().min(15).max(900).default(180),
      /** Longest in-game chat message. */
      sayMaxChars: z.number().int().min(10).max(256).default(200),
    })
    .optional(),
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
      /** Artist requests shuffle the artist's top songs (ranked by Deezer's free public API).
       *  Deezer gets the artist's name, and X from a plain "play X", to find out whether it's an artist. */
      topSongs: z.boolean().default(true),
    })
    .default({ enabled: true, ffmpeg: 'ffmpeg', plexBackup: true, volume: 0.5, duckLevel: 0.2, maxQueue: 25, autoplay: true, topSongs: true }),
  /** Cloud voice for English replies; the local voice stays as fallback. */
  cloudVoice: z
    .object({
      enabled: z.boolean().default(true),
      provider: z.literal('speechify').default('speechify'),
      voiceId: z.string().min(1).default('sabrina'),
      model: z.string().min(1).default('simba-3.5'),
      apiKeySecret: keyName('voice').default('SPEECHIFY_API_KEY'),
      /** Characters per month before switching to the local voice (0 = unlimited).
       *  Unset: what the Starter plan covers for the model. */
      monthlyChars: z.number().int().min(0).optional(),
      timeoutMs: z.number().int().min(500).max(15_000).default(4000),
      /** Speaking rate on top of voice.speed. Unset: the model's own pace, except
       *  simba-3.2, whose 133 words a minute is slow for a conversation. */
      speed: z.number().min(0.75).max(1.5).optional(),
    })
    .transform((v) => ({ ...v, speed: v.speed ?? cloudVoiceSpeed(v.model), monthlyChars: v.monthlyChars ?? cloudVoiceChars(v.model) }))
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
