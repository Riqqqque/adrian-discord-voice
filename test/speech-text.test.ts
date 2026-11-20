import { describe, expect, it } from 'vitest';
import { forSpeech, ordinal, SentenceSplitter, toSpeakable } from '../src/brain/speech-text.js';

describe('forSpeech (English voices)', () => {
  const cases: [string, string][] = [
    // Weather tool lines
    ['Now 54°F (feels like 50) and cloudy.', 'Now 54 degrees (feels like 50) and cloudy.'],
    ['Thursday: snow, 28 to 35°F, 60% chance of snow.', 'Thursday: snow, 28 to 35 degrees, 60% chance of snow.'],
    ['Your GPU is at 62°C.', 'Your GPU is at 62 degrees Celsius.'],
    ['It was -5°C this morning.', 'It was minus 5 degrees Celsius this morning.'],
    ['The thermostat says 72° inside.', 'The thermostat says 72 degrees inside.'],
    // Dates and times
    ['until Nov 9.', 'until November 9th.'],
    ['Alarm set for 8:15 AM Saturday, November 28.', 'Alarm set for 8:15 AM Saturday, November 28th.'],
    ['November 28, 2026', 'November 28th, 2026'],
    ['Your appointment is on 11/21 at 2 PM.', 'Your appointment is on November 21st at 2 PM.'],
    ['Your next alarm is at 07:00.', "Your next alarm is at 7 o'clock."],
    ["It's 5:00 PM.", "It's 5 PM."],
    ['Your timer has 1:30 left.', 'Your timer has 1 minute 30 seconds left.'],
    ['Severance S3E3: downloading, 75%, 00:04:10 left', 'Severance season 3 episode 3: downloading, 75%, 4 minutes 10 seconds left'],
    // Units, money, symbols
    ['Ping is around 35 ms right now.', 'Ping is around 35 milliseconds right now.'],
    ['The shelf is 6 ft tall, or 1 ft wider.', 'The shelf is 6 feet tall, or 1 foot wider.'],
    ['Set it to 1080p at 144 Hz.', 'Set it to 1080p at 144 hertz.'],
    ['It costs €20 in Europe, or £15 here.', 'It costs 20 euros in Europe, or 15 pounds here.'],
    ["You're #1 on the leaderboard!", "You're number 1 on the leaderboard!"],
    ['Add 1/2 a cup of sugar.', 'Add half a cup of sugar.'],
    ["It's 50/50 whether it rains.", "It's 50 50 whether it rains."],
    ['AC/DC is playing next.', 'AC DC is playing next.'],
    // Abbreviations and numerals
    ["Meet me at St. Mary's at 5.", "Meet me at Saint Mary's at 5."],
    ["It's approx. 20 min away.", "It's approximately 20 minutes away."],
    ['Playing Pt. 2 by Kanye West.', 'Playing Part 2 by Kanye West.'],
    ['Hades II is on sale.', 'Hades 2 is on sale.'],
    ['Cats vs. dogs.', 'Cats versus dogs.'],
  ];
  for (const [text, said] of cases) it(text, () => expect(forSpeech(text)).toBe(said));

  it('leaves what it should alone', () => {
    for (const t of [
      'Canberra is the capital of Australia, not Sydney.',
      "It's seventy two degrees and sunny.",
      'It is 3:45 PM and 17:00 in Berlin.',
      'Main St. Then left.', // Street, not Saint
      'Grand Theft Auto V is out.', // single-letter numerals are too often letters
      'The score was 3-1 at halftime.', // Kokoro reads ranges; "2 to 3" made "40 to 60" heard as "4 to 60"
      'You have 300 GB free.',
      '#gaming',
    ]) expect(forSpeech(t)).toBe(t);
  });

  it('is safe to apply twice', () => {
    for (const [text] of cases) expect(forSpeech(forSpeech(text))).toBe(forSpeech(text));
  });

  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
  });
});

describe('toSpeakable', () => {
  it('drops emoji, which the voices read by name', () => {
    expect(toSpeakable('Sure! 🎵 Playing your mix now.')).toBe('Sure! Playing your mix now.');
    expect(toSpeakable('Nice one, that was clean 😂👍🏽')).toBe('Nice one, that was clean');
    expect(toSpeakable('¡Claro! 🎉 Ya está.')).toBe('¡Claro! Ya está.');
  });

  it('says a bare link as its site', () => {
    expect(toSpeakable('You can grab it from https://modrinth.com/mod/jei right now.')).toBe('You can grab it from modrinth.com right now.');
    expect(toSpeakable('See https://www.youtube.com/watch?v=abc.')).toBe('See youtube.com.');
    expect(toSpeakable('(https://example.org)')).toBe('(example.org)');
  });

  it('keeps "#1" but drops a heading marker', () => {
    expect(toSpeakable('#1 on the list')).toBe('#1 on the list');
    expect(toSpeakable('## Tips\nDrink water.')).toBe('Tips Drink water.');
  });
});

describe('sentence splitter', () => {
  it('does not cut after "Pt." or "feat."', () => {
    const s = new SentenceSplitter();
    expect([...s.push('Playing Pt. 2 by Kanye West. Next is a song feat. Drake. '), ...s.flush()]).toEqual(['Playing Pt. 2 by Kanye West.', 'Next is a song feat. Drake.']);
  });

  it('keeps "Nov. 9" together', () => {
    const s = new SentenceSplitter();
    expect([...s.push('It ends Nov. 9 at noon. Then it resets. '), ...s.flush()]).toEqual(['It ends Nov. 9 at noon.', 'Then it resets.']);
  });

  it('"No." ends a sentence unless a number follows', () => {
    const s = new SentenceSplitter();
    expect([...s.push('No. It closes at nine. Track No. 5 is next. '), ...s.flush()]).toEqual(['No.', 'It closes at nine.', 'Track No. 5 is next.']);
    const w = new SentenceSplitter();
    expect(w.push('Sorry, no. ')).toEqual([]); // waits for the next word
    expect(w.push('That one is gone. ')).toEqual(['Sorry, no.', 'That one is gone.']);
  });
});
