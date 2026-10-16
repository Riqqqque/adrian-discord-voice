// The voice stack: wake → Parakeet → LLM (read-only tools, per-user memory)
// → Kokoro → Discord, streamed sentence by sentence, under the conversation
// controller's queue and interruption rules and the spend caps. Started by
// main.ts once the config is complete, and restarted by the admin UI.

import { Client, Events, GatewayIntentBits, type VoiceBasedChannel } from 'discord.js';
import { dateFormat } from '../core/time.js';
import { humansIn, registerVoiceCommands, type VoiceSpot } from './commands.js';
import prism from 'prism-media';
import { FallbackLlm } from '../brain/fallback.js';
import { ConversationOrchestrator, type Usage } from '../brain/orchestrator.js';
import { OpenAiCompatibleLlm } from '../brain/openai-compatible.js';
import { AnthropicLlm } from '../brain/anthropic.js';
import { SessionMemory } from '../brain/sessions.js';
import { cachedTool, tavilySearchTool, timeTool } from '../brain/tools.js';
import type { PocConfig } from '../config.js';
import { ConversationController } from '../conversation/controller.js';
import type { LlmProvider, Logger, Tool, UserId } from '../core/interfaces.js';
import { classify } from '../conversation/intents.js';
import { RoomTalk } from '../conversation/room.js';
import { matureContext } from '../brain/mature.js';
import { LIMIT_MESSAGES, UsageLedger } from '../limits/usage-ledger.js';
import { routeTools } from '../brain/tool-router.js';
import { PartyGames } from '../features/games.js';
import { AutoMemory } from '../features/automemory.js';
import { gameServerTool } from '../features/gameservers.js';
import { mediaTools } from '../features/media.js';
import { UserNotes } from '../features/notes.js';
import { dueMessage, Reminders } from '../features/reminders.js';
import { join } from 'node:path';
import { type HeardEvent, ListeningPipeline } from '../listen/pipeline.js';
import { EnglishWords, LANGS, looksSpanish, type ReplyLang, replyLang, stripWakeLead } from '../speech/language.js';
import { PiperTts, VoiceRouter } from '../speech/piper.js';
import { WhisperStt } from '../speech/whisper.js';
import { MODEL_LAYOUT } from '../web/checks.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { KokoroTts } from '../speech/kokoro.js';
import { CharBudget, SpeechifyTts } from '../speech/speechify.js';
import { Mixer } from '../voice/mixer.js';
import { eager } from '../core/eager.js';
import { creatorLines, memberLabel } from './identity.js';
import { describe as trackName, ffmpegDecoder, MusicPlayer, musicRules, musicState, musicTools, PlexMusicSource, type MusicSource, YoutubeSource } from '../features/music.js';
import { classifyMusic, isTimeQuestion } from '../conversation/intents.js';
import { ParakeetStt } from '../speech/sherpa.js';
import { DiscordVoiceTransport } from '../transport/discord.js';
import { Speaker } from '../voice/speaker.js';
import { TextWakeDetector } from '../wake/text-wake.js';

export interface AnswerRecord {
  at: string;
  outcome: string;
  sttLatencyMs: number | null;
  llmFirstChunkMs: number | null;
  ttsFirstMs: number | null;
  speechEndToAudioMs: number | null;
  costUsd: number;
}

export interface VoiceStack {
  readonly ledger: UsageLedger;
  voiceReady(): boolean;
  botTag(): string | undefined;
  /** Latest answers, newest last (no user IDs or text). */
  answers(): readonly AnswerRecord[];
  stop(): Promise<void>;
}

/** Throws if the config can't run (missing sections or token). */
export async function startVoiceStack(
  config: PocConfig,
  secrets: Map<string, string>,
  log: Logger,
  ledger: UsageLedger,
  models?: { sttFor(dir: string, threads: number): Promise<ParakeetStt>; ttsFor(dir: string, threads: number): KokoroTts },
  /** Where timers and notes are kept; in memory only if unset. */
  stateDir?: string,
): Promise<VoiceStack> {
  const listen = config.listen;
  const voice = config.voice;
  if (!listen || !voice) throw new Error('config needs "listen" and "voice" sections');
  const token = secrets.get('DISCORD_TOKEN');
  if (!token) throw new Error('DISCORD_TOKEN is not set');

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const transport = new DiscordVoiceTransport({ client, logger: log, silenceMs: config.silenceMs });
  let ready = false;
  /** The voice channel the bot is in (or joining); undefined after /leave. */
  let spot: VoiceSpot | undefined = { guildId: config.guildId, channelId: config.channelId };
  /** Who set the bot up (optional): '' when not configured. */
  const creator = config.identity.creator ?? '';
  transport.on('ready', () => (ready = true));
  transport.on('disconnected', (r) => {
    ready = false;
    log.warn('voice disconnected', { reason: r });
  });
  transport.on('moved', (guildId, channelId) => {
    if (spot?.guildId === guildId) spot = { guildId, channelId };
  });
  transport.on('failed', (r) => {
    ready = false;
    log.error('voice failed', { reason: r });
  });

  // --- speech ------------------------------------------------------------

  let t = performance.now();
  const stt = models
    ? await models.sttFor(listen.asrModelDir, listen.asrThreads)
    : await ParakeetStt.load({ modelDir: listen.asrModelDir, threads: listen.asrThreads });
  log.info('asr loaded', { ms: Math.round(performance.now() - t) });
  t = performance.now();
  const tts = models ? models.ttsFor(voice.modelDir, voice.threads) : new KokoroTts({ modelDir: voice.modelDir, threads: voice.threads });
  /** Where the extra language models live (next to the Kokoro model). */
  const langModels = dirname(voice.modelDir);
  const gainDb = await tts.gainFor(voice.voice, voice.speed);
  log.info('tts loaded and calibrated', { ms: Math.round(performance.now() - t), voice: voice.voice, gainDb: Number(gainDb.toFixed(2)) });
  const piperVi = existsSync(join(langModels, MODEL_LAYOUT.piperVi))
    ? new PiperTts({ modelDir: join(langModels, MODEL_LAYOUT.piperVi), modelFile: 'vi_VN-vais1000-medium.onnx', threads: voice.threads })
    : undefined;
  const cv = config.cloudVoice;
  const cloudKey = cv?.enabled ? secrets.get(cv.apiKeySecret) : undefined;
  if (cv?.enabled && !cloudKey) log.warn('cloud voice key missing; local voice only', { secret: cv.apiKeySecret });
  const voiceBudget = new CharBudget(stateDir ? join(stateDir, 'voice-usage.json') : undefined, cv?.monthlyChars ?? 0, config.timezone);
  const cloud =
    cv && cloudKey
      ? new SpeechifyTts({ apiKey: cloudKey, voiceId: cv.voiceId, model: cv.model, timeoutMs: cv.timeoutMs, budget: voiceBudget, log }, tts, voice.voice)
      : undefined;
  if (cloud) log.info('cloud voice', { provider: cv!.provider, voice: cv!.voiceId, usedChars: voiceBudget.used(), monthlyChars: cv!.monthlyChars });
  const CLOUD = 'cloud:en';
  /** Said before a slow lookup when nothing else has been said yet. */
  const FILLERS = ['One sec.', 'Let me check.', 'On it.'];
  let fillerTurn = 0;
  // Speech and music share Discord's one audio player through the mixer.
  const mc = config.music;
  const mixer = new Mixer({ start: (s) => transport.playPcm(s, { volume: 1 }), duckLevel: mc.duckLevel });
  const speaker = new Speaker(mixer, new VoiceRouter(tts, { ...(piperVi ? { vi_piper: piperVi } : {}), ...(cloud ? { [CLOUD]: cloud } : {}) }));

  // --- music --------------------------------------------------------------
  const ytdlp = mc.ytdlp ?? join(langModels, MODEL_LAYOUT.ytdlp);
  const musicSources: MusicSource[] = [];
  if (mc.enabled && existsSync(ytdlp)) musicSources.push(new YoutubeSource({ ytdlp, node: process.execPath }));
  const plexForMusic = secrets.get('PLEX_TOKEN');
  if (mc.enabled && mc.plexBackup && plexForMusic) musicSources.push(new PlexMusicSource({ url: config.media.plexUrl, token: plexForMusic }));
  const ffmpegOk = mc.enabled && spawnSync(mc.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
  const music = ffmpegOk && musicSources.length ? new MusicPlayer({ sources: musicSources, output: mixer, decode: ffmpegDecoder(mc.ffmpeg), log, volume: mc.volume, maxQueue: mc.maxQueue, autoplay: mc.autoplay }) : undefined;
  if (mc.enabled) log.info(music ? 'music ready' : 'music off', { sources: musicSources.map((s) => s.name), ffmpeg: ffmpegOk });

  // --- languages: Whisper re-reads non-English questions --------------------
  const english = new EnglishWords(join(voice.modelDir, 'lexicon-us-en.txt'));
  const whisperDir = join(langModels, MODEL_LAYOUT.whisper);
  let whisper: WhisperStt | undefined;
  if (config.languages && existsSync(join(whisperDir, 'small-encoder.int8.onnx'))) {
    // Loaded in the background so startup isn't slower.
    void WhisperStt.load({ modelDir: whisperDir, threads: listen.asrThreads })
      .then((w) => {
        whisper = w;
        log.info('whisper loaded', { languages: Object.keys(LANGS) });
        void (async () => {
          for (const l of ['es', 'zh', 'ja', 'vi'] as const) {
            const v = voiceFor(l);
            if (v === voice.voice) continue;
            await speaker.warm(v, voice.speed).catch((err: Error) => log.warn('voice warm-up failed', { voice: v, error: err.message }));
          }
          log.info('language voices ready');
        })();
      })
      .catch((e: Error) => log.warn('whisper failed to load; English only', { error: e.message }));
  }
  /** Language each person last spoke to the bot in. */
  const userLang = new Map<UserId, ReplyLang>();
  const voiceFor = (lang: ReplyLang) => (lang === 'en' ? (cloud ? CLOUD : voice.voice) : lang === 'vi' && !piperVi ? voice.voice : LANGS[lang].voice);
  // Native @discordjs/opus when its prebuild matches this glibc, else opusscript (WebAssembly).
  new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 }).destroy(); // loads the module
  log.info('opus', { module: prism.opus.Encoder.type });

  // --- timers, notes, games -----------------------------------------------

  const reminders = new Reminders(stateDir ? join(stateDir, 'reminders.json') : undefined, config.timezone, (r, lateMs) => {
    const text = dueMessage(r, lateMs);
    const ch = spot ? (client.channels.cache.get(spot.channelId) as VoiceBasedChannel | undefined) : undefined;
    log.info('reminder due', { user: r.userId, kind: r.kind, lateMs });
    if (ready && ch?.members.has(r.userId)) {
      controller.announce(r.userId, text);
    } else {
      // Not in the call with the bot: send it as a DM instead.
      void client.users
        .send(r.userId, text.replace(/^[^,]+, /, ''))
        .catch((e: Error) => log.warn('reminder DM failed', { user: r.userId, error: e.message }));
    }
  });
  const notes = new UserNotes(stateDir ? join(stateDir, 'notes.json') : undefined);
  const games = new PartyGames();
  const room = new RoomTalk();
  /** Who's in the voice call, so it can talk about and to everyone by name. */
  function rosterLines(channelId: string | undefined, askerId: string): string[] {
    const ch = channelId ? (client.channels.cache.get(channelId) as VoiceBasedChannel | undefined) : undefined;
    if (!ch) return [];
    const people = [...ch.members.values()]
      .filter((m) => !m.user.bot)
      .slice(0, 25)
      .map((m) => memberLabel(m.displayName, { creator, isCreator: isCreator(m.id), isAsker: m.id === askerId, creatorNames: config.identity.creatorHeardAs, ...(config.nicknames[m.id] ? { nickname: config.nicknames[m.id] } : {}) }));
    return people.length ? [`People in this voice call right now (${ch.name}): ${people.join(', ')}.`] : [];
  }
  const sessions = new SessionMemory(16, 60 * 60_000);
  /** Discord's age-restricted flag on the channel the bot is talking in. */
  const isAgeRestricted = (channelId?: string) =>
    !!channelId && (client.channels.cache.get(channelId) as { nsfw?: boolean } | undefined)?.nsfw === true;

  // --- brain -------------------------------------------------------------

  let orchestrator: ConversationOrchestrator | undefined;
  let autoMemory: AutoMemory | undefined;
  const brain = config.brain;
  if (brain) {
    const apiKey = brain.apiKeySecret ? secrets.get(brain.apiKeySecret) : undefined;
    if (brain.apiKeySecret && !apiKey) {
      log.warn('LLM key missing; answering with a setup notice', { secret: brain.apiKeySecret });
    } else {
      const tools: Tool[] = [timeTool(config.timezone)];
      const searchKey = brain.search ? secrets.get(brain.search.apiKeySecret) : undefined;
      if (searchKey) tools.push(tavilySearchTool(searchKey, brain.search?.maxResults));
      tools.push(...reminders.tools(), ...notes.tools(), ...games.tools());
      if (music) tools.push(...musicTools(music));
      // Read-only lookups are reused briefly: asking twice in a row doesn't wait again.
      if (config.gameServers.length) tools.push(cachedTool(gameServerTool(config.gameServers), 30_000));
      const m = config.media;
      const plexToken = secrets.get('PLEX_TOKEN');
      const sonarrKey = secrets.get('SONARR_API_KEY');
      const radarrKey = secrets.get('RADARR_API_KEY');
      tools.push(
        ...mediaTools({
          ...(plexToken ? { plex: { url: m.plexUrl, token: plexToken } } : {}),
          ...(sonarrKey ? { sonarr: { url: m.sonarrUrl, apiKey: sonarrKey } } : {}),
          ...(radarrKey ? { radarr: { url: m.radarrUrl, apiKey: radarrKey } } : {}),
          timezone: config.timezone,
        }).map((t) => cachedTool(t, 60_000)),
      );
      // Claude through its own SDK, anything else through the OpenAI-compatible adapter.
      const makeLlm = (p: { provider: 'openai' | 'anthropic'; baseUrl: string; model: string; effort: 'low' | 'medium' | 'high'; extraBody?: Record<string, unknown> | undefined }, key?: string): LlmProvider =>
        p.provider === 'anthropic'
          ? new AnthropicLlm({ model: p.model, apiKey: key ?? '', effort: p.effort })
          : new OpenAiCompatibleLlm({ baseUrl: p.baseUrl, model: p.model, ...(key ? { apiKey: key } : {}), ...(p.extraBody ? { extraBody: p.extraBody } : {}) });
      let llm: LlmProvider = makeLlm(brain, apiKey);
      const fb = brain.fallback;
      const fbKey = fb?.apiKeySecret ? secrets.get(fb.apiKeySecret) : undefined;
      const fbUsable = !!fb && (!fb.apiKeySecret || !!fbKey);
      if (fb && fbUsable) {
        llm = new FallbackLlm(
          llm,
          makeLlm(fb, fbKey),
          (err) => log.warn('primary LLM failed; using fallback', { error: err.message.slice(0, 200), fallback: fb.model }),
        );
      }
      if (config.autoMemory) {
        autoMemory = new AutoMemory(llm, notes, sessions, log, (inTok, outTok) =>
          ledger.addCost((inTok * brain.priceInPerM + outTok * brain.priceOutPerM) / 1e6),
        );
      }
      orchestrator = new ConversationOrchestrator(llm, sessions, tools, {
        spokenName: 'Adrian',
        writtenName: 'A.D.R.I.A.N.',
        timezone: config.timezone,
        firstEventTimeoutMs: brain.firstEventTimeoutMs,
        maxTokens: brain.maxTokens,
        maxToolRounds: 3,
        context: (ctx) => [
          ...(config.nicknames[ctx.userId] ? [`Call ${ctx.speaker} "${config.nicknames[ctx.userId]}" when you address them; that's what they go by here.`] : []),
          ...(isOwner(ctx.userId) ? ownerPrompt(ctx.speaker, ctx.userId) : []),
          ...(creator && !isCreator(ctx.userId) ? creatorLines(ctx.speaker, { creator, isCreator: false }) : []),
          ...(LANGS[userLang.get(ctx.userId) ?? 'en'].prompt ? [LANGS[userLang.get(ctx.userId) ?? 'en'].prompt] : []),
          // Mature mode by channel is per request; always/off is a constant (cached).
          ...(config.mature === 'age-restricted' ? matureContext(config.mature, isAgeRestricted(ctx.channelId)) : []),
          ...rosterLines(ctx.channelId, ctx.userId),
          ...room.context(ctx.channelId, ctx.userId),
          ...notes.context(ctx.userId, ctx.speaker),
          ...games.context(ctx),
          ...(music ? [musicState(music)] : []),
        ],
        selectTools: (text, ctx, all) =>
          routeTools(all, text, { gameRunning: games.context(ctx).length > 0, hasTimers: reminders.forUser(ctx.userId).length > 0, musicPlaying: !!music?.nowPlaying }),
        ...(creator ? { creator: { name: creator, spoken: config.identity.creatorSpoken ?? creator, heardAs: config.identity.creatorHeardAs } } : {}),
        // Claude caches the tools and the stable prompt; that needs the same tools every call.
        stablePrefix: brain.provider === 'anthropic',
        // First chunk stays a whole sentence: cutting at the first comma was
        // measured slower overall (bench/first-audio.mjs, median 1.39 vs 1.26 s).
        filler: () => FILLERS[fillerTurn++ % FILLERS.length]!,
        stableLines: [...(config.mature === 'age-restricted' ? [] : matureContext(config.mature, false)), ...(music ? musicRules() : [])],
      });
      log.info('brain ready', { model: brain.model, fallback: fbUsable ? fb!.model : null, tools: tools.map((x) => x.spec.name) });
    }
  }

  // Claude: cache reads cost 0.1x input, cache writes (5-minute) 1.25x.
  const claude = brain?.provider === 'anthropic';
  const costUsd = (u: Usage) =>
    brain
      ? ((u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * brain.priceInPerM +
          u.cachedTokens * (brain.priceCachedInPerM ?? (claude ? brain.priceInPerM * 0.1 : brain.priceInPerM)) +
          u.cacheWriteTokens * brain.priceInPerM * (claude ? 1.25 : 1) +
          u.outputTokens * brain.priceOutPerM) /
        1e6
      : 0;

  const { maxRequestChars, usageFile: _usageFile, ...limits } = config.limits;
  ledger.setLimits(limits);
  ledger.setTimezone(config.timezone);
  log.info('limits', { ...limits, todayUsd: Number(ledger.todayUsd().toFixed(4)), monthUsd: Number(ledger.monthUsd().toFixed(4)) });
  const pausedNotified = new Map<string, number>(); // reason → last spoken

  async function* fixed(text: string): AsyncGenerator<string> {
    yield text;
  }

  const names = new Map<UserId, string>();
  function nameOf(id: UserId): string {
    if (!names.has(id)) {
      const m = client.guilds.cache.get(spot?.guildId ?? config.guildId)?.members.cache.get(id);
      names.set(id, m?.displayName ?? m?.user.username ?? 'someone');
    }
    return names.get(id)!;
  }

  const speakOpts = { voice: voiceFor('en'), speed: voice.speed, volume: config.playbackVolume };
  /** Timing of each user's latest transcript, for the latency log line. */
  const lastHeard = new Map<UserId, { segmentClosedAt: number; sttLatencyMs: number }>();
  const answers: AnswerRecord[] = [];

  /** What was last said to each user, for "say that again". */
  const lastSpoken = new Map<UserId, string>();

  /** Everyday phrases answered locally (no model call, no cost). True if handled. */
  async function local(userId: UserId, command: string, signal: AbortSignal): Promise<boolean> {
    if (music && (await localMusic(userId, command, signal))) return true;
    if (isTimeQuestion(command)) {
      const t = dateFormat('en-US', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date());
      await speaker.speak(fixed(`It's ${t}.`), speakOpts, signal);
      return true;
    }
    const intent = classify(command);
    if (!intent) return false;
    const say = (t: string) => speaker.speak(fixed(t), speakOpts, signal);
    switch (intent.kind) {
      case 'ack':
        // "okay", "cool": nothing to say. But after a question from the bot,
        // "yeah" / "sure" is the answer, so the model gets it.
        return !(lastSpoken.get(userId) ?? '').trim().endsWith('?');
      case 'thanks':
        await say(["You're welcome.", 'Anytime.', 'Happy to help.'][Math.floor(Math.random() * 3)]!);
        return true;
      case 'bye':
        await say('Bye!');
        return true;
      case 'repeat': {
        const last = lastSpoken.get(userId);
        await speaker.speak(fixed(last ?? "I haven't said anything yet."), speakOpts, signal);
        return true;
      }
      case 'volume': {
        // With music on, "turn it up/down" means the music (unless it's about the voice).
        if (music?.nowPlaying && !/\b(you|your|voice|talk|speak)\b/i.test(command)) {
          const to = music.nudgeVolume(intent.dir);
          log.info('music volume', { to, by: userId });
          return true;
        }
        const v = speakOpts.volume;
        // Volume 1.0 is the −16 LUFS target; never above it.
        speakOpts.volume = Math.min(1, Math.max(0.25, Number((v * (intent.dir > 0 ? 1.3 : 0.75)).toFixed(2))));
        log.info('volume', { from: v, to: speakOpts.volume, by: userId });
        await say(speakOpts.volume === v ? (intent.dir > 0 ? "That's as loud as I go." : "That's as quiet as I go.") : intent.dir > 0 ? 'Okay, louder.' : 'Okay, quieter.');
        return true;
      }
      case 'speed': {
        const s = speakOpts.speed;
        speakOpts.speed = Math.min(1.25, Math.max(0.8, Number((s + intent.dir * 0.1).toFixed(2))));
        log.info('speed', { from: s, to: speakOpts.speed, by: userId });
        await say(speakOpts.speed === s ? "That's my limit." : intent.dir > 0 ? 'Okay, a bit faster.' : 'Okay, a bit slower.');
        return true;
      }
      default:
        return false; // stop/name are the controller's job
    }
  }

  /** "play X", "skip", "pause"...: answered without the model. */
  async function localMusic(userId: UserId, command: string, signal: AbortSignal): Promise<boolean> {
    const m = classifyMusic(command);
    if (!m || !music) return false;
    const say = (t: string) => speaker.speak(fixed(t), speakOpts, signal);
    if (m.kind === 'play') {
      const allowed = ledger.check(userId, isOwner(userId));
      if (!allowed.ok && allowed.reason === 'user-rate') {
        await say("You've asked for a lot in the last hour. Give it a bit.");
        return true;
      }
      ledger.noteRequest(userId);
      log.info('music request', { user: userId, mode: m.mode, ...(m.source ? { source: m.source } : {}) });
      // The search takes a few seconds: say a quick line if it isn't back in 0.9 s.
      let filler: Promise<unknown> | undefined;
      const fillerTimer = setTimeout(() => (filler = say(FILLERS[fillerTurn++ % FILLERS.length]!).catch(() => undefined)), 900);
      const r = await music
        .play(m.query, m.mode, signal, m.source)
        .catch((e: Error) => ({ ok: false as const, message: signal.aborted ? '' : (log.warn('music failed', { error: e.message }), "I couldn't play that.") }))
        .finally(() => clearTimeout(fillerTimer));
      await filler;
      if (signal.aborted) return true;
      if (!r.ok) await say(r.message);
      else await say(r.queued ? `Added ${trackName(r.track)}, number ${r.queued} in the queue.` : `Playing ${trackName(r.track)}.`);
      return true;
    }
    switch (m.action) {
      case 'pause':
        if (!music.pause()) await say("Nothing's playing.");
        return true;
      case 'resume':
        if (!music.resume()) await say(music.nowPlaying ? "It's already playing." : "Nothing's paused.");
        return true;
      case 'stop':
        if (!music.stop()) await say("Nothing's playing.");
        return true;
      case 'skip': {
        const n = await music.skip().catch(() => undefined);
        await say(n === false ? "Nothing's playing." : n ? `Next up, ${trackName(n)}.` : "That's the end of the queue.");
        return true;
      }
      default: {
        const n = music.nowPlaying;
        const q = music.upNext;
        await say(n ? `This is ${trackName(n)}.${q.length ? ` Then ${trackName(q[0]!)}${q.length > 1 ? `, and ${q.length - 1} more` : ''}.` : ''}` : "Nothing's playing right now.");
        return true;
      }
    }
  }

  async function respond(userId: UserId, command: string, outer: AbortSignal, followUp = false): Promise<void | 'silent'> {
    if (await local(userId, command, outer)) return;
    let silent = false;
    // The time limit is for getting the answer, not for saying it: the
    // model's text is read in as fast as it comes (eager), the timer stops
    // when it's done, and long answers keep playing (2 min hard cap).
    const genLimit = new AbortController();
    let genTimer = setTimeout(() => genLimit.abort(), brain?.totalTimeoutMs ?? 20_000);
    const signal = AbortSignal.any([outer, genLimit.signal]);
    /** The model finished its answer (so a late timer can't mark it timed out). */
    let generated = false;
    const playSignal = AbortSignal.any([outer, AbortSignal.timeout(120_000)]);
    const heard = lastHeard.get(userId);
    const tStart = performance.now();
    let llmFirstMs: number | undefined;
    let usage: Usage | undefined;
    let source: AsyncIterable<string>;
    const allowed = orchestrator ? ledger.check(userId, isOwner(userId)) : ({ ok: true } as const);
    if (!orchestrator) {
      source = fixed("I'm not fully set up yet. My language model hasn't been configured.");
    } else if (!allowed.ok) {
      log.info('limited', { user: userId, reason: allowed.reason });
      // Say why once per reason per 10 minutes; otherwise stay quiet.
      const key = allowed.reason === 'user-rate' ? `user:${userId}` : allowed.reason;
      if (performance.now() - (pausedNotified.get(key) ?? -Infinity) < 600_000) return;
      pausedNotified.set(key, performance.now());
      source = fixed(LIMIT_MESSAGES[allowed.reason]);
    } else {
      ledger.noteRequest(userId);
      const question = command.length > maxRequestChars ? command.slice(0, maxRequestChars) : command;
      const gen = orchestrator.ask(userId, nameOf(userId), question, signal, (u) => (usage = u), spot ? { guildId: spot.guildId, channelId: spot.channelId } : {}, {
        followUp,
        onSilent: () => (silent = true),
        // A slow tool (music lookup) may take longer than the answer limit: give
        // it its own limit plus time for the model to answer afterwards.
        onTool: (ms) => {
          if (genLimit.signal.aborted) return;
          clearTimeout(genTimer);
          genTimer = setTimeout(() => genLimit.abort(), ms + 8_000);
        },
      });
      source = eager(
        (async function* () {
        const said: string[] = [];
        try {
          for await (const chunk of gen) {
            llmFirstMs ??= Math.round(performance.now() - tStart);
            said.push(chunk);
            yield chunk;
          }
          generated = true;
        } finally {
          clearTimeout(genTimer);
          if (said.length) {
            lastSpoken.set(userId, said.join(' '));
            if (spot) room.add(spot.channelId, 'bot', `You (answering ${nameOf(userId)})`, said.join(' '));
          }
        }
        })(),
      );
    }
    if (!orchestrator || !allowed.ok) {
      clearTimeout(genTimer);
      generated = true;
    }
    let firstAudioAt: number | undefined;
    let r: Awaited<ReturnType<typeof speaker.speak>> = { outcome: 'error', chunks: 0, synthMs: [] };
    let failure: Error | undefined;
    try {
      r = await speaker.speak(source, { ...speakOpts, voice: voiceFor(userLang.get(userId) ?? 'en'), onFirstAudio: () => (firstAudioAt = performance.now()) }, playSignal);
    } catch (e) {
      // The model or the voice failed partway (or the time limit cut the
      // model off): what was already said stands; the accounting below runs.
      failure = e as Error;
    } finally {
      clearTimeout(genTimer);
      // Nobody is reading the answer any more: stop the model too, so it
      // can't keep generating (or start tools) in the background.
      if (!generated) genLimit.abort();
    }
    const timedOut = genLimit.signal.aborted && !generated && !outer.aborted && !!failure;
    if (usage && autoMemory) autoMemory.afterTurn(userId, nameOf(userId));
    // Stopped or replaced mid-answer: the next turn must not pick it back up.
    if (outer.aborted) sessions.markCutOff(userId);
    const cost = usage ? costUsd(usage) : 0;
    ledger.addCost(cost);
    const rec: AnswerRecord = {
      at: new Date().toISOString(),
      outcome: outer.aborted ? 'interrupted' : timedOut ? 'timed out' : failure ? 'error' : r.outcome,
      sttLatencyMs: heard?.sttLatencyMs ?? null,
      llmFirstChunkMs: llmFirstMs ?? null,
      ttsFirstMs: r.synthMs[0] ?? null,
      // The VAD closes a segment minSilence after speech ends.
      speechEndToAudioMs: firstAudioAt && heard ? Math.round(firstAudioAt - heard.segmentClosedAt + listen!.minSilence * 1000) : null,
      costUsd: Number(cost.toFixed(6)),
    };
    answers.push(rec);
    if (answers.length > 200) answers.shift();
    log.info('answered', {
      user: userId,
      ...rec,
      at: undefined,
      chunks: r.chunks,
      ...(usage
        ? { tokensIn: usage.inputTokens, tokensCached: usage.cachedTokens, tokensCacheWrite: usage.cacheWriteTokens, tokensOut: usage.outputTokens, toolCalls: usage.toolCalls }
        : {}),
      spentTodayUsd: Number(ledger.todayUsd().toFixed(4)),
    });
    if (failure && !timedOut && !outer.aborted) log.warn('answer failed', { user: userId, error: failure.message });
    if (silent) return 'silent';
    // The model answered with nothing at all: say so rather than leave silence.
    if (!failure && !outer.aborted && firstAudioAt === undefined && generated && orchestrator && allowed.ok) {
      await speaker.speak(fixed("Sorry, I didn't get that. Could you say it again?"), speakOpts, playSignal).catch(() => undefined);
      return;
    }
    // Only when nothing was said: then the user should hear a short sorry.
    // A partial answer that was cut off just ends.
    if ((timedOut || failure) && !outer.aborted && firstAudioAt === undefined) throw failure ?? new Error('timed out');
  }

  /** The names in the owner's greetings ("Yes, chief" → "chief"). */
  const petNames = config.ownerAck.map((a) => a.replace(/^\s*yes[,.!]?\s*/i, '').replace(/[.!?]+$/, '').trim()).filter(Boolean);

  /** How to treat an owner (their greeting first, and more affection). */
  function ownerPrompt(speaker: string, userId: UserId): string[] {
    const lines: string[] = [];
    if (isCreator(userId)) lines.push(...creatorLines(speaker, { creator, isCreator: true }));
    if (config.ownerAck.length) lines.push(`Start every answer to ${speaker} with "${nextOwnerAck()}," then answer.`);
    if (config.ownerAffection)
      lines.push(
        `${isCreator(userId) ? creator : speaker} is ${isCreator(userId) ? 'your creator and ' : ''}your favorite person. With ${isCreator(userId) ? creator : speaker} be extra affectionate and devoted: sweet, adoring, playful, teasing in a loving way, happy to hear from them, using ${petNames.length ? `pet names like ${petNames.join(', ')}` : 'warm nicknames'} now and then. Still give real, correct, useful answers, and keep it short.`,
      );
    return lines;
  }
  const priorityRoles = new Set(config.priorityRoleIds);
  /** Owners: the configured IDs plus the bot's app owner. */
  const isOwner = (id: UserId) => config.owners.includes(id) || id === voiceCommands.ownerId();
  /** The creator's own Discord account(s): configured, else the owners. */
  function isCreator(id: UserId): boolean {
    if (!creator) return false;
    return config.identity.creatorIds.length ? config.identity.creatorIds.includes(id) : isOwner(id);
  }
  let ownerAckTurn = 0;
  /** The owner's greetings in turn ("Yes boss", "Yes, chief", ...). */
  const nextOwnerAck = () => config.ownerAck[ownerAckTurn++ % config.ownerAck.length]!;
  const controller = new ConversationController({
    now: () => performance.now(),
    respond,
    say: async (text, signal) => {
      const limit = AbortSignal.timeout(15_000);
      await speaker.speak(fixed(text), speakOpts, signal ? AbortSignal.any([signal, limit]) : limit);
    },
    // The owner can stop any answer by saying "stop", but just talking in the
    // call must not cut off answers to other people.
    canStop: (id) => isOwner(id),
    ack: (id) => (isOwner(id) && config.ownerAck.length ? `${nextOwnerAck().replace(/[.!]+$/, '')}?` : config.nicknames[id] ? `Yes, ${config.nicknames[id]}?` : 'Yes?'),
    preempts: (id) => isOwner(id),
    stopOther: (id) => {
      if (music?.stop()) log.info('music stopped', { by: id, how: 'stop phrase' });
    },
    onStopped: (id) => {
      if (isOwner(id) && config.ownerStopReply.trim()) controller.announce(id, config.ownerStopReply.trim());
    },
    isPriority: (id) => {
      const m = client.guilds.cache.get(spot?.guildId ?? config.guildId)?.members.cache.get(id);
      return !!m && m.roles.cache.some((r) => priorityRoles.has(r.id));
    },
    log: (event, fields) => log.info(event, fields),
  });

  const wakeDetector = new TextWakeDetector({ name: listen.wakeName });
  const logTranscripts = listen.logTranscripts;
  const pipeline = new ListeningPipeline(transport, stt, wakeDetector, {
    model: listen.vadModel,
    threshold: listen.vadThreshold,
    minSilence: listen.minSilence,
    minSpeech: listen.minSpeech,
    maxSpeech: listen.maxSpeech,
  });
  pipeline.on('heard', (e) => void heard(e).catch((err: Error) => log.warn('heard failed', { error: err.message })));
  async function heard(e: HeardEvent): Promise<void> {
    // Questions that don't look English get a second, multilingual pass.
    const forBot = e.woke || controller.listeningTo(e.userId);
    const before = userLang.get(e.userId) ?? 'en';
    const said = e.woke ? e.command : e.text;
    const quick = classify(said);
    if (forBot && said.trim() && quick?.kind !== 'stop' && quick?.kind !== 'name') {
      if (english.looksEnglish(said)) {
        userLang.set(e.userId, 'en');
      } else if (looksSpanish(said)) {
        userLang.set(e.userId, 'es');
      } else if (whisper && e.samples) {
        const w = await whisper.transcribe(e.samples);
        const lang = replyLang(w.lang);
        userLang.set(e.userId, lang);
        log.info('second pass', { user: e.userId, lang: w.lang, decodeMs: w.decodeMs });
        if (w.text) {
          const m = wakeDetector.matchLoose(w.text);
          e = { ...e, text: w.text, command: e.woke ? (m.woke ? m.remainder : stripWakeLead(w.text)) : '' };
        }
      } else {
        userLang.set(e.userId, 'en');
      }
    }
    if (forBot && (userLang.get(e.userId) ?? 'en') !== before) log.info('language', { user: e.userId, from: before, to: userLang.get(e.userId) });
    if (spot) room.add(spot.channelId, e.userId, nameOf(e.userId), e.text);
    if (logTranscripts) log.debug("heard", { user: e.userId, text: e.text, woke: e.woke });
    // Data for tuning the end-of-speech wait: the same person talking again
    // right after their last segment closed may mean it was cut mid-sentence.
    const prev = lastHeard.get(e.userId);
    const gapMs = prev ? Math.round(e.segmentClosedAt - (e.audioSeconds ?? 0) * 1000 - prev.segmentClosedAt) : undefined;
    if (gapMs !== undefined && gapMs >= 0 && gapMs < 1_200) log.info('quick continuation', { user: e.userId, gapMs, woke: e.woke });
    lastHeard.set(e.userId, { segmentClosedAt: e.segmentClosedAt, sttLatencyMs: e.sttLatencyMs });
    if (e.woke) mixer.duckFor(8_000);
    if (e.woke) log.info('wake', { user: e.userId, sttLatencyMs: e.sttLatencyMs, audioSeconds: e.audioSeconds, ...(e.loose ? { loose: true } : {}) });
    controller.heard({ userId: e.userId, text: e.text, woke: e.woke, command: e.command, ...(e.loose ? { loose: true } : {}) });
  }
  pipeline.on('voiceActivity', (id, ms) => controller.voiceActivity(id, ms));
  pipeline.on('error', (id, err) => log.warn('listen error', { user: id, error: err.message }));

  // --- /join and /leave ---------------------------------------------------
  let moving: Promise<void> = Promise.resolve();
  const moveTo = (to: VoiceSpot | undefined): Promise<void> => {
    controller.cancelAll();
    music?.stop();
    mixer.stopAll();
    const run = async () => {
      if (spot?.guildId === to?.guildId && spot?.channelId === to?.channelId && ready) return;
      ready = false;
      await transport.disconnect();
      names.clear();
      spot = to;
      if (to) await transport.connect(to.guildId, to.channelId);
    };
    const p = moving.then(run, run);
    moving = p.catch(() => undefined);
    return p;
  };
  const voiceCommands = registerVoiceCommands({ client, log, current: () => spot, moveTo: (s) => moveTo(s), leave: () => moveTo(undefined), allowedGuilds: config.allowedGuilds });
  // Outside the home channel, leave after 10 minutes with nobody else there.
  let emptySince: number | undefined;
  const idleTimer = setInterval(() => {
    const away = spot && (spot.guildId !== config.guildId || spot.channelId !== config.channelId);
    const ch = spot ? (client.channels.cache.get(spot.channelId) as VoiceBasedChannel | undefined) : undefined;
    if (!away || humansIn(ch) > 0) {
      emptySince = undefined;
      return;
    }
    emptySince ??= Date.now();
    if (Date.now() - emptySince > 10 * 60_000) {
      emptySince = undefined;
      log.info('left an empty channel', { guildId: spot!.guildId });
      void moveTo(undefined).catch(() => undefined);
    }
  }, 30_000);
  idleTimer.unref();

  client.once(Events.ClientReady, async (c) => {
    log.info('logged in', { bot: c.user.tag });
    reminders.start(); // also fires any that came due while offline
    // Dev check of the speech output path: SAY="text" speaks once on join.
    const say = process.env.SAY;
    if (say) {
      transport.once('ready', () => {
        const t0 = performance.now();
        void speaker
          .speak(fixed(say), speakOpts, AbortSignal.timeout(20_000))
          .then((r) => log.info('said', { outcome: r.outcome, firstAudioMs: r.firstAudioMs, synthMs: r.synthMs, totalMs: Math.round(performance.now() - t0) }));
      });
    }
    try {
      await transport.connect(config.guildId, config.channelId);
    } catch (e) {
      log.error('voice connect failed', { error: (e as Error).message });
    }
  });

  await client.login(token);

  if (cloud) {
    // Fetch the short replies once so "Yes?" and friends play without a wait.
    const lines = ['Yes?', 'Okay.', ...FILLERS, ...config.ownerAck.map((a) => `${a.replace(/[.!]+$/, '')}?`), config.ownerStopReply.trim()].filter(Boolean);
    void (async () => {
      for (const l of new Set(lines)) await cloud.synthesize(l, { voice: CLOUD, speed: voice.speed }).catch(() => undefined);
      log.info('cloud voice ready', { cachedLines: lines.length, usedChars: voiceBudget.used() });
    })();
  }

  return {
    ledger,
    voiceReady: () => ready,
    botTag: () => client.user?.tag,
    answers: () => answers,
    stop: async () => {
      ready = false;
      clearInterval(idleTimer);
      controller.cancelAll();
      reminders.stop();
      music?.stop();
      mixer.stopAll();
      ledger.flush();
      voiceBudget.flush();
      try {
        await transport.disconnect();
      } finally {
        await client.destroy();
      }
    },
  };
}
