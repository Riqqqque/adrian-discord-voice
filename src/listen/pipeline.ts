// Listening pipeline (milestone 3): per user, Discord audio → 16 kHz →
// Silero VAD → speech segments → Parakeet (shared, one at a time) → wake
// check. Each user has their own downsampler and VAD keyed by user ID, so
// audio and state never mix between users. Audio lives only in memory.

import { EventEmitter } from 'node:events';
import { rmsDbfs } from '../audio/pcm.js';
import type { SpeechToText, UserId, VoiceTransport, WakeDetector } from '../core/interfaces.js';
import { ASR_SAMPLE_RATE, Downsampler, type SileroOptions, SileroVad } from '../speech/sherpa.js';

export interface HeardEvent {
  userId: UserId;
  /** Full transcript (dev logging only; never persisted). */
  text: string;
  woke: boolean;
  /** Text after the wake phrase. */
  command: string;
  /** Woken by the looser check (bare name, or wake phrase mid-sentence). */
  loose?: boolean;
  /** The clip, 16 kHz mono, for a second recognition pass. Never stored. */
  samples?: Float32Array;
  audioSeconds: number;
  levelDbfs: number;
  /** End of speech (VAD segment close) → transcript ready, ms. */
  sttLatencyMs: number;
  /** performance.now() when the VAD closed the segment. */
  segmentClosedAt: number;
  decodeMs: number;
}

export interface ListeningPipelineEvents {
  heard: (e: HeardEvent) => void;
  /** Continuous speech from a user so far, ms (for barge-in). */
  voiceActivity: (userId: UserId, voicedMs: number) => void;
  error: (userId: UserId, err: Error) => void;
}

interface UserState {
  down: Downsampler;
  vad: SileroVad;
  /** performance.now() when the current run of speech began. */
  voicedSince?: number;
}

/** Segments shorter than this are coughs/clicks; don't spend ASR on them. */
const MIN_SEGMENT_SECONDS = 0.3;

export class ListeningPipeline extends EventEmitter {
  private readonly users = new Map<UserId, UserState>();

  constructor(
    private readonly transport: VoiceTransport,
    private readonly stt: SpeechToText,
    private readonly wake: WakeDetector,
    private readonly vadOptions: SileroOptions,
  ) {
    super();
    transport.on('audio', (id, chunk) => {
      const u = this.user(id);
      const segments = u.vad.accept(u.down.push(chunk.samples));
      if (u.vad.isSpeaking()) {
        u.voicedSince ??= chunk.receivedAt;
        this.emit('voiceActivity', id, Math.round(chunk.receivedAt - u.voicedSince));
      } else {
        delete u.voicedSince;
      }
      for (const s of segments) this.handleSegment(id, s);
    });
    // Discord stopped sending for this user: close any open segment.
    transport.on('speechEnd', (id) => {
      const u = this.users.get(id);
      if (!u) return;
      delete u.voicedSince;
      for (const s of u.vad.flush()) this.handleSegment(id, s);
    });
    transport.on('membersChanged', (members) => {
      for (const id of this.users.keys()) if (!members.has(id)) this.users.delete(id);
    });
  }

  override on<E extends keyof ListeningPipelineEvents>(e: E, l: ListeningPipelineEvents[E]): this {
    return super.on(e, l);
  }

  private user(id: UserId): UserState {
    let u = this.users.get(id);
    if (!u) {
      u = { down: new Downsampler(), vad: new SileroVad(this.vadOptions) };
      this.users.set(id, u);
    }
    return u;
  }

  private handleSegment(userId: UserId, samples: Float32Array): void {
    const audioSeconds = samples.length / ASR_SAMPLE_RATE;
    if (audioSeconds < MIN_SEGMENT_SECONDS) return;
    const segmentClosedAt = performance.now();
    const pcm = Int16Array.from(samples, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
    const levelDbfs = Number(rmsDbfs(pcm).toFixed(1));
    this.stt
      .transcribe(samples, ASR_SAMPLE_RATE)
      .then(({ text, decodeMs }) => {
        if (!text) return;
        const m = this.wake.matchLoose?.(text) ?? { ...this.wake.match(text), loose: false };
        this.emit('heard', {
          userId,
          text,
          woke: m.woke,
          command: m.remainder,
          ...(m.loose ? { loose: true } : {}),
          samples,
          audioSeconds: Number(audioSeconds.toFixed(2)),
          levelDbfs,
          sttLatencyMs: Math.round(performance.now() - segmentClosedAt),
          segmentClosedAt,
          decodeMs,
        } satisfies HeardEvent);
      })
      .catch((e: Error) => this.emit('error', userId, e));
  }
}
