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
