# 3. Install the server

This guide gets a Linux computer ready, installs A.D.R.I.A.N. on it, walks through the setup wizard, and ends with the bot answering you in a Discord voice channel.

Time: 30 minutes to 2 hours, depending on whether Linux is already installed and how fast your internet is.

Before you start, have these from the earlier guides: the bot token ([01](01-discord-bot.md)) and a language-model key ([02](02-keys.md)).

[Back to the start](README.md)

---

## 1. Check the computer

A.D.R.I.A.N. runs on one always-on computer in your home. An old laptop or a small "mini PC" is fine, as long as it has:

| | Minimum | Recommended |
|---|---|---|
| Processor | 64-bit Intel or AMD ("x86_64"), 4 CPU threads | 8 threads |
| Memory | 4 GB | 8 GB or more |
| Free disk | 3 GB | 10 GB or more, so updates and logs have room |
| Network | Reliable home internet | A network cable instead of Wi-Fi |
| Operating system | Linux with systemd: Ubuntu 24.04 or Debian 12 are tested | Ubuntu Server 24.04 LTS |

**systemd** is the part of Linux that starts programs when the computer boots and starts them again if they stop. A.D.R.I.A.N. runs as one of those programs (a "service"). Ubuntu and Debian have systemd built in, so there's nothing to install.

How much it really uses: about 1.5 to 1.6 GB of memory after it starts, and about 1.3 GB more the first time someone speaks Spanish, Chinese, Japanese or Vietnamese to it. The speech models take about 2.1 GB of disk.

**These don't work:**

- **Raspberry Pi and other ARM boards.** Only 64-bit Intel or AMD processors are supported for now. The installer says so and changes nothing.
- **Windows or macOS as the server.** The server part needs Linux. (The PC app in [04-pc-app.md](04-pc-app.md) is the Windows part.)
- **Windows Subsystem for Linux (WSL), Alpine Linux, and Linux containers without systemd** are not supported or not tested. For containers, see [Docker instead](#docker-instead) at the end.

A rented Linux server ("VPS") with these specs also works, with one warning: don't open the PC app's port to the internet (see [04-pc-app.md](04-pc-app.md)).

**Already running Linux?** On the server, run these to check. Each one prints one answer:

```bash
uname -m
nproc
free -h
df -h /
```

You want `x86_64` from the first, `4` or more from the second, at least `4.0Gi` under "total" from the third, and at least `3.0G` under "Avail" from the last. Then skip to [step 3](#3-keep-it-awake-and-give-it-a-fixed-address).

## 2. Install Linux (if the computer doesn't have it)

**This erases the computer's disk.** Copy off anything you want to keep first.

Use **Ubuntu Server 24.04 LTS**. Ubuntu's own step-by-step guide, with pictures, is here: <https://ubuntu.com/tutorials/install-ubuntu-server>. You need a USB stick of 8 GB or more and about 30 to 60 minutes.

While following it, only these choices matter for A.D.R.I.A.N.:

1. **Network:** if a network cable is plugged in, it's found by itself. Write down the address it shows (four numbers with dots, for example `192.0.2.10`).
2. **Storage:** "Use an entire disk" is fine.
3. **Your name, server name, username and password:** pick a username and a password you'll remember. You'll type them often.
4. **SSH:** tick **Install OpenSSH server**. This lets you control the server from your Windows PC.
5. **Featured server snaps:** don't pick any.

When it's done, remove the USB stick and let it restart. Log in with your username and password. Then bring it up to date (this can take a few minutes):

```bash
sudo apt update && sudo apt upgrade -y
```

`sudo` asks for your password. Nothing appears while you type it. Type it anyway and press Enter.

**Find the server's address** at any time with:

```bash
hostname -I
```

It prints the address, for example `192.0.2.10` (yours will be different). Write it down. In these guides, `192.0.2.10` always means "your server's address".

## 3. Keep it awake and give it a fixed address

**A fixed address.** Your router hands out addresses and may give the server a different one next week. Then the PC app and your SSH connection can't find it. In your router's settings, look for "DHCP reservation", "static lease" or "address reservation", and reserve the server's current address for it. Every router does this differently; search the web for your router's model and "DHCP reservation". Optional, but it saves trouble later.

**Laptops: don't sleep when the lid is closed.** By default a closed laptop goes to sleep, and the bot goes offline. To keep it running with the lid closed, run:

```bash
sudo sed -i 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/; s/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind
```

**Ubuntu Desktop instead of Server:** open **Settings**, then **Power**, and turn **Automatic Suspend** off. Otherwise the computer goes to sleep when nobody touches it. (Ubuntu Server doesn't do that.)

**Optional, power cuts:** many computers have a setting in their BIOS called "Restore on AC power loss" or "Power on after power failure". Set it to "On", and the server starts again by itself after a power cut. A.D.R.I.A.N. starts automatically whenever the computer does.

## 4. Connect from your Windows PC (SSH)

You can type every command on the server's own keyboard. It's usually easier to do it from your Windows PC, where you can copy and paste. Windows 10 and 11 include the `ssh` command for this.

1. On the Windows PC, open **Terminal** or **PowerShell** (press the Windows key, type `powershell`, press Enter).
2. Type this, with your username and the server's address, and press Enter:

   ```powershell
   ssh you@192.0.2.10
   ```

3. The first time, it asks `Are you sure you want to continue connecting (yes/no/[fingerprint])?`. Type `yes` and press Enter.
4. Type the server password and press Enter (nothing appears while you type).

You should now see a line ending in `$`, like `you@myserver:~$`. Everything you type now runs on the server. To leave, type `exit`.

**To paste** into the terminal: right-click, or press Ctrl+V (in Windows Terminal) or Ctrl+Shift+V.

If you see `Connection timed out` or `Connection refused`, check the address, that the server is on, and that you ticked "Install OpenSSH server" (if not, run `sudo apt install -y openssh-server` on the server).

## 5. Install A.D.R.I.A.N.

There are two ways. Try 5a first. If its first command prints `curl: (22) The requested URL returned error: 404` (and the second then says `bash: get.sh: No such file or directory`), the one-step installer isn't published yet: use 5b, which works for every version.

### 5a. The one-step installer

On the server, run these two lines:

```bash
curl -fsSLO https://raw.githubusercontent.com/Riqqqque/adrian-discord-voice/main/packaging/get.sh
sudo bash get.sh
```

What it does, in order:

1. Checks that the computer can run A.D.R.I.A.N. (processor, systemd, disk space, internet).
2. Lists any system packages it needs (for example `ffmpeg` for music) and asks `Install the system packages A.D.R.I.A.N. needs (...)? [Y/n]`. Press Enter to say yes.
3. Finds the newest release, downloads it with its checksum, and checks that the download is complete and unchanged.
4. Runs the installer inside it, which downloads the speech models (about 2 GB) and starts the service.

You can add installer options at the end, for example `sudo bash get.sh --lan` (see [step 6](#6-open-the-admin-page)).

If something isn't ready, it lists every problem at once, with what to do, and changes nothing. Fix them and run `sudo bash get.sh` again. Downloads that already finished are kept, so a second run is quicker.

Go on to [What you should see](#what-you-should-see).

### 5b. Install by hand (works with every version)

On the server, run these lines one at a time.

Install the tools the installer uses, and `ffmpeg` for music:

```bash
sudo apt update && sudo apt install -y curl xz-utils bzip2 iproute2 ffmpeg
```

This takes a few minutes: `ffmpeg` brings a lot of small helper packages with it, a few hundred MB in all. That's normal.

Find the newest version number:

```bash
VER=$(curl -fsSL https://api.github.com/repos/Riqqqque/adrian-discord-voice/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p'); echo "Newest release: $VER"
```

You should see something like `Newest release: 0.17.1`. If the number after the colon is empty, GitHub didn't answer. Open <https://github.com/Riqqqque/adrian-discord-voice/releases>, find the newest version (for example `v0.17.1`), and type `VER=0.17.1` (without the `v`) instead.

Download the release and its checksum, and check them:

```bash
curl -fLO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz
curl -fLO https://github.com/Riqqqque/adrian-discord-voice/releases/download/v$VER/adrian-voice-$VER-linux-x64.tar.gz.sha256
sha256sum -c adrian-voice-$VER-linux-x64.tar.gz.sha256
```

The last line must print `... OK`. If it says `FAILED`, the download is damaged: delete both files (`rm adrian-voice-*`) and download them again.

Unpack the installer and run it:

```bash
mkdir -p adrian-$VER && tar -xzf adrian-voice-$VER-linux-x64.tar.gz -C adrian-$VER
sudo adrian-$VER/packaging/install.sh --bundle adrian-voice-$VER-linux-x64.tar.gz
```

Options you can add at the end of the last line:

| Option | What it does |
|---|---|
| `--lan` | Lets other computers on your home network open the admin page (see [step 6](#6-open-the-admin-page)). Default: only this computer. |
| `--port N` | Use port N for the admin page. Default: 8790, or the next free one up to 8799. |
| `--yes` | Don't ask questions. |
| `--check` | Only check the computer and say what to fix; install nothing. (Newer versions.) |

**`VER` is forgotten when you close the window.** The commands above use `$VER`, which only lasts until you close that SSH window. Whenever you come back later and a command in these guides has `$VER` in it (for example to add `--lan` in [step 6](#option-c-open-it-to-your-home-network)), set it again first. `ls ~` shows a folder like `adrian-0.17.1`; the number in it is your version:

```bash
ls ~
VER=0.17.1
```

Once A.D.R.I.A.N. is installed, check that it's the version that runs now: `sudo adrian version` must print the same number. If the folder is gone, or the numbers differ (because you updated since), download and unpack the newest release again with the commands above, which set `VER` too.

### What you should see

The model download takes a while, with progress lines. At the end you should see something like:

```text
==> Installed A.D.R.I.A.N. voice 0.17.1
    Admin UI:   http://127.0.0.1:8790/
    From another computer: ssh -L 8790:127.0.0.1:8790 you@<this-server>, then open http://localhost:8790/
    Setup code: ABCDE-FGHJK  (expires in 60 min)
    Then follow the setup wizard. Status: sudo adrian status
```

Copy the **setup code** and the **port** (the number after `127.0.0.1:`, usually `8790`) into your notes. A port is a number that says which program on the server you want to talk to: the admin page listens on one port, the PC app's link on another. You'll type it after the server's address, with a colon, for example `192.0.2.10:8790`.

If the port isn't `8790` (for example `8791`), another program on the server already used 8790, so the installer took the next free number. That works, but the PC app's link normally uses 8791. If you'll use the PC app, see [07-troubleshooting.md](07-troubleshooting.md#a-port-is-already-in-use-or-a-firewall-blocks-it) ("The admin page got port 8791").

The setup code works for 60 minutes. If it runs out, get a fresh one with:

```bash
sudo adrian setup-code
```

**If you see something else:**

- `This computer is not ready for A.D.R.I.A.N. yet. Nothing was changed. Fix:` followed by a list: do what each line says, then run the same command again.
- `x86_64 only for now`, or a message about an ARM processor: this computer can't run it. See [step 1](#1-check-the-computer).
- `systemd is not running`, or a message about WSL or a container: see [step 1](#1-check-the-computer) and [Docker instead](#docker-instead).
- `missing command: ...` (version 0.17.1; newer versions list it under "not ready" above, as `Some tools this installer needs are missing`): run the `sudo apt install` line from [5b](#5b-install-by-hand-works-with-every-version), then the install command again.
- `checksum mismatch for ...` (version 0.17.1) or `... doesn't match its pinned checksum` (newer versions): run the same command once more. If the same file fails again, retrying won't help: see [07-troubleshooting.md](07-troubleshooting.md#a-download-doesnt-match-its-checksum).
- A download stopped halfway, or `Not enough free disk`: see [07-troubleshooting.md](07-troubleshooting.md#the-disk-filled-up-or-a-download-stopped).
- `the service did not come up`: see [07-troubleshooting.md](07-troubleshooting.md#the-bot-is-offline-in-discord) and run `sudo adrian doctor`.
- `warning: less than 4 GB of memory`: it may still work, but read [07-troubleshooting.md](07-troubleshooting.md#low-memory-or-it-keeps-restarting).

### What the installer did

So you know what's on your computer now:

- a system user called `adrian` that runs the bot (it can't log in);
- the app in `/opt/adrian`;
- the settings in `/etc/adrian`: `config.json`, and `secrets.env` with your keys (only the `adrian` user can read it);
- the speech models and everything A.D.R.I.A.N. remembers in `/var/lib/adrian`;
- a service called `adrian-voice` that starts with the computer and restarts by itself if it stops;
- the `adrian` command, for managing it. Most of its commands need `sudo`.

Running the installer again is meant to be safe: newer versions keep your settings, keys, port, `--lan` choice and admin account, and restart the service. It prints the same closing lines each time, including `Then follow the setup wizard`. If your setup is already done, ignore that line.

## 6. Open the admin page

The admin page is where you finish the setup. For safety it only listens on the server itself (address `127.0.0.1`, "this computer only"). Pick one of these three ways to open it.

### Option A: on the server's own screen

If the server has a screen, a desktop and a web browser (for example Ubuntu Desktop), open the browser there and go to `http://127.0.0.1:8790/` (use your port if it's different).

### Option B: an SSH tunnel from your Windows PC (recommended)

A tunnel makes the admin page appear on your own PC as if it were local. Nothing extra is opened on your network.

1. On the Windows PC, open a **new** PowerShell window (keep it separate from the one you used for commands).
2. Run this, with your username, the server's address, and your port in both places if it isn't 8790:

   ```powershell
   ssh -L 8790:127.0.0.1:8790 you@192.0.2.10
   ```

3. Log in with the server password. **Leave this window open** the whole time you use the admin page. Closing it closes the tunnel.
4. In your web browser on the PC, open `http://localhost:8790/`.

If you see `bind [127.0.0.1]:8790: Address already in use`, something on your PC already uses 8790. Use another number on your side, for example `ssh -L 18790:127.0.0.1:8790 you@192.0.2.10`, and open `http://localhost:18790/`.

### Option C: open it to your home network

Choose this only if you trust everyone on your home network. The login page is then sent over plain, unencrypted HTTP.

- New install: add `--lan` to the install command, for example `sudo bash get.sh --lan`.
- Already installed: run the install command again with `--lan` and your current port, then restart. With the one-step installer:

  ```bash
  sudo bash get.sh --reinstall --lan --port 8790
  sudo adrian restart
  ```

  If you installed by hand (5b), add `--lan --port 8790` to the `install.sh` line instead, then run `sudo adrian restart`. In a new SSH window, [set `VER` again](#5b-install-by-hand-works-with-every-version) first, or the line looks for a folder called `adrian-` and fails with `No such file or directory`:

  ```bash
  sudo adrian-$VER/packaging/install.sh --bundle adrian-voice-$VER-linux-x64.tar.gz --lan --port 8790
  sudo adrian restart
  ```

Then, on any computer at home, open `http://192.0.2.10:8790/` (your server's address and port). **Use the address with numbers**, not a name like `myserver.local`: a name gets `Unknown host name. Add it to server.allowedHosts in the config to use it.` unless you add it there (see [../install.md](../install.md)).

To go back to "this computer only": run the install command again with `--no-lan` instead of `--lan` (newer versions).

## 7. Run the setup wizard

### Create the admin account

The first page says **Welcome** and **Create the admin account**.

1. **Setup code:** paste the code from the installer, for example `ABCDE-FGHJK`.
2. **Username:** keep `admin`, or choose your own.
3. **Password:** at least 10 characters. Type it twice. There is only one admin account, so remember it (a password manager helps).
4. Click **Create admin account**.

If you see `setup code is wrong or expired`, get the current code with `sudo adrian setup-code` on the server and try again.

The wizard has seven steps, shown along the top: **Check, Discord, Language model, Search, Voice, Limits, Finish**.

### Step 1: Check

A table shows the computer's processor, memory, free disk and whether the speech models are installed. Yellow warnings mean it may be slow or short on memory; it can still work. Click **Continue**.

### Step 2: Discord

1. Paste the bot token from [01-discord-bot.md](01-discord-bot.md) into **Bot token** and click **Verify token**.
2. You should see `Token is valid and saved.` and `Signed in as A.D.R.I.A.N.` (your bot's name).
   - `This bot is public` in yellow: go back to [01-discord-bot.md, step 1.3](01-discord-bot.md#13-make-the-bot-private) and switch Public Bot off. It still works meanwhile.
   - `Discord rejected the token (401)` or `That doesn't look like a bot token`: copy the token again. If in doubt, click **Reset Token** in the Developer Portal and paste the new one.
   - `That's a number, probably the Application ID` (newer versions): you copied the Application ID, a long number, instead of the token. The token is on the **Bot** page: press **Reset Token** and copy what it shows (a long text with two dots in it). Version 0.17.1 says `That doesn't look like a bot token` here.
3. Click the **Invite link**. It opens Discord in a new tab.
   - Under **Add to Server**, choose your server and click **Continue**.
   - Check the list of permissions and click **Authorize**.
   - Discord may ask you to prove you're human. Do that yourself.
   - Close the tab and go back to the admin page.
4. Back on the admin page, click **I added it, refresh** (newer versions notice by themselves within a few seconds).
5. **Server:** choose your server. **Voice channel to join:** choose the voice channel the bot should live in.
   - Newer versions check that the bot may see, join and speak in that channel. If it says `The bot can't ... in General`, fix the channel's permissions in Discord as it describes. If the channel is private, add the bot's role to the channel's permissions with View Channel, Connect and Speak allowed.
   - **The voice channel list stays empty** even though the server has voice channels: that's a known problem in version 0.17.1. See [07-troubleshooting.md](07-troubleshooting.md#the-voice-channel-list-in-the-wizard-is-empty) for the workaround.
6. Click **Save and continue**.

### Step 3: Language model

1. Under **Language model**, choose your main model (for example **Claude Haiku 5.5 (Recommended)**).
2. Paste its key into **API key** and click **Test**.
3. You should see `Works: "..." in ... ms. About $0.0001 per answer at paid rates.` If you see a red message, it says what's wrong; see [07-troubleshooting.md](07-troubleshooting.md#keys-hit-their-limits-or-say-429).
4. Under **Fallback (optional)**, choose a second provider (for example Groq), paste its key and click **Test**. Or choose **No fallback**.
5. Click **Save and continue**.

The wizard won't continue until each choice has a key that passed the test. If you see `Paste and test a key for the main provider first.`, click **Test** and wait for `Works`. If you see `Pick a different fallback, or No fallback.`, the fallback is the same as the main model.

Using a model on your own computer instead? The wizard can't set that up. In your SSH window, run the command from [02-keys.md](02-keys.md#fully-local-a-model-on-your-own-computer-advanced-optional) first, then reload this page. The main choice now reads **Keep** and your model's name, the fallback reads **No fallback**, and **Save and continue** works without a key.

### Step 4: Search (optional)

The page's heading says **Web search (Recommended)**. It's still optional: everything else works without it, and you can add a key later.

- With a Tavily key: tick **Use web search**, paste the key, click **Test**, then **Save and continue**.
- Without one: make sure **Use web search** is unticked and click **Save and continue**.

### Step 5: Voice

Choose a voice (the recommended one is `af_heart`) and a speed. Click **Preview** to hear it; the first preview takes about 10 seconds because the voice model loads. Click **Save and continue**.

The preview plays on the computer you're browsing from. If you hear nothing, check that computer's volume.

### Step 6: Limits

1. **Time zone:** where you live, written like `Europe/London` or `America/Chicago`. It decides when "today" starts for the daily limit, reminders and alarms. The page usually fills in your browser's time zone.
2. **Questions per person per hour:** default 30.
3. **Daily cap (USD)** and **Monthly cap (USD)**: default $1 and $10. When a cap is reached, she says she's paused and stops calling the paid model until the next day or month. `0` means no limit.
4. Click **Save and continue**.

### Step 7: Finish

If anything is still missing, the page lists it under `Before starting, fix:`. Click **Back** to fix it.

Otherwise, click **Start A.D.R.I.A.N.**. You should see `Loading speech models and joining the voice channel. This takes about 20 seconds…`, and then the **Dashboard**. On its **Status** tab you want two green badges: `running` and `in voice`.

**If you see something else:**

- `Could not start: ...` with a `What to do:` line: do what it says. Common: a token problem or a missing permission.
- `running` but `not in voice` after a minute: the bot can't join the channel. See [07-troubleshooting.md](07-troubleshooting.md#the-bot-is-online-but-doesnt-join-the-voice-channel).
- The page says `Your session ended. Log in again.`: normal after any restart or update. Log in with your username and password.

## 8. First test in a voice channel

1. In Discord, join the voice channel you picked. The bot should already be there.
2. Say, clearly: **"Hey Adrian, what time is it?"**
   She answers with the time. This one is answered on the server without the language model, so it also works when a key is wrong.
3. Now ask something only the language model can answer: **"Hey Adrian, what's the capital of Australia?"**
4. Try a pause: say **"Adrian?"**, wait for her **"Yes?"**, then ask your question.
5. To stop her mid-answer, say **"stop"**.

After step 3, the dashboard's **Spending** box should show a tiny cost for today (for example `$0.0011`), and the count of questions today goes up. (The time question costs nothing.)

Nothing happens? Go to [07-troubleshooting.md](07-troubleshooting.md#she-doesnt-respond-at-all-in-the-voice-channel).

To bring her to another voice channel, join it and type `/join` in any text channel of that server. `/leave` sends her away. After a restart or update she goes back to the channel you picked in the wizard.

More things to say: [../usage.md](../usage.md).

## 9. Recommended next steps

1. **Turn on automatic updates** (2 minutes). See [05-updating.md](05-updating.md#turn-on-automatic-updates-recommended).
2. **Make a backup** once everything works. See [06-backup-restore-uninstall.md](06-backup-restore-uninstall.md).
3. **Owners.** The Discord account that created the bot application is automatically an "owner": owners can stop anyone's answer, skip the queue, and aren't held to the hourly question limit. To add more owners (up to 10), use their user IDs:

   ```bash
   sudo adrian config owners '["123456789012345678"]'
   sudo adrian restart
   ```

   Several owners: `'["123456789012345678","234567890123456789"]'`. The list replaces the old one each time.
4. **The PC app** (optional): [04-pc-app.md](04-pc-app.md).

Every other setting is in [../configuration.md](../configuration.md). You change one with `sudo adrian config NAME VALUE`, then `sudo adrian restart`. Settings changed on the admin page take effect after **Restart bot** on its Status tab.

---

## Docker instead

If you already run your home services with Docker, there is a Docker setup in the release. It is meant for people comfortable with Docker, and it has fewer helpers: no `adrian` command, so no `update`, `rollback`, `backup` or `doctor`. Updates mean building the new image yourself. The steps are in [../install.md](../install.md), under Docker.

Inside Docker, commands that use `sudo adrian ...` in these guides take this form instead, run from the `packaging/docker` folder:

```bash
docker compose exec adrian node dist/cli/tool.js setup-code
docker compose exec adrian node dist/cli/tool.js check
```

The rest of the setup (the admin page, the wizard, the voice test) is the same. The admin page is published on `http://127.0.0.1:8790/` of the Docker host, so use [Option A or B](#6-open-the-admin-page) to open it.

**Next:** [04-pc-app.md](04-pc-app.md) for the PC app, or [05-updating.md](05-updating.md) to turn on automatic updates.
