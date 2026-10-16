// JSON-lines logger to stdout (journald picks it up in production).
// Callers must never pass secrets; as a safety net every line is also run
// through redact(), and the last lines are kept in memory for the dashboard.

import type { Logger } from './interfaces.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Shapes of the secrets this app handles. */
const SECRET_PATTERNS: RegExp[] = [
  /gsk_[A-Za-z0-9]{8,}/g, // Groq
  /AIza[0-9A-Za-z_-]{20,}/g, // Google
  /tvly-[A-Za-z0-9_-]{8,}/g, // Tavily
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/g, // Discord bot token
  /\$argon2id\$[^"\s]+/g,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

const RECENT_MAX = 500;
const recent: string[] = [];

/** Most recent log lines (already redacted), oldest first. */
export function recentLogLines(): readonly string[] {
  return recent;
}

export function createLogger(min: Level = 'info', out: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[min]) return;
    const line = redact(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
    recent.push(line);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    out(`${line}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
