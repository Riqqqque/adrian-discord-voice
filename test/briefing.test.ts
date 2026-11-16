import { describe, expect, it } from 'vitest';
import { Briefing, listWords } from '../src/features/briefing.js';
import { Calendars } from '../src/features/calendar.js';
import { feedText, feedTitles, Headlines } from '../src/features/headlines.js';
import { HeadsUp } from '../src/features/headsup.js';
import type { Reminder } from '../src/features/reminders.js';
import { sky, Weather } from '../src/features/weather.js';

const TZ = 'America/New_York';
/** 8 AM in New York on Monday 16 November 2026. */
const NOW = Date.UTC(2026, 10, 16, 13);
const hours = (key: string, prob: (h: number) => number, code: (h: number) => number) => ({
  time: Array.from({ length: 24 }, (_, h) => `${key}T${String(h).padStart(2, '0')}:00`),
  precipitation_probability: Array.from({ length: 24 }, (_, h) => prob(h)),
  weather_code: Array.from({ length: 24 }, (_, h) => code(h)),
});
const FORECAST = {
  current: { temperature_2m: 54.2, apparent_temperature: 49.6, weather_code: 3, wind_speed_10m: 8 },
  hourly: (() => {
    const a = hours('2026-11-16', (h) => (h >= 15 ? 70 : 10), (h) => (h >= 15 ? 61 : 3));
    const b = hours('2026-11-17', () => 0, () => 0);
    return { time: [...a.time, ...b.time], precipitation_probability: [...a.precipitation_probability, ...b.precipitation_probability], weather_code: [...a.weather_code, ...b.weather_code] };
  })(),
  daily: {
    time: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'],
    weather_code: [61, 0, 3, 71, 2, 1, 95],
    temperature_2m_max: [61.4, 58, 50, 35, 40, 44, 52],
    temperature_2m_min: [45, 41, 38, 28, 30, 33, 40],
    precipitation_probability_max: [80, 5, 20, 60, 10, 0, 55],
  },
};

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (url: URL | string) => {
    const u = String(url);
    calls.push(u);
    for (const [k, v] of Object.entries(routes)) if (u.includes(k)) return new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const weather = (calls: string[] = []) =>
  new Weather(
    { place: 'Springfield, Illinois', units: 'fahrenheit' },
    TZ,
    fakeFetch(
      {
        'geocoding-api': { results: [{ latitude: 37.2, longitude: -93.3, admin1: 'Missouri', country: 'United States' }, { latitude: 39.8, longitude: -89.6, admin1: 'Illinois', country: 'United States' }] },
        'api.open-meteo.com': FORECAST,
      },
      calls,
    ),
    () => NOW,
  );

describe('weather', () => {
  it('finds the right town of that name, and asks the forecast once per few minutes', async () => {
    const calls: string[] = [];
    const w = weather(calls);
    expect(await w.report('today')).toBe('Now 54°F (feels like 50) and cloudy. Today: high 61, low 45. Rain likely from 3 PM (70%).');
    await w.report('tomorrow');
    expect(calls.filter((c) => c.includes('forecast'))).toHaveLength(1);
    expect(calls.find((c) => c.includes('forecast'))).toContain('latitude=39.800');
    expect(calls.find((c) => c.includes('forecast'))).toContain('timezone=America%2FNew_York');
  });

  it('says tomorrow, the week, and the briefing words', async () => {
    const w = weather();
    expect(await w.report('tomorrow')).toBe('Tomorrow: clear, 41 to 58°F.');
    const week = await w.report('week');
    expect(week).toContain('Thursday: snow, 28 to 35°F, 60% chance of snow.');
    expect(week.split('. ').length).toBeGreaterThan(6);
    expect(await w.report('2027-01-01')).toMatch(/7 days/);
    expect(await w.brief()).toBe('54 degrees and cloudy, up to 61, rain likely from 3 PM');
  });

  it('reads the weather codes', () => {
    expect([0, 2, 45, 63, 66, 75, 81, 95].map(sky)).toEqual(['clear', 'partly cloudy', 'foggy', 'rain', 'freezing rain', 'heavy snow', 'showers', 'thunderstorms']);
  });

  it('a failed service is a short line, not an error', async () => {
    const w = new Weather({ place: 'Nowhere', units: 'celsius' }, TZ, fakeFetch({}), () => NOW);
    expect(await w.tool().run({}, AbortSignal.timeout(5000), { userId: 'a', speaker: 'Sean' })).toBe("I couldn't get the weather just now.");
    expect(new Weather({ units: 'celsius' }, TZ).usable).toBe(false);
  });
});

describe('headlines', () => {
  const RSS = `<?xml version="1.0"?><rss><channel><title>Feed</title>
    <item><title><![CDATA[Storm hits <b>coast</b>]]></title></item>
    <item><title>Markets &amp; rates &#8212; what&#x27;s next</title></item>
    <item><title>Storm hits coast</title></item></channel></rss>`;
  const ATOM = `<feed><title>A</title><entry><title type="html">Team wins title</title></entry></feed>`;

  it('reads RSS and Atom titles, without tags, entities or repeats', () => {
    expect(feedTitles(RSS)).toEqual(['Storm hits coast', 'Markets & rates — what\'s next']);
    expect(feedTitles(ATOM)).toEqual(['Team wins title']);
    expect(feedText('a\u0007b   c')).toBe('a b c');
  });

  it('takes turns between feeds and keeps them for half an hour', async () => {
    const calls: string[] = [];
    let t = NOW;
    const h = new Headlines(['https://a.example/rss', 'https://b.example/atom'], fakeFetch({ 'a.example': RSS, 'b.example': ATOM }, calls), () => t);
    expect(await h.top(3)).toEqual(['Storm hits coast', 'Team wins title', "Markets & rates — what's next"]);
    t += 10 * 60_000;
    await h.top(2);
    expect(calls).toHaveLength(2);
  });
});

describe('the morning briefing', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:1', 'DTSTART;TZID=America/New_York:20261116T100000', 'DTEND;TZID=America/New_York:20261116T110000', 'SUMMARY:Dentist', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:2', 'DTSTART;TZID=America/New_York:20261116T070000', 'DTEND;TZID=America/New_York:20261116T073000', 'SUMMARY:Already over', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:3', 'DTSTART;TZID=America/New_York:20261116T183000', 'SUMMARY:Dinner with Sam', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const rem = (text: string, h: number, kind: Reminder['kind'] = 'reminder'): Reminder => ({ id: text, userId: 'owner', speaker: 'Sean', kind, text, dueAt: Date.UTC(2026, 10, 16, h), createdAt: NOW });
  const make = (over: Partial<ConstructorParameters<typeof Briefing>[0]> = {}) =>
    new Briefing({
      weather: weather(),
      calendars: new Calendars([{ name: 'me', url: 'https://cal.example/a.ics' }], TZ, fakeFetch({ 'cal.example': ICS }), () => NOW),
      headlines: new Headlines(['https://news.example/rss'], fakeFetch({ 'news.example': '<rss><item><title>Big storm on the way to the east coast this week, forecasters say.</title></item><item><title>Second story</title></item></rss>' }), () => NOW),
      reminders: () => [rem('take out the trash', 19), rem('pizza', 14, 'timer'), rem('next week thing', 24 * 7)],
      calendarFor: (id) => id === 'owner',
      timezone: TZ,
      headlineCount: 2,
      now: () => NOW,
      ...over,
    });

  it('alone: the weather, what is left on the calendar, reminders and headlines', async () => {
    expect(await make().line('owner', { name: 'Sean', private: true })).toBe(
      "Good morning, Sean. It's 54 degrees and cloudy, up to 61, rain likely from 3 PM. Today: Dentist at 10 AM and Dinner with Sam at 6:30 PM. Reminder: take out the trash at 2 PM. In the news: Big storm on the way to the east coast this week, forecasters say. Second story.",
    );
  });

  it('with others there: only how many, and nobody else hears the owner\'s calendar', async () => {
    const shared = await make().line('owner', { private: false });
    expect(shared).toContain('You have 2 things on your calendar today.');
    expect(shared).toContain('You have 1 reminder today.');
    expect(shared).not.toContain('Dentist');
    expect(await make().line('friend', { private: true })).not.toMatch(/calendar|Dentist/);
  });

  it('says nothing when it has nothing but a greeting, and leaves out a source that fails', async () => {
    expect(await make({ weather: undefined, calendars: undefined, headlines: undefined, reminders: () => [] }).line('owner', { private: true })).toBeUndefined();
    const broken = make({ calendars: new Calendars([{ name: 'me', url: 'https://cal.example/a.ics' }], TZ, fakeFetch({}), () => NOW) });
    expect(await broken.line('owner', { private: true })).not.toMatch(/calendar|Today:/);
  });

  it('joins words the way speech does', () => {
    expect(listWords(['a'])).toBe('a');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('the briefing on the first join of the morning', () => {
  const setup = (t: { now: number }, alone = true) => {
    const said: string[] = [];
    const h = new HeadsUp(undefined, { enabled: false, people: [], awayHours: 4, minHours: 6 }, {
      sources: { media: { timezone: TZ }, servers: [], ping: async () => undefined },
      timezone: TZ,
      isOwner: (id) => id === 'owner',
      audible: () => true,
      quiet: () => true,
      say: async (_id, line) => (said.push(line), true),
      morning: { fromHour: 5, untilHour: 12, line: async (_id, a) => (a ? 'Good morning. Private bits.' : 'Good morning. Counts only.') },
      alone: () => alone,
      now: () => t.now,
      sleep: async () => undefined,
    });
    return { h, said };
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it('once a day, in the morning window, even with heads-ups off', async () => {
    const t = { now: NOW };
    const { h, said } = setup(t);
    h.members(new Set(), true);
    h.members(new Set(['owner']));
    await settle();
    expect(said).toEqual(['Good morning. Private bits.']);
    h.members(new Set());
    t.now += 3_600_000;
    h.members(new Set(['owner']));
    await settle();
    expect(said).toHaveLength(1);
    // The next morning.
    h.members(new Set());
    t.now = NOW + 24 * 3_600_000;
    h.members(new Set(['owner']));
    await settle();
    expect(said).toHaveLength(2);
  });

  it('not for other people, not in the afternoon, and not after they said no', async () => {
    const t = { now: NOW };
    const { h, said } = setup(t, false);
    h.members(new Set(['friend']));
    await settle();
    expect(said).toEqual([]);
    t.now = Date.UTC(2026, 10, 16, 19); // 2 PM
    h.members(new Set(['friend', 'owner']));
    await settle();
    expect(said).toEqual([]);
    const prefs = h.tools().find((x) => x.spec.name === 'digest_prefs')!;
    expect(await prefs.run({ morning_briefing: false }, AbortSignal.timeout(1000), { userId: 'owner', speaker: 'Sean' })).toBe('Okay, no more morning briefings.');
    h.members(new Set());
    t.now = NOW + 24 * 3_600_000;
    h.members(new Set(['owner']));
    await settle();
    expect(said).toEqual([]);
  });

  it('with friends in the call it says the shared version', async () => {
    const t = { now: NOW };
    const { h, said } = setup(t, false);
    h.members(new Set(['friend']), true);
    h.members(new Set(['friend', 'owner']));
    await settle();
    expect(said).toEqual(['Good morning. Counts only.']);
  });
});
