// The follow-up judge: words said WITHOUT her name in the follow-up window,
// at a PC and in a group call. Real follow-ups to her must be answered (or
// done, with the right tool); side talk to people in the room, on the phone,
// in a game or call, show audio, singing along and remarks about her must stay
// SILENT with no tool called. Real model, real tool specs and prompt lines, the
// stack's real room-talk lines and routing before the model (whole-utterance
// ack/thanks/bye are answered locally, MUSICISH adds the music hint).
//
// Labels were written before the first run. A third of the scenarios
// (`hold: true`) is held out: tune on the rest, look at the held-out split only
// to report. Ambiguous cases ("either") count in neither headline rate.
//   node bench/followup-judge.mjs <bot.json> [--split tune|holdout|all] [--room pc|call]
import { AsyncLocalStorage } from 'node:async_hooks';
import { AnthropicLlm } from '../dist/brain/anthropic.js';
import { ConversationOrchestrator } from '../dist/brain/orchestrator.js';
import { SessionMemory } from '../dist/brain/sessions.js';
import { loadConfig, readSecrets } from '../dist/config.js';
import { classify } from '../dist/conversation/intents.js';
import { RoomTalk } from '../dist/conversation/room.js';
import * as music from '../dist/features/music.js';
import { SOUND_RULE, soundTool } from '../dist/features/sounds.js';
import { PC_RULE, pcTools } from '../dist/satellite/tools.js';
import { HANDOFF_RULE, handoffTools } from '../dist/features/handoff.js';
import { alarmKit } from './alarm-kit.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const SPLIT = arg('--split', 'tune');
const ROOM = arg('--room', 'all');

// Copied from src/app/stack.ts (importing the stack loads sherpa).
const MUSICISH = /^\W*(?:(?:hey|ok(?:ay)?|yo|now|so|and|alright|bro)\W+)*(?:adri\w*\W+)?(?:(?:can|could|would|will) you (?:please )?|please )?(?:play|put on|throw on|queue|blast|bump|spin|skip|pause|resume|unpause|turn (?:up|down) the music|stop the music|(?:i want to|i wanna|let me|lemme|let's) (?:hear|listen to)|(?:make|do) (?:a|an|the|some) [a-z ]*(?:sound|noise))\b/i;
const MUSIC_FOLLOW_UP = 'This starts like an order for your music or sounds. If it names something to hear or controls what you are playing, it is for you: do it. If it is about a game or for someone else ("play the objective", "skip this round"), it is not.';
const CHANGES_NOTHING = new Set(['ack', 'thanks', 'bye']);
const LANG_EN = 'Reply in English (they are speaking English now, even if earlier messages were in another language).';

// New helpers, when this tree has them (the base tree doesn't).
const judge = await import('../dist/brain/followup.js').catch(() => null);

const c = loadConfig(process.argv[2]);
const s = readSecrets(c.secretsFile);
const llm = new AnthropicLlm({ model: 'claude-haiku-5-5', apiKey: s.get('ANTHROPIC_API_KEY'), effort: 'low' });

// Per-case state: which tools ran, and whether her music is playing.
const als = new AsyncLocalStorage();
const rec = (name, args) => als.getStore()?.calls.push({ name, args });
const NIGHTS = { title: 'Nights', artist: 'Frank Ocean', source: 'youtube', ref: '' };
const player = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'nowPlaying') return als.getStore()?.music ? NIGHTS : undefined;
    if (k === 'lent') return undefined;
    if (k === 'upNext' || k === 'recent') return [];
    if (k === 'paused' || k === 'youtubePaused') return false;
    if (k === 'autoplay') return true;
    // Tool calls are recorded by name below; the player only answers.
    if (/volume/i.test(String(k))) return async () => 0.4;
    return async () => ({ ok: true, started: NIGHTS, added: 1 });
  },
});
const pcResult = (name, x) => {
  if (name === 'pc_apps') return x.action === 'open' ? `Opening ${x.name} (app).` : x.action === 'close' ? `Asked ${x.name} to close.` : 'Open: Chrome, Discord, Spotify.';
  if (name === 'pc_volume') return x.playing ? 'Spotify at 40%.' : `Volume ${x.action === 'up' ? 60 : 40}%.`;
  if (name === 'pc_media') return x.action === 'next' ? 'Spotify is playing “Ivy” by Frank Ocean.' : 'Spotify is paused.';
  if (name === 'pc_system') return x.action === 'lock' ? 'Locked the PC.' : 'Done.';
  if (name === 'pc_open') return 'Opened the page.';
  if (name === 'pc_info') return 'CPU 12%; memory 17.2 GB of 30.9 GB used.';
  return 'Done.';
};
const pc = { action: async (name, args) => (rec(name, args), { ok: true, result: pcResult(name, args) }) };
const sounds = { find: async (q) => (rec('sound', [q]), { title: q, ref: '' }), play: async () => {} };
const alarms = alarmKit(c.timezone, (name, args) => rec(name, args));
const [handoff] = handoffTools({ things: { candidates: () => [] }, starts: {}, callRoom: 'discord', pcFor: () => pc, callMusic: () => undefined, call: () => undefined, inCall: () => false, isOwner: () => true, canSee: async () => true, readable: false });
const handoffRec = { ...handoff, run: async (a) => (rec(handoff.spec.name, a), 'Done.') };

const musicTools = music.musicTools(player).map((t) => ({ ...t, run: (a, sig, ctx) => (rec(t.spec.name, a), t.run(a, sig, ctx)) }));

const room = new RoomTalk();
const PC_LINE = (who) => `${who} is talking to you through their PC (A.D.R.I.A.N. satellite), not in the Discord call. Music and sounds play on that PC.`;
const ROSTER = (asker, others) => `People in this voice call right now (Lounge): ${[`${asker} (talking to you now)`, ...others].join(', ')}.`;

const pcMemory = new SessionMemory(16, 3_600_000);
const pcBrain = new ConversationOrchestrator(llm, pcMemory, [...alarms.tools, ...musicTools, ...pcTools({ pcFor: () => pc, findVideo: async () => 'jfKfPfyJRdk' }), handoffRec], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  stablePrefix: true,
  stableLines: [...music.musicRules(), PC_RULE, HANDOFF_RULE, alarms.rule],
  context: (x) => [LANG_EN, ...room.context(x.channelId, x.userId), music.musicState(player), PC_LINE(x.speaker)],
});
const callMemory = new SessionMemory(16, 3_600_000);
const callBrain = new ConversationOrchestrator(llm, callMemory, [...musicTools, soundTool(sounds), ...alarms.tools], {
  spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: c.timezone, firstEventTimeoutMs: 12000, maxTokens: 500, maxToolRounds: 3,
  stablePrefix: true,
  stableLines: [SOUND_RULE, ...music.musicRules(), alarms.rule],
  context: (x) => [LANG_EN, ROSTER(x.speaker, ['Sam', 'Kim']), ...room.context(x.channelId, x.userId), music.musicState(player)],
});

// ---- Cases --------------------------------------------------------------
// A scenario: a question she answered (said with her name), optional talk in
// between, then several separate trials of what the asker says next, each in a
// fresh conversation. `for`: meant for her; `not`: not meant for her;
// `either`: honestly ambiguous. `tool`: what doing it means. `secs`: seconds
// from the end of her answer.
const S = [];
const sc = (o) => S.push(o);

// ---------------- PC ----------------
sc({ id: 'dinner', room: 'pc', q: 'what should I make for dinner tonight', a: 'How about a quick stir fry? Chicken, peppers, soy sauce and rice, about twenty minutes.', said: [
  ["I don't have any peppers though", 'for', 4],
  ['babe do we still have rice?', 'not', 6],
  ['she says stir fry, you down?', 'not', 5],
] });
sc({ id: 'movie', room: 'pc', hold: true, q: 'give me a good horror movie for tonight', a: "Try Hereditary. It's slow at first but really unsettling.", said: [
  ['something less depressing?', 'for', 3],
  ['are you hungry? we should order before it starts', 'not', 8],
  ['what year did that come out', 'for', 5],
] });
sc({ id: 'rain', room: 'pc', q: 'is it gonna rain today', a: 'No rain today, about 48 degrees and cloudy.', said: [
  ['and tomorrow?', 'for', 3],
  ['told you, no umbrella', 'not', 4],
] });
sc({ id: 'song', room: 'pc', music: true, q: "what's this song", a: "It's Nights by Frank Ocean.", said: [
  ['turn it up a bit', 'for', 4, 'up'],
  ['skip this one, not feeling it', 'for', 6, 'skip'],
  ['dude you have to hear this part', 'not', 3],
  ['sorry, is it too loud for you?', 'not', 9],
] });
sc({ id: 'chips', room: 'pc', hold: true, q: 'how many calories in a bag of chips', a: 'A regular eight ounce bag is about twelve hundred calories.', said: [
  ['can you pass me the chips', 'not', 5],
  ['what about the small bags', 'for', 4],
] });
sc({ id: 'target', room: 'pc', q: 'what time does Target close', a: 'Most Targets close at ten tonight.', said: [
  ["yeah mom I'll be there in like twenty minutes", 'not', 7],
  ["okay I'm leaving now, do you need anything from Target?", 'not', 10],
  ['is it open tomorrow too', 'for', 4],
] });
sc({ id: 'js', room: 'pc', q: "what's the difference between let and const in javascript", a: "Const can't be reassigned; let can. Both are block scoped.", said: [
  ['so which one should I use for a loop counter', 'for', 5],
  ['ugh why is this not compiling', 'either', 12],
  ['Jordan did you push your changes yet', 'not', 9],
] });
sc({ id: 'everest', room: 'pc', hold: true, q: 'how tall is mount everest', a: 'About 29,032 feet, or 8,849 meters.', said: [
  ['and K2?', 'for', 3],
  ['told you it was taller', 'not', 4],
] });
sc({ id: 'moon', room: 'pc', q: 'how far away is the moon', a: 'About 239,000 miles on average.', said: [
  ["she's actually pretty smart", 'not', 5],
  ['how long would it take to drive there', 'for', 6],
] });
sc({ id: 'tip', room: 'pc', q: "what's 15 percent of 84", a: 'Twelve sixty.', said: [
  ['why does she always take so long to answer', 'not', 4],
  ['and twenty percent?', 'for', 3],
] });
sc({ id: 'severance', room: 'pc', hold: true, q: 'who plays the main character in Severance', a: 'Adam Scott plays Mark Scout.', said: [
  ['Mark, you have to understand, the board will never allow it.', 'not', 7],
  ['wait is he also in Parks and Rec?', 'for', 4],
] });
sc({ id: 'castiron', room: 'pc', q: 'how do I clean a cast iron pan', a: 'Rinse it with hot water, scrub with salt, dry it on the stove, then wipe on a thin coat of oil.', said: [
  ["and today we're gonna be looking at the best budget keyboards of the year", 'not', 8],
  ['can I use soap on it?', 'for', 4],
] });
sc({ id: 'focus', room: 'pc', q: "what's a good playlist for focusing", a: 'Try a lofi or ambient mix, nothing with lyrics.', said: [
  ['open spotify', 'for', 4, 'spotify'],
  ['honestly I just need to stop checking my phone', 'either', 7],
] });
sc({ id: 'screenshot', room: 'pc', hold: true, q: 'how do I take a screenshot on windows', a: 'Press Windows, Shift and S, then drag over what you want.', said: [
  ['can you open the snipping tool for me', 'for', 5, 'snip'],
  ['can you open the door for me, my hands are full', 'not', 9],
] });
sc({ id: 'leave', room: 'pc', q: 'when should I leave for a 7 pm movie if the theater is twenty minutes away', a: 'Leave by six thirty to get tickets and seats.', said: [
  ['did you lock the car?', 'not', 8],
  ['what if I already have tickets', 'for', 5],
] });
sc({ id: 'valorant', room: 'pc', q: "what's a good agent for a beginner in valorant", a: 'Try Sage. Her heals and walls are easy to use well.', said: [
  ["yo Sam, I'm gonna play Sage this game", 'not', 6],
  ['what about Brimstone?', 'for', 4],
  ["push left, they're all on B", 'not', 10],
] });
sc({ id: 'egg', room: 'pc', hold: true, q: 'how long do I boil an egg', a: 'About nine minutes for hard boiled, six for jammy.', said: [
  ['remind me in nine minutes', 'for', 4, 'timer'],
  ['oh also, how much is a dozen eggs right now', 'for', 6],
  ['you want one too?', 'not', 5],
] });
sc({ id: 'canberra', room: 'pc', q: "what's the capital of Australia", a: 'Canberra.', said: [
  ['huh, I always thought it was Sydney', 'either', 3],
  ['bro it was Canberra, you owe me five bucks', 'not', 5],
] });
sc({ id: 'cups', room: 'pc', q: 'how many ounces in a cup', a: 'Eight fluid ounces.', said: [
  ['okay so two cups for this recipe', 'either', 5],
  ['and how many in a pint', 'for', 4],
] });
sc({ id: 'spell', room: 'pc', hold: true, q: 'how do you spell necessary', a: 'N, E, C, E, S, S, A, R, Y.', said: [
  ["buddy, go brush your teeth, it's late", 'not', 6],
  ['Max, get off the couch!', 'not', 4],
  ['and occasionally?', 'for', 3],
] });
sc({ id: 'hum', room: 'pc', music: true, q: 'who sings this', a: "It's Nights by Frank Ocean.", said: [
  ["baby you're my only one tonight, oh oh", 'not', 6],
  ['what album is it on', 'for', 4],
] });
sc({ id: 'rename', room: 'pc', q: "what's the shortcut to rename a file", a: 'Select it and press F2.', said: [
  ['okay where did I save that thing', 'either', 8],
  ['what about a whole folder', 'for', 5],
] });
sc({ id: 'hades', room: 'pc', hold: true, q: 'who made Hades', a: 'Supergiant Games made Hades.', said: [
  ['no I meant Hades two', 'for', 3],
  ["Sam it's the same studio, I told you", 'not', 6],
] });
sc({ id: 'laptop', room: 'pc', q: "what's a good laptop for school under 800 dollars", a: 'Look at the MacBook Air M2 or the Asus Zenbook 14.', said: [
  ["no the other one, how's the battery", 'for', 4],
  ['mom she says the MacBook', 'not', 5],
] });
sc({ id: 'fullmoon', room: 'pc', q: "when's the next full moon", a: 'The next full moon is on December 4th.', said: [
  ['what about the one after that', 'for', 4],
  ['are we still doing pizza Friday or what', 'not', 9],
] });
sc({ id: 'back', room: 'pc', hold: true, q: "what's a good stretch for lower back pain", a: "Try child's pose for thirty seconds, then cat-cow.", said: [
  ["you hungry? I'm about to order", 'not', 7],
  ['how many times a day', 'for', 4],
] });
sc({ id: 'bulls', room: 'pc', q: "what's the score of the Nuggets game", a: 'Nuggets lead 88 to 80 in the fourth.', said: [
  ['Nuggets are up by eight bro', 'not', 4],
  ['who has the most points', 'for', 5],
  ["perfect, that's all I needed", 'either', 4],
] });
sc({ id: 'smart', room: 'pc', q: 'how many bones are in the human body', a: 'Two hundred six in an adult.', loose: true, said: [
  // A loose wake: since wake-2 the model gets the whole sentence, name and all, with the loose-wake line.
  ['Adrian is kind of smart actually', 'not', 5],
] });

// ---------------- Call (Morgan, Sam and Kim) ----------------
sc({ id: 'coop', room: 'call', q: "what's a good co-op game for four people", a: "Try Deep Rock Galactic. It's great with four.", said: [
  ['is it on game pass?', 'for', 3, undefined, [['Sam', "ooh I've heard of that"]]],
  ['yeah I got it last summer', 'not', 4, undefined, [['Sam', 'morgan you have it right?']]],
  ["I think it's like thirty bucks", 'not', 3, undefined, [['Kim', 'how much is it']]],
  ['how much does it cost', 'for', 2],
] });
sc({ id: 'boss', room: 'call', hold: true, q: 'how do I beat the first boss in Elden Ring', a: 'Use a spirit summon and dodge his delayed swings.', said: [
  ["watch out, he's behind you", 'not', 3],
  ["dude I'm so bad at this lol", 'not', 4],
  ['what level should I be before I fight him', 'for', 3],
] });
sc({ id: 'canada', room: 'call', q: "what's the population of Canada", a: 'About forty one million.', said: [
  ["Sam it's huge, it's just empty", 'not', 3, undefined, [['Sam', "no way it's that high"]]],
  ['how does that compare to California', 'for', 3],
] });
sc({ id: 'getlucky', room: 'call', music: true, q: 'who sings this', a: "It's Nights by Frank Ocean.", said: [
  ['skip it', 'for', 3, 'skip'],
  ["skip the shop this round, we're saving", 'not', 4],
  ["turn it down a little, I can't hear Kim", 'for', 3, 'down'],
] });
sc({ id: 'team', room: 'call', hold: true, q: "what's a good name for our team", a: 'How about the Night Owls?', said: [
  ['Kim what do you think', 'not', 2],
  ['yeah give us a few more', 'for', 3, undefined, [['Kim', 'night owls is kinda mid']]],
] });
sc({ id: 'stlouis', room: 'call', q: 'how long is the drive from Chicago to St. Louis', a: 'About five hours.', said: [
  ['like six am?', 'either', 3, undefined, [['Sam', 'we should leave early then']]],
  ["what's the best route", 'for', 3],
] });
sc({ id: 'fact', room: 'call', q: 'tell me a fun fact', a: 'Octopuses have three hearts.', said: [
  ["lmao that's crazy", 'not', 2],
  ['tell me another one', 'for', 2],
] });
sc({ id: 'realm', room: 'call', hold: true, q: 'how many people can join a Minecraft realm', a: 'Up to ten players at once.', said: [
  ['Kim send me the invite', 'not', 3],
  ['is that the same on bedrock', 'for', 3],
] });
sc({ id: 'superbowl', room: 'call', q: 'who won the super bowl last year', a: 'The Eagles won Super Bowl 59.', said: [
  ['whatever, you got lucky', 'not', 2, undefined, [['Kim', 'told you']]],
  ['who did they beat', 'for', 3],
] });
sc({ id: 'pizza', room: 'call', q: "what's a good pizza place downtown", a: "I don't have local listings, but Pizzeria Locale is a popular one downtown.", said: [
  ['you guys want pepperoni or cheese', 'not', 4],
  ['do they deliver?', 'for', 3],
] });
sc({ id: 'spanish', room: 'call', hold: true, q: 'how do you say good game in Spanish', a: 'Buen juego.', said: [
  ['buen juego everybody', 'not', 2],
  ['and in French?', 'for', 2],
] });
sc({ id: 'warzone', room: 'call', q: "what's the best loadout in warzone right now", a: 'Most people run an assault rifle with a sniper support build.', said: [
  ['drop on the left building, grab armor', 'not', 5],
  ['can you ping that guy on the roof', 'not', 6],
  ['what attachments for the rifle', 'for', 3],
] });
sc({ id: 'frozen', room: 'call', q: 'how long do I cook a frozen pizza', a: 'About fifteen minutes at 425.', said: [
  ["that's longer than I thought", 'either', 3],
  ['hmm where is my headset charger', 'either', 6],
] });
sc({ id: 'slow', room: 'call', hold: true, q: 'what time is it in Tokyo', a: "It's 9:40 in the morning there.", loose: true, said: [
  // A loose wake, as above.
  ['Adrian is so slow lol', 'not', 3],
  ['and in London?', 'for', 2],
] });
sc({ id: 'sam-asks', room: 'call', q: 'how many players are on a soccer team', a: 'Eleven on the field for each side.', said: [
  ['nah I can play after nine', 'not', 3, undefined, [['Sam', 'morgan you free tonight?']]],
  ['what about futsal', 'for', 3],
] });

// ---------------- Statements (added after the first report) ----------------
// Follow-ups to her that are statements, not questions or orders: objections,
// constraints, thanks with a tail, "more like that", answering her question;
// plus a few statement-shaped lines to someone else. Labeled before running;
// `--split stmt`. Not rewordings of any held-out case.
sc({ id: 'thighs', room: 'pc', set: 'stmt', q: 'how long should I bake chicken thighs', a: 'About thirty five minutes at 425.', said: [['my oven only goes to 400', 'for', 4]] });
sc({ id: 'podcast', room: 'pc', set: 'stmt', q: 'recommend a podcast for my commute', a: "Try Radiolab, it's science stories.", said: [["I've already heard all of those", 'for', 4]] });
sc({ id: 'dad', room: 'pc', set: 'stmt', q: "what's a good gift for my dad", a: 'A nice multitool or a whiskey sampler.', said: [["he doesn't drink", 'for', 3]] });
sc({ id: 'door', room: 'pc', set: 'stmt', q: 'how do I fix a squeaky door', a: 'Spray WD-40 on the hinges and swing it a few times.', said: [["I don't have any WD-40", 'for', 5]] });
sc({ id: 'stardew', room: 'pc', set: 'stmt', q: 'suggest a game like Stardew Valley', a: 'Try Coral Island.', said: [['that one was too slow for me', 'for', 4]] });
sc({ id: 'workout', room: 'pc', set: 'stmt', q: "what's a quick workout", a: 'Three rounds of twenty squats, ten pushups and a one minute plank.', said: [["thanks, I'll try that tonight", 'for', 4]] });
sc({ id: 'scifi', room: 'pc', set: 'stmt', q: 'name a good sci-fi book', a: 'Project Hail Mary by Andy Weir.', said: [['I loved that one, something like it would be great', 'for', 5]] });
sc({ id: 'water', room: 'pc', set: 'stmt', q: 'how much water should I drink a day', a: 'Around eight cups is a common target.', said: [['that seems like a lot', 'for', 3]] });
sc({ id: 'pasta', room: 'pc', set: 'stmt', q: 'how long do I boil pasta', a: 'About ten minutes.', said: [["the water's boiling, can you grab the salt", 'not', 6]] });
sc({ id: 'sunny', room: 'pc', set: 'stmt', q: "what's the weather tomorrow", a: 'Sunny, around sixty.', said: [["honey I'm taking the dog out", 'not', 7]] });
sc({ id: 'evanston', room: 'pc', set: 'stmt', q: 'how far is Chicago from Evanston', a: 'About fifteen miles.', said: [["I'll pick you up at seven then", 'not', 8]] });
sc({ id: 'jackbox', room: 'call', set: 'stmt', q: 'suggest a party game for tonight', a: 'Try Jackbox, Party Pack 9 has good ones.', said: [['yeah we did that already, something different', 'for', 3, undefined, [['Sam', 'we played that last week']]]] });
sc({ id: 'budapest', room: 'call', set: 'stmt', q: "what's a good movie for the group", a: 'How about The Grand Budapest Hotel?', said: [["Kim's seen it already", 'for', 3]] });
sc({ id: 'trivia', room: 'call', set: 'stmt', q: 'give me a trivia question', a: "What's the only planet that spins clockwise?", said: [["I think it's Venus", 'for', 4]] });
sc({ id: 'cozy', room: 'call', set: 'stmt', q: 'what should we name the server', a: 'How about The Cozy Corner?', said: [['another one like that but funnier', 'for', 3]] });
sc({ id: 'overcooked', room: 'call', set: 'stmt', q: 'how do we beat this level in Overcooked', a: 'Have one person only chop and one only cook.', said: [["we tried that and it still didn't work", 'for', 3]] });
sc({ id: 'celsius', room: 'call', set: 'stmt', q: 'convert 30 celsius to fahrenheit', a: "That's 86 degrees.", said: [["thanks, that's what I figured", 'for', 2]] });
sc({ id: 'topping', room: 'call', set: 'stmt', q: "what's the best pizza topping", a: "Pepperoni, it's the classic for a reason.", said: [['pineapple is better and you know it', 'for', 3]] });
sc({ id: 'worldcup', room: 'call', set: 'stmt', q: 'who won the last world cup', a: 'Argentina, in 2022.', said: [['facts, he carried them', 'not', 3, undefined, [['Kim', 'messi goat']]]] });
sc({ id: 'lethal', room: 'call', set: 'stmt', q: 'suggest a game for the four of us', a: 'Try Lethal Company.', said: [['Sam you still have it installed right', 'not', 4]] });

// ---- Run ------------------------------------------------------------------
const META = /\b(was(n'?t| not) (that |this )?(for|to|meant for|talking to) me|(were|are) you talking to me|talking to (me|someone else)|did you mean me|meant for me|not sure (if )?(that was|you were) (for|talking to) me)\b/i;
const TOOL = {
  up: (k) => (k.name === 'music_control' && /louder|volume/.test(k.args.action)) || (k.name === 'pc_volume' && /up|set/.test(k.args.action)),
  down: (k) => (k.name === 'music_control' && /quieter|volume/.test(k.args.action)) || (k.name === 'pc_volume' && /down|set/.test(k.args.action)),
  skip: (k) => (k.name === 'music_control' && k.args.action === 'skip') || (k.name === 'pc_media' && k.args.action === 'next'),
  spotify: (k) => k.name === 'pc_apps' && k.args.action === 'open' && /spotify/i.test(k.args.name ?? ''),
  snip: (k) => k.name === 'pc_apps' && k.args.action === 'open' && /snip/i.test(k.args.name ?? ''),
  timer: (k) => k.name === 'set_timer' || k.name === 'set_reminder',
};

const trials = [];
for (const x of S) {
  if (ROOM !== 'all' && x.room !== ROOM) continue;
  const split = x.set ?? (x.hold ? 'holdout' : 'tune');
  if (SPLIT !== 'all' && SPLIT !== split) continue;
  x.said.forEach(([said, label, secs, tool, lines], i) => trials.push({ ...x, n: i, split, said, label, secs, tool, lines: lines ?? [] }));
}

let nextUser = 0;
async function trial(t) {
  const user = `u${nextUser++}`;
  const ch = t.room === 'pc' ? `sat:${user}` : `call:${user}`;
  const memory = t.room === 'pc' ? pcMemory : callMemory;
  const brain = t.room === 'pc' ? pcBrain : callBrain;
  // Seeded, as heard: her name and question, her answer, any talk between, then these words.
  memory.append(user, { role: 'user', content: t.q });
  memory.append(user, { role: 'assistant', content: t.a });
  room.add(ch, user, 'Morgan', `Adrian, ${t.q}`);
  room.add(ch, 'bot', 'You (answering Morgan)', t.a);
  for (const [who, line] of t.lines) room.add(ch, who.toLowerCase(), who, line);
  room.add(ch, user, 'Morgan', t.said);
  const state = { calls: [], music: !!t.music };
  return als.run(state, async () => {
    const kind = classify(t.said)?.kind;
    if (CHANGES_NOTHING.has(kind)) return { got: kind === 'ack' ? 'silent' : 'answer', out: `(local ${kind})`, calls: [] };
    if (judge?.localSilent?.(t.said)) return { got: 'silent', out: '(local silent)', calls: [] };
    let out = '';
    let silent = false;
    const hint = MUSICISH.test(t.said);
    // In a `loose` scenario, the line with her name in it is the loose wake.
    const loose = !!t.loose && /\badrian\b/i.test(t.said);
    const opts = { followUp: true, ...(loose ? { loose: true } : {}), ...(t.room === 'pc' ? { desk: true } : {}), ...(hint ? { extra: [MUSIC_FOLLOW_UP] } : {}), sinceMs: t.secs * 1000, onSilent: () => (silent = true) };
    for await (const chunk of brain.ask(user, 'Morgan', t.said, AbortSignal.timeout(30_000), undefined, { channelId: ch }, opts)) out += (out ? ' ' : '') + chunk;
    const got = silent ? 'silent' : META.test(out) ? 'meta' : out || state.calls.length ? 'answer' : 'silent';
    return { got, out, calls: state.calls };
  });
}

const tally = {};
const bump = (k, ok) => ((tally[k] ??= [0, 0]), (tally[k][1] += 1), ok && (tally[k][0] += 1));
let wrong = 0;
let notTotal = 0;
for (const t of trials) {
  const r = await trial(t);
  let pass;
  if (t.label === 'not') {
    notTotal++;
    if (r.calls.length) wrong++;
    pass = r.got === 'silent' && !r.calls.length;
  } else if (t.label === 'for') {
    pass = r.got === 'answer' && (!t.tool || r.calls.some(TOOL[t.tool]));
    if (t.tool && r.calls.some((k) => !TOOL[t.tool](k))) wrong++;
  } else {
    pass = r.got !== 'meta';
  }
  const key = `${t.split} ${t.label}`;
  if (t.label === 'either') bump(`${t.split} either answered`, r.got === 'answer');
  else bump(key, pass);
  bump(`${t.room} ${t.label}${t.label === 'either' ? ' answered' : ''}`, t.label === 'either' ? r.got === 'answer' : pass);
  if (r.got === 'meta') bump('meta', true);
  const tools = r.calls.map((k) => `${k.name}${JSON.stringify(k.args)}`).join(' ');
  console.log(`${pass ? 'ok ' : 'BAD'} [${t.split} ${t.room} ${t.label}] ${t.id}/${t.n} "${t.said}"\n    -> ${r.got === 'silent' ? '(SILENT)' : r.out.slice(0, 160)}${tools ? `   tools: ${tools}` : ''}`);
}
const f = (k) => (tally[k] ? `${tally[k][0]}/${tally[k][1]}` : '-');
console.log('');
for (const sp of ['tune', 'holdout', 'stmt']) {
  if (!tally[`${sp} not`] && !tally[`${sp} for`]) continue;
  console.log(`${sp}: side talk silent ${f(`${sp} not`)}, follow-ups answered ${f(`${sp} for`)}, ambiguous answered ${f(`${sp} either answered`)}`);
}
console.log(`by room: pc not ${f('pc not')}, pc for ${f('pc for')}, call not ${f('call not')}, call for ${f('call for')}`);
console.log(`meta answers: ${tally.meta?.[1] ?? 0}`);
const scored = ['tune not', 'tune for', 'holdout not', 'holdout for', 'stmt not', 'stmt for'].reduce((a, k) => [a[0] + (tally[k]?.[0] ?? 0), a[1] + (tally[k]?.[1] ?? 0)], [0, 0]);
console.log(`wrong actions: ${wrong} (any tool on side talk, or a different tool than asked) of ${trials.length}`);
console.log(`\n${scored[0]}/${scored[1]} judged as expected`);
