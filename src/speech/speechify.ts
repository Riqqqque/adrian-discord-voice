// Speechify cloud voice (Simba, English), with a local voice as the
// automatic fallback: used when the monthly character budget is spent, the
// key is missing, or the API is slow or failing. Audio is fetched from the
// streaming endpoint as raw 24 kHz PCM, then leveled like the local voices.
// Sentences longer than the cached short lines play as their bytes arrive
// (first audio ~0.1 s after the request instead of the ~0.3 s the whole
// sentence takes).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dateFormat } from '../core/time.js';
import { dirname } from 'node:path';
import type { SpeechPiece, TextToSpeech } from '../core/interfaces.js';
import { integratedLoudness, StreamLimiter } from '../audio/loudness.js';
import { CEILING_DB, levelChunk, TARGET_LUFS } from './kokoro.js';

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

  constructor(
    private readonly o: SpeechifyOptions,
    /** Local engine and voice used whenever the cloud voice can't be. */
    private readonly fallback: TextToSpeech,
    private readonly fallbackVoice: string,
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Whether the next sentence will go to Speechify. */
  available(chars: number): boolean {
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

  private async raw(text: string, speed: number, signal?: AbortSignal, timeoutMs = this.o.timeoutMs) {
    const t0 = performance.now();
    this.lastCall = this.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const limit = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const rate = speed * (this.o.speed ?? 1);
    const bytes = await this.post(text, rate, limit).catch((e: Error) => {
      // A reused socket can die without warning. That says nothing about the
      // API, so one more try at once; only a second failure pauses the voice.
      if (limit.aborted || !connectionBroke(e)) throw e;
      this.o.log.info('cloud voice connection broke; trying again', { error: (e.cause as Error).message });
      return this.post(text, rate, limit);
    });
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
      const a = await this.raw(WARM_TEXT, 1, undefined, WARM_TIMEOUT_MS);
      this.o.log.info('cloud voice warmed', { ms: a.synthMs });
    } catch (e) {
      this.o.log.info('cloud voice warm-up failed', { error: (e as Error).message });
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

  async synthesize(text: string, opts: { voice: string; speed: number }, signal?: AbortSignal) {
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
    if (text.length <= SHORT || !this.available(text.length)) {
      const a = await this.synthesize(text, opts, signal);
      yield { samples: a.samples, sampleRate: a.sampleRate };
      return;
    }
    let started = false;
    try {
      const gain = await this.gainFor();
      for await (const samples of this.rawStream(text, opts.speed, gain, signal, () => started)) {
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
   *  the first bytes and any stall after them. */
  private async *rawStream(text: string, speed: number, gainDb: number, signal: AbortSignal | undefined, started: () => boolean): AsyncGenerator<Float32Array> {
    this.lastCall = this.now();
    const stall = new AbortController();
    const stalled = () => stall.abort(new DOMException('speechify stalled', 'TimeoutError'));
    let timer = setTimeout(stalled, this.o.timeoutMs);
    const limit = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
    const rate = speed * (this.o.speed ?? 1);
    let limiter = new StreamLimiter(RATE, gainDb, CEILING_DB);
    let carry: Buffer | undefined;
    let counted = false;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.request(text, rate, limit);
          if (!r.body) throw new Error('speechify returned no audio');
          if (!counted) this.o.budget.add(text.length);
          counted = true;
          for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) {
            clearTimeout(timer);
            timer = setTimeout(stalled, this.o.timeoutMs);
            let b = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
            if (carry) b = Buffer.concat([carry, b]);
            // A piece can end halfway through a 16-bit sample.
            const even = b.length & ~1;
            carry = even < b.length ? Buffer.from(b.subarray(even)) : undefined;
            const out = limiter.push(pcm16ToFloat(b.subarray(0, even)));
            if (out.length) yield out;
          }
          break;
        } catch (e) {
          // A reused socket can die without warning: one more try, as raw()
          // does, but only while nothing has been played.
          if (attempt > 0 || started() || limit.aborted || !connectionBroke(e)) throw e;
          this.o.log.info('cloud voice connection broke; trying again', { error: ((e as Error).cause as Error).message });
          carry = undefined;
          limiter = new StreamLimiter(RATE, gainDb, CEILING_DB);
        }
      }
      const tail = limiter.end();
      if (tail.length) yield tail;
    } finally {
      clearTimeout(timer);
    }
  }
}
