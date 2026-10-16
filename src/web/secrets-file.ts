// The secrets file (KEY=value, mode 0600). The admin API can set, replace
// and delete values but never read them back: it only reports which names
// are configured.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readSecrets } from '../config.js';

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export class SecretsFile {
  constructor(readonly path: string) {}

  read(): Map<string, string> {
    return existsSync(this.path) ? readSecrets(this.path) : new Map();
  }

  names(): string[] {
    return [...this.read().keys()].sort();
  }

  has(name: string): boolean {
    return !!this.read().get(name);
  }

  set(name: string, value: string): void {
    if (!SECRET_NAME.test(name)) throw new Error('invalid secret name');
    const v = value.trim();
    if (!v || /[\r\n]/.test(v) || v.length > 4096) throw new Error('invalid secret value');
    const m = this.read();
    m.set(name, v);
    this.write(m);
  }

  delete(name: string): boolean {
    const m = this.read();
    const had = m.delete(name);
    if (had) this.write(m);
    return had;
  }

  private write(m: Map<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o750 });
    const body = ['# A.D.R.I.A.N. secrets. Managed by the admin UI and `adrian secret`.', ...[...m].map(([k, v]) => `${k}=${v}`), ''].join('\n');
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/** Read a JSON file or return undefined. */
export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFile(path: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  renameSync(tmp, path);
}
