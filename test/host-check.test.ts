import { describe, expect, it } from 'vitest';
import { hostAllowed } from '../src/web/server.js';

describe('admin UI host check (DNS rebinding)', () => {
  it('answers to IPs, localhost and allowed names only', () => {
    expect(hostAllowed('127.0.0.1:8790', [])).toBe(true);
    expect(hostAllowed('localhost:8790', [])).toBe(true);
    expect(hostAllowed('[::1]:8790', [])).toBe(true);
    expect(hostAllowed('192.168.1.20:8790', [])).toBe(true);
    expect(hostAllowed('evil.example.com:8790', [])).toBe(false);
    expect(hostAllowed('homeserver.local:8790', [])).toBe(false);
    expect(hostAllowed('HomeServer.local:8790', ['homeserver.local'])).toBe(true);
    expect(hostAllowed(undefined, [])).toBe(false);
  });
});
