import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SpeechToText, UserId, VoiceTransport, WakeDetector } from '../src/core/interfaces.js';
import { type HeardEvent, ListeningPipeline, type TurnOptions, type UserState } from '../src/listen/pipeline.js';
import { Downsampler, type SileroVad } from '../src/speech/sherpa.js';

/** A VAD stand-in: segments are handed out on speechEnd. */
class FakeVad {
  queue: Float32Array[] = [];
  speaking = false;
  accept() {
    return [];
  }
  flush() {
    return this.queue.splice(0);
  }
  isSpeaking() {
    return this.speaking;
  }
}

class TestPipeline extends ListeningPipeline {
  readonly vad = new FakeVad();
  protected override user(id: UserId): UserState {
    let u = this.users.get(id);
    if (!u) {
      u = { down: new Downsampler(), vad: this.vad as unknown as SileroVad, epoch: 0 };
      this.users.set(id, u);
    }
    return u;
  }
}

const seconds = (s: number) => new Float32Array(Math.round(s * 16_000)).fill(0.1);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(probs: (number | Error)[], holdMs = 60) {
  const transport = new EventEmitter() as unknown as VoiceTransport;
  const heardLens: number[] = [];
  const stt: SpeechToText = { transcribe: async (s) => ({ text: `len ${s.length}`, decodeMs: 1 }) } as SpeechToText;
  const wake = { match: () => ({ woke: false, remainder: '' }) } as unknown as WakeDetector;
  const asked: number[] = [];
  const turn: TurnOptions = {
    holdMs,
    detector: {
      complete: async (s) => {
        asked.push(s.length);
        const p = probs.shift() ?? 1;
        if (p instanceof Error) throw p;
        return p;
      },
    },
  };
  const p = new TestPipeline(transport, stt, wake, { model: 'x', threshold: 0.5, minSilence: 0.8, minSpeech: 0.25, maxSpeech: 20 }, turn);
  p.on('heard', (e: HeardEvent) => heardLens.push(e.samples!.length));
  // make the user exist, then hand a segment over
  const say = (s: Float32Array) => {
    (transport as unknown as EventEmitter).emit('audio', 'u1', { samples: new Int16Array(0), receivedAt: 0 });
    p.vad.queue.push(s);
    (transport as unknown as EventEmitter).emit('speechEnd', 'u1');
  };
  return { p, say, heardLens, asked };
}

describe('waiting for the rest of a sentence', () => {
  it('passes a finished sentence straight on', async () => {
    const t = setup([0.9]);
    t.say(seconds(1));
    await wait(20);
    expect(t.heardLens).toEqual([16_000]);
    // the model heard the speech plus 0.8 s of silence
    expect(t.asked).toEqual([16_000 + 12_800]);
  });

  it('holds a pause that sounds unfinished and joins what comes next', async () => {
    const t = setup([0.2, 0.9]);
    t.say(seconds(1));
    await wait(20);
    expect(t.heardLens).toEqual([]);
    t.say(seconds(0.5));
    await wait(20);
    expect(t.heardLens).toEqual([16_000 + 4_000 + 8_000]);
  });

  it('gives up waiting after the extra wait', async () => {
    const t = setup([0.2], 60);
    t.say(seconds(1));
    await wait(30);
    expect(t.heardLens).toEqual([]);
    await wait(60);
    expect(t.heardLens).toEqual([16_000]);
  });

  it('keeps waiting while they are talking again', async () => {
    const t = setup([0.2, 0.9], 40);
    t.say(seconds(1));
    await wait(10);
    t.p.vad.speaking = true;
    await wait(120);
    expect(t.heardLens).toEqual([]);
    t.p.vad.speaking = false;
    t.say(seconds(0.5));
    await wait(20);
    expect(t.heardLens).toEqual([16_000 + 4_000 + 8_000]);
  });

  it("doesn't make anyone wait when the model fails", async () => {
    const t = setup([new Error('boom')]);
    t.say(seconds(1));
    await wait(20);
    expect(t.heardLens).toEqual([16_000]);
  });
});
