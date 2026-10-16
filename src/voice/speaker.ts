// Speaks a stream of text chunks: each chunk is synthesized (normalized),
// resampled to 48 kHz stereo and appended to one continuous Discord
// playback, so speech starts with the first chunk while later ones are
// still being generated.

import { PassThrough } from 'node:stream';
import sherpa from 'sherpa-onnx-node';
import { pauseAfter, trimSilence } from '../audio/pauses.js';
import type { PlaybackHandle, TextToSpeech, VoiceTransport } from '../core/interfaces.js';

export interface SpeakResult {
  outcome: 'finished' | 'stopped' | 'error';
  /** ms from speak() to the first audio handed to Discord. */
  firstAudioMs?: number;
  chunks: number;
  synthMs: number[];
}

export interface SpeakOptions {
  voice: string;
  speed: number;
  volume: number;
  /** Called the moment the first audio is written. */
  onFirstAudio?: () => void;
}

/** Mono float at `rate` → interleaved 48 kHz stereo s16le. */
export function toDiscordPcm(mono: Float32Array, rate: number): Buffer {
  const up = rate === 48_000 ? mono : new sherpa.LinearResampler(rate, 48_000).flush(mono);
  const buf = Buffer.alloc(up.length * 4);
  for (let i = 0; i < up.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(up[i]! * 32767)));
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

export class Speaker {
  constructor(
    private readonly transport: Pick<VoiceTransport, 'playPcm'>,
    private readonly tts: TextToSpeech,
  ) {}

  /** Load and calibrate a voice ahead of time (nothing is played). */
  async warm(voice: string, speed: number): Promise<void> {
    // Loading and calibrating happen before synthesis; a near-empty text
    // may then yield no audio, which is fine here.
    await this.tts.synthesize('Okay.', { voice, speed }).catch((e: Error) => {
      if (!/no audio/i.test(e.message)) throw e;
    });
  }

  /** Speak chunks until the source ends, the signal aborts, or playback is
   *  stopped. Aborting stops playback immediately. */
  async speak(chunks: AsyncIterable<string>, o: SpeakOptions, signal: AbortSignal): Promise<SpeakResult> {
    const t0 = performance.now();
    const out = new PassThrough({ highWaterMark: 1 << 20 });
    let handle: PlaybackHandle | undefined;
    const res: SpeakResult = { outcome: 'finished', chunks: 0, synthMs: [] };
    const onAbort = () => {
      handle?.stop();
      out.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let firstAudioAt = 0;
    let writtenS = 0; // seconds of audio handed to playback so far
    let prevText = '';
    try {
      for await (const text of chunks) {
        if (signal.aborted) break;
        const a = await this.tts.synthesize(text, { voice: o.voice, speed: o.speed }, signal);
        if (signal.aborted) break;
        res.synthMs.push(a.synthMs);
        const speech = trimSilence(a.samples, a.sampleRate);
        if (res.chunks > 0) {
          // A pause that fits the punctuation, minus any gap the listener
          // already heard while this chunk was being synthesized.
          const underrunS = Math.max(0, performance.now() - (firstAudioAt + writtenS * 1000)) / 1000;
          const pauseS = Math.max(0, pauseAfter(prevText) - underrunS);
          out.write(Buffer.alloc(Math.round(pauseS * 48_000) * 4));
          writtenS += pauseS;
        }
        out.write(toDiscordPcm(speech, a.sampleRate));
        writtenS += speech.length / a.sampleRate;
        prevText = text;
        res.chunks++;
        if (!handle) {
          firstAudioAt = performance.now();
          res.firstAudioMs = Math.round(performance.now() - t0);
          o.onFirstAudio?.();
          handle = this.transport.playPcm(out, { volume: o.volume });
        }
      }
    } catch (e) {
      signal.removeEventListener('abort', onAbort);
      handle?.stop();
      throw e;
    } finally {
      out.end();
    }
    // Synthesis usually ends seconds before playback does: "stop" must still
    // cut it off, so the listener stays until playback is over.
    try {
      if (!handle) return { ...res, outcome: signal.aborted ? 'stopped' : 'finished' };
      const outcome = await handle.done;
      res.outcome = signal.aborted ? 'stopped' : outcome;
      return res;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
