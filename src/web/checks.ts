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
  /** The privileged intents switched on in the Developer Portal. All optional. */
  intents?: { messageContent: boolean; members: boolean; presences: boolean };
}

function short(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 160);
}

/** The pasted token as Discord wants it: no "Bot " in front, no quotes, no spaces. */
export function cleanToken(raw: string): string {
  return raw
    .trim()
    .replace(/^(['"`])(.*)\1$/, '$2')
    .replace(/^Bot\s+/i, '')
    .trim();
}

/** Why a pasted value isn't a bot token, naming what it probably is instead. */
export function tokenShapeProblem(token: string): string | undefined {
  const where = 'The token is in the Developer Portal under Bot: press Reset Token and copy what it shows (a long text with two dots in it).';
  if (!token) return 'Paste the bot token first.';
  if (/^\d{17,20}$/.test(token)) return `That's a number, probably the Application ID. ${where}`;
  if (/^[a-f0-9]{64}$/i.test(token)) return `That looks like the Public Key from General Information. ${where}`;
  if (/^[A-Za-z0-9_-]{32}$/.test(token)) return `That looks like the Client Secret from the OAuth2 page. ${where}`;
  if (!/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(token) || token.length > 100) return `That doesn't look like a bot token. ${where}`;
  return undefined;
}

/** Plain words for a request to Discord that never got an answer. */
function unreachable(e: unknown, what = 'Discord'): string {
  if ((e as Error).name === 'TimeoutError') return `${what} did not answer within 8 seconds. Try again; if it keeps happening, check this server's internet connection.`;
  return `Could not reach ${what} from this server. Check that it is online and can look up names (DNS), and that no firewall blocks outgoing HTTPS.`;
}

class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function discordGet(token: string, f: Fetch) {
  return async (path: string) => {
    let r: Response;
    try {
      r = await f(`${DISCORD_API}${path}`, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8_000) });
    } catch (e) {
      throw new DiscordHttpError(0, unreachable(e));
    }
    if (r.status === 401) throw new DiscordHttpError(401, 'Discord rejected the token (401). Reset it in the Developer Portal and paste the new one.');
    if (r.status === 429) throw new DiscordHttpError(429, 'Discord is rate limiting this bot right now (429). Wait a minute and try again.');
    if (r.status >= 500) throw new DiscordHttpError(r.status, `Discord is having trouble (${r.status}). Try again in a few minutes.`);
    if (!r.ok) throw new DiscordHttpError(r.status, `Discord returned ${r.status}`);
    return r.json() as Promise<Record<string, unknown>>;
  };
}

// Application flags: each privileged intent has a "verified" and a "limited" bit.
const INTENT_FLAGS = { presences: (1 << 12) | (1 << 13), members: (1 << 14) | (1 << 15), messageContent: (1 << 18) | (1 << 19) };

export async function checkDiscordToken(raw: string, f: Fetch = fetch): Promise<DiscordCheck> {
  const token = cleanToken(raw);
  const shape = tokenShapeProblem(token);
  if (shape) return { ok: false, error: shape };
  const get = discordGet(token, f);
  try {
    const me = await get('/users/@me');
    const app = await get('/oauth2/applications/@me');
    const guilds = (await get('/users/@me/guilds')) as unknown as { id: string; name: string }[];
    const appId = String(app.id);
    const disc = String(me.discriminator ?? '0');
    const flags = typeof app.flags === 'number' ? app.flags : 0;
    return {
      ok: true,
      botTag: disc && disc !== '0' ? `${me.username}#${disc}` : String(me.username),
      appId,
      publicBot: app.bot_public === true,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`,
      guilds: guilds.map((g) => ({ id: String(g.id), name: String(g.name) })),
      intents: {
        messageContent: (flags & INTENT_FLAGS.messageContent) !== 0,
        members: (flags & INTENT_FLAGS.members) !== 0,
        presences: (flags & INTENT_FLAGS.presences) !== 0,
      },
    };
  } catch (e) {
    return { ok: false, error: short((e as Error).message) };
  }
}

/** Channel permission bits the bot needs to be heard (see Discord's permission docs). */
const NEEDS = [
  ['View Channel', 1n << 10n],
  ['Connect', 1n << 20n],
  ['Speak', 1n << 21n],
] as const;
const ADMINISTRATOR = 1n << 3n;

export interface VoiceAccess {
  ok: boolean;
  /** Permissions the bot lacks in that channel. */
  missing?: string[];
  channel?: string;
  /** In words: what's wrong and where to change it. */
  error?: string;
}

/** The bot's own permissions in one voice channel, worked out the way Discord
 *  does: server roles, then the channel's overwrites for everyone, its roles
 *  and itself. Finds a missing Connect or Speak before a join silently fails. */
export async function checkVoiceAccess(token: string, guildId: string, channelId: string, f: Fetch = fetch): Promise<VoiceAccess> {
  if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId)) return { ok: false, error: 'Choose a server and a voice channel first.' };
  const get = discordGet(token, f);
  try {
    const me = await get('/users/@me');
    const botId = String(me.id);
    let guild: Record<string, unknown>;
    let member: Record<string, unknown>;
    try {
      guild = await get(`/guilds/${guildId}`);
      member = await get(`/guilds/${guildId}/members/${botId}`);
    } catch (e) {
      if (e instanceof DiscordHttpError && (e.status === 403 || e.status === 404)) {
        return { ok: false, error: "The bot isn't in that server (anymore). Open the invite link to add it, then try again." };
      }
      throw e;
    }
    let channel: Record<string, unknown>;
    try {
      channel = await get(`/channels/${channelId}`);
    } catch (e) {
      if (e instanceof DiscordHttpError && (e.status === 403 || e.status === 404)) {
        return { ok: false, missing: ['View Channel'], error: "The bot can't see that voice channel. In Discord, open the channel's settings, then Permissions, and allow the bot (or its role) View Channel, Connect and Speak." };
      }
      throw e;
    }
    const name = String(channel.name ?? 'that channel');
    const roles = (guild.roles as { id: string; permissions: string }[] | undefined) ?? [];
    const mine = new Set(((member.roles as string[] | undefined) ?? []).map(String));
    const perm = (s: unknown) => {
      try {
        return BigInt(String(s ?? '0'));
      } catch {
        return 0n;
      }
    };
    let p = 0n;
    if (String(guild.owner_id) === botId) p = ~0n;
    for (const r of roles) if (r.id === guildId || mine.has(r.id)) p |= perm(r.permissions);
    if (!(p & ADMINISTRATOR)) {
      const ow = (channel.permission_overwrites as { id: string; type: number; allow: string; deny: string }[] | undefined) ?? [];
      const everyone = ow.find((o) => o.id === guildId);
      if (everyone) p = (p & ~perm(everyone.deny)) | perm(everyone.allow);
      let deny = 0n;
      let allow = 0n;
      for (const o of ow) if (o.type === 0 && mine.has(o.id)) (deny |= perm(o.deny)), (allow |= perm(o.allow));
      p = (p & ~deny) | allow;
      const self = ow.find((o) => o.type === 1 && o.id === botId);
      if (self) p = (p & ~perm(self.deny)) | perm(self.allow);
    } else {
      p = ~0n;
    }
    const missing = NEEDS.filter(([, bit]) => !(p & bit)).map(([n]) => n);
    if (!missing.length) return { ok: true, missing: [], channel: name };
    const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
    return {
      ok: false,
      missing,
      channel: name,
      error: `The bot can't ${list} in ${name}, so it can't be heard there. In Discord, open that channel's settings, then Permissions, add the bot (or its role), and allow View Channel, Connect and Speak.`,
    };
  } catch (e) {
    return { ok: false, error: short((e as Error).message) };
  }
}

export async function listVoiceChannels(token: string, guildId: string, f: Fetch = fetch): Promise<{ id: string; name: string }[]> {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('bad guild id');
  let r: Response;
  try {
    r = await f(`${DISCORD_API}/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8_000) });
  } catch (e) {
    throw new Error(unreachable(e));
  }
  if (r.status === 403 || r.status === 404) throw new Error("The bot isn't in that server (anymore). Open the invite link to add it, then press I added it, refresh.");
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
      if (status) return { ok: false, error: llmError(status, (e as Error).message, p.model) };
      return { ok: false, error: noAnswer(e) };
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
    if (!r.ok) return { ok: false, error: llmError(r.status, await r.text().catch(() => ''), p.model) };
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = j.choices?.[0]?.message?.content?.trim() ?? '';
    return { ok: !!reply, ...(reply ? {} : { error: 'Empty reply.' }), firstTokenMs, totalMs: Math.round(performance.now() - t0), reply: reply.slice(0, 200), estCostPerAnswerUsd: est };
  } catch (e) {
    return { ok: false, error: noAnswer(e) };
  }
}

function noAnswer(e: unknown): string {
  return (e as Error).name === 'TimeoutError'
    ? 'No answer within 15 seconds. Try again; if it keeps happening, the provider may be overloaded, so choose another one.'
    : "Could not reach the provider from this server. Check that it is online and can look up names (DNS); a local model's server must be running.";
}

/** What a provider's error answer means, in words, with what to do. `detail`
 *  is the provider's own message (never shown whole: it may echo the request). */
export function llmError(status: number, detail: string, model: string): string {
  const d = detail.toLowerCase();
  const money = /credit balance|insufficient[_ ]quota|billing|payment|exceeded your current quota|out of credits/.test(d);
  if (money || status === 402) {
    return "The account behind this key has no credit left. Add some on the provider's billing page (for Claude: console.anthropic.com, Plans & Billing; a claude.ai subscription doesn't include API use), or choose Groq, which has a free tier.";
  }
  if (status === 401 || status === 403) return `The provider rejected the key (${status}). Copy it again in full, and check it hasn't been deleted or limited to other models.`;
  if (status === 429) return 'The provider is rate-limiting this key (429). Wait a minute and press Test again; on a free tier, the limit per minute is low.';
  if (status === 404 || /model.{0,40}(not[_ ]found|does not exist|not available|unknown)/.test(d)) {
    return `The provider doesn't offer the model ${model.slice(0, 60)} to this key (${status}). Choose another provider, or check the model name.`;
  }
  if (status >= 500) return `The provider is having trouble right now (${status}). Try again in a few minutes, or choose another provider.`;
  return `The provider returned ${status}.`;
}

const KEY_SHAPES: { test: RegExp; preset: string; name: string; prefix: string }[] = [
  { test: /^sk-ant-/, preset: 'claude', name: 'an Anthropic (Claude)', prefix: 'sk-ant-' },
  { test: /^gsk_/, preset: 'groq', name: 'a Groq', prefix: 'gsk_' },
  { test: /^AIza/, preset: 'gemini', name: 'a Google Gemini', prefix: 'AIza' },
  { test: /^tvly-/, preset: 'search', name: 'a Tavily (web search)', prefix: 'tvly-' },
];

/** A pasted key that is plainly another service's (from its prefix): say so
 *  before sending it anywhere. Unknown shapes pass: a provider may change them. */
export function keyMismatch(presetId: string, key: string): string | undefined {
  const is = KEY_SHAPES.find((k) => k.test.test(key));
  if (!is || is.preset === presetId) return undefined;
  const want = KEY_SHAPES.find((k) => k.preset === presetId);
  const chosen = want ? want.name.replace(/^an? /, '') : 'this provider';
  const hint = want ? ` (it starts with ${want.prefix})` : '';
  return `That looks like ${is.name} key, but ${chosen} is chosen. Choose the matching provider, or paste ${want ? want.name : 'its'} key${hint}.`;
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
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Tavily rejected the key. Copy it again from app.tavily.com, or turn search off: everything else works without it.' };
    if (r.status === 429 || r.status === 432) return { ok: false, error: "This Tavily key has used up its searches for now. Wait, upgrade the plan, or turn search off: everything else works without it." };
    if (!r.ok) return { ok: false, error: `Tavily returned ${r.status}.` };
    const j = (await r.json()) as { results?: unknown[] };
    return { ok: true, ms: Math.round(performance.now() - t0), results: j.results?.length ?? 0 };
  } catch {
    return { ok: false, error: 'Could not reach Tavily from this server. Check its internet connection, or turn search off: everything else works without it.' };
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
  smartTurn: 'smart-turn-v3.2-cpu.onnx',
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
