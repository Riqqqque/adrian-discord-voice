// "Pause", "skip", "mute my music" said at a PC while her own music is off:
// what to send the PC, and what to say back. Handled without the model, which
// sometimes reached for her own (empty) player instead of the PC's.
import type { MusicIntent } from '../conversation/intents.js';

type Control = Extract<MusicIntent, { kind: 'control' }>;

/** How long a quick music order waits for the PC (the app gives up at 10 s). */
export const PC_MUSIC_MS = 12_000;

/** A stop phrase that names what's playing: "shut up the music", "stop the song". */
export const NAMES_MUSIC = /\b(music|song|songs|track|playlist|spotify|youtube|video|audio)\b/i;

/** The PC action for an order, or undefined for one the model should handle. */
export function pcMusicOrder(m: Control): { name: 'pc_media' | 'pc_volume'; args: Record<string, unknown> } | undefined {
  switch (m.action) {
    case 'pause':
    case 'stop': // pausing keeps their place; a browser's stop can lose the video
      return { name: 'pc_media', args: { action: 'pause' } };
    case 'resume':
      return { name: 'pc_media', args: { action: 'play' } };
    case 'skip':
      return { name: 'pc_media', args: { action: 'next' } };
    case 'back':
      return { name: 'pc_media', args: { action: 'previous' } };
    case 'status':
      return { name: 'pc_media', args: { action: 'status' } };
    case 'mute':
    case 'unmute':
      return { name: 'pc_volume', args: { action: m.action, playing: true } };
    case 'volume':
      return { name: 'pc_volume', args: { action: 'set', level: m.level, playing: true } };
    default:
      return undefined; // "who asked for this" is about her own music
  }
}

/** What she says after it: nothing when it worked (the music changing is the
 *  answer), what's playing for a status, else the problem in a few words. */
export function pcMusicReply(action: Control['action'], r: { ok: boolean; result: string }): string | undefined {
  const text = r.result.trim();
  if (r.ok) return action === 'status' ? firstSentence(text) : undefined;
  if (/^(Nothing is playing|No music or video is playing|Nothing's playing|Nothing on this PC is playing)/i.test(text)) return "Nothing's playing on your PC.";
  if (/didn't answer|got stuck|gave up/i.test(text)) return "Your PC didn't answer, so that didn't happen.";
  if (/turned off in this PC's settings/i.test(text)) return "That's turned off in your PC app's settings.";
  return firstSentence(text) || "That didn't work on your PC.";
}

function firstSentence(t: string): string {
  const m = /^.{1,160}?[.!?](\s|$)/.exec(t);
  return (m ? m[0] : t.slice(0, 160)).trim();
}
