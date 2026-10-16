# Installing A.D.R.I.A.N. (Discord voice)

This guide takes you from nothing to a bot talking in your voice channel. Plan on about 20 minutes, most of it creating the Discord bot and getting an API key.

- [1. Create the Discord bot](#1-create-the-discord-bot)
- [2. Get a language-model key](#2-get-a-language-model-key)
- [3. Optional keys](#3-optional-keys)
- [4. Install (native)](#4-install-native)
- [5. Run the setup wizard](#5-run-the-setup-wizard)
- [6. Invite the bot and test it](#6-invite-the-bot-and-test-it)
- [Docker](#docker)
- [The `adrian` command](#the-adrian-command)
- [Updating, rolling back, backups](#updating-rolling-back-backups)
- [Uninstalling](#uninstalling)

---

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it (for example `A.D.R.I.A.N.`).
2. Open **Bot** in the left menu:
   - Click **Reset Token** and copy the token. You'll paste it into the setup wizard. **Never share it**: anyone with the token controls the bot.
   - Turn **Public Bot** off, so only you can add it to servers. (Turn it on only while a friend adds it to their server, then off again.)
   - No privileged intents are needed: leave Presence, Server Members and Message Content off. The bot only uses voice states.
3. Note your server's ID and the voice channel's ID. Turn on **Developer Mode** in Discord (User Settings → Advanced), then right-click the server or channel → **Copy ID**. The wizard also lets you pick them from a list, so this is optional.

The wizard builds the invite link for you once the token is in. It asks only for **View Channel, Connect, Speak and Use Voice Activity**, plus the `/join` and `/leave` slash commands.

## 2. Get a language-model key

The bot needs one language model. Pick one:

| Provider | Model | Cost | Get a key |
|---|---|---|---|
| **Anthropic (recommended)** | Claude Haiku 5.5 | about $0.10 per million input tokens and $0.50 per million output tokens, roughly $0.0002 to $0.0005 per spoken answer; prompt caching cuts input cost by about 75% | [console.anthropic.com](https://console.anthropic.com) → API Keys. A claude.ai chat subscription does **not** include API use. |
| Groq | gpt-oss-120b | free tier (8,000 tokens a minute, 200,000 a day), paid beyond that | [console.groq.com](https://console.groq.com) → API Keys |
| Google | Gemini 3.1 Flash-Lite | free tier is slow and rate-limited | [aistudio.google.com](https://aistudio.google.com) → Get API key |
| Anything OpenAI-compatible | your choice | | Any `/v1/chat/completions` server works, including a local one (Ollama, llama.cpp, vLLM). Set it with `adrian config` (see [configuration](configuration.md#language-model)). |

A good setup is Claude as the main model and Groq's free tier as the fallback for outages. The wizard offers that.

## 3. Optional keys

| Key | What it adds | Where |
|---|---|---|
| `TAVILY_API_KEY` | Web search for news, scores, prices and anything recent (free tier: 1,000 searches a month) | [tavily.com](https://tavily.com) |
| `SPEECHIFY_API_KEY` | A more natural cloud voice for English (Simba 3.2). Capped per month, then it falls back to the local voice. | [platform.speechify.ai](https://platform.speechify.ai) |
| `PLEX_TOKEN` | "What's new on Plex", "is X on Plex", and Plex music as the backup music source | [Finding your Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) |
| `SONARR_API_KEY`, `RADARR_API_KEY` | "What's downloading", "what's coming up" | Sonarr/Radarr → Settings → General → API Key |

You can add any of these later from the admin page (Keys tab) or with `sudo adrian secret set NAME`.

## 4. Install (native)

On the Linux machine that will run the bot (x86_64, systemd; Ubuntu 24.04 or Debian 12 recommended):

```bash
# Tools the installer uses, and ffmpeg for music
sudo apt install -y curl xz-utils bzip2 iproute2 ffmpeg

# Download the release bundle and its checksum from this repo's Releases page
VER=0.13.1
curl -LO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz
curl -LO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz.sha256
sha256sum -c adrian-voice-$VER-linux-x64.tar.gz.sha256

# Unpack the installer and run it
mkdir adrian-$VER && tar -xzf adrian-voice-$VER-linux-x64.tar.gz -C adrian-$VER
sudo adrian-$VER/packaging/install.sh --bundle adrian-voice-$VER-linux-x64.tar.gz
```

Installer options:

| Option | Meaning |
|---|---|
| `--yes` | Don't ask questions; use the recommended choices |
| `--port N` | Admin page port (default: the first free one from 8790 to 8799) |
| `--lan` | Let other machines on your network reach the admin page (default: this machine only) |
| `--no-start` | Install but don't start the service |
| `--uninstall [--keep-data]` | Remove everything the installer added |

What it does:
- Checks the system (x86_64, systemd, glibc, 3 GB free disk, memory, ffmpeg).
- Downloads a pinned Node.js 22 runtime and the speech models, about 1.5 GB in total, each checked against its SHA-256. To reuse already-downloaded files, set `ADRIAN_DOWNLOAD_CACHE=/path`.
- Creates:
  - a system user `adrian` (no login)
  - `/opt/adrian` (the app)
  - `/etc/adrian` (`config.json`, and `secrets.env`, mode 0600)
  - `/var/lib/adrian` (state and models)
  - the `adrian-voice` systemd service
  - the `adrian` command
- Starts the service and prints the admin page address and a **one-time setup code** (valid for 60 minutes; `sudo adrian setup-code --new` makes another).

The admin page listens on `127.0.0.1` only. To open it from another computer, use an SSH tunnel:

```bash
ssh -L 8790:127.0.0.1:8790 you@your-server
# then open http://127.0.0.1:8790 on your computer
```

Or install with `--lan` and open `http://<server-ip>:8790`. If you reach it through a host name (`http://homeserver.local:8790`) rather than an IP, add that name to `server.allowedHosts`: `sudo adrian config server.allowedHosts '["homeserver.local"]'`. This blocks DNS-rebinding attacks.

## 5. Run the setup wizard

Open the admin page, enter the setup code, and create the admin account (the password is stored as argon2id). The wizard then goes through:

1. **Check**: hardware, models, and what leaves your machine.
2. **Discord**: paste the bot token. It's verified, and you get the invite link. Then pick the server and the voice channel the bot lives in.
3. **Language model**: pick a main model and an optional fallback. Each key is tested with a real request before it's saved, and you see the answer speed and an estimated cost per answer.
4. **Search**: optional Tavily key.
5. **Voice**: listen to voices and pick one and a speed.
6. **Limits**: per-person requests per hour, and daily and monthly spend caps in USD.
7. **Finish**: the bot starts and joins the channel.

Things not in the wizard (owners, music, cloud voice, media servers, game servers, mature mode, identity) are set with `adrian config`. See [configuration.md](configuration.md).

## 6. Invite the bot and test it

1. Open the invite link from the wizard and add the bot to your server.
2. Make sure the bot's role can **View**, **Connect** and **Speak** in the voice channel. Check per-channel permission overrides too.
3. Join the channel and say **"Hey Adrian, what time is it?"**

If nothing happens, see [troubleshooting.md](troubleshooting.md).

Make yourself an owner, so you can stop anyone's answer and skip the line:

```bash
sudo adrian config owners '["YOUR_DISCORD_USER_ID"]'
sudo adrian restart
```

(The account that owns the Discord application is always an owner.)

---

## Docker

An alternative to the native install, for machines that already run everything in containers. You build the image from a release bundle:

```bash
# from a checkout of this repo, with the bundle in the current directory
packaging/docker/build.sh adrian-voice-0.13.1-linux-x64.tar.gz
cd packaging/docker
ADRIAN_VERSION=0.13.1 docker compose up -d
docker compose exec adrian node dist/cli/tool.js setup-code
```

- A one-time `models` job downloads the speech models into a volume.
- The admin page is published on `127.0.0.1:8790` only.
- The container runs as an unprivileged user, with a read-only root filesystem and no Linux capabilities.

Setting a key in Docker:

```bash
printf %s 'the-key-value' | docker compose exec -T adrian node dist/cli/tool.js secret-set ANTHROPIC_API_KEY
docker compose restart adrian
```

Updating in Docker: build the new image, set `ADRIAN_VERSION` to the new version, and run `docker compose up -d`. Config and state live in volumes and carry over. `update`, `rollback`, `backup` and `doctor` are only in the native `adrian` command.

## The `adrian` command

Most commands need `sudo`.

| Command | What it does |
|---|---|
| `adrian status` | Service state, health, admin page address |
| `adrian logs [-f]` | Recent log, or follow it (keys are redacted) |
| `adrian start` / `stop` / `restart` | Control the service |
| `adrian url` | Admin page address |
| `adrian setup-code [--new]` | One-time code for creating the admin account |
| `adrian reset-admin` | Forgot the password: removes the admin account; then use `setup-code` |
| `adrian secret set NAME` | Set a key (hidden prompt, or piped on stdin) |
| `adrian secret delete NAME` / `adrian secret list` | Remove a key / list key names (never values) |
| `adrian check` | What's still missing before the bot can start |
| `adrian voice [NAME [SPEED]]` | Show or change the voice (speed 0.7 to 1.4) |
| `adrian config KEY [VALUE]` | Show or change a setting by dotted path (validated; file paths can't be changed this way) |
| `adrian doctor` | Full diagnostics: service, permissions, models, ffmpeg, yt-dlp, config |
| `adrian backup [FILE]` | Config, keys and state (not the models) to a `.tar.gz`. **It contains your keys; keep it private.** |
| `adrian restore FILE` | Restore a backup |
| `adrian update BUNDLE` | Install a new version (rolls back by itself if it isn't healthy within 30 s; keeps 3 versions) |
| `adrian rollback` | Switch back to the previous version |
| `adrian uninstall [--keep-data]` | Remove A.D.R.I.A.N. |
| `adrian version` | Installed version |

## Updating, rolling back, backups

```bash
VER=0.13.1   # the new version
curl -LO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz
curl -LO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz.sha256
sudo adrian update adrian-voice-$VER-linux-x64.tar.gz
```

The update:
- verifies the checksum when the `.sha256` file is next to the bundle;
- downloads any new models;
- updates the service file;
- switches over, and rolls back by itself if the bot isn't healthy within 30 seconds.

`sudo adrian rollback` goes back one version at any time. After an update or restart, the bot rejoins its home channel. Use `/join` to bring it back to another one.

Back up before big changes: `sudo adrian backup ~/adrian-backup.tar.gz`.

**Music breaking:** YouTube changes things every few weeks, and the pinned yt-dlp then stops finding songs. Updating to a newer release (which pins a newer yt-dlp) fixes it.

## Uninstalling

```bash
sudo adrian uninstall              # removes everything, including config, keys and state
sudo adrian uninstall --keep-data  # keeps /etc/adrian and /var/lib/adrian
```

Remove the bot from your Discord server separately (Server Settings → Integrations).
