# 2. Get your keys

An **API key** is a long secret that lets A.D.R.I.A.N. use an online service. You need one key for a language model (the AI that writes the answers). Everything else on this page is optional.

Time: 5 to 15 minutes for the required key.

Prices and free plans change often. Everything below was checked in October and November 2026. Look at the provider's own pricing page before you pay for anything.

[Back to the start](README.md)

---

## At a glance

| Key | Needed? | What it does | Free option? |
|---|---|---|---|
| Discord bot token | **Required** | Logs the bot in. You got it in [01-discord-bot.md](01-discord-bot.md). | Free |
| One language-model key | **Required** (or run your own model) | Writes the answers. | Groq and Gemini have free tiers; a model on your own computer needs no key |
| A second language-model key, as a fallback | Recommended | Used when the main one is down or busy. | Groq's free tier is a good fallback |
| Tavily (web search) | Optional | News, scores, prices, anything recent. Also helps find songs it misheard, and lets the PC app open "the page for X". | 1,000 searches a month free |
| Speechify (cloud voice) | Optional | A more natural English voice. | No; paid plan. The built-in voices are free. |
| Groq for a second listen at the PC | Optional | More accurate speech recognition for the PC app. | Free tier |
| Plex, Sonarr, Radarr, Steam, Home Assistant and others | Optional | Answers about those services. | Free with those services |

**Where you paste keys:** the setup wizard asks for the language-model key and the search key, tests each one, and saves it only if it works. Every other key goes into the admin page's **Keys** tab (or the command `sudo adrian secret set NAME`, shown at the end of this page). Keys are stored only on your server, in a file only A.D.R.I.A.N. can read, and are never shown again.

## Pick a language model

Pick one main model. The setup wizard lists these three, with the right settings already filled in.

**About "tokens" in prices and limits.** Language models count text in small pieces called tokens, and they charge and limit by them. A token is roughly three quarters of an English word, so a million tokens is about 750,000 words. "Input" is what A.D.R.I.A.N. sends (your question plus her instructions), "output" is the answer she gets back. These tokens have nothing to do with the Discord **bot token** or the PC app's **pairing token**, which are passwords.

| Choice in the wizard | Good for | Cost | Key starts with |
|---|---|---|---|
| **Claude Haiku 5.5 (Recommended)** | The best answers for the price. Uses its tools (music, timers, search) reliably. First words in about a second. | Pay as you go: $0.10 per million input tokens, $0.50 per million output. In practice about $0.0011 per answer (November 2026 sample). | `sk-ant-` |
| **Groq gpt-oss-120b (free tier)** | Starting for $0, and as the fallback. Very fast. | Free tier with limits (below). Paid beyond that. | `gsk_` |
| **Google Gemini 3.1 Flash-Lite** | A second fallback. | Free tier, but slow and rate-limited; on the free tier Google may use your prompts to improve its products. | `AIza` |

A good setup is **Claude as the main model and Groq as the fallback**. If you want to spend nothing at all, use **Groq as the main model** and Gemini (or no fallback).

Newer versions of the wizard refuse a key that plainly belongs to another provider (for example a `gsk_` key with Claude chosen) before sending it anywhere. Older ones send it and report that the provider rejected it.

### Anthropic (Claude)

1. Go to <https://console.anthropic.com> and create an account.
2. Add credit under **Plans & Billing**. API use is paid in advance from that balance.
3. Open **API Keys** and click **Create Key**. Give it a name like `adrian`.
4. Copy the key (it starts with `sk-ant-`). It is shown only once.

**A claude.ai chat subscription (Pro or Max) does not include API use.** You need credit on the API console, even if you already pay for claude.ai.

If the wizard later says the account "has no credit left", add credit on the same billing page, or pick Groq instead.

### Groq (free tier)

1. Go to <https://console.groq.com> and create an account.
2. Open **API Keys** and click **Create API Key**.
3. Copy the key (it starts with `gsk_`).

The free tier had these limits when the project last checked (October 2026): 8,000 tokens a minute and 200,000 tokens a day. One spoken answer with a tool can use a few thousand tokens, so in a busy call the free tier runs out after two or three questions a minute, and a heavy day can hit the daily cap. When that happens the fallback model takes over if you set one, otherwise she says she couldn't get an answer. Groq's paid tier removes those limits.

### Google Gemini

1. Go to <https://aistudio.google.com> and sign in with a Google account.
2. Click **Get API key**, then **Create API key**.
3. Copy the key (it starts with `AIza`).

### Fully local: a model on your own computer (advanced, optional)

Speech recognition and the built-in voices already run on your server. If you also want the answers written without any online service, you can run your own language model with a program like [Ollama](https://ollama.com), llama.cpp or vLLM. A.D.R.I.A.N. talks to any server that offers an "OpenAI-compatible" chat API.

Be realistic about this choice:

- A useful model needs a lot of memory on top of A.D.R.I.A.N.'s own 1.5 to 3 GB. Plan on 16 GB of memory or more, or a separate computer with a graphics card.
- Small models are slower on an ordinary CPU and use the tools (music, timers, search) less reliably. The project's tests and recommendations are for the cloud models above.
- The setup wizard has no button for this. You set it with one command, then the wizard shows it as "Keep ..." and leaves it alone.

To try it, once A.D.R.I.A.N. is installed ([03-server-install.md](03-server-install.md)) and the model server runs on the same computer at its default address:

```bash
sudo adrian config brain '{"provider":"openai","baseUrl":"http://127.0.0.1:11434/v1","model":"qwen3:8b","apiKeySecret":""}'
sudo adrian restart
```

Change `qwen3:8b` to the model you downloaded in Ollama. `"apiKeySecret":""` means "no key needed"; leave it exactly like that, or the setup counts as unfinished. The address `127.0.0.1:11434` is Ollama's default on the same computer. (With the Docker install, `127.0.0.1` means the container itself, so use the host's network address instead.) More options: [../configuration.md](../configuration.md).

This command replaces all language-model settings at once, including a fallback model and web search that you may have saved in the wizard. If you had search on, open the admin page afterwards, go to Settings, **Search**, and save it again.

Local models cost nothing, so the dollar limits have nothing to count. The per-person hourly limit still applies.

## Optional keys

### Tavily: web search

Without it, she answers from what the model already knows, which may be out of date. With it, she can look things up.

1. Go to <https://tavily.com> and sign up.
2. Copy the API key from your dashboard (it starts with `tvly-`).
3. On the **Search** step of the setup wizard, tick **Use web search**, paste the key, and click **Test**. You should see `Works (... ms).`

The free plan includes 1,000 searches a month.

No Tavily key? Leave **Use web search** unticked and click **Save and continue**. If the box is already ticked and Save says `Paste and test a Tavily key, or turn search off.`, untick it and save again.

### Speechify: a more natural English voice

A.D.R.I.A.N. comes with more than 50 free voices in several languages that run on your server (the setup wizard lists the 28 English ones). Speechify is an optional online voice for English answers that sounds more natural. Other languages keep the built-in voices.

1. Get a key at <https://platform.speechify.ai> (a paid plan; check their current prices).
2. Save it on the server:

   ```bash
   sudo adrian secret set SPEECHIFY_API_KEY
   ```

   Paste the key when asked and press Enter. Nothing appears while you paste; that's normal.
3. Turn the cloud voice on and restart:

   ```bash
   sudo adrian config cloudVoice.enabled true
   sudo adrian restart
   ```

It stops itself at a monthly character limit (by default 950,000 characters for the default `simba-3.5` model, sized for Speechify's Starter plan) and then switches to the free voice until the next month. If Speechify is down or the key stops working, the free voice takes over automatically. Speechify's costs are not counted by A.D.R.I.A.N.'s dollar limits; your Speechify plan is the limit.

### Groq: a second listen at the PC

Only useful with the PC app ([04-pc-app.md](04-pc-app.md)). Speech that the local recognizer already judged to be meant for her is sent to Groq's Whisper for a more accurate transcription. This sends that audio to Groq. If you use Groq as your language model, the same key works.

```bash
sudo adrian secret set GROQ_API_KEY
sudo adrian config cloudStt.enabled true
sudo adrian restart
```

On the free tier this allowed about 20 requests a minute (October 2026). When Groq is busy, she uses the local transcription instead.

### Everything else

Plex, Sonarr, Radarr, Steam, Helix (Minecraft servers), Home Assistant and calendars each need their own key and a setting. They are listed in [../configuration.md](../configuration.md).

## Adding or changing a key later

Two ways. Both need a restart afterwards.

**On the admin page:** open the **Keys** tab, paste the value next to its name, click **Save** (or **Replace**). Then open the **Status** tab and click **Restart bot**.

**On the server:**

```bash
sudo adrian secret set NAME
sudo adrian restart
```

Replace `NAME` with the key's name from this table. When asked, paste the value and press Enter.

| Name | Service |
|---|---|
| `DISCORD_TOKEN` | Discord bot |
| `ANTHROPIC_API_KEY` | Claude |
| `GROQ_API_KEY` | Groq |
| `GEMINI_API_KEY` | Google Gemini |
| `TAVILY_API_KEY` | Tavily search |
| `SPEECHIFY_API_KEY` | Speechify voice |

To see which keys are saved (names only, never the values):

```bash
sudo adrian secret list
```

It prints one name per line. If no keys are saved yet, it prints nothing at all; that's normal.

## How to check a key works

- In the setup wizard, the **Test** button asks the model a real question. You should see something like `Works: "Two plus two is four." in 900 ms.` If you see a message in red instead, it says what's wrong: a rejected key, no credit, or a rate limit. See [07-troubleshooting.md](07-troubleshooting.md#keys-hit-their-limits-or-say-429).
- After the bot starts, the admin page's **Status** tab shows `running`. If a key is missing, it lists what's still needed.
- On the server, `sudo adrian check` lists anything missing. When all is well it prints `Config is complete.`

**Next:** [03-server-install.md](03-server-install.md), to install A.D.R.I.A.N. on the server.
