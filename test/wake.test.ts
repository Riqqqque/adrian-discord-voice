import { describe, expect, it } from 'vitest';
import { TextWakeDetector } from '../src/wake/text-wake.js';

const d = new TextWakeDetector();

describe('text wake detector', () => {
  const wakes: [string, string][] = [
    ['Hey Adrian, what time is it?', 'what time is it?'],
    ['hey adrian what time is it', 'what time is it'],
    ['Hey, Adrian. Turn off the lights.', 'Turn off the lights.'],
    ['Hi Adrian, how are you?', 'how are you?'],
    ['Okay Adrian, set a timer for five minutes.', 'set a timer for five minutes.'],
    ['OK Adrien, what is the weather?', 'what is the weather?'],
    ['Hey Adrean. Who won the game?', 'Who won the game?'],
    ['Um, hey Adrian, are you there?', 'are you there?'],
    ['Hey a drian, tell me a joke.', 'tell me a joke.'],
    ['Hey Adrian.', ''],
    ['Hey Adrian', ''],
    ['Hey Adrian, is it going to rain tomorrow?', 'is it going to rain tomorrow?'],
    ['Hey Adrians.', ''],
    ['K. Adrian, who wrote Hamlet?', 'who wrote Hamlet?'],
  ];
  for (const [text, remainder] of wakes) {
    it(`wakes on "${text}"`, () => {
      expect(d.match(text)).toEqual({ woke: true, remainder });
    });
  }

  const notWakes = [
    'I saw Adrian yesterday.',
    "Hey, Adrian's coming over later.",
    'hey adrians coming',
    'Adrian, pass me the ball.',
    'Hey guys, Adrian said he would be late.',
    'Did you hear what Adrian said?',
    'hey what is adrian doing',
    'Hey Andrew, what time is it?',
    'Hadrian built a wall.',
    'they adrian', // not a greeting
    '',
    'hey',
    "Hey Adrian'll be here soon.",
  ];
  for (const text of notWakes) {
    it(`does not wake on "${text}"`, () => {
      expect(d.match(text).woke).toBe(false);
    });
  }

  it('keeps the ASR spellings when the name is given explicitly as adrian', () => {
    expect(new TextWakeDetector({ name: 'adrian' }).match('Hey Adrien, hi').woke).toBe(true);
  });

  it('can allow the bare name when configured', () => {
    const bare = new TextWakeDetector({ allowBareName: true });
    expect(bare.match('Adrian, what time is it?')).toEqual({ woke: true, remainder: 'what time is it?' });
  });

  it('supports a renamed bot without the Adrian variants', () => {
    const jarvis = new TextWakeDetector({ name: 'jarvis' });
    expect(jarvis.match('Hey Jarvis, lights on').woke).toBe(true);
    expect(jarvis.match('Hey Adrien, lights on').woke).toBe(false);
  });
});

describe('loose wake', () => {
  it('accepts the bare name first or the wake phrase mid-sentence; only talk about it is loose', async () => {
    const { TextWakeDetector } = await import('../src/wake/text-wake.js');
    const w = new TextWakeDetector();
    expect(w.matchLoose('Hey Adrian, what time is it?')).toEqual({ woke: true, remainder: 'what time is it?', loose: false });
    expect(w.matchLoose('Adrian, what time is it?')).toEqual({ woke: true, remainder: 'what time is it?', loose: false });
    expect(w.matchLoose('Adrian is so slow')).toEqual({ woke: true, remainder: 'is so slow', loose: true });
    expect(w.matchLoose('Adrian never listens to me').loose).toBe(true);
    expect(w.matchLoose('yo wait, hey Adrian, roll a d20')).toEqual({ woke: true, remainder: 'roll a d20', loose: false });
    expect(w.matchLoose("Adrian's so slow").woke).toBe(false);
    expect(w.matchLoose('I saw Adrian yesterday').woke).toBe(false);
    expect(w.matchLoose('Adrian?')).toEqual({ woke: true, remainder: '', loose: false }); // the name alone wakes it
  });
});

describe('wake in other languages', () => {
  it('accepts Spanish and Vietnamese greetings', async () => {
    const { TextWakeDetector } = await import('../src/wake/text-wake.js');
    const w = new TextWakeDetector();
    expect(w.match('Hola Adrián, ¿qué hora es?')).toEqual({ woke: true, remainder: '¿qué hora es?' });
    expect(w.match('Oye Adrian, pon un temporizador')).toEqual({ woke: true, remainder: 'pon un temporizador' });
    expect(w.match('Xin chào Adrian, mấy giờ rồi?')).toEqual({ woke: true, remainder: 'mấy giờ rồi?' });
  });
});
