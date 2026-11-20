// The local voice (Kokoro) at start. It holds about 0.5 GB once loaded and
// calibrated. When the cloud voice speaks English, Kokoro only stands in when
// the cloud can't (an outage, a timeout, a spent month) and for the wizard's
// preview, so it loads then, on first use, instead of at every start: the
// server's memory guard kills the bot first when memory runs out, and those
// 0.5 GB were most of the margin. The first stand-in sentence after a start
// then waits for the load and calibration (a few seconds, once).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/interfaces.js';
import { rssMb } from './memory.js';

export interface LocalVoice {
  gainFor(voice: string, speed: number): Promise<number>;
}

/** Whether the cloud voice will speak English (stack.ts builds it on the same terms). */
export function cloudVoicePrimary(cv: { enabled: boolean; apiKeySecret: string } | undefined, secrets: Map<string, string>): boolean {
  return !!cv?.enabled && !!secrets.get(cv.apiKeySecret);
}

/** Load and calibrate now, or leave it for its first use. Returns the gain when loaded. */
export async function prepareLocalVoice(
  tts: LocalVoice,
  o: { modelDir: string; modelFile?: string; voice: string; speed: number; cloudPrimary: boolean },
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<number | undefined> {
  const t = performance.now();
  if (o.cloudPrimary) {
    // Said now, not when the cloud first fails. The cloud voice can still talk
    // without it, so this no longer stops the start as a failed load did.
    const model = join(o.modelDir, o.modelFile ?? 'model.onnx');
    if (!existsSync(model)) log.warn('local voice model not found; nothing stands in if the cloud voice fails', { model });
    else log.info('local voice loads on first use', { voice: o.voice, why: 'cloud voice is primary' });
    return undefined;
  }
  const gainDb = await tts.gainFor(o.voice, o.speed);
  log.info('tts loaded and calibrated', { ms: Math.round(performance.now() - t), voice: o.voice, gainDb: Number(gainDb.toFixed(2)), rssMb: rssMb() });
  return gainDb;
}
