// Which language someone is speaking, and how to answer in it.

import { readFileSync } from 'node:fs';

export type ReplyLang = 'en' | 'es' | 'zh' | 'ja' | 'vi';

export interface LangInfo {
  name: string;
  /** Default voice for this language. */
  voice: string;
  /** Extra instruction for the model when replying in it. */
  prompt: string;
}

export const LANGS: Record<ReplyLang, LangInfo> = {
  en: { name: 'English', voice: 'af_heart', prompt: 'Reply in English (they are speaking English now, even if earlier messages were in another language).' },
  es: { name: 'Spanish', voice: 'ef_dora', prompt: 'Reply in Spanish.' },
  zh: { name: 'Chinese', voice: 'zf_xiaobei', prompt: 'Reply in Simplified Chinese (Mandarin).' },
  ja: {
    name: 'Japanese',
    voice: 'jf_alpha',
    prompt:
      'Reply in Japanese, written ONLY in hiragana and katakana with spaces between phrases: no kanji at all, because the voice cannot read kanji.',
  },
  vi: { name: 'Vietnamese', voice: 'vi_piper', prompt: 'Reply in Vietnamese with full diacritics.' },
};

/** Whisper language code → a language A.D.R.I.A.N. can speak (else English). */
export function replyLang(code: string): ReplyLang {
  const c = code.toLowerCase().slice(0, 2);
  return (['en', 'es', 'zh', 'ja', 'vi'] as const).find((l) => l === c) ?? 'en';
}

const SPANISH = new Set(['que', 'qué', 'el', 'la', 'los', 'las', 'de', 'del', 'es', 'en', 'por', 'para', 'como', 'cómo', 'cual', 'cuál', 'donde', 'dónde', 'cuando', 'cuándo', 'hoy', 'un', 'una', 'mi', 'tu', 'pon', 'dime', 'cuanto', 'cuánto', 'hace', 'tiempo', 'hora', 'está', 'esta', 'son', 'muy', 'pero', 'sí', 'también']);

/** Clearly Spanish? Parakeet transcribes Spanish well, so no second pass is needed. */
export function looksSpanish(text: string): boolean {
  if (/[¿¡ñ]/i.test(text)) return true;
  const ws = text.toLowerCase().match(/[a-záéíóúüñ]+/g) ?? [];
  return ws.length >= 3 && ws.filter((w) => SPANISH.has(w)).length >= 2;
}

/** Drop a leading greeting + name that a second pass heard as something else
 *  ("Này, Dinh, ..." → "..."), when the first pass already caught the wake. */
export function stripWakeLead(text: string): string {
  const m = /^[^,，、。.!?！？]{0,24}[,，、]\s*/.exec(text);
  return m && m[0].trim().split(/\s+/).length <= 4 ? text.slice(m[0].length).trim() : text;
}

/** Words of the English lexicon, to tell whether a transcript is English. */
/** English grammar words that aren't also common Spanish or Vietnamese
 *  syllables ("a", "no", "me", "he", "an", "do", "to" are left out). */
const ENGLISH_GRAMMAR = new Set(
  ('the is are was were be been does did can could would will should what whats how why who whos where when which you your ' +
    "you're my i i'm im it's its this that these those of and or in on for with at from about is isn't don't doesn't can't won't " +
    'we us our they them their there here just like if but have has got get gonna wanna please tell give play put some any').split(' '),
);

export class EnglishWords {
  private readonly words: Set<string>;

  constructor(lexiconFile?: string) {
    // Chat words the pronunciation lexicon lacks.
    this.words = new Set(['lol', 'lmao', 'gg', 'xd', 'bro', 'ty', 'thx', 'pls', 'omg', 'wtf', 'idk', 'tbh', 'ngl', 'afk', 'brb']);
    if (!lexiconFile) return;
    try {
      for (const line of readFileSync(lexiconFile, 'utf8').split('\n')) {
        const w = line.slice(0, line.indexOf(' ')).toLowerCase();
        if (w) this.words.add(w);
      }
    } catch {
      /* no lexicon: everything counts as English */
    }
  }

  get size(): number {
    return this.words.size;
  }

  /** Mostly English words (or too short to tell)? Non-Latin script → no. */
  looksEnglish(text: string): boolean {
    if (/[぀-ヿ㐀-鿿가-힯]/.test(text)) return false; // CJK, kana, Hangul
    if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return false; // Vietnamese marks
    if (/[ñ¿¡]/i.test(text)) return false;
    const all = text.toLowerCase().match(/[a-z']+/g) ?? [];
    if (!all.length || !this.words.size) return true;
    // After "play"/"queue" comes a song or artist name: judge the rest.
    const cut = all.findIndex((w) => w === 'play' || w === 'queue');
    const ws = cut >= 0 ? all.slice(0, cut + 1) : all;
    const known = ws.filter((w) => this.words.has(w) || this.words.has(w.replace(/'s$/, ''))).length;
    // Short: every word must be English ("Shizong." is Chinese misheard).
    if (ws.length < 3) return known === ws.length;
    if (known / ws.length >= 0.7) return true;
    // Names, slang and game words aren't in the lexicon, but real English
    // still has its grammar words; misheard Chinese/Japanese/Vietnamese
    // doesn't.
    const grammar = ws.filter((w) => ENGLISH_GRAMMAR.has(w)).length;
    return grammar >= 2 && known / ws.length >= 0.5;
  }
}
