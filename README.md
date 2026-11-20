# A.D.R.I.A.N. — Discord voice assistant

**A**dvanced **D**igital **R**easoning & **I**ntelligence **A**ssistant **N**etwork, the voice module.

A.D.R.I.A.N. is a self-hosted voice assistant that sits in a Discord voice channel with you and your friends. Say **"Hey Adrian"** and ask anything: it answers out loud, plays music, sets alarms and timers, runs party games, checks your game servers and media server, and remembers people. It is one Node.js process (`node dist/app/main.js`, run by systemd as the `adrian-voice` service) that is at once the Discord bot, the server side of the optional Windows PC app (a WebSocket for paired PCs), and a small admin web page on loopback. Speech recognition and the built-in voices run on your own machine; no audio goes to the language model you choose, only text (the transcribed request plus context such as recent talk in the call) and, when you ask about your PC's screen, a picture of it. Spending is capped.

This repository is what runs in production. The Windows PC app and its PC-control library live in [the main A.D.R.I.A.N. repository](https://github.com/Riqqqque/A.D.R.I.A.N) (`crates/desktop`, `crates/pc-control`).

**Changing the code?** Start with [CONTRIBUTING.md](CONTRIBUTING.md): reading order, what is safe to change, what is guarded and by which tests, and how to test.

---

## Features at a glance

Everything below is in the current release (0.17.1), except what is marked *(next release)*: that is on `main` and ships with the next release. Example phrases and every command are in [docs/usage.md](docs/usage.md); every model tool is in [docs/tools.md](docs/tools.md).

**Talking to it**
- Wake with "Hey Adrian", "Adrian, ...", or just "Adrian?" (it says "Yes?" and listens). Follow-ups within 8 seconds in a call (20 seconds at a PC) don't need the name. A question with the name at the end ("what time is it, Adrian?") wakes it too, and the model decides whether it was meant for it; talk *about* it ("hey, Adrian is in the other channel") is judged the same way *(next release)*.
- Short, conversational answers: most are one sentence, how-to answers two, with no offers or questions back unless it needs your answer. A safety warning that matters, and every item of a list you asked for, are always kept, and anything that changes day to day (sunset, the weather, store hours, scores, prices) is looked up rather than answered from memory *(next release)*. It knows who is in the call and what was said in the last few minutes, ignores side talk and game chatter, keeps one answer at a time with a short queue, and lets the person it is answering talk over it.
- Stops at once on "stop", "shut up", "never mind". Everyday words like "done" or "quiet" only count from the person it is answering, or with its name.
- Everyday phrases are handled locally, with no model call: thanks, bye, repeat that, louder or quieter, faster or slower, what time is it, and plain music controls.
- Five languages: English, Spanish, Chinese, Japanese and Vietnamese, answered in the language you speak. For Chinese, Japanese and Vietnamese, say "Hey Adrian", wait for "Yes?", then ask.
- Per-person memory: "remember that I'm vegetarian", plus facts it picks up by itself every few answers (`autoMemory`). Each person's notes go only into their own requests.

**Text chat and the Discord server**
- @mention it, reply to it, or DM it: same brain, tools, memory and limits, answered in text. Replies never ping @everyone or roles.
- With Discord's Message Content intent it reads recent channel messages for context and you can keep talking for a few minutes without @mentioning it.
- Knows the server: who is online and playing what, who is in which call, members, roles and channels (only what the asker can see). Passes messages on: "tell Sam dinner's ready" sends a DM, after a read-back unless you named the person yourself.
- Game nights: "who's free for Valorant?", "ping me for game night", "get the squad on" (pings only people who signed up, with cooldowns).

**Music and sounds** (YouTube Music through a pinned yt-dlp, your Plex library as a backup; needs `ffmpeg`)
- Songs, artists, albums, playlists, moods ("something for a late night drive"), "more like this", podcasts, any YouTube video, and pasted YouTube, SoundCloud, Bandcamp or Spotify links (Spotify is found on YouTube).
- Queue, skip, back, pause, shuffle, volume, "what's playing", "who put this on?". Autoplay keeps similar songs coming without repeats. Music ducks under its voice.
- A version asked for by name ("tiny desk", "live", "acoustic", "remix", "sped up") plays that performance, and a bare genre or era ("some jazz", "90s r&b") plays a playlist *(next release)*.
- Learns each person's taste for "play some music", and has its own.
- Music quiz: short clips, anyone in the call guesses, it keeps score. Matching is local; a near miss may cost one tiny model call.
- Sound effects: "give me a drum roll" plays a short clip (up to 15 seconds).
- Commands too: `/join` and `/leave`, `/play` (with suggestions), `/music ...` (now-playing card with buttons), and typed `!play`, `!skip`, `!np` and the rest.

**Alarms, reminders and your day**
- Alarms that ring until stopped, timers and reminders, by voice or `/alarm`. Nine built-in tones, its voice, a song, or saved clips. Stop by voice with no wake word, snooze, undo within 3 minutes, optional "firm" or "math" mode to turn an alarm off.
- Rings where you are: the call, else your PC, else a DM with Stop and Snooze buttons. The PC app keeps a backup copy and rings by itself if the server doesn't.
- Weather (Open-Meteo, no key; the place comes only from config), news headlines from RSS feeds, a read-only iCal calendar, and a morning briefing that keeps details private when others can hear.
- Optional heads-up when someone joins after hours away, "what did I miss?", and a weekly recap post with counts only (no transcripts).

**Integrations** (most need a key or a config entry before they appear)
- Minecraft servers: status by server-list ping. With the Helix panel: start, stop and restart (stop and restart ask first), whitelist, and in-game chat, for owners and allow-listed people.
- Steam: which friends are playing what, wishlist sales, store prices.
- Plex, Sonarr and Radarr, read-only: what's new, is it on Plex, what's downloading, upcoming episodes.
- Home control through MCP, for example Home Assistant's MCP server: only allow-listed tools, only listed people (owners by default), and a spoken yes before locks, doors, garage and the like.
- Web search through Tavily.

**Games** (always on)
- Party games: trivia, would-you-rather and riddles with a scoreboard, dice, coin flips. The music quiz is listed under music.

**Voice**
- 54 built-in Kokoro voices run locally, plus a local Piper voice for Vietnamese. Speech is loudness-matched (about -16 LUFS).
- Optional cloud voice for English (Speechify, model `simba-3.5`, voice `sabrina` by default) with a monthly character cap. It falls back to the local voice by itself when the cap is reached or the service fails. Its longer sentences start playing while they're still arriving, and the local voice then loads only when it's needed *(next release)*.
- Times, units, symbols and links are said the way people say them ("7 o'clock", "season 3 episode 3", "modrinth.com"), and emoji aren't read out *(next release)*.

**On your PC** (optional Windows app, see [docs/pc-app.md](docs/pc-app.md))
- Listens through the PC's mic ("Hey Adrian", or hold Ctrl+Alt+Space), answers through its speakers in the same voice, and shows a small animated window. In the tray it uses about 5 MB of memory.
- Controls the PC through typed, allow-listed actions: open apps and games, web pages, YouTube and Spotify, media keys, volume, window layout, lock, and sleep, restart or shut down only after a spoken yes. Each PC decides in its own settings what is allowed.
- PC health, and only when you ask, what you copied or what is on screen.
- Quiet while gaming: during a game it needs its name every time, keeps answers short and holds reminders until the match ends.
- Between the PC and Discord: "send that link to my PC", "move the music to my PC", "tell the call I'll be on in 5".
- When the PC's owner is also in its Discord call, the call answers instead, so music plays for everyone.
- Orders about the house ("lock the front door", "turn the TV down", "kill the lights") never reach the PC; "lock my PC" still does *(next release)*.
- Answers at the PC start sooner: it starts recognizing what you said during the pause at the end of it (about 0.5 s sooner in a test harness with stand-in models) *(next release)*.

**Running it**
- Admin web page with a setup wizard, live status (latency, spend), settings, keys and logs. Loopback only by default. Its Status tab also shows what needs attention, what she costs (including the cloud voice, Groq and Tavily), how fast she answers and how reliable she is, kept across restarts *(next release)*.
- The `adrian` command: status, logs, start/stop/restart, config, secret (keys), voice, check, doctor, setup-code, reset-admin, satellite (pair PCs), backup, restore, update, rollback, uninstall, and an optional hourly `auto-update` that waits until nobody is in its call and nothing is playing.
- Behaviour you may want to change: `mature` is `age-restricted` by default (swearing, crude humor and frank adult topics only in voice channels Discord marks as age-restricted; `off` or `always` are the other choices); `brain.fallback` answers when the main model fails (rate limit, outage); `brain.background` can run automatic memory on a local model.
- Owners (by Discord user ID, plus the bot application's owner) can stop anyone, skip the line, and use the guarded tools.

## What it costs at a glance

Full numbers, how they were measured and how to spend less: [docs/costs.md](docs/costs.md).

| Item | Cost | In the dollar caps? |
|---|---|---|
| Language model | Pay per token. The recommended preset, Claude Haiku 5.5, is $0.10 per million input tokens, $0.01 cached, $0.50 output (preset prices in `src/web/checks.ts`, checked 2026-10-14/15). The wizard's estimate for a plain answer is 900 input and 60 output tokens, about $0.00012. Real answers carry a larger prompt (mostly cached on Claude) and a request that uses a tool usually takes a second model call, up to four per request. With `autoMemory` on (default), one extra background call every 4 answers per person reads the conversation for facts; point `brain.background` at a local model to make it free. Measured figures are in docs/costs.md. Groq has a free tier, and any OpenAI-compatible endpoint works, including a local one. | Yes |
| Spend caps (defaults) | `limits.dailyUsd` $1, `limits.monthlyUsd` $10, `limits.perUserPerHour` 30 requests (owners are exempt from the hourly limit only). At a cap it stops calling the paid model; the answer that crosses a cap still finishes. | — |
| Free, no model call | Local phrases, plain "play X", slash and typed commands, `/alarm`, speech recognition, the Kokoro and Piper voices, Deezer, Open-Meteo, RSS and YouTube lookups. | — |
| Cloud voice (optional) | Your Speechify plan. Default cap `cloudVoice.monthlyChars` 950,000 characters a month for `simba-3.5`, then the local voice. | No, own character budget |
| Cloud second listen (optional, off by default) | `cloudStt`: Groq Whisper re-transcribes speech already judged to be for it (PC rooms only by default, `cloudStt.rooms`). Groq key and rate limits apply. | No |
| Web search (optional) | Tavily, one credit per search. | No |
| Server machine | About 1.5-1.6 GB of memory after start (1.52-1.64 GB measured, releases 0.15.4-0.17.1); about 1.3 GB more once someone speaks a language other than English. With the cloud voice on, about 0.5 GB less from the next release, because the local voice then loads only when it's needed (1.59 to 1.10 GB in a measurement on Windows). The service is capped at `MemoryHigh=4G`, `MemoryMax=5G`, `CPUQuota=400%`. The installer needs about 3 GB free under `/opt` and `/var/lib`. | — |
| PC app | About 5 MB of private memory in the tray (releases 0.15.3-0.17.1, November 2026); about 0.01% CPU and 0% GPU in the tray (measured 2026-10-23). All AI cost is on the server. | — |

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Linux x86_64 with systemd and glibc (not musl/Alpine, not ARM). The container tests default to Ubuntu 24.04. | Ubuntu 24.04 |
| CPU | 4 cores | 8 threads, recent desktop or server CPU |
| Memory | 4 GB free (about 3.5 GB once the language voices load, as measured in 0.14.7 when they loaded at every start; since 0.15.4 they load on first use: about 1.5-1.6 GB after start, plus about 1.3 GB the first time someone speaks a language other than English; `sudo adrian config languages false` keeps it near 1.5 GB). The installer warns below 4 GB. | 8 GB+ |
| Disk | About 3 GB free: 1 GB under `/opt` and 2 GB under `/var/lib` (the installer refuses less) | |
| Other | `ffmpeg` for music and sounds, plus `curl`, `xz-utils`, `bzip2` and `iproute2` for the installer (`get.sh` installs them after asking; by hand: `sudo apt install ffmpeg curl xz-utils bzip2 iproute2`). Node.js 22 and the speech models are downloaded by the installer, pinned and checked against SHA-256. | |

You also need:
- A Discord account and a server where you can add a bot.
- A language-model API key: Claude Haiku 5.5 (recommended, pay as you go), Groq (free tier), Gemini, or any OpenAI-compatible endpoint.
- For the PC app: Windows 10 or 11 (x64).

Docker is supported as an alternative to the native install (without the `adrian` command, updates, rollback or backups); see [docs/install.md](docs/install.md).

## Quick start

The full walkthrough, including creating the Discord bot and getting each key, is in **[docs/install.md](docs/install.md)**. The short version, on the Linux machine:

```bash
# 1. Get the installer and run it: it installs the packages it needs (asking first),
#    downloads the newest release with its checksum, checks it and installs it
curl -fsSLO https://raw.githubusercontent.com/Riqqqque/adrian-discord-voice/main/packaging/get.sh
sudo bash get.sh

# 2. Open the admin page it prints (usually http://127.0.0.1:8790), enter the setup code, follow the wizard
```

If the machine isn't ready (disk, internet, an unsupported computer), it lists everything to fix at once and changes nothing; run it again after. Installing by hand, without `get.sh`, is in [docs/install.md](docs/install.md#install-by-hand).

The installer creates a locked-down `adrian` system user and the systemd service, and prints a one-time setup code. The wizard then walks you through the Discord token, the server and channel, the language model, search, the voice and spend limits. On a remote server, reach the admin page through an SSH tunnel (the installer prints the command).

Everyday management on the server:

```bash
sudo adrian status            # service state, health, admin page address
sudo adrian logs -f           # live log (keys are redacted)
sudo adrian doctor            # full diagnostics
sudo adrian update            # newest release from GitHub, checksum verified; rolls back if it does worse
                              # (runs in the background, so a dropped SSH connection can't stop it)
sudo adrian config music.autoplay false   # change any setting, then: sudo adrian restart
sudo adrian config owners '["<your Discord user ID>"]'
```

Every command is in [docs/install.md](docs/install.md); every setting, with its default, is in [docs/configuration.md](docs/configuration.md). For the PC app, turn on `satellite.enabled`, pair the PC with `sudo adrian satellite add NAME OWNER_ID`, and follow [docs/pc-app.md](docs/pc-app.md).

## Privacy in short

- **Stays on your machine:** speech recognition, the built-in voices, alarms, notes and all state files. Audio is not stored or uploaded unless you turn on `cloudStt` (sends speech meant for it to Groq) or `satellite.recordDays` (keeps recordings of PC requests).
- **Leaves your machine:** the transcribed request, the conversation so far, what others in the call said recently, who is in the call, and the asker's notes go to your language model. Searches go to Tavily, English replies to Speechify if the cloud voice is on, music searches to YouTube and Deezer. On request at the PC, what you copied or a picture of your screen goes to the model. The weather place goes to Open-Meteo; news feeds are fetched (NPR by default, `news.feeds`); Steam lookups go to Steam; the calendar's iCal address is fetched; the same prompts go to `brain.fallback` or `brain.background` if you configure them; MCP and Home Assistant servers you configure get the tool calls meant for them.
- **Keys** live in `/etc/adrian/secrets.env` (mode 0600). The admin page can set keys but never shows them, and each setting can only use a key meant for its own job.
- **Other services** are read-only unless you configure control: Helix server actions and MCP home control are opt-in and limited to owners, allow lists and a spoken yes where it matters.

Threat model and protections: [docs/security.md](docs/security.md). Reporting a problem: [SECURITY.md](SECURITY.md).

## Documentation

| Document | What it covers |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | **Start here to change the code**: reading order, safe vs guarded areas, invariants and their tests, testing, privacy rules, commits and releases |
| [docs/codebase-map.md](docs/codebase-map.md) | Every source file and directory: purpose, key exports, invariants, covering tests |
| [docs/architecture.md](docs/architecture.md) | Components, processes, the path of a spoken turn (Discord and PC), alarms, music, state files, models, workers |
| [docs/usage.md](docs/usage.md) | User guide: every feature with example phrases, slash and typed commands, who can do what |
| [docs/tools.md](docs/tools.md) | Every model tool: purpose, arguments, guard rails, who may use it, cost notes |
| [docs/costs.md](docs/costs.md) | Money per answer and per provider, free tiers, budgets, how to make it cheaper; machine cost |
| [docs/configuration.md](docs/configuration.md) | Every config key and secret, with defaults |
| [docs/install.md](docs/install.md) | Discord bot setup, keys, native and Docker install, the `adrian` command, updates, backups, uninstall |
| [docs/pc-app.md](docs/pc-app.md) | The Windows PC app: turning it on, getting or building it, pairing, settings |
| [docs/satellite.md](docs/satellite.md) | The PC connection protocol (WebSocket messages) |
| [docs/security.md](docs/security.md) | Threat model and protections |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common problems and fixes |
| [docs/development.md](docs/development.md) | Building, tests, container tests, benches, release bundles |
| [docs/roadmap.md](docs/roadmap.md) | Future plans, open items, known limitations |
| [docs/decisions.md](docs/decisions.md) | Important design decisions and why |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability |

The PC app's internals and the PC actions are documented in [the main A.D.R.I.A.N. repository](https://github.com/Riqqqque/A.D.R.I.A.N).

## License

[MIT](LICENSE)
