# Configuration

Settings live in `/etc/adrian/config.json`, and keys live in `/etc/adrian/secrets.env`. Change them with the admin page, or by dotted path with the `adrian` command:

```bash
sudo adrian config music.volume            # show a value
sudo adrian config music.volume 0.4        # set it (validated before saving)
sudo adrian config owners '["123456789012345678"]'
sudo adrian restart                        # most settings apply on restart
```

`adrian config` validates against the schema and won't save an invalid value. File paths (models, secrets, usage file) belong to the installer and can't be changed this way.

## Discord

| Setting | Default | Meaning |
|---|---|---|
| `guildId` | (required) | The home server's ID |
| `channelId` | (required) | The home voice channel's ID; it joins this at start |
| `allowedGuilds` | `[]` | Servers where `/join` works; empty means any server the bot was invited to |
| `priorityRoleIds` | `[]` | Role IDs whose members may interrupt anyone's answer |
| `owners` | `[]` | User IDs with owner rights (the app owner always has them); max 10 |
| `timezone` | the installer's system time zone | For "what time is it", timers and the daily spend cap |
| `playbackVolume` | `0.7` | Voice level, 0 to 1 (1 is about −16 LUFS) |
| `silenceMs` | `800` | Discord: how long a speaker must be silent before their audio stream ends |

## Listening

| Setting | Default | Meaning |
|---|---|---|
| `listen.vadThreshold` | `0.5` | Voice detection sensitivity, 0.1 to 0.95 |
| `listen.minSilence` | `0.5` | Pause (seconds) that ends a phrase |
| `listen.minSpeech` | `0.25` | Shortest sound counted as speech (seconds) |
| `listen.maxSpeech` | `20` | Longest single phrase (seconds) |
| `listen.asrThreads` | `4` | CPU threads for speech recognition |
| `listen.wakeName` | `"adrian"` | The name it listens for |
| `listen.logTranscripts` | `false` | Development only: log what people say. Leave off. |

## Language model

| Setting | Default | Meaning |
|---|---|---|
| `brain.provider` | `"openai"` | `"anthropic"` (Claude through its SDK) or `"openai"` (any OpenAI-compatible API) |
| `brain.baseUrl` | | OpenAI-compatible base URL, e.g. `https://api.groq.com/openai/v1`; unused for anthropic |
| `brain.model` | (required) | e.g. `claude-haiku-5-5`, `openai/gpt-oss-120b` |
| `brain.effort` | `"low"` | Claude only: `low`, `medium` or `high`. Low answers fastest. |
| `brain.apiKeySecret` | `"LLM_API_KEY"` | Name of the key in `secrets.env`; empty for a local server without a key |
| `brain.extraBody` | | Extra request fields for OpenAI-compatible APIs, e.g. `{"reasoning_effort":"medium"}` |
| `brain.maxTokens` | `500` | Cap on the spoken answer |
| `brain.firstEventTimeoutMs` | `8000` | No response by then: retry once, then give up |
| `brain.totalTimeoutMs` | `20000` | Time to write the whole answer; a slow tool (music) extends it |
| `brain.priceInPerM` / `priceCachedInPerM` / `priceOutPerM` | `0` | USD per million tokens, for spend tracking. **Set these**, or the dollar caps can't count anything. The wizard's presets fill them in. |
| `brain.search.apiKeySecret` | `"TAVILY_API_KEY"` | Web search (optional) |
| `brain.search.maxResults` | `4` | Results per search |
| `brain.fallback.{provider,baseUrl,model,effort,apiKeySecret,extraBody}` | | Used when the main model fails before answering (outage, rate limit) |

Example, Claude main with a free Groq fallback (the wizard writes this for you):

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

With Claude, the bot uses prompt caching. The rules, the tool descriptions and earlier turns of a conversation are reused between requests, so later answers read about 90% of their input from the cache at a tenth of the price.

## Behaviour

| Setting | Default | Meaning |
|---|---|---|
| `languages` | `true` | Answer in Spanish, Chinese, Japanese and Vietnamese too |
| `autoMemory` | `true` | Note facts about each person automatically (private to them) |
| `mature` | `"age-restricted"` | `off`, `age-restricted` (only in age-restricted channels) or `always` |
| `ownerStopReply` | `""` | Said after an owner stops an answer |
| `ownerAck` | `[]` | What owners hear instead of "Yes?" (used in turn) |
| `ownerAffection` | `false` | Extra warm with owners |
| `nicknames` | `{}` | What to call particular people, by Discord user ID: `{"123456789012345678": "Big Mike"}` |
| `identity.creator` | (unset) | Your name, for "who made you?" |
| `identity.creatorSpoken` | | How to pronounce it, if needed |
| `identity.creatorHeardAs` | `[]` | How speech recognition misspells it |
| `identity.creatorIds` | `[]` | Your Discord account ID(s); empty means the owners |

## Voice

| Setting | Default | Meaning |
|---|---|---|
| `voice.voice` | `"af_heart"` | Built-in voice, one of 54 (`adrian voice` lists the English ones) |
| `voice.speed` | `1.0` | 0.7 to 1.4 in the CLI and admin page |
| `voice.threads` | `4` | CPU threads for the voice |
| `cloudVoice.enabled` | `true` when the block exists | Cloud voice for English replies |
| `cloudVoice.voiceId` | `"sabrina"` | Speechify voice |
| `cloudVoice.model` | `"simba-3.2"` | |
| `cloudVoice.apiKeySecret` | `"SPEECHIFY_API_KEY"` | |
| `cloudVoice.monthlyChars` | `1900000` | Monthly character cap, then the local voice (0 means no cap) |
| `cloudVoice.timeoutMs` | `4000` | Slower than this: the local voice is used for that sentence |

Turn the cloud voice on (with `SPEECHIFY_API_KEY` saved):

```bash
sudo adrian config cloudVoice '{"voiceId":"sabrina"}'
sudo adrian restart
```

## Music

| Setting | Default | Meaning |
|---|---|---|
| `music.enabled` | `true` | Needs `ffmpeg` installed |
| `music.volume` | `0.5` | Music level, 0.05 to 1 |
| `music.duckLevel` | `0.2` | Music level while it listens or talks, as a share of normal |
| `music.maxQueue` | `25` | |
| `music.autoplay` | `true` | Keep playing similar songs after the queue ends |
| `music.plexBackup` | `true` | Use Plex music when YouTube fails (needs `PLEX_TOKEN`) |
| `music.ffmpeg` | `"ffmpeg"` | Path to ffmpeg |

## Integrations

| Setting | Default | Meaning |
|---|---|---|
| `gameServers` | `[]` | `[{"name":"Survival","host":"127.0.0.1","port":25565}]`: Minecraft status pings |
| `media.plexUrl` | `http://127.0.0.1:32400` | |
| `media.sonarrUrl` | `http://127.0.0.1:8989` | |
| `media.radarrUrl` | `http://127.0.0.1:7878` | |

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `limits.perUserPerHour` | `30` | Requests per person per hour (owners are exempt); 0 means unlimited |
| `limits.dailyUsd` | `1` | Daily spend cap in USD (0 means none) |
| `limits.monthlyUsd` | `10` | Monthly spend cap in USD (0 means none) |
| `limits.maxRequestChars` | `600` | Longest question passed to the model |

At a cap, it says once that it's paused and stops calling the paid model. Things handled locally keep working: stop phrases, "what time is it", volume and speed, and music commands. Timers that are already set still go off.

## Admin page

| Setting | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | `0.0.0.0` with `--lan` |
| `server.port` | `8790` | |
| `server.allowedHosts` | `[]` | Host names you open it by (IPs and `localhost` always work) |
| `server.tls.cert` / `server.tls.key` | | PEM files: serve over HTTPS with Secure cookies |

## Secrets (`/etc/adrian/secrets.env`)

| Name | Used for |
|---|---|
| `DISCORD_TOKEN` | The bot token (required) |
| `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `LLM_API_KEY` | Language models (whichever `brain.apiKeySecret` names) |
| `TAVILY_API_KEY` | Web search |
| `SPEECHIFY_API_KEY` | Cloud voice |
| `PLEX_TOKEN`, `SONARR_API_KEY`, `RADARR_API_KEY` | Media (read-only) |

Set with `sudo adrian secret set NAME` (hidden prompt) or the admin page. Values are never shown again.

Each setting can only use keys meant for its job. For example, a language-model setting can never be pointed at `DISCORD_TOKEN` or `PLEX_TOKEN`, so a changed endpoint can't leak them.

## Environment variables

For development or unusual layouts: `ADRIAN_CONFIG` (the config file), `ADRIAN_SECRETS` (the secrets file), `ADRIAN_STATE` (the state directory), `ADRIAN_MODELS` (the models directory), and `LOG_LEVEL=debug`.
