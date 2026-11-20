# Roadmap, open items and known limitations

This page says where A.D.R.I.A.N. is heading, what is planned next, what is waiting on a decision, and what doesn't work well yet. It covers this repo (the Discord bot and the server side of the PC app) and the PC app in the main repo. The Rust household server's own design plan is in the main repo's [docs/ROADMAP.md](https://github.com/Riqqqque/A.D.R.I.A.N/blob/main/docs/ROADMAP.md).

State of the code: version 0.17.1 (2026-11-19). Page written 2026-11-20. Nothing here is a promise or a schedule. Items move when they are measured and built.

Related: [decisions.md](decisions.md) (why things are the way they are), [costs.md](costs.md), [architecture.md](architecture.md), [../CONTRIBUTING.md](../CONTRIBUTING.md) (how to change things safely).

## Contents

- [Vision](#vision)
- [Where things stand](#where-things-stand)
- [Planned work](#planned-work)
- [Waiting on a decision](#waiting-on-a-decision)
- [Built, but little used so far](#built-but-little-used-so-far)
- [Known limitations](#known-limitations)
- [Further out: the household server vision](#further-out-the-household-server-vision)
- [Taking on an item](#taking-on-an-item)

---

## Vision

A.D.R.I.A.N. is meant to be a personal assistant suite that you run yourself, and that other people can run too. It has three modules:

| Module | What it should be | Lives in |
|---|---|---|
| **Discord voice bot** | Sits in a voice call, answers "Hey Adrian ...", plays music, keeps alarms and notes, plays games, chats in text. | This repo. Runs in production. |
| **PC satellite** | A Windows tray app that is always listening, speaks back, controls the PC through safe typed actions, and shows a calm animated orb. Tiny when idle. | `crates/desktop` and `crates/pc-control` in the main repo. Its server side is in this repo. |
| **Household server** | Runs the home: Home Assistant, room-aware announcements and alarms, voice-recognized admin, long-term memory, cameras. | `crates/server` and `web/` in the main repo. A preview; not deployed. |

The principles behind all three:

- **Self-hosted first.** Each part can run locally or use a cloud service, mixed per part.
- **As cheap as possible to run**, with monthly spending caps that hold.
- **Security first.** The model acts only through narrow, typed tools. Anything with real consequences needs the person's own yes.
- **Private by default.** Side talk stays on your hardware, and transcripts aren't logged unless you turn that on.

How the plan changed: the first design (main repo roadmap, 2026-10-14) made the Rust household server the hub, with the Discord bot as its client. In practice the bot was built first, in TypeScript, and became the hub: the PC app talks to the bot, and the bot has its own memory, budgets, alarms and Home Assistant access. See [decisions.md](decisions.md#suite-layout).

## Where things stand

| Part | State | Notes |
|---|---|---|
| Discord bot | Released, 0.17.1. Public history from 0.13.0 (2026-10-16). | Voice, text chat, music, alarms, memory, home control over MCP, PC handoff, games. See [usage.md](usage.md). |
| PC app server side | In the bot, off by default (`satellite.enabled`). | One room per connected PC. Protocol in [satellite.md](satellite.md). |
| PC app (Windows) | Released with every bot release since 0.14.9. Updates itself. | See [pc-app.md](pc-app.md). |
| Household server (Rust) | An early preview. Maintained, with 157 tests, but not what runs in production. | The plans in the [main repo roadmap](https://github.com/Riqqqque/A.D.R.I.A.N/blob/main/docs/ROADMAP.md) still apply to it. |
| Old Rust satellite (`crates/satellite`) | Replaced by the PC app. | Removal is pending ([below](#waiting-on-a-decision)). |

---

## Planned work

These are concrete next items, in no fixed order. Expected savings come from a latency analysis of the turn pipeline on 2026-11-01 (maintainer measurement); treat them as estimates until re-measured.

### Faster answers

| Item | Expected gain | Notes |
|---|---|---|
| Let more tools say their own line (`Tool.speak`), skipping the second model call | 230-475 ms on the median; about 900 ms on answers where it applies | Already used by PC tools, alarms, reminders, notes, music (`play_music`, `music_control`), Steam, server control, the briefing, heads-ups, the recap and others. Still without it: `play_sound`, and the information tools (`web_search`, `get_time`, `weather`, `calendar`, `headlines`, `game_server_status`, the Plex and download tools), which return facts for the model to phrase. Each new one needs its bench rerun. |
| Answer exact short PC orders locally | about 360 ms median | Medium risk: these are exactly the orders the model routes, and words without her name may be side talk. |
| Handle "set a timer", "pause my music", "turn my music down" without the model | 1-2 s each | Must stay whole-utterance matches (see [decisions.md](decisions.md#phrases-answered-without-the-model-must-be-whole-utterances)). |
| Stream Speechify's audio instead of waiting for the whole line | about 0.15 s on the first sentence | Speechify sends first bytes at about 140 ms; the code waits for the whole line (about 290 ms). |
| Start the Groq re-transcription as soon as the local wake fires, for segments that aren't held | part of the Groq wait | Only for speech already judged for her, as now. Held PC segments already start it during the Smart Turn hold (`onHeldWords` in `src/app/stack.ts`). |
| Keep a warm TLS connection to the model provider | about 66 ms | Measured on a fresh connection. |
| A per-round `answer timing` log line | none (diagnostics) | Tool rounds and thinking were most of the gap between bench and live first-chunk times. |

Also rename or document `llmFirstChunkMs`: it means "first spoken sentence", through tool rounds, not the model's first token.

### Lower cost

These four are the cost plans [costs.md](costs.md) refers to:

1. **Answer more requests without the model.** Grow the local fast path in `src/conversation/intents.ts` and `local()` in `src/app/stack.ts`. The speed items above overlap with this.
2. **A small model for routine chat, a larger one only when needed.** Today there is one `brain` model, plus a `brain.background` model for automatic memory (0.16.0) and a `brain.fallback` for errors.
3. **Routing per capability** (chat, speech-to-text, voice, vision), with a strict-local option for each.
4. **Hard caps that fall back to local models** instead of pausing her when `limits.dailyUsd` or `limits.monthlyUsd` is reached.

Related open items:

- **Count everything the money is spent on.** The dollar ledger counts only model tokens. Speechify (it has its own character cap), Groq and Tavily are not in it, and fallback-model calls are priced at the primary's prices.
- **Trim the prompt.** A review on 2026-11-01 judged only 9 of 30 proposed cuts safe, because most rules trace to a real complaint. Low value: do it last, then rerun the real-model benches.

### Shorter answers

The word rule brought the median down, but on the real prompt (2026-11-01, `bench/answer-length.mjs --real`) the median answer was 34 words and 73% were over the 20-word target. The `--real` mode first needs to be brought in step with `src/app/stack.ts`: alarm tools, `ALARM_RULE` and the PC-from-Discord rules (`pcDiscord.rules`) are missing from it; `PC_RULE` and the PC tools are already there.

### The PC app

- **Rights at a PC.** Anyone talking near a paired PC is heard as its owner (a finding of the main repo's 2026-10-14 design review). The PC's own allowlist and the spoken yes for power actions are the stopgap. The long-term fix is per-speaker rights: speaker verification as a soft factor plus assurance levels (see [further out](#further-out-the-household-server-vision)).
- **Orb cost with the window open** at high refresh rates (120 Hz) hasn't been measured or tuned; the tray state is already near zero.
- **Speaker output**: a `try_lock` on the output path can play a moment of silence under contention.
- **Settings at the PC**: voice volume, speed, the music level and the queue reset when a PC reconnects, because PC rooms are built per connection. Open: keep them per device.
- **Game protection gaps** in `crates/pc-control` (the list in the main repo's `docs/pc-control.md`, "Known gaps"):
  - `pc_volume` with a named `app`, and the master volume, have no game check; only `playing: true` skips games;
  - `pc_system screen_off` broadcasts a system message to every top-level window, a running game's included;
  - `pc_apps show_desktop` minimizes every window, a game's included, without a game or full-screen check;
  - `pc_media` has no game check (it acts on media sessions only).

  Reconcile these with the "nothing that messages a running game" rule.
- **App index**:
  - games from Battle.net, Xbox, EA, Ubisoft and Rockstar folders have no launcher entry (they open by name only through the Start menu);
  - `Pc::refresh()` has no caller, so new installs appear only after the 10-minute rebuild.

### Home control

- **More Home Assistant domains, one at a time**: switches and scenes, climate, media players, covers. Locks and alarm panels come last, and only behind a stronger check than a spoken yes.
- **Locks over MCP**: until then, keep locks and alarm panels unexposed to the assistant in Home Assistant. The bot's MCP client asks first for calls that *name* a lock or door (`confirmWords` in `src/features/mcp.ts`), but it can't catch a call that names only an area.
- **Open MCP client gaps** (`src/features/mcp.ts`):
  - refresh tools on `tools/list_changed`;
  - support servers without a token;
  - apply the same URL rule as `helix.url` (https, or http only to a private address);
  - check every argument word for confirm words: today only the first 80 characters of the top-level strings (and one level of arrays) are checked (`argWords`), and deeper nesting is skipped.

### New features

- **A local fallback for the cloud listen (idea)**: Qwen3-ASR 0.6B was the best local alternative in the 2026-10-21 speech-model shootout, at about 2 GB of memory ([decisions.md](decisions.md#parakeet-v3-stays-the-speech-model)). It isn't wired in.

- **Android TV control**: pairing with a TV over the Android TV remote protocol, plus TV tools. In development; not part of any release yet.
- **Easy setup for non-technical users**: step-by-step guides for the server install, the Discord application (intents, invite), keys (including the free and local options), the PC app download and SmartScreen, updates, backups, uninstall, and a troubleshooting tree. They count as done when someone can follow only the guide in a clean container and end up with a working bot.

### Tests and benches

- `test/web.test.ts` fails under `--sequence.shuffle` (shared session state).
- Add a bench for tone (how she sounds), and complete the prefix that `bench/cache-check.mjs` covers.
- Benches hard-code the Claude Haiku model instead of following `brain.model`.
- `test-env/update-test.sh` hard-codes base version `0.1.0`; read it from the bundle.

### Small fixes

- **`adrian config`**: allow `server.allowedHosts` and `allowedGuilds` (today they need a hand edit of `config.json`, and the refusal gives a misleading reason).
- **`adrian satellite remove`** should drop a live PC connection at once, not at the next restart.
- **PC recordings**: setting `satellite.recordDays` back to 0 stops pruning recordings already on disk; prune them anyway.
- **State files**: give `reminders.json`, `notes.json`, `heads-up.json` and `weekly-recap.json` the same protection as `alarms.json`. Today an unreadable file starts empty and the next save replaces it.
- **`adrian doctor`** prints "limit 4096" for memory, while the unit's hard limit is `MemoryMax=5G`.
- **Stale comments**: fix the header comments that predate features (see [../CONTRIBUTING.md](../CONTRIBUTING.md)).

---

## Waiting on a decision

These are product calls, not engineering puzzles. Each has a working default today.

| Question | Today | What deciding involves |
|---|---|---|
| Use Smart Turn in Discord calls too? | PC rooms only (`satellite.unfinishedWaitMs`) | Fewer cut-off sentences in calls, for about 0.2 s more wait and more CPU per segment. Needs a bench on call audio. |
| Remove the old Rust satellite (`crates/satellite`)? | Kept; replaced by the PC app, shares nothing with it, known bugs | Don't fix it in the meantime. |
| Sign releases? | SHA-256 files from the same release | Signing would stop a hijacked publishing account from reaching every auto-updating server and PC. See [security.md](security.md). |
| Real Spotify playback? | Spotify links are read and played from YouTube | Needs the Spotify Web API, a Premium account and OAuth. |
| Speechify at 48 kHz? | Speechify audio is requested at 24 kHz (`RATE` in `src/speech/speechify.ts`) and resampled for the 48 kHz mixer | Quality against bandwidth and latency. |
| The Speechify voice for other languages? | English only; other languages use local Kokoro or Piper | Character budget, and how each voice handles the language. |

---

## Built, but little used so far

These paths have unit tests but little or no real-world use yet. Expect rough edges, and treat a report about them as likely real.

- **Alarms (0.17.0)**:
  - a ring in a Discord call;
  - the Stop and Snooze buttons in a DM;
  - `/alarm`;
  - a saved YouTube clip as the alarm sound;
  - raising quiet PC speakers for a ring.
- **0.15.6 features**:
  - moving windows across monitors with different scaling;
  - real screen captures;
  - quiet while gaming with real games;
  - Helix server control against a real server;
  - Steam wishlist field names;
  - a music quiz in a real call;
  - heads-up and weekly recap posts.
- **Commands**: the `/play` and `/music` slash commands and the typed `!` commands (0.15.7, 0.15.8).
- **Plex** as the music backup.
- **Docker mode**: `test-env/compose-test.sh` exists, but the issues below were found by reading the code and haven't been confirmed by a run:
  - `build.sh` takes the app from the bundle but the pins from the checkout, so an update can leave yt-dlp and Node behind;
  - a broken `config.json` takes the admin page off the published port;
  - a config that fails the schema still reports healthy;
  - the compose memory limit is 4g, about a GiB under the native unit's;
  - `compose-test.sh` skips music and isn't in releases.

---

## Known limitations

What doesn't work, or works with a catch, as of 0.17.1. Many of these have entries above.

### Listening

- **Some languages aren't caught**: Japanese and Vietnamese ways of saying the name don't wake her; say "Hey Adrian" first, then ask after her "Yes?". Chinese and Vietnamese speech is sometimes taken for English by Parakeet (4 of 11 in `bench/english-check.mjs`).
- **The name is partly hard-coded**: `listen.wakeName` renames the wake check only. Stop phrases with the name, the bare-name "Yes?", the CJK name forms, `MUSICISH`, the speech-recognition prompt and the brain prompt still say "Adrian". `nameVariants`, `greetings` and `allowBareName` aren't reachable from config.
- **Smart Turn and holds exist only at a PC**: Discord rooms use the plain VAD silence.
- **One Parakeet queue for every room**: with many speakers, decodes queue behind each other, with no priority for woken or PC clips.
- **Weak stops in group calls**: hold phrases and weak stops ("wait", "hold on", everyday words) are unreliable there.
- **Side talk at a PC**: it isn't always judged silent; a 2026-11-01 bench kept it silent about half the time. Side talk is also most of the server's CPU time.
- **Groq's free tier**: after a 429 the cloud listen pauses 60 s for everyone. Groq gets no language hint, and for non-English speech the Whisper second pass can override its text.
- **A friend called Adrian** (next release): questions to them ending in the name wake her loosely (a model call and a short music duck each), a question-shaped stop ("can you stop, Adrian?") stops the music, and a greeting with the name alone gets "Yes?". See [usage.md](usage.md#waking-it).
- **"Louder" without her name**: said as a follow-up while nothing plays, it usually gets no answer. `next` is missing from `MUSICISH`, though the model still routes it to music.

### Answers and cost

- **Answers run long** (median 34 words against a 20-word target at 0.17.1; about 22-30 words with the next release's rule, still over the target on `bench/answer-length.mjs --real`).
- **`brain.maxTokens` is not a real cap with Claude**: the adapter sends `max(2048, maxTokens * 4)` to leave room for thinking.
- **Caps are soft by one request**: they're checked before a request and the cost is added after, so the request that crosses a cap finishes. Per-person hourly counts reset on restart.
- **Prices at 0 make the dollar caps blind**: `brain.priceInPerM` and the other price keys must be set. The ledger misses Speechify, Groq and Tavily.
- **Conversation history is in memory**: a restart forgets conversations (notes, reminders and alarms persist).
- **Configs without `baseUrl`**: `brain.provider` defaults to `openai` while `brain.baseUrl` defaults to the Anthropic URL, so set `baseUrl` with an OpenAI-compatible provider.

### Voice and music

- **The cloud voice is English only.** Kokoro is serialized across all rooms, so several rooms talking at once queue behind each other.
- **Speechify characters are paid again on restart**: the short-line cache and a calibration line are re-fetched at each start.
- **YouTube can break**:
  - it changes and breaks yt-dlp every few weeks; the fix is a new pin and a release;
  - the direct YouTube Music search uses an undocumented API;
  - a bot check pauses YouTube for 30 minutes, and without Plex there is no music then.
- **Some songs are hard to find**: weak matches take 2-4 s longer, and some requests still miss (too far from the catalog, or no single upload under 15 minutes).
- **Music state isn't saved**: volume, queue, autoplay, voice volume and voice speed reset on restart, and per PC on reconnect.
- **The quiz takes the music**: a music quiz doesn't give back what was playing. PC music isn't counted in the weekly recap.

### Alarms, reminders and memory

- **Reminders are separate from alarms**: 20 per person, up to 31 days ahead, against 30 alarms and timers per person (alarms up to 366 days ahead, timers up to 7 days).
- **One household time zone**: only alarms have a per-person zone. Reminders, the calendar, weather, the briefing, heads-ups and the recap use the household `timezone`.
- **Automatic memory runs only after voice turns**: people who only use text or DMs never get learned notes.
- **The briefing lists reminders only**, not alarms or timers.
- **The calendar tool doesn't check who else is listening**, unlike the briefing. It is read-only: no adding events.
- **Heads-ups and the morning briefing** fire only when someone joins the Discord call, not when a PC connects.
- **An alarm can still be missed**: if the PC is asleep or off, the app isn't running and the person isn't in her call, only the DM reaches them.

### PC

- **Windows only.**
- **Anyone near the PC has the owner's rights** (see [above](#the-pc-app)). If the PC owner is also a bot owner, that includes owner-only powers elsewhere.
- **The satellite WebSocket is plain `ws`**: use a LAN, a VPN or a TLS reverse proxy. Tokens don't expire and there is no rotate command; remove the PC and pair it again.
- **The server trusts the PC's speech gate**: audio is accepted at any time after the welcome.
- **No echo cancellation** ([decisions.md](decisions.md#no-acoustic-echo-canceller-at-the-pc-a-full-duplex-gate-instead)).
- **`pc_open` limits**: raw IP addresses are always refused, public ones too. The DNS check resolves once, and the browser resolves again later. Addresses longer than 300 bytes, and names ending in .localhost, .local, .lan, .home, .internal, .intranet, .corp or .arpa, are refused (`MAX_URL`, `PRIVATE_SUFFIXES` in `src/satellite/tools.ts`, mirrored in `crates/pc-control/src/win/open.rs`).
- **The house guard is a word list**: from the next release an order has to sit right before the house thing, so "turn off the ceiling fan" or "lock the office door" isn't recognised and only the prompt keeps it off the PC; the same miss lets a PC action in the same sentence through. `pc_open`, `pc_windows` and `pc_screen` aren't guarded.
- **`pc_apps running` sends window titles to the model**: the first 60 characters of each, which can name documents or chats.
- **No CPU temperature**; GPU stats are NVIDIA only.
- **The exe isn't code-signed**: SmartScreen warns on first run.
- **Dev builds share the installed copy's state**: settings, alarms and the single-instance event. They also update themselves unless auto-update is off in their settings.

### Integrations and Discord

- **MCP**: streamable HTTP only, no resources or prompts. Every MCP tool counts as acting, so read-only answers also end follow-up listening.
- **Game servers are Minecraft Java only**; server control needs Helix 1.10 or newer.
- **Steam's Web API needs its key in the URL** (Steam's own requirement; its errors never carry the URL).
- **Without Discord's privileged intents, features degrade**: Message Content is needed for typed `!` commands without an @mention and for reading links from messages; Presence for game night; Server Members for full member lists.
- **One voice call at a time** across all servers.

### Operations

- **Linux x86_64 with glibc and systemd only.** The installer has only `--mode native` and `--profile recommended`; there is no ARM build.
- **Health proves less than it says**: it shows that she started and logged in. A voice failure and setup mode both count as healthy.
- **Admin sessions are in memory**: restarting logs the admin out. There is one admin account and no roles. Settings saved in the admin page need a restart.
- **The first update onto a release** runs the previous release's update checks (on the server and on PCs).

---

## Further out: the household server vision

These are the long-term plans from the main repo's design review (2026-10-14). They were written for the Rust household server. Several now apply to the bot as well, since it became the hub. Nothing here is being built right now.

- **Identity and admin**: a voice-recognized primary admin, with assurance levels per request (none, device, voice, code, session, console). Tools declare the level they need. Policy changes by conversation may only tighten. A break-glass CLI on the server holds the rights the model can never reach. Speaker verification (local voice embeddings) counts as a soft factor. This is the real fix for "anyone near the PC is its owner".
- **Rooms, people and groups**: "wake the kids at 6" plays only in their room. An `announce(target, text)` tool, local Piper speech on room speakers, and cheap room satellites over the Wyoming protocol.
- **Memory v2**: nightly dated summaries of what happened, local embeddings with `sqlite-vec`, and `recall(query, from, to, person)` that cites snippets. Also "forget this" and export.
- **Cost**: the fast path first, small model then large, per-capability routing with strict-local options, and caps that fall back to local models (the same four plans as [above](#lower-cost)).
- **Cameras**: Frigate as the vision backbone ("where did I leave my phone?" from detector events, with one vision call only when unsure). Face recognition local and opt-in.
- **Home Assistant**: one domain at a time, with locks and alarm panels only at voice assurance or higher.
- **Data safety**: scheduled backups with retention (daily for 7 days, weekly for 4 weeks, monthly for 12 months), and encryption of the whole database, not just the secrets.

Some of this exists in the bot in a simpler form:

| Plan | In the bot today |
|---|---|
| Home Assistant | Home control over MCP (0.16.0) |
| Memory | Per-person notes that update, plus automatic memory |
| Cost | A spend ledger with daily and monthly caps |
| Rooms | Rooms per Discord call and per PC |

---

## Taking on an item

1. Read [../CONTRIBUTING.md](../CONTRIBUTING.md) and the relevant entry in [decisions.md](decisions.md). Many limitations above are deliberate trade-offs, with the measurement that chose them.
2. Find the bench that measures the behavior ([development.md](development.md)). Run it before and after. Most prompt and routing changes need the real-model benches (`bench/pc-orders.mjs`, `bench/desk-followup.mjs`, `bench/answer-length.mjs`, `bench/music-follow-up.mjs`), which cost a little money.
3. Anything that touches the PC protocol must keep older PC apps working: add optional fields, never repurpose one ([satellite.md](satellite.md)).
4. When an item here is done, remove it from this page in the same commit, and add a [decisions.md](decisions.md) entry if you chose between real alternatives.
