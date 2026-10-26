// The voice stack: wake → Parakeet → LLM (read-only tools, per-user memory)
// → Kokoro → Discord, streamed sentence by sentence, under the conversation
// controller's queue and interruption rules and the spend caps. Started by
// main.ts once the config is complete, and restarted by the admin UI.

import { Client, Events, GatewayIntentBits, Partials, type VoiceBasedChannel } from 'discord.js';
import { dateFormat } from '../core/time.js';
import { humansIn, registerVoiceCommands, type VoiceSpot } from './commands.js';
import prism from 'prism-media';
import { FallbackLlm } from '../brain/fallback.js';
import { ConversationOrchestrator, type Usage } from '../brain/orchestrator.js';
import { OpenAiCompatibleLlm } from '../brain/openai-compatible.js';
import { AnthropicLlm } from '../brain/anthropic.js';
import { SessionMemory } from '../brain/sessions.js';
import { cachedTool, tavilySearchTool, timeTool, topResultUrl } from '../brain/tools.js';
import type { PocConfig } from '../config.js';
import { ConversationController, DEFAULT_CONTROLLER_OPTIONS } from '../conversation/controller.js';
import type { LlmProvider, Logger, Tool, UserId, VoiceTransport } from '../core/interfaces.js';
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
import { type HeardEvent, ListeningPipeline, type TurnOptions } from '../listen/pipeline.js';
import { EnglishWords, LANGS, looksSpanish, type ReplyLang, replyLang, stripWakeLead } from '../speech/language.js';
import { PiperTts, VoiceRouter } from '../speech/piper.js';
import { WhisperStt } from '../speech/whisper.js';
import { SmartTurn } from '../speech/smart-turn.js';
import { groqTranscribe, sttPrompt } from '../speech/cloud-stt.js';
import { MODEL_LAYOUT } from '../web/checks.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { KokoroTts } from '../speech/kokoro.js';
import { CharBudget, SpeechifyTts } from '../speech/speechify.js';
import { Mixer } from '../voice/mixer.js';
import { SOUND_RULE, soundTool } from '../features/sounds.js';
import { eager } from '../core/eager.js';
import { creatorLines, genderLines, memberLabel } from './identity.js';
import { registerTextChat } from './textchat.js';
import { discordTools, RelayLimiter } from '../features/discordinfo.js';
import { describe as trackName, ffmpegDecoder, MusicPlayer, musicRules, musicState, musicTools, PlexMusicSource, type MusicSource, YoutubeSource } from '../features/music.js';
import { linksLine, PLAY_THAT_LINK, RecentLinks } from '../features/links.js';
import { classifyMusic, isTimeQuestion } from '../conversation/intents.js';
import { ParakeetStt } from '../speech/sherpa.js';
import { DiscordVoiceTransport } from '../transport/discord.js';
import { Speaker } from '../voice/speaker.js';
import { TextWakeDetector } from '../wake/text-wake.js';
import type { SatelliteConnection } from '../satellite/connection.js';
import { SatelliteDevices } from '../satellite/devices.js';
import { PcRecorder } from '../satellite/recorder.js';
import { startSatelliteServer } from '../satellite/server.js';
import { PC_RULE, pcTools } from '../satellite/tools.js';

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

  // Messages: ones that @mention the bot (and DMs) carry their text anyway.
  // Reading the rest of a channel needs the Message Content intent, which is
  // switched on in the Developer Portal; asking for it when it's off would
  // fail the login, so check first.
  const granted = await privilegedIntents(token, log);
  const readChannels = config.textChat.enabled && config.textChat.readChannels && granted.messageContent;
  const seeMembers = config.serverInfo.enabled && config.serverInfo.members && granted.members;
  const seePresences = config.serverInfo.enabled && config.serverInfo.presences && granted.presences;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      ...(readChannels ? [GatewayIntentBits.MessageContent] : []),
      ...(seeMembers ? [GatewayIntentBits.GuildMembers] : []),
      ...(seePresences ? [GatewayIntentBits.GuildPresences] : []),
    ],
    partials: [Partials.Channel],
  });
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
  transport.on('kicked', () => {
    ready = false;
    spot = undefined;
    controller.cancelAll();
    music?.stop();
    mixer.stopAll();
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
  /** Starts like a request to play something or control the music. */
  const MUSICISH = /^\W*(?:(?:hey|ok(?:ay)?|yo|now|so|and|alright|bro)\W+)*(?:adri\w*\W+)?(?:(?:can|could|would|will) you (?:please )?|please )?(?:play|put on|throw on|queue|blast|bump|spin|skip|pause|resume|unpause|turn (?:up|down) the music|stop the music|(?:i want to|i wanna|let me|lemme|let's) (?:hear|listen to)|(?:make|do) (?:a|an|the|some) [a-z ]*(?:sound|noise))\b/i;
  /** Said before a slow lookup when nothing else has been said yet. */
  const FILLERS = ['One sec.', 'Let me check.', 'On it.'];
  let fillerTurn = 0;
  // Speech and music share Discord's one audio player through the mixer.
  const mc = config.music;
  const mixer = new Mixer({ start: (s) => transport.playPcm(s, { volume: 1 }), duckLevel: mc.duckLevel });
  // One set of voices, shared by every room (the Discord call and each PC).
  const router = new VoiceRouter(tts, { ...(piperVi ? { vi_piper: piperVi } : {}), ...(cloud ? { [CLOUD]: cloud } : {}) });
  const speaker = new Speaker(mixer, router);

  // --- music --------------------------------------------------------------
  const ytdlp = mc.ytdlp ?? join(langModels, MODEL_LAYOUT.ytdlp);
  const musicSources: MusicSource[] = [];
  if (mc.enabled && existsSync(ytdlp)) musicSources.push(new YoutubeSource({ ytdlp, node: process.execPath }));
  const plexForMusic = secrets.get('PLEX_TOKEN');
  if (mc.enabled && mc.plexBackup && plexForMusic) musicSources.push(new PlexMusicSource({ url: config.media.plexUrl, token: plexForMusic }));
  const ffmpegOk = mc.enabled && spawnSync(mc.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
  const makeMusic = (out: Mixer) =>
    ffmpegOk && musicSources.length ? new MusicPlayer({ sources: musicSources, output: out, decode: ffmpegDecoder(mc.ffmpeg), log, volume: mc.volume, maxQueue: mc.maxQueue, autoplay: mc.autoplay }) : undefined;
  const music = makeMusic(mixer);
  if (mc.enabled) log.info(music ? 'music ready' : 'music off', { sources: musicSources.map((s) => s.name), ffmpeg: ffmpegOk });

  // --- sound effects (needs YouTube and ffmpeg, like music) -------------------
  const ytForSounds = musicSources.find((s): s is YoutubeSource => s instanceof YoutubeSource);
  /** Plays one sound effect at a time into a room's mixer. */
  function soundPlayer(out: Mixer): { play(t: { ref: string; title?: string }): void; stop(): void } {
    let handle: { stop(): void } | undefined;
    const stop = () => {
      handle?.stop();
      handle = undefined;
    };
    return {
      stop,
      play: (t) => {
        stop();
        const dec = ffmpegDecoder(mc.ffmpeg)({ url: t.ref });
        const h = out.playPcm(dec.pcm, { volume: Math.min(1, config.playbackVolume) });
        const cap = setTimeout(() => h.stop(), 15_000); // a sound, not a song
        const mine = { stop: () => (h.stop(), dec.kill()) };
        handle = mine;
        void h.done.finally(() => {
          clearTimeout(cap);
          dec.kill();
          if (handle === mine) handle = undefined;
        });
        log.info('sound playing', { title: t.title });
      },
    };
  }

  // --- rooms: the Discord call, and each connected PC ------------------------
  /** Where a conversation happens: its own speaker, music and sounds. */
  interface Room {
    key: string;
    mixer: Mixer;
    speaker: Speaker;
    music: MusicPlayer | undefined;
    sound: ReturnType<typeof soundPlayer>;
    /** What tools and room talk see: the voice channel, or `sat:<id>` for a PC. */
    place(): { guildId?: string; channelId?: string };
    /** The PC's window, for satellites. */
    ui?: SatelliteConnection;
  }
  const discordRoom: Room = {
    key: 'discord',
    mixer,
    speaker,
    music,
    sound: soundPlayer(mixer),
    place: () => (spot ? { guildId: spot.guildId, channelId: spot.channelId } : {}),
  };
  const satRooms = new Map<string, Room>();
  // PC satellites (docs/satellite.md): off unless configured, and they need the state folder for pairings.
  const satEnabled = !!config.satellite.enabled && !!stateDir;
  let satServer: ReturnType<typeof startSatelliteServer> | undefined;
  const recorder = satEnabled && config.satellite.recordDays > 0 ? new PcRecorder(join(stateDir!, 'pc-recordings'), config.satellite.recordDays) : undefined;
  if (recorder) log.info('recording PC requests', { days: config.satellite.recordDays });
  /** The asker's own PC: the one they're talking through, else their most recently active one. */
  function pcFor(ctx: { userId: UserId; channelId?: string | undefined }): SatelliteConnection | undefined {
    const mine = (satServer?.connections() ?? []).filter((c) => c.owner === ctx.userId);
    return mine.find((c) => `sat:${c.device.id}` === ctx.channelId) ?? mine.sort((a, b) => b.lastSeen - a.lastSeen)[0];
  }
  /** The room a request came from (tools get it through their context). */
  const roomFor = (ctx: { channelId?: string | undefined }): Room => (ctx.channelId && satRooms.get(ctx.channelId)) || discordRoom;
  const sounds =
    music && ytForSounds
      ? {
          find: (q: string, signal: AbortSignal) => ytForSounds.soundEffect(q, signal),
          play: async (t: { ref: string; title?: string }, ctx: { channelId?: string }) => roomFor(ctx).sound.play(t),
        }
      : undefined;

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
  /** Playable links pasted in chat, for "play that link" (memory only). */
  const links = new RecentLinks();
  const games = new PartyGames();
  const room = new RoomTalk();
  /** Who's in the voice call, so it can talk about and to everyone by name. */
  function rosterLines(channelId: string | undefined, askerId: string): string[] {
    const any = channelId ? client.channels.cache.get(channelId) : undefined;
    if (!any?.isVoiceBased()) return []; // a text chat has no call roster
    const ch = any as VoiceBasedChannel;
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
      if (music) tools.push(...musicTools((ctx) => roomFor(ctx).music));
      if (sounds) tools.push(soundTool(sounds));
      if (satEnabled)
        tools.push(
          ...pcTools({
            pcFor: (ctx) => pcFor(ctx),
            ...(ytForSounds ? { findVideo: async (q: string, signal: AbortSignal) => (await ytForSounds.video(q, signal))?.ref.match(/[?&]v=([\w-]{11})/)?.[1] } : {}),
            ...(searchKey ? { findUrl: (q: string, signal: AbortSignal) => topResultUrl(searchKey, q, signal) } : {}),
            onCall: (name, args, result) => {
              if (config.satellite.logTranscripts) log.info('pc action', { name, args, result: result.slice(0, 200) });
            },
          }),
        );
      if (config.serverInfo.enabled)
        tools.push(
          ...discordTools(
            { client, allowedGuilds: config.allowedGuilds, members: seeMembers, presences: seePresences, timezone: config.timezone },
            config.messaging.enabled
              ? { limiter: new RelayLimiter(config.messaging.perUserPerHour, config.messaging.perTargetPerHour), isOwner: (id) => isOwner(id), maxChars: config.messaging.maxChars }
              : undefined,
          ),
        );
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
          ...(roomFor(ctx).music ? [musicState(roomFor(ctx).music!), ...linksLine(links.forPrompt(ctx.userId, ctx.guildId))] : []),
          ...(roomFor(ctx).ui ? [`${ctx.speaker} is talking to you through their PC (A.D.R.I.A.N. satellite), not in the Discord call. Music and sounds play on that PC.`] : []),
        ],
        selectTools: (text, ctx, all) =>
          routeTools(all, text, { gameRunning: games.context(ctx).length > 0, hasTimers: reminders.forUser(ctx.userId).length > 0, musicPlaying: !!roomFor(ctx).music?.nowPlaying }),
        ...(creator ? { creator: { name: creator, spoken: config.identity.creatorSpoken ?? creator, heardAs: config.identity.creatorHeardAs } } : {}),
        // Claude caches the tools and the stable prompt; that needs the same tools every call.
        stablePrefix: brain.provider === 'anthropic',
        // First chunk stays a whole sentence: cutting at the first comma was
        // measured slower overall (bench/first-audio.mjs, median 1.39 vs 1.26 s).
        filler: () => FILLERS[fillerTurn++ % FILLERS.length]!,
        stableLines: [
          ...genderLines(config.botGender),
          ...(sounds ? [SOUND_RULE] : []),
          ...(config.mature === 'age-restricted' ? [] : matureContext(config.mature, false)),
          ...(music ? musicRules() : []),
          ...(satEnabled ? [PC_RULE] : []),
        ],
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
      const u = client.users.cache.get(id);
      const n = m?.displayName ?? u?.globalName ?? u?.username;
      if (!n) return 'someone'; // not cached yet: try again next time
      names.set(id, n);
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
  async function local(rm: Room, userId: UserId, command: string, signal: AbortSignal): Promise<boolean> {
    if (rm.music && (await localMusic(rm, userId, command, signal))) return true;
    if (isTimeQuestion(command)) {
      const t = dateFormat('en-US', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date());
      await rm.speaker.speak(fixed(`It's ${t}.`), speakOpts, signal);
      return true;
    }
    const intent = classify(command);
    if (!intent) return false;
    const say = (t: string) => rm.speaker.speak(fixed(t), speakOpts, signal);
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
        await rm.speaker.speak(fixed(last ?? "I haven't said anything yet."), speakOpts, signal);
        return true;
      }
      case 'volume': {
        const aboutHer = /\b(you|your|voice|talk|speak)\b/i.test(command);
        // With music on, "turn it up/down" means the music (unless it's about the voice).
        if (rm.music?.nowPlaying && !aboutHer) {
          const to = rm.music.nudgeVolume(intent.dir);
          log.info('music volume', { to, by: userId });
          return true;
        }
        // At a PC, "turn it down" means the PC's volume: the model's pc_volume.
        if (rm.ui && !aboutHer) return false;
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
  async function localMusic(rm: Room, userId: UserId, command: string, signal: AbortSignal): Promise<boolean> {
    if (rm.music && PLAY_THAT_LINK.test(command)) return playPastedLink(rm, userId, command, signal);
    const m = classifyMusic(command);
    const music = rm.music;
    if (!m || !music) return false;
    // At a PC, "pause", "skip" and "what's playing" mean whatever the PC is
    // playing (Spotify, a video) unless her own music is on: the model's PC
    // tools handle that.
    if (rm.ui && m.kind !== 'play' && !music.nowPlaying) return false;
    const say = (t: string) => rm.speaker.speak(fixed(t), speakOpts, signal);
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

  /** "Play that link I just sent": the asker's latest pasted link, else the server's latest. */
  async function playPastedLink(rm: Room, userId: UserId, command: string, signal: AbortSignal): Promise<boolean> {
    const say = (t: string) => rm.speaker.speak(fixed(t), speakOpts, signal);
    const pasted = links.latestFor(userId, rm.place().guildId);
    if (!pasted) {
      await say("I don't see a link in chat from the last half hour. Paste it and ask again.");
      return true;
    }
    const allowed = ledger.check(userId, isOwner(userId));
    if (!allowed.ok && allowed.reason === 'user-rate') {
      await say("You've asked for a lot in the last hour. Give it a bit.");
      return true;
    }
    ledger.noteRequest(userId);
    log.info('music link', { user: userId, kind: pasted.link.kind, fromUser: pasted.userId === userId });
    let filler: Promise<unknown> | undefined;
    const fillerTimer = setTimeout(() => (filler = say(FILLERS[fillerTurn++ % FILLERS.length]!).catch(() => undefined)), 900);
    const queue = /^\W*(?:\w+\W+){0,3}queue\b/i.test(command) ? 'queue' : 'now';
    const r = await rm
      .music!.request('link', pasted.link.url, queue, signal)
      .catch((e: Error) => ({ ok: false as const, message: signal.aborted ? '' : (log.warn('music failed', { error: e.message }), "I couldn't play that link.") }))
      .finally(() => clearTimeout(fillerTimer));
    await filler;
    if (signal.aborted) return true;
    if (!r.ok) await say(r.message);
    else if (r.started) await say(`Playing ${trackName(r.started)}${r.added ? `, and ${r.added} more after it` : ''}.`);
    else await say(`Added ${r.added === 1 ? 'it' : `${r.added} songs`} to the queue.`);
    return true;
  }

  async function respond(rm: Room, userId: UserId, command: string, outer: AbortSignal, followUp = false, onSpeaking?: () => void): Promise<void | 'silent'> {
    if (await local(rm, userId, command, outer)) return;
    // A music or sound request is always for the bot, even without the name.
    const musicish = rm.music !== undefined && MUSICISH.test(command);
    if (musicish) followUp = false;
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
      const gen = orchestrator.ask(userId, nameOf(userId), question, signal, (u) => (usage = u), rm.place(), {
        followUp,
        ...(rm.ui ? { desk: true } : {}),
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
            rm.ui?.transcript('her', said.join(' '), false);
            yield chunk;
          }
          generated = true;
        } finally {
          clearTimeout(genTimer);
          if (said.length) {
            lastSpoken.set(userId, said.join(' '));
            const pl = rm.place();
            if (pl.channelId) room.add(pl.channelId, 'bot', `You (answering ${nameOf(userId)})`, said.join(' '));
            rm.ui?.transcript('her', said.join(' '));
            if (rm.ui && config.satellite.logTranscripts) log.info('pc answer', { room: rm.key, asked: command.slice(0, 300), said: said.join(' ').slice(0, 500) });
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
    let r: Awaited<ReturnType<typeof rm.speaker.speak>> = { outcome: 'error', chunks: 0, synthMs: [] };
    let failure: Error | undefined;
    try {
      r = await rm.speaker.speak(source, { ...speakOpts, voice: voiceFor(userLang.get(userId) ?? 'en'), onFirstAudio: () => { firstAudioAt = performance.now(); onSpeaking?.(); } }, playSignal);
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
    // Asked for music but nothing was played: log what was asked, to see why.
    if (musicish && !outer.aborted && (silent || !usage?.toolCalls)) log.warn('music asked but not played', { user: userId, text: command.slice(0, 120) });
    if (silent) return 'silent';
    // The model answered with nothing at all: say so rather than leave silence.
    if (!failure && !outer.aborted && firstAudioAt === undefined && generated && orchestrator && allowed.ok && !usage?.toolCalls) {
      await rm.speaker.speak(fixed("Sorry, I didn't get that. Could you say it again?"), speakOpts, playSignal).catch(() => undefined);
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
  /** A conversation controller for one room (the Discord call, or a PC). */
  function makeController(rm: Room): ConversationController {
    const c: ConversationController = new ConversationController({
    now: () => performance.now(),
    respond: async (userId, command, signal, followUp) => {
      rm.ui?.mode('thinking');
      try {
        return await respond(rm, userId, command, signal, followUp, () => c.speaking(userId));
      } finally {
        rm.ui?.mode('idle');
      }
    },
    say: async (text, signal) => {
      const limit = AbortSignal.timeout(15_000);
      await rm.speaker.speak(fixed(text), speakOpts, signal ? AbortSignal.any([signal, limit]) : limit);
    },
    // The owner can stop any answer by saying "stop", but just talking in the
    // call must not cut off answers to other people.
    canStop: (id) => isOwner(id),
    ack: (id) => (isOwner(id) && config.ownerAck.length ? `${nextOwnerAck().replace(/[.!]+$/, '')}?` : config.nicknames[id] ? `Yes, ${config.nicknames[id]}?` : 'Yes?'),
    preempts: (id) => isOwner(id),
    stopOther: (id) => {
      if (rm.music?.stop()) log.info('music stopped', { by: id, how: 'stop phrase', room: rm.key });
    },
    onStopped: (id) => {
      rm.sound.stop();
      if (isOwner(id) && config.ownerStopReply.trim()) c.announce(id, config.ownerStopReply.trim());
    },
    isPriority: (id) => {
      const m = client.guilds.cache.get(spot?.guildId ?? config.guildId)?.members.cache.get(id);
      return !!m && m.roles.cache.some((r) => priorityRoles.has(r.id));
    },
    log: (event, fields) => log.info(event, rm.ui ? { ...fields, room: rm.key } : fields),
    // At a PC it's one person talking to her: keep the conversation open
    // longer, and stop as soon as they talk over her (the PC only sends
    // speech that's clearly louder than her own echo).
    }, rm.ui ? { ...DEFAULT_CONTROLLER_OPTIONS, followUpMs: 20_000, bargeInMs: 600 } : DEFAULT_CONTROLLER_OPTIONS);
    return c;
  }
  const controller = makeController(discordRoom);

  const wakeDetector = new TextWakeDetector({ name: listen.wakeName });

  // --- the cloud second listen (config cloudStt) ---------------------------
  const cs = config.cloudStt;
  const csKey = cs.enabled ? secrets.get(cs.apiKeySecret) : undefined;
  if (cs.enabled) log.info(csKey ? 'cloud speech-to-text' : 'cloud speech-to-text key missing; local only', { model: cs.model, rooms: cs.rooms });
  let csPausedUntil = 0;
  // Names it should expect: her creator, people's nicknames.
  const csPrompt = sttPrompt([creator, ...Object.values(config.nicknames)].filter(Boolean));
  // PC rooms, and PC owners in the call (their PC hands the call their requests).
  const hasPc = (userId: UserId) => (satServer?.connections() ?? []).some((c) => c.owner === userId);
  const cloudSttFor = (rm: Room, userId: UserId) => !!csKey && (cs.rooms === 'all' || !!rm.ui || hasPc(userId)) && performance.now() > csPausedUntil;
  /** The cloud's words for a segment, or undefined (slow, failed, rate-limited: use the local ones). */
  async function cloudListen(samples: Float32Array): Promise<string | undefined> {
    try {
      return (await groqTranscribe(csKey!, samples, 16_000, { model: cs.model, prompt: csPrompt, signal: AbortSignal.timeout(cs.timeoutMs) })) || undefined;
    } catch (err) {
      const msg = (err as Error).message;
      // Rate limit or outage: give it a minute.
      if (/HTTP (429|5\d\d)/.test(msg)) csPausedUntil = performance.now() + 60_000;
      log.warn('cloud speech-to-text failed; using local words', { error: msg.slice(0, 120) });
      return undefined;
    }
  }
  const logTranscripts = listen.logTranscripts;
  // PC rooms: a pause that sounds mid-sentence waits a little longer (Smart Turn).
  let turn: TurnOptions | undefined;
  const turnModel = join(langModels, MODEL_LAYOUT.smartTurn);
  if (satEnabled && config.satellite.unfinishedWaitMs > 0 && existsSync(turnModel)) {
    try {
      const detector = await SmartTurn.load(turnModel);
      turn = {
        detector,
        holdMs: config.satellite.unfinishedWaitMs,
        onHold: (userId, info) => log.info('waiting for the rest', { user: userId, ...info }),
      };
      log.info('smart turn loaded', { waitMs: turn.holdMs });
    } catch (err) {
      log.warn('smart turn unavailable; using the plain silence wait', { error: (err as Error).message.slice(0, 160) });
    }
  }
  const vad = {
    model: listen.vadModel,
    threshold: listen.vadThreshold,
    minSilence: listen.minSilence,
    minSpeech: listen.minSpeech,
    maxSpeech: listen.maxSpeech,
  };
  /** In the voice channel she's in, and audible there (not muted or deafened). */
  function inHerCall(userId: UserId): boolean {
    if (!spot) return false;
    const vs = client.guilds.cache.get(spot.guildId)?.voiceStates.cache.get(userId);
    return !!vs && vs.channelId === spot.channelId && !vs.mute && !vs.deaf;
  }
  /** Listen to one room's audio. `direct()` true: the next thing heard is a question for her (push-to-talk). */
  function listenTo(source: VoiceTransport, rm: Room, ctl: ConversationController, direct?: () => boolean): ListeningPipeline {
  // At a PC, a pause mid-sentence shouldn't split it in two (Discord keeps the snappier default).
  const pipeline = rm.ui
    ? new ListeningPipeline(source, stt, wakeDetector, { ...vad, minSilence: Math.max(vad.minSilence, 0.8) }, turn)
    : new ListeningPipeline(source, stt, wakeDetector, vad);
  pipeline.on('heard', (e) => void heard(e).catch((err: Error) => log.warn('heard failed', { error: err.message })));
  async function heard(e: HeardEvent): Promise<void> {
    if (!e.woke && direct?.()) e = { ...e, woke: true, command: e.text };
    // In her Discord call too: the call hears the same words, and that's
    // where a group wants her (music for everyone). The call answers; it can
    // still reach this PC through the PC tools. Push-to-talk and typing in
    // the window stay with the PC, and so does everything while muted there.
    else if (rm.ui && inHerCall(e.userId)) {
      if (e.woke) {
        log.info('pc deferred to discord', { room: rm.key });
        rm.ui.transcript('her', 'Answering in the Discord call.');
      }
      return;
    }
    const forBot = e.woke || ctl.listeningTo(e.userId);
    const before = userLang.get(e.userId) ?? 'en';
    // Said to her: a second, more accurate listen in the cloud for the words
    // (the local model already decided it was for her). Stops and her name
    // alone don't need it.
    const first = classify(e.woke ? e.command : e.text);
    const local = e.text;
    let cloud: string | undefined;
    if (forBot && e.samples && first?.kind !== 'stop' && first?.kind !== 'name' && cloudSttFor(rm, e.userId)) {
      const t0 = performance.now();
      const text = (cloud = await cloudListen(e.samples));
      if (text) {
        const m = wakeDetector.matchLoose(text);
        const command = e.woke ? (m.woke ? m.remainder : stripWakeLead(text)) : '';
        if (config.satellite.logTranscripts && (rm.ui || hasPc(e.userId))) log.info('pc stt', { local: e.text, cloud: text, ms: Math.round(performance.now() - t0) });
        // Keep the local words if the cloud lost the request itself.
        if (!e.woke || command.trim()) e = { ...e, text, command };
      }
    }
    if (recorder && forBot && rm.ui && e.samples) {
      try {
        recorder.save(rm.key, e.samples, { local, ...(cloud ? { cloud } : {}) });
      } catch (err) {
        log.warn('recording failed', { error: (err as Error).message });
      }
    }
    // Questions that don't look English get a second, multilingual pass.
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
    const pl = rm.place();
    if (pl.channelId) room.add(pl.channelId, e.userId, nameOf(e.userId), e.text);
    if (forBot && rm.ui) rm.ui.transcript('you', e.woke ? e.command || e.text : e.text);
    if (logTranscripts) log.debug("heard", { user: e.userId, text: e.text, woke: e.woke });
    // PC rooms: what happened to each thing heard (no words), to tune the PC side.
    if (rm.ui)
      log.info('pc heard', {
        room: rm.key,
        seconds: e.audioSeconds,
        woke: e.woke,
        forBot,
        ...(e.loose ? { loose: true } : {}),
        ...(config.satellite.logTranscripts ? { text: e.text } : {}),
      });
    // Data for tuning the end-of-speech wait: the same person talking again
    // right after their last segment closed may mean it was cut mid-sentence.
    const prev = lastHeard.get(e.userId);
    const gapMs = prev ? Math.round(e.segmentClosedAt - (e.audioSeconds ?? 0) * 1000 - prev.segmentClosedAt) : undefined;
    if (gapMs !== undefined && gapMs >= 0 && gapMs < 1_200) log.info('quick continuation', { user: e.userId, gapMs, woke: e.woke });
    lastHeard.set(e.userId, { segmentClosedAt: e.segmentClosedAt, sttLatencyMs: e.sttLatencyMs });
    if (e.woke) rm.mixer.duckFor(8_000);
    if (e.woke) log.info('wake', { user: e.userId, sttLatencyMs: e.sttLatencyMs, audioSeconds: e.audioSeconds, ...(e.loose ? { loose: true } : {}) });
    ctl.heard({ userId: e.userId, text: e.text, woke: e.woke, command: e.command, ...(e.loose ? { loose: true } : {}) });
  }
  pipeline.on('voiceActivity', (id, ms) => ctl.voiceActivity(id, ms));
  pipeline.on('error', (id, err) => log.warn('listen error', { user: id, error: err.message }));
  return pipeline;
  }
  listenTo(transport, discordRoom, controller);

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
  // Text chat (@mentions, replies, DMs): same brain and limits as voice.
  registerTextChat({
    client,
    log,
    ...(orchestrator
      ? {
          ask: (userId, name, text, place, signal, opts) => {
            const o = orchestrator!;
            return (async function* () {
              let usage: Usage | undefined;
              let silent = false;
              try {
                yield* o.ask(userId, name, text, signal, (u) => (usage = u), place, {
                  text: true,
                  followUp: opts.followUp,
                  extra: opts.extra,
                  onSilent: () => {
                    silent = true;
                    opts.onSilent();
                  },
                });
              } finally {
                // Side talk it stayed out of doesn't count toward the hourly limit (its cost does).
                if (!silent) ledger.noteRequest(userId);
                if (usage) ledger.addCost(costUsd(usage));
              }
            })();
          },
        }
      : {}),
    links,
    limited: (userId) => {
      const a = ledger.check(userId, isOwner(userId));
      return a.ok ? undefined : LIMIT_MESSAGES[a.reason];
    },
    enabled: config.textChat.enabled,
    dms: config.textChat.dms,
    allowedGuilds: config.allowedGuilds,
    maxQuestionChars: maxRequestChars,
    maxReplyChars: config.textChat.maxReplyChars,
    readChannels,
    maxPings: config.textChat.maxPings,
    historyMessages: config.textChat.historyMessages,
    followUpMs: config.textChat.followUpMinutes * 60_000,
  });
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

  // --- PC satellites: each connected PC is a room of its own ----------------
  if (satEnabled) {
    satServer = startSatelliteServer({
      bind: config.satellite.bind,
      port: config.satellite.port,
      devices: new SatelliteDevices(stateDir!),
      log,
      welcome: (c) => ({ owner: nameOf(c.owner) }),
      onConnect: (conn) => {
        const key = `sat:${conn.device.id}`;
        const satMixer = new Mixer({ start: (s) => conn.playPcm(s), duckLevel: mc.duckLevel });
        const rm: Room = {
          key,
          mixer: satMixer,
          speaker: new Speaker(satMixer, router),
          music: makeMusic(satMixer),
          sound: soundPlayer(satMixer),
          place: () => ({ channelId: key }),
          ui: conn,
        };
        satRooms.set(key, rm);
        const ctl = makeController(rm);
        // Push-to-talk: the next thing heard is for her, no "Hey Adrian" needed.
        let pttUntil = 0;
        listenTo(conn, rm, ctl, () => {
          const on = performance.now() < pttUntil;
          pttUntil = 0;
          return on;
        });
        conn.on('ptt', () => (pttUntil = performance.now() + 15_000));
        conn.on('text', (text) => ctl.heard({ userId: conn.owner, text, woke: true, command: text }));
        conn.on('stop', () => {
          ctl.cancelAll();
          rm.sound.stop();
        });
        conn.on('closed', () => {
          ctl.cancelAll();
          rm.music?.stop();
          satMixer.stopAll();
          satRooms.delete(key);
        });
        // Their name for the prompt, even when they aren't in a voice channel.
        void client.users
          .fetch(conn.owner)
          .then(() => names.delete(conn.owner))
          .catch(() => undefined);
      },
    });
  }

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
      await satServer?.close();
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

/** Which privileged intents the bot's app has switched on in the Developer
 *  Portal (the verified or the under-100-servers flag). Asking for one that's
 *  off fails the login, so this is checked first. Any doubt counts as off. */
export async function privilegedIntents(
  token: string,
  log: { info(m: string, f?: object): void; warn(m: string, f?: object): void },
): Promise<{ messageContent: boolean; members: boolean; presences: boolean }> {
  try {
    const r = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const flags = Number(((await r.json()) as { flags?: number }).flags ?? 0);
    const on = (a: number, b: number) => (flags & ((1 << a) | (1 << b))) !== 0;
    const g = { presences: on(12, 13), members: on(14, 15), messageContent: on(18, 19) };
    log.info('privileged intents', g);
    return g;
  } catch (e) {
    log.warn('privileged intents check failed', { error: (e as Error).message });
    return { messageContent: false, members: false, presences: false };
  }
}
