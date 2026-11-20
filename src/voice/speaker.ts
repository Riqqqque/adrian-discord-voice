// Speaks a stream of text chunks: each chunk is synthesized (normalized),
// resampled to 48 kHz stereo and appended to one continuous Discord
// playback, so speech starts with the first chunk while later ones are
// still being generated. A voice that streams (Speechify) starts playing a
// chunk's first words while the rest of it is still arriving.

import { PassThrough } from 'node:stream';
import sherpa from 'sherpa-onnx-node';
import { pauseAfter, StreamTrimmer } from '../audio/pauses.js';
import type { PlaybackHandle, SpeechPiece, TextToSpeech, VoiceTransport } from '../core/interfaces.js';

/** Audio collected before playback opens, s: the mixer then starts it at once
 *  instead of padding a tiny first piece with silence. */
const OPEN_S = 0.2;

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
  return toStereo(rate === 48_000 ? mono : new sherpa.LinearResampler(rate, 48_000).flush(mono));
}

/** Mono 48 kHz float → interleaved stereo s16le. */
function toStereo(up: Float32Array): Buffer {
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

  /** One sentence's audio: streamed when the voice can, else all at once. */
  private async *pieces(text: string, o: SpeakOptions, signal: AbortSignal): AsyncIterable<SpeechPiece> {
    if (this.tts.stream) {
      yield* this.tts.stream(text, { voice: o.voice, speed: o.speed }, signal);
      return;
    }
    const a = await this.tts.synthesize(text, { voice: o.voice, speed: o.speed }, signal);
    yield { samples: a.samples, sampleRate: a.sampleRate };
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
    /** Audio held back before playback opens, so it opens on a solid start. */
    let opening: Buffer[] = [];
    let openingS = 0;
    const open = () => {
      firstAudioAt = performance.now();
      res.firstAudioMs = Math.round(firstAudioAt - t0);
      o.onFirstAudio?.();
      for (const b of opening) out.write(b);
      opening = [];
      handle = this.transport.playPcm(out, { volume: o.volume });
    };
    const write = (b: Buffer, seconds: number) => {
      writtenS += seconds;
      if (handle) out.write(b);
      else {
        opening.push(b);
        openingS += seconds;
        if (openingS >= OPEN_S) open();
      }
    };
    try {
      for await (const text of chunks) {
        if (signal.aborted) break;
        const c0 = performance.now();
        const trim = new StreamTrimmer(48_000);
        let rate = 0;
        let resampler: InstanceType<typeof sherpa.LinearResampler> | undefined;
        let heard = false;
        const emit = (speech: Float32Array) => {
          if (!speech.length) return;
          if (!heard) {
            heard = true;
            res.synthMs.push(Math.round(performance.now() - c0));
            if (res.chunks > 0) {
              // A pause that fits the punctuation, minus any gap the listener
              // already heard while this chunk was being synthesized.
              const playedS = handle ? (performance.now() - firstAudioAt) / 1000 : 0;
              const underrunS = handle ? Math.max(0, playedS - writtenS) : 0;
              const pauseS = Math.max(0, pauseAfter(prevText) - underrunS);
              write(Buffer.alloc(Math.round(pauseS * 48_000) * 4), pauseS);
            }
          }
          write(toStereo(speech), speech.length / 48_000);
        };
        // Pieces are resampled to 48 kHz as they come, then trimmed, so the
        // first words play while the rest of the sentence is still arriving.
        for await (const p of this.pieces(text, o, signal)) {
          if (signal.aborted) break;
          if (!resampler && p.sampleRate !== 48_000) resampler = new sherpa.LinearResampler(p.sampleRate, 48_000);
          rate = p.sampleRate;
          emit(trim.push(resampler ? resampler.resample(p.samples) : p.samples));
        }
        if (signal.aborted) break;
        if (resampler && rate) emit(trim.push(resampler.flush(new Float32Array(0))));
        emit(trim.end());
        if (!heard) continue; // nothing audible: no pause, no chunk
        prevText = text;
        res.chunks++;
        // A first sentence shorter than OPEN_S plays now, not with the next one.
        if (!handle) open();
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
