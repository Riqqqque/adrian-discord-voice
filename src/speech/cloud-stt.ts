// A second, more accurate listen for what's said to her: Whisper large v3
// turbo on Groq. The local model still does all the listening (wake phrase,
// side talk); only speech meant for her is sent here.

/** 16-bit mono WAV in memory. */
export function wav(samples: Float32Array, rate: number): Uint8Array {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const w = (o: number, s: string) => [...s].forEach((ch, i) => data.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  data.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  w(36, 'data');
  data.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 32767, true);
  return new Uint8Array(data.buffer);
}

/** Words Whisper should expect: her name, people, and things often asked for at a PC. */
export function sttPrompt(names: string[] = []): string {
  return [
    'Hey Adrian,',
    ...names,
    'Spotify, Discord, Valorant, Steam, Chrome, YouTube, Netflix, Modrinth, CurseForge, Minecraft, Fabric, Forge, OBS, FL Studio.',
  ]
    .join(' ')
    .slice(0, 600);
}

export interface CloudSttOptions {
  model?: string;
  /** Vocabulary and style hint (names, apps). */
  prompt?: string;
  /** ISO language when known ('en'); unset lets Whisper detect it. */
  language?: string;
  signal?: AbortSignal;
}

/** Transcribe 16 kHz mono audio with Groq's Whisper. Throws on any failure. */
export async function groqTranscribe(apiKey: string, samples: Float32Array, rate: number, o: CloudSttOptions = {}): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([wav(samples, rate)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', o.model ?? 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (o.prompt) form.append('prompt', o.prompt);
  if (o.language) form.append('language', o.language);
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok) throw new Error(`Groq STT HTTP ${res.status}`);
  const j = (await res.json()) as { text?: string };
  return (j.text ?? '').trim();
}
