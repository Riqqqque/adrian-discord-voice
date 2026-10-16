import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationOrchestrator, systemPrompt } from '../src/brain/orchestrator.js';
import { OpenAiCompatibleLlm } from '../src/brain/openai-compatible.js';
import { SessionMemory } from '../src/brain/sessions.js';
import { SentenceSplitter, toSpeakable } from '../src/brain/speech-text.js';
import { timeTool } from '../src/brain/tools.js';

// --- mock OpenAI-compatible server --------------------------------------

type Script = (body: any, n: number) => { status?: number; chunks?: unknown[]; delayMs?: number };
let script: Script = () => ({ chunks: [] });
const requests: any[] = [];
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const s = script(body, requests.length);
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      if (s.status && s.status !== 200) {
        res.writeHead(s.status).end('{"error":{"message":"rate limited"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of s.chunks ?? []) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

const text = (t: string) => ({ choices: [{ index: 0, delta: { content: t } }] });
const usage = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } };
const opts = {
  spokenName: 'Adrian',
  writtenName: 'A.D.R.I.A.N.',
  timezone: 'America/Denver',
  firstEventTimeoutMs: 1_000,
  maxTokens: 200,
  maxToolRounds: 2,
};
const make = (memory = new SessionMemory()) =>
  new ConversationOrchestrator(new OpenAiCompatibleLlm({ baseUrl, model: 'mock' }), memory, [timeTool('America/Denver')], opts);
const collect = async (g: AsyncGenerator<string>) => {
  const out: string[] = [];
  for await (const s of g) out.push(s);
  return out;
};

// --- tests ---------------------------------------------------------------

describe('sentence splitter', () => {
  const early = { firstChunkMinChars: 8, maxChunkChars: 220, firstChunkMaxChars: 16 };

  it('speaks whole sentences by default', () => {
    const s = new SentenceSplitter();
    const out = [...s.push('The capital of Australia is Canberra, not Sydney. Many people get that wrong. '), ...s.push('Want another'), ...s.flush()];
    expect(out).toEqual(['The capital of Australia is Canberra, not Sydney.', 'Many people get that wrong.', 'Want another']);
  });

  it('early-start mode: a short first clause, then whole sentences', () => {
    const s = new SentenceSplitter(early);
    const out = [
      ...s.push('The capital of Australia is Canberra, '),
      ...s.push('not Sydney. Many people get that wrong. '),
      ...s.push('Want another'),
      ...s.flush(),
    ];
    expect(out).toEqual(['The capital of Australia is Canberra,', 'not Sydney.', 'Many people get that wrong.', 'Want another']);
  });

  it('early-start mode cuts a long unpunctuated opening at a word', () => {
    const s = new SentenceSplitter(early);
    const out = s.push('Well the forecast for tomorrow looks mostly sunny and warm ');
    expect(out).toEqual(['Well the forecast']);
  });

  it('does not split decimals, abbreviations or initials', () => {
    const s = new SentenceSplitter({ firstChunkMinChars: 1000, maxChunkChars: 1000 });
    const out = [...s.push('It costs 3.5 dollars at Dr. Smith in the U.S. today. Bye. '), ...s.flush()];
    expect(out).toEqual(['It costs 3.5 dollars at Dr. Smith in the U.S. today.', 'Bye.']);
  });

  it('keeps A.D.R.I.A.N. in one piece', () => {
    const s = new SentenceSplitter({ firstChunkMinChars: 1000, maxChunkChars: 1000 });
    expect([...s.push('I am A.D.R.I.A.N. and I can help. '), ...s.flush()]).toEqual(['I am A.D.R.I.A.N. and I can help.']);
  });
});

describe('toSpeakable', () => {
  it('strips markdown and links and says the name as a word', () => {
    expect(toSpeakable('**Sure!** I\'m A.D.R.I.A.N. See [the docs](http://x.y) or https://a.b/c')).toBe(
      "Sure! I'm Adrian See the docs or a link",
    );
    expect(toSpeakable('- one\n- two')).toBe('one two');
    // A chunk boundary inside **bold** leaves an unmatched marker per side.
    expect(toSpeakable('it is **seventy')).toBe('it is seventy');
    expect(toSpeakable('two** degrees')).toBe('two degrees');
  });
});

describe('session memory', () => {
  it('keeps users separate and forgets after idle time', () => {
    let now = 0;
    const m = new SessionMemory(4, 1_000, () => now);
    m.append('a', { role: 'user', content: 'secret A' });
    m.append('b', { role: 'user', content: 'secret B' });
    expect(m.history('a').map((t) => t.content)).toEqual(['secret A']);
    expect(m.history('b').map((t) => t.content)).toEqual(['secret B']);
    now = 2_000;
    expect(m.history('a')).toEqual([]);
  });

  it('caps the number of turns', () => {
    const m = new SessionMemory(2);
    for (const c of ['1', '2', '3']) m.append('a', { role: 'user', content: c });
    expect(m.history('a').map((t) => t.content)).toEqual(['2', '3']);
  });
});

describe('system prompt', () => {
  const o = { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'UTC', firstEventTimeoutMs: 1, maxTokens: 1, maxToolRounds: 1 };
  it('only mentions tools that exist', () => {
    const none = systemPrompt(o, 'R', 'today');
    expect(none).not.toMatch(/web_search|get_time/);
    expect(none).toMatch(/can't look those up/);
    const both = systemPrompt(o, 'R', 'today', ['get_time', 'web_search']);
    expect(both).toMatch(/always call web_search/);
    expect(both).toMatch(/get_time/);
  });
});

describe('orchestrator', () => {
  it('streams speakable chunks and reports usage', async () => {
    requests.length = 0;
    script = () => ({ chunks: [text('Sure, it is **seventy two** degrees '), text('right now. Anything else?'), usage] });
    let u: any;
    const out = await collect(make().ask('u1', 'Sean', 'how warm is it', new AbortController().signal, (x) => (u = x)));
    expect(out.join(' ')).toBe('Sure, it is seventy two degrees right now. Anything else?');
    expect(u).toMatchObject({ inputTokens: 100, cachedTokens: 40, outputTokens: 20, toolCalls: 0 });
    expect(requests[0].stream).toBe(true);
    expect(requests[0].messages.filter((m: { role: string }) => m.role === 'system').map((m: { content: string }) => m.content).join(' ')).toContain('Sean');
  });

  it('runs a tool call round and feeds the result back as untrusted data', async () => {
    requests.length = 0;
    script = (_b, n) =>
      n === 1
        ? {
            chunks: [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'c1',
                          function: { name: 'get_time', arguments: '{}' },
                          extra_content: { google: { thought_signature: 'sig123' } },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          }
        : { chunks: [text('It is noon.')] };
    const out = await collect(make().ask('u1', 'Sean', 'what time is it', new AbortController().signal));
    expect(out).toEqual(['It is noon.']);
    const toolMsg = requests[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('c1');
    expect(toolMsg.content).toMatch(/untrusted data/);
    // Gemini 3 needs the thought signature echoed back with the call.
    const asst = requests[1].messages.find((m: any) => m.role === 'assistant');
    expect(asst.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'sig123' } });
    expect(requests[0].tools?.[0]?.function?.name).toBe('get_time');
  });

  it('never leaks one user context into another user request', async () => {
    requests.length = 0;
    const memory = new SessionMemory();
    const o = make(memory);
    script = () => ({ chunks: [text('Nice to meet you, Bob.')] });
    await collect(o.ask('alice', 'Alice', 'my secret word is pineapple', new AbortController().signal));
    script = () => ({ chunks: [text('I do not know your secret word.')] });
    await collect(o.ask('bob', 'Bob', 'what is my secret word', new AbortController().signal));
    const bobRequest = JSON.stringify(requests[1]);
    expect(bobRequest).not.toContain('pineapple');
    expect(bobRequest).not.toContain('Alice');
    // Alice's own follow-up does see her context.
    script = () => ({ chunks: [text('Pineapple.')] });
    await collect(o.ask('alice', 'Alice', 'what was it', new AbortController().signal));
    expect(JSON.stringify(requests[2])).toContain('pineapple');
  });

  it('retries once on a transient error before speaking', async () => {
    requests.length = 0;
    script = (_b, n) => (n === 1 ? { status: 429 } : { chunks: [text('Back now.')] });
    const out = await collect(make().ask('u1', 'R', 'hi', new AbortController().signal));
    expect(out).toEqual(['Back now.']);
    expect(requests.length).toBe(2);
  });

  it('gives up when the model does not respond in time', async () => {
    script = () => ({ delayMs: 1_500, chunks: [text('late')] });
    await expect(collect(make().ask('u1', 'R', 'hi', new AbortController().signal))).rejects.toThrow(/in time/);
  });

  it('stops when cancelled', async () => {
    script = () => ({ chunks: [text('One. '), text('Two. '), text('Three.')] });
    const ctl = new AbortController();
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const s of make().ask('u1', 'R', 'count', ctl.signal)) {
          got.push(s);
          ctl.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(got).toEqual(['One.']);
  });
});

describe('creator identity', () => {
  const o = { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'UTC', firstEventTimeoutMs: 8000, maxTokens: 200, maxToolRounds: 2 };
  it('tells the model who made it and how ASR spells the name', () => {
    const p = systemPrompt({ ...o, creator: { name: 'Sean', spoken: 'Shawn', heardAs: ['Shaun', 'Shon'] } }, 'Sam', 'today');
    expect(p).toContain('created and built by Sean');
    expect(p).toContain('who made, created, built');
    expect(p).toContain('Shaun, Shon');
    expect(systemPrompt(o, 'Sam', 'today')).not.toContain('created and built by');
  });

  it('says the creator name the way it is pronounced', () => {
    expect(toSpeakable('I was made by Sean.', 'A.D.R.I.A.N.', 'Adrian', [['Sean', 'Shawn']])).toBe('I was made by Shawn.');
    expect(toSpeakable("Sean's bot", 'A.D.R.I.A.N.', 'Adrian', [['Sean', 'Shawn']])).toBe("Shawn's bot");
    expect(toSpeakable('Enrique Iglesias', 'A.D.R.I.A.N.', 'Adrian', [['Sean', 'Shawn']])).toBe('Enrique Iglesias');
  });
});

describe('sentence splitter, Chinese and Japanese', () => {
  it('splits at 。！？ without spaces', () => {
    const s = new SentenceSplitter();
    expect([...s.push('今天天气很好。明天会下雨！'), ...s.flush()]).toEqual(['今天天气很好。', '明天会下雨！']);
    const j = new SentenceSplitter();
    expect([...j.push('こんにちは。 きょうは はれです。'), ...j.flush()]).toEqual(['こんにちは。', 'きょうは はれです。']);
  });
});

describe('cut-off answers', () => {
  it('marks a stopped answer so the topic is dropped', () => {
    const m = new SessionMemory();
    m.append('a', { role: 'user', content: 'tell me about the roman empire' });
    m.append('a', { role: 'assistant', content: 'So the Roman Empire started' });
    m.markCutOff('a');
    expect(m.history('a').at(-1)!.content).toContain('Cut off here');
    m.append('b', { role: 'user', content: 'long story' });
    m.markCutOff('b'); // stopped before saying anything
    expect(m.history('b').at(-1)).toEqual({ role: 'assistant', content: expect.stringContaining('Cut off here') });
  });
});
