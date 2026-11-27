# Architecture

How the A.D.R.I.A.N. service is put together: what runs, what loads when, the path a spoken request takes in a Discord call and at a PC, how alarms and music get to your ears, what is kept on disk, and what happens when something fails.

This is the bot repo, and it is what runs in production. The Windows PC app (`crates/desktop`) and its PC actions (`crates/pc-control`) live in the main repo, [A.D.R.I.A.N](https://github.com/Riqqqque/A.D.R.I.A.N). That repo also holds an older Rust household server (`crates/server`, `crates/satellite`, `web/`). That server is not part of anything described here, and the PC app does not talk to it.

Related docs: [codebase-map.md](codebase-map.md) (every file), [configuration.md](configuration.md) (every key), [tools.md](tools.md) (every model tool), [costs.md](costs.md), [satellite.md](satellite.md) (the PC protocol), [security.md](security.md).

## Contents

- [Components](#components)
- [Processes, threads and workers](#processes-threads-and-workers)
- [Start-up order](#start-up-order)
- [Models and when they load](#models-and-when-they-load)
- [Rooms](#rooms)
- [A spoken turn in a Discord call](#a-spoken-turn-in-a-discord-call)
- [A spoken turn at a PC](#a-spoken-turn-at-a-pc)
- [Timings](#timings)
- [Text chat](#text-chat)
- [Music](#music)
- [Alarms, timers and reminders](#alarms-timers-and-reminders)
- [State on disk](#state-on-disk)
- [What lives only in memory](#what-lives-only-in-memory)
- [Config and secrets](#config-and-secrets)
- [What leaves the server](#what-leaves-the-server)
- [Failure handling](#failure-handling)
- [Design rules](#design-rules)

## Components

One Node process (`node dist/app/main.js`) does everything:

```
                         ┌──────────────────────── one Node process ──────────────────────────┐
 Discord gateway ◄──────►│ discord.js client: slash commands, text chat, DMs, voice states    │
 Discord voice (UDP) ◄──►│ DiscordVoiceTransport ──► "discord" room                           │
                         │                                                                    │
 PC app (WebSocket) ◄───►│ satellite server (/satellite, port 8791) ──► one "sat:<id>" room   │
                         │ (satellite.bind, default 0.0.0.0)          per connected PC        │
                         │                                                                    │
                         │  each room: ListeningPipeline → ConversationController → respond() │
                         │             Speaker → Mixer → its transport                        │
                         │                                                                    │
                         │  shared by all rooms: Parakeet ASR, voices (Kokoro, Piper,         │
                         │  Speechify), Smart Turn, Whisper, the orchestrator and its tools,  │
                         │  session memory, the usage ledger, alarms, reminders, notes        │
                         │                                                                    │
 browser on loopback ◄──►│ admin web UI (127.0.0.1:8790): setup wizard, dashboard, JSON API   │
                         └────────────────────────────────────────────────────────────────────┘
                                │                  │                       │
                        language model     cloud voice / STT       YouTube, Deezer, Plex,
                        (Claude or any     (Speechify, Groq,       Tavily, Open-Meteo, RSS,
                        OpenAI-compatible) both optional)          iCal, MCP, Helix, Steam ...
```

| Component | Main files | Job |
|---|---|---|
| Entry and lifecycle | `src/app/main.ts`, `src/app/manager.ts` | Resolve paths, start the admin UI, then start the voice stack; restart it on settings changes; retry failures that can pass |
| Wiring | `src/app/stack.ts` | Builds every piece below and connects them. Rooms, rights, local phrases, `respond()`, cost accounting, PC rooms |
| Discord voice | `src/transport/discord.ts` | Join, rejoin, kicks and moves; one decoded Opus stream per person; playback (Opus 128 kbps, FEC) |
| PC link | `src/satellite/*` | WebSocket server, pairing, one connection per PC, PC tools, quiet-while-gaming, opt-in recordings |
| Listening | `src/listen/pipeline.ts`, `src/speech/sherpa.ts`, `src/wake/text-wake.ts`, `src/speech/smart-turn.ts` | Resample, VAD, end-of-turn check (PC only), ASR, wake check on the text |
| Turn-taking | `src/conversation/controller.ts`, `intents.ts`, `room.ts` | Queue, follow-up windows, stops, barge-in, owners; phrases answered without the model; recent call talk |
| Brain | `src/brain/*` | Prompt, tool rounds, streaming, SILENT, retries, fallback model, per-person history |
| Features | `src/features/*`, `src/satellite/tools.ts` | The model's tools: alarms, reminders, notes, music, PC control, home control, game servers and more ([tools.md](tools.md)) |
| Voice out | `src/speech/{kokoro,piper,speechify}.ts`, `src/voice/speaker.ts`, `src/voice/mixer.ts` | Text to speech, loudness to about -16 LUFS, one mixed 48 kHz stream per room |
| Limits | `src/limits/usage-ledger.ts` | Daily and monthly dollar caps, per-person hourly limit (`limits.perUserPerHour`, owners exempt) |
| Admin UI and CLI | `src/web/*`, `web/`, `src/cli/tool.ts`, `packaging/adrian` | Wizard, dashboard, settings, secrets (write-only), the `adrian` command |

For the file-by-file list see [codebase-map.md](codebase-map.md).

## Processes, threads and workers

| What | Where it runs | Notes |
|---|---|---|
| Event loop (main thread) | the Node process | Discord gateway and voice, the mixer's 20 ms frame clock, the satellite WebSocket, the admin HTTP server, Silero VAD (small 512-sample windows, synchronous), the controller, the orchestrator and tool calls. Anything that blocks it for more than the mixer's 160 ms lead makes music skip. |
| sherpa-onnx native calls | native threads, off the event loop (`decodeAsync`, `generateAsync`) | Parakeet (`listen.asrThreads`, default 2), Whisper (`listen.whisperThreads`, default 4) and Kokoro and Piper (`voice.threads`, default 4) each have their own one-job-at-a-time queue. onnxruntime's worker threads spin while they wait, so extra threads cost CPU even when they barely speed a decode up (`src/bench/sidetalk-bench.ts`). All rooms share these queues, but different engines can run at once (a Kokoro job beside a Piper job, a Parakeet decode beside a Whisper one). |
| Smart Turn worker | `worker_threads` (`src/speech/smart-turn-worker.ts`) | End-of-turn model for PC rooms. onnxruntime with 1 intra-op and 1 inter-op thread. Moved off the main thread on 2026-11-08 (commit 43b548a): it had blocked the event loop for up to 172 ms per PC segment; on the worker it blocks it for 1 ms. |
| Calendar worker | `worker_threads` (`src/features/calendar-worker.ts`) | Expands iCal recurrences. Started on first use, stopped after 5 idle minutes. A busy calendar took about half a second on the main thread. |
| ffmpeg | child process | One per playing track, quiz clip, sound effect or alarm clip being saved. Killed with SIGKILL. |
| yt-dlp | child process | One per lookup, 25 s timeout. The stream lookup's yt-dlp starts beside the search and waits for the video address on stdin (`--batch-file -`), so Python's start-up is hidden behind the search; if nothing is found, stdin closes and it exits without asking YouTube anything. Runs with `--encoding utf-8`. Stopped with SIGTERM, never SIGKILL, so it can clean its temp folder. |
| Periodic timers | event loop | Alarm clock tick 1 s, reminders tick 1 s, recap tick 60 s, quiet-while-gaming sweep 30 s, empty-call check 30 s (music stops after 2 min, leaves a non-home channel after 10 min), alarm list push to PCs hourly, satellite ping 30 s. |
| Auto-update | separate systemd unit (`adrian-update.timer`) | Only when `adrian auto-update on`. Hourly, skips while `busy` ([install.md](install.md)). |

The systemd unit (`packaging/adrian-voice.service`) runs the process as user `adrian` with `CPUQuota=400%`, `CPUWeight=50`, `IOWeight=50`, `Nice=5`, `MemoryHigh=4G`, `MemoryMax=5G`, `TasksMax=256`, `Restart=always`, `RestartSec=20`. Docker mode uses `cpus: 4` and `mem_limit: 4g`.

## Start-up order

`src/app/main.ts`:

1. Paths: config from `argv[2]`, else `ADRIAN_CONFIG`, else `/etc/adrian/config.json`. Secrets from `secretsFile` in the config, else `ADRIAN_SECRETS`, else `secrets.env` next to the config. State from `ADRIAN_STATE`, else `/var/lib/adrian`. Models from `ADRIAN_MODELS`, else `<state>/models`.
2. Usage ledger, admin auth, stack manager, and the SIGINT/SIGTERM handlers (`src/app/shutdown.ts`). They go in before the voice stack starts, so a signal during model loading is logged (`shutting down` with the signal, state, uptime and memory) and exits at once instead of waiting for the load.
3. Admin web server on `server.host:server.port` (default `127.0.0.1:8790`). If no admin account exists yet, it writes a setup code (`sudo adrian setup-code` shows it).
4. `stack.restart()`: if the config is incomplete (no Discord token, no channel, no model or key, no model paths), the stack stays in `setup` and only the admin UI runs. Otherwise the voice stack starts. On Linux, before the speech models load the first time, the manager reads `/proc/meminfo`: if available memory plus swap above earlyoom's floor, minus the estimated need (`startNeedMb`: about 1030 MB, 1550 MB with Kokoro at start), leaves less than 6% of RAM, the start is put off (`LowMemoryError`, retried with the usual backoff; after 15 minutes it loads anyway). A restart with the models already loaded skips this.

`startVoiceStack` (`src/app/stack.ts`), in order:

1. Checks the `listen` and `voice` sections and `DISCORD_TOKEN`. Asks Discord which privileged intents the portal allows; any doubt counts as off, because asking for an intent that is off fails the login.
2. Speech: Parakeet, the Kokoro voice object, the Piper Vietnamese voice object (its model loads on first use), and the Speechify voice if there is a `cloudVoice` section with `enabled` (the default) and its key exists. Then `prepareLocalVoice` (`src/app/local-voice.ts`): when Kokoro is the English voice (no cloud voice, or the month's characters already spent) it loads and calibrates the default voice's loudness now (`tts loaded and calibrated`); when the cloud voice speaks English, Kokoro loads on first use instead (`local voice loads on first use`), saving about 0.5 GB. The start log lines carry memory figures (`rssMb`, `availMb`, `swapFreeMb`).
3. Mixer, `VoiceRouter` and `Speaker` (one set of voices for every room).
4. Music sources: YouTube if the yt-dlp binary exists, Plex if `music.plexBackup` and `PLEX_TOKEN`. ffmpeg is probed with `-version`. Music exists only with ffmpeg and at least one source.
5. Rooms, the PC recorder, the power-down window, quiet-while-gaming.
6. Opus encoder probe (native `@discordjs/opus` if its prebuild loads, else `opusscript`).
7. Reminders, alarms, notes, taste, links, game night, party games, room talk, heads-up, recap, weather, headlines, calendars, briefing, quiz.
8. The brain, if `brain` is set and its key exists: the tool list, MCP servers, the main and fallback models, automatic memory, the quiz judge, two orchestrators (one for servers and calls, one for DMs).
9. The Discord room's controller, the wake detector, cloud STT, the Discord listening pipeline. Slash commands, text chat and typed music commands.
10. `client.login()`. On ready: join the home channel, start reminders, alarms, the recap and any server-control jobs left running.
11. Smart Turn, if satellites are on, `satellite.unfinishedWaitMs > 0` and `<models>/smart-turn-v3.2-cpu.onnx` exists.
12. The satellite WebSocket server, if `satellite.enabled` and a state folder exists.
13. With the cloud voice on, a few short fixed lines ("Yes?", "Okay.", the fillers, owner greetings) are synthesized once so they play instantly later.

## Models and when they load

All model files are pinned by URL and SHA-256 in `packaging/downloads.sh` and live in the models folder (`MODEL_LAYOUT` in `src/web/checks.ts`).

| Model | File or folder | Runs on | Loaded |
|---|---|---|---|
| Silero VAD | `silero_vad.onnx` | CPU, 1 thread per speaker stream | On the first audio from each person (one instance per person heard) |
| Parakeet TDT 0.6B v3, int8 | `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/` | CPU, `listen.asrThreads` (2) | At start. Kept across stack restarts (`SpeechModels`) |
| Kokoro 82M multi-language, fp32 | `kokoro-multi-lang-v1_0/` | CPU, `voice.threads` (4) | The engine for the default voice's language at start when Kokoro is the English voice; with the cloud voice primary, the first time it stands in (or the wizard's first preview). Each other language prefix gets its own engine on first use |
| Piper Vietnamese | `vits-piper-vi_VN-vais1000-medium/` | CPU | First Vietnamese answer |
| Whisper small, int8 | `sherpa-onnx-whisper-small/` | CPU, `listen.whisperThreads` (4) | First question that looks neither English nor Spanish (needs `languages` on) |
| Smart Turn v3.2 | `smart-turn-v3.2-cpu.onnx` | CPU, worker thread | After login, only with PC satellites and `satellite.unfinishedWaitMs > 0` |
| yt-dlp | `yt-dlp_linux` (2026.08.19) | child process | Per lookup |
| Language model | cloud (or a local OpenAI-compatible server) | | Per request |
| Speechify `simba-3.5`, voice `sabrina` | cloud | | Per English sentence, with a `cloudVoice` section (`enabled`, the default) and its key |
| Groq `whisper-large-v3-turbo` | cloud | | Per request for her, only when `cloudStt.enabled` |

Memory: Whisper and the other languages' voices held about 1.3 GB when they loaded at every start, so since commit 43b548a (2026-11-08) they load on first use. The maintainer measured 1.52 to 1.64 GB of resident memory right after start across versions 0.15.4 to 0.17.1 (2026-11-08 to 2026-11-19). With the cloud voice primary, Kokoro (about 0.5 GB with its onnxruntime arena) no longer loads at start: `bench/mem-start.mjs` on Windows measured 1.59 GB before and 1.10 GB after, steady and peak alike; the server's figure is not measured yet. The admin wizard's hardware check warns under 4 CPU threads, under 4 GiB of memory and under 2 GiB of free disk.

## Rooms

A room is one place she can hear and speak. Each has its own mixer, speaker settings (voice volume and speed), music player, sound player and conversation controller.

| | Discord room | PC room |
|---|---|---|
| Key | `discord` | `sat:<deviceId>` |
| Created | at start | when a paired PC connects; removed when it disconnects |
| Who is heard | every member, each on their own stream | the PC mic, counted as the PC's owner (a Discord user ID set at pairing) |
| VAD silence that ends a phrase | `listen.minSilence` (0.5 s), or the Discord stream ending after `silenceMs` (800 ms) | `max(listen.minSilence, 0.8)` s, plus the PC's own `speech_end` |
| End-of-turn hold (Smart Turn) | never | up to `satellite.unfinishedWaitMs` (1200 ms) for speech meant for her that sounds unfinished |
| Follow-up window after an answer | 8 s | 20 s |
| Talking over her stops her after | 2.5 s | 0.6 s |
| Audio out | Opus to Discord | 48 kHz mono s16le binary WebSocket frames |

Both rooms share the queue limit (2 waiting), the 10 s wait limit and the 1.5 s duplicate-wake window (`DEFAULT_CONTROLLER_OPTIONS` in `src/conversation/controller.ts`; PC overrides in `stack.ts`). Tools find the asker's room through `ctx.channelId`.

The satellite WebSocket listens on all interfaces by default (`satellite.bind` `0.0.0.0`, `satellite.port` 8791), unlike the admin UI, which is loopback-only. It only runs with `satellite.enabled`. Read [satellite.md](satellite.md) and [security.md](security.md) before exposing it beyond your LAN.

Outside the home channel she leaves after 10 minutes with nobody else there.

## A spoken turn in a Discord call

```
 person speaks in the call
   │  Discord: Opus per person, DAVE end-to-end encryption (@discordjs/voice 0.19.2)
   ▼
 DiscordVoiceTransport ── decode, stereo → mono 48 kHz ─────────────────── per person
   ▼
 Downsampler 48 → 16 kHz ─► Silero VAD (0.25 s preroll) ────────────────── per person
   │  phrase closes after listen.minSilence (0.5 s) of silence,
   │  or when the stream ends after silenceMs (800 ms)
   │  clips under 0.3 s are dropped
   ▼
 Parakeet ASR (one shared recognizer, one decode at a time)
   ▼
 text wake check (matchLoose): "hey Adrian ...", "Adrian, ...", or the wake
   │  phrase later in the sentence ("yo wait, hey Adrian, ...")
   ▼
 heard() in stack.ts
   │  alarm words first (stop, snooze, "I'm up" for their ringing alarm, no name needed)
   │  is it for her?  woke, or inside their listening window (judged from when they
   │                  STARTED talking)
   │  optional cloud second listen (Groq), only for speech already judged for her
   │  language check → Whisper second pass if not English or Spanish
   │  every clip, side talk included, goes into room talk (memory, 5 min, 24 lines)
   ▼
 ConversationController.heard()
   │  stops, hold phrases, "Yes?" for a bare wake, queue of 2, owners first,
   │  continuations, follow-up windows
   ▼
 respond()
   ├─ local phrase? (time, thanks, bye, repeat, volume, speed, clear music orders,
   │   quiz answers) → spoken directly, no model call, no cost
   ▼
 usage ledger check (monthly cap, daily cap, per-person hourly limit
   │  `limits.perUserPerHour`, owners exempt)
   ▼
 orchestrator.ask() → language model, streamed
   │  prompt: cached stable part + tools + history │ this turn: who's in the call, room
   │                                               │ talk, the asker's notes, music state
   │  up to 3 tool rounds (4 model calls at most); a tool that confirms in its own
   │  words, or asks a yes/no question, ends the turn without another model call
   ▼
 SentenceSplitter (whole sentences, at most 220 characters) → toSpeakable
   │  (and forSpeech in the English voices: times, units, dates, symbols)
   ▼
 Speaker: per sentence, Speechify (English) or Kokoro / Piper → level to -16 LUFS,
   │      trim silence, pause by punctuation, resample to 48 kHz stereo.
   │      Speechify sentences over 40 characters stream: they play as their
   │      audio arrives (playback opens once 0.2 s is in)
   ▼
 Mixer: speech at full level, music ducked to 0.2 under it, 20 ms frames on the
   │    wall clock with a 160 ms lead
   ▼
 Discord audio player (Opus 128 kbps, FEC)
```

Steps that matter when you change things:

- **Wake on text, not sound.** The decision is made on the transcript (`src/wake/text-wake.ts`), so "Hadrian built a wall" or "Adrian's coming over" do not wake her. A loose wake goes to the model as a follow-up that it may answer with `SILENT`: the name followed by talk about her ("is in", "will handle", "said", "and"), and from the next release a question with the name at the end ("what time is it, Adrian?"; the words before the name are the request) or the bare name after a lead-in ("hold on guys. Adrian, what time is it?"). A loose wake still runs stops and hold phrases without the model, but from the next release the lead-in and name-at-the-end paths don't wake on a stop, a hold or the bare name ("can you stop, Adrian?" is left to whoever is called Adrian), exclamations and game talk about someone ("what a save, Adrian", "can you heal Adrian?") don't wake, and an everyday greeting ("good morning", "hey there", "excuse me") wakes only when what follows is something only she does; anything else after it is judged. A loose wake hands the model the whole sentence, name included, with a judge line saying her name was in it but maybe about her rather than to her, and keeps its local words unless the cloud's (or Whisper's) words also wake her. The loose-wake and follow-up judge lines live together in `src/brain/followup.ts` and share one list of what isn't for her in each place (at a PC: words to people nearby, passing her answer on, talk about her, show and game audio, lyrics; in a call: talk to or answering someone else, game callouts, reactions). A follow-up has no name in it, so when unsure it stays silent unless it's a question or an order; a loose wake leans to answering (next release).
- **The window is judged from when the person started talking** (`startedAt`), not from when the transcript arrived.
- **The model's text is read in as fast as it comes** (`src/core/eager.ts`) while earlier sentences are still being spoken. `brain.totalTimeoutMs` (20 s) limits generating the answer, not speaking it. A slow tool extends it to that tool's own timeout plus 8 s. Playback has a 2 minute hard cap.
- **Short answers.** The stable prompt defines a short answer (one sentence under twenty words; at most two short sentences for how, why and what-should-I questions), and every spoken turn repeats the length rule last, before the person's words (`SPOKEN_TURN` in `src/brain/orchestrator.ts`; text chat doesn't get it), with "a plain fact is just the fact, no backstory". A safety warning that matters and every item of a list they asked for are always kept: the stable prompt says so ("Two things short never cuts"); from the next release `SPOKEN_TURN` no longer repeats that exception.
- **Live facts are looked up.** The stable prompt says the model's knowledge stops well before today, and that anything that changes day to day or depends on where they are (sunrise and sunset, the weather, scores, prices, store hours, what's open) is looked up, never answered from memory (next release; `bench/live-facts.mjs`).
- **Confirmations say themselves.** Tools that only confirm (alarm edits and settings, game-night sign-ups, taste, remember, the PC tools and more) return their own spoken line, so the turn ends after one model call. When the person's words also ask something, or give another order after a break ("I love Frank Ocean, play something of his"; a leading name, filler or polite "can you" doesn't count), the model answers instead (`asksMore`; from the next release it also gates the alarm, timer, reminder and game-night sign-up lines). The PC lines and the game-night "Pinged them." line don't check it, and an order after a full stop ("Set a timer. Play some lofi.") isn't seen.
- **A filler** ("One sec.", "Let me check.", "On it.") is said when a slow tool has not answered within 900 ms and nothing has been said yet.
- **After the answer**: cost is added to the ledger, automatic memory may run (every 4 exchanges per person), an interrupted answer is marked in history so it isn't picked up again, and an `answered` log line records the timing fields below.
- **Barge-in** (talking over her for `bargeInMs`: 2.5 s in a call, 0.6 s at a PC) counts only from the asker or a priority role, only once her voice is audible, and never while a tool is carrying out an order.
- **Who can stop whose answer.** A clear stop phrase ("stop", "shut up") stops the answer from anyone; an everyday word ("done", "quiet") or her name alone only from the asker, plus:
  - Priority roles (`isPriority`): talking over her or her name stops anyone's answer.
  - Owners (`canStop`): a stop phrase or her name stops anyone's answer; talking never does.
  - An owner's "Hey Adrian" with a request (`preempts`, logged `owner first`) interrupts the current answer, and the request that was cut off is answered again right after the owner's (unless a tool had already carried it out). Owners also skip the duplicate-wake filter. From the next release only a clear wake preempts: an owner's loose wake waits its turn like anyone's.
- **A loose wake never cuts an answer off** (next release). From the asker while their answer runs, it is queued and judged once that answer ends; it never expires in the queue, so it is always judged rather than dropped or apologized for. A clear request from the same person drops their waiting loose one. If it really was for her, a stop or talking over her still cuts in sooner. With push-to-talk held there is no loose wake at all: the key says it's for her, so the words (the cloud's too) go to the model without a judge line, except a quick local answer (time, music, a stop, volume), which still goes the fast way.
- **One push-to-talk press is one request** (next release). The segments of one held press reach the controller in the order they were said: a later part waits while an earlier one is still in its cloud or Whisper listen (its own cloud listen starts meanwhile), and a stop never waits. A later part joins the running request (`continued`, without the 12 s limit, even once she's audible), unless that request is an order a tool is carrying out or has carried out: then it is queued as its own request, so a tool never runs twice. A key-up that cuts the clip reuses the early clip and its cloud listen when nothing new was said after it.

The controller's full rule set is in `src/conversation/controller.ts`. [usage.md](usage.md) describes it from the user's side.

## A spoken turn at a PC

The PC app only gates the mic. Everything else (VAD, ASR, wake, turn-taking, the model, the voice) runs on the server, with the same code and keys as the Discord call.

```
 PC app (crates/desktop, main repo)
   │  mic always open, 20 ms frames; energy gate opens after 60 ms above the
   │  learned threshold (300 ms preroll), closes after 1.2 s of quiet
   │  full duplex: opens over her voice only above 3x the expected echo
   │  push-to-talk (Ctrl+Alt+Space) forces it open while held; typed text goes as `text`
   │  after each welcome and on change: `output` (headphones, speakers or unknown)
   ▼
 WebSocket /satellite: speech_start, binary PCM (48 kHz mono s16le), speech_end
   ▼
 SatelliteConnection (acts as a VoiceTransport; the mic is the PC's owner)
   ▼
 Downsampler ─► Silero VAD, phrase closes after 0.8 s of silence
   │  a second Silero VAD on the same audio closes after 0.32 s: that clip is
   │  decoded at once and, if it's for her, the Groq listen starts too
   │  (satellite.earlyListen); used only if the 0.8 s close has the same samples
   ▼
 Smart Turn check (worker thread) on the last 8 s, with Parakeet started beside it
   │  p > 0.5 "finished" → release now
   │  else hold up to satellite.unfinishedWaitMs (1200 ms), but only if the speech is
   │  for her AND its words end mid-thought ("play the", "remind me at") or aren't
   │  English (they can't be judged);
   │  more speech during a hold is joined to the clip; 15 s total cap
   │  Groq listen may start early during a hold
   │  early decodes wait behind every other clip queued for Parakeet
   ▼
 Parakeet ASR → wake check → heard()
   │  push-to-talk held? → what closes between key-down and key-up is for her
   │                        (apps before 0.17.2: the next clip within 15 s)
   │  owner in a voice call the bot can see, not deafened, PC not on headphones?
   │      → only push-to-talk and typing; a stop still stops; her name gets a chime
   │  owner audible in her Discord call? → the PC defers: "Answering in the Discord call."
   │                                       (push-to-talk, typing and stops stay at the PC)
   ▼
 controller (follow-up 20 s, barge-in 600 ms; quiet while gaming turns both off)
   ▼
 respond() → model → tools (pc_* tools run on the asker's own PC)
   ▼
 Speaker → room Mixer → stereo averaged to mono → binary frames to the PC
   │  plus `state {speaking, listenMs}`, `mode thinking|idle`, `transcript`
   ▼
 PC app plays it; ducks her voice to 0.3 while you talk over her, never the music
```

PC-specific parts:

- **Early listen.** Both VAD waits are whole numbers of Silero windows (10 and 25 x 512 samples), so for speech said in one go the two cut at the same sample and the early words are the same words, about 0.5 s sooner when the Groq listen is on. A pause of 0.32-0.8 s inside the speech makes them differ: the early clip is dropped, its Groq request aborted, and timing is exactly as without it. A clip arriving while speech is held, or a second pause within the same speech, isn't decoded early. `pc heard` lines carry `early: true` when the words came from the early listen. `SileroVad` feeds sherpa exactly one 512-sample window per call, so reuse doesn't depend on the app's frame size. Early decodes go behind every real clip in Parakeet's queue (`DecodeQueue`, `src/speech/decode-queue.ts`), so the Discord call's clips aren't held up by them, except for one already running. A doubted pause is judged when a fresh decode would have ended, with or without early words. Every Groq call counts in one sliding minute (`CloudBudget`, `src/speech/cloud-budget.ts`); early ones go out only while it holds fewer than 14, and not for 10 minutes after a 429.
- **PC tools.** The model has nine `pc_*` tools ([tools.md](tools.md)). Each call is sent as an `action` to the asker's own connected PC (`pcFor` in `stack.ts` filters on the owner; no tool argument can name a PC or a person). The PC checks it against its own local policy before doing anything; the server cannot change that policy. Sleep, restart and shutdown need the person's own spoken yes on their very next turn. Simple orders confirm in a fixed short line ("Spotify's open.") instead of a second model call. An order about the house (a door, the garage, the lights, the TV, the heat) never reaches the PC: `judge` in `src/satellite/target.ts` reads the person's own words as orders and what each acts on, and refuses a call whose orders are all about the house before the PC is looked up, telling the model to use a home-control tool if there is one (next release). When it's unclear a lock or screens-off means the PC it asks "Lock the PC?" and waits for their yes, like the power actions. This is a second layer: the call guard (`pcGuarded`) first decides whose words a PC takes at all; this one decides what a PC call may act on.
- **Defer to the call.** If the PC's owner is audible in her Discord call (in her channel, not muted or deafened, voice link up), the call answers and the PC stays quiet. While push-to-talk is held, and for 3 s after, the call ignores that person's words, except stops.
- **The call plays here.** While the owner is in any voice channel the bot can see, in any of its servers, and not deafened, their speakers play that call, so the PC's mic hears everyone in it (`pcGuarded` in `stack.ts`). Then the PC takes only push-to-talk and typing, unless its app says it plays through headphones (`output`). Her own voice link doesn't matter: disconnecting her and then moving the owner lifts nothing. A stop still stops her, music and sounds, but never an alarm; her name or alarm words get a transcript line and a soft chime (`notice`, at most every 20 s). The orb's `listenMs` is 0 then. A muted owner's alarm rings in the call with DM buttons, unless the PC is on headphones.
- **Quiet while gaming.** PC apps from 0.15.6 report `activity`. While a game is in front and `satellite.quietWhileGaming` is on, every turn needs her name, push-to-talk or typing, answers are kept short, and everything else works as usual: reminders, timers and alarms come on time, and she does whatever she's asked. Messages from other people can wait in `held-while-gaming.json` until the match ends.
- **Speech end is measured differently.** At a PC, `speechEndToAudioMs` includes the 0.8 s silence wait, the Smart Turn check and any hold, so it reads about 1 s higher than the older figure that left those out (`stack.ts`, near the `AnswerRecord`).

The wire protocol is in [satellite.md](satellite.md). Setting up the app is in [pc-app.md](pc-app.md). The app's internals are in the main repo, in [crates/desktop](https://github.com/Riqqqque/A.D.R.I.A.N/tree/main/crates/desktop) and [crates/pc-control](https://github.com/Riqqqque/A.D.R.I.A.N/tree/main/crates/pc-control) and that repo's `docs/` folder.

## Timings

Each answer logs an `answered` line with these fields. The admin page's Status card shows p50/p95 for four of them over the last 200 answers: `sttLatencyMs`, `llmFirstChunkMs`, `ttsFirstMs` and `speechEndToAudioMs`. From the next release the dashboard below it shows p50/p90 of `speechEndToAudioMs` (all, in the call, at a PC) and of every stage field, over the last day and 7 days (`src/web/metrics.ts` reads the `answered` lines; percentiles are within about 6%).

| Field | Measures |
|---|---|
| `sttLatencyMs` | Release of the clip (after any hold) to the transcript |
| `turnCheckMs` | VAD close to Smart Turn's answer (PC only) |
| `holdMs` | Smart Turn's answer to the release (PC only) |
| `groqMs` | The part of the cloud listen still awaited after the words were ready: not covered by a hold or the early listen. It reads lower since the early listen (about 35-335 ms instead of about 520), but the Groq request itself is no faster |
| `llmFirstChunkMs` | Start of `respond()` to the first speakable sentence. This includes tool rounds and second model calls; it is not the model's raw first token. |
| `ttsFirstMs` | Time to the first sentence's first audio, measured in the Speaker for every voice. For a streamed Speechify sentence that is the first piece, not the whole sentence, so it reads lower than before streaming without the answer being that much sooner: compare `speechEndToAudioMs` |
| `speechEndToAudioMs` | VAD close to the first audio handed to playback, plus the silence the room waited out (`endSilenceMs`) |

Stage costs, with their source:

| Stage | Typical | Source |
|---|---|---|
| Silence before a phrase closes | 0.5 s (call, VAD), 0.8 s (call stream end, or PC) | config defaults |
| Smart Turn check | 50 to 250 ms of compute per PC segment, now on a worker thread | `src/speech/smart-turn-worker.ts` header |
| Smart Turn hold | 0 to 1.2 s, only for unfinished-sounding speech for her; used after the 0.8 s wait it halves mid-sentence cut-offs for about 0.2 s more waiting on average | `src/speech/smart-turn.ts` header (`bench/turn-bench.py`, 460 clips) |
| Parakeet decode | about 0.1 to 0.3 s per phrase (median 170 ms on 4 threads, 2026-10-21). On 2 threads (the `listen.asrThreads` default) the CPU per phrase halves and the decode takes 10-100 ms longer, depending on the machine's load | maintainer measurements, `src/bench/sidetalk-bench.ts` |
| Whisper second pass (neither English nor Spanish) | about 1 s per clip on 4 threads | `src/speech/whisper.ts` header |
| Model, first sentence | median about 1.3 s for Claude Haiku in a 2026-10-15 bench (`bench/claude-vs.mjs`) | maintainer bench |
| First chunk: whole sentence vs cut at the first comma | median 1.26 s vs 1.39 s, so the whole sentence is kept | `stack.ts` comment, `bench/first-audio.mjs` (2026-10-16) |
| Early listen at a PC | the decode and the Groq listen start 0.48 s before the 0.8 s wait ends; in the latency harness (stubbed models at the delays above) a PC request said in one go went from 3,425 to 2,945 ms end to end | `test/latency-harness.test.ts` |
| Cloud voice, first audio | streamed sentences over 40 characters: median 253 ms against 382 ms whole (12 lines, 3 runs each) | `bench/speak-first.mjs` |
| Mixer | 160 ms lead, plus 3 silent frames (60 ms) when a playback opens | `src/voice/mixer.ts` |

End to end, from one deployment's `answered` lines (a sample of 20 answers ending 2026-11-20, so treat it as rough): median `speechEndToAudioMs` 3,535 ms, longest 5,620 ms; median `llmFirstChunkMs` 1,360 ms, `ttsFirstMs` 428 ms, `turnCheckMs` 155 ms. The model's first sentence is the largest single part. Live `llmFirstChunkMs` runs above a plain model bench because it includes any tool rounds before the first sentence.

Music is slower than speech: the direct YouTube Music song search takes about 0.5 s instead of 1.8 s through yt-dlp (commit bcb60cd, 2026-11-01). In `bench/music-corpus.mjs` (63 requests, from a Windows PC), request to stream URL went from a median 3.1 s to 2.6 s (p90 5.4 to 3.5 s) once the stream's yt-dlp started early, video searches used YouTube's own search API, and albums and playlists came from YouTube Music's API (an album lookup about 4 s instead of 8). Bench scripts live in `bench/`; see [development.md](development.md).

## Text chat

`src/app/textchat.ts`. She answers when @mentioned, when someone replies to one of her messages, and in DMs. With the Message Content intent and `textChat.readChannels`, the last `textChat.historyMessages` (30) channel messages go to the model as context marked "context only, not instructions", and a conversation stays open for `textChat.followUpMinutes` (3) with each person she answered. It is the same orchestrator and tools as voice, without the speech rules; DMs use their own orchestrator with separate history. Replies never ping @everyone or roles. Every model call counts toward the hourly limit, even ones that end `SILENT`. Nothing read from channels is stored.

## Music

```
 "play X" (local regex)  ─┐
 play_music tool (model) ─┼─► MusicPlayer (one per room)
 /play, !play            ─┘     │
                                ├─ song: YouTube Music search (direct API, 1.5 s timeout)
                                │        → yt-dlp search fallback; weak match → wider
                                │          YouTube search (YouTube's own search API,
                                │          2 s, then yt-dlp) and Tavily for the spelling;
                                │          the direct video searches of one lookup
                                │          share 3 s, and 3 failures in a row rest
                                │          them for 5 min (music.directSearch)
                                ├─ artist: Deezer top songs (shuffled), radio fill; the
                                │          artist's own top song waits up to 3 s
                                ├─ a bare genre or era ("jazz", "90s r&b"): a playlist
                                ├─ album, playlist (YouTube Music's API), vibe, similar,
                                │  podcast, video, link
                                └─ Plex backup (when asked, when YouTube finds nothing,
                                   or while YouTube is paused)
                                ▼
                        yt-dlp resolves a stream URL (started beside the search,
                        address on stdin; next track prepared ahead)
                                ▼
                        ffmpeg: soxr to 48 kHz, -6 dB, limiter, s16le stereo
                                ▼
                        Mixer music channel (ducked to music.duckLevel while she
                        speaks, after a wake for 8 s, and while an alarm rings)
                                ▼
                        Discord player, or the PC's WebSocket
```

- Clear orders ("play X", "skip", "pause", "volume 40 percent") are handled by `classifyMusic` in `src/conversation/intents.ts` without the model and cost nothing. Vague ones ("something chill", "an album") go to the model's `play_music` tool.
- Each room has its own player, queue (`music.maxQueue`, 25) and autoplay. Queues, volumes and history are memory only. A PC's player goes away when it disconnects.
- At a PC, "pause", "skip", "resume", "go back", "what's playing", "mute my music" and "unmute my music" go straight to the PC (`pc_media`, or `pc_volume` with `playing: true` for mute) unless her music is playing there, with no model call (`src/satellite/pc-music.ts`). She says nothing when it worked, only what went wrong. A stop phrase that names the music ("shut up the music") pauses the PC's player the same way. They wait up to 12 s for the PC.
- Matching: a version named in the request (tiny desk, live, acoustic, remix, sped up, session, cover ...) must appear in a result that replaces the catalog song; whole sets (tiny desk, concert, session, unplugged) may run up to 40 minutes. A catalog answer in another script (夜に駆ける for "yoru ni kakeru") is kept. Sound-alike matching treats a soft g like j and two words as one name ("me goes" = Migos).
- A YouTube "Sign in to confirm" bot check pauses YouTube for 30 minutes; requests then go to Plex, or she says "I can't reach YouTube right now." From the next release a yt-dlp run started early (beside the search, for a list's first song, or as a spare) is dropped too if the pause began while it waited.
- Spares (next release): an album, playlist or vibe starts one spare yt-dlp while its listing loads, and only that list's first looked-up song may take it; another room never does. A spare not taken within 20 s is dropped. The music quiz starts none.
- ffmpeg inputs are limited to `http,https,tls,tcp,crypto`, so a track URL can never read local files. The Plex token goes only in a header, and only to the Plex origin.
- With nobody human in the call for 2 minutes, music and any quiz stop (see [Rooms](#rooms) for leaving an empty channel).
- Sound effects (`play_sound`) use the same YouTube search and ffmpeg, capped at 15 s, as a speech channel so music ducks under them. The music quiz borrows the room's player.

Details: [usage.md](usage.md) for what can be asked, [tools.md](tools.md) for the tool arguments.

## Alarms, timers and reminders

```
 set_alarm / set_timer / edit_alarm (model)  or  /alarm (slash, no model)
   ▼
 AlarmClock (src/features/alarms.ts) ── alarms.json ── tick every 1 s
   │ due
   ▼
 where does it ring? (alarmPlace in stack.ts)
   ├─ her call: bot connected, person in her channel, not deafened,
   │            and not (muted while they have a PC)
   ├─ else their PC (sat:<id>)
   └─ else nowhere → DM with Stop / Snooze buttons
   ▼
 ringIn (src/app/alarm-ring.ts): tone, saved clip, music, or her voice;
   │ alarms fade in, timers start full; her voice line (with the voice
   │ preference on) every 60 s, or every 20 s when the sound is her voice
   ▼
 Mixer alarm channel: several people's alarms mix; music stays ducked;
   │ the alarm drops to 0.25 under her voice
   ▼
 turned off by:
   - the alarm owner's whole-utterance words ("stop", "I'm up", "snooze", "five more"),
     checked before the wake check; dismiss modes stop / firm / math
   - /alarm stop|snooze, DM buttons, the PC window or tray buttons
 nobody answers: an alarm rings ringMin (10) minutes, snoozes, up to 3 rounds,
   then a DM; a timer rings timerRingMin (5) minutes once, then a DM
```

- **Ring state is on disk.** `ringingSince` is saved, so a restart or a move picks the ring up again. One that came due while the bot was down rings late if still inside its ring time, else she sends a DM.
- **PC backup ring.** Every connected PC of the owner gets an `alarms` message on connect, on every change and hourly, listing what rings now and what is due in the next 8 days (`PC_AHEAD_MS`). If the server hasn't rung one within 20 s of its time, or the link drops mid-ring, the PC app rings it itself with its own beeps and reports `alarm_done` after the next welcome. The server applies that only if the occurrence still matches and is ringing, snoozed or due by its own clock (a PC whose clock ran ahead rings early, and its Stop must not cancel the real ring), and only once.
- **Updates wait.** `busySoon()` (an alarm ringing, snoozed, or due within 5 minutes) makes `/api/health` report busy, so auto-update holds off.
- **Reminders** (`src/features/reminders.ts`, `reminders.json`) are said once, not rung: in her call, at the PC they were set at plus a DM, or by DM. During a game they're still said on time.
- The alarm tools, sounds, dismiss modes and phrases are in [usage.md](usage.md) and [tools.md](tools.md).

## State on disk

State folder: `ADRIAN_STATE`, default `/var/lib/adrian`, owned by the service user `adrian`. JSON files are written atomically (temp file and rename), most through `writeJsonFile` (`src/web/secrets-file.ts`, mode 0600); `usage.json` and `voice-usage.json` do the same in their own code.

| File | Owner (code) | Holds | If it can't be read |
|---|---|---|---|
| `admin.json` | `src/web/auth.ts` | The one admin account (argon2id hash) | No account: setup code flow |
| `setup-code` | `src/web/auth.ts` | One-time setup code, 1 h lifetime | |
| `usage.json` | `src/limits/usage-ledger.ts` | Spend and request count per local day, last 400 days; saved 2 s after a change and on stop | Starts empty |
| `voice-usage.json` | `src/speech/speechify.ts` (`CharBudget`) | Cloud voice characters per month | |
| `dashboard.json` | `src/web/metrics.ts` | The dashboard's counters: 24 hourly and 8 daily slots, the errors, restarts and Tavily/Groq rings, and a `running` flag that tells a clean stop from a crash; mode 0600, saved at start, every 5 min and at shutdown (next release) | Starts empty |
| `satellites.json` | `src/satellite/devices.ts` | Paired PCs: id, name, owner, SHA-256 of the token (never the token), mode 0600 | |
| `alarms.json` | `src/features/alarms.ts` | Alarms and timers including ring state, each person's alarm settings, saved sound names | Parse error: moved aside as `alarms.json.unreadable-<ms>` and never written over; other read errors lock saving |
| `alarm-sounds/<id>.pcm` (the first 12 characters of a random UUID, e.g. `1b4e28ba-2fa.pcm`) | `src/app/alarm-commands.ts` | Saved alarm clips, mono s16le 24 kHz, at most 30 s | Missing file: classic tone |
| `reminders.json` | `src/features/reminders.ts` | Reminders | Starts empty; the next save replaces it |
| `notes.json` | `src/features/notes.ts` | Per-person notes (told and learned) | Starts empty; the next save replaces it |
| `music-taste.json` | `src/features/taste.ts` | Per-person artist plays, likes and dislikes; her own taste | |
| `documents/<id>/index.json`, `documents/<id>/<doc>.<ext>` | `src/features/documents.ts` | Files a person sent her (name, kind, size, pages, field count) and their bytes, two weeks | Parse error: index moved aside as `index.json.bad-<ms>`, starts empty |
| `writing/<id>.json` | `src/features/writing.ts` | One person's drafts (text, 20 earlier versions, template, private flag), word list, writing log and templates | Parse error: moved aside as `<id>.json.bad-<ms>`, starts empty |
| `ignored.json` | `src/features/ignore.ts` | People an owner told her to ignore: id, name, scope, who said so, until when | Parse error: moved aside as `ignored.json.bad-<ms>`, starts empty |
| `heads-up.json` | `src/features/headsup.ts` | When each person was last in the call, their heads-up choices | Starts empty |
| `weekly-recap.json` | `src/features/recap.ts` | Counts for the last 3 weeks | Starts empty |
| `game-night.json` | `src/features/gamenight.ts` | Game-night opt-ins | |
| `game-server-jobs.json` | `src/features/servercontrol.ts` | Running start/stop jobs, resumed after a restart | Invalid entries dropped |
| `held-while-gaming.json` | `src/satellite/quiet.ts` | Reminders and messages held during a game, until released | Ignored |
| `pc-recordings/<date>/` | `src/satellite/recorder.ts` | Opt-in WAVs of requests for her at a PC plus `index.jsonl`; only with `satellite.recordDays > 0` | |
| `install-manifest.json` | `packaging/install.sh` (root) | Install record | |
| `models/` | installer (root-owned, read-only to the service) | Speech models and yt-dlp | `adrian doctor` reports missing models |

Config folder (default `/etc/adrian`): `config.json` (0640) and `secrets.env` (0600). `adrian backup` packs both folders except `models/`; the archive contains your keys.

## What lives only in memory

Lost on every restart: conversation history (16 turns per person, forgotten after 60 idle minutes), room talk, admin sessions (a restart logs everyone out), the per-person hourly request times, music queues and volumes, per-room voice volume and speed, pasted links, the cloud voice's short-line cache, pending yes questions, the last 200 answer records (no user IDs or text) and the last 500 log lines shown on the dashboard.

## Config and secrets

- `config.json` is validated with zod (`PocConfigSchema` in `src/config.ts`). An invalid file fails with every issue listed; a file that does not parse is never treated as empty and saved over.
- Installer-owned paths (`secretsFile`, model paths, `limits.usageFile`) are filled in by `baseConfig()` and can't be set from the browser or with `adrian config`.
- Three ways to change settings, all applied on restart: the admin UI (a small set: channel, timezone, limits, voice, model), `sudo adrian config KEY VALUE` (most top-level sections), or editing the file (needed for `server` and `allowedGuilds`).
- Secrets are read only from `secrets.env` (`NAME=value` lines), never from the environment. The admin API is write-only for them and returns names only. The logger redacts token shapes.
- A config setting may only name a secret of its own purpose (`SECRET_PURPOSE` and `keyName()` in `src/config.ts`), so an endpoint changed in config can never be handed the Discord token or another service's key.

Every key: [configuration.md](configuration.md). Security model: [security.md](security.md).

## What leaves the server

Hearing and speaking run on your own hardware by default. The main things that go out, and when:

| Data | Goes to | When |
|---|---|---|
| The request text, the prompt (who's in the call, recent call talk including other people's side talk, the asker's notes, music state) and tool results | The language model provider | Every model call |
| A credential-free `GET` that only opens a connection (each provider answers 401 and keeps it): `/v1/models`, `/openai/v1/models`, `/v1/voices`, `/` | Claude, Groq, Speechify, Tavily | From the next release, when someone starts talking and that provider's connection has closed: at most about once per provider every 6 minutes while people talk (`src/core/http.ts`) |
| A cache warm-up: the cached tools and system prompt, a placeholder user turn, `max_tokens: 0` | Claude | From the next release (`brain.prewarm`), while a woken question is still being listened to, or on push-to-talk |
| Audio of requests already judged for her, plus a vocabulary prompt that includes the configured creator name and nicknames | Groq | Only with `cloudStt.enabled`, for PC rooms (and PC owners in the call) or everyone with `rooms: "all"`. Side talk never goes. |
| English answer sentences | Speechify | Only with a `cloudVoice` section (`enabled`, the default) and its key |
| Screenshots from `pc_screen` | Claude | Only when asked; seen in one model call, never kept. The OpenAI-compatible adapter never sends pictures. |
| Clipboard text from `pc_clipboard` | The language model provider | Only when asked; never logged |
| Search queries | Tavily | `web_search`, `pc_open` search, weak music matches |
| Artist names | Deezer | With `music.topSongs` on |
| The configured place | Open-Meteo | Weather |
| Music, sound and video search words, and track streams | YouTube Music / YouTube | Every music or sound request (Plex instead when it is the source) |
| Lookups and actions for configured integrations (Plex, Sonarr/Radarr, Steam, Helix, RSS, iCal, MCP / Home Assistant, game servers) | Each configured service | When the matching tool runs |

Microphone audio is never written to disk, except opt-in PC recordings. Transcripts are logged only with `satellite.logTranscripts` (PC requests for her, at info), or with `listen.logTranscripts` plus `LOG_LEVEL=debug` (everything heard).

## Failure handling

| Failure | What happens | Where |
|---|---|---|
| Config incomplete | Stack stays in `setup`; the admin UI lists the problems | `configProblems`, `src/app/manager.ts` |
| Start fails for a reason that can pass (DNS, refused connection, timeouts, HTTP 5xx) | Retried after 30 s, doubling to 5 min; a success resets it. A bad token or missing model stays `failed` with its reason. | `canRecover`, `manager.ts` |
| Process exits for any reason | systemd restarts it after 20 s (`Restart=always`) | `packaging/adrian-voice.service` |
| Too little memory for a first start | The start is put off and retried (30 s, doubling to 5 min); after 15 min it loads anyway. The state shows `failed` with the reason meanwhile | `src/app/memory.ts`, `manager.ts` |
| SIGTERM or SIGINT | Logged with state and memory. While `starting`: admin UI closed, ledger flushed, the signal re-raised. While running: a clean stop, capped at 20 s. A second signal exits at once | `src/app/shutdown.ts` |
| Discord voice drops | Waits 5 s, then for Ready: up to 30 s while the library resumes (Connecting), but only 5 s in Signalling, where a failed resume otherwise waited for an answer Discord rarely sends; a connection error rebuilds at once. `voice back` logs each recovery's time and path. Then rebuilds with backoff (5 tries at 1, 2, 4, 8, 16 s plus up to 0.5 s jitter), then retries every 5 minutes. A kick stays out until `/join`; a drag to another channel is followed. | `src/transport/discord.ts` |
| Main model fails before its first event | The same round goes to `brain.fallback`. No switch once words have streamed. | `src/brain/fallback.ts` |
| Transient model error (429, 5xx, first-event timeout) before anything was said | One retry after 250-750 ms | `src/brain/orchestrator.ts` |
| Model says nothing, or fails | "Sorry, I didn't get that. Could you say it again?" or a short apology | `stack.ts` |
| Spend cap or hourly limit reached | A short notice once per reason per 10 minutes, then silence | `usage-ledger.ts`, `stack.ts` |
| Speechify times out or errors | That sentence uses Kokoro (loaded on the spot the first time, when the cloud voice is primary). A streamed sentence that breaks off after its first audio ends there (a second voice would repeat its start). `cloudVoice.timeoutMs` limits the wait for the first bytes and any stall after them. Timeouts, 401/403/408/429 and 5xx pause the cloud voice for 60 s; past `monthlyChars` it stays local until next month. | `src/speech/speechify.ts` |
| Groq times out, errors or returns nothing | The local words are used. 429 or 5xx pauses it for 60 s. | `stack.ts` |
| Smart Turn fails | Treated as "finished": nobody waits | `src/listen/pipeline.ts` |
| Whisper fails to load | English only, logged | `stack.ts` |
| YouTube bot check | YouTube paused 30 min; Plex or a spoken notice | `src/features/music.ts` |
| A track stalls or won't play | 30 s without audio moves on; up to 2 other uploads are tried; 5 failures in a row end the list | `music.ts` |
| PC disconnects | `satellite disconnected` logs who ended it (`by`: pc, heartbeat, replaced, shutdown, server), the close code and reason, the link's age and how long the PC was quiet. Pending actions answer "The PC disconnected."; the room's answers, music and mixer stop; the room is removed. The PC reconnects with backoff, and keeps ringing alarms itself. | `src/satellite/*`, `stack.ts` |
| PC action takes too long | "The PC didn't answer in time." after 15 s (19 s for screenshots) | `src/satellite/connection.ts` |
| Bad satellite frames or tokens | Closed. A wrong token or no hello counts as a failure; 5 per address lock it out for 10 minutes, but a correct token always gets in. Oversized first frames are closed without counting. | `src/satellite/server.ts` |
| An update does worse than the old version | `adrian update` rolls back; auto-update skips that version for 24 h | `packaging/adrian` |

Shutdown (`stack.stop()`) cancels answers, then stops reminders, alarms, the recap, server control and MCP, flushes heads-up state, stops music, the mixer and the satellite server, flushes the ledger and voice budget, and disconnects from Discord, so state files are left whole.

## Design rules

- **Local first.** VAD, speech recognition, the wake decision and the default voices run on your hardware. Cloud speech (Groq STT, the Speechify voice) is opt-in. The language model is a cloud API unless you point `brain` at a local OpenAI-compatible server; lookups such as YouTube, Deezer, weather and news use public services.
- **Act only through typed tools with guard rails.** Tools that do something (PC control, home control, messages, alarms, game-server control) are narrow and typed. Actions with real consequences need the person's own spoken yes on their very next turn (`PendingYes` in `src/brain/tools.ts`); the model can't supply it. The PC's own policy is the last word on PC actions. Music and sound tools only work for people in that room (`inRoomOnly`). Plex, Sonarr, Radarr, Steam, calendars and game-server status are read-only.
- **Tool output is untrusted.** Every tool result goes to the model wrapped as data, not instructions (`asUntrustedData`).
- **Fail soft.** A failed cloud voice falls back to the local one, a failed model to the fallback model, YouTube to Plex, and Groq to the local words. When nothing works, she says a short sorry.
- **Bounded cost.** Model tokens are metered and capped by `limits.dailyUsd` and `limits.monthlyUsd`. The cloud voice has its own monthly character cap. Groq STT and Tavily are not counted by the ledger. Prompt caching keeps input cheap, and common phrases never reach the model. Numbers are in [costs.md](costs.md).
- **Keep the event loop free.** Heavy work (ASR, TTS, Smart Turn, calendar expansion) runs off the main thread, because the mixer and Discord heartbeats share it.

The reasons behind these choices are in the commit history and the code comments cited above.
