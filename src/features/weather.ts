// Weather from Open-Meteo (free, no key): now, today, tomorrow or the week,
// for the household's place. The place (a city name, or coordinates) is the
// only thing sent; it's set in the config, never taken from a request, so
// nobody can make her look up where someone else lives.

import { dateFormat } from '../core/time.js';
import type { Tool } from '../core/interfaces.js';
import { addDays, dayKey } from './calendar.js';

type Fetch = typeof fetch;

const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 6_000;
const MAX_BYTES = 1024 * 1024;

export interface WeatherPlace {
  /** "Denver" or "Denver, Colorado" or "Denver, US". */
  place?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  units: 'fahrenheit' | 'celsius';
}

interface Forecast {
  current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number };
  hourly?: { time?: string[]; precipitation_probability?: (number | null)[]; weather_code?: (number | null)[] };
  daily?: {
    time?: string[];
    weather_code?: (number | null)[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
}

/** WMO weather codes in a few words. */
export function sky(code: number | null | undefined): string {
  if (code === null || code === undefined) return 'unknown';
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code === 56 || code === 57) return 'freezing drizzle';
  if (code >= 61 && code <= 65) return code === 65 ? 'heavy rain' : 'rain';
  if (code === 66 || code === 67) return 'freezing rain';
  if (code >= 71 && code <= 77) return code === 75 ? 'heavy snow' : 'snow';
  if (code >= 80 && code <= 82) return 'showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code >= 95) return 'thunderstorms';
  return 'unknown';
}

const WET = (code: number | null | undefined) => code !== null && code !== undefined && code >= 51 && code !== 45 && code !== 48;
const round = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined);

async function getJson<T>(f: Fetch, url: string, signal?: AbortSignal): Promise<T> {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await f(url, { signal: sig, redirect: 'error' });
  if (!res.ok) throw new Error(`weather service answered ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('weather answer too big');
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}

export class Weather {
  private spot: { lat: number; lon: number } | undefined;
  private cache: { at: number; f: Forecast } | undefined;

  constructor(
    private readonly where: WeatherPlace,
    private readonly tz: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (where.latitude !== undefined && where.longitude !== undefined) this.spot = { lat: where.latitude, lon: where.longitude };
  }

  /** Is a place set at all? */
  get usable(): boolean {
    return !!this.spot || !!this.where.place?.trim();
  }

  private get deg(): string {
    return this.where.units === 'celsius' ? '°C' : '°F';
  }

  private async locate(signal?: AbortSignal): Promise<{ lat: number; lon: number }> {
    if (this.spot) return this.spot;
    const [name, region] = (this.where.place ?? '').split(',').map((s) => s.trim());
    if (!name) throw new Error('no place set');
    const j = await getJson<{ results?: { latitude: number; longitude: number; admin1?: string; country?: string; country_code?: string }[] }>(
      this.fetchFn,
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`,
      signal,
    );
    const r = region?.toLowerCase();
    const hit =
      (r && j.results?.find((x) => [x.admin1, x.country, x.country_code].some((v) => v?.toLowerCase() === r || (r.length > 2 && v?.toLowerCase().startsWith(r))))) ||
      j.results?.[0];
    if (!hit) throw new Error('place not found');
    this.spot = { lat: hit.latitude, lon: hit.longitude };
    return this.spot;
  }

  private async forecast(signal?: AbortSignal): Promise<Forecast> {
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache.f;
    const { lat, lon } = await this.locate(signal);
    const q = new URLSearchParams({
      latitude: lat.toFixed(3),
      longitude: lon.toFixed(3),
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
      hourly: 'precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      temperature_unit: this.where.units,
      wind_speed_unit: this.where.units === 'celsius' ? 'kmh' : 'mph',
      timezone: this.tz,
      forecast_days: '7',
    });
    const f = await getJson<Forecast>(this.fetchFn, `https://api.open-meteo.com/v1/forecast?${q}`, signal);
    this.cache = { at: this.now(), f };
    return f;
  }

  /** "rain likely from 3 PM (70%)" for the rest of a day, if any. */
  private wetHours(f: Forecast, key: string, fromHour: number): string | undefined {
    const t = f.hourly?.time ?? [];
    const p = f.hourly?.precipitation_probability ?? [];
    const c = f.hourly?.weather_code ?? [];
    let first: number | undefined;
    let top = 0;
    for (let i = 0; i < t.length; i++) {
      if (!t[i]!.startsWith(key)) continue;
      const hour = Number(t[i]!.slice(11, 13));
      if (hour < fromHour) continue;
      const pr = p[i] ?? 0;
      if (pr >= 50 && WET(c[i])) {
        first ??= hour;
        top = Math.max(top, pr);
      }
    }
    if (first === undefined) return undefined;
    const kind = sky(c[t.findIndex((x) => x === `${key}T${String(first).padStart(2, '0')}:00`)] ?? 61);
    const what = kind === 'snow' || kind === 'heavy snow' || kind === 'snow showers' ? 'snow' : kind === 'thunderstorms' ? 'storms' : 'rain';
    const clock = first === 0 ? 'midnight' : first === 12 ? 'noon' : first < 12 ? `${first} AM` : `${first - 12} PM`;
    return first <= fromHour ? `${what} likely (${top}%)` : `${what} likely from ${clock} (${top}%)`;
  }

  /** One day's line: "Tuesday: rain, 48 to 55°F, rain likely (80%)." */
  private dayLine(f: Forecast, i: number, label: string): string | undefined {
    const d = f.daily;
    const hi = round(d?.temperature_2m_max?.[i]);
    const lo = round(d?.temperature_2m_min?.[i]);
    if (hi === undefined || lo === undefined) return undefined;
    const pr = round(d?.precipitation_probability_max?.[i]);
    const wet = pr !== undefined && pr >= 40 ? `, ${pr}% chance of ${sky(d?.weather_code?.[i]).includes('snow') ? 'snow' : 'rain'}` : '';
    return `${label}: ${sky(d?.weather_code?.[i])}, ${lo} to ${hi}${this.deg}${wet}.`;
  }

  /** Text for a day ("today", "tomorrow", "week" or YYYY-MM-DD). */
  async report(when: string = 'today', signal?: AbortSignal): Promise<string> {
    const f = await this.forecast(signal);
    const today = dayKey(this.now(), this.tz);
    const days = f.daily?.time ?? [];
    if (when === 'week') {
      const lines = days.map((k, i) => this.dayLine(f, i, i === 0 ? 'Today' : this.weekday(k))).filter(Boolean);
      return lines.join(' ') || 'No forecast came back.';
    }
    const key = when === 'tomorrow' ? addDays(today, 1) : /^\d{4}-\d{2}-\d{2}$/.test(when) ? when : today;
    const i = days.indexOf(key);
    if (i < 0) return 'The forecast only goes 7 days ahead.';
    if (key !== today) {
      const line = this.dayLine(f, i, key === addDays(today, 1) ? 'Tomorrow' : this.weekday(key));
      const wet = this.wetHours(f, key, 0);
      return line ? `${line}${wet ? ` ${wet[0]!.toUpperCase()}${wet.slice(1)}.` : ''}` : 'No forecast came back.';
    }
    const c = f.current;
    const now = round(c?.temperature_2m);
    const feels = round(c?.apparent_temperature);
    const hour = Number(dateFormat('en-US', { timeZone: this.tz, hour: 'numeric', hourCycle: 'h23' }).format(this.now()));
    const parts: string[] = [];
    if (now !== undefined) parts.push(`Now ${now}${this.deg}${feels !== undefined && Math.abs(feels - now) >= 4 ? ` (feels like ${feels})` : ''} and ${sky(c?.weather_code)}.`);
    const hi = round(f.daily?.temperature_2m_max?.[i]);
    const lo = round(f.daily?.temperature_2m_min?.[i]);
    if (hi !== undefined && lo !== undefined) parts.push(`Today: high ${hi}, low ${lo}.`);
    const wet = this.wetHours(f, key, hour);
    parts.push(wet ? `${wet[0]!.toUpperCase()}${wet.slice(1)}.` : 'No rain expected.');
    return parts.join(' ');
  }

  /** Short words for the morning briefing: "54 and cloudy, up to 61, rain likely from 3 PM". */
  async brief(signal?: AbortSignal): Promise<string | undefined> {
    const f = await this.forecast(signal);
    const key = dayKey(this.now(), this.tz);
    const i = (f.daily?.time ?? []).indexOf(key);
    const now = round(f.current?.temperature_2m);
    const hi = i >= 0 ? round(f.daily?.temperature_2m_max?.[i]) : undefined;
    if (now === undefined) return undefined;
    const hour = Number(dateFormat('en-US', { timeZone: this.tz, hour: 'numeric', hourCycle: 'h23' }).format(this.now()));
    const wet = this.wetHours(f, key, hour);
    return [`${now} degrees and ${sky(f.current?.weather_code)}`, ...(hi !== undefined && hi > now ? [`up to ${hi}`] : []), ...(wet ? [wet.replace(/ \(\d+%\)$/, '')] : [])].join(', ');
  }

  private weekday(key: string): string {
    const [y, m, d] = key.split('-').map(Number) as [number, number, number];
    return dateFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(Date.UTC(y, m - 1, d, 12));
  }

  tool(): Tool {
    return {
      slow: true,
      timeoutMs: 8_000,
      route: /\b(weather|rain(ing|y)?|snow(ing|y)?|temperature|degrees|hot|cold|warm|chilly|forecast|umbrella|jacket|coat|sunny|cloudy|storms?|wind(y)?|outside|humid)\b/i,
      spec: {
        name: 'weather',
        description: "Weather where the household is: now and today, tomorrow, a date (YYYY-MM-DD) within 7 days, or the week. Use this instead of a web search for the household's own weather.",
        parameters: { type: 'object', properties: { when: { type: 'string', description: 'today (default), tomorrow, week, or YYYY-MM-DD' } }, additionalProperties: false },
      },
      run: async (a, signal) => {
        try {
          return await this.report(typeof a.when === 'string' ? a.when : 'today', signal);
        } catch {
          return "I couldn't get the weather just now.";
        }
      },
    };
  }
}
