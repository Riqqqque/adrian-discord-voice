// Sound effects on request: "make an airhorn sound", "do a drum roll", "cat
// meow". A short clip is found on YouTube and played once over whatever is
// going on (music ducks under it, like under speech).

import type { Tool } from '../core/interfaces.js';
import type { Track } from './music.js';

export interface SoundDeps {
  find(query: string, signal: AbortSignal): Promise<Track | undefined>;
  /** Start playing; resolves once it has started. */
  play(t: Track): Promise<void>;
}

/** Prompt line: sounds are something it can do. */
export const SOUND_RULE =
  'You can make sounds in the call: when someone asks for a sound or asks you to make or do one (meow, bark, an airhorn, a drum roll, a fart, any noise), call play_sound right away with a short description, and say nothing yourself: no words before it and no imitation of the sound. The clip is the whole answer.';

export function soundTool(d: SoundDeps): Tool {
  return {
    spec: {
      name: 'play_sound',
      description:
        'Play a short sound effect in the voice call (up to 15 seconds): animals, instruments, effects like an airhorn, drum roll, applause, thunder, a doorbell, a meme sound. query: a short description, e.g. "airhorn", "cat meow", "sad trombone".',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What sound, in a few words.' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    timeoutMs: 20_000,
    // The clip is the answer: no "one sec" before it, no words after it.
    endsTurn: true,
    run: async (a, signal) => {
      const q = String(a.query ?? '').trim().slice(0, 80);
      if (!q) throw new Error('no sound named');
      const t = await d.find(q, signal);
      if (!t) throw new Error(`no "${q}" sound found`);
      await d.play(t);
      return `Played the ${q} sound.`;
    },
  };
}
