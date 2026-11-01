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
    for (const t of ['what does shut up mean', 'how do you say shut up in Spanish?', 'why do people say stfu', 'can you explain enough is enough', 'what does it mean, shut up']) expect(classify(t), t).toBeUndefined();
  });
  it('a play or queue order is never a stop', () => {
    for (const t of [
      'Hey Adrian, play Shut Up and Dance', 'play Enough by Drake', 'put on Be Quiet and Drive', 'queue Stop Talking', 'play Stop It by Rihanna',
      'can you play Shut Up and Dance', 'Queue up Shut Up, Stop Talking', 'Play Shut Up, Be Quiet',
    ]) expect(classify(t), t).toBeUndefined();
  });
  it('ordinary sentences are not stop commands', () => {
    for (const t of [
      'not enough ammo', 'we have enough wood', 'we need to stop that guy', 'i told her to shut up', 'he wont stop talking', "he won't shut up",
      'tell Sam to shut up', 'stop that guy', "don't stop talking", 'they need to be quiet', 'so we need to stop it', 'can you stop that guy',
    ]) expect(classify(t), t).toBeUndefined();
  });
  it('"fair enough" is an acknowledgement', () => {
    for (const t of ['fair enough', 'Fair enough.', 'okay fair enough', 'Adrian, fair enough']) expect(kind(t), t).toBe('ack');
  });
  it('an order, or anything said to her, still stops', () => {
    for (const t of [
      'shut the fuck up', 'stfu', 'bro just stop talking', 'shut up already', 'stop talking to him', 'stop talking about it', 'stop it right now',
      'can you stop talking', 'could you please shut the hell up', 'would you just stop talking', 'you need to shut up', 'you should stop talking',
      'i said shut up', 'i told you to stop talking', 'no you shut up', 'please be quiet', 'quiet down', 'shhh', 'enough of that', "that's enough talking",
      'Oh my God, shut up.', 'Seriously, stop it.', "We've got plenty, stop talking.", 'ya cállate', 'cállate por favor', 'basta de hablar',
    ]) expect(kind(t), t).toBe('stop');
  });
  it('an interjection in front does not hide the order, with or without a comma', () => {
    for (const t of [
      'oh my god shut up', 'oh my god just shut up', 'seriously stop talking', 'yeah shut up', 'jesus shut up', 'for real shut up',
      'please for the love of god shut up', 'come on stop it', 'bruh stop talking', 'everyone be quiet',
    ]) expect(kind(t), t).toBe('stop');
    for (const t of ['oh my god he wont shut up', 'seriously stop that guy', 'yeah we need to stop that guy', 'for real i told her to shut up'])
      expect(classify(t), t).toBeUndefined();
  });
  it('"enough" alone is an everyday word, like "done"', () => {
    for (const t of ['enough', 'Enough!', 'yo enough bro']) expect(classify(t), t).toEqual({ kind: 'stop', weak: true });
    expect(classify("that's enough")).toEqual({ kind: 'stop' });
  });
  it('"enough" after an interjection, or told to her, is still that everyday word', () => {
    for (const t of [
      'Yeah, enough.', 'yeah enough', 'Seriously, enough.', 'seriously enough', 'Come on, enough.', 'come on enough', 'Oh my god, enough.', 'oh my god enough',
      'Enough, enough.', 'enough enough', 'Enough for now.', 'I said enough.',
    ]) expect(classify(t), t).toEqual({ kind: 'stop', weak: true });
  });
  it('"that\'s enough" stays a clear stop however it is said', () => {
    for (const t of ["Yeah, that's enough.", "yeah that's enough", "That's enough for now.", "that's enough for today", 'that is enough for now', "I said that's enough.", "come on that's enough"])
      expect(classify(t), t).toEqual({ kind: 'stop' });
  });
  it('"enough" inside something else is not a stop', () => {
    for (const t of ["that's enough ammo", 'enough is enough', 'sure enough', 'good enough', 'close enough', 'is that enough', 'we have enough for now', 'not enough for now'])
      expect(classify(t)?.kind, t).not.toBe('stop');
  });
  it('more ways of telling her', () => {
    for (const t of [
      'I asked you to stop talking.', 'i said to stop talking', "I'm telling you to shut up.", 'You really need to shut up.', 'i told you shut up',
      'Adrienne shut up.', 'Adriana stop talking.', 'wow shut up', 'dang shut up', 'holy shit shut up', 'fuck shut up', 'fucking shut up', 'just fucking shut up',
      "For fuck's sake shut up.", "For god's sake stop talking.", 'sorry shut up', 'listen shut up', 'oye cállate', 'por favor cállate', 'ay basta', 'bueno basta',
      'I said stop.', 'Stop, stop, stop.', 'Stop that right now please.',
    ]) expect(kind(t), t).toBe('stop');
    expect(classify('Stop it for a second.')).toEqual({ kind: 'stop', hold: true });
  });
  it('but not when it is about someone else', () => {
    for (const t of ['i asked her to shut up', 'i said he should shut up', 'im telling him to shut up', 'he really needs to shut up', 'i told sam to stop talking'])
      expect(classify(t), t).toBeUndefined();
  });
  it('"stop listening" keeps its meaning however it is said, so the music stays on', () => {
    for (const t of ['stop listening', 'Stop listening.', 'Hey Adrian, stop listening.', 'Stop listening please.', 'Stop listening to me.', 'quit listening', 'Can you stop listening.', 'You can stop listening.', 'yeah stop listening', 'I said stop listening.'])
      expect(classify(t), t).toEqual({ kind: 'stop', listen: true });
    for (const t of ['stop listening to that song', 'he should stop listening', 'what does stop listening mean']) expect(classify(t), t).toBeUndefined();
  });
  it('every everyday "wait" is weak; "wait stop" is a real stop', () => {
    for (const t of ['wait', 'wait wait', 'hold on', 'hold up', 'hold on a sec', 'hold on a second', 'wait a sec', 'wait a second', 'one sec', 'one second', 'hang on', 'hang on a sec'])
      expect(classify(t), t).toEqual({ kind: 'stop', hold: true, weak: true });
    for (const t of ['wait stop', 'stop for a sec', 'stop for a second']) expect(classify(t), t).toEqual({ kind: 'stop', hold: true });
  });
});
