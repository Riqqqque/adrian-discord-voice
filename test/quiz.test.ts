import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { PlaybackHandle } from '../src/core/interfaces.js';
import { type Clip, MusicPlayer, type MusicOutput, type Track } from '../src/features/music.js';
import {
  answerScore,
  answerTitle,
  clipRange,
  judgeGuess,
  MusicQuiz,
  parseQuizCommand,
  QUIZ_BUSY,
  type QuizDeps,
  quizSongs,
  type QuizSong,
  Quizzes,
} from '../src/features/quiz.js';

const quiet = { info() {}, warn() {} };
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const SONGS: QuizSong[] = [
  { title: 'Blinding Lights', artist: 'The Weeknd' },
  { title: 'Seven Nation Army', artist: 'The White Stripes' },
  { title: 'Dracula (with JENNIE)', artist: 'Tame Impala' },
  { title: 'Bohemian Rhapsody', artist: 'Queen' },
  { title: 'Hello', artist: 'Adele' },
  { title: 'Take on Me', artist: 'a-ha' },
];

/** A quiz with a fake clock, fake clips and everything she says written down. */
function rig(o: { songs?: QuizSong[]; rounds?: number; artist?: string; people?: number; failReady?: Set<string>; judge?: QuizDeps['judge']; names?: Record<string, string> } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const said: string[] = [];
  const clips: (Clip & { stopped: boolean; end(): void })[] = [];
  const state = { people: o.people ?? 3, ended: 0 };
  const names = o.names ?? { u1: 'Alex', u2: 'Sam', u3: 'Kim' };
  const deps: QuizDeps = {
    now: () => now,
    after: (ms, fn) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    songs: async () => o.songs ?? SONGS,
    ready: async (s) => {
      if (o.failReady?.has(s.title)) throw new Error('that one is unavailable');
      return { title: s.title.replace(/\s*\(.*\)/, ''), ...(s.artist ? { artist: s.artist } : {}), source: 'youtube', ref: 'https://stream/x', durationS: 200, year: 2019 } as Track;
    },
    play: async (t) => {
      let end!: (o: 'finished' | 'stopped') => void;
      const done = new Promise<'finished' | 'stopped' | 'error'>((r) => (end = r));
      const c = {
        track: t,
        startS: 60,
        seconds: 20,
        done,
        stopped: false,
        stop: () => {
          c.stopped = true;
          end('stopped');
        },
        end: () => end('finished'),
      };
      clips.push(c);
      return c;
    },
    say: async (text) => {
      said.push(text);
    },
    nameOf: (id) => names[id],
    people: () => state.people,
    ...(o.judge ? { judge: o.judge } : {}),
    ended: () => state.ended++,
    log: quiet,
  };
  const quiz = new MusicQuiz(deps, { rounds: o.rounds ?? 3, ...(o.artist ? { artist: o.artist } : {}) }, { clipSeconds: 20, hintSeconds: 12, gapMs: 1000 }, 'u1');
  /** Move the clock on, running what comes due. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { quiz, said, clips, state, advance, answer: () => (quiz as unknown as { answer?: { title: string; artist?: string } }).answer };
}

describe('matching a guess', () => {
  it('takes the title, part of it, or the artist, as speech recognition spells them', () => {
    const lights = { title: 'Blinding Lights', artist: 'The Weeknd' };
    expect(judgeGuess('is it blinding light', lights)).toEqual({ right: true, got: 'title' });
    expect(judgeGuess("that's the weekend", lights)).toEqual({ right: true, got: 'artist' });
    expect(judgeGuess('7 nation army', { title: 'Seven Nation Army' })).toMatchObject({ right: true });
    expect(judgeGuess('seven nation army', { title: '7 Nation Army' })).toMatchObject({ right: true });
    expect(judgeGuess('dracula', { title: 'Dracula (with JENNIE)', artist: 'Tame Impala' })).toMatchObject({ right: true, got: 'title' });
    expect(judgeGuess('never gonna give', { title: 'Never Gonna Give You Up' })).toMatchObject({ right: true });
    expect(judgeGuess('bruno mars', { title: 'Die With A Smile', artist: 'Lady Gaga & Bruno Mars' })).toMatchObject({ right: true, got: 'artist' });
    expect(judgeGuess('here comes the sun', { title: 'Here Comes The Sun - Remastered 2009', artist: 'The Beatles' })).toMatchObject({ right: true, got: 'title' });
  });

  it('leaves side talk and filler alone', () => {
    const lights = { title: 'Blinding Lights', artist: 'The Weeknd' };
    expect(judgeGuess('yeah lol', lights).right).toBe(false);
    expect(judgeGuess('the', lights).right).toBe(false);
    expect(judgeGuess('turn the lights off in the kitchen', lights)).toEqual({ right: false, close: false });
    expect(judgeGuess('hello everyone how are you doing', { title: 'Hello', artist: 'Adele' }).right).toBe(false);
    expect(judgeGuess('is it hello', { title: 'Hello', artist: 'Adele' }).right).toBe(true);
    expect(judgeGuess('in the future we should go there', { title: 'Mask Off', artist: 'Future' }).right).toBe(false);
  });

  it('wants more than an everyday word: half a band name, a small word, or a word sung twice is no answer', () => {
    const ewf = { title: 'September', artist: 'Earth, Wind & Fire' };
    expect(judgeGuess("that's fire", ewf).right).toBe(false);
    expect(judgeGuess('earth', ewf).right).toBe(false);
    expect(judgeGuess('earth wind and fire', ewf)).toEqual({ right: true, got: 'artist' });
    expect(judgeGuess('men', { title: 'Little Talks', artist: 'Of Monsters and Men' }).right).toBe(false);
    expect(judgeGuess('monsters', { title: 'Little Talks', artist: 'Of Monsters and Men' }).right).toBe(false);
    expect(judgeGuess('of monsters and men', { title: 'Little Talks', artist: 'Of Monsters and Men' }).right).toBe(true);
    expect(judgeGuess('sons', { title: 'The Cave', artist: 'Mumford & Sons' }).right).toBe(false);
    expect(judgeGuess('mumford', { title: 'The Cave', artist: 'Mumford & Sons' })).toEqual({ right: true, got: 'artist' });
    expect(judgeGuess('wine', { title: 'Naked as We Came', artist: 'Iron & Wine' }).right).toBe(false);
    expect(judgeGuess('the machine', { title: 'Dog Days Are Over', artist: 'Florence + the Machine' }).right).toBe(false);
    expect(judgeGuess('florence', { title: 'Dog Days Are Over', artist: 'Florence + the Machine' }).right).toBe(true);
    expect(judgeGuess('garfunkel', { title: 'The Boxer', artist: 'Simon & Garfunkel' }).right).toBe(true);
    // Nothing but small words: only those, alone.
    const yeah = { title: 'Yeah!', artist: 'Usher' };
    expect(judgeGuess('yeah', yeah).right).toBe(true);
    expect(judgeGuess('yeah yeah', yeah).right).toBe(false);
    expect(judgeGuess('oh yeah', yeah).right).toBe(false);
    // One word among small ones is half the title, for the model to decide.
    expect(judgeGuess('take', { title: 'Take on Me', artist: 'a-ha' })).toEqual({ right: false, close: true });
    expect(judgeGuess('is it take on me', { title: 'Take on Me', artist: 'a-ha' }).right).toBe(true);
    expect(judgeGuess('hello hello', { title: 'Hello', artist: 'Adele' }).right).toBe(false);
    expect(judgeGuess('creep by radiohead', { title: 'Creep', artist: 'Radiohead' }).right).toBe(true);
    expect(judgeGuess('maybe', { title: 'Maybe', artist: 'Someone' }).right).toBe(true);
  });

  it('counts only the title in an artist quiz', () => {
    expect(judgeGuess('the weeknd', { title: 'Blinding Lights', artist: 'The Weeknd' }, true).right).toBe(false);
  });

  it('calls half a title close, for the model to decide', () => {
    expect(answerScore('bohemian', 'bohemian rhapsody')).toBe(0.5);
    expect(judgeGuess('bohemian', { title: 'Bohemian Rhapsody', artist: 'Queen' })).toEqual({ right: false, close: true });
  });

  it('cleans the answer', () => {
    expect(answerTitle('Gangsta\'s Paradise (feat. L.V.) [Official Video]')).toBe('gangsta s paradise');
    expect(answerTitle('Hell At Night (feat. Ella Langley)')).toBe('hell at night');
  });
});

describe('quiz words', () => {
  it('starts with what it understands, and leaves names to the model', () => {
    expect(parseQuizCommand("Hey Adrian, let's do a music quiz", false)).toEqual({ kind: 'start', options: {} });
    expect(parseQuizCommand('start a music quiz with 5 rounds of 90s hip hop', false)).toEqual({ kind: 'start', options: { rounds: 5, decade: '90s', genre: 'hip hop' } });
    expect(parseQuizCommand('guess the song, eighties rock', false)).toEqual({ kind: 'start', options: { decade: '80s', genre: 'rock' } });
    expect(parseQuizCommand("can we play guess the song with songs we've played", false)).toEqual({ kind: 'start', options: { played: true } });
    expect(parseQuizCommand('music quiz with Drake songs', false)).toBe('model');
    expect(parseQuizCommand('how does the music quiz work', false)).toBeUndefined();
    expect(parseQuizCommand('play some music', false)).toBeUndefined();
  });

  it('knows its orders while one runs', () => {
    expect(parseQuizCommand('stop the quiz', true)).toEqual({ kind: 'stop' });
    expect(parseQuizCommand("what's the score?", true)).toEqual({ kind: 'score' });
    expect(parseQuizCommand('skip this one', true)).toEqual({ kind: 'skip' });
    expect(parseQuizCommand('give us a hint', true)).toEqual({ kind: 'hint' });
    expect(parseQuizCommand('stop the quiz', false)).toBeUndefined();
  });

  it('without her name, takes only the clear quiz orders, said on their own', () => {
    const unnamed = (t: string) => parseQuizCommand(t, true, false);
    expect(unnamed('skip')).toEqual({ kind: 'skip' });
    expect(unnamed('Next.')).toEqual({ kind: 'skip' });
    expect(unnamed('stop the quiz')).toEqual({ kind: 'stop' });
    expect(unnamed("What's the score?")).toEqual({ kind: 'score' });
    expect(unnamed('hint')).toEqual({ kind: 'hint' });
    expect(unnamed('give us a hint')).toEqual({ kind: 'hint' });
    for (const t of ["I'm done.", "we're done", 'pass', 'give up', 'scores', "who's this?", 'what is playing', 'stop the game', 'skip this one and grab the loot', 'next time bring snacks']) expect(unnamed(t)).toBeUndefined();
    // With her name they all work.
    expect(parseQuizCommand("I'm done", true, true)).toEqual({ kind: 'stop' });
    expect(parseQuizCommand('pass', true, true)).toEqual({ kind: 'skip' });
    expect(parseQuizCommand("who's this", true, true)).toEqual({ kind: 'status' });
  });
});

describe('clip placement', () => {
  it('starts just before the most replayed part, or a third in, never too near the end', () => {
    expect(clipRange({ durationS: 200, peakS: 61 }, 20)).toEqual({ startS: 58, seconds: 20 });
    expect(clipRange({ durationS: 200 }, 20)).toEqual({ startS: 70, seconds: 20 });
    expect(clipRange({ durationS: 200, peakS: 190 }, 20)).toEqual({ startS: 175, seconds: 20 });
    expect(clipRange({ durationS: 200, peakS: 5 }, 20)).toEqual({ startS: 24, seconds: 20 });
    expect(clipRange({ durationS: 30 }, 20)).toEqual({ startS: 8, seconds: 20 });
    expect(clipRange({ durationS: 16 }, 20)).toEqual({ startS: 4, seconds: 11 });
  });
});

describe('a quiz round by round', () => {
  it('plays, takes the first right answer without her name, and reveals only then', async () => {
    const r = rig({ songs: SONGS.slice(0, 3), rounds: 2 });
    await r.quiz.start();
    expect(r.said[0]).toMatch(/^Music quiz! 2 rounds/);
    expect(r.said.at(-1)).toBe('Round 1.');
    expect(r.quiz.open).toBe(true);
    const title = r.answer()!.title;
    // No spoilers before the reveal: not in her lines, the hint or her prompt.
    await r.advance(12_000);
    expect(r.said.at(-1)).toMatch(/^Hint: /);
    expect([...r.said, ...r.quiz.context()].join(' ')).not.toContain(title);
    expect(r.quiz.heard('u2', 'dude did you see the game last night', false)).toBe(false);
    expect(r.quiz.heard('u2', judgeable(title), false)).toBe(true);
    // Someone else a moment later: the round is already won.
    expect(r.quiz.heard('u3', judgeable(title), false)).toBe(false);
    await flush();
    expect(r.said.at(-1)).toBe(`Sam got it! That's ${title} by ${r.answer()!.artist}.`);
    expect(r.clips[0]!.stopped).toBe(true);
    await r.advance(1_000);
    expect(r.said.at(-1)).toBe('Last round.');
    await r.advance(21_500);
    expect(r.said.at(-2)).toMatch(/^Time's up\. That was /);
    expect(r.said.at(-1)).toBe("That's the quiz! Final score: Sam 1. Sam wins!");
    expect(r.state.ended).toBe(1);
    expect(r.quiz.on).toBe(false);
  });

  it("gives an unknown speaker the round but no points", async () => {
    const r = rig({ rounds: 1, names: {} });
    await r.quiz.start();
    r.quiz.heard('stranger', judgeable(r.answer()!.title), false);
    await flush();
    expect(r.said.at(-1)).toMatch(/^Got it! That's /);
    expect(r.quiz.scoreLine(true)).toBe('Nobody scored.');
  });

  it('wants the title in an artist quiz', async () => {
    const r = rig({ rounds: 1, artist: 'The Weeknd', songs: [{ title: 'Blinding Lights', artist: 'The Weeknd' }, { title: 'Starboy', artist: 'The Weeknd' }, { title: 'Save Your Tears', artist: 'The Weeknd' }] });
    await r.quiz.start();
    expect(r.quiz.heard('u2', 'the weeknd', false)).toBe(false);
    expect(r.quiz.open).toBe(true);
  });

  it('says "not quite" only to a wrong answer said to her, and leaves her other orders alone', async () => {
    const r = rig({ rounds: 2 });
    await r.quiz.start();
    expect(r.answer()!.title).toBe('Blinding Lights');
    expect(r.quiz.heard('u2', 'what time is it', true)).toBe(false);
    expect(r.quiz.heard('u2', "it's lights", true)).toBe(true);
    await flush();
    expect(r.said.at(-1)).toBe('Not quite.');
    expect(r.quiz.open).toBe(true);
  });

  it('leaves orders and questions that start like an answer to her usual handling', async () => {
    const r = rig({ rounds: 2 });
    await r.quiz.start();
    const before = r.said.length;
    for (const t of ['is it raining outside?', "it's too loud", "that's enough music for today", "it's some song by nobody"]) expect(r.quiz.heard('u2', t, true)).toBe(false);
    await flush();
    expect(r.said).toHaveLength(before);
    expect(r.quiz.open).toBe(true);
    // Her prompt says what a wrong guess that reaches her gets.
    expect(r.quiz.context().join(' ')).toContain('Not quite.');
  });

  it('side talk without her name never ends, skips or answers the quiz', async () => {
    const r = rig({ rounds: 3 });
    await r.quiz.start();
    const before = r.said.length;
    for (const t of ["I'm done.", "We're done", 'pass', "who's this?", 'scores', 'stop the game']) expect(r.quiz.heard('u2', t, false)).toBe(false);
    await flush();
    expect(r.said).toHaveLength(before);
    expect(r.quiz.on).toBe(true);
    expect(r.quiz.open).toBe(true);
    // "Next" on its own is the quiz's.
    const first = r.answer()!;
    expect(r.quiz.heard('u2', 'next', false)).toBe(true);
    await flush();
    expect(r.said.at(-1)).toBe(`Skipping. That was ${first.title} by ${first.artist}.`);
    // Between rounds a bare "skip" or "hint" isn't the quiz's; with her name an "I'm done" ends it.
    expect(r.quiz.heard('u2', 'skip', false)).toBe(false);
    expect(r.quiz.heard('u2', "I'm done", true)).toBe(true);
    await flush();
    expect(r.quiz.on).toBe(false);
  });

  it('a call talking about other things is nobody guessing', async () => {
    const r = rig({ rounds: 6 });
    await r.quiz.start();
    r.quiz.heard('u2', 'dude did you see the game last night', false);
    r.quiz.heard('u3', 'no way', false);
    await r.advance(21_000 + 1_000);
    r.quiz.heard('u2', 'grab the loot on the left', false);
    await r.advance(21_000);
    expect(r.said).toContain("Nobody's guessing, so I'll stop the quiz here.");
    expect(r.quiz.on).toBe(false);
  });

  it('a wrong guess still counts as playing along', async () => {
    const r = rig({ rounds: 6 });
    await r.quiz.start();
    await r.advance(21_000 + 1_000);
    r.quiz.heard('u2', 'is it purple rain', false);
    await r.advance(21_000 + 1_000);
    expect(r.said).not.toContain("Nobody's guessing, so I'll stop the quiz here.");
    expect(r.quiz.on).toBe(true);
  });

  it('asks the model about a near miss, once per guess and twice per round at most', async () => {
    let calls = 0;
    const r = rig({
      rounds: 1,
      songs: [{ title: 'Bohemian Rhapsody', artist: 'Queen' }, ...SONGS.slice(1, 3)],
      judge: async () => (++calls, calls === 2),
    });
    await r.quiz.start();
    expect(r.quiz.heard('u2', 'bohemian', false)).toBe(true);
    await flush();
    expect(r.quiz.open).toBe(true);
    expect(r.quiz.heard('u3', 'bohemian rhaps', false)).toBe(true);
    await flush();
    expect(calls).toBe(2);
    expect(r.said.at(-1)).toMatch(/^Kim got it!/);
  });

  it('never calls the model for side talk', async () => {
    let calls = 0;
    const r = rig({ rounds: 1, judge: async () => (++calls, false) });
    await r.quiz.start();
    for (const t of ['lol', 'no way', 'I have no idea honestly, this one is hard and I never listen to this kind of thing']) r.quiz.heard('u2', t, false);
    await flush();
    expect(calls).toBe(0);
  });

  it('skips a round, keeps score, and stops on request with the scores', async () => {
    const r = rig({ rounds: 5 });
    await r.quiz.start();
    r.quiz.heard('u1', judgeable(r.answer()!.title), false);
    await flush();
    await r.advance(1_000);
    const second = r.answer()!;
    expect(r.quiz.heard('u2', 'skip', false)).toBe(true);
    await flush();
    expect(r.said.at(-1)).toBe(`Skipping. That was ${second.title} by ${second.artist}.`);
    await r.advance(1_000);
    expect(r.quiz.heard('u3', "what's the score", false)).toBe(true);
    await flush();
    expect(r.said.at(-1)).toBe('Round 3 of 5. Alex 1.');
    const third = r.answer()!;
    expect(r.quiz.heard('u3', 'stop the quiz', true)).toBe(true);
    await flush();
    expect(r.said.at(-1)).toBe(`Quiz over. That one was ${third.title} by ${third.artist}. Final score: Alex 1. Alex wins!`);
    expect(r.state.ended).toBe(1);
    expect(r.clips.every((c) => c.stopped)).toBe(true);
  });

  it('stops by itself when nobody guesses for two rounds', async () => {
    const r = rig({ rounds: 6 });
    await r.quiz.start();
    await r.advance(21_000 + 1_000 + 21_000);
    expect(r.said).toContain("Nobody's guessing, so I'll stop the quiz here.");
    expect(r.quiz.on).toBe(false);
  });

  it('ends quietly when everyone has left', async () => {
    const r = rig({ rounds: 3 });
    await r.quiz.start();
    r.state.people = 0;
    await r.advance(21_000 + 1_000);
    expect(r.quiz.on).toBe(false);
    expect(r.said.at(-1)).toMatch(/^Time's up/);
  });

  it('moves on to another song when one is unavailable', async () => {
    const r = rig({ rounds: 1, failReady: new Set([SONGS[0]!.title]) });
    await r.quiz.start();
    expect(r.quiz.open).toBe(true);
    expect(r.answer()!.title).toBe(SONGS[1]!.title);
  });

  it("says so when there aren't enough songs", async () => {
    const r = rig({ songs: SONGS.slice(0, 2), rounds: 8 });
    await r.quiz.start();
    expect(r.said.at(-1)).toMatch(/^I couldn't find enough/);
    expect(r.state.ended).toBe(1);
  });

  it('ends a round with a short song', async () => {
    const r = rig({ rounds: 2 });
    await r.quiz.start();
    await r.advance(5_000);
    r.clips[0]!.end();
    await flush();
    expect(r.said.at(-1)).toMatch(/^Time's up/);
  });

  it('a clip that ends at once was never heard: another song takes the round, unrevealed', async () => {
    const r = rig({ rounds: 2 });
    await r.quiz.start();
    const dead = r.answer()!.title;
    r.clips[0]!.end();
    await flush();
    expect(r.said.join(' ')).not.toContain(dead);
    expect(r.said.filter((s) => s === 'Round 1.')).toHaveLength(1);
    expect(r.clips).toHaveLength(2);
    expect(r.quiz.open).toBe(true);
    expect(r.quiz.roundNumber).toBe(1);
    expect(r.answer()!.title).not.toBe(dead);
  });

  it('gives up after three clips in a row that end at once', async () => {
    const r = rig({ rounds: 2 });
    await r.quiz.start();
    for (let i = 0; i < 3; i++) {
      r.clips.at(-1)!.end();
      await flush();
    }
    expect(r.said.at(-2)).toBe("I ran out of songs that play, so that's the quiz.");
    expect(r.said.join(' ')).not.toMatch(/Time's up|Nobody's guessing/);
    expect(r.quiz.on).toBe(false);
  });

  it('plays each song once, whatever version', async () => {
    const r = rig({ rounds: 3, songs: [SONGS[0]!, { title: 'Blinding Lights (Remastered)', artist: 'The Weeknd' }, SONGS[1]!, SONGS[2]!] });
    await r.quiz.start();
    const titles = [r.answer()!.title];
    for (let i = 0; i < 2; i++) {
      await r.advance(21_000 + 1_000);
      titles.push(r.answer()!.title);
      r.quiz.heard('u1', judgeable(r.answer()!.title), false);
      await flush();
    }
    expect(new Set(titles.map((t) => t.toLowerCase().slice(0, 8))).size).toBe(3);
  });
});

/** A right answer for a title: its main words. */
function judgeable(title: string): string {
  return `is it ${title.replace(/\s*\(.*\)/, '')}`;
}

describe('picking songs', () => {
  const fakeFetch = (rows: unknown[]) => (async () => new Response(JSON.stringify({ data: rows }))) as unknown as typeof fetch;

  it("uses Deezer's chart, without live takes, remixes or tiny clips", async () => {
    const songs = await quizSongs(
      { rounds: 2 },
      {
        recent: () => [],
        log: quiet,
        fetch: fakeFetch([
          { title: 'Song A', duration: 200, artist: { name: 'One' } },
          { title: 'Song B (Live)', duration: 200, artist: { name: 'Two' } },
          { title: 'Song C (Remix)', duration: 200, artist: { name: 'Three' } },
          { title: 'Song D', duration: 20, artist: { name: 'Four' } },
          { title: 'Song E', duration: 180, artist: { name: 'Five' } },
        ]),
      },
      AbortSignal.timeout(1000),
      () => 0,
    );
    expect(songs.map((s) => s.title).sort()).toEqual(['Song A', 'Song E']);
  });

  it('uses what played here, songs only', async () => {
    const t = (n: number, extra: Partial<Track> = {}): Track => ({ title: `Song ${n}`, artist: 'X', id: `vid${n}0000000`.slice(0, 11), source: 'youtube', ref: '', durationS: 180, ...extra });
    const songs = await quizSongs({ rounds: 2, played: true }, { recent: () => [t(1), t(2, { kind: 'podcast' }), t(3, { durationS: 4000 })], log: quiet }, AbortSignal.timeout(1000));
    expect(songs.map((s) => s.title)).toEqual(['Song 1']);
  });

  it('keeps where a Plex song is, so its clip can play', async () => {
    const plex: Track = { title: 'Plex Song', artist: 'X', source: 'plex', ref: '/library/parts/7/file.mp3', durationS: 180 };
    const yt: Track = { title: 'YouTube Song', artist: 'Y', id: 'vid00000001', source: 'youtube', ref: 'https://stream/stale', durationS: 180 };
    const songs = await quizSongs({ rounds: 2, played: true }, { recent: () => [plex, yt], log: quiet }, AbortSignal.timeout(1000), () => 0);
    expect(songs.find((s) => s.source === 'plex')).toMatchObject({ ref: '/library/parts/7/file.mp3' });
    // A YouTube stream URL goes stale: that one is looked up again by its id.
    expect(songs.find((s) => s.source === 'youtube')?.ref).toBeUndefined();
  });
});

describe('quizzes in a room', () => {
  function room() {
    const started: { input: string; range?: { startS: number; seconds: number } }[] = [];
    const out: MusicOutput = {
      playMusic: () => ({ done: new Promise(() => {}), stop() {} }) as PlaybackHandle,
      pauseMusic() {},
      resumeMusic() {},
      setMusicVolume() {},
      musicPlaying: true,
      musicPaused: false,
    };
    const music = new MusicPlayer({
      sources: [],
      output: out,
      decode: (input, range) => {
        started.push({ input: 'url' in input ? input.url : 'stream', ...(range ? { range } : {}) });
        return { pcm: new PassThrough(), kill() {} };
      },
      log: quiet,
    });
    const said: string[] = [];
    return { key: 'discord', music, said, started, say: async (t: string) => void said.push(t), people: () => 2, nameOf: () => 'Alex' };
  }

  it('holds music requests while it runs and gives the music back after', async () => {
    const q = new Quizzes({ settings: { enabled: true, rounds: 8, clipSeconds: 20, hintSeconds: 12 }, log: quiet, sources: () => ({ recent: () => [], log: quiet, fetch: (async () => new Response('{"data":[]}')) as unknown as typeof fetch }) });
    const rm = room();
    expect(await q.local(rm, 'u1', 'start a music quiz')).toBe(true);
    expect(rm.music.lent?.reason).toBe(QUIZ_BUSY);
    expect(await rm.music.request('song', 'anything', 'now', AbortSignal.timeout(1000))).toEqual({ ok: false, message: QUIZ_BUSY });
    expect(await rm.music.playNamed('anything', 'now', AbortSignal.timeout(1000))).toEqual({ ok: false, message: QUIZ_BUSY });
    await flush();
    await flush();
    // No songs to be had: it says so and hands the music back.
    expect(rm.said.some((s) => s.startsWith("I couldn't find enough"))).toBe(true);
    expect(rm.music.lent).toBeUndefined();
    expect(q.of('discord')).toBeUndefined();
  });

  it('refuses a quiz of songs played here when hardly any have', async () => {
    const q = new Quizzes({ settings: { enabled: true, rounds: 8, clipSeconds: 20, hintSeconds: 12 }, log: quiet, sources: () => ({ recent: () => [], log: quiet }) });
    const rm = room();
    expect(q.start(rm, 'u1', { played: true })).toMatch(/haven't played enough/);
    expect(rm.music.lent).toBeUndefined();
  });

  it('hands a Plex song from history to the player with its part', async () => {
    const rm = room();
    const plex = Array.from({ length: 4 }, (_, i): Track => ({ title: `Plex Song ${i}`, artist: 'X', source: 'plex', ref: `/library/parts/${i}/file.mp3`, durationS: 180 }));
    Object.defineProperty(rm.music, 'recent', { get: () => plex });
    const asked: Track[] = [];
    rm.music.clipTrack = async (t) => (asked.push(t), new Promise(() => {}));
    const q = new Quizzes({ settings: { enabled: true, rounds: 2, clipSeconds: 20, hintSeconds: 12 }, log: quiet, sources: (r) => ({ recent: () => r.music.recent, log: quiet }) });
    expect(q.start(rm, 'u1', { played: true })).toBeUndefined();
    await flush();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.ref).toMatch(/^\/library\/parts\/\d\/file\.mp3$/);
    q.end('discord');
  });

  it('a stop for the music ends the quiz', async () => {
    const q = new Quizzes({ settings: { enabled: true, rounds: 8, clipSeconds: 20, hintSeconds: 12 }, log: quiet, sources: () => ({ recent: () => [], log: quiet, fetch: (async () => new Promise(() => {})) as unknown as typeof fetch }) });
    const rm = room();
    q.start(rm, 'u1', {});
    expect(q.of('discord')).toBeDefined();
    expect(rm.music.stop()).toBe(true);
    await flush();
    expect(q.of('discord')).toBeUndefined();
    expect(rm.music.lent).toBeUndefined();
  });
});
