// Speechify cloud voice (Simba 3.2, English), with a local voice as the
// automatic fallback: used when the monthly character budget is spent, the
// key is missing, or the API is slow or failing. Audio is fetched from the
// streaming endpoint as raw 24 kHz PCM, then leveled like the local voices.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dateFormat } from '../core/time.js';
import { dirname } from 'node:path';
import type { TextToSpeech } from '../core/interfaces.js';
import { integratedLoudness } from '../audio/loudness.js';
import { levelChunk, TARGET_LUFS } from './kokoro.js';

const API = 'https://api.speechify.ai/v1/audio/stream';
const RATE = 24_000;
/** Lines up to this long are cached in memory. */
const SHORT = 40;
const CALIBRATION = "Sure, here's what I found. It's seventy two degrees and clear right now. The capital of Australia is Canberra.";

export class SpeechifyError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`speechify HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
}

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

  private async raw(text: string, speed: number, signal?: AbortSignal) {
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
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
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!r.ok) throw new SpeechifyError(r.status, (await r.text().catch(() => '')).slice(0, 160));
    const samples = pcm16ToFloat(Buffer.from(await r.arrayBuffer()));
    if (!samples.length) throw new Error('speechify returned no audio');
    this.o.budget.add(text.length);
    return { samples, sampleRate: RATE, synthMs: Math.round(performance.now() - t0) };
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
        // A request it won't take (content policy, bad input) only affects
        // that sentence; timeouts, rate limits and outages pause the API.
        const status = e instanceof SpeechifyError ? e.status : 0;
        if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408 && status !== 429) {
          this.o.log.warn('cloud voice refused a line; local voice for it', { status, error: (e as Error).message });
        } else {
          this.pausedUntil = this.now() + 60_000;
          this.o.log.warn('cloud voice failed; local voice for a minute', { status, error: (e as Error).message });
        }
      }
    }
    return this.fallback.synthesize(text, { voice: this.fallbackVoice, speed: opts.speed }, signal);
  }
}
