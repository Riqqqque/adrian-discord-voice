// The local voice (Kokoro) at start. It holds about 0.5 GB once loaded and
// calibrated. When the cloud voice speaks English, Kokoro only stands in when
// the cloud can't (an outage, a timeout, a spent month) and for the wizard's
// preview, so it loads then, on first use, instead of at every start: the
// server's memory guard kills the bot first when memory runs out, and those
// 0.5 GB were most of the margin. The first stand-in sentence after a start
// then waits for the load (calibration is kept between starts in the state
// dir), and the cloud voice starts the load early at the first sign of
// trouble (see SpeechifyTts.warmFallback).

import { existsSync } from 'node:fs';
import type { Logger } from '../core/interfaces.js';
import { kokoroFiles } from '../speech/kokoro.js';
import { rssMb } from './memory.js';

export interface LocalVoice {
  gainFor(voice: string, speed: number): Promise<number>;
  keepGainsIn?(file: string): void;
  /** Load the engine and calibrate (a kept gain alone loads nothing). */
  prepare?(voice: string, speed: number): Promise<void>;
}

/** Whether the cloud voice will speak English (stack.ts builds it on the same terms). */
export function cloudVoicePrimary(cv: { enabled: boolean; apiKeySecret: string } | undefined, secrets: Map<string, string>): boolean {
  return !!cv?.enabled && !!secrets.get(cv.apiKeySecret);
}

/** Load and calibrate now, or leave it for its first use. Returns the gain when loaded. */
export async function prepareLocalVoice(
  tts: LocalVoice,
  o: { modelDir: string; modelFile?: string; voice: string; speed: number; cloudPrimary: boolean; gainFile?: string | undefined },
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<number | undefined> {
  const t = performance.now();
  if (o.gainFile) tts.keepGainsIn?.(o.gainFile);
  if (o.cloudPrimary) {
    // Said now, not when the cloud first fails. The cloud voice can still talk
    // without it, so this no longer stops the start as a failed load did.
    const missing = kokoroFiles(o.modelDir, o.modelFile, o.voice).filter((f) => !existsSync(f));
    if (missing.length) log.error('local voice files missing; nothing stands in if the cloud voice fails', { missing });
    else log.info('local voice loads on first use', { voice: o.voice, why: 'cloud voice is primary' });
    return undefined;
  }
  // The engine loads now even when the gain was kept from an earlier start.
  await tts.prepare?.(o.voice, o.speed);
  const gainDb = await tts.gainFor(o.voice, o.speed);
  log.info('tts loaded and calibrated', { ms: Math.round(performance.now() - t), voice: o.voice, gainDb: Number(gainDb.toFixed(2)), rssMb: rssMb() });
  return gainDb;
}
