# 1. Create the Discord bot

A.D.R.I.A.N. joins Discord as a bot account. In this guide you create that account in Discord's Developer Portal and copy its **token**: the secret that lets A.D.R.I.A.N. log in as the bot. You also learn how to copy Discord IDs, which you'll need later.

Time: 10 to 15 minutes. You need a Discord account and a web browser. You don't need the server computer yet.

Discord changes the look of the Developer Portal from time to time. The button names below were correct in November 2026. If one has moved, look for the same words nearby.

[Back to the start](README.md)

---

## 1.1 Have a Discord server ready

You need a Discord server (Discord also calls it a "guild") where you have the **Manage Server** permission. If you made the server yourself, you have it.

To make a new server just for testing:

1. In the Discord app, click the **+** ("Add a Server") at the bottom of the server list on the left.
2. Choose **Create My Own**, then **For me and my friends**.
3. Give it a name and click **Create**.

A new server comes with a voice channel called "General". That's fine for testing.

## 1.2 Create the application

1. Open the Developer Portal: <https://discord.com/developers/applications>. Log in with your Discord account if asked.
2. Click **New Application** (top right).
3. Type a name, for example `A.D.R.I.A.N.`. This is the name people see in Discord.
4. Tick the box to accept Discord's terms, then click **Create**.

You should now see the application's **General Information** page. You can add a picture here if you like (optional).

## 1.3 Make the bot private

A private bot can only be added to servers by you. That stops strangers from adding your bot to their servers, where it would answer them on your bill.

1. In the left menu, click **Installation**.
2. Under **Install Link**, choose **None**, then click **Save Changes** at the bottom if it appears.
3. In the left menu, click **Bot**.
4. Find **Public Bot** and switch it **off**. Click **Save Changes**.

If you see an error like "Private application cannot have a default authorization link" when switching Public Bot off, you skipped steps 1 and 2: set the Install Link to **None** first, then try again.

On the same Bot page, leave **Requires OAuth2 Code Grant** switched **off**.

## 1.4 Copy the bot token

1. Still on the **Bot** page, click **Reset Token**, then confirm with **Yes, do it!**.
2. If you use two-factor login, Discord asks for your code or password. Enter it.
3. A long line of text appears. Click **Copy**.
4. Paste it somewhere safe for now, for example a Notepad file. You'll paste it into the setup wizard in [03-server-install.md](03-server-install.md).

A real token is one long piece of text with two dots in it, like `MTE...xyz.Gh1abc.k9...`. It is not the "Application ID" (only digits) or the "Public Key" (on the General Information page). The setup wizard tells you if you pasted the wrong one.

**Keep the token secret.** Anyone who has it controls your bot. Never paste it into a Discord chat, a screenshot or a public post. If it ever leaks, come back here and click **Reset Token** again: the old one stops working at once. Then paste the new one into the admin page (Keys tab, `DISCORD_TOKEN`) and restart the bot.

Discord shows the token only once. If you lose it, click **Reset Token** to get a new one.

## 1.5 Privileged intents: all optional

Further down the **Bot** page is a section called **Privileged Gateway Intents** with three switches. A.D.R.I.A.N. works with all three **off**. Each one adds something:

| Switch | What it adds if you turn it on |
|---|---|
| **Presence Intent** | It can answer "who's online?" and "what is Sam playing?". Also used for game-night pings. |
| **Server Members Intent** | It can see the full member list, for questions about members and roles. |
| **Message Content Intent** | In text channels, it reads the recent messages for context and lets you keep chatting without @mentioning it each time. Typed music commands like `!play` work without an @mention. |

Without Message Content, the bot still answers text messages that @mention it, reply to it, or are sent to it as a direct message.

Turn on whichever you want, then click **Save Changes**. A.D.R.I.A.N. checks which ones are on when it starts and only uses those, so you can change your mind later. Bots in fewer than 100 servers can switch these on freely.

## 1.6 Don't make an invite link yet

The setup wizard makes the invite link for you, with exactly the permissions the bot needs, once the token is in. You'll use it in [03-server-install.md](03-server-install.md#7-run-the-setup-wizard).

The permissions it asks for are: View Channels, Connect, Speak, Use Voice Activity, Send Messages, Send Messages in Threads and Read Message History. It also adds the `/join`, `/leave`, `/play`, `/music` and `/alarm` slash commands. It never asks for Administrator.

If you ever need the link without the wizard, it is:

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot+applications.commands&permissions=274914675712
```

Replace `APPLICATION_ID` with the number shown as **Application ID** on the General Information page.

## 1.7 Turn on Developer Mode and copy IDs

Discord gives every server, channel and person a long number called an **ID**. You'll need your own user ID for a few things (making yourself an owner, pairing the PC app), and the server and channel IDs are a handy fallback for the setup.

Turn on Developer Mode once:

1. In the Discord app, click the gear (**User Settings**) next to your name at the bottom left.
2. Click **Advanced** in the left menu.
3. Switch **Developer Mode** on.
4. Close the settings.

Now you can copy IDs by right-clicking:

| To copy | Right-click | Then choose |
|---|---|---|
| Your user ID | your own name, in the member list or on a message you wrote | **Copy User ID** |
| The server ID | the server's icon in the list on the left | **Copy Server ID** |
| A voice channel's ID | the voice channel in the channel list | **Copy Channel ID** |

On a phone: long-press instead of right-clicking. An ID is 17 to 20 digits, for example `123456789012345678`.

Paste your user ID into your notes file now. You'll want it later.

## 1.8 Check your notes

Before moving on, you should have:

- the bot token (long text with two dots), kept private;
- your own Discord user ID (17 to 20 digits);
- a Discord server where you have Manage Server, with a voice channel in it.

**Next:** [02-keys.md](02-keys.md), to get a language-model key.
