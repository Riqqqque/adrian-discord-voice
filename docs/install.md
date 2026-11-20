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

The installer checks these and stops (or warns) before it changes anything.

| What | Needed | If not |
|---|---|---|
| CPU | x86_64 (no ARM build) | stops |
| C library | glibc (Debian, Ubuntu and similar; not Alpine/musl) | stops |
| Init | systemd running | stops (use [Docker](#docker) without systemd) |
| Commands | `tar xz bzip2 sha256sum curl ss useradd runuser systemd-analyze` | stops, naming the missing one |
| Disk | at least 3 GB free under `/opt` | stops |
| Memory | 4 GB | warns only |
| `ffmpeg` | for music | warns; music stays off until it's installed |
| Ports | one free port from 8790 to 8799 for the admin page (or `--port N`) | stops |

Ubuntu 24.04 and Debian 12 are the recommended systems. The wizard's Check step also warns under 4 CPU threads and under 2 GB of free disk.

**Memory.** The service may use up to `MemoryHigh=4G` (the kernel throttles it above that) and `MemoryMax=5G` (hard limit). Whisper and the other languages' voices load the first time someone speaks a language other than English, not at start; a comment in `src/app/stack.ts` puts them at about 1.3 GB together. The installer's warning gives about 3.5 GB with the language voices on and about 1.5 GB with them off. To keep them out for good: `sudo adrian config languages false`.

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

The installer checks the bundle against its `.sha256` again when that file sits next to the bundle, as it does here. The bundle is about 40 MB (v0.17.1: 41,481,428 bytes).

Installer options (`install.sh --help` prints them):

| Option | Meaning |
|---|---|
| `--bundle FILE` | The release bundle (required) |
| `--yes`, `-y` | Don't ask questions; use the recommended choices |
| `--port N` | Admin page port (default: the first free one from 8790 to 8799) |
| `--lan` | Let other machines on your network reach the admin page (default: this machine only). It prints a warning: the login then goes over plain HTTP unless you add `server.tls` |
| `--no-start` | Install but don't start the service |
| `--uninstall [--keep-data]` | Remove everything the installer added (`--keep-data` keeps `/etc/adrian` and `/var/lib/adrian`) |
| `--mode native`, `--profile recommended` | The only values accepted so far (local speech, cloud language model) |

What it does:

1. Runs the checks in [Requirements](#requirements).
2. Creates a system user and group `adrian` (no login, home `/var/lib/adrian`).
3. Downloads a pinned Node.js runtime (22.23.4) and checks it runs.
4. Unpacks the bundle to `/opt/adrian/releases/<version>` (owned by root) and points `/opt/adrian/current` at it.
5. Downloads the speech models and yt-dlp into `/var/lib/adrian/models`: Silero VAD, Parakeet TDT 0.6B v3 (speech recognition), Kokoro (local voice), Whisper small (other languages), a Piper Vietnamese voice, Smart Turn v3.2 (end of turn at a PC) and yt-dlp 2026.08.19. Every file is pinned by URL and SHA-256 in `packaging/downloads.sh` and fetched over HTTPS; a mismatch stops the install. To reuse already-downloaded files, set `ADRIAN_DOWNLOAD_CACHE=/path`.
6. Writes `/etc/adrian/config.json` if there isn't one (`server.host`, `server.port`, `timezone` from the system, `secretsFile`); on a re-run it only updates `server.host` and `server.port`, from this run's options: pass the same `--port` (and `--lan`, if you used it) again, or the admin page moves to `127.0.0.1` and the first free port (the running service still holds its old one, so that can be 8791, the PC endpoint's default). Creates `/etc/adrian/secrets.env` (mode 0600, owner `adrian`).
7. Installs the `adrian` command (`/usr/local/bin/adrian`) and the `adrian-voice` systemd service, checks the unit with `systemd-analyze verify`, and records everything it created in `/var/lib/adrian/install-manifest.json`.
8. Unless `--no-start`: enables and starts the service and waits up to 60 seconds for it to answer. If it doesn't, it prints the last 30 log lines.
9. Prints the admin page address, an SSH tunnel hint and a **one-time setup code** (valid for 60 minutes; `sudo adrian setup-code --new` makes another).

The admin page listens on `127.0.0.1` only. To open it from another computer, use an SSH tunnel:

```bash
ssh -L 8790:127.0.0.1:8790 you@your-server
# then open http://127.0.0.1:8790 on your computer
```

Or install with `--lan` and open `http://<server-ip>:8790`. If you reach it through a host name (`http://adrian.example.com:8790`) rather than an IP, add that name to `server.allowedHosts`; any other name gets HTTP 421, which blocks DNS-rebinding attacks. `adrian config` can't change `server.*`, so edit the file by hand: open it with `sudo nano /etc/adrian/config.json`, add `"allowedHosts": ["adrian.example.com"]` inside `"server"` (so it reads `"server": { "host": "0.0.0.0", "port": 8790, "allowedHosts": ["adrian.example.com"] },`), then run `sudo adrian restart`. For HTTPS, add `"tls": { "cert": "/path/cert.pem", "key": "/path/key.pem" }` there too.

## 5. Run the setup wizard

Open the admin page, enter the setup code, and create the admin account (password 10 to 256 characters, stored as argon2id). The wizard then goes through:

1. **Check**: CPU, memory, disk, Node version, which models are present, and what leaves your machine.
2. **Discord**: paste the bot token. It's checked with Discord and saved only if Discord accepts it, and you get the invite link. Then pick the server and the voice channel the bot lives in.
3. **Language model**: pick a main model and an optional fallback. Each key is tested with a real request before it's saved, and you see the answer speed and an estimated cost per answer. A model set with `sudo adrian config` (a custom or local endpoint) shows as "Keep" and is left as it is.
4. **Search**: optional Tavily key, tested the same way.
5. **Voice**: listen to the local voices and pick one and a speed (0.8 to 1.2 on the slider; `sudo adrian voice NAME SPEED` takes 0.7 to 1.4).
6. **Limits**: time zone, questions per person per hour, and daily and monthly spend caps in USD (0 means no limit).
7. **Finish**: the bot restarts (about 20 seconds) and joins the channel.

Settings changed later on the admin page apply after **Restart bot** on its Status tab. Everything not in the wizard (owners, music, cloud voice, media servers, game servers, mature mode, identity, PC app) is set with `sudo adrian config`; see [configuration.md](configuration.md).

## 6. Invite the bot and test it

1. Open the invite link from the wizard and add the bot to your server.
2. Make sure the bot's role can **View**, **Connect** and **Speak** in the voice channel. Check per-channel permission overrides too.
3. Join the channel and say **"Hey Adrian, what time is it?"**

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
docker compose exec adrian node dist/cli/tool.js setup-code
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
| `adrian doctor` | Full diagnostics: Node, service enabled and running, health, last failed update, `secrets.env` mode and owner, models, yt-dlp, ffmpeg, config complete, free disk, service memory, errors in the last 15 minutes |
| `adrian backup [FILE]` | Config, keys and state (not the models) to a `.tar.gz`, mode 0600. **It contains your keys; keep it private.** |
| `adrian restore FILE` | Restore a backup. Refuses archives with anything outside `etc/adrian` and `var/lib/adrian`, `..` paths or links, before it stops anything |
| `adrian update` | Install the newest release from GitHub (see below). `--check` only says whether there's one; `adrian update FILE.tar.gz` installs a bundle you downloaded |
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

Every update:

1. asks GitHub for the latest release and stops with "Up to date" if it isn't newer than what's installed;
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

**Coming from 0.15.2 or older:** an update runs the `adrian` that's already installed, so new checks start with the update after the one that brings them. That first update still rolls back only if the bot isn't healthy within 30 seconds. In general, any change to the update steps first applies on the update after the one that ships it.

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
