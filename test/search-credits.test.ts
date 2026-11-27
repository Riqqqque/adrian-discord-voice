import { afterEach, describe, expect, it, vi } from 'vitest';
import { tavilySearchTool } from '../src/brain/tools.js';
import { onCall } from '../src/core/calls.js';

afterEach(() => {
  onCall(undefined);
  vi.unstubAllGlobals();
});

describe('web_search', () => {
  it('asks for an advanced search and counts it as the two credits it costs; a failed one once', async () => {
    const seen: number[] = [];
    onCall((service, status) => service === 'tavily' && seen.push(status));
    const bodies: any[] = [];
    let status = 200;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ results: [{ title: '2 Much (Live from Paris)', content: 'Key: A; bpm: 120' }] }), { status });
    });
    const tool = tavilySearchTool('tvly-test-key-000000');
    const out = await tool.run({ query: 'justin bieber 2 much live from paris key' }, AbortSignal.timeout(2000), { userId: 'u', speaker: 'Sam' });
    expect(out).toContain('Key: A');
    expect(bodies[0]).toMatchObject({ search_depth: 'advanced', include_answer: false });
    expect(seen).toEqual([200, 200]);
    status = 432;
    expect(await tool.run({ query: 'x' }, AbortSignal.timeout(2000), { userId: 'u', speaker: 'Sam' })).toBe('Search failed (HTTP 432).');
    expect(seen).toEqual([200, 200, 432]);
  });
});
