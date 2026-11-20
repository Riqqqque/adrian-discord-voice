// Text-based wake detection: the transcript must START with the wake phrase
// ("hey adrian", with tolerant greetings and ASR spellings of the name).
// Acoustic wake words can't tell "Hey Adrian" from people talking to a
// friend named Adrian, so this check is the authority.

import type { WakeDetector } from '../core/interfaces.js';
import { classify, classifyMusic, isTimeQuestion } from '../conversation/intents.js';

export interface TextWakeOptions {
  /** Spoken name, lower case. Default "adrian". */
  name?: string;
  /** Extra accepted spellings of the name, lower case. */
  nameVariants?: string[];
  /** Greetings that may precede the name. */
  greetings?: string[];
  /** Accept the bare name with no greeting ("Adrian, what time is it").
   *  Off by default: it false-wakes on people talking to a friend. */
  allowBareName?: boolean;
}

/** "k" is how ASR often renders a clipped "okay". */
const DEFAULT_GREETINGS = [
  'hey', 'hi', 'hay', 'okay', 'ok', 'k', 'yo', 'hello', 'heya', 'hiya',
  'hola', 'oye', 'ola', 'chào', 'chao', 'ê', 'này',
];
/** Spellings Parakeet and other ASR produce for "Adrian". */
const DEFAULT_VARIANTS = [
  'adrien', 'adriane', 'adrean', 'adreon', 'adrion', 'adryan', 'aidrian', 'adriaan', 'adrain', 'edrian', 'adrián', 'adriàn',
];
/** Fillers allowed before the greeting. */
const FILLERS = new Set(['um', 'uh', 'erm', 'hmm', 'so', 'oh', 'ah', 'xin', 'eh']);
/** Words that lead into a request without being one ("wait, Adrian, pause it").
 *  Only for the bare name, and such a wake is loose: the model judges it. */
const LEAD_INS = new Set([
  'wait', 'alright', 'all', 'right', 'yeah', 'yes', 'okay', 'ok', 'sorry', 'actually', 'well', 'guys', 'bro', 'dude', 'hold', 'on', 'hang', 'one', 'sec', 'second', 'and', 'now',
  ...FILLERS,
]);
/** "Adrian's", "Adrian'll" etc. talk ABOUT someone, not TO the bot. */
const CONTRACTION = /^['’](s|ll|d|re|ve|m)\b/;
/** After the bare name: words that mean talk about the bot ("Adrian is so slow"). */
const ABOUT_IT = /^(is|was|isn'?t|wasn'?t|has|had|did|does|doesn'?t|didn'?t|said|says|keeps|always|never|just|be|been|will|would|won'?t|can'?t|sounds|said)\b/i;

/** Helper verbs: a question to her puts the subject right after them ("is it",
 *  "can you"); talk about her puts a verb or a word about her there ("is in
 *  the other channel", "will handle it"). A plain "does" or "did" is nearly
 *  always a question ("does pizza freeze well"), so they aren't here. */
const AUX = new Set([
  'is', 'was', 'are', 'were', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must',
  "isn't", "wasn't", "aren't", "weren't", "won't", "wouldn't", "can't", "couldn't", "shouldn't", "doesn't", "didn't",
]);
/** After the bare name, only a pronoun makes a helper verb a question ("Adrian,
 *  is it raining"): "Adrian is the best" is talk about him. */
const PRONOUNS = new Set(['you', 'it', 'i', 'we', 'they', 'he', 'she', 'there', 'anyone', 'anybody', 'someone', 'somebody', 'everyone']);
/** "has" and "had" are also plain verbs ("has it covered", "has a car"): only these make them a question. */
const HAS = new Set(['has', 'had', 'have', "hasn't", "hadn't", "haven't"]);
const HAS_SUBJECTS = new Set(['anyone', 'anybody', 'anything', 'someone', 'somebody', 'something', 'everyone', 'everybody', 'nobody', 'there', 'you', 'he', 'she', 'they', 'we', 'i']);
const SUBJECTS = new Set([
  ...HAS_SUBJECTS, 'it', 'this', 'that', 'these', 'those', 'the', 'a', 'an', 'my', 'your', 'his', 'her', 'our', 'their', 'its',
  'any', 'some', 'all', 'every', 'each', 'no', 'one', 'two', 'three', 'what', 'which', "it's", "there's", "that's",
]);
/** Right after the name, these say what Adrian did or is like. */
const ABOUT_WORDS = new Set([
  'said', 'says', 'told', 'tells', 'thinks', 'thought', 'knows', 'knew', 'keeps', 'kept', 'wants', 'likes', 'loves', 'hates', 'needs', 'plays',
  'gets', 'got', 'goes', 'went', 'gone', 'makes', 'made', 'left', 'came', 'comes', 'won', 'lost', 'took', 'gave', 'built', 'broke', 'bought', 'ran',
  'sent', 'sat', 'saw', 'heard', 'found', 'fell', 'felt', 'ate', 'drove', 'wrote', 'spoke', 'sounds', 'always', 'usually', 'literally', 'apparently',
  'probably', 'definitely', 'gonna', 'been', 'and', 'or', 'also',
]);
/** Adverbs that say nothing alone: the next word decides ("just left" vs "just play"). */
const SOFT = new Set(['just', 'already', 'still', 'really']);
/** The word before a name at the end that makes it the object, not an address
 *  ("seen Adrian", "talking to Adrian", "where's Adrian"). */
const OBJECT_TAKERS = new Set([
  // prepositions, conjunctions, articles and possessives
  'to', 'with', 'for', 'at', 'about', 'from', 'of', 'by', 'like', 'than', 'as', 'on', 'in', 'into', 'onto', 'after', 'before', 'without', 'against',
  'near', 'behind', 'beside', 'except', 'unlike', 'including', 'vs', 'versus', 'and', 'or', 'nor', 'but', 'the', 'a', 'my', 'your', 'our', 'his',
  'her', 'their', 'this', 'that', 'no', 'not', 'named', 'called',
  // "is" and friends ("where's Adrian", "it was Adrian")
  'is', 's', 'was', 'are', 'were', 'be', 'been', 'being', 'am', 're',
  // verbs that take a person
  'ask', 'asked', 'tell', 'told', 'call', 'called', 'text', 'texted', 'message', 'messaged', 'invite', 'invited', 'see', 'saw', 'seen', 'meet', 'met',
  'know', 'knew', 'known', 'love', 'loves', 'hate', 'hates', 'likes', 'liked', 'mute', 'muted', 'unmute', 'kick', 'kicked', 'ban', 'banned', 'add',
  'added', 'tag', 'tagged', 'ping', 'pinged', 'beat', 'help', 'helped', 'blame', 'blamed', 'trust', 'believe', 'ignore', 'ignored', 'follow', 'kill',
  'killed', 'find', 'found', 'miss', 'missed', 'bring', 'brought', 'pick', 'picked', 'hear', 'heard', 'show', 'showed', 'pay', 'paid', 'owe', 'get',
  'got', 'thank', 'thanked', 'join', 'joined', 'carry', 'carried', 'marry', 'date', 'dated', 'visit', 'visited', 'wait', 'need', 'want', 'became',
  // game talk about a teammate ("can you heal Adrian", "did anyone rez Adrian")
  'heal', 'healed', 'healing', 'revive', 'revived', 'reviving', 'rez', 'rezzed', 'res', 'ressed', 'resurrect', 'downed', 'spectate', 'spectating',
  'rescue', 'rescued', 'protect', 'protected',
]);
/** After "how", these make a question ("how long", "how do I"); any other word
 *  with no helper verb later is an exclamation ("how lucky, Adrian!"). */
const HOW_ASKS = new Set([
  'do', 'does', 'did', 'is', 'are', 'was', 'were', 'am', 'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'have', 'has', 'had',
  's', 'much', 'many', 'long', 'far', 'old', 'often', 'come', 'about', 'to', 'soon', 'big', 'late', 'early', 'fast',
]);
const TIMES = /^(morning|evening|afternoon)$/;
/** How a question to her starts. The name at the end or after a lead-in only
 *  wakes her for a question: "nice shot, Adrian", "stop it, Adrian" and "wait,
 *  Adrian, come here" are said to a person called Adrian far more often. */
const QUESTION = new Set([
  'what', 'who', 'where', 'when', 'why', 'how', 'which', 'whose', 'is', 'are', 'am', 'was', 'were', 'can', 'could', 'will', 'would',
  'do', 'does', 'did', 'should', 'shall', 'have', 'has', 'may', 'might',
]);
const PAUSE = /^\s*[,.;:!?—–-]/;
const PAUSE_BEFORE = /[,.;:!?—–-]\s*$/;
const STRIP = /^[\s,.:;!?—–-]+/;

interface Word {
  w: string;
  start: number;
  end: number;
}
interface Hit {
  /** Index of the name's last word. */
  last: number;
  /** Text right after the name, punctuation included. */
  after: string;
  /** Opened by an everyday greeting ("good morning", "hey there", "excuse me"),
   *  said to friends as often as to her. */
  soft?: boolean;
}

function words(text: string): Word[] {
  const out: Word[] = [];
  const re = /[A-Za-zÀ-ÿ]+(?:[-][A-Za-zÀ-ÿ]+)*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

/** The words of what follows the name, contractions kept ("isn't"), with
 *  whether each was capitalized (a proper noun in ASR text). */
function lead(after: string, n: number): { w: string; cap: boolean }[] {
  const out: { w: string; cap: boolean }[] = [];
  const re = /[A-Za-zÀ-ÿ]+(?:['’][A-Za-z]+)?/g;
  for (let m = re.exec(after); m && out.length < n; m = re.exec(after)) out.push({ w: m[0].toLowerCase().replace('’', "'"), cap: /^[A-Z]/.test(m[0]) });
  return out;
}

/** Whether what follows the name talks about Adrian rather than to her:
 *  "Adrian is in the other channel", "Adrian will handle it", "Adrian built a
 *  wall". A pause right after the name ("Hey Adrian, was wondering ...") means
 *  she's being addressed, so it never counts as talk about her. */
export function talksAbout(after: string): boolean {
  if (PAUSE.test(after)) return false;
  const ws = lead(after, 2);
  if (ws[0] && SOFT.has(ws[0].w)) {
    // "just left", "already answered" vs "just play something", "still there?"
    const n = ws[1];
    return !!n && (ABOUT_WORDS.has(n.w) || /[^e]ed$/.test(n.w));
  }
  const [a, b] = ws;
  if (!a) return false;
  if (a.w === 'never') return b?.w !== 'mind';
  if (AUX.has(a.w)) return !b || !(SUBJECTS.has(b.w) || b.cap);
  if (HAS.has(a.w)) return !b || !HAS_SUBJECTS.has(b.w);
  // Not any "-ed" word: Parakeet often hears a request as past tense
  // ("Adrian, skip this song" comes out "Adrian skipped this song").
  return ABOUT_WORDS.has(a.w);
}

/** The older, coarser test for talk about her, still used where there was no
 *  greeting: any helper verb first, unless a pronoun follows ("is it", "will you"). */
function oldAbout(remainder: string): boolean {
  if (!ABOUT_IT.test(remainder)) return false;
  const [a, b] = lead(remainder, 2);
  return !(a && b && (AUX.has(a.w) || HAS.has(a.w) || a.w === 'does' || a.w === 'did') && PRONOUNS.has(b.w));
}

/** Helper verbs that ask what a person did or does ("did you eat", "has he
 *  left"): after the bare name the model judges these, as it always did.
 *  "Will you", "would you" and "is it" stay direct: they ask her for something. */
const PAST = new Set(['did', 'does', "didn't", "doesn't", 'has', 'had', 'was', "wasn't"]);
const PERSONAL = new Set(['you', 'he', 'she', 'they', 'we', 'i']);
function bareAbout(r: string): boolean {
  const [a, b] = lead(r, 2);
  return (!!a && !!b && PAST.has(a.w) && PERSONAL.has(b.w)) || oldAbout(r);
}

/** What she acts on without the model: a stop or a hold, or her name alone.
 *  The loose paths never let these through, so a stop said to a person called
 *  Adrian doesn't stop her music ("can you stop, Adrian?"). */
function actsAlone(r: string): boolean {
  if (!r.trim()) return true;
  const k = classify(r)?.kind;
  return k === 'stop' || k === 'name';
}

/** "What a shot", "what an idea", "how lucky": an exclamation, not a question.
 *  `ws` starts at the question word. */
function exclaims(ws: string[]): boolean {
  const [q, a] = ws;
  if (q === 'what') return a === 'a' || a === 'an';
  if (q !== 'how' || !a || HOW_ASKS.has(a)) return false;
  return !ws.slice(2).some((w) => AUX.has(w) || HAS.has(w) || w === 'do' || w === 'does' || w === 'did' || w === 's');
}

/** After an everyday greeting, she was clearly addressed: something only she
 *  does ("play Drake", "turn it up", "what time is it"). A question isn't
 *  enough: "morning Adrian, how was your weekend?" is said to a friend. */
function addressed(r: string): boolean {
  return !!classify(r) || !!classifyMusic(r) || isTimeQuestion(r);
}

/** "Adrian works there", "Adrian plays bass": a verb with a third-person "s"
 *  right after the name (no pause). Only where the wake is loose anyway:
 *  "thanks", "pass", "focus" don't count. */
function saysWhatHeDoes(after: string): boolean {
  if (PAUSE.test(after)) return false;
  const w = lead(after, 1)[0]?.w ?? '';
  return /^[a-z]{2,}[^su']s$/.test(w) && w !== 'thanks';
}

export class TextWakeDetector implements WakeDetector {
  private readonly names: Set<string>;
  private readonly greetings: Set<string>;
  private readonly allowBare: boolean;

  constructor(opts: TextWakeOptions = {}) {
    const name = (opts.name ?? 'adrian').toLowerCase();
    const builtIn = name === 'adrian' ? DEFAULT_VARIANTS : [];
    this.names = new Set([name, ...builtIn, ...(opts.nameVariants ?? [])]);
    this.greetings = new Set(opts.greetings ?? DEFAULT_GREETINGS);
    this.allowBare = opts.allowBareName ?? false;
  }

  /** The name starting at word i: the index of its last word, or -1. */
  private nameAt(ws: Word[], i: number, afterGreeting: boolean): number {
    const w0 = ws[i]?.w;
    const w1 = ws[i + 1]?.w;
    if (!w0) return -1;
    if (this.names.has(w0)) return i;
    // A bare "Hey Adrian." often comes out as "Hey Adrians." Only accepted
    // as the last word, so "hey adrians coming" still doesn't wake.
    if (w0.endsWith('s') && this.names.has(w0.slice(0, -1)) && i === ws.length - 1) return i;
    // The name split by ASR: "a drian", "a dren".
    if (w0 === 'a' && w1 && this.names.has(`a${w1}`)) return i + 1;
    // "heya drian" → hey + adrian
    if (afterGreeting && i > 0 && /^(heya|hey)$/.test(ws[i - 1]!.w) && this.names.has(`a${w0}`)) return i;
    return -1;
  }

  /** Greetings starting at word i ("hey", "hey hey", "hey there", "good
   *  morning", "excuse me"): the index after them, or i if there are none.
   *  A bare "morning" only opens the transcript: "this morning Adrian went" isn't one. */
  private greetingEnd(ws: Word[], i: number, first: boolean): { end: number; soft: boolean } {
    let j = i;
    if (ws[j]?.w === 'excuse' && ws[j + 1]?.w === 'me') return { end: j + 2, soft: true };
    if (ws[j]?.w === 'good' && TIMES.test(ws[j + 1]?.w ?? '')) return { end: j + 2, soft: true };
    if (first && TIMES.test(ws[j]?.w ?? '')) return { end: j + 1, soft: true };
    while (j < i + 2 && ws[j] && this.greetings.has(ws[j]!.w)) j++;
    if (j > i && ws[j]?.w === 'there' && /^(hey|hi|hello)$/.test(ws[j - 1]!.w)) return { end: j + 1, soft: true };
    return { end: j, soft: false };
  }

  /** Greeting + name at word i (fillers allowed first). With `bare`, the
   *  greeting may be missing. */
  private wakeAt(text: string, ws: Word[], i: number, bare: boolean): Hit | undefined {
    const first = i === 0;
    while (i < ws.length && FILLERS.has(ws[i]!.w)) i++;
    const { end: g, soft } = this.greetingEnd(ws, i, first);
    if (g === i && !bare) return undefined;
    const last = this.nameAt(ws, g, g > i);
    if (last < 0) return undefined;
    const after = text.slice(ws[last]!.end);
    if (CONTRACTION.test(after)) return undefined; // "Hey, Adrian's coming"
    return { last, after, ...(soft ? { soft } : {}) };
  }

  match(transcript: string): { woke: boolean; remainder: string } {
    const hit = this.wakeAt(transcript, words(transcript), 0, this.allowBare);
    const r = hit?.after.replace(STRIP, '').trim() ?? '';
    // "Good morning, Adrian!" is said to friends: only a request for her after it counts.
    if (!hit || (hit.soft && (actsAlone(r) || !addressed(r)))) return { woke: false, remainder: '' };
    return { woke: true, remainder: r };
  }

  matchLoose(transcript: string): { woke: boolean; remainder: string; loose: boolean } {
    const ws = words(transcript);
    const rest = (h: Hit) => h.after.replace(STRIP, '').trim();
    // "Hey Adrian, ...": a question to her, unless the words after her name
    // talk about her ("Hey, Adrian is in the other channel"), which the model judges.
    // An everyday greeting ("good morning", "hey there", "excuse me") is said
    // to friends as often as to her: with nothing after the name, or only a
    // stop, it doesn't wake her, and unless it asks what only she does, the model judges it.
    const soft = (h: Hit) => !!h.soft && !addressed(rest(h));
    const refused = (h: Hit) => !!h.soft && actsAlone(rest(h));
    const strict = this.wakeAt(transcript, ws, 0, this.allowBare);
    if (strict && !refused(strict)) return { woke: true, remainder: rest(strict), loose: talksAbout(strict.after) || soft(strict) };
    // The bare name first: "Adrian, what's the weather" is a question to it;
    // "Adrian is so slow" is talk about it, which the model may let pass.
    const bare = strict ? undefined : this.wakeAt(transcript, ws, 0, true);
    if (bare) {
      const r = rest(bare);
      return { woke: true, remainder: r, loose: bareAbout(r) || talksAbout(bare.after) }; // "Adrian?" alone answers "Yes?"
    }
    // The wake phrase later on: "yo wait, hey Adrian, what's ...".
    for (let i = 1; i < ws.length; i++) {
      const h = this.wakeAt(transcript, ws, i, false);
      if (h && !refused(h)) {
        const r = rest(h);
        return { woke: true, remainder: r, loose: bareAbout(r) || talksAbout(h.after) || soft(h) };
      }
    }
    // Everything below is loose: the model decides whether it was for her, and
    // only a question counts (see QUESTION).
    // The bare name after a lead-in ("wait, Adrian, what's the score", "alright
    // Adrian how long is left"), or after a pause and followed by one ("hold on
    // guys. Adrian, what time is it?"). Talk about her doesn't count.
    let led = true;
    for (let i = 1; i < ws.length; i++) {
      led &&= LEAD_INS.has(ws[i - 1]!.w) || this.greetings.has(ws[i - 1]!.w);
      if (!led && !PAUSE_BEFORE.test(transcript.slice(ws[i - 1]!.end, ws[i]!.start))) continue;
      const last = this.nameAt(ws, i, false);
      if (last < 0) continue;
      const after = transcript.slice(ws[last]!.end);
      const r = after.replace(STRIP, '').trim();
      // Not the name alone ("yeah, Adrian"), nor a list of names ("Marco, Adrian, and Sam").
      if (!r || !QUESTION.has((lead(r, 1)[0]?.w ?? '').replace(/'.*$/, '')) || /^(and|or)\b/i.test(r) || CONTRACTION.test(after) || talksAbout(after) || oldAbout(r) || saysWhatHeDoes(after) || (!led && !PAUSE.test(after))) continue;
      // Nor a stop ("wait, Adrian, can you stop?") or an exclamation ("wait, Adrian, what a shot").
      if (actsAlone(r) || exclaims(words(r).map((x) => x.w))) continue;
      return { woke: true, remainder: r, loose: true };
    }
    // The name at the end, as an address: "what is good, Adrian?", "can you
    // turn it down, Adrian". Not as the object: "have you seen Adrian", "talking to Adrian".
    // ASR often hangs an "s" on a final name ("Adrians", "Adrian's"): nothing follows, so it isn't a possessive.
    let n = ws.length - 1;
    if (n >= 1 && ws[n]!.w === 's' && /^['’]$/.test(transcript.slice(ws[n - 1]!.end, ws[n]!.start))) n--;
    const last = ws[n]?.w ?? '';
    const named = this.names.has(last) || (last.endsWith('s') && this.names.has(last.slice(0, -1)));
    const q = ws.slice(0, n).findIndex((x) => !LEAD_INS.has(x.w) && !this.greetings.has(x.w));
    const asks = q >= 0 && QUESTION.has(ws[q]!.w) && !exclaims(ws.slice(q, n).map((x) => x.w));
    if (n >= 1 && named && asks && !OBJECT_TAKERS.has(ws[n - 1]!.w)) {
      const before = transcript.slice(0, ws[n]!.start).replace(/[\s,.:;!?—–-]+$/, '').trim();
      // A stop said to a person called Adrian ("can you stop, Adrian?") isn't hers to act on.
      if (!actsAlone(before)) return { woke: true, remainder: before, loose: true };
    }
    return { woke: false, remainder: '', loose: false };
  }
}
