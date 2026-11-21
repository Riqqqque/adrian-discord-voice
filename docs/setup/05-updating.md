# 5. Keeping it up to date

New versions fix bugs and keep music working (YouTube changes things every few weeks, and only a newer version catches up). This guide covers the server and the PC app: automatic updates, updating by hand, and going back to the previous version.

[Back to the start](README.md)

---

## The server

### Turn on automatic updates (recommended)

Automatic updates are **off** after installing. To turn them on, run this once on the server:

```bash
sudo adrian auto-update on
```

You should see:

```text
Auto-update is on: every hour she checks GitHub and updates, only while nobody is in her call and nothing is playing.
See what it did: journalctl -u adrian-update
```

From then on, about every hour, the server checks for a new release on GitHub. It installs one only when:

- nobody is in her voice call,
- no music is playing anywhere (Discord or a PC),
- no alarm is ringing, snoozed, or due in the next 5 minutes.

Otherwise it waits and tries again an hour later. So an update never cuts anyone off. The first check runs about 15 minutes after the computer starts.

To see what it did lately:

```bash
sudo adrian auto-update status
```

To turn it off again: `sudo adrian auto-update off`.

Automatic updates install whatever the project publishes as its newest release. [../security.md](../security.md) explains what that means for trust.

### Update by hand

```bash
sudo adrian update --check
```

says whether a newer version exists, without changing anything. To install it:

```bash
sudo adrian update
```

It takes one to four minutes. You should see `Downloading ...`, `Switching ... -> ...`, `Watching ... for a minute or two` and finally `Updated to 0.17.2.` (your version number). If there is nothing new: `Up to date (0.17.1).` If you name a release file that's already installed: `error: version 0.17.2 is already installed`; nothing was changed.

**Fix the bot before you update it.** If the bot isn't working before the update (for example a wrong token: the admin page's Status tab shows `failed`), the update can't prove the new version is healthy, so it always rolls back and says the new version `did worse`. That doesn't mean the new version is bad. Fix the reason shown on the Status tab first ([07](07-troubleshooting.md#the-bot-is-offline-in-discord)), then update.

Newer versions run the update in the background and only show it in your window, so a dropped SSH connection can't stop it halfway. They print `Updating in the background, so a dropped connection can't stop it halfway.` first. Ctrl+C then stops the watching, not the update. The full log is in `/opt/adrian/update.log`.

You can update while people are in the call, but the bot leaves and comes back during the switch, so pick a quiet moment.

To see the installed version: `sudo adrian version`.

### What every update does

1. Downloads the new release and checks it against its published checksum. A mismatch stops it.
2. Asks the new version whether it can run your settings. If not, it changes nothing and tells you why.
3. Downloads any new speech models it needs.
4. Switches over, then watches the new version for a minute or two.
5. If the new version does worse than the old one (doesn't start, falls back to setup mode, doesn't rejoin the voice channel, or crashes in that minute), it **switches back by itself** and tells you `Version ... did worse than ...; rolling back.` If the bot wasn't healthy before the update either, it also ends with `rolled back to ..., but it is not healthy either: adrian logs`; see [Fix the bot before you update it](#update-by-hand).

It keeps the three newest versions on disk. Your settings, keys, memory and paired PCs are not touched. Everyone is logged out of the admin page, so log in again afterwards.

### Go back to the previous version

```bash
sudo adrian rollback
```

You should see `Switching 0.17.2 -> 0.17.1` and `Rolled back to 0.17.1.`

**It prints nothing and you're back at the prompt?** Then there's no older version on the server to go back to, and nothing was changed. That happens after the first install, before any update has worked, because an update that rolled back by itself removes the version that failed. `sudo adrian version` shows what runs.

**If automatic updates are on,** the newer version comes back within about an hour. To stay on the older one until a fix is out, turn them off first:

```bash
sudo adrian auto-update off
sudo adrian rollback
```

and turn them on again later with `sudo adrian auto-update on`.

After a failed update, automatic updates leave that version alone for a day, so a bad release can't restart her every hour. `sudo adrian update` by hand tries it again right away.

After a failed update, `sudo adrian doctor` shows a `warn` line like `update 0.17.2 failed here on ... and was undone; auto-update tries it again a day later`. The retry only happens if automatic updates are on. The line goes away after the next update that works.

### Special cases

- **The server has no internet:** download `adrian-voice-<version>-linux-x64.tar.gz` and its `.sha256` from the [releases page](https://github.com/Riqqqque/adrian-discord-voice/releases) on another computer, copy both to the server (see [06](06-backup-restore-uninstall.md#copy-the-backup-to-your-pc) for how to copy files), and run, in the folder that holds them:

  ```bash
  sudo adrian update adrian-voice-0.17.2-linux-x64.tar.gz
  ```

- **Very old installs (0.14.9 and older)** can't download updates by themselves. Update once with a downloaded file as above; after that `sudo adrian update` works.
- **Not enough free disk:** newer versions need about 500 MB free under `/opt` for an update, and say so if it's missing. See [07-troubleshooting.md](07-troubleshooting.md#the-disk-filled-up-or-a-download-stopped).
- **The power went out during an update:** newer versions notice the next time an update runs (by hand or automatically). They keep the new version if it's healthy and go back to the old one if it isn't. `sudo adrian status` mentions an update that was cut off.
- **The one-step installer on an installed server:** `sudo bash get.sh` on a server that already has A.D.R.I.A.N. updates it instead of installing again.
- **Docker:** build the new image, change `ADRIAN_VERSION` in `packaging/docker/.env`, and run `docker compose up -d`. Details: [../install.md](../install.md).

The update protections above (running in the background, one update at a time, the disk check, recovery after a power cut) are carried out by the `adrian` command that is already installed. So they start working with the update **after** the one that brings them.

## The PC app

### Automatic (on by default)

The PC app updates itself. About 3 minutes after it starts, and then every 6 hours, it checks the releases page. When there's a new version, it downloads it, checks it, and installs it the next time she is idle in the tray: window closed, nothing playing, nobody talking, and no full-screen game in front. Then it starts again in the tray by itself. You don't need to do anything.

Open Settings (the gear) to see the version. Under **Updates** it shows a line such as `Version 0.17.1, up to date.` or `Version 0.17.1. 0.17.2 is downloaded and installs the next time she's idle in the tray.`

To turn automatic updates off, untick **Update automatically** and click **Save**. Then it only tells you when a new version is out.

### Update by hand

1. Download and unpack the newest zip, as in [04-pc-app.md, step 4.3](04-pc-app.md#43-download-the-app).
2. Run the install command from [step 4.4](04-pc-app.md#44-install) again in the new folder.

It closes the running app, replaces it, and starts the new one. Your pairing and settings stay.

### Go back to an older version

1. In Settings, untick **Update automatically** and click **Save**. Otherwise the newest version comes back a few minutes after the app starts.
2. Download the older version's zip from the [releases page](https://github.com/Riqqqque/adrian-discord-voice/releases) (scroll down to older releases) and unpack it.
3. Run the install command from [step 4.4](04-pc-app.md#44-install) in that folder.

### If the app won't start after an update

The copy it replaced stays next to it as `ADRIAN.old.exe` until the new version has connected to the server and run for 3 minutes.

1. Press Windows+R, type `%LOCALAPPDATA%\A.D.R.I.A.N` and press Enter. The app's folder opens.
2. If `ADRIAN.old.exe` is there: delete `ADRIAN.exe`, then rename `ADRIAN.old.exe` to `ADRIAN.exe`, and double-click it.
3. Turn off **Update automatically** in Settings until a fixed version is out.

If there's no `ADRIAN.old.exe`, install the previous version by hand as described above.

## Server and PC app versions

The server and the PC app share version numbers and are released together. They work with each other across versions: an older PC app with a newer server simply lacks the newest PC features (she says the app needs an update when you ask for one of them).

**Next:** [06-backup-restore-uninstall.md](06-backup-restore-uninstall.md).
