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

/** True for addresses that only mean something at home (or to this machine):
 *  private, loopback, link-local and CGNAT IPv4, localhost, home suffixes,
 *  and single-label names. */
function localHost(host: string): boolean {
  const h = host.toLowerCase();
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) {
    const [a, b] = [+ip[1]!, +ip[2]!];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === 'localhost' || !h.includes('.') || /\.(?:local|lan|home|internal|localdomain|localhost|home\.arpa)$/.test(h);
}

/** How a link is said: its site ("modrinth.com"), never the whole address,
 *  never an IP, a user name or a home address. */
function spokenLink(url: string): string {
  const rest = url.replace(/^https?:\/\//i, '');
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (authority.includes('@')) return 'a link'; // user name (and maybe a password) in it
  const host = authority.replace(/:\d*$/, '').replace(/^www\./i, '');
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) return 'a link'; // IPv6, non-ASCII, odd
  if (localHost(host)) return 'a local link';
  if (/^\d+(?:\.\d+)*$/.test(host)) return 'a link'; // a public IP: never read out
  return host;
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
  // A link: just the site's name ("modrinth.com"), not the whole address.
  // Punctuation, quotes and markup after it stay (linear: no backtracking).
  t = t.replace(/https?:\/\/\S+/gi, (m) => {
    const tail = /[.,!?;:)\]}'"`>*_~]+$/.exec(m)?.[0] ?? '';
    return spokenLink(m.slice(0, m.length - tail.length)) + tail;
  });
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
// Each rule is here because Kokoro + Parakeet heard the plain text wrong
// (bench/speech-words.mjs); things Kokoro already reads well (km, kg, lbs,
// "November 28", "5:00 PM", "2-3 days") are left alone.

const MONTH_ABBR: Record<string, string> = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', jun: 'June', jul: 'July', aug: 'August',
  sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, VI: 6, VII: 7, VIII: 8, IX: 9, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16 };
const ORDINAL_WORDS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth'];
/** Rulers' names: "Elizabeth II" is "Elizabeth the Second", not "Elizabeth 2". */
const REGNAL = 'Elizabeth|Henry|Charles|George|Edward|William|Louis|Richard|James|Leo|John|Paul|John Paul|Benedict|Pius|Gregory|Innocent|Clement|Urban|Philip|Frederick|Peter|Catherine|Alexander|Nicholas|Ivan|Mary|Victor Emmanuel|Felipe|Juan Carlos|Ramesses|Ptolemy|Napoleon|Wilhelm|Ludwig|Gustav|Haakon|Olav|Christian|Willem|Constantine|Justinian|Otto|Rudolf|Francis|Joseph|Leopold|Albert|Baudouin|Carlos|Alfonso|Sancho|Ferdinand|Isabella|Anne|Victoria|Stephen|Harold|David|Robert|Malcolm|Kenneth|Selim|Mehmed|Suleiman|Murad|Ahmed|Mahmud';
const REGNAL_RE = new RegExp(`\\b((?:(?:Queen|King|Pope|Prince|Princess|Emperor|Empress|Tsar|Czar|Sultan|Pharaoh|Kaiser|Shah) [A-Z][a-z]+)|${REGNAL}) (II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI)\\b(?![a-z'])`, 'g');
/** "km/h" is "kilometers per hour" (dropping the slash lost the "per"). */
const PER_UNITS: Record<string, string> = { 'km/h': 'kilometers per hour', 'm/s': 'meters per second', 'ft/s': 'feet per second', 'mi/h': 'miles per hour', 'km/s': 'kilometers per second' };
/** Words after "a/b" that make it a fraction, not a date ("by 3/5 of the vote"). */
const FRACTION_NEXT = /^\s+(?:to\s+\d{1,2}\/\d{1,2}\s+)?(?:of|a|an|the|cups?|teaspoons?|tablespoons?|tsp|tbsp|inch(?:es)?|miles?|pounds?|lbs?|oz|ounces?|majority|share|vote|chance)\b/i;
const FRACTIONS: Record<string, string> = { '1/2': 'half', '1/3': 'a third', '2/3': 'two thirds', '1/4': 'a quarter', '3/4': 'three quarters' };
/** Units said wrong after a number ("35 ms" as "M S", "6 ft" as "F T"): [singular, plural]. */
const UNITS: Record<string, [string, string]> = { ms: ['millisecond', 'milliseconds'], ft: ['foot', 'feet'], hz: ['hertz', 'hertz'] };

const DENOMINATORS: Record<number, [string, string]> = { 5: ['fifth', 'fifths'], 6: ['sixth', 'sixths'], 8: ['eighth', 'eighths'], 10: ['tenth', 'tenths'] };
/** "3/5" as "3 fifths" (simple fractions only: smaller over 5, 6, 8 or 10). */
function fraction(a: number, b: number): string | undefined {
  const d = DENOMINATORS[b];
  if (!d || a < 1 || a >= b) return undefined;
  return a === 1 ? `one ${d[0]}` : `${a} ${d[1]}`;
}

/** A weekday just before: "Fri, 11/21" and "Monday 2/6" are dates. */
const WEEKDAY_BEFORE = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\.?,?\s+$/i;
/** A score or odds just before: "won 3/1" is "3 to 1". */
const SCORE_BEFORE = /\b(?:won|lost|beat|beats|lead|leads|led|trail|trails|trailed|odds(?:\s+(?:of|are|at))?)\s+$/i;
/** What says "a/b" is a rating: "3/4 stars", "8/10 overall". */
const RATING_NEXT = /^\s*(?:stars?|rating|points?|overall)\b/i;

/** "a/b" as it is said. Only clear fractions are read as fractions ("3/4 of a
 *  cup", "1/2"); ratings ("4/5 stars", "7.8/10") are "out of", a score after
 *  "won" is "to", and a month/day pair is a date. */
function slash(m: string, a: string, b: string, before: string, after: string): string {
  const date = !a.includes('.') && !b.includes('.') && +a >= 1 && +a <= 12 && +b >= 1 && +b <= 31 ? `${MONTHS[+a - 1]} ${ordinal(+b)}` : undefined;
  if (a.includes('.') || b.includes('.')) return `${a} out of ${b}`;
  if (date && WEEKDAY_BEFORE.test(before)) return date;
  if (+a < +b && FRACTION_NEXT.test(after)) return FRACTIONS[m] ?? fraction(+a, +b) ?? m;
  if (SCORE_BEFORE.test(before)) return `${a} to ${b}`;
  if ((+b === 5 || +b === 10 || +b === 100 || RATING_NEXT.test(after)) && +a <= +b) return `${a} out of ${b}`;
  if (FRACTIONS[m]) return FRACTIONS[m];
  // "50/50"; "3/3" in a stat line is "3 for 3".
  if (a === b) return +a >= 13 ? `${a} ${b}` : `${a} for ${b}`;
  return date ?? fraction(+a, +b) ?? m;
}

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
  // Dates: "Nov 9" → "November 9th"; "on 11/21" → "on November 21st".
  t = t.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})(?![\d:.,]\d|st|nd|rd|th)\b/g, (m, mon: string, d: string) =>
    +d >= 1 && +d <= 31 ? `${MONTH_ABBR[mon.toLowerCase()]} ${ordinal(+d)}` : m,
  );
  t = t.replace(/\b(on|by|until|from|since|before|after|due|through|till)\s+(\d{1,2})\/(\d{1,2})(?![/\d])/gi, (m, w: string, a: string, b: string, at: number, all: string) => {
    // "cut it by 1/2" is a fraction, "on 1/2" a date; so is "by 3/5 of the
    // vote" and "from 1/2 to 3/4 of a cup".
    // ("on 11/21 the store opens" is still a date: only by/from/before/after are ambiguous.)
    if (/^(by|from|before|after)$/i.test(w) && FRACTION_NEXT.test(all.slice(at + m.length))) return m;
    const fraction = FRACTIONS[`${a}/${b}`] && !/^(on|until|since|through|till|due)$/i.test(w);
    return +a >= 1 && +a <= 12 && +b >= 1 && +b <= 31 && !fraction ? `${w} ${MONTHS[+a - 1]} ${ordinal(+b)}` : m;
  });
  // Clock-style durations: "00:04:10" and "1:30 left". A time of day with
  // seconds ("at 10:30:00", "3:15:20 PM") isn't one: on the hour it loses its
  // ":00" seconds, otherwise it's left as it is.
  t = t.replace(/(?<=\b(?:at|by|until|from|since|till|before|after)\s)(\d{1,2}):(\d\d):00\b/gi, '$1:$2');
  t = t.replace(/\b(\d{1,2}):(\d\d):00(?=\s?[AaPp]\.?[Mm]\b)/g, '$1:$2');
  t = t.replace(/(?<!\b(?:at|by|until|from|since|till|before|after)\s)\b(\d{1,2}):(\d\d):(\d\d)\b(?!\s?[AaPp]\.?[Mm]\b)/gi, (_, h: string, m: string, sec: string) => duration(+h, +m, +sec));
  t = t.replace(/\b(\d{1,2}):(\d\d)(?=\s+(?:left|remaining|to go)\b)/g, (_, m: string, sec: string) => duration(0, +m, +sec));
  t = t.replace(/\b0(\d):(\d\d)\b/g, '$1:$2'); // "07:00" → "7:00"
  // On the hour: "7:00" is read "seven zero zero".
  t = t.replace(/\b(\d{1,2}):00\b(?!\s?[AaPp]\.?[Mm]\b)/g, (m, h: string) => (+h >= 1 && +h <= 12 ? `${+h} o'clock` : m));
  t = t.replace(/\bS(\d{1,2})\s?E(\d{1,3})\b/g, (_, a: string, b: string) => `season ${+a} episode ${+b}`);
  // Temperatures: "72°F" is read "seventy two degrees F".
  t = t.replace(/(^|[\s(])[-−](\d+(?:\.\d+)?)\s?°/g, '$1minus $2°');
  t = t.replace(/(\d)\s?°\s?F\b/g, '$1 degrees');
  t = t.replace(/(\d)\s?°\s?C\b/g, '$1 degrees Celsius');
  t = t.replace(/(\d)\s?°/g, '$1 degrees');
  // Money the voices read backwards ("euros 20"). Cents only for exactly two
  // decimals; "€2.5 million" is "2.5 million euros".
  const money = (one: string, many: string) => (_: string, n: string, d: string | undefined, scale: string | undefined) => {
    if (scale) return `${n}${d ? `.${d}` : ''} ${scale.trim()} ${many}`;
    if (d !== undefined && d.length !== 2) return `${n}.${d} ${many}`;
    return `${n} ${n === '1' ? one : many}${d && d !== '00' ? ` ${d}` : ''}`;
  };
  // Commas only as thousands separators ("€20, or" keeps its comma), and an
  // amount run into letters ("£5m", "€20k", "£1.5bn") is left to the voice.
  const amount = String.raw`\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?!\w|[.,]\d)(\s(?:thousand|million|billion|trillion)\b)?`;
  t = t.replace(new RegExp(`€${amount}`, 'g'), money('euro', 'euros'));
  t = t.replace(new RegExp(`£${amount}`, 'g'), money('pound', 'pounds'));
  t = t.replace(/#(\d)/g, 'number $1');
  // Units after a number.
  t = t.replace(/\b(\d+(?:\.\d+)?)\s?(ms|ft|Hz)(?![\w/])/g, (m, n: string, u: string) => {
    const w = UNITS[u.toLowerCase()];
    return w ? `${n} ${plural(n, w)}` : m;
  });
  // Slashes: "50/50", "1/2 a cup", "4/5 stars", "Fri 11/21", "AC/DC" (read "slash").
  // Not inside a longer run ("11/21/2026", "1.2.3/4").
  t = t.replace(/(?<![\w.,/])(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?![\w/]|[.,]\d)/g, (m, a: string, b: string, at: number, all: string) => slash(m, a, b, all.slice(0, at), all.slice(at + m.length)));
  // "60km/h" has no word boundary before the unit.
  t = t.replace(/(?<=\d)(km|m|ft|mi)\/(h|s)\b/g, (m) => (PER_UNITS[m] ? ` ${PER_UNITS[m]}` : m));
  t = t.replace(/\b(km|m|ft|mi)\/(h|s)\b/g, (m) => PER_UNITS[m] ?? m);
  // Only names in capitals ("AC/DC", "TCP/IP") and "and/or"; "w/o" is left to the voice.
  t = t.replace(/\b([A-Z]{2,})\/([A-Z]{2,})\b/g, '$1 $2');
  t = t.replace(/\band\/or\b/g, 'and or');
  // Abbreviations read as letters or words: "St." Mary's, "approx.", "Pt. 2".
  // "St." before a name is Saint, but after one ("Main St.") or a number ("5th St.") it's Street.
  t = t.replace(/(?<!\b[A-Z][a-z]*\s|\d(?:st|nd|rd|th)?\s)\bSt\.\s(?=[A-Z][a-z])/g, 'Saint ');
  t = t.replace(/\bapprox\.?(?=\s)/gi, 'approximately');
  t = t.replace(/\bPt\.?\s?(\d)/g, 'Part $1');
  t = t.replace(/\bvs\.?(?=\s)/g, 'versus'); // read "V S"
  // Rulers first: "Queen Elizabeth II" is "Queen Elizabeth the Second".
  t = t.replace(REGNAL_RE, (_, w: string, r: string) => `${w} the ${ORDINAL_WORDS[ROMAN[r]!]}`);
  // "Hades II" is read "Hades Roman two".
  t = t.replace(/\b([A-Z][a-z]+) (II|III|IV|VI|VII|VIII|IX|XI|XII|XIII|XIV|XV|XVI)\b(?![a-z'])/g, (_, w: string, r: string) => `${w} ${ROMAN[r]}`);
  return t;
}
