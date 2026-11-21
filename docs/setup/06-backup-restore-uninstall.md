# 6. Backup, restore and uninstall

[Back to the start](README.md)

---

## What a backup holds

One file with everything A.D.R.I.A.N. needs to come back as it was:

- your settings (`config.json`);
- **all your keys** (`secrets.env`), so treat the backup like a password;
- the admin account;
- what she remembers about people, reminders, alarms, saved alarm sounds and music taste;
- the spending history;
- the paired PCs.

Not in it: the speech models (the installer downloads them again) and anything that only lives in memory, such as the current conversation and the music queue.

## Make a backup

On the server:

```bash
sudo adrian backup ~/adrian-backup.tar.gz
```

You should see `Backup written to /home/you/adrian-backup.tar.gz (contains your keys: keep it private)`. It's usually small, because the speech models are left out.

Without a file name, it picks one with today's date and time, in the current folder.

Make one after setup works, and again after big changes. Before an uninstall, always.

### Copy the backup to your PC

A backup that only lives on the server is lost with the server's disk. Copy it to your PC:

1. On the server, make the file yours, so you're allowed to copy it (backups are created readable only by the administrator):

   ```bash
   sudo chown $USER ~/adrian-backup.tar.gz
   ```

2. On the Windows PC, in PowerShell, with your username and server address:

   ```powershell
   scp you@192.0.2.10:adrian-backup.tar.gz "$HOME\Downloads"
   ```

3. Type the server password. The file is now in your Downloads folder. Move it somewhere safe from there.

The same `scp` command works the other way round to copy a file to the server: `scp "$HOME\Downloads\FILE" you@192.0.2.10:`.

Keep the backup somewhere private. Anyone who has it has your Discord bot token and your API keys.

### Optional: a backup every week

To have the server make a fresh backup every Sunday at 4 in the morning:

```bash
echo '0 4 * * 0 root /usr/local/bin/adrian backup /root/adrian-backup.tar.gz' | sudo tee /etc/cron.d/adrian-backup
```

It overwrites the same file each week, in the administrator's folder. Copy it off the server now and then as above (use `sudo cp /root/adrian-backup.tar.gz ~/` first, then the `chown` step). To stop it: `sudo rm /etc/cron.d/adrian-backup`.

## Restore a backup

### On the same server

1. Copy the backup file to the server, if it isn't there.
2. Run:

   ```bash
   sudo adrian restore ~/adrian-backup.tar.gz
   ```

It stops the bot, puts everything back, fixes the file permissions, and starts it again. You should see `Restored and running.`

It refuses a file that isn't an A.D.R.I.A.N. backup, or a damaged one (`can't read ...; is it a complete backup?`), before stopping anything. A damaged file may first print a line or two starting with `gzip:` or `tar:`; they mean the same thing. Copy the backup again (the copy was probably cut off) and try once more.

If it says `restored, but the service is not healthy: adrian logs`, everything was put back but the bot didn't come up. Run `sudo adrian doctor`. If it only says `service not running` and `admin UI not responding`, look for `EADDRINUSE` in `sudo adrian logs`: see [the port note below](#on-a-new-computer-moving-the-server).

### On a new computer (moving the server)

1. Get the new computer ready and install A.D.R.I.A.N. on it, as in [03-server-install.md](03-server-install.md), steps 1 to 5. **Stop when the installer prints the setup code.** Don't run the setup wizard: the backup brings your admin account and settings.
2. Copy the backup to the new server, as above.
3. Restore it:

   ```bash
   sudo adrian restore ~/adrian-backup.tar.gz
   ```

   **The backup brings the old server's admin-page port and `--lan` choice with it.** If another program on the new computer already uses that port, the restore ends with `restored, but the service is not healthy: adrian logs`, the service keeps restarting, and `sudo adrian logs` shows `EADDRINUSE` and `address already in use` with the port number (`sudo adrian doctor` doesn't name the reason). Move the admin page to a free port by running the install command again with `--port`, for example 8792:

   ```bash
   sudo adrian-$VER/packaging/install.sh --bundle adrian-voice-$VER-linux-x64.tar.gz --port 8792
   sudo adrian restart
   ```

   If the old server was opened to the home network, add `--lan` to the first line as well (version 0.17.1 forgets it otherwise). With the one-step installer, the first line is `sudo bash get.sh --reinstall --port 8792`. In a new SSH window, [set `VER` again](03-server-install.md#5b-install-by-hand-works-with-every-version) first. Your settings, keys and admin account from the backup stay. Use the new port for the admin page from then on.
4. **Switch the old server off** (or run `sudo adrian stop` on it) before or right after. Two servers with the same bot token fight over the bot.
5. Check: `sudo adrian status`, and the bot shows up in Discord.
6. Open the admin page as in [03-server-install.md, step 6](03-server-install.md#6-open-the-admin-page), and log in with your old username and password.
7. **PC apps:** they're still paired. If the new server has a different address, open Settings in each PC app and change **Server address**, then **Save**. Turn on the PC link's firewall rule on the new server too if it uses one ([04-pc-app.md, step 4.1](04-pc-app.md#41-turn-on-the-pc-link-on-the-server)).
8. Turn automatic updates on again on the new server: `sudo adrian auto-update on`. That choice isn't part of the backup.

## Uninstall

### Remove A.D.R.I.A.N. from the server

Make a backup first if there's any chance you'll want it back.

To remove everything (the app, settings, keys, memory, models and, usually, the `adrian` user):

```bash
sudo adrian uninstall
```

It asks `Remove A.D.R.I.A.N., its config, keys and data? [y/N]`. Type `y` and press Enter. **This can't be undone** without a backup. It ends with `A.D.R.I.A.N. removed.`

The `adrian` system user is only removed when the uninstall can tell that the installer created it (the line `Removing user adrian` shows that). After a first install that stopped halfway, a restore from a backup, or `--keep-data` and a reinstall, it can be left behind. It's harmless: it can't log in and owns no files any more. To remove it anyway:

```bash
id adrian
sudo userdel adrian
```

If `id adrian` says `no such user`, it's already gone and you can skip the second line.

To remove the program but keep settings, keys and memory (for reinstalling later):

```bash
sudo adrian uninstall --keep-data
```

It keeps `/etc/adrian` and `/var/lib/adrian`. Installing again later picks them up.

If you set up the weekly backup above, remove it too: `sudo rm /etc/cron.d/adrian-backup` (and `sudo rm /root/adrian-backup.tar.gz` for its file, unless you still want it).

Packages the installer added (like `ffmpeg`) stay installed. They're ordinary system packages and harmless.

### Remove the bot from Discord

1. In your Discord server: **Server Settings**, then **Integrations**. Find the bot under **Bots and Apps**, open it, and choose **Remove** (or right-click the bot in the member list and **Kick**).
2. To delete the bot completely: in the [Developer Portal](https://discord.com/developers/applications), open the application, go to **General Information**, and click **Delete App** at the bottom. This can't be undone.

### Cancel the keys

On each provider's website (Anthropic, Groq, Google, Tavily, Speechify), open the API keys page and delete the key you made for A.D.R.I.A.N. A key you've deleted can never be used again, even from an old backup.

### Remove the PC app

1. Open the folder you unpacked the app into (or unpack the zip again).
2. Click the address bar, type this and press Enter:

   ```text
   powershell -NoExit -ExecutionPolicy Bypass -File .\Install.ps1 -Uninstall
   ```

   A PowerShell window opens and stays open (that's what `-NoExit` is for). You should see `A.D.R.I.A.N. is removed. Its settings stay in %APPDATA%\adrian.` Close the window. The **A.D.R.I.A.N.** shortcuts are gone from the desktop and the Start menu.
3. Optional, to remove its settings too (the server address and the encrypted token): press Windows+R, type `%APPDATA%\adrian` and press Enter, then delete the `desktop` folder inside.
4. On the server, remove its pairing so its token stops working:

   ```bash
   sudo adrian satellite list
   sudo adrian satellite remove ID
   sudo adrian restart
   ```

   Use the id from the list in place of `ID`.

No zip at hand? Remove it by hand instead of steps 1 and 2: right-click the tray icon and choose **Quit**, then delete the folder `%LOCALAPPDATA%\A.D.R.I.A.N`, the **A.D.R.I.A.N.** shortcuts on the desktop and in the Start menu, and the one in the Startup folder (Windows+R, type `shell:startup`, Enter).

**Next:** [07-troubleshooting.md](07-troubleshooting.md), if anything isn't working.
