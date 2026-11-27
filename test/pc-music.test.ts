import { describe, expect, it } from 'vitest';
import { classify, classifyMusic } from '../src/conversation/intents.js';
import { NAMES_MUSIC, pcMusicOrder, pcMusicReply } from '../src/satellite/pc-music.js';

describe('music words for the PC', () => {
  it.each([
    ['mute my music', 'mute'],
    ['Hey Adrian, mute my music.', 'mute'],
    ['mute the video', 'mute'],
    ['unmute my music', 'unmute'],
    ['pause my music', 'pause'],
    ['pause spotify', 'pause'],
    ['skip my song', 'skip'],
    ['shut off the music', 'stop'],
    ['turn my music off', 'stop'],
  ])('"%s" is a %s', (said, action) => {
    expect(classifyMusic(said)).toEqual({ kind: 'control', action });
  });

  it('"shut up the music" is a stop that names the music, either way it is caught', () => {
    const said = 'shut up the music';
    const asStop = classify(said)?.kind === 'stop';
    const asMusic = classifyMusic(said);
    expect(asStop || asMusic?.kind === 'control').toBe(true);
    expect(NAMES_MUSIC.test(said)).toBe(true);
    expect(NAMES_MUSIC.test('shut up')).toBe(false);
  });

  it('leaves alone what isn\'t about music', () => {
    for (const t of ['mute discord', 'mute me', 'mute him', 'unmute my mic']) expect([t, classifyMusic(t)]).toEqual([t, undefined]);
  });

  it('sends each order as the PC action that does it', () => {
    expect(pcMusicOrder({ kind: 'control', action: 'pause' })).toEqual({ name: 'pc_media', args: { action: 'pause' } });
    expect(pcMusicOrder({ kind: 'control', action: 'back' })).toEqual({ name: 'pc_media', args: { action: 'previous' } });
    expect(pcMusicOrder({ kind: 'control', action: 'volume', level: 30 })).toEqual({ name: 'pc_volume', args: { action: 'set', level: 30, playing: true } });
    expect(pcMusicOrder({ kind: 'control', action: 'who' })).toBeUndefined();
  });

  it('says nothing when it worked, what plays for a status, and the problem otherwise', () => {
    expect(pcMusicReply('pause', { ok: true, result: 'Spotify is paused on “Nights”.' })).toBeUndefined();
    expect(pcMusicReply('status', { ok: true, result: 'Spotify is playing “Nights” by Frank Ocean. Brave is paused.' })).toBe('Spotify is playing “Nights” by Frank Ocean.');
    expect(pcMusicReply('pause', { ok: false, result: 'Nothing on this PC is playing media I can control.' })).toBe("Nothing's playing on your PC.");
    expect(pcMusicReply('mute', { ok: false, result: 'The PC got stuck doing that and gave up.' })).toBe("Your PC didn't answer, so that didn't happen.");
    expect(pcMusicReply('skip', { ok: false, result: "That's turned off in this PC's settings." })).toBe("That's turned off in your PC app's settings.");
    expect(pcMusicReply('skip', { ok: false, result: 'Yusic didn\'t accept that.' })).toBe("Yusic didn't accept that.");
  });
});
