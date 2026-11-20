# Codebase map

Every directory and file in this repo: what it is for, what it exports, what must stay true, and which tests guard it. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first. Use this page when you need to find where something lives, or what you will break by changing it.

Facts here match version 0.17.1 (`package.json`) plus the changes merged after it on 2026-11-20 (faster PC answers, 2-thread recognition, lazy local voice, streamed cloud voice, the one-step installer; then the admin dashboard, the wake rules for talk about her, live facts looked up, the house guard tied to its object, and the music search fixes). Line counts are `wc -l` on that tree, taken 2026-11-20. Test counts are lines that start an `it(` / `it.each(` / `test(` call; rows of `it.each` expand at run time, so `npm test` reports more. Line references into `src/app/stack.ts` are approximate: search for the name.

Related pages: [architecture.md](architecture.md) (how a turn flows), [tools.md](tools.md) (every model tool), [configuration.md](configuration.md) (every config key), [satellite.md](satellite.md) (PC protocol), [development.md](development.md) (build, test, bench), [security.md](security.md), [costs.md](costs.md), [decisions.md](decisions.md), [roadmap.md](roadmap.md).

---

## At a glance

- TypeScript, strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`), ESM (`"type": "module"`, `NodeNext`), target ES2023. `tsc` compiles `src/` to `dist/` with source maps. No bundler, no framework.
- Node >= 22.12.0. Every runtime dependency is pinned to an exact version (see [package.json](#root-files)).
- One process, `node dist/app/main.js`, is at the same time:
  - the Discord bot (one voice call at a time, text chat, slash and typed commands),
  - the server for the Windows PC app ("satellite"): a WebSocket at `/satellite`, one room per connected PC,
  - the admin web UI (setup wizard and dashboard), on loopback by default.
- `src/`: 107 files, about 28,900 lines. `test/`: 91 files, about 1,925 test call sites. `bench/`: 69 scripts plus four data files.
- Checks: `npm run typecheck`, `npm test` (vitest; no network, models or keys needed), `npm run build`.

The PC app itself (Rust, Tauri 2) and its action library live in the main repo, [A.D.R.I.A.N](https://github.com/Riqqqque/A.D.R.I.A.N) (`crates/desktop`, `crates/pc-control`). That repo also holds an older Rust household server that is not what runs in production.

## Top-level layout

| Path | What it is | In the release bundle? |
|---|---|---|
| `src/` | All source. Compiled to `dist/`. | As `dist/` only |
| `test/` | vitest unit tests, one file per area | No (run by `package.sh` before it builds, then deleted) |
| `bench/` | Hand-run benches against real models and services | No |
| `packaging/` | Installer, `adrian` CLI, systemd units, Docker files, pinned downloads | Yes, except `package.sh` |
| `scripts/` | `patch-voice.mjs`, run by `npm ci` (postinstall) | Yes |
| `web/` | Admin UI frontend (plain JS, no build step) | Yes |
| `docs/` | These docs | No |
| `test-env/` | Container tests for the installer, updates and Docker mode | No |
| `assets/` | `test-clip.ogg`, used only by the proof-of-concept runner | No |
| root files | `package.json`, `package-lock.json`, `tsconfig.json`, `LICENSE` (MIT), `README.md`, `SECURITY.md`, `.gitattributes`, `.gitignore` | `package.json`, lockfile, `LICENSE`, `README.md` |

`.gitignore` keeps out `node_modules/`, `dist/`, `*.log`, `.env`, `secrets.env`, `/models/`, `/assets/*.raw.wav`, `/release/`, `/samples/`. Never commit a real `secrets.env`, a config with real Discord IDs, recordings, or model files.

## How the files connect

One spoken turn, file by file (full story in [architecture.md](architecture.md)):

1. Audio in: `transport/discord.ts` (one Opus stream per Discord user) or `satellite/connection.ts` (one PC mic).
2. `listen/pipeline.ts`: resample and Silero VAD (`speech/sherpa.ts`), Smart Turn hold at PCs (`speech/smart-turn.ts`), Parakeet ASR (`speech/sherpa.ts`), then the text wake check (`wake/text-wake.ts`).
3. `app/stack.ts` `heard()`: push-to-talk, alarm words (`features/alarms.ts`), PC-vs-call handover, Groq second listen (`speech/cloud-stt.ts`), language check and Whisper second pass (`speech/language.ts`, `speech/whisper.ts`), room talk (`conversation/room.ts`).
4. `conversation/controller.ts`: stops, follow-up windows, queue, owners, barge-in.
5. `app/stack.ts`: `local()` / `localMusic()` answer everyday phrases with no model call (`conversation/intents.ts`); everything else goes to `respond()`.
6. `brain/orchestrator.ts` with a provider (`brain/anthropic.ts`, `brain/openai-compatible.ts`, `brain/fallback.ts`) and tools from `brain/tools.ts`, `features/*` and `satellite/tools.ts`. Spend is checked and recorded in `limits/usage-ledger.ts`.
7. Text out: `brain/speech-text.ts` cuts sentences and makes them speakable.
8. `voice/speaker.ts` -> `speech/piper.ts` `VoiceRouter` (Speechify `speech/speechify.ts`, Kokoro `speech/kokoro.ts`, Piper) -> `voice/mixer.ts` -> back out through the transport.

---

## src/app: process entry and wiring

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `main.ts` | 114 | Process entry. Resolves paths (config from `argv[2]`, `ADRIAN_CONFIG`, else `/etc/adrian/config.json`; state `ADRIAN_STATE`, else `/var/lib/adrian`; models `ADRIAN_MODELS`, else `<state>/models`), creates the usage ledger, admin auth and `StackManager`, starts the admin server, installs the SIGINT/SIGTERM handlers (`shutdown.ts`) before it calls `stack.restart()`, passes the `/proc/meminfo` reader to the manager. Keeps a 12-entry cache for the wizard's voice preview. | (script) | through `web.test.ts`, `manager.test.ts` |
| `manager.ts` | 235 | Voice stack lifecycle: `setup`, `starting`, `running`, `failed`, `stopped`. Serialized restarts; retry with backoff (30 s doubling to 5 min) only for failures that can pass by themselves (`canRecover`: network codes, timeouts, HTTP 5xx). Plain-word setup problem list. One shared Parakeet and Kokoro instance across restarts (`SpeechModels`). On Linux a first start waits while memory is short (`LowMemoryError`, retried by the same backoff; after 15 min it loads anyway); a restart with the models already loaded skips the check. | `StackManager`, `StackState`, `SpeechModels`, `configProblems`, `canRecover` | `manager.test.ts` (14) |
| `local-voice.ts` | 41 | Whether Kokoro loads and calibrates at start (it is the English voice) or on first use (the cloud voice speaks English, so Kokoro only stands in). A missing Kokoro model is a warning when the cloud voice is primary. | `prepareLocalVoice`, `cloudVoicePrimary`, `LocalVoice` | `local-voice.test.ts` (5), `stack.test.ts` "the local voice at start" |
| `memory.ts` | 72 | Memory at start: `/proc/meminfo` parsing, the estimated need (1030 MB, 1550 MB with Kokoro at start), the rule that puts a first start off (available plus swap above earlyoom's floor, minus the need, under 6% of RAM), memory fields for the start log lines. | `rssMb`, `parseMemInfo`, `readMemInfo`, `memoryFields`, `startNeedMb`, `tooLittleMemory`, `LowMemoryError`, `MemInfo` | `memory.test.ts` (14) |
| `shutdown.ts` | 81 | Signal handling. Logs `shutting down` with the signal, state, uptime and memory. While `starting`, closes the admin UI, flushes the ledger and re-raises the signal (a model load can't be waited for); when running, a clean stop capped at 20 s; a second signal exits at once. | `shutdownOnSignal`, `reraise`, `ShutdownDeps` | `shutdown.test.ts` (9) |
| `stack.ts` | 1975 | Builds and wires the whole bot: speech, voices, mixer, music, rooms (the call and each PC), every feature, the tool list, the brain, the controller, listening, slash and typed commands, text chat, the satellite server. Owns owner rights, local answers, `respond()`, cost accounting, `busy()` and `stop()`. | `startVoiceStack`, `VoiceStack`, `AnswerRecord`, `privilegedIntents`, `MUSICISH`, `MUSIC_FOLLOW_UP` | `stack.test.ts` (170): the real `startVoiceStack` with fake Discord, listening, satellite server and HTTP |
| `commands.ts` | 170 | `/join`, `/leave`, seat rules (who may move her between calls), the app owner id fetched on ready. Registers every slash command in one call (Discord replaces the whole set). | `registerVoiceCommands`, `COMMANDS`, `humansIn`, `Seat`, `VoiceSpot`, `Asking`, `VoiceCommands`, `CommandDeps` | `commands.test.ts` (19) |
| `music-commands.ts` | 704 | `/play` (with autocomplete), `/music ...`, typed `!` commands, the now-playing card and its buttons, output escaping. | `registerMusicCommands`, `MUSIC_COMMANDS`, `PLAY_TYPES`, `parseTextCommand`, `textHelp`, `nowCard`, `queueCard`, `buttons`, `playedText`, `suggestions`, `safe`, `trackLine` | `music-commands.test.ts` (47) |
| `alarm-commands.ts` | 367 | `/alarm ...`, Stop/Snooze buttons on alarm DMs, the `alarms` message sent to PCs (`alarmState`, next 8 days), saving a YouTube clip as an alarm sound. | `registerAlarmCommands`, `ALARM_COMMANDS`, `alarmState`, `alarmButtons`, `saveClip` | `alarms.test.ts` |
| `alarm-ring.ts` | 153 | The sound of one ringing alarm in one room: tone, saved clip or music, plus her spoken time line; previews. | `ringIn`, `previewIn`, `ringLine`, `RingerDeps`, `RingRoom` | `alarms.test.ts` |
| `textchat.ts` | 281 | Text chat: @mentions, replies, DMs, follow-ups, channel history as JSON-line context, reply splitting, ping limits. | `registerTextChat`, `splitReply`, `historyBlock`, `questionText`, `NAME_IN_TEXT`, `TextChatDeps` | `textchat.test.ts` (2), `textchat-read.test.ts` (25) |
| `identity.ts` | 33 | Prompt lines that tie the configured creator's Discord accounts to the creator's name; bot gender lines. | `memberLabel`, `creatorLines`, `genderLines` | `identity.test.ts` (4) |

Landmarks in `stack.ts` (approximate line numbers):

| Lines | What |
|---|---|
| 129-150 | Required sections, privileged intents, which intents are requested |
| 176-211 | Voices: Kokoro, Piper, Speechify, `VoiceRouter`, `voiceFor` |
| 213-262 | Music sources and player, sound-effect player |
| 265-343 | Rooms, `roomFor`, `pcFor`, `PowerDownWindow`, `GameQuiet`, `callOff`, `inRoomOnly` |
| 353-366 | English check, lazy Whisper and other-language voices, per-user reply language |
| 374-494 | Reminders delivery, alarm ringer, `alarmPlace`, `AlarmClock`, alarm words |
| 516-614 | Notes, digest, weather, briefing, heads-up, members feed, recap |
| 658-675 | Session memory (16 turns, 60 min idle), private PC turns |
| 684-805 | The tool list, in its fixed order; MCP tools join later |
| 833-845 | Automatic memory and quiz judge, with their cost booking |
| 846-887 | Orchestrator options: names, `maxToolRounds: 3`, `stablePrefix`, per-request context, stable lines |
| 894-903 | `costUsd`: the price formula |
| 954-1145 | `local()`, `localMusic()`, `playPastedLink()`: answers with no model call |
| 1144-1318 | `respond()`: limits, timeouts, fillers, auto-memory, `AnswerRecord`, `answered` log line |
| 1336-1394 | `isOwner`, `isCreator`, controller deps and options (PC: follow-up 20 s, barge-in 600 ms) |
| 1398-1490 | Wake detector, cloud STT, PC silence floor, `listenTo()` per room, `shouldHold`, `onHeldWords` |
| 1492-1608 | `heard()` |
| 1632-1721 | `/alarm`, text chat, slash and typed command registration |
| 1722-1775 | Leaving empty calls, `ClientReady`: connect, start reminders, alarms, recap, server-control jobs |
| 1787-1886 | Smart Turn load, satellite server, one room per connected PC |
| 1890-1934 | Cloud voice pre-cache, `busy()`, `stop()` order |
| 1941-1957 | `privilegedIntents()` |

What must stay true here:

- The tool list has a fixed order and content per configuration. With Claude, all tools go on every call and the prompt cache depends on them being identical (`orchestrator-tools.test.ts` "with a stable prefix ...").
- New slash commands go through `extraCommands` in `registerVoiceCommands`, or they vanish when Discord replaces the command set.
- `busy()` (someone in her call, music in any room, an alarm ringing, snoozed or due within 5 minutes) is what keeps auto-update from restarting her. The shell CLI reads it from `/api/health` (`packaging.test.ts`).
- A PC defers to the Discord call when its owner is audible there; alarm words from a PC are ignored while its owner is in her call, because the PC mic hears the call (`stack.test.ts` "a request at the PC", "a ringing alarm").
- Music, sound and quiz tools are wrapped in `inRoomOnly`; PC tools are gated by `pcFor` (the asker's own PC only) instead (`stack.test.ts` "whose PC a tool reaches").
- `stop()` order: controller, reminders, alarms, quiet mode, recap, server control, MCP, heads-up flush, music, mixer, satellite server, ledger and voice budget flush, Discord. State files must be flushed before exit.

## src/audio: PCM helpers and loudness

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `loudness.ts` | 180 | ITU-R BS.1770-4 integrated loudness, peak measure, gain plus look-ahead peak limiter. Used to level every voice to -16 LUFS. | `integratedLoudness`, `peakDbfs`, `gainAndLimit`, `StreamLimiter` (the same gain and limiter for audio that arrives in pieces), `CEILING_DB` | `loudness.test.ts` (3), `speech-stream.test.ts` |
| `pauses.ts` | 113 | Trims silence off synthesized chunks (below -45 dBFS, 15 ms margin) and picks the pause after punctuation (0.26 s after `?`/`!`, 0.22 s after `.`, 0.12 s after `,;:` and dashes, 0.06 s otherwise; shortened 2026-11-08). | `trimSilence`, `pauseAfter`, `StreamTrimmer` (the same trim for streamed audio: exact at the start, within 10 ms at the end) | `speech-stream.test.ts`, `speaker.test.ts` |
| `pcm.ts` | 43 | Stereo to mono, RMS in dBFS, Buffer to Int16Array. `decimate48kTo16k` has no caller (the sherpa resampler is used). | `downmixStereo`, `rmsDbfs`, `bufferToInt16`, `decimate48kTo16k` | `pcm.test.ts` (6) |
| `wav.ts` | 23 | Float samples to a 16-bit WAV Buffer (the admin UI's voice preview, built in `app/main.ts`). | `toWav` | (no direct test) |

## src/bench: compiled benches

Built with the rest of `src/` and shipped in `dist/bench/`. They need real models. `e2e-bench` and `wake-bench` run on Linux x86_64; the side-talk benches also run on Windows.

| File | Lines | Purpose | Run |
|---|---|---|---|
| `e2e-bench.ts` | 182 | End of speech to first audio without Discord: wake clips in real time through VAD, Parakeet, wake, orchestrator (mock LLM with a configurable time to first token), Kokoro and leveling. | `node dist/bench/e2e-bench.js <bench.json>` |
| `sidetalk-bench.ts` | 156 | What each heard segment costs (VAD, Smart Turn, Parakeet CPU and wall time) and whether it wakes her, over a labelled clip corpus with the PC room's settings. `THREADS` sets Parakeet's threads, `TURN=only` measures Smart Turn alone. Scored by `bench/sidetalk-score.mjs`. | `node dist/bench/sidetalk-bench.js <corpus> <models> <out.jsonl>` |
| `sidetalk-pipeline.ts` | 173 | The PC room's real `ListeningPipeline` fed clips back to back in real time, holds and joins included: decoded seconds per heard second, Smart Turn calls, process CPU. | `node dist/bench/sidetalk-pipeline.js <corpus> <models> <out.jsonl>`; env `THREADS`, `MINUTES` |
| `turn-child.ts` | 19 | Smart Turn in a child process for `sidetalk-pipeline.ts` (on Windows onnxruntime-node can't load beside sherpa-onnx). | (spawned) |
| `wake-bench.ts` | 109 | Wake miss rate, false-wake rate and ASR timing over a labelled clip corpus (the corpus is generated outside the repo). | `node dist/bench/wake-bench.js <corpus> <vad.onnx> <asr_dir> <threads> [gainDb ...]`; env `PREROLL` (default 0.25) |
| `wake-asr.ts` | 54 | Decodes a clip corpus with the PC room's pipeline settings and writes each segment's words and wake decision as JSON lines, for `bench/wake-score.mjs`. | `node dist/bench/wake-asr.js <corpus> <models> <out.jsonl>` |

## src/brain: prompts, tool loop, model adapters

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `orchestrator.ts` | 464 | One request to a streamed, speakable answer. Builds the prompt (stable part plus per-request part), runs up to 3 tool rounds (4 model calls), adds `SPOKEN_TURN` (the length rule, repeated last in every spoken turn; text chat doesn't get it), holds a possible `SILENT`, retries once on a transient error before anything was said, first-event timeout, fillers for slow tools, `speak`/`asks`/`endsTurn` handling, reports usage exactly once (estimates it on a stop). | `ConversationOrchestrator`, `OrchestratorOptions`, `Usage`, `systemPrompt`, `stablePrompt`, `requestPrompt`, `SPOKEN_TURN` | `brain.test.ts` (22), `orchestrator-tools.test.ts` (39), `fallback.test.ts`, `dm-talk.test.ts` |
| `tools.ts` | 228 | Built-in tools `get_time` and `web_search` (Tavily); Tavily helpers for `pc_open search` and misheard songs; the untrusted-data wrapper; the person's own yes (`isYes`, `PendingYes`, 20 s); `cachedTool` for read-only lookups; `asksMore` (their words also ask something, so a tool's own confirmation line isn't enough). | `asksMore`, `timeTool`, `tavilySearchTool`, `topResultUrl`, `webYoutubeVideos`, `youtubeVideoId`, `asUntrustedData`, `isYes`, `PendingYes`, `cachedTool` | `pending-yes.test.ts` (17), `cached-tool.test.ts` (1), `music-lookups.test.ts` |
| `tool-router.ts` | 56 | Which tools a request carries, by keyword groups or a tool's own `route` regex. Only used for non-Claude providers. | `routeTools`, `RouteHints` | `tool-router.test.ts` (4), `mcp.test.ts`, `steam.test.ts` |
| `anthropic.ts` | 141 | Claude through `@anthropic-ai/sdk`: message conversion, two cache breakpoints, exact replay of thinking and tool-use blocks, effort setting, `maxRetries: 0`. | `AnthropicLlm`, `toClaude`, `AnthropicOptions` | `anthropic.test.ts` (3), `pc-senses.test.ts` |
| `openai-compatible.ts` | 143 | Any Chat Completions endpoint over `fetch` + SSE, with tool calls. Throws `LlmHttpError` carrying the status (`transient` for 429 and 5xx). Never sends pictures. | `OpenAiCompatibleLlm`, `LlmHttpError`, `wire`, `OpenAiCompatibleOptions` | `brain.test.ts`, `orchestrator-tools.test.ts` |
| `fallback.ts` | 51 | Primary then secondary model, per round, only if the primary failed before its first event (`stack.ts` sets the stall deadline to 60% of `brain.firstEventTimeoutMs`; with no deadline given there is none). No switch mid-answer; no stall deadline for a round with a picture. | `FallbackLlm` | `fallback.test.ts` (9) |
| `sessions.ts` | 67 | Per-person conversation history in memory, trimmed in blocks so the cached prefix stays stable; separate DM history; cut-off marks. Production uses 16 turns and 60 minutes idle. | `SessionMemory` | `brain.test.ts`, `dm-talk.test.ts` (6) |
| `images.ts` | 33 | Pictures in tool results (`pc_screen`): seen in one model call, then replaced with a note; counted as 1,600 tokens. | `IMAGE_SEEN`, `IMAGE_UNREADABLE`, `stripImages`, `countable` | `pc-senses.test.ts` (22) |
| `mature.ts` | 16 | Adult-language prompt lines and their hard limits, per channel's age-restricted flag. | `matureContext`, `MatureSetting` | `mature.test.ts` (3) |
| `speech-text.ts` | 226 | Sentence splitter (220-char chunks, abbreviations such as Pt., vol., feat. and months, initials, CJK marks; "No." ends a sentence unless a number follows), `toSpeakable` (spoken name, no markdown or emoji, a link said as its site, never read whole) and `forSpeech` (English voices only: degrees, dates, times and durations, units, currency, #1, slashes, St./vs./approx., Roman numerals). | `SentenceSplitter`, `SplitterOptions`, `toSpeakable`, `forSpeech`, `ordinal` | `speech-text.test.ts` (9), `brain.test.ts`, `discordinfo-tools.test.ts` |

What must stay true here:

- Every tool result and tool error goes through `asUntrustedData` (`brain.test.ts`, `orchestrator-tools.test.ts` "text from outside ...").
- Actions with real consequences need the person's own yes on their very next turn in the same place. The model cannot supply it: it cannot write `ctx.said`, and `asks` questions are said word for word and end the turn (`pending-yes.test.ts`, `orchestrator-tools.test.ts` "a planted order for a restart, through the real tools").
- Claude cache stability: same tools in the same order every round, the last round keeps the tools with `toolChoice: 'none'`, per-request context stays out of the system block (`orchestrator-tools.test.ts`, `anthropic.test.ts`).
- No retry and no model switch after words were spoken (`fallback.test.ts`, `brain.test.ts` "retries once on a transient error before speaking").
- One person's history never reaches another's request; DMs never reach public answers or automatic memory (`brain.test.ts`, `dm-talk.test.ts`).
- Usage is reported exactly once per request, including stops (`orchestrator-tools.test.ts` "a stop").

## src/cli: helper behind the `adrian` command

| File | Lines | Purpose | Tests |
|---|---|---|---|
| `tool.ts` | 213 | Node helper the bash CLI runs as the service user (`node dist/cli/tool.js <cmd>`): `secret-set NAME` (value on stdin, never argv), `secret-delete`, `secret-list`, `setup-code [--new]`, `reset-admin`, `check` (exit 3 incomplete, 1 unreadable), `port`, `voice`, `config KEY [VALUE]`, `satellite-add`, `satellite-list`, `satellite-remove`, `version`. `config` validates the whole result with the real schema, keeps 16+ digit strings as strings, and only allows the top-level keys in `ALLOWED` (no paths, no `server`, no `allowedGuilds`). | `config-file.test.ts` (18), `packaging.test.ts` |

## src/config.ts: the config schema

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `config.ts` | 545 | The zod schema for the whole config file with every default; secret names and their purposes; the private-host rule for `helix.url`; cloud voice defaults by model (`simba-3.5`: speed 1, 950,000 chars a month). | `PocConfigSchema`, `PocConfig`, `loadConfig`, `readSecrets`, `SECRET_PURPOSE`, `keyName`, `privateHost`, `cloudVoiceSpeed`, `cloudVoiceChars` | `config.test.ts` (4), `secret-purpose.test.ts` (5), `cloud-voice-defaults.test.ts` (3), `helix-config.test.ts` (7), `recap.test.ts`, `steam.test.ts` |

What must stay true: a new key needs a default (a required key breaks every existing config), and sections with `.default({...})` must repeat every inner default. A setting that names a secret must use `keyName(purpose)`, so no endpoint can be pointed at another service's key. Every key is documented in [configuration.md](configuration.md). Secrets are read only from the secrets file; there is no environment fallback.

## src/conversation: turn-taking and local phrases

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `controller.ts` | 418 | Turn-taking rules as pure logic with an injected clock: queue (2), duplicate wakes (1.5 s), follow-up windows (8 s Discord, 20 s PC), continuation (12 s), "Yes?" expecting window (20 s), stops, hold phrases, barge-in (2.5 s Discord, 600 ms PC), owner preemption, announcements, quiet while gaming. | `ConversationController`, `ControllerOptions`, `DEFAULT_CONTROLLER_OPTIONS`, `ControllerDeps`, `HeardInput` | `controller.test.ts` (86), `music-taste.test.ts`, `stack.test.ts` |
| `intents.ts` | 273 | Classifies whole short utterances: stop, weak stop, hold, name, thanks, bye, ack, repeat, volume, speed (several languages); clear music orders; time questions; a bare "play" waiting for its object. | `classify`, `Intent`, `classifyMusic`, `MusicIntent`, `bareMusicVerb`, `afterBareVerb`, `PendingPlay`, `isTimeQuestion` | `intents.test.ts` (30), `music*.test.ts`, `pending-yes.test.ts` |
| `room.ts` | 53 | Recent talk in a room (last 24 lines, 5 minutes, 200 chars each, memory only), fed to the prompt as untrusted context. | `RoomTalk` | `room.test.ts` (2) |

What must stay true: everyday words (weak stops) never stop someone else's answer; "stop listening" and song titles never stop music; owners stop others by phrase, never just by talking; an order that already ran never runs twice (`working`/`acted`). Only `ack`, `thanks` and `bye` may be answered locally for words said without her name. The name is partly hard-coded to "adrian" here (`NAMES`, `adri` regexes), even when `listen.wakeName` changes.

## src/core: shared interfaces and small utilities

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `interfaces.ts` | 222 | The contracts everything plugs into: transport, VAD, wake, STT, TTS, LLM, tools, memory, secrets, logger. `Tool` carries `timeoutMs`, `slow`, `filler`, `endsTurn`, `speak`, `asks`, `acts`, `route`. `TextToSpeech.stream?` returns a sentence's audio in pieces (`SpeechPiece`). | `VoiceTransport`, `VoiceTransportEvents`, `PlaybackHandle`, `PcmChunk`, `VoiceActivityDetector`, `WakeDetector`, `SpeechToText`, `TextToSpeech`, `SpeechPiece`, `LlmProvider`, `LlmEvent`, `ChatMessage`, `ToolCall`, `Tool`, `ToolSpec`, `ToolContext`, `ToolOutput`, `ToolImage`, `MemoryStore`, `SecretsStore`, `Logger`, `UserId` | used by most tests |
| `logger.ts` | 60 | JSON-lines logger to stdout with redaction of token shapes (Groq, Google, Tavily, `sk-`, Discord bot tokens, argon2 hashes, `sat_` pairing tokens, long `Bearer` values) and a 500-line in-memory buffer for the dashboard. `createLogger`'s optional third argument is an observer that sees every line after the level filter, in a try/catch (the dashboard's counters). | `createLogger`, `redact`, `recentLogLines` | `web.test.ts` (careless log calls are still redacted), `helix-config.test.ts` (bearer tokens) |
| `calls.ts` | 21 | Counts paid outside calls the dollar ledger doesn't see: `noteCall(service, status)` after each Tavily and Groq answer; `main.ts` points it at the dashboard. | `noteCall`, `onCall`, `CountedService` | `dashboard.test.ts` |
| `eager.ts` | 42 | Pulls an async stream as fast as it produces, buffering for a slower reader, so the model's time limit never counts time spent speaking. | `eager` | `eager.test.ts` (3) |
| `time.ts` | 14 | Cached `Intl.DateTimeFormat` instances. | `dateFormat` | (none) |

## src/features: what she can do

Each feature is a module that exposes model tools (`Tool` objects) and prompt lines; `stack.ts` builds them and puts them into the tool list. The per-tool reference (arguments, guards, who may use them) is in [tools.md](tools.md).

### The person's day

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `alarms.ts` | 963 | Alarm and timer store (`alarms.json`), 1 s clock, ring sessions, where it rings, stop/snooze words (whole utterances only), dismiss modes (`stop`, `firm`, `math`), undo within 3 min, self-snooze rounds, missed-while-offline, DST, per-person prefs, `busySoon()`. | `AlarmClock`, `Alarm`, `AlarmPrefs`, `SavedSound`, `LIMITS`, `DEFAULTS`, `ringWord`, `backWord`, `parseClock`, `parseDays`, `nextAt`, `localParts`, `localDate`, `clockText`, `dayText`, `daysText`, `firstNumber`, `timerName`, `soundKind`, `validZone` | `alarms.test.ts` (46), `stack.test.ts` "a ringing alarm" |
| `alarm-tools.ts` | 627 | The 7 model tools: `set_alarm`, `set_timer`, `edit_alarm`, `list_timers`, `cancel_timer` (also lists and cancels reminders), `alarm_control`, `alarm_options`; spoken read-backs; the `ALARM_RULE` prompt line. | `alarmTools`, `ALARM_RULE` | `alarms.test.ts` |
| `alarm-tones.ts` | 255 | 9 built-in tones synthesized in code at 48 kHz (`classic` for alarms, `chime` for timers), trimmed to about -13 LUFS; the ring PCM stream. Nothing to download. | `TONES`, `DEFAULT_TONE`, `DEFAULT_TIMER_TONE`, `isTone`, `tonePattern`, `ringStream`, `patternFromPcm`, `TONE_RATE` | `alarms.test.ts` |
| `reminders.ts` | 317 | Reminder store (`reminders.json`) and the `set_reminder` tool, with delivery retry (every 60 s for about a day); where a reminder is said; household-time helpers used across features. Its own `set_timer`/`list_timers`/`cancel_timer` are not registered: the alarm ones are. | `Reminders`, `Reminder`, `reminderRoute`, `dueMessage`, `localToEpoch`, `spokenDuration` | `reminders.test.ts` (21) |
| `notes.ts` | 212 | Per-person notes (`notes.json`), `remember` and `forget`, and the place rule for which notes reach a prompt (all in a DM or at their own PC; in a server only notes told there or asked about, matched on the word, its plural or third-person form and a few synonyms, so "where do I live" finds "lives in ..." and "living in ...", while everyday verbs count only in a first-person question). `remember` says its own "Got it." | `UserNotes`, `asksAbout` | `notes.test.ts` (29) |
| `automemory.ts` | 158 | Every 4th voice turn per person, one background model call that adds, updates or drops learned notes. One run at a time; "forget" wins over a run in progress. | `AutoMemory`, `parseFacts`, `parseChanges` | `automemory.test.ts` (20) |
| `weather.ts` | 229 | Open-Meteo geocoding and forecast for the configured place only; `weather` tool; briefing words. | `Weather`, `sky` | `briefing.test.ts` |
| `headlines.ts` | 94 | RSS/Atom title reader; `headlines` tool (titles only). | `Headlines`, `feedTitles`, `feedText` | `briefing.test.ts` |
| `calendar.ts` | 351 | Read-only iCal from secret URLs, recurrence expansion with ical.js; `calendar` tool limited to `calendar.people` (else owners); day-key helpers. | `Calendars`, `eventsBetween`, `calendarUrl`, `dayKey`, `dayStart`, `addDays` | `calendar.test.ts` (8), `briefing.test.ts` |
| `calendar-worker.ts` | 15 | Worker thread that runs `eventsBetween`, because a busy calendar took about half a second on the main thread, longer than the mixer's 160 ms lead. | (worker entry) | (tests run the expansion inline) |
| `briefing.ts` | 118 | Morning briefing text with no model call: greeting, weather, calendar, reminders, headlines; details only when private. `briefing` tool. | `Briefing`, `listWords` | `briefing.test.ts` (13) |
| `headsup.ts` | 363 | Join tracking for her call, the heads-up gate, the first-join morning briefing; `whats_new` and `digest_prefs` tools; `heads-up.json`. | `HeadsUp`, `headsUpGate`, `wentDown` | `headsup.test.ts` (19), `briefing.test.ts` |
| `digest.ts` | 312 | "New since" from Sonarr, Radarr or Plex plus game servers that went down, as one line of at most 25 words. | `gatherNews`, `newMedia`, `digestLine`, `sinceWords`, `hasSources`, `cleanTitle`, `MAX_WORDS` | `digest.test.ts` (20) |
| `recap.ts` | 342 | Weekly recap post (most played, new media, game server uptime, questions answered); never posted twice; `post_recap` tool (owners); `weekly-recap.json`. | `Recap`, `slotAtOrBefore`, `weekOf`, `weekdayIndex`, `WEEKDAYS`, `SAMPLE_MS` | `recap.test.ts` (18) |

What must stay true: nothing rings out silently (unanswered alarms self-snooze, then DM; nowhere to ring means a DM with buttons); only the alarm's owner stops it by voice; `alarms.json` is never saved over after a failed read; the PC copy of alarms only applies `alarm_done` to the same occurrence. Alarm file and `alarms` message changes must add optional fields only: `isAlarm` drops entries that fail validation, and PC apps read the message ([satellite.md](satellite.md)). Note privacy (`notes.context`, `asksAbout`) is high risk: `notes.test.ts` "where a note can come up" must stay green.

### Music, sounds and the music quiz

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `music.ts` | 2460 | YouTube source (YouTube Music's API for songs, albums and playlists, YouTube's search API for videos, yt-dlp as the fallback and for streams; the stream's yt-dlp starts beside the search and reads the address from stdin), Plex source, ffmpeg decoder (protocol whitelist), Deezer top tracks, misheard-name matching (soft g, two words as one name, other scripts), version words (tiny desk, live, remix ...) that must appear in a result, genres that play a playlist (`isGenre`), `MusicPlayer` (queue, autoplay, history, stalls, YouTube bot-check pause, which also drops early and spare yt-dlp runs), spares tied to one list's tracks, the direct video search's switch (`music.directSearch`), breaker (3 failures rest it 5 min) and 3 s budget per lookup, `play_music` and `music_control` tools, music prompt lines. | `YoutubeSource`, `PlexMusicSource`, `ffmpegDecoder`, `decoderArgs`, `inputArgs`, `deezerTopTracks`, `MusicPlayer`, `musicTools`, `musicRules`, `musicState`, `whoAsked`, `cleanTitle`, `matchScore`, `soundOf`, `respell`, `songKey`, `trackKey`, `heatmapPeak`, `pickVideo`, `pickShort`, `versionsAsked`, `hasVersions`, `otherScript`, `isGenre`, `runProgram`, `Runner` | `music-speed.test.ts` (37), `music.test.ts` (15), `music-lookups.test.ts` (141), `music-requests.test.ts` (14), `music-polish.test.ts` (22), `music-taste.test.ts` (28) |
| `taste.ts` | 186 | Per-person artist play scores (60-day half-life), likes and dislikes, her own taste; `music_taste` tool; `music-taste.json`. | `MusicTaste` | `music-taste.test.ts`, `music-commands.test.ts` |
| `links.ts` | 152 | Pasted media links (YouTube, SoundCloud, Bandcamp, Spotify read through its page tags and searched on YouTube), recent links per person for "play that link". | `parseMediaLink`, `mediaLinksIn`, `MediaLink`, `PastedLink`, `RecentLinks`, `linksLine`, `PLAY_THAT_LINK`, `spotifyItem`, `SpotifyItem` | `links.test.ts` (7) |
| `sounds.ts` | 44 | `play_sound`: a short YouTube clip, cut at 15 s, which is the whole answer (`endsTurn`); `SOUND_RULE`. | `soundTool`, `SOUND_RULE`, `SoundDeps` | `sounds.test.ts` (2), `textchat-read.test.ts` |
| `quiz.ts` | 1047 | Music quiz: local start and command parsing, song lists (Deezer charts, YouTube Music playlists, artist top songs, room history), clip placement at the most replayed part, local guess matching, at most 2 tiny model judge calls per round; `music_quiz` tool. | `Quizzes`, `MusicQuiz`, `parseQuizCommand`, `judgeGuess`, `answerScore`, `artistNames`, `clipRange`, `quizSongs`, `modelJudge`, `GENRES`, `QUIZ_BUSY` | `quiz.test.ts` (40), `stack.test.ts` "a music quiz in the call" |

What must stay true: ffmpeg only gets whitelisted network protocols (`http,https,tls,tcp,crypto`) or a pipe, so a URL can never read local files; the Plex token goes only in a header to the Plex origin under `/library/parts/`; yt-dlp is stopped with SIGTERM, never SIGKILL; `KNOWN_FANS = 50_000` decides when a bare "play X" means an artist; titles and names go into prompts quoted, capped and labelled as data; no lyrics; side talk during a quiz never reaches the model.

### Discord, the PC and the household's services

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `handoff.ts` | 690 | What "that" means (recent links and songs per person), `pc_handoff` (`send_to_pc`, `music_to_pc`, `pc_to_call`), `tell_call`, who started the music in a room, `HANDOFF_RULE`. | `handoffTools`, `tellCallTool`, `LastThings`, `linksIn`, `noteMessage`, `MusicStarts`, `notingStarts`, `parsePlayers`, `callRequestFor`, `WindowLimiter`, `startsWithName`, `whichLine`, `confirmLine`, `HANDOFF_RULE` | `handoff.test.ts` (49) |
| `handoff-discord.ts` | 172 | The Discord side: watches messages for links, builds `pc_handoff`, `tell_call` and `game_night` with the real client, per-feature gating. | `watchDiscord`, `pcDiscordTools` | `handoff-discord.test.ts` (7) |
| `textchannel.ts` | 76 | Picks the text channel for posts; visibility and post-permission checks; text that cannot ping. | `pickTextChannel`, `canSee`, `canPost`, `plainText`, `PostableChannel`, `ChannelChoice` | through `handoff.test.ts`, `gamenight.test.ts` |
| `gamenight.ts` | 479 | `game_night`: who is free or playing, sign-ups (`game-night.json`), pings with cooldowns and order guards. | `gameNightTool`, `GameNightSignups`, `gameKey`, `sameGame`, `matchState`, `GAME_NIGHT_RULE` | `gamenight.test.ts` (30) |
| `discordinfo.ts` | 447 | `server_info` lookups filtered to what the asker can see, and the `message_member` relay with read-backs and limits. | `discordTools`, `RelayLimiter`, `matchMembers`, `namesMember`, `allowedPings`, `describeActivity` | `discordinfo-tools.test.ts` (80), `discordinfo.test.ts` (5) |
| `mcp.ts` | 287 | Minimal MCP client (streamable HTTP) that turns allowed server tools into home-control tools, owners only by default, with a yes before risky calls (locks, doors, garage ...). | `connectMcp`, `serverTools`, `McpClient`, `rpcMessages`, `toolName`, `describeCall`, `HOME_WORDS`, `McpServer`, `McpError` | `mcp.test.ts` (11) |
| `helix.ts` | 258 | Client for the Helix game-server panel's token Automation API: exact headers, no redirects or cookies, one request at a time, local rate ceiling, capped bodies. | `HelixClient`, `HelixError`, `HelixFailure`, `readCapped`, `MAX_WAIT_SEC` | `servercontrol.test.ts` |
| `servercontrol.ts` | 915 | Minecraft start, stop, restart, whitelist, chat and status through Helix; one job per server; background job watches kept in `game-server-jobs.json` across restarts; console command whitelist. | `ServerControl`, `resolveServer`, `safeCommand`, `failText`, `rejectedText`, `playerNames`, `playerTarget`, `whitelistReply`, `chatText`, `clean`, `STUCK_MS`, `TOKEN_MISSING` | `servercontrol.test.ts` (39), `helix-config.test.ts` |
| `gameservers.ts` | 116 | Minecraft Java server-list ping; `game_server_status` when Helix is not set up. | `pingMinecraft`, `describeStatus`, `gameServerTool`, `GameServer`, `McStatus` | `gameservers.test.ts` (3), `digest.test.ts` |
| `steam.ts` | 990 | Read-only Steam: friends in game, wishlist sales, store prices; account linking; caches and rate limits under Steam's own. | `Steam`, `steamTools`, `parseSteamAccount`, `TtlCache`, `nameScore`, `normName`, `cleanText`, `parseItem`, `describeFriends`, `describeSales`, `notOnSteam`, `softenCaps`, `STEAM_KEY` | `steam.test.ts` (49) |
| `media.ts` | 140 | Read-only Plex, Sonarr and Radarr tools (GET only, each key to its own app). | `mediaTools`, `getJson`, `MediaConfig` | `media.test.ts` (4) |
| `games.ts` | 169 | Dice, coin, and one shared party game per channel with a scoreboard (memory only). | `PartyGames`, `rollDice` | `games.test.ts` (5) |

What must stay true: recipients and pings come from the person's own words (`ctx.said`), never from the model; `allowedMentions` always parses nothing except listed user IDs; visibility follows the asker's Discord permissions; limits are released when nothing went out; Helix gets only `SAFE_COMMANDS` console shapes and a change whose answer was lost is never re-sent; MCP offers only tools that are both allowed and really offered. Details in [security.md](security.md) and [tools.md](tools.md).

## src/limits: spend caps

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `usage-ledger.ts` | 149 | Daily and monthly USD caps and the per-person hourly request limit (owners skip only the hourly limit). Spend per local day in `usage.json` (newest 400 days), saved 2 s after a change and on stop. Checked before a request, added after it, so the request that crosses a cap still finishes. | `UsageLedger`, `Limits`, `LimitCheck`, `LIMIT_MESSAGES` | `ledger.test.ts` (5), `stack.test.ts` "what an answer costs" |

Only language-model tokens are counted. Speechify characters have their own monthly budget (`speech/speechify.ts`); Groq speech-to-text and Tavily are not counted. See [costs.md](costs.md).

## src/listen: from audio to a transcript

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `pipeline.ts` | 443 | Per-user resampler and Silero VAD (0.25 s preroll, set in `speech/sherpa.ts`), drops clips under 0.3 s, Smart Turn hold and join at PCs (0.25 s gap between joined clips, 15 s cap), Parakeet decode started beside the turn check, text wake check, emits `heard`, `voiceActivity`, `error`. At PCs a second Silero VAD with a 0.32 s wait (`EarlyOptions`) decodes early; its words are used only when the full wait closes the very same samples. | `ListeningPipeline`, `ListeningPipelineEvents`, `HeardEvent`, `ClosedBy`, `TurnOptions`, `EarlyOptions`, `CloseInfo`, `UserState`, `endsDangling` | `turn-hold.test.ts` (44), `early-listen.test.ts` (18), `stack.test.ts` |

What must stay true: each user has their own VAD state (Discord streams are never mixed); one `heard` per clip (an epoch counter discards stale checks after a join); a Smart Turn failure never makes anyone wait; side talk is never held.

## src/poc: proof of concept

| File | Lines | Purpose |
|---|---|---|
| `main.ts` | 180 | The early milestone runner: join a voice channel under DAVE, receive per-user audio, play a normalized test clip (`assets/test-clip.ogg`), survive reconnects. Logs per-utterance statistics only, never audio. `npm run poc -- <config.json>`. Not used in production; kept as a minimal transport check. |

## src/satellite: the PC app's server side

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `server.ts` | 136 | `ws` server at `/satellite`: hello within 5 s, token check before the per-address lockout (5 failures lock an address for 10 min, a correct token always gets in), one live connection per device, 30 s ping keep-alive (`heartbeatMs`), frame cap before the welcome. `satellite disconnected` says how the link ended (`by`: pc, heartbeat, replaced, shutdown, server; close code, reason, link age, how long the PC was quiet). | `startSatelliteServer`, `SatelliteServerOptions` | `satellite.test.ts` (63), `quiet.test.ts`, `pc-senses.test.ts` |
| `connection.ts` | 306 | One welcomed PC as a `VoiceTransport`: JSON and binary frames, `action()` with timeouts (15 s default), PCM out (stereo mixed to mono, 48 kHz s16le), `state`, `mode`, `transcript`, `alarms`, `audio_stop`. | `SatelliteConnection`, `SatelliteEvents`, `SatelliteMode`, `ActionResult`, `SMALL_FRAME` (256 KiB), `MAX_FRAME` (2 MiB + 64 KiB), `SAT_RATE`, `capFrames`, `frameBytes` | `satellite.test.ts`, `pc-senses.test.ts`, `quiet.test.ts` |
| `devices.ts` | 63 | Pairing store `satellites.json`: issues `sat_` tokens, keeps only their SHA-256, constant-time verify. | `SatelliteDevices`, `Device` | `satellite.test.ts` |
| `tools.ts` | 392 | The PC tools `pc_apps`, `pc_windows`, `pc_open`, `pc_media`, `pc_volume`, `pc_system`, `pc_info` (plus the two from `senses.ts`), `PC_RULE`, the spoken yes for sleep/restart/shutdown (`confirmed` is stripped from model arguments), the 30 s restart/shutdown cancel window, the server-side URL name check, spoken confirmations that skip the second model call, and the house guard (`houseOrder`: an order verb right before a door, the lights, the TV, the heat or another house thing, or the thing's state right after it, keeps PC power, media, volume and app actions off unless the PC is named or another clause holds that PC order; `cancel_shutdown` always passes). | `pcTools`, `PcToolDeps`, `PC_RULE`, `PowerDownWindow`, `webUrl`, `confirmation`, `houseOrder` | `pc-house.test.ts` (10), `satellite.test.ts`, `orchestrator-tools.test.ts` |
| `senses.ts` | 120 | `pc_clipboard` and `pc_screen` specs and rule, the model-facing result, log redaction for private tools, private-turn marks, detection of PC apps too old for the health check. | `SENSES_RULE`, `SENSES_SPECS`, `forModel`, `forLog`, `answerForLog`, `PRIVATE_TOOLS`, `PrivateTurns`, `beforeHealth`, `HEALTH_NEEDS_UPDATE` | `pc-senses.test.ts` (22) |
| `images.ts` | 33 | Validates a `pc_screen` picture: type, base64 length before decoding, magic bytes, 1.5 MB. | `readImage`, `MAX_IMAGE_BYTES` | `pc-senses.test.ts` |
| `quiet.ts` | 387 | Quiet while gaming: parses `activity`, holds PC reminders on disk (`held-while-gaming.json`; 50 per owner, 500 total, 12 h), releases them when the game ends without sending a DM twice, prompt lines. | `GameQuiet`, `GameQuietDeps`, `QuietPc`, `parseActivity`, `Activity`, `HeldItems`, `HeldItem`, `reminderBrief`, `messageBrief`, `releaseText`, `gamingLine`, `toldLine`, `HELD_MAX`, `HELD_TOTAL_MAX`, `HELD_TTL_MS`, `SETTLE_MS`, `LOST_MS` | `quiet.test.ts` (32) |
| `recorder.ts` | 42 | Opt-in WAV recordings of PC requests meant for her (`satellite.recordDays` > 0), with an index file, pruned by day. | `PcRecorder` | `recorder.test.ts` (1) |

What must stay true: a PC tool only reaches the asker's own PC (`pcFor` filters on the owner; no argument names a PC); the model can never set `confirmed`; `webUrl` mirrors `web_url` in the main repo's `crates/pc-control/src/win/open.rs` (change both together); clipboard and screen contents never reach the logs; pictures are validated, never cached, and seen in one model call only; the server never changes the PC's own policy. A new protocol field must be optional so older PC apps keep working. The protocol itself is in [satellite.md](satellite.md).

## src/speech: speech recognition and voices

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `sherpa.ts` | 160 | sherpa-onnx wrappers: Silero VAD (512-sample windows, preroll), 48 to 16 kHz resampler, Parakeet TDT 0.6B v3 int8 (one recognizer for the whole process, decodes serialized). | `SileroVad`, `SileroOptions`, `Downsampler`, `ParakeetStt`, `ParakeetOptions`, `ASR_SAMPLE_RATE` | `turn-hold.test.ts` (real resampler, fake VAD and ASR); real models only in benches |
| `smart-turn.ts` | 179 | Smart Turn v3.2 end-of-turn model: Whisper-style log-mel features in TypeScript plus the onnxruntime session. Runs on a worker by default. | `SmartTurn`, `TurnDetector`, `turnFeatures` | `stack.test.ts` (mocked); `bench/turn-parity.*` |
| `smart-turn-worker.ts` | 15 | The worker thread entry. Smart Turn blocked the main thread for 50-250 ms, longer than the mixer's 160 ms lead, so PC music skipped. | (worker entry) | (none) |
| `cloud-stt.ts` | 66 | Groq Whisper transcription over HTTPS: in-memory WAV, vocabulary prompt (600 chars), timeout. | `groqTranscribe`, `sttPrompt`, `wav`, `CloudSttOptions` | `cloud-stt.test.ts` (2), `stack.test.ts` |
| `whisper.ts` | 40 | Local Whisper small int8 second pass for non-English speech; returns the detected language. Loaded on first use. | `WhisperStt` | `stack.test.ts` (mocked) |
| `language.ts` | 100 | Reply languages (en, es, zh, ja, vi) with their voice and prompt line; English and Spanish checks; stripping a leading wake phrase. | `LANGS`, `LangInfo`, `ReplyLang`, `replyLang`, `looksSpanish`, `stripWakeLead`, `EnglishWords` | `language.test.ts` (3) |
| `speechify.ts` | 338 | Speechify cloud voice with automatic local fallback, the monthly character budget (`voice-usage.json`), short-line cache, warm-up after 30 idle minutes, failure pause. `stream()` plays sentences over 40 characters as their audio arrives (`timeoutMs` limits the wait for the first bytes and any stall); a failure before the first audio falls back to the local voice, a break mid-sentence ends that sentence. | `SpeechifyTts`, `SpeechifyOptions`, `CharBudget`, `SpeechifyError`, `pcm16ToFloat`, `speechInput` | `speechify.test.ts` (20), `speech-stream.test.ts` (12), `cloud-voice-defaults.test.ts` |
| `kokoro.ts` | 157 | Kokoro-82M local voice (fp32), one engine per language created on first use, synthesis serialized; `levelChunk`, the shared leveling every voice goes through. | `KokoroTts`, `KokoroOptions`, `levelChunk`, `TARGET_LUFS`, `langOf`, `SpeechLang` | benches only (`tts-speed.mjs`, `level-check.mjs`) |
| `piper.ts` | 92 | Piper VITS voice for Vietnamese, and `VoiceRouter`, which sends a voice name to Piper, the cloud voice or Kokoro, and streams when that voice can. | `PiperTts`, `VoiceRouter` | benches only (`lang-e2e.mjs`) |
| `voices.ts` | 12 | The 54 Kokoro speaker names. The array index is the speaker id. Also the list `web/server.ts`, `web/settings.ts` and `adrian voice` (`cli/tool.ts`) validate against; `kokoro.ts` maps a name to its index. | `KOKORO_VOICES` | (no direct test) |

What must stay true: never reorder, sort or insert into `KOKORO_VOICES`; every engine is leveled to -16 LUFS with the -2 dBFS limiter and voice volume 1.0 is never exceeded; a Speechify error never fails the answer; characters are counted only after audio arrived; Parakeet decodes stay serialized; nothing heavy goes back on the main thread. `src/types/sherpa-onnx-node.d.ts` must be updated with any sherpa-onnx-node bump.

## src/transport: Discord voice

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `discord.ts` | 444 | Joins with DAVE end-to-end encryption, one Opus receive stream per user (ended after `silenceMs`), playback (Opus 128 kbps, FEC, `maxMissedFrames: 50`), recovery (a resume that falls back to Signalling is rebuilt after 5 s there, Connecting keeps 30 s, an error rebuilds at once; `voice back` logs each recovery time), rejoin with backoff, kicks (stays out until `/join`), drags to other channels, redaction of voice debug lines. | `DiscordVoiceTransport`, `DiscordTransportOptions`, `redactVoiceDebug` | `transport-reconnect.test.ts` (26), `transport-kick.test.ts` (4), `redact.test.ts` (2) |

`@discordjs/voice` is pinned to 0.19.2 and patched by `scripts/patch-voice.mjs`; upgrading it means re-checking that patch.

## src/types

| File | Lines | Purpose |
|---|---|---|
| `sherpa-onnx-node.d.ts` | 126 | Hand-written typings for `sherpa-onnx-node` 1.13.8 (the package ships none). Only what the code uses. |

## src/voice: playback

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `mixer.ts` | 401 | Mixes speech, one music channel and any number of alarms into one 48 kHz stereo stream in 20 ms frames on the wall clock with a 160 ms lead; ducks music for her voice, sounds, alarms and 8 s after a wake; stall handling; ends playback when idle; reports when her voice is audible (`onVoice`). | `Mixer`, `MixerOptions`, `FRAME_BYTES`, `LEAD_FRAMES`, `START_LEAD_FRAMES` | `mixer.test.ts` (22), `music-taste.test.ts`, `alarms.test.ts`; `bench/mixer-stall.mjs` |
| `speaker.ts` | 167 | Streams answer chunks into one playback: synthesize (or stream, when the voice can), resample to 48 kHz stereo, trim, pause by punctuation. Playback opens once 0.2 s of audio is in; a sentence with no audible audio is skipped. `synthMs` is the time to a sentence's first audio. A stop cuts playback even after synthesis finished. | `Speaker`, `SpeakOptions`, `SpeakResult`, `toDiscordPcm` | `speaker.test.ts` (2), `speech-stream.test.ts` |

What must stay true: sound only plays on the full lead, a new playback opens with 3 silent frames, samples are clamped, not wrapped; music ducks only for her voice, sounds, alarms and wakes, never for people talking to each other. `Mixer.hold()` and `Speaker.warm()` have no production caller.

## src/wake: the wake check

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `text-wake.ts` | 278 | Wake decision on the transcript, not acoustically. Strict match: fillers, a greeting, then the name (with built-in ASR spellings of "adrian"). Loose match: bare name first or the wake phrase mid-sentence, sent to the model as a judged follow-up; a greeting or bare name followed by talk about her (`talksAbout`); a question with the name at the end or after a lead-in (the words before the name are the request). Contractions ("Adrian's") never wake. One tokenization per transcript. | `TextWakeDetector`, `TextWakeOptions` | `wake.test.ts` (7, with many cases each) |

## src/web: admin web UI backend

| File | Lines | Purpose | Key exports | Tests |
|---|---|---|---|---|
| `server.ts` | 534 | Admin HTTP(S) server and JSON API under `/api/` (health, session, setup/claim, login, logout, status, settings, secrets, check/discord, check/channels, check/llm, check/search, check/hardware, voice-preview, restart, logs, password, dashboard); static files from `web/`; security headers and CSP; Host check against DNS rebinding; body and per-socket request caps. | `createAdminServer`, `hostAllowed`, `WebDeps` | `web.test.ts` (32), `host-check.test.ts` (1) |
| `metrics.ts` | 623 | The dashboard's counters, fed by the logger's observer: `WATCHED` log messages (answers, voice and PC link drops, fallbacks, starts, restarts, shutdowns), 24 hourly and 8 daily slots of 11 histograms (96 log-spaced bands, about 6%) and 19 counters in typed arrays (72,704 B fixed), rings for errors, restarts, PCs and Tavily/Groq days; saved to `<state>/dashboard.json` (0600, atomic) at start, every 5 min and at shutdown. | `Metrics`, `WATCHED`, `BINS`, `binOf`, `binValue`, `PC_DROP_MS` | `dashboard.test.ts` |
| `dashboard.ts` | 361 | `GET /api/dashboard`: assembles the cards (needs attention, spending, answer speed, reliability, this server), the needs-attention rules, disk and memory facts, the updater's notes, and the GitHub newest-release check (only while the page is open, at most every 6 h). | `buildDashboard`, `attention`, `ReleaseCheck`, `systemInfo`, `newer` | `dashboard.test.ts`, `web.test.ts`, `web-ui.test.ts` |
| `auth.ts` | 225 | The single admin account (argon2id), one-time setup code, login and session cookies, CSRF token, rate limits with a shared trickle so the owner is never locked out. | `AdminAuth`, `Session`, `validPassword`, `validUsername`, `SETUP_CODE_TTL_MS`, `LIMIT_WINDOW_MS` | `auth.test.ts` (14) |
| `settings.ts` | 173 | What the admin UI may change (strict schema, no paths), installer-owned paths, presets to brain config, the rule that a stored key only goes to its own preset's address. | `SettingsPatchSchema`, `SettingsPatch`, `CustomLlmSchema`, `applySettings`, `baseConfig`, `settingsView`, `keyRouteProblem`, `InstallPaths` | `web.test.ts`, `manager.test.ts`, `secret-purpose.test.ts` |
| `checks.ts` | 449 | Wizard checks in plain words: Discord token (cleans `Bot ` and quotes, names an Application ID, Public Key or Client Secret pasted by mistake, which privileged intents are on), voice channels, the bot's View/Connect/Speak in the picked channel (`checkVoiceAccess`, worked out from roles and overwrites), language model (one short test answer with timing and an estimated cost; a key for the wrong provider is refused before it's sent; no credit, rate limits, outages named), Tavily, hardware; the LLM presets with prices; the model folder layout; invite permissions; the setup-code command for native or Docker. | `checkDiscordToken`, `cleanToken`, `tokenShapeProblem`, `listVoiceChannels`, `checkVoiceAccess`, `checkLlm`, `llmError`, `keyMismatch`, `checkTavily`, `checkHardware`, `setupCodeCommand`, `LLM_PRESETS`, `LlmPreset`, `MODEL_LAYOUT`, `INVITE_PERMISSIONS`, `DiscordCheck`, `LlmCheck`, `HardwareCheck`, `VoiceAccess` | `setup-checks.test.ts` (21), `web.test.ts`, `stack.test.ts` |
| `explain.ts` | 80 | Plain words for why the voice stack failed to start (11 rules: bad token, missing intents or permissions, models, DNS, EACCES, out of memory, bad config ...), shown on the dashboard, after Start and by `adrian doctor` (`tool.js explain-log`). | `explainStartError`, `lastStartFailure` | `setup-checks.test.ts` |
| `secrets-file.ts` | 101 | The secrets file (write-only through the API) and atomic JSON and config writes that keep the file mode; a config file that does not parse is never treated as empty. | `SecretsFile`, `SECRET_NAME`, `readJsonFile`, `readConfigFile`, `writeJsonFile`, `writeConfigFile` | `config-file.test.ts` (18), `web.test.ts` |

What must stay true: secrets are write-only over HTTP and never logged; a custom endpoint only ever gets a key pasted for that test; the browser can never set a file path; non-GET requests are same-origin and carry `X-CSRF-Token`; the Host header is an IP, `localhost` or in `server.allowedHosts`. The health JSON is compact and its field names (`ok`, `state`, `voiceReady`, `busy`) are read literally by every installed `adrian` CLI: renaming one breaks updates.

---

## test/: unit tests

- Runner: vitest 5.0.4 with its defaults (no config file); it picks up `test/*.test.ts`. Run `npm test`, or one file with `npx vitest run test/mixer.test.ts`.
- No network, models or keys. Some tests open local sockets (real `ws` servers, a local HTTPS server in `packaging.test.ts`).
- Skips: the shell suites in `packaging.test.ts` need bash, tar and gzip (on Windows they look for Git Bash); "the Node runtime" suite also needs `xz`; one umask test in `config-file.test.ts` skips on Windows.
- `stack.test.ts` drives the real `startVoiceStack` with fake Discord, listening, satellite server and HTTP; `privilegedIntents` sees a failing portal call, so every stack test runs the "any doubt means off" path.
- `web-ui.test.ts` runs the real `web/app.js` in a fake DOM (`node:vm`) against a fake API.
- `packaging.test.ts` runs the real shell scripts in bash with stubbed `id` and `systemctl`.
- Test names are sentences about behavior ("never starts empty over a file it cannot read"). Keep that style. Use made-up names and documentation addresses (example.com, 192.0.2.x) in fixtures, never real people, IDs or addresses.

| File | Tests | Source under test | Covers |
|---|---|---|---|
| `alarms.test.ts` | 46 | `features/alarms`, `alarm-tools`, `alarm-tones`, `app/alarm-commands`, `app/alarm-ring`, `voice/mixer` | Words, DST, ring/snooze/missed/offline/restart/move, buttons, firm and math modes, undo, unreadable file, PC copy, tools, tones |
| `anthropic.test.ts` | 3 | `brain/anthropic` | Claude message conversion, cache breakpoints, tool-turn replay |
| `auth.test.ts` | 14 | `web/auth` | Login, setup code and password-change limits |
| `automemory.test.ts` | 20 | `features/automemory`, `notes`, `brain/orchestrator` | Parsing, cadence, forget races, update/drop, background fallback and pricing |
| `brain.test.ts` | 22 | `brain/*` | Splitter, `toSpeakable`, session memory, prompt tool lines, streaming, tool round, user isolation, retry, timeout, creator |
| `briefing.test.ts` | 13 | `features/briefing`, `weather`, `headlines`, `calendar`, `headsup`, `reminders` | Weather, headlines, private vs shared briefing, first-join briefing |
| `cached-tool.test.ts` | 1 | `brain/tools` | Cached read-only tools |
| `calendar.test.ts` | 8 | `features/calendar` | Zones, all-day, floating times, recurrence, URL rules, tool access |
| `cloud-stt.test.ts` | 2 | `speech/cloud-stt` | WAV, model, prompt and key sent; HTTP errors |
| `cloud-voice-defaults.test.ts` | 3 | `config` | Cloud voice speed and character cap follow the model |
| `commands.test.ts` | 19 | `app/commands` | `/join`, `/leave`, seat rules |
| `config-file.test.ts` | 18 | `web/secrets-file` (and the CLI) | Atomic writes, modes, broken files, long IDs, `adrian config` and `adrian check` |
| `config.test.ts` | 4 | `config` | Schema |
| `confirm-lines.test.ts` | 14 | `features/alarm-tools`, `gamenight`, `taste`, `notes`, `brain/tools` | Tools that say their own confirmation (edit_alarm, alarm_options, game-night join/leave, taste, remember); `asksMore` sends the turn to the model; empty fields the model filled in aren't changes |
| `controller.test.ts` | 86 | `conversation/controller` | Stops, listening windows, end of turn, repeated names, questions back, owners, quiet while gaming |
| `digest.test.ts` | 20 | `features/digest`, `gameservers` | Line wording and word limit, "since" words, history paging, Plex fallback |
| `dashboard.test.ts` | 30 | `web/metrics`, `web/dashboard`, `core/logger`, `core/calls` | Band accuracy, day and week percentiles by room and stage, voice and PC drops vs planned stops, restart reasons, the errors ring (dedup, redaction, ID masking), Tavily/Groq counts, every watched log message still in `src/`, the memory bound, the needs-attention rules, the release check |
| `discordinfo-tools.test.ts` | 80 | `features/discordinfo` | `message_member` limits, read-backs, threads, pings, names; `server_info` |
| `discordinfo.test.ts` | 5 | `features/discordinfo` | Helpers |
| `dm-talk.test.ts` | 6 | `brain/orchestrator`, `sessions`, `features/notes`, `automemory` | DMs stay out of public answers and memory |
| `eager.test.ts` | 3 | `core/eager` | Eager stream draining |
| `early-listen.test.ts` | 18 | `listen/pipeline` | The early listen at PCs: reuse only on identical samples, heard event identical with and without it, dropped on resumed speech, no decode for a second pause or speech being joined, window alignment, cancels |
| `fallback.test.ts` | 9 | `brain/fallback` | When to switch, stall deadline, pictures |
| `gamenight.test.ts` | 30 | `features/gamenight` | Presence or not, pings, cooldowns, order guards, sign-ups, channel choice |
| `games.test.ts` | 5 | `features/games` | Party games |
| `gameservers.test.ts` | 3 | `features/gameservers` | Ping parsing |
| `get.test.ts` | 12 | `packaging/get.sh` (run in bash) | ARM/no-systemd refusal before anything, packages asked for, newest release with its checksum, rate-limit fallback, update instead of install, `--version`, `--reinstall` |
| `handoff-discord.test.ts` | 7 | `features/handoff-discord`, `handoff` | Message watching, gating, closed schemas |
| `handoff.test.ts` | 49 | `features/handoff`, `music` | Links memory, "which one", others' links, `music_to_pc` rights, `pc_to_call`, `tell_call` |
| `headsup.test.ts` | 19 | `features/headsup`, `digest` | Gate, quiet wait, opt-out, servers that went down, `whats_new` |
| `helix-config.test.ts` | 7 | `config`, `core/logger`, `brain/tool-router` | Helix URL rules, bearer-token redaction |
| `host-check.test.ts` | 1 | `web/server` | Host header check |
| `identity.test.ts` | 4 | `app/identity` | Creator lines, impostors, gender lines |
| `install.test.ts` | 18 | `packaging/install.sh` (run in bash) | Every problem listed at once, `--check`, re-run over a live install keeps port and LAN, downgrade refused, foreign port refused, health accepts only her answer, cut-off downloads |
| `intents.test.ts` | 30 | `conversation/intents` | Stop, hold and weak phrases, other languages, stop as an order, bare "play" |
| `language.test.ts` | 3 | `speech/language` | English check, reply language, Spanish |
| `latency-harness.test.ts` | 1 | `app/stack`, `listen/pipeline` | Off unless `LATENCY_HARNESS=1`: end of speech to first audio through the real stack with stubbed models at prod delays (`LATENCY_RUNS`, `LATENCY_STT_MS`); needs Silero and Kokoro (`ADRIAN_MODELS`) |
| `ledger.test.ts` | 5 | `limits/usage-ledger` | Caps, hourly limit, owner exemption |
| `links.test.ts` | 7 | `features/links` | Pasted links |
| `local-voice.test.ts` | 5 | `app/local-voice` | Eager calibration when Kokoro is the English voice, nothing loaded when the cloud is primary, a failing cloud still gets the local voice, missing-model warning |
| `loudness.test.ts` | 3 | `audio/loudness` | BS.1770 loudness, gain, limiter |
| `manager.test.ts` | 14 | `app/manager`, `web/settings` | Start from config, failed start, retry, setup readiness |
| `mature.test.ts` | 3 | `brain/mature` | Mature mode lines |
| `mcp.test.ts` | 11 | `features/mcp` | JSON/SSE, sessions, paging, token errors, allow list, owners only, confirmations, reconnect |
| `media.test.ts` | 4 | `features/media` | Read-only, each key to its own app |
| `memory.test.ts` | 14 | `app/memory`, `app/manager` | meminfo parsing, the fit rule against real numbers, waiting until memory frees, loading anyway after 15 min, restarts skip the check |
| `mixer.test.ts` | 22 | `voice/mixer` | Ducking, lead, stalls, clipping, wake duck |
| `music-commands.test.ts` | 47 | `app/music-commands` | Definitions, cards, `/play`, `/music`, buttons, typed commands |
| `music-lookups.test.ts` | 141 | `features/music` | Lookups, matching, misheard names, autoplay, stalls, YouTube video |
| `music-polish.test.ts` | 22 | `features/music` | Lists, autoplay, who asked, unplayable songs, quiz clips, bare "play X" |
| `music-requests.test.ts` | 14 | `features/music`, `conversation/intents` | Local orders vs vague requests |
| `music-speed.test.ts` | 37 | `features/music` | Early yt-dlp start over stdin, the direct video search and its fallback, album and playlist ids, versions, other scripts, genres, lead wait, soft g, joined words |
| `music-taste.test.ts` | 28 | `features/music`, `taste`, `voice/mixer` | Artist requests, Deezer top songs, taste |
| `music.test.ts` | 15 | `features/music` | Prompt, titles, local commands, Plex, player |
| `notes.test.ts` | 29 | `features/notes` | Privacy by place, full list rules, old file format |
| `orchestrator-tools.test.ts` | 39 | `brain/orchestrator`, `satellite/tools`, `features/reminders` | Tool rounds, `speak`, fillers, stable prefix, stops, `asks`, planted orders, untrusted wrapping |
| `packaging.test.ts` | 52 | `packaging/*` (run in bash) | Pinned downloads, restore, update and rollback, auto-update, Node swap, `package.sh`, unit file, help text |
| `patch.test.ts` | 1 | `scripts/patch-voice.mjs` | DAVE patch applies |
| `pc-house.test.ts` | 10 | `satellite/tools` | House orders never reach the PC (connected or not), PC orders with house words still do, look-alikes (DoorDash, GarageBand, "the doors on youtube") |
| `pc-senses.test.ts` | 22 | `satellite/*`, `brain/images`, providers | Pictures, health, clipboard and screen, log redaction, private turns |
| `pcm.test.ts` | 6 | `audio/pcm` | PCM helpers |
| `pending-yes.test.ts` | 17 | `brain/tools` | Yes on the very next turn only |
| `quiet.test.ts` | 32 | `satellite/quiet` | Quiet while gaming, held items, release |
| `quiz.test.ts` | 40 | `features/quiz` | Matching, orders, rounds, judge limits, music lending |
| `recap.test.ts` | 18 | `features/recap` | Schedule, post once, missed weeks, retries, naming |
| `recorder.test.ts` | 1 | `satellite/recorder` | PC recordings |
| `redact.test.ts` | 2 | `transport/discord` | Voice debug redaction (media key, token, session id) |
| `reminders.test.ts` | 21 | `features/reminders` | DST, delivery retry and give-up, PC room, read-back |
| `room.test.ts` | 2 | `conversation/room` | Room talk |
| `satellite.test.ts` | 63 | `satellite/server`, `connection`, `devices`, `tools` | Pairing, lockout, frames, bad frames, PC tools, URL rule, search, power yes, cancel window |
| `secret-purpose.test.ts` | 5 | `config`, `web/settings` | A setting only names a key meant for its job |
| `servercontrol.test.ts` | 39 | `features/servercontrol`, `helix`, `gameservers` | Helix client and control flows |
| `setup-checks.test.ts` | 21 | `web/checks`, `web/explain` | Token shape and cleaning, intents, channel access from roles and overwrites, wrong-provider keys, no credit, rate limits, start-failure explanations, setup-code command |
| `shutdown.test.ts` | 9 | `app/shutdown` | Running vs starting vs setup/failed, a hanging or failing stop, a second signal, re-raise on Linux and Windows |
| `sounds.test.ts` | 2 | `features/sounds` | Sound effects |
| `speaker.test.ts` | 2 | `voice/speaker` | Stop after synthesis, plays to the end |
| `speech-stream.test.ts` | 12 | `speech/speechify`, `speech/piper`, `voice/speaker`, `audio/*` | Streamed sentences: same samples as the whole-sentence path for any chunking, fallback before the first audio, a break mid-sentence, split 16-bit samples, timeouts |
| `speech-text.test.ts` | 9 | `brain/speech-text` | `forSpeech` rules, links said as their site, emoji removed, splitter abbreviations, applying it twice |
| `speechify.test.ts` | 20 | `speech/speechify` | API, cache, budget, SSML, warm-up, broken sockets |
| `stack.test.ts` | 170 | `app/stack` and most of `src/` | The assembled bot: costs, PC requests, stops, follow-ups, rooms, timers, notes, DMs, quiz, alarms |
| `steam.test.ts` | 49 | `features/steam` | Accounts, caches, limits, every answer shape |
| `textchat-read.test.ts` | 25 | `app/textchat` | History format, follow-ups, reply limits, pings |
| `textchat.test.ts` | 2 | `app/textchat` | Reply splitting |
| `tool-router.test.ts` | 4 | `brain/tool-router` | Routing groups |
| `transport-kick.test.ts` | 4 | `transport/discord` | Kicks and own leave |
| `transport-reconnect.test.ts` | 26 | `transport/discord` | Disconnects, stuck connections, long outages, failed joins |
| `turn-hold.test.ts` | 44 | `listen/pipeline`, `speech/sherpa` | Smart Turn hold and join, `endsDangling`, one heard per clip |
| `update-safety.test.ts` | 10 | `packaging/adrian` (run in bash) | The update lock, the cut-off update note (keep, roll back or undo), the disk check, detaching from the terminal (Linux only: flock, setsid) |
| `wake.test.ts` | 16 | `wake/text-wake` | Strict and loose wake, renamed bot, other languages |
| `web-ui.test.ts` | 44 | `web/app.js` | Ended sessions, failing buttons, lost contact, wizard messages |
| `web.test.ts` | 32 | `web/*`, `app/manager`, `core/logger` | Admin API, write-only secrets, key routing, paths, CSRF, headers |

No unit test loads a real model; `speech/kokoro.ts`, `speech/piper.ts`, `speech/whisper.ts` and the real Parakeet path are checked by benches.

## bench/: hand-run benches

Benches answer "does this still work well with the real thing": real models, real APIs, real YouTube. They are not part of `npm test` and not in the release bundle. What you need:

- Run `npm run build` first; they import from `../dist/...`.
- Most take a normal config file (`<bot.json>`); keys are read from its `secretsFile`.
- Anything that loads sherpa-onnx (Parakeet, Kokoro, Whisper, Piper, or the whole stack) needs Linux x86_64 and `LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64`.
- Model benches use `claude-haiku-5-5` with `ANTHROPIC_API_KEY` hard-coded, not your configured `brain.model` (`ttft-survey.mjs`, `llm-check.mjs` and `lang-e2e.mjs` use the configured endpoint). They spend real money, usually cents per run; see [costs.md](costs.md).
- yt-dlp benches call YouTube from your address; heavy use can trigger YouTube's bot check.
- The `.py` benches run in a Python venv of their own (for example `venv/bin/python -I bench/asr-bark.py ...`).

| File | What it checks | Needs |
|---|---|---|
| `alarm-kit.mjs` | Helper: the alarm tools as the live bot has them, for other benches to include | (imported) |
| `alarm-orders.mjs` | Everyday alarm and timer requests reach the right tool with the right arguments, short replies | model key |
| `alarm-ring.mjs` | Real mixer plus `ringIn` on the wall clock: frames keep pace, memory stays flat | none |
| `alarm-tones.mjs` | Renders each built-in tone for 20 s to WAV, for listening and loudness checks | none |
| `alarm-words.mjs` | Stop, snooze and "I'm up" heard over every tone; tones alone give no alarm words | local models |
| `answer-length.mjs` | Sentences and words of real answers; `--real` uses the production prompt and tools from `prod-kit.mjs` | model key |
| `asr-bark.py`, `asr-granite.py` | Other ASR models over the same corpus | Python venv (Granite needs torch) |
| `asr-corpus.mjs` | Builds the speech-to-text shootout corpus (synthetic PC phrases with desk-mic damage, public corpora) | Kokoro, ffmpeg, optional Speechify key, downloaded corpora |
| `asr-hotwords.py` | Writes a hotwords file for sherpa biasing | Python |
| `asr-score.mjs` | Word error rate per set, key-word hit rate, latency | none |
| `asr-shootout.mjs` | Runs one speech-to-text model over the corpus | local models; `groq-*` models need a Groq key |
| `asr-speed.mjs` | Parakeet speed and memory | local model |
| `cache-check.mjs` | Prompt-cache reads and writes over a conversation | model key |
| `claude-vs.mjs` | Claude models vs Groq on the real prompt: first chunk, total, tokens, estimated cost | Anthropic and Groq keys |
| `cloud-voice.mjs` | Speechify latency and level | Speechify key (spends characters) |
| `creator-check.mjs` | The model credits the configured creator and refuses impostors | model key |
| `desk-followup.mjs` | Follow-ups at a PC without the name are answered; show and game audio stays `SILENT` | model key |
| `english-check.mjs` | Which utterances trigger the Whisper second pass | local models |
| `everyday.mjs` | 30 household voice questions on the production prompt: right tool or none, content, length, no "Sure!" openers; `--holdout` (19 more), `--long` (where short is wrong), `--keep` (safety warnings and lists asked for) | model key |
| `first-audio.mjs` | Time to first audio, whole first sentence vs first clause (the `stack.ts` comment cites medians of 1.26 s vs 1.39 s, so the whole sentence was kept) | model and Speechify keys |
| `home-pc.mjs` | House orders (doors, lights, the TV ...) at the desk and in the call never reach the PC; PC orders with house words still do | model key |
| `knows.mjs` | Notes asked about in a call, remember, search answers | model key |
| `live-facts.mjs` | Today's facts (sunset, weather, scores, prices, store hours) come from a tool, stable facts don't; `--holdout` for 8 more | model key |
| `lang-e2e.mjs` | Per language: Parakeet, English check, Whisper, reply, that language's voice | configured brain key, local models |
| `level-check.mjs` | Writes exactly what goes to Discord per sentence, for an ffmpeg loudness and true-peak check | Kokoro |
| `link-check.mjs` | What pasted links would play | network, yt-dlp |
| `llm-check.mjs` | Time to first token, first speakable chunk, total, tool use, cost | configured brain key |
| `mem-start.mjs` | Memory at start per component (`--cloud`: the cloud voice primary; `--dist` measures another build; `--json`) | local models (`node --expose-gc bench/mem-start.mjs <models> --cloud`) |
| `memory-check.mjs` | Roster, room talk, automatic memory and note privacy | model key |
| `memory-update.mjs` | Automatic memory rewrites contradicted notes and ignores chatter and other people's news | model key |
| `meter.mjs` | Helper (`node --import ./bench/meter.mjs bench/x.mjs ...`): per call tokens, cost and first-text time, per answer words and model calls, for any bench (`METER_OUT`) | (imported) |
| `mixer-stall.mjs` | Music through the mixer into a Discord-like player under event-loop stalls | network, yt-dlp |
| `multilang.mjs` | Speech per language, Whisper small vs turbo accuracy and speed | local models |
| `music-check.mjs` | Real YouTube through ffmpeg and the mixer with a voice in the middle | network, yt-dlp, ffmpeg |
| `music-compare.mjs` | Compares two `music-corpus.mjs` runs | none |
| `music-corpus.json` | 63 judged song requests by class (titles, artists, misheard, versions, non-English, genres, ambiguous); `paired` marks the 16-request subset | (data) |
| `music-corpus.mjs` | The music corpus through the real `classifyMusic`/`playNamed` path: hit rate, time to stream URL and first audio, lookups per request (`--routes` without network, `--record`/`--replay`) | network, yt-dlp, ffmpeg |
| `music-e2e.mjs` | Model to `play_music` to real lookups | model key, network |
| `music-follow-up.mjs` | Follow-ups without the name that start like music orders | model key, sherpa |
| `music-intent.mjs` | Indirect music requests reach the music tools | model key |
| `music-kinds.mjs` | Every request kind against real YouTube | network |
| `music-paired.mjs` | Two builds alternating on the paired subset (`--cap N` stops after N YouTube lookups) | network, yt-dlp, ffmpeg |
| `music-search.mjs` | What YouTube search picks for a query | network |
| `natural-samples.mjs` | Renders one answer across Kokoro voices (used to pick the default voice) | Kokoro |
| `pc-orders.mjs` | PC orders: right PC tool and arguments with a stub PC, short confirmations, power actions in two turns | model key |
| `pc-sites.mjs` | "Go to <site>" opens the site's own address, not a search page (8 sites) | model key |
| `prod-kit.mjs` | Helper: the live bot's tools and rule lines with stubs (`pc: 'connected' / 'absent'`, `runPc`, `onPc`), for the brain benches | (imported) |
| `prompt-size.mjs` | The cached prompt prefix in tokens (`count_tokens`, free), `--each` for every tool and rule | model key |
| `sabrina-render.mjs` | Renders changed lines in the Speechify voice, spaced 0.7 s apart | Speechify key (spends characters) |
| `server-info-check.mjs` | `server_info` read-only against a real Discord server, then tool choice | model key, Discord token (sends nothing) |
| `sidetalk-score.mjs` | Scores `dist/bench/sidetalk-bench.js` runs: wake recall, false wakes, CPU per segment, transcripts and decisions that differ | none |
| `slow-speaker.mjs` | A long answer with a slow voice is not cut off by the time limit | model key |
| `sound-check.mjs` | Sound-effect search and `play_sound` tool use | model key, network |
| `speak-first-lines.json` | The 12 lines for `speak-first.mjs` | (data) |
| `speak-first.mjs` | Time to first heard audio in the cloud voice for `speak-first-lines.json` (12 lines over 40 characters) | Speechify key (spends characters) |
| `speech-changed.mjs` | Lines whose spoken text differs between two builds, for `sabrina-render.mjs` | none |
| `speech-lines.json` | 80 lines (tool lines and model-style lines; every 4th held out) with their reference words, for `speech-words.mjs` | (data) |
| `speech-score.mjs` | Word error rate helper for the speech benches | (imported) |
| `speech-wavs.mjs` | Parakeet over rendered WAVs (the Sabrina check) | local models |
| `speech-words.mjs` | Kokoro says each line, Parakeet hears it: word error rate of the spoken text (`--oracle` for the floor) | local models |
| `stream-level.mjs` | Loudness of streamed cloud-voice sentences against the target | Speechify key (spends characters) |
| `stt-compare.mjs` | Local Parakeet vs Groq whisper-large-v3-turbo on PC phrases with noise | local models, Groq key |
| `taste-orders.mjs` | Taste requests, artist requests, saved opinions; Deezer to YouTube Music lookups only with `--live` | model key (network with `--live`) |
| `text-followup.mjs` | Text chat uses history, answers follow-ups, stays `SILENT` for side talk | model key |
| `ttft-survey.mjs` | Time to first token across models on one OpenAI-compatible endpoint (`EXTRA='{...}'` adds body fields) | endpoint key |
| `tts-speed.mjs` | Kokoro speed and memory | Kokoro |
| `wake-extra.mjs` | Synthesizes an extra wake corpus for the thin shapes (name at the end, talk about her, sound-alikes, lines said to someone called Adrian): 173 phrases, 4 Kokoro voices each, desk-mic noise | local models (Kokoro) |
| `wake-score.mjs` | Replays saved transcripts (`sidetalk-bench` and `wake-asr` runs) through a baseline and the current wake check on a fixed phrase split (every third phrase per class held out; held-out transcripts print only with `--final`); `--time` for the check's cost | none |
| `turn-bench.py` | Smart Turn vs the fixed 0.8 s wait (the `smart-turn.ts` header cites 460 clips: about half the mid-sentence cut-offs for about 0.2 s more waiting) | Python venv, clips |
| `turn-parity.py`, `turn-parity.mjs` | The TypeScript Smart Turn features and probabilities match the Python reference | onnxruntime, Python venv |
| `corpus/phrases.json` | Wake and not-wake phrase lists (data; not read by any script in the repo) | |

Write new benches the same way: one file, a usage line in its header comment, made-up speaker names, no real recordings or IDs, and print a short score line.

## packaging/: install, run, update

All of this ships inside the release bundle except `package.sh`. The [install guide](install.md) explains it from the user's side.

| File | Lines | Purpose |
|---|---|---|
| `install.sh` | 411 | Native installer and uninstaller (root): preflight that lists every problem at once and changes nothing until all pass (x86_64, glibc 2.28+, systemd with the WSL fix, free space under `/opt` and `/var/lib` together on a shared disk, the download hosts reachable, missing tools as exact apt or dnf packages, RAM warning under 4 GB, ffmpeg warning, a `--port` another program holds, an older bundle than the installed one), `adrian` system user, directories with symlink refusal, pinned Node and models, release unpacked to `/opt/adrian/releases/<v>`, `current` symlink, first config, unit install, health wait (only her own answer counts; a lost port or out-of-memory is named from the journal), setup code. Safe to run again: keeps the config, keys, port and LAN setting, and restarts the service on the new files. Downloads go under `/opt/adrian/.install-*`, cleared by the next run. Options `--bundle`, `--yes`/`-y`, `--check` (check only, no root needed), `--port`, `--lan`, `--no-lan`, `--no-start`, `--allow-downgrade`, `--uninstall`, `--keep-data`, plus `--mode native` and `--profile recommended` (the only values accepted so far). Everything it creates is recorded in `/var/lib/adrian/install-manifest.json`, which `--uninstall` reads. |
| `get.sh` | 145 | One-step install, fetched from `main` with curl: refuses ARM and no-systemd machines first, installs missing system packages after asking (`--yes`, `--no-packages`), finds the newest release (falls back to the release page's redirect when the GitHub API is rate-limited), downloads the bundle with its `.sha256` (refused without one), checks it and runs `install.sh`. On an installed machine it runs `adrian update` instead (`--reinstall` repairs). `--version X.Y.Z` pins a release; other options go to the installer. | 
| `downloads.sh` | 107 | Sourced, not run. Pinned downloads with SHA-256 (Node 22.23.4, Silero VAD, Parakeet v3, Whisper small, Piper Vietnamese, Kokoro, Smart Turn v3.2, yt-dlp 2026.08.19), HTTPS and TLS 1.2 only, gives up on a stall but never on total time, atomic Node swap, `refuse_symlinks`. |
| `upgrade-prep.sh` | 50 | Run from the new release by `adrian update`: models, service file (keeps the old one), update units, Node. |
| `package.sh` | 41 | Builds `adrian-voice-<v>-linux-x64.tar.gz` and its `.sha256` on Linux x86_64. Refuses to build unless typecheck and tests pass; sets `ONNXRUNTIME_NODE_INSTALL=skip`; strips sources, tests, build folders and non-Linux onnxruntime binaries. |
| `adrian` | 465 | The `adrian` management CLI (bash): status, logs, start/stop/restart, url, setup-code, reset-admin, secret, check, voice, config, satellite, doctor, backup, restore, update, auto-update, rollback, uninstall, version. Releases come from `ADRIAN_UPDATE_REPO` (default: this repo). `update` at a terminal runs in its own session (`setsid`) and the terminal follows `/opt/adrian/update.log`, so a dropped SSH connection or Ctrl+C can't stop it halfway (`ADRIAN_DETACH=0` runs it in the foreground); `flock` on `/opt/adrian/update.lock` keeps the timer, a manual update and `rollback` apart; it needs 500 MB free; `/opt/adrian/update-in-progress` lets the next update, rollback or hourly check finish or undo an update that was cut off. `doctor` explains a failed start, checks file ownership (prints the `chown`) and that discord.com and github.com can be reached. |
| `adrian-voice.service` | 63 | Main systemd unit: user `adrian`, `Restart=always`, `CPUQuota=400%`, `MemoryHigh=4G`, `MemoryMax=5G`, full hardening (`ProtectSystem=strict`, empty capability set, `SystemCallFilter=@system-service`, ...). `MemoryDenyWriteExecute` is off on purpose (V8 JIT). |
| `adrian-update.service` | 13 | Oneshot `adrian update --auto`, low priority, 2 h timeout. |
| `adrian-update.timer` | 11 | 15 min after boot, then hourly, random delay up to 10 min. |
| `docker/Dockerfile` | 37 | Two stages: a fetch stage (Node and model downloader) and the runtime image (ubuntu:24.04, ffmpeg, uid 10001, health check). |
| `docker/build.sh` | 18 | Builds `adrian-voice:<v>` and `adrian-voice-fetch:<v>` from a bundle. |
| `docker/compose.yaml` | 52 | `models` one-shot job and the `adrian` service: loopback publish, read-only root, no capabilities, 4 CPUs, `mem_limit: 4g`. |
| `docker/entrypoint.sh` | 16 | First start: minimal config and empty secrets file, then `dist/app/main.js`. |
| `docker/fetch-models.sh` | 12 | Runs `install_models` into the models volume. |

What must stay true: every download is pinned by URL and SHA-256; root never follows a symlink inside service-owned directories; restore accepts only `etc/adrian` and `var/lib/adrian` with no links; an update is judged against the version it replaces and rolls back by itself; auto-update never restarts her while `busy`; no bundle is built unless tests pass. A change to the update logic only takes effect on the update after the one that ships it, because updates run the already-installed CLI. `packaging.test.ts` pins some exact text: the README memory sentence must keep `4 GB free (about 3.5 GB once the language voices load`, and the unit must keep `about 3.5 GiB by default`.

## scripts/

| File | Lines | Purpose |
|---|---|---|
| `patch-voice.mjs` | 50 | Runs on every `npm ci` (postinstall). Fixes a bug in `@discordjs/voice` 0.19.2 (discord.js issue #11653): a DAVE transition id of 0 was treated as "none", so a user already talking when the bot joined was never decrypted. Edits both builds, is idempotent, and fails the install if the version is not exactly 0.19.2 or the target line does not match exactly once. Tested by `patch.test.ts`. |

## web/: admin UI frontend

Served by `src/web/server.ts` from this folder. Plain browser JavaScript, no framework and no build step. The CSP forbids inline scripts and styles, so keep code in `app.js` and set styles through the DOM (`el.style.x`).

| File | Lines | Purpose |
|---|---|---|
| `index.html` | 19 | Shell: header, notice bar, `#app`, loads `app.js` as a module; sets `<meta name="color-scheme" content="light dark">`. |
| `app.js` | 803 | The whole page: `h()` element helper, `api()` fetch wrapper (adds `X-CSRF-Token`, handles an ended session), claim view, login view, the 7-step wizard (Check, Discord, Language model, Search, Voice, Limits, Finish), the dashboard tabs (status, settings, keys, logs, account); the Status tab's dashboard cards from `/api/dashboard`, with the old cards as the fallback when it fails. |
| `style.css` | 97 | Styles as CSS variables, light and dark (`@media (prefers-color-scheme: dark)`). |

Tested by `web-ui.test.ts` (the real file in a fake DOM). Known key names for the Keys tab are listed in `app.js` (`dashKeys`). Static files are cached in memory until the service restarts.

## test-env/, assets/, docs/

| Path | Purpose |
|---|---|
| `test-env/Dockerfile`, `entry.sh` | A systemd-as-PID-1 container (default base ubuntu:24.04) for installer tests. |
| `test-env/clean-install-test.sh` | Fresh install, checks (service, permissions, loopback UI, setup code, voice preview under the unit's hardening, clean failure with fake credentials, no secrets in the journal), backup, `install.sh --check`, doctor's "what to do" for the fake-token start, a re-run over the live install (keeps port, LAN setting, admin account and keys), uninstall with a file and user diff. |
| `test-env/update-test.sh` | Update, automatic rollback of a broken release, manual rollback, bad checksum and same version refused, no update note or temp folders left behind, the update lock. Works with any base bundle version. |
| `test-env/upgrade-0.7-test.sh` | The historic 0.6.x to 0.7.x upgrade path. |
| `test-env/compose-test.sh` | Docker Compose mode on the host's Docker (project `adrian-cit`, port 8795). |
| `assets/test-clip.ogg` | Clip for the proof-of-concept runner. |
| `docs/` | These docs. Start at [README.md](../README.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). |

## Root files

- `package.json`: name `adrian-discord-voice`, `"private": true`, MIT. Scripts `build`, `typecheck`, `test`, `poc`, `postinstall`. Runtime dependencies, all exact: `discord.js` 14.27.0, `@discordjs/voice` 0.19.2 (patched), `@snazzah/davey` 0.1.12 (DAVE), `@anthropic-ai/sdk` 0.131.0, `sherpa-onnx-node` 1.13.8, `onnxruntime-node` 1.30.0 (Smart Turn), `zod` 4.6.7, `ws` 8.22.0, `@node-rs/argon2` 2.2.1, `ical.js` 2.2.1, `prism-media` 1.3.5, `opusscript` 0.0.8; optional `@discordjs/opus` 0.10.0 (native Opus; falls back to `opusscript`). Dev: `typescript` 7.0.2, `vitest` 5.0.4, `@types/node`, `@types/ws`.
- `tsconfig.json`: `rootDir` `src`, `outDir` `dist`, strict options listed under [At a glance](#at-a-glance).
- `SECURITY.md`: how to report a vulnerability. The security model is in [security.md](security.md).

## State files and the module that owns each

All under the state folder (`ADRIAN_STATE`, default `/var/lib/adrian`), written atomically. `adrian backup` includes them (not the models).

| File | Owner |
|---|---|
| `admin.json`, `setup-code` | `web/auth.ts` |
| `usage.json` | `limits/usage-ledger.ts` |
| `voice-usage.json` | `speech/speechify.ts` (`CharBudget`) |
| `dashboard.json` | `web/metrics.ts` |
| `satellites.json` | `satellite/devices.ts` |
| `held-while-gaming.json` | `satellite/quiet.ts` |
| `pc-recordings/` | `satellite/recorder.ts` (opt-in) |
| `alarms.json`, `alarm-sounds/*.pcm` | `features/alarms.ts`, `app/alarm-commands.ts` |
| `reminders.json` | `features/reminders.ts` |
| `notes.json` | `features/notes.ts` |
| `music-taste.json` | `features/taste.ts` |
| `heads-up.json` | `features/headsup.ts` |
| `weekly-recap.json` | `features/recap.ts` |
| `game-night.json` | `features/gamenight.ts` |
| `game-server-jobs.json` | `features/servercontrol.ts` |
| `install-manifest.json` | `packaging/install.sh`, not the bot (what the installer created, written once at install time with a plain write; `--uninstall` reads it, so don't delete it) |
| `models/` | the installer (`packaging/downloads.sh`; layout in `MODEL_LAYOUT`, `web/checks.ts`) |

Memory only, lost on restart: conversation history, admin sessions, music queues and volumes, per-room voice settings, pasted links, rate limits and cooldowns, caches, party games and quizzes.

## Stale comments and known mismatches

Comments in the code that no longer match what it does. Don't repeat them in docs; fix them when you touch the file.

- `brain/tools.ts` and `brain/orchestrator.ts` headers say the tools are read-only. Many tools act now (PC control, alarms, home control, Discord messages, server control).
- `core/interfaces.ts`: "Later milestones ... no implementations yet" (VAD, wake, STT and TTS all exist), and the `Tool.run` comment says only `message_member` acts outside the bot.
- `brain/tool-router.ts` says only `get_time` and `web_search` are always on; every ungrouped tool without a `route` is.
- `brain/sessions.ts` mentions "persistent memory later"; history is memory only.
- `config.ts` says the bot token can come from the environment; secrets are read only from the secrets file.
- `web/checks.ts` points to `docs/milestone-2.md` and `docs/milestones-4-6.md`, which do not exist.
- `satellite/server.ts` mentions an accent color in the welcome; none is sent. `satellite/senses.ts` says private turns last 10 minutes; the stack runs them for 60.
- `audio/pcm.ts` `decimate48kTo16k` mentions milestone 3 and has no caller.
- `speech/speechify.ts` header says Simba 3.2; the default model is `simba-3.5`.
- `packaging/adrian-voice.service` says every language voice loads at start, and the `install.sh` low-memory warning implies about 3.5 GB from the start; since the lazy-loading change they load the first time someone speaks another language (`stack.ts`). The test-pinned unit wording is kept on purpose; see [packaging/](#packaging-install-run-update).
