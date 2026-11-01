// Drives the real startVoiceStack with fake Discord, listening, satellite server
// and HTTP. Nothing here touches the network or an audio device.
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVoiceStack } from '../src/app/stack.js';
import { PocConfigSchema } from '../src/config.js';
import { MusicPlayer } from '../src/features/music.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';

const h = vi.hoisted(() => {
  /** Takes audio at once, like a player that never falls behind. */
  const play = (stream: NodeJS.ReadableStream) => {
    let stop!: () => void;
    const done = new Promise<string>((r) => {
      stop = () => r('stopped');
      stream.on('data', () => {});
      stream.once('end', () => r('finished'));
      stream.once('close', () => r('finished'));
    });
    return { done, stop };
  };
  return { play, pipes: [] as any[], transport: undefined as any, sat: undefined as any, conns: [] as unknown[] };
});

// Music looks for ffmpeg at startup; nothing here decodes anything.
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawnSync: () => ({ status: 0 }) }));
vi.mock('../src/listen/pipeline.js', async () => {
  const { EventEmitter } = await import('node:events');
  class ListeningPipeline extends EventEmitter {
    constructor() {
      super();
      h.pipes.push(this);
    }
  }
  return { ListeningPipeline };
});
vi.mock('../src/transport/discord.js', async () => {
  const { EventEmitter } = await import('node:events');
  class DiscordVoiceTransport extends EventEmitter {
    constructor() {
      super();
      h.transport = this;
    }
    playPcm = h.play;
    async connect() {}
    async disconnect() {}
  }
  return { DiscordVoiceTransport };
});
vi.mock('../src/satellite/server.js', () => ({
  startSatelliteServer: (o: unknown) => {
    h.sat = o;
    return { connections: () => h.conns, close: async () => {} };
  },
}));

const GUILD = '100000000000000010';
const CALL = '100000000000000020';
const OWNER = '100000000000000030';
const SAM = '100000000000000040';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => unknown, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

const text = (s: string) => ({ choices: [{ delta: { content: s } }] });
const usage = (i: number, o: number) => ({ choices: [], usage: { prompt_tokens: i, completion_tokens: o } });
const toolCall = (name: string, args = '{}') => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name, arguments: args } }] } }] });

function sse(parts: unknown[], hang: boolean, signal?: AbortSignal, lingerMs = 0) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(`data: ${JSON.stringify(p)}\n\n`));
        if (hang) signal?.addEventListener('abort', () => setTimeout(() => c.error(new DOMException('aborted', 'AbortError')), lingerMs), { once: true });
        else {
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        }
      },
    }),
    { status: 200 },
  );
}

function fakeConn(owner: string) {
  const c = Object.assign(new EventEmitter(), {
    device: { id: 'd1', name: 'Desk', owner },
    owner,
    lastSeen: Date.now(),
    /** The socket is gone: isReady goes false, as it does on the real connection. */
    open: true,
    isReady: () => c.open,
    transcripts: [] as string[],
    actions: [] as string[],
    /** Holds PC actions until the test lets go. Like the real ones, they ignore a stop. */
    hold: undefined as Promise<void> | undefined,
    mode() {},
    state() {},
    send() {},
    transcript(who: string, t: string) {
      c.transcripts.push(`${who}: ${t}`);
    },
    async action(name: string) {
      c.actions.push(name);
      await c.hold;
      return { ok: true, result: 'CPU 12%.' };
    },
    playPcm: h.play,
  });
  return c;
}

async function rig(over: Record<string, unknown> = {}) {
  h.pipes.length = 0;
  h.conns = [];
  const dir = mkdtempSync(join(tmpdir(), 'stack-'));
  const config = PocConfigSchema.parse({
    guildId: GUILD,
    channelId: CALL,
    secretsFile: join(dir, 'secrets.env'),
    listen: { vadModel: 'x', asrModelDir: dir },
    voice: { modelDir: dir },
    brain: { provider: 'openai', baseUrl: 'http://llm.test/v1', model: 'fake', apiKeySecret: 'LLM_API_KEY', priceInPerM: 1, priceOutPerM: 5, totalTimeoutMs: 5000, firstEventTimeoutMs: 3000, search: {} },
    music: { enabled: false },
    languages: false,
    autoMemory: false,
    serverInfo: { enabled: false },
    textChat: { enabled: false },
    satellite: { enabled: true, port: 40000, unfinishedWaitMs: 0 },
    limits: { perUserPerHour: 0, dailyUsd: 0, monthlyUsd: 0 },
    ...over,
  });
  const steps: { parts: unknown[]; hang?: boolean; lingerMs?: number }[] = [];
  const llmBodies: any[] = [];
  const groq = { calls: 0, done: 0, delay: 0, reply: '' };
  const search = { calls: 0 };
  vi.stubGlobal('fetch', async (url: unknown, init: any) => {
    const u = String(url);
    if (u.includes('applications/@me')) return new Response('{}', { status: 401 });
    if (u.includes('api.tavily.com')) {
      search.calls++;
      return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true }));
    }
    if (u.includes('audio/transcriptions')) {
      groq.calls++;
      await sleep(groq.delay);
      groq.done++;
      return new Response(JSON.stringify({ text: groq.reply }), { status: 200 });
    }
    if (u.endsWith('/chat/completions')) {
      llmBodies.push(JSON.parse(init.body));
      const s = steps.shift() ?? { parts: [text('Okay.'), usage(10, 2)] };
      return sse(s.parts, !!s.hang, init.signal, s.lingerMs);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  const tts = {
    calls: [] as string[],
    /** Stoppable: synthesis waits for the stop and rejects, like the cloud voice. */
    mode: 'plain' as 'plain' | 'stoppable',
    gainFor: async () => 0,
    async synthesize(t: string, _o: unknown, signal?: AbortSignal) {
      tts.calls.push(t);
      if (tts.mode === 'stoppable') await new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('cancelled')), { once: true }));
      return { samples: new Float32Array(960).fill(0.1), sampleRate: 48_000, synthMs: 1 };
    },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const ledger = new UsageLedger(undefined, { perUserPerHour: 0, dailyUsd: 0, monthlyUsd: 0 }, 'UTC');
  let client: any;
  vi.spyOn(Client.prototype, 'login').mockImplementation(async function (this: unknown) {
    client = this;
    return 'x';
  });
  const secrets = new Map([['DISCORD_TOKEN', 'x'], ['LLM_API_KEY', 'y'], ['GROQ_API_KEY', 'z'], ['TAVILY_API_KEY', 'w']]);
  const stack = await startVoiceStack(config as never, secrets, log as never, ledger, { sttFor: async () => ({}) as never, ttsFor: () => tts as never }, dir);
  client.users.fetch = async () => ({});
  const voiceStates = new Map<string, unknown>();
  client.guilds.cache.set(GUILD, { voiceStates: { cache: voiceStates }, members: { cache: new Map() } });
  h.transport.emit('ready');
  const heard = (pipe: EventEmitter, userId: string, t: string, command?: string, audioSeconds = 1) =>
    pipe.emit('heard', { userId, text: t, woke: command !== undefined, command: command ?? '', samples: new Float32Array(16_000), audioSeconds, levelDbfs: -20, sttLatencyMs: 10, segmentClosedAt: performance.now(), decodeMs: 5 });
  const connect = () => {
    const conn = fakeConn(OWNER);
    h.conns = [conn];
    h.sat.onConnect(conn);
    return { conn, pipe: h.pipes[h.pipes.length - 1] as EventEmitter };
  };
  return { stack, ledger, steps, llmBodies, groq, search, tts, transport: h.transport as EventEmitter, discordPipe: h.pipes[0] as EventEmitter, heard, connect, voiceStates };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('what an answer costs', () => {
  it('charges a finished answer at the configured prices', async () => {
    const r = await rig();
    r.steps.push({ parts: [text('Canberra.'), usage(1000, 100)] });
    r.heard(r.discordPipe, SAM, 'hey adrian capital of australia', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the answer');
    expect(r.ledger.todayUsd()).toBeCloseTo((1000 * 1 + 100 * 5) / 1e6, 8);
    expect(r.stack.answers()[0]!.costUsd).toBeCloseTo(0.0015, 6);
    await r.stack.stop();
  });

  it('over the daily cap: no model call, and one notice', async () => {
    const r = await rig({ limits: { perUserPerHour: 0, dailyUsd: 0.01, monthlyUsd: 0 } });
    r.ledger.addCost(1);
    r.heard(r.discordPipe, SAM, 'hey adrian one', 'first question');
    await until(() => r.stack.answers().length === 1, 'the notice');
    r.heard(r.discordPipe, SAM, 'hey adrian two', 'second question');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(0);
    expect(r.tts.calls).toHaveLength(1);
    await r.stack.stop();
  });

  it('a stop during a search sends no further model call, and the round that ran is charged', async () => {
    const r = await rig();
    r.steps.push({ parts: [toolCall('web_search', '{"query":"weather"}'), usage(1000, 100)] });
    r.heard(r.discordPipe, SAM, 'hey adrian weather', 'what is the weather');
    await until(() => r.search.calls === 1, 'the search');
    r.heard(r.discordPipe, SAM, 'stop');
    await until(() => r.stack.answers().length === 1, 'the answer');
    expect(r.llmBodies).toHaveLength(1);
    expect(r.ledger.todayUsd()).toBeCloseTo(0.0015, 8);
    await r.stack.stop();
  });

  it('a stream stopped partway counts an estimate, since usage never arrives', async () => {
    const r = await rig();
    r.steps.push({ parts: [text('First sentence here. Second')], hang: true });
    r.heard(r.discordPipe, SAM, 'hey adrian story', 'tell a story');
    await until(() => r.tts.calls.length >= 1, 'speech');
    await sleep(30);
    r.heard(r.discordPipe, SAM, 'stop');
    await until(() => r.stack.answers().length === 1, 'the answer');
    expect(r.stack.answers()[0]).toMatchObject({ outcome: 'interrupted' });
    expect(r.stack.answers()[0]!.costUsd).toBeGreaterThan(0);
    expect(r.ledger.todayUsd()).toBeGreaterThan(0);
    await r.stack.stop();
  });

  it('a stop during a PC action: the round is charged, the right turn is marked, and the room is free again', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    r.steps.push({ parts: [text('Canberra is the capital.'), usage(10, 2)] });
    r.heard(pipe, OWNER, 'hey adrian capital', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the first answer');
    const before = r.ledger.todayUsd();

    // Her voice is mid-sentence when the stop lands, and the PC hasn't answered.
    let release!: () => void;
    conn.hold = new Promise((res) => (release = res));
    r.tts.mode = 'stoppable';
    r.steps.push({ parts: [text('Let me look at that.'), toolCall('pc_info', '{"action":"summary"}'), usage(1000, 100)] });
    r.heard(pipe, OWNER, 'hey adrian pc status', 'how is my pc doing');
    await until(() => conn.actions.length === 1 && r.tts.calls.length === 2, 'the action');
    r.heard(pipe, OWNER, 'stop');
    await until(() => r.stack.answers().length === 2, 'the stopped answer');
    expect(r.ledger.todayUsd() - before).toBeCloseTo(0.0015, 8);

    r.tts.mode = 'plain';
    r.heard(pipe, OWNER, 'hey adrian next', 'what about new zealand');
    await until(() => r.llmBodies.length === 3, 'the next request'); // with the action still out
    release();
    const said = r.llmBodies[2].messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content);
    expect(said[0]).toBe('Canberra is the capital.');
    expect(said[1]).toContain('Let me look at that.');
    expect(said[1]).toContain('Cut off here');
    await r.stack.stop();
  });

  it('waits for the model to let go before counting, so nothing lands on the turn before', async () => {
    const r = await rig();
    r.steps.push({ parts: [text('Canberra is the capital.'), usage(10, 2)] });
    r.heard(r.discordPipe, SAM, 'hey adrian capital', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the first answer');
    const before = r.ledger.todayUsd();

    // Her voice stops at once; the model's request takes a moment longer to end.
    r.tts.mode = 'stoppable';
    r.steps.push({ parts: [text('A long story begins here. And')], hang: true, lingerMs: 40 });
    r.heard(r.discordPipe, SAM, 'hey adrian story', 'tell me a story');
    await until(() => r.tts.calls.length === 2, 'speech');
    r.heard(r.discordPipe, SAM, 'stop');
    await until(() => r.stack.answers().length === 2, 'the stopped answer');
    expect(r.ledger.todayUsd()).toBeGreaterThan(before);
    expect(r.stack.answers()[1]!.costUsd).toBeGreaterThan(0);

    r.tts.mode = 'plain';
    r.heard(r.discordPipe, SAM, 'hey adrian next', 'what about new zealand');
    await until(() => r.llmBodies.length === 3, 'the next request');
    const said = r.llmBodies[2].messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content);
    expect(said[0]).toBe('Canberra is the capital.');
    expect(said[1]).toContain('A long story begins here.');
    expect(said[1]).toContain('Cut off here');
    await r.stack.stop();
  });

  it("a stop after she judged it wasn't for her leaves the answer before unmarked", async () => {
    const r = await rig();
    r.steps.push({ parts: [text('Canberra is the capital.'), usage(10, 2)] });
    r.heard(r.discordPipe, SAM, 'hey adrian capital', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the first answer');
    await sleep(20);
    r.steps.push({ parts: [text('SILENT')], hang: true });
    r.heard(r.discordPipe, SAM, 'grab the diamonds');
    await until(() => r.llmBodies.length === 2, 'the follow-up');
    await sleep(30);
    r.heard(r.discordPipe, SAM, 'stop');
    await until(() => r.stack.answers().length === 2, 'the stopped follow-up');
    r.heard(r.discordPipe, SAM, 'hey adrian next', 'what about new zealand');
    await until(() => r.llmBodies.length === 3, 'the next request');
    expect(r.llmBodies[2].messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content)).toEqual(['Canberra is the capital.']);
    await r.stack.stop();
  });

  it('a stopped over-the-cap notice marks nothing', async () => {
    const r = await rig({ limits: { perUserPerHour: 0, dailyUsd: 0.01, monthlyUsd: 0 } });
    r.steps.push({ parts: [text('Canberra is the capital.'), usage(10, 2)] });
    r.heard(r.discordPipe, SAM, 'hey adrian capital', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the first answer');
    r.ledger.addCost(1);
    r.tts.mode = 'stoppable';
    r.heard(r.discordPipe, SAM, 'hey adrian next', 'what about spain');
    await until(() => r.tts.calls.length === 2, 'the notice');
    r.heard(r.discordPipe, SAM, 'stop');
    await until(() => r.stack.answers().length === 2, 'the notice to end');
    r.tts.mode = 'plain';
    r.ledger.setLimits({ perUserPerHour: 0, dailyUsd: 0, monthlyUsd: 0 });
    r.heard(r.discordPipe, SAM, 'hey adrian next', 'what about new zealand');
    await until(() => r.llmBodies.length === 2, 'the next request');
    expect(r.llmBodies[1].messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content)).toEqual(['Canberra is the capital.']);
    await r.stack.stop();
  });
});

describe('a request at the PC', () => {
  const ask = (r: Awaited<ReturnType<typeof rig>>, pipe: EventEmitter) => r.heard(pipe, OWNER, 'hey adrian open spotify', 'open spotify');
  const DEFERRED = 'her: Answering in the Discord call.';

  it('goes to her Discord call when the voice link is up and they can be heard there', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    ask(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain(DEFERRED);
    await r.stack.stop();
  });

  it.each([
    ['muted', { mute: true, deaf: false }],
    ['deafened', { mute: false, deaf: true }],
  ])('stays at the PC when they are %s in the call', async (_how, state) => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, ...state });
    const { pipe } = r.connect();
    ask(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });

  it.each(['disconnected', 'failed', 'kicked'])('stays at the PC when the voice link is %s, even with them in the channel', async (event) => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.transport.emit(event, 'dropped');
    expect(r.stack.voiceReady()).toBe(false);
    ask(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(conn.transcripts).not.toContain(DEFERRED);
    await r.stack.stop();
  });

  it('push-to-talk with the wake word stays at the PC, and uses the press up', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    ask(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(conn.transcripts).not.toContain(DEFERRED);
    await until(() => r.stack.answers().length === 1, 'the answer');
    r.heard(pipe, OWNER, 'dude that was so funny');
    await sleep(100);
    expect(r.llmBodies).toHaveLength(1);
    await r.stack.stop();
  });

  it('the call hears the same words but leaves them to the PC: one answer, whichever hears them first', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    r.heard(r.discordPipe, OWNER, 'hey adrian open spotify', 'open spotify'); // the call first
    ask(r, pipe);
    await until(() => r.stack.answers().length === 1, 'the answer');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(1);
    expect(conn.transcripts).toContain('her: Okay.');

    conn.emit('ptt');
    ask(r, pipe); // the PC first
    await sleep(10);
    r.heard(r.discordPipe, OWNER, 'hey adrian open spotify', 'open spotify');
    await until(() => r.stack.answers().length === 2, 'the second answer');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(2);
    await r.stack.stop();
  });

  it('after a short while the call takes their words again', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    ask(r, pipe);
    await until(() => r.stack.answers().length === 1, 'the answer');
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + 4_000);
    r.heard(r.discordPipe, OWNER, 'hey adrian what about spain', 'what about spain');
    await until(() => r.llmBodies.length === 2, 'the call to answer');
    await r.stack.stop();
  });

  it('push-to-talk without the wake word stays at the PC too', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'open spotify');
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });
});

describe('speech waiting on the cloud listen', () => {
  const cloud = { cloudStt: { enabled: true, rooms: 'all' } };

  it('a stop wins over the question it overtook', async () => {
    const r = await rig(cloud);
    r.groq.delay = 80;
    r.groq.reply = 'Hey Adrian, tell me a long story';
    r.heard(r.discordPipe, SAM, 'hey adrian tell me a long story', 'tell me a long story');
    await until(() => r.groq.calls === 1, 'the cloud listen');
    r.heard(r.discordPipe, SAM, 'stop');
    await until(() => r.groq.done === 1, 'the cloud reply');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it("the PC's stop button wins too", async () => {
    const r = await rig(cloud);
    const { conn, pipe } = r.connect();
    r.groq.delay = 80;
    r.groq.reply = 'Hey Adrian, tell me a long story';
    r.heard(pipe, OWNER, 'hey adrian tell me a long story', 'tell me a long story');
    await until(() => r.groq.calls === 1, 'the cloud listen');
    conn.emit('stop');
    await until(() => r.groq.done === 1, 'the cloud reply');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it("someone else's stop doesn't drop it, and the cloud's words are what she answers", async () => {
    const r = await rig(cloud);
    r.groq.delay = 40;
    r.groq.reply = 'Hey Adrian, tell me a long story';
    r.heard(r.discordPipe, SAM, 'hey adrian tell me a song story', 'tell me a song story');
    await until(() => r.groq.calls === 1, 'the cloud listen');
    r.heard(r.discordPipe, OWNER, 'stop');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(r.llmBodies[0].messages.at(-1).content).toContain('tell me a long story');
    await r.stack.stop();
  });

  it('a stop said before the question leaves the question alone', async () => {
    const r = await rig(cloud);
    r.groq.reply = 'Hey Adrian, what time is it in Tokyo';
    r.heard(r.discordPipe, SAM, 'stop');
    r.heard(r.discordPipe, SAM, 'hey adrian what is the weather', 'what is the weather');
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });

  it('speech not meant for her never reaches the cloud', async () => {
    const r = await rig(cloud);
    r.heard(r.discordPipe, SAM, 'random side talk about dinner');
    await sleep(60);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });
});

describe('a stop, wherever it lands', () => {
  it('reaches the answer in the call while the PC has their words', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn } = r.connect();
    r.tts.mode = 'stoppable';
    r.steps.push({ parts: [text('A long story begins here. And')], hang: true });
    r.heard(r.discordPipe, OWNER, 'hey adrian story', 'tell me a story');
    await until(() => r.tts.calls.length === 1, 'speech in the call');
    conn.emit('ptt');
    r.heard(r.discordPipe, OWNER, 'stop');
    await until(() => r.stack.answers().length === 1, 'the stopped answer');
    expect(r.stack.answers()[0]).toMatchObject({ outcome: 'interrupted' });
    await r.stack.stop();
  });

  it('reaches the answer at the PC while they are in her call', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.tts.mode = 'stoppable';
    r.steps.push({ parts: [text('A long story begins here. And')], hang: true });
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'tell me a story');
    await until(() => r.tts.calls.length === 1, 'speech at the PC');
    r.heard(pipe, OWNER, 'stop');
    await until(() => r.stack.answers().length === 1, 'the stopped answer');
    expect(r.stack.answers()[0]).toMatchObject({ outcome: 'interrupted' });
    await r.stack.stop();
  });

  it('at the PC, it still drops a question waiting on the cloud listen', async () => {
    const r = await rig({ cloudStt: { enabled: true, rooms: 'all' } });
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.groq.delay = 80;
    r.groq.reply = 'tell me a long story';
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'tell me a long story');
    await until(() => r.groq.calls === 1, 'the cloud listen');
    r.heard(pipe, OWNER, 'stop');
    await until(() => r.groq.done === 1, 'the cloud reply');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it('anything else said at the PC still goes to the call', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.tts.mode = 'stoppable';
    r.steps.push({ parts: [text('A long story begins here. And')], hang: true });
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'tell me a story');
    await until(() => r.tts.calls.length === 1, 'speech at the PC');
    r.heard(pipe, OWNER, 'hey adrian make it a good one', 'make it a good one');
    await sleep(60);
    expect(r.stack.answers()).toHaveLength(0);
    expect(conn.transcripts).toContain('her: Answering in the Discord call.');
    r.heard(pipe, OWNER, 'stop');
    await until(() => r.stack.answers().length === 1, 'the stopped answer');
    await r.stack.stop();
  });
});

describe('a PC that went away', () => {
  it('speech landing after the socket closed starts nothing in the dead room', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    conn.open = false;
    conn.emit('closed');
    r.heard(pipe, OWNER, 'hey adrian tell me a story', 'tell me a story');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it('nor does a question that was waiting on the cloud listen when it closed', async () => {
    const r = await rig({ cloudStt: { enabled: true, rooms: 'all' } });
    const { conn, pipe } = r.connect();
    r.groq.delay = 60;
    r.groq.reply = 'Hey Adrian, tell me a story';
    r.heard(pipe, OWNER, 'hey adrian tell me a story', 'tell me a story');
    await until(() => r.groq.calls === 1, 'the cloud listen');
    conn.open = false;
    conn.emit('closed');
    await until(() => r.groq.done === 1, 'the cloud reply');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });
});

describe('the listening window on a live call', () => {
  /** After an answer, move the clock past the 8 s follow-up window. */
  async function pastTheWindow(r: Awaited<ReturnType<typeof rig>>) {
    r.steps.push({ parts: [text('Canberra.'), usage(10, 2)] });
    r.heard(r.discordPipe, SAM, 'hey adrian capital', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the first answer');
    await sleep(20);
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + 8_500);
  }

  it('words begun inside it count, though they land after it closed', async () => {
    const r = await rig();
    await pastTheWindow(r);
    r.heard(r.discordPipe, SAM, 'and what about new zealand', undefined, 2.5);
    await until(() => r.llmBodies.length === 2, 'the follow-up');
    await r.stack.stop();
  });

  it('words begun after it closed do not', async () => {
    const r = await rig();
    await pastTheWindow(r);
    r.heard(r.discordPipe, SAM, 'and what about new zealand', undefined, 0.5);
    await sleep(60);
    expect(r.llmBodies).toHaveLength(1);
    await r.stack.stop();
  });

  it('words begun inside it get the second listen too', async () => {
    const r = await rig({ cloudStt: { enabled: true, rooms: 'all' } });
    await pastTheWindow(r);
    r.groq.reply = 'And what about New Zealand?';
    r.heard(r.discordPipe, SAM, 'and what about new sealand', undefined, 2.5);
    await until(() => r.llmBodies.length === 2, 'the follow-up');
    expect(r.llmBodies[1].messages.at(-1).content).toContain('New Zealand');
    await r.stack.stop();
  });
});

describe('local music orders', () => {
  it('"skip" followed by more words skips once, however long the next song takes', async () => {
    const r = await rig({ music: { enabled: true, ffmpeg: 'ffmpeg-stub', ytdlp: process.execPath, topSongs: false } });
    let release!: (v: undefined) => void;
    const skip = vi.spyOn(MusicPlayer.prototype, 'skip').mockImplementation(() => new Promise((res) => (release = res)));
    r.heard(r.discordPipe, SAM, 'hey adrian skip this', 'skip this');
    await until(() => skip.mock.calls.length === 1, 'the skip');
    r.heard(r.discordPipe, SAM, 'please');
    await sleep(40);
    release(undefined);
    await sleep(60);
    expect(skip).toHaveBeenCalledTimes(1);
    await r.stack.stop();
  });
});
