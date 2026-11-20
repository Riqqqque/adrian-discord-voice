// Speechify cloud voice (Simba, English), with a local voice as the
// automatic fallback: used when the monthly character budget is spent, the
// key is missing, or the API is slow or failing. Audio is fetched from the
// streaming endpoint as raw 24 kHz PCM, then leveled like the local voices.
// Sentences longer than the cached short lines play as their bytes arrive
// (first audio ~0.1 s after the request instead of the ~0.3 s the whole
// sentence takes). A streamed sentence gets the same cap on hot sentences as
// levelChunk (StreamCap): its first CAP_FREE_S play at once, the rest waits
// for the whole sentence, which arrives about 30 times faster than it plays.
//
// The local voice loads only when needed (see app/local-voice.ts). At the
// first sign of trouble (a slow or failed request, a failed warm-up, the
// month's characters nearly spent) it starts loading in the background, so
// it's ready by the time a sentence has to fall back.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dateFormat } from '../core/time.js';
import { dirname } from 'node:path';
import type { SpeechPiece, TextToSpeech } from '../core/interfaces.js';
import { integratedLoudness, StreamCap } from '../audio/loudness.js';
import { CEILING_DB, levelChunk, MAX_OVER_LU, TARGET_LUFS } from './kokoro.js';
import { forSpeech } from '../brain/speech-text.js';

const API = 'https://api.speechify.ai/v1/audio/stream';
const RATE = 24_000;
/** Lines up to this long are cached in memory. */
const SHORT = 40;
const CALIBRATION = "Sure, here's what I found. It's seventy two degrees and clear right now. The capital of Australia is Canberra.";
/** After this long without a call the next sentence may stall. */
const WARM_IDLE_MS = 30 * 60_000;
const WARM_TIMEOUT_MS = 4_000;
/** All a warm-up says: every character counts toward the month. */
const WARM_TEXT = 'Hi.';
/** No audio for this long (first bytes, or between pieces): the local voice
 *  starts loading in case this sentence or the next has to fall back. Each
 *  load keeps 0.5 GB for good, so this sits above the slowest normal answer:
 *  in a month of production (119 answers, whole-sentence time before
 *  streaming) p99 was 1.79 s and the slowest 1.85 s; streamed first audio
 *  is 0.2-0.3 s. Still 2 s ahead of the 4 s timeout. */
export const SLOW_MS = 2_000;
/** Mid-sentence, a gap longer than this ends the sentence: by then the
 *  listener hears it as broken, and cutting lets the next sentence start
 *  (in the local voice, which starts loading then if it hasn't yet). The wait for the
 *  first bytes keeps the full timeoutMs: nothing has been heard yet. */
export const STALL_MS = 2_000;
/** Audio of a streamed sentence that plays at once at the calibrated gain, s.
 *  More than the Speaker's 0.2 s opening plus the ~20 ms of lead silence it
 *  trims, so first audio is as early as without the cap. */
export const CAP_FREE_S = 0.6;
/** When the held rest of a sentence is due, ms after its first audio went out:
 *  CAP_FREE_S less the mixer's 160 ms lead and a 140 ms margin. Measured, the
 *  whole sentence is in 105-140 ms after its first piece; if it isn't by
 *  then, the rest plays uncapped, as streaming did before the cap. */
export const CAP_DUE_MS = 300;
/** Fewer characters than this left in the month: load the local voice ahead of the switch. */
export const LOW_CHARS = 10_000;

export class SpeechifyError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`speechify HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
}

/** fetch reports a broken connection as a TypeError caused by the socket
 *  error. Timeouts and aborts are DOMExceptions; a bad request has no cause. */
const connectionBroke = (e: unknown) => e instanceof TypeError && e.cause !== undefined;

/** Characters spoken per calendar month (household timezone), persisted. */
export class CharBudget {
  private data: { version: 1; months: Record<string, number> } = { version: 1, months: {} };
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly file: string | undefined,
    private readonly monthlyChars: number,
    private readonly timezone: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const d = JSON.parse(readFileSync(file, 'utf8')) as typeof this.data;
      if (d?.version === 1 && d.months) this.data = d;
    } catch {
      /* first run */
    }
  }

  private month(): string {
    return dateFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit' }).format(this.now()).slice(0, 7);
  }

  used(): number {
    return this.data.months[this.month()] ?? 0;
  }

  /** Characters left this month (Infinity when unlimited). */
  left(): number {
    return this.monthlyChars === 0 ? Infinity : Math.max(0, this.monthlyChars - this.used());
  }

  /** True while this many more characters fit in the month (0 = unlimited). */
  allows(chars: number): boolean {
    return this.monthlyChars === 0 || this.used() + chars <= this.monthlyChars;
  }

  add(chars: number): void {
    const m = this.month();
    this.data.months[m] = (this.data.months[m] ?? 0) + chars;
    if (this.file && !this.saveTimer) this.saveTimer = setTimeout(() => this.flush(), 5_000);
  }

  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), { mode: 0o640 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Raw 16-bit little-endian PCM to float. */
export function pcm16ToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text at normal speed; SSML prosody rate otherwise. */
export function speechInput(text: string, speed: number): string {
  if (Math.abs(speed - 1) < 0.01) return text;
  const pct = Math.round((speed - 1) * 100);
  return `<speak><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${escapeXml(text)}</prosody></speak>`;
}

export interface SpeechifyOptions {
  apiKey: string;
  voiceId: string;
  model: string;
  /** Longest wait for one sentence before falling back, ms. */
  timeoutMs: number;
  /** Speaking rate on top of the speed each call asks for. Default 1. */
  speed?: number;
  budget: CharBudget;
  log: { info(m: string, f?: object): void; warn(m: string, f?: object): void };
  fetch?: typeof fetch;
  now?: () => number;
}

export class SpeechifyTts implements TextToSpeech {
  private gain: Promise<number> | undefined;
  /** After a failure, skip the API until this time. */
  private pausedUntil = 0;
  private budgetNoted = false;
  /** When raw() last went to the API. */
  private lastCall = -Infinity;
  private readonly short = new Map<string, Float32Array>();
  /** Set once the local voice was asked to load ahead of need. */
  private fallbackWarming = false;
  /** The speed sentences were last asked for (the local voice calibrates per speed). */
  private speed = 1;

  constructor(
    private readonly o: SpeechifyOptions,
    /** Local engine and voice used whenever the cloud voice can't be. */
    private readonly fallback: TextToSpeech,
    private readonly fallbackVoice: string,
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Start loading the local voice in the background, once: a sentence may
   *  soon need it. Costs its memory (about 0.5 GB) from then on. */
  private warmFallback(why: string): void {
    const f = this.fallback as TextToSpeech & { prepare?(voice: string, speed: number): Promise<void> };
    if (this.fallbackWarming || !f.prepare) return;
    this.fallbackWarming = true;
    const t = performance.now();
    this.o.log.info('loading the local voice in case the cloud voice fails', { why });
    f.prepare(this.fallbackVoice, this.speed).then(
      () => this.o.log.info('local voice ready', { ms: Math.round(performance.now() - t) }),
      (e: Error) => {
        this.fallbackWarming = false; // the next sign of trouble tries again
        this.o.log.warn('local voice failed to load', { error: e.message });
      },
    );
  }

  /** Calls warmFallback if nothing is heard from the API for SLOW_MS. */
  private slowWatch(): { progress(): void; done(): void } {
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.warmFallback('slow answer'), SLOW_MS);
      timer.unref?.();
    };
    arm();
    return { progress: arm, done: () => clearTimeout(timer) };
  }

  /** Whether the next sentence will go to Speechify. */
  available(chars: number): boolean {
    if (this.o.budget.left() < LOW_CHARS) this.warmFallback('monthly characters nearly spent');
    if (this.now() < this.pausedUntil) return false;
    if (!this.o.budget.allows(chars)) {
      if (!this.budgetNoted) this.o.log.warn('cloud voice budget used up for this month; using the local voice', { usedChars: this.o.budget.used() });
      this.budgetNoted = true;
      return false;
    }
    return true;
  }

  /** One try at the API: the raw PCM bytes. */
  private async post(text: string, speed: number, signal: AbortSignal): Promise<Buffer> {
    const r = await this.request(text, speed, signal);
    return Buffer.from(await r.arrayBuffer());
  }

  /** The API's answer, once its headers are in (the audio follows). */
  private async request(text: string, speed: number, signal: AbortSignal): Promise<Response> {
    const r = await (this.o.fetch ?? fetch)(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: speechInput(text, speed),
        voice_id: this.o.voiceId,
        model: this.o.model,
        language: 'en-US',
        output_format: `pcm_${RATE}`,
        // Off by default on the stream endpoint; reads digits, times and units.
        options: { text_normalization: true },
      }),
      signal,
    });
    if (!r.ok) throw new SpeechifyError(r.status, (await r.text().catch(() => '')).slice(0, 160));
    return r;
  }

  private async raw(text: string, speed: number, signal?: AbortSignal, timeoutMs = this.o.timeoutMs, watchSlow = true) {
    const t0 = performance.now();
    this.lastCall = this.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const limit = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const rate = speed * (this.o.speed ?? 1);
    const slow = watchSlow ? this.slowWatch() : undefined;
    const bytes = await this.post(text, rate, limit)
      .catch((e: Error) => {
        // A reused socket can die without warning. That says nothing about the
        // API, so one more try at once; only a second failure pauses the voice.
        if (limit.aborted || !connectionBroke(e)) throw e;
        this.o.log.info('cloud voice connection broke; trying again', { error: (e.cause as Error).message });
        return this.post(text, rate, limit);
      })
      .finally(() => slow?.done());
    const samples = pcm16ToFloat(bytes);
    if (!samples.length) throw new Error('speechify returned no audio');
    this.o.budget.add(text.length);
    return { samples, sampleRate: RATE, synthMs: Math.round(performance.now() - t0) };
  }

  /** Long idles are when sentences stall, so a few characters go out ahead of
   *  the next one when someone starts talking. A failure costs nothing more
   *  than the stall would have: it's never thrown and never pauses the voice. */
  async warmIfIdle(): Promise<void> {
    if (this.now() - this.lastCall <= WARM_IDLE_MS || !this.available(WARM_TEXT.length)) return;
    try {
      // A slow warm-up is what it's there to soak up: only a failure says trouble.
      const a = await this.raw(WARM_TEXT, 1, undefined, WARM_TIMEOUT_MS, false);
      this.o.log.info('cloud voice warmed', { ms: a.synthMs });
    } catch (e) {
      this.o.log.info('cloud voice warm-up failed', { error: (e as Error).message });
      // Someone is talking to her now, so the answer may well need the local voice.
      this.warmFallback('warm-up failed');
    }
  }

  /** Gain that brings this voice to the target loudness, measured once. */
  private gainFor(): Promise<number> {
    this.gain ??= this.raw(CALIBRATION, 1).then(
      (a) => {
        const l = integratedLoudness(a.samples, a.sampleRate);
        return Number.isFinite(l) ? TARGET_LUFS - l : 0;
      },
      (e: Error) => {
        this.gain = undefined; // try again next time
        throw e;
      },
    );
    return this.gain;
  }

  async synthesize(line: string, opts: { voice: string; speed: number }, signal?: AbortSignal) {
    this.speed = opts.speed;
    const text = forSpeech(line);
    // Short lines repeat ("Yes?", "Okay, louder."): kept so they play at once.
    const key = text.length <= SHORT ? `${opts.speed}|${text}` : undefined;
    const hit = key && this.short.get(key);
    if (hit) return { samples: hit, sampleRate: RATE, synthMs: 0 };
    if (this.available(text.length)) {
      try {
        const gain = await this.gainFor();
        const a = await this.raw(text, opts.speed, signal);
        const samples = levelChunk(a.samples, a.sampleRate, gain);
        if (key) {
          if (this.short.size >= 64) this.short.delete(this.short.keys().next().value!);
          this.short.set(key, samples);
        }
        return { ...a, samples };
      } catch (e) {
        if (signal?.aborted) throw e;
        this.failed(e);
      }
    }
    return this.fallback.synthesize(text, { voice: this.fallbackVoice, speed: opts.speed }, signal);
  }

  /** A request it won't take (content policy, bad input) only affects that
   *  sentence; timeouts, rate limits and outages pause the API. */
  private failed(e: unknown, midSentence = false): void {
    const status = e instanceof SpeechifyError ? e.status : 0;
    const error = (e as Error).message;
    this.warmFallback('cloud voice failed');
    if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429) {
      this.o.log.warn('cloud voice refused a line; local voice for it', { status, error });
    } else {
      this.pausedUntil = this.now() + 60_000;
      this.o.log.warn(midSentence ? 'cloud voice broke off mid-sentence; local voice for a minute' : 'cloud voice failed; local voice for a minute', { status, error });
    }
  }

  /** The sentence as it arrives. Short lines come whole (they're cached).
   *  Anything that goes wrong before the first audio falls back to the local
   *  voice for the sentence, as synthesize() does. If the stream breaks off
   *  partway, the rest of that sentence is dropped (another voice saying it
   *  again would repeat its start) and the API is paused like any failure. */
  async *stream(text: string, opts: { voice: string; speed: number }, signal?: AbortSignal): AsyncGenerator<SpeechPiece> {
    this.speed = opts.speed;
    if (text.length <= SHORT || !this.available(text.length)) {
      const a = await this.synthesize(text, opts, signal);
      yield { samples: a.samples, sampleRate: a.sampleRate };
      return;
    }
    const said = forSpeech(text);
    let started = false;
    try {
      const gain = await this.gainFor();
      for await (const samples of this.rawStream(said, opts.speed, gain, signal, () => started)) {
        started = true;
        yield { samples, sampleRate: RATE };
      }
      if (!started) throw new Error('speechify returned no audio');
      return;
    } catch (e) {
      if (signal?.aborted) throw e;
      this.failed(e, started);
      if (started) return;
    }
    const a = await this.fallback.synthesize(text, { voice: this.fallbackVoice, speed: opts.speed }, signal);
    yield { samples: a.samples, sampleRate: a.sampleRate };
  }

  /** Leveled audio pieces as the bytes come in. timeoutMs limits the wait for
   *  the first bytes, STALL_MS (at most timeoutMs) any gap after them. The
   *  capped part of the sentence is held until the body ends, or until
   *  CAP_DUE_MS after the first audio, whichever comes first. */
  private async *rawStream(text: string, speed: number, gainDb: number, signal: AbortSignal | undefined, started: () => boolean): AsyncGenerator<Float32Array> {
    this.lastCall = this.now();
    const stall = new AbortController();
    const stalled = () => stall.abort(new DOMException('speechify stalled', 'TimeoutError'));
    let timer = setTimeout(stalled, this.o.timeoutMs);
    const slow = this.slowWatch();
    const limit = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
    const rate = speed * (this.o.speed ?? 1);
    const capper = () => new StreamCap(RATE, gainDb, CEILING_DB, { maxLufs: TARGET_LUFS + MAX_OVER_LU, freeS: CAP_FREE_S });
    let cap = capper();
    let carry: Buffer | undefined;
    let counted = false;
    let firstOutAt = 0;
    let dueTimer: NodeJS.Timeout | undefined;
    /** Resolves when the held audio has to go out. */
    let due: Promise<'due'> | undefined;
    let it: AsyncIterator<Uint8Array> | undefined;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.request(text, rate, limit);
          if (!r.body) throw new Error('speechify returned no audio');
          if (!counted) this.o.budget.add(text.length);
          counted = true;
          it = (r.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
          for (;;) {
            const next = it.next();
            next.catch(() => undefined); // a read left pending when we stop early must not go unhandled
            let res = due ? await Promise.race([next, due]) : await next;
            if (res === 'due') {
              due = undefined;
              const out = cap.release();
              if (out.length) yield out;
              res = await next;
            }
            if (res.done) break;
            const part = res.value;
            clearTimeout(timer);
            timer = setTimeout(stalled, Math.min(STALL_MS, this.o.timeoutMs));
            slow.progress();
            let b = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
            if (carry) b = Buffer.concat([carry, b]);
            // A piece can end halfway through a 16-bit sample.
            const even = b.length & ~1;
            carry = even < b.length ? Buffer.from(b.subarray(even)) : undefined;
            const out = cap.push(pcm16ToFloat(b.subarray(0, even)));
            if (out.length) {
              firstOutAt ||= performance.now();
              yield out;
            }
            if (!due && cap.holding) {
              const wait = Math.max(0, firstOutAt + CAP_DUE_MS - performance.now());
              due = new Promise((resolve) => (dueTimer = setTimeout(() => resolve('due'), wait)));
            }
          }
          break;
        } catch (e) {
          // A reused socket can die without warning: one more try, as raw()
          // does, but only while nothing has been played.
          if (attempt > 0 || started() || limit.aborted || !connectionBroke(e)) {
            // What arrived before a break still plays (the caller's own abort drops it).
            if (!signal?.aborted && cap.holding) {
              const out = cap.release();
              if (out.length) yield out;
            }
            throw e;
          }
          this.o.log.info('cloud voice connection broke; trying again', { error: ((e as Error).cause as Error).message });
          carry = undefined;
          cap = capper();
          clearTimeout(timer);
          timer = setTimeout(stalled, this.o.timeoutMs);
        }
      }
      const tail = cap.end();
      if (tail.length) yield tail;
    } finally {
      clearTimeout(timer);
      clearTimeout(dueTimer);
      slow.done();
      // Stopped early (the caller returned): close the body, as for await did.
      void it?.return?.().catch(() => undefined);
    }
  }
}
