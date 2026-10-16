// What the admin UI may change in the config, and how. File paths (models,
// secrets, usage file) belong to the installer and can't be set from the
// browser; the UI picks providers from presets or gives a custom
// OpenAI-compatible endpoint.

import { join } from 'node:path';
import { z } from 'zod';
import { KOKORO_VOICES } from '../speech/voices.js';
import { keyName } from '../config.js';
import { LLM_PRESETS, MODEL_LAYOUT } from './checks.js';

const snowflake = z.string().regex(/^\d{17,20}$/);

export const CustomLlmSchema = z.object({
  preset: z.literal('custom'),
  baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'http(s) only'),
  model: z.string().min(1).max(200),
  // Only a language-model key: never the bot token or another service's key.
  keySecret: keyName('llm'),
  priceInPerM: z.number().min(0).max(1000),
  priceOutPerM: z.number().min(0).max(1000),
});

const llmChoice = z.discriminatedUnion('preset', [
  z.object({ preset: z.enum(LLM_PRESETS.map((p) => p.id) as [string, ...string[]]) }),
  CustomLlmSchema,
]);

export const SettingsPatchSchema = z
  .object({
    guildId: snowflake,
    channelId: snowflake,
    timezone: z.string().min(1).max(64).refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'unknown time zone'),
    priorityRoleIds: z.array(snowflake).max(20),
    playbackVolume: z.number().min(0.1).max(1),
    voice: z.object({ voice: z.enum(KOKORO_VOICES), speed: z.number().min(0.7).max(1.4) }),
    limits: z.object({
      perUserPerHour: z.number().int().min(0).max(1000),
      dailyUsd: z.number().min(0).max(1000),
      monthlyUsd: z.number().min(0).max(10_000),
      maxRequestChars: z.number().int().min(20).max(4000),
    }),
    llm: llmChoice,
    fallback: z.union([llmChoice, z.object({ preset: z.literal('none') })]),
    search: z.boolean(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export interface InstallPaths {
  secretsFile: string;
  stateDir: string;
  modelsDir: string;
}

type Raw = Record<string, unknown>;
type Llm = z.infer<typeof llmChoice>;

function brainFor(c: Llm): Raw {
  if (c.preset === 'custom') {
    const x = c as Extract<Llm, { preset: 'custom' }>;
    return { baseUrl: x.baseUrl, model: x.model, apiKeySecret: x.keySecret, priceInPerM: x.priceInPerM, priceOutPerM: x.priceOutPerM, preset: 'custom' };
  }
  const p = LLM_PRESETS.find((q) => q.id === c.preset)!;
  return {
    preset: p.id,
    provider: p.provider ?? 'openai',
    ...(p.effort ? { effort: p.effort } : {}),
    baseUrl: p.baseUrl,
    model: p.model,
    apiKeySecret: p.keySecret,
    ...(p.extraBody ? { extraBody: p.extraBody } : {}),
    priceInPerM: p.priceInPerM,
    ...(p.priceCachedInPerM !== undefined ? { priceCachedInPerM: p.priceCachedInPerM } : {}),
    priceOutPerM: p.priceOutPerM,
  };
}

/** The installer-owned parts every config has. */
export function baseConfig(paths: InstallPaths, raw: Raw): Raw {
  const m = paths.modelsDir;
  const listen = (raw.listen as Raw | undefined) ?? {};
  const voice = (raw.voice as Raw | undefined) ?? {};
  const limits = (raw.limits as Raw | undefined) ?? {};
  return {
    ...raw,
    secretsFile: paths.secretsFile,
    listen: { ...listen, vadModel: join(m, MODEL_LAYOUT.vad), asrModelDir: join(m, MODEL_LAYOUT.asr) },
    voice: { voice: 'af_heart', speed: 1, ...voice, modelDir: join(m, MODEL_LAYOUT.tts) },
    limits: { ...limits, usageFile: join(paths.stateDir, 'usage.json') },
  };
}

/** Apply a validated patch to the raw config. */
export function applySettings(raw: Raw, patch: SettingsPatch, paths: InstallPaths): Raw {
  const out: Raw = baseConfig(paths, raw);
  for (const k of ['guildId', 'channelId', 'timezone', 'priorityRoleIds', 'playbackVolume'] as const) {
    if (patch[k] !== undefined) out[k] = patch[k];
  }
  if (patch.voice) out.voice = { ...(out.voice as Raw), ...patch.voice };
  if (patch.limits) out.limits = { ...(out.limits as Raw), ...patch.limits };
  const brain = { ...((out.brain as Raw | undefined) ?? {}) };
  if (patch.llm) {
    const keep = { search: brain.search, fallback: brain.fallback };
    Object.keys(brain).forEach((k) => delete brain[k]);
    Object.assign(brain, brainFor(patch.llm), keep);
  }
  if (patch.fallback) {
    if (patch.fallback.preset === 'none') delete brain.fallback;
    else {
      const b = brainFor(patch.fallback as Llm);
      brain.fallback = { preset: b.preset, provider: b.provider, ...(b.effort ? { effort: b.effort } : {}), baseUrl: b.baseUrl, model: b.model, apiKeySecret: b.apiKeySecret, ...(b.extraBody ? { extraBody: b.extraBody } : {}) };
    }
  }
  if (patch.search !== undefined) {
    if (patch.search) brain.search = { apiKeySecret: 'TAVILY_API_KEY', maxResults: 4 };
    else delete brain.search;
  }
  if (Object.keys(brain).some((k) => brain[k] !== undefined)) {
    for (const k of Object.keys(brain)) if (brain[k] === undefined) delete brain[k];
    out.brain = brain;
  }
  return out;
}

/** What the UI shows. The config holds no secret values, only names. */
export function settingsView(raw: Raw): Raw {
  const brain = raw.brain as Raw | undefined;
  const fb = brain?.fallback as Raw | undefined;
  const voice = raw.voice as Raw | undefined;
  return {
    guildId: raw.guildId ?? null,
    channelId: raw.channelId ?? null,
    timezone: raw.timezone ?? 'UTC',
    priorityRoleIds: raw.priorityRoleIds ?? [],
    playbackVolume: raw.playbackVolume ?? 0.7,
    voice: { voice: voice?.voice ?? 'af_heart', speed: voice?.speed ?? 1 },
    limits: { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10, maxRequestChars: 600, ...((raw.limits as Raw) ?? {}), usageFile: undefined },
    llm: brain
      ? { preset: brain.preset ?? 'custom', baseUrl: brain.baseUrl, model: brain.model, keySecret: brain.apiKeySecret, priceInPerM: brain.priceInPerM, priceOutPerM: brain.priceOutPerM }
      : null,
    fallback: fb ? { preset: fb.preset ?? 'custom', model: fb.model, keySecret: fb.apiKeySecret } : { preset: 'none' },
    search: !!brain?.search,
    server: raw.server ?? { host: '127.0.0.1', port: 8790 },
  };
}
