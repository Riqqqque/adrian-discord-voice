# 7. Troubleshooting

Find what you see in the list below and follow the steps in that section. Each section goes from the most likely cause to the least likely.

[Back to the start](README.md)

---

## Start here

**Three commands answer most questions.** Run them on the server ([how to connect](03-server-install.md#4-connect-from-your-windows-pc-ssh)):

```bash
sudo adrian doctor
sudo adrian check
sudo adrian status
```

- `doctor` checks the service, its files, the speech models, music tools, free disk and recent errors. Each line starts with `ok`, `warn` or `FAIL`. Fix the `FAIL` lines first. Newer versions also explain in words why the bot failed to start, and what to do.
- `check` lists what's still missing from the setup. `Config is complete.` means nothing is.
- `status` shows whether the service runs, its health, and the admin page address.

**The admin page's Status tab** shows the same in a friendlier way: a badge, whether she's `in voice`, and an error with `What to do:` (newer versions) when something is wrong. The badge is one of:

- `running`: all good.
- `starting`: for a few seconds after a start, restart or update. Wait, then reload the page.
- `setup`: something in the setup is still missing (listed under it).
- `failed`: the bot couldn't start; the reason is shown under it.
- `stopped`: the bot isn't running, usually only for a moment while the service shuts down or restarts. If it stays, click **Restart bot**.

**The log** shows what she hears and does, one line per event. To watch it live while you test, run this and then talk to her:

```bash
sudo adrian logs -f
```

Press Ctrl+C to stop watching. Each line looks like `{"t":"...","level":"info","msg":"wake",...}`. The `"msg"` part says what happened. Keys and tokens are always hidden in the log, so it's safe to share a few lines when asking for help, but check them for names first.

### What do you see?

| Symptom | Go to |
|---|---|
| The bot shows as offline in Discord | [The bot is offline in Discord](#the-bot-is-offline-in-discord) |
| It's online but not in the voice channel | [The bot is online but doesn't join the voice channel](#the-bot-is-online-but-doesnt-join-the-voice-channel) |
| It's in the channel, but nothing happens when you talk | [She doesn't respond at all in the voice channel](#she-doesnt-respond-at-all-in-the-voice-channel) |
| The setup wizard's voice channel list is empty | [The voice channel list in the wizard is empty](#the-voice-channel-list-in-the-wizard-is-empty) |
| The admin page doesn't open | [The admin page won't open](#the-admin-page-wont-open) |
| Lost the setup code, or forgot the admin password | [Lost setup code, or locked out of the admin page](#lost-setup-code-or-locked-out-of-the-admin-page) |
| A key is rejected, "rate limit", "429", or "no credit" | [Keys hit their limits or say 429](#keys-hit-their-limits-or-say-429) |
| She says she's "paused" | [Keys hit their limits or say 429](#keys-hit-their-limits-or-say-429) |
| Answers take a long time | [Answers are slow](#answers-are-slow) |
| The PC app says Offline, Connecting, or "refused" | [The PC app won't connect](#the-pc-app-wont-connect) |
| Everything stopped working after the router or server restarted | [The server's address changed](#the-servers-address-changed) |
| Two PCs keep disconnecting, or orders go to the wrong PC | [Several PCs](#several-pcs) |
| The installer or an update says the disk is full, or a download stopped | [The disk filled up, or a download stopped](#the-disk-filled-up-or-a-download-stopped) |
| The installer says `doesn't match any checksum this version knows`, `doesn't match its checksum` or (0.17.1) `checksum mismatch` | [A download doesn't match its checksum](#a-download-doesnt-match-its-checksum) |
| `sudo adrian start` or `restart` says `not healthy after 60 s` | [The bot is offline in Discord](#the-bot-is-offline-in-discord), step 1 |
| A restore says `restored, but not started: port ...`, `restored, but she can't start` or `restored, but the service is not healthy` | [A port is already in use, or a firewall blocks it](#a-port-is-already-in-use-or-a-firewall-blocks-it) |
| It's slow, restarts by itself, or "out of memory" | [Low memory, or it keeps restarting](#low-memory-or-it-keeps-restarting) |
| "Port already in use", or something can't connect at all | [A port is already in use, or a firewall blocks it](#a-port-is-already-in-use-or-a-firewall-blocks-it) |
| An update failed or rolled back | [An update failed or rolled back](#an-update-failed-or-rolled-back) |
| Music doesn't play, wrong language, other problems | [../troubleshooting.md](../troubleshooting.md) |

---

## The bot is offline in Discord

The bot shows as online in Discord only while A.D.R.I.A.N. is running, set up, and logged in.

1. **Is the service running?** Run `sudo adrian status` and look at the line starting with `Active:`.
   - `Active: inactive (dead)` or `failed`: start it with `sudo adrian start`. If it doesn't stay up, look at `sudo adrian logs` and `sudo adrian doctor`.
   - `Active: active (running)` but `health: not responding` further down: the service runs, but the bot inside it failed to start (a bad token, for example). Starting it again won't help; open the admin page and read the reason on the Status tab (step 3), or run `sudo adrian doctor`.
   - `sudo adrian start` or `sudo adrian restart` waits a minute and then prints `error: not healthy after 60 s: adrian logs`: usually the same thing, the bot inside the service didn't start. Read the reason on the admin page's Status tab and go on with step 3. Newer versions of `sudo adrian doctor` also say it, in a `FAIL  the bot failed to start: ...` line with `what to do:` under it. (Version 0.17.1's doctor only says `admin UI not responding` in this case, although the admin page works.) If the admin page doesn't open either, the service itself keeps failing: see [Low memory, or it keeps restarting](#low-memory-or-it-keeps-restarting).
2. **Is the setup finished?** On the admin page, a `setup` badge means something is still missing (listed under it). The bot doesn't log in to Discord until the setup is complete. Click **Continue setup**.
3. **Did it fail to start?** A `failed` badge comes with the reason:
   - `Discord rejected the token`, `invalid token` or `401`: the token is wrong or was reset. In the Developer Portal, **Bot**, **Reset Token**, then paste the new token on the admin page (Settings tab, **Discord**, or the Keys tab, `DISCORD_TOKEN`). Then **Restart bot** on the Status tab.
   - `disallowed intents` or `4014`: a privileged intent was switched off in the Developer Portal after the bot started. Click **Restart bot**: at each start it checks again which switches are on ([01, step 1.5](01-discord-bot.md#15-privileged-intents-all-optional)) and only uses those.
   - A network error (`ENOTFOUND`, `ETIMEDOUT`, `fetch failed`): the server can't reach Discord. It retries by itself (after 30 seconds, then less often). Check the server's internet: `curl -I https://discord.com` should print `HTTP/2 200` or similar.
4. **Is the server on and awake?** A laptop with its lid closed, or a desktop set to sleep, takes the bot offline. See [03, step 3](03-server-install.md#3-keep-it-awake-and-give-it-a-fixed-address).
5. **Is the same token used somewhere else?** Two programs logged in with one bot token (an old copy on another computer, or a second install) knock each other off. Stop the other one, or reset the token so only this server has it.
6. **Is Discord itself down?** Check <https://discordstatus.com>.

## The bot is online but doesn't join the voice channel

The Status tab says `running` but `not in voice`.

1. **Permissions.** The bot needs **View Channel**, **Connect** and **Speak** in that voice channel. Private channels and channels with their own permission settings often block bots. In Discord, right-click the voice channel, **Edit Channel**, **Permissions**, add the bot (or its role, which has the bot's name), and allow those three. Newer versions say on the Status tab when this is the reason.
2. **The channel is full.** A channel with a user limit that's reached refuses her. Raise the limit, or choose another channel (Settings tab, **Discord**).
3. **The channel was deleted**, or the bot was removed from the server: pick the channel again on the Settings tab, **Discord** step. If the server isn't in the list, open the invite link there again.
4. **Someone disconnected her.** If a person disconnects the bot from the call, she stays out until someone types `/join` (the log says `disconnected from voice by someone; staying out until /join`). Join the channel and type `/join`.
5. **She left by herself.** In any channel other than her home channel, she leaves after 10 minutes with nobody else there. That's normal. Her home channel is the one picked in the wizard; she goes back there after every restart.
6. **Voice traffic is blocked.** Discord voice needs outgoing UDP traffic. The log shows `voice connect failed`. Some school, office or hotel networks, and strict firewalls, block it. Try another network, or allow outgoing UDP on the server's firewall.
7. **You invited the bot a long time ago** (before version 0.13.4): open the invite link again from the Settings tab, **Discord** step, to give it the newer permissions.

## She doesn't respond at all in the voice channel

First find out where it stops. Run `sudo adrian logs -f` on the server, then in the voice channel say clearly: **"Hey Adrian, what time is it?"**

- **No new lines at all, or no line with `"msg":"wake"`:** she doesn't hear you, or doesn't hear her name. Go to [She can't hear me](#she-cant-hear-me).
- **A `wake` line, but no answer:** go to [She hears me but never answers](#she-hears-me-but-never-answers).
- **A line with `"msg":"answered"`, but you hear nothing:** go to [She answers but I hear nothing](#she-answers-but-i-hear-nothing).

If she isn't in the channel at all, see [the section above](#the-bot-is-online-but-doesnt-join-the-voice-channel).

### She can't hear me

1. **Same channel?** She only hears people in the voice channel she's in.
2. **Your microphone in Discord.** Open Discord's **User Settings**, **Voice & Video**, and use **Mic Test**. If you use push-to-talk, hold the key while you speak. Make sure you aren't muted.
3. **Is she deafened?** A deafened bot hears nothing. Right-click the bot in the voice channel. If **Server Deafen** is ticked, untick it.
4. **Say her name first and clearly:** "Hey Adrian, ..." or "Adrian, ...". If that doesn't work, say just "Adrian?", wait for her "Yes?", then ask.
5. **She just started.** After a start or update, give her about 20 seconds to load the speech models.
6. **The server is overloaded.** If the dashboard's Latency table shows speech recognition taking several seconds, see [Answers are slow](#answers-are-slow).

### She hears me but never answers

Look at the lines after `wake` in the log:

1. **`"msg":"limited"`:** a spending limit or the hourly limit per person was reached. She says so once (for example `I'm paused for the rest of today because the daily spending limit was reached.`) and then stays quiet for a while. See [Keys hit their limits or say 429](#keys-hit-their-limits-or-say-429).
2. **`"msg":"answer failed"`, or `"outcome":"timed out"`:** the language model didn't answer: a wrong key, no credit, a rate limit or an outage. Open the admin page, Settings, **Language model**, and click **Test** to see the reason. Adding a fallback model helps with outages.
3. **She says "I'm not fully set up yet. My language model hasn't been configured."**: the language-model key is missing. Run `sudo adrian check` and finish the Language model step.
4. **The time question works, but real questions don't:** the time is answered without the language model, so this also points at the model (see 2).
5. **You didn't say her name.** Follow-up questions shortly after an answer don't need the name, but then the model decides whether you meant her, and it stays quiet for side conversations. Say "Adrian" when in doubt.
6. **She's busy.** She answers one person at a time, with a short queue.

### She answers but I hear nothing

1. **Her volume on your side.** In Discord, right-click the bot in the voice channel: check **User Volume** isn't at 0 and **Mute** isn't ticked. Check your own speakers or headset and that you aren't deafened.
2. **Speak permission or server mute.** If the bot has a crossed-out microphone in the channel, it may lack the **Speak** permission there, or a moderator muted it: right-click it and untick **Server Mute**, or fix the channel's permissions ([above](#the-bot-is-online-but-doesnt-join-the-voice-channel)).
3. **A Stage channel.** In a Stage channel she's in the audience until a moderator makes her a speaker. Use a normal voice channel.
4. **Only other people can't hear her:** each person has their own User Volume and Mute for her in Discord.

At the PC app, see [The PC app won't connect](#the-pc-app-wont-connect) first. If it's connected and the label says **Speaking** but you hear nothing, check Windows' default output device and the volume of **A.D.R.I.A.N.** in the Windows volume mixer.

## The voice channel list in the wizard is empty

**Known problem in version 0.17.1:** on the Discord step, the server is listed, but **Voice channel to join** offers no channels, even though the server has some. Newer versions fix this. Workaround:

1. Copy the server ID and the voice channel ID in Discord ([01, step 1.7](01-discord-bot.md#17-turn-on-developer-mode-and-copy-ids)).
2. On the server, set them, with your own numbers:

   ```bash
   sudo adrian config guildId 123456789012345678
   sudo adrian config channelId 234567890123456789
   ```

   Each prints a line like `guildId = "123456789012345678". Restart to apply: sudo adrian restart`. You don't need to restart now.
3. In your browser, while logged in to the admin page, open `http://localhost:8790/?step=2` (your port if it isn't 8790). This skips to the **Language model** step. Carry on from there as in [03, step 7](03-server-install.md#7-run-the-setup-wizard).

Also check that the bot is really in the server (it shows in the member list) and that it can see the channel: a private channel is hidden from it until you allow it.

## The admin page won't open

1. **Using the SSH tunnel?** The PowerShell window with `ssh -L ...` must stay open and logged in. If it closed, run it again ([03, step 6](03-server-install.md#6-open-the-admin-page)).
2. **The right port?** `sudo adrian url` prints the address. Use that port number in the tunnel and the browser. If you installed with `--lan`, it prints `http://0.0.0.0:8790/` (with your port). `0.0.0.0` isn't an address you can open: it means "every address of this server". From another computer, use the server's own address from `hostname -I` with that port, for example `http://192.0.2.10:8790/`.
3. **`http://`, not `https://`.** Type the address with `http://` in front. Some browsers switch to `https://` by themselves, which fails; turn off "always use secure connections" for this address, or try another browser.
4. **Is the service running?** `sudo adrian status`. If not, `sudo adrian start`.
5. **`Unknown host name. Add it to server.allowedHosts in the config to use it.`**: you opened it with a name instead of the numbers. Use `http://localhost:PORT/` through the tunnel, or the server's address in numbers if you installed with `--lan`.
6. **`Your session ended. Log in again.`**: normal after every restart or update. Log in again.
7. **From another computer without a tunnel:** that only works if you installed with `--lan` ([03, step 6, Option C](03-server-install.md#option-c-open-it-to-your-home-network)).

## Lost setup code, or locked out of the admin page

| Problem | Fix |
|---|---|
| Lost the setup code, or it expired (they last an hour) | `sudo adrian setup-code` shows the current code, or makes a new one if it expired. `sudo adrian setup-code --new` always makes a new one. |
| `setup code is wrong or expired` | Get the current one with `sudo adrian setup-code`. The code looks like `ABCDE-FGHJK`; letters O and I and digits 0 and 1 are never used, so there's nothing to mix up. |
| `too many attempts; try again later, or make a new code ...` | After 10 wrong tries the old code stops working. Run `sudo adrian setup-code --new` and use the new code it prints. |
| `The admin account already exists.` (when asking for a setup code) | Someone already created the account. Log in with it, or reset it (next row). |
| Forgot the admin password or username | `sudo adrian reset-admin` removes the account (and nothing else) and restarts the bot. Its message still says `Restart the service`; you don't need to, it already did. Then `sudo adrian setup-code` and create the account again on the admin page. Your settings and keys stay. |
| `too many failed logins; try again in a minute` | Wait a minute. Login attempts are limited so nobody can guess the password. |
| Forgot the Linux password of the server | That's outside A.D.R.I.A.N.: search for "Ubuntu reset password recovery mode". |

## Keys hit their limits or say 429

"429" is how online services say "too many requests, slow down".

**Messages from the setup wizard's Test button:**

| Message | Meaning | Fix |
|---|---|---|
| `The provider rejected the key (401)` or `(403)` | Wrong, incomplete or deleted key | Copy the key again in full, or make a new one. |
| `The account behind this key has no credit left.` | Paid account with no balance (newer versions say this; older ones may just say they couldn't reach the provider) | Add credit on the provider's billing page (Claude: console.anthropic.com, **Plans & Billing**), or choose Groq. |
| `The provider is rate-limiting this key (429)` | Too many requests for that key right now; free tiers have low limits per minute | Wait a minute and test again. |
| `The provider doesn't offer the model ...` | That account can't use that model | Choose another provider. |
| `That looks like a ... key, but ... is chosen.` | The key is for a different provider | Pick the matching provider, or paste the right key. |
| `Could not reach the provider from this server.` | No internet, or DNS trouble on the server | Check the server's connection: `curl -I https://api.anthropic.com`. |
| `Discord is rate limiting this bot right now (429)` | Too many tries in a short time | Wait a minute. |

**While running:**

- **Groq's free tier** has limits per minute and per day (when last checked, October 2026: 8,000 tokens a minute, 200,000 a day). In a busy call it runs out after a few questions a minute, and a long day can hit the daily cap. With a fallback model set, the fallback answers meanwhile. Otherwise set one up, or use Groq's paid tier.
- **She says `I'm paused for the rest of today because the daily spending limit was reached.`** (or "for the rest of the month"): your own spending cap, not the provider's. Raise it on the admin page: Settings, **Limits**, then **Restart bot**. `0` means no cap. Spending so far is on the Status tab.
- **She says `You've asked a lot this hour. I'm pausing your questions for a bit.`**: the per-person hourly limit (default 30 questions). It frees up as the hour rolls on. Owners aren't held to it ([03, step 9](03-server-install.md#9-recommended-next-steps)). Change it under **Limits**.
- **Tavily says the key `has used up its searches`**: the free plan's monthly searches are gone. Wait for next month, upgrade, or turn search off (Settings, **Search**). Everything else keeps working.
- **The cloud voice turned into the built-in voice:** Speechify's monthly character limit was reached, or Speechify is down. It switches back by itself next month or when Speechify answers again.
- **The Groq second listen at the PC:** when Groq says 429, it pauses for a minute and uses the local transcription. Nothing to do.

## Answers are slow

**What's normal:** about 3.5 seconds from when you stop talking to her first word (the median of a small sample in November 2026), a bit more at the PC app. Music takes longer, often several seconds, because it searches first. The first answer in another language takes longer because that language's models load.

Look at the admin page's Status tab, **Latency (last answers)**. The row with the big number shows where the time goes:

- **Speech recognition** above about 1 second: the server's processor is too slow or busy. Close other heavy programs on it. Fewer than 4 CPU threads is too few.
- **Model first sentence** above 2 to 3 seconds: the language model is slow. Questions that need a web search or a tool take longer (she says "One sec." first). Free tiers are slower and may be falling back to the second model. Claude Haiku or Groq's paid tier are the quick ones. A model on your own computer without a graphics card is slow.
- **Voice first sentence** high: the voice is slow. With the built-in voice it's the processor again; with the cloud voice, Speechify.

## The PC app won't connect

Open the app's Settings (the gear). The top says **Not connected** or **Not set up yet**, and the line under it says why. (Hovering over the tray icon shows the same line.)

| What the app says | Meaning | Go to step |
|---|---|---|
| `Not set up: open settings.` | No server address or token saved | 1 |
| `Can't reach the server: ...` | Nothing answers at that address and port | 2, 3, 4 |
| `The server refused this PC (bad token). Check the token in settings.` | Wrong token, or the pairing was removed | 5 |
| `The server refused this PC (too many failed attempts). ...` | Locked out for 10 minutes after 5 wrong tokens | 5 |
| `Disconnected. Reconnecting…`, over and over | Connected, then dropped | 6 |

1. **Fill in Settings:** **Server address** like `192.0.2.10:8791` (no `http://` needed; don't use `https://`), and the whole token starting with `sat_`. Click **Save**. Save refuses a token that doesn't start with `sat_` and says so.
2. **Is the PC link on?** On the server, `sudo adrian config satellite.enabled` must print `true`. If it prints `null` or `false`, turn it on ([04, step 4.1](04-pc-app.md#41-turn-on-the-pc-link-on-the-server)).
3. **Can the PC reach the server?** On the PC, in PowerShell, with your server's address:

   ```powershell
   Test-NetConnection 192.0.2.10 -Port 8791
   ```

   - `TcpTestSucceeded : True`: the network is fine; go to step 5.
   - `False`: check the address (on the server: `hostname -I`), that the server is on, and the server's firewall ([04, step 4.1](04-pc-app.md#41-turn-on-the-pc-link-on-the-server)). A **VPN app on the PC** often blocks the home network: allow "local network access" in its settings, or turn it off to test. If the address changed, see [The server's address changed](#the-servers-address-changed).
4. **Is the port free on the server?** `sudo adrian logs | grep satellite`. A line with `"msg":"satellite server error"` and `EADDRINUSE` means another program uses port 8791. Move the PC link to another port, then use that port in the app's **Server address** (and in the firewall rule):

   ```bash
   sudo adrian config satellite.port 8792
   sudo adrian restart
   ```

5. **The token.** A line with `"msg":"satellite rejected"` and `"reason":"bad token"` means the token doesn't match a pairing. Make a new pairing ([04, step 4.2](04-pc-app.md#42-pair-the-pc)) and paste the new token. After 5 wrong tokens, the PC's address is locked out for 10 minutes; the right token still gets in, and the app tries again by itself every few minutes.
6. **It keeps dropping.** Two PCs using the same token knock each other off: give each PC its own pairing ([Several PCs](#several-pcs)). Otherwise check the Wi-Fi of the PC and the server.

When it works, the server log shows `"msg":"satellite connected"`.

## The server's address changed

Signs: `ssh` says `Connection timed out`, the tunnel to the admin page doesn't work, and PC apps say `Can't reach the server`, often right after the router restarted.

1. Find the new address: on the server's own screen, log in and run `hostname -I`. Or look in your router's list of connected devices.
2. Use the new address everywhere: in your `ssh` commands, and in each PC app's Settings (**Server address**, then **Save**).
3. So it doesn't happen again, reserve the address in your router ([03, step 3](03-server-install.md#3-keep-it-awake-and-give-it-a-fixed-address)).

On many home networks the server can also be reached by its name with `.local` added (for example `myserver.local`) instead of numbers. That works for `ssh` and the PC app if your network supports it, but not for the admin page in `--lan` mode unless you add the name to `server.allowedHosts`.

## Several PCs

- **Two PCs keep disconnecting each other** (both flip between connected and `Disconnected. Reconnecting…`): they use the same token. Pair each PC on its own with `sudo adrian satellite add "Other PC" ID` and give each its own token.
- **She says `No PC is connected for ...`** when you ask for something on your PC: your PC app isn't running or connected, or the PC is paired to someone else's Discord ID. Check `sudo adrian satellite list`: the owner ID must be yours.
- **An order from Discord went to the wrong PC:** with several PCs paired to you, orders from Discord go to the one you used most recently. Say it at the PC you mean, or use that PC once first.
- **Someone else used your PC's powers:** everyone talking near a PC counts as its owner. Turn off actions you don't want others to have ([04, step 4.8](04-pc-app.md#48-what-she-may-do-on-this-pc)).

## The disk filled up, or a download stopped

Check the free space where A.D.R.I.A.N. keeps its files (the app in `/opt`, the speech models and her memory in `/var/lib`):

```bash
df -h /opt /var/lib
```

It prints one line for each, under **Avail**. Both lines are often the same disk, which is fine. On some servers (rented ones in particular) `/opt` or `/var` has its own, smaller part of the disk, so look at the line the installer's message named (`under /opt` or `under /var/lib`), not only at `/`. The installer needs about 3 GB, an update about 500 MB, and `sudo adrian doctor` warns below 2 GB.

To free space:

```bash
sudo apt-get clean
sudo apt autoremove -y
sudo journalctl --vacuum-size=200M
```

If you installed by hand (03, 5b), the downloaded release and its unpacked folder are still in your home folder and can go: `rm -r ~/adrian-voice-*.tar.gz* ~/adrian-0.*` (check with `ls ~` first).

If PC recordings are turned on (`satellite.recordDays`), they're kept in `/var/lib/adrian/pc-recordings`.

**A download stopped halfway** (a dropped connection, or the disk ran full): fix the cause and run the same command again. Speech models that already finished are kept and not downloaded again.

## A download doesn't match its checksum

The installer checks every file it downloads against a fingerprint (a "checksum") written into that version of A.D.R.I.A.N. If a file doesn't match, it stops:

- version 0.17.1: `error: checksum mismatch for sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` (or another file name);
- newer versions: `error: ... downloaded at full size but doesn't match any checksum this version knows` when the file on the site changed, or `error: ... doesn't match its checksum, and it's smaller than it should be` when the download was cut short.

1. **Run the same command once more.** A download that was cut off or damaged on the way gets fixed by downloading it again. Files that already finished are kept.
2. **The same file fails again?** Then retrying won't help, however often you try. It almost always means the file on the download site was replaced with a newer copy, so it no longer matches the fingerprint this version expects. It's not your internet connection and not your computer, and nothing was installed wrong.

**Known problem in version 0.17.1 and older:** two speech-model files were replaced on their download site in October and November 2026, and these versions still expect the old copies: `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` (speech recognition) and `kokoro-multi-lang-v1_0.tar.bz2` (the built-in voices). A fresh install of these versions stops at one of these two files. **Fresh installs work again from the release after 0.17.1 on:** it knows both the old and the new copies, so a server that already has the old ones keeps them and a new one gets the new ones. The Docker install of 0.17.1 downloads the same files, so it doesn't get around it. What to do:

- Install the newest release, which is newer than 0.17.1 (5a and 5b of [03](03-server-install.md#5-install-adrian) both pick the newest by themselves). Leave a half-finished 0.17.1 install as it is: installing the newer version on top of it keeps the models that already finished, so it doesn't start from zero.
- If a newer version fails the same way with another file, the site replaced that one too: look in the project's issues on GitHub for "checksum", and open one if nobody has, with the file name from the message.
- Newer versions can also try mirrors after the original site: `ADRIAN_DOWNLOAD_MIRRORS="https://..."` in front of the install command, or one https address per line in `/opt/adrian/download-mirrors`. Use only a mirror you trust. Its files must still match a checksum this version knows, so it can't bring in an unknown file.

Don't try to get around the check by putting a file you downloaded yourself in place. It's what keeps a damaged or swapped file off your server.

## Low memory, or it keeps restarting

Signs: the bot goes offline and comes back, the server is very slow, or a message says `out of memory`.

If it restarts over and over without being slow, and `sudo adrian logs` mentions `EADDRINUSE`, it's not memory: see [A port is already in use](#a-port-is-already-in-use-or-a-firewall-blocks-it).

1. **Check:** `free -h` shows the memory (**total**, **available**). `sudo adrian doctor` shows `service memory: ... MiB`. She needs about 1.5 GB after starting, and about 1.3 GB more once someone speaks Spanish, Chinese, Japanese or Vietnamese to her.
2. **If you only speak English to her,** turn the other languages off. That stops those models from ever loading:

   ```bash
   sudo adrian config languages false
   sudo adrian restart
   ```

3. **Close or move other heavy programs** on the server (game servers, media servers, browsers).
4. **Add memory** if you can. 8 GB is comfortable.
5. **As a stopgap, add swap** (disk space used as slow extra memory) if the server has none. `swapon --show` prints nothing when there's none. To add 4 GB:

   ```bash
   sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

The service has two memory limits. Above 4 GB (the `limit 4096` that `sudo adrian doctor` shows, in MiB) Linux makes it give memory back, so it gets slower. At 5 GB it's stopped and starts again by itself after 20 seconds.

## A port is already in use, or a firewall blocks it

A "port" is a numbered door on the server that a program listens on. A.D.R.I.A.N. uses two:

| Port | For | Default |
|---|---|---|
| Admin page | the setup wizard and dashboard | 8790, or the next free one up to 8799 (`sudo adrian url` shows it) |
| PC link | the PC app | 8791 |

- **`ports 8790-8799 are all taken by other programs`** (installer; 0.17.1 says `ports 8790-8799 are all in use`): run the install command again with `--port 8800` (or another free number).
- **`port N is already used by another program`** (newer installers): leave `--port` out, or pick another number.
- **The admin page got port 8791** because 8790 was taken: then the PC link can't use its usual 8791. The installer doesn't warn about this; you see it only in the `Admin UI:` line (`:8791/`). Move the PC link: `sudo adrian config satellite.port 8792`, `sudo adrian restart`, and use `:8792` in the PC app.
- **The admin page's port is taken while it runs** (often right after restoring a backup on another computer, because the backup brings the old port): a restore says `restored, but not started: port ...` or `restored, but she can't start: port ... is taken by another program`, and `sudo adrian doctor` says `admin UI not responding: port ... is taken by another program`. Version 0.17.1 doesn't name it: the service keeps restarting, a restore says `restored, but the service is not healthy`, and doctor only says `service not running` and `admin UI not responding`. To see it in the log:

  ```bash
  sudo adrian logs | grep EADDRINUSE
  ```

  A line with `admin UI failed to start` and `address already in use` names the port. Stop the other program, or move the admin page to a free port by running the install command again with `--port`, for example `--port 8792` (as in [03, step 6, Option C](03-server-install.md#option-c-open-it-to-your-home-network), with `--port 8792` instead of `--port 8790`; keep `--lan` only if you use it), then `sudo adrian restart`. Your settings and keys stay. Details: [06, On a new computer](06-backup-restore-uninstall.md#on-a-new-computer-moving-the-server). (The admin page's port can't be changed with `sudo adrian config`; only the installer sets it.)
- **Which program has a port?** `sudo ss -ltnp | grep 8791` shows it.
- **Outgoing connections the server needs:** HTTPS to discord.com (and outgoing UDP for voice), the language model's site, github.com for updates, and during install also nodejs.org and huggingface.co. Home routers allow all of this. School, office and some hotel networks may not.
- **Incoming:** only the PC link's port needs to be reachable, and only from your home network ([04, step 4.1](04-pc-app.md#41-turn-on-the-pc-link-on-the-server)). The admin page needs nothing incoming when you use the SSH tunnel.

## An update failed or rolled back

| Message | Meaning | Fix |
|---|---|---|
| `Version ... did worse than ...; rolling back.` | The new version didn't come up healthy, so the old one is back and running. | Look at `sudo adrian logs` for the reason. A Discord voice outage at that moment can cause it; try `sudo adrian update` again later. |
| `rolled back to ..., but it is not healthy either: adrian logs`, or (newer versions) `... wasn't healthy before the update either ..., so this doesn't show ... is worse` | The bot wasn't working before the update either (a bad token, for example), so the update couldn't prove the new version works. The new version isn't necessarily bad. | Fix the bot first ([The bot is offline in Discord](#the-bot-is-offline-in-discord)), then `sudo adrian update` again. |
| `version ... is already installed` | That version is the one running now. | Nothing to do. |
| `error: no previous version to roll back to` (0.17.1: `sudo adrian rollback` prints nothing) | There is no older version on the server to go back to; nothing was changed. | Nothing to do: `sudo adrian version` shows what runs. |
| `warn  update ... failed here on ... and was undone` (in `sudo adrian doctor`) | A reminder of the last failed update. | Automatic updates retry it after a day, only if they're on. The line goes away after the next update that works. |
| `update ... was tried here on ... and undone, but it couldn't be judged` (in `sudo adrian doctor`, newer versions) | The bot wasn't healthy before that update either. | Fix what doctor shows above it, then `sudo adrian update` again. |
| `The cut-off update to ... is undone` (after `sudo adrian rollback`, newer versions) | An update was cut off (a power cut); the rollback finished undoing it and switched nothing else. | Nothing to do. Run `sudo adrian rollback` again only to go back one more version. |
| `version ... can't run this config, so nothing was changed:` | A setting isn't accepted by the new version; the lines below name it. | Fix that setting ([../configuration.md](../configuration.md)), then update again. |
| `update ... skipped: it failed here in the last day` (in `sudo adrian auto-update status`) | Automatic updates wait a day after a failure. | `sudo adrian update` tries it now. |
| `couldn't reach GitHub ...` | No internet on the server, or GitHub is down. | Try later. Without internet: [05, special cases](05-updating.md#special-cases). |
| `another update is already running` (newer versions) | The hourly automatic update, or an update from another window, is busy. | Wait a few minutes. `sudo tail -f /opt/adrian/update.log` follows one started by hand; `journalctl -u adrian-update -f` the hourly one. |
| `only ... MB free under /opt` or `not enough disk for ...` (newer versions) | Not enough disk for the update, or for the speech models it still has to download. Nothing was changed. | [Free some space](#the-disk-filled-up-or-a-download-stopped). |

| `warning: NOT CHECKED: ...` (newer versions) | A release file given by hand has no `.sha256` next to it, so it wasn't checked. | Put the `.sha256` from the same releases page next to it. `--require-checksum` refuses such a file. |
| `there's no bundle file ...` (newer versions) | The release file named isn't there (a typo, or another folder). | Run it in the folder that holds the file, or give its full path. |

The log of an update started by hand (newer versions) is `/opt/adrian/update.log`; the hourly one's is `journalctl -u adrian-update`.

More about updates and going back: [05-updating.md](05-updating.md).

---

Still stuck? Run `sudo adrian doctor` and look at the last lines of `sudo adrian logs`, then search or ask in the project's issues on GitHub. Leave out keys, tokens and private names or addresses when you paste anything.
