# Configuration

Settings live in `/etc/adrian/config.json`, and keys live in `/etc/adrian/secrets.env`. Change them with the admin page, or by dotted path with the `adrian` command (`server.*` and `allowedGuilds` are the exceptions, see below):

```bash
sudo adrian config music.volume            # show a value
sudo adrian config music.volume 0.4        # set it (validated before saving)
sudo adrian config owners '["123456789012345678"]'
sudo adrian restart                        # most settings apply on restart
```

`adrian config` validates against the schema and won't save an invalid value. File paths (models, secrets, usage file) belong to the installer and can't be changed this way.

`server.*` and `allowedGuilds` can't be changed with `adrian config` or the admin page. Edit the file by hand with `sudo nano /etc/adrian/config.json`, keep it valid JSON, then run `sudo adrian restart`. `allowedGuilds` is a top-level array of server IDs: `"allowedGuilds": ["123456789012345678"],`.

## Discord

| Setting | Default | Meaning |
|---|---|---|
| `guildId` | (required) | The home server's ID |
| `channelId` | (required) | The home voice channel's ID; it joins this at start |
| `allowedGuilds` | `[]` | Servers where `/join` works; empty means any server the bot was invited to. Hand edit only (see above). |
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
| `satellite.enabled` | `false` | The endpoint PCs connect to (see [pc-app.md](pc-app.md)) |
| `satellite.bind` | `"0.0.0.0"` | Address that endpoint listens on |
| `satellite.port` | `8791` | Port that endpoint listens on |
| `satellite.logTranscripts` | `false` | For fixing misunderstandings: log what PCs hear and what she answers. Leave off otherwise. |
| `satellite.recordDays` | `0` | Keep recordings of requests made at a PC (never side talk) for this many days, in `<state>/pc-recordings`, to test speech-to-text on your own voice. 0 = off. |
| `satellite.unfinishedWaitMs` | `1200` | At a PC, when a pause sounds mid-sentence (the Smart Turn model), wait this much longer before answering, in ms. 0 = off (only the plain silence wait). |
| `satellite.quietWhileGaming` | `true` | While a PC app (0.15.6 and later) says its owner is in a game: her name for every turn at that PC, short answers there, and reminders held until the match ends (timers still ring). See [satellite.md](satellite.md#quiet-while-gaming). |
| `cloudStt.enabled` | `false` | A second, more accurate listen on Groq for speech meant for her. The local model still does the listening and decides what's meant for her. |
| `cloudStt.apiKeySecret` | `"GROQ_API_KEY"` | Name of the key in `secrets.env` |
| `cloudStt.model` | `"whisper-large-v3-turbo"` | Groq speech model |
| `cloudStt.rooms` | `"pc"` | `pc`: PCs, and anyone in the call with a PC connected. `all`: everyone in the call too |
| `cloudStt.timeoutMs` | `1500` | Longest wait before using the local words, 300 to 5000 ms |

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
| `textChat.enabled` | `true` | Answer @mentions and replies in servers |
| `textChat.dms` | `true` | Answer direct messages |
| `textChat.maxReplyChars` | `1800` | Longest text reply |
| `textChat.readChannels` | `true` | With the Message Content intent on: read channel history and carry on conversations without an @ |
| `textChat.historyMessages` | `30` | Earlier messages read as context for each answer (0-100) |
| `textChat.followUpMinutes` | `3` | How long after an answer people can keep talking without an @ (0-30) |
| `textChat.maxPings` | `5` | Most people one text reply may @mention, only when asked (0: never) |
| `serverInfo.enabled` | `true` | The server_info lookup: server, members, channels, roles, who's in voice |
| `serverInfo.members` | `true` | Use the Server Members intent (full member list) when it's switched on in the portal |
| `serverInfo.presences` | `true` | Use the Presence intent (online status, activities) when it's switched on |
| `messaging.enabled` | `true` | Pass messages on ("tell Sam ...") by DM or a channel @mention |
| `messaging.perUserPerHour` | `10` | Messages each person can send through it per hour (owners exempt) |
| `messaging.perTargetPerHour` | `5` | Messages each person can receive through it per hour |
| `messaging.maxChars` | `600` | Longest passed-on message |
| `handoff.enabled` | `true` | Between a PC and Discord: "send that link to my PC", "move the music to my PC", "put what I'm watching into the call" (needs `satellite.enabled`), and `tell_call` |
| `handoff.keepMinutes` | `30` | How long links and songs count as "that" (5-120). Other people's links count for 10 minutes |
| `handoff.tellCall.enabled` | `true` | "Tell the call I'll be on in 5": said in her voice call, or posted in text when nobody's there |
| `handoff.tellCall.max` | `3` | Messages per person per window (1-10) |
| `handoff.tellCall.windowMinutes` | `5` | That window (1-60) |
| `handoff.tellCall.maxChars` | `200` | Longest message (50-500) |
| `handoff.tellCall.channelId` | (unset) | Text channel for when nobody's in a call with her. Unset: the one she last wrote in, else her voice channel's chat, else the server's system channel |
| `gameNight.enabled` | `true` | "Who's free for Valorant?", "who's playing?", "ping everyone for Valorant in 10", "ping me for game night" |
| `gameNight.channelId` | (unset) | Where pings go. Unset: the chat it's asked from, else the one she last wrote in, else her voice channel's chat, else the system channel. A set channel she can't post in is an error, not a fallback |
| `gameNight.optIn` | `[]` | Discord IDs always signed up for every game, until they say "stop pinging me" |
| `gameNight.cooldownMinutes` | `15` | Minutes between pings for the same game (1-240) |
| `gameNight.maxMentions` | `10` | Most people one ping mentions (1-10) |
| `gameNight.perUserPerHour` | `4` | Pings one person may send per hour (1-20) |
| `botGender` | `"none"` | `female` (she/her), `male` (he/him) or `none`: how it talks about itself |
| `nicknames` | `{}` | What to call particular people, by Discord user ID: `{"123456789012345678": "Big Mike"}` |
| `identity.creator` | (unset) | Your name, for "who made you?" |
| `identity.creatorSpoken` | | How to pronounce it, if needed |
| `identity.creatorHeardAs` | `[]` | How speech recognition misspells it |
| `identity.creatorIds` | `[]` | Your Discord account ID(s); empty means the owners |

## Voice

| Setting | Default | Meaning |
|---|---|---|
| `voice.voice` | `"af_heart"` | Built-in voice, one of 54 (the admin page's Voice step lists the English ones; `adrian voice` shows the current one) |
| `voice.speed` | `1.0` | 0.7 to 1.4 in the CLI and admin page |
| `voice.threads` | `4` | CPU threads for the voice |
| `cloudVoice.enabled` | `true` when the block exists | Cloud voice for English replies |
| `cloudVoice.voiceId` | `"sabrina"` | Speechify voice |
| `cloudVoice.model` | `"simba-3.5"` | `"simba-3.2"` is the older, slower model |
| `cloudVoice.apiKeySecret` | `"SPEECHIFY_API_KEY"` | |
| `cloudVoice.monthlyChars` | `950000` on simba-3.5, `1900000` otherwise | Monthly character cap, then the local voice (0 means no cap). The Starter plan covers 1.9M characters, and simba-3.5 counts each one twice from 21 Nov 2026 |
| `cloudVoice.speed` | `1.0`, or `1.2` on simba-3.2 | Speaking rate for the cloud voice only (0.75 to 1.5). simba-3.5 speaks about 200 words a minute on its own |
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
| `music.topSongs` | `true` | Artist requests shuffle the artist's top songs, ranked by Deezer's free public API. Off: their top song, then similar ones |
| `music.plexBackup` | `true` | Use Plex music when YouTube fails (needs `PLEX_TOKEN`) |
| `music.ffmpeg` | `"ffmpeg"` | Path to ffmpeg |
| `music.quiz.enabled` | `true` | "Start a music quiz" |
| `music.quiz.rounds` | `8` | Rounds when none are asked for, 1 to 20 |
| `music.quiz.clipSeconds` | `20` | How long each clip plays, 8 to 45 |
| `music.quiz.hintSeconds` | `12` | When the hint comes, 3 to 40 |

## Integrations

| Setting | Default | Meaning |
|---|---|---|
| `gameServers` | `[]` | `[{"name":"Survival","host":"127.0.0.1","port":25565}]`: Minecraft status pings |
| `gameServers.N.helix.instanceId` | | The same server in Helix, e.g. `helix:0b9a6c7e-5d0f-4f7e-8f0e-2f6d2b1c9a41` (the server page's **Advanced** tab). Needed for server control |
| `gameServers.N.helix.bedrock` | `false` | The server runs Geyser and Floodgate, so Bedrock players can be whitelisted |
| `gameServers.N.helix.bedrockPrefix` | `"."` | Floodgate's `username-prefix` (in `plugins/floodgate/config.yml`) |
| `helix.url` | | Helix's dashboard address, e.g. `http://192.168.1.50:3100`. Turns on server control |
| `helix.allow.start`, `.stop`, `.restart`, `.whitelist`, `.say` | `[]` | Discord user or role IDs who may do that, besides the owners |
| `helix.startWaitSec` | `420` | How long she waits for a start or restart before she stops watching |
| `helix.stopWaitSec` | `180` | The same for a stop |
| `helix.sayMaxChars` | `200` | Longest in-game chat message |
| `media.plexUrl` | `http://127.0.0.1:32400` | |
| `media.sonarrUrl` | `http://127.0.0.1:8989` | |
| `media.radarrUrl` | `http://127.0.0.1:7878` | |
| `steam.enabled` | `true` | Steam questions: friends online, wishlist sales, store prices (read-only) |
| `steam.accounts` | `{}` | Discord user ID → that person's SteamID64, in quotes: `{"123456789012345678": "76561198000000000"}`. A `steamcommunity.com/profiles/…` or `/id/…` link or a custom profile name also works; profile names need `STEAM_API_KEY` to look up |
| `steam.country` | `"US"` | Store country (two letters). Prices come in its currency |
| `steam.shareWithServer` | `false` | Let members ask about each other's Steam ("is anything on Alex's wishlist on sale"). Only members with an account in `steam.accounts` can be asked about. Off: everyone gets only their own |

### Steam

Prices work with no setup. Wishlists need the person's account in `steam.accounts`. Friends need that and a Steam Web API key.

1. **API key** (for friends): sign in at https://steamcommunity.com/dev/apikey, enter any domain name (for example `localhost`), agree, and copy the key. Limited Steam accounts (less than $5 spent) can't get one. Then: `sudo adrian secret set STEAM_API_KEY`.
2. **SteamID64**: in Steam, click your name at the top right, then Account details: the 17-digit number starting `7656119` under your name is it. Your profile link shows it too, as `steamcommunity.com/profiles/7656119…`. If your link is `steamcommunity.com/id/yourname`, you can give that name instead (it needs the key).
3. **Discord ID**: in Discord, Settings → Advanced → Developer Mode on, then right-click yourself → Copy User ID.
4. Link them and restart:
   ```bash
   sudo adrian config steam.accounts.123456789012345678 76561198000000000
   sudo adrian config steam.country US        # only if your store isn't the US one
   sudo adrian restart
   ```
5. **Privacy** (Steam → your profile → Edit Profile → Privacy Settings): *My profile* Public for anything; *Friends List* Public for friends; *Game details* Public for the wishlist. Friends whose own *Game details* are private show as online without a game.

Steam is only asked when someone asks. Answers are kept briefly so asking twice doesn't ask Steam twice: friends' status 1 minute, friend lists 10 minutes, wishlists 30 minutes, prices 1 hour. A Steam rate limit pauses Steam questions for a minute. SteamIDs are never said or written in answers.

### Minecraft server control (Helix)

With [Helix](https://github.com/Riqqqque/Helix) running your game servers, A.D.R.I.A.N. can start, stop and restart them, change their whitelist and post in their chat. It uses a Helix server API token that lists only the servers you choose and only the permissions it needs.

1. **Make the token.** In Helix: **Settings → Server API tokens → Manage tokens**.
   - Name: `A.D.R.I.A.N.`
   - Expires after: your choice. When it expires she says Helix turned her token down; make a new one and save it again.
   - Servers: tick each server she may manage.
   - Turn **Full access** off and tick only **View**, **Start**, **Stop**, **Restart** and **Console**. Console is for the whitelist, in-game chat and the player list; leave it off if you only want start, stop and restart. She never needs Kill, Files, Settings, Update, Backups, Network or Remove.
   - **Create token**, then copy the value.
2. **Save it** on the bot's machine: `sudo adrian secret set HELIX_TOKEN`, and paste the value at the hidden prompt.
3. **Point her at Helix.** Use the dashboard address you open Helix with, exactly as Helix was installed (`HELIX_GATEWAY_HOST` and `HELIX_LAN_PORT` in `/opt/helix/helix.env`). On the same machine that is still the LAN address, not `127.0.0.1`: Helix publishes its port on that one address only.
   ```
   sudo adrian config helix.url http://192.168.1.50:3100
   ```
4. **Link each server.** For every entry in `gameServers` (0 is the first), copy the server's ID from its **Advanced** tab in Helix:
   ```
   sudo adrian config gameServers.0.helix.instanceId helix:0b9a6c7e-5d0f-4f7e-8f0e-2f6d2b1c9a41
   sudo adrian config gameServers.0.helix.bedrock true
   ```
   The second line is only for a server with Geyser and Floodgate.
5. `sudo adrian restart`. The log shows `helix server ok` for each linked server, or `helix server check failed` with the problem: `denied` (the server isn't on the token, or View is off), `gateway` (wrong address), `auth` (the token is wrong or expired), `unreachable` (nothing answers there).

Without the token she says "Server control isn't set up" and does nothing else; status checks keep working. The token goes only to `helix.url`: plain `http` is accepted only for a private IP address or `localhost` (use `https` for a host name), redirects are never followed, and no cookie or Origin header is ever sent (Helix refuses token requests that have one).

To let others use it, add their Discord user IDs or role IDs (owners can always do everything). Role checks need the member in the bot's cache, which they are once they've joined a call or written in a channel she reads. This is a hand edit to `config.json`:
```json
"helix": { "url": "http://192.168.1.50:3100", "allow": { "start": ["123456789012345678"], "whitelist": ["987654321098765432"] } }
```

## Heads-ups and the weekly recap

| Setting | Default | Meaning |
|---|---|---|
| `headsUp.enabled` | `false` | One short line about what's new when someone joins her call after a while away (see usage) |
| `headsUp.people` | `[]` | Discord user IDs who get them; empty means the owners |
| `headsUp.awayHours` | `4` | Away at least this long before a heads-up |
| `headsUp.minHours` | `6` | At most one heads-up per person this often |
| `recap.channelId` | (unset) | Text channel for the weekly recap; setting it turns the recap on |
| `recap.enabled` | on once `channelId` is set | `false` turns it off with the channel still set |
| `recap.day` | `"sunday"` | Day it's posted, `sunday` to `saturday` |
| `recap.hour` | `18` | Hour it's posted (0-23), in `timezone` |

The heads-up and "what did I miss?" read Sonarr and Radarr's import history (or Plex's recently added when those aren't set up) and ping the `gameServers`, only when someone joins or asks, with a 6 second limit. The recap pings the game servers every 10 minutes while the bot runs, for its uptime line. The bot needs Send Messages in the recap channel.

Files in the state folder: `heads-up.json` (when each person was last in the call, last heads-up, their choices; at most 200 people) and `weekly-recap.json` (counts for the last 3 weeks: songs, questions per place, game server samples, and which week was last posted).

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `limits.perUserPerHour` | `30` | Requests per person per hour (owners are exempt); 0 means unlimited |
| `limits.dailyUsd` | `1` | Daily spend cap in USD (0 means none) |
| `limits.monthlyUsd` | `10` | Monthly spend cap in USD (0 means none) |
| `limits.maxRequestChars` | `600` | Longest question passed to the model |

At a cap, it says once that it's paused and stops calling the paid model. Things handled locally keep working: stop phrases, "what time is it", volume and speed, and music commands. Timers that are already set still go off.

## Admin page

These are hand edits to `config.json` (see the top of this page).

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
| `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `LLM_API_KEY` | Language models (whichever `brain.apiKeySecret` names). `GROQ_API_KEY` is also the default for `cloudStt`. |
| `TAVILY_API_KEY` | Web search |
| `SPEECHIFY_API_KEY` | Cloud voice |
| `PLEX_TOKEN`, `SONARR_API_KEY`, `RADARR_API_KEY` | Media (read-only) |
| `STEAM_API_KEY` | Steam friends (prices and wishlists work without it) |
| `HELIX_TOKEN` | Minecraft server control through Helix (see [Minecraft server control](#minecraft-server-control-helix)) |

Set with `sudo adrian secret set NAME` (hidden prompt) or the admin page. Values are never shown again.

Each setting can only use keys meant for its job. For example, a language-model setting can never be pointed at `DISCORD_TOKEN` or `PLEX_TOKEN`, so a changed endpoint can't leak them.

## Environment variables

For development or unusual layouts: `ADRIAN_CONFIG` (the config file), `ADRIAN_SECRETS` (the secrets file), `ADRIAN_STATE` (the state directory), `ADRIAN_MODELS` (the models directory), and `LOG_LEVEL=debug`.
