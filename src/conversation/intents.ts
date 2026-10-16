// Everyday phrases handled locally, without the language model: stopping,
// thanks, goodbye, repeat, volume and speed. A phrase only counts when it is
// the whole utterance (after fillers, politeness and the bot's name are
// stripped), so "how do I stop a nosebleed" still goes to the model.

export type Intent =
  /** weak: an everyday word ("done", "quiet", "ya") that only means stop
   *  from the person being answered or when said with the name. */
  | { kind: 'stop'; weak?: boolean } // stop talking / cancel / shut up / stop listening
  | { kind: 'name' } // just the name ("Adrian?"): stops an answer, else a wake
  | { kind: 'thanks' }
  | { kind: 'bye' }
  | { kind: 'ack' } // "okay", "cool", "got it": nothing to answer
  | { kind: 'repeat' }
  | { kind: 'volume'; dir: 1 | -1 }
  | { kind: 'speed'; dir: 1 | -1 };

const NAMES = new Set(['adrian', 'adrien', 'adriane', 'adrean', 'adreon', 'adrion', 'adryan', 'aidrian', 'adriaan', 'adrain', 'edrian', 'adrians']);
const LEAD = new Set(['hey', 'hi', 'ok', 'okay', 'k', 'yo', 'um', 'uh', 'erm', 'hmm', 'oh', 'ah', 'so', 'please', 'alright', 'all', 'right', 'well', 'just', 'no', 'nah', 'dude', 'bro', 'man', 'and']);
const TAIL = new Set(['please', 'now', 'already', 'man', 'dude', 'bro', 'thanks', 'ok', 'okay', 'pls', 'plz']);

const PHRASES: [Intent, string[]][] = [
  [
    { kind: 'stop' },
    [
      'stop', 'stop it', 'stop that', 'stop stop', 'stop talking', 'stop speaking', 'stop listening', 'stop listening to me',
      'stop talking to me', 'quit it', 'quit talking', 'shut up', 'shut it', 'shush', 'shh', 'sh', 'hush', 'quiet',
      'be quiet', 'silence', 'zip it', 'pipe down', 'enough', 'that is enough', 'thats enough', 'enough talking',
      'cancel', 'cancel that', 'never mind', 'nevermind', 'forget it', 'forget about it', 'forget that', 'scratch that',
      'can you stop', 'could you stop', 'will you stop', 'can you be quiet', 'can you shut up', 'would you shut up',
      'go to sleep', 'go away', 'leave me alone', 'not now', 'not you', 'i was not talking to you', 'i wasnt talking to you',
      'im not talking to you', 'i am not talking to you', 'wasnt talking to you', 'nobody asked', 'mute', 'end', 'done',
      'im done', 'we are done', 'were done', 'that is all', 'thats all', 'that will be all', 'thatll be all', 'thats it',
      'that is it', 'nothing', 'no thanks', 'no thank', 'never mind that',
      // Spanish
      'para', 'parale', 'callate', 'basta', 'ya basta', 'silencio', 'detente', 'olvidalo', 'cancela', 'cancelalo', 'no importa', 'ya', 'suficiente',
      // Vietnamese
      'dung lai', 'dung', 'im di', 'im lang', 'thoi', 'thoi di', 'im', 'khong can',
    ],
  ],
  [
    { kind: 'thanks' },
    ['thanks', 'thank you', 'thank you so much', 'thanks so much', 'thanks a lot', 'ty', 'cheers', 'appreciate it', 'i appreciate it',
      'cool thanks', 'great thanks', 'awesome thanks', 'perfect thanks', 'nice thanks', 'got it thanks', 'good job', 'nice job',
      'well done', 'good bot', 'gracias', 'muchas gracias', 'cam on', 'cam on ban', 'xie xie', 'arigato'],
  ],
  [{ kind: 'bye' }, ['adios', 'hasta luego', 'tam biet', 'bye', 'goodbye', 'bye bye', 'good night', 'goodnight', 'see you', 'see ya', 'see you later', 'later', 'talk to you later', 'peace', 'catch you later']],
  [{ kind: 'ack' }, ['ok', 'okay', 'all right', 'ok cool', 'okay cool', 'cool', 'got it', 'gotcha', 'nice', 'great', 'awesome', 'perfect', 'alright', 'right', 'sure', 'yep', 'yeah', 'mhm', 'interesting', 'wow', 'oh', 'i see', 'makes sense', 'fair enough', 'no way', 'i am good', 'im good', 'all good', 'we are good', 'were good', 'good', 'ok good']],
  [
    { kind: 'repeat' },
    ['repeat', 'repeat that', 'say that again', 'say it again', 'can you repeat that', 'could you repeat that', 'what did you say',
      'what was that', 'come again', 'pardon', 'sorry what', 'what', 'huh', 'one more time', 'again', 'i did not hear that',
      'i didnt hear that', 'i didnt catch that', 'repeat yourself'],
  ],
  [
    { kind: 'volume', dir: 1 },
    ['louder', 'speak up', 'talk louder', 'be louder', 'volume up', 'turn it up', 'turn up', 'turn up the volume', 'turn the volume up',
      'i cant hear you', 'i can not hear you', 'cant hear you', 'too quiet', 'you are too quiet', 'youre too quiet', 'raise your voice'],
  ],
  [
    { kind: 'volume', dir: -1 },
    ['quieter', 'softer', 'talk quieter', 'speak quieter', 'speak softer', 'volume down', 'turn it down', 'turn down',
      'turn down the volume', 'turn the volume down', 'too loud', 'you are too loud', 'youre too loud', 'lower your voice', 'not so loud'],
  ],
  [{ kind: 'speed', dir: -1 }, ['slower', 'slow down', 'talk slower', 'speak slower', 'too fast', 'you are too fast', 'youre too fast', 'slow it down']],
  [{ kind: 'speed', dir: 1 }, ['faster', 'speed up', 'talk faster', 'speak faster', 'too slow', 'you are too slow', 'youre too slow', 'hurry up']],
];

/** Stop phrases that are also everyday words in a group call. */
const WEAK_STOP = new Set([
  'done', 'end', 'nothing', 'quiet', 'mute', 'enough', 'not now', 'im done', 'we are done', 'were done', 'thats it', 'that is it',
  'thats all', 'that is all', 'ya', 'para', 'suficiente', 'dung', 'im', 'thoi', 'thoi di',
]);

const TABLE = new Map<string, Intent>();
for (const [intent, list] of PHRASES) for (const p of list) if (!TABLE.has(p)) TABLE.set(p, intent);

function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // "cállate" → "callate", "dừng" → "dung"
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[’']/g, '') // "that's" → "thats"
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Chinese and Japanese stop / thanks phrases (no spaces, so matched whole). */
const CJK: [RegExp, Intent][] = [
  [/^(停|停下|停一下|别说了|不要说了|闭嘴|安静|够了|算了|やめて|止めて|とめて|ストップ|うるさい|静かに|しずかに|もういい)[。！!、,.\s]*$/, { kind: 'stop' }],
  [/^(谢谢|谢谢你|多谢|ありがとう|ありがとうございます)[。！!、,.\s]*$/, { kind: 'thanks' }],
  [/^(再见|拜拜|さようなら|またね|バイバイ)[。！!、,.\s]*$/, { kind: 'bye' }],
];

/** Classify a whole utterance (or the command after the wake phrase). */
/** "Shut the fuck up", "bro just stop talking", "stfu": stop phrases inside a
 *  short utterance that isn't a question about them. */
const STOP_INSIDE = /\b(shut (the )?(fuck |hell |heck )?up|stfu|stop (talking|speaking|it|that|now)|be quiet|quiet down|shush|shh+|stop stop|enough|cállate|callate|basta)\b/i;
const QUESTION_START = /^(what|how|why|does|do|is|are|can you (tell|explain)|who|when|where|which|define|translate|spell)\b/i;

export function classify(text: string): Intent | undefined {
  const raw = text.trim().replace(/^(嘿|喂|ねえ|ねぇ)?\s*(adrian|阿德里安|エイドリアン)?[，,、\s]*/i, '');
  for (const [re, intent] of CJK) if (re.test(raw)) return intent;
  const plain = text.trim();
  if (STOP_INSIDE.test(plain) && plain.split(/\s+/).length <= 8 && !plain.includes('?')) {
    const afterName = plain.replace(/^\W*(hey|ok(ay)?|yo)?\W*(adri[a-zà-ÿ]*)?\W*/i, '');
    if (!QUESTION_START.test(afterName)) return { kind: 'stop' };
  }
  let w = words(text);
  if (w.length === 0 || w.length > 10) return undefined;
  const sawName = w.some((x) => NAMES.has(x));
  // Strip the name anywhere at the edges ("stop adrian", "adrian stop"),
  // fillers in front and politeness at the end.
  for (let changed = true; changed; ) {
    changed = false;
    while (w.length && (LEAD.has(w[0]!) || NAMES.has(w[0]!))) {
      w = w.slice(1);
      changed = true;
    }
    while (w.length && (TAIL.has(w[w.length - 1]!) || NAMES.has(w[w.length - 1]!))) {
      w = w.slice(0, -1);
      changed = true;
    }
    if (w.length > 2 && w[w.length - 2] === 'thank' && w[w.length - 1] === 'you') {
      w = w.slice(0, -2); // "that's all, thank you"
      changed = true;
    }
  }
  const phrase = w.join(' ');
  if (!phrase) {
    // Only fillers and politeness left: "thank you", "no thanks", "okay",
    // or just the name ("hey Adrian").
    const known = TABLE.get(words(text).filter((x) => !NAMES.has(x)).join(' '));
    if (known) return known;
    return sawName ? { kind: 'name' } : undefined;
  }
  const found = TABLE.get(phrase);
  return found?.kind === 'stop' && WEAK_STOP.has(phrase) ? { kind: 'stop', weak: true } : found;
}

// --- music --------------------------------------------------------------------

export type MusicIntent =
  | { kind: 'play'; query: string; mode: 'now' | 'queue'; source?: 'youtube' | 'plex' }
  | { kind: 'control'; action: 'pause' | 'resume' | 'skip' | 'stop' | 'status' };

/** Party games and other things you "play" that aren't music. */
const NOT_MUSIC = /^(a |the |some )?(game|games|trivia|quiz|would you rather|riddles?|20 questions|twenty questions|rock paper|tic tac|hangman|word games?|with me|along|dead|nice|fair|it again|that again|it cool|around|dumb|minecraft|fortnite|valorant|roblox|rocket league|cards?|poker|chess|catch)\b/i;

/** Requests the model should interpret (a mood, a playlist, "like that one"). */
const VAGUE = /\b(playlists?|mix(es)?|vibes?|like (this|that|the|what|it)|similar|album|podcasts?|episodes?|radio|something|anything|songs|music|stuff|tunes|type of|kind of|genre|more|whatever|random|mood|hype|chill|sad|happy|for (gaming|studying|sleep|sleeping|working|the gym|a party|driving))\b/i;

const MUSIC_CONTROL: [RegExp, MusicIntent][] = [
  [/^(skip|next|skip (it|this|that|this song|that song|the song|this one|song)|next song|play the next (one|song)|change the song)$/, { kind: 'control', action: 'skip' }],
  [/^(pause|pause (it|this|that|the music|the song|music)|hold the music)$/, { kind: 'control', action: 'pause' }],
  [/^(resume|unpause|un pause|keep playing|continue|continue (the music|playing)|play (it|the music) again|resume (the music|playing|the song))$/, { kind: 'control', action: 'resume' }],
  [/^(stop (the |this )?(music|song)|stop playing|turn off the music|turn the music off|kill the music|cut the music|music off|no more music|end the music|clear the queue)$/, { kind: 'control', action: 'stop' }],
  [/^(whats playing|what is playing|what song is (this|that|playing)|whats this song|what is this song|what song|whats (the|this) song( called)?|what are we listening to|whats up next|what is up next|whats next|whats in the queue|whats queued)$/, { kind: 'control', action: 'status' }],
];

/** "play get lucky", "queue up some drake", "put on lofi from plex", "skip". */
export function classifyMusic(text: string): MusicIntent | undefined {
  let s = text
    .trim()
    .replace(/^\W*(hey|hi|ok(ay)?|yo|um+|uh+)?\W*(adri[a-zà-ÿ]*)?[\s,.!:]*/i, '')
    .replace(/^(can|could|would|will) you (please )?|^please |^(go ahead and |just )/i, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+(please|pls|now|for me|for us|thanks)$/i, '')
    .trim();
  const plain = s.toLowerCase().replace(/[’']/g, '');
  for (const [re, intent] of MUSIC_CONTROL) if (re.test(plain)) return intent;
  const m = s.match(/^(play|put on|throw on|blast|bump|queue( up)?|add)\s+(.+)$/i);
  if (!m) return undefined;
  const verb = m[1]!.toLowerCase();
  let query = m[3]!.trim();
  if (NOT_MUSIC.test(query) || VAGUE.test(query)) return undefined;
  let mode: 'now' | 'queue' = verb.startsWith('queue') || verb === 'add' ? 'queue' : 'now';
  const next = query.match(/^(.+?)\s+(next|after this( one| song)?|to the queue|to queue|in the queue|later)$/i);
  if (next) {
    query = next[1]!.trim();
    mode = 'queue';
  }
  let source: 'youtube' | 'plex' | undefined;
  const from = query.match(/^(.+?)\s+(from|on|off) (my |the )?(plex|youtube( music)?)$/i);
  if (from) {
    query = from[1]!.trim();
    source = from[4]!.toLowerCase() === 'plex' ? 'plex' : 'youtube';
  }
  query = query.replace(/^(me |us )?(the song |a song called |the track )/i, '').replace(/^(me |us )/i, '').trim();
  if (verb === 'add' && !/\b(queue|next)\b/i.test(m[3]!)) {
    if (!next) return undefined; // "add milk to my list" isn't music
  }
  if (!query || query.split(/\s+/).length > 14) return undefined;
  return { kind: 'play', query, mode, ...(source ? { source } : {}) };
}

/** "what time is it", "what's the time": answered locally. */
export function isTimeQuestion(text: string): boolean {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/^\W*(hey|hi|ok(ay)?|yo|um+|uh+)?\W*(adri[a-zà-ÿ]*)?[\s,.!:]*/i, '')
    .replace(/[.!?\s]+$/, '');
  return /^(what time is it|whats the time|what is the time|what time is it (right )?now|do you know what time it is|time check)$/.test(s);
}
