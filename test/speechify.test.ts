import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextToSpeech } from '../src/core/interfaces.js';
import { CharBudget, pcm16ToFloat, SpeechifyTts, type SpeechifyOptions, speechInput } from '../src/speech/speechify.js';

const quiet = { info() {}, warn() {} };

/** One second of a 220 Hz tone as 16-bit PCM. */
function tone(): Buffer {
  const b = Buffer.alloc(24_000 * 2);
  for (let i = 0; i < 24_000; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 24_000) * 8000), i * 2);
  return b;
}

function fakeFetch(fail = false) {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (fail) return new Response('nope', { status: 503 });
    return new Response(tone(), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

const local: TextToSpeech & { calls: string[] } = {
  calls: [],
  async synthesize(text, opts) {
    this.calls.push(`${opts.voice}:${text}`);
    return { samples: new Float32Array(100), sampleRate: 24_000, synthMs: 1 };
  },
};

describe('speechify voice', () => {
  it('speaks through the API, counts characters and caches short lines', async () => {
    const { f, bodies } = fakeFetch();
    const budget = new CharBudget(undefined, 0, 'UTC');
    const tts = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.2', timeoutMs: 2000, budget, log: quiet, fetch: f }, local, 'af_heart');
    const a = await tts.synthesize('Yes?', { voice: 'cloud:en', speed: 1 });
    expect(a.sampleRate).toBe(24_000);
    expect(a.samples.length).toBe(24_000);
    expect(bodies[1]).toMatchObject({ input: 'Yes?', voice_id: 'sabrina', model: 'simba-3.2', output_format: 'pcm_24000' });
    await tts.synthesize('Yes?', { voice: 'cloud:en', speed: 1 });
    expect(bodies).toHaveLength(2); // calibration + one request; the repeat came from the cache
    expect(budget.used()).toBeGreaterThan(4);
  });

  it('speaks at its own rate on top of the one asked for, and the local voice keeps the plain one', async () => {
    const { f, bodies } = fakeFetch();
    const tts = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.2', timeoutMs: 2000, speed: 1.2, budget: new CharBudget(undefined, 0, 'UTC'), log: quiet, fetch: f }, local, 'af_heart');
    await tts.synthesize('A whole sentence that is long enough not to be cached here.', { voice: 'cloud:en', speed: 1 });
    expect(bodies.at(-1)!.input).toContain('rate="+20%"');
    await tts.synthesize('Another sentence, long enough to skip the short-line cache.', { voice: 'cloud:en', speed: 0.9 });
    expect(bodies.at(-1)!.input).toContain('rate="+8%"'); // "slower" still slows her down
  });

  it('falls back to the local voice on errors and when the month is used up', async () => {
    let now = 0;
    local.calls = [];
    const bad = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.2', timeoutMs: 2000, budget: new CharBudget(undefined, 0, 'UTC'), log: quiet, fetch: fakeFetch(true).f, now: () => now }, local, 'af_heart');
    await bad.synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
    expect(local.calls).toEqual(['af_heart:Hello there, friend.']);
    expect(bad.available(10)).toBe(false); // paused for a minute
    now += 61_000;
    expect(bad.available(10)).toBe(true);

    // A refused line (400) falls back for that line only, no pause.
    const refusing = (async () => new Response('policy', { status: 400 })) as unknown as typeof fetch;
    const picky = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.2', timeoutMs: 2000, budget: new CharBudget(undefined, 0, 'UTC'), log: quiet, fetch: refusing }, local, 'af_heart');
    await picky.synthesize('Something it will not say.', { voice: 'cloud:en', speed: 1 });
    expect(local.calls.at(-1)).toBe('af_heart:Something it will not say.');
    expect(picky.available(10)).toBe(true);

    const full = new CharBudget(undefined, 10, 'UTC');
    full.add(8);
    const capped = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.2', timeoutMs: 2000, budget: full, log: quiet, fetch: fakeFetch().f }, local, 'af_heart');
    await capped.synthesize('This is too long for the budget.', { voice: 'cloud:en', speed: 1 });
    expect(local.calls.at(-1)).toBe('af_heart:This is too long for the budget.');
  });

  it('budget resets each month', () => {
    let now = Date.UTC(2026, 9, 31, 12);
    const b = new CharBudget(undefined, 100, 'UTC', () => now);
    b.add(90);
    expect(b.allows(20)).toBe(false);
    now = Date.UTC(2026, 10, 1, 12);
    expect(b.allows(20)).toBe(true);
  });

  it('uses SSML only when the speed changes, and escapes it', () => {
    expect(speechInput('Hi & bye', 1)).toBe('Hi & bye');
    expect(speechInput('Hi & <bye>', 1.1)).toBe('<speak><prosody rate="+10%">Hi &amp; &lt;bye&gt;</prosody></speak>');
    expect(speechInput('Slow', 0.8)).toContain('rate="-20%"');
  });

  it('reads 16-bit PCM', () => {
    const b = Buffer.alloc(4);
    b.writeInt16LE(16384, 0);
    b.writeInt16LE(-32768, 2);
    expect(Array.from(pcm16ToFloat(b))).toEqual([0.5, -1]);
  });
});

const MINUTE = 60_000;

function voice(o: Partial<SpeechifyOptions>) {
  return new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.2', timeoutMs: 2000, budget: new CharBudget(undefined, 0, 'UTC'), log: quiet, ...o }, local, 'af_heart');
}

describe('speechify warm-up', () => {
  afterEach(() => void vi.restoreAllMocks());

  it('sends a few characters, once, and only after 30 idle minutes', async () => {
    let now = 0;
    const { f, bodies } = fakeFetch();
    const budget = new CharBudget(undefined, 0, 'UTC');
    const tts = voice({ fetch: f, budget, now: () => now });
    await Promise.all([tts.warmIfIdle(), tts.warmIfIdle()]); // two people start talking at once
    expect(bodies).toHaveLength(1);
    const said = String(bodies[0]!.input);
    expect(said.length).toBeLessThanOrEqual(5);
    expect(bodies[0]).toMatchObject({ voice_id: 'sabrina', model: 'simba-3.2', output_format: 'pcm_24000' });
    expect(budget.used()).toBe(said.length);

    now += 30 * MINUTE;
    await tts.warmIfIdle();
    expect(bodies).toHaveLength(1);
    now += 1;
    await tts.warmIfIdle();
    expect(bodies).toHaveLength(2);
    expect(budget.used()).toBe(said.length * 2);
  });

  it('counts real sentences as calls, but not lines played from the cache', async () => {
    let now = 40 * MINUTE;
    const { f, bodies } = fakeFetch();
    const tts = voice({ fetch: f, now: () => now });
    await tts.synthesize('Yes?', { voice: 'cloud:en', speed: 1 });
    const sent = bodies.length;
    now += 29 * MINUTE;
    await tts.warmIfIdle();
    expect(bodies).toHaveLength(sent);
    await tts.synthesize('Yes?', { voice: 'cloud:en', speed: 1 }); // cached: no call
    now += 2 * MINUTE;
    await tts.warmIfIdle();
    expect(bodies).toHaveLength(sent + 1);
  });

  it('bypasses the short-line cache', async () => {
    const { f, bodies } = fakeFetch();
    const tts = voice({ fetch: f });
    await tts.warmIfIdle();
    const said = String(bodies[0]!.input);
    await tts.synthesize(said, { voice: 'cloud:en', speed: 1 }); // not served by the warm-up
    expect(bodies.at(-1)).toMatchObject({ input: said });
    expect(bodies).toHaveLength(3); // warm-up, calibration, the line
  });

  it('swallows failures and never pauses the voice', async () => {
    local.calls = [];
    const broken = new TypeError('fetch failed', { cause: new Error('other side closed') });
    for (const f of [fakeFetch(true).f, (async () => Promise.reject(broken)) as unknown as typeof fetch, (async () => Promise.reject(new Error('odd'))) as unknown as typeof fetch]) {
      const tts = voice({ fetch: f });
      await expect(tts.warmIfIdle()).resolves.toBeUndefined();
      expect(tts.available(10)).toBe(true);
    }
    expect(local.calls).toEqual([]);
  });

  it('has its own 4 s limit and really gives up at it', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const limits: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      limits.push(ms);
      return realTimeout(5);
    });
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const tts = voice({ fetch: hang, timeoutMs: 60_000 });
    await expect(tts.warmIfIdle()).resolves.toBeUndefined();
    expect(limits).toEqual([4_000]);
    expect(tts.available(10)).toBe(true);
  });

  it('stays quiet when the month is used up', async () => {
    const { f, bodies } = fakeFetch();
    const budget = new CharBudget(undefined, 10, 'UTC');
    budget.add(10);
    await voice({ fetch: f, budget }).warmIfIdle();
    expect(bodies).toEqual([]);
  });

  it('goes quiet after a failure too, so a dead API never sees them stack up', async () => {
    let now = 0;
    let calls = 0;
    const f = (async () => (calls++, new Response('nope', { status: 503 }))) as unknown as typeof fetch;
    const tts = voice({ fetch: f, now: () => now });
    await Promise.all([tts.warmIfIdle(), tts.warmIfIdle(), tts.warmIfIdle()]);
    await tts.warmIfIdle();
    expect(calls).toBe(1);
    now += 30 * MINUTE + 1;
    await tts.warmIfIdle();
    expect(calls).toBe(2);
  });

  it('charges nothing for a warm-up that failed', async () => {
    const budget = new CharBudget(undefined, 0, 'UTC');
    await voice({ fetch: fakeFetch(true).f, budget }).warmIfIdle();
    expect(budget.used()).toBe(0);
  });
});

describe('speechify broken connections', () => {
  const brokenSocket = () => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

  /** Fails the calls whose number (from 1) is listed, the given way. */
  function flaky(fail: Record<number, () => unknown>) {
    let calls = 0;
    const f = (async () => {
      const how = fail[++calls];
      if (how) throw how();
      return new Response(tone(), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls: () => calls };
  }

  it('tries again at once, without pausing the voice', async () => {
    local.calls = [];
    const { f, calls } = flaky({ 1: brokenSocket, 3: brokenSocket });
    const tts = voice({ fetch: f });
    const a = await tts.synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
    expect(a.samples.length).toBe(24_000);
    expect(calls()).toBe(4); // calibration twice, the sentence twice
    expect(local.calls).toEqual([]);
    expect(tts.available(10)).toBe(true);
  });

  it('counts a sentence that took two tries once', async () => {
    const used = async (fail: Record<number, () => unknown>) => {
      const budget = new CharBudget(undefined, 0, 'UTC');
      await voice({ fetch: flaky(fail).f, budget }).synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
      return budget.used();
    };
    expect(await used({ 1: brokenSocket, 3: brokenSocket })).toBe(await used({}));
  });

  it('pauses the voice when the second try fails too', async () => {
    local.calls = [];
    const { f, calls } = flaky({ 1: brokenSocket, 2: brokenSocket });
    const tts = voice({ fetch: f });
    await tts.synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
    expect(calls()).toBe(2);
    expect(local.calls).toEqual(['af_heart:Hello there, friend.']);
    expect(tts.available(10)).toBe(false);
  });

  it('leaves everything else to the existing path', async () => {
    const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const badRequest = () => new TypeError('Headers.append: invalid header value'); // never reached the network
    for (const how of [timeout, badRequest]) {
      const { f, calls } = flaky({ 1: how });
      const tts = voice({ fetch: f });
      await tts.synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
      expect(calls()).toBe(1);
      expect(tts.available(10)).toBe(false);
    }

    let answers = 0;
    const down = (async () => (answers++, new Response('nope', { status: 503 }))) as unknown as typeof fetch;
    await voice({ fetch: down }).synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
    expect(answers).toBe(1); // an answer from the API isn't a broken connection
  });

  it('does not try again after a stop or the time limit', async () => {
    const stop = new AbortController();
    let calls = 0;
    const stopped = (async () => {
      if (++calls === 1) return new Response(tone(), { status: 200 }); // calibration
      stop.abort(); // stopped just as the socket broke
      throw brokenSocket();
    }) as unknown as typeof fetch;
    await expect(voice({ fetch: stopped }).synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 }, stop.signal)).rejects.toThrow();
    expect(calls).toBe(2);

    let tries = 0;
    const late = ((_url: string, init: RequestInit) => {
      tries++;
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(brokenSocket())));
    }) as unknown as typeof fetch;
    await voice({ fetch: late, timeoutMs: 5 }).synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
    expect(tries).toBe(1);
  });

  describe('against a real socket', () => {
    let server: Server | undefined;
    afterEach(() => {
      server?.closeAllConnections();
      server?.close();
    });

    it('survives one dropped before the answer and one dropped mid-answer', async () => {
      local.calls = [];
      let requests = 0;
      const srv = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          requests++;
          if (requests === 1) return void req.socket.destroy();
          if (requests === 3) {
            res.writeHead(200, { 'Content-Length': String(48_000) });
            res.write(Buffer.alloc(1_000));
            return void setImmediate(() => res.socket?.destroy());
          }
          res.end(tone());
        });
      });
      server = srv;
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
      const tts = voice({ fetch: ((_url: string, init: RequestInit) => fetch(base, init)) as unknown as typeof fetch });
      const a = await tts.synthesize('Hello there, friend.', { voice: 'cloud:en', speed: 1 });
      expect(a.samples.length).toBe(24_000);
      expect(requests).toBe(4);
      expect(local.calls).toEqual([]);
      expect(tts.available(10)).toBe(true);
    });
  });
});
