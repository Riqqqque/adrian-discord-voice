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
- **"Stop", "shut up", "be quiet", "never mind", "stfu":** from anyone, these stop the current answer immediately.
- **Everyday words:** "done", "quiet", "enough" and "that's it" only stop it when the person being answered says them, or when they come with the name ("Adrian, quiet").
- **Owners** can stop anyone's answer and go to the front of the line.
- **Priority roles** (`priorityRoleIds`) can interrupt anyone's answer.

## Things handled instantly (no model call, free)

- Stop phrases, "thanks", "bye", "okay" / "cool" (nothing to answer).
- "Repeat that" / "what did you say".
- "Louder" / "quieter", "faster" / "slower" (voice; with music playing, "turn it up" / "turn it down" changes the music).
- "What time is it".
- Plain music commands: "play X", "skip", "pause", "keep playing", "stop the music", "what's playing".

Everything else goes to the language model.

## Music

| You say | It does |
|---|---|
| "Play Blinding Lights" | Searches YouTube Music's song catalog and plays the real track. |
| "Play Travis Scott" | Their top song, then similar songs. |
| "Play the whole Graduation album" | The album in order. |
| "Put on something chill for a late night drive" | Finds a matching public playlist and shuffles it. |
| "Play a playlist like that last song" / "more like this" | YouTube Music radio based on what was playing. |
| "Play the newest Joe Rogan episode" | The newest playable episode of that podcast. |
| "Play 10 hours of rain sounds" | Any YouTube video's audio, any length. |
| "Play Sicko Mode next" / "add Humble to the queue" | Adds to the queue (up to 25). |
| "Play Thriller from Plex" | Uses your Plex music library. |
| "Skip", "pause", "keep playing", "stop the music" | Controls. |
| "Shuffle", "clear the queue", "what's playing?", "what's next?" | Queue control and status. |
| "Turn off autoplay" | Stop adding similar songs when the queue ends. |

- **Volume:** music sits under the voice and drops further whenever someone says the name or the bot talks.
- **Autoplay:** when the queue runs low, it adds songs similar to the last one and skips anything played recently.
- **"Stop":** when the bot is talking, it stops the talking and the music keeps playing. When the bot isn't talking, a stop aimed at it stops the music.
- **`/leave` or moving channels:** stops the music.
- **Lyrics:** it won't sing or read out song lyrics. It just names what's playing.

## Timers, reminders, memory

- **Timers and reminders:**
  - "Set a timer for 10 minutes", "remind me at 6 to take the pizza out", "what timers do I have", "cancel my timer". Up to 20 per person, and they survive restarts.
  - When one goes off, it's announced in the call. If you've left, you get a DM.
- **Notes:**
  - "Remember that I'm allergic to peanuts", "forget my birthday". Up to 30 notes per person.
  - It also notes useful facts on its own every few answers (`autoMemory`).
  - Your notes are only ever used when **you** talk to it. It never tells anyone else what's in them.
  - What people say out loud in the call is shared context: it can refer to it.

## Party games

"Let's play trivia" (everyone in the channel can answer), "roll 2d20", "flip a coin". The game state is per voice channel.

## Game servers and media

With `gameServers` set, you can ask "Is the server up?", "who's on the survival server?" and "how many players are on?". These are read-only status pings and never change anything.

With Plex, Sonarr and Radarr keys set:
- "What's new on Plex?"
- "Is Dune on Plex?"
- "What's downloading?"
- "When's the next episode of …?"

All read-only.

## Languages

With `languages` on (the default), it answers in English, Spanish, Chinese, Japanese or Vietnamese: whatever you spoke. The always-on speech recognizer handles English and Spanish directly. For other languages, a second pass with Whisper (about 1 second) identifies the language and transcribes it.

Tip for Chinese, Japanese and Vietnamese speakers: the first recognizer doesn't catch the wake word in those languages. Say **"Hey Adrian"** first, wait for "Yes?", then ask.

Japanese answers are written in kana (the Japanese voice can't read kanji). Vietnamese uses its own voice.

## Owners

Owners are the Discord application's owner plus anyone listed in `owners`. Owners:
- can stop any answer;
- go to the front of the line;
- have no per-person hourly limit (the daily and monthly spend caps still apply).

Optional flavor:
- `ownerAck`: what an owner hears instead of "Yes?", for example `["Yes boss", "Yes, chief"]`. Answers to owners also start with it.
- `ownerStopReply`: what it says after an owner stops it, for example `"Yes boss."`.
- `ownerAffection`: extra warm and playful with owners. It uses the names from `ownerAck`.

## Identity

Set `identity.creator` to your name, and it answers "who made you?" with it. In the call, it treats your Discord account (the owners, or `identity.creatorIds`) as you. Anyone else who claims to be you is told they aren't. If your name is spelled unusually, add `creatorSpoken` for pronunciation, and `creatorHeardAs` for the ways speech recognition misspells it.

## Mature mode

`mature` controls swearing, crude humor and frank adult topics:
- `off`
- `age-restricted` (the default): only in Discord channels marked age-restricted.
- `always`

Hard limits stay in every mode: no sexual roleplay or explicit sexual content, no slurs, nothing involving minors, nothing that helps real harm.

## Slash commands

| Command | What it does |
|---|---|
| `/join` | Joins the voice channel you're in. It won't leave a call that still has people in it unless an owner asks. When it isn't in its home channel, it leaves after 10 minutes alone. |
| `/leave` | Leaves voice. Use `/join` to bring it back. |

After a restart or update, it goes back to its home channel. To limit which servers `/join` works in, set `allowedGuilds`.
