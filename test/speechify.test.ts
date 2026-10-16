import { describe, expect, it } from 'vitest';
import type { TextToSpeech } from '../src/core/interfaces.js';
import { CharBudget, pcm16ToFloat, SpeechifyTts, speechInput } from '../src/speech/speechify.js';

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
