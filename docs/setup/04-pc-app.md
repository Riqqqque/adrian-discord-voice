# 4. The PC app (Windows, optional)

The PC app lets you talk to A.D.R.I.A.N. through your Windows PC's microphone and hear her through its speakers, without being in a Discord call. She can also control the PC: open apps and games, pause or skip music, change the volume, move windows, lock the screen, and more. It uses the same server, memory, keys and spending limits as the Discord bot.

Time: 10 to 15 minutes.

You need:

- the server from [03-server-install.md](03-server-install.md), working;
- a Windows 10 or 11 PC (64-bit) with a microphone and speakers or headphones;
- the PC and the server on the same home network;
- your Discord user ID ([01-discord-bot.md, step 1.7](01-discord-bot.md#17-turn-on-developer-mode-and-copy-ids)).

[Back to the start](README.md)

---

## Before you start: two things to know

**Anyone near the PC counts as you.** The PC is paired to one Discord account, its owner. Everything said at that PC is treated as coming from that person, with their rights, because she can't tell voices apart yet. If the owner is also an owner of the bot, that includes owner-only powers. If other people use the room, turn off the PC actions you don't want them to have ([step 4.8](#48-what-she-may-do-on-this-pc)).

**The PC sends sound to your server whenever someone talks near it.** Not only after "Hey Adrian": the PC just notices that someone is talking and sends that sound to your own server, which writes out the words and decides whether they were meant for her. That happens on your server, not on the internet. Nothing is recorded unless you turn recordings on, and only the question goes to the language model, as with Discord. (The optional Groq second listen in [02-keys.md](02-keys.md#groq-a-second-listen-at-the-pc) does send speech meant for her to Groq.)

## 4.1 Turn on the PC link on the server

In your SSH window on the server ([03-server-install.md, step 4](03-server-install.md#4-connect-from-your-windows-pc-ssh)):

```bash
sudo adrian config satellite.enabled true
sudo adrian restart
```

You should see `satellite.enabled = true. Restart to apply: sudo adrian restart`. The restart then takes up to a minute and finishes with no message.

If the restart prints `error: not healthy after 60 s: adrian logs` instead, the bot itself isn't starting, and the PC link only starts together with the bot. Find out why on the admin page's **Status** tab (or with `sudo adrian doctor` in newer versions) and fix that first; usually it's the bot token. See [07-troubleshooting.md](07-troubleshooting.md#the-bot-is-offline-in-discord). Until then the check below shows nothing.

Check that it listens:

```bash
sudo adrian logs | grep satellite
```

You want a line containing `"msg":"satellite server listening"` and `"port":8791`. The PC app connects to that port.

If the admin page got port 8791 when you installed (the installer's `Admin UI:` line ended in `:8791/`), the PC link can't use 8791 too. Move it to 8792 as shown in [07-troubleshooting.md](07-troubleshooting.md#a-port-is-already-in-use-or-a-firewall-blocks-it), and use 8792 instead of 8791 everywhere below.

**If your server uses a firewall.** Ubuntu's firewall (UFW) is off unless someone turned it on. Check:

```bash
sudo ufw status
```

- `Status: inactive`: nothing to do.
- `Status: active`: allow the PC app's port from your home network only. Replace `192.0.2.0/24` with your network: your server's address with the last number replaced by `0`, then `/24`.

  ```bash
  sudo ufw allow from 192.0.2.0/24 to any port 8791 proto tcp
  ```

**Never forward port 8791 in your router to the internet.** The connection is not encrypted. To use the PC app away from home, connect the PC to your home network with a VPN (for example WireGuard or Tailscale) and use the server's VPN address.

## 4.2 Pair the PC

Each PC gets its own pairing, tied to the Discord account of the person who uses it. Pick a name for the PC, and use your Discord user ID:

```bash
sudo adrian satellite add "Desk PC" 123456789012345678
```

You should see:

```text
Paired "Desk PC" (id 0123456789ab).
Token (shown once; paste it into the PC app): sat_...
```

Copy the whole token, starting with `sat_`, into your notes. **It is shown only once.** It works like a password for that PC: anyone with it can connect as you.

Lost it before pasting it? Remove the pairing and make a new one:

```bash
sudo adrian satellite list
sudo adrian satellite remove 0123456789ab
sudo adrian satellite add "Desk PC" 123456789012345678
```

(`list` shows each PC's id; use yours in `remove`.)

## 4.3 Download the app

1. On the PC, open the releases page: <https://github.com/Riqqqque/adrian-discord-voice/releases>
2. Under the newest release (marked **Latest**), open **Assets**.
3. Click `adrian-pc-app-<version>-windows-x64.zip` to download it (for example `adrian-pc-app-0.17.1-windows-x64.zip`, about 5 MB).
4. Also download `adrian-pc-app-<version>-windows-x64.zip.sha256` (optional, for the check below).

The `.exe` with the same name is the file the app uses to update itself. You don't need it.

### Check the download (recommended)

This proves the file is exactly the one published, not damaged or swapped.

1. Open PowerShell (Windows key, type `powershell`, Enter).
2. Run this, with your version number:

   ```powershell
   Get-FileHash "$HOME\Downloads\adrian-pc-app-0.17.1-windows-x64.zip"
   ```

3. It prints a long code under **Hash**. Open the `.sha256` file with Notepad: it starts with a long code too.
4. The two codes must be the same (uppercase or lowercase doesn't matter). If they differ, delete the zip and download it again. Don't run a file that doesn't match.

### Unpack it

Right-click the zip, choose **Extract All...**, then **Extract**. The new folder holds three files: `ADRIAN.exe`, `Install.ps1` and `README.txt`.

## 4.4 Install

1. Open the unpacked folder in File Explorer.
2. Click in the address bar at the top (where the folder's path is), so the path is selected.
3. Type this and press Enter:

   ```text
   powershell -NoExit -ExecutionPolicy Bypass -File .\Install.ps1
   ```

   This runs the included install script once, without changing Windows' script settings. `-NoExit` keeps the window open afterwards, so you can read what it says.

A PowerShell window opens. When the script is done, it says `A.D.R.I.A.N. is installed: on the desktop, in the Start menu, and running in the tray.`, with a `PS ...>` prompt under it. Then close that window with its X (the app keeps running). If the window shows red text instead, the install didn't finish. The most common one is `Build the app first ...`: despite the wording, it means `ADRIAN.exe` isn't in the folder next to `Install.ps1`. Usually an antivirus removed it ([If your antivirus complains](#if-your-antivirus-complains)), or the command ran in a different folder than the unpacked one.

The script:

- copies the app to your user's own programs folder (`%LOCALAPPDATA%\A.D.R.I.A.N`);
- adds **A.D.R.I.A.N.** to the desktop and the Start menu;
- makes it start with Windows, quietly in the tray (the small icons near the clock);
- starts it now, with its window open.

### "Windows protected your PC"

The first time the app starts, Windows may show a blue box saying **Windows protected your PC** and "Unknown publisher". That's because the app isn't signed with a paid certificate, not because anything is wrong with it. If your file passed the check in 4.3:

1. Click **More info**.
2. Click **Run anyway**.

It doesn't ask again for that file.

### If your antivirus complains

Some antivirus programs distrust any new, unsigned program, especially one that downloads its own updates, as this one does. If yours blocks or removes `ADRIAN.exe`:

1. First make sure your download passed the check in 4.3. If it didn't, don't go further: download it again.
2. **Microsoft Defender:** open **Windows Security**, then **Virus & threat protection**, then **Protection history**. Click the entry for `ADRIAN.exe`, then **Actions**, then **Restore** (or **Allow on device**).
3. **Other antivirus programs:** look for "quarantine" or "exclusions" in its settings and restore the file.
4. Run the install command from 4.4 again.

Don't turn your antivirus off to install it. You can also report a wrong warning to your antivirus maker (for Microsoft: <https://www.microsoft.com/wdsi/filesubmission>), which helps everyone.

## 4.5 Connect it

The app's window opens with **Settings** showing, because it isn't paired yet.

1. Under **Server and pairing**:
   - **Server address:** your server's address, a colon, and `8791` (or the port you moved the PC link to in 4.1). For example `192.0.2.10:8791`.
   - **Pairing token:** paste the `sat_...` token from 4.2.
2. Click **Save**.

Within a few seconds the top of Settings should say **Connected to your home server**, with `Her voice, memory and tools are the same as in Discord.` under it. Close Settings with the X at its top right. The small label at the top of the window should say **Ready**. (Hovering over the tray icon shows `Connected as Desk PC`.)

On the server, `sudo adrian logs | grep satellite` now shows `"msg":"satellite connected"`.

**If you see something else:**

- `Can't reach the server: ...`: the address or port is wrong, the PC link isn't on, or a firewall is in the way.
- `The server refused this PC (bad token). Check the token in settings.`: the token is wrong or was removed.
- The label stays on **Connecting** or **Offline**.

For all of these, go to [07-troubleshooting.md](07-troubleshooting.md#the-pc-app-wont-connect).

The token is stored encrypted for your Windows user only. After a successful save, the token box shows `Paired. Paste a new token only to replace it.`

## 4.6 Using it

- **Say "Hey Adrian, ..."** anywhere in the room. Or **hold Ctrl+Alt+Space** while you talk: then you don't need to say her name. Or type in the box at the bottom of the window and press Enter.
- **Stop her:** say "stop", talk over her, click the square stop button, or press Escape in the window.
- **Close the window** with the X: she keeps running in the tray. Click the tray icon to open the window again. Right-click the tray icon for **Show A.D.R.I.A.N.**, **Stop alarm**, **Snooze alarm** and **Quit**. In the tray she uses a few MB of memory and almost no CPU.
- **In the bot's Discord call at the same time?** While you're in her voice channel and not muted, the call answers instead of the PC (so music plays for everyone), and the window says `Answering in the Discord call.` To talk to the PC alone, mute yourself in Discord, hold Ctrl+Alt+Space, or type.
- **Quiet while gaming:** while a game is in front, she only answers to her name or push-to-talk, keeps answers short, and saves reminders for after the match. Switch it off under **Games** in Settings.

Things to try: "Hey Adrian, open Spotify", "pause the music", "turn it down", "put Discord on the left", "why is my PC slow?". More: [../pc-app.md](../pc-app.md).

## 4.7 The wake word

There is nothing to install or train. Her wake word is her name, "Adrian", and it's recognized on the server, the same way as in Discord. "Hey Adrian, ...", "Adrian, ..." and just "Adrian?" all work.

What you can tune on the PC is **how easily it notices talking**, under **Microphone** in Settings:

- The bar moves when the microphone hears sound. If it never moves, Windows is using another microphone: pick the right one as the default in Windows' sound settings. The app follows Windows' default microphone and speakers, even when you change them.
- **Sensitivity** starts at **Automatic**, which adjusts to the room. If she reacts to the TV or background noise, move it to the right. If she misses you, move it back to the left or to Automatic.
- In a noisy room, holding Ctrl+Alt+Space is the most reliable.

Click **Save** after changing it.

## 4.8 What she may do on this PC

Under **What she may do on this PC** in Settings, each kind of action has its own switch: apps and games, window layout, web and folders, media, volume, PC status, clipboard, screen, lock, turning the screens off, sleep, restart and shut down. All are on at first.

- Sleep, restart and shut down always ask you out loud first and need a spoken "yes". Restart and shut down then wait 30 seconds; say "cancel" to stop them.
- Clipboard and screen are used only when you ask ("summarize what I copied", "what's this error on my screen?").
- She never closes, focuses or moves a running game, and never types or clicks into other programs.

Anything switched off is refused by the PC itself, whatever the server asks. Click **Save** after changing switches.

## 4.9 Start with Windows (or not)

The install script makes the app start with Windows, in the tray. To stop that:

- Open **Task Manager** (Ctrl+Shift+Esc), click **Startup apps**, right-click **A.D.R.I.A.N.** and choose **Disable**.
- Or run the install command from 4.4 again with `-NoStartup` at the end.

To start it by hand, use the **A.D.R.I.A.N.** shortcut on the desktop or in the Start menu.

## 4.10 More than one PC

- **Each PC needs its own pairing** (step 4.2, with a different name). Don't use one token on two PCs: they keep knocking each other off the server.
- **Several people:** pair each PC to the Discord ID of the person who uses it.
- **One person with several PCs:** pair each to the same ID. When you ask from Discord ("open Spotify on my PC"), it goes to the PC you used most recently.
- Paired PCs: `sudo adrian satellite list`. Removing one: `sudo adrian satellite remove ID`, then `sudo adrian restart` if that PC is connected right now.

## What's next

- Updates happen by themselves: [05-updating.md](05-updating.md#the-pc-app).
- Removing the app: [06-backup-restore-uninstall.md](06-backup-restore-uninstall.md#remove-the-pc-app).
- Problems: [07-troubleshooting.md](07-troubleshooting.md#the-pc-app-wont-connect).
- Everything the PC app can do: [../pc-app.md](../pc-app.md).
