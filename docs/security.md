# Security

A.D.R.I.A.N. listens to a voice channel anyone in your server can join, holds API keys that cost money, and runs on your home server. This page lists what it protects against and how.

## What's at stake, and the protections

**Your keys** (Discord token, model and service keys)
- Stored in `/etc/adrian/secrets.env`: mode 0600, owned by the service user, written atomically.
- Never passed in program arguments or the environment of child processes.
- Never logged. Log lines and admin-page errors go through a redactor for tokens and keys.
- The admin page can set keys but never reads them back.
- Each setting may only reference keys meant for its own purpose. A language-model endpoint can't be pointed at `DISCORD_TOKEN` or `PLEX_TOKEN`, from the admin page, the CLI or a hand-edited config, so a hijacked admin session can't send those keys anywhere.
- Plex, Sonarr, Radarr and Tavily keys travel in request headers only, never in URLs.

**Your server**
- The service runs as the `adrian` system user under systemd sandboxing:
  - `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` and `PrivateDevices`.
  - `NoNewPrivileges` and an empty capability set.
  - A `@system-service` syscall filter and restricted address families.
  - CPU and memory caps.
- Child processes (yt-dlp, ffmpeg) inherit all of it.
- Releases and models are owned by root and read-only to the service.
- The installer and the `adrian` command refuse to follow symbolic links in the service-owned directories, so a compromised service can't trick root into touching system files. They reject odd version names, verify the bundle checksum when the `.sha256` file is present, refuse backups that contain links or paths outside the two data directories, and use private temp files.

**Downloads**
- Node.js, every speech model and yt-dlp are pinned by version and SHA-256, and fetched over HTTPS only.
- npm dependencies are pinned exactly (`package-lock.json`).

**The admin page**
- Listens on loopback by default.
- Logins:
  - argon2id password hashing (OWASP parameters).
  - A 50-bit one-time setup code that expires after an hour and burns after 10 wrong tries.
  - Timing-safe comparisons and rate limiting.
- Sessions: HttpOnly, SameSite=Strict cookies (Secure under TLS), CSRF tokens plus an Origin check.
- Requests and responses:
  - A strict Content-Security-Policy, and no `innerHTML` in the page.
  - Request bodies capped at 64 KB, and static files served from a fixed set of types.
- **DNS rebinding:** requests whose `Host` isn't an IP, `localhost` or a name in `server.allowedHosts` get refused.

**Voice input from anyone in the call**
- Spoken text never becomes a command-line option. Music searches are passed as `ytsearch5:`-prefixed or URL-encoded arguments, without a shell.
- ffmpeg may only open `http`/`https` streams (`-protocol_whitelist`), never local files.
- Plex track paths must stay on the Plex server and under `/library/parts/`.
- Tool results and web content are marked as untrusted data in the prompt.
- Notes are keyed by Discord user ID and only used when that person is speaking, so nobody can talk the bot into revealing someone else's notes.
- Owner rights are checked by Discord ID, never by display name. A member named like the creator is flagged as not the creator.
- Integrations (Plex, Sonarr, Radarr, game servers) are read-only.

**Cost**
- A per-person hourly limit (music requests count too), plus daily and monthly dollar caps checked before every model call.
- Common phrases are answered locally.
- Cloud voice characters are capped per month.

**Abuse**
- One answer at a time, and the queue holds 2.
- Question length is capped, and each phrase is at most 20 seconds of audio.
- Up to 20 reminders and 30 notes per person.
- `allowedGuilds` restricts `/join` to your servers. Keep **Public Bot** off in the Discord Developer Portal, so strangers can't add it to theirs.

## Things to know

- **Release bundles** are protected by SHA-256 checksums, not signatures. Download them from this repository's Releases page over HTTPS.
- **Backups** (`adrian backup`) contain your keys. Store them like passwords.
- **`listen.logTranscripts`** writes what people say into the log. It's for debugging only; leave it off.
- **`satellite.recordDays`** saves the audio of requests made at a PC (only speech already judged as meant for her) with what each listener heard, in the state folder, deleted after that many days. Off by default.
- **Channel context** (text chat with Message Content on) sends a channel's recent messages, written by people who never addressed the bot, to your language-model provider whenever it answers there. Nothing is stored. Use `textChat.readChannels false` or `allowedGuilds` if that doesn't fit a server.
- **Server lookups and messaging.** server_info shows only channels the asker can see. message_member always names the sender, pings only the one recipient, refuses channels the sender can't post in, and is rate limited per sender and per recipient. People can still use it to annoy each other within those limits; turn off `messaging.enabled` if that's a problem in your server.
- **Mature mode** depends on the language model following its instructions. It isn't a content filter.
- **Music taste** (`music-taste.json` in the state folder) keeps which artists each person asks for and any likes or dislikes they state. A person's taste only goes into their own prompts. Her own taste goes into everyone's.
- **Top songs** (`music.topSongs`) sends the artist's name to Deezer's public API, with no account or key. Turn it off if you'd rather not.
- **YouTube playback** uses yt-dlp, which isn't sanctioned by YouTube's terms of service. You decide whether to keep `music.enabled` on.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private vulnerability reporting (the **Security** tab, then **Report a vulnerability**) on this repository. Include the version (`adrian version`) and the steps to reproduce.
