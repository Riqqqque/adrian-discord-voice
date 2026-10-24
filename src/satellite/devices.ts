// Paired PC satellites. Each has an owner (a Discord user ID) and a token
// that is shown once at pairing; only its SHA-256 is kept.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../web/secrets-file.js';

export interface Device {
  id: string;
  name: string;
  /** Discord user ID: whose PC this is. */
  owner: string;
  tokenHash: string;
  createdAt: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class SatelliteDevices {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, 'satellites.json');
  }

  list(): Device[] {
    const d = readJsonFile<{ devices?: Device[] }>(this.file);
    return Array.isArray(d?.devices) ? d.devices : [];
  }

  private save(devices: Device[]): void {
    writeJsonFile(this.file, { devices });
  }

  /** Pair a new PC. The token is returned once and never stored. */
  add(name: string, owner: string): { device: Device; token: string } {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new Error('give the PC a name');
    if (!/^\d{15,22}$/.test(owner)) throw new Error('owner must be a Discord user ID (turn on Developer Mode, right-click yourself, Copy User ID)');
    const token = `sat_${randomBytes(32).toString('base64url')}`;
    const device: Device = { id: randomBytes(6).toString('hex'), name: clean, owner, tokenHash: hash(token), createdAt: new Date().toISOString() };
    this.save([...this.list(), device]);
    return { device, token };
  }

  remove(idOrName: string): boolean {
    const all = this.list();
    const keep = all.filter((d) => d.id !== idOrName && d.name.toLowerCase() !== idOrName.toLowerCase());
    if (keep.length === all.length) return false;
    this.save(keep);
    return true;
  }

  /** The device a token belongs to, compared in constant time. */
  verify(token: unknown): Device | undefined {
    if (typeof token !== 'string' || !token.startsWith('sat_') || token.length > 100) return undefined;
    const h = Buffer.from(hash(token), 'hex');
    return this.list().find((d) => {
      const stored = Buffer.from(d.tokenHash, 'hex');
      return stored.length === h.length && timingSafeEqual(stored, h);
    });
  }
}
