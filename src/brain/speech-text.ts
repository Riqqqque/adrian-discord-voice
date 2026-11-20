// Turning streamed model text into speakable chunks.

/** Abbreviations whose trailing period does not end a sentence. */
const ABBREV = /\b(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|jr|sr|approx|u\.s|a\.m|p\.m|pt|vol|ep|feat|fig|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.$/i;
/** Abbreviations that only go on with a number: "No. 5", but "No. It closes at nine." ends. */
const NUMBERED = /\b(?:no|nos)\.$/i;

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
      if (NUMBERED.test(before)) {
        if (next === undefined) return -1; // wait for the next word
        if (/\d/.test(next)) continue;
      }
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

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

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
  // A bare link: just the site's name ("modrinth.com"), not the whole address.
  t = t.replace(/https?:\/\/(?:www\.)?([a-z0-9.-]*[a-z0-9])(?:[/?#]\S*?)?(?=[.,!?;:)\]]*(?:\s|$))/gi, '$1');
  t = t.replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2');
  // Markers left unmatched because a chunk boundary fell inside them.
  t = t.replace(/\*+|~~|(^|\s)_+|_+(?=\s|$)/g, '$1');
  t = t.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, ''); // list markers
  t = t.replace(/^\s*#{1,6}\s+/gm, ''); // headings ("#1" is a number)
  t = t.replace(/\.{2,}|…/g, '.'); // ellipses read badly
  // Emoji: the voices read their names out ("face with tears of joy").
  t = t.replace(EMOJI, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// --- English text the voices misread --------------------------------------
// Applied by the English voices themselves (Kokoro us/gb, Speechify), so tool
// lines, fixed lines and model text all get it, and other languages never do.
// Each rule is here because Kokoro + Parakeet showed the plain text misheard
// (bench/speech-words.mjs).

const MONTH_ABBR: Record<string, string> = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', jun: 'June', jul: 'July', aug: 'August',
  sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, VI: 6, VII: 7, VIII: 8, IX: 9, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16 };
const FRACTIONS: Record<string, string> = { '1/2': 'half', '1/3': 'a third', '2/3': 'two thirds', '1/4': 'a quarter', '3/4': 'three quarters' };
/** Units said wrong after a number ("35 ms" as "M S"): [singular, plural]. */
const UNITS: Record<string, [string, string]> = {
  ms: ['millisecond', 'milliseconds'], ft: ['foot', 'feet'], hz: ['hertz', 'hertz'], khz: ['kilohertz', 'kilohertz'],
  mhz: ['megahertz', 'megahertz'], ghz: ['gigahertz', 'gigahertz'], 'km/h': ['kilometer per hour', 'kilometers per hour'],
  km: ['kilometer', 'kilometers'], kg: ['kilogram', 'kilograms'], lb: ['pound', 'pounds'], lbs: ['pound', 'pounds'],
  min: ['minute', 'minutes'], mins: ['minute', 'minutes'], hr: ['hour', 'hours'], hrs: ['hour', 'hours'], sec: ['second', 'seconds'], secs: ['second', 'seconds'],
};

export function ordinal(n: number): string {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
}

const plural = (n: string, [one, many]: [string, string]) => (n === '1' ? one : many);

/** "4 minutes 10 seconds" from hours, minutes, seconds (zeros left out). */
function duration(h: number, m: number, sec: number): string {
  const parts: string[] = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (sec || !parts.length) parts.push(`${sec} ${sec === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

/** English text rewritten the way it is said, for the English voices. Text
 *  that is already in words comes back unchanged, so applying it twice is
 *  harmless. */
export function forSpeech(text: string): string {
  let t = text;
  // Dates: "Nov 9" / "November 28" → "November 9th"; "on 11/21" → "on November 21st".
  t = t.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})(?![\d:.,]\d|st|nd|rd|th)\b/g, (m, mon: string, d: string) =>
    +d >= 1 && +d <= 31 ? `${MONTH_ABBR[mon.toLowerCase()]} ${ordinal(+d)}` : m,
  );
  t = t.replace(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?![\\d:.]\\d|st|nd|rd|th)\\b`, 'g'), (m, mon: string, d: string) => (+d >= 1 && +d <= 31 ? `${mon} ${ordinal(+d)}` : m));
  t = t.replace(/\b(on|by|until|from|since|before|after|due|through|till)\s+(\d{1,2})\/(\d{1,2})(?![/\d])/gi, (m, w: string, a: string, b: string) =>
    +a >= 1 && +a <= 12 && +b >= 1 && +b <= 31 ? `${w} ${MONTHS[+a - 1]} ${ordinal(+b)}` : m,
  );
  // Clock-style durations: "00:04:10" and "1:30 left".
  t = t.replace(/\b(\d{1,2}):(\d\d):(\d\d)\b/g, (_, h: string, m: string, sec: string) => duration(+h, +m, +sec));
  t = t.replace(/\b(\d{1,2}):(\d\d)(?=\s+(?:left|remaining|to go)\b)/g, (_, m: string, sec: string) => duration(0, +m, +sec));
  t = t.replace(/\b0(\d):(\d\d)\b/g, '$1:$2'); // "07:00" → "7:00"
  // On the hour: "7:00" is read "seven zero zero".
  t = t.replace(/\b(\d{1,2}):00(?=\s?[AaPp]\.?[Mm]\b)\s?/g, '$1 ');
  t = t.replace(/\b(\d{1,2}):00\b/g, (m, h: string) => (+h >= 1 && +h <= 12 ? `${+h} o'clock` : m));
  t = t.replace(/\bS(\d{1,2})\s?E(\d{1,3})\b/g, (_, a: string, b: string) => `season ${+a} episode ${+b}`);
  // Temperatures: "72°F" is read "seventy two degrees F".
  t = t.replace(/(^|[\s(])[-−](\d+(?:\.\d+)?)\s?°/g, '$1minus $2°');
  t = t.replace(/(\d)\s?°\s?F\b/g, '$1 degrees');
  t = t.replace(/(\d)\s?°\s?C\b/g, '$1 degrees Celsius');
  t = t.replace(/(\d)\s?°/g, '$1 degrees');
  // Money the voices read backwards ("euros 20").
  t = t.replace(/€\s?(\d[\d,]*)(?:\.(\d\d))?\b/g, (_, n: string, c?: string) => `${n} ${n === '1' ? 'euro' : 'euros'}${c && c !== '00' ? ` ${c}` : ''}`);
  t = t.replace(/£\s?(\d[\d,]*)(?:\.(\d\d))?\b/g, (_, n: string, c?: string) => `${n} ${n === '1' ? 'pound' : 'pounds'}${c && c !== '00' ? ` ${c}` : ''}`);
  t = t.replace(/#(\d)/g, 'number $1');
  // Units after a number.
  t = t.replace(/\b(\d+(?:\.\d+)?)\s?(ms|ft|[kMG]?Hz|km\/h|km|kg|lbs?|mins?|hrs?|secs?)(?![\w/])/g, (m, n: string, u: string) => {
    const w = UNITS[u.toLowerCase()];
    return w ? `${n} ${plural(n, w)}` : m;
  });
  // Slashes: "50/50", "1/2 a cup", "AC/DC" (read "slash").
  t = t.replace(/\b(\d+)\/(\d+)\b(?!\/)/g, (m, a: string, b: string) => (a === b ? `${a} ${b}` : (FRACTIONS[m] ?? m)));
  t = t.replace(/\bw\/\s?/g, 'with ');
  t = t.replace(/\b([A-Za-z]+)\/([A-Za-z]+)\b/g, '$1 $2');
  // Abbreviations read as letters or words: "St." Mary's, "approx.", "Pt. 2".
  // "St." before a name is Saint, but after one ("Main St.") it's Street.
  t = t.replace(/(?<!\b[A-Z][a-z]*\s)\bSt\.\s(?=[A-Z][a-z])/g, 'Saint ');
  t = t.replace(/\bapprox\.?(?=\s)/gi, 'approximately');
  t = t.replace(/\bPt\.?\s?(\d)/g, 'Part $1');
  t = t.replace(/\bvs\.?(?=\s)/g, 'versus'); // read "V S"
  // "Hades II" is read "Hades Roman two".
  t = t.replace(/\b([A-Z][a-z]+) (II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI)\b(?![a-z'])/g, (_, w: string, r: string) => `${w} ${ROMAN[r]}`);
  return t;
}
