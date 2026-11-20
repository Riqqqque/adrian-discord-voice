# Design decisions

This page records the choices that shaped A.D.R.I.A.N.: what was chosen, what else was tried or considered, why, and what to rerun before changing it. Many of these values look arbitrary in the code (a 2.5 s barge-in, a pinned yt-dlp from August, a 50,000-fan threshold). Each one is there because something else was measured and was worse.

State of the code: version 0.17.1 (2026-11-19). Page written 2026-11-20.

Related: [architecture.md](architecture.md) (how it all fits), [costs.md](costs.md) (money and machine numbers), [roadmap.md](roadmap.md) (what is still open), [development.md](development.md) (how to run the benches), [../CONTRIBUTING.md](../CONTRIBUTING.md) (what is guarded).

## How to read an entry

- **Chosen**: what the code does now, with the version and date it arrived.
- **Instead of**: the alternatives that were tried or planned.
- **Why**: the reason, with the measurement where there is one.
- **Where**: the files and constants.
- **Before changing**: the bench or tests to rerun. Benches live in `bench/` and `src/bench/`; they need `npm run build`, real keys and a config, and most of them cost a little money (see [development.md](development.md)).

About the numbers: results from a bench in this repo name that bench. Some numbers come from one-off maintainer measurements that the repo can't reproduce (live probes, a desktop-PC meter, a test server's logs). Those are labelled "maintainer measurement" with their date. "The test server" is an ordinary x86_64 Linux machine; speech models run on its CPU. Versions before 0.13.0 predate the public git history, so they have a version but no commit.

If you have new data that contradicts an entry, change the code and this page in the same commit.

## Contents

- [Suite layout](#suite-layout)
- [Listening](#listening)
- [The conversation](#the-conversation)
- [The brain](#the-brain)
- [Her voice](#her-voice)
- [Music](#music)
- [Alarms, reminders and memory](#alarms-reminders-and-memory)
- [The PC app and PC actions](#the-pc-app-and-pc-actions)
- [Installs, updates and releases](#installs-updates-and-releases)
- [Security and privacy](#security-and-privacy)

---

## Suite layout

### The TypeScript bot is the hub, not the Rust household server

- **Chosen**: the Discord bot (this repo) is the one backend for both the Discord call and the PC app. One brain, one memory, one budget, one set of tools. The PC app's server side was added to the bot in 0.14.0 (October 2026).
- **Instead of**: the original plan in the main repo's [docs/ROADMAP.md](https://github.com/Riqqqque/A.D.R.I.A.N/blob/main/docs/ROADMAP.md) (2026-10-14). In that 2026-10-14 design review, the Discord bot was a Rust (Songbird) client of the Rust household server (`crates/server`), and the PC satellite paired with that server.
- **Why**: the bot was built first and grew the parts the plan assumed the server would have: a model with tools, per-person memory, spend caps, alarms and Home Assistant (over MCP). Giving the PC the same backend meant people at a PC and in a call share one memory and one budget, with no second brain to keep in step.
- **Where**: `src/satellite/*` (the PC protocol server); the PC app in the main repo, `crates/desktop`.
- **Consequence**: the Rust household server is maintained (157 tests) but is not what runs in production. Its plans (rooms, memory v2, cameras) are still the long-term vision; see [roadmap.md](roadmap.md#further-out-the-household-server-vision).

### Two repositories, and PC app releases ship from this one

- **Chosen**: the Rust workspace (PC app, `pc-control`, household server) is in the main repo. The bot is here. Every bot release also carries the Windows PC app (`adrian-pc-app-<v>-windows-x64.exe`, a `.zip`, and `.sha256` files). Since 0.15.0 the desktop crate's version tracks the bot's release number.
- **Why**: the PC app's updater looks for its download in this repo's GitHub releases (`REPO` in `crates/desktop/src/update.rs`). One release number means one place to look and one compatibility story: the server learns the PC app's version from `hello.version`.
- **Before changing**: a release without the bare exe asset and its `.sha256` strands every PC on its current version. See [pc-app.md](pc-app.md) and [satellite.md](satellite.md).

### Docs live in the repos

- **Chosen**: documentation is Markdown in each repo (`README.md`, `CONTRIBUTING.md`, `docs/`). A 2026-10-14 plan moved it to the GitHub wiki; that never happened, and the in-repo docs were expanded in November 2026 instead.
- **Why**: docs reviewed in the same commit as the code they describe. A few doc sentences are pinned by tests (see [../CONTRIBUTING.md](../CONTRIBUTING.md)).

---

## Listening

### Local first: VAD, speech recognition and the wake decision run on your server

- **Chosen**: Silero VAD per speaker, Parakeet TDT 0.6B v3 (int8, sherpa-onnx) for every segment, and a text check for her name, all on the server's CPU. Cloud speech recognition (Groq) is optional and comes later in the pipeline (next entries).
- **Why**: free per request, private by default, and no cloud round trip before the wake decision. Parakeet takes about 0.1-0.3 s per phrase, median 170 ms, on the test server (4 threads, decodes serialized; maintainer measurement, 2026-10-21, see [costs.md](costs.md)).
- **Where**: `src/speech/sherpa.ts`, `src/listen/pipeline.ts`, `src/wake/text-wake.ts`.

### Parakeet runs on 2 threads

- **Chosen**: `listen.asrThreads` defaults to 2 (it was 4); Whisper keeps 4 through its own `listen.whisperThreads` (next release).
- **Instead of**: 4 threads (to match the service's 4-core quota) or 1.
- **Why**: every segment anyone says is decoded, so side talk is most of the bot's CPU, and onnxruntime's worker threads spin while they wait (sherpa-onnx-node exposes no switch for that). On 889 clips (`src/bench/sidetalk-bench.ts`, a desktop PC, 2026-11-20): Parakeet CPU per segment 703 ms on 4 threads, 360 ms on 2 (an independent re-run: 391 ms), about 188 ms on 1. The words were identical in all 890 segments, and wake recall (250/257) and false wakes (17/608) didn't change. The cost is decode time: 10-50 ms more per decode in one run, about 100 ms more (median) in a re-run on a busy machine. 1 thread adds about 90-140 ms more again.
- **Where**: `src/config.ts` (`listen.asrThreads`, `listen.whisperThreads`).
- **Before changing**: `src/bench/sidetalk-bench.ts` with `THREADS=N`, scored by `bench/sidetalk-score.mjs`; on the server, compare `sttLatencyMs` before and after.

### At a PC, recognition starts during the silence wait

- **Chosen**: PC rooms run a second Silero VAD with a 0.32 s wait. Its clip is decoded at once, and the Groq listen starts if the speech would go to Groq anyway; the words are used only when the full 0.8 s wait then closes exactly the same samples (`satellite.earlyListen`, on by default; next release).
- **Instead of**: a shorter silence wait (more cut-off sentences), or speculating the model on the local words while Groq runs (needs orchestrator changes: `ask()` writes memory and can run tools).
- **Why**: in the latency harness (`test/latency-harness.test.ts`, stand-in models at prod delays), a PC request said in one go went from 3,425 to 2,945 ms end to end at a 300 ms decode, the same at 150 and 450 ms; speech with a 0.32-0.8 s pause falls back to today's timing exactly. With 0.32 s and 0.8 s both whole Silero windows, the two VADs cut at the same sample: all 240 synthetic PC commands and 5 real PC recordings matched. Cost: about 20% more decoding on conversation-like side talk (AMI corpora), none on PC commands, and an aborted Groq request when someone goes on talking.
- **Where**: `EarlyOptions` in `src/listen/pipeline.ts`, `listenEarly` in `src/app/stack.ts`.
- **Before changing**: the latency harness, `test/early-listen.test.ts`.

### The wake word comes from the transcript, not from a keyword spotter

- **Chosen**: every segment is transcribed, and `TextWakeDetector` decides whether it was meant for her ("Hey Adrian ...", "Adrian, ..."). On a PC, the app only runs a loudness gate with 300 ms of pre-roll (`PREROLL_FRAMES` in `crates/desktop/src/audio.rs`). The server finds the words and the name.
- **Instead of**: an acoustic wake word. The old Rust satellite used rustpotter (opt-in), and the PC satellite v2 plan in the main repo's roadmap called for sherpa-onnx keyword spotting on the PC.
- **Why**: one wake check for every room. It can tell talk *about* her from talk *to* her: "Hey, Adrian's coming over later" and "Hadrian built a wall" must not wake her (`test/wake.test.ts`). And the PC app stays tiny. With Parakeet v3, `src/bench/wake-bench.ts` had 0 misses in 240 wake phrases and 0 false wakes on its synthetic corpus (0.7.0).
- **Cost of the choice**: all speech is transcribed, side talk included. Side talk is most of the server's CPU time. Japanese and Vietnamese ways of saying the name aren't caught (say "Hey Adrian" first; see [roadmap.md](roadmap.md#known-limitations)).
- **Before changing**: `test/wake.test.ts`, `src/bench/wake-bench.ts`.

### Parakeet v3 stays the speech model

- **Chosen**: Parakeet v3 int8 (upgraded from v2 in 0.7.0).
- **Instead of**: a shootout over 380 clips (synthetic PC commands, far-field and headset meeting audio, read speech), maintainer measurement 2026-10-21, scripts `bench/asr-corpus.mjs`, `bench/asr-shootout.mjs`, `bench/asr-score.mjs`, `bench/asr-bark.py`, `bench/asr-granite.py`:
  - **Qwen3-ASR 0.6B int8**: the best local alternative (1.5% WER on the PC commands), but about 720 ms per command and about 2 GB of memory. Noted as a fallback; not wired in.
  - **Whisper small**: 2.4% WER, about 900 ms.
  - **Underdog Bark 3.0**: best on real meeting audio, but misspells names. That matters for a wake word.
  - **Also worse**: distil-large, a local Whisper turbo (about 2.5 s), Moonshine, Canary, SenseVoice and Parakeet 110M. Granite Speech (tried 2026-10-23) reached 3.2% at about 1.9 s per command.
  - **Hotword biasing** on Parakeet (`bench/asr-hotwords.py`) made results worse and sometimes empty.
- **Why**: nothing was better at Parakeet's speed and memory.
- **Before changing**: rerun the `asr-*` benches and `src/bench/wake-bench.ts`.

### Cloud re-transcription only for speech already judged to be for her

- **Chosen**: `cloudStt` (0.14.5, off by default) sends a segment to Groq's `whisper-large-v3-turbo` only after the local path decided it was for her: it woke her, or it came inside a follow-up window (not stops, not the bare name). `cloudStt.rooms` defaults to `pc`: PC rooms, plus speech in the Discord call from anyone whose PC is connected (their PC hands the call their requests). `all` adds every speaker in the call. The local wake decision always stands. If Groq's text lacks the command, fails, times out (`timeoutMs` 1500) or returns nothing, the local words are used. HTTP 429 and 5xx pause it for 60 s.
- **Why**: better words for commands without sending anyone's side talk to a cloud service, and without letting the cloud decide who is talking to her. PC commands (app names, site names) were where local recognition slipped most.
- **Where**: `src/speech/cloud-stt.ts`, `src/app/stack.ts`.
- **Before changing**: `test/cloud-stt.test.ts`, and the `test/stack.test.ts` sections "speech waiting on the cloud listen", "the second listen" and "speech not meant for her never reaches the cloud". `bench/stt-compare.mjs` compares the two.

### Whisper small as a second pass for other languages, loaded on first use

- **Chosen**: Parakeet transcribes everything. Clips that don't look English go through Whisper small (about 1-1.5 s) for the language and the words. Since 0.15.4 (commit 43b548a), Whisper and the non-English voices load the first time someone speaks another language, not at start.
- **Why**: Parakeet is fast but English-centred. Loading the other languages lazily saved about 1.3 GB: resident memory after start is about 1.5-1.6 GB (maintainer measurement, 2026-11-08). The service has a hard limit of 5 GB (`MemoryMax`).
- **Before changing**: `bench/english-check.mjs`, `bench/lang-e2e.mjs`, `test/stack.test.ts` "startup".

### Smart Turn as a hybrid hold, only at a PC, on a worker thread

- **Chosen**: at a PC, after the normal 0.8 s of silence, Smart Turn v3.2 (an ONNX model that judges from the sound whether a turn is finished) can hold the segment for more speech. The hold lasts up to `satellite.unfinishedWaitMs` (1200 ms, 0 = off), and holds are capped at 15 s in total. Added 0.14.7. Runs in a worker thread since 0.15.4.
- **Instead of**: Smart Turn as a replacement for the silence wait (stop after 0.2 s). Or no turn model.
- **Why**, from `bench/turn-bench.py` (maintainer runs, October 2026):
  - **As a replacement**, it cut off 18.9% of utterances, against 6.7% for the plain 0.8 s wait.
  - **As a hybrid**, it halved cut-offs to 3.3% (long meeting speech 20% to 7.5%) for about 0.2 s more waiting on average, and about 0.05 s on PC commands. The header of `src/speech/smart-turn.ts` records the same result over 460 clips.
  - **Parity**: the TypeScript feature code matches the reference on 100 of 100 clips (`bench/turn-parity.mjs`, `bench/turn-parity.py`).
- **Why a worker**: on the main thread each check blocked the event loop for about 172 ms, which starved the mixer's 160 ms lead, and PC music skipped. On a worker the block is about 1 ms (commit 43b548a).
- **Why PC only**: it was built and measured for PC rooms. Using it in Discord rooms is a pending decision ([roadmap.md](roadmap.md#waiting-on-a-decision)). Discord rooms use the plain VAD silence.
- **Before changing**: `test/turn-hold.test.ts`, the `test/stack.test.ts` "speech that sounds unfinished at a PC" sections, `bench/turn-bench.py`.

### End-of-speech silence: VAD 0.5 s and stream end 800 ms in Discord, at least 0.8 s at a PC

- **Chosen**: in Discord the VAD closes a segment after `listen.minSilence` (0.5 s) of silence. `silenceMs` (800) is how long Discord's receive stream waits after the last packet before it ends and flushes what it has (`EndBehaviorType.AfterSilence` in `src/transport/discord.ts`). PC rooms use `max(listen.minSilence, 0.8)` (since 0.14.1). For how fast she answers in a Discord call, `listen.minSilence` is the key that matters for most segments.
- **Why**: shorter waits cut people off mid-sentence. Longer ones add delay to every answer. `silenceMs` has stayed at 800 since 0.12.0 on purpose.
- **Before changing**: `endSilenceMs` must match the real wait, or the `speechEndToAudioMs` timing field is wrong.

### No acoustic echo canceller at the PC; a full-duplex gate instead

- **Chosen**: the PC app's mic gate learns how loud her voice comes back through the mic while she plays (fast down, slow up). It opens over her only above 3 times the expected echo plus 0.01 for 4 frames, and it ducks her voice locally while you talk (0.14.2). The gate's noise floor only rises slowly, and never while she plays, with the threshold capped at 0.035 (0.14.1).
- **Instead of**: echo cancellation. `crates/desktop/examples/aec_probe.rs` in the main repo (run with `cargo run --release -p adrian-desktop --example aec_probe -- <voice.wav> <out dir>`) tried Windows' communications-mode processing.
- **Why**: maintainer probe, 2026-10-23. Her echo raised the mic level about 2 dB at about -60 dBFS, while real requests recorded at about -31 dBFS, roughly 30 dB apart. The interface tested applied no echo cancellation in communications mode anyway. Trouble talking over her came from gate logic, not echo. In 0.14.0 the floor learned her voice and show audio as "noise" and the gate went deaf; the floor rules fixed that.
- **Before changing**: the gate tests in `crates/desktop/src/audio.rs` (`her_voice_and_loud_moments_dont_deafen_it`, `talking_over_her_cuts_in_but_her_echo_does_not`), then listen on real hardware.

---

## The conversation

### Barge-in: 2.5 s in Discord, 600 ms at a PC

- **Chosen**: talking over her interrupts only when it comes from the person she is answering (or a priority role), only once her answer is audible, and only after `bargeInMs` of continuous speech: 2500 ms in a Discord call (`DEFAULT_CONTROLLER_OPTIONS`, `src/conversation/controller.ts`) and 600 ms at a PC (`src/app/stack.ts`). Other people talking never interrupts her, and neither does anyone while a tool is carrying out an order or while the asker is in a game at their PC (quiet while gaming). A stop phrase ("stop", "shut up", "never mind") works at once.
- **Instead of**: 0.5 s cut off 11 of 21 answers (laughs, reactions, echo). 1.2 s still cut about 30% in group calls. 2.5 s since 0.9.0; the PC value since 0.14.2.
- **Why**: in a group call most voice over her is people reacting, not interrupting. The 600 ms at a PC came with the full-duplex gate (0.14.2), which already keeps her own echo out, so talking over her cuts in quickly.
- **Before changing**: `test/controller.test.ts` hard-codes the 2.5 s value in test names and timings. The PC's 600 ms is set in `src/app/stack.ts` (the `rm.ui` controller options) and no test asserts it, so check the PC barge-in by hand or add a test.

### Owners stop other people's answers only with a stop phrase

- **Chosen**: an owner talking never barges in on someone else's answer. An owner can stop anyone with a stop phrase.
- **Why**: in 0.5.1, letting owners' voice activity barge in caused many unwanted interruptions in a busy server (167 in one measurement).

### Follow-ups without her name: 8 s in Discord, 20 s at a PC, judged by the model

- **Chosen**: after she answers, the asker can carry on without saying "Adrian" for 8 s (`followUpMs`) in a call, 20 s at a PC. Of the phrases answered locally, only `ack`, `thanks` and `bye` are allowed on a follow-up (`CHANGES_NOTHING` in `src/app/stack.ts`). Anything else goes to the model, which may answer `SILENT` when the words weren't for her. A follow-up that starts like a music order (`MUSICISH`) is never judged silent.
- **Why**: words said without her name may be meant for someone else in the room. Acting on them locally ("louder", "stop") would act on side talk. The model sees the context and can stay silent.
- **Cost**: each judged follow-up is a model call, even when she stays silent.
- **Before changing**: `bench/desk-followup.mjs` (PC follow-ups against show and game audio), `bench/text-followup.mjs`, `bench/music-follow-up.mjs`, `test/stack.test.ts` "a follow-up said without her name".

### A continuation merges into the request instead of replacing it

- **Chosen**: if the asker keeps talking within 12 s (`CONTINUE_MS`) and before she has started speaking, the new words join the active request (0.14.3, logged as `continued`).
- **Instead of**: "replaced by newer request", which threw away the first half of what was said.
- **Guard**: once a tool acted (`working`, `acted`), no continuation re-runs the order.

### Phrases answered without the model must be whole utterances

- **Chosen**: everyday phrases (thanks, bye, repeat, louder or quieter, faster or slower, the time, clear music controls) are answered locally for free (`src/conversation/intents.ts`, 0.4.0 onwards). They must match the whole utterance or a clear order. Vague music requests go to the model (`classifyMusic`).
- **Why**: free and instant when it's certain. A wrong local match acts on something nobody asked for. "Play the objective" or a song title containing "stop" must not turn into commands.
- **Before changing**: `test/intents.test.ts`, `test/music-requests.test.ts` ("local music commands leave vague requests to the model").

---

## The brain

### Claude Haiku is the recommended model

- **Chosen**: the setup wizard's recommended preset is Claude Haiku 5.5 ($0.10 input, $0.01 cached input, $0.50 output per million tokens; prices "verified 2026-10-14/15" in `LLM_PRESETS`, `src/web/checks.ts`). Claude support arrived in 0.8.0. The schema default for `brain.provider` is still `openai`; any OpenAI-compatible endpoint works, local ones included.
- **Instead of**, per `bench/claude-vs.mjs` (2026-10-15):
  - **Sonnet**: about 20 times the cost for the same 1.3 s first chunk.
  - **Opus**: about 40 times the cost, with a 2.1 s first chunk.
  - **Groq gpt-oss-120b on its free tier**: hit its token-per-minute and daily caps after a few tool questions a minute.
  - **Gemini Flash-Lite on its free tier**: took over 8 s and timed out as a fallback.
- **Why**: fast enough for voice, follows tool rules, and is cheap once its prompt cache is warm. Prices and the cost formula are in [costs.md](costs.md).

### Prompt caching: one stable prefix, every tool on every call (Claude)

- **Chosen**: with Claude (`stablePrefix`), every call carries the same system block and the same tool list in the same order, cached with `cache_control: ephemeral` (0.12.0). Per-request context (the roster, notes, what's playing) goes after the cached part. Other providers get a routed subset of tools from `src/brain/tool-router.ts`.
- **Why**: cache reads cost a tenth of the input price. `bench/cache-check.mjs` (0.12.1) measured 83% of input read from the cache on single turns and 90-93% in a six-turn conversation. The router saves tokens on uncached providers, but a routing miss means the model can't use the tool it needs. With Claude caching, sending everything is cheap and never misses a tool.
- **Consequence**: every new tool adds its schema to every Claude call (the 0.17.0 alarm tools added about 1,170 tokens). Anything that changes per request must stay out of the stable part, or every call misses the cache.
- **Before changing**: `test/orchestrator-tools.test.ts` ("with a stable prefix ..."), `test/anthropic.test.ts`, `bench/cache-check.mjs`.

### Thinking stays on, at low effort

- **Chosen**: the Claude adapter (`src/brain/anthropic.ts`) never turns thinking off. It sends `output_config.effort` (`brain.effort`, default `low`) and leaves room for thinking tokens (`max_tokens` at least 2048, which is also why `brain.maxTokens` is not a hard cap with Claude). Thinking and tool-use blocks are replayed exactly on the next round, as tool use with thinking requires.
- **Instead of**: thinking off. Maintainer A/B bench, 2026-11-01: 942 calls, $0.12 in total.
- **Why**:
  - **Speed**: thinking off saved nothing at the median (13-30 ms).
  - **PC routing got worse**: `bench/pc-orders.mjs` fell from 22/22 to about 18/22, and correct tool calls fell from 90/90 to 83/90.
  - **She talked her reasoning aloud** on up to 30% of tool rounds.
- **Before changing**: `bench/pc-orders.mjs`, `bench/answer-length.mjs`, `bench/llm-check.mjs`.

### Answer length is held by a word rule in the prompt, repeated in every spoken turn

- **Chosen**: the stable prompt asks for answers "under twenty words", at most forty (`src/brain/orchestrator.ts`; 0.15.2). From the next release it also says what short means (one sentence; two short sentences for how, why and what-should-I; no caveats, offers or questions back; a decline in a few words), and `SPOKEN_TURN` repeats the rule last in every spoken turn. A safety warning that matters and every item of a requested list are exempt.
- **Instead of**: sentence-count rules, which didn't move the length. `brain.maxTokens` can't do it either: with Claude it isn't a real cap. Trimming rule text the tool descriptions repeat was tried and reverted: "go to reddit" then opened a Google search (3 of 3).
- **Why**: `bench/answer-length.mjs` median went from 54 to 36 words with the word rule (0.15.2, without tools). On the real prompt (2026-11-01) the median was 34 words, with 73% of answers over 20. With the defined rule repeated per turn (2026-11-20, independent re-run, 3 runs each): `answer-length.mjs --real` within its limit 60.6% to 93.9%, median 34 to 22 words; `everyday.mjs --holdout` 68.4% to 86.0%. The safety and list exception (`everyday.mjs --keep`) kept every warning and list item; it made answers a few words longer on `answer-length` (median about 25-30), not on `everyday`.
- **Before changing**: `bench/answer-length.mjs --real`, `bench/everyday.mjs` (with `--holdout`, `--long`, `--keep`).

### A tool can say its own line and skip the second model call

- **Chosen**: `Tool.speak(args, result)` (0.14.3). When every tool in a round returns a line, the orchestrator says it and makes no second call. PC tools use short confirmations. Errors and information go back to the model. From the next release alarm edits and settings, game-night join and leave, music likes and `remember` speak too (12 bench turns: 2 calls to 1, first chunk median 1,235 to 816 ms), unless the person's words also ask something (`asksMore`). A sent message stays the model's to describe, on purpose.
- **Why**: a tool round normally costs a second full model call, and its latency, just to say "Done." Skipping it saves a call and the time to its first word.

### A filler line before a slow tool

- **Chosen**: if a tool marked `slow` hasn't answered after 0.9 s (`fillerAfterMs`), she says a short filler ("One sec.", "On it.") (0.12.0).
- **Why**: music, podcast and web lookups take 2-8 s, and a long silence after a request gives no sign she heard it.

### Read the model's stream eagerly, and time the answer per tool

- **Chosen**: the answer stream is read as fast as the model produces it (`src/core/eager.ts`, 0.12.0), while earlier sentences are still being spoken. `brain.totalTimeoutMs` is 20 s (15 s before 0.11.0). The timer covers generation only, and it is reset for each tool call to that tool's `timeoutMs` plus 8 s (0.12.1).
- **Why**: with a slow voice, reading the stream only as fast as she spoke let the request time out mid-answer. `bench/slow-speaker.mjs`: the old reader was cut off after 4 of 8 sentences; the eager one spoke all 8. The longer timer is for album and podcast lookups, which take 5-8 s.
- **Before changing**: `test/eager.test.ts`, `test/orchestrator-tools.test.ts`, `bench/slow-speaker.mjs`.

### Spend caps are checked before a request and counted after it

- **Chosen**: `src/limits/usage-ledger.ts` checks the monthly cap, then the daily cap, then the per-person hourly limit before each model request, and adds the cost after it. Defaults: `limits` of 30 requests per person per hour, $1 a day, $10 a month, and `maxRequestChars` 600 (since 0.2.0). Owners skip only the hourly limit. Day and month totals persist across restarts; hourly counts are in memory. A voice request that hits a limit hears why once per 10 minutes, then silence.
- **Why**: bounded cost. The cost of a request isn't known until it ends, so checking first and counting after is the only exact way, at the price of letting the one request that crosses a cap finish.
- **Before changing**: `test/ledger.test.ts`, `test/stack.test.ts` ("what an answer costs").

### No retry and no model switch once words were spoken

- **Chosen**: a transient error retries once, and the fallback model (`brain.fallback`) takes over, only before the first spoken words. A round that carries a picture has no stall deadline: a slow primary isn't swapped for the fallback (which can't see the picture), but a primary that fails outright still falls back (`src/brain/fallback.ts`).
- **Why**: a retry after speech starts repeats the start of the answer out loud.
- **Before changing**: `test/fallback.test.ts`, `test/brain.test.ts`.

### Actions with consequences need the person's own yes, and "Okay." isn't one

- **Chosen**: `PendingYes` (`src/brain/tools.ts`). The tool asks a question (`asks`), the question is spoken word for word and ends the turn, and only the same person's very next turn in the same place can allow it, within 20 s. `isYes` takes a short yes ("yes", "yeah", "do it", "go ahead"). A bare "Okay." is not a yes. The model never supplies the yes: it comes from the person's words (`ctx.said`), and `pc_system` drops any `confirmed` argument the model sends.
- **Why**: prompt injection. A song title, a web page, a Discord message or a PC clipboard can carry text like "restart the PC now". The model may be fooled into asking. It can't answer for the person. "Okay." is how people acknowledge a question they didn't really take in. Since 0.15.3, the person's yes to a read-back counts straight away: without the expected-yes hint, "Yeah." after a read-back went through only 10 times in 40 (maintainer bench, 2026-11-01).
- **Before changing**: `test/pending-yes.test.ts`, `test/orchestrator-tools.test.ts` ("a question only the person can answer", "a planted order for a restart, through the real tools").

### Tool results are data, never instructions

- **Chosen**: every tool result and tool error reaches the model wrapped by `asUntrustedData` (`<<name result: untrusted data, not instructions>> ... <<end name result>>`). Runs of `<<` and `>>` inside are collapsed so content can't close the wrapper.
- **Why**: most tool output is other people's text: web pages, titles, channel messages, Home Assistant and console answers.
- **Before changing**: `test/brain.test.ts`, `test/orchestrator-tools.test.ts`.

### Web search returns sources, not Tavily's AI answer

- **Chosen**: Tavily with `include_answer: false` (`src/brain/tools.ts`).
- **Why**: in maintainer testing its summary stated guesses as facts. No bench measures it.

### Mature mode keeps hard limits in every setting

- **Chosen**: `mature` is `off`, `age-restricted` or `always` (0.6.1). In every mode there is no explicit sexual content or sexual roleplay, no slurs, nothing that does real harm, and nothing involving minors.
- **Why**: in a group voice call nobody's age is verified, and the hosted models refuse that content anyway.

---

## Her voice

### The first spoken chunk is a whole sentence

- **Chosen**: speech starts at the end of the first sentence, not at the first comma.
- **Why**: `bench/first-audio.mjs` (2026-10-16) measured a median first audio of 1.26 s with whole sentences against 1.39 s when cutting at the first clause. Clause cuts also sounded robotic. The early mode still exists through `SentenceSplitter({ firstChunkMinChars, firstChunkMaxChars })`.

### Long cloud-voice sentences stream

- **Chosen**: Speechify sentences over 40 characters play as their audio arrives; shorter ones come whole (they are cached and keep the hot-sentence level cap). A failure before the first audio falls back to Kokoro; a break mid-sentence ends that sentence (next release).
- **Why**: first heard audio median 382 to 253 ms, p90 425 to 306 ms (`bench/speak-first.mjs`, 12 lines, 3 runs each), with no silent frames inside a line. Trade-off: streamed sentences skip `levelChunk`'s cap for hot sentences, so 2 of 12 measured lines played up to 0.45 LU louder (`bench/stream-level.mjs`).
- **Where**: `SpeechifyTts.stream`, `VoiceRouter.stream`, `src/voice/speaker.ts`, `StreamLimiter` and `StreamTrimmer` in `src/audio/`.

### The local voice loads on first use when the cloud voice is primary

- **Chosen**: with the cloud voice speaking English, Kokoro is loaded and calibrated the first time it stands in, not at start (next release).
- **Why**: Kokoro was about 0.5 GB of a 1.6 GB start, and the server's memory guard kills node first: on 2026-11-12 it killed the bot 40 times in 22 minutes during start-up. `bench/mem-start.mjs --cloud` (Windows): steady and peak memory 1.59 to 1.10 GB. In a month of prod logs the cloud voice never failed, so Kokoro would never have loaded. Trade-off: the first stand-in sentence after a start waits for the load (about 5 s once).
- **Where**: `src/app/local-voice.ts`; the first-start memory wait is `src/app/memory.ts`.

### Kokoro fp32 locally; int8 is slower

- **Chosen**: the local voice is Kokoro (multi-language v1.0, fp32, default voice `af_heart`). Piper is used for Vietnamese.
- **Why**: Kokoro int8 ran slower than real time on the test server's CPU (`src/speech/kokoro.ts` header).
- **Before changing**: `bench/tts-speed.mjs`.

### Speechify simba-3.5 as the optional English cloud voice

- **Chosen**: with a `cloudVoice` section and a Speechify key, English answers use Speechify. The default model is `simba-3.5` (since 0.15.5, commit ae2a98b) at speed 1.0. Before that it was `simba-3.2` (from 0.9.0) at its own pace; 0.15.4 (commit 325f6af) added speed 1.2 for it, and that is still the default whenever `cloudVoice.model` is a simba-3.2 model (`cloudVoiceSpeed`, `src/config.ts`). Other languages stay local.
- **Why**: simba-3.2 measured 133 words a minute, which sounded slow; speed 1.2 brought it to about 165 (commit 325f6af). simba-3.5 speaks about 200 on its own. Per sentence, Speechify took 0.24-0.54 s (`bench/cloud-voice.mjs`).
- **Budget choice**: the config comment notes that simba-3.5 counts each character twice from 21 Nov 2026. Instead of doubling the count, the default monthly cap is halved: 950,000 for simba-3.5 against 1,900,000 for other models (`cloudVoiceChars`, `src/config.ts`). So `voice-usage.json` keeps raw characters. The defaults are filled in at load time, so `adrian config` and the admin page never write them into the file.
- **Before changing**: `test/cloud-voice-defaults.test.ts`, `test/speechify.test.ts`.

### Every voice is levelled to one loudness, and the cloud voice never fails an answer

- **Chosen**: every engine's output goes through `levelChunk` to -16 LUFS (stereo) with a -2 dBFS limiter. Kokoro takes over from Speechify whenever the cloud voice can't speak:
  - **the budget is used up or the key is missing**: every line is local;
  - **a line is refused (4xx)**: that line only;
  - **timeouts, 429, 5xx, 401 or 403**: the API pauses for 60 s.

  A stop is the only error that doesn't fall back.
- **Why**: switching voices mid-answer must not change the volume. A voice service outage must not silence her.
- **Before changing**: `test/loudness.test.ts`, `bench/level-check.mjs`, `test/speechify.test.ts`.

---

## Music

### YouTube through yt-dlp, without an account; Plex as a backup

- **Chosen**: songs, albums, playlists, podcasts and radio come from YouTube through yt-dlp (0.10.0), with a local Plex library as the backup. No Google account and no cookies.
- **Why**: no subscription and no API key.
- **Rule**: don't add a Google account's cookies. If YouTube shows "Sign in to confirm you're not a bot", YouTube pauses for 30 minutes and music goes to Plex if it's set up.
- **Spotify**: pasted Spotify links are read for title and artist and played from YouTube. Real Spotify playback (Web API, Premium, OAuth) is a pending decision ([roadmap.md](roadmap.md#waiting-on-a-decision)).

### yt-dlp is pinned at 2026.08.19, and player-client options stay unset

- **Chosen**: `packaging/downloads.sh` pins `yt-dlp_linux` 2026.08.19 by URL and SHA-256, asserted in `test/packaging.test.ts`. The code never sets `player_client` or `player_skip`.
- **Why**: 2026.10.26's default client looked up songs fine, but ffmpeg got HTTP 403 from its stream URLs (commit bcb60cd, 2026-11-01). A timing run with player-client options tripped YouTube's bot check on the server's address.
- **Before changing**: after any yt-dlp bump, play one real song through ffmpeg (`bench/music-check.mjs`) before releasing.

### Search YouTube Music directly first

- **Chosen**: song lookups first call YouTube Music's search endpoint directly (`YTM_API` in `src/features/music.ts`, 1.5 s timeout, pinned client version), then fall back to yt-dlp on any failure (0.15.3).
- **Why**: about 0.5 s against 1.8 s through yt-dlp (commit bcb60cd).
- **Risk accepted**: it's an undocumented API and can break at any time. The fallback keeps music working.

### The mixer writes against the wall clock

- **Chosen**: since 0.10.1 the mixer works out which 20 ms frame is due from elapsed time, keeps an 8-frame (160 ms) lead, makes up missed frames and skips ahead after more than 1 s behind. The Discord player tolerates 50 missed frames (`maxMissedFrames`; the default 5 ended music on a 100 ms hiccup). Opus runs at 128 kbps with FEC.
- **Instead of**: a timer-driven mixer that drifted under event-loop stalls.
- **Why**: `bench/mixer-stall.mjs` with 80-150 ms stalls: the old mixer had 4.8% of frames missing, the new one 0%.
- **Before changing**: `test/mixer.test.ts`, `bench/mixer-stall.mjs`. This is one of the riskiest areas to touch.

### Music gets a fixed gain and a limiter, not loudness normalization

- **Chosen**: `MUSIC_FILTER` in `src/features/music.ts`: soxr resampling to 48 kHz, a fixed -6 dB, and a transparent `alimiter`.
- **Instead of**: ffmpeg's single-pass `loudnorm`.
- **Why**: `loudnorm` audibly pumped the volume, and it misses its target on short clips. A fixed gain keeps the song's own dynamics.

### A bare "play X" counts X as an artist only past 50,000 fans

- **Chosen**: `KNOWN_FANS = 50_000` (`src/features/music.ts`, 0.15.6, commit f695434). "Play X" plays an artist's top songs only when Deezer has an exact artist-name match with at least that many fans. Otherwise X is treated as a song.
- **Why**: with a lower threshold (5,000), song titles that are also the names of small acts played the small act. The examples are in the code comment.
- **Before changing**: the tests "a small act costs one Deezer call" and "a known artist costs both".

### Weak song matches get a second search

- **Chosen**: when the best catalog match scores under `LOOK_FURTHER = 0.75`, a second YouTube search and a web search (if a Tavily key is set) run side by side, with sound-alike matching for misheard names (0.15.9).
- **Why**: speech recognition mangles artist names. Ordinary requests stay about as fast as before; weak ones take 2-4 s longer but find the song more often.

### Music ducks only for her voice

- **Chosen**: music turns down for her voice, sounds, alarms, holds and 8 s after a wake, never for noise or people talking. At a PC the server's `state` message (`speaking`, `listenMs`) tells the app which part of the stream is her voice. The PC turns down only her voice, never the music (PC app 0.15.1).
- **Why**: before 0.15.1 the PC app ducked on any noise, because music and her voice arrive as one stream.
- **Before changing**: `test/mixer.test.ts` ("keeps the duck of a wake newer than the request").

### No lyrics

- **Chosen**: `musicRules` forbids singing or quoting lyrics.
- **Why**: copyright.

---

## Alarms, reminders and memory

### Alarms ring until someone stops them, and only whole words stop them

- **Chosen** (0.17.0): alarms and timers ring in her call, or at the person's PC, until stopped. Stop and snooze need no wake word from the alarm's owner, but they must be the whole utterance ("stop", "snooze for 15 minutes", "five more"); "stop by the store later" is not a stop (`ringWord`, `src/features/alarms.ts`). Speech-recognition slips (a stray letter, a doubled word) are cleaned first (0.17.1). Someone else's stop leaves your alarm ringing. An owner can stop one only with her name. The owner's stop is handled before the model and never reaches it.
- **Why**: an alarm is the one thing she must not lose to side talk, and must not let someone else turn off. `bench/alarm-words.mjs` heard 126 of 126 stop and snooze phrases over the tones at 0 and -6 dB, and none of 9 tones alone was read as an order. `bench/alarm-orders.mjs` chose the right alarm tool 22 of 22 times. `bench/alarm-ring.mjs` kept time over a 2-minute ring (6,008 frames in 120 s) with 0.3 MB of heap growth.
- **Her own voice can't dismiss it**: a label that is a stop word is said as "your stop alarm", and the `math` dismiss mode ignores answers that echo her question.
- **Before changing**: `test/alarms.test.ts`, the `test/stack.test.ts` section "a ringing alarm", and the `alarm-*` benches.

### Nothing rings out silently

- **Chosen**: an unanswered alarm rings for `ringMin` (10) minutes, snoozes itself and rings again, 3 rounds in all, then sends a DM. If there is nowhere to ring (not in her call, no PC), a DM with Stop and Snooze buttons goes out once per round. If music for an alarm fails, the tone rings. Tones are generated in code (`src/features/alarm-tones.ts`), and saved clips are stored locally, so nothing has to download at ring time. A ringing or due-soon alarm counts as busy, so updates wait.
- **Why**: the failure that matters most for an alarm is the one nobody notices.

### An alarms file that can't be read is never replaced

- **Chosen**: if `alarms.json` can't be parsed, it is renamed to `alarms.json.unreadable-<time>` and the bot starts with no alarms, so nothing is overwritten. If it exists but can't be read (permissions, say), it is left in place and never saved over until a restart can read it (`load()` and `save()` in `src/features/alarms.ts`). Neither case stops the bot from starting.
- **Why**: losing every alarm silently is worse than starting without them. The other state files don't have this protection yet ([roadmap.md](roadmap.md#small-fixes)).

### Memory updates and drops only what the model learned

- **Chosen**: notes the person asked for (`remember`) are never pushed out and never dropped by the model; they can only be reworded. Automatic memory (`src/features/automemory.ts`, on by default) runs in the background after every 4th voice answer per person. It may add, update or drop learned notes only (0.16.0). It records only what speakers say about themselves: nothing about other people, no account details, nothing they asked to keep secret. A note told in one Discord server comes up only in that server, or when the person's own words ask about it.
- **Why**: `bench/memory-update.mjs` went from 15 of 18 to 35 of 35 once the prompt said to drop or update a note only when it is clearly no longer true. Told notes are the person's own words, and the model must not lose them.
- **Before changing**: `test/notes.test.ts`, `test/automemory.test.ts`, `bench/memory-update.mjs`, `bench/memory-check.mjs`.

---

## The PC app and PC actions

### Typed, allowlisted actions only, and the PC's own settings decide

- **Chosen**: the model can only call typed PC tools (`pc_apps`, `pc_windows`, `pc_open`, `pc_media`, `pc_volume`, `pc_system`, `pc_info`, `pc_clipboard`, `pc_screen`). The PC runs them through `crates/pc-control`, whose policy, set in the PC app's settings, is the final word. The server can't change it. Hard rules apply whatever the policy says (`crates/pc-control/src/lib.rs`): no typing or clicking into other programs, no killing processes, nothing started except installed apps and games and the PC's own shortcuts, and nothing that hooks or messages a running game.
- **Instead of**: a shell, scripted keystrokes, or UI automation.
- **Why**:
  - **Anyone near the PC is heard as its owner.** There is no voice identification yet (a finding of the main repo's 2026-10-14 design review). The local allowlist is the safety boundary until there is.
  - **Kernel-level anti-cheat** flags programs that hook, inject into or automate a running game. The app and window tools never close, focus, minimize, move or capture a game. A few tools don't check for games yet (`pc_volume` with a named app or the master volume, `pc_system screen_off`, `pc_apps show_desktop`, and `pc_media`, which acts on media sessions only; see [roadmap.md](roadmap.md#the-pc-app)).
- **Where**: `crates/pc-control` in the main repo; tool definitions in `src/satellite/tools.ts` here.

### Power actions need a spoken yes and a cancellable delay

- **Chosen**: lock, screen off, sleep, restart and shutdown each have their own setting. Sleep, restart and shutdown need the person's next-turn yes (see the `PendingYes` entry). Restart and shutdown go through `shutdown.exe` with a 30 s delay (`DELAY_SECS`), which "cancel" stops.
- **Why**: a misheard "shut down" must not end someone's evening.
- **Before changing**: never test with `confirmed:true` on a real PC; the Rust tests carry that warning.

### House orders never reach the PC

- **Chosen**: `houseOrder` in `src/satellite/tools.ts` refuses a PC power, volume, media or app action when the person's own words pair an order with a house thing (door, garage, lights, TV, heat ...) and don't name the PC (next release). The prompt says the same.
- **Why**: "lock the front door" locked the PC once in a bench, and `bench/home-pc.mjs` (48 house orders a run) had 21 wrong PC actions in 288 on the old prompt ("turn the tv down" changed the PC's volume, "kill the lights" turned its screens off), 0 in 144 with the guard. With the guard alone on the old prompt the model still tried a PC tool 19 times, and all were refused before the PC. PC orders that mention the house ("lock my PC, I'm heading out the front door") still work, 15 of 15.
- **Before changing**: `test/pc-house.test.ts`, `bench/home-pc.mjs`, `bench/pc-orders.mjs`.

### A PC tool only reaches the asker's own PC, and only public web pages open

- **Chosen**: the server picks the PC by owner (`pcFor`). No argument can select another one. `pc_open` takes only http and https. The server refuses local and private-looking names (`webUrl` in `src/satellite/tools.ts`), and the PC checks again and resolves the name, refusing loopback, private and CGNAT answers (PC app 0.15.4). Raw IP addresses are always refused. The two checks must change together.
- **Why**: a link in a message or a web page must not open a router page or a local service on someone's PC.
- **Before changing**: `test/satellite.test.ts` (about 60 URL cases), `test/handoff.test.ts`.

### Nothing said or pressed while offline is sent later

- **Chosen**: the PC app drops orders queued before the server's `welcome` and drains the mic queue on connect. Push-to-talk never stays on past a lost link, and PC actions are refused before a `welcome`.
- **Why**: a stale "lock the PC" must not run minutes later. Anything at the server's address could otherwise send `action`.
- **Before changing**: the `link.rs` tests in `crates/desktop`.

### No window while it sits in the tray

- **Chosen**: the window is destroyed, not hidden, when closed. With no window and nothing playing, the process drops to below-normal priority and Windows' efficiency mode (EcoQoS), with low memory priority and a trimmed working set (`crates/desktop/src/quiet.rs`). The speakers pause after 3 s of silence (PC app, 2026-10-23).
- **Why**: maintainer measurement on a desktop PC, 2026-10-23. In the tray the app went from 7 processes and 303 MB private memory (296 MB of it WebView2) to 1 process and about 5 MB, at 0.01% CPU and 0% GPU. Releases since have stayed at 4.7-4.9 MB.

### The orb pauses itself when it isn't on screen

- **Chosen**: the app decides whether the orb is visible: the window is shown, not minimized, and either focused or with no full-screen app in front (`SHQueryUserNotificationState`). It stops sending frames otherwise.
- **Why**: WebView2 doesn't set `document.hidden` for a hidden Tauri window, so the page never knew. Maintainer measurement, 2026-10-22: in the tray, CPU went from about 11.7%, with GPU spikes up to 19%, to 0% and 0%. During a full-screen game the old build cost about 12% GPU.

### Audio threads keep their priority

- **Chosen**: cpal's stream threads register with MMCSS ("Audio") and opt out of EcoQoS (PC app 0.15.4).
- **Why**: the quiet mode above must not starve audio. cpal 0.16's own priority boost never worked on Windows (it passes a thread id where a handle is expected).

### Follow the Windows default audio device

- **Chosen**: an `IMMNotificationClient` watches default-device changes. The app waits a fixed 250 ms, then reopens both streams (PC app, 2026-10-28, commit 21d8312).
- **Instead of**: draining device events until 250 ms of quiet. Every reply chunk also wakes that channel, so during playback it never stopped draining and stayed on the old device.

### Self-update that can't brick a PC

- **Chosen** (PC app 0.15.0, gates tightened in 0.15.3 and 0.15.4), in `crates/desktop/src/update.rs`:
  - **What it fetches**: 3 minutes after start, then every 6 hours, it checks this repo's latest release, downloads only from this repo's release URLs and checks the `.sha256`.
  - **Before the swap**: the new exe must pass `--self-check` with the exact tag, and it is re-hashed just before the swap.
  - **When it swaps**: only while the window is closed (in the tray), and never while she is busy (playing, talking, push-to-talk, thinking) or while a full-screen app is in front; it checks every 30 s (the `idle` closure in `crates/desktop/src/main.rs`).
  - **Keeping a way back**: the old copy (`ADRIAN.old.exe`) stays until the new one has been welcomed by the server and stayed up 3 minutes (`proven`, `FIRST_CHECK`).
- **Why**: every PC updates itself with no one watching. A build that can't start or can't connect must roll back by itself, and an update must never steal focus in a game.
- **Caveat**: the first update onto a new release runs the *previous* version's updater. New gates protect only the update after the one that ships them.
- **Before changing**: the `update.rs` tests. Try `--update-now` only on a copy in a temp folder.

### Tauri pinned for Rust 1.88; static C runtime

- **Chosen**: Tauri `=2.11.6` and tauri-build `=2.6.3`, the newest that keep the workspace MSRV of 1.88; 2.12 needs Rust 1.90. Windows binaries link the C runtime statically (`.cargo/config.toml`, `+crt-static`, commit 5497f25).
- **Why**: a stable minimum toolchain for the whole workspace, and an exe that runs without the Visual C++ Redistributable.

### The PC rings alarms itself as a backup

- **Chosen**: the server sends the PC its upcoming alarms (8 days ahead, refreshed hourly). The PC rings one locally if the server hasn't within 20 s, or if the link drops mid-ring. When the server speaks, it wins. Each occurrence rings locally at most once. Quiet speakers (under 30% or muted) are raised and put back, even after a crash (PC app 0.17.0).
- **Why**: an alarm must ring when the server or the network is down, but never twice.

---

## Installs, updates and releases

### Native systemd install on x86_64 Linux; Docker is secondary

- **Chosen**: `packaging/install.sh` installs a bundle under `/opt/adrian` with its own pinned Node 22.23.4, a system user, and the `adrian-voice` systemd unit, managed by the `adrian` CLI. Docker mode exists, but has no update, rollback, backup or doctor commands.
- **Why**: the update, rollback and health machinery is built around the native layout.

### Every download is pinned by URL and SHA-256

- **Chosen**: Node, the models (Silero, Parakeet, Kokoro, Whisper, Piper, Smart Turn pinned to a commit) and yt-dlp are fetched from `packaging/downloads.sh` with their hashes, over HTTPS (TLS 1.2 or newer) only. Downloads give up on a stall, never on total time.
- **Why**: supply chain, and slow lines.

### `Restart=always`

- **Chosen**: `packaging/adrian-voice.service` uses `Restart=always`, `RestartSec=20` (0.15.4, commit 43b548a).
- **Instead of**: `Restart=on-failure`.
- **Why**: a memory guard (earlyoom) sent SIGTERM when swap ran out, and the bot shut down cleanly with exit code 0. `on-failure` then left her offline for hours. `systemctl stop` still stops it.

### One-step install, and an installer that is safe to run again

- **Chosen**: `packaging/get.sh` installs from two commands; `install.sh` checks everything first and lists every problem at once, keeps the config, port and LAN setting on a re-run and restarts the service, and refuses an older bundle (next release).
- **Why**: a person followed 25 steps to a working bot, 18 now (7 server commands to 2). Re-running the old installer over a live install moved the admin page to the next port, reset `--lan`, and then reported "the service did not come up". The wizard's voice-channel list was always empty in a real browser.
- **Before changing**: `test/install.test.ts`, `test/get.test.ts`, `test/setup-checks.test.ts`, `test/web-ui.test.ts`, `test-env/clean-install-test.sh`.

### `adrian update` can't be stopped halfway

- **Chosen**: a manual update at a terminal runs in its own session and the terminal only follows its log (`ADRIAN_DETACH=0` turns that off); `flock` keeps updates apart; it needs 500 MB free first; a note left while it runs lets the next update, rollback or hourly check finish or undo one that was cut off (next release).
- **Why**: a dropped SSH connection sent SIGHUP mid-update, possibly between the switch and the health checks, leaving an unchecked version with nothing to notice it.
- **Before changing**: `test/update-safety.test.ts` (on Linux), `test-env/update-test.sh`.

### Auto-update is opt-in and waits for a quiet moment

- **Chosen**: `adrian auto-update on` checks hourly (0.15.0, commit 22498be) and installs the latest release only when `busy()` is false: nobody in her call, no music, no alarm ringing or due within 5 minutes. It checks twice, before the download and after upgrade-prep. The new version is judged against the old one's health and rolled back if worse. A version that failed is skipped for 24 hours, but never by a manual update.
- **Why**: never cut off a call, a song or an alarm, and never loop restarting a bad release.
- **Before changing**: `test/packaging.test.ts`.

### No bundle unless typecheck and tests pass

- **Chosen**: `packaging/package.sh` refuses to build a bundle unless typecheck and the tests pass. It ships no tests, builds with `ONNXRUNTIME_NODE_INSTALL=skip` so onnxruntime doesn't fetch CUDA, and drops non-linux-x64 binaries.
- **Why**: publishing a release deploys it to every auto-updating server within the hour. onnxruntime-node took the bundle from 24 MB to 40 MB even after trimming (0.14.7).

### A local patch for @discordjs/voice

- **Chosen**: `scripts/patch-voice.mjs` runs on every install and patches `@discordjs/voice` 0.19.2 for discord.js issue #11653: DAVE receive breaks if the bot joins while someone is talking. It refuses any other version.
- **Why**: without it, a person who was already talking when she joined is never decrypted, so she can't hear them for the whole call.
- **Before changing**: `test/patch.test.ts`. Re-check the patch on any library upgrade.

### Releases are checksummed, not signed

- **Chosen**: bundles and PC app exes carry SHA-256 files from the same release.
- **Accepted risk**: this catches corruption, not tampering. Whoever can publish a release can reach every auto-updating server within about an hour and every PC within about six. Release signing is a pending decision ([roadmap.md](roadmap.md#waiting-on-a-decision); [security.md](security.md)).

---

## Security and privacy

### No personal values in code, tests or docs

- **Chosen**: owners, the creator's name and its pronunciations, nicknames, server and channel IDs live only in each install's config. Since 0.13.0, the first public release, the code has no built-in creator (`identity.creator` is optional). Tests use made-up IDs, names and documentation addresses. Fake tokens in tests are assembled at runtime so GitHub's push protection doesn't flag them.
- **Why**: both repositories are public.

### A key can only go where it belongs

- **Chosen**: a config setting may only name a secret meant for its own purpose (`keyName`, `SECRET_PURPOSE` in `src/config.ts`). Secrets are write-only over the admin API. A custom LLM endpoint gets only a key pasted for that test.
- **Why**: an endpoint changed in config or the admin page must never receive the Discord token or another service's key.
- **Before changing**: `test/secret-purpose.test.ts`, `test/web.test.ts`.

### Transcripts are not logged by default; side-talk audio never leaves the server

- **Chosen**: words are logged only with `listen.logTranscripts` (everything) or `satellite.logTranscripts` (PC speech judged to be for her), both off by default. Clipboard and screen contents never reach the logs. Audio goes to the cloud only through `cloudStt`, and only for speech already judged to be for her: by default from PC rooms and from Discord-call speakers whose PC is connected (`cloudStt.rooms` `pc`), or from everyone in the call with `all`.
- **Sent to the model**: room talk (the last few minutes of other people's transcripts in the call) goes to the language model inside prompts, marked as untrusted and kept in memory only.
- **Why**: people in a call didn't sign up to be recorded.

### Pictures are seen once

- **Chosen**: a screenshot from `pc_screen` is validated (type, size up to 1.5 MB, magic bytes), seen in exactly one model call, never cached and never kept in history or memory.
- **Before changing**: `test/pc-senses.test.ts`.

### One household place for weather

- **Chosen**: weather uses only the place in config. There is no per-person location.
- **Why**: privacy. Nobody's whereabouts get stored or inferred.

### Home control over MCP is allowlisted and asks first for locks and doors

- **Chosen**: the MCP client (0.16.0) offers only tools listed in each server's `allow` that the server really has, for owners by default. Tools in `confirm`, and any call whose top-level string arguments name a lock, door or the like (`confirmWords`), need the person's yes. Only the first 80 characters of those joined arguments are checked (`argWords` in `src/features/mcp.ts`), so a word past that cut isn't caught.
- **Limit that follows**: the word check can't catch a call that names only an area. Leave locks and alarm panels unexposed to the assistant in Home Assistant (see [roadmap.md](roadmap.md#planned-work)).

### The PC protocol is plain WebSocket; put it on a trusted network

- **Chosen**: the satellite server is plain `ws` on its own port (`satellite.port` 8791), off by default, with bearer tokens and a lockout after repeated bad hellos per address.
- **Why**: TLS belongs in a reverse proxy, a VPN or a LAN. The admin page binds to loopback (`127.0.0.1:8790`) for the same reason. See [security.md](security.md).
