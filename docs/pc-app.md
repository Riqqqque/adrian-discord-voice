# The PC app (Windows)

The A.D.R.I.A.N. PC app puts the bot on your Windows PC: she listens through
your microphone, answers through your speakers in the same voice, and can
control the PC (open apps and games, YouTube and Spotify searches, pause or
skip what's playing, volume, lock, and more). It talks to the same service as
the Discord bot, so memory, people, limits and costs are shared.

The app lives in the main A.D.R.I.A.N. repository
([`crates/desktop`](https://github.com/Riqqqque/A.D.R.I.A.N/tree/main/crates/desktop)).
How the connection works is in [satellite.md](satellite.md).

## 1. Turn it on in the service

On the server that runs the bot:

```sh
sudo adrian config satellite.enabled true
sudo adrian restart
```

It listens on port 8791 (`satellite.port`). Open that port to your home
network only, never to the internet; the connection isn't encrypted unless
you put it behind TLS. With UFW and a 192.168.1.x network:

```sh
sudo ufw allow from 192.168.1.0/24 to any port 8791 proto tcp
```

Then pair a PC to its owner, by the owner's Discord user ID (Discord settings,
Advanced, Developer Mode, then right-click your name and Copy User ID):

```sh
sudo adrian satellite add "Desk PC" 123456789012345678
```

It prints a token that starts with `sat_`, once. Keep it for step 3. Everything
said at that PC counts as that person, so pair each PC to the person who uses
it. `sudo adrian satellite list` shows the PCs and `remove` takes one away.

## 2. Build the app

On the Windows PC, with [Rust](https://rustup.rs) 1.88 or newer and WebView2
(built into Windows 10 and 11):

```powershell
git clone https://github.com/Riqqqque/A.D.R.I.A.N
cd A.D.R.I.A.N
cargo build --release -p adrian-desktop
```

The app is `target\release\adrian-desktop.exe`.

## 3. Install and connect

`crates\desktop\packaging\Install.ps1` copies the app to
`%LOCALAPPDATA%\A.D.R.I.A.N`, adds it to the desktop and the Start menu,
starts it with Windows in the tray, and pairs it in one go:

```powershell
powershell -ExecutionPolicy Bypass -File crates\desktop\packaging\Install.ps1 -Server myserver:8791 -Token sat_xxxxxxxx
```

Leave out `-Server` and `-Token` to enter them in the app's settings instead (the gear in
the window), and add `-NoStartup` if it shouldn't start with Windows. The
token is stored encrypted for your Windows user only. `-Uninstall` removes
the app and its shortcuts.

## Using it

- Say "Hey Adrian, ..." anywhere in the room, or hold **Ctrl+Alt+Space** and
  talk (no "Hey Adrian" needed). You can also type in the window.
- Talk over her to cut her off; "wait" or "hold on" stops her and keeps
  listening.
- Closing the window keeps her running in the tray (click the tray icon to
  open it again; Quit is in its menu). In the tray she uses a few MB of RAM,
  no GPU and almost no CPU, and gets out of the way of games.
- **In the bot's Discord call too?** While you're in the same voice channel
  and not muted, the call answers instead of the PC, so music plays for
  everyone. PC orders ("pause Spotify", "open Valorant") still reach your PC.
  Mute yourself in Discord, hold Ctrl+Alt+Space or type in the window to talk
  to the PC alone.

## What it may do

The app's settings decide which PC actions the bot may take: apps, web pages,
media, volume, system info, lock, screen off, and sleep, restart and shut down
(those three always ask you first, out loud). Running games are never closed,
focused or minimized. Anything she asks for that's turned off is refused on the
PC itself, whatever the server says.

## Optional extras on the server

- `cloudStt`: a more accurate second listen for what's said to her at a PC,
  using Groq's Whisper (free tier, about 20 requests a minute):
  `sudo adrian secret set GROQ_API_KEY`, then
  `sudo adrian config cloudStt.enabled true` and `sudo adrian restart`.
- `satellite.unfinishedWaitMs` (default 1200): when you pause mid-sentence,
  she waits up to this much longer for the rest. 0 turns it off.
- `satellite.recordDays` (default 0): keep recordings of requests made at a PC
  for that many days, to check speech recognition on your own voice.
