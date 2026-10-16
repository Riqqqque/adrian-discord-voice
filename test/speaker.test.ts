import { describe, expect, it } from 'vitest';
import type { PlaybackHandle, TextToSpeech } from '../src/core/interfaces.js';
import { Speaker } from '../src/voice/speaker.js';

const tts: TextToSpeech = {
  async synthesize() {
    return { samples: new Float32Array(4_800).fill(0.1), sampleRate: 48_000, synthMs: 1 };
  },
};

async function* say(...lines: string[]) {
  for (const l of lines) yield l;
}

describe('speaker', () => {
  it('"stop" still cuts playback after all the audio was generated', async () => {
    let stopped = false;
    let finish!: (o: 'finished' | 'stopped') => void;
    const transport = {
      playPcm: (): PlaybackHandle => ({
        done: new Promise((r) => (finish = r)),
        stop: () => {
          stopped = true;
          finish('stopped');
        },
      }),
    };
    const ctl = new AbortController();
    const result = new Speaker(transport, tts).speak(say('One.', 'Two.'), { voice: 'v', speed: 1, volume: 1 }, ctl.signal);
    await new Promise((r) => setTimeout(r, 10)); // synthesis is done, playback is still going
    ctl.abort();
    expect(stopped).toBe(true);
    expect((await result).outcome).toBe('stopped');
  });

  it('plays to the end when nobody stops it', async () => {
    const transport = { playPcm: (): PlaybackHandle => ({ done: Promise.resolve('finished'), stop: () => {} }) };
    const r = await new Speaker(transport, tts).speak(say('Hi.'), { voice: 'v', speed: 1, volume: 1 }, new AbortController().signal);
    expect(r).toMatchObject({ outcome: 'finished', chunks: 1 });
  });
});
