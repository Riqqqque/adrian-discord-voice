// The local voice at start: loaded and calibrated when it speaks English, left
// for its first use when the cloud voice does, and still there, loaded on the
// spot, when the cloud fails. Kokoro itself is faked (no models in tests).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => {
  /** Half a second of a 220 Hz tone at 24 kHz, as Kokoro would hand back. */
  const tone = () => Float32Array.from({ length: 12_000 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / 24_000));
  const said: string[] = [];
  const createAsync = vi.fn(async () => ({
    generateAsync: async ({ text }: { text: string }) => {
      said.push(text);
      return { samples: tone(), sampleRate: 24_000 };
    },
  }));
  return { createAsync, said };
});
vi.mock('sherpa-onnx-node', () => ({ default: { OfflineTts: { createAsync: engine.createAsync } } }));

import { cloudVoicePrimary, prepareLocalVoice } from '../src/app/local-voice.js';
import { KokoroTts } from '../src/speech/kokoro.js';
import { CharBudget, SpeechifyTts } from '../src/speech/speechify.js';

const modelDir = mkdtempSync(join(tmpdir(), 'adrian-kokoro-'));
writeFileSync(join(modelDir, 'model.onnx'), '');
const voice = { modelDir, voice: 'af_heart', speed: 1 };

function logger() {
  const lines: { level: string; m: string; f?: Record<string, unknown> }[] = [];
  return {
    lines,
    info: (m: string, f?: Record<string, unknown>) => void lines.push({ level: 'info', m, ...(f ? { f } : {}) }),
    warn: (m: string, f?: Record<string, unknown>) => void lines.push({ level: 'warn', m, ...(f ? { f } : {}) }),
  };
}

beforeEach(() => {
  engine.createAsync.mockClear();
  engine.said.length = 0;
});

describe('the local voice at start', () => {
  it('loads and calibrates when it is the voice that speaks English', async () => {
    const tts = new KokoroTts({ modelDir, threads: 4 });
    const log = logger();
    const gain = await prepareLocalVoice(tts, { ...voice, cloudPrimary: false }, log);
    expect(Number.isFinite(gain)).toBe(true);
    expect(engine.createAsync).toHaveBeenCalledTimes(1);
    expect(engine.said).toHaveLength(2); // the two calibration sentences
    expect(log.lines.map((l) => l.m)).toEqual(['tts loaded and calibrated']);
  });

  it('is left for its first use when the cloud voice speaks English', async () => {
    const tts = new KokoroTts({ modelDir, threads: 4 });
    const log = logger();
    await expect(prepareLocalVoice(tts, { ...voice, cloudPrimary: true }, log)).resolves.toBeUndefined();
    expect(engine.createAsync).not.toHaveBeenCalled();
    expect(log.lines).toEqual([{ level: 'info', m: 'local voice loads on first use', f: { voice: 'af_heart', why: 'cloud voice is primary' } }]);
  });

  it('says at start when there is no model to stand in, without stopping the start', async () => {
    const tts = new KokoroTts({ modelDir: join(modelDir, 'missing'), threads: 4 });
    const log = logger();
    await expect(prepareLocalVoice(tts, { ...voice, modelDir: join(modelDir, 'missing'), cloudPrimary: true }, log)).resolves.toBeUndefined();
    expect(log.lines.map((l) => [l.level, l.m])).toEqual([['warn', 'local voice model not found; nothing stands in if the cloud voice fails']]);
  });

  it('still stands in when the cloud fails: loaded on the spot, calibrated, and leveled the same as before', async () => {
    const lazy = new KokoroTts({ modelDir, threads: 4 });
    await prepareLocalVoice(lazy, { ...voice, cloudPrimary: true }, logger());
    const down = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    const log = logger();
    const cloud = new SpeechifyTts({ apiKey: 'k', voiceId: 'sabrina', model: 'simba-3.5', timeoutMs: 2000, budget: new CharBudget(undefined, 0, 'UTC'), log, fetch: down }, lazy, 'af_heart');
    const a = await cloud.synthesize('The capital of Australia is Canberra.', { voice: 'cloud:en', speed: 1 });
    expect(engine.createAsync).toHaveBeenCalledTimes(1);
    expect(engine.said).toEqual([expect.any(String), expect.any(String), 'The capital of Australia is Canberra.']);
    expect(log.lines.some((l) => l.m === 'cloud voice failed; local voice for a minute')).toBe(true);

    // The same sentence from a Kokoro that was calibrated at start: same samples.
    const eager = new KokoroTts({ modelDir, threads: 4 });
    await prepareLocalVoice(eager, { ...voice, cloudPrimary: false }, logger());
    const b = await eager.synthesize('The capital of Australia is Canberra.', { voice: 'af_heart', speed: 1 });
    expect(a.sampleRate).toBe(b.sampleRate);
    expect(Array.from(a.samples)).toEqual(Array.from(b.samples));

    // The next sentence in the outage needs no second load.
    const loads = engine.createAsync.mock.calls.length;
    await cloud.synthesize('And it is sunny there.', { voice: 'cloud:en', speed: 1 });
    expect(engine.createAsync).toHaveBeenCalledTimes(loads);
    expect(engine.said.at(-1)).toBe('And it is sunny there.');
  });
});

describe('whether the cloud voice speaks English', () => {
  it('needs it on and its key set', () => {
    const on = { enabled: true, apiKeySecret: 'SPEECHIFY_API_KEY' };
    expect(cloudVoicePrimary(on, new Map([['SPEECHIFY_API_KEY', 'k']]))).toBe(true);
    expect(cloudVoicePrimary(on, new Map())).toBe(false);
    expect(cloudVoicePrimary({ ...on, enabled: false }, new Map([['SPEECHIFY_API_KEY', 'k']]))).toBe(false);
    expect(cloudVoicePrimary(undefined, new Map([['SPEECHIFY_API_KEY', 'k']]))).toBe(false);
  });
});
