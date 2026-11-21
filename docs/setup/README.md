# Setting up A.D.R.I.A.N.: start here

These guides take you from nothing to a voice assistant that sits in your Discord voice channel and answers when someone says "Hey Adrian". If you want, it can also listen and answer on your Windows PC. You don't need to know Linux or programming. Every command you need is written out, and each step says what you should see.

If you already run servers and want the short version, read [../install.md](../install.md) instead.

## What you are building

A.D.R.I.A.N. has two parts:

1. **The server (required).** A small program that runs all the time on a Linux computer in your home. It joins your Discord voice channel, listens, works out what was said, writes an answer and speaks it. Speech recognition and the built-in voices run on that computer. Only the written-out question goes to an online "language model" (the AI service that writes the answers).
2. **The PC app (optional).** A Windows app that lets you talk to the same assistant through your PC's microphone and speakers. It can also control your PC: open apps, pause music, change the volume. It connects to the server over your home network.

A few words you will see a lot:

| Word | What it means |
|---|---|
| Server | The always-on Linux computer that runs A.D.R.I.A.N. It can be an old laptop or a small "mini PC". It doesn't have to be a big machine. |
| Terminal | A window where you type commands instead of clicking. On Windows it's called PowerShell or Terminal. |
| Command | One line of text you type (or paste) into a terminal, then press Enter. |
| `sudo` | Put in front of a Linux command to run it as the administrator. Linux asks for your password the first time. Nothing appears on screen while you type the password. That's normal. |
| SSH | A way to type commands on the server from your Windows PC, so the server doesn't need its own screen and keyboard. |
| API key | A long secret password that lets A.D.R.I.A.N. use an online service (for example the language model). Treat it like a password. |
| Admin page | A web page served by A.D.R.I.A.N. where you finish the setup and later check on it. |
| Port | A number that says which program on a computer you want to reach. It goes after the address with a colon: `192.0.2.10:8790` means "the program on port 8790 of that computer". A.D.R.I.A.N. uses 8790 for the admin page and 8791 for the PC app. |
| systemd | The part of Linux that starts programs when the computer boots and restarts them if they stop. Ubuntu and Debian have it built in. |
| Tokens (in prices) | How language models measure text: a token is about three quarters of a word. Prices and free-tier limits are counted in them. Not the same as the bot token, which is a password. |
| "Version 0.17.1" and "newer versions" | Where a message differs between versions, the guides quote both. "Newer versions" means every release after 0.17.1. `sudo adrian version` shows yours. An update's messages come from the version you update *from*, so your first update away from 0.17.1 still prints 0.17.1's wording. |

## What you need

| Thing | Required? | Notes |
|---|---|---|
| A Discord account, and a Discord server where you can add bots | Yes | You need the "Manage Server" permission on that server. Your own server is easiest. |
| A computer to be the server | Yes | 64-bit Intel or AMD processor (not a Raspberry Pi or other ARM board). At least 4 CPU threads, at least 4 GB of memory (8 GB recommended), at least 3 GB of free disk, a wired or reliable Wi-Fi connection. It should stay switched on. Details in [03-server-install.md](03-server-install.md#1-check-the-computer). |
| Linux on that computer | Yes | Ubuntu Server 24.04 is the recommended choice. Debian 12 also works. [03-server-install.md](03-server-install.md#2-install-linux-if-the-computer-doesnt-have-it) explains how to install it. |
| A key for a language model | Yes | One of: Anthropic (Claude, pay as you go, recommended), Groq (has a free tier), Google Gemini (has a free tier), or a model you run yourself. See [02-keys.md](02-keys.md). |
| A Windows 10 or 11 PC with a microphone | Only for the PC app | It must be on the same home network as the server (or connected to it through a VPN). |
| Other keys (web search, a nicer cloud voice) | No | All optional. Everything works without them. |

## How long it takes

These are honest estimates for someone doing this for the first time. Downloads depend on your internet speed.

| Part | Time |
|---|---|
| Create the Discord bot ([01](01-discord-bot.md)) | 10 to 15 minutes |
| Get a language-model key ([02](02-keys.md)) | 5 to 15 minutes |
| Install Linux on a spare computer, if it doesn't have it yet | 30 to 60 minutes |
| Install A.D.R.I.A.N. ([03](03-server-install.md)) | 15 to 40 minutes, mostly waiting for about 2 GB of downloads |
| The setup wizard and the first test | 10 to 15 minutes |
| The PC app ([04](04-pc-app.md)) | 10 to 15 minutes |

All together: about one to two hours the first time. Most of it is waiting.

## What it costs

Prices change. The numbers below are from November 2026. Check the provider's own page before you rely on them.

| Item | Cost |
|---|---|
| A.D.R.I.A.N. itself | Free and open source. |
| Discord | Free. |
| The server computer | Whatever you already have. It runs all the time, so it uses a little electricity. |
| Language model, recommended (Claude Haiku 5.5) | Pay as you go. The setup uses $0.10 per million input tokens and $0.50 per million output tokens (checked by the project in October 2026). Real use came to about $0.0011 per spoken answer (a small sample, November 2026). At that rate, 50 questions a day is roughly $1.65 a month. You buy credit from Anthropic in advance. |
| Language model, free option (Groq) | $0 on Groq's free tier, which has limits per minute and per day. See [02-keys.md](02-keys.md#groq-free-tier). |
| Web search (Tavily), optional | Free plan with 1,000 searches a month. |
| Nicer cloud voice (Speechify), optional | A paid Speechify plan. Without it, the free built-in voices are used. |
| Updates | Free. |

**Spending limits are on from the start.** By default A.D.R.I.A.N. stops using the paid language model after $1 in a day or $10 in a month, and each person can ask at most 30 questions an hour. You can change these in the setup wizard. These limits count the language model only, not the optional voice or search services, which have their own plans.

## The path through the guides

Do them in this order. Each guide ends by telling you where to go next.

1. [01-discord-bot.md](01-discord-bot.md): create the bot account in Discord and copy its token.
2. [02-keys.md](02-keys.md): get a language-model key, and decide on the optional ones.
3. [03-server-install.md](03-server-install.md): get the server computer ready, install A.D.R.I.A.N., run the setup wizard, and test it in a voice channel.
4. [04-pc-app.md](04-pc-app.md) (optional): install the Windows app and connect it.
5. [05-updating.md](05-updating.md): keep everything up to date, automatically or by hand, and go back if an update goes wrong.
6. [06-backup-restore-uninstall.md](06-backup-restore-uninstall.md): make a backup, move to a new computer, or remove everything.
7. [07-troubleshooting.md](07-troubleshooting.md): when something doesn't work. Start from what you see and follow the steps.

Keep a text file open while you work (Notepad is fine) and paste things into it as you go: the bot token, your keys, the server's address, the setup code. Delete it when you're done, because it will hold secrets.

## Where to go after setup

- What you can say to it: [../usage.md](../usage.md)
- Every setting: [../configuration.md](../configuration.md)
- What it costs in detail: [../costs.md](../costs.md)
- Privacy and security: [../security.md](../security.md)
- More fixes, especially for music: [../troubleshooting.md](../troubleshooting.md)
