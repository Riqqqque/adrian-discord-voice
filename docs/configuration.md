# Configuration

Every setting the bot reads, with its type, default and effect. The source of truth is the zod schema `PocConfigSchema` in [`src/config.ts`](../src/config.ts); this page follows it key by key. If the two ever disagree, the schema wins and this page is out of date.

- [Where settings live and how to change them](#where-settings-live-and-how-to-change-them)
- [Reading this page](#reading-this-page)
- [A complete example](#a-complete-example)
- [Discord](#discord) · [Listening](#listening) · [Language model](#language-model) · [Behaviour](#behaviour) · [Voice](#voice) · [Music](#music)
- [Integrations](#integrations) · [Steam](#steam) · [Helix](#minecraft-server-control-helix) · [Weather, calendars, news, briefing](#weather-calendars-news-and-the-morning-briefing) · [Home control](#home-control-mcp-home-assistant) · [Heads-ups and recap](#heads-ups-and-the-weekly-recap)
- [Limits](#limits) · [Admin page](#admin-page) · [Installer-owned keys](#installer-owned-keys) · [Secrets](#secrets-etcadriansecretsenv) · [Environment variables](#environment-variables)

## Where settings live and how to change them

| What | Native install | Docker |
|---|---|---|
| Settings | `/etc/adrian/config.json` (owner `adrian`, mode 0640) | the `config` volume, `/etc/adrian/config.json` in the container |
| Keys and tokens | `/etc/adrian/secrets.env` (`NAME=value` lines, mode 0600) | the same file in the `config` volume |
| State (memory, reminders, usage, models) | `/var/lib/adrian` | the `state` and `models` volumes |

There are three ways to change a setting.

1. **The admin page** (wizard and Settings tab) changes only these: `guildId`, `channelId`, `timezone` (checked as a time zone name), `voice.voice` and `voice.speed` (slider 0.8 to 1.2), `limits.perUserPerHour`, `limits.dailyUsd`, `limits.guestDailyUsd` and `limits.monthlyUsd`, the main and fallback language model (one of the presets) and web search on or off. Picking a preset replaces only the provider fields (`provider`, `baseUrl`, `model`, `effort`, `apiKeySecret`, `extraBody`, prices) and keeps your timeouts and token cap. A model set with `adrian config` shows as "Keep" and is left alone. The page also writes `brain.preset` (and `brain.fallback.preset`), which only the page uses; the schema drops it when the config is loaded. The settings API behind the page (`SettingsPatchSchema` in `src/web/settings.ts`) also accepts `priorityRoleIds`, `playbackVolume`, `limits.maxRequestChars` and a custom endpoint, but the page has no control for them.
2. **`sudo adrian config KEY [VALUE]`**, by dotted path, for everything else:

   ```bash
   sudo adrian config music.volume            # show a value
   sudo adrian config music.volume 0.4        # set it (validated before saving)
   sudo adrian config owners '["123456789012345678"]'
   sudo adrian config gameServers.0.name Survival
   sudo adrian config recap.channelId null    # remove it (back to unset)
   sudo adrian restart                        # every change applies on restart
   ```

   In Docker the same command is `docker compose exec adrian node dist/cli/tool.js config KEY [VALUE]`, followed by `docker compose restart adrian`.
3. **A hand edit** of `config.json` (`sudo nano /etc/adrian/config.json`, keep it valid JSON, then `sudo adrian restart`). This is the only way to change `allowedGuilds`, `server.allowedHosts` and `server.tls`. `server.host` and `server.port` are also rewritten whenever the installer is run again (from its `--lan` and `--port` options; see [install.md](install.md#4-install-native)).

How `adrian config` reads a value: anything that parses as JSON is used as JSON (numbers, `true`/`false`, arrays, objects), otherwise it is a string. A string of 16 or more digits always stays a string, so Discord IDs and SteamIDs keep every digit. `null` removes the key and any parent object it leaves empty, which turns an optional setting back off (`sudo adrian config helix.url null` removes the whole `helix` block if nothing else is in it). If a removal would leave a setting that still needs the removed part, it isn't saved; remove the whole block instead (`sudo adrian config helix null`).

Before saving, `adrian config` merges the change into the live config and validates the result with the real schema. An invalid result is refused with the reason and nothing is written. It refuses to touch: top-level keys other than the ones in this page's sections (in particular `server`, `allowedGuilds`, `secretsFile`, `testClip`), any key whose last part ends in `file` or `dir`, `vadModel`, and anything starting with `secrets`. Those belong to the installer (see [Installer-owned keys](#installer-owned-keys)).

When the service starts, the whole file is validated. An invalid file doesn't start the bot: the admin page and `sudo adrian check` list every problem as `Config <path>: <message>`. A missing token, server, channel or model shows as a setup step instead.

## Reading this page

- **ID** means a Discord ID: a string of 17 to 20 digits, in quotes (`"123456789012345678"`). Copy one with Discord's Developer Mode on (Settings, Advanced), then right-click a user, role, server or channel and choose Copy ID.
- **key name** means the *name* of a key in `secrets.env`, never the key itself. It must look like `^[A-Z][A-Z0-9_]{1,63}$`, and it may not be a name reserved for another purpose (see [Secrets](#secrets-etcadriansecretsenv)). Language-model key names may be empty, for local servers that need no key.
- Ranges are inclusive and enforced by the schema. "(unset)" means the key is absent by default and the feature behaves as described when it is.
- Blocks marked **optional block** may be left out entirely. `brain`, `listen` and `voice` are optional in the schema, but a working setup has all three: the wizard writes `brain`, and the installer-owned paths in `listen` and `voice` are filled in on every save and every start.

## A complete example

What a finished native install typically looks like after the wizard and a few `adrian config` calls. The installer-owned paths are shown as the service fills them.

```json
{
  "server": { "host": "127.0.0.1", "port": 8790 },
  "timezone": "America/New_York",
  "secretsFile": "/etc/adrian/secrets.env",
  "guildId": "123456789012345678",
  "channelId": "223456789012345678",
  "owners": ["323456789012345678"],
  "brain": {
    "preset": "claude",
    "provider": "anthropic", "baseUrl": "https://api.anthropic.com",
    "model": "claude-haiku-5-5", "effort": "low", "apiKeySecret": "ANTHROPIC_API_KEY",
    "priceInPerM": 0.1, "priceCachedInPerM": 0.01, "priceOutPerM": 0.5,
    "search": { "apiKeySecret": "TAVILY_API_KEY", "maxResults": 4 }
  },
  "listen": {
    "vadModel": "/var/lib/adrian/models/silero_vad.onnx",
    "asrModelDir": "/var/lib/adrian/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
  },
  "voice": { "voice": "af_heart", "speed": 1, "modelDir": "/var/lib/adrian/models/kokoro-multi-lang-v1_0" },
  "cloudVoice": { "voiceId": "sabrina" },
  "limits": { "perUserPerHour": 30, "dailyUsd": 1, "monthlyUsd": 10, "maxRequestChars": 600, "usageFile": "/var/lib/adrian/usage.json" },
  "weather": { "place": "Springfield, Illinois" }
}
```

Every key not in the file takes its default from the tables below.

## Discord

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `guildId` | ID | required | The home server: voice connects there at start; names and roles are looked up there | `"123456789012345678"` |
| `channelId` | ID | required | The home voice channel. She joins it at start and after every restart, and never leaves it for being empty (other channels she leaves after 10 minutes alone) | `"223456789012345678"` |
| `allowedGuilds` | ID[], up to 50 | `[]` | Servers where `/join`, typed music commands, text chat and the Discord lookups work. Empty: any server the bot was invited to. Hand edit only | `["123456789012345678"]` |
| `priorityRoleIds` | ID[] | `[]` | Members with any of these roles may interrupt anyone's answer, like owners can. Set with `adrian config` | `["423456789012345678"]` |
| `owners` | ID[], up to 10 | `[]` | Owner rights: stop anyone, go to the front of the line, no per-person hourly limit, and the default audience for calendars, home control and heads-ups. The account that owns the Discord application is always an owner | `["323456789012345678"]` |
| `timezone` | string | `"UTC"` in the schema; the installer writes the system's zone | Clock answers, timers, reminders, alarms, the daily and monthly spend caps, the recap and briefing hours. Use an IANA name; the admin page checks it, `adrian config` does not | `"Europe/London"` |
| `playbackVolume` | number 0-1 | `0.7` | Her speech level in every room. Sound effects and alarm sounds follow it. The voice is already normalized to about −16 LUFS, so 1 is that level | `0.6` |
| `silenceMs` | integer 100-5000 | `800` | Discord only: how long a speaker must be silent before Discord's audio stream for them is cut off. Phrase endings are decided by `listen.minSilence` | `1000` |

## Listening

`listen` is filled in automatically (its model paths are installer-owned), so you only add the keys you want to change.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `listen.vadModel` | path | installer-owned | Silero VAD model file | - |
| `listen.asrModelDir` | path | installer-owned | Parakeet speech-recognition model folder | - |
| `listen.asrThreads` | integer 1-8 | `2` | CPU threads for Parakeet. Everything anyone says goes through it, side talk included. onnxruntime's idle threads spin, so 4 threads cost about twice the CPU of 2 for the same words. The price is slower words: 10-50 ms per phrase in one measurement, about 100 ms (median) in another on a busy machine. Set `4` if you have CPU to spare and want the quickest words; 1 saves more CPU again but adds about 100 ms more | `4` |
| `listen.whisperThreads` | integer 1-8 | `4` | CPU threads for Whisper, the second listen to questions that aren't in English (only when `languages` is on) | `2` |
| `listen.vadThreshold` | number 0.1-0.95 | `0.5` | Voice detection sensitivity. Higher ignores more background noise but can miss quiet speech | `0.6` |
| `listen.minSilence` | seconds 0.1-3 | `0.5` | Pause that ends a phrase. PC rooms always use at least 0.8 | `0.7` |
| `listen.minSpeech` | seconds 0.05-2 | `0.25` | Shortest sound counted as speech | `0.3` |
| `listen.maxSpeech` | seconds 2-60 | `20` | Longest single phrase; longer speech is cut there | `30` |
| `listen.wakeName` | string, 2+ characters | `"adrian"` | The name she listens for. Renames only the strict wake check. Stops with the name, the bare-name "Yes?", prompts and speech-recognition hints still use "Adrian" (see [roadmap, Known limitations](roadmap.md#known-limitations)) | `"adrian"` |
| `listen.logTranscripts` | boolean | `false` | Development only: logs what people say (debug level). Leave off; it writes other people's speech to the journal | `false` |

### Second listen in the cloud (`cloudStt`)

Off by default. When on, speech the local model already judged to be meant for her (not stop words, not her name alone) is sent once more to Groq's Whisper for a more accurate transcript. The local model still does all the listening and makes the wake decision; if the cloud is slow or loses the command, the local words are used.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `cloudStt.enabled` | boolean | `false` | Turn the second listen on | `true` |
| `cloudStt.apiKeySecret` | key name (language model) | `"GROQ_API_KEY"` | Groq key in `secrets.env`. Missing key: logged once, local words only | `"GROQ_API_KEY"` |
| `cloudStt.model` | string | `"whisper-large-v3-turbo"` | Groq speech model | `"whisper-large-v3-turbo"` |
| `cloudStt.rooms` | `pc` or `all` | `"pc"` | `pc`: requests made at a PC, and from anyone in the call who has a PC connected. `all`: everyone in the call too | `"all"` |
| `cloudStt.timeoutMs` | integer 300-5000 | `1500` | Longest wait before the local words are used. An HTTP 429 or 5xx answer pauses the cloud listen for 60 seconds | `1200` |

What leaves the machine: the audio of that one request, plus a spelling hint made from `identity.creator` and the `nicknames` values. Costs are in [costs.md](costs.md).

### PC satellites (`satellite`)

The WebSocket endpoint the Windows PC app connects to. Setup is in [pc-app.md](pc-app.md); the protocol is in [satellite.md](satellite.md). Pair PCs with `sudo adrian satellite add NAME OWNER_ID`.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `satellite.enabled` | boolean | `false` | Open the endpoint. Needs the state directory (always there in an install) | `true` |
| `satellite.bind` | string | `"0.0.0.0"` | Address it listens on. Use it on a private network or behind TLS | `"0.0.0.0"` |
| `satellite.port` | integer 1024-65535 | `8791` | Port it listens on | `8791` |
| `satellite.logTranscripts` | boolean | `false` | For fixing misunderstandings: log what PCs hear, what she answers, PC actions and their arguments, and cloud-vs-local transcripts (`pc heard`, `pc answer`, `pc action`, `pc stt`). After reading the clipboard or the screen only the answer's length is logged, and window titles never are. Leave off otherwise: the log then holds people's requests | `false` |
| `satellite.recordDays` | integer 0-14 | `0` | Keep audio of requests made at a PC (never side talk) for this many days in `<state>/pc-recordings`, to test speech-to-text against real voices. 0 = off | `3` |
| `satellite.unfinishedWaitMs` | integer 0-3000 | `1200` | At a PC, when a pause sounds mid-sentence (the Smart Turn model), wait this much longer before answering. 0 = off (plain silence wait only) | `800` |
| `satellite.earlyListen` | boolean | `true` | At a PC, start recognizing what was said (and the cloud listen) 0.32 s into a pause instead of after the full 0.8 s wait. The words are used only if the full wait then closes exactly the same audio, so they are the same words, and answers come about 0.5 s sooner when the cloud listen is on (about 0.15 s without it). A pause that Smart Turn doubts is still judged when a fresh decode would have ended, so what gets joined doesn't change. Early recognitions wait behind every other clip queued for the recognizer, her Discord call's included. Costs one extra local recognition when someone pauses 0.32-0.8 s and goes on talking (about 20% more decoding on conversation-like side talk). Early cloud listens count against Groq's limit even when dropped, so they stop while the last minute has 14 or more Groq calls, and for 10 minutes after a 429. `pc heard` lines carry `early: true` when the words came from the early listen | `false` |
| `satellite.quietWhileGaming` | boolean | `true` | While a PC app (0.15.6 and later) reports its owner is in a game: her name is needed for every turn at that PC, answers there are short, and reminders with their DMs are held until the match ends (timers and alarms still ring). See [satellite.md](satellite.md#quiet-while-gaming) | `false` |

## Language model

`brain` is an optional block in the schema, but without it she can't answer anything (the admin page shows it as a setup step). The wizard writes it from a preset.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `brain.provider` | `openai` or `anthropic` | `"openai"` | `anthropic`: Claude through the official SDK. `openai`: any OpenAI-compatible `/chat/completions` API (Groq, Gemini, Ollama, llama.cpp, vLLM) | `"anthropic"` |
| `brain.baseUrl` | URL | `"https://api.anthropic.com"` | Base URL for an OpenAI-compatible API; unused for `anthropic` | `"https://api.groq.com/openai/v1"` |
| `brain.model` | string | required | Model name as the provider spells it | `"claude-haiku-5-5"` |
| `brain.effort` | `low`, `medium`, `high` | `"low"` | Claude only. Lower answers faster; voice wants `low` | `"low"` |
| `brain.apiKeySecret` | key name (language model), may be empty | `"LLM_API_KEY"` | Key in `secrets.env`. Empty for a local server without a key. A missing key shows a setup notice instead of answers | `"ANTHROPIC_API_KEY"` |
| `brain.extraBody` | object | (unset) | Extra fields merged into OpenAI-compatible requests | `{"reasoning_effort":"medium"}` |
| `brain.maxTokens` | integer 32-2000 | `500` | Output token cap for each model call | `400` |
| `brain.firstEventTimeoutMs` | integer 500-30000 | `8000` | No first event by then: the request is ended and retried once (only if nothing has been said yet), then she gives up. With a fallback set, the fallback takes over at 0.6 times this value | `6000` |
| `brain.totalTimeoutMs` | integer 1000-60000 | `20000` | Time to get the whole answer from the model (not to say it; long answers keep playing, up to 2 minutes) | `25000` |
| `brain.priceInPerM` | USD per 1M tokens, 0+ | `0` | Input price, for the spend ledger. **Set the three prices**, or the dollar caps count nothing. The presets fill them in | `0.1` |
| `brain.priceCachedInPerM` | USD per 1M tokens, 0+ | (unset) | Price of cached input (prompt caching). Unset: a tenth of `priceInPerM` with Claude, the full input price otherwise. Claude cache writes are counted at 1.25 times the input price | `0.01` |
| `brain.priceOutPerM` | USD per 1M tokens, 0+ | `0` | Output price | `0.5` |
| `brain.search.apiKeySecret` | key name (search) | `"TAVILY_API_KEY"` | Turns on the web search tool. Also used to find misheard song titles and, at a PC, "open the page for X". Optional block | `"TAVILY_API_KEY"` |
| `brain.search.maxResults` | integer 1-8 | `4` | Results per search | `3` |
| `brain.prewarm.enabled` | boolean | `true` | Claude only. When a woken question heads to the cloud listen (at a PC already when its early listen or a held sentence starts that listen), or push-to-talk goes down, a `max_tokens: 0` request writes the cached tools and prompt while the words are still being listened to, so the answer reads the cache instead of writing it. Skipped while the prefix is warm, for stops, local commands, music orders and the time, for a PC that takes only push-to-talk, and past the spend caps. Each one counts toward the caps: about $0.0017 when it writes the prefix and nothing follows, about $0.00015 more than a cold answer when the answer follows | `false` |
| `brain.prewarm.maxPerHour` | integer | `20` | Most warm-ups in any hour, so a run of false wakes costs at most this many writes | `10` |

### Fallback model (`brain.fallback`, optional block)

Used when the main model fails before it has said anything (outage, rate limit, timeout). It has no price fields; its spend is counted at the main model's prices.

| Key | Type | Default | Example |
|---|---|---|---|
| `brain.fallback.provider` | `openai` or `anthropic` | `"openai"` | `"openai"` |
| `brain.fallback.baseUrl` | URL | `"https://api.anthropic.com"` | `"https://api.groq.com/openai/v1"` |
| `brain.fallback.model` | string | required in the block | `"openai/gpt-oss-120b"` |
| `brain.fallback.effort` | `low`, `medium`, `high` | `"low"` | `"low"` |
| `brain.fallback.apiKeySecret` | key name (language model), may be empty | `""` | `"GROQ_API_KEY"` |
| `brain.fallback.extraBody` | object | (unset) | `{"reasoning_effort":"medium","include_reasoning":false}` |

A fallback whose key is missing is skipped with a warning in the log.

### Background model (`brain.background`, optional block)

Runs background jobs (automatic memory) on another model, typically a local one, so they cost nothing while it's up. When it's down, or its key is missing, the main model does the job. Only used when `autoMemory` is on.

| Key | Type | Default | Example |
|---|---|---|---|
| `brain.background.provider` | `openai` or `anthropic` | `"openai"` | `"openai"` |
| `brain.background.baseUrl` | URL | `"http://127.0.0.1:11434/v1"` (Ollama) | `"http://127.0.0.1:8080/v1"` |
| `brain.background.model` | string | required in the block | `"qwen3:8b"` |
| `brain.background.effort` | `low`, `medium`, `high` | `"low"` | `"low"` |
| `brain.background.apiKeySecret` | key name (language model), may be empty | `""` | `""` |
| `brain.background.extraBody` | object | (unset) | `{}` |
| `brain.background.priceInPerM` | USD per 1M tokens | `0` | `0` |
| `brain.background.priceOutPerM` | USD per 1M tokens | `0` | `0` |

### More models and switching (`brain.models`, optional list)

Leave it out and nothing changes: the main model answers everything, and there's no `use_model` tool or `/model` command. List models here and the main model becomes one choice among them, under the name `brain.mainName` (default `main`). Each kind of job can have its own model (`brain.routes`), and people can switch for a while by voice, text or `/model` ("use the smart model for this", "switch to private", "what model are you on", "go back to normal"). A switch lasts until they switch back or don't talk to her for half an hour.

Each entry takes the same provider fields as the main model, plus:

| Key | Type | Default | Notes |
|---|---|---|---|
| `name` | lowercase name, up to 24 characters | required | What people call it: `smart`, `fast`, `private` |
| `provider`, `baseUrl`, `model`, `effort`, `apiKeySecret`, `extraBody` | as for `brain` | as for `brain` (`apiKeySecret` `""`) | |
| `priceInPerM`, `priceCachedInPerM`, `priceOutPerM` | USD per 1M tokens | `0` | Required (not both 0) unless `local` is true, so spend caps count it |
| `maxTokens` | integer 32-16000 | `brain.maxTokens` | Longest answer. Writing wants more than voice |
| `local` | boolean | `false` | Runs on this machine or your own network. Checked: `baseUrl` must be loopback, a private address or a local name (`localhost`, `*.local`, `*.lan`, a bare name). Free, and may only fall back to another local model |
| `ownersOnly` | boolean | `false` | Only owners may switch to it |
| `about` | text, up to 80 characters | (unset) | Said when someone asks which models there are |
| `fallback` | a listed name or `brain.mainName` | (unset) | Tried when this one fails before answering |

| Key | Type | Default | What it does |
|---|---|---|---|
| `brain.mainName` | lowercase name | `"main"` | The main model's name in the list |
| `brain.routes.chat`, `.writing`, `.background` | model names | (main model) | Which model does that job by default. `background` is automatic memory, when `brain.background` isn't set; a local one there never hands memory to a cloud model |
| `brain.switching` | `owners`, `everyone`, `off` | `"owners"` | Who may switch. `off` keeps the routes and drops the tool and `/model` |
| `brain.lowBudget.model`, `.atPercent` | name, 10-100 | (unset), `80` | Once that share of `limits.dailyUsd` or `limits.monthlyUsd` is spent, people who aren't owners get this model |

A model whose key is missing is left out with a warning. An entry with `provider: "anthropic"` caches its prompt the way the main model does; only the main model's cache is warmed ahead of a question.

```json
"brain": {
  "provider": "anthropic", "model": "claude-haiku-5-5", "apiKeySecret": "ANTHROPIC_API_KEY", "priceInPerM": 1, "priceOutPerM": 5,
  "models": [
    { "name": "smart", "provider": "anthropic", "model": "claude-sonnet-5-5", "apiKeySecret": "ANTHROPIC_API_KEY", "priceInPerM": 3, "priceOutPerM": 15, "maxTokens": 4000, "ownersOnly": true, "about": "slower, for careful writing", "fallback": "main" },
    { "name": "private", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3:8b", "local": true, "maxTokens": 4000, "about": "runs here; nothing leaves the house" }
  ],
  "routes": { "writing": "smart" },
  "lowBudget": { "model": "main", "atPercent": 80 }
}
```

### Presets and examples

The admin page's presets (`LLM_PRESETS` in `src/web/checks.ts`, prices marked there as verified 2026-10-14/15):

| Preset | Model | Key | USD per 1M tokens in / cached in / out |
|---|---|---|---|
| `claude` (recommended) | `claude-haiku-5-5`, effort low | `ANTHROPIC_API_KEY` | 0.10 / 0.01 / 0.50 |
| `groq` | `openai/gpt-oss-120b` at `https://api.groq.com/openai/v1`, `extraBody {"reasoning_effort":"medium","include_reasoning":false}` | `GROQ_API_KEY` | 0.15 / - / 0.60 |
| `gemini` | `gemini-3.1-flash-lite` at `https://generativelanguage.googleapis.com/v1beta/openai`, `extraBody {"reasoning_effort":"none"}` | `GEMINI_API_KEY` | 0.25 / 0.025 / 1.50 |

Claude main with a Groq fallback (the wizard writes this for you):

```json
"brain": {
  "provider": "anthropic", "model": "claude-haiku-5-5", "effort": "low",
  "apiKeySecret": "ANTHROPIC_API_KEY",
  "priceInPerM": 0.1, "priceCachedInPerM": 0.01, "priceOutPerM": 0.5,
  "search": { "apiKeySecret": "TAVILY_API_KEY" },
  "fallback": {
    "provider": "openai", "baseUrl": "https://api.groq.com/openai/v1",
    "model": "openai/gpt-oss-120b", "apiKeySecret": "GROQ_API_KEY",
    "extraBody": { "reasoning_effort": "medium", "include_reasoning": false }
  }
}
```

A local model (Ollama, llama.cpp, vLLM) with no key:

```json
"brain": { "provider": "openai", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3:8b", "apiKeySecret": "" }
```

With Claude the bot uses prompt caching: the rules, the tool descriptions and the earlier turns of a conversation are reused between requests, so most of each later request is billed at the cached-input price (a tenth of the normal price on Haiku). Per-answer numbers are in [costs.md](costs.md).

The admin page offers only the presets, and only ever sends a stored key to the address of the preset it belongs to. A custom or local endpoint is set with `sudo adrian config`.

## Behaviour

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `languages` | boolean | `true` | Also understand and answer Spanish, Chinese, Japanese and Vietnamese. Needs the Whisper model; Whisper and the other languages' voices load the first time someone speaks another language, not at start | `false` |
| `autoMemory` | boolean | `true` | Note facts about each person from their conversations, private to that person | `false` |
| `mature` | `off`, `age-restricted`, `always` | `"age-restricted"` | Swearing, crude humor and adult topics: never, only in age-restricted (NSFW) voice channels, or always | `"off"` |
| `ownerStopReply` | string, up to 80 | `""` | Said after an owner stops an answer. Empty: nothing | `"Okay."` |
| `ownerAck` | string[], up to 10, each up to 40 | `[]` | What an owner hears instead of "Yes?" (used in turn), and how each answer to them starts. Empty: the normal "Yes?" | `["Yes?","Go ahead."]` |
| `ownerAffection` | boolean | `false` | Extra warm and devoted with owners | `true` |
| `botGender` | `female`, `male`, `none` | `"none"` | How she talks about herself: she/her, he/him, or doesn't say | `"female"` |
| `nicknames` | object, ID → string up to 40 | `{}` | What to call particular people. Also used in the greeting ("Yes, Mo?") and as a spelling hint for `cloudStt` | `{"123456789012345678":"Mo"}` |
| `identity.creator` | string, 1-64 | (unset) | The person who set the bot up; "who made you?" answers with this name. Unset: no creator lines | `"Alex"` |
| `identity.creatorSpoken` | string, 1-64 | (unset) | How the voice should say the name, if it's spelled unusually | `"Aleks"` |
| `identity.creatorHeardAs` | string[], up to 20 | `[]` | How speech recognition tends to spell the name | `["Alec","Alix"]` |
| `identity.creatorIds` | string[] of 15-22 digits, up to 5 | `[]` | The creator's Discord accounts. Empty: the owners and the app owner | `["323456789012345678"]` |

The identity and nickname values go into the system prompt sent to the language model on every answer.

### Writing (`writing`, optional block)

Drafts written and edited with her by voice or text: see [usage.md](usage.md#writing-with-her). Off unless `enabled` is true; then the `draft` tool is added.

| Key | Type | Default | What it does |
|---|---|---|---|
| `writing.enabled` | boolean | `false` | Turns it on |
| `writing.people` | `owners`, `everyone` | `"owners"` | Who may keep drafts. Everyone only ever reaches their own |
| `writing.maxTokens` | integer 500-16000 | `4000` | Longest answer from the writing model, when the main model writes. A listed model's own `maxTokens` wins |
| `writing.maxDraftChars` | integer 1000-200000 | `30000` | Longest draft |
| `writing.dictationIdleMinutes` | integer 1-60 | `10` | Dictation ends by itself after this long without a word |
| `writing.documents` | boolean | `true` | Files sent to her in Discord (PDF, Word, text, Markdown): kept per person for two weeks, and the `document` tool to read, fill, edit and convert them. Needs `textChat` on to receive them |
| `writing.templates` | list | `[]` | Templates anyone can start from: `name`, `sections` (`name`, optional `limit` in characters per bullet or paragraph), `bulletLimit`, `style` (rules as text). None are built in; people can also make their own by asking |

Edits are made by the writing model: `brain.routes.writing` if more models are listed, else the main model. A draft marked private is only ever sent to a local model (`brain.models` with `local: true`, or the main model if its address is local); without one, private drafts can be dictated, typed and read but not edited.

```json
"writing": {
  "enabled": true,
  "people": "everyone",
  "templates": [
    { "name": "report", "sections": [{ "name": "Summary", "limit": 400 }, { "name": "Findings" }], "bulletLimit": 200, "style": ["No first person.", "Start each bullet with a verb."] }
  ]
}
```

### Text chat (`textChat`)

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `textChat.enabled` | boolean | `true` | Answer @mentions and replies in servers | `false` |
| `textChat.dms` | boolean | `true` | Answer direct messages | `false` |
| `textChat.maxReplyChars` | integer 200-6000 | `1800` | Longest text reply | `1200` |
| `textChat.readChannels` | boolean | `true` | With the Message Content intent on: read channel history for context and carry on conversations without a new @ | `false` |
| `textChat.historyMessages` | integer 0-100 | `30` | Earlier messages read as context for each answer | `20` |
| `textChat.followUpMinutes` | number 0-30 | `3` | How long after an answer people can keep talking to her without an @ | `5` |
| `textChat.maxPings` | integer 0-20 | `5` | Most people one text reply may @mention, and only when asked. 0: never | `0` |

### Server info (`serverInfo`)

| Key | Type | Default | Effect | Example |
|---|---|---|---|---|
| `serverInfo.enabled` | boolean | `true` | The `server_info` lookup: the server, members, channels, roles, who's in voice | `false` |
| `serverInfo.members` | boolean | `true` | Use the Server Members intent (full member list) when it's switched on in the Developer Portal | `false` |
| `serverInfo.presences` | boolean | `true` | Use the Presence intent (online status, activities) when it's switched on | `false` |

### Passing messages on (`messaging`)

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `messaging.enabled` | boolean | `true` | The `message_member` tool: "tell Sam dinner's ready", by DM or a channel @mention | `false` |
| `messaging.perUserPerHour` | integer 1-100 | `10` | Messages each person can send through her per hour. Owners get at least 30 | `5` |
| `messaging.perTargetPerHour` | integer 1-100 | `5` | Messages each person can receive through her per hour | `3` |
| `messaging.maxChars` | integer 50-1500 | `600` | Longest passed-on message | `300` |

### Between a PC and Discord (`handoff`)

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `handoff.enabled` | boolean | `true` | "Send that link to my PC", "move the music to my PC", "put what I'm watching into the call" (PC parts need `satellite.enabled`), and `tell_call` | `false` |
| `handoff.keepMinutes` | integer 5-120 | `30` | How long your own links and songs count as "that". Other people's links count for 10 minutes | `60` |
| `handoff.tellCall.enabled` | boolean | `true` | "Tell the call I'll be on in 5": said in her voice call, or posted in text when nobody's there | `false` |
| `handoff.tellCall.max` | integer 1-10 | `3` | Messages per person per window | `2` |
| `handoff.tellCall.windowMinutes` | integer 1-60 | `5` | That window | `10` |
| `handoff.tellCall.maxChars` | integer 50-500 | `200` | Longest message | `150` |
| `handoff.tellCall.channelId` | ID | (unset) | Text channel for when nobody's in a call with her. Unset: the one she last wrote in, else her voice channel's chat, else the server's system channel | `"523456789012345678"` |

### Game nights (`gameNight`)

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `gameNight.enabled` | boolean | `true` | "Who's free for Valorant?", "who's playing?", "ping everyone for Valorant in 10", "ping me for game night" | `false` |
| `gameNight.channelId` | ID | (unset) | Where pings go. Unset: the chat it's asked from, else the one she last wrote in, else her voice channel's chat, else the system channel. A set channel she can't post in is an error, not a fallback | `"523456789012345678"` |
| `gameNight.optIn` | ID[], up to 100 | `[]` | People always signed up for every game, until they say "stop pinging me" | `["123456789012345678"]` |
| `gameNight.cooldownMinutes` | integer 1-240 | `15` | Minutes between pings for the same game, and before the same person is pinged again for any game | `30` |
| `gameNight.maxMentions` | integer 1-10 | `10` | Most people one ping mentions | `6` |
| `gameNight.perUserPerHour` | integer 1-20 | `4` | Pings one person may send per hour | `2` |

Sign-ups and cooldowns are kept in `<state>/game-night.json`.

## Voice

`voice` is filled in automatically (its model folder is installer-owned, and `voice` and `speed` start at `af_heart` and 1).

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `voice.modelDir` | path | installer-owned | Kokoro model folder; the other language models are found next to it | - |
| `voice.voice` | string | `"af_heart"` | Local Kokoro voice for English (when the cloud voice is off or falls back). One of 54; `sudo adrian voice NAME` lists the English ones if you give a wrong name, and the admin page's Voice step lets you listen | `"bf_emma"` |
| `voice.speed` | number 0.5-2 (`adrian voice`: 0.7-1.4; the admin page's slider: 0.8-1.2) | `1.0` | Speaking rate; the cloud voice's own speed multiplies on top | `1.1` |
| `voice.threads` | integer 1-8 | `4` | CPU threads for the local voices (Kokoro and Piper) | `2` |

`sudo adrian voice NAME [SPEED]` sets both and restarts.

### Cloud voice (`cloudVoice`, optional block)

Speechify for English replies, with the local voice as the fallback. The block is absent after a fresh install, so there is no cloud voice until you add it; once it exists, `enabled` defaults to `true`.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `cloudVoice.enabled` | boolean | `true` | Use it. Missing key: a warning in the log and the local voice only | `false` |
| `cloudVoice.provider` | `speechify` | `"speechify"` | The only provider | `"speechify"` |
| `cloudVoice.voiceId` | string | `"sabrina"` | Speechify voice | `"sabrina"` |
| `cloudVoice.model` | string | `"simba-3.5"` | Speechify model. `simba-3.2` is the older, slower one | `"simba-3.2"` |
| `cloudVoice.apiKeySecret` | key name (voice) | `"SPEECHIFY_API_KEY"` | Key in `secrets.env` | `"SPEECHIFY_API_KEY"` |
| `cloudVoice.monthlyChars` | integer 0+ | unset: 950,000 for `simba-3.5*`, 1,900,000 otherwise | Characters per calendar month (in `timezone`) before she switches to the local voice for the rest of the month; 0 means no cap. Speechify's Starter plan covers 1.9M characters a month, and simba-3.5 counts each one twice from 21 Nov 2026. Usage is kept in `<state>/voice-usage.json` | `500000` |
| `cloudVoice.timeoutMs` | integer 500-15000 | `4000` | Longest wait for a sentence's first audio, and for any stall after it in a streamed sentence. Past it before any audio: that sentence uses the local voice; past it mid-sentence: the rest of that sentence is dropped. Either way the cloud voice pauses for 60 s | `3000` |
| `cloudVoice.speed` | number 0.75-1.5 | unset: 1.2 for `simba-3.2*`, 1 otherwise | Rate for the cloud voice only, on top of `voice.speed`. simba-3.2 speaks about 133 words a minute, simba-3.5 about 200 | `1.1` |

Turn the cloud voice on (with `SPEECHIFY_API_KEY` saved):

```bash
sudo adrian secret set SPEECHIFY_API_KEY
sudo adrian config cloudVoice '{"voiceId":"sabrina"}'
sudo adrian restart
```

## Music

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `music.enabled` | boolean | `true` | Music in the call. Needs `ffmpeg` installed | `false` |
| `music.ytdlp` | path | (unset): `yt-dlp_linux` next to the models | yt-dlp binary for YouTube | `"/usr/local/bin/yt-dlp"` |
| `music.ffmpeg` | string | `"ffmpeg"` | ffmpeg command or path | `"/usr/bin/ffmpeg"` |
| `music.plexBackup` | boolean | `true` | Use the Plex music library when YouTube fails (needs `PLEX_TOKEN`) | `false` |
| `music.volume` | number 0.05-1 | `0.5` | Music level | `0.35` |
| `music.duckLevel` | number 0-1 | `0.2` | Music level while she listens or talks, as a share of normal | `0.3` |
| `music.maxQueue` | integer 1-100 | `25` | Longest queue | `50` |
| `music.autoplay` | boolean | `true` | When the queue runs out, keep playing similar songs | `false` |
| `music.prefix` | up to 3 symbols; no letters, digits, spaces, `_` or backtick | `"!"` | Typed music commands start with this (`!play x`, `!skip`, `!join`). Empty turns them off. Without the Message Content intent they work only after an @mention (`@A.D.R.I.A.N. !play x`) | `"?"` |
| `music.topSongs` | boolean | `true` | Artist requests shuffle the artist's top songs, ranked by Deezer's free public API. Deezer gets the artist's name, and X from a plain "play X", to find out whether it's an artist. Off: their top song, then similar ones | `false` |
| `music.directSearch` | boolean | `true` | Video searches ask YouTube's search page directly (one request, about 0.5 s) instead of starting yt-dlp. It isn't a documented API, so it has limits: each search waits at most 2 s and one lookup's searches share 3 s; after 3 failures in a row it rests for 5 minutes (logged once as `direct video search resting`) and yt-dlp searches. Off: yt-dlp searches every time | `false` |
| `music.quiz.enabled` | boolean | `true` | "Start a music quiz" | `false` |
| `music.quiz.rounds` | integer 1-20 | `8` | Rounds when none are asked for | `5` |
| `music.quiz.clipSeconds` | integer 8-45 | `20` | How long each clip plays | `25` |
| `music.quiz.hintSeconds` | integer 3-40 | `12` | When the hint comes. Never later than 60% of the clip (with `clipSeconds` 20, at most 12) | `10` |

`music.ytdlp` can be set with `adrian config`, but leave it unset unless you have a reason: the pinned copy next to the models is the one updates replace when YouTube breaks the old one.

## Integrations

### Game servers (`gameServers`)

An array of up to 20 Minecraft servers she may check (a status ping; answers are reused for 30 seconds when `helix` isn't set). With `helix` set and a server linked, she can also start, stop, restart, whitelist and post in chat.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `gameServers[].name` | string 1-60 | required | What people call it | `"Survival"` |
| `gameServers[].host` | string | required | Host or address for the status ping | `"mc.example.com"` |
| `gameServers[].port` | integer 1-65535 | required | Game port | `25565` |
| `gameServers[].kind` | `minecraft` | `"minecraft"` | The only kind | `"minecraft"` |
| `gameServers[].helix.instanceId` | `helix:<id>` (exact, from the server's Advanced tab in Helix) | (unset) | Links the server to Helix; needed for control | `"helix:<instance id>"` |
| `gameServers[].helix.bedrock` | boolean | `false` | The server runs Geyser and Floodgate, so Bedrock players can be whitelisted | `true` |
| `gameServers[].helix.bedrockPrefix` | up to 3 symbols | `"."` | Floodgate's `username-prefix` (in `plugins/floodgate/config.yml`) | `"."` |

With `adrian config`, address entries by index: `gameServers.0.name`, `gameServers.1.helix.instanceId`. A whole list at once: `sudo adrian config gameServers '[{"name":"Survival","host":"127.0.0.1","port":25565}]'`.

### Helix (`helix`, optional block)

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `helix.url` | URL | required in the block | Helix's dashboard address (`SERVER_LAN_IP` stands for your server's address on your network); turns on server control. Only the origin (no path, query or credentials); `https`, or plain `http` only to a private address (10.x, 172.16-31.x, 192.168.x, 100.64-127.x, 169.254.x, loopback, IPv6 ULA or link-local) | `"http://SERVER_LAN_IP:3100"` |
| `helix.allow.start` / `.stop` / `.restart` / `.whitelist` / `.say` | ID[] each, up to 50 | `[]` | Discord user or role IDs who may do that, besides the owners | `["123456789012345678"]` |
| `helix.startWaitSec` | integer 30-1500 | `420` | How long she watches a start or restart before she stops waiting (Helix itself gives up after 6 minutes, 20 for modpacks) | `900` |
| `helix.stopWaitSec` | integer 15-900 | `180` | The same for a stop (it saves the world first) | `300` |
| `helix.sayMaxChars` | integer 10-256 | `200` | Longest in-game chat message | `120` |

Setup steps are in [Minecraft server control (Helix)](#minecraft-server-control-helix) below.

### Media apps (`media`)

Read-only. Each app is used only if its key is in `secrets.env` (`PLEX_TOKEN`, `SONARR_API_KEY`, `RADARR_API_KEY`). Lookups are cached for 60 seconds.

| Key | Type | Default | Effect | Example |
|---|---|---|---|---|
| `media.plexUrl` | URL | `"http://127.0.0.1:32400"` | Plex: "what's new on Plex", "is X on Plex", Plex music backup | `"http://127.0.0.1:32400"` |
| `media.sonarrUrl` | URL | `"http://127.0.0.1:8989"` | Sonarr: "what's downloading", "what's coming up" | `"http://127.0.0.1:8989"` |
| `media.radarrUrl` | URL | `"http://127.0.0.1:7878"` | Radarr: the same for films | `"http://127.0.0.1:7878"` |

### Steam (`steam`) settings

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `steam.enabled` | boolean | `true` | Steam questions: friends online, wishlist sales, store prices (read-only). Friends and wishlists are offered only once `steam.accounts` has an account; prices work without one | `false` |
| `steam.accounts` | object, ID → SteamID64 string, profile link or custom profile name; up to 50 | `{}` | Links a Discord user to their Steam account. Profile names need `STEAM_API_KEY` to look up | `{"123456789012345678":"76561198000000000"}` |
| `steam.country` | two letters (stored upper-case) | `"US"` | Store country; prices come in its currency | `"GB"` |
| `steam.shareWithServer` | boolean | `false` | Let members ask about each other's Steam ("is anything on Alex's wishlist on sale"). Only members with an account in `steam.accounts` can be asked about. Off: everyone gets only their own | `true` |

### Steam

Prices work with no setup. Wishlists need the person's account in `steam.accounts`. Friends need that and a Steam Web API key.

1. **API key** (for friends): sign in at https://steamcommunity.com/dev/apikey, enter any domain name (for example `localhost`), agree, and copy the key. Limited Steam accounts (less than $5 spent) can't get one. Then: `sudo adrian secret set STEAM_API_KEY`.
2. **SteamID64**: in Steam, click your name at the top right, then Account details: the 17-digit number starting `7656119` under your name is it. Your profile link shows it too, as `steamcommunity.com/profiles/7656119…`. If your link is `steamcommunity.com/id/yourname`, you can give that name instead (it needs the key).
3. **Discord ID**: in Discord, Settings → Advanced → Developer Mode on, then right-click yourself → Copy User ID.
4. Link them and restart:
   ```bash
   sudo adrian config steam.accounts.123456789012345678 76561198000000000
   sudo adrian config steam.country GB        # your store's two-letter country; the default is US
   sudo adrian restart
   ```
5. **Privacy** (Steam → your profile → Edit Profile → Privacy Settings): *My profile* Public for anything; *Friends List* Public for friends; *Game details* Public for the wishlist. Friends whose own *Game details* are private show as online without a game.

Steam is only asked when someone asks. Answers are kept briefly so asking twice doesn't ask Steam twice: friends' status 1 minute, friend lists 10 minutes, wishlists 30 minutes, prices 1 hour. A Steam rate limit pauses Steam questions for a minute. SteamIDs are never said or written in answers.

### Minecraft server control (Helix)

Needs Helix 1.10 or later (older panels have no automation API at that address).

With [Helix](https://github.com/Riqqqque/Helix) running your game servers, A.D.R.I.A.N. can start, stop and restart them, change their whitelist and post in their chat. It uses a Helix server API token that lists only the servers you choose and only the permissions it needs.

1. **Make the token.** In Helix: **Settings → Server API tokens → Manage tokens**.
   - Name: `A.D.R.I.A.N.`
   - Expires after: your choice. When it expires she says Helix turned her token down; make a new one and save it again.
   - Servers: tick each server she may manage.
   - Turn **Full access** off and tick only **View**, **Start**, **Stop**, **Restart** and **Console**. Console is for the whitelist, in-game chat and the player list; leave it off if you only want start, stop and restart. She never needs Kill, Files, Settings, Update, Backups, Network or Remove.
   - **Create token**, then copy the value.
2. **Save it** on the bot's machine: `sudo adrian secret set HELIX_TOKEN`, and paste the value at the hidden prompt.
3. **Point her at Helix.** Use the dashboard address you open Helix with, exactly as Helix was installed (`HELIX_GATEWAY_HOST` and `HELIX_LAN_PORT` in `/opt/helix/helix.env`). On the same machine that is still the LAN address, not `127.0.0.1`: Helix publishes its port on that one address only.
   ```bash
   sudo adrian config helix.url http://SERVER_LAN_IP:3100
   ```
4. **Link each server.** For every entry in `gameServers` (0 is the first), copy the server's ID from its **Advanced** tab in Helix:
   ```bash
   sudo adrian config gameServers.0.helix.instanceId "helix:<instance id from the server's Advanced tab>"
   sudo adrian config gameServers.0.helix.bedrock true
   ```
   The second line is only for a server with Geyser and Floodgate.
5. `sudo adrian restart`. The log shows `helix server ok` for each linked server, or `helix server check failed` with the problem: `denied` (the server isn't on the token, or View is off), `gateway` (wrong address), `auth` (the token is wrong or expired), `unreachable` (nothing answers there).

Start, stop and restart jobs being watched are kept in `<state>/game-server-jobs.json`, so she reports them after a restart.

Without the token she says "Server control isn't set up" and does nothing else; status checks keep working. The token goes only to `helix.url`: plain `http` is accepted only for a private address or `localhost` (use `https` for a host name), redirects are never followed, and no cookie or Origin header is ever sent (Helix refuses token requests that have one).

To let others use it, add their Discord user IDs or role IDs (owners can always do everything). Role checks need the member in the bot's cache, which they are once they've joined a call or written in a channel she reads. For example, as a hand edit to `config.json`:

```json
"helix": { "url": "http://SERVER_LAN_IP:3100", "allow": { "start": ["123456789012345678"], "whitelist": ["223456789012345678"] } }
```

## Weather, calendars, news and the morning briefing

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `weather.place` | string 2-100 | (unset) | Where the household is, for the weather. Only this goes to Open-Meteo (free, no key). Include the region to get the right town | `"Springfield, Illinois"` |
| `weather.latitude` | number -90 to 90 | (unset) | Coordinates instead of a place; set both or neither | `39.78` |
| `weather.longitude` | number -180 to 180 | (unset) | The other half of the coordinates | `-89.65` |
| `weather.units` | `fahrenheit` or `celsius` | `"fahrenheit"` | Units for temperatures in answers and the briefing | `"celsius"` |
| `news.feeds` | https URL[], up to 5 | `["https://feeds.npr.org/1001/rss.xml"]` (NPR top stories) | RSS or Atom feeds for headlines (titles only). `[]` turns the headlines tool off | `["https://example.com/feed.xml"]` |
| `calendar.calendars` | array of up to 5 `{name, urlSecret}` | `[]` | Read-only calendars | `[{"name":"personal"}]` |
| `calendar.calendars[].name` | 1-30 letters, digits, spaces, `_` or `-` | required | What people call it | `"personal"` |
| `calendar.calendars[].urlSecret` | key name (calendar) | `"CALENDAR_ICS_URL"` | Secret holding the calendar's private iCal address. A second calendar needs its own name | `"WORK_CALENDAR_URL"` |
| `calendar.people` | ID[], up to 10 | `[]` | Who may hear the calendars; empty means the owners | `["123456789012345678"]` |
| `briefing.enabled` | boolean | `false` | The morning briefing on an owner's first join of the morning ("brief me" works either way) | `true` |
| `briefing.fromHour` | integer 0-23 | `5` | First hour (in `timezone`) when a join counts as the morning one | `6` |
| `briefing.untilHour` | integer 1-24, after `fromHour` | `12` | End of that window | `11` |
| `briefing.headlines` | integer 0-5 | `2` | Headlines in the briefing (0 for none) | `3` |

A calendar is read from its private iCal address: in Google Calendar, open Settings, pick the calendar, and copy "Secret address in iCal format". Anyone with that address can read the calendar, so it goes in the secrets file: `sudo adrian secret set CALENDAR_ICS_URL`, then `sudo adrian config calendar.calendars '[{"name":"personal"}]'`. Nothing can add or change events. Repeating events, moved and cancelled ones, and time zones are handled; files are read again after 5 minutes.

The briefing is said without a model call: the weather, what's left on the calendar today, reminders due today, and the headlines. With other people in the call it says only how many events and reminders there are.

## Home control (MCP, Home Assistant)

`mcp.servers` is an array of up to 5 MCP servers (streamable HTTP) whose tools she may use.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `mcp.servers[].name` | lowercase letters, digits, `_`; up to 16, starting with a letter | required | Short name; her tools are called `<name>_<tool>` | `"home"` |
| `mcp.servers[].url` | URL | required | Home Assistant: `http://<host>:8123/api/mcp/assist` (device control only) | `"http://127.0.0.1:8123/api/mcp/assist"` |
| `mcp.servers[].tokenSecret` | key name (home control) | `"HOME_ASSISTANT_TOKEN"` | Token in `secrets.env` | `"HOME_ASSISTANT_TOKEN"` |
| `mcp.servers[].allow` | string[], up to 50 | `[]` | The tool names she may use; nothing else is offered (empty: no tools) | `["HassTurnOn","HassTurnOff"]` |
| `mcp.servers[].confirm` | string[], up to 50 | `[]` | Tools that always need the person's yes first | `["HassTurnOn"]` |
| `mcp.servers[].confirmWords` | string[], up to 50 | `lock, locks, unlock, door, doors, garage, gate, alarm, valve, oven, stove, security` | A call naming one of these words needs a yes too (Home Assistant locks and unlocks with the same turn on/off tools as lights) | `["lock","garage","heater"]` |
| `mcp.servers[].people` | ID[], up to 10 | `[]` | Who may use them; empty means the owners | `["123456789012345678"]` |
| `mcp.servers[].timeoutMs` | integer 1000-30000 | `8000` | Longest wait for an answer | `5000` |

Home Assistant: add the "Model Context Protocol Server" integration and use its device-control URL, `/api/mcp/assist`: it reaches only the entities exposed to voice assistants (Settings, Voice assistants, Expose), and works with a non-admin user. The main `/api/mcp` URL can include the "Home Assistant" tool set, which reads everything and can run any action, and needs an admin token; don't use it here. Make a user for her, create a long-lived access token on that user's profile page, then:

```bash
sudo adrian secret set HOME_ASSISTANT_TOKEN
sudo adrian config mcp.servers '[{"name":"home","url":"http://127.0.0.1:8123/api/mcp/assist","allow":["HassTurnOn","HassTurnOff","HassLightSet","GetLiveContext"]}]'
```

The yes check reads the names in each call. A call for a whole area ("turn off the porch") names no device, so it can't tell a lock is in it: keep locks, garage doors and alarms out of the exposed entities unless you want her able to work them, and use `confirm` for any tool that should always ask.

If the server doesn't answer at start, she tries again every 5 minutes and adds the tools once it does. The log line `home control ready` lists them, and `notOffered` lists allowed names the server doesn't have.

## Heads-ups and the weekly recap

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `headsUp.enabled` | boolean | `false` | One short "since yesterday: ..." line when someone joins her call after a while away (see [usage.md](usage.md)) | `true` |
| `headsUp.people` | ID[], up to 20 | `[]` | Who gets them; empty means the owners | `["123456789012345678"]` |
| `headsUp.awayHours` | number 0.5-720 | `4` | Away at least this long before a heads-up | `8` |
| `headsUp.minHours` | number 0.5-720 | `6` | At most one heads-up per person this often | `12` |
| `recap.channelId` | ID | (unset) | Text channel for the weekly recap; setting it turns the recap on | `"523456789012345678"` |
| `recap.enabled` | boolean | on once `channelId` is set | `false` turns it off with the channel still set | `false` |
| `recap.day` | `sunday` to `saturday` | `"sunday"` | Day it's posted | `"friday"` |
| `recap.hour` | integer 0-23 | `18` | Hour it's posted, in `timezone` | `20` |

The heads-up and "what did I miss?" read Sonarr and Radarr's import history (or Plex's recently added when those aren't set up) and ping the `gameServers`, only when someone joins or asks, with a 6 second limit. The recap pings the game servers every 10 minutes while the bot runs, for its uptime line. The bot needs Send Messages in the recap channel.

Files in the state folder: `heads-up.json` (when each person was last in the call, last heads-up, their choices; at most 200 people) and `weekly-recap.json` (counts for the last 3 weeks: songs, questions per place, game server samples, and which week was last posted).

## Limits

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `limits.perUserPerHour` | integer 0+ (admin page 0-1000) | `30` | Requests per person per rolling hour: model questions and music plays (including typed and slash music commands). Owners are exempt; 0 means unlimited | `20` |
| `limits.dailyUsd` | number 0+ (admin page 0-1000) | `1` | Spend cap per local day (in `timezone`), USD. 0 means none | `0.5` |
| `limits.guestDailyUsd` | number 0+ | `0.2` | What one guest may spend per local day, USD, so one guest can't use up the shared daily cap (also in the dashboard's Limits step). Owners, the creator's accounts (`identity.creatorIds`) and priority-role members aren't guests. Their answers, and what she learns about them, count. Past it they hear that their share is used up until tomorrow. 0 means no cap of their own | `0.5` |
| `limits.monthlyUsd` | number 0+ (admin page 0-10000) | `10` | Spend cap per calendar month, USD. 0 means none | `5` |
| `limits.maxRequestChars` | integer 20-4000 | `600` | Longest question passed to the model, voice or text | `400` |
| `limits.usageFile` | path | installer-owned: `<state>/usage.json` | Where daily totals are kept, so the caps survive restarts | - |

At a cap she says she's paused (at most once every 10 minutes for each cap, or for each person with the hourly limit), otherwise stays quiet, and stops calling the paid model. Things handled locally keep working: stop phrases, "what time is it", volume and speed, and music commands. Timers that are already set still go off. The caps count only what the `brain.price*` settings say; cloud voice and cloud speech-to-text have their own limits (`cloudVoice.monthlyChars`, the provider's free tier). See [costs.md](costs.md).

## Admin page

Hand edits to `config.json` only (see the top of this page). `server` is an optional block: the installer always writes `host` and `port`.

| Key | Type and range | Default | Effect | Example |
|---|---|---|---|---|
| `server.host` | string | `"127.0.0.1"` | Address the admin page listens on. The installer writes `0.0.0.0` with `--lan`; the Docker image writes `0.0.0.0` inside the container (published only on the host's loopback) | `"0.0.0.0"` |
| `server.port` | integer 1-65535 | `8790` | Port. The installer picks the first free one from 8790 to 8799 unless given `--port` | `8790` |
| `server.allowedHosts` | string[], up to 20 | `[]` | Host names the page answers to besides IP addresses and `localhost` (DNS-rebinding guard; any other Host header gets HTTP 421) | `["adrian.example.com"]` |
| `server.tls.cert` | path to a PEM file | (unset) | With `key`: serve over HTTPS with Secure cookies and HSTS | `"/etc/adrian/tls/cert.pem"` |
| `server.tls.key` | path to a PEM file | (unset) | The private key | `"/etc/adrian/tls/key.pem"` |

## Installer-owned keys

These are set by the installer or filled in by the service on every start and every settings save (`baseConfig` in `src/web/settings.ts`). `adrian config` refuses them.

| Key | Value in a native install | Note |
|---|---|---|
| `secretsFile` | `/etc/adrian/secrets.env` | Required by the schema |
| `listen.vadModel` | `<models>/silero_vad.onnx` | |
| `listen.asrModelDir` | `<models>/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` | |
| `voice.modelDir` | `<models>/kokoro-multi-lang-v1_0` | |
| `limits.usageFile` | `<state>/usage.json` | |
| `testClip` | not used | An Ogg/Opus clip played after joining, only by the development proof-of-concept runner |

`<models>` is `/var/lib/adrian/models` (or `ADRIAN_MODELS`), `<state>` is `/var/lib/adrian` (or `ADRIAN_STATE`).

## Secrets (`/etc/adrian/secrets.env`)

| Name | Purpose | Used for |
|---|---|---|
| `DISCORD_TOKEN` | discord | The bot token (required). Read only by the Discord connection; never part of `config.json` |
| `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `LLM_API_KEY` | language model | Whichever `brain.apiKeySecret`, `brain.fallback.apiKeySecret` or `brain.background.apiKeySecret` names. `GROQ_API_KEY` is also the default for `cloudStt` |
| `TAVILY_API_KEY` | search | Web search |
| `SPEECHIFY_API_KEY` | voice | Cloud voice |
| `PLEX_TOKEN`, `SONARR_API_KEY`, `RADARR_API_KEY` | media | Media apps (read-only) |
| `STEAM_API_KEY` | steam | Steam friends and profile-name lookups (prices and wishlists work without it) |
| `HELIX_TOKEN` | helix | Minecraft server control (see [Minecraft server control](#minecraft-server-control-helix)) |
| `CALENDAR_ICS_URL` | calendar | A calendar's private iCal address (see [Weather, calendars, news and the morning briefing](#weather-calendars-news-and-the-morning-briefing)) |
| `HOME_ASSISTANT_TOKEN` | home control | Home Assistant long-lived access token (see [Home control](#home-control-mcp-home-assistant)) |

Set with `sudo adrian secret set NAME` (hidden prompt, or piped on stdin) or, for the names it lists, on the admin page's Keys tab (`CALENDAR_ICS_URL`, `HOME_ASSISTANT_TOKEN`, `LLM_API_KEY` and other names appear there only once they have been set). `sudo adrian secret list` shows names only; values are never shown again and never logged. In Docker: `printf %s 'value' | docker compose exec -T adrian node dist/cli/tool.js secret-set NAME`.

Each setting may only name a key meant for its job (`SECRET_PURPOSE` and `keyName()` in `src/config.ts`). A language-model setting can never be pointed at `DISCORD_TOKEN` or `PLEX_TOKEN`, for example, so a changed endpoint can't be handed another service's key. Names that aren't in the table (`WORK_CALENDAR_URL`, a second `MY_LLM_KEY`) are free for any purpose. The file format is `NAME=value` per line; a line starting with `#` is a comment (a `#` after the value is part of the value, so `KEY=abc # note` stores `abc # note`), and a quote at either end of the value is stripped.

## Environment variables

| Variable | Used by | Effect |
|---|---|---|
| `ADRIAN_CONFIG` | service, `tool.js` | Config file (default `/etc/adrian/config.json`; the service also takes it as its first argument) |
| `ADRIAN_SECRETS` | service, `tool.js` | Secrets file. Order: the config's `secretsFile`, then this variable, then `secrets.env` next to the config |
| `ADRIAN_STATE` | service, `tool.js` | State directory (default `/var/lib/adrian`) |
| `ADRIAN_MODELS` | service, `tool.js` | Models directory (default `<state>/models`) |
| `ADRIAN_DOWNLOAD_CACHE` | `install.sh`, `upgrade-prep.sh`, the Docker `models` job | Reuse already-downloaded models and runtimes from this folder when their SHA-256 matches (any checksum the pin lists) |
| `ADRIAN_DOWNLOAD_MIRRORS` | `install.sh`, `upgrade-prep.sh`, `adrian update`, the Docker `models` job | https mirrors to try after a file's own site, separated by spaces or commas, as `<mirror>/<file name>` (next release). `/opt/adrian/download-mirrors`, one URL per line, does the same and is read by the hourly update too. A mirror's file must still match a listed checksum; `http://` mirrors are skipped |
| `ADRIAN_UPDATE_REPO` | `adrian update` | GitHub `owner/name` that releases come from (default: this repository) |
| `ADRIAN_DETACH=0` | `adrian update` | Run a by-hand update in the foreground instead of as its own service |
| `ADRIAN_VERSION`, `ADRIAN_PORT`, `TZ` | Docker Compose | Image version (required), host port for the admin page (default 8790), time zone written to the config |
| `LOG_LEVEL=debug` | service | Debug logging |
| `SAY="text"` | service, development | Speaks the text once after the voice link is ready and logs the timing |

The service and `tool.js` read keys only from the secrets file; there is no environment-variable fallback. Only the development proof-of-concept runner, `src/poc/main.ts`, also takes `DISCORD_TOKEN` from the environment.
