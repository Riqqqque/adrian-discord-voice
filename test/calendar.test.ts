import { describe, expect, it } from 'vitest';
import { addDays, calendarUrl, Calendars, dayKey, dayStart, eventsBetween } from '../src/features/calendar.js';

const TZ = 'America/New_York';
const ics = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...events, 'END:VCALENDAR'].join('\r\n');
const ev = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const day = (k: string) => [dayStart(k, TZ)!, dayStart(addDays(k, 1), TZ)!] as const;

const FILE = ics(
  ev('UID:a', 'DTSTART;TZID=America/New_York:20261116T100000', 'DTEND;TZID=America/New_York:20261116T110000', 'SUMMARY:Dentist', 'LOCATION:Main St'),
  ev('UID:b', 'DTSTART;VALUE=DATE:20261116', 'DTEND;VALUE=DATE:20261117', 'SUMMARY:Mom birthday'),
  ev('UID:c', 'DTSTART:20261116T230000Z', 'DTEND:20261117T000000Z', 'SUMMARY:Late call'),
  ev('UID:d', 'DTSTART;TZID=America/New_York:20261117T090000', 'DTEND;TZID=America/New_York:20261117T093000', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED'),
  // Weekly standup on Mondays; the 23rd is skipped, the 30th moved to 2 PM.
  ev('UID:w', 'DTSTART;TZID=America/New_York:20261102T090000', 'DTEND;TZID=America/New_York:20261102T091500', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/New_York:20261123T090000', 'SUMMARY:Standup'),
  ev('UID:w', 'RECURRENCE-ID;TZID=America/New_York:20261130T090000', 'DTSTART;TZID=America/New_York:20261130T140000', 'DTEND;TZID=America/New_York:20261130T141500', 'SUMMARY:Standup (moved)'),
  ev('UID:f', 'DTSTART:20261116T190000', 'DTEND:20261116T200000', 'SUMMARY:Floating dinner'),
);

describe('calendar files', () => {
  it('lists one household day: zoned, all-day, UTC and floating times; cancelled ones left out', () => {
    const [a, b] = day('2026-11-16');
    const got = eventsBetween(FILE, a, b, 'me', TZ);
    expect(got.map((e) => e.title)).toEqual(['Mom birthday', 'Standup', 'Dentist', 'Late call', 'Floating dinner']);
    const c = new Calendars([], TZ);
    const dentist = got.find((e) => e.title === 'Dentist')!;
    expect(c.clock(dentist.start)).toBe('10 AM');
    expect(dentist.where).toBe('Main St');
    // 23:00 UTC is 6 PM in New York in November.
    expect(c.clock(got.find((e) => e.title === 'Late call')!.start)).toBe('6 PM');
    expect(c.clock(got.find((e) => e.title === 'Floating dinner')!.start)).toBe('7 PM');
    expect(eventsBetween(FILE, ...day('2026-11-17'), 'me', TZ)).toEqual([]);
  });

  it('expands repeats, skipping excluded days and moving changed ones', () => {
    expect(eventsBetween(FILE, ...day('2026-11-23'), 'me', TZ)).toEqual([]);
    const moved = eventsBetween(FILE, ...day('2026-11-30'), 'me', TZ);
    expect(moved.map((e) => [e.title, new Calendars([], TZ).clock(e.start)])).toEqual([['Standup (moved)', '2 PM']]);
    expect(eventsBetween(FILE, ...day('2026-12-07'), 'me', TZ).map((e) => e.title)).toEqual(['Standup']);
  });

  it('keeps control characters and long titles out of what the model reads', () => {
    const f = ics(ev('UID:x', 'DTSTART:20261116T150000Z', `SUMMARY:${'A'.repeat(300)}`), ev('UID:y', 'DTSTART:20261116T160000Z', 'SUMMARY:bad\\nline'));
    const got = eventsBetween(f, ...day('2026-11-16'), 'me', TZ);
    expect(got[0]!.title.length).toBe(80);
    expect(got[1]!.title).toBe('bad line');
  });

  it('day keys follow the household time zone, across the DST change', () => {
    expect(dayKey(Date.UTC(2026, 10, 17, 3), TZ)).toBe('2026-11-16');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(dayStart('2026-11-01', TZ)! - dayStart('2026-10-31', TZ)!).toBe(24 * 3_600_000);
    expect(dayStart('2026-11-02', TZ)! - dayStart('2026-11-01', TZ)!).toBe(25 * 3_600_000);
  });

  it('takes only https or webcal addresses with no login inside', () => {
    expect(String(calendarUrl('webcal://calendar.google.com/calendar/ical/x/basic.ics'))).toBe('https://calendar.google.com/calendar/ical/x/basic.ics');
    expect(calendarUrl('http://example.com/a.ics')).toMatch(/https/);
    expect(calendarUrl('https://u:p@example.com/a.ics')).toMatch(/password/);
    expect(calendarUrl('file:///etc/passwd')).toMatch(/https/);
  });
});

describe('the calendar tool', () => {
  const now = () => Date.UTC(2026, 10, 16, 14); // 9 AM in New York
  const fake = (body: string, calls: { url: string; init: RequestInit | undefined }[] = []) =>
    (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
  const ctx = (userId: string) => ({ userId, speaker: 'Sean' });

  it('answers the owner with the day, and nobody else', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const c = new Calendars([{ name: 'personal', url: 'webcal://cal.example/secret.ics' }], TZ, fake(FILE, calls), now);
    const tool = c.tool((id) => id === 'owner');
    const out = String(await tool.run({}, AbortSignal.timeout(5000), ctx('owner')));
    expect(out).toContain('Monday, November 16');
    expect(out).toContain('10 AM to 11 AM: Dentist (at Main St)');
    expect(out).toContain('all day: Mom birthday');
    expect(String(await tool.run({}, AbortSignal.timeout(5000), ctx('friend')))).toMatch(/only they can ask/);
    expect(calls[0]!.url).toBe('https://cal.example/secret.ics');
    expect(calls[0]!.init?.redirect).toBe('error');
    // Read once, then from memory for a few minutes.
    await tool.run({ date: '2026-11-17' }, AbortSignal.timeout(5000), ctx('owner'));
    expect(calls.length).toBe(1);
  });

  it('covers several days and says which calendars it could not read', async () => {
    const bad = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const c = new Calendars([{ name: 'work', url: 'https://cal.example/w.ics' }], TZ, bad, now);
    expect(String(await c.tool(() => true).run({}, AbortSignal.timeout(5000), ctx('owner')))).toMatch(/couldn't read the calendar.*work/);
    const ok = new Calendars([{ name: 'personal', url: 'https://cal.example/p.ics' }], TZ, fake(FILE), now);
    const week = String(await ok.tool(() => true).run({ date: '2026-11-16', days: 3 }, AbortSignal.timeout(5000), ctx('owner')));
    expect(week.split('\n')).toHaveLength(3);
    expect(week).toContain('Tuesday, November 17: nothing.');
  });

  it('refuses a file that is not a calendar', async () => {
    const c = new Calendars([{ name: 'x', url: 'https://cal.example/p.ics' }], TZ, fake('<html>login</html>'), now);
    expect((await c.day()).failed).toEqual(['x']);
  });
});
