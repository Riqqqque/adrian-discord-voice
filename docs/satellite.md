# PC satellite

A PC satellite is a small Windows app that gives A.D.R.I.A.N. a microphone, a
speaker and a window on a computer, and lets her control that computer. It
connects to this service, which does everything else exactly as it does for
Discord: speech recognition, the wake phrase, the language model, the voice,
memory, tools and spend limits.

This page is the contract between the two sides: the connection protocol and
the PC actions. Both sides enforce it.

## Who it acts as

Each satellite is paired to one Discord user, its owner. Everything heard on
that PC is treated as that person talking: their memory, their owner rights,
their spend limits. Anyone else talking near the PC therefore speaks with the
owner's rights. Until voice identification exists, the limits on PC actions
below (an allowlist on the PC, confirmations for power actions) are the
safeguard.

PC actions always go to a satellite owned by the person asking. From Discord
or text chat, "open Spotify on my PC" reaches the asker's own connected PC.
No argument can name another person's PC.

When the owner is also in the voice call the bot is in, the call hears the
same words, so the call answers and the PC stays quiet (its window shows
"Answering in the Discord call."). Music and sounds then play for everyone in
the call, and PC orders ("pause Spotify", "open Valorant") still reach the
PC through the PC tools. The PC takes over again when the owner is muted or
deafened in Discord, leaves the call, holds push-to-talk, or types in the
window. Their requests in the call get the same cloud speech-to-text as the
PC (`cloudStt`).

## Connection

One WebSocket per satellite, at `ws://<host>:<satellite.port>/satellite`
(default port 8791). Run it over a private network (LAN, Tailscale) or put TLS
in front: frames are not encrypted otherwise.

Text frames are JSON objects with a `type`. Binary frames are audio.

### Satellite → service

| type | fields | meaning |
|---|---|---|
| `hello` | `token`, `device`, `version` | First frame. Anything else first closes the connection. |
| `speech_start` | | Someone started talking (local energy gate). |
| *(binary)* | PCM s16le mono 48 kHz | Microphone audio, only between `speech_start` and `speech_end`. The service finds the exact speech (Silero VAD) and the wake phrase. |
| `speech_end` | | Talking stopped. |
| `ptt` | `down: bool` | Push-to-talk: the next thing said is for her, no wake phrase needed (for 15 seconds). |
| `text` | `text` | A typed question from the window. |
| `stop` | | Stop talking (button or hotkey). |
| `action_result` | `id`, `ok`, `result`, optional `image` | Outcome of an `action`. `result` is text for the model (the server keeps at most 9000 characters). `image` (`pc_screen` only): `{ mime, data }`, `mime` `image/jpeg` or `image/png`, `data` base64 of at most 1.5 MB. See [Pictures](#pictures). |
| `ping` | | Keep-alive; answered with `pong`. |
| `activity` | `gaming: bool`, `game` (optional, at most 60 characters) | A game is being played on this PC now, or no longer is (see [Quiet while gaming](#quiet-while-gaming)). Sent when it changes and after every `welcome` while playing. Apps before 0.15.6 never send it: the service treats every connection as not playing until it says otherwise. |

### Service → satellite

| type | fields | meaning |
|---|---|---|
| `welcome` | `owner`, `name` | Accepted. `owner` is the owner's display name. |
| `denied` | `reason` | Rejected; the connection closes. |
| `mode` | `mode` | `thinking` while she works on an answer, `idle` after. |
| `state` | `speaking`, `listenMs` (either or both) | `speaking`: her voice is audible, as opposed to music only (the PC gets both as one stream, and only turns her voice down when you talk over it). `listenMs`: how much longer she takes words without her name, 0 when she doesn't. |
| `transcript` | `who` (`you`/`her`), `text`, `final` | What was heard, and what she's saying so far (`final: false` while it grows). |
| *(binary)* | PCM s16le mono 48 kHz | Her voice, music and sounds, in real time. |
| `audio_stop` | | Drop any audio still buffered (she was interrupted). |
| `action` | `id`, `name`, `args` | Do a PC action and answer with `action_result`. |
| `pong` | | |

Pairing: `sudo adrian satellite add NAME OWNER_DISCORD_ID` on the server prints
a token once. The service keeps only its SHA-256. The satellite stores the
token encrypted with Windows DPAPI. Five bad tokens from one address lock it
out for 10 minutes. Turn the endpoint on with `sudo adrian config
satellite.enabled true` (port `satellite.port`, address `satellite.bind`).

Music, sound effects and her voice asked for through a PC play on that PC.
Each PC is its own room: talking at the PC doesn't interrupt the Discord call.

## PC actions

The model sees these tools. Each one is sent to the owner's satellite as an
`action`; the satellite checks it against its own settings before doing
anything, so a compromised or confused server still can't do more than the
PC allows. No action types or clicks into other programs, and nothing touches
a running game.

| tool | `action` values / args | notes |
|---|---|---|
| `pc_apps` | `open`, `close`, `focus`, `minimize`, `running`, `show_desktop`, `list`; `name` | Apps from the Start menu (desktop and Store apps), Steam, Epic and Riot games, and the PC's own shortcuts. Ambiguous names come back as a list to choose from. `list` finds installed apps or games by name; with no name it lists the games. `close` asks the window to close, it never kills. |
| `pc_windows` | `snap` (`side`: `left`, `right`, `top`, `bottom`, `top_left`, `top_right`, `bottom_left`, `bottom_right`), `maximize`, `restore`, `center`, `move`, `back`, `monitors`; optional `name`, `monitor` | Window layout. `name` finds the app like `pc_apps` does (its most recently used window, or the one whose title fits); without it, the window in front. `monitor` is `main`, `other` (only with two), `left`/`right`/`top`/`bottom`/`middle` by where the monitors sit, a number as Windows numbers them (the n of `\\.\DISPLAYn`), or the monitor's own name; `move` without it goes to the other one when there are two. Snaps fill the monitor's work area (around the taskbar, wherever it is) edge to edge in physical pixels, mixed DPI included. A snapped window keeps its half or quarter on another monitor, a maximized one stays maximized, any other keeps its size and spot. Nothing is activated, and nothing is raised over a full-screen window or a game in front. `back` undoes the PC's last change to that window (or to any window), kept in memory for the last 32 changes. Refused with a sentence: games, full-screen windows, windows on another virtual desktop, windows that aren't responding, admin windows, maximizing while something is full screen in front, and a monitor a full-screen game is on. Size limits are reported ("Discord can't get that narrow..."). `monitors` lists each monitor's number, role, position, name, resolution, scale and windows. PC apps before 0.15.6 answer "Unknown PC action", which she turns into "Your PC app needs an update for that." |
| `pc_open` | one of `url`, `search`, `youtube` (with `play`), `spotify`, `folder` (downloads, documents, desktop, pictures, music, videos) | Opens in the default browser, Spotify or Explorer. `url` must be a public `http`/`https` address of at most 300 characters: no localhost, LAN names, IP addresses or `user@` parts (checked on the PC; apps from 0.15.2 and older take any `http`/`https` address). `search` and `play` end on the server: `search` becomes the `url` of the best web result, or a Google results page, and `play` swaps `youtube` for the top result's `video_id`. Spotify opens its own search page, or the web player without the app. |
| `pc_media` | `play_pause`, `play`, `pause`, `next`, `previous`, `stop`, `status`; optional `app` | Through Windows media sessions (Spotify, browsers, players). `app` picks a player or site by name, and a YouTube, Netflix or Twitch tab counts. Without it, pause, skip and stop go to what's playing, and play to the last one used. `status` says what's playing, and without `app` it lists every player. |
| `pc_volume` | `get`, `set` (`level` 0-100), `up`, `down`, `mute`, `unmute`; optional `app` or `playing` | Master volume, one app's volume ("mute Discord"), or with `playing: true` every app making sound that could be music or video ("turn my music down"). Games, Discord and other voice chat are left alone. PC apps before 0.15.4 ignore `playing` and change the master volume. |
| `pc_system` | `lock`, `screen_off`, `sleep`, `restart`, `shutdown`, `cancel_shutdown`; `confirmed` | `sleep`, `restart` and `shutdown` need `confirmed: true`, which isn't in the tool the model sees. The server drops any the model sends, and sets it only when the person's very next turn, in the same place and within 20 seconds, is a plain yes to the fixed question. Restart and shutdown wait 30 seconds and can be cancelled. Each can be turned off on the PC. |
| `pc_info` | `summary`, `processes`, `health` | CPU, memory, disk space, uptime, battery; the busiest programs. `health` ("why is my PC slow?") takes one 250 ms sample: CPU load and the busiest programs by CPU, memory and its biggest users, NVIDIA GPU load, video memory and temperature (through the driver's NVML library, loaded only for the call; other GPUs: "GPU stats aren't available"), free space per drive, and a one-line verdict first ("Nothing's struggling.", "Chrome is using 40% CPU."). CPU temperature is never reported: Windows only shows it to admin tools. Closing a hog is `pc_apps close`, which the model only offers. PC apps 0.15.5 and earlier answer `health` with `summary`. |
| `pc_clipboard` | `read` | The clipboard's text (`CF_UNICODETEXT`), up to 8000 characters, with a note when cut. Refused, without reading it, when a password manager marked it: an `ExcludeClipboardContentFromMonitorProcessing` or `Clipboard Viewer Ignore` format, or `CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` set to 0. Images and copied files are only described ("an image", "3 copied files"). Retries briefly when another program has the clipboard open. The text is never logged: the transcript log shows only the first line ("The clipboard text (120 characters):"). |
| `pc_screen` | `window` (default), `monitor`; optional `name` | A JPEG of the window in front (or the next one down when A.D.R.I.A.N.'s own window is in front), of the window `name` matches, or with `monitor` of the whole screen that window is on. Refused while a full-screen app is in front, for games and programs that can't be identified, and for the app's own window (left out of `monitor` pictures). Windows are drawn with `PrintWindow(PW_RENDERFULLCONTENT)`, so a window partly covered still comes out whole; a black picture (DRM) is refused with a reason. Long side at most 1568 px, under 1 MB. |

The satellite's settings list which tools are on (`clipboard` and `screen`
included, both on by default), which power actions are allowed, and its own named shortcuts (for example a launcher script), which
`pc_apps open` can start. Nothing else on the PC can be run.

When no satellite is connected for the asker, every PC tool answers "no PC is
connected", so the model can say so. A PC app that doesn't know a tool yet
answers `Unknown PC action …`, which the server turns into "Your PC app needs
an update for that."

The model only calls `pc_clipboard` and `pc_screen` when the person asks about
what they copied or what's on their screen, never on its own; what either
returns is treated as data, not instructions.

### Pictures

A `pc_screen` result carries the picture in `action_result.image`. The server
checks it before the model sees it: `image/jpeg` or `image/png` only, at most
1.5 MB decoded (the base64 length is checked first), and the first bytes must
match the type. A picture that fails is dropped, and the result text says why,
so the model can say it couldn't see the screen. Frames are limited to 256 KB
until the satellite has been welcomed, and after that for everything except
`action_result`, which may be up to 2 MiB for this (256 KB for every frame in
0.15.5 and earlier). An oversized frame closes the connection with 1009.

Claude gets the picture as an image block inside the tool result, for the one
model call that follows; later tool rounds in the same answer carry only a
note that it was shown. An OpenAI-compatible model (the fallback) never gets
it: its tool result says the screen couldn't be read right now, so it says so
instead of guessing. Pictures are never logged, cached or kept in the
conversation memory, which holds only what was said.

## Quiet while gaming

The PC app looks at what's in front every 2 seconds: a program in a game's
install folder (Steam, Epic, Riot, Xbox and the usual launcher folders) or a
well-known game by name, or a full-screen app that isn't a browser or video
player. If Windows can't read the program in front but Steam says a game is
running, that counts too. It only reads the foreground window, its program and
Steam's `RunningAppID`; nothing touches the game. Playing starts after 5
seconds in a game and ends after 20 seconds out of one, so a moment in Discord
doesn't end it. The switch "Quiet while I play" in the app's settings (on by
default) turns this off on that PC.

While that PC is in a game, and `satellite.quietWhileGaming` is on:

- Every turn in that PC's room needs her name (or push-to-talk, or typing).
  There's no follow-up window after an answer, talking over her doesn't stop
  her ("stop" and her name still do), and she never answers side talk. After a
  bare "Adrian" ("Yes?") and after her own questions ("Restart the PC?") the
  next words are still taken.
- Answers there are kept to one short sentence, and she knows the game's name,
  so "am I in a game?" works.
- The Discord call is unaffected, and so are requests from the call that reach
  the PC.

What would reach the PC unasked, and what happens to it:

| what | while playing |
|---|---|
| Timers they set | Ring as usual: they set them to ring. |
| Reminders said at that PC | Held, and so is the DM that goes with every PC reminder (a Discord notification would pop up over the game). The DM goes when the reminder is released, worded as it was due ("late" if it was). |
| Reminders due while they're audible in her call | Said in the call, as usual. |
| Messages from other people (`message_member`) | Never spoken at a PC: they're a DM or an @mention in Discord, so nothing changes. |
| Answers to their own stop ("Okay.", a restart called off) | Said: they asked. |

When the game ends, held items come as one line: "While you were playing:"
and what they were, for one or two; for more, a summary ("...your laundry
reminder came up, and 2 reminders came up. Ask me if you want the details.")
with the details in her context for 30 minutes. If they're audible in her call
then, she says it there. Each held reminder's own DM goes out at the same
time, whether or not the line was heard: it's the record. A line that isn't
heard goes by DM too, for items whose DM didn't go.

Held items are kept per owner in `<state>/held-while-gaming.json`, at most 50
per owner (another one is said at once), and survive a restart. If the PC drops in a
game, they wait 2 minutes for it, even when another of the owner's PCs is
connected: back and still playing, they stay held; back and not playing, she
says them there; still gone, they go to another PC of theirs, or out the way
they would with no PC: their DMs, then her call if they're in it, else a DM
of what had none.
Anything held for 12 hours goes out that way too, even mid-game. After a
restart with nobody back, the saved ones go after 2 minutes the same way.
Items leave the file only once they have gone out, so a restart in the
middle of that sends them again (a DM that already went is not sent twice).

## PC and Discord together

These use the PC actions above, so they need nothing new from the PC app.
Everything goes to the asker's own PC; nobody can reach someone else's.

- **"Send that link to my PC"**, **"open that on my PC"**, **"put that video on
  my PC"**: "that" is the newest link, video or song from the last 30 minutes
  (`handoff.keepMinutes`): one you posted or she wrote you, one someone posted
  in a channel you can see (last 10 minutes), or the song playing in the call
  ("that song" means it, unless a song link is just as new). Two within 90
  seconds of each other and she asks which. "The one Sam sent", "my link" and
  "the reddit one" narrow it down. Only public `http`/`https` pages open.
- **Message Content.** Without that intent, Discord hides the words of every
  message that doesn't @mention her, links included. She says so when she
  finds nothing, and when there are newer messages she couldn't read.
- **"Play this on my PC instead"**, **"move the music to my PC"**: the call's
  song opens on your PC (its YouTube page; a Plex song is found on YouTube). It
  stops in the call if you started it, you're an owner, or whoever started it
  has left the call; otherwise it keeps playing there. If the PC can't open it,
  nothing stops. The rest of the queue isn't carried over.
- **"Put what I'm watching into the call"**: she asks the PC what's playing
  (`pc_media status`), finds it on YouTube (a song from Spotify or a player, a
  video from a YouTube tab) and plays it in the call, then pauses it on the
  PC. Netflix, Disney+, Prime Video, Twitch and the like can't be played. You
  have to be in the call, or an owner, and someone has to be there to hear it.
- **"Tell the call I'll be on in 5"**, **"ask them if they want to play
  Valorant"**: she says it in her voice call, starting with your name ("Alex
  says he'll be on in five"). When nobody's in a call with her, she posts it in
  a text channel instead (`handoff.tellCall.channelId`, else the one she last
  wrote in). No pings, links become plain words, 200 characters at most, 3
  every 5 minutes per person. If you're in the call yourself she won't repeat
  you. When your words didn't ask her to tell anyone, she reads it back first.
