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
| `action_result` | `id`, `ok`, `result` | Outcome of an `action`. `result` is text for the model. |
| `ping` | | Keep-alive; answered with `pong`. |

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
| `pc_windows` | `snap` (`side`: `left`, `right`, `top`, `bottom`, `top_left`, `top_right`, `bottom_left`, `bottom_right`), `maximize`, `restore`, `center`, `move`, `back`, `monitors`; optional `name`, `monitor` | Window layout. `name` finds the app like `pc_apps` does (its most recently used window, or the one whose title fits); without it, the window in front. `monitor` is `main`, `other` (only with two), `left`/`right`/`top`/`bottom`/`middle` by where the monitors sit, a number as Windows numbers them (the n of `\\.\DISPLAYn`), or the monitor's own name; `move` without it goes to the other one when there are two. Snaps fill the monitor's work area (around the taskbar, wherever it is) edge to edge in physical pixels, mixed DPI included. A snapped window keeps its half or quarter on another monitor, a maximized one stays maximized, any other keeps its size and spot. Nothing is activated, and nothing is raised over a full-screen window or a game in front. `back` undoes the PC's last change to that window (or to any window), kept in memory for the last 32 changes. Refused with a sentence: games, full-screen windows, windows on another virtual desktop, windows that aren't responding, admin windows, maximizing while something is full screen in front, and a monitor a full-screen game is on. Size limits are reported ("Discord can't get that narrow..."). `monitors` lists each monitor's number, role, position, name, resolution, scale and windows. PC apps from before this tool answer "Unknown PC action". |
| `pc_open` | one of `url`, `search`, `youtube` (with `play`), `spotify`, `folder` (downloads, documents, desktop, pictures, music, videos) | Opens in the default browser, Spotify or Explorer. `url` must be a public `http`/`https` address of at most 300 characters: no localhost, LAN names, IP addresses or `user@` parts (checked on the PC; apps from 0.15.2 and older take any `http`/`https` address). `search` and `play` end on the server: `search` becomes the `url` of the best web result, or a Google results page, and `play` swaps `youtube` for the top result's `video_id`. Spotify opens its own search page, or the web player without the app. |
| `pc_media` | `play_pause`, `play`, `pause`, `next`, `previous`, `stop`, `status`; optional `app` | Through Windows media sessions (Spotify, browsers, players). `app` picks a player or site by name, and a YouTube, Netflix or Twitch tab counts. Without it, pause, skip and stop go to what's playing, and play to the last one used. `status` says what's playing, and without `app` it lists every player. |
| `pc_volume` | `get`, `set` (`level` 0-100), `up`, `down`, `mute`, `unmute`; optional `app` or `playing` | Master volume, one app's volume ("mute Discord"), or with `playing: true` every app making sound that could be music or video ("turn my music down"). Games, Discord and other voice chat are left alone. PC apps before 0.15.4 ignore `playing` and change the master volume. |
| `pc_system` | `lock`, `screen_off`, `sleep`, `restart`, `shutdown`, `cancel_shutdown`; `confirmed` | `sleep`, `restart` and `shutdown` need `confirmed: true`, which isn't in the tool the model sees. The server drops any the model sends, and sets it only when the person's very next turn, in the same place and within 20 seconds, is a plain yes to the fixed question. Restart and shutdown wait 30 seconds and can be cancelled. Each can be turned off on the PC. |
| `pc_info` | `summary`, `processes` | CPU, memory, disk space, uptime, battery; the busiest programs. |

The satellite's settings list which tools are on, which power actions are
allowed, and its own named shortcuts (for example a launcher script), which
`pc_apps open` can start. Nothing else on the PC can be run.

When no satellite is connected for the asker, every PC tool answers "no PC is
connected", so the model can say so.
