# How it works

```
Discord voice (Opus, per speaker, DAVE end-to-end encryption)
   │  @discordjs/voice: one decoded stream per person, never mixed
   ▼
Voice activity detection (Silero VAD) ── a phrase ends after 0.5 s of silence
   ▼
Speech recognition (Parakeet TDT 0.6B v3, int8, on the CPU; about 0.1 to 0.3 s per phrase)
   │  not English or Spanish? → Whisper small second pass (about 1 s): language + text
   ▼
Wake check (text): "hey Adrian", "Adrian, …", the name alone, follow-up window
   ▼
Conversation controller: one answer at a time, queue of 2, stop phrases, barge-in, owners
   │
   ├─ local intents (stop, thanks, repeat, volume, time, music commands) → spoken directly
   │
   ▼
Orchestrator → language model (Claude, or any OpenAI-compatible API, streamed)
   │  prompt = cached rules + tools + earlier turns │ this turn: who's in the call,
   │                                                │ room talk, the asker's notes, music state
   │  tool rounds (up to 3): timers, notes, games, search, music, servers, media
   ▼
Sentence splitter → text-to-speech (Kokoro on the CPU, or cloud Speechify for English;
   │                Piper for Vietnamese), loudness-matched to about −16 LUFS
   ▼
Mixer: speech at full level, music ducked underneath, 20 ms frames on the wall clock
   ▼
Discord audio player (Opus 128 kbps, FEC)
```

Typical time from the end of your sentence to its first word: 1.5 to 2.5 seconds. Most of that is the language model's first sentence (0.7 to 1.3 s with Claude Haiku). Measured on a Ryzen 7 3700X.

## Source layout (`src/`)

| Path | What's there |
|---|---|
| `app/main.ts` | Service entry: admin page first, then the voice stack once config and keys are complete |
| `app/manager.ts` | Starts, restarts and stops the voice stack when settings change |
| `app/stack.ts` | Wires everything together: transport, speech, the controller, the model, tools, music, and the answer path |
| `app/commands.ts` | `/join` and `/leave` |
| `app/identity.ts` | Creator and call-roster prompt lines |
| `transport/discord.ts` | Voice connection, per-user receive, playback, reconnects |
| `listen/pipeline.ts` | VAD, speech recognition and wake check per speaker |
| `wake/text-wake.ts` | Wake phrase matching on the transcript |
| `speech/` | Parakeet and Whisper (sherpa-onnx), Kokoro, Piper, Speechify, the language check |
| `conversation/controller.ts` | Turn-taking: queue, follow-ups, stops, barge-in, owners |
| `conversation/intents.ts` | Local phrases (stop, thanks, volume, music, time), several languages |
| `conversation/room.ts` | Recent call talk (5 minutes, 24 lines; memory only) |
| `brain/orchestrator.ts` | The prompt, tool rounds, streaming, SILENT for side talk, retries |
| `brain/anthropic.ts`, `brain/openai-compatible.ts`, `brain/fallback.ts` | Model adapters |
| `brain/tools.ts`, `features/*` | Tools: time, search, timers, notes, games, game servers, Plex/Sonarr/Radarr, music |
| `features/music.ts` | YouTube (yt-dlp) and Plex sources, queue, radio, autoplay, ffmpeg decoding |
| `voice/mixer.ts`, `voice/speaker.ts` | Mixing speech and music; sentence-by-sentence speaking |
| `limits/usage-ledger.ts` | Spend caps and per-person rate limit |
| `web/` | Admin page API: auth, setup wizard, settings, checks, secrets |
| `cli/tool.ts` | The Node half of the `adrian` command |

## State on disk (`/var/lib/adrian`)

- `admin.json`: the admin account (argon2id hash).
- `usage.json`: spend per day.
- `voice-usage.json`: cloud voice characters per month.
- `reminders.json`, `notes.json`: timers and reminders, per-person notes.
- `models/`: speech models and yt-dlp (root-owned, read-only to the service).

Conversation history and room talk are kept in memory only. They're gone after a restart.

## Design rules

- **Local first.** Hearing and speaking run on your hardware; only text goes to the model.
- **Read-only integrations.** Plex, Sonarr, Radarr and game servers are only ever queried.
- **Fail soft.** A failed cloud voice falls back to the local voice, a failed model to the fallback model, and a failed YouTube lookup to Plex. When nothing works, a short spoken sorry.
- **Bounded cost.** Every paid call is metered and capped, prompt caching keeps input cheap, and the common phrases never reach the model.
