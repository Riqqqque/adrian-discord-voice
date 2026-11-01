import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SpeechToText, UserId, VoiceTransport, WakeDetector } from '../src/core/interfaces.js';
import { endsDangling, type HeardEvent, ListeningPipeline, type TurnOptions, type UserState } from '../src/listen/pipeline.js';
import { Downsampler, type SileroVad } from '../src/speech/sherpa.js';

/** A VAD stand-in: segments are handed out on speechEnd, or on audio from `closing`. */
class FakeVad {
  queue: Float32Array[] = [];
  closing: Float32Array[] = [];
  speaking = false;
  accept() {
    return this.closing.splice(0);
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

/** Polls, so a busy machine slows a test down instead of failing it. */
async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) await wait(2);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Options {
  /** What the recognizer makes of a clip, by default its length. */
  words?: (s: Float32Array) => string | Promise<string>;
  hooks?: Pick<TurnOptions, 'shouldHold' | 'onHeldWords'>;
  onHold?: TurnOptions['onHold'];
  /** Like a Discord room: no Smart Turn. */
  noTurn?: boolean;
}

function setup(probs: (number | Error | Promise<number>)[], holdMs = 60, o: Options = {}) {
  const transport = new EventEmitter() as unknown as VoiceTransport;
  const heardLens: number[] = [];
  const heard: HeardEvent[] = [];
  const errors: Error[] = [];
  const decoded: number[] = [];
  const stt: SpeechToText = {
    transcribe: async (s) => {
      decoded.push(s.length);
      return { text: await (o.words?.(s) ?? `len ${s.length}`), decodeMs: 1 };
    },
  } as SpeechToText;
  const wake = { match: () => ({ woke: false, remainder: '' }) } as unknown as WakeDetector;
  const asked: number[] = [];
  const turn: TurnOptions = {
    holdMs,
    detector: {
      complete: async (s) => {
        asked.push(s.length);
        const p = (await probs.shift()) ?? 1;
        if (p instanceof Error) throw p;
        return p;
      },
    },
    ...o.hooks,
    ...(o.onHold ? { onHold: o.onHold } : {}),
  };
  const p = new TestPipeline(transport, stt, wake, { model: 'x', threshold: 0.5, minSilence: 0.8, minSpeech: 0.25, maxSpeech: 20 }, o.noTurn ? undefined : turn);
  p.on('heard', (e: HeardEvent) => {
    heardLens.push(e.samples!.length);
    heard.push(e);
  });
  p.on('error', (_id, e) => errors.push(e));
  const audio = () => (transport as unknown as EventEmitter).emit('audio', 'u1', { samples: new Int16Array(0), receivedAt: 0 });
  // make the user exist, then hand a segment over
  const say = (s: Float32Array) => {
    audio();
    p.vad.queue.push(s);
    (transport as unknown as EventEmitter).emit('speechEnd', 'u1');
  };
  /** The same, closed by the VAD's own silence wait. */
  const sayToVad = (s: Float32Array) => {
    p.vad.closing.push(s);
    audio();
  };
  return { p, say, sayToVad, heardLens, heard, errors, decoded, asked };
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

describe('recognizing beside the turn check', () => {
  it('starts on the first segment, before the check answers, and heard still waits for it', async () => {
    const check = deferred<number>();
    const t = setup([check.promise]);
    t.say(seconds(1));
    expect(t.decoded).toEqual([16_000]);
    await wait(10);
    expect(t.heardLens).toEqual([]);
    check.resolve(0.9);
    await until(() => t.heard.length > 0);
    expect(t.heardLens).toEqual([16_000]);
    expect(t.decoded).toEqual([16_000]);
  });

  it('reuses the words when a hold runs out', async () => {
    const t = setup([0.2], 120, { words: async (s) => (await wait(30), `len ${s.length}`) });
    const clip = seconds(1);
    t.say(clip);
    await wait(10);
    expect(t.decoded).toEqual([16_000]);
    await until(() => t.heard.length > 0);
    expect(t.decoded).toEqual([16_000]);
    expect(t.heard[0]!.samples).toBe(clip);
    expect(t.heard[0]!.text).toBe('len 16000');
    // ready before the release, so the 30 ms decode isn't in here
    expect(t.heard[0]!.sttLatencyMs).toBeLessThan(20);
  });

  it('decodes the joined audio, not the old promise', async () => {
    const t = setup([0.2, 0.9]);
    t.say(seconds(1));
    await wait(20);
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    expect(t.decoded).toEqual([16_000, 28_000]);
    expect(t.heard.map((e) => e.text)).toEqual(['len 28000']);
  });

  it('ignores the old words when they land after a join', async () => {
    const first = deferred<string>();
    const t = setup([0.2, 0.9], 60, { words: (s) => (s.length === 16_000 ? first.promise : `len ${s.length}`) });
    t.say(seconds(1));
    await wait(10);
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    first.resolve('old words');
    await wait(10);
    expect(t.heard.map((e) => e.text)).toEqual(['len 28000']);
  });

  it('shrugs off a failed decode that a join replaced', async () => {
    const t = setup([0.2, 0.9], 60, { words: (s) => (s.length === 16_000 ? Promise.reject(new Error('boom')) : `len ${s.length}`) });
    t.say(seconds(1));
    await wait(10);
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    expect(t.heard.map((e) => e.text)).toEqual(['len 28000']);
    expect(t.errors).toEqual([]);
  });

  it('reports a failed decode once, at release', async () => {
    const t = setup([0.2], 40, { words: () => Promise.reject(new Error('boom')) });
    t.say(seconds(1));
    await wait(10);
    expect(t.errors).toEqual([]);
    await until(() => t.errors.length > 0);
    await wait(10);
    expect(t.errors.map((e) => e.message)).toEqual(['boom']);
    expect(t.heard).toEqual([]);
    expect(t.decoded).toEqual([16_000]);
  });

  it('leaves a join undecoded until release without the hooks', async () => {
    const t = setup([0.2, 0.2], 60);
    t.say(seconds(1));
    await wait(10);
    t.say(seconds(0.5));
    await wait(10);
    expect(t.decoded).toEqual([16_000]);
    await until(() => t.heard.length > 0);
    expect(t.decoded).toEqual([16_000, 28_000]);
  });

  it('hands over the words of held speech, with the array heard will carry', async () => {
    const got: { text: string; samples: Float32Array }[] = [];
    const t = setup([0.2], 60, { hooks: { onHeldWords: (_id, w) => got.push(w) } });
    t.say(seconds(1));
    await until(() => got.length > 0);
    expect(t.heard).toEqual([]);
    await until(() => t.heard.length > 0);
    expect(got.map((w) => w.text)).toEqual(['len 16000']);
    expect(got[0]!.samples).toBe(t.heard[0]!.samples);
  });

  it('hands over a join as new audio', async () => {
    const got: { text: string; samples: Float32Array }[] = [];
    const t = setup([0.2, 0.2], 80, { hooks: { onHeldWords: (_id, w) => got.push(w) } });
    t.say(seconds(1));
    await until(() => got.length > 0);
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    expect(got.map((w) => w.text)).toEqual(['len 16000', 'len 28000']);
    expect(got[1]!.samples).toBe(t.heard[0]!.samples);
    expect(got[0]!.samples).not.toBe(t.heard[0]!.samples);
    expect(t.decoded).toEqual([16_000, 28_000]);
  });

  it("doesn't hand over words for speech that isn't held", async () => {
    const got: string[] = [];
    const t = setup([0.9, 0.2], 40, {
      words: () => 'finished',
      hooks: { onHeldWords: (_id, w) => got.push(w.text), shouldHold: () => false },
    });
    t.say(seconds(1)); // finished by the sound of it
    await until(() => t.heard.length === 1);
    t.say(seconds(1)); // unfinished, but the words say otherwise
    await until(() => t.heard.length === 2);
    expect(got).toEqual([]);
  });

  it("doesn't hand over a clip with no words", async () => {
    const got: string[] = [];
    const t = setup([0.2], 40, { words: () => '', hooks: { onHeldWords: (_id, w) => got.push(w.text) } });
    t.say(seconds(1));
    await wait(100);
    expect(got).toEqual([]);
    expect(t.heard).toEqual([]);
  });
});

describe('endsDangling', () => {
  it.each(['Hey Adrian, play', 'Hey Adrian, play.', 'hey adrian, put on', 'PUT  ON?', 'open', 'search', 'Set...', 'can you turn', 'play the', 'a', 'to', 'and', 'or', 'of', 'for', 'with', 'my', 'some', 'play some'])(
    'holds %j',
    (text) => expect(endsDangling(text)).toBe(true),
  );

  it.each(['', 'Hey Adrian', 'Hey Adrian.', 'no, just play Ella Langley', 'turn it on', 'put it on', 'on', 'Play Aerosmith', 'display', 'replay', 'Adrian, stop', 'open Spotify'])(
    "doesn't hold %j",
    (text) => expect(endsDangling(text)).toBe(false),
  );

  it.each([
    'tell Sam that',
    'Hey Adrian, tell Sam',
    'tell me',
    'ask him if',
    'open the',
    "what's the weather in",
    'remind me at',
    'can you',
    'could you please',
    'how do you',
    'I want',
    'what is',
    'because',
    'um',
    'and then',
    'turn on',
    'turn it',
    'something from',
    'is there an',
    "what's",
  ])('holds a real unfinished sentence: %j', (text) => expect(endsDangling(text)).toBe(true));

  it.each(['pon la', 'abre el', 'dile a', 'quiero que', 'busca una canción de', 'pon música', 'pon algo de', 'chào bạn', '播放', 'Beyoncé'])(
    "holds what it can't judge, or what stops mid-sentence in Spanish: %j",
    (text) => expect(endsDangling(text)).toBe(true),
  );

  it.each(['what time is it', 'how are you', 'thank you', 'turn it off', 'turn it up', 'play it', 'show me the weather', 'tell me a joke', 'set a timer for five minutes', 'skip', 'U2', "how's it going", "I don't have any yet"])(
    "still lets a finished order go: %j",
    (text) => expect(endsDangling(text)).toBe(false),
  );
});

describe('asking the words whether to hold', () => {
  const byRule: Options['hooks'] = { shouldHold: (_id, text) => endsDangling(text) };
  const long = 5_000; // a test that wrongly holds runs out of patience first

  it('lets a bare wake go at once', async () => {
    const t = setup([0.02], long, { words: () => 'Hey Adrian', hooks: byRule });
    t.say(seconds(1));
    await until(() => t.heard.length > 0);
    expect(t.heard.map((e) => e.text)).toEqual(['Hey Adrian']);
  });

  it('lets a finished order go at once', async () => {
    const t = setup([0.49], long, { words: () => 'no, just play Ella Langley', hooks: byRule });
    t.say(seconds(1));
    await until(() => t.heard.length > 0);
    expect(t.heard.map((e) => e.text)).toEqual(['no, just play Ella Langley']);
    expect(t.decoded).toEqual([16_000]);
  });

  it('lets side talk go at once when the hook says so', async () => {
    const asked: [string, string][] = [];
    const t = setup([0.2], long, {
      words: () => 'what should I play',
      hooks: { shouldHold: (id, text) => (asked.push([id, text]), false) },
    });
    t.say(seconds(1));
    await until(() => t.heard.length > 0);
    expect(asked).toEqual([['u1', 'what should I play']]);
  });

  it('holds a dangling order and joins what comes next', async () => {
    const t = setup([0.01, 0.02], long, {
      words: (s) => (s.length === 16_000 ? 'Hey Adrian, play' : 'Hey Adrian, play. Ella Langley'),
      hooks: byRule,
    });
    t.say(seconds(1));
    await wait(30);
    expect(t.heard).toEqual([]);
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    expect(t.heardLens).toEqual([28_000]);
    expect(t.heard[0]!.text).toBe('Hey Adrian, play. Ella Langley');
    expect(t.decoded).toEqual([16_000, 28_000]);
  });

  it('holds "tell Sam that" and joins the rest', async () => {
    const t = setup([0.2, 0.9], long, {
      words: (s) => (s.length === 16_000 ? 'Hey Adrian, tell Sam that' : "Hey Adrian, tell Sam that I'm late"),
      hooks: byRule,
    });
    t.say(seconds(1));
    await wait(30);
    expect(t.heard).toEqual([]);
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    expect(t.heard.map((e) => e.text)).toEqual(["Hey Adrian, tell Sam that I'm late"]);
  });

  it("won't cut them off when they're already talking again", async () => {
    const t = setup([0.2, 0.9], 40, { hooks: { shouldHold: () => false } });
    t.p.vad.speaking = true;
    t.say(seconds(1));
    await wait(70); // well past when the words said to let it go
    expect(t.heard).toEqual([]);
    t.p.vad.speaking = false;
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    expect(t.heardLens).toEqual([28_000]);
  });

  it('says how long the clip is, so a window can be judged from when they started', async () => {
    const asked: number[] = [];
    const t = setup([0.2, 0.2], 5_000, { hooks: { shouldHold: (_id, _text, s) => (asked.push(s), asked.length === 1) } });
    t.say(seconds(1));
    await until(() => asked.length === 1);
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    expect(asked).toEqual([1, 1.75]);
  });

  it('still gives up on a dangling order after the extra wait', async () => {
    const t = setup([0.01], 40, { words: () => 'Hey Adrian, play', hooks: byRule });
    t.say(seconds(1));
    await wait(10);
    expect(t.heard).toEqual([]);
    await until(() => t.heard.length > 0);
    expect(t.heard.map((e) => e.text)).toEqual(['Hey Adrian, play']);
    expect(t.decoded).toEqual([16_000]);
  });

  it('holds everything that sounds unfinished without the hook', async () => {
    const t = setup([0.02], 80, { words: () => 'Hey Adrian' });
    t.say(seconds(1));
    await wait(20);
    expect(t.heard).toEqual([]);
    await until(() => t.heard.length > 0);
    expect(t.heard.map((e) => e.text)).toEqual(['Hey Adrian']);
  });

  it("doesn't ask when it sounds finished", async () => {
    const asked: string[] = [];
    const t = setup([0.9], long, { hooks: { shouldHold: (_id, text) => (asked.push(text), false) } });
    t.say(seconds(1));
    await until(() => t.heard.length > 0);
    expect(asked).toEqual([]);
  });

  it('logs a hold only once it stands', async () => {
    const holds: number[] = [];
    const t = setup([0.2, 0.3], 40, {
      words: (s) => (s.length === 16_000 ? 'finished' : 'play the'),
      hooks: byRule,
      onHold: (_id, i) => holds.push(i.probability),
    });
    t.say(seconds(1));
    await until(() => t.heard.length === 1);
    expect(holds).toEqual([]);
    t.say(seconds(0.5));
    await until(() => t.heard.length === 2);
    expect(holds).toEqual([0.3]);
  });

  it("doesn't add slow words to the wait", async () => {
    const asked: string[] = [];
    const t = setup([0.2], 100, {
      words: async () => (await wait(400), 'play the'),
      hooks: { shouldHold: (_id, text) => (asked.push(text), true) },
    });
    t.say(seconds(1));
    await until(() => t.heard.length > 0);
    const e = t.heard[0]!;
    expect(e.segmentClosedAt - e.vadClosedAt!).toBeLessThan(350);
    expect(asked).toEqual([]); // the wait ran out first, so there was nothing left to decide
  });

  it('keeps the hold when the words fail', async () => {
    const asked: string[] = [];
    const t = setup([0.2], 80, {
      words: () => Promise.reject(new Error('boom')),
      hooks: { shouldHold: (_id, text) => (asked.push(text), false) },
    });
    t.say(seconds(1));
    await wait(20);
    expect(t.errors).toEqual([]);
    await until(() => t.errors.length > 0);
    expect(asked).toEqual([]);
    expect(t.errors.map((e) => e.message)).toEqual(['boom']);
  });

  it('survives a hook that throws, and the hold still ends', async () => {
    const t = setup([0.2], 40, {
      hooks: {
        shouldHold: () => {
          throw new Error('hook');
        },
      },
    });
    t.say(seconds(1));
    await until(() => t.heard.length > 0);
    expect(t.errors.map((e) => e.message)).toEqual(['hook']);
    expect(t.heardLens).toEqual([16_000]);
  });
});

describe('only one heard per clip', () => {
  it("won't let old words release a joined clip", async () => {
    const first = deferred<string>();
    const check2 = deferred<number>();
    const asked: string[] = [];
    const t = setup([0.2, check2.promise], 5_000, {
      words: (s) => (s.length === 16_000 ? first.promise : 'joined'),
      hooks: { shouldHold: (_id, text) => (asked.push(text), false) },
    });
    t.say(seconds(1));
    await wait(10);
    t.say(seconds(0.5));
    first.resolve('old words');
    await wait(20);
    expect(asked).toEqual([]);
    expect(t.heard).toEqual([]);
    check2.resolve(0.9);
    await until(() => t.heard.length > 0);
    await wait(10);
    expect(t.heard.map((e) => e.text)).toEqual(['joined']);
    expect(t.heardLens).toEqual([28_000]);
  });

  it('emits once when the wait runs out before the words land', async () => {
    const first = deferred<string>();
    const asked: string[] = [];
    const got: string[] = [];
    const t = setup([0.2], 30, {
      words: () => first.promise,
      hooks: { shouldHold: (_id, text) => (asked.push(text), true), onHeldWords: (_id, w) => got.push(w.text) },
    });
    t.say(seconds(1));
    await wait(80); // released by now, still waiting for the words
    first.resolve('words');
    await until(() => t.heard.length > 0);
    await wait(10);
    expect(t.heard.map((e) => e.text)).toEqual(['words']);
    expect(asked).toEqual([]);
    expect(got).toEqual([]);
  });

  it("won't let old words touch the next chain", async () => {
    const first = deferred<string>();
    const asked: string[] = [];
    const t = setup([0.2, 0.2], 30, {
      words: (s) => (s.length === 16_000 ? first.promise : 'play the'),
      hooks: { shouldHold: (_id, text) => (asked.push(text), text === 'play the') },
    });
    t.say(seconds(1));
    await wait(80); // the first chain's wait is over
    t.say(seconds(0.5)); // a new chain, not a join
    first.resolve('old words');
    await until(() => t.heard.length === 2);
    await wait(10);
    expect(t.heard.map((e) => e.text)).toEqual(['old words', 'play the']);
    expect(asked).toEqual(['play the']);
  });

  it('drops a stale check, whichever answers first', async () => {
    for (const staleFirst of [true, false]) {
      const check1 = deferred<number>();
      const check2 = deferred<number>();
      const t = setup([check1.promise, check2.promise]);
      t.say(seconds(1));
      t.say(seconds(0.5));
      if (staleFirst) {
        check1.resolve(0.9);
        await wait(10);
        expect(t.heard).toEqual([]);
      }
      check2.resolve(0.9);
      await until(() => t.heard.length > 0);
      if (!staleFirst) check1.resolve(0.9);
      await wait(10);
      expect(t.heardLens).toEqual([28_000]);
    }
  });
});

describe('when a clip closed', () => {
  it('says what closed it', async () => {
    const t = setup([0.9, 0.9]);
    t.sayToVad(seconds(1));
    await until(() => t.heard.length === 1);
    t.say(seconds(1));
    await until(() => t.heard.length === 2);
    expect(t.heard.map((e) => e.closedBy)).toEqual(['vad', 'flush']);
  });

  it('stamps a held clip at the VAD close, and leaves segmentClosedAt at release', async () => {
    const t = setup([0.2], 100);
    const said = performance.now();
    t.say(seconds(1));
    const closed = performance.now();
    await until(() => t.heard.length > 0);
    const e = t.heard[0]!;
    expect(e.vadClosedAt!).toBeGreaterThanOrEqual(said);
    expect(e.vadClosedAt!).toBeLessThanOrEqual(closed);
    expect(e.segmentClosedAt - e.vadClosedAt!).toBeGreaterThanOrEqual(95);
    expect(e.holdMs!).toBeGreaterThanOrEqual(95);
    expect(e.turnCheckMs! + e.holdMs!).toBeCloseTo(e.segmentClosedAt - e.vadClosedAt!, -1);
  });

  it('stamps a joined clip at the last close', async () => {
    const t = setup([0.2, 0.9], 200);
    t.say(seconds(1));
    await wait(40);
    const second = performance.now();
    t.say(seconds(0.5));
    await until(() => t.heard.length > 0);
    const e = t.heard[0]!;
    expect(e.vadClosedAt!).toBeGreaterThanOrEqual(second);
    expect(e.holdMs).toBe(0); // the wait before the join was them talking
  });

  it('times the check and reports no hold on a clip that sounds finished', async () => {
    const check = deferred<number>();
    const t = setup([check.promise]);
    t.say(seconds(1));
    await wait(30);
    check.resolve(0.9);
    await until(() => t.heard.length > 0);
    expect(t.heard[0]!.turnCheckMs!).toBeGreaterThanOrEqual(25);
    expect(t.heard[0]!.holdMs).toBe(0);
  });

  it('has no check or hold figures where nothing checks', async () => {
    const t = setup([], 60, { noTurn: true });
    const said = performance.now();
    t.sayToVad(seconds(1));
    await until(() => t.heard.length > 0);
    const e = t.heard[0]!;
    expect(e.vadClosedAt!).toBeGreaterThanOrEqual(said);
    expect(e.closedBy).toBe('vad');
    expect(e).not.toHaveProperty('turnCheckMs');
    expect(e).not.toHaveProperty('holdMs');
  });
});
