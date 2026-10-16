// Text-based wake detection: the transcript must START with the wake phrase
// ("hey adrian", with tolerant greetings and ASR spellings of the name).
// Acoustic wake words can't tell "Hey Adrian" from people talking to a
// friend named Adrian, so this check is the authority.

import type { WakeDetector } from '../core/interfaces.js';

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
const DEFAULT_GREETINGS = ['hey', 'hi', 'hay', 'okay', 'ok', 'k', 'yo', 'hello', 'heya', 'hiya', 'hola', 'oye', 'ola', 'chào', 'chao', 'ê', 'này'];
/** Spellings Parakeet and other ASR produce for "Adrian". */
const DEFAULT_VARIANTS = [
  'adrien', 'adriane', 'adrean', 'adreon', 'adrion', 'adryan', 'aidrian', 'adriaan', 'adrain', 'edrian', 'adrián', 'adriàn',
];
/** Fillers allowed before the greeting. */
const FILLERS = new Set(['um', 'uh', 'erm', 'hmm', 'so', 'oh', 'ah', 'xin', 'eh']);
/** "Adrian's", "Adrian'll" etc. talk ABOUT someone, not TO the bot. */
const CONTRACTION = /^['’](s|ll|d|re|ve|m)\b/;
/** After the bare name: words that mean talk about the bot ("Adrian is so slow"). */
const ABOUT_IT = /^(is|was|isn'?t|wasn'?t|has|had|did|does|doesn'?t|didn'?t|said|says|keeps|always|never|just|be|been|will|would|won'?t|can'?t|sounds|said)\b/i;

export class TextWakeDetector implements WakeDetector {
  private readonly names: Set<string>;
  private readonly greetings: Set<string>;
  private readonly allowBare: boolean;

  private readonly opts: TextWakeOptions;
  private bare: TextWakeDetector | undefined;

  constructor(opts: TextWakeOptions = {}) {
    this.opts = opts;
    const name = (opts.name ?? 'adrian').toLowerCase();
    const builtIn = name === 'adrian' ? DEFAULT_VARIANTS : [];
    this.names = new Set([name, ...builtIn, ...(opts.nameVariants ?? [])]);
    this.greetings = new Set(opts.greetings ?? DEFAULT_GREETINGS);
    this.allowBare = opts.allowBareName ?? false;
  }

  match(transcript: string): { woke: boolean; remainder: string } {
    const no = { woke: false, remainder: '' };
    // Tokenize while remembering where each word ends in the original text,
    // so the remainder keeps the user's wording and punctuation.
    const words: { w: string; end: number }[] = [];
    const re = /[A-Za-zÀ-ÿ]+(?:[-][A-Za-zÀ-ÿ]+)*/g;
    for (let m = re.exec(transcript); m; m = re.exec(transcript)) {
      words.push({ w: m[0].toLowerCase(), end: m.index + m[0].length });
    }
    let i = 0;
    while (i < words.length && FILLERS.has(words[i]!.w)) i++;

    let greeted = false;
    if (i < words.length && this.greetings.has(words[i]!.w)) {
      greeted = true;
      i++;
    }
    if (!greeted && !this.allowBare) return no;

    // The name, possibly split by ASR: "a drian", "a dren".
    let nameEnd: number | undefined;
    const w0 = words[i]?.w;
    const w1 = words[i + 1]?.w;
    if (w0 && this.names.has(w0)) {
      nameEnd = words[i]!.end;
    } else if (w0 && w0.endsWith('s') && this.names.has(w0.slice(0, -1)) && i === words.length - 1) {
      // A bare "Hey Adrian." often comes out as "Hey Adrians." Only accepted
      // as the last word, so "hey adrians coming" still doesn't wake.
      nameEnd = words[i]!.end;
    } else if (w0 === 'a' && w1 && this.names.has(`a${w1}`)) {
      nameEnd = words[i + 1]!.end;
    } else if (greeted && w0 && /^(heya|hey)$/.test(words[i - 1]!.w) && this.names.has(`a${w0}`)) {
      // "heya drian" → hey + adrian
      nameEnd = words[i]!.end;
    }
    if (nameEnd === undefined) return no;

    const after = transcript.slice(nameEnd);
    if (CONTRACTION.test(after)) return no; // "Hey, Adrian's coming"
    const remainder = after.replace(/^[\s,.:;!?—–-]+/, '').trim();
    return { woke: true, remainder };
  }

  matchLoose(transcript: string): { woke: boolean; remainder: string; loose: boolean } {
    const strict = this.match(transcript);
    if (strict.woke) return { ...strict, loose: false };
    // The bare name first: "Adrian, what's the weather".
    this.bare ??= this.allowBare ? this : new TextWakeDetector({ ...this.opts, allowBareName: true });
    const b = this.bare.match(transcript);
    // "Adrian, what's the weather" is a question to it; "Adrian is so slow"
    // is talk about it, which the model may let pass.
    if (b.woke) return { ...b, loose: ABOUT_IT.test(b.remainder) }; // "Adrian?" alone answers "Yes?"
    // The wake phrase later on: "yo wait, hey Adrian, what's ...".
    const re = /[A-Za-zÀ-ÿ]+/g;
    for (let m = re.exec(transcript); m; m = re.exec(transcript)) {
      if (m.index === 0) continue;
      const r = this.match(transcript.slice(m.index));
      if (r.woke) return { ...r, loose: ABOUT_IT.test(r.remainder) };
    }
    return { woke: false, remainder: '', loose: false };
  }
}
