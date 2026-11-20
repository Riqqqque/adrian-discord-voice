// The follow-up judge's words: what the model is told about speech that came
// without her name, right after one of her answers, and about a loose wake
// (her name said, maybe about her rather than to her). Her microphone (or the
// call) also carries talk between people, so the model decides whether the
// words are for her and answers exactly SILENT when they aren't. Only the
// per-turn request changes: the cached prompt stays the same.
//
// The two kinds lean differently on purpose. A follow-up has no name in it, so
// when unsure it stays out. A loose wake has her name in it (the model gets the
// whole sentence, name and all), so it's usually for her and is answered unless
// it clearly isn't; what counts as "clearly isn't" is the same list as for a
// follow-up in that place.

/** Parakeet writes some orders in the past tense; the wake rules keep those loose. */
const PAST_TENSE = 'The words come from speech recognition, which sometimes writes an order to you in the past tense ("skipped this song" for "skip this song"): that is still an order for you.';

/** At their PC: one microphone hears everything near it, all as them. */
export function deskFollowUp(speaker: string): string {
  return [
    `${speaker} said this at their PC without using your name, soon after your last answer. The PC's microphone also hears everything else said near it, all as ${speaker}: talking with people in the room, on the phone or in a voice chat, a show or video playing, singing along. Decide whether these words are for you.`,
    `For you, so answer: a question or order for you, thanking you, or words that carry on your conversation with ${speaker}, like a follow-up question, a correction or a detail you need ("what about Saturday?", "no, the second one", "but I'm out of eggs").`,
    `Not for you, so reply with exactly SILENT and nothing else: words to someone else (a name or nickname that isn't yours, "honey", "man", or a question only a person there could answer, like "are you ready yet?" or "where did you put my keys?"), reactions and banter with others ("see, I was right"), passing on what you said to someone ("she said ..."), talk about you as "she" or "it", thinking out loud, lines from a show, video or game, lyrics.`,
    'If you are unsure, it is for you only if it asks you something or tells you to do something you can do. Staying out of it costs little (they can say your name); answering talk meant for someone else interrupts them.',
  ].join(' ');
}

/** In a voice call: several people, each heard as themselves. */
export function callFollowUp(speaker: string): string {
  return [
    `${speaker} just said this without using your name, a few seconds after your last answer. People in the call also talk to each other and about their games; the call list marks ${speaker} as talking to you only because they spoke to you last. Decide whether these words are for you.`,
    `Not for you, so reply with exactly SILENT and nothing else: talking to someone else, answering or reacting to what someone else just said (check the recent talk: if another person spoke after your answer, words that answer them are for them), callouts and instructions for the game ("grab the diamonds", "run", "watch out", "go left"), reactions ("lol", "nice one"), talk about you as "she" or "it", thinking out loud. Things you could not do anyway are usually meant for someone else.`,
    'If it carries on your conversation with them or asks you something, answer normally.',
  ].join(' ');
}

/** At their PC, a loose wake: the whole sentence, with her name in it. */
export function deskLooseWake(speaker: string): string {
  return [
    `${speaker} said this at their PC with your name in it, but maybe about you rather than to you. They're usually talking to you: answer it.`,
    PAST_TENSE,
    `The PC's microphone also hears everything else said near it, all as ${speaker}. Reply with exactly SILENT and nothing else only if it clearly isn't for you: talk about you rather than to you, passing on what you said to someone, words to someone else in the room, on the phone or in a voice chat, lines from a show, video or game playing on the PC, lyrics.`,
  ].join(' ');
}

/** In a voice call, a loose wake: the whole sentence, with her name in it. */
export function callLooseWake(speaker: string): string {
  return [
    `${speaker} just said this with your name in it, but maybe about you rather than to you.`,
    PAST_TENSE,
    'People in the call also talk to each other and about their games. If it is not meant for you, reply with exactly SILENT and nothing else. Not meant for you: talking about you rather than to you, talking to someone else, answering or reacting to what someone else just said, callouts and instructions for the game ("grab the diamonds", "run", "watch out", "go left"), reactions ("lol", "nice one"), thinking out loud. Things you could not do anyway are usually meant for someone else.',
    'If it carries on your conversation or asks you something, answer normally.',
  ].join(' ');
}
