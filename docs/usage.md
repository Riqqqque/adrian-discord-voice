# Using A.D.R.I.A.N.

This is the user guide: everything A.D.R.I.A.N. can do, with example phrases and commands, and who may do what. It covers the Discord voice call, text chat, DMs and the PC app.

- Each feature's settings: [configuration.md](configuration.md).
- The model tools behind each feature, with their exact arguments and guard rails: [tools.md](tools.md).
- What each feature costs: [costs.md](costs.md).
- Setting up the PC app: [pc-app.md](pc-app.md).

The spoken name is "Adrian". Facts here are for version 0.17.1.

## Waking it

| You say | It does |
|---|---|
| "Hey Adrian, …" | Answers the question. Greetings like "hi", "yo", "okay", "hello", "hola", "oye" and "chào" work too, and from the next release "hey there", "good morning", "good evening", "morning" and "excuse me". |
| "Adrian, …" | Treated as a question to it. |
| "… hey Adrian, …" in the middle of a sentence | Also a question to it. |
| "Adrian?" (the name alone) | "Yes?", then your next words within 20 seconds are the question. |
| "What time is it, Adrian?", "Wait, Adrian, what's the score?" | A question with the name at the end, or after a lead-in: the model decides whether it was meant for it, and sees the whole sentence, name included. Anything else said this way ("nice shot, Adrian", "what a save, Adrian", "stop it, Adrian", "can you stop, Adrian?") is left to whoever is called Adrian. |
| "Good morning, Adrian", "Hey there, Adrian", "Excuse me, Adrian" | Everyday greetings, said to friends as often as to it: alone they don't wake it (from the next release). Followed by something only it does ("Morning Adrian, play some jazz", "Excuse me Adrian, what's the time?") they do; anything else after them, questions included, is left for the model to judge. |
| "Adrian is so slow", "Hey, Adrian is in the other channel" | Talk *about* it: the model decides whether to answer, and usually stays quiet. "Have you seen Adrian?" doesn't wake it at all. |
| "Adrian's late", "Adrian'll know" | Never a wake: a contraction after the name means you're talking about it. |

- **Follow-ups.** After it answers, you can carry on without the name for about 8 seconds in the Discord call, or 20 seconds at a PC ("and what about tomorrow?"). If the follow-up clearly isn't for it (game callouts, talking to someone else), it stays silent.
- **No follow-up after an order.** When it has *done* something ("play Drake", "set a timer"), it stops listening right away, so talking to someone else afterwards isn't taken as more for it. After a normal answer, or a question from it, you can carry on.
- **Keep talking.** If you pause mid-request and carry on before it starts answering (within 12 seconds), the two parts are joined into one request.
- **Misspellings.** Speech recognition spells unusual names oddly, so it accepts misspellings like "Adrien" and "Adrean".
- **A friend called Adrian** (next release). The wake check reads words, not who is being spoken to, so in a call with someone of that name:
  - Questions to them that end in the name ("are you coming, Adrian?", "did you hit Adrian?") wake it loosely. The model is asked whether it was meant for it, with the whole sentence, and usually stays quiet, but each one costs a model call and ducks the music for a few seconds.
  - Exclamations ("what a shot, Adrian!", "how lucky, Adrian") and game talk about them ("can you heal Adrian?", "revive Adrian") don't wake it.
  - A stop phrased as a question ("can you stop, Adrian?") is left to them: nothing stops without the model. "Adrian, stop" and "Adrian, be quiet" still stop it.
  - A greeting with the name alone ("good morning, Adrian", "morning Adrian") doesn't wake it, so it doesn't answer "Yes?" and doesn't take the friend's next sentence as a question. A greeting followed by a question ("Morning Adrian, how was your weekend?", "Excuse me, Adrian, is this your seat?") goes to the model. With "Hey Adrian, good morning" the model still decides whether to give the briefing.
  - "Adrian, did you eat?" and other questions about what someone did go to the model; "Adrian, will you…", "would you…" and "is it…" are still questions to it.
  - "Adrian, pass me the controller" has always been taken as an order to it.
  - These rules are English only: "¿Qué hora es, Adrián?" doesn't wake it.

## Busy calls

- **One answer at a time.** Up to 2 more requests wait in line. A request that waits more than 10 seconds is dropped with "Sorry, I missed that."
- **Interrupting by talking:**
  - In the Discord call, the person being answered can cut it off by talking for about 2.5 seconds; at a PC, 0.6 seconds is enough.
  - It only counts once its voice is actually playing, and not while it's carrying out an order.
  - Laughs and short reactions don't cut it off.
- **"Stop", "shut up", "be quiet", "never mind", "cancel", "stfu":** from anyone, these stop the current answer immediately.
  - "Shut up", "be quiet" and "stfu" also count at the start of a short remark (up to 8 words, not a question), like "bro, shut up" or "can you be quiet".
  - Anywhere else in a sentence they don't count, so "I told her to shut up" changes nothing.
  - Spanish, Vietnamese, Chinese and Japanese stop words work too ("cállate", "basta", "dừng lại", "停", "やめて").
- **"Wait", "hold on", "hang on", "one sec":** from the person being answered (or with the name), these stop it talking but keep listening, so you can go on. With nothing to stop, they leave the music alone.
- **"Stop listening":** ends the listening window and leaves the music playing.
- **Everyday words:** "done", "quiet", "enough", "that's it" and the Spanish "para" and "ya" only stop it when the person being answered says them, or when they come with the name ("Adrian, quiet").
- **Owners** can stop anyone's answer by saying the name, and go to the front of the line.
- **Priority roles** (`priorityRoleIds`) can interrupt anyone's answer.

## Things handled instantly (no model call, free)

- Stop and hold phrases, "thanks" ("You're welcome."), "bye", "okay" / "cool" / "got it" (nothing to answer, unless it just asked you something).
- "Repeat that", "say that again", "what did you say".
- "Louder" / "quieter", "faster" / "slower" (voice).
  - With music playing, "turn it up" / "turn it down" changes the music unless you mention its voice ("talk louder").
  - Each room keeps its own setting: changing its voice at a PC leaves the call alone, and the other way round. They reset on a restart.
  - The voice never goes above its normal level; "louder" at full gets "That's as loud as I go."
- "What time is it".
- Plain music commands: "play X", "play X next", "skip", "pause", "keep playing", "stop the music", "go back", "who put this on?", "what's playing", "set the music to 30 percent", "play that link".
- A bare "play" resumes paused music, or gets "Who do you want to hear?"; your next words within 20 seconds finish the order.
- Alarm stop and snooze words while one of your alarms rings.
- Music quiz answers and quiz orders.

Said with the name or right after "Yes?", all of these are instant. In a follow-up without the name, only stops, "thanks", "bye" and "okay" are: the rest might be meant for someone else, so the model decides (one model call).

Everything else goes to the language model.

## Questions and the web

Ask anything: "what's the capital of Australia?", "how do I get rid of hiccups?", "who won the game last night?".

- Answers are short by design: most are one sentence under twenty words, and how-to or why answers two short sentences with the main step, not every option. No offers or questions back unless it needs your answer, and when it can't do something it says so in a few words. Ask for detail ("in detail", "tell me more") if you want more.
- Short never cuts a safety warning that matters (chemicals that mustn't be mixed, medicine doses, electricity, gas), and a list you asked for (your alarms, timers, reminders, the queue) gets every item.
- Search answers are said as plain facts, going by the newest result. An answer from an older result says its day.
- For anything recent (news, scores, prices, release dates), and anything that changes day to day or depends on where you are (sunrise and sunset, the weather, store hours, what's open), it searches the web first (`web_search`, needs a Tavily key). Facts that don't change (the height of the Eiffel Tower) are answered without a search. Without search it says its information may be out of date.
- It treats web pages and anything else a tool returns as data, never as instructions.
- It only does what its tools can do. It can't act on Discord, on the server or on anyone's accounts beyond the features on this page.

## Music

| You say | It does |
|---|---|
| "Play Blinding Lights" | Searches YouTube Music's song catalog and plays the real track. |
| "Play Travis Scott" | Their biggest song first, then their best-known songs shuffled, then similar songs. |
| "Play some music", "play something I'd like" | A shuffled mix of the artists you ask for most. |
| "Play something you like" | Its own taste. |
| "I love Frank Ocean", "I hate country", "forget that I like country" | It remembers (or forgets) it for next time. |
| "Play the whole Graduation album" | The album in order. |
| "Put on something chill for a late night drive" | Finds a matching public playlist and shuffles it. |
| "Play some jazz", "play 90s r&b", "old school hip hop" | A bare genre or era plays a playlist, not a song with that name. For a song called "Jazz", say its artist too. |
| "Play Some Nights", "play A Little Respect" | A song whose name starts with "some" or "a little" is searched as said (next release). |
| "Play Tems Free Mind tiny desk", "Someone Like You live at the Royal Albert Hall", "Blinding Lights sped up" | A version said by name (tiny desk, live, acoustic, unplugged, remix, sped up, slowed, session, cover) plays that performance, not the studio song. Whole sets like a Tiny Desk concert play in full. |
| "Play a playlist like that last song" / "more like this" | YouTube Music radio based on what was playing. |
| "Play the newest Joe Rogan episode" | The newest playable episode of that podcast. |
| "Play 10 hours of rain sounds" | Any YouTube video's audio, any length. |
| "Play that link" / "play the song I just sent" | Your latest pasted YouTube, YouTube Music, SoundCloud, Bandcamp or Spotify link from the last half hour, else the server's latest. Spotify links are found on YouTube. |
| "Play Sicko Mode next" / "add Humble to the queue" | Adds to the queue (up to 25). |
| "Play Thriller from Plex" | Uses your Plex music library. |
| "Skip", "pause", "keep playing", "stop the music", "clear the queue" | Controls. Said just like that, "clear the queue" also stops the current song. |
| "Go back", "previous song" | Plays the song before this one again; this one comes next. |
| "Set the music to 30 percent" | Sets the music's level (5 to 100). "Turn it up" / "turn it down" still nudge it. |
| "Shuffle", "what's playing?", "what's next?" | Queue control and status. |
| "Who put this on?" | Who asked for the song playing, or that autoplay picked it. |
| "Turn off autoplay" | Stop adding similar songs when the queue ends. |

- **Who can change it:**
  - People in the voice call (muted counts), the owner of the PC it's playing on, and owners.
  - Anyone can ask what's playing, but nobody else can play, skip or stop anything, from text chat or DMs either. Sounds work the same way.
  - Only owners can change its own taste ("you like jazz now"); everyone else gets "That's up to me."
- **Volume:**
  - Music sits under the voice and drops further whenever someone says the name or the bot talks. Noise and talking to other people leave it alone.
  - "Set the volume to 30" sets the music's level and it says it back. With nothing playing, it says the level is for the next song.
- **Taste:** it learns what you like from the artists and songs you ask for, and favors recent ones. It also builds up a taste of its own. Yours is only used in your own conversations.
- **Autoplay:** when the queue runs low, it adds songs similar to the last one and skips anything played recently, including the same song in another upload (the video, the lyrics version). Nightcore, sped-up and 8D remakes are left out unless that's what was playing.
- **Songs YouTube won't play** (age-restricted, removed): it tries another upload of the same song, and says so if none plays.
- **YouTube blocks it** ("sign in to confirm you're not a bot"): YouTube is paused for 30 minutes. Requests go to Plex if it's set up; otherwise it says "I can't reach YouTube right now."
- **Nobody left in the call:** after 2 minutes the music stops, autoplay with it.
- **"Stop":**
  - When it is talking, "stop" stops the talking and the music keeps playing.
  - When it isn't talking, a stop aimed at it stops the music. That means said with the name, or by someone it's talking with.
- **`/leave`, or `/join` to another channel:** stops the music. Being dragged to another channel keeps it playing.
- **Lyrics:** it won't sing or read out song lyrics. It just names what's playing.
- **At a PC** the PC has its own player, queue and volume. Bare "pause", "skip", "what's playing" and "turn it down" there mean the PC's own media (Spotify, a browser tab), unless its own music is what's playing.

### Music commands in text

The same music, typed instead of said: as slash commands (`/play`, `/music ...`) or with a `!` prefix (`!play`, `!skip`). They work in any text channel of the server it's in.

| Command | It does |
|---|---|
| `/play query:` | Plays it, like saying "play X": a song, or a well-known artist's top songs. Suggests songs played lately and artists you play while you type. Pasting a YouTube, YouTube Music, Spotify, SoundCloud or Bandcamp link plays that. |
| `/play type:` | Says what it is: auto, song, artist, album, playlist, vibe ("chill late night r&b"), similar (to what's playing, or to what you type), podcast, video (any YouTube audio), favorites (yours), or hers. |
| `/play queue:True` | Adds it to the queue instead. `source:` picks YouTube or Plex. |
| `/music now` | The now-playing card (only you see it), with Back, Pause/Resume, Skip, Stop and Queue buttons. |
| `/music queue [page]` | What's coming up, 10 per page, with who asked for each. |
| `/music skip [to]` | Skips this song, or jumps to a place in the queue. |
| `/music back`, `pause`, `resume`, `stop` | As said aloud. Stop also clears the queue. |
| `/music volume [level]` | Sets the music level (5-100), or shows it. |
| `/music shuffle`, `clear`, `remove position:` | Changes the queue. Clear leaves the current song playing. |
| `/music autoplay on:` | Similar songs after the queue runs out, or not. |
| `/music who` | Who asked for this song. |

- **Who can use them:** the same people as by voice. Changing the music takes being in its call (owners can from anywhere). Looking at it (`now`, `queue`, `volume` without a level, `who`) works for anyone in the server.
- **It comes to you:**
  - Playing something from a voice channel it isn't in brings it there first, by `/join`'s rules: it won't leave a call that has other people in it, unless an owner asks.
  - An owner who isn't in any call plays into its current call.
- **What everyone sees:** a started song posts the card with its buttons in the channel, and changes say who made them ("Sam skipped"). With slash commands, refusals and lists only show to you; `!` commands answer in the channel.
- **Limits:**
  - A play counts toward the hourly limit like a spoken request. A lookup may take up to 60 seconds; an album or podcast usually takes 5 to 8.
  - During a music quiz, skip and stop go to the quiz and the rest waits for it.
  - With music off, the commands answer "Music isn't set up on this bot."
- **Slash commands not showing?** Discord caches the command list: restart Discord or press Ctrl+R. Server admins can also limit an app's commands under Server Settings → Integrations.

**`!` commands** (aliases in brackets)

| Command | It does |
|---|---|
| `!play <song, artist or link>` (`!p`) | Plays it now. `!play` alone resumes. |
| `!playnext <song>` (`!pn`, `!add`), `!queue <song>` | Adds it to the queue. |
| `!song`, `!artist`, `!album`, `!playlist`, `!podcast`, `!video`, `!vibe` (`!mood`) `<words>` | Says what it is. |
| `!plex <song>` | Plays it from Plex. |
| `!similar [song]` (`!radio`, `!more`) | Songs like this one, or like the one you name. |
| `!favorites` (`!favourites`, `!favs`, `!mine`), `!hers` | What you like, what it likes. |
| `!skip [n]` (`!s`, `!next`, `!fs`), `!back` (`!prev`, `!previous`) | Skip (to a place in the queue), or the song before. |
| `!pause`, `!resume` (`!unpause`, `!continue`), `!stop` | As said aloud. |
| `!np` (`!now`, `!nowplaying`, `!playing`) | What's playing, with buttons. |
| `!queue [page]` (`!q`), `!who` | What's next (`!queue 2` is page 2), who asked. |
| `!volume [5-100]` (`!vol`, `!v`) | Shows or sets the music level. |
| `!shuffle`, `!clear`, `!remove <n>` (`!rm`), `!autoplay [on/off]` | The rest of the controls. |
| `!join` (`!summon`, `!come`), `!leave` (`!dc`, `!disconnect`) | Like `/join` and `/leave`. |
| `!help` (`!commands`, `!music`) | This list. Needs an @mention, since other bots answer these too. |

- **Message Content intent.** `!` commands need it: Developer Portal → your app → Bot → Privileged Gateway Intents, then `sudo adrian restart`. Without it Discord only shows the bot messages that @mention it, so type `@A.D.R.I.A.N. !play x`.
- **Changing the prefix.** `sudo adrian config music.prefix "?"` changes the `!`; an empty prefix turns the commands off.
- **Other bots' commands are left alone.** That covers words it doesn't know (`!roll`), and its own words with something extra after them (`!clear 50`). If another music bot in the server also uses `!play`, give one of them another prefix.

## Music quiz

"Start a music quiz", "let's play guess the song", "name that tune", "music quiz, 5 rounds of 90s hip hop", "guess the song with songs we've played", "a Drake music quiz".

- **Each round** plays about 20 seconds from the catchy part of a song: the part people replay most on YouTube, or about a third of the way in. Nothing gives it away: no title on screen or in the PC window, no message in chat, and it doesn't know the song itself if you ask.
- **Answering:**
  - Anyone in the call just says the title or the artist, no "Adrian" needed.
  - Close is fine: most of the title, "the weekend" for The Weeknd, "7 nation army".
  - An everyday word on its own isn't enough: "fire" isn't Earth, Wind & Fire, "sons" isn't Mumford & Sons (but "Mumford" is), "take" isn't Take on Me, and "yeah yeah" isn't "Yeah!".
  - A title or band that is one everyday word ("Hello", "Yeah!", "Stay", "Yes") needs a clear guess: "is it Hello", "it's Yeah", "Hello by Adele", or the name first. A bare "hello" in the call doesn't count.
  - The first right answer gets the point. In an artist quiz only the title counts.
  - Talking about other things in between is ignored, and it never answers that.
- **A wrong guess to it** ("Adrian, is it Purple Rain?") gets "Not quite." Anything else said to it ("Adrian, is it raining?", "Adrian, it's too loud") is handled as usual.
- **Hint** after about 12 seconds (never later than 60% of the clip): the artist's first letter, or the year. "Give us a hint" gets it early.
- **Reveal:** when someone gets it, or when the clip ends: title and artist.
- **Orders:**
  - Said on their own, without the name: "skip this round" (or "skip this song", "next song", "next round"), "what's the score?", "give us a hint" and "stop the quiz".
  - Need the name ("Adrian, skip"), so talk among yourselves never ends or skips the quiz: a bare "skip" or "next", and everyday phrases like "hint", "who's winning", "I'm done", "pass", "give up" or "who's this?".
  - A stop for it while it isn't talking ("Adrian, stop") ends the quiz too.
  - At the end it reads the scoreboard.
- **Music controls while it runs:** "skip" and "stop the music" go to the quiz, "turn it down" and "set the volume to 30" change the clip's level, and "go back", "pause" or "who put this on?" get "say stop the quiz first".
- **Kinds:** a genre (pop, rock, hip hop, R&B, country, metal, latin, k-pop...), a decade (50s to 2020s), both, an artist, or songs played here lately. With nothing named: today's popular songs. Default 8 rounds (up to 20).
- **Music requests wait:** while a quiz runs, "play X" gets "say stop the quiz first". Other commands work as usual. Starting a quiz stops what was playing, and it doesn't come back afterwards: ask for music again.
- **It ends by itself** when nobody tries for two rounds, or everyone leaves. A guess, a near miss, "is it...", a quiz order or anything said to it counts as trying; talk about other things doesn't.
- **A song that won't play** (its clip stops right away) is never revealed: another song takes the round. A clip that breaks partway through ends the round with the reveal, as if it ran out. After three in a row the quiz ends.
- **Songs played here** can come from Plex as well as YouTube.
- **At a PC** it works the same, just for you.
- **Cost:** answers are checked on the spot, for free. A near miss ("bohemian" for Bohemian Rhapsody) may cost one tiny model call, at most twice a round.

## Sounds

"Make an airhorn sound", "do a drum roll", "cat meow", "sad trombone", "what does a wolf sound like?": it finds a short sound effect on YouTube and plays it once, up to 15 seconds, on top of any music (the music ducks).

- "Stop" cuts it off.
- It never imitates the sound itself or talks around it: the clip is the whole answer.
- It needs the same setup as music (yt-dlp and ffmpeg), and the same rights: people in the room, the PC's owner, and owners.

## Party games

- **"Let's play trivia"**, "give us a riddle", "would you rather": a shared game for everyone in the channel, with a scoreboard. Anyone can answer; it says whether you're right and keeps score. "What's the score?" and "end the game" work. The game is per channel (the voice call, a text channel, or a PC), or per person when there is none, and ends after 30 minutes with nobody playing.
- **"Roll 2d20"**, "roll a d6 plus 2", "pick a number from 1 to 10": real random dice (1 to 20 dice, 2 to 1,000 sides).
- **"Flip a coin".**

Guessing songs is the music quiz, above.

## Alarms and timers

Alarms and timers ring with a sound until you stop them, the way an alarm clock does.

- **Setting them:**
  - "Wake me up at 7", "set an alarm for 6:30 on weekdays", "alarm at 9 tomorrow, label it dentist", "set a timer for 10 minutes", "pizza timer, twelve minutes".
  - It always says the day and AM or PM back ("Alarm set for 7 AM tomorrow, Thursday."), so a misheard time gets noticed.
  - Up to 30 per person, a year ahead at most. Timers go up to 7 days.
  - A time that doesn't exist on the night the clocks spring forward (2:30) rings an hour on, like a phone.
- **Where it rings:**
  - In its call if you're in it and not deafened.
  - Muted in the call, it rings in the call and also sends you the **Stop** and **Snooze** buttons in a DM, since a spoken stop can't be heard there. If your PC app says it plays through headphones (or you marked it so in its settings), it rings at the PC instead, where a spoken stop works.
  - Otherwise at your PC if the PC app is running; while you're in another voice call the bot can see, the DM gets the buttons too. Otherwise as a DM with **Stop** and **Snooze** buttons.
  - It follows you: if you join the call or open the PC app while it rings, it moves there.
  - Music goes down while it rings. When it talks over the alarm (the time, or an answer), the alarm turns down for it.
- **Turning it off:**
  - Say "stop", "turn it off", "dismiss" or "I'm up". "Snooze", "five more minutes" or "snooze for 10 minutes" snoozes it. You don't need its name.
  - Only you can stop your alarm by voice. An owner can stop anyone's, but only with the name ("Adrian, stop the alarm").
  - At a PC whose speakers play a voice call you're in, what the PC hears might be someone else: use push-to-talk, the window's or tray's buttons, or the DM's buttons. A spoken stop there gets a soft chime instead.
  - Only whole sentences count: "stop by the store later" or a song called *Stop* does nothing to it, and neither do music commands or "stop listening".
  - "Wait, I'm not up" or "turn it back on" within 3 minutes of a stop puts it back, snoozed.
  - Also from the Stop and Snooze buttons in the PC app's window and tray, the DM buttons, or `/alarm stop`. A DM's buttons work only for the alarm and ring they were sent for: an older message's Stop leaves a newer alarm ringing, and with two ringing at once, each message's buttons stop only their own. Buttons on messages from before 0.17.2 act only on what rings right now.
  - A DM button, `/alarm stop` or a typed stop also turns off an alarm that is waiting out a snooze, in every turn-off mode: in "firm" and "math" mode they count as you deciding on purpose. A spoken "stop" during a snooze does nothing; in firm mode it takes "I'm up". Stopping one that wasn't ringing isn't said out loud in the call or at your PC.
  - Deleting an alarm right after a stop is final: "wait, I'm not up" or a Snooze button doesn't bring it back.
- **Nobody answers:** an alarm rings for 10 minutes, snoozes itself, and rings again, 3 times in all. After that you get a DM saying you missed it. A timer rings for 5 minutes, then sends the DM.
- **Restarts and updates:**
  - Alarms are saved to disk. A restart while one rings picks the ring up again.
  - Updates wait while an alarm rings, is snoozed, or is due within 5 minutes.
  - One that came due while it was offline rings when it's back if still within its ring time; otherwise you get a DM.
- **Changing them:**
  - "Change my 6:30 alarm to 6:45", "skip tomorrow's alarm", "skip Friday's alarm", "turn off my gym alarm" (it stays saved until you turn it back on), "add 5 minutes to the pizza timer", "what alarms do I have", "delete my 7am alarm".
  - From the next release: "take the label off my 7am alarm" ("It has no label now.") and "use the default sound for my gym alarm". "Use the default timer sound" works in the settings too.
  - If more than one alarm fits what you said, it asks which.
  - Deleting a repeating alarm, or several at once, asks first; only your own yes, as your next words, does it.
- **Sounds:**
  - "What alarm sounds do you have?" lists them, and "let me hear the marimba one" plays a few seconds.
  - Built in, with nothing to download: classic, chime, bells, marimba, gentle, birds, pulse, digital and buzzer. They're all about the same loudness.
  - **voice:** soft chimes with it saying the time and what it's for.
  - **Music:** "wake me up to Drake at 9" plays music instead. If the music can't start, the classic tone rings.
  - **Your own:** "save an airhorn as an alarm sound" finds a short clip on YouTube and keeps it on the server, so it can't go missing when the alarm is due. Up to 10, 30 seconds each. "Delete my airhorn sound" removes one.
- **Settings, per person:**
  - "Use birds for my alarms", "make snooze 15 minutes", "ring for 5 minutes", "fade in over a minute" (alarms start soft and rise to full; timers start at full), "alarm volume 70", "don't say the time while it rings", "my time zone is New York", "what are my alarm settings?".
  - **How it turns off:** "stop" (the default), "firm" (only "I'm up" turns it off; stop just snoozes), or "math" (it asks a sum, and only the right answer turns it off).
  - **Defaults and ranges:** sound classic for alarms and chime for timers, snooze 9 minutes (1 to 60), ring 10 minutes (1 to 30; timers 5), fade-in 30 seconds (0 to 300), volume 100%, the time said while it rings, and "stop" turns it off.
  - `/alarm settings` shows and changes the same things.
- **The PC app** (0.17.0 and newer):
  - The window comes up with Stop and Snooze while an alarm rings, but not over a full-screen game. The tray menu has the same two items.
  - If the speakers are muted or under 30%, they're turned up while it rings and put back after.
  - It keeps a copy of your alarms due in the next 8 days, refreshed every hour. If the server can't be reached when one is due, the PC rings it itself (classic beeps) and tells the server how it was answered once it's back.
- **What can still miss it:** a PC that's asleep or off, the PC app not running, and not being in its call. Then it's only the DM on your phone.

## Reminders and memory

- **Reminders:**
  - "Remind me at 6 to take the pizza out", "remind me in an hour to call mom". They're said once, not rung.
  - Up to 20 per person, up to a month ahead, and they survive restarts. "What reminders do I have?" and "cancel the pizza reminder" go through the same list as alarms.
  - When one goes off, it's announced in the call if you're in it and can hear it. If not, one you set at your PC goes off there, with a DM as well. Otherwise you get a DM (or, muted in the call, it's still announced there).
  - While you're in a game at your PC (quiet while gaming), a reminder set there waits, with its DM, until the game ends.
  - If it was offline when one was due, the reminder comes late, saying so.
- **Notes:**
  - "Remember that I'm allergic to peanuts", "forget my birthday", "forget everything". Up to 30 notes per person. A plain "remember ..." just gets "Got it."
  - It also notes useful facts on its own every few answers in voice (`autoMemory`), and keeps them true: "I quit Valorant" rewrites "plays Valorant" instead of keeping both, and a plan that was called off goes. Notes you asked it to remember are only reworded, never dropped by themselves.
  - Your notes are only ever used when **you** talk to it. It never tells anyone else what's in them.
  - In a server, where others can hear or read the answer, it only uses notes you told it in that server, or the ones your own words ask about ("where do I live?" finds "lives in ..." and "living in ...", "what's my job?" finds "works at ..."). From the next release a word matches only as itself, its plural or "-s" form ("caring" no longer finds a note about a car), and everyday verbs like "work", "play" or "like" count only when you ask about yourself ("what game should we play tonight?" doesn't pull in a note about the games you play). In a DM or at your PC it uses them all. What it picked up by itself, and notes saved before this rule, count as private.
  - "Forget" says how many notes went, not which ones. "Forget everything" also clears what it remembers of your recent conversation.
  - What people say out loud in the call is shared context: it can refer to it.
- **Short-term memory:** it remembers your last 4 to 8 exchanges (up to 16 messages, cut back to the newest 8 when full) for an hour of quiet, shared between the call, your PC and server text chat. DMs have their own. A restart clears it.

## At your PC

With the PC app connected (setup: [pc-app.md](pc-app.md)), you can talk to it at your PC and it can work your PC. Orders from the Discord call, text chat or a DM ("open Spotify on my PC") also reach your PC, and only yours.

**Talking to it there**

- Say "Hey Adrian, …", hold **Ctrl+Alt+Space** and talk (no name needed), or type in the window. The window's stop button stops it. From PC app 0.17.2, push-to-talk takes what you say while the key is down, pauses included, and nothing after you let go.
- At a PC the follow-up window is 20 seconds, and talking over it for 0.6 seconds cuts it off. It starts working out what you said during the pause after you stop, so answers there come sooner when you say a request in one go.
- **In its Discord call too?** While you're in its voice channel and not muted, the call answers instead of the PC, and the PC window shows "Answering in the Discord call." Push-to-talk and typing stay with the PC.
- **In any voice call, on speakers** (next release): while you're in a voice channel the bot can see and not deafened, your speakers play the call and the PC's mic hears everyone in it, so the PC takes only push-to-talk and typing, muted or not. Its name said there gets a soft chime and a line in the window; "stop" still stops it and the music. On headphones it listens as usual: Windows says so for most headsets, and for a USB DAC or dock that reports speakers, tick "These speakers are headphones" in the app's settings.
- **Quiet while gaming:** while a game is in front, every turn needs the name, push-to-talk or typing. Answers are one short sentence, and reminders set at that PC wait until the game ends. Timers and alarms still ring. "Quiet while I play" in the PC app's settings turns it off for that PC. Server-wide it's `satellite.quietWhileGaming` (on by default; `false` turns it off for every PC).

**What it can do there**

Orders about the house ("lock the front door", "shut the garage", "turn the TV down", "kill the lights", "turn the heat up") are kept off your PC, even said at the PC. With home control set up they go there; otherwise she says she can't. Name the PC when you mean it ("turn off my monitors", "lock my PC, I'm heading out the front door"), and "pause the music, someone's at the door" still pauses the music. A TV show, Apple TV or "the TV app" isn't the TV.

From the next release:
- A PC order said next to a house errand goes through: "pause, gotta open the door", "skip and turn the lights on", "lock it and turn off the lights". With one turn for both, only the PC part gets an answer.
- "Cancel the shutdown" is never refused, whatever else is said with it.
- "Lock up" is about the house, not the PC.
- How the check works: a word check on your own words, backed by the model's instructions. It counts an order when its verb comes right before the house thing ("turn off the living room lights"). An unusual word in between ("turn off the ceiling fan", "lock the office door") isn't caught by the word check, so only the model's instructions keep that off the PC. In a bench of 48 house orders a run, the model tried a PC tool on none.

| Area | Say | Notes |
|---|---|---|
| Apps and games | "Open Spotify", "open Valorant", "close Discord", "switch to Chrome", "minimize Discord", "what's open?", "show the desktop", "what games do I have?" | Installed apps, Steam, Epic and Riot games, and the PC's own shortcuts. Close asks the program to close; it never kills it. Running games are never closed, switched to or minimized. |
| Windows | "Put Discord on the left", "snap Chrome to the top right", "move Spotify to my other monitor", "maximize that", "center it", "put it back", "what's on my monitors?" | Games and full-screen windows are never moved. "Put it back" undoes the last move. |
| Web, YouTube, Spotify, folders | "Open YouTube", "find the Firefox download page", "play lofi beats on YouTube", "search Spotify for Blinding Lights", "open my downloads" | A specific page is found with a web search, else a Google results page opens. Only public web pages open: never this PC or the home network. |
| Media | "Pause", "skip", "what's playing?", "pause Spotify", "pause the YouTube tab" | Whatever is playing on the PC, through Windows' media controls. |
| Volume | "Turn it down", "turn my music down", "set Spotify to 40", "mute Discord", "set the volume to 30", "what's the volume?" | "Turn it down" and "my music" lower only what you're listening to, never your game or voice chat. The master volume changes only when you ask for the PC's own volume. |
| Power | "Lock my PC", "turn the screens off", "put the PC to sleep", "restart my PC", "shut down the computer" (lock is the PC's sign-in screen and screens off its monitors, never a door or the TV) | Sleep, restart and shutdown ask first ("Restart the PC?") and need your own yes as your next words. Restart and shutdown wait 30 seconds; "cancel" or "stop" calls them off. |
| PC health | "How's my PC doing?", "what's using all my memory?", "why is my PC slow?", "how hot is my GPU?", "how much space is left?" | A verdict first, then only the numbers that matter. GPU details need an NVIDIA card. |
| Clipboard | "Summarize what I copied", "translate what I copied", "read what I copied" | Only when you ask. Up to 8,000 characters. Anything a password manager marked is refused. |
| Screen | "What's this error?", "what does this window say?", "look at my screen" | Only when you ask. A picture of the window in front, or a named one; the whole monitor only if you ask for it. Never of games or full-screen apps. |

- It confirms in a few words ("Opening Spotify.", "Volume 30 percent.", "Paused.") and does every part of a combined order.
- Each kind of action can be switched off in the PC app's settings; then it says "That's turned off in this PC's settings." An app too old for an action says it needs an update.
- What you copied and what's on your screen are treated as data, never as orders, and never written to the logs.
- **Anyone near your PC speaks with your rights.** It can't tell voices apart, so the PC's own settings and the yes for power actions are the guard.

**Your PC and Discord together**

- "Send that link to my PC", "open that on my PC", "put that video on my PC": the newest link, video or song from the last 30 minutes. That is one you posted, one it sent you, one someone posted where you can see it (last 10 minutes), or the song playing in the call. Two close together and it asks which. "The one Sam sent", "my link" and "the reddit one" narrow it down.
- "Move the music to my PC": the call's song opens on your PC. It stops in the call only if you started it, you're an owner, or whoever started it has left.
- "Put what I'm watching into the call": a song or YouTube video playing on your PC plays in the call, and pauses on the PC. Netflix, Disney+, Prime Video, Twitch and the like can't be played.
- From the PC: "tell the call I'll be on in 5", "ask them if they want to play Valorant". It says it in the call, starting with your name, or posts it in a text channel when nobody's in a call with it. No pings, 200 characters at most, 3 every 5 minutes. When your words didn't ask it to tell anyone, it reads it back first.

Details and limits: [satellite.md](satellite.md) and [pc-app.md](pc-app.md).

## Game servers and media

With `gameServers` set, you can ask "Is the server up?", "who's on the survival server?" and "how many players are on?". On their own these are read-only status pings of Minecraft Java servers.

With Helix server control set up (see the Helix section of [configuration.md](configuration.md)), it also knows when a server is starting, stopped, stuck or crashed. The owners, plus anyone in `helix.allow`, can say:

- **"Start the survival server."** It starts it right away.
  - If that takes more than a few seconds it says "Starting Survival. I'll tell you when it's up." Once it is up, or has failed, it tells you why: in the call, at your PC, in the chat you asked in, or by DM.
  - It stops watching after `helix.startWaitSec` and says so.
  - If the bot restarts meanwhile (or someone saves the settings), it picks the watch up once it's back and still tells you. If your PC isn't connected again yet, that comes in the chat you asked in or by DM.
- **"Restart Survival." / "Stop Creative."** These always ask first: "3 people are on Survival. Restart it anyway?"
  - Only your own yes on your very next turn counts ("yes", "yeah, restart it"). Anything else, or someone else's yes, and nothing happens.
  - A stopped server is just started, without the question.
  - While a server is starting it won't stop or restart it, unless it has been starting for 10 minutes or more (it may be stuck). Then it asks the same way.
- **"Whitelist Steve on Survival", "take Steve off the whitelist", "who's on the whitelist?".**
  - Java names are 3 to 16 letters, numbers or underscores; anything else is refused.
  - For a Bedrock player on a server with `bedrock` on, say it's a Bedrock player, or use the in-game name with its dot (".Gamer_Tag"). It adds the gamertag through Floodgate and checks the whitelist afterwards.
- **"Tell everyone on Survival dinner's ready."** It posts it in the game chat as "Alex: dinner's ready": one line, without color codes or @ selectors, up to `helix.sayMaxChars` characters.

Good to know:
- With one server it uses that one; with several and no name, it asks which. A half-heard name ("survivor") finds the closest one.
- One job per server. If someone asks while a restart runs, it says it's already restarting, and tells them too when it's back, even when it was quick. A different order has to wait until it's done.
- If Helix is busy with a backup, an update or a restore on that server, it says so and does nothing; ask again when it's finished.
- If Helix doesn't answer a start, stop or restart, it never sends it again. It looks for the job, and if it can't find it, it says it can't tell and asks you to check the panel.
- Every order is logged as `game server action`: what, which server, who asked and how it went. A chat message is logged only by its length.

With Plex, Sonarr and Radarr keys set (all read-only):
- "What's new on Plex?"
- "Is Dune on Plex?"
- "What's downloading?"
- "When's the next episode of …?"

"What did I miss?", "anything new?" or "catch me up" gives one line about what's new since you were last in the call (or the last day): new episodes, movies that finished downloading, game servers that are down. "What's new in the last three days?" works too.

## Steam

From Discord (voice or text) and from a PC:
- **"Which of my Steam friends are online?" / "What are my Steam friends playing?"**
  - These, and wishlists, need your account in `steam.accounts`. While no account is linked at all, it only does store prices.
- **"Are any of my Steam friends playing Elden Ring?"**
  - "Is anyone playing Valorant?" on its own means people in the Discord server (game nights), not your Steam friends.
  - Steam only sees games launched through Steam, so Valorant, League or Fortnite won't show unless a friend added them to Steam.
- **"Is anything on my wishlist on sale?"** Biggest discounts first: five by voice ("and 7 more"), up to twelve in text with the end dates.
- **"Is Elden Ring on sale?" / "How much is Hades II on Steam?"**
  - Free-to-play, not out yet, taken off the store, not sold in your region, DLC, and other editions on sale are all said as such.
  - A store link or app number works in text.

Prices need no setup. Wishlists and friends use your own Steam account only, once the admin links it (the Steam section of [configuration.md](configuration.md)); friends also need the Steam key. If something's private, it says which Steam privacy setting to change. With `steam.shareWithServer` on, you can also ask about another member who has linked theirs.

## Heads-ups when you join

With `headsUp.enabled` on (it's off by default), people in `headsUp.people` (empty means the owners) who join its call after at least 4 hours away hear one short line about what's new since they were last there:

> Alex, since yesterday: 14 new episodes, mostly Frieren and One Piece, and Dune finished downloading.

- One line at most, never one per item: 300 new episodes is still one line. Never more than about 25 words.
- At most once every 6 hours per person, and only about what's new since you were last there or last heard one.
- Nothing at all when nothing is new, or the media apps don't answer in time.
- Only in a quiet moment: if people are talking, music is playing, or it's answering someone, it waits up to a minute and a half, then drops it.
- Not for people already in the call when it joins, and not if you're deafened.
- A game server is mentioned only if it went down since you last heard about it.
- It doesn't listen on after a heads-up, so what you say next to the others stays yours. "Adrian, stop telling me that" turns them off for you, for good; "turn my heads-ups back on" undoes it.
- Not while a music quiz runs either.
- Only joining the Discord call counts; connecting a PC doesn't.

## Weather, calendar, news and the morning briefing

- **Weather:** "What's the weather?", "will it rain tomorrow?", "what's the week look like?". It uses the household's place (`weather.place`) only. For anywhere else it searches the web.
- **News:** "What's in the news?" reads the top headlines (titles only). For a particular story it searches the web.
- **Calendar:** "What's on my calendar today?", "am I free Friday?", "what's on this week?". Read-only: it can't add or change events. Only people in `calendar.people` (empty means the owners) may ask, and it answers wherever they ask, so ask in private if others shouldn't hear.
- **Briefing:** "Good morning" or "brief me": the weather, what's left on your calendar today, reminders due today and a couple of headlines. With other people around it only says how many events and reminders you have.
- **Automatic morning briefing:** with `briefing.enabled`, people who get heads-ups hear the briefing on their first join of the morning (5 AM to noon by default), even with heads-ups off. "Stop the morning briefing" turns it off for you.

## Home control

- With a Home Assistant MCP server set up (`mcp.servers`), the people in that server's `people` list (empty means the owners) can say "turn off the kitchen lights", "set the living room to 50 percent" or "is the garage door open?".
- Only the tools in the server's `allow` list exist for it.
- Calls that name a lock, door, garage, gate, alarm, valve, oven, stove or security ask "Okay to ...?" first, and only your own yes on your next turn does it. A yes for one door can't open another.
- The check reads the words of the call, not the device: a call that names only an area or a device by another name ("turn off the porch") isn't caught. See the known limits in [tools.md](tools.md#home-control-mcp).

## Weekly recap

Set `recap.channelId` and it posts a recap there every Sunday at 18:00 (household time; `recap.day`, `recap.hour`):

- the songs played most in the call that week,
- new episodes and movies (counts and the top three titles),
- game server uptime and peak players (from a check every 10 minutes while the bot runs),
- how many questions it answered: in the call, at PCs and in text chat.

Counts only: no transcripts, no quotes, and nobody is named unless they asked ("put my name in the recap"; "leave my name out" undoes it). It never pings anyone.

- If the bot was down at that hour, the recap goes out once when it's back, within a day; a week missed by more than that is skipped.
- It's never posted twice for one week, and nothing is posted for a week with nothing in it.
- An owner can say "post the recap now" for this week so far.

## Languages

With `languages` on (the default), it answers in English, Spanish, Chinese, Japanese or Vietnamese: whatever you spoke. The always-on speech recognizer handles English and Spanish directly. For other languages, a second pass with Whisper (about 1 second) identifies the language and transcribes it.

Tip for Chinese, Japanese and Vietnamese speakers: the first recognizer doesn't catch the wake word in those languages. Say **"Hey Adrian"** first, wait for "Yes?", then ask.

Japanese answers are written in kana (the Japanese voice can't read kanji). Vietnamese uses its own voice. Only English uses the cloud voice; the other languages use local voices.

## Text chat

@mention it in a channel ("@A.D.R.I.A.N. what's the capital of Australia?"), reply to one of its messages, or DM it.

- It answers in text, using the same model, tools and memory as in voice.
- "@A.D.R.I.A.N. play Humble" starts the song in the call it's in, if you're in that call too or you're an owner.
- It shows that it's typing and splits long answers.
- It never pings @everyone or roles, and pings people only when asked.
- Spend caps and the hourly limit apply.
- Turn it off with `textChat.enabled false` (servers) or `textChat.dms false` (DMs).

With **Message Content** switched on for the bot in the Developer Portal (restart the service after changing it), text chat gets two more things:

- **Channel context.** Each answer comes with the channel's last 30 messages (`textChat.historyMessages`), so "@A.D.R.I.A.N. what are they planning?" works. They're fetched when it answers and not stored.
- **Carrying on.** For 3 minutes after it answers you (`textChat.followUpMinutes`), you can keep talking without @mentioning it.
  - Writing its name ("adrian what do you think") works for anyone, anytime.
  - These messages are judged by the model, so it stays out of side talk and reactions.
  - A message that @mentions or replies to someone else is never treated as one for it.
  - Two ignored messages in a row end the conversation.
  - Each message it reads this way is one small model call, and counts toward the hourly limit, even when it stays out.

The `privileged intents` log line at startup shows it (`messageContent: true`). Turn the extras off with `textChat.readChannels false`.

## The server and its people

It can look things up about the server it's in, by voice or text: "who's online?", "what's Sam playing?", "who's in voice?", "when did Kim join?", "what channels are there?", "what roles are there?", "how many people are in here?".

- It only tells you about channels you can see yourself.
- Online status and activities need the **Presence** intent, and the full member list needs **Server Members** (Developer Portal → Bot). Without them it still finds people by name.
- The `privileged intents` line at startup shows what's on.

**Tagging people.** In text chat, "@A.D.R.I.A.N. tag Sam and tell him we're on" makes it @mention Sam. It pings only when asked, at most 5 people per reply (`textChat.maxPings`), and never @everyone, @here or roles.

**Passing messages on.** "Tell Sam dinner's ready" or "let Kim know we're starting, in #general":

- By default it DMs them: "**Alex** (in Game Night) asked me to tell you: dinner's ready."
- Ask for a channel ("in #general", "post it here") and it posts there with an @mention of that person only.
- It always says who the message is from. Each person can send 10 an hour and each person can get 5 an hour (`messaging.perUserPerHour`, `messaging.perTargetPerHour`); owners can send 30, and at most 3 go out per request.
- It goes straight out when you name who it's for ("tell Sam", "message Sam", "let Sam know") and that's the whole of one of their names. "Tell Sam" for Samantha is read back first. Otherwise it reads the message back and waits for your yes.
- It won't post in a channel you can't post in yourself, or to bots, or to yourself.
- Turn it off with `messaging.enabled false`, and the lookups with `serverInfo.enabled false`.

## Game nights

- **"Who's playing right now?"**, **"who's free for Valorant?"**:
  - Who's in voice (muted, deafened, the AFK channel).
  - With the **Presence** intent on, also who's online, idle or on do not disturb, what they're playing, and whether they look like they're in a match or in the menus. That last part is a guess from the game's status text, and it says so.
  - Without the Presence intent it answers from voice alone and says once that it can't see games.
- **"Ping me for game night"** (or "ping me for Valorant") signs you up; **"stop pinging me"** (or "for Minecraft") takes you off; "who gets game night pings?" lists them.
  - Only for yourself.
  - People in `gameNight.optIn` start signed up for everything, and their "stop" sticks.
- **"Get the squad on"**, **"ping everyone for Valorant in 10"**: one message in a text channel, "**Alex** is getting Valorant going in 10 minutes. Who's in?", that @mentions only people signed up for that game.
  - Never @everyone, @here or roles, and at most 10 people.
  - It leaves out the person asking, bots, people already in voice, people on do not disturb, and anyone who can't see the channel.
  - One ping per game every 15 minutes, nobody is pinged twice in 15 minutes whatever the game is called, and 4 pings per person an hour.
  - When your words didn't ask for a ping (or said not to), it asks first.
- From a PC or a DM it means the bot's home server.
- Turn it off with `gameNight.enabled false`.

## Who can do what

| What | Who |
|---|---|
| Talk to it, ask questions, text chat, DMs | Anyone in a server it's allowed in (`allowedGuilds`), within the hourly limit |
| Stop the current answer with a clear stop phrase | Anyone |
| Stop it with everyday words ("done", "quiet") or by talking over it | The person being answered; priority roles for anyone's answer |
| Stop anyone's answer by saying its name, go to the front of the line | Owners |
| Play, skip, stop music and sounds, run a music quiz | People in its call (muted counts), the PC's owner at that PC, owners anywhere |
| Look at what's playing, the queue, the quiz score | Anyone in the server |
| Change its own music taste | Owners |
| Alarms, timers, reminders, notes, music taste, heads-up and recap choices | Everyone, for their own only |
| Stop someone else's alarm | Owners, with its name, or the DM buttons |
| Use a PC's tools | That PC's owner, from anywhere. Anyone speaking at that PC counts as its owner |
| Calendar | `calendar.people`, else owners |
| Home control | That MCP server's `people`, else owners |
| Start, stop, restart, whitelist and message Minecraft servers | Owners, plus the users or roles in `helix.allow.<action>` |
| Minecraft server status, Plex, downloads, Steam prices, weather, news | Anyone |
| Steam friends and wishlist | People with a linked account; others' only with `steam.shareWithServer` |
| Heads-ups and the automatic morning briefing | `headsUp.people`, else owners |
| Post the weekly recap now | Owners |
| `/leave` or `/join` from outside a call that still has other people in it | Owners |

## Owners

Owners are the Discord application's owner plus anyone listed in `owners`. Besides the rights in the table above, owners have no per-person hourly limit. The daily and monthly spend caps still apply, and [passing messages on](#the-server-and-its-people) has its own limit: 30 an hour.

Optional flavor:
- `ownerAck`: what an owner hears instead of "Yes?", for example `["Yes boss", "Yes, chief"]`. Answers to owners also start with it.
- `ownerStopReply`: what it says after an owner stops it, for example `"Yes boss."`.
- `ownerAffection`: extra warm and playful with owners. It uses the names from `ownerAck`.

## Limits

When a limit is reached it says so. By voice it says it once, then stays quiet about that limit for 10 minutes; in text chat it replies with the same line.

| Limit | Setting | What it says |
|---|---|---|
| Requests per person per hour (owners exempt) | `limits.perUserPerHour` (30) | "You've asked a lot this hour. I'm pausing your questions for a bit." |
| Spend per guest per day (next release; owners, the creator's accounts and priority-role members aren't guests) | `limits.guestDailyUsd` ($0.20) | "You've used your share of today's budget, so I'm pausing your questions until tomorrow." |
| Spend per day | `limits.dailyUsd` ($1) | "I'm paused for the rest of today because the daily spending limit was reached." |
| Spend per month | `limits.monthlyUsd` ($10) | "I'm paused for the rest of the month because the monthly spending limit was reached." |
| Longest question passed to the model (voice and text) | `limits.maxRequestChars` (600 characters, 20 to 4000) | Nothing: the rest of the question is cut off. |

Plain music orders and typed music commands count toward the hourly limit too, though they cost nothing. Things answered instantly don't count. The cloud voice has its own monthly character budget; past it, it switches to the local voice until the next month. See [costs.md](costs.md).

To see how close you are, open the admin page's Status tab. From the next release its dashboard shows spending against both caps, the cloud voice's characters, Groq and Tavily use, how fast answers come, voice and PC drops, restarts and recent errors, with a "Needs attention" list at the top ([install.md](install.md#the-dashboard)).

## Who it is

Set `botGender` to `female` or `male` and it talks about itself that way ("I'm a girl"); `none` (the default) leaves it unsaid. Pick a voice to match with `adrian voice`.

## Nicknames

Set `nicknames` to give people a name it calls them by, for example `{"123456789012345678": "Captain"}`. It addresses them by it, mentions it in who is in the call, and answers their "Adrian?" with "Yes, Captain?". A nickname gives no extra rights.

## Identity

Set `identity.creator` to your name, and it answers "who made you?" with it. In the call, it treats your Discord account (the owners, or `identity.creatorIds`) as you. Anyone else who claims to be you is told they aren't. If your name is spelled unusually, add `identity.creatorSpoken` for pronunciation, and `identity.creatorHeardAs` for the ways speech recognition misspells it.

## Mature mode

`mature` controls swearing, crude humor and frank adult topics:
- `off`
- `age-restricted` (the default): only in Discord channels marked age-restricted.
- `always`

Hard limits stay in every mode: no sexual roleplay or explicit sexual content, no slurs, nothing involving minors, nothing that helps real harm.

## Disconnects

- **Network drop or Discord hiccup:** it reconnects by itself.
- **Someone disconnects it, or the channel is deleted:** it stays out (no fighting back in) and stops any music. Use `/join` to bring it back.
- **Someone drags it to another channel:** it follows and keeps working there.
- **After a restart or update:** it goes back to its home channel.
- **Alone away from home:** outside its home channel it leaves after 10 minutes with nobody else there.

## Slash commands

| Command | What it does |
|---|---|
| `/join` | Joins the voice channel you're in. It won't leave a call that still has people in it unless an owner asks. When it isn't in its home channel, it leaves after 10 minutes alone. |
| `/leave` | Leaves voice. Use `/join` to bring it back. From outside a call that has people in it, only owners can. |
| `/play`, `/music` | Music by text: see [Music commands in text](#music-commands-in-text). |
| `/alarm` | Alarms and timers by text, in servers and in DMs. See below. Replies are visible only to you. |

`/alarm` subcommands. They run the same code as spoken requests, without the model, so they work even with no language model set up:

| Subcommand | Does |
|---|---|
| `set time [repeat] [days] [date] [label] [sound]` | An alarm. `repeat` is once, daily, weekdays or weekends; `date` is YYYY-MM-DD. |
| `timer minutes [label] [sound]` | A timer, 0.1 to 10,080 minutes. |
| `list` | Your alarms, timers and reminders. |
| `stop`, `snooze [minutes]` | What's ringing for you. Typed stops always stop, whatever your dismiss mode, and also turn off one that is waiting out a snooze. |
| `delete which` | Deletes one (with autocomplete). |
| `off which [on]` | Turns one off, or back on. |
| `skip which` | Skips its next ring only. |
| `sounds` | The sounds you can pick. |
| `settings [sound] [timer_sound] [snooze] [ring] [fade_in] [volume] [turn_off_by] [voice] [timezone]` | Shows or changes your alarm settings. |

After a restart or update, it goes back to its home channel. To limit which servers `/join` works in, set `allowedGuilds` by editing the config file (see [configuration.md](configuration.md)).

## Features and their tools

Each feature that needs the model goes through one or more tools. Their arguments, limits and guard rails are in [tools.md](tools.md).

| Feature | Tools |
|---|---|
| Questions about now | `get_time`, `web_search` |
| Alarms and timers | `set_alarm`, `set_timer`, `edit_alarm`, `list_timers`, `cancel_timer`, `alarm_control`, `alarm_options` |
| Reminders | `set_reminder` (listed and cancelled with `list_timers`, `cancel_timer`) |
| Notes | `remember`, `forget` |
| Party games | `roll_dice`, `flip_coin`, `game` |
| Music, taste, quiz, sounds | `play_music`, `music_control`, `music_taste`, `music_quiz`, `play_sound` |
| Your PC | `pc_apps`, `pc_windows`, `pc_open`, `pc_media`, `pc_volume`, `pc_system`, `pc_info`, `pc_clipboard`, `pc_screen` |
| PC and Discord together | `pc_handoff`, `tell_call` |
| The server and its people | `server_info`, `message_member` |
| Game nights | `game_night` |
| Minecraft servers | `game_server_status`, `game_server_control`, `game_server_whitelist`, `game_server_say` |
| Plex, Sonarr, Radarr | `plex_recently_added`, `plex_search`, `downloads`, `upcoming_episodes` |
| Steam | `steam_friends`, `steam_wishlist_sales`, `steam_price` |
| "What did I miss", heads-ups, recap | `whats_new`, `digest_prefs`, `post_recap` |
| Weather, news, calendar, briefing | `weather`, `headlines`, `calendar`, `briefing` |
| Home control | `<server>_<Tool>` from each MCP server |
