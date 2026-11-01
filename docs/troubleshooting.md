# Troubleshooting

Start with:

```bash
sudo adrian doctor     # service, permissions, models, ffmpeg, yt-dlp, config
sudo adrian check      # what's missing before the bot can start
sudo adrian logs -f    # live log
```

## The bot doesn't join the voice channel

- **`adrian check` lists something missing.** Usually the Discord token, the server and channel, or the model key. Finish the wizard.
- **Permissions.** The bot's role needs View Channel, Connect and Speak on that channel. Check per-channel permission overrides, which often block bots in private channels.
- **Bad token.** The logs say `logged in` with the bot's name when the token is good. Reset it in the Developer Portal and set it again: `sudo adrian secret set DISCORD_TOKEN`.

## It's in the channel but doesn't answer

- **The wake phrase.** Say "Hey Adrian, …" clearly, at the start. The logs show a `wake` line when it hears it.
- **No `wake` lines at all:** it isn't hearing you.
  - Check your Discord input sensitivity and push-to-talk.
  - The bot must not be server-deafened.
- **`answered` with `outcome: "timed out"` or `answer failed`:** the model is slow, out of credit, or rate-limited. Check the key and provider, and add a fallback model.
- **`limited`:** a spend cap or the hourly limit was hit. See `limits.*`, and the status page shows today's spend.

## It talks over people or stops by itself

- **"Interrupted" a lot:** the person being answered keeps talking (reactions, echo from their speakers). Ask them to use headphones; barge-in needs 2.5 seconds of talking.
- **It answered side conversations:** follow-ups without the name go to the model, which usually stays silent for chatter. Say the name when you mean it.

## Music doesn't play, or plays the wrong thing

- **`adrian doctor` says ffmpeg is missing:** run `sudo apt install ffmpeg` and restart.
- **`music search failed` in the logs for every song:** YouTube changed something and the pinned yt-dlp is out of date. Update to the newest release.
- **"Sign in to confirm you're not a bot":** YouTube is blocking your server's IP address. There's no fix without an account, so use Plex music (`"play X from Plex"`) in the meantime.
- **Wrong song:** the logs show `music search` (what it searched for) and `music playing` (what it picked). If speech recognition misheard the title, say the artist too ("play Humble by Kendrick Lamar").
- **Choppy:** each song logs `music ended` with `musicGaps` and `longestStallMs`. Large stalls mean the CPU is overloaded; lower `listen.asrThreads` and `voice.threads`, or check other load on the machine.

## The admin page won't open

- It's loopback-only by default. Use an SSH tunnel (`ssh -L 8790:127.0.0.1:8790 you@server`), or reinstall with `--lan`.
- **"Unknown host name":** you opened it by a host name. Add the name to `server.allowedHosts` by editing `/etc/adrian/config.json`, then run `sudo adrian restart` (see [install.md](install.md#4-install-native)).
- **Forgot the password:** run `sudo adrian reset-admin`, then `sudo adrian setup-code`.
- **Blank page after building from source:** restart the service after a web rebuild.

## Wrong language, or it answered in Spanish

- It replies in the language it detected. If it keeps getting that wrong, speak a full sentence. For Chinese, Japanese and Vietnamese, say "Hey Adrian", wait for "Yes?", then ask.
- To turn other languages off: `sudo adrian config languages false`.

## High memory use

About 3.5 GB by default, because Whisper and the language voices load at every start. Turning off languages (`languages false`) brings it to about 1.5 GB. The service is capped at 5 GB (4 GB in Docker).

## Updates

- **`adrian update` rolled back:** the new version did worse than the old one: it wasn't up within 2 minutes, it came back in setup mode or out of her voice channel, or it crashed in the minute after. The log shows why: `sudo adrian logs`. The previous version is still running, under its old service file. A Discord voice outage during that minute can do this to a good release, so try `sudo adrian update` again once it's over.
- **`version X can't run this config`:** the new release doesn't accept your `config.json`, and the message lists why. Nothing was changed. Fix those settings (see [configuration.md](configuration.md)), then update again.
- **`update X skipped: it failed here in the last day`** (in `sudo adrian auto-update status`): auto-update leaves a version that failed alone for a day, so a bad release can't restart her every hour. `sudo adrian doctor` shows when it failed. `sudo adrian update` tries it right away, and a success clears it.
- **After any update or restart,** the bot is back in its home channel. Use `/join` to bring it to another one.
