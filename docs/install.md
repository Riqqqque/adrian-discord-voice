# Installing A.D.R.I.A.N. (Discord voice)

This guide takes you from nothing to a bot talking in your voice channel. Plan on about 20 minutes, most of it creating the Discord bot and getting an API key. Every setting mentioned here is described in [configuration.md](configuration.md); what it costs to run is in [costs.md](costs.md).

- [Requirements](#requirements)
- [1. Create the Discord bot](#1-create-the-discord-bot)
- [2. Get a language-model key](#2-get-a-language-model-key)
- [3. Optional keys](#3-optional-keys)
- [4. Install (native)](#4-install-native)
- [5. Run the setup wizard](#5-run-the-setup-wizard)
- [6. Invite the bot and test it](#6-invite-the-bot-and-test-it)
- [7. Optional: the PC app](#7-optional-the-pc-app)
- [Docker](#docker)
- [The `adrian` command](#the-adrian-command)
- [Updating, rolling back, backups](#updating-rolling-back-backups)
- [Where everything is](#where-everything-is)
- [Uninstalling](#uninstalling)

---

## Requirements

The installer checks all of these before it changes anything. It lists every problem at once, each with its fix, and stops (or only warns). To run just the checks: `bash packaging/install.sh --check` from an unpacked bundle (no sudo needed).

| What | Needed | If not |
|---|---|---|
| CPU | x86_64 (no ARM build) | stops |
| C library | glibc 2.28 or newer (Debian, Ubuntu, Fedora and similar; not Alpine/musl) | stops |
| Init | systemd running | stops (on WSL it prints the two `wsl.conf` lines that turn systemd on; in a container, use [Docker](#docker)) |
| Commands | `tar gzip xz bzip2 sha256sum curl ss useradd runuser systemd-analyze` | stops, naming every missing one as the `apt` or `dnf` packages to install (`get.sh` installs them for you, after asking) |
| Disk | about 1 GB free under `/opt` and 2 GB under `/var/lib` (3 GB together when both are on one disk) | stops |
| Internet | the hosts the downloads come from (nodejs.org, github.com, huggingface.co), unless those files are already downloaded | stops, naming the host (behind a proxy: `sudo https_proxy=http://PROXY:PORT bash ...`) |
| Memory | 4 GB | warns only |
| `ffmpeg` | for music | warns; music stays off until it's installed |
| Ports | one free port from 8790 to 8799 for the admin page (or `--port N`; a `--port` another program holds is refused) | stops |
| Version | not older than the version already installed | stops (use `adrian rollback`, or `--allow-downgrade`) |

Ubuntu 24.04 and Debian 12 are the recommended systems. The wizard's Check step also warns under 4 CPU threads and under 2 GB of free disk.

**Memory.** The service may use up to `MemoryHigh=4G` (the kernel throttles it above that) and `MemoryMax=5G` (hard limit). Whisper and the other languages' voices load the first time someone speaks a language other than English, not at start; a comment in `src/app/stack.ts` puts them at about 1.3 GB together. The installer's warning gives about 3.5 GB with the language voices on and about 1.5 GB with them off. To keep them out for good: `sudo adrian config languages false`.

With the cloud voice on (`cloudVoice`, Speechify), the local English voice (Kokoro, about 0.5 GB) isn't loaded at start either: it loads the first time the cloud voice can't speak (an outage, a timeout, a spent month) and then stays. In a maintainer measurement on Windows that took the bot from about 1.59 GB to about 1.10 GB after start; on a Linux server expect a similar drop (not measured there). The first stand-in sentence after a start then waits a few seconds for the load, once.

On a first start, a bot on a machine that is short of memory waits instead of loading its speech models (which would get it killed by an out-of-memory guard such as earlyoom): it retries after 30 seconds, doubling to 5 minutes, and after 15 minutes it loads anyway. Until then the admin page and `adrian status` show it as failed, with the reason.

**CPU.** Speech recognition and the local voice run on the CPU. The service is limited to 4 cores (`CPUQuota=400%`) at low priority (`Nice=5`, `CPUWeight=50`), so it shares a machine well. No GPU is used.

**Network.** Nothing needs to reach the server from outside. The bot connects out to Discord, your language-model provider and any optional services you add. The admin page listens on `127.0.0.1` only unless you install with `--lan`. The PC app's endpoint (port 8791) is closed until you turn it on.

## 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it (for example `A.D.R.I.A.N.`).
2. Open **Bot** in the left menu:
   - Click **Reset Token** and copy the token. You'll paste it into the setup wizard. **Never share it**: anyone with the token controls the bot.
   - Turn **Public Bot** off, so only you can add it to servers. (Turn it on only while a friend adds it to their server, then off again.)
   - The three **Privileged Gateway Intents** are optional, and everything else works with them off. **Server Members** gives it the full member list and **Presence** lets it see who's online and what they're playing or listening to (for questions like "who's online?"). **Message Content** is for text chat: turn it on if you want the bot to read channels for context and carry on text conversations without a new @mention each time (see [Text chat](usage.md#text-chat)). Bots in fewer than 100 servers can switch them on freely; past that Discord asks for verification.
3. Note your server's ID and the voice channel's ID. Turn on **Developer Mode** in Discord (User Settings → Advanced), then right-click the server or channel → **Copy ID**. The wizard also lets you pick them from a list, so this is optional.

The wizard builds the invite link for you once the token is in. It asks only for **View Channel, Connect, Speak, Use Voice Activity, Send Messages (and in threads) and Read Message History**, plus its slash commands (`/join`, `/leave`, `/play`, `/music`, `/alarm`). With Message Content off, the bot reads only messages that @mention it, reply to it, or DM it. If you added the bot before text chat existed, open the invite link again to give it the message permissions.

## 2. Get a language-model key

The bot needs one language model. Pick one; the wizard has a preset for each of the first three and tests the key with a real request before saving it. Prices are the presets' (USD per million tokens, marked in `src/web/checks.ts` as verified 2026-10-14/15).

| Provider | Model | Price in / cached in / out | Notes | Get a key |
|---|---|---|---|---|
| **Anthropic (recommended)** | `claude-haiku-5-5` | 0.10 / 0.01 / 0.50 | First words in about a second, reliable with tools. Prompt caching bills most of each request at the cached price. A claude.ai chat subscription does **not** include API use | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| Groq | `openai/gpt-oss-120b` | 0.15 / - / 0.60 | Fast; has a free tier (8,000 tokens a minute), paid beyond that. A good fallback | [console.groq.com](https://console.groq.com) → API Keys |
| Google | `gemini-3.1-flash-lite` | 0.25 / 0.025 / 1.50 | The free tier is slow and rate-limited, and Google may use free-tier prompts | [aistudio.google.com](https://aistudio.google.com) → Get API key |
| Anything OpenAI-compatible | your choice | you enter it | Any `/v1/chat/completions` server works, including a local one (Ollama, llama.cpp, vLLM). Set it with `adrian config` (see [configuration](configuration.md#language-model)) | |

The wizard's estimate per answer assumes 900 input and 60 output tokens; on Haiku that is about $0.00012. Real answers that use tools cost more; [costs.md](costs.md) has measured numbers. The prices matter: the daily and monthly dollar caps (default $1 and $10) can only count what they know.

A good setup is Claude as the main model and Groq's free tier as the fallback for outages. The wizard offers that.

## 3. Optional keys

| Key | What it adds | Where |
|---|---|---|
| `TAVILY_API_KEY` | Web search for news, scores, prices and anything recent; also finds misheard song titles. Tavily has a free tier | [tavily.com](https://tavily.com) |
| `SPEECHIFY_API_KEY` | A more natural cloud voice for English (Speechify `simba-3.5`, voice `sabrina`). Capped per month, then it falls back to the local voice. Turned on with `adrian config` after install ([Cloud voice](configuration.md#cloud-voice-cloudvoice-optional-block)) | [platform.speechify.ai](https://platform.speechify.ai) |
| `GROQ_API_KEY` | Besides the model fallback: the optional cloud second listen (`cloudStt`) | [console.groq.com](https://console.groq.com) |
| `PLEX_TOKEN` | "What's new on Plex", "is X on Plex", and Plex music as the backup music source | [Finding your Plex token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) |
| `SONARR_API_KEY`, `RADARR_API_KEY` | "What's downloading", "what's coming up" | Sonarr/Radarr → Settings → General → API Key |
| `STEAM_API_KEY` | Steam friends online ([Steam](configuration.md#steam)) | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) |
| `HELIX_TOKEN` | Start, stop and whitelist Minecraft servers ([Helix](configuration.md#minecraft-server-control-helix)) | your Helix dashboard |
| `CALENDAR_ICS_URL` | Read-only calendar ([calendars](configuration.md#weather-calendars-news-and-the-morning-briefing)) | your calendar's private iCal address |
| `HOME_ASSISTANT_TOKEN` | Home control through Home Assistant's MCP server ([Home control](configuration.md#home-control-mcp-home-assistant)) | your Home Assistant user profile |

You can add these later with `sudo adrian secret set NAME`. The admin page's Keys tab also takes most of them, but not `CALENDAR_ICS_URL` or `HOME_ASSISTANT_TOKEN` (or any other name it doesn't list) until they have been set once.

## 4. Install (native)

On the Linux machine that will run the bot:

```bash
curl -fsSLO https://raw.githubusercontent.com/Riqqqque/adrian-discord-voice/main/packaging/get.sh
sudo bash get.sh
```

`get.sh` installs the few system packages it needs (it asks first), finds the newest release, downloads it with its checksum, checks it, and runs the installer inside it. If something isn't ready (disk space, no internet, an unsupported computer), it lists everything to fix at once and changes nothing: fix it and run the same command again. Downloads that already finished are kept.

| `get.sh` option | Meaning |
|---|---|
| `--version X.Y.Z` | Install that release instead of the newest |
| `--yes`, `-y` | Don't ask questions (installs missing packages too) |
| `--no-packages` | Never install system packages; only say which are missing |
| `--reinstall` | Run the installer even if A.D.R.I.A.N. is already installed (repairs it) |
| anything else | Passed to the installer, for example `sudo bash get.sh --lan` |

On a machine that already has A.D.R.I.A.N., `get.sh` runs `adrian update` instead. It refuses ARM computers and machines without systemd before it installs or downloads anything. When GitHub's API limit is reached (60 requests an hour per address), it finds the newest release through the Releases page instead.

### Install by hand

The same steps without `get.sh`:

```bash
# Tools the installer uses, and ffmpeg for music
sudo apt install -y curl xz-utils bzip2 iproute2 ffmpeg

# Find the newest release (to install a particular version, set VER=x.y.z yourself instead)
VER=$(curl -fsSL https://api.github.com/repos/Riqqqque/adrian-discord-voice/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
echo "Newest release: ${VER:?could not read it from GitHub, set VER by hand from the Releases page}"

# Download the release bundle and its checksum from this repo's Releases page
curl -fLO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz
curl -fLO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz.sha256
sha256sum -c adrian-voice-$VER-linux-x64.tar.gz.sha256

# Unpack the installer and run it
mkdir adrian-$VER && tar -xzf adrian-voice-$VER-linux-x64.tar.gz -C adrian-$VER
sudo adrian-$VER/packaging/install.sh --bundle adrian-voice-$VER-linux-x64.tar.gz
```

The installer checks the bundle against its `.sha256` again when that file sits next to the bundle, as it does here, before it changes anything (without one it warns; `get.sh` refuses a release without one). The bundle is about 40 MB (v0.17.1: 41,481,428 bytes).

Installer options (`install.sh --help` prints them):

| Option | Meaning |
|---|---|
| `--bundle FILE` | The release bundle (required, except with `--check`) |
| `--check` | Only check this machine and say what to fix; change nothing (no root needed) |
| `--yes`, `-y` | Don't ask questions; use the recommended choices |
| `--port N` | Admin page port (default: the one it already has, else the first free one from 8790 to 8799) |
| `--lan` | Let other machines on your network reach the admin page (default: this machine only). It prints a warning: the login then goes over plain HTTP unless you add `server.tls` |
| `--no-lan` | This machine only again, after an install with `--lan` |
| `--no-start` | Install but don't start the service |
| `--allow-downgrade` | Install a bundle older than the version already installed (refused otherwise) |
| `--uninstall [--keep-data]` | Remove everything the installer added (`--keep-data` keeps `/etc/adrian` and `/var/lib/adrian`) |
| `--mode native`, `--profile recommended` | The only values accepted so far (local speech, cloud language model) |

Running the installer again is safe. It keeps your config, keys, port and LAN setting, and restarts the service on the new files. After `--uninstall --keep-data`, a new install reads the port and LAN setting back from the kept config.

What it does:

1. Runs the checks in [Requirements](#requirements), and changes nothing if any fail.
2. Creates a system user and group `adrian` (no login, home `/var/lib/adrian`).
3. Downloads a pinned Node.js runtime (22.23.4) and checks it runs.
4. Unpacks the bundle to `/opt/adrian/releases/<version>` (owned by root) and points `/opt/adrian/current` at it.
5. Downloads the speech models and yt-dlp into `/var/lib/adrian/models`: Silero VAD, Parakeet TDT 0.6B v3 (speech recognition), Kokoro (local voice), Whisper small (other languages), a Piper Vietnamese voice, Smart Turn v3.2 (end of turn at a PC) and yt-dlp 2026.08.19. Every file is pinned by URL and SHA-256 in `packaging/downloads.sh` and fetched over HTTPS; a mismatch stops the install. Downloads are kept under `/opt/adrian/.install-*` while they run (not `/tmp`), and a run that was cut off is cleaned up by the next one. If a download stops halfway, run the same command again: every file that finished is kept. To reuse already-downloaded files, set `ADRIAN_DOWNLOAD_CACHE=/path`.
6. Writes `/etc/adrian/config.json` if there isn't one (`server.host`, `server.port`, `timezone` from the system, `secretsFile`). On a re-run it keeps the file, including the admin page's address and port, unless you pass `--port`, `--lan` or `--no-lan`. Creates `/etc/adrian/secrets.env` (mode 0600, owner `adrian`).
7. Installs the `adrian` command (`/usr/local/bin/adrian`) and the `adrian-voice` systemd service, checks the unit with `systemd-analyze verify`, and records everything it created in `/var/lib/adrian/install-manifest.json`.
8. Unless `--no-start`: enables and (re)starts the service and waits up to 60 seconds for it to answer. Only the bot's own answer counts, not another program on the same port; an answer that says the bot is failing (a bad token, say) counts as up, with a note to open the page or run `sudo adrian doctor`. If it doesn't answer, it prints the last 30 log lines and names a port that was taken or memory that ran out.
9. Prints the admin page address, an SSH tunnel hint (with your user name filled in) and a **one-time setup code** (valid for 60 minutes; `sudo adrian setup-code --new` makes another).

The admin page listens on `127.0.0.1` only. To open it from another computer, use an SSH tunnel:

```bash
ssh -L 8790:127.0.0.1:8790 you@your-server
# then open http://127.0.0.1:8790 on your computer
```

Or install with `--lan` and open `http://<server-ip>:8790`. If you reach it through a host name (`http://adrian.example.com:8790`) rather than an IP, add that name to `server.allowedHosts`; any other name gets HTTP 421, which blocks DNS-rebinding attacks. `adrian config` can't change `server.*`, so edit the file by hand: open it with `sudo nano /etc/adrian/config.json`, add `"allowedHosts": ["adrian.example.com"]` inside `"server"` (so it reads `"server": { "host": "0.0.0.0", "port": 8790, "allowedHosts": ["adrian.example.com"] },`), then run `sudo adrian restart`. For HTTPS, add `"tls": { "cert": "/path/cert.pem", "key": "/path/key.pem" }` there too.

## 5. Run the setup wizard

Open the admin page, enter the setup code, and create the admin account (password 10 to 256 characters, stored as argon2id). The wizard then goes through:

1. **Check**: CPU, memory, disk, Node version, which models are present, and what leaves your machine.
2. **Discord**: paste the bot token. It's checked with Discord and saved only if Discord accepts it, and you get the invite link. If you paste the Application ID, Public Key or Client Secret by mistake, it says which one it is and where the token is; `Bot ` in front and quotes around it are cleaned off. It also shows which privileged intents are on and what each adds (all optional). If the bot isn't in a server yet, open the invite link: the page notices by itself within a few seconds (it checks every 5 seconds for 10 minutes). Then pick the server and the voice channel the bot lives in. The wizard checks that the bot can **View**, **Connect** and **Speak** in that channel, worked out from its roles and the channel's overrides, and says what to change in Discord if not (it warns but lets you save).
3. **Language model**: pick a main model and an optional fallback. Each key is tested with a real request before it's saved, and you see the answer speed and an estimated cost per answer. A key for the wrong provider (a Groq key on Claude, say) is refused before it's sent anywhere, and the usual failures are named: an Anthropic account with no credit left (a claude.ai subscription doesn't cover the API), rate limits, a model that isn't available, an outage. A model set with `sudo adrian config` (a custom or local endpoint) shows as "Keep" and is left as it is.
4. **Search**: optional, and off unless you add a Tavily key, which is tested the same way.
5. **Voice**: listen to the local voices and pick one and a speed (0.8 to 1.2 on the slider; `sudo adrian voice NAME SPEED` takes 0.7 to 1.4).
6. **Limits**: time zone, questions per person per hour, and daily and monthly spend caps in USD (0 means no limit).
7. **Finish**: the bot restarts (about 20 seconds) and joins the channel. If it can't start, the page shows the error and a "What to do" line under it (a rejected token, a missing permission, a model that's missing, no network, and so on).

Settings changed later on the admin page apply after **Restart bot** on its Status tab. Everything not in the wizard (owners, music, cloud voice, media servers, game servers, mature mode, identity, PC app) is set with `sudo adrian config`; see [configuration.md](configuration.md).

## 6. Invite the bot and test it

1. Open the invite link from the wizard and add the bot to your server, if you haven't yet.
2. Join the channel and say **"Hey Adrian, what time is it?"**

The wizard already checked that the bot can View, Connect and Speak in the channel. If that changes later (a new role or channel override), the dashboard says so when it's the reason she isn't in voice.

If nothing happens, see [troubleshooting.md](troubleshooting.md). `sudo adrian check` lists anything still missing, and `sudo adrian doctor` checks the whole install.

Make yourself an owner, so you can stop anyone's answer and skip the line:

```bash
sudo adrian config owners '["YOUR_DISCORD_USER_ID"]'
sudo adrian restart
```

(The account that owns the Discord application is always an owner.)

## 7. Optional: the PC app

The Windows PC app lets her listen and answer at a desk, and do allowlisted things on that PC. It connects to this service over port 8791. Turn the endpoint on and pair a PC with:

```bash
sudo adrian config satellite.enabled true
sudo adrian restart
sudo adrian satellite add "Desk PC" YOUR_DISCORD_USER_ID   # prints the PC's token once
```

The full steps (firewall, the installer on the PC, settings) are in [pc-app.md](pc-app.md).

---

## Docker

An alternative to the native install, for machines that already run everything in containers. You build the image from a release bundle:

```bash
# From a checkout of this repo: find the newest release (or set VER=x.y.z yourself)
VER=$(curl -fsSL https://api.github.com/repos/Riqqqque/adrian-discord-voice/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
echo "Newest release: ${VER:?could not read it from GitHub, set VER by hand from the Releases page}"

# Download the bundle and its checksum (build.sh checks it)
curl -fLO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz
curl -fLO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz.sha256

# Build the images and start
packaging/docker/build.sh adrian-voice-$VER-linux-x64.tar.gz
cd packaging/docker
echo "ADRIAN_VERSION=$VER" > .env   # every docker compose command needs this; .env keeps it
docker compose up -d
docker compose exec adrian node dist/cli/tool.js setup-code   # the claim page shows this command too
```

- `build.sh` makes two images, `adrian-voice:<version>` (Ubuntu 24.04 with ffmpeg) and `adrian-voice-fetch:<version>`.
- A one-time `models` job downloads the speech models into a volume, checked against the same SHA-256 pins. The bot starts after it finishes.
- The admin page is published on `127.0.0.1:8790` only (`ADRIAN_PORT` in `.env` changes the host port). The time zone comes from `TZ` (default `UTC`).
- The container runs as an unprivileged user, with a read-only root filesystem, no Linux capabilities, `no-new-privileges`, 4 CPUs and a 4 GB memory limit.
- Data lives in the volumes `adrian_config`, `adrian_state` and `adrian_models`.
- Run `docker compose` from `packaging/docker`, where `.env` is.
- There's no `adrian` command in the container. Its Node helper does the same jobs as `docker compose exec adrian node dist/cli/tool.js COMMAND`, then `docker compose restart adrian`. The commands are `setup-code [--new]`, `check`, `secret-list`, `secret-delete NAME`, `reset-admin`, `voice [NAME [SPEED]]`, `config KEY [VALUE]`, `satellite-add NAME OWNER_ID`, `satellite-list` and `satellite-remove ID` (or the PC's name). `secret-set NAME` reads the value from stdin; see below.
- The PC app's port isn't published. To use the PC app, follow the Docker steps in [pc-app.md](pc-app.md#1-turn-it-on-in-the-service).

Setting a key in Docker:

```bash
printf %s 'the-key-value' | docker compose exec -T adrian node dist/cli/tool.js secret-set ANTHROPIC_API_KEY
docker compose restart adrian
```

Updating in Docker: download the new bundle, build the new image, set `ADRIAN_VERSION` in `.env` to the new version, and run `docker compose up -d`. Config and state live in volumes and carry over. `update`, `auto-update`, `rollback`, `backup` and `doctor` exist only in the native `adrian` command; to roll back, set the old `ADRIAN_VERSION` again.

## The dashboard

The admin page's Status tab shows, without reading logs:

- **Needs attention:** spending caps at 80% or reached, the cloud voice's monthly characters, Tavily searches near the free plan's 1,000, the voice connection down, PC links dropping, the main model falling back, answers failing, the cloud voice or Groq failing or rate limited, an unclean shutdown, low disk or memory, a failed or cut-off update, and a newer release.
- **Spending:** the language model against the daily and monthly caps, cost per answer, and what the dollar caps don't count: Speechify characters this month, Groq second listens and Tavily searches.
- **Answer speed:** median and 90th percentile from the end of speech to her first audio, over the last day and 7 days, in the call and at a PC, with the time each stage takes.
- **Reliability:** voice and PC link drops and how long each took to come back, restarts and why (a stop, an update, a crash, or no clean shutdown), and the latest errors with how often each happened.
- **This server:** free disk, available memory, her own memory, and whether an update is available.

The numbers come from her own log lines as they are written, are kept in `dashboard.json` in the state folder (so a restart or update keeps the week), and never leave the server. They hold no user IDs, PC names, addresses or words. The one outside request is the newest-release lookup on GitHub that `adrian update` also makes, done only while the page is open and at most every 6 hours.

## The `adrian` command

Every command except `logs`, `version` and `help` needs `sudo`.

| Command | What it does |
|---|---|
| `adrian status` | Service state, health, admin page address (the default command) |
| `adrian logs [-f]` | The last 200 log lines, or follow them (keys are redacted by the bot itself) |
| `adrian start` / `stop` / `restart` | Control the service; `start` and `restart` wait up to 60 seconds for it to be healthy |
| `adrian url` | Admin page address |
| `adrian setup-code [--new]` | One-time code for creating the admin account (refused once an admin exists) |
| `adrian reset-admin` | Forgot the password: removes the admin account, makes a new setup code and restarts |
| `adrian secret set NAME` | Set a key (hidden prompt, or piped on stdin; never on the command line) |
| `adrian secret delete NAME` / `adrian secret list` | Remove a key / list key names (never values) |
| `adrian check` | What's still missing before the bot can start |
| `adrian voice [NAME [SPEED]]` | Show or change the local voice (speed 0.7 to 1.4); restarts |
| `adrian config KEY [VALUE]` | Show or change a setting by dotted path, validated before saving. File paths, `server.*` and `allowedGuilds` can't be changed this way. See [configuration.md](configuration.md#where-settings-live-and-how-to-change-them) |
| `adrian satellite add NAME OWNER_ID` | Pair a PC for the Discord user `OWNER_ID`; prints its token (starts with `sat_`) once |
| `adrian satellite list` / `remove ID\|NAME` | List paired PCs / unpair one by ID or name (a restart drops it if it's connected) |
| `adrian doctor` | Full diagnostics: Node, service enabled and running, health (a failed start is explained in words, with what to do), an update under way or cut off, last failed update, `secrets.env` mode and owner, files the service can't read because they belong to root (with the `chown` that fixes it), models, yt-dlp, ffmpeg, config complete, free disk, service memory, whether discord.com and github.com can be reached, errors in the last 15 minutes |
| `adrian backup [FILE]` | Config, keys and state (not the models) to a `.tar.gz`, mode 0600. **It contains your keys; keep it private.** |
| `adrian restore FILE` | Restore a backup. Refuses archives with anything outside `etc/adrian` and `var/lib/adrian`, `..` paths or links, before it stops anything |
| `adrian update` | Install the newest release from GitHub (see below). At a terminal it runs in the background and the terminal follows along. `--check` only says whether there's one; `adrian update FILE.tar.gz` installs a bundle you downloaded |
| `adrian auto-update on\|off\|status` | Update by itself (see below) |
| `adrian rollback` | Switch back to the previous version |
| `adrian uninstall [--keep-data]` | Remove A.D.R.I.A.N. |
| `adrian version` | Installed version |
| `adrian help` | The command list |

## Updating, rolling back, backups

The easy way, once:

```bash
sudo adrian auto-update on
```

This installs a systemd timer, `adrian-update.timer`: 15 minutes after boot and then every hour (plus a random delay of up to 10 minutes) it runs `adrian update --auto`. That installs whatever is published as the latest release, as root, but only while she isn't busy. Busy means someone is in her voice call, music is playing (in the call or at a PC), or an alarm is ringing, snoozed or due within 5 minutes. It checks this before downloading and again just before switching, so an update never cuts anyone off. `sudo adrian auto-update status` shows the timer and the last checks (`journalctl -u adrian-update` has the rest), and `off` removes it. PC apps update themselves too (see [pc-app.md](pc-app.md)). [security.md](security.md#things-to-know) says what you're trusting.

Or update by hand whenever you like:

```bash
sudo adrian update            # the newest release
sudo adrian update --check    # only say whether there's a newer one
```

`sudo adrian update` started from a terminal runs in the background in its own session, so a dropped SSH connection can't stop it halfway. The terminal just follows its log (`/opt/adrian/update.log`), and Ctrl+C stops the watching, not the update. `sudo ADRIAN_DETACH=0 adrian update` runs it in the foreground the old way. Only one update runs at a time: while one is under way, the hourly auto-update skips (and logs it), a second `sudo adrian update` says to wait, `rollback` waits for it, and `status` and `doctor` say an update is under way. Updates need about 500 MB free under `/opt`: without it nothing changes, the timer waits, and a manual update says what to free.

If an update was cut off anyway (a power cut, a kill), a note in `/opt/adrian/update-in-progress` remains. The next `sudo adrian update`, `rollback` or hourly check finishes the job: it keeps a healthy new version, rolls an unhealthy one back under its own service file, or undoes an update cut off before the switch. `status` and `doctor` show it meanwhile.

Every update:

1. asks GitHub for the latest release (when GitHub's API limit is reached, it reads the release from the Releases page instead) and stops with "Up to date" if it isn't newer than what's installed;
2. downloads `adrian-voice-<version>-linux-x64.tar.gz` and checks it against its `.sha256` file (a mismatch stops it);
3. if the bot is running, asks the new code whether it can run your config (if it can't, the new release is deleted, nothing is switched, and the version is noted in `/opt/adrian/update-failed`, so auto-update leaves it alone for a day and `sudo adrian doctor` warns about it);
4. runs the new release's `packaging/upgrade-prep.sh`: new models, the new service file (the old one is kept as `/opt/adrian/adrian-voice.service.previous`), the auto-update units, and the release's Node.js runtime if it pins a new one. If that fails, the old service file goes back and nothing is switched;
5. switches `/opt/adrian/current` to the new release and restarts;
6. watches the new version, and rolls back by itself if it does worse than the old one;
7. on success, keeps the three newest releases and deletes older ones.

Doing worse means one of these, which is why an update takes a few minutes:

- it isn't healthy within 2 minutes;
- it came back in setup mode, when the old version was running;
- it hasn't rejoined a voice channel, when the old version was in one;
- any of that a minute later, with up to another minute to get back, or systemd had to restart it during that minute.

If the old version wasn't answering at all, any healthy answer will do, so you can always update your way out of a broken version.

An automatic rollback brings back the old release and its service file; new models and the new Node.js stay. Auto-update then leaves that version alone for 24 hours, and `sudo adrian doctor` warns about it. `sudo adrian update` by hand tries it right away. A Discord voice outage during that minute can roll back a good release: it gets another try the next day, or update by hand once the outage is over. Auto-update also skips its run (and logs why) while `config.json` can't be read, and does nothing when GitHub can't be reached.

No internet on the server? Download the bundle and its `.sha256` from the [Releases page](https://github.com/Riqqqque/adrian-discord-voice/releases) and run `sudo adrian update adrian-voice-VERSION-linux-x64.tar.gz` next to them. A local bundle is checked only when its `.sha256` file sits next to it, so keep the two together.

**Coming from 0.14.9 or older:** those versions' `adrian` can't download by itself yet. Update once the old way (download the bundle and `.sha256`, then `sudo adrian update FILE`); from then on `sudo adrian update` and auto-update work.

**Coming from 0.15.2 or older:** an update runs the `adrian` that's already installed, so new checks start with the update after the one that brings them. That first update still rolls back only if the bot isn't healthy within 30 seconds. In general, any change to the update steps first applies on the update after the one that ships it: running in the background, the lock, the disk check and the cut-off note protect updates from the release that brings them, not the update that installs it.

`sudo adrian rollback` goes back one version at any time. It switches only the release: the service file and models stay as they are (the old service file is in `/opt/adrian/adrian-voice.service.previous`). With auto-update on, the newest release comes back within about an hour, as soon as she isn't busy, so run `sudo adrian auto-update off` first and turn it on again when a fix is out. After an update or restart, the bot rejoins its home channel. Use `/join` to bring it back to another one.

Back up before big changes: `sudo adrian backup ~/adrian-backup.tar.gz`. A restart logs you out of the admin page (sessions are kept in memory only).

**Music breaking:** YouTube changes things every few weeks, and the pinned yt-dlp then stops finding songs. Updating to a newer release (which pins a newer yt-dlp) fixes it.

## Where everything is

| Path | What |
|---|---|
| `/etc/adrian/config.json` | Settings ([configuration.md](configuration.md)), owner `adrian`, mode 0640 |
| `/etc/adrian/secrets.env` | Keys, owner `adrian`, mode 0600 |
| `/var/lib/adrian/` | State: admin account, usage ledger, memory notes, reminders, alarms, music taste, paired PCs and so on |
| `/var/lib/adrian/models/` | Speech models and yt-dlp, owned by root (the service can read, not change them); not in backups |
| `/var/lib/adrian/install-manifest.json` | What the installer created |
| `/opt/adrian/releases/<version>/` | Installed releases (the newest three) |
| `/opt/adrian/current`, `/opt/adrian/previous` | The running release and the one `rollback` goes back to |
| `/opt/adrian/node` | The pinned Node.js runtime (one older runtime is kept) |
| `/opt/adrian/update-failed` | The last version an update had to undo (root's, so the service can't clear it) |
| `/opt/adrian/update.log`, `update.lock`, `update-in-progress` | The last manual update's log, the lock that keeps updates apart, and the note an update leaves while it runs |
| `/etc/systemd/system/adrian-voice.service` | The service: runs as `adrian`, can write only `/etc/adrian` and `/var/lib/adrian` |
| `/etc/systemd/system/adrian-update.{service,timer}` | Auto-update, when on |
| `/usr/local/bin/adrian` | The command, a link into the current release |

## Uninstalling

```bash
sudo adrian uninstall              # removes everything, including config, keys and state
sudo adrian uninstall --keep-data  # keeps /etc/adrian and /var/lib/adrian
```

It asks first (unless `--yes`), stops and removes the service and the auto-update timer, removes `/opt/adrian` and the `adrian` command, and without `--keep-data` also the config, state and the `adrian` user if the installer created it.

Remove the bot from your Discord server separately (Server Settings → Integrations).
