# What A.D.R.I.A.N. costs

This page covers money (what each answer costs and why, every outside service, the budgets that cap it) and machine cost (memory, CPU, disk, network). It also lists the levers that make it cheaper and the code rules that keep it cheap.

Related: [configuration.md](configuration.md) (every key), [tools.md](tools.md) (per-tool cost notes), [architecture.md](architecture.md) (latency and data flow), [pc-app.md](pc-app.md), [decisions.md](decisions.md), [roadmap.md](roadmap.md), [troubleshooting.md](troubleshooting.md).

How to read the numbers:
- **Code** values are defaults and constants in this repo; the file is named.
- **Measured** values carry their date and source. Several come from the maintainer's bench runs and dated notes and can't be re-run from the repo alone. They are marked as such.
- **Arithmetic** rows are worked out from the code's formula and the measured token counts. They are estimates, not measurements.
- Vendor prices and free tiers change. The prices in the code were checked on 2026-10-14/15 (`src/web/checks.ts`). Check the vendor's page before you rely on them.

---

## 1. At a glance

| Item | What you pay | Counted by the dollar caps? |
|---|---|---|
| Language model (required) | Per token. Recommended preset: Claude Haiku 5.5 at $0.10 per million input tokens, $0.01 cached, $0.50 output. In a sample of 20 answers ending 2026-11-20, **about $0.0011 per answer**. | Yes |
| Cloud voice, Speechify (optional) | Your Speechify plan: Free $0 or Starter $10 a month on Speechify's pricing page (checked 2026-11-20, section 3.3). Capped at `cloudVoice.monthlyChars` (950,000 characters a month for `simba-3.5`), then the free local voice takes over. | No, its own character budget |
| Cloud second listen, Groq Whisper (optional, off by default) | $0.04 per hour of audio, at least 10 s billed per request (Groq's docs, checked 2026-11-20), so about $0.0001 per request. Only speech already judged to be for her is sent. | No |
| Web search, Tavily (optional) | 2 credits per `web_search` (advanced depth, from the next release; 1 before), 1 for the other lookups. Free plan: 1,000 credits a month, so about 500 of her searches (admin UI text, `web/app.js`). | No |
| Everything else | Free: local speech recognition and voices, local phrases, music from YouTube and Deezer, weather, news, calendars, Steam, Plex, Sonarr, Radarr, Home Assistant, Helix, Discord, GitHub updates. | — |
| Server machine | About 1.5-1.6 GB of RAM after start (about 0.5 GB less with the cloud voice on, from the next release), about 1.3 GB more once someone speaks a language other than English. Service capped at 4 cores, `MemoryHigh=4G`, `MemoryMax=5G`. About 2.1 GB of models on disk. | — |
| PC app | About 5 MB of private memory and 0.01% CPU in the tray. No AI runs on the PC; all paid calls happen on the server. | — |

Default caps: `limits.dailyUsd` $1, `limits.monthlyUsd` $10, `limits.perUserPerHour` 30 requests. At $0.0011 an answer, $10 covers about 9,000 answers (arithmetic).

### Example month (arithmetic)

Assumptions: a household asks 30 questions a day that reach the model, every answer is spoken with Speechify, about 175 characters per answer (20-40 words), and the Groq second listen is on for every one of those questions. Prices as above.

| Item | Working | Per month |
|---|---|---|
| Language model | 30 x 30 days x $0.0011 | about $1.00 |
| Speechify | 30 x 30 x 175 = about 160,000 characters, plus alarm and briefing lines | $0 on the Free plan (333,000 `simba-3.5` characters from 21 Nov 2026) |
| Groq second listen | 900 requests x 10 s minimum = 2.5 hours x $0.04 | about $0.10 |
| Tavily | a few searches a day | $0 on the free plan |
| **Total** | | **about $1.10** |

At 100 questions a day the model comes to about $3.30 a month, still under the default `limits.monthlyUsd` of $10, and Speechify passes the Free plan (about 525,000 characters), so it needs Starter at $10. Phrases answered locally (section 2.6) and side talk in a call cost nothing and are not in these counts. The Free plan pauses when its balance runs out; the bot then uses the local voice.

---

## 2. The language model

### 2.1 What one answer is made of

A spoken or typed question that the local phrase matcher can't handle goes to the model (`respond()` in `src/app/stack.ts`, `ConversationOrchestrator.ask()` in `src/brain/orchestrator.ts`). Each model call sends:

| Part | Size | Cached on Claude? |
|---|---|---|
| Stable prompt: rules, style, music rules, PC rules, alarm rule (`stablePrompt`, `stableLines`) | about 2,260 tokens (prompt audit, 2026-11-01) | Yes |
| Tool specs | about 5,500 tokens, 3,100 of them scaffolding (audit, 2026-11-01). The alarm tools of 0.17.0 added about 1,170 tokens per call (2026-11-19). Every allowed MCP tool (`mcp.servers`) adds its own spec on top. | Yes |
| Per-request context: who is asking, nickname, call roster (up to 25 people), language, mature mode, the asker's notes, music state, PC lines, game lines | varies; the 0.12.x cache bench left 130-210 uncached tokens a call | No |
| Room talk: what was said aloud in the call in the last 5 minutes | up to 24 lines of 200 characters (`src/conversation/room.ts`), so up to about 1,200 tokens | No |
| History: up to 16 messages per person (her answers and theirs, so about 8 exchanges), forgotten after 60 idle minutes (`SessionMemory(16, 60 min)`) | grows with the conversation | Up to the last assistant turn, yes |
| Output: the spoken answer plus thinking (`brain.effort` `low`) | answers are asked to be one sentence under twenty words, two short sentences (forty words) at most for how and why questions, and the rule is repeated at the end of every spoken turn (`SPOKEN_TURN`, about 60 uncached tokens a call). In the maintainer's benches that cut the median spoken answer from about 35 to about 23 words (`bench/answer-length.mjs --real`), so output tokens fell by 10-30 per call | — |

One request can make up to **4 model calls**: the first call plus up to `maxToolRounds: 3` tool rounds (hard-coded in `stack.ts`). Each round re-sends everything above plus the tool results. When every tool in a round returns a `speak` line (alarms, timers, reminders, notes, music, Steam, server control, PC confirmations and others), the orchestrator says those lines and skips the second call. For a simple PC order that is about half the calls. Since the next release, alarm edits and alarm settings, game-night sign-ups, music likes and "remember ..." also speak for themselves: in the maintainer's benches those confirmations went from 2 model calls to 1, and their first audio about 0.4 s sooner (median 1,235 to 816 ms on 12 turns); alarm-orders went from 189 to 169 micro-dollars a turn.

Tool results that add input tokens:
- `pc_screen`: one picture, long side at most 1568 px. The code counts a picture as 1,600 input tokens when it has to estimate (`IMAGE_TOKENS`, `src/brain/images.ts`); the provider's real count depends on the size. Only the Claude adapter sends the picture. OpenAI-compatible models, as primary or fallback, get a note that the picture can't be read instead, so the picture costs nothing there.
- `pc_clipboard`: up to 8,000 characters (about 2,000 tokens).
- `server_info` up to 6,000 characters, MCP results up to 4,000, text chat history block up to 4,000.

### 2.2 The cost formula

Every call's usage goes through one function (`costUsd`, `src/app/stack.ts`):

```
cost = ( (input - cached - cacheWrite) * priceInPerM
       + cached * priceCachedInPerM
       + cacheWrite * priceInPerM * (1.25 if provider is anthropic, else 1)
       + output * priceOutPerM ) / 1,000,000
```

- `brain.priceCachedInPerM` unset: Claude uses 0.1 x `priceInPerM`, other providers the full input price.
- Claude's 5-minute cache writes cost 1.25 x input; reads cost 0.1 x.
- With Claude, the adapter's input count already includes cache reads and writes (`src/brain/anthropic.ts`). OpenAI-compatible providers report cached tokens in `usage.prompt_tokens_details.cached_tokens` and no cache-write count.
- If an answer is stopped mid-stream, the provider still bills but sends no usage. The orchestrator then estimates the whole request at `ceil(chars / 4)` tokens (pictures at 1,600) at the plain input price, plus the output so far. It errs high on purpose. Errors that were not stops are not estimated.

### 2.3 Prompt caching (Claude only)

With `brain.provider` `anthropic`, the orchestrator turns on `stablePrefix`: every tool is sent on every call, in a fixed order, so the prefix is byte-identical from call to call. `src/brain/anthropic.ts` puts `cache_control: { type: 'ephemeral' }` on the stable system block and on the last assistant message of the history (two breakpoints). The stable part is shared by everyone; the history part is per person. The cache lasts 5 minutes after its last use.

From the next release, a cache warm-up (`brain.prewarm`, on by default, Claude only) writes that prefix while a woken question is still being listened to: when the question heads to the cloud listen, at a PC already when its early listen or a held sentence starts that listen, and on push-to-talk. The answer then reads the cache instead of writing it. Measured on the real API with the production prompt (13.9k cached tokens, `bench/prewarm.mjs`): first spoken chunk after a quiet spell 882 to 803 ms (median); with kept-open connections (`src/core/http.ts`) as well, 854 to 787 ms with no warm-up and 814 to 775 ms with one. Cost: about $0.00015 more per answered wake (8%), about $0.0017 for a warm-up nothing follows, and sometimes a double write (+$0.0018) when the cloud listen comes back in under about 300 ms. Skipped while the prefix is warm, for stops, local orders, music orders and the time, and past the spend caps; at most `brain.prewarm.maxPerHour` (20) an hour. Warm-ups count in the ledger.

Other providers don't get `stablePrefix`. They get the tool subset picked by `routeTools` (`src/brain/tool-router.ts`) from the words of the request. PC tools have no router group, so with `satellite.enabled` they are offered on every call either way.

Measured (`bench/cache-check.mjs`, version 0.12.x, October 2026, before 2026-10-16; the bench uses only part of today's prefix):
- the first call writes about 2,185-2,599 tokens;
- later calls read 83% (single questions) to 90-93% (a six-turn conversation) of their input from the cache, leaving about 130-210 uncached tokens a call;
- input cost about 75% lower.

These are two different figures. The share is of tokens; the saving is of money. For example, 83% of tokens read at 0.1x the price plus 17% at full price comes to about 25% of the uncached input bill.

### 2.4 Per-answer cost: measured and worked out

Measured:

| What | Cost | Date and source |
|---|---|---|
| Live answers, sample of 20 answers ending 2026-11-20 | about $0.0011 per answer (small sample, treat as rough) | `answered` log lines of one deployment |
| Haiku on the real prompt of that time (`bench/claude-vs.mjs`) | about $0.0002-0.0005 per question; first spoken chunk median 1.3 s | 2026-10-15 bench. Prompt was smaller then. |
| Sonnet and Opus in the same bench | about 20x and 40x Haiku's cost; first chunk 1.3 s and 2.1 s | 2026-10-15, priced with the bench's own table ($2/$10 and $4/$20 per million) |
| A 942-call A/B bench (thinking on vs off) on Haiku | $0.12 in total | 2026-11-01 |
| Wizard estimate shown at setup (`checkLlm`, `src/web/checks.ts`) | 900 input + 60 output tokens x price, about $0.00012 on Haiku | code. It ignores the tool specs and caching, so it reads low. |

The cached prefix was measured with `bench/prompt-size.mjs` (free `count_tokens`): 13,481 tokens at 0.17.1 (10,598 of them tool specs), about 13,990 with the next release's prompt changes. A cold answer (the whole prefix written) then costs about $0.0018 on Haiku and a warm one about $0.0003; the 2026-11 prod logs had 29 of 52 answers cold.

Worked out (arithmetic, Haiku preset prices, a 9,000-token stable prefix from the 2026-11-01 audit plus the alarm tools, 300 uncached tokens, 150 output tokens including thinking):

| Call | Stable prefix | Uncached | Output | Total |
|---|---|---|---|---|
| Cold cache (first call in 5 minutes) | 9,000 x $0.125/M = $0.00113 | $0.00003 | $0.000075 | **about $0.0012** |
| Warm cache | 9,000 x $0.01/M = $0.00009 | $0.00003 | $0.000075 | **about $0.0002** |

A question that uses a tool adds a second call, usually warm. At household pace questions are often more than 5 minutes apart, so many answers pay the cache write. The live sample is consistent with that: it sits near the cold figure and above the October bench.

### 2.5 Calls you might not expect

| Source | When | Cost |
|---|---|---|
| Follow-up judging | Words said without her name inside a follow-up window, and "loose" wakes (her name followed by "is", "was", "said" and similar), go to the model, which may answer `SILENT` | A full call, even when she stays silent. Counts toward the hourly limit. |
| Text chat follow-ups | With `textChat.readChannels` on (the default): for `textChat.followUpMinutes` (3) after she answers someone, their next messages, and any channel message that names her without an @mention, go to the model | A full call each, even when the reply is `SILENT`. With `textChat.readChannels`, the last `textChat.historyMessages` (30) messages ride along (up to 4,000 characters). |
| Automatic memory (`autoMemory`, on by default) | Every 4 exchanges per person, one run at a time (`src/features/automemory.ts`) | One call with a prompt of about 240 words (about 350 tokens), up to 30 notes (`MAX_NOTES`, `src/features/notes.ts`) and the last 10 history messages, `maxTokens` 300 (2048 on Claude, see 2.7), 30 s limit. Booked at the main model's prices, or `brain.background`'s when that model answered, with no cache discount. No measured token count yet. |
| Music quiz near-miss judge | Only when a guess is close but not exact | At most 2 calls per round (`JUDGE_CALLS`), each asked for 5 output tokens (a hard cap on OpenAI-compatible providers; on Claude the cap is 2048 and thinking adds output), main-model prices, 4 s limit. Starts, answers and orders are matched locally. |
| Fallback model | Primary fails before its first event (4.8 s by default) | Priced at the **primary's** prices in the ledger (the fallback has no price fields). |
| Wizard key test, `POST /api/check/llm` | Once per test | One short call, not recorded in the ledger. |
| Benches in `bench/` | When you run them with real keys | Paid by your key, not recorded in the ledger. |

### 2.6 Calls that cost nothing

Handled before the model (`local()` and `localMusic()` in `src/app/stack.ts`, `src/conversation/intents.ts`):
- "what time is it", "thanks", "bye", "okay", "say that again", "louder", "quieter", "faster", "slower" ("okay", "yeah", "sure" and similar go to the model when her last line was a question; at a PC with no music playing, "louder" and "quieter" go to the model's `pc_volume` unless they're about her voice);
- clear music orders: play X, pause, resume, stop, skip, back, music volume N percent, what's playing, play that link;
- quiz answers and controls;
- alarm stop, snooze and "I'm up" words while one rings;
- `/alarm`, `/play`, `/music`, typed `!` music commands, alarm DM buttons;
- the morning briefing on join, heads-up lines, weekly recap posts, reminder delivery and alarm ring lines.

Music plays still count toward `limits.perUserPerHour`, but cost nothing.

### 2.7 Providers and presets

The setup wizard offers three presets (`LLM_PRESETS`, `src/web/checks.ts`, checked 2026-10-14/15). Any OpenAI-compatible endpoint also works, including a local one.

| Preset | Model | USD per 1M tokens: in / cached in / out | Notes |
|---|---|---|---|
| `claude` (recommended) | `claude-haiku-5-5`, `brain.effort` `low`, key `ANTHROPIC_API_KEY` | 0.10 / 0.01 / 0.50 | Pay as you go. A claude.ai chat subscription doesn't include API use. Prompt caching on. |
| `groq` | `openai/gpt-oss-120b` at `https://api.groq.com/openai/v1`, key `GROQ_API_KEY`, `reasoning_effort` medium | 0.15 / – / 0.60 | Free tier: 8,000 tokens a minute and 200,000 a day. In testing around 2026-10-15 that allowed 2-3 tool questions a minute before falling back, and the daily cap was reached in one day of testing. A paid tier lifts both limits. |
| `gemini` | `gemini-3.1-flash-lite` at Google's `/v1beta/openai`, key `GEMINI_API_KEY`, `reasoning_effort` none | 0.25 / 0.025 / 1.50 | Free tier is slow and rate-limited, and Google may use free-tier prompts. As a free fallback it took over 8 s and timed out in the same early testing. |

The recommended pairing is Claude as `brain` and Groq's free tier as `brain.fallback`. `brain.maxTokens` (500) is a real output cap on OpenAI-compatible providers. On Claude it is sent as `max(2048, maxTokens x 4)` because thinking counts against it, so the answer's length is held by the prompt rule, not by this key.

---

## 3. Speech

### 3.1 Speech recognition: local and free

Every speech segment, from everyone in a call or at a PC, is transcribed on the server with Parakeet TDT 0.6B v3 int8 (sherpa-onnx) and checked for the wake word in text. No audio goes to the language model. Non-English questions get a second local pass with Whisper small. The cost is CPU and memory only (section 7).

### 3.2 Cloud second listen: Groq (optional)

`cloudStt` re-transcribes speech that the local path already judged to be for her (woke her, or came inside a follow-up window; not stops or a bare name) with Groq's `whisper-large-v3-turbo` (`src/speech/cloud-stt.ts`).

| Key | Default | Effect on cost |
|---|---|---|
| `cloudStt.enabled` | `false` | Off: nothing goes to Groq. |
| `cloudStt.rooms` | `pc` | `pc`: PC rooms, plus people in the call who have a PC connected. `all`: everyone in the call, so more requests. |
| `cloudStt.apiKeySecret` | `GROQ_API_KEY` | Can share the key with a Groq brain fallback. |
| `cloudStt.timeoutMs` | 1500 | Longest wait before the local words are used. |

- Side talk never leaves the server (`test/stack.test.ts` "speech not meant for her never reaches the cloud").
- With the early listen at a PC (`satellite.earlyListen`, on by default), the Groq request starts during the pause at the end of a request. When the person goes on talking within 0.8 s, that request is aborted and a second one is made for the whole clip. Groq may still bill the aborted one (at least 10 s each, below), so a request said with a short pause can cost two Groq requests. Stops, her name alone, side talk and speech in her call never go early. One edge: the early listen judges a follow-up window from a start time up to about 50 ms off, so speech right at the window's edge can be sent early and then judged not for her; its words are not used, but that audio did reach Groq.
- HTTP 429 or 5xx pauses the cloud listen for 60 s; a timeout, error or empty text keeps the local words.
- From the next release, every Groq call (aborted early ones too) counts in one sliding minute. Early calls go out only while that minute has fewer than 14 (Groq's ~20 minus 6 kept for calls someone waits on), and not for 10 minutes after a 429. On a meeting recording, early calls that were dropped went from 26% to 16%.
- Price (Groq's speech-to-text docs, https://console.groq.com/docs/speech-to-text, checked 2026-11-20): $0.04 per hour of audio for `whisper-large-v3-turbo`, with at least 10 seconds billed per request. Her segments are mostly shorter than 10 s, so count about $0.00011 per request: 1,000 requests cost about $0.11. No price is in the code.
- Rate limits: Groq's rate-limits page (https://console.groq.com/docs/rate-limits, checked 2026-11-20) lists 20 requests a minute, 2,000 a day, 7,200 audio seconds an hour and 28,800 a day for this model; your account's limits page shows your own tier. The maintainer's speech comparison bench of 2026-10-21 spaces its requests 3.2 s apart for the same reason ("Groq free tier: ~20 a minute", `bench/stt-compare.mjs`). Past the limit Groq answers 429, which pauses the cloud listen for 60 s.
- Not counted by the dollar caps.

### 3.3 The voice

| Voice | Where | Cost |
|---|---|---|
| Kokoro `kokoro-multi-lang-v1_0` fp32 (default voice `af_heart`), Piper for Vietnamese | local CPU | Free. Spanish, Chinese, Japanese and Vietnamese are always local. |
| Speechify (`cloudVoice`, voice `sabrina`, model `simba-3.5`) | cloud, English only | Characters against your Speechify plan |

Speechify's API plans (https://speechify.ai/pricing, checked 2026-11-20):

| Plan | Price | Included each month | After the balance |
|---|---|---|---|
| Free | $0, no card | 500,000 characters of Simba 3.0/3.2; `simba-3.5`: 500,000 until 21 Nov 2026, 333,000 after | Pauses until next month; no top-up |
| Starter | $10 a month | 2M characters of Simba 3.0/3.2; `simba-3.5`: 2M until 21 Nov 2026, 1.3M after | Top-up at $10 per 1M characters (3.0/3.2) or $15 per 1M (`simba-3.5`, $10 until 21 Nov 2026); auto top-up is off by default |
| Pro, Scale | $99, $499 a month | 13.6M and 99.8M characters (3.0/3.2) | Same top-up model |

The code's default caps were set from an earlier reading of the Starter plan (1.9M characters, `simba-3.5` counted twice). On the page as checked on 2026-11-20, Starter covers 2M characters and `simba-3.5` uses 1.5 times the balance from 21 Nov 2026 (1.3M characters). The default 950,000 cap therefore stops well short of what Starter now covers for `simba-3.5`, and is above the Free plan's 333,000. On the Free plan, set `cloudVoice.monthlyChars` to 333,000 (or 500,000 on `simba-3.2`) so the bot switches to the local voice before Speechify pauses. On Starter you can raise it to about 1,300,000 for `simba-3.5`.

Speechify keys and defaults (`src/config.ts`, `src/speech/speechify.ts`):

| Key | Default | Notes |
|---|---|---|
| `cloudVoice` | absent | Absent means local voice only, which costs nothing. |
| `cloudVoice.model` | `simba-3.5` | |
| `cloudVoice.monthlyChars` | 950,000 for `simba-3.5*`, 1,900,000 for other models (`cloudVoiceChars`) | The code comment: the Starter plan covers 1.9M characters a month, and `simba-3.5` counts each character twice from 21 Nov 2026. The cap is halved instead of doubling the count, so `voice-usage.json` holds raw characters. 0 = no cap. |
| `cloudVoice.timeoutMs` | 4000 | Per sentence; on timeout that sentence uses the local voice. |
| `cloudVoice.speed` | 1.0 on `simba-3.5`, 1.2 on `simba-3.2` | `simba-3.2` speaks 133 words a minute (1.2 brings it to about 165); `simba-3.5` about 200 (`config.ts` comment, 2026-11-08). |

What uses characters:
- every sentence of an English reply, except short lines already cached (40 characters or fewer, up to 64 in memory);
- spoken lines from features: alarm ring lines (every 60 s or 20 s while ringing), reminders, briefings, heads-ups. Estimate only: an unanswered alarm with voice lines is about 0.5-1.5k characters; a private briefing a few hundred;
- one 110-character calibration sentence per process start;
- about 92 characters of pre-cached short lines ("Yes?", "One sec." and so on) plus each `ownerAck` and `ownerStopReply`, on every restart;
- a 3-character "Hi." warm-up when someone starts talking after 30 idle minutes.

Not charged: local fallbacks, cache hits, failed calls (characters are added only after audio arrives). Past the cap, a refused line, a missing key, or an outage (401/403/408/429/5xx/timeouts pause it 60 s): the local voice speaks.

Rough capacity (arithmetic): an answer of 20-40 words is about 100-250 characters, so 950,000 characters cover roughly 4,000-9,500 spoken answers a month.

Speechify spending is **not** in `limits.dailyUsd` or `limits.monthlyUsd` and is not shown in the admin UI. The monthly count lives in `<state>/voice-usage.json` (`{ "version": 1, "months": { "YYYY-MM": chars } }`).

---

## 4. Other outside services

| Service | Used for | Key | Cost and limits in code |
|---|---|---|---|
| Tavily `api.tavily.com/search` | `web_search` (`brain.search.maxResults` 4), `pc_open search` (finds the page, 3 results), web check for weak song matches (5 results, YouTube domains, only below a 0.75 match score) | `TAVILY_API_KEY` (`brain.search.apiKeySecret`) | `web_search` is an advanced search, 2 credits, from the next release (basic missed plain facts such as a song's key); the other two are basic, 1 credit. Free plan 1,000 credits a month. Tavily's own answer is turned off. The wizard's test uses one search. Without a key: no `web_search`, `pc_open search` opens a Google results page, the music web check is skipped. Not counted by the caps. |
| YouTube via yt-dlp (pinned 2026.08.19) and the YouTube Music search endpoint | music, sounds, alarm clips, quiz clips, PC YouTube | none | Free. A "Sign in to confirm you're not a bot" check pauses YouTube for 30 minutes. Don't add a Google account's cookies. CPU and bandwidth on the server. |
| Deezer public API | artist detection, top songs, quiz charts | none | Free. 3 s timeout (search), 4 s (charts), charts cached 6 h. A bare "play X" makes 1 call, 2 when X is a known artist. |
| Spotify page (`open.spotify.com`) | reading a pasted Spotify link | none | Free, one page fetch. |
| Open-Meteo | weather | none | Free. Geocode once per process, forecast at most once per 10 minutes. |
| News feeds (default NPR top stories, `news.feeds`) | headlines | none | Free. At most once per 30 minutes. |
| iCal calendars | calendar, briefing | `CALENDAR_ICS_URL` | Free. At most once per 5 minutes per calendar; parsed in a worker thread. |
| Steam Web API and store | friends, wishlists, prices | `STEAM_API_KEY` (friends only) | Free. Local caps: 20,000 Web API calls a day (Steam allows 100,000), 150 store calls per 5 minutes. Any 429 pauses Steam for 60 s. |
| Plex, Sonarr, Radarr | music backup, media questions, heads-up | `PLEX_TOKEN`, `SONARR_API_KEY`, `RADARR_API_KEY` | Self-hosted, free. Default Plex address is the loopback `http://127.0.0.1:32400`. |
| Home Assistant or other MCP servers (`mcp.servers`, up to 5) | home control and other MCP tools | `HOME_ASSISTANT_TOKEN` by default (`tokenSecret` per server) | Home Assistant is self-hosted and free. A third-party MCP server may charge for its own service. Not counted by the caps. |
| Helix | Minecraft server control | `HELIX_TOKEN` | Self-hosted, free. Local ceiling 120 requests a minute. |
| Discord | everything social | `DISCORD_TOKEN` | Free. |
| GitHub releases | `adrian update`, auto-update | none | Free. One unauthenticated API call per check (hourly with auto-update on) and about 41 MB per update download. |

---

## 5. Budgets and limits

### 5.1 Keys

All in `src/config.ts`. Set them in the admin UI's limits form or with `sudo adrian config`, for example `sudo adrian config limits.dailyUsd 2`, then `sudo adrian restart`.

| Key | Default | Effect |
|---|---|---|
| `limits.dailyUsd` | 1 | USD per local day; 0 = no cap. |
| `limits.monthlyUsd` | 10 | USD per local calendar month; 0 = no cap. |
| `limits.perUserPerHour` | 30 | Requests per person per rolling hour, model questions and music plays alike; 0 = unlimited. Owners skip this one only. |
| `limits.maxRequestChars` | 600 (20-4000) | Longest question passed to the model; longer is cut. Also the text chat's limit. |
| `limits.usageFile` | `<state>/usage.json` | Set by the installer; read at process start. |
| `brain.priceInPerM`, `brain.priceCachedInPerM`, `brain.priceOutPerM` | 0, unset, 0 | **Set these.** At 0 the dollar caps count nothing. The wizard presets fill them in. |
| `brain.background.priceInPerM`, `.priceOutPerM` | 0 | Prices for the background (memory) model. |
| `cloudVoice.monthlyChars` | 950,000 (`simba-3.5`) | Speechify cap, separate from the dollars. |
| `textChat.maxReplyChars` | 1800 (200-6000) | Hard cut of typed replies; the prompt asks for about 1,200. |
| `messaging.perUserPerHour`, `messaging.perTargetPerHour`, `messaging.maxChars` | 10, 5, 600 | Limits on passing messages on (spam guard, not money). |

### 5.2 How the caps behave (`src/limits/usage-ledger.ts`)

- `check()` runs before every paid request, in this order: monthly cap, daily cap, then the per-person hourly limit.
- Cost is added after the answer, so the request that crosses a cap still finishes. The caps are soft by one answer.
- Day and month follow `timezone`. Day totals persist in `usage.json` (last 400 days, saved 2 s after a change and on shutdown). Hourly request times are in memory and reset on restart.
- When limited, she says it once per reason per 10 minutes, then stays quiet:
  - per person: "You've asked a lot this hour. I'm pausing your questions for a bit."
  - daily: "I'm paused for the rest of today because the daily spending limit was reached."
  - monthly: "I'm paused for the rest of the month because the monthly spending limit was reached."
- The dollar caps pause only model requests. Music plays and pasted links keep working; only the hourly limit stops them, with "You've asked for a lot in the last hour. Give it a bit."

### 5.3 What the ledger counts and what it doesn't

Counted: every main-model call (all rounds), automatic memory, the quiz judge, estimated stopped streams, and cache warm-ups (a stopped one is estimated as a full write).

From the next release each guest also has a daily share, `limits.guestDailyUsd` ($0.20 by default), checked with the caps. Owners skip the hourly limit and the share; the creator's accounts (`identity.creatorIds`) and priority-role members skip only the share.

Not counted, or counted inexactly:
- Speechify characters (own budget), Groq speech-to-text, Tavily searches.
- Fallback-model calls are priced at the primary's prices.
- Automatic memory and the quiz judge get no cache discount.
- A stopped answer is estimated high.
- The wizard's test call and bench runs.
- Anything at all when the `brain.price*` keys are 0.

### 5.4 Where to see spending

- Admin UI dashboard: today vs the daily cap, this month vs the monthly cap, the last 14 days (questions and cost), and the cost of the last 10 answers. From the next release also cost per answer (day, 7 days), Speechify characters this month, Groq second listens (with an estimate at $0.04 an hour, 10 s minimum per request; every answered request counts, early listens included) and Tavily searches against the free plan's 1,000. These counts start at zero with that version.
- Every answer logs an `answered` line with `tokensIn`, `tokensCached`, `tokensCacheWrite`, `tokensOut`, `toolCalls`, `costUsd` and `spentTodayUsd` (`sudo adrian logs`).
- Speechify: `<state>/voice-usage.json` only.

---

## 6. Running fully local and free

| Piece | Free setting |
|---|---|
| Brain | `brain.provider` `openai`, `brain.baseUrl` your local OpenAI-compatible server (for example Ollama at `http://127.0.0.1:11434/v1`, llama.cpp or LM Studio), `brain.apiKeySecret` `""`, prices 0. The model must handle tool calls well. |
| Memory model | `brain.background` with the same local server, or `autoMemory` `false`. |
| Voice | Leave `cloudVoice` out. Kokoro and Piper speak. |
| Speech recognition | Keep `cloudStt.enabled` `false` (the default). |
| Web search | Leave `TAVILY_API_KEY` unset. You lose `web_search` and exact-page `pc_open search`. |
| The rest | Music, weather, news, calendars, Steam prices, Plex, Home Assistant and Helix need no paid service. |

With prices at 0 the dollar caps count nothing, but `limits.perUserPerHour` still applies. A local model on the same machine competes with speech recognition for CPU and memory (section 7); the service unit's 4-core and 5 GB limits apply to the bot process only.

---

## 7. Machine cost

### 7.1 Server memory

| What | Memory | Source |
|---|---|---|
| Whole bot right after start (English only loaded) | 1.52-1.64 GB RSS | maintainer measurements, releases 0.15.4-0.17.1 (2026-11-08 to 2026-11-19) |
| Whisper small plus the non-English voices | about 1.3 GB more, loaded the first time someone speaks another language | comment in `src/app/stack.ts` |
| Everything loaded at start, before lazy loading (0.14.7, October 2026) | 3.45 GB anonymous plus 0.85 GB page cache | maintainer measurement |
| Milestone 7 (0.2.0), idle | about 1.4 GiB | 2026-10-15 |
| Per component, Windows (`bench/mem-start.mjs`, 2026-11-20) | Parakeet about 690 MB at load plus about 190 MB after its first long decode (its onnxruntime arena, never given back); Kokoro load and calibration about 490 MB; Smart Turn about 74 MB; Node, the app code, VAD and the rest under 100 MB | maintainer measurement |
| Whole bot with the cloud voice primary, next release | about 1.10 GB steady and peak on Windows, against 1.59 GB before (median of 4 and 5 runs): Kokoro loads only when it stands in. Not measured on a server yet | `bench/mem-start.mjs --cloud` |
| Whole bot after another language has loaded, since lazy loading | not measured | — |

- Each Kokoro language engine holds its own copy of the model, so every extra language adds memory.
- The int8 Kokoro model is not used: it ran slower than real time on the test server.
- `languages` `false` keeps Whisper and the other voices from ever loading.
- With the cloud voice primary, Kokoro loads the first time the cloud voice can't speak and then stays loaded, so an outage brings the 0.5 GB back.
- On a first start with too little memory free, the bot waits (up to 15 minutes) instead of loading its models into an out-of-memory kill.
- The installer warns below 4 GB of RAM. Its warning text and [troubleshooting.md](troubleshooting.md) still give the older 3.5 GB "languages on" figure from before lazy loading.
- Caps: systemd `MemoryHigh=4G`, `MemoryMax=5G` (`packaging/adrian-voice.service`); Docker `mem_limit: 4g` (`packaging/docker/compose.yaml`).

### 7.2 Server CPU

| Work | Cost | Source |
|---|---|---|
| Parakeet decode, every segment from everyone | about 0.1-0.3 s per phrase, median 170 ms on 4 threads; one decode at a time across all rooms. CPU per segment on a desktop PC over 890 segments: 703 ms on 4 threads, 360-391 ms on 2 (the default since the next release), about 188 ms on 1; the words were the same in every case. The decode itself took 10-100 ms longer on 2 threads | maintainer measurements, 2026-10-21 and `src/bench/sidetalk-bench.ts` 2026-11-20 |
| Early listen at a PC | a second Silero VAD (about 0.47 s CPU per minute of audio), and one extra decode when someone pauses 0.32-0.8 s and goes on: no extra decoding on PC commands, about 20% more on conversation-like side talk | `src/listen/pipeline.ts`, 2026-11-20 measurement |
| Silero VAD | one thread per speaking user stream | code |
| Smart Turn end-of-turn check (PC rooms) | about 50-250 ms per PC segment on a worker thread | `src/speech/smart-turn-worker.ts` header |
| Whisper second pass (non-English) | about 1 s per clip | `src/speech/whisper.ts` header |
| Kokoro and Piper synthesis | one job at a time; each language engine is created on first use | `src/speech/kokoro.ts` |
| Calendar expansion | about 0.5 s for a busy calendar, in a worker stopped after 5 idle minutes | `src/features/calendar-worker.ts` header |
| ffmpeg, yt-dlp | one ffmpeg process per playing track, clip or sound; one yt-dlp process per lookup | code |

Because every segment is transcribed to hear the wake word, side talk dominates CPU. In a maintainer measurement on 2026-11-08, PC side talk alone was about two thirds of the bot's CPU. For side talk, Parakeet was about 90% of that CPU, Smart Turn 8% and the VAD 2% (2026-11-20). Thread counts: `listen.asrThreads` 2 (Parakeet; 4 before the next release), `listen.whisperThreads` 4, `voice.threads` 4 (Kokoro and Piper). Caps: systemd `CPUQuota=400%`, `CPUWeight=50`, `IOWeight=50`, `Nice=5`, `TasksMax=256`; Docker `cpus: 4`, `cpu_shares: 512`.

### 7.3 Disk

| What | Size |
|---|---|
| Install download (Node.js runtime plus speech models) | about 1.5 GB ([install.md](install.md)) |
| Models unpacked (`silero_vad.onnx`, Parakeet v3 int8, Kokoro multi-lang, Whisper small, Piper vi, Smart Turn v3.2, yt-dlp) | about 2.1 GB (2026-11-19). Leave them out of data backups; `packaging/downloads.sh` fetches them again, pinned by SHA-256. |
| Free space the installer requires | about 1 GB under `/opt` and 2 GB under `/var/lib`, 3 GB together on one disk (`packaging/install.sh`); an update needs about 500 MB under `/opt` |
| Release bundle | about 40-41 MB (grew from 24 MB when onnxruntime-node arrived in 0.14.7). `adrian update` keeps the three newest releases under `/opt/adrian/releases`. |
| State files | small JSON files. Saved alarm sounds are at most 30 s of 24 kHz mono 16-bit, about 1.4 MB each. |
| `pc-recordings/` | only when `satellite.recordDays` > 0 (at most 14 days kept). Real voices: treat as private. |

### 7.4 Network

- PC link: 48 kHz 16-bit mono, 96 KB/s up while the PC's gate is open and the same down while she plays at the PC; nothing while nobody talks; a small ping every 20 s.
- Updates: one GitHub API call per check and about 41 MB per new release (server; the v0.17.1 bundle is 41,481,428 bytes); one call 3 minutes after start and then every 6 hours per PC, plus the PC app download when there is a new version: about 13 MB per update (the v0.17.1 exe is 13,449,216 bytes) and a 4.7 MB zip (4,746,577 bytes) for a first install.

### 7.5 The PC app

Measured with a meter that adds up the app and its child processes, on a desktop PC:

| Measurement | Result | Date |
|---|---|---|
| In the tray, no window (window destroyed, process BelowNormal and EcoQoS, working set trimmed) | 1 process, 5 MB private, 0.01% CPU, 0% GPU, 0.3 KB disk I/O a minute | 2026-10-23 |
| Same, before that change (WebView2 window kept alive while hidden) | 7 processes, 303 MB private (296 MB of it WebView2), 0.04% CPU | 2026-10-23 |
| Orb still drawing while hidden (before the fix) | about 12% CPU, GPU spikes up to 19%; during a full-screen game about 12% GPU, peaks 24% | 2026-10-22 |
| Releases 0.15.3 to 0.17.1 after a restart | 4.7-4.9 MB private | 2026-11-01 to 2026-11-19 |

An open window costs the WebView2 memory again until it is closed. The PC app calls no AI service itself. Its requests cost the same as Discord turns on the server, plus `pc_screen` pictures and clipboard text as model input.

The older Rust household server in the main repository is not what runs in production. Its own usage and budget tracking is documented there.

---

## 8. Levers to make it cheaper

| Lever | How | Saves | Trade-off |
|---|---|---|---|
| Use Claude with caching | `brain.provider` `anthropic` (turns on `stablePrefix` by itself) | About 75% of input cost in the 0.12.x cache bench | Pay as you go only |
| Keep the price keys right | `brain.priceInPerM`, `priceCachedInPerM`, `priceOutPerM` | Makes the caps work at all | — |
| Tighten the caps | `limits.dailyUsd`, `limits.monthlyUsd`, `limits.perUserPerHour` | Hard ceiling (soft by one answer) | She pauses when reached |
| Move memory to a local model | `brain.background` pointed at a local server | One paid call per 4 exchanges per person | Local model RAM and CPU |
| Turn memory off | `autoMemory` `false` | The same calls | No facts saved from conversations |
| Fewer MCP tools | fewer `mcp.servers`, or a short `allow` list per server | Each allowed MCP tool's spec leaves every Claude call (Claude gets every tool; other providers only on home words) | Those tools are gone |
| Switch off features you don't use | `satellite.enabled` `false`, `music.enabled` `false`, `steam.enabled` `false`, `serverInfo.enabled` `false`, no `gameServers`, no search key | Their tool specs and rules leave every call (the 9 PC tool specs and PC rules are in every call while `satellite.enabled` is on) | Those features are gone |
| Keep the cloud voice off or capped | leave out `cloudVoice`, or lower `cloudVoice.monthlyChars` | The Speechify plan | The local voice sounds less natural |
| Get more characters per plan | `cloudVoice.model` `simba-3.2` (1.9M cap instead of 950,000) | Twice the default cap; on Speechify's page as checked 2026-11-20, about 1.5 times the characters on the same plan (2M instead of 1.3M on Starter) | Older, slower voice (sped up 1.2x) |
| Keep the second listen narrow | `cloudStt.enabled` `false`, or `cloudStt.rooms` `pc` (default) | Groq requests | Local words only |
| Skip Tavily | no `TAVILY_API_KEY` | Search credits | No web search, no exact-page `pc_open search` |
| Trim text chat context | `textChat.readChannels` `false`, smaller `textChat.historyMessages`, shorter `textChat.followUpMinutes` | Input tokens and `SILENT` calls in text | Less context in channels |
| Shorter questions and replies | `limits.maxRequestChars`, `textChat.maxReplyChars` | Input and output tokens | Long questions are cut |
| Free fallback | `brain.fallback` on Groq's free tier | Nothing on normal days; keeps answers going during outages | Free-tier rate limits |
| Lower RAM | `languages` `false` | About 1.3 GB that would load on the first non-English question | English only |

---

## 9. For contributors: keeping it cheap

These rules hold the cost down. Break them only on purpose and measure before and after.

- **The stable prefix must stay byte-identical across calls.** With Claude, `stablePrefix` sends every tool, in a fixed order, on every call. Anything that changes per request (names, time, music state, roster) belongs in the per-request context, never in `stableLines` or a tool description. A change there turns every call into a cache write at 1.25x the input price. Covered by `test/orchestrator-tools.test.ts` (stable prefix, usage estimates).
- **Every new tool spec is paid on every Claude call** (cached, but written again at each cold start). Keep descriptions short. The alarm tools added about 1,170 tokens per call in 0.17.0.
- **Give tools a `speak` line** when success can be confirmed without the model. That skips the second call.
- **Add new tools to a router group** in `src/brain/tool-router.ts`, or give them `route`, so non-Claude providers don't get them on every call.
- **Answer clear phrases locally** in `src/conversation/intents.ts` or `local()` in `stack.ts` when the outcome doesn't need the model.
- **Meter every new paid service.** Model calls go through the ledger (`ledger.addCost`); other paid services need their own budget and a local fallback, like `CharBudget` for Speechify.
- Tests that guard cost: `test/stack.test.ts` ("what an answer costs", "phrases answered without the model", "speech not meant for her never reaches the cloud"), `test/ledger.test.ts`, `test/orchestrator-tools.test.ts`, `test/cloud-voice-defaults.test.ts`.
- Benches that measure cost or tokens: `bench/cache-check.mjs` (cache read share), `bench/claude-vs.mjs` (cost and first chunk per model), `bench/llm-check.mjs`, `bench/ttft-survey.mjs`, `bench/cloud-voice.mjs`. They call real APIs with your keys and cost money. See [development.md](development.md).

Cost plans on the [roadmap](roadmap.md): answer more requests without the model, a small model for routine chat with a larger one only when needed, routing per capability (chat, speech-to-text, voice, vision) with a strict-local option for each, and hard caps that fall back to local models instead of pausing.
