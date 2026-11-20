# Troubleshooting

Start with:

```bash
sudo adrian doctor     # service, permissions, models, ffmpeg, yt-dlp, config, disk, memory, recent errors
sudo adrian check      # what's missing before the bot can start
sudo adrian logs -f    # live log (keys and tokens are redacted)
```

Almost every command needs `sudo` (only `logs`, `version` and `help` don't).
In Docker, use `docker compose exec adrian node dist/cli/tool.js check` (also
`setup-code`, `secret-list`, `secret-set NAME`, `reset-admin`) and
`docker compose logs -f adrian`; `doctor`, `update`, `rollback` and `backup`
are native only.

The admin page's status tab shows the state, problems, the last answers with
their timing and cost, and today's spend.

## It won't start, or keeps restarting

- **`adrian check` lists something missing.** Usually the Discord token, the
  server and channel, or the model key. Finish the wizard on the admin page.
- **`version X can't run this config` or a config error at start:** the
  message lists the settings it refuses. Fix them with `sudo adrian config KEY
  VALUE` (`null` removes a key; see [configuration.md](configuration.md)). A
  `config.json` that doesn't parse is never overwritten by the service: fix it
  by hand.
- **A bad Discord token** stops it without retrying; network trouble and
  Discord outages are retried. Reset the token in the Developer Portal and set
  it again: `sudo adrian secret set DISCORD_TOKEN`.
- **Two copies on one bot token** (a development copy and the service) fight
  over the voice session. Stop the service before running another copy.
- **Out of memory:** see [High memory use](#high-memory-use).

## The bot doesn't join the voice channel

- **Permissions.** The bot's role needs View Channel, Connect and Speak on that
  channel. Check per-channel permission overrides, which often block bots in
  private channels.
- **Bad token.** The logs say `logged in` with the bot's name when the token is
  good.
- **`/join` refused:** she's in one call at a time across all servers. People
  outside a call that has people in it can't pull her out of it (owners can),
  and `allowedGuilds` limits which servers she joins.
- **After any update or restart** she's back in her home channel. Use `/join`
  to bring her to another one.

## It's in the channel but doesn't answer

- **The wake phrase.** Say "Hey Adrian, ..." clearly, at the start. The logs
  show a `wake` line when it hears it.
- **No `wake` lines at all:** it isn't hearing you.
  - Check your Discord input sensitivity and push-to-talk.
  - The bot must not be server-deafened.
- **`answered` with `outcome: "timed out"` or `answer failed`:** the model is
  slow, out of credit, or rate-limited. Check the key and provider, and add a
  fallback model.
- **`limited`:** a spend cap or the per-person hourly limit was hit ("You've
  asked a lot this hour", "paused for the rest of today/month"). See
  `limits.*`; owners skip only the hourly limit. The status tab shows today's
  spend.
- **Chinese, Japanese or Vietnamese:** say "Hey Adrian", wait for "Yes?", then
  ask; the wake phrase isn't caught inside those languages.

## It talks over people or stops by itself

- **"Interrupted" a lot in the call:** the person being answered keeps talking
  (reactions, echo from their speakers). Ask them to use headphones; in the
  call barge-in needs 2.5 seconds of talking.
- **It answered side conversations:** follow-ups without the name go to the
  model, which usually stays silent for chatter. Say the name when you mean it.
- **"Wait" or "hold on" didn't stop her** in a busy call: those everyday words
  only count from the person she's answering, and are weak in group calls.
  "Stop" works for anyone; owners can also say her name.

## Text chat or `!` commands don't work

- Discord's privileged intents gate features. Without **Message Content**
  she can't read messages that don't @mention her (links in them included),
  and typed `!` commands only work as `@A.D.R.I.A.N. !play ...`. Without
  **Server Members** and **Presence**, member and game lookups are partial.
  Turn them on in the Developer Portal (Bot tab) and restart; she never asks
  for one that's off, so login doesn't fail.
- **She can't post or read history in a server invited before 0.13.4:**
  re-open the invite link to grant Send Messages, Send Messages in Threads and
  Read Message History.

## Music doesn't play, or plays the wrong thing

- **`adrian doctor` says ffmpeg is missing:** run `sudo apt install ffmpeg` and restart.
- **`music search failed` in the logs for every song:** YouTube changed something and the pinned yt-dlp is out of date. Update to the newest release.
- **"Sign in to confirm you're not a bot":** YouTube is blocking your server's IP address. She pauses YouTube for 30 minutes; there's no fix without an account, so use Plex music (`"play X from Plex"`) in the meantime.
- **Wrong song:** the logs show `music search` (what it searched for) and `music playing` (what it picked). If speech recognition misheard the title, say the artist too ("play Humble by Kendrick Lamar").
- **Choppy:** each song logs `music ended` with `musicGaps` and `longestStallMs`. Large stalls mean the CPU is overloaded; lower `listen.asrThreads` and `voice.threads`, or check other load on the machine.
- **"You've asked for a lot in the last hour":** music requests count toward the hourly limit too.

## Her voice

- **`cloud voice key missing; local voice only`** at start: the cloud voice is
  configured but its key isn't set. `sudo adrian secret set SPEECHIFY_API_KEY`
  (or the name in `cloudVoice.apiKeySecret`) and restart.
- **She switched to the local voice mid-month:** the monthly character cap
  was reached; the logs' `cloud voice` lines show `usedChars`. It resets at
  the start of the month in your time zone.
- **A key saved but no cloud voice:** a fresh config has no `cloudVoice`
  section until you set one (see [configuration.md](configuration.md)).

## The admin page won't open

- It's loopback-only by default. Use an SSH tunnel (`ssh -L 8790:127.0.0.1:8790 you@server`), or reinstall with `--lan`.
- **"Unknown host name":** you opened it by a host name. Add the name to `server.allowedHosts` by editing `/etc/adrian/config.json` (it can't be set with `adrian config`), then run `sudo adrian restart` (see [install.md](install.md)).
- **Forgot the password:** run `sudo adrian reset-admin`, then `sudo adrian setup-code`.
- **Logged out after a restart:** sessions are kept in memory only. Log in again.
- **Too many failed logins:** past the limit one try every 10 seconds still gets through; `sudo adrian restart` clears the counters.
- **Blank page after building from source:** restart the service after a web rebuild.
- **A setting changed on the page didn't take effect:** settings apply after the dashboard's Restart (or `sudo adrian restart`).

## Wrong language, or it answered in Spanish

- It replies in the language it detected. If it keeps getting that wrong, speak a full sentence.
- To turn other languages off: `sudo adrian config languages false`.

## High memory use

About 1.5 GB right after start. The Whisper model (the second listen for
languages other than English and Spanish) and the other languages' voices load
the first time someone speaks one of those languages, and hold about 1.3 GB
between them once loaded. Before they loaded on first use (0.14.7, everything
loaded at start) the service measured about 3.5 GB. `sudo adrian config languages false` keeps it near 1.5 GB. The
native service is throttled above 4 GB and stopped at 5 GB (`MemoryHigh`,
`MemoryMax`); Docker's limit is 4 GB. `adrian doctor` shows the service's
current memory.

## High CPU with a PC connected

The PC app sends every sound loud enough to open its gate: shows, music,
games, people talking in the room. The server runs speech detection and
recognition on each one to find out whether it was for her, so a noisy room
costs server CPU even when she never answers.
In the PC app's settings, move Sensitivity off Automatic to a higher value
(the meter shows what opens it), use headphones, or close the app when it
isn't wanted. All rooms share one speech recognizer, so a busy PC can slow
recognition in the Discord call too.

## The PC app

The status line in the app's settings and the tray tooltip say what's wrong.

| Status | Cause | Fix |
|---|---|---|
| "Not set up: open settings." | No address or token saved | Enter both in settings, or run `Install.ps1 -Server ... -Token ...` |
| "Connecting..." for a long time, then "Can't reach the server: ..." | Wrong address or port, the PC endpoint off, a firewall, or the server down | Check `satellite.enabled` is true and the service was restarted (the log says `satellite server listening`), the address is `host:8791` (or your `satellite.port`), and the firewall allows the PC's network. In Docker, the port must be published in `compose.yaml` |
| "The server refused this PC (bad token). Check the token in settings." | The token is wrong, or the PC was removed with `adrian satellite remove` | Pair it again: `sudo adrian satellite add NAME OWNER_ID`, paste the new token in settings |
| "The server refused this PC (too many failed attempts)..." | Five failed tries from that address in a row locked it out for 10 minutes | A correct token still gets in. Fix the token; the app retries every 5 minutes, or at once when you save |
| "Disconnected. Reconnecting..." over and over | Two PCs using one token replace each other; or the network drops | Pair each PC separately. The app backs off up to 10 seconds between tries |
| Server log `satellite rejected` with `reason` | Seen on the server for every refusal, with the address | `bad token`, `no hello` (the PC didn't speak within 5 seconds), `frame too big` |

Other problems:

- **She doesn't hear me at the PC.** Check that the window's orb shows
  Listening when you hold Ctrl+Alt+Space, and the Sensitivity meter moves when
  you talk. "No microphone found." or "Microphone: ..." means Windows has no
  default input, or it's busy: set the default recording device in Windows;
  the app follows it. On the server, `pc heard` lines (always logged, without
  words) show each segment and whether it was judged for her.
- **She hears everything (opens on every noise).** Raise Sensitivity, or use
  headphones. The server still ignores what isn't for her.
- **Her own voice cuts her off.** There is no echo cancellation; the app
  learns how loud her voice comes back, but very loud speakers close to the
  microphone can still open the gate. Lower the speakers or use headphones.
- **No sound from the PC.** "No speakers found." or "Speakers: ..." in the tray
  tooltip: set the default playback device in Windows. A switch of the default
  device is followed within a moment.
- **"Answering in the Discord call."** You're in her voice call and audible
  there, so the call answers. Mute or deafen yourself in Discord, hold
  Ctrl+Alt+Space, or type in the window to talk to the PC alone.
- **She says "Your PC app needs an update for that."** The app doesn't know
  that PC tool yet (window layout, clipboard and screen need 0.15.6). Older
  apps also answer "why is my PC slow?" with the plain summary (full health
  check from 0.15.6), and have no alarm buttons or backup ring (0.17.0). Let
  it update, or install the newest release.
- **She says "That's turned off in this PC's settings."** Turn it on under
  "What she may do on this PC".
- **"No PC is connected for ..."** The app isn't running or isn't connected,
  or the request came from someone who isn't that PC's owner: PC tools only
  reach the asker's own PC.
- **A page didn't open: "Only public http and https web addresses can be
  opened."** or "That address leads to this PC or the home network". IP
  addresses, `localhost` and LAN names are refused on purpose.
- **An app opened the wrong thing, or she asked "which one?"** Say more of the
  name ("Visual Studio 2022"). For things the Start menu doesn't list, add a line
  under Shortcuts.
- **The first PC action after starting the app, or after Save, is slow.** The
  app index (Start menu, Steam, Epic, Riot, Battle.net) is built in the
  background, and the first action that needs it waits up to 15 seconds for
  it.
- **A newly installed app isn't found.** The index is refreshed in the
  background when it is over 10 minutes old and something asks for it, and
  that request is still answered from the old list. Ask again a few seconds
  later, or press Save in settings to rebuild it now.
- **She won't move, close or picture a window:** it belongs to a game, a
  program the app can't identify (often one running as administrator), or
  something is full screen in front. That's deliberate.
- **Quiet while gaming kicks in with no game:** a full-screen app that isn't a
  browser or video player counts as a game. Turn "Quiet while I play" off in
  settings if it gets in the way.
- **Two apps start, or the window won't open.** A second launch only opens
  the running copy's window. A development build shares settings with the
  installed app and exits if the installed one is running.
- **Settings changed by themselves to empty.** A `config.json` that can't be
  read loads as defaults. Pair again.

## Alarms at the PC

- **No Stop/Snooze buttons on the PC:** both the server and the app need
  0.17.0 or newer.
- **The PC rang an alarm the server also rang:** the PC rings by itself only
  when the alarm is 20 seconds past due and the server isn't ringing it, or
  the link dropped mid-ring. A new message from the server stops the local
  ring. Check the PC's clock is roughly right; the app corrects for the
  server's clock.
- **The volume jumped up during an alarm:** the master volume was under 30%
  or muted; the app raises it and puts it back when the ringing ends (or at
  the next start after a crash).

## Cloud speech-to-text (`cloudStt`)

- **`cloud speech-to-text key missing; local only`** at start:
  `sudo adrian secret set GROQ_API_KEY` and restart.
- **`cloud speech-to-text failed; using local words`:** Groq was slower than
  `cloudStt.timeoutMs` (default 1500 ms), or returned an error. On a rate
  limit (HTTP 429) or server error it pauses for 60 seconds, for everyone.
  Groq's free tier has a per-minute limit; `cloudStt.rooms all` uses it up
  faster.

## Home control and other integrations

- **`home control token missing; that server stays off`:** set the secret
  named in `mcp.servers[].tokenSecret` (default `HOME_ASSISTANT_TOKEN`).
- **`home control unreachable; trying again later`:** retried every 5 minutes.
  **`home control ready`** lists `notOffered` for allowed tool names the server
  doesn't have: check the names in `allow`.
- **"the server refused the token":** the Home Assistant token is wrong or
  lacks access.

## Updates

- **`adrian update` rolled back:** the new version did worse than the old one: it wasn't up within 2 minutes, it came back in setup mode or out of her voice channel, or it crashed in the minute after. The log shows why: `sudo adrian logs`. The previous version is still running, under its old service file. A Discord voice outage during that minute can do this to a good release, so try `sudo adrian update` again once it's over.
- **`version X can't run this config`:** the new release doesn't accept your `config.json`, and the message lists why. Nothing was changed. Fix those settings (see [configuration.md](configuration.md)), then update again.
- **`update X skipped: it failed here in the last day`** (in `sudo adrian auto-update status`): auto-update leaves a version that failed alone for a day, so a bad release can't restart her every hour. `sudo adrian doctor` shows when it failed. `sudo adrian update` tries it right away, and a success clears it.
- **Auto-update didn't run:** it waits while someone is in her call, music plays, or an alarm rings, is snoozed or is due within 5 minutes, and while `config.json` can't be loaded. `journalctl -u adrian-update` shows each run.
- **Very old installs (0.14.9 and older)** can't fetch from GitHub: update once with a downloaded bundle (`sudo adrian update adrian-voice-<v>-linux-x64.tar.gz`).
- **Something went wrong after an update:** `sudo adrian rollback` switches back to the previous release.

PC app updates:

- **The settings say "The last update check failed: ..."**: usually no network
  or GitHub unreachable; it tries again in 6 hours, or when you turn automatic
  updates back on. "release X has no PC app download" means that release has
  no PC app asset yet.
- **"... is downloaded and installs the next time she's idle in the tray":**
  close the window and stop playing anything; it also waits while a
  full-screen app is in front.
- **The app doesn't start after an update:** in its folder
  (`%LOCALAPPDATA%\A.D.R.I.A.N` with the install script), delete `ADRIAN.exe`,
  rename `ADRIAN.old.exe` to `ADRIAN.exe`, start it, and turn automatic updates
  off until a fixed version is out. See [pc-app.md](pc-app.md).

## Older systems

- **`opus` logged with `module: "opusscript"` at start:** the native Opus module needs a newer
  glibc than the system has (the bundle is built on Ubuntu 24.04), so it uses
  the WebAssembly one. It works, with a little more CPU.
