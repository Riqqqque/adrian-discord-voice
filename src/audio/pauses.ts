// Joining separately synthesized chunks so they sound like one answer:
// Kokoro pads each utterance with silence of varying length, so trim it and
// put back a pause that fits the punctuation.

/** Drop leading/trailing near-silence (below -45 dBFS in 10 ms windows),
 *  keeping a 15 ms margin so word onsets and tails aren't clipped. */
export function trimSilence(x: Float32Array, rate: number): Float32Array {
  const win = Math.max(1, Math.round(rate / 100));
  const thr = 10 ** (-45 / 20);
  const loud = (i: number) => {
    let s = 0;
    const end = Math.min(x.length, i + win);
    for (let j = i; j < end; j++) s += x[j]! * x[j]!;
    return Math.sqrt(s / win) > thr;
  };
  let a = 0;
  while (a < x.length && !loud(a)) a += win;
  if (a >= x.length) return x.subarray(0, 0);
  let b = x.length - win;
  while (b > a && !loud(b)) b -= win;
  const m = Math.round(rate * 0.015);
  return x.subarray(Math.max(0, a - m), Math.min(x.length, b + win + m));
}

/** Seconds of silence to put after a chunk that ends with this text. */
export function pauseAfter(text: string): number {
  const t = text.trimEnd();
  // Shorter since 2026-11-08: the longer ones made her sound slow between sentences.
  if (/[?!]["')\]]?$/.test(t)) return 0.26;
  if (/[.]["')\]]?$/.test(t)) return 0.22;
  if (/[,;:—–-]$/.test(t)) return 0.12;
  return 0.06; // cut mid-phrase (very long sentence): barely a breath
}

/** trimSilence for audio that arrives in pieces: leading near-silence is
 *  dropped, quiet stretches are held until more sound follows them, and at
 *  end() only the margin of the trailing quiet is kept. Windows are counted
 *  from the start, so the tail can differ from trimSilence by under 10 ms. */
export class StreamTrimmer {
  private readonly win: number;
  private readonly thr: number;
  private readonly margin: number;
  /** Samples not yet judged (less than a window). */
  private part = new Float32Array(0);
  /** Quiet since the last sound (or before the first), not yet given out. */
  private quiet: Float32Array[] = [];
  private quietLen = 0;
  private started = false;

  constructor(rate: number) {
    this.win = Math.max(1, Math.round(rate / 100));
    this.thr = 10 ** (-45 / 20);
    this.margin = Math.round(rate * 0.015);
  }

  /** True once some sound has come out. */
  get heard(): boolean {
    return this.started;
  }

  push(x: Float32Array): Float32Array {
    const all = new Float32Array(this.part.length + x.length);
    all.set(this.part);
    all.set(x, this.part.length);
    const out: Float32Array[] = [];
    let i = 0;
    for (; i + this.win <= all.length; i += this.win) this.window(all.subarray(i, i + this.win), out);
    this.part = all.slice(i);
    return concat(out);
  }

  end(): Float32Array {
    const out: Float32Array[] = [];
    if (this.part.length) this.window(this.part, out);
    this.part = new Float32Array(0);
    if (this.started) out.push(concat(this.quiet).subarray(0, this.margin));
    this.quiet = [];
    this.quietLen = 0;
    return concat(out);
  }

  private window(w: Float32Array, out: Float32Array[]): void {
    let s = 0;
    for (let j = 0; j < w.length; j++) s += w[j]! * w[j]!;
    if (Math.sqrt(s / this.win) <= this.thr) {
      this.quiet.push(w);
      this.quietLen += w.length;
      if (!this.started && this.quietLen > this.margin * 4) {
        // Before the first sound only the last margin's worth matters.
        const q = concat(this.quiet);
        this.quiet = [q.slice(q.length - this.margin)];
        this.quietLen = this.margin;
      }
      return;
    }
    const q = concat(this.quiet);
    out.push(this.started ? q : q.subarray(Math.max(0, q.length - this.margin)), w);
    this.quiet = [];
    this.quietLen = 0;
    this.started = true;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
