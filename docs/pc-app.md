# The PC app (Windows)

The A.D.R.I.A.N. PC app puts the bot on a Windows PC: she listens through the
microphone, answers through the speakers in the same voice, and can control
the PC. It talks to the same service as the Discord bot, so memory, people,
limits and costs are shared. All speech recognition, the language model and
the voice run on the server; the PC only listens for loudness, plays audio and
carries out PC actions its own settings allow.

The app's code lives in the main A.D.R.I.A.N. repository
([`crates/desktop`](https://github.com/Riqqqque/A.D.R.I.A.N/tree/main/crates/desktop)
for the app, `crates/pc-control` for the PC actions). How the two sides talk
is in [satellite.md](satellite.md).

## What it does

- **Always listening, locally gated.** The microphone stays open, but audio
  leaves the PC only while someone is talking loudly enough. The server then
  decides whether it was for her ("Hey Adrian, ..."). Hold **Ctrl+Alt+Space**
  to talk without the name, or type in the window.
- **Talk over her.** Speaking while she talks turns her voice down on the PC
  at once and stops her; music alone is never turned down for noise. "Wait"
  or "hold on" stops her and keeps listening.
- **Controls the PC**: apps and games, window layout across monitors, web
  pages, YouTube and Spotify searches, media playback, volume (master, one
  app, or "my music"), lock, screens off, sleep, restart and shut down (those
  three ask first, out loud), PC status and health. Only when asked: reads the
  clipboard, looks at a window or the screen.
- **Quiet while gaming.** While a game is in front she only answers to her
  name, keeps answers short and holds reminders until the match ends.
- **Alarms.** Stop and Snooze in the window and the tray, and a backup ring
  on the PC itself if the server doesn't ring an alarm or can't be reached.
- **Music, sounds and the music quiz** play on the PC when asked for there.
- **Works with the Discord call.** In the bot's call too, the call answers
  and PC orders still reach the PC.
- **Stays out of the way.** In the tray there is no window at all, the
  process drops to low priority, and it uses a few MB of memory.
- **Follows the Windows default devices** when you switch speakers or
  headphones, and **updates itself** from GitHub releases.

## 1. Turn it on in the service

On the server that runs the bot:

```sh
sudo adrian config satellite.enabled true
sudo adrian restart
```

It listens on port 8791 (`satellite.port`) on every address
(`satellite.bind`, default `0.0.0.0`). Open that port to your home network
only, never to the internet: the connection isn't encrypted unless you put it
behind TLS. With UFW, using your own network's range in place of the example
`192.0.2.0/24`:

```sh
sudo ufw allow from 192.0.2.0/24 to any port 8791 proto tcp
```

Then pair a PC to its owner, by the owner's Discord user ID (Discord settings,
Advanced, Developer Mode, then right-click your name and Copy User ID):

```sh
sudo adrian satellite add "Desk PC" 123456789012345678
```

It prints a token that starts with `sat_`, once. Keep it for step 3. Everything
said at that PC counts as that person, so pair each PC to the person who uses
it. `sudo adrian satellite list` shows the PCs and `sudo adrian satellite
remove ID` takes one away (restart the service to drop one that is connected).

**Docker:** the container has no `adrian` command, and compose only publishes
the admin page. From `packaging/docker`, turn it on with the container's tool:

```sh
docker compose exec adrian node dist/cli/tool.js config satellite.enabled true
```

Then add the port to `compose.yaml`, under `ports:` in the `adrian` service.
Use the server's address on your home network in place of `SERVER_LAN_IP`:
ports published by Docker go around UFW, so the rule above won't limit them.

```yaml
      - "SERVER_LAN_IP:8791:8791"
```

Apply that and pair the PC:

```sh
docker compose up -d
docker compose exec adrian node dist/cli/tool.js satellite-add "Desk PC" 123456789012345678
```

## 2. Get the app

Download `adrian-pc-app-<version>-windows-x64.zip` from the
[Releases page](https://github.com/Riqqqque/adrian-discord-voice/releases),
check it against its `.sha256` file, and unzip it. Each release also carries
the bare `adrian-pc-app-<version>-windows-x64.exe` and its `.sha256`, which is
what the app's updater downloads. It runs on 64-bit Windows 10 and 11. The C
runtime is linked in; the window uses the Microsoft Edge WebView2 Runtime,
which Windows 11 and updated Windows 10 already have (if the window stays
blank, install the runtime from Microsoft). It isn't code-signed,
so SmartScreen may warn the first time: choose "More info", then "Run anyway".

Or build it yourself, with [Rust](https://rustup.rs) 1.88 or newer on the MSVC
toolchain (`x86_64-pc-windows-msvc`, the rustup default on Windows) and the
Visual Studio Build Tools with the C++ build tools workload (a C compiler and
linker are needed):

```powershell
git clone https://github.com/Riqqqque/A.D.R.I.A.N
cd A.D.R.I.A.N
cargo build --release -p adrian-desktop
```

The exe is `target\release\adrian-desktop.exe`.

## 3. Install and connect

In the unzipped folder (or in the repo, after building), run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install.ps1 -Server myserver:8791 -Token sat_xxxxxxxx
```

From the repo the script is `crates\desktop\packaging\Install.ps1`. It:

- checks the address and token first (by running the app with `--pair`) and
  stops without changing anything if they're wrong,
- copies the app to `%LOCALAPPDATA%\A.D.R.I.A.N\ADRIAN.exe`,
- adds shortcuts to the desktop and the Start menu, and to Startup with
  `--background` so it starts with Windows in the tray (`-NoStartup` leaves
  that out, and removes it if it was there),
- starts it: in the tray when paired, with the window otherwise.

Leave out `-Server` and `-Token` to enter them in the app's settings instead
(the gear in the window). That also keeps the token out of the PowerShell
command line and history. The token is stored encrypted for your Windows user
only. `-Uninstall` removes the app and its shortcuts; its settings stay in
`%APPDATA%\adrian`.

The script only checks that the address and token look right. It can't tell
that a token is wrong until the app connects: then the window shows "The
server refused this PC (bad token). Check the token in settings."

## Using it

- Say "Hey Adrian, ..." anywhere in the room, or hold **Ctrl+Alt+Space** and
  talk (no "Hey Adrian" needed; it works for the next 15 seconds). You can also
  type in the window (up to 2000 characters; while she's offline the text
  isn't sent and stays in the box).
- After an answer she keeps listening for 20 seconds without her name, so a
  follow-up needs no "Hey Adrian".
- Talk over her to cut her off; "wait" or "hold on" stops her and keeps
  listening. The stop button or Escape stops her too.
- Closing the window keeps her running in the tray (click the tray icon to
  open it again; Quit is in its menu).
- **In the bot's Discord call too?** While you're in the same voice channel
  and not muted or deafened, the call answers instead of the PC, so music
  plays for everyone. PC orders ("pause Spotify", "open Valorant") still reach
  your PC. Mute yourself in Discord, hold Ctrl+Alt+Space or type in the window
  to talk to the PC alone.

Things to say:

| Area | Examples |
|---|---|
| Apps and games | "open Spotify", "open Valorant", "close Discord", "what's open?", "which games do I have?" |
| Windows | "put Discord on the left", "snap Chrome to the top right", "move Spotify to my other monitor", "maximize that", "put it back" |
| Web | "open the Wikipedia page for Rust", "search YouTube for lo-fi", "play the new trailer on YouTube", "open my downloads" |
| Media | "pause", "skip", "what's playing?", "pause YouTube" |
| Volume | "turn it down", "volume 30", "mute Discord", "turn my music down" |
| System | "lock my PC", "turn the screens off", "restart the PC" (she asks "Restart the PC?" and waits for your yes), "cancel" within 30 seconds |
| Health | "why is my PC slow?", "how hot is my GPU?", "how much space is left?" |
| Clipboard and screen | "summarize what I copied", "translate what I copied", "what's this error on my screen?" |
| PC and Discord | "send that link to my PC", "move the music to my PC", "put what I'm watching into the call", "tell the call I'll be on in 5" |
| Everything else | timers, alarms, reminders, notes, weather, music, the music quiz, Steam ("which of my Steam friends are online?"): see [usage.md](usage.md) |

## The window and the tray

- **No window in the tray.** The window is created when you open it and
  destroyed when you close it (or after it has been minimized for 2 minutes),
  so its web view's memory goes away with it.
- **Tray**: left click opens or closes the window. The menu has Show
  A.D.R.I.A.N., Stop alarm and Snooze alarm (while one rings) and Quit. The
  tooltip shows the connection status; an orange dot on the icon means not
  connected, or the microphone or speakers failed.
- **The orb** shows her state: Ready, Listening (only while she'd take your
  words without her name, or while push-to-talk is held), Thinking, Speaking
  (her voice, not music). It stops drawing whenever the window is hidden,
  minimized, or behind a full-screen app.
- **Transcript**: the last thing you said to her and her answer as she says
  it, fading 20 seconds after she finishes.
- A second launch of the app just opens the running copy's window.

## Settings

The gear in the window. Save is all or nothing: a bad address, a token that
doesn't start with `sat_`, or a shortcut line it can't read is named and
nothing changes. While connected, Save reconnects only when the address or
token changed (a reconnect drops what she's doing). While not connected, every
Save tries again at once. Every Save also rebuilds the app index in the
background.

| Section | Setting | Default |
|---|---|---|
| Connection | Server address, e.g. `myserver:8791`. No scheme means `ws://`; `https://` means `wss://`; `/satellite` is added | empty |
| Connection | Pairing token (`sat_...`), stored encrypted with Windows DPAPI for this Windows user | empty |
| Microphone | Sensitivity, 0 = automatic; a live level meter; the devices in use (always the Windows defaults) | automatic |
| Games | Quiet while I play | on |
| Updates | Update automatically, with the version and the last check | on |
| What she may do on this PC | Apps and games, Window layout, Web and folders, Media, Volume, PC status, Clipboard, Screen, Lock the PC, Turn the screens off, Sleep, Restart, Shut down | all on |
| Shortcuts | Extra things she can open by name, one per line: `name = target` or `name = "target" args`. A target is an `.exe`, `.lnk`, `.bat`, `.ps1` or a URL | none |

The settings live in `%APPDATA%\adrian\desktop\config\config.json`. A missing
key takes its default. A file that can't be read loads as defaults (not
paired), and the next Save replaces it.

## Listening and talking

- The microphone is the Windows default input, mixed to mono and resampled to
  48 kHz. A loudness gate opens after 60 ms above its threshold and sends the
  300 ms before that too, so the first word isn't cut. It closes after 1.2
  seconds of quiet, or after 30 seconds of continuous sound.
- The automatic threshold follows the room's background level: it drops fast
  when the room gets quieter and rises slowly, never while the gate is open or
  her voice is playing, and stays between 0.012 and 0.035 RMS so loud shows or
  music can't make it deaf.
- **Talking over her**: while she plays, the app learns how loud her own
  voice comes back into the microphone and opens the gate only for sound
  clearly above that echo (three times the expected echo, for 80 ms). Then it
  turns her voice down to 30% at once, and the server stops her. There is no
  echo cancellation, so speakers turned up very loud can still trip it, and
  headphones work best.
- **Audio from the server** (her voice, music, sounds) is resampled to the
  speakers' rate and buffered up to 8 seconds. The speakers are released after
  3 seconds of silence and opened again when audio arrives.
- **Device changes**: switching the Windows default device (speakers to
  headphones, a new microphone) reopens both streams on the new defaults
  within about a quarter of a second. Audio already buffered at that moment is
  dropped; what streams after it plays on the new device. A device that fails
  is retried, from 0.3 seconds doubling to 5.
- **While offline** nothing is queued: audio, typing and push-to-talk from
  while the link was down are never sent later.

## Alarms

From 0.17.0, with a server of the same version:

- The server sends the owner's alarms for the next 8 days, and again on every
  change and every hour.
- While an alarm rings, the window opens (without taking focus, and not over a
  full-screen app) with Stop and Snooze (More time for timers), and the tray
  menu enables Stop alarm and Snooze alarm. If the alarm opened the window, it
  closes again a few seconds after the ringing ends, unless you clicked into
  it.
- **Backup ring**: if an alarm is 20 seconds past due and the server isn't
  ringing it, or the link drops while it rings, the PC rings it itself with
  its own beeps, for the alarm's ring time. A stop or snooze given there is
  sent to the server once it's back.
- If the master volume is under 30% or muted while an alarm rings, the app
  raises it to 30% and puts it back afterwards. The old level is saved first,
  so a crash mid-ring is undone at the next start.

What can still miss an alarm: the PC asleep or off, or the app not running.
Then the server rings it in the call if you're there, else sends a DM.

## Games

While you play a game on the PC, she only answers when you say her name (or
push-to-talk, or typing), keeps answers short, and saves reminders for when
the match ends. Timers and alarms still ring. The app checks every 2 seconds
what's in front: a program in a game's install folder (Steam, Epic, Riot,
Battle.net, Xbox and common launcher folders), a well-known game by name, or a
full-screen app that isn't a browser, video player or Store app. Playing
starts after 5 seconds in a game and ends after 20 seconds out of one. The
switch "Quiet while I play" (on by default) turns this off for this PC.
Details: [satellite.md](satellite.md#quiet-while-gaming).

The app is built to stay away from games' anti-cheat: it never closes,
focuses, minimizes, moves or takes a picture of a game's window, never opens a
game's process for more than its name, and treats programs it can't identify
as games. It won't pop a focused window over a full-screen app, and it won't
install an update while one is in front.

## What it may do

The settings decide which PC actions the bot may take. Anything turned off is
refused on the PC itself, whatever the server says; the server can't change
these settings. Sleep, restart and shut down also need you to say yes to her
question, on your next turn, within 20 seconds; restart and shut down then
wait 30 seconds, and "cancel" (or the stop button) calls them off. She never
types or clicks into other programs, never kills a process, and starts only
installed apps, games and your own shortcuts.

Two settings let her look at things, only when you ask:

- **Clipboard** ("read what I copied", "summarize this", "translate what I
  copied"): she reads the text you copied, up to 8000 characters. Anything a
  password manager marks as secret is refused without being read, and copied
  images and files are only described, never opened.
- **Screen** ("what's this error on my screen?", "what does this say?"): she
  takes one picture of the window in front, a window you name, or, if you ask,
  the whole screen it's on. Never of a game, never while a full-screen app is
  in front, and never of her own window. The picture goes to the language
  model for that one answer and is not kept or logged. Protected video (DRM)
  comes out black, and she says so.

Both are on by default. PC apps 0.15.5 and earlier don't have them: she says
the app needs an update.

## Updates

The app updates itself. Three minutes after it starts, and every six hours,
it asks GitHub for this project's latest release. If it is newer, the app:

1. downloads the `.exe` asset and its `.sha256` (only from this repository's
   release downloads) and checks the hash,
2. saves it as `ADRIAN.new.exe` beside the running app and starts it once with
   `--self-check`, which must print exactly the release's version,
3. waits until she's idle in the tray (no window, nothing playing, nobody
   talking, no push-to-talk, no answer under way, no full-screen app in front),
4. checks the hash again, swaps the files (the old one becomes
   `ADRIAN.old.exe`), starts the new copy in the tray and exits.

`ADRIAN.old.exe` is deleted only after the new version has been welcomed by
the server and has run for 3 minutes. The settings show the version and the
last check ("Version 0.17.1, up to date."), and have a switch to turn automatic
updates off; then it only tells you a new version is out.

**Going back to an older version:** turn automatic updates off first, or the
app installs the newest one again a few minutes after it starts. Then quit the
app and replace `ADRIAN.exe` with the older
`adrian-pc-app-<version>-windows-x64.exe` from the Releases page, renamed to
`ADRIAN.exe`.

**If the app stops starting after an update:** in the app's folder
(`%LOCALAPPDATA%\A.D.R.I.A.N` if you used the script), delete `ADRIAN.exe`,
rename `ADRIAN.old.exe` back to `ADRIAN.exe` and start it. Then turn automatic
updates off until a fixed version is out.

For the bot on the server, `sudo adrian auto-update on` does the same (see
[install.md](install.md)). Updates trust whoever can publish releases on this
repository: see [security.md](security.md).

## Command-line options

| Option | What it does |
|---|---|
| `--background` | Start in the tray without the window (the window still opens if it isn't paired). The Startup shortcut uses it. |
| `--pair SERVER TOKEN` | Save the address and token without opening anything. Exit code 0 on success, 1 on bad input (there is no console output in release builds). |
| `--update-now` | Check, download, verify and install the newest release right away, without waiting for idle. |
| `--self-check` | Start the app framework, print the version and exit. The updater uses it to prove a download runs. |
| `--after-update` | Used by the updater when it starts the new copy. |

## Files it keeps

| File | Where |
|---|---|
| `ADRIAN.exe` | `%LOCALAPPDATA%\A.D.R.I.A.N` with the script |
| `ADRIAN.new.exe`, `ADRIAN.old.exe` | beside it, only around an update |
| `config.json` (settings, encrypted token) | `%APPDATA%\adrian\desktop\config` |
| `alarms.json` (the server's alarms, answers still to send, a volume to restore) | same folder |
| Web view cache (`EBWebView`, created when the window first opens) | `%LOCALAPPDATA%\ai.adrian.desktop` |

`Install.ps1 -Uninstall` removes the app folder and its shortcuts but leaves
the settings folder and the web view cache in place; delete them by hand for a
clean removal.

The app writes no log files and sends no telemetry. Besides the server, the
only thing it talks to is GitHub, for updates.

## What it costs to run

On the PC (measured on one Windows PC):

| When | Measured |
|---|---|
| In the tray, before the window was removed from the tray (2026-10-23) | 7 processes, 303 MB private memory (296 MB of it the web view), 0.04% CPU |
| In the tray now (2026-10-23) | 1 process, 5 MB private memory, 0.01% CPU while speech was being sent, 0% GPU, about 0.3 KB of disk I/O a minute |
| 0.15.6 to 0.17.1 after a restart (2026-11-08 to 2026-11-19) | 4.8-4.9 MB private memory |
| The orb drawing in a hidden window, before it was paused (2026-10-22) | about 12% CPU and GPU spikes up to 19%; 0% after |

While the window is open the web view adds a few hundred MB. Audio is 768
kbit/s (48 kHz, 16-bit mono) up while the gate is open and the same down
while she plays audio; nothing goes up while nobody talks. Update checks are one
small GitHub API call 3 minutes after start and then every 6 hours, plus the
download when there is a new version.

On the server, a PC costs what a Discord user costs: speech recognition, the
language model, the voice. Each gate opening is a segment the server listens
to (local, free); only requests meant for her reach the model. A screen
picture is sent to the model as an image. See [costs.md](costs.md).

## Optional extras on the server

- `cloudStt`: a second, more accurate listen for what's said to her at a PC,
  using Groq's hosted Whisper (`whisper-large-v3-turbo`):
  `sudo adrian secret set GROQ_API_KEY`, then
  `sudo adrian config cloudStt.enabled true` and `sudo adrian restart`. It also
  covers what PC owners say to her in a Discord call while their PC is
  connected, and `sudo adrian config cloudStt.rooms all` adds everyone in the
  call. Only speech already judged as meant for her goes, and that audio goes
  to Groq. If Groq is slower than `cloudStt.timeoutMs` (default 1500) the local
  words are used; a rate limit (HTTP 429) or server error pauses it for 60
  seconds. Groq's free tier has a per-minute request limit.
- `satellite.unfinishedWaitMs` (default 1200): when you pause mid-sentence,
  she waits up to this much longer for the rest (Smart Turn, PCs only). 0
  turns it off.
- `satellite.quietWhileGaming` (default true): the server side of quiet while
  gaming.
- `satellite.logTranscripts` (default false) and `satellite.recordDays`
  (default 0): words in the log and recordings of requests made at a PC, for
  fixing misunderstandings. Both are personal data; see
  [security.md](security.md).

All keys: [configuration.md](configuration.md).

## Limits

- Windows only. No echo cancellation: talking over her relies on the learned
  echo level, so very loud speakers can still let her voice open the gate.
- Anyone near the PC speaks as its owner (see [security.md](security.md)).
- A PC's music queue, music level, voice volume and speed reset when it
  reconnects.
- Window undo (`put it back`) remembers the last 32 changes, in memory only.
- CPU temperature is never reported; GPU stats need an NVIDIA card.
- A development build shares settings with an installed copy and updates
  itself too unless automatic updates are off.
- Not code-signed.

Building, internals and tests: the main repository's docs
([docs/desktop.md](https://github.com/Riqqqque/A.D.R.I.A.N/blob/main/docs/desktop.md),
[docs/pc-control.md](https://github.com/Riqqqque/A.D.R.I.A.N/blob/main/docs/pc-control.md)) and `cargo test -p adrian-desktop`,
`cargo test -p adrian-pc-control`.
