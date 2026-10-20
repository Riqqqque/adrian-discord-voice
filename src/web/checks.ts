// Checks behind the setup wizard and the dashboard's diagnostics. Each takes
// a fetch implementation so tests can run offline. Keys are sent only to the
// service they belong to and never appear in results or errors.

import { AnthropicLlm } from '../brain/anthropic.js';
import { existsSync, statfsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';

type Fetch = typeof fetch;

const DISCORD_API = 'https://discord.com/api/v10';
/** Connect, Speak, Use Voice Activity, View Channel (see docs/milestone-2.md). */
/** View Channel, Connect, Speak, Use Voice Activity, Send Messages, Send Messages in Threads, Read Message History. */
export const INVITE_PERMISSIONS = '274914675712';

export interface DiscordCheck {
  ok: boolean;
  error?: string;
  botTag?: string;
  appId?: string;
  publicBot?: boolean;
  inviteUrl?: string;
  guilds?: { id: string; name: string }[];
}

function short(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 160);
}

export async function checkDiscordToken(token: string, f: Fetch = fetch): Promise<DiscordCheck> {
  if (!/^[A-Za-z0-9._-]{50,100}$/.test(token)) return { ok: false, error: "That doesn't look like a bot token." };
  const get = async (path: string) => {
    const r = await f(`${DISCORD_API}${path}`, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8_000) });
    if (r.status === 401) throw new Error('Discord rejected the token (401). Reset it in the Developer Portal and paste the new one.');
    if (!r.ok) throw new Error(`Discord returned ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  };
  try {
    const me = await get('/users/@me');
    const app = await get('/oauth2/applications/@me');
    const guilds = (await get('/users/@me/guilds')) as unknown as { id: string; name: string }[];
    const appId = String(app.id);
    const disc = String(me.discriminator ?? '0');
    return {
      ok: true,
      botTag: disc && disc !== '0' ? `${me.username}#${disc}` : String(me.username),
      appId,
      publicBot: app.bot_public === true,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`,
      guilds: guilds.map((g) => ({ id: String(g.id), name: String(g.name) })),
    };
  } catch (e) {
    return { ok: false, error: short((e as Error).message) };
  }
}

export async function listVoiceChannels(token: string, guildId: string, f: Fetch = fetch): Promise<{ id: string; name: string }[]> {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('bad guild id');
  const r = await f(`${DISCORD_API}/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`Discord returned ${r.status}`);
  const all = (await r.json()) as { id: string; name: string; type: number; position?: number }[];
  return all
    .filter((c) => c.type === 2 || c.type === 13) // voice, stage
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: String(c.id), name: String(c.name) }));
}

export interface LlmPreset {
  id: string;
  label: string;
  /** anthropic: Claude through its own SDK; default: OpenAI-compatible. */
  provider?: 'openai' | 'anthropic';
  effort?: 'low' | 'medium' | 'high';
  baseUrl: string;
  model: string;
  keySecret: string;
  extraBody?: Record<string, unknown>;
  priceInPerM: number;
  priceCachedInPerM?: number;
  priceOutPerM: number;
  note: string;
}

/** Verified 2026-10-14/15 (docs/milestones-4-6.md). */
export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'claude',
    label: 'Claude Haiku 5.5 (Recommended)',
    provider: 'anthropic',
    effort: 'low',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-5-5',
    keySecret: 'ANTHROPIC_API_KEY',
    priceInPerM: 0.1,
    priceCachedInPerM: 0.01,
    priceOutPerM: 0.5,
    note: 'Best answers for the price; first words in about 1 second; uses tools (music, timers, search) reliably. Pay as you go with an Anthropic API key (a claude.ai subscription does not include API use).',
  },
  {
    id: 'groq',
    label: 'Groq gpt-oss-120b (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keySecret: 'GROQ_API_KEY',
    extraBody: { reasoning_effort: 'medium', include_reasoning: false },
    priceInPerM: 0.15,
    priceOutPerM: 0.6,
    note: 'Fast first token (about 0.3 s). Free tier: 8,000 tokens per minute.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini 3.1 Flash-Lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.1-flash-lite',
    keySecret: 'GEMINI_API_KEY',
    extraBody: { reasoning_effort: 'none' },
    priceInPerM: 0.25,
    priceCachedInPerM: 0.025,
    priceOutPerM: 1.5,
    note: 'Good fallback. Free tier is slow and rate-limited; on the free tier Google may use prompts to improve its products.',
  },
];

export interface LlmCheck {
  ok: boolean;
  error?: string;
  firstTokenMs?: number;
  totalMs?: number;
  reply?: string;
  estCostPerAnswerUsd?: number;
}

export async function checkLlm(
  p: { provider?: 'openai' | 'anthropic'; baseUrl: string; model: string; key?: string; extraBody?: Record<string, unknown>; priceInPerM: number; priceOutPerM: number },
  f: Fetch = fetch,
): Promise<LlmCheck> {
  const t0 = performance.now();
  // A typical spoken answer: about 900 tokens in (prompt + history), 60 out.
  const est = Number(((900 * p.priceInPerM + 60 * p.priceOutPerM) / 1e6).toFixed(6));
  if (p.provider === 'anthropic') {
    try {
      const llm = new AnthropicLlm({ model: p.model, apiKey: p.key ?? '', effort: 'low' });
      let reply = '';
      let firstTokenMs: number | undefined;
      for await (const ev of llm.stream([{ role: 'user', content: 'Reply with one short sentence: what is two plus two?' }], { maxTokens: 60, signal: AbortSignal.timeout(15_000) })) {
        if (ev.type !== 'text') continue;
        firstTokenMs ??= Math.round(performance.now() - t0);
        reply += ev.delta;
      }
      reply = reply.trim();
      return { ok: !!reply, ...(reply ? {} : { error: 'Empty reply.' }), ...(firstTokenMs ? { firstTokenMs } : {}), totalMs: Math.round(performance.now() - t0), reply: reply.slice(0, 200), estCostPerAnswerUsd: est };
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 401 || status === 403) return { ok: false, error: `The provider rejected the key (${status}).` };
      if (status === 429) return { ok: false, error: 'The provider is rate-limiting this key (429). Try again in a minute.' };
      return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'No answer within 15 seconds.' : 'Could not reach the provider.' };
    }
  }
  try {
    const r = await f(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'Reply with one short sentence: what is two plus two?' }],
        max_tokens: 60,
        ...p.extraBody,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const firstTokenMs = Math.round(performance.now() - t0);
    if (r.status === 401 || r.status === 403) return { ok: false, error: `The provider rejected the key (${r.status}).` };
    if (r.status === 429) return { ok: false, error: 'The provider is rate-limiting this key (429). Try again in a minute.' };
    if (!r.ok) return { ok: false, error: `The provider returned ${r.status}.` };
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = j.choices?.[0]?.message?.content?.trim() ?? '';
    return { ok: !!reply, ...(reply ? {} : { error: 'Empty reply.' }), firstTokenMs, totalMs: Math.round(performance.now() - t0), reply: reply.slice(0, 200), estCostPerAnswerUsd: est };
  } catch (e) {
    return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'No answer within 15 seconds.' : 'Could not reach the provider.' };
  }
}

export async function checkTavily(key: string, f: Fetch = fetch): Promise<{ ok: boolean; error?: string; ms?: number; results?: number }> {
  const t0 = performance.now();
  try {
    const r = await f('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: 'weather', max_results: 1, include_answer: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Tavily rejected the key.' };
    if (!r.ok) return { ok: false, error: `Tavily returned ${r.status}.` };
    const j = (await r.json()) as { results?: unknown[] };
    return { ok: true, ms: Math.round(performance.now() - t0), results: j.results?.length ?? 0 };
  } catch {
    return { ok: false, error: 'Could not reach Tavily.' };
  }
}

/** Model files the installer places under <models>. */
export const MODEL_LAYOUT = {
  vad: 'silero_vad.onnx',
  asr: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  tts: 'kokoro-multi-lang-v1_0',
  whisper: 'sherpa-onnx-whisper-small',
  piperVi: 'vits-piper-vi_VN-vais1000-medium',
  ytdlp: 'yt-dlp_linux',
} as const;

export interface HardwareCheck {
  cpuModel: string;
  cpuThreads: number;
  memTotalGiB: number;
  memFreeGiB: number;
  diskFreeGiB: number | null;
  node: string;
  models: { vad: boolean; asr: boolean; tts: boolean; whisper: boolean; piperVi: boolean };
  warnings: string[];
}

export function checkHardware(modelsDir: string, stateDir: string): HardwareCheck {
  const c = cpus();
  const gib = (b: number) => Number((b / 2 ** 30).toFixed(1));
  let disk: number | null = null;
  try {
    const s = statfsSync(stateDir);
    disk = gib(s.bavail * s.bsize);
  } catch {
    /* unknown */
  }
  const models = {
    vad: existsSync(join(modelsDir, MODEL_LAYOUT.vad)),
    asr: existsSync(join(modelsDir, MODEL_LAYOUT.asr, 'encoder.int8.onnx')),
    tts: existsSync(join(modelsDir, MODEL_LAYOUT.tts, 'model.onnx')),
    whisper: existsSync(join(modelsDir, MODEL_LAYOUT.whisper, 'small-encoder.int8.onnx')),
    piperVi: existsSync(join(modelsDir, MODEL_LAYOUT.piperVi, 'vi_VN-vais1000-medium.onnx')),
  };
  const warnings: string[] = [];
  if (c.length < 4) warnings.push('Fewer than 4 CPU threads: speech recognition and voice will be slow.');
  if (totalmem() < 4 * 2 ** 30) warnings.push('Less than 4 GiB of memory: the speech models need about 2 GiB.');
  if (disk !== null && disk < 2) warnings.push('Less than 2 GiB of free disk.');
  if (!models.vad || !models.asr || !models.tts) warnings.push('Some speech models are missing. Run `sudo adrian doctor`.');
  return {
    cpuModel: c[0]?.model.trim() ?? 'unknown',
    cpuThreads: c.length,
    memTotalGiB: gib(totalmem()),
    memFreeGiB: gib(freemem()),
    diskFreeGiB: disk,
    node: process.version,
    models,
    warnings,
  };
}
