# Using A.D.R.I.A.N.

## Waking it

| You say | It does |
|---|---|
| "Hey Adrian, …" | Answers the question. Greetings like "hi", "yo", "okay", "hola", "oye" and "chào" work too. |
| "Adrian, …" | Treated as a question to it. |
| "… hey Adrian, …" in the middle of a sentence | Also a question to it. |
| "Adrian?" (the name alone) | "Yes?", then it listens to your next sentence (for 20 seconds). |
| "Adrian is so slow" | Talk *about* it: the model decides whether to answer, and usually stays quiet. |

After it answers, you have about 8 seconds to follow up without the name ("and what about tomorrow?"). If the follow-up is clearly not for it (game callouts, talking to someone else), it stays silent.

Speech recognition spells unusual names oddly, so it tolerates misspellings like "Adrien" and "Adrean".

## Busy calls

- **One answer at a time.** Up to 2 more requests wait in line; requests that wait too long are dropped with "Sorry, I missed that."
- **Interrupting:** the person being answered can interrupt by talking for about 2.5 seconds, or by saying the name. Laughs and short reactions don't cut it off.
- **"Stop", "shut up", "be quiet", "never mind", "stfu":** from anyone, these stop the current answer immediately. "Shut up", "be quiet" and "stfu" also count at the start of a short remark (up to 8 words, not a question), like "bro, shut up" or "can you be quiet". Anywhere else in a sentence they don't, so "I told her to shut up" changes nothing.
- **Everyday words:** "done", "quiet", "enough" and "that's it" only stop it when the person being answered says them, or when they come with the name ("Adrian, quiet").
- **Owners** can stop anyone's answer and go to the front of the line.
- **Priority roles** (`priorityRoleIds`) can interrupt anyone's answer.

## Things handled instantly (no model call, free)

- Stop phrases, "thanks", "bye", "okay" / "cool" (nothing to answer).
- "Repeat that" / "what did you say".
- "Louder" / "quieter", "faster" / "slower" (voice; with music playing, "turn it up" / "turn it down" changes the music). Each room keeps its own: changing her voice at a PC leaves the call alone, and the other way round. They reset on a restart.
- "What time is it".
- Plain music commands: "play X", "skip", "pause", "keep playing", "stop the music", "what's playing".

Said with the name or right after "Yes?", all of these are instant. In a follow-up without the name, only stop phrases, "thanks", "bye" and "okay" are: the rest might be meant for someone else, so the model decides (one model call).

Everything else goes to the language model.

## Music

| You say | It does |
|---|---|
| "Play Blinding Lights" | Searches YouTube Music's song catalog and plays the real track. |
| "Play Travis Scott" | Their biggest song first, then their best-known songs shuffled, then similar songs. |
| "Play some music", "play something I'd like" | A shuffled mix of the artists you ask for most. |
| "Play something you like" | Her own taste. |
| "I love Frank Ocean", "I hate country" | She remembers it for next time. |
| "Play the whole Graduation album" | The album in order. |
| "Put on something chill for a late night drive" | Finds a matching public playlist and shuffles it. |
| "Play a playlist like that last song" / "more like this" | YouTube Music radio based on what was playing. |
| "Play the newest Joe Rogan episode" | The newest playable episode of that podcast. |
| "Play 10 hours of rain sounds" | Any YouTube video's audio, any length. |
| "Play Sicko Mode next" / "add Humble to the queue" | Adds to the queue (up to 25). |
| "Play Thriller from Plex" | Uses your Plex music library. |
| "Skip", "pause", "keep playing", "stop the music", "clear the queue" | Controls. Said just like that, "clear the queue" also stops the current song. |
| "Go back", "previous song" | Plays the song before this one again; this one comes next. |
| "Set the music to 30 percent" | Sets the music's level (5 to 100). "Turn it up" / "turn it down" still nudge it. |
| "Shuffle", "what's playing?", "what's next?" | Queue control and status. |
| "Who put this on?" | Who asked for the song playing, or that autoplay picked it. |
| "Turn off autoplay" | Stop adding similar songs when the queue ends. |

- **Who can change it:** people in the voice call (muted counts), the owner of the PC it's playing on, and owners. Anyone can ask what's playing, but nobody else can play, skip or stop anything, from text chat or DMs either. Sounds work the same way.
- **Volume:** music sits under the voice and drops further whenever someone says the name or the bot talks. Noise and talking to other people leave it alone. "Set the volume to 30" sets the music's level and she says it back; with nothing playing, she says it's for the next song.
- **Taste:** she learns what you like from the artists and songs you ask for, and favors recent ones. She also builds up a taste of her own. Yours is only used in your own conversations.
- **After an order:** when she's done something ("play Drake", "set a timer"), she stops listening right away, so talking to someone else afterwards isn't taken as more for her. After a normal answer, or if she asked you something, you can carry on without her name.
- **Autoplay:** when the queue runs low, it adds songs similar to the last one and skips anything played recently, including the same song in another upload (the video, the lyrics version). Nightcore, sped-up and 8D remakes are left out unless that's what was playing.
- **Songs YouTube won't play** (age-restricted, removed): it tries another upload of the same song, and says so if none plays.
- **Nobody left in the call:** after 2 minutes the music stops, autoplay with it.
- **"Stop":** when the bot is talking, it stops the talking and the music keeps playing. When the bot isn't talking, a stop aimed at it stops the music.
- **`/leave`, or `/join` to another channel:** stops the music. Being dragged to another channel keeps it playing.
- **Lyrics:** it won't sing or read out song lyrics. It just names what's playing.

### Music commands in text

The same music, typed instead of said: as slash commands (`/play`, `/music ...`) or with a `!` prefix (`!play`, `!skip`). They work in any text channel of the server she's in.

| Command | It does |
|---|---|
| `/play query:` | Plays it, like saying "play X": a song, or a well-known artist's top songs. Suggests songs played lately and artists you play while you type. Pasting a YouTube, YouTube Music, Spotify, SoundCloud or Bandcamp link plays that. |
| `/play type:` | Says what it is: song, artist, album, playlist, mood ("chill late night r&b"), similar (to what's playing, or to what you type), podcast, any YouTube audio, your favorites, or hers. |
| `/play queue:True` | Adds it to the queue instead. `source:Plex library` looks in Plex first. |
| `/music now` | The now-playing card (only you see it), with Back, Pause/Resume, Skip, Stop and Queue buttons. |
| `/music queue [page]` | What's coming up, 10 per page, with who asked for each. |
| `/music skip [to]` | Skips this song, or jumps to a place in the queue. |
| `/music back`, `pause`, `resume`, `stop` | As said aloud. Stop also clears the queue. |
| `/music volume [level]` | Sets the music level (5-100), or shows it. |
| `/music shuffle`, `clear`, `remove position:` | Changes the queue. Clear leaves the current song playing. |
| `/music autoplay on:` | Similar songs after the queue runs out, or not. |
| `/music who` | Who asked for this song. |

- **Who can use them:** the same people as by voice. Changing the music takes being in her call (owners can from anywhere). Looking at it (`now`, `queue`, `volume` without a level, `who`) works for anyone in the server.
- **She comes to you:** playing something from a voice channel she isn't in brings her there first, by `/join`'s rules: she won't leave a call that has other people in it, unless an owner asks. An owner who isn't in any call plays into hers.
- **What everyone sees:** a started song posts the card with its buttons in the channel, and changes say who made them ("Sam skipped"). With slash commands, refusals and lists only show to you; `!` commands answer in the channel.
- **Limits:** a play counts toward the hourly limit like a spoken request. During a music quiz, skip and stop go to the quiz and the rest waits for it.
- **Slash commands not showing?** Discord caches the command list: restart Discord or press Ctrl+R. Server admins can also limit an app's commands under Server Settings → Integrations.

**`!` commands**

| Command | It does |
|---|---|
| `!play <song, artist or link>` (`!p`) | Plays it now. `!play` alone resumes. |
| `!queue <song>`, `!playnext <song>` (`!add`, `!pn`) | Adds it to the queue. |
| `!album`, `!playlist`, `!artist`, `!podcast`, `!vibe`, `!video <words>` | Says what it is. |
| `!similar [song]`, `!favorites`, `!hers`, `!plex <song>` | Songs like this one, what you like, what she likes, from Plex. |
| `!skip [n]` (`!s`, `!next`), `!back` | Skip (to a place in the queue), or the song before. |
| `!pause`, `!resume`, `!stop` | As said aloud. |
| `!np`, `!queue [page]` (`!q`), `!who` | What's playing (with buttons), what's next, who asked. |
| `!volume [5-100]` (`!vol`), `!shuffle`, `!clear`, `!remove <n>`, `!autoplay [on/off]` | The rest of the controls. |
| `!join`, `!leave` (`!dc`) | Like `/join` and `/leave`. |
| `!help` | This list. |

They need the bot's **Message Content** intent (Developer Portal → your app → Bot → Privileged Gateway Intents, then `sudo adrian restart`). Without it Discord only shows the bot messages that @mention it, so type `@A.D.R.I.A.N. !play x`. Change the `!` with `sudo adrian config music.prefix "?"`, or turn them off with an empty prefix. Words she doesn't know (`!roll`), and her words with something extra after them (`!clear 50`), are left for other bots. `!help` needs the @mention, since other bots answer it too. If another music bot in the server also uses `!play`, give one of them another prefix.

## Music quiz

"Start a music quiz", "let's play guess the song", "music quiz, 5 rounds of 90s hip hop", "guess the song with songs we've played", "a Drake music quiz".

- **Each round** plays about 20 seconds from the catchy part of a song (the part people replay most on YouTube, or about a third of the way in). Nothing gives it away: no title on screen or in the PC window, no message in chat, and she doesn't know it herself if you ask her.
- **Answering:** anyone in the call just says the title or the artist, no "Adrian" needed. Close is fine: most of the title, "the weekend" for The Weeknd, "7 nation army". An everyday word on its own isn't enough: "fire" isn't Earth, Wind & Fire, "sons" isn't Mumford & Sons (but "Mumford" is), "take" isn't Take on Me, and "yeah yeah" isn't "Yeah!". A title or band that is one everyday word ("Hello", "Yeah!", "Stay", "Yes") needs a clear guess: "is it Hello", "it's Yeah", "Hello by Adele", or her name first; a bare "hello" in the call doesn't count. The first right answer gets the point. In an artist quiz only the title counts. Talking about other things in between is ignored, and she never answers it.
- **A wrong guess to her** ("Adrian, is it Purple Rain?") gets "Not quite." Anything else said to her ("Adrian, is it raining?", "Adrian, it's too loud") is handled as usual.
- **Hint** after about 12 seconds (never later than 60% of the clip): the artist's first letter, or the year. "Give us a hint" gets it early.
- **Reveal:** when someone gets it, or when the clip ends: title and artist.
- **"Skip this round"** (or "skip this song", "next song", "next round"), **"what's the score?"**, **"give us a hint"** and **"stop the quiz"** work without her name when said on their own. A bare "skip" or "next", and everyday phrases like "hint", "who's winning", "I'm done", "pass", "give up" or "who's this?", need her name ("Adrian, skip"), so talk among yourselves never ends or skips the quiz. A stop for her while she isn't talking ("Adrian, stop") ends it too. At the end she reads the scoreboard.
- **Music controls while it runs:** "skip" and "stop the music" go to the quiz, "turn it down" and "set the volume to 30" change the clip's level, and "go back", "pause" or "who put this on?" get "say stop the quiz first".
- **Kinds:** a genre (pop, rock, hip hop, R&B, country, metal, latin, k-pop...), a decade (50s to 2020s), both, an artist, or songs played here lately. With nothing named: today's popular songs. Default 8 rounds (up to 20).
- **Music requests wait:** while a quiz runs, "play X" gets "say stop the quiz first". Her other commands work as usual. Starting a quiz stops what was playing, and it doesn't come back afterwards: ask for music again.
- **It ends by itself** when nobody tries for two rounds (a guess, a near miss, "is it...", a quiz order or anything said to her counts; talk about other things doesn't), or everyone leaves.
- **A song that won't play** (its clip stops right away) is never revealed: another song takes the round. A clip that breaks partway through ends the round with the reveal, as if it ran out. After three in a row the quiz ends.
- **Songs played here** can come from Plex as well as YouTube.
- **At a PC** it works the same, just for you.
- Answers are checked on the spot, for free. A near miss ("bohemian" for Bohemian Rhapsody) may cost one tiny model call, at most twice a round.

## Sounds

"Make an airhorn sound", "do a drum roll", "cat meow", "sad trombone", "what does a wolf sound like?": it finds a short sound effect on YouTube and plays it once, up to 15 seconds, on top of any music (the music ducks). "Stop" cuts it off. For simple vocal sounds it may just say them. Needs the same setup as music (yt-dlp and ffmpeg).

## Timers, reminders, memory

- **Timers and reminders:**
  - "Set a timer for 10 minutes", "remind me at 6 to take the pizza out", "what timers do I have", "cancel my timer". Up to 20 per person, and they survive restarts.
  - When one goes off, it's announced in the call if you're in it and can hear it. If not, one you set at your PC goes off there, with a DM as well. Otherwise you get a DM (or, muted in the call, it's still announced there).
- **Notes:**
  - "Remember that I'm allergic to peanuts", "forget my birthday". Up to 30 notes per person.
  - It also notes useful facts on its own every few answers (`autoMemory`).
  - Your notes are only ever used when **you** talk to it. It never tells anyone else what's in them.
  - In a server, where others can hear or read the answer, it only uses notes you told it in that server, or the ones your own words ask about. In a DM or at your PC it uses them all. What it picked up by itself, and notes saved before this rule, count as private.
  - "Forget" says how many notes went, not which ones.
  - What people say out loud in the call is shared context: it can refer to it.

## Party games

"Let's play trivia" (everyone in the channel can answer), "roll 2d20", "flip a coin". The game state is per voice channel.

## Game servers and media

With `gameServers` set, you can ask "Is the server up?", "who's on the survival server?" and "how many players are on?". On their own these are read-only status pings.

With Helix server control set up (see [configuration.md](configuration.md#minecraft-server-control-helix)), she also knows when a server is starting, stopped, stuck or crashed, and the owners (plus anyone in `helix.allow`) can say:
- "Start the survival server." She starts it right away. If that takes more than a few seconds she says "Starting Survival. I'll tell you when it's up." and tells you once it is, or why it failed: in the call, at your PC, in the chat you asked in, or by DM. She stops watching after `helix.startWaitSec` and says so. If the bot restarts meanwhile (or someone saves the settings), she picks the watch up once she's back and still tells you; if your PC isn't connected again yet, that comes in the chat you asked in or by DM.
- "Restart Survival." / "Stop Creative." These always ask first: "3 people are on Survival. Restart it anyway?" Only your own yes on your very next turn counts ("yes", "yeah, restart it"); anything else, or someone else's yes, and nothing happens. A stopped server is just started, without the question. While a server is starting she won't stop or restart it, unless it has been starting for 10 minutes or more (it may be stuck): then she asks the same way.
- "Whitelist Steve on Survival", "take Steve off the whitelist", "who's on the whitelist?". Java names are 3 to 16 letters, numbers or underscores; anything else is refused. For a Bedrock player on a server with `bedrock` on, say it's a Bedrock player, or use the in-game name with its dot (".Gamer_Tag"). She adds the gamertag through Floodgate and checks the whitelist afterwards.
- "Tell everyone on Survival dinner's ready." She posts it in the game chat as "Alex: dinner's ready": one line, without color codes or @ selectors, up to `helix.sayMaxChars` characters.

Good to know:
- With one server she uses it; with several and no name, she asks which. A half-heard name ("survivor") finds the closest one.
- One job per server. If someone asks while a restart runs, she says it's already restarting and tells them too when it's back, even when it was quick. A different order has to wait until it's done.
- If Helix is busy with a backup, an update or a restore on that server, she says so and does nothing; ask again when it's finished.
- If Helix doesn't answer a start, stop or restart, she never sends it again. She looks for the job, and if she can't find it she says she can't tell and asks you to check the panel.
- Every order is logged as `game server action`: what, which server, who asked and how it went. A chat message is logged only by its length.

With Plex, Sonarr and Radarr keys set:
- "What's new on Plex?"
- "Is Dune on Plex?"
- "What's downloading?"
- "When's the next episode of …?"

All read-only.

"What did I miss?", "anything new?" or "catch me up" gives one line about what's new since you were last in the call (or the last day): new episodes, movies that finished downloading, game servers that are down. "What's new in the last three days?" works too.

## Steam

From Discord (voice or text) and from a PC:
- "Which of my Steam friends are online?" / "What are my Steam friends playing?" These and wishlists need your account in `steam.accounts`; while no account is linked at all, she only does store prices.
- "Are any of my Steam friends playing Elden Ring?" "Is anyone playing Valorant?" on its own means people in the Discord server (game nights), not your Steam friends. Steam only sees games launched through Steam, so Valorant, League or Fortnite won't show unless a friend added them to Steam.
- "Is anything on my wishlist on sale?" Biggest discounts first: five by voice ("and 7 more"), up to twelve in text with the end dates.
- "Is Elden Ring on sale?" / "How much is Hades II on Steam?" Free-to-play, not out yet, taken off the store, not sold in your region, DLC, and other editions on sale are all said as such. A store link or app number works in text.

Prices need no setup. Wishlists and friends use your own Steam account only, once the admin links it (configuration.md, Steam); friends also need the Steam key. If something's private, she says which Steam privacy setting to change. With `steam.shareWithServer` on, you can also ask about another member who has linked theirs.

## Heads-ups when you join

With `headsUp.enabled` on (it's off by default), owners who join her call after at least 4 hours away hear one short line about what's new since they were last there:

> Alex, since yesterday: 14 new episodes, mostly Frieren and One Piece, and Dune finished downloading.

- One line at most, never one per item: 300 new episodes is still one line. Never more than about 25 words.
- At most once every 6 hours per person, and only about what's new since you were last there or last heard one.
- Nothing at all when nothing is new, or the media apps don't answer in time.
- Only in a quiet moment: if people are talking, music is playing, or she's answering someone, she waits up to a minute and a half, then drops it.
- Not for people already in the call when she joins, and not if you're deafened.
- A game server is mentioned only if it went down since you last heard about it.
- She doesn't listen on after a heads-up, so what you say next to the others stays yours. "Adrian, stop telling me that" turns them off for you, for good; "turn my heads-ups back on" undoes it.
- Not while a music quiz runs either.

## Weekly recap

Set `recap.channelId` and she posts a recap there every Sunday at 18:00 (household time; `recap.day`, `recap.hour`):

- the songs played most in the call that week,
- new episodes and movies (counts and the top three titles),
- game server uptime and peak players (from a check every 10 minutes while the bot runs),
- how many questions she answered: in the call, at PCs and in text chat.

Counts only: no transcripts, no quotes, and nobody is named unless they asked ("put my name in the recap"; "leave my name out" undoes it). It never pings anyone. If the bot was down at that hour, the recap goes out once when it's back, within a day; a week missed by more than that is skipped. It's never posted twice for one week. An owner can say "post the recap now" for this week so far. Nothing is posted for a week with nothing in it.

## Languages

With `languages` on (the default), it answers in English, Spanish, Chinese, Japanese or Vietnamese: whatever you spoke. The always-on speech recognizer handles English and Spanish directly. For other languages, a second pass with Whisper (about 1 second) identifies the language and transcribes it.

Tip for Chinese, Japanese and Vietnamese speakers: the first recognizer doesn't catch the wake word in those languages. Say **"Hey Adrian"** first, wait for "Yes?", then ask.

Japanese answers are written in kana (the Japanese voice can't read kanji). Vietnamese uses its own voice.

## Owners

Owners are the Discord application's owner plus anyone listed in `owners`. Owners:
- can stop any answer;
- go to the front of the line;
- have no per-person hourly limit (the daily and monthly spend caps still apply, and [passing messages on](#the-server-and-its-people) has its own limit: 30 an hour).

Optional flavor:
- `ownerAck`: what an owner hears instead of "Yes?", for example `["Yes boss", "Yes, chief"]`. Answers to owners also start with it.
- `ownerStopReply`: what it says after an owner stops it, for example `"Yes boss."`.
- `ownerAffection`: extra warm and playful with owners. It uses the names from `ownerAck`.

## Who it is

Set `botGender` to `female` or `male` and it talks about itself that way ("I'm a girl"); `none` (the default) leaves it unsaid. Pick a voice to match with `adrian voice`.

## Nicknames

Set `nicknames` to give people a name it calls them by, for example `{"123456789012345678": "Big Mike"}`. It addresses them by it, mentions it in who is in the call, and answers their "Adrian?" with "Yes, Big Mike?". A nickname gives no extra rights.

## Identity

Set `identity.creator` to your name, and it answers "who made you?" with it. In the call, it treats your Discord account (the owners, or `identity.creatorIds`) as you. Anyone else who claims to be you is told they aren't. If your name is spelled unusually, add `creatorSpoken` for pronunciation, and `creatorHeardAs` for the ways speech recognition misspells it.

## Mature mode

`mature` controls swearing, crude humor and frank adult topics:
- `off`
- `age-restricted` (the default): only in Discord channels marked age-restricted.
- `always`

Hard limits stay in every mode: no sexual roleplay or explicit sexual content, no slurs, nothing involving minors, nothing that helps real harm.

## Text chat

@mention it in a channel ("@A.D.R.I.A.N. what's the weather in Denver?"), reply to one of its messages, or DM it. It answers in text, using the same model, tools and memory as in voice. "@A.D.R.I.A.N. play Humble" starts the song in the call it's in, if you're in that call too or an owner. It shows that it's typing, splits long answers, and never pings @everyone, roles or people. Spend caps and the hourly limit apply. Turn it off with `textChat.enabled false` (servers) or `textChat.dms false` (DMs).

With **Message Content** switched on for the bot in the Developer Portal (restart the service after changing it), text chat gets two more things:

- **Channel context.** Each answer comes with the channel's last 30 messages (`textChat.historyMessages`), so "@A.D.R.I.A.N. what are they planning?" works. They're fetched when it answers and not stored.
- **Carrying on.** For 3 minutes after it answers you (`textChat.followUpMinutes`), you can keep talking without @mentioning it. Writing its name ("adrian what do you think") works for anyone, anytime. These messages are judged by the model, so it stays out of side talk and reactions. A message that @mentions or replies to someone else is never treated as one for it. Two ignored messages in a row end the conversation; side talk it stays out of doesn't count toward the hourly limit, but each one is a small model call.

The log line `message content` at startup says whether it's on. Turn the extras off with `textChat.readChannels false`.

## The server and its people

It can look things up about the server it's in, by voice or text: "who's online?", "what's Sam playing?", "who's in voice?", "when did Kim join?", "what channels are there?", "how many people are in here?". It only tells you about channels you can see yourself. Online status and activities need the **Presence** intent, and the full member list needs **Server Members** (Developer Portal → Bot). Without them it still finds people by name. The `privileged intents` line at startup shows what's on.

**Tagging people.** In text chat, "@A.D.R.I.A.N. tag Sam and tell him we're on" makes it @mention Sam. It pings only when asked, at most 5 people per reply (`textChat.maxPings`), and never @everyone, @here or roles.

**Passing messages on.** "Tell Sam dinner's ready" or "let Kim know we're starting, in #general":

- By default it DMs them: "**Alex** (in Game Night) asked me to tell you: dinner's ready."
- Ask for a channel, or it's a text chat, and it posts there with an @mention of that person only.
- It always says who the message is from. Each person can send 10 an hour and each person can get 5 an hour (`messaging.perUserPerHour`, `messaging.perTargetPerHour`); owners can send 30, and at most 3 go out per request.
- It goes straight out when you name who it's for ("tell Sam", "message Sam", "let Sam know") and that's the whole of one of their names: "tell Sam" for Samantha is read back first. Otherwise it reads the message back and waits for your yes.
- It won't post in a channel you can't post in yourself.
- Turn it off with `messaging.enabled false`, and the lookups with `serverInfo.enabled false`.

## Your PC and Discord

With the PC app connected: "send that link to my PC" (the newest link or video you posted, she sent you, or someone posted where you can see it), "move the music to my PC", "put what I'm watching into the call", and from the PC, "tell the call I'll be on in 5". Details and limits are in [satellite.md](satellite.md#pc-and-discord-together).

## Game nights

- **"Who's playing right now?"**, **"who's free for Valorant?"**: who's in voice (muted, deafened, the AFK channel), and with the **Presence** intent on, who's online, idle or on do not disturb, what they're playing, and whether they look like they're in a match or in the menus. That last part is a guess from the game's status text, and she says so. Without the Presence intent she answers from voice alone and says once that she can't see games.
- **"Ping me for game night"** (or "ping me for Valorant") signs you up; **"stop pinging me"** (or "for Minecraft") takes you off. Only for yourself. People in `gameNight.optIn` start signed up for everything, and their "stop" sticks.
- **"Get the squad on"**, **"ping everyone for Valorant in 10"**: one message in a text channel, "**Alex** is getting Valorant going in 10 minutes. Who's in?", that @mentions only people signed up for that game. Never @everyone, @here or roles; at most 10 people; not the person asking, bots, people already in voice, people on do not disturb, or anyone who can't see the channel. One ping per game every 15 minutes, nobody is pinged twice in 15 minutes whatever the game is called, and 4 pings per person an hour. When your words didn't ask for a ping (or said not to), she asks first.
- From a PC or a DM it means the bot's home server.
- Turn it off with `gameNight.enabled false`.

## Disconnects

- **Network drop or Discord hiccup:** it reconnects by itself.
- **Someone disconnects it, or the channel is deleted:** it stays out (no fighting back in) and stops any music. Use `/join` to bring it back.
- **Someone drags it to another channel:** it follows and keeps working there.
- **After a restart or update:** it goes back to its home channel.

## Slash commands

| Command | What it does |
|---|---|
| `/join` | Joins the voice channel you're in. It won't leave a call that still has people in it unless an owner asks. When it isn't in its home channel, it leaves after 10 minutes alone. |
| `/leave` | Leaves voice. Use `/join` to bring it back. From outside a call that has people in it, only the app's owner can. |

After a restart or update, it goes back to its home channel. To limit which servers `/join` works in, set `allowedGuilds` by editing the config file (see [configuration.md](configuration.md)).
