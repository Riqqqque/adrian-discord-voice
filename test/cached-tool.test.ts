import { describe, expect, it } from 'vitest';
import { cachedTool } from '../src/brain/tools.js';
import type { Tool } from '../src/core/interfaces.js';

describe('cached read-only tools', () => {
  it('reuses an answer for the same arguments until it expires; failures are not kept', async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const base: Tool = {
      spec: { name: 'game_server_status', description: '', parameters: { type: 'object', properties: {} } },
      run: async (a) => {
        calls++;
        if (fail) throw new Error('down');
        return `status ${JSON.stringify(a)} #${calls}`;
      },
    };
    const t = cachedTool(base, 30_000, () => now);
    const sig = AbortSignal.timeout(1000);
    const ctx = { userId: 'u', speaker: 'Sean' };
    expect(await t.run({}, sig, ctx)).toBe('status {} #1');
    now += 10_000;
    expect(await t.run({}, sig, ctx)).toBe('status {} #1'); // reused
    expect(await t.run({ name: 'atm' }, sig, ctx)).toBe('status {"name":"atm"} #2'); // other arguments
    now += 25_000;
    expect(await t.run({}, sig, ctx)).toBe('status {} #3'); // expired
    now += 40_000;
    fail = true;
    await expect(t.run({}, sig, ctx)).rejects.toThrow('down');
    fail = false;
    expect(await t.run({}, sig, ctx)).toBe('status {} #5'); // the failure wasn't cached
  });
});
