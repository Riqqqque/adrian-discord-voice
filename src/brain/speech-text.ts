// Turning streamed model text into speakable chunks.

/** Abbreviations whose trailing period does not end a sentence. */
const ABBREV = /\b(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|jr|sr|no|approx|u\.s|a\.m|p\.m)\.$/i;

export interface SplitterOptions {
  /** Emit the first chunk at a clause boundary (comma, dash, colon) once it
   *  has this many characters, so speech starts sooner. Unset: whole
   *  sentences only, which sounds far more natural (each chunk is spoken as
   *  a complete utterance) at the cost of a later start. */
  firstChunkMinChars?: number;
  /** Split any chunk longer than this at the last clause boundary. */
  maxChunkChars: number;
  /** If the first chunk reaches this length with no punctuation, cut it at
   *  a word boundary so speech can start. */
  firstChunkMaxChars?: number;
}

/** Incremental sentence splitter: push model deltas, get chunks to speak. */
export class SentenceSplitter {
  private buf = '';
  private emitted = 0;

  constructor(private readonly o: SplitterOptions = { maxChunkChars: 220 }) {}

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const chunk = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (chunk) {
        out.push(chunk);
        this.emitted++;
      }
    }
    return out;
  }

  /** End of stream: whatever is left. */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }

  private findCut(): number {
    const b = this.buf;
    // Chinese and Japanese end sentences with 。！？ and no space after.
    const cjk = /[。！？]+[」』）]?/.exec(b);
    if (cjk) return cjk.index + cjk[0].length;
    // Sentence end: . ! ? followed by whitespace (we need to see the space
    // to know "3.5" or "A.D.R.I.A.N." isn't over).
    const re = /[.!?]+["')\]]?\s/g;
    for (let m = re.exec(b); m; m = re.exec(b)) {
      const before = b.slice(0, m.index + 1);
      const end = m.index + m[0].length;
      if (ABBREV.test(before)) continue;
      const next = b.slice(end).trimStart()[0];
      if (/\b[A-Z]\.$/.test(before)) {
        // After an initial ("U.S.", "A.D.R.I.A.N."): need the next word to
        // decide. Wait for it; a lowercase word means the sentence goes on.
        if (next === undefined) return -1;
        if (/[a-z]/.test(next) || /^[A-Z]\./.test(b.slice(end).trimStart())) continue;
      } else if (next !== undefined && /[a-z]/.test(next)) {
        continue; // "e.g. this" style continuation
      }
      return end;
    }
    const clause = /[,;:—–]\s/g;
    if (this.emitted === 0 && this.o.firstChunkMinChars !== undefined && b.length >= this.o.firstChunkMinChars) {
      let last = -1;
      for (let m = clause.exec(b); m; m = clause.exec(b)) {
        if (m.index >= this.o.firstChunkMinChars! - 1) {
          last = m.index + m[0].length;
          break;
        }
      }
      if (last > 0) return last;
      const cap = this.o.firstChunkMaxChars;
      if (cap && b.length >= cap) {
        // First word break at or after the cap, so the chunk ends on a whole
        // word ("Well the forecast", not "Well the").
        const sp = b.indexOf(' ', cap);
        if (sp > 0 && sp <= cap + 12) return sp + 1;
        if (sp < 0 && b.length <= cap + 12) return -1; // wait for the word to end
        const back = b.lastIndexOf(' ', cap);
        if (back >= this.o.firstChunkMinChars!) return back + 1;
      }
    }
    if (b.length > this.o.maxChunkChars) {
      let last = -1;
      clause.lastIndex = 0;
      for (let m = clause.exec(b); m; m = clause.exec(b)) last = m.index + m[0].length;
      if (last > 0) return last;
      const sp = b.lastIndexOf(' ', this.o.maxChunkChars);
      if (sp > 0) return sp + 1;
    }
    return -1;
  }
}

/** Make model text safe and natural for TTS: no markdown, no URLs, the
 *  written name spoken as a word. */
export function toSpeakable(
  text: string,
  writtenName = 'A.D.R.I.A.N.',
  spokenName = 'Adrian',
  /** Other written → spoken words, e.g. a name TTS says wrong. Whole words only. */
  sayAs: readonly (readonly [string, string])[] = [],
): string {
  let t = text;
  t = t.split(writtenName).join(spokenName).split(writtenName.replace(/\.$/, '')).join(spokenName);
  for (const [w, s] of sayAs) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\b${esc}\\b`, 'g'), s);
  }
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // [text](link) → text
  t = t.replace(/https?:\/\/\S+/g, ' a link ');
  t = t.replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2');
  // Markers left unmatched because a chunk boundary fell inside them.
  t = t.replace(/\*+|~~|(^|\s)_+|_+(?=\s|$)/g, '$1');
  t = t.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, ''); // list markers
  t = t.replace(/^\s*#+\s*/gm, '');
  t = t.replace(/\.{2,}|…/g, '.'); // ellipses read badly
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
