import { describe, expect, it } from 'vitest';
import { gainAndLimit, StreamLimiter } from '../src/audio/loudness.js';
import { StreamTrimmer, trimSilence } from '../src/audio/pauses.js';
import type { PlaybackHandle, SpeechPiece, TextToSpeech } from '../src/core/interfaces.js';
import { VoiceRouter } from '../src/speech/piper.js';
import { forSpeech } from '../src/brain/speech-text.js';
import { CharBudget, SpeechifyTts, type SpeechifyOptions } from '../src/speech/speechify.js';
import { Speaker } from '../src/voice/speaker.js';

const quiet = { info() {}, warn() {} };
const RATE = 24_000;

/** Speech-like test audio: bursts of tone with quiet between, hot enough to hit the limiter. */
function speechy(seconds: number, rate = RATE): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    const on = Math.sin(2 * Math.PI * 3 * t) > -0.2 && t > 0.08 && t < seconds - 0.12;
    x[i] = on ? 0.9 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * t)) : 0.0003 * Math.sin(2 * Math.PI * 50 * t);
  }
  return x;
}

function pcm(x: Float32Array): Buffer {
  const b = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767), i * 2);
  return b;
}

/** Split a buffer at awkward places, odd sizes included. */
function pieces(b: Buffer, sizes = [1, 3, 338, 7, 4096, 1001]): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0, k = 0; off < b.length; k++) {
    const n = sizes[k % sizes.length]!;
    out.push(b.subarray(off, off + n));
    off += n;
  }
  return out;
}

const join = (parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

describe('stream limiter', () => {
  it('gives the same samples as limiting the whole sentence at once', () => {
    const x = speechy(1.3);
    const whole = gainAndLimit(x, RATE, 6, -2);
    for (const sizes of [[1], [47, 48, 49], [480, 13], [100_000]]) {
      const lim = new StreamLimiter(RATE, 6, -2);
      const parts: Float32Array[] = [];
      for (let off = 0, k = 0; off < x.length; k++) {
        const n = sizes[k % sizes.length]!;
        parts.push(lim.push(x.subarray(off, off + n)));
        off += n;
      }
      parts.push(lim.end());
      expect(join(parts)).toEqual(whole);
    }
  });
});

describe('stream trimmer', () => {
  it('trims like trimSilence, give or take one 10 ms window at the end', () => {
    const rate = 48_000;
    const x = speechy(1.1, rate);
    const whole = trimSilence(x, rate);
    const t = new StreamTrimmer(rate);
    const parts: Float32Array[] = [];
    for (let off = 0; off < x.length; off += 777) parts.push(t.push(x.subarray(off, off + 777)));
    parts.push(t.end());
    const got = join(parts);
    expect(Math.abs(got.length - whole.length)).toBeLessThanOrEqual(rate / 100);
    // Same start: the first sound and its margin line up exactly.
    expect(got.subarray(0, 4_800)).toEqual(whole.subarray(0, 4_800));
  });

  it('gives nothing for silence', () => {
    const t = new StreamTrimmer(48_000);
    expect(t.push(new Float32Array(48_000)).length + t.end().length).toBe(0);
    expect(t.heard).toBe(false);
  });
});

function streamingFetch(body: Buffer, o: { breakAfter?: number; fail?: number } = {}) {
  const calls: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const input = String(JSON.parse(String(init.body)).input);
    calls.push(input);
    if (o.fail) return new Response('nope', { status: o.fail });
    // The calibration line comes whole; sentences come in pieces.
    if (input.startsWith('Sure,')) return new Response(pcm(speechy(2)), { status: 200 });
    const parts = pieces(body);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (o.breakAfter !== undefined && i === o.breakAfter) {
          c.error(new TypeError('terminated', { cause: new Error('other side closed') }));
          return;
        }
        if (i >= parts.length) return c.close();
        c.enqueue(new Uint8Array(parts[i++]!));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const local: TextToSpeech & { calls: string[] } = {
  calls: [],
  async synthesize(text) {
    this.calls.push(text);
    return { samples: new Float32Array(2_400).fill(0.1), sampleRate: RATE, synthMs: 1 };
  },
};

function voice(f: typeof fetch, extra: Partial<SpeechifyOptions> = {}) {
  const warns: string[] = [];
  const tts = new SpeechifyTts(
    { apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.5', timeoutMs: 2000, budget: new CharBudget(undefined, 0, 'UTC'), log: { info() {}, warn: (m: string) => warns.push(m) }, fetch: f, ...extra },
    local,
    'af_heart',
  );
  return { tts, warns };
}

async function collect(it: AsyncIterable<SpeechPiece>) {
  const out: SpeechPiece[] = [];
  for await (const p of it) out.push(p);
  return out;
}

const LONG = 'This sentence is long enough that it is streamed, not cached.';

describe('speechify streaming', () => {
  it('streams a long sentence: same audio as synthesize(), cut at odd byte counts', async () => {
    const body = pcm(speechy(1.5));
    const a = voice(streamingFetch(body).f);
    const whole = await a.tts.synthesize(LONG, { voice: 'cloud:en', speed: 1 });
    const b = voice(streamingFetch(body).f);
    const got = await collect(b.tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(got.length).toBeGreaterThan(5);
    expect(got.every((p) => p.sampleRate === RATE)).toBe(true);
    // synthesize() also caps a hot short line; a 1.5 s sentence at the calibration level isn't capped.
    expect(join(got.map((p) => p.samples))).toEqual(whole.samples);
  });

  it('checks the month against the words it will send, which can be longer than the text', async () => {
    const text = 'It is 72°F now and the ticket costs €20 at 7:00 tonight.';
    const said = forSpeech(text);
    expect(said.length).toBeGreaterThan(text.length);
    const budget = new CharBudget(undefined, text.length, 'UTC'); // room for the text, not for what is said
    const { f, calls } = streamingFetch(pcm(speechy(1)));
    const { tts } = voice(f, { budget });
    local.calls.length = 0;
    await collect(tts.stream(text, { voice: 'cloud:en', speed: 1 }));
    expect(calls).not.toContain(said);
    expect(local.calls).toHaveLength(1);
    expect(budget.used()).toBeLessThanOrEqual(text.length);
  });

  it('short lines come whole and cached', async () => {
    const { f, calls } = streamingFetch(pcm(speechy(0.5)));
    const { tts } = voice(f);
    await collect(tts.stream('Yes?', { voice: 'cloud:en', speed: 1 }));
    const again = await collect(tts.stream('Yes?', { voice: 'cloud:en', speed: 1 }));
    expect(again).toHaveLength(1);
    expect(calls.filter((c) => c === 'Yes?')).toHaveLength(1);
  });

  it('falls back to the local voice when it fails before any audio', async () => {
    local.calls = [];
    const { tts, warns } = voice(streamingFetch(Buffer.alloc(0), { fail: 503 }).f);
    const got = await collect(tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(local.calls).toEqual([LONG]);
    expect(got).toHaveLength(1);
    expect(warns).toEqual(['cloud voice failed; local voice for a minute']);
    expect(tts.available(10)).toBe(false);
  });

  it('a stream that breaks before any audio is tried once more', async () => {
    const body = pcm(speechy(1));
    let n = 0;
    const good = streamingFetch(body).f;
    const broken = streamingFetch(body, { breakAfter: 0 }).f;
    const f = (async (u: string, init: RequestInit) => {
      const input = String(JSON.parse(String(init.body)).input);
      return input === LONG && n++ === 0 ? broken(u, init) : good(u, init);
    }) as unknown as typeof fetch;
    local.calls = [];
    const { tts, warns } = voice(f);
    const got = await collect(tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(local.calls).toEqual([]);
    expect(warns).toEqual([]);
    expect(join(got.map((p) => p.samples)).length).toBe(RATE);
  });

  it('a stream that breaks partway ends the sentence there and pauses the API', async () => {
    local.calls = [];
    const { tts, warns } = voice(streamingFetch(pcm(speechy(1.5)), { breakAfter: 5 }).f);
    const got = await collect(tts.stream(LONG, { voice: 'cloud:en', speed: 1 }));
    expect(got.length).toBeGreaterThan(0);
    expect(local.calls).toEqual([]); // not said again from the start
    expect(warns).toEqual(['cloud voice broke off mid-sentence; local voice for a minute']);
    expect(tts.available(10)).toBe(false);
  });

  it('stops when the caller aborts', async () => {
    const { tts } = voice(streamingFetch(pcm(speechy(1.5))).f);
    const ctl = new AbortController();
    const it = tts.stream(LONG, { voice: 'cloud:en', speed: 1 }, ctl.signal)[Symbol.asyncIterator]();
    await it.next();
    ctl.abort();
    await expect(
      (async () => {
        for (;;) if ((await it.next()).done) return 'done';
      })(),
    ).resolves.toBe('done');
  });

  it('the router streams cloud lines and wraps the others', async () => {
    const { tts } = voice(streamingFetch(pcm(speechy(1.5))).f);
    const r = new VoiceRouter(local, { 'cloud:en': tts });
    expect((await collect(r.stream(LONG, { voice: 'cloud:en', speed: 1 }))).length).toBeGreaterThan(5);
    expect(await collect(r.stream('Hi.', { voice: 'af_heart', speed: 1 }))).toHaveLength(1);
  });
});

describe('speaker with a streaming voice', () => {
  /** A voice that sends a sentence as 20 ms pieces, `gapMs` apart. */
  const streamer = (gapMs: number, seconds = 1): TextToSpeech => ({
    async synthesize() {
      throw new Error('not used');
    },
    async *stream() {
      const x = speechy(seconds);
      for (let off = 0; off < x.length; off += 480) {
        await new Promise((r) => setTimeout(r, gapMs));
        yield { samples: x.subarray(off, off + 480), sampleRate: RATE };
      }
    },
  });

  async function* say(...lines: string[]) {
    for (const l of lines) yield l;
  }

  it('opens playback once 0.2 s of audio is in, before the sentence is done', async () => {
    const t0 = performance.now();
    let openedAt = 0;
    let bytes = 0;
    const transport = {
      playPcm: (s: NodeJS.ReadableStream): PlaybackHandle => {
        openedAt = performance.now() - t0;
        s.on('data', (b: Buffer) => (bytes += b.length));
        return { done: new Promise((r) => s.on('end', () => r('finished'))), stop: () => {} };
      },
    };
    const r = await new Speaker(transport, streamer(2, 1)).speak(say('One long sentence here.'), { voice: 'v', speed: 1, volume: 1 }, new AbortController().signal);
    const total = performance.now() - t0;
    expect(r).toMatchObject({ outcome: 'finished', chunks: 1 });
    expect(openedAt).toBeLessThan(total * 0.6);
    // The sentence minus trimmed silence, as 48 kHz stereo.
    expect(bytes / 4 / 48_000).toBeGreaterThan(0.7);
    expect(r.synthMs[0]).toBeLessThan(openedAt);
  });

  it('a first sentence shorter than 0.2 s still plays before the next one is ready', async () => {
    let opened = false;
    const short: TextToSpeech = {
      async synthesize() {
        return { samples: speechy(0.15).map((v, i) => (i > 100 && i < 3_000 ? 0.3 : v)), sampleRate: RATE, synthMs: 1 };
      },
    };
    const transport = { playPcm: (): PlaybackHandle => ((opened = true), { done: Promise.resolve('finished'), stop: () => {} }) };
    async function* slow() {
      yield 'Hi.';
      await new Promise((r) => setTimeout(r, 50));
      expect(opened).toBe(true);
      yield 'There.';
    }
    const r = await new Speaker(transport, short).speak(slow(), { voice: 'v', speed: 1, volume: 1 }, new AbortController().signal);
    expect(r.chunks).toBe(2);
  });
});
