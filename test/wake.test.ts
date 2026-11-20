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

describe('talk about her vs to her', () => {
  const w = new TextWakeDetector();
  it('judges "hey Adrian" + a statement about her loosely, never drops it', () => {
    expect(w.matchLoose('Hey, Adrian is in the other room.')).toEqual({ woke: true, remainder: 'is in the other room.', loose: true });
    expect(w.matchLoose('Okay, Adrian will sort it out.').loose).toBe(true);
    expect(w.matchLoose('Hey, Adrian just left the game.').loose).toBe(true);
    expect(w.matchLoose('Yo Adrian keeps freezing').loose).toBe(true);
    expect(w.matchLoose('Hi, Adrian has it under control.').loose).toBe(true);
    expect(w.matchLoose('Hey Adrian and Sam are late').loose).toBe(true);
  });
  it('keeps questions that start with a helper verb strict', () => {
    for (const t of [
      'Hey Adrian is it cold outside?', 'Hey Adrian, is it cold outside?', 'Hey Adrian can you hear me', 'Hey Adrian will it snow',
      'Hey Adrian did the game start', 'Hey Adrian are you awake', 'Hey Adrian is Steam down', 'Hey Adrian has anyone texted me',
      'Hey Adrian never mind', 'Hey Adrian just play something', 'Hey Adrian still there?', 'Hey Adrian, was wondering about dinner',
    ]) expect(w.matchLoose(t), t).toMatchObject({ woke: true, loose: false });
  });
  it('treats the bare name + what Adrian did as talk about her', () => {
    expect(w.matchLoose('Adrian went to bed').loose).toBe(true);
    expect(w.matchLoose('Adrian already answered').loose).toBe(true);
    expect(w.matchLoose('Adrian skipped this song').loose).toBe(false); // ASR's past tense for "skip this song"
    expect(w.matchLoose('Adrian, what time is it?').loose).toBe(false);
  });
});

describe('the name later in the sentence', () => {
  const w = new TextWakeDetector();
  it('wakes loosely on a question with the name at the end, with what came before as the request', () => {
    expect(w.matchLoose('Yo, what is good, Adrian?')).toEqual({ woke: true, remainder: 'Yo, what is good', loose: true });
    expect(w.matchLoose('can you turn it up a bit Adrian')).toEqual({ woke: true, remainder: 'can you turn it up a bit', loose: true });
    expect(w.matchLoose('Are you there, Adrians?').woke).toBe(true);
  });
  it('not on things said to a person called Adrian', () => {
    for (const t of ['Nice shot, Adrian.', 'Stop it, Adrian.', 'Wait, Adrian, come here.', 'Cheers Adrian.', 'Shut up, Adrian.', 'Alright Adrian, you lead.'])
      expect(w.matchLoose(t).woke, t).toBe(false);
  });
  it('not when the name at the end is the object', () => {
    for (const t of ['Have you met Adrian?', "Where's Adrian?", 'I was playing with Adrian', 'Go and ask Adrian', 'It was Adrian', 'Yeah Adrian', 'Me and Adrian'])
      expect(w.matchLoose(t).woke, t).toBe(false);
  });
  it('wakes loosely on the bare name + a question after a lead-in or a pause', () => {
    expect(w.matchLoose("Wait, Adrian, what's the score?")).toEqual({ woke: true, remainder: "what's the score?", loose: true });
    expect(w.matchLoose('alright Adrian how long is left')).toEqual({ woke: true, remainder: 'how long is left', loose: true });
    expect(w.matchLoose('That was close. Adrian, how much time is left?')).toEqual({ woke: true, remainder: 'how much time is left?', loose: true });
  });
  it('not on talk about her after a lead-in, a list of names, or the name alone', () => {
    for (const t of ['Wait, Adrian left?', 'So yeah Adrian is not here', 'Marco, Adrian, and Sam are on', 'Yeah Adrian did that', 'Well Adrian does that all the time', 'Okay so Adrian works there', 'Okay so Adrian said no', 'Yeah, Adrian.', 'This morning Adrian went out'])
      expect(w.matchLoose(t).woke, t).toBe(false);
  });
  it('accepts more greetings', () => {
    expect(w.match('Hey there Adrian, what time is it?')).toEqual({ woke: true, remainder: 'what time is it?' });
    expect(w.match('Hey hey Adrian, louder')).toEqual({ woke: true, remainder: 'louder' });
    expect(w.match('Good morning Adrian, any news?')).toEqual({ woke: true, remainder: 'any news?' });
    expect(w.match('Morning Adrian')).toEqual({ woke: true, remainder: '' });
    expect(w.match('Excuse me Adrian, how far is the moon?').woke).toBe(true);
  });
});
