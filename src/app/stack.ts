// The voice stack: wake → Parakeet → LLM (read-only tools, per-user memory)
// → Kokoro → Discord, streamed sentence by sentence, under the conversation
// controller's queue and interruption rules and the spend caps. Started by
// main.ts once the config is complete, and restarted by the admin UI.

import { Client, Events, GatewayIntentBits, Partials, type VoiceBasedChannel } from 'discord.js';
import { dateFormat } from '../core/time.js';
import { humansIn, registerVoiceCommands, type VoiceSpot } from './commands.js';
import prism from 'prism-media';
import { FallbackLlm } from '../brain/fallback.js';
import { ConversationOrchestrator, type OrchestratorOptions, type Usage } from '../brain/orchestrator.js';
import { OpenAiCompatibleLlm } from '../brain/openai-compatible.js';
import { AnthropicLlm } from '../brain/anthropic.js';
import { SessionMemory } from '../brain/sessions.js';
import { cachedTool, tavilySearchTool, timeTool, topResultUrl } from '../brain/tools.js';
import type { PocConfig } from '../config.js';
import { ConversationController, DEFAULT_CONTROLLER_OPTIONS } from '../conversation/controller.js';
import type { LlmProvider, Logger, Tool, UserId, VoiceTransport } from '../core/interfaces.js';
import { afterBareVerb, bareMusicVerb, classify, classifyMusic, isTimeQuestion, type PendingPlay } from '../conversation/intents.js';
import { RoomTalk } from '../conversation/room.js';
import { matureContext } from '../brain/mature.js';
import { LIMIT_MESSAGES, UsageLedger } from '../limits/usage-ledger.js';
import { routeTools } from '../brain/tool-router.js';
import { PartyGames } from '../features/games.js';
import { AutoMemory } from '../features/automemory.js';
import { gameServerTool, pingMinecraft } from '../features/gameservers.js';
import { HeadsUp } from '../features/headsup.js';
import { HelixClient } from '../features/helix.js';
import { ServerControl } from '../features/servercontrol.js';
import { mediaTools } from '../features/media.js';
import { Recap, weekdayIndex } from '../features/recap.js';
import { Steam, STEAM_KEY, steamTools } from '../features/steam.js';
import { UserNotes } from '../features/notes.js';
import { dueMessage, reminderRoute, Reminders } from '../features/reminders.js';
import { join } from 'node:path';
import { type ClosedBy, endsDangling, type HeardEvent, ListeningPipeline, type TurnOptions } from '../listen/pipeline.js';
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
import { registerTextChat, splitReply } from './textchat.js';
import { discordTools, RelayLimiter } from '../features/discordinfo.js';
import { MusicTaste } from '../features/taste.js';
import { deezerTopTracks, describe as trackName, ffmpegDecoder, MusicPlayer, musicRules, musicState, musicTools, PlexMusicSource, type MusicSource, whoAsked, YoutubeSource, YTM_API } from '../features/music.js';
import { modelJudge, type QuizRoom, Quizzes } from '../features/quiz.js';
import { linksLine, PLAY_THAT_LINK, RecentLinks } from '../features/links.js';
import { ParakeetStt } from '../speech/sherpa.js';
import { DiscordVoiceTransport } from '../transport/discord.js';
import { Speaker } from '../voice/speaker.js';
import { TextWakeDetector } from '../wake/text-wake.js';
import type { SatelliteConnection } from '../satellite/connection.js';
import { SatelliteDevices } from '../satellite/devices.js';
import { PcRecorder } from '../satellite/recorder.js';
import { startSatelliteServer } from '../satellite/server.js';
import { PC_RULE, pcTools, PowerDownWindow } from '../satellite/tools.js';
import { answerForLog, PRIVATE_TOOLS } from '../satellite/senses.js';
import { GameQuiet, gamingLine, HeldItems, reminderBrief, toldLine } from '../satellite/quiet.js';
import { pcDiscordTools, watchDiscord } from '../features/handoff-discord.js';
import { MusicStarts, notingStarts } from '../features/handoff.js';
import { toSpeakable } from '../brain/speech-text.js';

/** Starts like a request to play something or control the music. */
export const MUSICISH = /^\W*(?:(?:hey|ok(?:ay)?|yo|now|so|and|alright|bro)\W+)*(?:adri\w*\W+)?(?:(?:can|could|would|will) you (?:please )?|please )?(?:play|put on|throw on|queue|blast|bump|spin|skip|pause|resume|unpause|turn (?:up|down) the music|stop the music|(?:i want to|i wanna|let me|lemme|let's) (?:hear|listen to)|(?:make|do) (?:a|an|the|some) [a-z ]*(?:sound|noise))\b/i;
/** For the judge, when words without her name start like that. */
export const MUSIC_FOLLOW_UP = 'This starts like an order for your music or sounds. If it names something to hear or controls what you are playing, it is for you: do it. If it is about a game or for someone else ("play the objective", "skip this round"), it is not.';

export interface AnswerRecord {
  at: string;
  /** `discord`, or `sat:<id>` for a PC. */
  room: string;
  outcome: string;
  sttLatencyMs: number | null;
  /** The wait for the cloud's words: what a hold hadn't already covered. */
  groqMs: number | null;
  closedBy: ClosedBy | null;
  turnCheckMs: number | null;
  holdMs: number | null;
  llmFirstChunkMs: number | null;
  ttsFirstMs: number | null;
  /** From the end of their speech: the silence that closed the clip, any turn
   *  check and hold, and everything after. */
  speechEndToAudioMs: number | null;
  costUsd: number;
}

export interface VoiceStack {
  readonly ledger: UsageLedger;
  voiceReady(): boolean;
  /** Someone is in her voice call, or music is playing anywhere (no restarts now). */
  busy(): boolean;
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
  /** The voice channel the bot is in (or joining); undefined after /leave. */
  let spot: VoiceSpot | undefined = { guildId: config.guildId, channelId: config.channelId };
  /** stop() has run: what was still starting must not carry on. */
  let closing = false;
  /** Who set the bot up (optional): '' when not configured. */
  const creator = config.identity.creator ?? '';
  transport.on('disconnected', (r) => log.warn('voice disconnected', { reason: r }));
  transport.on('kicked', () => {
    spot = undefined;
    controller.cancelAll();
    music?.stop();
    mixer.stopAll();
  });
  transport.on('moved', (guildId, channelId) => {
    if (spot?.guildId === guildId) spot = { guildId, channelId };
  });
  transport.on('failed', (r) => log.error('voice failed', { reason: r }));

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
      ? new SpeechifyTts({ apiKey: cloudKey, voiceId: cv.voiceId, model: cv.model, timeoutMs: cv.timeoutMs, speed: cv.speed, budget: voiceBudget, log }, tts, voice.voice)
      : undefined;
  if (cloud) log.info('cloud voice', { provider: cv!.provider, voice: cv!.voiceId, usedChars: voiceBudget.used(), monthlyChars: cv!.monthlyChars });
  const CLOUD = 'cloud:en';
  const voiceFor = (lang: ReplyLang) => (lang === 'en' ? (cloud ? CLOUD : voice.voice) : lang === 'vi' && !piperVi ? voice.voice : LANGS[lang].voice);
  /** Said before a slow lookup when nothing else has been said yet. */
  const FILLERS = ['One sec.', 'Let me check.', 'On it.'];
  /** Said when a bot check has paused YouTube and Plex has nothing either. */
  const YOUTUBE_DOWN = "I can't reach YouTube right now.";
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
  if (mc.enabled && existsSync(ytdlp)) musicSources.push(new YoutubeSource({ ytdlp, node: process.execPath, searchApi: YTM_API }));
  const plexForMusic = secrets.get('PLEX_TOKEN');
  if (mc.enabled && mc.plexBackup && plexForMusic) musicSources.push(new PlexMusicSource({ url: config.media.plexUrl, token: plexForMusic }));
  const ffmpegOk = mc.enabled && spawnSync(mc.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
  const makeMusic = (out: Mixer, onPlayed?: (t: { title: string; artist?: string; kind?: string }) => void) =>
    ffmpegOk && musicSources.length ? new MusicPlayer({ sources: musicSources, output: out, decode: ffmpegDecoder(mc.ffmpeg), log, volume: mc.volume, maxQueue: mc.maxQueue, autoplay: mc.autoplay, ...(mc.topSongs ? { topTracks: deezerTopTracks() } : {}), ...(onPlayed ? { onPlayed } : {}) }) : undefined;
  // The call's songs count toward the weekly recap (not podcasts, not PCs).
  const music = makeMusic(mixer, (t) => t.kind !== 'podcast' && recap.played(t.title, t.artist));
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
    /** How she sounds here: "talk quieter" at a PC leaves the call as it was. */
    speech: { voice: string; speed: number; volume: number };
    music: MusicPlayer | undefined;
    sound: ReturnType<typeof soundPlayer>;
    /** What tools and room talk see: the voice channel, or `sat:<id>` for a PC. */
    place(): { guildId?: string; channelId?: string };
    /** The PC's window, for satellites. */
    ui?: SatelliteConnection;
    /** Its conversation, for what she says unprompted at a PC. */
    ctl?: ConversationController;
  }
  const defaultSpeech = () => ({ voice: voiceFor('en'), speed: voice.speed, volume: config.playbackVolume });
  const discordRoom: Room = {
    key: 'discord',
    mixer,
    speaker,
    speech: defaultSpeech(),
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
  const power = new PowerDownWindow();
  // Quiet while gaming (satellite/quiet.ts): a PC in a game keeps reminders for after the match.
  const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  const quiet = new GameQuiet(new HeldItems(satEnabled ? join(stateDir!, 'held-while-gaming.json') : undefined), {
    enabled: () => config.satellite.quietWhileGaming,
    pcs: () => satServer?.connections() ?? [],
    sayAt: (pc, owner, text) => {
      if (inHerCall(owner)) return controller.announce(owner, `${nameOf(owner)}, ${lowerFirst(text)}`);
      const rm = satRooms.get(`sat:${pc.device.id}`);
      if (!rm?.ctl) return Promise.resolve(false);
      rm.ui?.transcript('her', text);
      return rm.ctl.announce(owner, text);
    },
    elsewhere: async (owner, items, text) => {
      if (transport.isReady() && inHerChannel(owner) && (await controller.announce(owner, `${nameOf(owner)}, ${lowerFirst(text)}`))) return;
      const unsent = items.filter((i) => !i.dmSent);
      if (unsent.length) await client.users.send(owner, `While you were playing:\n${unsent.map((i) => i.line.trim()).join('\n')}`).catch((e: Error) => log.warn('held items DM failed', { user: owner, error: e.message }));
    },
    // A held reminder's own DM, sent when it's released.
    dm: (owner, text) =>
      client.users.send(owner, text).then(
        () => true,
        (e: Error) => (log.warn('reminder DM failed', { user: owner, error: e.message }), false),
      ),
    log: (event, fields) => log.info(event, fields),
  });
  /** A stop also calls off their restart or shutdown, if one is counting down. */
  const callOff = (id: UserId, ctl: ConversationController) => void power.cancel(id).then((line) => line && void ctl.announce(id, line));
  /** The room a request came from (tools get it through their context). */
  const roomFor = (ctx: { channelId?: string | undefined }): Room => (ctx.channelId && satRooms.get(ctx.channelId)) || discordRoom;
  /** Text chat reaches the same tools from anywhere, DMs included. A room's music
   *  and sounds are for the people in it, and owners. */
  const inRoomOnly = (t: Tool): Tool => ({
    ...t,
    run: async (a, signal, ctx) => {
      const rm = roomFor(ctx);
      const inRoom = isOwner(ctx.userId) || (rm.ui ? rm.ui.owner === ctx.userId : !!inHerChannel(ctx.userId));
      // Thrown, so the model says why: a sound's success ends the turn in silence.
      if (!inRoom && (typeof t.acts === 'function' ? t.acts(a) : t.acts)) throw new Error('Only people in the voice call can do that.');
      return t.run(a, signal, ctx);
    },
  });
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
  /** Whisper and the other languages' voices load the first time someone speaks
   *  another language, not at start: together they held about 1.3 GB, unused for
   *  weeks, on a server whose memory guard kills the bot first when it runs out. */
  let whisper: Promise<WhisperStt | undefined> | undefined;
  const languagesOn = !!config.languages && existsSync(join(whisperDir, 'small-encoder.int8.onnx'));
  const whisperFor = () =>
    (whisper ??= WhisperStt.load({ modelDir: whisperDir, threads: listen.asrThreads }).then(
      (w) => (log.info('whisper loaded', { languages: Object.keys(LANGS) }), w),
      (e: Error) => (log.warn('whisper failed to load; English only', { error: e.message }), undefined),
    ));
  /** Language each person last spoke to the bot in. */
  const userLang = new Map<UserId, ReplyLang>();
  // Native @discordjs/opus when its prebuild matches this glibc, else opusscript (WebAssembly).
  new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 }).destroy(); // loads the module
  log.info('opus', { module: prism.opus.Encoder.type });

  // --- timers, notes, games -----------------------------------------------

  // Resolving takes it off the list, so it only does once someone could have got it.
  const reminders = new Reminders(stateDir ? join(stateDir, 'reminders.json') : undefined, config.timezone, async (r, lateMs) => {
    const text = dueMessage(r, lateMs);
    // Said at a PC or sent: without the name, which only the call needs.
    const plain = text.replace(/^[^,]+, /, '');
    const pc = r.room ? satRooms.get(r.room) : undefined;
    const route = reminderRoute({ audibleInCall: inHerCall(r.userId), inChannel: transport.isReady() && !!inHerChannel(r.userId), pcUp: !!pc?.ctl });
    // In a game at that PC, a reminder waits for the end of the match, and so
    // does its DM (a Discord notification would pop up over the game): it goes
    // when the reminder is released, worded as it was due. A timer, set to
    // ring, doesn't wait. A full hold list says it now instead.
    const holding =
      route.speak === 'pc' &&
      r.kind === 'reminder' &&
      quiet.playingAt(pc!.ui!) &&
      quiet.hold(pc!.ui!, { kind: 'reminder', line: dueMessage(r, 0).replace(/^[^,]+, /, ''), brief: reminderBrief(r.text), dmSent: !route.dm, ...(route.dm ? { dm: plain } : {}) });
    log.info('reminder due', { user: r.userId, kind: r.kind, lateMs, route: holding ? 'held' : (route.speak ?? 'dm') });
    if (holding) return;
    const dm = route.dm
      ? client.users.send(r.userId, plain).then(
          () => true,
          (e: Error) => {
            log.warn('reminder DM failed', { user: r.userId, error: e.message });
            return false;
          },
        )
      : Promise.resolve(false);
    if (route.speak === 'pc') pc!.ui?.transcript('her', plain);
    const heard = route.speak === 'call' ? controller.announce(r.userId, text) : route.speak === 'pc' ? pc!.ctl!.announce(r.userId, plain) : Promise.resolve(false);
    // Any way through counts: at a PC the DM is the record, so a dropped announcement isn't retried.
    if (!(await dm) && !(await heard)) throw new Error('reminder not delivered');
  });
  const notes = new UserNotes(stateDir ? join(stateDir, 'notes.json') : undefined);
  const taste = new MusicTaste(stateDir ? join(stateDir, 'music-taste.json') : undefined, Date.now, (id) => isOwner(id));
  /** Playable links pasted in chat, for "play that link" (memory only). */
  const links = new RecentLinks();
  /** Links and media per person, and who started the music, for the PC handoff (memory only). */
  const watch = watchDiscord(client, { readable: readChannels, allowedGuilds: config.allowedGuilds, keepMs: config.handoff.keepMinutes * 60_000 });
  const musicStarts = new MusicStarts();
  const games = new PartyGames();
  const room = new RoomTalk();

  // --- heads-ups on joining, the weekly recap (features/headsup.ts, recap.ts) --
  const digestSources = {
    media: {
      ...(secrets.get('PLEX_TOKEN') ? { plex: { url: config.media.plexUrl, token: secrets.get('PLEX_TOKEN')! } } : {}),
      ...(secrets.get('SONARR_API_KEY') ? { sonarr: { url: config.media.sonarrUrl, apiKey: secrets.get('SONARR_API_KEY')! } } : {}),
      ...(secrets.get('RADARR_API_KEY') ? { radarr: { url: config.media.radarrUrl, apiKey: secrets.get('RADARR_API_KEY')! } } : {}),
      timezone: config.timezone,
    },
    servers: config.gameServers,
    ping: (host: string, port: number) => pingMinecraft(host, port),
  };
  /** Who's talking in the call (a stream that never ended counts for 20 s at most), for "is it quiet?". */
  const talking = new Map<UserId, number>();
  let lastTalkAt = -Infinity;
  transport.on('speechStart', (id) => void (talking.set(id, performance.now()), (lastTalkAt = performance.now())));
  transport.on('speechEnd', (id) => void (talking.delete(id), (lastTalkAt = performance.now())));
  const callQuiet = () => {
    const now = performance.now();
    for (const [id, at] of talking) if (now - at > 20_000) talking.delete(id);
    return talking.size === 0 && now - lastTalkAt > 4_000 && !music?.nowPlaying && !controller.busy && controller.queued === 0;
  };
  const headsUp = new HeadsUp(stateDir ? join(stateDir, 'heads-up.json') : undefined, config.headsUp, {
    sources: digestSources,
    timezone: config.timezone,
    isOwner: (id) => isOwner(id),
    // Muted is fine; deafened can't hear it.
    audible: (id) => transport.isReady() && !!inHerChannel(id) && !inHerChannel(id)!.deaf,
    quiet: callQuiet,
    name: (id) => config.nicknames[id] ?? nameOf(id),
    say: async (id, line) => {
      const heard = await controller.announce(id, line);
      if (heard && spot) room.add(spot.channelId, 'bot', `You (heads-up for ${nameOf(id)})`, line);
      return heard;
    },
    log,
  });
  /** People in her call (not bots). Right after she joins or moves, nobody there is arriving. */
  const humansHere = () => {
    const ch = spot ? client.channels.cache.get(spot.channelId) : undefined;
    return new Set(ch?.isVoiceBased() ? [...ch.members.values()].filter((m) => !m.user.bot).map((m) => m.id) : []);
  };
  let membersKnown = false;
  transport.on('membersChanged', (ids) => {
    headsUp.members(new Set([...ids].filter((id) => !client.users.cache.get(id)?.bot)), !membersKnown || !transport.isReady());
    membersKnown = true;
  });
  transport.on('ready', () => void (headsUp.members(humansHere(), true), (membersKnown = true)));
  transport.on('moved', () => void (headsUp.left(), headsUp.members(humansHere(), true)));
  transport.on('kicked', () => void (headsUp.left(), (membersKnown = false)));
  const rc = config.recap;
  if (rc.enabled && !rc.channelId) log.warn('weekly recap needs recap.channelId; it stays off');
  const recap = new Recap(
    stateDir ? join(stateDir, 'weekly-recap.json') : undefined,
    { enabled: rc.enabled && !!rc.channelId, timezone: config.timezone, day: weekdayIndex(rc.day), hour: rc.hour },
    {
      sources: digestSources,
      post: async (content) => {
        const ch = await client.channels.fetch(rc.channelId!);
        if (!ch?.isSendable()) throw new Error('the recap channel is not a text channel the bot can post in');
        for (const part of splitReply(content)) await ch.send({ content: part, allowedMentions: { parse: [] } });
      },
      nameOf: (id) => config.nicknames[id] ?? nameOf(id),
      named: (id) => headsUp.named(id),
      isOwner: (id) => isOwner(id),
      log,
    },
  );
  // --- music quiz: one per room, its clips through the room's music player ---
  const quizTops = mc.topSongs ? deezerTopTracks() : undefined;
  const quizzes = new Quizzes({ settings: mc.quiz, log, sources: (r) => ({ ...(ytForSounds ? { yt: ytForSounds } : {}), ...(quizTops ? { topTracks: quizTops } : {}), recent: () => r.music.recent, log }) });
  /** A room as the quiz sees it: it speaks there like a timer going off. */
  const quizRoom = (rm: Room): QuizRoom | undefined =>
    rm.music && {
      key: rm.key,
      music: rm.music,
      say: async (text, to) => {
        if (rm.ui ? !rm.ui.isReady() : !transport.isReady()) return;
        rm.ui?.transcript('her', text);
        await (rm.ctl ?? controller).announce(to, text, { listen: false });
      },
      people: () => (rm.ui ? Number(rm.ui.isReady()) : spot && transport.isReady() ? humansIn(client.channels.cache.get(spot.channelId) as VoiceBasedChannel | undefined) : 0),
      nameOf: (id) => (nameOf(id) === 'someone' ? undefined : nameOf(id)),
    };
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
  let dmOrchestrator: ConversationOrchestrator | undefined;
  let autoMemory: AutoMemory | undefined;
  /** People whose answer being made read their clipboard or screen: the
   *  transcript log keeps only its length (cleared when it's logged). */
  const privateTurns = new Set<UserId>();
  const brain = config.brain;
  if (brain) {
    const apiKey = brain.apiKeySecret ? secrets.get(brain.apiKeySecret) : undefined;
    if (brain.apiKeySecret && !apiKey) {
      log.warn('LLM key missing; answering with a setup notice', { secret: brain.apiKeySecret });
    } else {
      const tools: Tool[] = [timeTool(config.timezone)];
      const searchKey = brain.search ? secrets.get(brain.search.apiKeySecret) : undefined;
      if (searchKey) tools.push(tavilySearchTool(searchKey, brain.search?.maxResults));
      tools.push(...reminders.tools((id) => (userLang.get(id) ?? 'en') === 'en'), ...notes.tools((id) => (userLang.get(id) ?? 'en') === 'en'), ...games.tools());
      if (music) tools.push(...musicTools((ctx) => roomFor(ctx).music, taste, (id) => (userLang.get(id) ?? 'en') === 'en').map((t) => inRoomOnly(notingStarts(t, musicStarts, (ctx) => roomFor(ctx).key))), ...taste.tools(), inRoomOnly(quizzes.tool((ctx) => quizRoom(roomFor(ctx)))));
      if (sounds) tools.push(inRoomOnly(soundTool(sounds)));
      if (satEnabled)
        tools.push(
          ...pcTools({
            pcFor,
            onPowerDown: (id, pc) => power.started(id, pc),
            onPowerCancelled: (id, pc) => power.calledOff(id, pc),
            ...(ytForSounds ? { findVideo: (q: string, signal: AbortSignal) => ytForSounds.videoId(q, signal) } : {}),
            ...(searchKey ? { findUrl: (q: string, signal: AbortSignal) => topResultUrl(searchKey, q, signal) } : {}),
            onCall: (name, args, result, ctx) => {
              if (ctx && PRIVATE_TOOLS.has(name)) privateTurns.add(ctx.userId);
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
      // Between a PC and Discord, and game nights (features/handoff.ts, gamenight.ts).
      const pcDiscord = pcDiscordTools({
        client,
        watch,
        allowedGuilds: config.allowedGuilds,
        homeGuild: config.guildId,
        presences: seePresences,
        readable: readChannels,
        handoff: satEnabled && config.handoff.enabled,
        tellCall: config.handoff.enabled ? config.handoff.tellCall : undefined,
        gameNight: config.gameNight,
        stateFile: stateDir ? join(stateDir, 'game-night.json') : undefined,
        starts: musicStarts,
        callRoom: discordRoom.key,
        pcFor,
        callMusic: () => discordRoom.music,
        spot: () => spot,
        voiceReady: () => transport.isReady(),
        isOwner: (id) => isOwner(id),
        inHerCall: (id) => inHerCall(id),
        nameOf: (id) => (creator && isCreator(id) ? creator : (config.nicknames[id] ?? nameOf(id))),
        announce: (id, text) => controller.announce(id, text),
        speakable: (text) => toSpeakable(text, 'A.D.R.I.A.N.', 'Adrian', creator ? [[creator, config.identity.creatorSpoken ?? creator]] : []),
        ...(ytForSounds ? { findVideo: (q: string, signal: AbortSignal) => ytForSounds.videoId(q, signal) } : {}),
      });
      tools.push(...pcDiscord.tools);
      // Read-only lookups are reused briefly: asking twice in a row doesn't wait again.
      // With Helix set up, the status knows starting, stopped and crashed, and
      // linked servers can be started, stopped, restarted, whitelisted and messaged.
      if (config.gameServers.length && config.helix) {
        const hx = config.helix;
        const helixToken = secrets.get('HELIX_TOKEN');
        const control = new ServerControl({
          servers: config.gameServers,
          client: helixToken ? new HelixClient({ url: hx.url, token: helixToken }) : undefined,
          settings: hx,
          isOwner: (id) => isOwner(id),
          hasRole: (id, guildId, roleIds) => !!client.guilds.cache.get(guildId ?? spot?.guildId ?? config.guildId)?.members.cache.get(id)?.roles.cache.some((r) => roleIds.includes(r.id)),
          // Said where they asked: at their PC, in the call, in that chat, else by DM.
          announce: async (to, text) => {
            const pc = to.channelId ? satRooms.get(to.channelId) : undefined;
            if (pc?.ctl) {
              pc.ui?.transcript('her', text);
              return pc.ctl.announce(to.userId, text);
            }
            if (inHerCall(to.userId)) return controller.announce(to.userId, `${to.speaker}, ${text}`);
            const ch = to.channelId ? client.channels.cache.get(to.channelId) : undefined;
            if (ch && ch.isTextBased() && !ch.isVoiceBased() && 'send' in ch) return ch.send({ content: text, allowedMentions: { parse: [] } });
            return client.users.send(to.userId, text);
          },
          log,
        });
        tools.push(...control.tools());
        void control.check();
      } else if (config.gameServers.length) tools.push(cachedTool(gameServerTool(config.gameServers), 30_000));
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
      // Steam: its own short caches; failures aren't kept, so a retry really retries.
      if (config.steam.enabled)
        tools.push(...steamTools(new Steam({ ...config.steam, apiKey: secrets.get(STEAM_KEY), nameOf: (id) => nameOf(id), timezone: config.timezone })));
      tools.push(...headsUp.tools((id) => (userLang.get(id) ?? 'en') === 'en'), ...recap.tools());
      // Claude through its own SDK, anything else through the OpenAI-compatible adapter.
      const makeLlm = (p: { provider: 'openai' | 'anthropic'; baseUrl: string; model: string; effort: 'low' | 'medium' | 'high'; extraBody?: Record<string, unknown> | undefined }, key?: string): LlmProvider =>
        p.provider === 'anthropic'
          ? new AnthropicLlm({ model: p.model, apiKey: key ?? '', effort: p.effort })
          : new OpenAiCompatibleLlm({ baseUrl: p.baseUrl, model: p.model, ...(key ? { apiKey: key } : {}), ...(p.extraBody ? { extraBody: p.extraBody } : {}) });
      let llm: LlmProvider = makeLlm(brain, apiKey);
      const fb = brain.fallback;
      const fbKey = fb?.apiKeySecret ? secrets.get(fb.apiKeySecret) : undefined;
      const fbUsable = !!fb && (!fb.apiKeySecret || !!fbKey);
      if (fb && !fbUsable) log.warn('fallback model has no key; running without it', { secret: fb.apiKeySecret });
      if (fb && fbUsable) {
        llm = new FallbackLlm(
          llm,
          makeLlm(fb, fbKey),
          (err) => log.warn('primary LLM failed; using fallback', { error: err.message.slice(0, 200), fallback: fb.model }),
          // Well inside the answer's own first-event limit, so a primary that
          // hangs leaves the fallback time to answer. Much lower risks needless
          // switches: Claude's tool rounds send nothing until they're finished.
          Math.round(brain.firstEventTimeoutMs * 0.6),
        );
      }
      if (config.autoMemory) {
        autoMemory = new AutoMemory(llm, notes, sessions, log, (inTok, outTok) =>
          ledger.addCost((inTok * brain.priceInPerM + outTok * brain.priceOutPerM) / 1e6),
        );
      }
      quizzes.useJudge(modelJudge(llm, (inTok, outTok) => ledger.addCost((inTok * brain.priceInPerM + outTok * brain.priceOutPerM) / 1e6)));
      const brainOptions: OrchestratorOptions = {
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
          ...notes.context(ctx.userId, ctx.speaker, ctx),
          ...headsUp.context(ctx.userId, ctx.speaker),
          ...games.context(ctx),
          ...(roomFor(ctx).music ? [musicState(roomFor(ctx).music!), ...quizzes.context(roomFor(ctx).key), ...linksLine(links.forPrompt(ctx.userId, ctx.guildId)), ...taste.context(ctx.userId, ctx.speaker)] : []),
          ...(roomFor(ctx).ui ? [`${ctx.speaker} is talking to you through their PC (A.D.R.I.A.N. satellite), not in the Discord call. Music and sounds play on that PC.`] : []),
          ...(roomFor(ctx).ui && quiet.playingAt(roomFor(ctx).ui!) ? [gamingLine(ctx.speaker, quiet.gameAt(roomFor(ctx).ui!))] : []),
          ...(satEnabled ? toldLine(ctx.speaker, quiet.told(ctx.userId)) : []),
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
          ...pcDiscord.rules,
        ],
      };
      orchestrator = new ConversationOrchestrator(llm, sessions, tools, brainOptions);
      dmOrchestrator = new ConversationOrchestrator(llm, sessions.dms(), tools, brainOptions);
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

  /** Timing of each user's latest transcript, for the latency log line. */
  const lastHeard = new Map<
    UserId,
    {
      segmentClosedAt: number;
      sttLatencyMs: number;
      vadClosedAt: number | undefined;
      closedBy: ClosedBy | undefined;
      turnCheckMs: number | undefined;
      holdMs: number | undefined;
      groqMs: number | undefined;
    }
  >();
  const answers: AnswerRecord[] = [];

  /** What was last said to each user, for "say that again". */
  const lastSpoken = new Map<UserId, string>();

  /** After a bare "play": what it's waiting for, per room and person. */
  const pendingPlay = new Map<string, PendingPlay>();

  /** What local() may still answer for words without her name. Anything that
   *  acts might be meant for someone else, so that's the model's to judge. These
   *  change nothing, and every "okay" going to the model would cost a call. */
  const CHANGES_NOTHING = new Set<string | undefined>(['ack', 'thanks', 'bye']);

  /** Everyday phrases answered locally (no model call, no cost). True if handled. */
  async function local(rm: Room, userId: UserId, command: string, signal: AbortSignal, onWorking?: (on: boolean) => void): Promise<boolean> {
    const qr = quizRoom(rm);
    if (qr && (await quizzes.local(qr, userId, command))) return true;
    if (rm.music && (await localMusic(rm, userId, command, signal, onWorking))) return true;
    if (isTimeQuestion(command)) {
      const t = dateFormat('en-US', { timeZone: config.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date());
      await rm.speaker.speak(fixed(`It's ${t}.`), rm.speech, signal);
      return true;
    }
    const intent = classify(command);
    if (!intent) return false;
    const say = (t: string) => rm.speaker.speak(fixed(t), rm.speech, signal);
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
        await rm.speaker.speak(fixed(last ?? "I haven't said anything yet."), rm.speech, signal);
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
        const v = rm.speech.volume;
        // Volume 1.0 is the −16 LUFS target; never above it.
        rm.speech.volume = Math.min(1, Math.max(0.25, Number((v * (intent.dir > 0 ? 1.3 : 0.75)).toFixed(2))));
        log.info('volume', { from: v, to: rm.speech.volume, by: userId, room: rm.key });
        await say(rm.speech.volume === v ? (intent.dir > 0 ? "That's as loud as I go." : "That's as quiet as I go.") : intent.dir > 0 ? 'Okay, louder.' : 'Okay, quieter.');
        return true;
      }
      case 'speed': {
        const s = rm.speech.speed;
        rm.speech.speed = Math.min(1.25, Math.max(0.8, Number((s + intent.dir * 0.1).toFixed(2))));
        log.info('speed', { from: s, to: rm.speech.speed, by: userId, room: rm.key });
        await say(rm.speech.speed === s ? "That's my limit." : intent.dir > 0 ? 'Okay, a bit faster.' : 'Okay, a bit slower.');
        return true;
      }
      default:
        return false; // stop/name are the controller's job
    }
  }

  /** "play X", "skip", "pause"...: answered without the model. */
  async function localMusic(rm: Room, userId: UserId, command: string, signal: AbortSignal, onWorking?: (on: boolean) => void): Promise<boolean> {
    if (rm.music && PLAY_THAT_LINK.test(command)) return playPastedLink(rm, userId, command, signal);
    const m = classifyMusic(command);
    const music = rm.music;
    if (!m || !music) return false;
    // At a PC, "pause", "skip" and "what's playing" mean whatever the PC is
    // playing (Spotify, a video) unless her own music is on: the model's PC
    // tools handle that.
    if (rm.ui && m.kind !== 'play' && !music.nowPlaying) return false;
    const say = (t: string) => rm.speaker.speak(fixed(t), rm.speech, signal);
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
      const fillerTimer = setTimeout(() => (filler = say('On it.').catch(() => undefined)), 900);
      onWorking?.(true);
      const r = await music
        .playNamed(m.query, m.mode, signal, m.source, nameOf(userId))
        .catch((e: Error) => ({ ok: false as const, message: signal.aborted ? '' : (log.warn('music failed', { error: e.message }), "I couldn't play that.") }))
        .finally(() => {
          clearTimeout(fillerTimer);
          onWorking?.(false);
        });
      await filler;
      if (signal.aborted) return true;
      if (!r.ok) {
        await say(r.message);
        return true;
      }
      const artist = r.artist ?? (r.started ?? r.queuedAs?.track)?.artist;
      if (artist) taste.played(userId, artist);
      if (r.started) musicStarts.started(rm.key, userId);
      // The music starting is the answer; a queued song has no such signal.
      if (r.queuedAs) await say(`Added ${trackName(r.queuedAs.track)}.`);
      else if (r.artist && !r.started) await say(`Added ${r.artist}.`);
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
      case 'back': {
        onWorking?.(true);
        const b = await music
          .back(signal)
          .catch(() => undefined)
          .finally(() => onWorking?.(false));
        if (b === false) await say("Nothing played before this one.");
        else if (!b && !signal.aborted) await say("I couldn't play that one again.");
        return true;
      }
      case 'who':
        await say(whoAsked(music));
        return true;
      case 'volume': {
        const to = music.setVolume(m.level / 100);
        log.info('music volume', { to, by: userId });
        return true;
      }
      case 'skip': {
        // The next song may need a lookup, and the skip can't be taken back.
        onWorking?.(true);
        const n = await music
          .skip(signal)
          .catch(() => undefined)
          .finally(() => onWorking?.(false));
        if (!n) await say(n === false ? "Nothing's playing." : music.youtubePaused ? YOUTUBE_DOWN : "That's the end of the queue.");
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
    const say = (t: string) => rm.speaker.speak(fixed(t), rm.speech, signal);
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
    else if (!r.started) await say(`Added ${r.added === 1 ? 'it' : `${r.added} songs`} to the queue.`);
    else musicStarts.started(rm.key, userId);
    return true;
  }

  async function respond(rm: Room, userId: UserId, command: string, outer: AbortSignal, followUp = false, onSpeaking?: () => void, onWorking?: (on: boolean) => void): Promise<void | 'silent' | 'done' | 'asked'> {
    const waitKey = `${rm.key}:${userId}`;
    const waiting = pendingPlay.get(waitKey);
    pendingPlay.delete(waitKey);
    // With her name it's a new order of its own, not the answer to "Who?".
    const order = afterBareVerb(followUp ? waiting : undefined, command, Date.now());
    if (order !== command) {
      command = order;
      followUp = false; // she asked, so it's for her
    }
    const verb = rm.music && !followUp ? bareMusicVerb(command) : undefined;
    if (verb) {
      if (rm.music!.resume()) return 'done';
      pendingPlay.set(waitKey, { verb, until: Date.now() + 20_000 });
      await rm.speaker.speak(fixed('Who do you want to hear?'), rm.speech, outer);
      return; // the follow-up stays open for the answer
    }
    if ((!followUp || CHANGES_NOTHING.has(classify(command)?.kind)) && (await local(rm, userId, command, outer, onWorking))) return 'done';
    const musicish = rm.music !== undefined && MUSICISH.test(command);
    let silent = false;
    /** A tool did something (played music, opened an app): an order, not a chat. */
    let acted = false;
    /** A tool is waiting on their answer ("Restart the PC?"). */
    let asked = false;
    let saidAll = '';
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
    /** Resolves when the model has let go: by then its spend and its turn are in. */
    let modelDone: Promise<void> = Promise.resolve();
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
      let finished!: () => void;
      modelDone = new Promise((r) => (finished = r));
      const gen = orchestrator.ask(userId, nameOf(userId), question, signal, (u) => (usage = u), rm.place(), {
        followUp,
        ...(rm.ui ? { desk: true } : {}),
        ...(followUp && musicish ? { extra: [MUSIC_FOLLOW_UP] } : {}),
        onSilent: () => (silent = true),
        onActed: () => (acted = true),
        onAsked: () => (asked = true),
        ...(onWorking ? { onWorking } : {}),
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
          finished();
          clearTimeout(genTimer);
          if (said.length) {
            saidAll = said.join(' ');
            lastSpoken.set(userId, said.join(' '));
            const pl = rm.place();
            if (pl.channelId) room.add(pl.channelId, 'bot', `You (answering ${nameOf(userId)})`, said.join(' '));
            rm.ui?.transcript('her', said.join(' '));
            const privateTurn = privateTurns.delete(userId);
            if (rm.ui && config.satellite.logTranscripts) log.info('pc answer', { room: rm.key, asked: command.slice(0, 300), ...answerForLog(said.join(' '), privateTurn) });
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
      r = await rm.speaker.speak(source, { ...rm.speech, voice: voiceFor(userLang.get(userId) ?? 'en'), onFirstAudio: () => { firstAudioAt = performance.now(); onSpeaking?.(); } }, playSignal);
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
    // A stop can end her voice first: what the answer spent and the turn it
    // saved only exist once the model has let go, which a stop makes quick.
    await modelDone;
    const timedOut = genLimit.signal.aborted && !generated && !outer.aborted && !!failure;
    if (usage && autoMemory) autoMemory.afterTurn(userId, nameOf(userId));
    // Stopped or replaced mid-answer: the next turn must not pick it back up.
    // Nothing to mark if the model never ran, or stayed out of it (SILENT).
    if (outer.aborted && usage && !silent) sessions.markCutOff(userId);
    const cost = usage ? costUsd(usage) : 0;
    ledger.addCost(cost);
    const rec: AnswerRecord = {
      at: new Date().toISOString(),
      room: rm.key,
      outcome: outer.aborted ? 'interrupted' : timedOut ? 'timed out' : failure ? 'error' : r.outcome,
      sttLatencyMs: heard?.sttLatencyMs ?? null,
      groqMs: heard?.groqMs ?? null,
      closedBy: heard?.closedBy ?? null,
      turnCheckMs: heard?.turnCheckMs ?? null,
      holdMs: heard?.holdMs ?? null,
      llmFirstChunkMs: llmFirstMs ?? null,
      ttsFirstMs: r.synthMs[0] ?? null,
      // From the VAD's close, not the release, so a Smart Turn check and hold
      // count, plus the silence the room really waits out. Reads about 1 s above
      // the old figure at a PC: she isn't slower, the old one left those out.
      speechEndToAudioMs: firstAudioAt && heard ? Math.round(firstAudioAt - (heard.vadClosedAt ?? heard.segmentClosedAt) + endSilenceMs(rm, heard.closedBy)) : null,
      costUsd: Number(cost.toFixed(6)),
    };
    answers.push(rec);
    if (answers.length > 200) answers.shift();
    if (!silent && usage && firstAudioAt !== undefined) recap.answered(rm.ui ? 'pc' : 'call', userId);
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
    // Not what the judge left alone: that may be talk that was never for her.
    if (musicish && !outer.aborted && !silent && !usage?.toolCalls) log.warn('music asked but not played', { user: userId, text: command.slice(0, 120) });
    if (silent) return 'silent';
    // The model answered with nothing at all: say so rather than leave silence.
    if (!failure && !outer.aborted && firstAudioAt === undefined && generated && orchestrator && allowed.ok && !usage?.toolCalls) {
      await rm.speaker.speak(fixed("Sorry, I didn't get that. Could you say it again?"), rm.speech, playSignal).catch(() => undefined);
      return;
    }
    // Only when nothing was said: then the user should hear a short sorry.
    // A partial answer that was cut off just ends.
    if ((timedOut || failure) && !outer.aborted && firstAudioAt === undefined) throw failure ?? new Error('timed out');
    if (asked && !failure) return 'asked';
    // An order carried out, and she didn't ask anything back: the conversation is over.
    if (acted && !failure && !/\?\s*$/.test(saidAll)) return 'done';
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
        return await respond(rm, userId, command, signal, followUp, () => c.speaking(userId), (on) => c.working(userId, on));
      } finally {
        rm.ui?.mode('idle');
      }
    },
    say: async (text, signal) => {
      const limit = AbortSignal.timeout(15_000);
      await rm.speaker.speak(fixed(text), rm.speech, signal ? AbortSignal.any([signal, limit]) : limit);
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
      pendingPlay.delete(`${rm.key}:${id}`); // "never mind" after "Who do you want to hear?"
      if (isOwner(id) && config.ownerStopReply.trim()) void c.announce(id, config.ownerStopReply.trim());
    },
    isPriority: (id) => {
      const m = client.guilds.cache.get(spot?.guildId ?? config.guildId)?.members.cache.get(id);
      return !!m && m.roles.cache.some((r) => priorityRoles.has(r.id));
    },
    log: (event, fields) => log.info(event, rm.ui ? { ...fields, room: rm.key } : fields),
    // The PC shows "listening" only while she'd really take words without her name.
    ...(rm.ui
      ? {
          listenChanged: (id?: UserId) => {
            const owner = rm.ui!.owner;
            if (id === undefined || id === owner) rm.ui!.state({ listenMs: c.listenLeftMs(owner) });
          },
          // In a game there: only her name starts a turn.
          quiet: () => quiet.playingAt(rm.ui!),
        }
      : {}),
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
  /** What a PC room's VAD waits for: a pause mid-sentence shouldn't split it in two. */
  const pcSilence = Math.max(listen.minSilence, 0.8);
  /** The silence a clip ended on before it closed, ms. */
  const endSilenceMs = (rm: Room, closedBy: ClosedBy | undefined) => (rm.ui ? pcSilence * 1000 : closedBy === 'flush' ? config.silenceMs : listen.minSilence * 1000);
  const vad = {
    model: listen.vadModel,
    threshold: listen.vadThreshold,
    minSilence: listen.minSilence,
    minSpeech: listen.minSpeech,
    maxSpeech: listen.maxSpeech,
  };
  /** Their voice state, if they're in the voice channel she's in. */
  function inHerChannel(userId: UserId) {
    if (!spot) return undefined;
    const vs = client.guilds.cache.get(spot.guildId)?.voiceStates.cache.get(userId);
    return vs?.channelId === spot.channelId ? vs : undefined;
  }
  /** In the voice channel she's in, and audible there (not muted or deafened),
   *  with her voice link up: a dropped link leaves `spot` set but nobody answering. */
  function inHerCall(userId: UserId): boolean {
    const vs = inHerChannel(userId);
    return transport.isReady() && !!vs && !vs.mute && !vs.deaf;
  }
  /** Stops so far, per room and person. They skip the second listens, so one
   *  can overtake the question it's for: that question checks this before it goes on. */
  const stops = new Map<string, number>();
  const stopsFrom = (rm: Room, userId: UserId) => stops.get(`${rm.key}:${userId}`) ?? 0;
  const noteStop = (rm: Room, userId: UserId) => void stops.set(`${rm.key}:${userId}`, stopsFrom(rm, userId) + 1);
  /** Until when a person's words belong to their PC (push-to-talk). Her call
   *  hears the same words, sometimes first, and has to leave them alone. */
  const pcHasWords = new Map<UserId, number>();
  /** Listen to one room's audio. `direct()` true: the next thing heard is a question for her (push-to-talk).
   *  `pttOpen()` says the same without using it up. */
  function listenTo(source: VoiceTransport, rm: Room, ctl: ConversationController, direct?: () => boolean, pttOpen?: () => boolean): ListeningPipeline {
  /** The cloud's listen to held speech, by the clip it heard. A join makes a new clip, so it can't land on the wrong audio. */
  const early = new WeakMap<Float32Array, Promise<string | undefined>>();
  // Discord keeps the snappier default.
  const pipeline = rm.ui
    ? new ListeningPipeline(
        source,
        stt,
        wakeDetector,
        { ...vad, minSilence: pcSilence },
        turn && {
          ...turn,
          // Smart Turn doubts plenty of finished sentences. Nobody waits on speech
          // that isn't for her, and a sentence only waits if its words stop
          // mid-thought. Those words are only judged in English and Spanish, so
          // anything else keeps waiting, as all of it used to.
          shouldHold: (userId, text, seconds) => {
            const m = wakeDetector.matchLoose(text);
            if (!m.woke && !ctl.listeningTo(userId, performance.now() - seconds * 1000) && !pttOpen?.()) return false;
            const said = m.woke ? m.remainder : text;
            return !english.looksEnglish(said) || endsDangling(said);
          },
          // The wait is long enough for most of the cloud's listen: start it now.
          onHeldWords: (userId, { text, samples }) => {
            const m = wakeDetector.matchLoose(text);
            const said = m.woke ? m.remainder : text;
            const kind = classify(said)?.kind;
            const forHer = m.woke || ctl.listeningTo(userId, performance.now() - (samples.length / 16_000) * 1000);
            if (forHer && said.trim() && kind !== 'stop' && kind !== 'name' && cloudSttFor(rm, userId) && !inHerCall(userId)) early.set(samples, cloudListen(samples));
          },
        },
      )
    : new ListeningPipeline(source, stt, wakeDetector, vad);
  pipeline.on('heard', (e) => void heard(e).catch((err: Error) => log.warn('heard failed', { error: err.message })));
  async function heard(e: HeardEvent): Promise<void> {
    // Asking whether push-to-talk is on also uses it up, whatever was said.
    const ptt = direct?.() ?? false;
    if (!e.woke && ptt) e = { ...e, woke: true, command: e.text };
    const first = classify(e.woke ? e.command : e.text);
    const stop = first?.kind === 'stop';
    if (stop) noteStop(rm, e.userId);
    if (first?.kind === 'stop' && !first.weak) callOff(e.userId, ctl);
    // In her Discord call too: the call hears the same words, and that's
    // where a group wants her (music for everyone). The call answers; it can
    // still reach this PC through the PC tools. Push-to-talk and typing in
    // the window stay with the PC, and so does everything while muted there.
    // A stop isn't handed over: it's for whichever room she's talking in.
    if (!ptt && rm.ui && inHerCall(e.userId) && !(stop && ctl.busy)) {
      if (e.woke) {
        log.info('pc deferred to discord', { room: rm.key });
        rm.ui.transcript('her', 'Answering in the Discord call.');
      }
      return;
    }
    if (!rm.ui && !stop && (pcHasWords.get(e.userId) ?? 0) > performance.now()) return;
    // The windows are judged from when they started talking, not when the words land.
    const startedAt = (e.vadClosedAt ?? e.segmentClosedAt) - e.audioSeconds * 1000;
    const forBot = e.woke || ctl.listeningTo(e.userId, startedAt);
    const before = userLang.get(e.userId) ?? 'en';
    // Said to her: a second, more accurate listen in the cloud for the words
    // (the local model already decided it was for her). Stops and her name
    // alone don't need it.
    const stopsBefore = stopsFrom(rm, e.userId);
    const local = e.text;
    let cloud: string | undefined;
    let groqMs: number | undefined;
    if (forBot && e.samples && first?.kind !== 'stop' && first?.kind !== 'name' && (!e.woke || e.command.trim()) && cloudSttFor(rm, e.userId)) {
      const t0 = performance.now();
      const text = (cloud = await (early.get(e.samples) ?? cloudListen(e.samples)));
      groqMs = Math.round(performance.now() - t0);
      if (text) {
        const m = wakeDetector.matchLoose(text);
        const command = e.woke ? (m.woke ? m.remainder : stripWakeLead(text)) : '';
        if (config.satellite.logTranscripts && (rm.ui || hasPc(e.userId))) log.info('pc stt', { local: e.text, cloud: text, ms: groqMs });
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
      } else if (languagesOn && e.samples && (await whisperFor())) {
        const w = await (await whisperFor())!.transcribe(e.samples);
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
    // They said stop while this waited on a second listen: it's already cancelled.
    if (stopsFrom(rm, e.userId) !== stopsBefore) {
      log.info('stopped before it started', { user: e.userId });
      return;
    }
    // The PC went away while this waited: nothing could stop music started now.
    if (rm.ui && !rm.ui.isReady()) return;
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
        closedBy: e.closedBy,
        turnCheckMs: e.turnCheckMs,
        holdMs: e.holdMs,
        ...(e.loose ? { loose: true } : {}),
        // Side talk stays out of the log, even when transcripts are on.
        ...(config.satellite.logTranscripts && forBot ? { text: e.text } : {}),
      });
    // Data for tuning the end-of-speech wait: the same person talking again
    // right after their last segment closed may mean it was cut mid-sentence.
    const prev = lastHeard.get(e.userId);
    const gapMs = prev ? Math.round(e.segmentClosedAt - (e.audioSeconds ?? 0) * 1000 - prev.segmentClosedAt) : undefined;
    if (gapMs !== undefined && gapMs >= 0 && gapMs < 1_200) log.info('quick continuation', { user: e.userId, gapMs, woke: e.woke });
    lastHeard.set(e.userId, { segmentClosedAt: e.segmentClosedAt, sttLatencyMs: e.sttLatencyMs, vadClosedAt: e.vadClosedAt, closedBy: e.closedBy, turnCheckMs: e.turnCheckMs, holdMs: e.holdMs, groqMs });
    // A music quiz round is open: anyone's answer counts without her name.
    if (!e.woke && quizzes.heard(rm.key, e.userId, e.text)) return;
    if (e.woke) rm.mixer.duckFor(8_000);
    if (e.woke) log.info('wake', { user: e.userId, sttLatencyMs: e.sttLatencyMs, audioSeconds: e.audioSeconds, ...(e.loose ? { loose: true } : {}) });
    ctl.heard({ userId: e.userId, text: e.text, woke: e.woke, command: e.command, startedAt, ...(e.loose ? { loose: true } : {}) });
  }
  // Before the question reaches it: after a long quiet Speechify stalls on the first sentence.
  source.on('speechStart', () => void cloud?.warmIfIdle());
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
      if (spot?.guildId === to?.guildId && spot?.channelId === to?.channelId && transport.isReady()) return;
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
            const o = place.guildId ? orchestrator! : dmOrchestrator!;
            return (async function* () {
              let usage: Usage | undefined;
              let silent = false;
              try {
                yield* o.ask(userId, name, text, signal, (u) => (usage = u), place, {
                  text: true,
                  followUp: opts.followUp,
                  extra: opts.extra,
                  onActed: opts.onActed,
                  onSilent: () => {
                    silent = true;
                    opts.onSilent();
                  },
                });
              } finally {
                // Every model call counts toward the hourly limit, side talk she stayed
                // out of too: otherwise "adrian" in every message spends the shared
                // daily budget with no per-person check.
                ledger.noteRequest(userId);
                if (usage) ledger.addCost(costUsd(usage));
                if (usage && !silent) recap.answered('text', userId);
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
  const voiceCommands = registerVoiceCommands({ client, log, current: () => spot, voiceReady: () => transport.isReady(), moveTo: (s) => moveTo(s), leave: () => moveTo(undefined), allowedGuilds: config.allowedGuilds });
  // Outside the home channel, leave after 10 minutes with nobody else there.
  let emptySince: number | undefined;
  /** Since when music (or a quiz) has played to an empty call. */
  let unheardSince: number | undefined;
  const idleTimer = setInterval(() => {
    const away = spot && (spot.guildId !== config.guildId || spot.channelId !== config.channelId);
    const ch = spot ? (client.channels.cache.get(spot.channelId) as VoiceBasedChannel | undefined) : undefined;
    // Nobody left to hear it: after 2 minutes the music stops, autoplay with it.
    if ((music?.nowPlaying || quizzes.of(discordRoom.key)) && humansIn(ch) === 0) {
      unheardSince ??= Date.now();
      if (Date.now() - unheardSince >= 120_000) {
        unheardSince = undefined;
        quizzes.end(discordRoom.key);
        if (music?.stop()) log.info('music stopped', { how: 'empty call' });
      }
    } else unheardSince = undefined;
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
    // Dev check of the speech output path: SAY="text" speaks once on join.
    const say = process.env.SAY;
    if (say) {
      transport.once('ready', () => {
        const t0 = performance.now();
        void speaker
          .speak(fixed(say), discordRoom.speech, AbortSignal.timeout(20_000))
          .then((r) => log.info('said', { outcome: r.outcome, firstAudioMs: r.firstAudioMs, synthMs: r.synthMs, totalMs: Math.round(performance.now() - t0) }));
      });
    }
    try {
      await transport.connect(config.guildId, config.channelId);
    } catch (e) {
      log.error('voice connect failed', { error: (e as Error).message });
      transport.retry(); // /join reports its own failure; here nobody's waiting to hear it
    }
    // After the join, so one that came due while offline can be said in the call.
    if (!closing) reminders.start();
    if (!closing) recap.start();
  });

  // The manager tries again after a passing failure, every 30 s to 5 min, so a
  // failed login must leave nothing running or loaded. It reads this very error.
  try {
    await client.login(token);
  } catch (e) {
    clearInterval(idleTimer);
    throw e;
  }

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

  // --- PC satellites: each connected PC is a room of its own ----------------
  if (satEnabled) {
    // Held items from before a restart go out even if no PC comes back.
    quiet.start();
    satServer = startSatelliteServer({
      bind: config.satellite.bind,
      port: config.satellite.port,
      devices: new SatelliteDevices(stateDir!),
      log,
      welcome: (c) => ({ owner: nameOf(c.owner) }),
      onConnect: (conn) => {
        const key = `sat:${conn.device.id}`;
        // The PC gets music and voice as one stream: tell it which is which,
        // so talking only turns her voice down there, never the music.
        const satMixer = new Mixer({ start: (s) => conn.playPcm(s), duckLevel: mc.duckLevel, onVoice: (on) => conn.state({ speaking: on }) });
        const rm: Room = {
          key,
          mixer: satMixer,
          speaker: new Speaker(satMixer, router),
          speech: defaultSpeech(),
          music: makeMusic(satMixer),
          sound: soundPlayer(satMixer),
          place: () => ({ channelId: key }),
          ui: conn,
        };
        satRooms.set(key, rm);
        const ctl = makeController(rm);
        rm.ctl = ctl;
        // Push-to-talk: the next thing heard is for her, no "Hey Adrian" needed.
        let pttUntil = 0;
        listenTo(
          conn,
          rm,
          ctl,
          () => {
            const on = performance.now() < pttUntil;
            pttUntil = 0;
            // The call's copy of these words may still be on its way.
            if (on) pcHasWords.set(conn.owner, performance.now() + 3_000);
            return on;
          },
          () => performance.now() < pttUntil,
        );
        conn.on('ptt', () => {
          pttUntil = performance.now() + 15_000;
          pcHasWords.set(conn.owner, pttUntil);
        });
        conn.on('text', (text) => {
          if (classify(text)?.kind === 'stop') callOff(conn.owner, ctl);
          ctl.heard({ userId: conn.owner, text, woke: true, command: text });
        });
        conn.on('stop', () => {
          noteStop(rm, conn.owner);
          ctl.cancelAll();
          rm.sound.stop();
          callOff(conn.owner, ctl);
        });
        // In a game (PC apps from 0.15.6 say so): her name for every turn here, reminders kept for after.
        quiet.connected(conn);
        conn.on('activity', (a) => {
          if (quiet.activity(conn, a)) conn.state({ listenMs: ctl.listenLeftMs(conn.owner) });
        });
        conn.on('closed', () => {
          quiet.disconnected(conn);
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
    const lines = ['Yes?', 'Okay.', 'Who do you want to hear?', YOUTUBE_DOWN, ...FILLERS, ...config.ownerAck.map((a) => `${a.replace(/[.!]+$/, '')}?`), config.ownerStopReply.trim()].filter(Boolean);
    void (async () => {
      for (const l of new Set(lines)) await cloud.synthesize(l, { voice: CLOUD, speed: voice.speed }).catch(() => undefined);
      log.info('cloud voice ready', { cachedLines: lines.length, usedChars: voiceBudget.used() });
    })();
  }

  return {
    ledger,
    voiceReady: () => transport.isReady(),
    busy: () => {
      const ch = spot ? (client.channels.cache.get(spot.channelId) as VoiceBasedChannel | undefined) : undefined;
      const people = ch?.members.filter((m) => !m.user.bot).size ?? 0;
      return people > 0 || !!music?.nowPlaying || [...satRooms.values()].some((r) => !!r.music?.nowPlaying);
    },
    botTag: () => client.user?.tag,
    answers: () => answers,
    stop: async () => {
      closing = true;
      clearInterval(idleTimer);
      controller.cancelAll();
      reminders.stop();
      quiet.stop();
      recap.stop();
      headsUp.left();
      headsUp.flush();
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
