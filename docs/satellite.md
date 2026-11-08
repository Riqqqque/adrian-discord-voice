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
| Reminders said at that PC | Held. The DM that goes with every PC reminder still goes at once, as the record. |
| Reminders due while they're audible in her call | Said in the call, as usual. |
| Messages from other people (`message_member`) | Never spoken at a PC: they're a DM or an @mention in Discord, so nothing changes. |
| Answers to their own stop ("Okay.", a restart called off) | Said: they asked. |

When the game ends, held items come as one line: "While you were playing:"
and what they were, for one or two; for more, a summary ("...your laundry
reminder came up, and 2 reminders came up. Ask me if you want the details.")
with the details in her context for 30 minutes. If they're audible in her call
then, she says it there. A line that isn't heard goes by DM (for items that
don't have one yet).

Held items are kept per owner in `<state>/held-while-gaming.json`, at most 50
(another one is said at once), and survive a restart. If the PC drops in a
game, they wait 2 minutes for it: back and still playing, they stay held; back
and not playing, she says them there; still gone, they go out the way they
would with no PC (her call if they're in it, else a DM of what had none).
Anything held for 12 hours goes out that way too, even mid-game. After a
restart with nobody back, the saved ones go after 2 minutes the same way.
