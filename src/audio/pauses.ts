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
  if (/[?!]["')\]]?$/.test(t)) return 0.36;
  if (/[.]["')\]]?$/.test(t)) return 0.32;
  if (/[,;:—–-]$/.test(t)) return 0.16;
  return 0.08; // cut mid-phrase (very long sentence): barely a breath
}
