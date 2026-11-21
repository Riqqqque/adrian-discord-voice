# Development

The hands-on companion to [CONTRIBUTING.md](../CONTRIBUTING.md): how to set up a checkout, build, test, run the bot, read its logs, bench it, and ship a bundle. Read CONTRIBUTING.md first for what is safe to change and what guards it.

## Requirements

| Need | For |
|---|---|
| Node.js 22.12+ (production runs the 22.23.4 pinned in `packaging/downloads.sh`), 24, or 26+, and npm | everything. `engines.node` is `>=22.12.0`, but vitest 5 (`^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`) does not run on Node 23, 25 or anything below 22.12. |
| Linux x86_64 with glibc | running the bot with its speech models, benches that load them, and building release bundles. Typecheck and unit tests also run on Windows and macOS. |
| `ffmpeg` on `PATH` | music, sound effects, alarm clips. Without it the bot runs but music stays off. |
| bash, tar, gzip (and xz) | the shell-script suites in `test/packaging.test.ts`. On Windows they look for Git Bash at `%ProgramFiles%\Git\bin\bash.exe`; without it those suites are skipped. |
| Docker | container tests in `test-env/` and the Docker images |
| Python 3 venv | only the `.py` benches |

## First setup

```bash
npm ci            # postinstall runs scripts/patch-voice.mjs
npm run typecheck # tsc --noEmit
npm test          # vitest run
npm run build     # TypeScript -> dist/
```

- `npm ci` patches `@discordjs/voice` 0.19.2 for discord.js issue #11653 (if the bot joins while someone is talking, that person's audio never decrypts). The patch exits non-zero, failing `npm ci`, if the installed version isn't exactly 0.19.2 or the target line doesn't match exactly once. Upgrading that package means re-checking the issue and the patch; `test/patch.test.ts` asserts it applied to both builds.
- `onnxruntime-node` (used for Smart Turn) downloads CUDA libraries during install unless you set `ONNXRUNTIME_NODE_INSTALL=skip`. `packaging/package.sh` sets it; you can too (`ONNXRUNTIME_NODE_INSTALL=skip npm ci`).
- Generate `package-lock.json` on Linux, the deploy target, so it matches what the bundle installs.
- Dependencies are pinned to exact versions. A new dependency must not download platform binaries at install time, and you should check what it adds to the bundle size.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` |
| `npm test` | `vitest run` over `test/*.test.ts`; `vitest.config.ts` sets a 20 s test and 30 s hook limit (files that need more set it themselves). `package.sh` doesn't copy it, so the bundle's own run keeps vitest's 5 s default, and the suite passes with `--testTimeout=5000` |
| `npx vitest run test/alarms.test.ts` | one file |
| `npx vitest run test/stack.test.ts -t "a ringing alarm"` | one `describe` or `it` by name |
| `npm test -- --maxWorkers=2` | what `package.sh` runs; use it on small machines |
| `npm run build` | compile to `dist/` (benches and the CLI helper run from there) |
| `npm run build`, then `npm run poc -- <config.json>` | the old transport proof of concept (`src/poc/main.ts`, run from `dist/poc/`): join under DAVE, receive per-user audio, play the config's `testClip` if set (`assets/test-clip.ogg` is one), survive reconnects |

TypeScript is strict, with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noImplicitOverride` on, `module` and `moduleResolution` set to `NodeNext`. Imports between source files use `.js` suffixes.

## Tests

- CI (`.github/workflows/ci.yml`, next release): on every push and pull request to `main`, one job on Ubuntu 24.04 with the Node version `packaging/downloads.sh` ships: `npm ci`, `npx tsc --noEmit -p .`, `npx vitest run` (with `LD_LIBRARY_PATH` at the sherpa-onnx addon). Read-only permissions, no secrets, nothing that releases or publishes. It covers no real models, keys, benches or the container tests. `packaging/package.sh` still runs the suite at release time.
- Tests wait for what they check (`vi.waitFor`, a server's "listening" line, a free port) instead of fixed sleeps, so a busy machine makes them slower, not red. Keep it that way in new tests.
- 105 files in `test/`, all vitest. Run `npm test` for the current count; counting `it(` lines undercounts because `it.each` rows expand.
- `test/latency-harness.test.ts` is skipped unless `LATENCY_HARNESS=1`. It drives the real stack with stand-in models at production-like delays and reports end of speech to first audio per scenario: `LATENCY_HARNESS=1 LATENCY_RUNS=3 LATENCY_STT_MS=300 npx vitest run test/latency-harness.test.ts` (about 20 minutes, mostly real-time audio; needs Silero and Kokoro from `ADRIAN_MODELS` and skips with a message without it; `test/early-listen-silero.test.ts` needs it too; `LATENCY_TABLE`, `LATENCY_OUT` and `LATENCY_DEBUG=1` write more).
- They need no network, no speech models and no keys. Some open local sockets (real `ws` servers, a local HTTPS server in `test/packaging.test.ts`).
- `test/stack.test.ts` drives the real `startVoiceStack` with a fake Discord client, a mocked listening pipeline, a mocked satellite server and stubbed HTTP. It is the place for behavior that crosses modules (rooms, costs, stops, follow-ups, PC requests, alarms ringing).
- `test/packaging.test.ts`, `test/packaging-update.test.ts` and `test/packaging-update-checks.test.ts` (sharing `test/packaging-shell.ts`, split so they run in parallel) run the real shell scripts (`packaging/adrian` restore and update, the `downloads.sh` helpers, `package.sh`) in bash with stubbed `id`, `systemctl` and friends, and checks `install.sh` and the unit files as text. `test/install.test.ts`, `test/get.test.ts` and `test/update-safety.test.ts` run `install.sh`, `get.sh` and `adrian update` the same way (stand-ins for systemctl, curl, df and so on in `test/install-stubs.sh`); `ADRIAN_PACKAGING_UNDER_TEST=dir` points them at another copy of `packaging/`. Three update-safety cases (flock, setsid) run only on Linux.
- `test/web-ui.test.ts` runs the real `web/app.js` in a fake DOM (`node:vm`) against a fake API.
- Skips: the bash suites skip without bash, tar and gzip; "the Node runtime" suite also needs `xz`; `test/config-file.test.ts` skips its umask test on Windows; "stop with an error when the server goes silent" in `test/packaging.test.ts` runs only with `ADRIAN_SLOW_TESTS=1` (it waits out curl's 60 s stall limit).

Writing tests:

- Use made-up IDs, names and documentation addresses (`192.0.2.x`, `example.com`). Never a real person, server, LAN address or host name. Some older tests still use the maintainer's public author name as a sample speaker; don't copy that into new ones.
- Build token-shaped fakes from parts at runtime (GitHub push protection rejects token-shaped literals). `test/web.test.ts` shows the pattern.
- Prefer a test in the file that already owns the area (see the area table in CONTRIBUTING.md). Behavior that only shows when the whole stack is wired goes in `test/stack.test.ts`.
- Some tests assert exact reply strings. If you change wording, update the test in the same change.

## Known tool quirks

- **One `tsc` error when `onnxruntime-node` is missing.** If `onnxruntime-node` isn't installed in your checkout (this has happened on Windows), `tsc` reports that it can't find the module at the dynamic `import('onnxruntime-node')` in `src/speech/smart-turn.ts`. That one error is expected there; any other error is real. A full typecheck on Linux (as `package.sh` runs it) has none.
- **vitest leaves a cache in `node_modules`.** vitest 5 writes `node_modules/.vitest-cache` even with `--no-cache`. It's harmless; `package.sh` deletes `node_modules/.vite*` before packing.
- **`test/web.test.ts` has been reported to fail under `--sequence.shuffle`** (tests share session state). Run it in order.
- **Worker files only work from `dist/`.** Smart Turn (`src/speech/smart-turn-worker.ts`) and calendar expansion (`src/features/calendar-worker.ts`) start ESM workers by `.js` URL. Tests run the calendar code inline from `.ts`, so a worker problem shows only in a built copy. After touching either, build and run once.
- **Shell edits can damage source.** Shell heredocs and some editors have turned `\b` in a regex into a literal backspace, damaged `\d`, and turned `\n` inside TypeScript strings into real newlines. After any shell-based edit, check the diff for control characters.
- **Byte order marks.** Windows PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM. Don't write repository files that way; use an editor or `sed`.
- **ffmpeg reads stdin.** In a script fed to a remote shell on stdin (`ssh host 'bash -s' < script`), an `ffmpeg` call eats the rest of the script. Add `-nostdin`.

## Running from a checkout

The bot needs the speech models. The installer gets them with `packaging/downloads.sh`; you can do the same by hand (Linux x86_64):

```bash
mkdir -p ~/adrian-data/models /tmp/adrian-dl
bash -c '. packaging/downloads.sh; install_models ~/adrian-data/models /tmp/adrian-dl'

npm run build
export ADRIAN_CONFIG=~/adrian-data/config.json ADRIAN_STATE=~/adrian-data/state ADRIAN_MODELS=~/adrian-data/models
export LD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-linux-x64
node dist/app/main.js   # admin page on http://127.0.0.1:8790/
```

- Set `ADRIAN_DOWNLOAD_CACHE=/some/dir` to reuse files you already downloaded (each is still checked against its pinned SHA-256).
- On first start there is no admin account: the process writes a one-time setup code to `<state>/setup-code`. Print it with the Node helper, using the same environment:

  ```bash
  node dist/cli/tool.js setup-code
  ```

  Then open the admin page, claim it, and walk through the wizard (Discord token, server and voice channel, language model, search, voice, limits). The wizard writes `config.json` and `secrets.env`; settings apply on the dashboard's Restart.
- The same helper covers everything the installed `adrian` command does with config and secrets: `node dist/cli/tool.js config KEY [VALUE]` (VALUE `null` removes it), `secret-set NAME` (value on stdin), `secret-delete NAME`, `secret-list`, `setup-code [--new]`, `reset-admin`, `check`, `port`, `voice [NAME [SPEED]]`, `satellite-add NAME OWNER_ID`, `satellite-list`, `satellite-remove ID|NAME`. Restart the process after a change.
- **Never run a development copy with the same bot token as an installed service.** Two processes fight over the voice connection. Stop the service first, or use a separate test bot application and a test server.
- Admin sessions are kept in memory, so every restart logs you out of the admin page. Conversation history, music queues and pasted links are memory-only too; notes, reminders, alarms and the spend ledger persist under the state folder.
- Discord privileged intents (Message Content, Server Members, Presence) change what works. The bot reads the application's flags at start and asks only for intents that are on, so login never fails on them; without Message Content, typed `!` commands work only after an @mention and channel history isn't read.

### Working with the PC app

To test the satellite side against a PC app:

```bash
node dist/cli/tool.js config satellite.enabled true    # listens on 0.0.0.0:8791 by default
node dist/cli/tool.js satellite-add test-pc <your Discord user id>   # prints the token once
```

Restart, then pair the PC app: paste the server address (port 8791) and the token into its settings, or run it with `--pair <server address> <token>` (see [pc-app.md](pc-app.md)). Pairing replaces that PC's existing pairing, so don't do it on a PC that is paired to a real server you care about. The plain WebSocket carries the token and audio unencrypted; keep test traffic on a trusted network or behind TLS. The PC side and its tests live in the main repo (`cargo test -p adrian-pc-control`, `cargo test -p adrian-desktop`). Protocol changes must stay compatible with older PC apps; see [satellite.md](satellite.md).

PC actions run for real on the PC. Never live-test lock, sleep, restart or shutdown, or game launches.

## Local and server runs

| Task | Dev checkout | Installed server |
|---|---|---|
| Start, stop, restart | run `node dist/app/main.js`; Ctrl+C stops it cleanly | `sudo adrian start`, `stop`, `restart` (start and restart wait up to 60 s for a healthy `/api/health`) |
| Logs | JSON lines on stdout | `adrian logs [-f]` (journald, last 200 lines; needs read access to the journal), or the dashboard's Logs tab |
| Change config | `node dist/cli/tool.js config KEY VALUE` with `ADRIAN_CONFIG` set, or edit `config.json` | `sudo adrian config KEY VALUE`, then `sudo adrian restart` |
| Keys | `node dist/cli/tool.js secret-set NAME` (stdin) | `sudo adrian secret set NAME` (hidden prompt) |
| Health | `curl http://127.0.0.1:8790/api/health` | `sudo adrian status`, `sudo adrian doctor` |
| Update, rollback, backup | n/a | `sudo adrian update`, `rollback`, `backup`, `restore` ([install.md](install.md)) |

Most `adrian` commands need root (all but `logs`, `version` and `help`). Paths in an install: config in `/etc/adrian`, state and models in `/var/lib/adrian`, releases in `/opt/adrian/releases/<version>` with `current` and `previous` symlinks.

## Logs and debugging

- **Format.** One JSON object per line on stdout: `{t, level, msg, ...fields}`. In production journald stores them. The last 500 lines are kept in memory for the dashboard (`GET /api/logs` returns the last 200).
- **Redaction.** Every line passes through `redact()` in `src/core/logger.ts`, which hides known key shapes. It is a safety net, not permission to log secrets. Discord voice debug lines go through `redactVoiceDebug` in `src/transport/discord.ts`, because they echo the session's media key and voice token.
- **Switches:**

  | Switch | Effect |
  |---|---|
  | `LOG_LEVEL=debug` | debug lines on |
  | `listen.logTranscripts: true` | every transcript at debug level (`heard` lines, with user ID and text). Development only. |
  | `satellite.logTranscripts: true` | at a PC: the words of speech judged meant for her (`pc heard`), local vs cloud transcripts (`pc stt`), what was asked and said (`pc answer`), PC actions with their arguments (`pc action`). Clipboard and screen contents are kept out. |
  | `SAY="text"` | speaks the text once after the voice link is ready and logs the timing |
  | `VOICE_DEBUG=1` | proof of concept only: verbose DAVE and voice lines |

  Logs with either `logTranscripts` switch on contain what people said. Turn them off when you're done. Some words are logged with both off: music search and request queries (`music search`, `music request`) and up to 120 characters of a request that sounded like music but played nothing (`music asked but not played`, with the user ID). Treat production logs as personal data either way. Recordings of PC requests (`satellite.recordDays`) are separate; see [CONTRIBUTING.md](../CONTRIBUTING.md#privacy-rules-for-code-tests-and-logs).
- **Lines worth knowing.** Listening: `wake`, `waiting for the rest`, `quick continuation`, `second pass`, `language`, `cloud speech-to-text failed; using local words`, `stopped before it started`, `pc deferred to discord`. Controller: `queued`, `dropped (queue full)`, `wake ignored (duplicate)`, `continued`, `replaced by newer request`, `owner first`, `cancelled`, `interrupted`, `expired in queue`, `not for me`, `dequeued`. Answers: `answered`, with `sttLatencyMs`, `groqMs`, `closedBy`, `turnCheckMs`, `holdMs`, `llmFirstChunkMs`, `ttsFirstMs`, `speechEndToAudioMs`, tokens and `costUsd`. Startup logs which Opus encoder loaded (`opus`: native or WebAssembly).
- **More lines.** Start: `voice stack starting`, `asr loaded`, `tts loaded and calibrated` or `local voice loads on first use`, `smart turn loaded`, `voice stack ready`, each with memory figures (`rssMb`, `availMb`, `swapFreeMb`); `shutting down` with the signal, state, uptime and memory. Voice link: `voice disconnected` with `reason` (`voice link resuming`, `voice link rejoining`, `voice connection dropped`), `rejoining voice`, `voice back` (`ms`, `via`, `attempts`). PC link: `satellite disconnected` with `by`, `code`, `reason`, `linkS`, `quietS`. Voice: `cloud voice broke off mid-sentence; local voice for a minute`. Music: `direct video search failed`, `direct search answer unreadable`, `direct video search resting`. `pc heard` carries `early: true` when the words came from the early listen.
- **Timing fields.** `speechEndToAudioMs` runs from the VAD close to her first audio, plus the room's end silence. At a PC it also includes the end-of-turn check and any hold, so it reads about 1 s higher there than older versions reported. `sttLatencyMs` starts when the clip is released (after any hold). `groqMs` counts only the part of the cloud wait still awaited after the words were ready (not covered by a hold or the early listen), so it reads lower since the early listen without Groq being faster. `ttsFirstMs` is the time to the first sentence's first audio, measured in the Speaker; for a streamed cloud sentence that is its first piece, so compare `speechEndToAudioMs` across versions rather than `ttsFirstMs`.
- **Dashboard.** The Status tab shows state, problems, warnings, p50/p95 latency for speech recognition, model first sentence, voice first sentence and end of speech to first audio, the last answers with their cost, and spend against the caps. From the next release `GET /api/dashboard` adds the cards described in [install.md](install.md#the-dashboard). They are counted from about 20 log messages through the logger's observer (`WATCHED` in `src/web/metrics.ts`, fed by `createLogger`'s third argument in `main.ts`), so changing one of those messages changes a counter: `test/dashboard.test.ts` fails when a watched message no longer appears in `src/`, but not when a line keeps its text and changes meaning. Tavily and Groq answers are counted by `noteCall` (`src/core/calls.ts`).
- **`/api/health`.** `{ok, state, voiceReady, busy, version}`; HTTP 503 when the state is `failed`. `ok` is true in `running` and `setup`. Health proves she started and logged in, not that voice works end to end.
- **`adrian doctor`.** Checks Node, the service, health (a failed start is explained with what to do, through `node dist/cli/tool.js explain-log`), an update under way or cut off, the last failed update, `secrets.env` mode and owner, files owned by root in the service's folders (with the `chown` that fixes them), the five models, yt-dlp, ffmpeg, config completeness, free disk, service memory, whether discord.com and github.com answer, and errors in the last 15 minutes. Exits 1 on any failure.

## Benches (`bench/`)

Benches run against real models and services, by hand, and are not part of `npm test`. The `bench/` scripts are not in the release bundle; the compiled benches from `src/bench/` are (as `dist/bench/`), but nothing runs them.

Common rules:

- Run `npm run build` first: they import from `../dist/`.
- `<bot.json>` is a normal `config.json`; keys are read from its `secretsFile`. Some take a `secrets.env` path, a models folder, or a yt-dlp path instead.
- Anything that loads the local speech models (marked "Linux" below) needs Linux x86_64 and `LD_LIBRARY_PATH=node_modules/sherpa-onnx-linux-x64`. The benches marked "local models" also run on Windows. On Windows, onnxruntime-node (Smart Turn) can't load in a process that already loaded sherpa-onnx (both ship an `onnxruntime.dll`), so those benches measure Smart Turn in a separate process.
- Many model benches can report tokens, cost and first-text time per call with `METER_OUT=run.json node --import ./bench/meter.mjs bench/<bench>.mjs <bot.json>`.
- Model benches use `claude-haiku-5-5` with `ANTHROPIC_API_KEY` (effort low), hard-coded, not your configured `brain`. `lang-e2e.mjs`, `llm-check.mjs` and `ttft-survey.mjs` use the configured OpenAI-compatible endpoint (`brain.baseUrl`, `brain.model` and its key) and don't support `brain.provider: "anthropic"`; `lang-e2e.mjs` also replaces `extraBody` with Groq-style reasoning fields; `claude-vs.mjs` compares several Claude models with Groq.
- **They cost money.** Only `claude-vs.mjs` and `llm-check.mjs` print an estimated cost. A run of a model bench is usually cents; a larger Claude model in `claude-vs.mjs` costs more. Speechify benches spend characters from your monthly plan.
- yt-dlp benches hit YouTube (and Deezer or Tavily where noted) from your address. Heavy use can trigger YouTube's bot check, which also affects a live bot on the same address.
- Keep benches free of personal data: no real speaker names in new fixtures, no real recordings of people in the repository. Some older benches use the maintainer's public author name as a speaker, and `turn-bench.py` mentions a set of real recordings that is not in the repository.

Rerun the bench that matches a change before shipping it:

| Changed | Rerun |
|---|---|
| prompt rules, PC tools, PC confirmations | `pc-orders.mjs`, `desk-followup.mjs`, `followup-judge.mjs`, `answer-length.mjs --real`, `everyday.mjs` (and `--holdout`, `--long`, `--keep`), `home-pc.mjs` |
| tool confirmation lines, notes, search wording | `alarm-orders.mjs`, `taste-orders.mjs`, `knows.mjs` |
| prompt size | `prompt-size.mjs` (free) |
| listening, thread counts, side talk | `node dist/bench/sidetalk-bench.js` and `bench/sidetalk-score.mjs`; the latency harness (`LATENCY_HARNESS=1`) |
| text for speech, the splitter | `speech-words.mjs`; for the cloud voice `speech-changed.mjs`, `sabrina-render.mjs`, `speech-wavs.mjs` |
| streaming voice, cloud voice timing | `speak-first.mjs` (`--replay`, `--capture`), `stream-level.mjs`, `fallback-first.mjs` (how soon the local voice stands in) |
| provider connections, cache warm-up | `keepalive.mjs` (real APIs, cheap), `prewarm.mjs` (real model) |
| the loose-wake judge line | `loose-wake.mjs` (real model, about $0.03) |
| start-up memory | `mem-start.mjs` (with and without `--cloud`) |
| alarm tools or wording | `alarm-orders.mjs`; stop and snooze words: `alarm-words.mjs` |
| music tools, routing, search | `music-corpus.mjs` or `music-paired.mjs`, `music-intent.mjs`, `music-follow-up.mjs`, `taste-orders.mjs`, `music-search.mjs`, `music-e2e.mjs` |
| mixer, music filters | `mixer-stall.mjs`, `music-check.mjs`, `level-check.mjs` |
| memory or notes | `memory-update.mjs`, `memory-check.mjs` |
| text chat follow-ups | `text-followup.mjs` |
| prompt layout or caching | `cache-check.mjs` |
| model or provider | `llm-check.mjs`, `claude-vs.mjs`, `ttft-survey.mjs`, `first-audio.mjs` |

All bench files:

| File | Measures | Run | Needs |
|---|---|---|---|
| `alarm-kit.mjs` | helper: the alarm tools as the live bot has them, for other benches | imported | - |
| `alarm-orders.mjs` | everyday alarm and timer requests reach the right tool with the right arguments, short replies | `node bench/alarm-orders.mjs <bot.json>` | Anthropic key |
| `alarm-ring.mjs` | real mixer and `ringIn` on the wall clock: frames keep pace, memory stays flat | `node bench/alarm-ring.mjs [seconds]` | nothing |
| `alarm-tones.mjs` | renders each built-in tone (20 s) to WAV for listening and loudness | `node bench/alarm-tones.mjs <out folder>` | nothing |
| `alarm-words.mjs` | stop, snooze and "I'm up" heard over every tone; tones alone give no words | `node bench/alarm-words.mjs <models dir>` | Linux |
| `answer-length.mjs` | sentences, words and seconds of real answers; `--real` uses the production prompt and tools from `prod-kit.mjs` | `node bench/answer-length.mjs <bot.json> [--real]` | Anthropic key |
| `asr-bark.py` | Bark ASR (ONNX) over the corpus | `venv/bin/python -I bench/asr-bark.py <bench dir> [name]` | Python venv |
| `asr-corpus.mjs` | builds the speech recognition shootout corpus | `node bench/asr-corpus.mjs <models dir> <bot.json> <out dir>` | Linux, Speechify key for one voice, ffmpeg, public corpora downloaded separately |
| `asr-granite.py` | Granite Speech over the corpus (CPU) | `venv/bin/python -I bench/asr-granite.py <bench dir> [threads]` | Python venv with torch |
| `asr-hotwords.py` | writes a hotwords file for sherpa biasing | `venv/bin/python -I bench/asr-hotwords.py <bench dir>` | Python |
| `asr-score.mjs` | word error rate per set, key-word hit rate, latency | `node bench/asr-score.mjs <bench dir> [--errors model]` | nothing |
| `asr-shootout.mjs` | one recognizer over the corpus, results to JSONL | `node bench/asr-shootout.mjs <bench dir> <model> [bot.json]` | Linux; Groq key for `groq-*` models |
| `asr-speed.mjs` | Parakeet speed and memory | `node bench/asr-speed.mjs <model_dir> <threads> <wav...>` | Linux |
| `cache-check.mjs` | prompt-cache reads and writes over a conversation | `node bench/cache-check.mjs <bot.json> [stablePrefix=1]` | Anthropic key |
| `claude-vs.mjs` | Claude models vs Groq on the real prompt: first chunk, total, tokens, estimated cost | `node bench/claude-vs.mjs <bot.json>` | Anthropic and Groq keys |
| `cloud-voice.mjs` | Speechify latency and level | `node bench/cloud-voice.mjs <secrets.env> [voice] [out.wav]` | Speechify key (spends characters) |
| `creator-check.mjs` | the model knows the creator's account and refuses impostors | `node bench/creator-check.mjs <bot.json>` | Anthropic key |
| `desk-followup.mjs` | follow-ups at a PC without her name get answered; show and game audio stays `SILENT` | `node bench/desk-followup.mjs <bot.json>` | Anthropic key |
| `followup-judge.mjs` | follow-ups without her name at a PC and in a call: real ones answered (or done with the right tool), side talk `SILENT` with no tool; 100 labelled trials, a third held out, plus 20 statement-shaped ones | `node bench/followup-judge.mjs <bot.json> [--split tune\|holdout\|stmt\|all] [--room pc\|call]` | Anthropic key |
| `english-check.mjs` | which utterances trigger the Whisper second pass | `node bench/english-check.mjs <models dir>` | Linux |
| `everyday.mjs` | household voice questions on the production prompt: right tool or none, content, length, no "Sure!" openers; `--holdout` (19 kept apart from tuning), `--long` (where short is wrong), `--keep` (safety warnings, lists asked for) | `node bench/everyday.mjs <bot.json> [--holdout \| --long \| --keep]` | Anthropic key |
| `first-audio.mjs` | time to first audio, whole first sentence vs first clause | `node bench/first-audio.mjs <bot.json>` | Anthropic and Speechify keys |
| `home-pc.mjs` | house orders never reach the PC, at the desk and in the call; PC orders with house words still do; an unclear lock asks, and a yes locks | `node bench/home-pc.mjs <bot.json>` | Anthropic key; stub PC |
| `knows.mjs` | notes asked about in a call, remember, search answers | `node bench/knows.mjs <bot.json>` | Anthropic key |
| `live-facts.mjs` | today's facts (sunset, sunrise, weather, scores, prices, store hours) come from a tool, stable facts don't; length counted apart | `node bench/live-facts.mjs <bot.json> [--holdout]` | Anthropic key |
| `lang-e2e.mjs` | per-language path: Parakeet, English check, Whisper, reply, that language's voice | `node bench/lang-e2e.mjs <bot.json> <models dir> <out dir>` | Linux, configured OpenAI-compatible model key |
| `level-check.mjs` | writes exactly what goes to Discord per sentence, for an ffmpeg loudness check | `node bench/level-check.mjs <kokoro_dir> <voice> <out_dir>` | Linux |
| `link-check.mjs` | what pasted links would play | `node bench/link-check.mjs <yt-dlp>` | network |
| `llm-check.mjs` | time to first token, first speakable chunk, total, tool use, estimated cost | `node bench/llm-check.mjs <bot.json>` | configured OpenAI-compatible model key; Tavily key optional (adds web search) |
| `mem-start.mjs` | memory at start, per component (`--cloud`: the cloud voice primary) | `node --expose-gc bench/mem-start.mjs <models dir> [--cloud] [--json file] [--dist dir]` | local models; sets its own low priority |
| `memory-check.mjs` | roster, room talk, automatic memory, note privacy | `node bench/memory-check.mjs <bot.json>` | Anthropic key |
| `memory-update.mjs` | automatic memory rewrites contradicted notes and ignores chatter and other people's news | `node bench/memory-update.mjs <secrets.env> [runs]` | Anthropic key |
| `meter.mjs` | helper: per-call tokens, cost and first-text time, per-answer words and model calls, for any bench | `METER_OUT=x.json node --import ./bench/meter.mjs bench/<bench>.mjs ...` | - |
| `mixer-stall.mjs` | music through the mixer into a Discord-like player under event-loop stalls | `node bench/mixer-stall.mjs <mixer.js> <music.js> <yt-dlp> [seconds]` | network |
| `multilang.mjs` | speech per language, then Whisper small vs turbo accuracy and speed | `node bench/multilang.mjs <models dir> <out dir>` | Linux |
| `music-check.mjs` | real YouTube through ffmpeg and the mixer, with a fake voice in the middle | `node bench/music-check.mjs <yt-dlp> "<query>" [out.wav]` | network, ffmpeg |
| `music-compare.mjs` | compares two `music-corpus.mjs` runs by class | `node bench/music-compare.mjs <before.jsonl> <after.jsonl>` | nothing |
| `music-corpus.json` | the music corpus: 63 requests with their expected answers, `paired` marks the 16-request subset | - | - |
| `music-corpus.mjs` | 63 judged song requests (`music-corpus.json`) through the real routing: hit rate, time to stream URL and first audio, lookups | `node bench/music-corpus.mjs --ytdlp <yt-dlp> [--dist dist] [--out run.json] [--routes] [--record f \| --replay f]` | network, ffmpeg (`--routes` needs neither) |
| `music-e2e.mjs` | model, `play_music` and real lookups with production options | `node bench/music-e2e.mjs <bot.json> <yt-dlp>` | Anthropic key, network |
| `music-follow-up.mjs` | follow-ups without her name that start like music orders | `node bench/music-follow-up.mjs <bot.json>` | Linux (imports the stack), Anthropic key |
| `music-intent.mjs` | indirect music requests reach the music tools | `node bench/music-intent.mjs <bot.json> ["request" ...]` | Anthropic key |
| `music-kinds.mjs` | every request kind against real YouTube | `node bench/music-kinds.mjs <yt-dlp>` | network |
| `music-paired.mjs` | two builds alternating on the 16-request paired subset | `node bench/music-paired.mjs --ytdlp <yt-dlp> --a <dist> --b <dist> --out <prefix> [--gap 2500] [--cap 80]` (`--cap` stops before the YouTube lookups pass N) | network, ffmpeg |
| `music-search.mjs` | what YouTube search picks | `node bench/music-search.mjs <yt-dlp> ["query" ...]` | network |
| `natural-samples.mjs` | one answer rendered several ways across Kokoro voices | `node bench/natural-samples.mjs <kokoro model dir> <out dir>` | Linux |
| `pc-orders.mjs` | PC orders and chat reach the right PC tool and arguments with short confirmations; power actions take two turns | `node bench/pc-orders.mjs <bot.json>` | Anthropic key; stub PC, nothing runs on a real PC |
| `pc-sites.mjs` | "go to <site>" opens the site's own address, not a search page (8 sites) | `node bench/pc-sites.mjs <bot.json>` | Anthropic key; stub PC |
| `prod-kit.mjs` | helper: the live bot's tools and rule lines with stubs, for the brain benches | imported | - |
| `prompt-size.mjs` | the cached prompt prefix in tokens, `--each` per tool and rule | `node bench/prompt-size.mjs <bot.json> [--each]` | Anthropic key (`count_tokens` is free) |
| `sabrina-render.mjs` | renders changed lines in the cloud voice, 0.7 s apart | `node bench/sabrina-render.mjs <secrets.env> <changed.json> <out dir>` | Speechify key (spends characters) |
| `server-info-check.mjs` | `server_info` read-only against a real Discord server, then tool choice | `node bench/server-info-check.mjs <bot.json>` | Linux (imports the stack), Anthropic key and a Discord token; logs in a second gateway session beside a running bot (sends nothing) |
| `sidetalk-score.mjs` | scores `dist/bench/sidetalk-bench.js` runs: recall, false wakes, CPU, differing transcripts and decisions | `node bench/sidetalk-score.mjs <run.jsonl> [run2.jsonl ...]` | nothing |
| `slow-speaker.mjs` | a long answer with a slow voice: does it get cut off? | `node bench/slow-speaker.mjs <bot.json>` | Anthropic key |
| `sound-check.mjs` | sound-effect search, and the model calling `play_sound` | `node bench/sound-check.mjs <bot.json> <yt-dlp>` | Anthropic key, network |
| `speak-first-lines.json` | the 12 lines for `speak-first.mjs` | - | - |
| `speak-first.mjs` | time to first heard audio in the cloud voice, 12 lines over 40 characters | `node bench/speak-first.mjs <dist dir> <secrets.env> [runs] [lines.json]` | Speechify key (about 920 characters a run) |
| `speech-changed.mjs` | lines whose spoken text differs between two builds | `node bench/speech-changed.mjs <old dist> <new dist> > changed.json` | nothing |
| `speech-lines.json` | 80 lines with reference words for `speech-words.mjs` (every 4th held out) | - | - |
| `speech-score.mjs` | helper: word error rate for the speech benches | imported | - |
| `speech-wavs.mjs` | Parakeet over rendered before/after WAVs | `node bench/speech-wavs.mjs <dir> <parakeet dir> <dist dir>` | local models |
| `speech-words.mjs` | Kokoro says each of 80 lines (`speech-lines.json`), Parakeet hears it: word error rate of the spoken text | `node bench/speech-words.mjs <dist dir> <kokoro dir> <parakeet dir> [--oracle] [--json out.json]` | local models |
| `stream-level.mjs` | loudness of streamed cloud-voice sentences | `node bench/stream-level.mjs <dist dir> <secrets.env> [lines.json]` | Speechify key (spends characters) |
| `stt-compare.mjs` | local Parakeet vs Groq re-transcription on PC phrases with noise | `node bench/stt-compare.mjs <models dir> <bot.json>` | Linux, Groq key (free-tier rate limits apply) |
| `taste-orders.mjs` | "play some music" uses her own taste; artist requests; saved opinions | `node bench/taste-orders.mjs <bot.json> [--live [yt-dlp]]` | Anthropic key; network only with `--live` |
| `text-followup.mjs` | text chat uses history, answers follow-ups, stays `SILENT` for side talk | `node bench/text-followup.mjs <bot.json>` | Anthropic key |
| `ttft-survey.mjs` | time to first token across models on one OpenAI-compatible endpoint (`EXTRA='{...}'` adds body fields) | `node bench/ttft-survey.mjs <bot.json> <runs> <model> [model...]` | endpoint key |
| `tts-speed.mjs` | Kokoro speed and memory | `node bench/tts-speed.mjs <model_dir> <model_file> <threads> [sid]` | Linux |
| `turn-bench.py` | Smart Turn vs the fixed silence wait | `venv/bin/python -I bench/turn-bench.py <bench dir> <smart-turn.onnx> <silero_vad.onnx>` | Python venv, labelled clips |
| `turn-parity.py`, `turn-parity.mjs` | the TypeScript Smart Turn features and probabilities vs the reference Python | `node bench/turn-parity.mjs <model.onnx> <python results.json> <wav>...` | onnxruntime, Python venv |
| `wake-extra.mjs` | synthesizes the extra wake corpus (173 phrases in 11 classes, 4 Kokoro voices each, desk-mic noise, half without commas) | `node bench/wake-extra.mjs <models dir> <out dir>` | local models; Linux or Windows |
| `wake-score.mjs` | replays saved transcripts through a baseline and the current wake check on a fixed phrase split (every third phrase per class held out by an FNV hash); held-out transcripts print only with `--final`, `--time` times the check | `node bench/wake-score.mjs [--base old/text-wake.js] [--new dist/wake/text-wake.js] [--show] [--final] [--time] <run.jsonl> ...` | none |
| `corpus/phrases.json` | wake and not-wake phrase lists (data; not read by any script in the repo) | - | - |

Compiled benches in `src/bench/` (run from `dist/bench/` after a build; `e2e-bench` and `wake-bench` on Linux, the side-talk ones on Linux or Windows):

- `node dist/bench/e2e-bench.js <bench.json>`: end of speech to first audio without Discord. Wake clips are played in real time in 20 ms frames through VAD, Parakeet, the wake check, the orchestrator and Kokoro, against a local mock model with a configurable time to first token (or a real OpenAI-compatible model when `bench.json` has `realLlm`, which costs tokens).
- `node dist/bench/wake-bench.js <corpus_dir> <vad.onnx> <asr_dir> <threads> [gainDb ...]`: wake and false-wake rates and recognition timing over a labelled clip corpus (`PREROLL` env, default 0.25). The corpus generator is not in the repository.

- `node dist/bench/sidetalk-bench.js <corpus> <models dir> <out.jsonl>`: what each heard segment costs (VAD, Smart Turn, Parakeet CPU and wall time) and whether it wakes her, with the PC room's settings. `THREADS=N` sets Parakeet's threads; `TURN=only` measures Smart Turn alone (on Windows it can't share a process with sherpa-onnx). Score with `bench/sidetalk-score.mjs`. A corpus run takes 4-6 minutes.
- `node dist/bench/wake-asr.js <corpus> <models dir> <out.jsonl>`: decodes a clip corpus (the extra wake corpus) with the PC room's settings and writes each segment's words and wake decision, for `bench/wake-score.mjs`.
- `node dist/bench/sidetalk-pipeline.js <corpus> <models dir> <out.jsonl>`: the PC room's real `ListeningPipeline` fed clips back to back in real time, holds and joins included (Smart Turn in a child process, `turn-child.js`); `THREADS`, `MINUTES`.

Past results and what they decided are in [decisions.md](decisions.md) and [costs.md](costs.md).

## Container tests

`test-env/` holds installer tests that run in throwaway containers. They need Docker on a Linux host and a built bundle. They are not shipped.

| Script | Checks |
|---|---|
| `test-env/clean-install-test.sh /rel/<bundle>.tar.gz` | inside the systemd container: install with `--yes`, service active and running as `adrian`, `secrets.env` 0600, admin page on loopback only, setup code claim (single use), an invalid Discord token rejected and not saved, a voice preview rendered under the unit's hardening, settings save, `doctor`, a full start with fake credentials (models load under hardening, Discord login fails cleanly without a crash loop), backup without models, no secrets in the journal, uninstall leaves no trace. Run before every release. |
| `test-env/update-test.sh /rel/<bundle>.tar.gz` | builds a healthy `0.1.1-test` and a broken `0.1.2-bad` from the bundle, then update, automatic rollback from the broken one, manual rollback, data kept, bad checksum and same version refused, uninstall. It expects the base bundle to report version `0.1.0`, so a normal release bundle fails its version checks; set the base bundle's `package.json` version to `0.1.0` first, or adjust the script. |
| `test-env/upgrade-0.7-test.sh <0.6.2 bundle> <0.7.x bundle>` | the historic one-time 0.6 to 0.7 upgrade path. Of little use now. |
| `test-env/compose-test.sh <bundle> <download cache dir>` | on the host's Docker (project `adrian-cit`, port 8795): images build, models job, loopback publish, non-root user, read-only root, no capabilities, secrets 0600, setup code via `exec`, admin claim, invalid token rejected, voice preview, `TZ` passed through, admin survives a restart, no secrets in logs; removes everything it created. Skips music. |

The systemd image is `test-env/Dockerfile` (any Debian- or Ubuntu-based image with systemd packages can be the base; it uses `apt-get`). The container runs systemd as PID 1: `test-env/entry.sh` remounts the container's own `/sys/fs/cgroup` read-write, which needs `CAP_SYS_ADMIN` and a private cgroup namespace. The scripts expect the bundle folder at `/rel` and a download cache at `/dl`.

Running the clean-install test (the release gate). The container options are the ones the maintainer's release runs have used since 2026-10-15 (`CAP_SYS_ADMIN`, `--cgroupns=private`, `--security-opt apparmor=unconfined`, `--tmpfs /run`, 2 CPUs, 3 GB, low CPU shares). The command lines below are written out from those options and the scripts; as of 2026-11-20 they have not been run in exactly this form, so treat a container that doesn't boot as a problem with these lines before suspecting the bundle.

```bash
# Once: the test image (from the repository root).
docker build --build-arg BASE=ubuntu:24.04 -t adrian-test-ubuntu24 test-env

# Optional: a download cache, so each run doesn't fetch Node and the models again.
# install.sh only reads it (files named as in their URLs, each checked against its pin);
# with an empty /dl it downloads everything, so the container needs internet.
mkdir -p ~/adrian-dl
bash -c '. packaging/downloads.sh
  for m in "${MODELS[@]}"; do IFS="|" read -r _ u s _ <<<"$m"; [ -f ~/adrian-dl/"${u##*/}" ] || fetch "$u" "$s" ~/adrian-dl/"${u##*/}"; done
  [ -f ~/adrian-dl/"${NODE_URL##*/}" ] || fetch "$NODE_URL" "$NODE_SHA256" ~/adrian-dl/"${NODE_URL##*/}"'

# A fresh container per run: release/ is where package.sh wrote the bundle.
docker run -d --name adrian-cit \
  --cap-add SYS_ADMIN --cgroupns=private --security-opt apparmor=unconfined --tmpfs /run \
  --cpus 2 --memory 3g --cpu-shares 256 \
  -v "$PWD/release:/rel:ro" -v ~/adrian-dl:/dl:ro -v "$PWD/test-env:/test-env:ro" \
  adrian-test-ubuntu24
docker exec adrian-cit bash /test-env/clean-install-test.sh /rel/adrian-voice-<version>-linux-x64.tar.gz
docker rm -f adrian-cit
```

Each check prints `PASS` or `FAIL`; the last line is `== <n> passed, <m> failed` and the script exits non-zero on any failure. A release needs `0 failed`. `update-test.sh` and `upgrade-0.7-test.sh` run the same way in a fresh container (see the table for what `update-test.sh` needs first). `compose-test.sh` runs on the host instead, not in this container.

## Building a release bundle

On Linux x86_64 with a Node version vitest supports (see [Requirements](#requirements)):

```bash
packaging/package.sh release/
# -> release/adrian-voice-<version>-linux-x64.tar.gz and .sha256
```

It copies the sources to a temporary folder, runs `ONNXRUNTIME_NODE_INSTALL=skip npm ci`, then `npm run typecheck` and `npm test -- --maxWorkers=2`. If either fails, no bundle is built. It then builds, prunes dev dependencies, and strips `src`, `test`, `tsconfig.json`, `packaging/package.sh`, `node_modules/.vite*`, the `@discordjs/opus` build folder (it holds the build machine's paths) and every non-Linux-x64 onnxruntime binary (about 250 MB). Files are packed as uid/gid 0. `bench/`, `docs/`, `test-env/` and `assets/` are not shipped. Everything compiled from `src/` is, including `dist/bench/` and `dist/poc/`.

Install it with `sudo packaging/install.sh --bundle <file>`, or upgrade an install with `sudo adrian update <file>` (a local bundle is checksum-checked only when its `.sha256` sits next to it). Docker images: `packaging/docker/build.sh <bundle>` builds `adrian-voice:<v>` and `adrian-voice-fetch:<v>`; see [install.md](install.md).

What a published release must contain is in [CONTRIBUTING.md](../CONTRIBUTING.md#releases).

## Building the PC app for a release

Every release carries the PC app at the release number (see [CONTRIBUTING.md](../CONTRIBUTING.md#releases) for why). It is built on Windows from a checkout of the main repo, [A.D.R.I.A.N](https://github.com/Riqqqque/A.D.R.I.A.N), with Rust 1.88 or newer on the MSVC toolchain. Set `version` in `crates/desktop/Cargo.toml` and `crates/desktop/tauri.conf.json` first (no byte-order mark).

A public exe must not carry the build machine's paths. Two things keep them out: `--remap-path-prefix` for Rust's own paths (panic messages name every dependency's source file), and a `CARGO_HOME` under `target\`, because `aws-lc-sys` compiles C whose `__FILE__` strings ignore the remap. Pass the remap with `--config`, which adds to the workspace's `.cargo/config.toml` (the `+crt-static` flag). Don't set `RUSTFLAGS`: it replaces those flags, and the exe then needs the Visual C++ runtime. Run it from the repository root, or `.cargo/config.toml` doesn't apply.

```powershell
# Windows PowerShell, in the main repo's root
$env:CARGO_HOME = "$PWD\target\cargo-home"   # the first build fills a fresh registry here
cargo build --release -p adrian-desktop --config "target.x86_64-pc-windows-msvc.rustflags=['--remap-path-prefix=$env:USERPROFILE=~']"
$LASTEXITCODE                                  # must be 0

$exe = 'target\release\adrian-desktop.exe'
(Get-FileHash $exe -Algorithm SHA256).Hash     # must differ from the previous release's exe .sha256
(Get-Item $exe).VersionInfo.FileVersion        # must be the release number
Select-String -Path Cargo.lock -Pattern 'name = "adrian-desktop"' -Context 0,1   # the next line: the same version
& $exe --self-check | Out-String               # must print exactly the release number
Select-String -Path $exe -Pattern $env:USERNAME -SimpleMatch -Quiet             # must be False
```

- The release exe is a Windows-subsystem program: `--self-check` output only shows when it is piped, as above. `--self-check` builds the app without a window, tray or audio, prints the version and exits 0, so it is safe next to a running copy.
- If the hash equals the previous release's, cargo didn't write a new exe (a rerun of the same version): `cargo clean --release -p adrian-desktop` and build again.
- The release asset `adrian-pc-app-<v>-windows-x64.exe` is this exe under that name; the zip holds it again as `ADRIAN.exe`, with `crates/desktop/packaging/Install.ps1` and a `README.txt`. Checksums are made with `sha256sum --text <file> > <file>.sha256` in bash (without `--text`, Git Bash writes `<hash> *<name>`), not with a PowerShell 5.1 redirect.
- The release exe isn't code-signed; SmartScreen warns on first run.

These commands follow the maintainer's release script (not public). As of 2026-11-20 they have not been run in exactly this form.

## Updating pinned downloads

`packaging/downloads.sh` pins every download (Node, the speech models, Smart Turn, yt-dlp) by URL and SHA-256, over HTTPS with TLS 1.2 or newer. Downloads give up on a stall but have no total time limit.

- **Bumping yt-dlp** (YouTube breaks it from time to time): take the new version and its checksum from that release's `SHA2-256SUMS`, update the `yt-dlp_linux` line, and update the "pinned downloads" assertion in `test/packaging.test.ts`. Before releasing, play one real song through ffmpeg (`bench/music-check.mjs`): a lookup that looks clean can still return stream URLs that ffmpeg gets 403 on. Do not set yt-dlp's `player_client` or `player_skip` options; they have tripped YouTube's bot check.
- **Bumping Node**: update the URL and hash, and the "pinned downloads" test (it asserts the exact Node version and hash).
- **Adding a model**: add it to `downloads.sh`, to `MODEL_LAYOUT` in `src/web/checks.ts` if the wizard should report it, and to the model list in `adrian doctor` if it is required. `packaging/upgrade-prep.sh` installs it on the next update.

Upstream sometimes replaces a speech model file in place (both Parakeet and Kokoro were re-uploaded in 2026), and every fresh install then stops at the checksum. To accept the new upload:
1. Download it, check it comes from the project's own release, and compare it with the old files (what changed, and the ASR and speech benches).
2. Put its SHA-256 first in that model's checksum field, keeping the old one after a comma. A model already installed from either one is kept, so existing servers download nothing.
3. Update the entry's `ARCHIVE:PEAK:KEPT` sizes if they moved, and ship a release.

`ADRIAN_DOWNLOAD_MIRRORS` (or `/opt/adrian/download-mirrors`, one https URL per line) lists places to try after the original site, as `<mirror>/<file name>`. A mirror's files must still match a listed checksum.

## Conventions

- **Config.** Zod validates all config in `src/config.ts`, and every setting added later has a default (or is optional); only the installer- and wizard-written keys (`guildId`, `channelId`, `secretsFile`, `listen.vadModel`, `listen.asrModelDir`, `brain.model`) are required. A new required key breaks existing installs on their next update. Sections with `.default({...})` repeat every default in the object literal. A new top-level section that people should be able to set with `adrian config` goes in `ALLOWED` in `src/cli/tool.ts`; file paths stay installer-only.
- **Keys.** Never log one or put it in an argument or URL. A setting only references keys meant for its own purpose (`SECRET_PURPOSE` in `src/config.ts`). New key shapes get a redaction pattern in `src/core/logger.ts`.
- **Integrations stay read-only** unless they are explicitly acting ones with allow lists and confirmations.
- **Paid calls** go through the spend ledger.
- **Admin UI.** `web/` is plain JavaScript with no build step. The CSP forbids inline scripts and styles: keep code in `web/app.js` and set styles through CSSOM (`el.style.x`). Static files are cached in memory until restart.
- **Tools.** Follow the `Tool` interface in `src/core/interfaces.ts`: `timeoutMs`, `slow` for anything that can take about a second, `filler` for a fixed "one sec" line of its own, `speak` when success can be confirmed without a second model call, `endsTurn` when success needs no words after it (a sound effect), `acts` when it does something, an `asks(result)` predicate with `PendingYes` for anything with real consequences (its `speak` line goes out word for word), `route` for non-Claude routing. Each schema costs prompt tokens on every Claude call. Document it in [tools.md](tools.md).
