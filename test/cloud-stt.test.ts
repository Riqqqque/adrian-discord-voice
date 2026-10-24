import { afterEach, describe, expect, it, vi } from 'vitest';
import { groqTranscribe, sttPrompt } from '../src/speech/cloud-stt.js';

afterEach(() => vi.unstubAllGlobals());

describe('cloud speech-to-text', () => {
  it('sends a 16 kHz WAV with the model, prompt and key, and returns the words', async () => {
    let seen: { url: string; auth: string; form: FormData } | undefined;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization, form: init.body as FormData };
      return new Response(JSON.stringify({ text: ' Pause the show. ' }), { status: 200 });
    });
    const text = await groqTranscribe('k', new Float32Array(1600).fill(0.1), 16_000, { prompt: sttPrompt(['Rique']) });
    expect(text).toBe('Pause the show.');
    expect(seen!.url).toContain('api.groq.com/openai/v1/audio/transcriptions');
    expect(seen!.auth).toBe('Bearer k');
    expect(seen!.form.get('model')).toBe('whisper-large-v3-turbo');
    expect(String(seen!.form.get('prompt'))).toContain('Rique');
    const file = seen!.form.get('file') as Blob;
    const head = new DataView(await file.arrayBuffer());
    expect(head.getUint32(24, true)).toBe(16_000); // sample rate
    expect(file.size).toBe(44 + 1600 * 2);
  });

  it('throws on errors so the caller keeps the local words', async () => {
    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429 }));
    await expect(groqTranscribe('k', new Float32Array(10), 16_000)).rejects.toThrow('429');
  });
});
