import { describe, expect, it } from 'vitest';
import { classify } from '../src/conversation/intents.js';

const kind = (t: string) => classify(t)?.kind;

describe('everyday phrases', () => {
  it('recognizes the ways people tell it to stop', () => {
    for (const t of [
      'Stop.', 'stop it', 'Shut up!', 'shut up Adrian', 'Adrian, shut up.', 'okay stop', 'please stop', 'Stop talking.',
      'Stop listening to me.', 'be quiet', 'Quiet!', 'shh', 'Never mind.', 'nevermind', 'forget it', 'cancel that',
      "That's enough.", 'enough', 'no stop', 'just stop', "I wasn't talking to you.", 'not you', 'go to sleep',
      "That's all, thanks.", 'no thanks', 'can you shut up', 'Stop, stop.', 'Hey Adrian, stop.', 'zip it', 'pipe down',
    ]) {
      expect(kind(t), t).toBe('stop');
    }
  });

  it('leaves real questions for the model', () => {
    for (const t of [
      'How do I stop a nosebleed?', 'What does shut up mean in French?', 'Stop the music and tell me a joke',
      'Is it quiet in space?', 'Why do people say never mind?', 'What time is it?', 'Tell me about the Thank You song',
      'Who made you?', 'Can you speak up about climate change?',
    ]) {
      expect(classify(t), t).toBeUndefined();
    }
  });

  it('knows the bare name, thanks, goodbye and acknowledgements', () => {
    expect(kind('Adrian?')).toBe('name');
    expect(kind('Hey Adrian.')).toBe('name');
    expect(kind('Thanks Adrian!')).toBe('thanks');
    expect(kind('thank you so much')).toBe('thanks');
    expect(kind('Thank you.')).toBe('thanks');
    expect(kind('good night')).toBe('bye');
    expect(kind('Bye Adrian')).toBe('bye');
    expect(kind('Okay.')).toBe('ack');
    expect(kind('got it')).toBe('ack');
    expect(kind('all right')).toBe('ack');
  });

  it('handles repeat, volume and speed', () => {
    expect(kind('Say that again?')).toBe('repeat');
    expect(kind('What did you say?')).toBe('repeat');
    expect(classify('louder please')).toEqual({ kind: 'volume', dir: 1 });
    expect(classify("I can't hear you")).toEqual({ kind: 'volume', dir: 1 });
    expect(classify("You're too loud.")).toEqual({ kind: 'volume', dir: -1 });
    expect(classify('slow down')).toEqual({ kind: 'speed', dir: -1 });
    expect(classify('talk faster')).toEqual({ kind: 'speed', dir: 1 });
  });
});

describe('other languages', () => {
  it('knows stop, thanks and bye in Spanish, Vietnamese, Chinese and Japanese', () => {
    for (const t of ['¡Cállate!', 'para', 'ya basta', 'Dừng lại', 'im đi', '停', '别说了。', '闭嘴', 'やめて', 'しずかに', 'うるさい']) expect(kind(t), t).toBe('stop');
    for (const t of ['Gracias', 'cảm ơn', '谢谢', 'ありがとう']) expect(kind(t), t).toBe('thanks');
    for (const t of ['adiós', '再见', 'またね']) expect(kind(t), t).toBe('bye');
    expect(classify('¿qué hora es?')).toBeUndefined();
    expect(classify('今天天气怎么样')).toBeUndefined();
  });
});

describe('stop phrases inside short utterances', () => {
  it('stops on swearing and filler around shut up', () => {
    for (const t of ['shut the fuck up', 'bro just shut up already', 'STFU', 'Adrian shut the hell up', 'ok stop talking now', 'yo enough bro', 'dude be quiet']) expect(kind(t), t).toBe('stop');
  });
  it('still answers questions about those words', () => {
    for (const t of ['what does shut up mean', 'how do you say shut up in Spanish?', 'why do people say stfu', 'can you explain enough is enough']) expect(classify(t), t).toBeUndefined();
  });
});
