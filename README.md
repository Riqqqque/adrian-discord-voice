# A.D.R.I.A.N. — Discord voice assistant

**A**dvanced **D**igital **R**easoning & **I**ntelligence **A**ssistant **N**etwork, the voice-chat module.

A self-hosted voice assistant that sits in a Discord voice channel with you and your friends. Say **"Hey Adrian"** and ask anything: it answers out loud, plays music, sets timers, runs party games, checks your game servers and media server, and remembers people. Speech recognition and the built-in voices run on your own machine; only the transcribed question goes to the language model you choose.

This is one module of the A.D.R.I.A.N. household assistant suite. Every module follows the same rules: self-hosted, installable by anyone with one script, private by default, read-only toward your other services unless you explicitly allow more, and spending capped.

---

## What it can do

**Conversation**
- Wake with "Hey Adrian", "Adrian, …", or just "Adrian?" (it answers "Yes?" and listens). Follow-up questions within a few seconds don't need the name.
- Talks like a person in the call: short, specific answers, reactions, no assistant filler. Knows who is in the call and what was said recently, and can refer to it.
- Handles a busy call: one answer at a time with a short queue, ignores game chatter and side conversations, and lets the person being answered interrupt.
- Stops instantly on "stop", "shut up", "never mind" (and other languages). Everyday words like "done" or "quiet" only count from the person it's answering or when said with its name.
- Everyday phrases are handled locally with no model call: thanks, bye, repeat that, louder/quieter, faster/slower, what time is it.
- Five languages: English, Spanish, Chinese, Japanese and Vietnamese. It answers in the language you speak.
- Remembers people: "remember that I'm vegetarian", and it also picks up facts on its own. Each person's notes are private to them.

**Text chat**
- @mention it in any channel it can see, reply to one of its messages, or DM it, and it answers in text with the same brain, tools and memory. Replies can never ping @everyone, roles or people.
- Optional, with Discord's Message Content intent: it reads the channel's recent messages for context, and you can keep talking for a few minutes without @mentioning it again (it stays out of side talk).
- Knows the server: who's online and what they're playing, who's in which call, members, roles and channels (only what the asker can see). Tags people when asked, and passes messages on: "tell Sam dinner's ready" sends Sam a DM from you.

**Music** (YouTube Music through yt-dlp, with your Plex music library as a backup)
- "Play Blinding Lights", "play the whole Graduation album", "put on something for a late night drive", "play a playlist like that last song", "play the newest Joe Rogan episode", "play rain sounds".
- Queue ("play Sicko Mode next"), skip, pause, resume, shuffle, "what's playing?", "turn it down".
- "Play that link I just sent": YouTube, SoundCloud, Bandcamp and Spotify links pasted in chat (Spotify ones are found on YouTube).
- Autoplay keeps similar songs coming when the queue runs out (YouTube Music radio), without repeats.
- Music ducks under the voice whenever someone talks to it.

**Sounds**
- "Make an airhorn sound", "give me a drum roll", "what does a cow sound like?": it finds a short sound effect and plays it in the call (up to 15 seconds, over any music).

**Tools**
- Timers and reminders ("remind me in 20 minutes to check the oven"); announced in the call, or by DM if you left.
- Web search for anything recent (optional, Tavily).
- Party games: trivia, dice, coin flips.
- Minecraft server status: who's online, player counts.
- Plex, Sonarr and Radarr, read-only: what's new, is a movie on Plex, what's downloading, upcoming episodes.

**Voice**
- 50+ built-in voices (Kokoro, runs locally), plus a Vietnamese voice (Piper).
- Optional cloud voice for English (Speechify Simba 3.2) with a monthly character cap; it falls back to the local voice automatically.
- Loudness-matched speech (about −16 LUFS) so it never blasts or whispers.

**On your PC** (optional Windows app, [docs/pc-app.md](docs/pc-app.md))
- She listens through your PC's mic ("Hey Adrian", or hold Ctrl+Alt+Space), answers through its speakers in the same voice, and shows a small animated window.
- Controls the PC: open apps and games, web pages, YouTube and Spotify searches, pause or skip what's playing in a named app, volume, lock, and sleep/restart/shut down after a spoken yes. Each PC decides what's allowed.
- In the tray it uses a few MB and stays out of the way of games. When you're in the bot's Discord call too, the call answers instead, so music plays for everyone.

**Running it**
- A web admin page with a setup wizard, live status (latency, spend), settings, keys and logs.
- An `adrian` command for everything else: status, logs, update, rollback, backup, doctor.
- Spend caps: per-person hourly limit, daily and monthly dollar caps. It stops calling the paid model at the cap.
- Owners (by Discord ID) can stop anyone and skip the line.
- `/join` and `/leave` slash commands bring it to whatever voice channel you're in.

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Linux x86_64 with systemd and glibc (Ubuntu 24.04 and Debian 12 are tested) | Ubuntu 24.04 |
| CPU | 4 cores | 8 threads, recent desktop or server CPU |
| Memory | 3 GB free (about 1.5 GB used in English, up to about 3.5 GB with every language voice loaded) | 8 GB+ |
| Disk | 3 GB free (models are about 1.5 GB) | |
| Other | `ffmpeg` for music (`sudo apt install ffmpeg`) | |

You also need:
- A Discord account and a server where you can add a bot.
- A language-model API key. Claude Haiku 5.5 is the recommended one (pay as you go, a fraction of a cent per answer). Groq has a free tier, and any OpenAI-compatible endpoint, including a local one, works too.

Docker is supported as an alternative to the native install (see [docs/install.md](docs/install.md#docker)).

## Install

The full walkthrough, including creating the Discord bot and getting each key, is in **[docs/install.md](docs/install.md)**. The short version:

```bash
# 1. Download a release bundle and its checksum (Releases page of this repo)
VER=0.13.4
curl -LO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz
curl -LO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz.sha256
sha256sum -c adrian-voice-$VER-linux-x64.tar.gz.sha256

# 2. Unpack the installer and run it
mkdir adrian-$VER && tar -xzf adrian-voice-$VER-linux-x64.tar.gz -C adrian-$VER
sudo adrian-$VER/packaging/install.sh --bundle adrian-voice-$VER-linux-x64.tar.gz

# 3. Open the admin page it prints (http://127.0.0.1:8790), enter the setup code, and follow the wizard
```

The installer downloads a pinned Node.js runtime and the speech models (checked against SHA-256), creates a locked-down `adrian` system user and a systemd service, and prints a one-time setup code. The wizard then walks you through the Discord token, the server and channel, the language model, search, the voice and spend limits.

Building the bundle yourself from this repo: see [docs/development.md](docs/development.md#building-a-release-bundle).

## Using it

Talk in the voice channel it's in:

| Say | What happens |
|---|---|
| "Hey Adrian, what's the capital of Australia?" | It answers out loud. |
| "Adrian?" … "how long do I boil an egg?" | "Yes?", then it answers. |
| "Hey Adrian, stop" / "shut up" | Stops talking at once. |
| "Hey Adrian, play something chill" | Picks a matching playlist and starts it. |
| "Hey Adrian, skip" / "pause" / "what's playing?" | Music controls. |
| "Hey Adrian, set a timer for 10 minutes" | Timer, announced in the call. |
| "Hey Adrian, is the server up?" | Checks your Minecraft servers. |
| "Hey Adrian, what's new on Plex?" | Recently added movies and shows. |
| "Hey Adrian, remember my birthday is May 3rd" | Saved to your private notes. |
| "Hey Adrian, let's play trivia" | Starts a round for everyone in the call. |

More in [docs/usage.md](docs/usage.md).

Run `adrian` on the server for management:

```bash
adrian status          # service state, health, admin page address
sudo adrian logs -f    # live log (keys are redacted)
sudo adrian doctor     # full diagnostics
sudo adrian update adrian-voice-<new>-linux-x64.tar.gz   # rolls back by itself if it doesn't come up
```

All commands: [docs/install.md#the-adrian-command](docs/install.md#the-adrian-command).

## Configuration

Most settings are in the admin page. Everything else is one command away, for example:

```bash
sudo adrian config owners '["123456789012345678"]'
sudo adrian config music.autoplay false
sudo adrian config mature off
sudo adrian restart
```

Every setting, with its default, is listed in **[docs/configuration.md](docs/configuration.md)**.

## Privacy and security

- **Stays on your machine:** speech recognition and the built-in voices. Audio is never stored or uploaded.
- **Leaves your machine:** the transcribed question and recent conversation go to your language model, which also writes the short per-person memory notes. Web searches go to Tavily if enabled. English replies go to Speechify if you turn on the cloud voice.
- **Keys:** kept in `/etc/adrian/secrets.env` (mode 0600). The admin page can set keys but never shows them, and each setting can only use a key meant for its own job.
- **The service:** runs as an unprivileged user under strict systemd sandboxing. The admin page is loopback-only by default, with argon2id passwords, CSRF protection, rate limiting, a strict CSP and a DNS-rebinding guard.
- **Other services:** Plex, Sonarr, Radarr and the game-server checks are read-only.

Details and how to report a problem: [docs/security.md](docs/security.md).

## Documentation

- [docs/install.md](docs/install.md): Discord bot setup, keys, native and Docker install, updates, backups, uninstall
- [docs/usage.md](docs/usage.md): everything you can say to it, owners, languages, music, mature mode
- [docs/pc-app.md](docs/pc-app.md): the Windows PC app: turning it on, building, installing, pairing
- [docs/configuration.md](docs/configuration.md): every setting and secret
- [docs/architecture.md](docs/architecture.md): how the voice pipeline works
- [docs/security.md](docs/security.md): threat model and protections
- [docs/troubleshooting.md](docs/troubleshooting.md): common problems
- [docs/development.md](docs/development.md): building, tests, benchmarks

## License

[MIT](LICENSE) © 2026 Rique
