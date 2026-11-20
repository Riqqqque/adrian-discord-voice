# PC satellite protocol

A PC satellite is the Windows PC app (see [pc-app.md](pc-app.md)). It gives
A.D.R.I.A.N. a microphone, a speaker and a window on a computer, and lets her
control that computer. It connects to this service, which does everything
else exactly as it does for Discord: speech detection and recognition, the
wake phrase, the language model, the voice, memory, tools and spend limits.

This page is the contract between the two sides: the connection, every
message in both directions, the PC actions and the rules both sides enforce.
The server side is `src/satellite/` in this repo. The PC side is
`crates/desktop` (the app) and `crates/pc-control` (the actions) in the main
[A.D.R.I.A.N repository](https://github.com/Riqqqque/A.D.R.I.A.N). Change
both sides together, and keep older PC apps working (see
[Changing the protocol](#changing-the-protocol)).

## Who it acts as

Each satellite is paired to one Discord user, its owner. Everything heard on
that PC is treated as that person talking: their memory, their rights, their
spend limits. Anyone else talking near the PC therefore speaks with the
owner's rights. Until voice identification exists, the limits on PC actions
(the allowlist in the PC's own settings, the spoken yes for power actions) are
the safeguard. See [security.md](security.md).

PC actions always go to a satellite owned by the person asking. From the
Discord call, a text channel or a DM, "open Spotify on my PC" reaches the
asker's own connected PC. No tool argument names a PC or a person, so nobody
can reach someone else's PC (`pcFor` in `src/app/stack.ts`). With two PCs
connected, the one the person is talking through wins, else the one whose last
frame arrived most recently (keep-alive pings count, so between two idle PCs
it can be either).

When the owner is also in the voice call the bot is in, and not muted or
deafened, the call hears the same words, so the call answers and the PC stays
quiet (its window shows "Answering in the Discord call."). Music and sounds
then play for everyone in the call, and PC orders ("pause Spotify", "open
Valorant") still reach the PC through the PC tools. Their requests in the call
get the same cloud speech-to-text as the PC (`cloudStt`). The PC takes over
again when the owner leaves the call, holds push-to-talk, or types in the
window (muted, see below). A stop said while the PC is busy stays with the PC.

While the owner is in a voice call and not deafened, their speakers play it,
so the PC's mic hears everyone in it, and everything a PC hears counts as its
owner. The PC app's echo gate only knows her own audio, not Discord's. So
then (muted in her call, or in any voice channel the bot can see in any of
its servers, whether or not her own voice link is up) the PC takes only
push-to-talk and typing in the window. Her name or alarm words said there get
"Your Discord call plays on this PC, so here I only take push-to-talk." in the
window, and a soft chime from the PC (`notice`, at most every 20 seconds), so
it's clear with the window closed. A stop still works by voice: it stops what
she's saying, music and sounds at the PC, and calls off a restart counting
down, but not an alarm. Deafened, or in no call, the PC takes speech as usual.
Disconnecting her from her call or moving the owner elsewhere doesn't lift
this: any channel the owner is in counts.

Not when the PC plays through headphones: apps from 0.17.2 tell the service
(`output`), from what Windows says about the default output or the "These
speakers are headphones" switch in the app's settings (many USB DACs and docks
say "speakers" whatever is plugged in). An app that doesn't say counts as
speakers. Calls the bot can't see (servers it isn't in, DM calls, other apps)
can't be told apart here, so headphones or push-to-talk are the safe setup.

Push-to-talk (apps from 0.17.2) covers everything said from the key going down
to it going up, pauses included, and nothing before or after: the press and
the release each cut what's being heard right then. Older apps only send the
press: the next thing said within 15 seconds is taken.

## Connection

One WebSocket per satellite, at `ws://<host>:<satellite.port>/satellite`
(default port 8791, address `satellite.bind`, default `0.0.0.0`). The service
speaks plain `ws` only. Frames are not encrypted, and the pairing token is in
the first one, so run it over a private network or a VPN, or put a TLS reverse
proxy in front. The PC app accepts `wss://` (an `https://` or `wss://` address
in its settings).

Text frames are JSON objects with a `type`. Binary frames are audio: PCM,
signed 16-bit little-endian, mono, 48 kHz (`SAT_RATE`), in both directions.

Turn the endpoint on with `sudo adrian config satellite.enabled true` and
restart. It also needs the state folder, where pairings are kept. The log
says `satellite server listening` with the address and port.

### Handshake

1. The PC opens the socket and sends `hello` within 5 seconds (`HELLO_MS`).
2. The service checks the token against `satellites.json` (SHA-256,
   constant-time compare).
3. Accepted: it sends `welcome`, raises the frame limit, and the PC becomes a
   room of its own (`sat:<deviceId>`). Rejected: it sends `denied` with a
   reason and closes with code 1008.

What counts as a failed attempt, per remote address: no `hello` within 5
seconds, a first frame that isn't a valid `hello` (binary, bad JSON, `null`,
another type) and a wrong token. Five failures lock that address out for 10
minutes (`MAX_FAILS`, `LOCKOUT_MS`). During a lockout a wrong token is closed
with 1008 "too many failed attempts" and no `denied`, and doesn't add to the
count. A connection that sends nothing within 5 seconds still counts during a
lockout (it gets `denied` "no hello") and restarts the 10 minutes, so an
address that keeps opening silent connections stays locked out. A correct token always gets in, even from a locked-out address: behind
a proxy every PC shares one address, and a stranger's guesses must not keep
the real PC out. A first frame over 256 KiB is closed with 1009 and isn't
counted.

One live connection per device: a new welcome for the same device
disconnects the old one.

### Limits and timers

| What | Value | Where |
|---|---|---|
| Time to send `hello` | 5 s | `server.ts` `HELLO_MS` |
| Lockout | 5 failures per address, 10 min | `server.ts` |
| Largest frame before `welcome` | 256 KiB | `SMALL_FRAME` |
| Largest frame after `welcome` | 256 KiB, except `action_result`: 2 MiB + 64 KiB | `SMALL_FRAME`, `MAX_FRAME` |
| Server keep-alive | WebSocket ping every 30 s; a socket that didn't answer the last one is dropped (so 30-60 s) | `server.ts` |
| PC keep-alive | JSON `ping` every 20 s; the link counts as lost after 40-60 s with nothing from the server | `link.rs` |
| `action` answer | 15 s (19 s for `pc_screen`), then "The PC didn't answer in time." | `connection.ts`, `tools.ts` |
| `action_result.result` | cut to 9000 characters | `connection.ts` |
| `text` | trimmed, cut to 2000 characters | `connection.ts` |
| `hello.version` | cut to 20 characters | `server.ts` |
| Picture | JPEG or PNG, at most 1.5 MB decoded | `images.ts` |

A frame over its limit closes the connection with 1009 "frame too big". The
per-socket limit before the welcome relies on a private field of `ws` 8
(`capFrames`); on another `ws` version only the per-message checks remain.

### PC to service

| type | fields | meaning |
|---|---|---|
| `hello` | `token`, `device`, `version` | First frame. `token` is the `sat_` pairing token. `device` is the PC's computer name; the service ignores it and uses the name it was paired with. `version` is the app version, which the service uses to tell old apps apart. |
| `speech_start` | | Someone started talking (the PC's loudness gate opened). |
| *(binary)* | PCM s16le mono 48 kHz | Microphone audio. The app sends it only between `speech_start` and `speech_end`, starting with 300 ms of audio from before the gate opened. The service doesn't enforce this: it takes audio any time after the welcome, and finds the exact speech itself (Silero VAD) and the wake phrase. A binary frame over 256 KiB closes the connection. |
| `speech_end` | | The gate closed. |
| `ptt` | `down`, optional `hold` | Push-to-talk, no wake phrase needed. `down: true, hold: true` (apps from 0.17.2): everything said until `down: false` is for her, and the press and the release each cut what's being heard right then; a key-up that never comes ends the press after 60 seconds. Without `hold` (older apps, which never send `down: false`): the next thing heard within 15 seconds is for her. While pressed it also keeps the Discord call off the owner's words, and for 3 seconds after. |
| `output` | `kind` (`headphones`, `speakers` or `unknown`) | What plays sound on this PC: sent after every `welcome` and whenever it changes (apps from 0.17.2). `headphones`: its mic can't hear a call playing there. Anything else, or never sent, counts as speakers. |
| `text` | `text` | A question typed in the window. Treated as said to her. A typed stop phrase also calls off a pending restart or shutdown. |
| `stop` | | The stop button or Escape: cancels every answer in that PC's room, stops sounds, and calls off a pending restart or shutdown. |
| `action_result` | `id`, `ok`, `result`, optional `image` | Outcome of an `action`. `ok` counts only when it is exactly `true`. `result` is text for the model. `image` (`pc_screen` only) is `{ mime, data }`: see [Pictures](#pictures). An unknown `id` is ignored. The only frame that may be over 256 KiB. |
| `ping` | | Keep-alive; answered with `pong`. |
| `activity` | `gaming`, optional `game` | A game is being played on this PC now, or no longer is. `game` is cleaned to letters, digits and ` .:'&+-!`, cut to 60 characters, and kept only while `gaming` is true. Sent when it changes and after every `welcome` while playing. See [Quiet while gaming](#quiet-while-gaming). |
| `alarm_action` | `action` (`stop` or `snooze`), optional `minutes` | Stop or Snooze pressed in the window or tray on an alarm the service is ringing. Her reply is spoken in that PC's room. |
| `alarm_done` | `id` (at most 40 characters), `base`, `action` (`stop` or `snooze`), `at`, optional `minutes` | An alarm this PC rang by itself and how it was answered there. Sent after a `welcome`, one per alarm, until delivered. Applied only if `base` is still that alarm's current occurrence. |

Before the `welcome`, the app sends only `hello`, its keep-alive `ping` and
an `ok: false` answer to any `action`; audio, typing, push-to-talk and the
rest wait for the welcome. Anything typed, pressed or recorded while offline
is dropped, never sent later: a stale "lock the PC" must not run minutes
afterwards.

### Service to PC

| type | fields | meaning |
|---|---|---|
| `welcome` | `name`, `owner` | Accepted. `name` is the name the PC was paired with; `owner` is the owner's display name. The app shows "Connected as `name`". |
| `denied` | `reason` | Rejected; the connection closes with 1008. `bad token` and `no hello` answer a hello; `unpaired` comes to a connected PC within 30 seconds of `adrian satellite remove`. |
| `mode` | `mode` | `thinking` while she works on an answer, `idle` after. No other value is sent (the type also lists `listening` and `speaking`, which are unused: the app learns those from `state`). |
| `state` | `speaking`, `listenMs` (either or both) | `speaking`: her voice is audible, as opposed to music only (the PC gets both as one stream, and only turns her voice down when you talk over it). `listenMs`: how much longer she takes words without her name there, 0 when she doesn't (always 0 while the PC takes only push-to-talk). Sent when either changes and after `activity` changes. |
| `transcript` | `who` (`you` or `her`), `text`, `final` | What was heard when it was for her, her answer as it grows (`final: false`) and when it's done, reminders, alarms, quiz lines, server announcements, and "Answering in the Discord call." |
| `notice` | `kind` (`ptt_only`) | Her name or alarm words were heard and left alone, because a call plays through this PC's speakers: the app plays a soft chime (apps from 0.17.2; older ones ignore it). At most every 20 seconds per PC. |
| *(binary)* | PCM s16le mono 48 kHz | Her voice, music and sounds, in real time: the room's 48 kHz stereo mix averaged to mono. |
| `audio_stop` | | Drop any audio still buffered (she was interrupted or stopped). |
| `action` | `id`, `name`, `args` | Do a PC action and answer with `action_result`. Ids count up per connection. |
| `alarms` | `ringing`, `list`, `snoozeMin`, `ringMin`, `now` | The owner's alarms. Sent right after `welcome`, on every change to that owner's alarms, and hourly. `ringing`: `[{ id, kind, label, base }]`, what the service is ringing now (its sound comes as ordinary audio); the app shows Stop / Snooze for it. `list`: `[{ id, kind, label, at, base, sound }]`, the enabled alarms not ringing now that are due within the next 8 days (`PC_AHEAD_MS`), without skipped days. `now` is the service's clock, so the app can correct for clock skew. |
| `pong` | | Answer to `ping`. |

What the app does with `alarms`: if an alarm in `list` is 20 seconds past due
and the service isn't ringing it, the PC rings it itself, whether or not the
link is up, until it's answered or `ringMin` minutes pass. If the link drops
while the service rings one, the PC keeps ringing it. A new `alarms` message
from the service stops any local ring (the service wins). Answers given to a
local ring go back as `alarm_done`.

### How the PC app handles the link

From `crates/desktop/src/link.rs`:

- Connect timeout 8 s; any single send is given 10 s.
- Reconnect waits 1, 2, 5, then 10 seconds. The wait goes back to 1 second
  only after a welcomed connection lasted 30 seconds (`HELD`), so two PCs on
  one token back off instead of replacing each other every second.
- After a refusal (`denied`, or a 1008 close before the welcome, which is how
  the lockout closes) it retries every 5 minutes, so it never feeds the
  lockout. `no hello` counts as a slow server, not a refusal. Saving new
  settings reconnects at once.
- An `action` that arrives before the `welcome` is refused with `ok: false`,
  "Not connected yet.": anything answering at that address could send one.
- On every disconnect: push-to-talk is released (it comes back only for a
  hotkey still held), playback is cleared, a ringing server alarm keeps
  ringing locally.
- Unknown message types are ignored, so new server messages are safe for old
  apps.

## Pairing

On the server:

```sh
sudo adrian satellite add "Desk PC" 123456789012345678   # name, owner's Discord user ID
sudo adrian satellite list                               # id, name, owner ID, date
sudo adrian satellite remove ID                          # ID, or the name
```

- `add` prints a token once: `sat_` plus 32 random bytes in base64url. The
  name is trimmed and at most 40 characters; the owner must be a Discord user
  ID (15-22 digits). Duplicate names are allowed.
- The service keeps only the token's SHA-256, in `<state>/satellites.json`
  (`{ devices: [{ id, name, owner, tokenHash, createdAt }] }`, mode 0600,
  written atomically).
- `remove` matches the ID or, case-insensitively, the name, and removes every
  device with that name. It doesn't drop a PC that is connected right now;
  restart the service for that. The token can't connect again, since every
  `hello` reads the file.
- Docker: `docker compose exec adrian node dist/cli/tool.js satellite-add "Desk PC" OWNER_ID`
  (also `satellite-list`, `satellite-remove`).
- There is no expiry and no rotate command: to change a token, remove the PC
  and add it again.

The PC stores its token encrypted with Windows DPAPI for the current Windows
user (see [pc-app.md](pc-app.md)).

## PC actions

The model has nine PC tools (`src/satellite/tools.ts`, `src/satellite/senses.ts`).
Each call is sent to the asker's own PC as an `action`. The PC checks it
against its own settings before doing anything, so a compromised or confused
server still can't do more than the PC allows. No PC action types or clicks
into other programs, kills a process, or starts anything other than installed
apps and games and the PC's own shortcuts.

Games: running games are never closed, focused, minimized, moved or pictured,
and programs the PC can't identify are treated as games. `pc_volume` with
`playing: true` never touches games or voice chat. Three actions have no game
check: `pc_apps show_desktop` (the shell's Show desktop toggle minimizes every
window), `pc_system screen_off` (a broadcast message every window receives),
and `pc_volume` with a named `app`, which changes that app's mixer level.

| tool | `action` values / args | notes |
|---|---|---|
| `pc_apps` | `open`, `close`, `focus`, `minimize`, `running`, `show_desktop`, `list`; `name` | Apps from the Start menu (desktop and Store apps), Steam, Epic and Riot games, and the PC's own shortcuts. Ambiguous names come back as a list to choose from. `list` finds installed apps or games by name; with no name it lists the games. `close` asks the window to close (`WM_CLOSE`), it never kills. `running` lists programs with the first 60 characters of each window title. |
| `pc_windows` | `snap` (`side`: `left`, `right`, `top`, `bottom`, `top_left`, `top_right`, `bottom_left`, `bottom_right`), `maximize`, `restore`, `center`, `move`, `back`, `monitors`; optional `name`, `monitor` | Window layout. `name` finds the app like `pc_apps` does; without it, the window in front. `monitor` is `main`, `other` (only with two), `left`/`right`/`top`/`bottom`/`middle` by where the monitors sit, a number as Windows numbers them (the n of `\\.\DISPLAYn`), or the monitor's own name; `move` without it goes to the other one when there are two. Snaps fill the monitor's work area edge to edge in physical pixels, mixed DPI included. Nothing is activated, and nothing is raised over a full-screen window or a game in front. `back` undoes the last change to that window (or any window), from the last 32 kept in memory. Refused with a sentence: games, full-screen windows, windows on another virtual desktop, windows that aren't responding, admin windows, maximizing while something is full screen in front, a monitor a full-screen game is on, and anything while an exclusive full-screen app runs. |
| `pc_open` | one of `url`, `search`, `youtube` (with `play`), `spotify`, `folder` (`downloads`, `documents`, `desktop`, `pictures`, `music`, `videos`) | Opens in the default browser, Spotify or Explorer. `url` must be a public `http`/`https` address of at most 300 bytes: no `localhost`, LAN names, IP addresses or `user@` parts. `search` and `play` are resolved on the server (below). Spotify opens its own search page, or the web player without the app. |
| `pc_media` | `play_pause`, `play`, `pause`, `next`, `previous`, `stop`, `status`; optional `app` | Through Windows media sessions (Spotify, browsers, players), never key presses. `app` picks a player or site by name; a YouTube, Netflix or Twitch tab counts. Without it, pause, skip and stop go to what's playing, and play to the last one used. `status` says what's playing; without `app` it lists every player. |
| `pc_volume` | `get`, `set` (`level` 0-100), `up`, `down` (default step 10), `mute`, `unmute`; optional `app` or `playing` | Master volume, one app's volume ("mute Discord"), or with `playing: true` every app making sound that could be music or video ("turn my music down"); games, Discord and other voice chat are left alone. |
| `pc_system` | `lock`, `screen_off`, `sleep`, `restart`, `shutdown`, `cancel_shutdown` | `sleep`, `restart` and `shutdown` need the person's spoken yes (below). Restart and shutdown wait 30 seconds and can be cancelled. Each can be turned off on the PC. |
| `pc_info` | `summary`, `processes`, `health` | CPU, memory, disk space, uptime, battery; the busiest programs. `health` ("why is my PC slow?") takes one 250 ms sample: CPU load and the busiest programs, memory and its biggest users, NVIDIA GPU load, video memory and temperature (through the driver's NVML library, loaded only for the call; other GPUs: "GPU stats aren't available"), free space per drive, and a one-line verdict first ("Nothing's struggling."). CPU temperature is never reported: Windows only shows it to admin tools. Closing a hog is `pc_apps close`, which the model only offers. |
| `pc_clipboard` | `read` | The clipboard's text, up to 8000 characters, with a note when cut. Refused, without reading it, when a password manager marked it (`ExcludeClipboardContentFromMonitorProcessing` or `Clipboard Viewer Ignore` formats, or `CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` set to 0). Images and copied files are only described ("an image", "3 copied files"). |
| `pc_screen` | `window` (default), `monitor`; optional `name` | A JPEG of the window in front (or the next one down when A.D.R.I.A.N.'s own window is in front), of the window `name` matches, or with `monitor` of the whole screen that window is on. Refused while a full-screen app is in front, for games and programs that can't be identified, and for the app's own window (hidden from `monitor` pictures). Windows are drawn with `PrintWindow(PW_RENDERFULLCONTENT)`, so a partly covered window comes out whole; an all-black picture (DRM) is refused with a reason. Long side at most 1568 px, aimed under 1 MB. The reply names the app, never the window title. |

The PC's settings say which tools are on (all on by default), which power
actions are allowed, and its own named shortcuts (an `.exe`, `.lnk`, `.bat`,
`.ps1` or URL), which `pc_apps open` can start. The service can't change them.
A tool turned off answers "That's turned off in this PC's settings."

When no satellite is connected for the asker, every PC tool answers "No PC is
connected for ..." so the model can say so. A PC app that doesn't know a tool
answers `Unknown PC action <name>.`, which the server turns into "Your PC app
needs an update for that."

The model only calls `pc_clipboard` and `pc_screen` when the person asks about
what they copied or what's on their screen, never on its own, and treats what
either returns as data, not instructions (`SENSES_RULE`). That is a prompt
rule; the hard limits are the PC's settings and the spoken yes.

### What the server does before sending

- `confirmed` is not in any tool schema the model sees, and the server deletes
  it from every call.
- `pc_open search`: the server looks up the best web result (Tavily
  `topResultUrl`, when a search key is set). If that result passes the
  server's own address check it becomes `url`; otherwise `url` is a Google
  results page. `pc_open youtube` with `play: true`: the server finds the top
  video and sends `video_id` instead. The PC never sees `search` or `play`.
- Every `url` is checked on the server (`webUrl`) before it is sent: http or
  https, at most 300 bytes, a plain host name of letters, digits, dots and
  dashes with at least two labels, a last label that doesn't start with a
  digit and isn't `localhost`, `local`, `lan`, `home`, `internal`,
  `intranet`, `corp` or `arpa`. That rules out IP addresses, `user@` parts,
  backslashes and percent escapes. A failing address gets "Only public http
  and https web addresses can be opened." and never reaches the PC. The PC
  runs the same check (`web_url` in `crates/pc-control/src/win/open.rs`) and
  then resolves the name and refuses it if any address is loopback, private,
  link-local or CGNAT. Change the two checks together.
- Timeouts: 15 seconds per PC tool; 20 seconds for `pc_open` (its action
  still has 15) and `pc_screen` (its action has 19).
- Spoken confirmations: when every tool in a round returns a line ("Spotify's
  open.", "Closing Discord.", "Opening example.com.", "Paused.", "Locked.",
  volume levels with "percent"), she says it and skips the second model call.
  Failures, lookups (`pc_apps running`/`list`, `pc_windows monitors`,
  `pc_media status`), `pc_info`, `pc_clipboard` and `pc_screen` go back to the
  model.
- Anything that acts ends the follow-up listening after that answer.
- `pc_info health` on apps older than 0.15.6 (known from `hello.version`)
  gets the plain summary plus "Their PC app needs an update for the full
  health check."

### Power actions: the spoken yes

`sleep`, `restart` and `shutdown` (`NEEDS_YES` in `tools.ts`):

1. The first call returns a fixed question ("Put the PC to sleep?", "Restart
   the PC?", "Shut down the PC?"). She says it word for word and the turn ends.
2. Only the person's very next turn, in the same place (same person and
   room), within 20 seconds, can confirm it. It must be a plain yes: no
   question mark, at most 5 words, starting with a yes phrase, every word from
   the yes set or the action's own words ("yes restart it").
3. Only then does the server set `confirmed: true` and send the action.

The PC refuses those three without `confirmed` on its own, and each has its
own switch in the PC's settings. Restart and shutdown run `shutdown.exe` with
a 30-second delay. During those 30 seconds a stop phrase ("cancel", "stop")
from that person in any room, the window's stop button, or a typed stop sends
`cancel_shutdown` to the PC that took the order, and she says "Cancelled." or
"I couldn't cancel it."

Never test these with `confirmed: true` on a real machine.

### Pictures

A `pc_screen` result carries the picture in `action_result.image`. The server
checks it before the model sees it (`src/satellite/images.ts`): `image/jpeg`
or `image/png` only, at most 1.5 MB decoded (the base64 length is checked
first), valid base64, and the first bytes must match the type. A picture that
fails is dropped, and the result text says why, so the model can say it
couldn't see the screen.

Claude gets the picture as an image block inside the tool result, for the one
model call that follows; later tool rounds in the same answer carry only a
note that it was shown. An OpenAI-compatible model (the fallback) never gets
it: its tool result says the screen couldn't be read right now. Pictures are
never logged, cached or kept in the conversation memory, which holds only what
was said. See [costs.md](costs.md) for what a picture costs.

### Which PC app version has what

The server reads `hello.version` and adapts. Older apps keep working; a
feature they lack is answered with "needs an update", or isn't used.

| PC app | Adds |
|---|---|
| 0.15.0 | Self-update from GitHub releases |
| 0.15.1 | Reads `state`: ducks only her voice, orb shows listening and speaking from the server |
| 0.15.3 | Checks `pc_open` addresses on the PC too (0.15.2 and older open any http/https address the server sends; the server's own check covers every version) |
| 0.15.4 | `pc_volume playing`; DNS check for `pc_open`; refuses `action` before `welcome` |
| 0.15.6 | `pc_windows`, `pc_info health`, `pc_clipboard`, `pc_screen`, `activity` (quiet while gaming) |
| 0.17.0 | `alarms`, `alarm_action`, `alarm_done`: Stop/Snooze in the window and tray, and the backup ring |

Apps before 0.15.6 never send `activity`, so the service treats them as not
playing. Apps before 0.15.4 ignore `playing` and change the master volume.

## Quiet while gaming

The PC app looks at what's in front every 2 seconds: a program in a game's
install folder (Steam, Epic, Riot, Battle.net, Xbox and the usual launcher
folders), a well-known game by name, or a full-screen app that isn't a
browser, video player or Store app. If Windows can't read the program in
front but Steam says a game is running, that counts too. It only reads the
foreground window, its program and Steam's `RunningAppID`; nothing touches
the game. Playing starts after 5 seconds in a game and ends after 20 seconds
out of one, so a moment in Discord doesn't end it. The switch "Quiet while I
play" in the app's settings (on by default) turns this off on that PC.

While that PC is in a game, and `satellite.quietWhileGaming` is on (default):

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
| Timers and alarms they set | Ring as usual: they set them to ring. |
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

Held items are kept in `<state>/held-while-gaming.json` (mode 0600), at most
50 per owner and 500 in all (past that, a new one is said at once), and
survive a restart. A newly connected PC gets 5 seconds to say it's in a game.
If the PC drops in a game, they wait 2 minutes for it, even when another of
the owner's PCs is connected: back and still playing, they stay held; back
and not playing, she says them there; still gone, they go to another PC of
theirs, or out the way they would with no PC: their DMs, then her call if
they're in it, else a DM of what had none. Anything held for 12 hours goes
out that way too, even mid-game. After a restart with nobody back, the saved
ones go after 2 minutes the same way. Items leave the file only once they
have gone out, so a restart in the middle of that sends them again; a DM that
already went is not sent twice.

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
  every 5 minutes per person (`handoff.tellCall.*`). If you're in the call
  yourself she won't repeat you. When your words didn't ask her to tell
  anyone, she reads it back first.

## Each PC is a room

A connected PC gets its own mixer, voice settings, music player, sound player
and conversation controller. Talking at the PC doesn't interrupt the Discord
call, and music, sounds, the music quiz, alarms and reminders asked for
through a PC play on that PC. When the connection closes, that room's answers
are cancelled, its music stops and the room is removed, so a PC's queue, music
level, voice volume and speed reset on every reconnect.

Listening differs from the Discord call in a few ways (`src/app/stack.ts`):

| | PC room | Discord call |
|---|---|---|
| Follow-up window (no name needed after an answer) | 20 s | 8 s |
| Talking over her stops her after | 600 ms | 2.5 s |
| Silence that ends speech | `listen.minSilence`, at least 0.8 s | `listen.minSilence` (default 0.5 s) |
| Wait for a sentence that sounds unfinished (Smart Turn) | up to `satellite.unfinishedWaitMs` (default 1200 ms) | none |
| Early listen: recognize (and start the cloud listen) 0.32 s into the pause, used only if the full wait closes the same audio (`satellite.earlyListen`) | yes, by default | none |
| Cloud second listen (`cloudStt`) | yes, when enabled | only for PC owners whose PC is connected, or everyone with `cloudStt.rooms all` |

At a PC, bare "pause", "skip", "what's playing" and "turn it down" go to
`pc_media` and `pc_volume` unless her own music is playing in that room.

## Logs and recordings

`pc heard` is always logged for PC rooms, without words: length, woke,
for-her, how the segment closed, turn-check and hold times, and `early: true`
when the words came from the early listen (`satellite.earlyListen`, in the table above).
`satellite disconnected` says how each link ended: `by` (`pc`, `heartbeat`,
`replaced`, `shutdown`, `server`), the close `code` and `reason`, `linkS` (how
long the link lasted) and `quietS` (how long the PC had been silent). The two options
below are off by default; both record what people said, so treat them as
personal data.

- `satellite.logTranscripts true` adds the words to `pc heard` for speech
  judged meant for her (her name, push-to-talk, or the follow-up window, even
  if she then stays silent), and logs `pc stt` (local and cloud words),
  `pc answer` (what was asked and said) and `pc action` (tool, arguments,
  first 200 characters of the result). Clipboard text and screen contents
  never reach the log: a clipboard result is logged by its first line only,
  screen results lose window titles, and her answers after either are logged
  by length only for the rest of that conversation.
- `satellite.recordDays` (0-14, default 0) keeps 16 kHz WAV recordings of
  requests made at a PC (only speech already judged for her) in
  `<state>/pc-recordings/YYYY-MM-DD/`, with an `index.jsonl` line of what each
  listener heard, and deletes them after that many days. Setting it back to 0
  stops the pruning too: delete old recordings by hand.

## Changing the protocol

- New message, either way: handle it in `connection.ts` `onJson` with type
  checks and length caps (anything that reaches a prompt is cleaned like
  `parseActivity`), add it to `SatelliteEvents`, wire it in `stack.ts`
  `onConnect`, and test it in `test/satellite.test.ts`. On the PC: the
  `session` match and `Cmd` in `crates/desktop/src/link.rs`, with a test using
  its local WebSocket helpers.
- Additive only. Never require a new field, never repurpose an old one.
  Older apps ignore unknown messages; the server learns the app version from
  `hello` and must degrade for old apps.
- New PC tool or action: `NAMES` and `specs` in `tools.ts` (or `SENSES_SPECS`),
  decide whether it is a lookup, its spoken confirmation and its timeout, and
  mention it in `PC_RULE` if the model needs guidance. On the PC: the policy
  flag, `allowed()` in `crates/pc-control/src/lib.rs`, the implementation in
  `win/`, and the toggle in the app's settings. Update this page and
  `bench/pc-orders.mjs`.
- Kept in step across the two repos: `webUrl` and `web_url`; the 30-second
  power-down delay (`POWER_DOWN_MS`, `DELAY_SECS`); picture size
  (`MAX_IMAGE_BYTES`, `TARGET_BYTES`, `MAX_SIDE`); the clipboard limit; result
  wording the server parses (`Unknown PC action`, the `(app|game|shortcut)`
  suffix of `pc_apps open`, the clipboard header line, the `pc_screen` reply).
- Never: let the server change the PC's policy, pass `confirmed` from model
  arguments, let a tool argument pick a device or a person, or add anything
  that types into, hooks or messages a running game.

Tests: `test/satellite.test.ts` (pairing, lockout, frames, bad frames, actions,
URL rule, power yes, cancel window), `test/pc-senses.test.ts`,
`test/quiet.test.ts`, `test/recorder.test.ts`, `test/pending-yes.test.ts`, and
the PC-related groups in `test/stack.test.ts`. PC side: `cargo test -p
adrian-desktop` and `cargo test -p adrian-pc-control` in the main repo.
