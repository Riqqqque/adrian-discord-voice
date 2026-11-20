// The local voice at start: loaded and calibrated when it speaks English, left
// for its first use when the cloud voice does, and still there, loaded on the
// spot, when the cloud fails. Kokoro itself is faked (no models in tests).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const fresh = async () => ({
    generateAsync: async ({ text }: { text: string }) => {
      said.push(text);
      return { samples: tone(), sampleRate: 24_000 };
    },
  });
  return { createAsync, said, fresh };
});
vi.mock('sherpa-onnx-node', () => ({ default: { OfflineTts: { createAsync: engine.createAsync } } }));

import { cloudVoicePrimary, prepareLocalVoice } from '../src/app/local-voice.js';
import { KokoroTts, LOAD_RETRY_MS } from '../src/speech/kokoro.js';
import { CharBudget, SpeechifyTts } from '../src/speech/speechify.js';

/** A complete Kokoro folder (empty files: the engine is faked). */
function kokoroDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'adrian-kokoro-'));
  for (const f of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt']) writeFileSync(join(d, f), '');
  mkdirSync(join(d, 'espeak-ng-data'));
  return d;
}
const modelDir = kokoroDir();
const voice = { modelDir, voice: 'af_heart', speed: 1 };

function logger() {
  const lines: { level: string; m: string; f?: Record<string, unknown> }[] = [];
  return {
    lines,
    info: (m: string, f?: Record<string, unknown>) => void lines.push({ level: 'info', m, ...(f ? { f } : {}) }),
    warn: (m: string, f?: Record<string, unknown>) => void lines.push({ level: 'warn', m, ...(f ? { f } : {}) }),
    error: (m: string, f?: Record<string, unknown>) => void lines.push({ level: 'error', m, ...(f ? { f } : {}) }),
  };
}

beforeEach(() => {
  engine.createAsync.mockClear();
  engine.createAsync.mockReset();
  engine.createAsync.mockImplementation(engine.fresh);
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
    expect(log.lines.map((l) => [l.level, l.m])).toEqual([['error', 'local voice files missing; nothing stands in if the cloud voice fails']]);
  });

  it('says so at start when any file it needs is missing, not only the model', async () => {
    const dir = kokoroDir();
    rmSync(join(dir, 'tokens.txt'));
    const log = logger();
    await prepareLocalVoice(new KokoroTts({ modelDir: dir, threads: 4 }), { ...voice, modelDir: dir, cloudPrimary: true }, log);
    expect(log.lines).toEqual([{ level: 'error', m: 'local voice files missing; nothing stands in if the cloud voice fails', f: { missing: [`${dir}/tokens.txt`] } }]);
    expect(engine.createAsync).not.toHaveBeenCalled();
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

describe('a local voice that fails to load', () => {
  it('is tried again after a while instead of failing every sentence until a restart', async () => {
    let now = 1_000_000;
    const tts = new KokoroTts({ modelDir, threads: 4, now: () => now });
    engine.createAsync.mockRejectedValueOnce(new Error('Failed to create OfflineTts'));
    await expect(tts.synthesize('One.', { voice: 'af_heart', speed: 1 })).rejects.toThrow('Failed to create OfflineTts');
    expect(engine.createAsync).toHaveBeenCalledTimes(1);
    // Within the wait: the same error at once, no second native load.
    now += LOAD_RETRY_MS - 1;
    await expect(tts.synthesize('Two.', { voice: 'af_heart', speed: 1 })).rejects.toThrow('Failed to create OfflineTts');
    expect(engine.createAsync).toHaveBeenCalledTimes(1);
    // After it (the files were fixed meanwhile): loads, calibrates and speaks.
    now += 1;
    const a = await tts.synthesize('Three.', { voice: 'af_heart', speed: 1 });
    expect(a.samples.length).toBeGreaterThan(0);
    expect(engine.createAsync).toHaveBeenCalledTimes(2);
    expect(engine.said.at(-1)).toBe('Three.');
  });

  it('waits longer after each failure', async () => {
    let now = 0;
    const tts = new KokoroTts({ modelDir, threads: 4, now: () => now });
    engine.createAsync.mockRejectedValue(new Error('broken'));
    await expect(tts.synthesize('a', { voice: 'af_heart', speed: 1 })).rejects.toThrow();
    now += LOAD_RETRY_MS;
    await expect(tts.synthesize('b', { voice: 'af_heart', speed: 1 })).rejects.toThrow();
    expect(engine.createAsync).toHaveBeenCalledTimes(2);
    now += LOAD_RETRY_MS; // not yet: the wait doubled
    await expect(tts.synthesize('c', { voice: 'af_heart', speed: 1 })).rejects.toThrow();
    expect(engine.createAsync).toHaveBeenCalledTimes(2);
    now += LOAD_RETRY_MS;
    await expect(tts.synthesize('d', { voice: 'af_heart', speed: 1 })).rejects.toThrow();
    expect(engine.createAsync).toHaveBeenCalledTimes(3);
  });
});

describe('calibration kept between starts', () => {
  const said = () => engine.said.length;

  it('a later start uses the kept gain: no calibration sentences, same samples', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'adrian-state-')), 'voice-gains.json');
    const first = new KokoroTts({ modelDir, threads: 4 });
    await prepareLocalVoice(first, { ...voice, cloudPrimary: true, gainFile: file }, logger());
    const a = await first.synthesize('The capital of Australia is Canberra.', { voice: 'af_heart', speed: 1 });
    expect(said()).toBe(3); // two calibration sentences + the line
    expect(existsSync(file)).toBe(true);

    engine.said.length = 0;
    const second = new KokoroTts({ modelDir, threads: 4 });
    await prepareLocalVoice(second, { ...voice, cloudPrimary: true, gainFile: file }, logger());
    const b = await second.synthesize('The capital of Australia is Canberra.', { voice: 'af_heart', speed: 1 });
    expect(engine.said).toEqual(['The capital of Australia is Canberra.']);
    expect(Array.from(b.samples)).toEqual(Array.from(a.samples));
  });

  it('a start where it is the English voice still loads it, though the gain was kept', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'adrian-state-')), 'voice-gains.json');
    await prepareLocalVoice(new KokoroTts({ modelDir, threads: 4 }), { ...voice, cloudPrimary: false, gainFile: file }, logger());
    engine.createAsync.mockClear();
    engine.said.length = 0;
    const log = logger();
    await prepareLocalVoice(new KokoroTts({ modelDir, threads: 4 }), { ...voice, cloudPrimary: false, gainFile: file }, log);
    expect(engine.createAsync).toHaveBeenCalledTimes(1); // loaded at start, not on the first answer
    expect(engine.said).toEqual([]); // but not calibrated again
    expect(log.lines.map((l) => l.m)).toEqual(['tts loaded and calibrated']);
  });

  it('is measured again when the voice files, the voice or the speed change', async () => {
    const dir = kokoroDir();
    const file = join(mkdtempSync(join(tmpdir(), 'adrian-state-')), 'voice-gains.json');
    const make = () => {
      const t = new KokoroTts({ modelDir: dir, threads: 4 });
      t.keepGainsIn(file);
      return t;
    };
    await make().gainFor('af_heart', 1);
    expect(said()).toBe(2);
    await make().gainFor('af_heart', 1);
    expect(said()).toBe(2); // kept
    await make().gainFor('af_heart', 1.1);
    expect(said()).toBe(4); // another speed
    await make().gainFor('af_bella', 1);
    expect(said()).toBe(6); // another voice
    writeFileSync(join(dir, 'voices.bin'), 'a new voice pack');
    await make().gainFor('af_heart', 1);
    expect(said()).toBe(8); // other voice files: the kept one would be stale
    expect(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { gains: object }).gains)).toHaveLength(4);
  });

  it('a file it cannot read is a calibration, not an error', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'adrian-state-')), 'voice-gains.json');
    writeFileSync(file, '{not json');
    const t = new KokoroTts({ modelDir, threads: 4 });
    t.keepGainsIn(file);
    await expect(t.gainFor('af_heart', 1)).resolves.toEqual(expect.any(Number));
    expect(said()).toBe(2);
  });

  it('a calibration that fails is not kept: the next call measures again', async () => {
    const t = new KokoroTts({ modelDir, threads: 4 });
    let fail = true;
    engine.createAsync.mockResolvedValueOnce({
      generateAsync: async ({ text }: { text: string }) => {
        if (fail) throw new Error('synth broke');
        engine.said.push(text);
        return { samples: new Float32Array(12_000).fill(0.1), sampleRate: 24_000 };
      },
    } as never);
    await expect(t.gainFor('af_heart', 1)).rejects.toThrow('synth broke');
    fail = false;
    await expect(t.gainFor('af_heart', 1)).resolves.toEqual(expect.any(Number));
    expect(engine.createAsync).toHaveBeenCalledTimes(1); // the engine loaded fine and stays
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
