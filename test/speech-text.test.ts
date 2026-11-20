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
    ['Cut it by 1/2.', 'Cut it by half.'],
    ['Due on 1/2.', 'Due on January 2nd.'],
    ['Your appointment is on 11/21 at 2 PM.', 'Your appointment is on November 21st at 2 PM.'],
    ['Your next alarm is at 07:00.', "Your next alarm is at 7 o'clock."],
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
    ["It's approx. 20 min away.", "It's approximately 20 min away."],
    ['Playing Pt. 2 by Kanye West.', 'Playing Part 2 by Kanye West.'],
    ['Hades II is on sale.', 'Hades 2 is on sale.'],
    ['Cats vs. dogs.', 'Cats versus dogs.'],
    // Review fixes (VO1-VO5)
    ['It costs €2.5 million.', 'It costs 2.5 million euros.'],
    ['It costs £1.5 billion.', 'It costs 1.5 billion pounds.'],
    ['€10.5 per month', '10.5 euros per month'],
    ['€1.234 total', '1.234 euros total'],
    ['€20.50 each', '20 euros 50 each'],
    ['approved by 3/5 of the Senate', 'approved by 3 fifths of the Senate'],
    ['from 1/2 to 3/4 of a cup', 'from half to three quarters of a cup'],
    ['Pay it by 11/21.', 'Pay it by November 21st.'],
    ['The meeting starts at 10:30:00.', 'The meeting starts at 10:30.'],
    ['It is 10:30:00 PM.', 'It is 10:30 PM.'],
    ['Queen Elizabeth II', 'Queen Elizabeth the Second'],
    ['Pope Leo XIV spoke.', 'Pope Leo the Fourteenth spoke.'],
    ['Henry VIII had six wives.', 'Henry the Eighth had six wives.'],
    ['World War II ended in 1945.', 'World War 2 ended in 1945.'],
    ['Going 15 km/h, or 9.8 m/s.', 'Going 15 kilometers per hour, or 9.8 meters per second.'],
    ['TCP/IP and/or UDP', 'TCP IP and or UDP'],
    ['It costs €20, or £15.', 'It costs 20 euros, or 15 pounds.'],
    ['€1,500 total', '1,500 euros total'],
    ['On 11/21 the store opens.', 'On November 21st the store opens.'],
    // Ratings, scores and dates are not fractions (REVIEW-11)
    ['IMDb rates it 7.8/10.', 'IMDb rates it 7.8 out of 10.'],
    ['It has a 4.5/5 rating.', 'It has a 4.5 out of 5 rating.'],
    ['Critics gave it 4/5 stars.', 'Critics gave it 4 out of 5 stars.'],
    ['I would give it a 9/10.', 'I would give it a 9 out of 10.'],
    ['Reviewers say 3/4 stars.', 'Reviewers say 3 out of 4 stars.'],
    ['Forecast for Friday 1/10.', 'Forecast for Friday January 10th.'],
    ["Mon 2/6 at 7:00", "Mon February 6th at 7 o'clock"],
    ['The show is Fri, 11/21.', 'The show is Fri, November 21st.'],
    ['The release is 11/21.', 'The release is November 21st.'],
    ['They won 3/1 last night.', 'They won 3 to 1 last night.'],
    ['He went 3/3 at the plate.', 'He went 3 for 3 at the plate.'],
    ['Add 3/4 of a cup of milk.', 'Add three quarters of a cup of milk.'],
    ['Use 3/8 inch screws.', 'Use 3 eighths inch screws.'],
    ['Only 1/10 of a second.', 'Only one tenth of a second.'],
    ['Top speed is 60km/h.', 'Top speed is 60 kilometers per hour.'],
  ];
  for (const [text, said] of cases) it(text, () => expect(forSpeech(text)).toBe(said));

  it('leaves what it should alone', () => {
    for (const t of [
      'Canberra is the capital of Australia, not Sydney.',
      "It's seventy two degrees and sunny.",
      'It is 3:45 PM and 17:00 in Berlin.',
      'Main St. Then left.', // Street, not Saint
      'Turn left on 5th St. Then go two blocks.', // after a number too
      'It is open 24/7.',
      'Dated 11/21/2026.', // a full date is the voice's
      'Grand Theft Auto V is out.', // single-letter numerals are too often letters
      'The score was 3-1 at halftime.', // Kokoro reads ranges; "2 to 3" made "40 to 60" heard as "4 to 60"
      'You have 300 GB free.',
      'About 5 km, 1.2 kg or 150 lbs, in 20 min.',
      "It's 5:00 PM on November 28.",
      '#gaming',
      'It ended at 3:15:20 PM.', // a time of day with seconds, not a duration
      'Coffee w/o sugar.', // left to the voice: "w o" lost the meaning
      'It cost £5m, then €20k, then £1.5bn.', // amounts run into letters: left to the voice
      'Downloading at 5 MB/s.', // megabytes, not "megabits per"
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
    // Never the whole address, however it's wrapped.
    for (const t of ['http://localhost:8080/x', '"https://x.com"', '<https://a.b>', '**https://x.com**', 'go to https://x.com/a?b=c&d=e, then']) expect(toSpeakable(t)).not.toMatch(/https?:|\/\//);
  });

  it('never reads a home address, a user name, an IP or an odd host', () => {
    expect(toSpeakable('Open http://192.168.0.20:8080/admin now.')).toBe('Open a local link now.');
    expect(toSpeakable('http://localhost:8080/x')).toBe('a local link');
    expect(toSpeakable('See http://nas.local/share.')).toBe('See a local link.');
    expect(toSpeakable('Try http://10.0.0.2 or http://100.100.1.1/')).toBe('Try a local link or a local link');
    expect(toSpeakable('https://user:secret@host.example/x')).toBe('a link');
    expect(toSpeakable('http://8.8.8.8/dns')).toBe('a link');
    expect(toSpeakable('Go to https://日本.jp/x now')).toBe('Go to a link now');
    expect(toSpeakable('http://[::1]:8080/')).toBe('a link');
    for (const t of ['http://192.168.1.1', 'https://u@x.com', 'http://[fe80::1]/', 'https://ünï.com']) expect(toSpeakable(t)).not.toMatch(/\d+\.\d+|u@|::|ünï|https?:/);
  });

  it('reads a link in linear time, however much punctuation follows it', () => {
    const t0 = performance.now();
    toSpeakable(`https://a.b/${')'.repeat(32_000)}`);
    expect(performance.now() - t0).toBeLessThan(200);
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
