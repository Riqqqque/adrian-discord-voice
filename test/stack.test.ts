// Drives the real startVoiceStack with fake Discord, listening, satellite server
// and HTTP. Nothing here touches the network or an audio device.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Client, Collection, Events, PermissionsBitField } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVoiceStack } from '../src/app/stack.js';
import { PocConfigSchema } from '../src/config.js';
import { MusicPlayer, YoutubeSource } from '../src/features/music.js';
import { QUIZ_BUSY } from '../src/features/quiz.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import type { TurnOptions } from '../src/listen/pipeline.js';
import { SmartTurn } from '../src/speech/smart-turn.js';
import { SpeechifyTts } from '../src/speech/speechify.js';
import { WhisperStt } from '../src/speech/whisper.js';
import { Speaker } from '../src/voice/speaker.js';
import { MODEL_LAYOUT } from '../src/web/checks.js';

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
  return { play, pipes: [] as any[], transport: undefined as any, sat: undefined as any, conns: [] as unknown[], connecting: undefined as (() => Promise<void>) | undefined };
});

// Music looks for ffmpeg at startup; nothing here decodes anything.
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawnSync: () => ({ status: 0 }) }));
vi.mock('../src/listen/pipeline.js', async (orig) => {
  const { EventEmitter } = await import('node:events');
  class ListeningPipeline extends EventEmitter {
    /** What the stack built it with: the turn options are the fifth. */
    readonly args: unknown[];
    /** Who push-to-talk cut off, in order. */
    readonly cuts: string[] = [];
    constructor(...args: unknown[]) {
      super();
      this.args = args;
      h.pipes.push(this);
    }
    cut(id: string) {
      this.cuts.push(id);
    }
  }
  return { ...(await orig<typeof import('../src/listen/pipeline.js')>()), ListeningPipeline };
});
vi.mock('../src/transport/discord.js', async () => {
  const { EventEmitter } = await import('node:events');
  class DiscordVoiceTransport extends EventEmitter {
    /** The real one reads its connection's state. */
    up = false;
    retries = 0;
    constructor() {
      super();
      h.transport = this;
      this.on('ready', () => (this.up = true));
      for (const e of ['disconnected', 'failed', 'kicked']) this.on(e, () => (this.up = false));
    }
    playPcm = h.play;
    isReady() {
      return this.up;
    }
    retry() {
      this.retries++;
    }
    async connect() {
      await h.connecting?.();
      this.up = true;
    }
    async disconnect() {
      this.up = false;
    }
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
const BOT = '100000000000000050';
const TEXT_CHANNEL = '100000000000000060';
const MUSIC = { music: { enabled: true, ffmpeg: 'ffmpeg-stub', ytdlp: process.execPath, topSongs: false } };

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

function fakeConn(owner: string, id: string) {
  const c = Object.assign(new EventEmitter(), {
    device: { id, name: 'Desk', owner },
    owner,
    lastSeen: Date.now(),
    /** The socket is gone: isReady goes false, as it does on the real connection. */
    open: true,
    isReady: () => c.open,
    transcripts: [] as string[],
    /** The soft chimes asked for (`notice`). */
    notices: [] as string[],
    /** What plays sound there (the app's `output`). */
    output: 'unknown' as string,
    actions: [] as string[],
    calls: [] as { name: string; args: Record<string, unknown> }[],
    /** Holds PC actions until the test lets go. Like the real ones, they ignore a stop. */
    hold: undefined as Promise<void> | undefined,
    /** What the PC answers (default: it worked). */
    reply: { ok: true, result: 'CPU 12%.' },
    mode() {},
    /** The `state` messages it was sent. */
    states: [] as { speaking?: boolean; listenMs?: number }[],
    state(s: { speaking?: boolean; listenMs?: number }) {
      c.states.push(s);
    },
    send() {},
    transcript(who: string, t: string) {
      c.transcripts.push(`${who}: ${t}`);
    },
    notice(kind: string) {
      c.notices.push(kind);
    },
    async action(name: string, args: Record<string, unknown>) {
      if (!c.open) return { ok: false, result: 'The PC disconnected.' };
      c.actions.push(name);
      c.calls.push({ name, args });
      await c.hold;
      return c.reply;
    },
    playPcm: h.play,
  });
  return c;
}

async function rig(over: Record<string, unknown> | ((dir: string) => Record<string, unknown>) = {}, o: { prepare?(dir: string): void; login?(client: Client): Promise<string> } = {}) {
  h.pipes.length = 0;
  h.conns = [];
  h.connecting = undefined;
  const dir = mkdtempSync(join(tmpdir(), 'stack-'));
  o.prepare?.(dir);
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
    ...(typeof over === 'function' ? over(dir) : over),
  });
  const steps: { parts: unknown[]; hang?: boolean; lingerMs?: number }[] = [];
  const llmBodies: any[] = [];
  const groq = { calls: 0, done: 0, aborted: 0, delay: 0, reply: '', status: 200 };
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
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, groq.delay);
        init.signal?.addEventListener('abort', () => (clearTimeout(t), groq.aborted++, rej(new DOMException('aborted', 'AbortError'))), { once: true });
      });
      groq.done++;
      if (groq.status !== 200) return new Response('{}', { status: groq.status });
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
  const warned: string[] = [];
  const logged: { m: string; f: any }[] = [];
  const log = { debug() {}, info: (m: string, f?: unknown) => void logged.push({ m, f }), warn: (m: string) => void warned.push(m), error() {} };
  const ledger = new UsageLedger(undefined, { perUserPerHour: 0, dailyUsd: 0, monthlyUsd: 0 }, 'UTC');
  let client: any;
  vi.spyOn(Client.prototype, 'login').mockImplementation(async function (this: unknown) {
    client = this;
    return o.login ? o.login(this as Client) : 'x';
  });
  const secrets = new Map([['DISCORD_TOKEN', 'x'], ['LLM_API_KEY', 'y'], ['GROQ_API_KEY', 'z'], ['TAVILY_API_KEY', 'w'], ['SPEECHIFY_API_KEY', 'v']]);
  const stack = await startVoiceStack(config as never, secrets, log as never, ledger, { sttFor: async () => ({}) as never, ttsFor: () => tts as never }, dir);
  client.users.fetch = async () => ({});
  client.user = { id: BOT, tag: 'bot#0' };
  const dms = { sent: [] as string[], tries: 0, fail: false };
  client.users.send = async (_id: string, t: string) => {
    dms.tries++;
    if (dms.fail) throw new Error('DMs closed');
    dms.sent.push(t);
    return {};
  };
  const voiceStates = new Map<string, unknown>();
  client.guilds.cache.set(GUILD, { voiceStates: { cache: voiceStates }, members: { cache: new Map() } });
  h.transport.emit('ready');
  const heard = (pipe: EventEmitter, userId: string, t: string, command?: string, audioSeconds = 1, more: Record<string, unknown> = {}) =>
    pipe.emit('heard', { userId, text: t, woke: command !== undefined, command: command ?? '', samples: new Float32Array(16_000), audioSeconds, levelDbfs: -20, sttLatencyMs: 10, segmentClosedAt: performance.now(), decodeMs: 5, ...more });
  const connect = (owner = OWNER, id = 'd1') => {
    const conn = fakeConn(owner, id);
    h.conns.push(conn);
    h.sat.onConnect(conn);
    return { conn, pipe: h.pipes[h.pipes.length - 1] as EventEmitter };
  };
  /** The gateway's ready event: joins the call and starts the timers. */
  const loggedIn = () => client.emit(Events.ClientReady, client);
  /** What she wrote back in text chat. */
  const replies: string[] = [];
  /** A message reaching the text chat. No guild: a DM. */
  const typed = (userId: string, content: string, guildId?: string) =>
    client.emit('messageCreate', {
      author: { id: userId, bot: false, username: 'someone' },
      system: false,
      content,
      embeds: [],
      guildId: guildId ?? null,
      guild: null,
      channelId: guildId ? TEXT_CHANNEL : `dm-${userId}`,
      channel: { type: guildId ? ChannelType.GuildText : ChannelType.DM },
      mentions: { users: new Collection(guildId ? [[BOT, {}]] : []), roles: new Collection(), everyone: false },
      reply: async (r: { content?: string }) => (replies.push(String(r?.content ?? '')), {}),
    });
  return { replies, stack, client, ledger, steps, llmBodies, groq, search, tts, transport: h.transport as EventEmitter, discordPipe: h.pipes[0] as EventEmitter, heard, connect, voiceStates, loggedIn, typed, dms, dir, warned, logged };
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

  it("a guest past their own share of the day hears why, and nobody else is held back", async () => {
    const r = await rig({ owners: [OWNER], limits: { perUserPerHour: 0, dailyUsd: 1, monthlyUsd: 0, guestDailyUsd: 0.001 } });
    r.steps.push({ parts: [text('Canberra.'), usage(1000, 100)] }); // $0.0015
    r.heard(r.discordPipe, SAM, 'hey adrian capital of australia', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the answer');
    expect(r.ledger.userTodayUsd(SAM)).toBeCloseTo(0.0015, 6);
    r.heard(r.discordPipe, SAM, 'hey adrian capital of peru', 'capital of peru');
    await until(() => r.stack.answers().length === 2, 'the notice');
    expect(r.llmBodies).toHaveLength(1);
    expect(r.tts.calls).toContain("You've used your share of today's budget, so I'm pausing your questions until tomorrow.");
    r.steps.push({ parts: [text('Lima.'), usage(1000, 100)] });
    r.heard(r.discordPipe, OWNER, 'hey adrian capital of peru', 'capital of peru');
    await until(() => r.llmBodies.length === 2, 'the owner answered');
    await r.stack.stop();
  });

  it.each(['a creator account', 'a priority-role member'])("%s isn't a guest: no share of their own", async (who) => {
    const CREATOR = '100000000000000070';
    const ROLE = '100000000000000080';
    const r = await rig({ owners: [OWNER], identity: { creator: 'Rique', creatorIds: [CREATOR] }, priorityRoleIds: [ROLE], limits: { perUserPerHour: 0, dailyUsd: 1, monthlyUsd: 0, guestDailyUsd: 0.001 } });
    const id = who === 'a creator account' ? CREATOR : SAM;
    // Seen in voice or chat: discord.js keeps the member, Members intent or not.
    const members = r.client.guilds.cache.get(GUILD).members.cache as Map<string, unknown>;
    const member = (roles: [string, { id: string }][]) => members.set(SAM, { roles: { cache: new Collection(roles) } });
    member([[ROLE, { id: ROLE }]]);
    r.ledger.addCost(0.01, id);
    r.heard(r.discordPipe, id, 'hey adrian capital of peru', 'capital of peru');
    await until(() => r.llmBodies.length === 1, 'the model');
    await until(() => r.stack.answers().length === 1, 'the answer');
    if (id === SAM) {
      // Without the role: a guest again.
      member([]);
      r.heard(r.discordPipe, SAM, 'hey adrian capital of chile', 'capital of chile');
      await until(() => r.tts.calls.some((t) => t.includes('share of today')), 'the notice');
      expect(r.llmBodies).toHaveLength(1);
    }
    await r.stack.stop();
  });

  it('in text chat too: a guest is charged for their answers, and past their share gets the reason, not the model', async () => {
    const r = await rig({ owners: [OWNER], textChat: { enabled: true, dms: true }, limits: { perUserPerHour: 0, dailyUsd: 1, monthlyUsd: 0, guestDailyUsd: 0.001 } });
    r.steps.push({ parts: [text('Canberra.'), usage(1000, 100)] }); // $0.0015
    r.typed(SAM, 'capital of australia?');
    await until(() => r.ledger.userTodayUsd(SAM) > 0, 'the charge');
    expect(r.ledger.userTodayUsd(SAM)).toBeCloseTo(0.0015, 6);
    await sleep(30); // the reply lets go of the person
    r.typed(SAM, 'capital of peru?');
    await until(() => r.replies.some((x) => x.includes('share of today')), 'the refusal');
    expect(r.llmBodies).toHaveLength(1);
    r.typed(OWNER, 'capital of peru?');
    await until(() => r.llmBodies.length === 2, 'the owner answered');
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
    // Time for her "SILENT" to land first: a stop before it is a stop of an
    // answer she might still have given (30 ms wasn't enough on a busy server).
    await sleep(250);
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

const OTHER_GUILD = '100000000000000011';
const OTHER_CALL = '100000000000000099';
/** What the PC window says when its speakers may be playing her call. */
const CALL_PLAYS_HERE = 'her: Your Discord call plays on this PC, so here I only take push-to-talk.';

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
    ['deafened', { channelId: CALL, mute: false, deaf: true }],
    ['muted and deafened', { channelId: CALL, mute: true, deaf: true }],
    ['deafened in another channel', { channelId: OTHER_CALL, mute: false, deaf: true }],
  ])('stays at the PC when they are %s', async (_how, state) => {
    const r = await rig();
    r.voiceStates.set(OWNER, state);
    const { pipe } = r.connect();
    ask(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });

  it('in another voice channel, its speakers play that call: only push-to-talk counts', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: OTHER_CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    ask(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    conn.emit('ptt');
    ask(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });

  it("in a voice channel of another server she's in, the same", async () => {
    const r = await rig();
    r.client.guilds.cache.set(OTHER_GUILD, { voiceStates: { cache: new Map([[OWNER, { channelId: OTHER_CALL, mute: true, deaf: false }]]) }, members: { cache: new Map() } });
    const { conn, pipe } = r.connect();
    ask(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    await r.stack.stop();
  });

  it('kicked or dragged out of her call by someone, the call still plays there: only push-to-talk counts', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.transport.emit('kicked', 'dropped');
    ask(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    await r.stack.stop();
  });

  it('moved to another channel, the one they stay in still counts', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.transport.emit('moved', GUILD, OTHER_CALL);
    ask(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    await r.stack.stop();
  });

  it('with her voice link down, any channel they are in still counts (disconnecting her, then moving them, lifts nothing)', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: OTHER_CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.transport.emit('disconnected', 'dropped');
    expect(r.stack.voiceReady()).toBe(false);
    ask(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    conn.emit('ptt');
    ask(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });

  it.each(['disconnected', 'failed'])('with the voice link %s and them still in her channel, their speakers play the call: only push-to-talk counts', async (event) => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.transport.emit(event, 'dropped');
    expect(r.stack.voiceReady()).toBe(false);
    ask(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    conn.emit('ptt');
    ask(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
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

describe('a PC whose owner is muted in her call', () => {
  // Their speakers play the call, so the PC mic hears everyone in it, and
  // everything a PC hears counts as its owner. Only push-to-talk and typing are surely them.
  const MUTED = { channelId: CALL, mute: true, deaf: false };
  const lock = (r: Awaited<ReturnType<typeof rig>>, pipe: EventEmitter) => r.heard(pipe, OWNER, 'hey adrian lock my pc', 'lock my pc');

  it('takes nothing it hears without push-to-talk, and says why on her name', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    r.steps.push({ parts: [toolCall('pc_system', '{"action":"lock"}'), usage(10, 2)] });
    lock(r, pipe);
    r.heard(pipe, OWNER, 'adrian tell me a joke', 'tell me a joke');
    await sleep(120);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.actions).toHaveLength(0);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    expect(r.logged.some((l) => l.m === 'pc heard')).toBe(false);
    await r.stack.stop();
  });

  it('push-to-talk and typing still count', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    lock(r, pipe);
    await until(() => r.stack.answers().length === 1, 'the answer');
    conn.emit('text', 'tell me a joke');
    await until(() => r.llmBodies.length === 2, 'the typed question');
    await r.stack.stop();
  });

  it('the follow-up after a push-to-talk answer needs push-to-talk too', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    r.steps.push({ parts: [text('Sure, which one?'), usage(10, 2)] });
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'open a game');
    await until(() => r.stack.answers().length === 1, 'the answer');
    r.heard(pipe, OWNER, 'the one with the dragons');
    await sleep(100);
    expect(r.llmBodies).toHaveLength(1);
    await r.stack.stop();
  });

  it('nothing it hears goes to the cloud listen', async () => {
    const r = await rig({ cloudStt: { enabled: true, rooms: 'all' } });
    r.voiceStates.set(OWNER, MUTED);
    const { pipe } = r.connect();
    r.groq.reply = 'Hey Adrian, lock my PC';
    const early = (pipe as unknown as { args: ({ onWords(u: string, w: unknown): void } | undefined)[] }).args[5]!;
    early.onWords(OWNER, { text: 'hey adrian lock my pc', samples: new Float32Array(16_000), startedAt: performance.now() - 1000, signal: new AbortController().signal });
    lock(r, pipe);
    await sleep(100);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });

  it('a stop still stops music playing at the PC', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    vi.spyOn(MusicPlayer.prototype, 'nowPlaying', 'get').mockReturnValue(TRACK as never);
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    r.heard(pipe, OWNER, 'hey adrian stop', 'stop');
    await until(() => r.logged.some((l) => l.m === 'music stopped' && l.f.room === 'sat:d1'), 'the music to stop');
    expect(m.stop).toHaveBeenCalled();
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.notices).toEqual([]); // it was taken: nothing to explain
    await r.stack.stop();
  });

  it('her name plays a soft chime at the PC, at most every 20 s', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    lock(r, pipe);
    r.heard(pipe, OWNER, 'adrian tell me a joke', 'tell me a joke');
    await sleep(60);
    expect(conn.notices).toEqual(['ptt_only']);
    r.heard(pipe, OWNER, 'so adrian said that', undefined); // no name heard: nothing
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + 21_000);
    lock(r, pipe);
    await sleep(60);
    expect(conn.notices).toEqual(['ptt_only', 'ptt_only']);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it('the orb never says she listens without her name there', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'open a game');
    await until(() => r.stack.answers().length === 1, 'the answer');
    await sleep(20);
    expect(conn.states.filter((s) => s.listenMs !== undefined).map((s) => s.listenMs)).toEqual(expect.arrayContaining([0]));
    expect(conn.states.every((s) => !s.listenMs)).toBe(true);
    await r.stack.stop();
  });

  it('voices over her answer at the PC do not cut it off; a stop still does', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    r.steps.push({ parts: [text('A long story begins here. And')], hang: true });
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'tell me a story');
    await until(() => r.tts.calls.length === 1, 'speech at the PC');
    await sleep(20);
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + 2_000);
    pipe.emit('voiceActivity', OWNER, 1_500);
    await sleep(60);
    expect(r.stack.answers()).toHaveLength(0);
    r.heard(pipe, OWNER, 'stop');
    await until(() => r.stack.answers().length === 1, 'the stopped answer');
    expect(r.stack.answers()[0]).toMatchObject({ outcome: 'interrupted' });
    await r.stack.stop();
  });
});

describe('push-to-talk held down (apps from 0.17.2)', () => {
  const MUTED = { channelId: CALL, mute: true, deaf: false };
  const cuts = (pipe: EventEmitter) => (pipe as unknown as { cuts: string[] }).cuts;

  it('takes everything said until the key goes up as one request, pauses and all', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    r.steps.push({ parts: [], hang: true });
    conn.emit('ptt', { hold: true });
    r.heard(pipe, OWNER, 'open the mod page');
    await until(() => r.llmBodies.length === 1, 'the first half');
    r.heard(pipe, OWNER, 'for jei on modrinth');
    await until(() => r.llmBodies.length === 2, 'both halves');
    const asked = JSON.stringify(r.llmBodies[1].messages.at(-1).content);
    expect(asked).toContain('open the mod page');
    expect(asked).toContain('for jei on modrinth');
    conn.emit('pttUp');
    await r.stack.stop();
  });

  it('said again in the same hold after her answer, it is a new request, not a follow-up to judge', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    conn.emit('ptt', { hold: true });
    r.heard(pipe, OWNER, 'open spotify');
    await until(() => r.stack.answers().length === 1, 'the answer');
    await sleep(20);
    r.heard(pipe, OWNER, 'and turn it up');
    await until(() => r.llmBodies.length === 2, 'the second request');
    expect(asPrompt(r.llmBodies[1])).not.toContain(JUDGE_LINE);
    expect(JSON.stringify(r.llmBodies[1].messages.at(-1).content)).toContain('and turn it up');
    conn.emit('pttUp');
    await r.stack.stop();
  });

  it('a PC that drops mid-press leaves her call free to take their words', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn } = r.connect();
    conn.emit('ptt', { hold: true });
    conn.open = false;
    conn.emit('closed');
    r.heard(r.discordPipe, OWNER, 'hey adrian open spotify', 'open spotify');
    await until(() => r.llmBodies.length === 1, 'the call to answer');
    await r.stack.stop();
  });

  it('the press and the release each cut what is being heard there', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    conn.emit('ptt', { hold: true });
    expect(cuts(pipe)).toEqual([OWNER]);
    conn.emit('pttUp');
    expect(cuts(pipe)).toHaveLength(1); // the last words are still on their way
    await until(() => cuts(pipe).length === 2, 'the release cut');
    await r.stack.stop();
  });

  it('a tap takes nothing said after it', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    conn.emit('ptt', { hold: true });
    conn.emit('pttUp');
    await until(() => cuts(pipe).length === 2, 'the release cut');
    r.heard(pipe, OWNER, 'lock my pc'); // someone in the call
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.actions).toHaveLength(0);
    await r.stack.stop();
  });

  it('speech that was already going when the key went down is not theirs', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    const before = performance.now();
    await sleep(5);
    conn.emit('ptt', { hold: true });
    // Closed by the press's cut: it began before the key went down.
    r.heard(pipe, OWNER, 'lock my pc', undefined, 5, { vadClosedAt: before });
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    r.heard(pipe, OWNER, 'tell me a joke');
    await until(() => r.llmBodies.length === 1, 'the words said with the key');
    expect(JSON.stringify(r.llmBodies[0].messages.at(-1).content)).not.toContain('lock my pc');
    await r.stack.stop();
  });

  it('the words said with the key stay with the PC: her call leaves its copy alone', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.emit('ptt', { hold: true });
    await sleep(20);
    r.heard(r.discordPipe, OWNER, 'hey adrian open spotify', 'open spotify'); // the call first
    r.heard(pipe, OWNER, 'hey adrian open spotify', 'open spotify');
    await until(() => r.stack.answers().length === 1, 'the answer');
    await sleep(60);
    expect(r.llmBodies).toHaveLength(1);
    await r.stack.stop();
  });
});

describe('a PC on headphones', () => {
  const MUTED = { channelId: CALL, mute: true, deaf: false };
  const lock = (r: Awaited<ReturnType<typeof rig>>, pipe: EventEmitter) => r.heard(pipe, OWNER, 'hey adrian open spotify', 'open spotify');

  it('muted in her call, hands-free still works there: its mic cannot hear the call', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, MUTED);
    const { conn, pipe } = r.connect();
    conn.output = 'headphones';
    lock(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(conn.transcripts).not.toContain(CALL_PLAYS_HERE);
    await r.stack.stop();
  });

  it('heard in her call itself, nothing goes to the cloud listen at the PC: the call runs its own', async () => {
    const r = await rig({ cloudStt: { enabled: true, rooms: 'all' } });
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.output = 'headphones';
    const early = (pipe as unknown as { args: ({ onWords(u: string, w: unknown): void } | undefined)[] }).args[5]!;
    early.onWords(OWNER, { text: 'hey adrian open spotify', samples: new Float32Array(16_000), startedAt: performance.now() - 1000, signal: new AbortController().signal });
    lock(r, pipe);
    await sleep(100);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });

  it('heard in her call itself, the call still answers', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.output = 'headphones';
    lock(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(0);
    expect(conn.transcripts).toContain('her: Answering in the Discord call.');
    await r.stack.stop();
  });

  it('switched to speakers, push-to-talk only again', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: OTHER_CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    conn.output = 'headphones';
    lock(r, pipe);
    await until(() => r.llmBodies.length === 1, 'the model');
    await until(() => r.stack.answers().length === 1, 'the answer');
    conn.output = 'speakers';
    conn.emit('output', 'speakers');
    expect(conn.states.at(-1)).toEqual({ listenMs: 0 });
    lock(r, pipe);
    await sleep(100);
    expect(r.llmBodies).toHaveLength(1);
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

type Rig = Awaited<ReturnType<typeof rig>>;
const SILENT = { parts: [text('SILENT'), usage(10, 2)] };
const TRACK = { title: 'Song', artist: 'Someone', ref: 'x', source: 'youtube' };
const JUDGE_LINE = 'without using your name';
const asPrompt = (body: any) => JSON.stringify(body.messages);
/** Moves the wall clock on. Before the rig: the clocks are taken when it starts. */
function clockAhead() {
  const real = Date.now.bind(Date);
  let ahead = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => real() + ahead);
  return (ms: number) => (ahead = ms);
}
/** Nothing the music player does may run for real here. */
function fakeMusic() {
  return {
    play: vi.spyOn(MusicPlayer.prototype, 'playNamed').mockResolvedValue({ ok: true } as never),
    request: vi.spyOn(MusicPlayer.prototype, 'request').mockResolvedValue({ ok: true, added: 1, started: TRACK } as never),
    skip: vi.spyOn(MusicPlayer.prototype, 'skip').mockResolvedValue(undefined),
    pause: vi.spyOn(MusicPlayer.prototype, 'pause').mockReturnValue(true),
    resume: vi.spyOn(MusicPlayer.prototype, 'resume').mockReturnValue(false),
    stop: vi.spyOn(MusicPlayer.prototype, 'stop').mockReturnValue(true),
    nudge: vi.spyOn(MusicPlayer.prototype, 'nudgeVolume').mockReturnValue(0.5),
  };
}
/** An answer from the model, which leaves her listening without her name. */
async function answered(r: Rig, who = SAM, pipe = r.discordPipe, say = 'Canberra.') {
  const n = r.stack.answers().length;
  r.steps.push({ parts: [text(say), usage(10, 2)] });
  r.heard(pipe, who, 'hey adrian capital', 'capital of australia');
  await until(() => r.stack.answers().length > n, 'the answer');
  await sleep(20);
}
/** Said with her name, then until she has said `line`. */
async function order(r: Rig, pipe: EventEmitter, who: string, words: string, line: string) {
  const n = r.tts.calls.length;
  r.heard(pipe, who, `hey adrian ${words}`, words);
  await until(() => r.tts.calls.length > n, line);
  expect(r.tts.calls.at(-1)).toBe(line);
  await sleep(20);
}

describe('a follow-up said without her name', () => {
  it.each(['next', 'skip', 'pause', 'resume', 'play the objective', 'turn it up', 'louder', 'slower', 'say that again', 'what time is it'])('"%s" goes to the judge, who can leave it alone', async (words) => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    vi.spyOn(MusicPlayer.prototype, 'nowPlaying', 'get').mockReturnValue(TRACK as never);
    await answered(r);
    r.steps.push(SILENT);
    r.heard(r.discordPipe, SAM, words);
    await until(() => r.llmBodies.length === 2, 'the judge');
    expect(asPrompt(r.llmBodies[1])).toContain(JUDGE_LINE);
    await sleep(40);
    for (const s of Object.values(m)) expect(s).not.toHaveBeenCalled();
    expect(r.tts.calls).toEqual(['Canberra.']);
    await r.stack.stop();
  });

  it('"Yeah." to a question from her tool goes straight through: no judge, and the order runs', async () => {
    const r = await rig();
    const { conn } = r.connect();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    r.steps.push({ parts: [toolCall('pc_system', '{"action":"restart"}'), usage(10, 2)] });
    r.heard(r.discordPipe, OWNER, 'hey adrian restart the pc', 'restart the pc');
    await until(() => r.stack.answers().length === 1, 'the question');
    expect(r.tts.calls).toEqual(['Restart the PC?']);
    expect(conn.actions).toHaveLength(0);

    r.steps.push({ parts: [toolCall('pc_system', '{"action":"restart"}'), usage(10, 2)] });
    r.heard(r.discordPipe, OWNER, 'Yeah.');
    await until(() => conn.actions.length === 1, 'the restart');
    expect(asPrompt(r.llmBodies[1])).not.toContain(JUDGE_LINE);
    await r.stack.stop();
  });

  it('what she does decide is for her still happens', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await answered(r);
    r.steps.push({ parts: [toolCall('music_control', '{"action":"skip"}'), usage(10, 2)] });
    r.voiceStates.set(SAM, { channelId: CALL, mute: false, deaf: false });
    r.heard(r.discordPipe, SAM, 'next');
    await until(() => m.skip.mock.calls.length === 1, 'the skip');
    await r.stack.stop();
  });

  it('tells the judge a music order may be just that, without taking the choice away', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await answered(r);
    r.steps.push({ parts: [toolCall('play_music', '{"request_type":"song","query":"get lucky"}'), usage(10, 2)] });
    r.voiceStates.set(SAM, { channelId: CALL, mute: false, deaf: false });
    r.heard(r.discordPipe, SAM, 'play get lucky');
    await until(() => m.request.mock.calls.length === 1, 'the song');
    expect(asPrompt(r.llmBodies[1])).toContain(JUDGE_LINE);
    expect(asPrompt(r.llmBodies[1])).toContain('order for your music');
    await r.stack.stop();
  });

  it('what the judge leaves alone stays out of the log: it may never have been for her', async () => {
    const r = await rig(MUSIC);
    fakeMusic();
    await answered(r);
    r.steps.push(SILENT);
    r.heard(r.discordPipe, SAM, 'play the objective');
    await until(() => r.stack.answers().length === 2, 'the judge');
    expect(r.warned).not.toContain('music asked but not played');
    await r.stack.stop();
  });

  it('a request to her that played nothing is logged, to see why', async () => {
    const r = await rig(MUSIC);
    fakeMusic();
    r.steps.push({ parts: [text('Sure, something chill coming up.'), usage(10, 2)] });
    r.heard(r.discordPipe, SAM, 'hey adrian play something chill', 'play something chill');
    await until(() => r.stack.answers().length === 1, 'the answer');
    expect(r.warned).toContain('music asked but not played');
    await r.stack.stop();
  });

  it('says nothing to the judge about music for other words', async () => {
    const r = await rig(MUSIC);
    fakeMusic();
    await answered(r);
    r.steps.push(SILENT);
    r.heard(r.discordPipe, SAM, 'grab the diamonds');
    await until(() => r.llmBodies.length === 2, 'the judge');
    expect(asPrompt(r.llmBodies[1])).not.toContain('order for your music');
    await r.stack.stop();
  });

  it.each([
    ['okay', 0],
    ['thanks', 1],
    ['bye', 1],
  ])('"%s" changes nothing, so it costs no model call', async (words, spoken) => {
    const r = await rig(MUSIC);
    await answered(r);
    r.heard(r.discordPipe, SAM, words);
    await sleep(60);
    expect(r.llmBodies).toHaveLength(1);
    expect(r.tts.calls).toHaveLength(1 + spoken);
    await r.stack.stop();
  });

  it('but "yeah" after a question from her is the answer', async () => {
    const r = await rig(MUSIC);
    await answered(r, SAM, r.discordPipe, 'Want the long version?');
    r.heard(r.discordPipe, SAM, 'yeah');
    await until(() => r.llmBodies.length === 2, 'the model');
    await r.stack.stop();
  });

  it('after "Yes?" the words are an order: they go straight through', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    r.heard(r.discordPipe, SAM, 'hey adrian', '');
    await until(() => r.tts.calls.includes('Yes?'), 'her answer');
    await sleep(20);
    r.heard(r.discordPipe, SAM, 'next');
    await until(() => m.skip.mock.calls.length === 1, 'the skip');
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });
});

describe('phrases answered without the model', () => {
  it('with her name, a music order needs no model', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    r.heard(r.discordPipe, SAM, 'hey adrian skip', 'skip');
    await until(() => m.skip.mock.calls.length === 1, 'the skip');
    await sleep(20);
    r.heard(r.discordPipe, SAM, 'hey adrian play get lucky', 'play get lucky');
    await until(() => m.play.mock.calls.length === 1, 'the song');
    expect(m.play.mock.calls[0]!.slice(0, 2)).toEqual(['get lucky', 'now']);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it('at a PC with none of her music on, "pause" means what the PC is playing', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    const { pipe } = r.connect();
    r.heard(pipe, OWNER, 'hey adrian pause', 'pause');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(m.pause).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it('at a PC with her music on, it means hers', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    vi.spyOn(MusicPlayer.prototype, 'nowPlaying', 'get').mockReturnValue(TRACK as never);
    const { pipe } = r.connect();
    r.heard(pipe, OWNER, 'hey adrian pause', 'pause');
    await until(() => m.pause.mock.calls.length === 1, 'the pause');
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it('with music on, "turn it up" is the music, unless it is about her voice', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    vi.spyOn(MusicPlayer.prototype, 'nowPlaying', 'get').mockReturnValue(TRACK as never);
    r.heard(r.discordPipe, SAM, 'hey adrian turn it up', 'turn it up');
    await until(() => m.nudge.mock.calls.length === 1, 'the music');
    await sleep(20);
    expect(r.tts.calls).toEqual([]);
    await order(r, r.discordPipe, SAM, 'talk louder', 'Okay, louder.');
    expect(m.nudge).toHaveBeenCalledTimes(1);
    await r.stack.stop();
  });

  it('volume and speed stop at their limits', async () => {
    const r = await rig();
    const p = r.discordPipe;
    await order(r, p, SAM, 'louder', 'Okay, louder.');
    await order(r, p, SAM, 'louder', 'Okay, louder.');
    await order(r, p, SAM, 'louder', "That's as loud as I go.");
    for (let i = 0; i < 5; i++) await order(r, p, SAM, 'quieter', 'Okay, quieter.');
    await order(r, p, SAM, 'quieter', "That's as quiet as I go.");
    await order(r, p, SAM, 'slower', 'Okay, a bit slower.');
    await order(r, p, SAM, 'slower', 'Okay, a bit slower.');
    await order(r, p, SAM, 'slower', "That's my limit.");
    for (let i = 0; i < 5; i++) await order(r, p, SAM, 'faster', 'Okay, a bit faster.');
    await order(r, p, SAM, 'faster', "That's my limit.");
    await r.stack.stop();
  }, 20_000);

  it('over the hourly limit, "play" says so and searches for nothing', async () => {
    const r = await rig({ ...MUSIC, limits: { perUserPerHour: 1, dailyUsd: 0, monthlyUsd: 0 } });
    const m = fakeMusic();
    r.ledger.noteRequest(SAM);
    r.heard(r.discordPipe, SAM, 'hey adrian play get lucky', 'play get lucky');
    await until(() => r.tts.calls.length === 1, 'her answer');
    expect(r.tts.calls[0]).toContain('asked for a lot');
    expect(m.play).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it('a music level is said back, and with nothing playing she says it is for the next song', async () => {
    const r = await rig(MUSIC);
    const set = vi.spyOn(MusicPlayer.prototype, 'setVolume');
    await order(r, r.discordPipe, SAM, 'set the volume to 30', 'Music volume set to 30 percent for the next song.');
    expect(set).toHaveBeenLastCalledWith(0.3);
    vi.spyOn(MusicPlayer.prototype, 'nowPlaying', 'get').mockReturnValue(TRACK as never);
    await order(r, r.discordPipe, SAM, 'set the volume to 40', 'Music volume 40 percent.');
    await r.stack.stop();
  });

  it('while a quiz has the music, its controls go to the quiz and the rest waits', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    const back = vi.spyOn(MusicPlayer.prototype, 'back');
    const lent = { reason: QUIZ_BUSY, stop: vi.fn(), skip: vi.fn() };
    vi.spyOn(MusicPlayer.prototype, 'lent', 'get').mockReturnValue(lent);
    const voice = r.tts.calls.length;
    // "Turn it down" is the clip, not her voice.
    r.heard(r.discordPipe, SAM, 'hey adrian turn it down', 'turn it down');
    await until(() => m.nudge.mock.calls.length === 1, 'the music');
    await sleep(20);
    expect(r.tts.calls).toHaveLength(voice);
    await order(r, r.discordPipe, SAM, 'go back', QUIZ_BUSY);
    await order(r, r.discordPipe, SAM, 'who put this on', QUIZ_BUSY);
    await order(r, r.discordPipe, SAM, 'pause', QUIZ_BUSY);
    expect(back).not.toHaveBeenCalled();
    expect(m.pause).not.toHaveBeenCalled();
    r.heard(r.discordPipe, SAM, 'hey adrian skip', 'skip');
    await until(() => lent.skip.mock.calls.length === 1, 'the skip');
    await sleep(20);
    expect(m.skip).not.toHaveBeenCalled();
    expect(r.tts.calls.at(-1)).toBe(QUIZ_BUSY);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });
});

describe('a pause after "play"', () => {
  const QUESTION = 'Who do you want to hear?';
  async function asked(r: Rig, pipe = r.discordPipe, who = SAM) {
    r.heard(pipe, who, 'hey adrian play', 'play');
    await until(() => r.tts.calls.includes(QUESTION), 'her question');
    await sleep(20);
  }

  it('asks who, and the next words finish the order without the model', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await asked(r);
    r.heard(r.discordPipe, SAM, 'Ella Langley');
    await until(() => m.play.mock.calls.length === 1, 'the song');
    expect(m.play.mock.calls[0]!.slice(0, 2)).toEqual(['Ella Langley', 'now']);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it('just carries on if the music was paused', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    m.resume.mockReturnValue(true);
    r.heard(r.discordPipe, SAM, 'hey adrian play', 'play');
    await until(() => m.resume.mock.calls.length === 1, 'the music');
    await sleep(40);
    expect(r.tts.calls).toEqual([]);
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });

  it('a new order with her name is its own order, even inside the wait', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await asked(r);
    r.heard(r.discordPipe, SAM, 'never mind');
    await sleep(40);
    r.heard(r.discordPipe, SAM, 'hey adrian play drake', 'play drake');
    await until(() => m.play.mock.calls.length === 1, 'the song');
    expect(m.play.mock.calls[0]![0]).toBe('drake');
    await r.stack.stop();
  });

  it('words with her name are not the answer to the question', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await asked(r);
    r.heard(r.discordPipe, SAM, 'hey adrian tell me a joke', 'tell me a joke');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(r.llmBodies[0].messages.at(-1).content).toBe('tell me a joke');
    expect(asPrompt(r.llmBodies[0])).not.toContain(JUDGE_LINE);
    expect(m.play).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it('a question inside the wait stays a question, and still gets judged', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await asked(r);
    r.steps.push(SILENT);
    r.heard(r.discordPipe, SAM, 'who is that');
    await until(() => r.llmBodies.length === 1, 'the judge');
    expect(asPrompt(r.llmBodies[0])).toContain(JUDGE_LINE);
    expect(r.llmBodies[0].messages.at(-1).content).toBe('who is that');
    expect(m.play).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it('"play" alone in a follow-up is for the judge, not a reason to ask', async () => {
    const r = await rig(MUSIC);
    fakeMusic();
    await answered(r);
    r.steps.push(SILENT);
    r.heard(r.discordPipe, SAM, 'play');
    await until(() => r.llmBodies.length === 2, 'the judge');
    await sleep(40);
    expect(r.tts.calls).not.toContain(QUESTION);
    await r.stack.stop();
  });

  it('belongs to the room it was asked in', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await answered(r);
    const { pipe } = r.connect(SAM);
    await asked(r, pipe);
    r.steps.push(SILENT);
    r.heard(r.discordPipe, SAM, 'Ella Langley');
    await until(() => r.llmBodies.length === 2, 'the judge');
    await sleep(40);
    expect(m.play).not.toHaveBeenCalled();
    await r.stack.stop();
  });
});

describe('her voice, room by room', () => {
  const opts = (s: { mock: { calls: unknown[][] } }) => s.mock.calls.at(-1)![1] as { volume: number; speed: number };

  it('"talk quieter" at a PC leaves the call as it was', async () => {
    const r = await rig();
    const { pipe } = r.connect();
    const speak = vi.spyOn(Speaker.prototype, 'speak');
    await order(r, pipe, OWNER, 'talk quieter', 'Okay, quieter.');
    const pc = opts(speak).volume;
    r.heard(r.discordPipe, SAM, 'hey adrian what time is it', 'what time is it');
    await until(() => speak.mock.calls.length === 2, 'the call');
    expect(pc).toBeCloseTo(0.52);
    expect(opts(speak).volume).toBe(0.7);
    await r.stack.stop();
  });

  it('nor does the call change a PC', async () => {
    const r = await rig();
    const { pipe } = r.connect();
    const speak = vi.spyOn(Speaker.prototype, 'speak');
    await order(r, r.discordPipe, SAM, 'talk faster', 'Okay, a bit faster.');
    expect(opts(speak).speed).toBeCloseTo(1.1);
    r.heard(pipe, OWNER, 'hey adrian what time is it', 'what time is it');
    await until(() => speak.mock.calls.length === 2, 'the PC');
    expect(opts(speak).speed).toBe(1);
    await r.stack.stop();
  });

  it("each room's answers keep its own settings", async () => {
    const r = await rig();
    const { pipe } = r.connect();
    await order(r, pipe, OWNER, 'talk slower', 'Okay, a bit slower.');
    const speak = vi.spyOn(Speaker.prototype, 'speak');
    await answered(r, OWNER, pipe);
    expect(opts(speak).speed).toBeCloseTo(0.9);
    await answered(r);
    expect(opts(speak).speed).toBe(1);
    await r.stack.stop();
  });
});

describe("a room's music is for the people in it", () => {
  const TEXT = { textChat: { enabled: true, dms: true } };
  const OUT = 'Only people in the voice call';
  const here = { channelId: CALL, mute: false, deaf: false };
  const stopIt = (r: Rig) => r.steps.push({ parts: [toolCall('music_control', '{"action":"stop"}'), usage(10, 2)] });
  const refused = (r: Rig) => asPrompt(r.llmBodies[1]).includes(OUT);

  it('a DM from someone not in the call cannot stop it', async () => {
    const r = await rig({ ...MUSIC, ...TEXT });
    const m = fakeMusic();
    stopIt(r);
    r.typed(SAM, 'stop the music');
    await until(() => r.llmBodies.length === 2, 'the refusal');
    expect(m.stop).not.toHaveBeenCalled();
    expect(refused(r)).toBe(true);
    await r.stack.stop();
  });

  it('nor can a message in a server channel', async () => {
    const r = await rig({ ...MUSIC, ...TEXT });
    const m = fakeMusic();
    stopIt(r);
    r.typed(SAM, `<@${BOT}> stop the music`, GUILD);
    await until(() => r.llmBodies.length === 2, 'the refusal');
    expect(m.stop).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it('being in another voice channel does not count', async () => {
    const r = await rig({ ...MUSIC, ...TEXT });
    const m = fakeMusic();
    r.voiceStates.set(SAM, { ...here, channelId: 'somewhere-else' });
    stopIt(r);
    r.typed(SAM, 'stop the music');
    await until(() => r.llmBodies.length === 2, 'the refusal');
    expect(m.stop).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it('nobody but an owner is in a call she has left', async () => {
    const r = await rig({ ...MUSIC, ...TEXT });
    const m = fakeMusic();
    r.voiceStates.set(SAM, here);
    r.transport.emit('kicked');
    m.stop.mockClear();
    stopIt(r);
    r.typed(SAM, 'stop the music');
    await until(() => r.llmBodies.length === 2, 'the refusal');
    expect(m.stop).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it('it cannot start anything from outside either: no song, no sound, no lookup', async () => {
    const r = await rig({ ...MUSIC, ...TEXT });
    const m = fakeMusic();
    const look = vi.spyOn(YoutubeSource.prototype, 'soundEffect').mockResolvedValue(undefined);
    r.steps.push({ parts: [toolCall('play_music', '{"request_type":"song","query":"x"}'), usage(10, 2)] });
    r.typed(SAM, 'play something');
    await until(() => r.llmBodies.length === 2, 'the first refusal');
    await sleep(20);
    r.steps.push({ parts: [toolCall('play_sound', '{"query":"airhorn"}'), usage(10, 2)] });
    r.typed(SAM, 'airhorn please');
    await until(() => r.llmBodies.length === 4, 'the second refusal');
    expect(m.request).not.toHaveBeenCalled();
    expect(look).not.toHaveBeenCalled();
    await r.stack.stop();
  });

  it.each([
    ['in the call', here],
    ['muted in the call', { ...here, mute: true, deaf: true }],
  ])('someone %s can use it from text chat', async (_who, state) => {
    const r = await rig({ ...MUSIC, ...TEXT });
    const m = fakeMusic();
    r.voiceStates.set(SAM, state);
    stopIt(r);
    r.typed(SAM, 'stop the music');
    await until(() => m.stop.mock.calls.length === 1, 'the stop');
    await r.stack.stop();
  });

  it('an owner can from anywhere', async () => {
    const r = await rig({ ...MUSIC, ...TEXT, owners: [OWNER] });
    const m = fakeMusic();
    stopIt(r);
    r.typed(OWNER, 'stop the music');
    await until(() => m.stop.mock.calls.length === 1, 'the stop');
    await r.stack.stop();
  });

  it("anyone can still ask what's on: that changes nothing", async () => {
    const r = await rig({ ...MUSIC, ...TEXT });
    fakeMusic();
    r.steps.push({ parts: [toolCall('music_control', '{"action":"status"}'), usage(10, 2)] });
    r.typed(SAM, 'what is playing');
    await until(() => r.llmBodies.length === 2, 'the answer');
    expect(refused(r)).toBe(false);
    expect(asPrompt(r.llmBodies[1])).toContain('Nothing is playing.');
    await r.stack.stop();
  });

  it('asked out loud in the call, it just works', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    r.voiceStates.set(SAM, here);
    stopIt(r);
    r.heard(r.discordPipe, SAM, 'hey adrian shut the tunes off', 'shut the tunes off');
    await until(() => m.stop.mock.calls.length === 1, 'the stop');
    await r.stack.stop();
  });

  it("each PC and the call have their own player, and an order only reaches the asker's", async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    const mine = r.connect(OWNER, 'mine');
    const sams = r.connect(SAM, 'sams');
    const other = '100000000000000070';
    r.voiceStates.set(other, here);
    for (const [who, pipe] of [[OWNER, mine.pipe], [SAM, sams.pipe], [other, r.discordPipe]] as const) {
      const n = m.stop.mock.calls.length;
      stopIt(r);
      r.heard(pipe, who, 'hey adrian shut the tunes off', 'shut the tunes off');
      await until(() => m.stop.mock.calls.length === n + 1, 'the stop');
      await sleep(20);
    }
    expect(new Set(m.stop.mock.contexts).size).toBe(3);
    await r.stack.stop();
  });
});

describe('whose PC a tool reaches', () => {
  const info = (r: Rig) => r.steps.push({ parts: [toolCall('pc_info', '{"action":"summary"}'), usage(10, 2)] });
  const NONE = 'No PC is connected';
  const askInCall = (r: Rig, who: string) => r.heard(r.discordPipe, who, 'hey adrian how is the pc', 'how is the pc');

  it("someone in the call can't reach either of the owner's PCs", async () => {
    const r = await rig();
    const a = r.connect(OWNER, 'a');
    const b = r.connect(OWNER, 'b');
    info(r);
    askInCall(r, SAM);
    await until(() => r.llmBodies.length === 2, 'the tool answer');
    expect(a.conn.calls).toEqual([]);
    expect(b.conn.calls).toEqual([]);
    expect(asPrompt(r.llmBodies[1])).toContain(NONE);
    await r.stack.stop();
  });

  it('nor can a DM, for a lock or anything else', async () => {
    const r = await rig({ textChat: { enabled: true, dms: true } });
    const { conn } = r.connect(OWNER);
    r.steps.push({ parts: [toolCall('pc_system', '{"action":"lock"}'), usage(10, 2)] });
    r.typed(SAM, 'lock it');
    await until(() => r.llmBodies.length === 2, 'the tool answer');
    expect(conn.calls).toEqual([]);
    expect(asPrompt(r.llmBodies[1])).toContain(NONE);
    await r.stack.stop();
  });

  it("the owner reaches their own, from the call too, and someone else's PC stays out of it", async () => {
    const r = await rig();
    const mine = r.connect(OWNER, 'mine');
    const sams = r.connect(SAM, 'sams');
    info(r);
    askInCall(r, OWNER);
    await until(() => mine.conn.calls.length === 1, 'the action');
    expect(sams.conn.calls).toEqual([]);
    await r.stack.stop();
  });

  it('with two PCs, the one they are talking through wins', async () => {
    const r = await rig();
    const a = r.connect(OWNER, 'a');
    const b = r.connect(OWNER, 'b');
    a.conn.lastSeen = Date.now() - 60_000;
    info(r);
    r.heard(a.pipe, OWNER, 'hey adrian how is the pc', 'how is the pc');
    await until(() => a.conn.calls.length === 1, 'the action');
    expect(b.conn.calls).toEqual([]);
    await r.stack.stop();
  });

  it('from anywhere else, the one used last', async () => {
    const r = await rig();
    const a = r.connect(OWNER, 'a');
    const b = r.connect(OWNER, 'b');
    a.conn.lastSeen = Date.now() - 60_000;
    info(r);
    askInCall(r, OWNER);
    await until(() => b.conn.calls.length === 1, 'the action');
    expect(a.conn.calls).toEqual([]);
    b.conn.lastSeen = Date.now() - 120_000;
    await sleep(20);
    info(r);
    askInCall(r, OWNER);
    await until(() => a.conn.calls.length === 1, 'the action');
    expect(b.conn.calls).toHaveLength(1);
    await r.stack.stop();
  });
});

describe('calling off a restart', () => {
  const asked = (c: { calls: { args: Record<string, unknown> }[] }) => c.calls.filter((x) => x.args.action === 'cancel_shutdown').length;
  const CANCELLED = 'Cancelled.';
  const COULD_NOT = "I couldn't cancel it.";
  /** Asked for and confirmed: two turns, with their own yes. */
  async function restarting(r: Rig, pipe: EventEmitter, conn: { calls: unknown[] }) {
    r.steps.push({ parts: [toolCall('pc_system', '{"action":"restart"}'), usage(10, 2)] });
    r.heard(pipe, OWNER, 'hey adrian restart my pc', 'restart my pc');
    await until(() => r.tts.calls.includes('Restart the PC?'), 'the question');
    await sleep(20);
    r.steps.push({ parts: [toolCall('pc_system', '{"action":"restart"}'), usage(10, 2)] });
    r.heard(pipe, OWNER, 'yes');
    await until(() => conn.calls.length === 1, 'the restart');
    await sleep(20);
  }

  it('"cancel" inside the 30 seconds reaches the PC, once, and she says so', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    r.heard(pipe, OWNER, 'cancel');
    await until(() => r.tts.calls.includes(CANCELLED), 'her word');
    expect(asked(conn)).toBe(1);
    r.heard(pipe, OWNER, 'cancel');
    await sleep(40);
    expect(asked(conn)).toBe(1);
    await r.stack.stop();
  });

  it('after the 30 seconds it is too late, and she says nothing', async () => {
    const later = clockAhead();
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    later(31_000);
    r.heard(pipe, OWNER, 'cancel');
    await sleep(60);
    expect(asked(conn)).toBe(0);
    expect(r.tts.calls).not.toContain(CANCELLED);
    await r.stack.stop();
  });

  it("someone else's stop leaves it counting down", async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    r.heard(r.discordPipe, SAM, 'cancel');
    await sleep(40);
    expect(asked(conn)).toBe(0);
    await r.stack.stop();
  });

  it('an everyday word from them is not a cancel', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    r.heard(pipe, OWNER, 'done');
    await sleep(40);
    expect(asked(conn)).toBe(0);
    await r.stack.stop();
  });

  it("the PC window's stop button does it too", async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    conn.emit('stop');
    await until(() => r.tts.calls.includes(CANCELLED), 'her word');
    expect(asked(conn)).toBe(1);
    await r.stack.stop();
  });

  it('and so does typing it in the window', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    conn.emit('text', 'cancel');
    await until(() => r.tts.calls.includes(CANCELLED), 'her word');
    expect(asked(conn)).toBe(1);
    await r.stack.stop();
  });

  it('the call can do it for a PC, even when both rooms hear the word', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    await restarting(r, r.discordPipe, conn);
    r.heard(pipe, OWNER, 'cancel');
    r.heard(r.discordPipe, OWNER, 'cancel');
    await until(() => r.tts.calls.includes(CANCELLED), 'her word');
    await sleep(40);
    expect(asked(conn)).toBe(1);
    await r.stack.stop();
  });

  it('with two PCs it goes to the one that took the restart, not the one seen last', async () => {
    const r = await rig();
    const a = r.connect(OWNER, 'a');
    const b = r.connect(OWNER, 'b');
    await restarting(r, a.pipe, a.conn);
    a.conn.lastSeen = Date.now() - 60_000;
    b.conn.lastSeen = Date.now();
    r.heard(a.pipe, OWNER, 'cancel');
    await until(() => r.tts.calls.includes(CANCELLED), 'her word');
    expect(asked(a.conn)).toBe(1);
    expect(asked(b.conn)).toBe(0);
    await r.stack.stop();
  });

  it("a PC that went away can't be reached, and she says so: the restart may still be coming", async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    conn.open = false;
    conn.emit('closed');
    r.heard(r.discordPipe, OWNER, 'cancel');
    await until(() => r.tts.calls.includes(COULD_NOT), 'her word');
    expect(asked(conn)).toBe(0);
    expect(r.tts.calls).not.toContain(CANCELLED);
    await r.stack.stop();
  });

  it('a PC that refuses: she says so instead of nothing', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    conn.reply = { ok: false, result: "The PC didn't answer in time." };
    r.heard(pipe, OWNER, 'cancel');
    await until(() => r.tts.calls.includes(COULD_NOT), 'her word');
    expect(r.tts.calls).not.toContain(CANCELLED);
    await r.stack.stop();
  });

  it('once the model has called it off, a later stop has nothing left to do', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    await restarting(r, pipe, conn);
    r.steps.push({ parts: [toolCall('pc_system', '{"action":"cancel_shutdown"}'), usage(10, 2)] });
    r.heard(pipe, OWNER, 'hey adrian call off the restart', 'call off the restart');
    await until(() => asked(conn) === 1, 'the cancel');
    await sleep(40);
    conn.reply = { ok: false, result: 'There was no restart or shutdown to cancel.' };
    r.heard(pipe, OWNER, 'cancel');
    await sleep(40);
    expect(asked(conn)).toBe(1);
    expect(r.tts.calls).not.toContain(COULD_NOT);
    await r.stack.stop();
  });

  it('with nothing counting down, "cancel" sends the PC nothing', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    r.heard(pipe, OWNER, 'cancel');
    await sleep(40);
    expect(conn.calls).toEqual([]);
    await r.stack.stop();
  });
});

describe('her own taste', () => {
  const likes = () => ({ parts: [toolCall('music_taste', '{"who":"you","what":"like","name":"Frank Ocean"}'), usage(10, 2)] });

  it('an owner can set it', async () => {
    const r = await rig({ ...MUSIC, owners: [SAM] });
    r.steps.push(likes());
    r.heard(r.discordPipe, SAM, 'hey adrian you love frank ocean', 'you love frank ocean');
    await until(() => r.llmBodies.length === 2, 'the tool answer');
    expect(asPrompt(r.llmBodies[1])).not.toContain("That's up to me.");
    expect(readFileSync(join(r.dir, 'music-taste.json'), 'utf8')).toContain('Frank Ocean');
    await r.stack.stop();
  });

  it('nobody else can', async () => {
    const r = await rig(MUSIC);
    r.steps.push(likes());
    r.heard(r.discordPipe, SAM, 'hey adrian you love frank ocean', 'you love frank ocean');
    await until(() => r.llmBodies.length === 2, 'the tool answer');
    expect(asPrompt(r.llmBodies[1])).toContain("That's up to me.");
    expect(existsSync(join(r.dir, 'music-taste.json'))).toBe(false);
    await r.stack.stop();
  });
});

describe('startup', () => {
  /** Everything that loads in the background once it's logged in. */
  const models = (dir: string) => {
    mkdirSync(join(dir, MODEL_LAYOUT.whisper), { recursive: true });
    writeFileSync(join(dir, MODEL_LAYOUT.whisper, 'small-encoder.int8.onnx'), '');
    writeFileSync(join(dir, MODEL_LAYOUT.smartTurn), '');
  };
  const heavy = (dir: string) => ({
    voice: { modelDir: join(dir, 'kokoro') },
    languages: true,
    satellite: { enabled: true, port: 40000, unfinishedWaitMs: 1200 },
  });

  it('a failed login leaves nothing behind, and its error goes up as it was', async () => {
    const whisper = vi.spyOn(WhisperStt, 'load').mockResolvedValue({} as never);
    const turn = vi.spyOn(SmartTurn, 'load').mockResolvedValue({} as never);
    const down = Object.assign(new Error('getaddrinfo ENOTFOUND discord.com'), { code: 'ENOTFOUND' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await expect(
        rig(heavy, {
          prepare: models,
          // As the real one does: its own timers go with it.
          login: async (client) => {
            await client.destroy();
            throw down;
          },
        }),
      ).rejects.toBe(down);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(whisper).not.toHaveBeenCalled();
    expect(turn).not.toHaveBeenCalled();
  });

  it('a good one loads Smart Turn, and Whisper waits for the first question in another language', async () => {
    const whisper = vi.spyOn(WhisperStt, 'load').mockResolvedValue({ transcribe: async () => ({ text: '', lang: 'en', decodeMs: 1 }) } as never);
    const turn = vi.spyOn(SmartTurn, 'load').mockResolvedValue({} as never);
    const r = await rig(heavy, { prepare: models });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(whisper).not.toHaveBeenCalled(); // about 1.3 GB with the voices it brought
    r.heard(r.discordPipe, SAM, 'oye adrian qué hora es', '¿qué hora es?');
    await sleep(40);
    expect(whisper).not.toHaveBeenCalled(); // Spanish is spotted without it
    r.heard(r.discordPipe, SAM, 'hey adrian ni hao ma xian zai ji dian', 'ni hao ma xian zai ji dian');
    await until(() => whisper.mock.calls.length === 1, 'the first load');
    await r.stack.stop();
  });

  it('keeps trying when the join at startup fails', async () => {
    const r = await rig();
    h.connecting = async () => {
      throw new Error('no voice');
    };
    r.loggedIn();
    await until(() => h.transport.retries === 1, 'the retry');
    await r.stack.stop();
  });

  it('a join that works needs no retry', async () => {
    const r = await rig();
    r.loggedIn();
    await sleep(30);
    expect(h.transport.retries).toBe(0);
    await r.stack.stop();
  });

  it('the voice link counts as down when it is, even if nothing said so', async () => {
    const r = await rig();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    h.transport.up = false;
    expect(r.stack.voiceReady()).toBe(false);
    r.heard(pipe, OWNER, 'hey adrian open spotify', 'open spotify');
    await sleep(60);
    // Not handed to a call that can't answer; their speakers still play it, so push-to-talk.
    expect(conn.transcripts).not.toContain('her: Answering in the Discord call.');
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE);
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'hey adrian open spotify', 'open spotify');
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });
});

describe('a timer coming due', () => {
  const FILE = 'reminders.json';
  const due = (room?: string) => (dir: string) =>
    writeFileSync(join(dir, FILE), JSON.stringify([{ id: 'r1', userId: OWNER, speaker: 'Sam', kind: 'timer', text: 'tea', dueAt: Date.now() - 1_000, createdAt: 0, ...(room ? { room } : {}) }]));
  const kept = (r: Rig) => (JSON.parse(readFileSync(join(r.dir, FILE), 'utf8')) as unknown[]).length;
  const CALLED = 'Sam, your tea timer is done.';
  const PLAIN = 'your tea timer is done.';
  const inCall = { channelId: CALL, mute: false, deaf: false };

  it('is said in the call to someone who can hear it there, with no DM', async () => {
    const r = await rig({}, { prepare: due() });
    r.voiceStates.set(OWNER, inCall);
    r.loggedIn();
    await until(() => r.tts.calls.includes(CALLED), 'the call');
    await until(() => kept(r) === 0, 'the file');
    expect(r.dms.tries).toBe(0);
    await r.stack.stop();
  });

  it('is said at the PC it was set at for someone out of the call, with a DM as the record', async () => {
    const r = await rig({}, { prepare: due('sat:d1') });
    const { conn } = r.connect();
    r.loggedIn();
    await until(() => r.tts.calls.includes(PLAIN), 'the PC');
    await until(() => kept(r) === 0, 'the file');
    expect(r.dms.sent).toEqual([PLAIN]);
    expect(conn.transcripts).toContain(`her: ${PLAIN}`);
    expect(r.tts.calls).not.toContain(CALLED);
    await r.stack.stop();
  });

  it('counts as delivered if only the PC got it', async () => {
    const r = await rig({}, { prepare: due('sat:d1') });
    r.dms.fail = true;
    r.connect();
    r.loggedIn();
    await until(() => r.tts.calls.includes(PLAIN), 'the PC');
    await until(() => kept(r) === 0, 'the file');
    await r.stack.stop();
  });

  it('is said in the call to someone muted there, when there is no PC', async () => {
    const r = await rig({}, { prepare: due() });
    r.voiceStates.set(OWNER, { ...inCall, mute: true });
    r.loggedIn();
    await until(() => r.tts.calls.includes(CALLED), 'the call');
    await r.stack.stop();
  });

  it('goes by DM otherwise', async () => {
    const r = await rig({}, { prepare: due() });
    r.loggedIn();
    await until(() => r.dms.sent.length === 1, 'the DM');
    expect(r.dms.sent).toEqual([PLAIN]);
    await until(() => kept(r) === 0, 'the file');
    await r.stack.stop();
  });

  it('stays on file when the DM fails, and goes again a minute later', async () => {
    const later = clockAhead();
    const r = await rig({}, { prepare: due() });
    r.dms.fail = true;
    r.loggedIn();
    await until(() => r.dms.tries === 1, 'the first try');
    await sleep(30);
    expect(kept(r)).toBe(1);
    r.dms.fail = false;
    later(61_000);
    await until(() => r.dms.sent.length === 1, 'the second try');
    await until(() => kept(r) === 0, 'the file');
    await r.stack.stop();
  });

  it('waits for the join at startup, so an overdue one can be said in the call', async () => {
    const r = await rig({}, { prepare: due() });
    r.voiceStates.set(OWNER, inCall);
    h.transport.up = false;
    r.loggedIn();
    await until(() => r.tts.calls.includes(CALLED), 'the call');
    expect(r.dms.tries).toBe(0);
    await r.stack.stop();
  });

  it('never starts counting once the stack has stopped', async () => {
    const r = await rig({}, { prepare: due() });
    let joined: (() => void) | undefined;
    h.connecting = () => new Promise<void>((res) => (joined = res));
    r.loggedIn();
    await until(() => joined, 'the join');
    await r.stack.stop();
    joined!();
    await sleep(40);
    expect(r.dms.tries).toBe(0);
    expect(kept(r)).toBe(1);
  });
});


describe('notes, DMs, text chat and /join through the real stack', () => {
  const chat = { textChat: { enabled: true, dms: true } };
  const said = (body: any) => JSON.stringify(body.messages);
  /** One message, answered: one answer at a time per person. */
  async function send(r: Awaited<ReturnType<typeof rig>>, n: number, userId: string, content: string, guildId?: string) {
    r.typed(userId, content, guildId);
    await until(() => r.llmBodies.length >= n, 'the answer');
    await sleep(20);
  }

  it('keeps DM talk out of a public answer', async () => {
    const r = await rig(chat);
    await send(r, 1, OWNER, 'my landlord is evicting me');
    await send(r, 2, OWNER, `<@${BOT}> any weekend ideas`, GUILD);
    expect(said(r.llmBodies[1])).not.toContain('landlord');
    await send(r, 3, OWNER, 'so what do I do');
    expect(said(r.llmBodies[2])).toContain('landlord');
    await r.stack.stop();
  });

  it('keeps a note told in a DM out of a server until they ask about it', async () => {
    const r = await rig(chat);
    r.steps.push({ parts: [toolCall('remember', '{"note":"landlord is evicting me"}'), usage(10, 2)] });
    // The note says itself ("Got it."): one model call.
    await send(r, 1, OWNER, 'remember that my landlord is evicting me');
    await send(r, 2, OWNER, 'hello again');
    expect(said(r.llmBodies[1])).toContain('landlord is evicting me');
    expect(said(r.llmBodies[1])).toContain('use it naturally');
    await send(r, 3, OWNER, `<@${BOT}> any weekend ideas`, GUILD);
    expect(said(r.llmBodies[2])).not.toContain('evicting');
    await send(r, 4, OWNER, `<@${BOT}> what's my landlord up to`, GUILD);
    expect(said(r.llmBodies[3])).toContain('landlord is evicting me');
    expect(said(r.llmBodies[3])).toContain('Other people can hear or read your answer here');
    await r.stack.stop();
  });

  it('says Done after a tool that finishes the turn, instead of sorry', async () => {
    const replies: string[] = [];
    const r = await rig({ ...chat, ...MUSIC });
    const yt = vi.spyOn(YoutubeSource.prototype, 'soundEffect').mockResolvedValue({ title: 'airhorn', ref: 'x', seconds: 3 } as never);
    r.steps.push({ parts: [toolCall('play_sound', '{"query":"airhorn"}'), usage(10, 2)] });
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    r.client.emit('messageCreate', {
      author: { id: OWNER, bot: false, username: 'someone' },
      system: false,
      content: `<@${BOT}> airhorn`,
      embeds: [],
      guildId: GUILD,
      guild: null,
      channelId: TEXT_CHANNEL,
      channel: { type: ChannelType.GuildText },
      mentions: { users: new Collection([[BOT, {}]]), roles: new Collection(), everyone: false },
      reply: async (o: { content: string }) => void replies.push(o.content),
    });
    await until(() => replies.length > 0, 'the reply');
    expect(yt).toHaveBeenCalled();
    expect(replies).toEqual(['Done.']);
    await r.stack.stop();
  });

  it('warns about a fallback with no key', async () => {
    const r = await rig({ brain: { provider: 'openai', baseUrl: 'http://llm.test/v1', model: 'fake', apiKeySecret: 'LLM_API_KEY', priceInPerM: 1, priceOutPerM: 5, fallback: { baseUrl: 'http://spare.test/v1', model: 'spare', apiKeySecret: 'SPARE_API_KEY' } } });
    expect(r.warned.some((w) => w.includes('fallback'))).toBe(true);
    await r.stack.stop();
  });

  describe('/join', () => {
    const OTHER = '100000000000000021';
    const FRIEND = '100000000000000031';
    /** One slash command from someone in `channelId`: the first reply. */
    async function slash(r: Awaited<ReturnType<typeof rig>>, name: string, channelId: string) {
      const replies: string[] = [];
      const ch = { id: channelId, name: channelId === CALL ? 'drag' : 'other', permissionsFor: () => new PermissionsBitField(PermissionsBitField.All) };
      const i: any = {
        commandName: name, guildId: GUILD, user: { id: SAM }, deferred: false, replied: false,
        isChatInputCommand: () => true, inCachedGuild: () => true,
        guild: { voiceStates: { cache: new Map([[SAM, { channel: ch }]]) }, members: { me: {} } },
        reply: async (o: { content: string }) => {
          i.replied = true;
          replies.push(o.content);
        },
        deferReply: async () => {
          i.deferred = true;
        },
        editReply: async (o: string) => void replies.push(o),
      };
      r.client.emit(Events.InteractionCreate, i);
      await until(() => replies.length > 0, 'a reply');
      return replies[0]!;
    }

    it('retries after a join that failed', async () => {
      const r = await rig();
      let fails = 1;
      h.connecting = async () => {
        if (fails-- > 0) throw new Error('timed out');
      };
      expect(await slash(r, 'join', OTHER)).toContain("didn't work");
      expect(r.stack.voiceReady()).toBe(false);
      expect(await slash(r, 'join', OTHER)).toContain('Joined');
      expect(r.stack.voiceReady()).toBe(true);
      await r.stack.stop();
    });

    it("rebuilds after 'failed', from that channel", async () => {
      const r = await rig();
      h.transport.emit('failed', 'not back');
      expect(await slash(r, 'join', CALL)).toContain('Joined');
      await r.stack.stop();
    });

    it('rebuilds after a join at startup that failed', async () => {
      const r = await rig();
      h.transport.up = false;
      expect(await slash(r, 'join', CALL)).toContain('Joined');
      await r.stack.stop();
    });

    it('stays in a busy call during a drop, for someone elsewhere', async () => {
      const r = await rig();
      r.voiceStates.set(BOT, { channelId: CALL });
      r.client.channels.cache.set(CALL, { members: { filter: () => ({ size: 1 }) }, isVoiceBased: () => true } as never);
      void FRIEND;
      h.transport.emit('disconnected', 'dropped');
      expect(await slash(r, 'join', OTHER)).toContain('another channel here');
      await r.stack.stop();
    });

    it('says she is already here when she is', async () => {
      const r = await rig();
      expect(await slash(r, 'join', CALL)).toContain("I'm already here");
      await r.stack.stop();
    });
  });
});

describe('what music_control says', () => {
  const pause = (r: Rig) => r.steps.push({ parts: [toolCall('music_control', '{"action":"pause"}'), usage(10, 2)] });

  it('word for word to someone speaking English: no second model call', async () => {
    const r = await rig(MUSIC);
    fakeMusic();
    r.voiceStates.set(SAM, { channelId: CALL, mute: false, deaf: false });
    pause(r);
    r.heard(r.discordPipe, SAM, 'hey adrian hold the tunes', 'hold the tunes');
    await until(() => r.stack.answers().length === 1, 'the answer');
    expect(r.llmBodies).toHaveLength(1);
    await r.stack.stop();
  });

  it('in the words of the model for someone who is not', async () => {
    const r = await rig(MUSIC);
    fakeMusic();
    r.voiceStates.set(SAM, { channelId: CALL, mute: false, deaf: false });
    pause(r);
    r.heard(r.discordPipe, SAM, 'hey adrian ¿puedes parar la música?', '¿puedes parar la música?');
    await until(() => r.llmBodies.length === 2, 'the second call');
    await r.stack.stop();
  });
});

describe('a video asked for at the PC', () => {
  const ID = 'dQw4w9WgXcQ';
  it('opens by its id, found without a stream lookup, and she says so', async () => {
    const r = await rig(MUSIC);
    vi.spyOn(YoutubeSource.prototype, 'videoId').mockResolvedValue(ID);
    const resolve = vi.spyOn(YoutubeSource.prototype, 'resolve').mockResolvedValue({ ...TRACK, ref: 'https://media.test/videoplayback?expire=1' } as never);
    const { conn, pipe } = r.connect();
    conn.reply = { ok: true, result: 'Opened the YouTube video.' };
    r.steps.push({ parts: [toolCall('pc_open', '{"youtube":"rick astley","play":true}'), usage(10, 2)] });
    r.heard(pipe, OWNER, 'hey adrian open rick astley on youtube', 'open rick astley on youtube');
    await until(() => r.tts.calls.length === 1, 'her line');
    expect(conn.calls).toEqual([{ name: 'pc_open', args: { video_id: ID } }]);
    expect(r.tts.calls).toEqual(['Opening it on YouTube.']);
    expect(resolve).not.toHaveBeenCalled();
    await r.stack.stop();
  });
});

describe('a skip with nothing to go to', () => {
  const DOWN = "I can't reach YouTube right now.";
  it.each([
    [undefined, true, DOWN],
    [undefined, false, "That's the end of the queue."],
    [false, true, "Nothing's playing."],
  ])('skip gave %s, YouTube paused %s', async (skipped, paused, line) => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    m.skip.mockResolvedValue(skipped as never);
    vi.spyOn(MusicPlayer.prototype, 'youtubePaused', 'get').mockReturnValue(paused);
    await order(r, r.discordPipe, SAM, 'skip', line);
    await r.stack.stop();
  });
});

/** A PC room with Smart Turn loaded, and a lexicon, so words count as English.
 *  Her name isn't in it, as it isn't in the real one: what's judged is what follows it. */
async function holding(over: Record<string, unknown> = {}) {
  vi.spyOn(SmartTurn, 'load').mockResolvedValue({} as never);
  const words = 'play the what about and new so then we went to is capital of australia open spotify';
  const r = await rig((dir) => ({ voice: { modelDir: join(dir, 'kokoro') }, satellite: { enabled: true, port: 40000, unfinishedWaitMs: 1200 }, ...over }), {
    prepare: (dir) => {
      mkdirSync(join(dir, 'kokoro'));
      writeFileSync(join(dir, 'kokoro', 'lexicon-us-en.txt'), words.split(' ').map((w) => `${w} x`).join('\n'));
      writeFileSync(join(dir, MODEL_LAYOUT.smartTurn), '');
    },
  });
  const { conn, pipe } = r.connect();
  return { r, conn, pipe, turn: (pipe as unknown as { args: TurnOptions[] }).args[4]! };
}

describe('speech that sounds unfinished at a PC', () => {
  it('only PCs wait for the rest', async () => {
    const { r } = await holding();
    expect((r.discordPipe as unknown as { args: unknown[] }).args[4]).toBeUndefined();
    await r.stack.stop();
  });

  it('and a PC waits out a longer silence first', async () => {
    const { r, pipe } = await holding();
    const vad = (p: unknown) => (p as { args: { minSilence: number }[] }).args[3]!.minSilence;
    expect(vad(pipe)).toBe(0.8);
    expect(vad(r.discordPipe)).toBe(0.5);
    await r.stack.stop();
  });

  it('with her name, waits only if the words stop mid-thought', async () => {
    const { r, turn } = await holding();
    expect(turn.shouldHold!(OWNER, 'hey adrian play', 1)).toBe(true);
    expect(turn.shouldHold!(OWNER, 'hey adrian what about the', 1)).toBe(true);
    expect(turn.shouldHold!(OWNER, 'hey adrian play ella langley', 1)).toBe(false);
    await r.stack.stop();
  });

  it('her name alone goes at once', async () => {
    const { r, turn } = await holding();
    expect(turn.shouldHold!(OWNER, 'hey adrian', 1)).toBe(false);
    await r.stack.stop();
  });

  it('side talk goes at once, however it ends: nobody is waiting on it', async () => {
    const { r, turn } = await holding();
    expect(turn.shouldHold!(OWNER, 'so then we went to the', 1)).toBe(false);
    await r.stack.stop();
  });

  it('inside the follow-up window, words without her name count', async () => {
    const { r, pipe, turn } = await holding();
    await answered(r, OWNER, pipe);
    expect(turn.shouldHold!(OWNER, 'and what about the', 1)).toBe(true);
    expect(turn.shouldHold!(OWNER, 'and what about new zealand', 1)).toBe(false);
    await r.stack.stop();
  });

  it('the window is judged from when they started talking', async () => {
    const { r, pipe, turn } = await holding();
    await answered(r, OWNER, pipe);
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + 20_500);
    expect(turn.shouldHold!(OWNER, 'and what about the', 2.5)).toBe(true);
    expect(turn.shouldHold!(OWNER, 'and what about the', 0.4)).toBe(false);
    await r.stack.stop();
  });

  it('push-to-talk counts, and asking does not use the press up', async () => {
    const { r, conn, pipe, turn } = await holding();
    conn.emit('ptt');
    expect(turn.shouldHold!(OWNER, 'what about the', 1)).toBe(true);
    r.heard(pipe, OWNER, 'open spotify');
    await until(() => r.llmBodies.length === 1, 'the model');
    await r.stack.stop();
  });

  it('words it can not read as English wait: only the words it knows can be judged', async () => {
    const { r, turn } = await holding();
    expect(turn.shouldHold!(OWNER, 'hey adrian wo ist der bahnhof', 1)).toBe(true);
    await r.stack.stop();
  });
});

describe('the cloud listen during a hold', () => {
  const cloud = { cloudStt: { enabled: true } };
  const QUESTION = 'Hey Adrian, what is the capital of Australia';

  it('starts on the held words, and the answer uses that one listen', async () => {
    const { r, pipe, turn } = await holding(cloud);
    r.groq.reply = QUESTION;
    const samples = new Float32Array(16_000);
    turn.onHeldWords!(OWNER, { text: 'hey adrian what is the', samples });
    await until(() => r.groq.calls === 1, 'the cloud listen');
    r.heard(pipe, OWNER, 'hey adrian what is the', 'what is the', 1, { samples });
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(r.groq.calls).toBe(1);
    expect(asPrompt(r.llmBodies[0])).toContain('capital of Australia');
    await r.stack.stop();
  });

  it('audio that was joined since gets a listen of its own', async () => {
    const { r, pipe, turn } = await holding(cloud);
    r.groq.reply = QUESTION;
    turn.onHeldWords!(OWNER, { text: 'hey adrian what is the', samples: new Float32Array(16_000) });
    await until(() => r.groq.calls === 1, 'the cloud listen');
    r.heard(pipe, OWNER, 'hey adrian what is the capital', 'what is the capital');
    await until(() => r.groq.calls === 2, 'the second listen');
    await r.stack.stop();
  });

  it('inside the follow-up window too', async () => {
    const { r, pipe, turn } = await holding(cloud);
    await answered(r, OWNER, pipe);
    const before = r.groq.calls;
    turn.onHeldWords!(OWNER, { text: 'and what about the', samples: new Float32Array(16_000) });
    await until(() => r.groq.calls === before + 1, 'the cloud listen');
    await r.stack.stop();
  });

  it.each([
    ['side talk', 'so then we went to the'],
    ['her name alone', 'hey adrian'],
    ['a stop', 'hey adrian stop'],
  ])('not for %s', async (_what, words) => {
    const { r, turn } = await holding(cloud);
    turn.onHeldWords!(OWNER, { text: words, samples: new Float32Array(16_000) });
    await sleep(30);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });

  it('not without a key for it', async () => {
    const { r, turn } = await holding();
    turn.onHeldWords!(OWNER, { text: 'hey adrian what is the', samples: new Float32Array(16_000) });
    await sleep(30);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });

  it('not when the call has these words: the call answers them', async () => {
    const { r, turn } = await holding(cloud);
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    turn.onHeldWords!(OWNER, { text: 'hey adrian what is the', samples: new Float32Array(16_000) });
    await sleep(30);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });
});

describe('the cloud listen during the silence wait', () => {
  const cloud = { cloudStt: { enabled: true } };
  const QUESTION = 'Hey Adrian, what is the capital of Australia';
  type Early = { minSilence: number; onWords(userId: string, w: { text: string; samples: Float32Array; startedAt: number; signal: AbortSignal }): void };
  const earlyOf = (pipe: EventEmitter) => (pipe as unknown as { args: (Early | undefined)[] }).args[5];
  const say = (e: Early, text: string, samples = new Float32Array(16_000), signal = new AbortController().signal) => e.onWords(OWNER, { text, samples, startedAt: performance.now() - 1000, signal });

  it('satellite.earlyListen false turns it off', async () => {
    const r = await rig({ ...cloud, satellite: { enabled: true, port: 40000, unfinishedWaitMs: 0, earlyListen: false } });
    const { pipe } = r.connect();
    expect(earlyOf(pipe)).toBeUndefined();
    await r.stack.stop();
  });

  it('a PC listens early, the call does not', async () => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    expect(earlyOf(pipe)!.minSilence).toBe(0.32);
    expect(earlyOf(r.discordPipe)).toBeUndefined();
    await r.stack.stop();
  });

  it('starts on early words with her name, and the answer uses that one listen', async () => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    r.groq.reply = QUESTION;
    const samples = new Float32Array(16_000);
    say(earlyOf(pipe)!, 'hey adrian what is the capital of australia', samples);
    await until(() => r.groq.calls === 1, 'the cloud listen');
    r.heard(pipe, OWNER, 'hey adrian what is the capital of australia', 'what is the capital of australia', 1, { samples });
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(r.groq.calls).toBe(1);
    expect(asPrompt(r.llmBodies[0])).toContain('capital of Australia');
    await r.stack.stop();
  });

  it('a hold on the same clip does not ask again', async () => {
    const { r, pipe, turn } = await holding(cloud);
    r.groq.reply = QUESTION;
    const samples = new Float32Array(16_000);
    say(earlyOf(pipe)!, 'hey adrian what is the capital of australia', samples);
    turn.onHeldWords!(OWNER, { text: 'hey adrian what is the capital of australia', samples });
    await until(() => r.groq.calls === 1, 'the cloud listen');
    await sleep(20);
    expect(r.groq.calls).toBe(1);
    await r.stack.stop();
  });

  it('a dropped clip stops its listen quietly, and the clip heard gets its own', async () => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    r.groq.delay = 200;
    r.groq.reply = QUESTION;
    const ctl = new AbortController();
    say(earlyOf(pipe)!, 'hey adrian what is the capital of australia', new Float32Array(16_000), ctl.signal);
    await until(() => r.groq.calls === 1, 'the cloud listen');
    ctl.abort();
    await until(() => r.groq.aborted === 1, 'the abort');
    r.groq.delay = 0;
    r.heard(pipe, OWNER, 'hey adrian what is the capital of australia and why', 'what is the capital of australia and why');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(r.groq.calls).toBe(2);
    expect(r.warned).not.toContain('cloud speech-to-text failed; using local words');
    await r.stack.stop();
  });

  it('inside the follow-up window, judged from when they started talking', async () => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    await answered(r, OWNER, pipe);
    const before = r.groq.calls;
    const e = earlyOf(pipe)!;
    e.onWords(OWNER, { text: 'and what about new zealand', samples: new Float32Array(16_000), startedAt: performance.now(), signal: new AbortController().signal });
    await until(() => r.groq.calls === before + 1, 'the cloud listen');
    // begun after the window closed: not for her
    e.onWords(OWNER, { text: 'and what about new zealand', samples: new Float32Array(16_000), startedAt: performance.now() + 60_000, signal: new AbortController().signal });
    await sleep(30);
    expect(r.groq.calls).toBe(before + 1);
    await r.stack.stop();
  });

  it.each([
    ['side talk', 'so then we went to the store'],
    ['her name alone', 'hey adrian'],
    ['a stop', 'hey adrian stop'],
    ['words that stop mid-thought', 'hey adrian open'],
  ])('not for %s', async (_what, words) => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    say(earlyOf(pipe)!, words);
    await sleep(30);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });

  it('not when the call has these words', async () => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    say(earlyOf(pipe)!, 'hey adrian what is the capital of australia');
    await sleep(30);
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });

  it('push-to-talk counts as for her', async () => {
    const r = await rig(cloud);
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    say(earlyOf(pipe)!, 'what is the capital of australia');
    await until(() => r.groq.calls === 1, 'the cloud listen');
    await r.stack.stop();
  });

  it("early listens stop near Groq's minute limit; a clip someone waits on still gets its own", async () => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    for (let i = 0; i < 20; i++) say(earlyOf(pipe)!, QUESTION, new Float32Array(16_000 + i));
    await sleep(50);
    expect(r.groq.calls).toBe(14);
    r.groq.reply = QUESTION;
    r.heard(pipe, OWNER, 'hey adrian what is the capital of australia', 'what is the capital of australia');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(r.groq.calls).toBe(15);
    await r.stack.stop();
  });

  it('after a rate limit, no early listen', async () => {
    const r = await rig(cloud);
    const { pipe } = r.connect();
    r.groq.status = 429;
    r.heard(pipe, OWNER, 'hey adrian what is the capital of australia', 'what is the capital of australia');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(r.groq.calls).toBe(1);
    r.groq.status = 200;
    say(earlyOf(pipe)!, QUESTION);
    await sleep(30);
    expect(r.groq.calls).toBe(1);
    await r.stack.stop();
  });
});

describe('the second listen', () => {
  it('skips her name alone: it would only hold up the "Yes?"', async () => {
    const r = await rig({ cloudStt: { enabled: true } });
    const { pipe } = r.connect();
    r.heard(pipe, OWNER, 'hey adrian', '');
    await until(() => r.tts.calls.includes('Yes?'), 'the ack');
    expect(r.groq.calls).toBe(0);
    await r.stack.stop();
  });

  it('still hears push-to-talk, where the words are the request', async () => {
    const r = await rig({ cloudStt: { enabled: true } });
    const { conn, pipe } = r.connect();
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'how is the weather');
    await until(() => r.groq.calls === 1, 'the cloud listen');
    await r.stack.stop();
  });
});

describe('the cloud voice after a long quiet', () => {
  it('warms up when anyone starts talking, in the call or at a PC', async () => {
    const warm = vi.spyOn(SpeechifyTts.prototype, 'warmIfIdle').mockResolvedValue();
    const r = await rig({ cloudVoice: { enabled: true } });
    const { conn } = r.connect();
    r.transport.emit('speechStart', SAM);
    conn.emit('speechStart', OWNER);
    expect(warm).toHaveBeenCalledTimes(2);
    await r.stack.stop();
  });

  it('has nothing to warm without it', async () => {
    const r = await rig();
    expect(() => r.transport.emit('speechStart', SAM)).not.toThrow();
    await r.stack.stop();
  });

  it("has the bot check's line ready, like the other short replies", async () => {
    const synth = vi.spyOn(SpeechifyTts.prototype, 'synthesize').mockResolvedValue({ samples: new Float32Array(960), sampleRate: 48_000, synthMs: 1 } as never);
    const r = await rig({ cloudVoice: { enabled: true } });
    await until(() => synth.mock.calls.some(([t]) => t === "I can't reach YouTube right now."), 'the line');
    await r.stack.stop();
  });
});

describe('how long an answer took', () => {
  const lines = (r: Rig, m: string) => r.logged.filter((l) => l.m === m).map((l) => l.f);
  const closed = (ms: number, by: string) => ({ vadClosedAt: performance.now() - ms, closedBy: by });
  /** At least `ms`, and not by much: the rest is this machine answering a fake model. */
  const about = (got: number | null, ms: number) => {
    expect(got).toBeGreaterThanOrEqual(ms);
    expect(got).toBeLessThan(ms + 1_200);
  };
  async function took(r: Rig, pipe: EventEmitter, who: string, more: Record<string, unknown> = {}) {
    r.steps.push({ parts: [text('Canberra.'), usage(10, 2)] });
    r.heard(pipe, who, 'hey adrian capital', 'capital of australia', 1, more);
    await until(() => r.stack.answers().length === 1, 'the answer');
    return r.stack.answers()[0]!;
  }

  it('counts from the VAD close, not the release, plus the wait a PC room really has', async () => {
    const r = await rig();
    const { pipe } = r.connect();
    const a = await took(r, pipe, OWNER, { ...closed(1000, 'vad'), turnCheckMs: 120, holdMs: 880 });
    about(a.speechEndToAudioMs, 1800);
    expect(a).toMatchObject({ room: 'sat:d1', closedBy: 'vad', turnCheckMs: 120, holdMs: 880 });
    await r.stack.stop();
  });

  it('a slower VAD setting is what a PC room waits, too', async () => {
    const r = await rig((dir) => ({ listen: { vadModel: 'x', asrModelDir: dir, minSilence: 1.5 } }));
    const { pipe } = r.connect();
    const a = await took(r, pipe, OWNER, closed(0, 'vad'));
    about(a.speechEndToAudioMs, 1500);
    await r.stack.stop();
  });

  it('in the call, the VAD wait for a clip it closed', async () => {
    const r = await rig();
    const a = await took(r, r.discordPipe, SAM, closed(1000, 'vad'));
    about(a.speechEndToAudioMs, 1500);
    expect(a).toMatchObject({ room: 'discord', closedBy: 'vad', turnCheckMs: null, holdMs: null });
    await r.stack.stop();
  });

  it("in the call, the transport's wait for a clip it ended", async () => {
    const r = await rig();
    const a = await took(r, r.discordPipe, SAM, closed(1000, 'flush'));
    about(a.speechEndToAudioMs, 1800);
    await r.stack.stop();
  });

  it('with no VAD time, from the release as before', async () => {
    const r = await rig();
    const a = await took(r, r.discordPipe, SAM);
    about(a.speechEndToAudioMs, 500);
    expect(a.closedBy).toBeNull();
    await r.stack.stop();
  });

  it('counts the wait for the cloud listen', async () => {
    const r = await rig({ cloudStt: { enabled: true } });
    const { pipe } = r.connect();
    r.groq.delay = 40;
    r.groq.reply = 'Hey Adrian, capital of Australia';
    const a = await took(r, pipe, OWNER);
    expect(a.groqMs).toBeGreaterThanOrEqual(35);
    await r.stack.stop();
  });

  it('has no cloud listen to count otherwise', async () => {
    const r = await rig();
    const a = await took(r, r.discordPipe, SAM);
    expect(a.groqMs).toBeNull();
    await r.stack.stop();
  });

  it('the log lines carry the same timing, and no words unless asked for', async () => {
    const r = await rig();
    const { pipe } = r.connect();
    await took(r, pipe, OWNER, { ...closed(100, 'vad'), turnCheckMs: 120, holdMs: 0 });
    expect(lines(r, 'pc heard')[0]).toMatchObject({ closedBy: 'vad', turnCheckMs: 120, holdMs: 0 });
    expect(lines(r, 'pc heard')[0].text).toBeUndefined();
    expect(lines(r, 'answered')[0]).toMatchObject({ room: 'sat:d1', closedBy: 'vad', turnCheckMs: 120, holdMs: 0, groqMs: null });
    await r.stack.stop();
  });
});

describe('a hold and the listening window', () => {
  /** After an answer, move the clock past the 8 s follow-up window. */
  async function pastTheWindow(r: Rig) {
    r.steps.push({ parts: [text('Canberra.'), usage(10, 2)] });
    r.heard(r.discordPipe, SAM, 'hey adrian capital', 'capital of australia');
    await until(() => r.stack.answers().length === 1, 'the first answer');
    await sleep(20);
    const real = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => real() + 8_500);
  }

  it('counts for words that began inside it, however long the hold', async () => {
    const r = await rig();
    await pastTheWindow(r);
    r.heard(r.discordPipe, SAM, 'and what about new zealand', undefined, 0.5, { vadClosedAt: performance.now() - 1_200 });
    await until(() => r.llmBodies.length === 2, 'the follow-up');
    await r.stack.stop();
  });

  it('does not count for words that began after it, held or not', async () => {
    const r = await rig();
    await pastTheWindow(r);
    r.heard(r.discordPipe, SAM, 'and what about new zealand', undefined, 0.5, { vadClosedAt: performance.now() });
    await sleep(60);
    expect(r.llmBodies).toHaveLength(1);
    await r.stack.stop();
  });
});

describe('what forget says', () => {
  const told = async (r: Rig) => {
    // Saved, it says itself: no second step.
    r.steps.push({ parts: [toolCall('remember', '{"note":"likes green tea"}'), usage(10, 2)] });
    r.heard(r.discordPipe, SAM, 'hey adrian remember i like green tea', 'remember i like green tea');
    await until(() => r.stack.answers().length === 1, 'the note');
    r.steps.push({ parts: [toolCall('forget', '{"what":"tea"}'), usage(10, 2)] });
  };

  it('word for word to someone speaking English: no second model call', async () => {
    const r = await rig();
    await told(r);
    const before = r.llmBodies.length;
    r.heard(r.discordPipe, SAM, 'hey adrian forget the tea thing', 'forget the tea thing');
    await until(() => r.stack.answers().length === 2, 'the answer');
    expect(r.llmBodies.length - before).toBe(1);
    await r.stack.stop();
  });

  it('in the words of the model for someone who is not', async () => {
    const r = await rig();
    await told(r);
    const before = r.llmBodies.length;
    r.heard(r.discordPipe, SAM, 'hey adrian ¿puedes forget lo del té?', '¿puedes forget lo del té?'); // the router needs its word
    await until(() => r.llmBodies.length === before + 2, 'the second call');
    await r.stack.stop();
  });
});

describe('a skip and a stop', () => {
  it('hands the skip its signal, so a stop during the lookup ends it', async () => {
    const r = await rig(MUSIC);
    const m = fakeMusic();
    await order(r, r.discordPipe, SAM, 'skip', "That's the end of the queue.");
    expect(m.skip.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    await r.stack.stop();
  });
});

describe('a PC in a game', () => {
  const FILE = 'reminders.json';
  const due = (kind: 'timer' | 'reminder', what: string, lateMs = 1_000) => (dir: string) =>
    writeFileSync(join(dir, FILE), JSON.stringify([{ id: 'r1', userId: OWNER, speaker: 'Sam', kind, text: what, dueAt: Date.now() - lateMs, createdAt: 0, room: 'sat:d1' }]));
  const kept = (r: Rig) => (JSON.parse(readFileSync(join(r.dir, FILE), 'utf8')) as unknown[]).length;
  const playing = (conn: EventEmitter, game?: string) => conn.emit('activity', { gaming: true, ...(game ? { game } : {}) });

  it('keeps a reminder and its DM for after the match: no Discord notification over the game', async () => {
    const r = await rig({}, { prepare: due('reminder', 'laundry') });
    const { conn } = r.connect();
    playing(conn, 'VALORANT');
    r.loggedIn();
    await until(() => kept(r) === 0, 'the file');
    await sleep(50);
    expect(r.dms.sent).toEqual([]);
    expect(r.tts.calls).toEqual([]);
    expect(conn.transcripts).toEqual([]);
    const held = JSON.parse(readFileSync(join(r.dir, 'held-while-gaming.json'), 'utf8'));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ dmSent: false, dm: expect.stringContaining('laundry') });
    conn.emit('activity', { gaming: false });
    await until(() => r.tts.calls.includes('While you were playing: Reminder: laundry.'), 'the line after the match');
    expect(conn.transcripts).toContain('her: While you were playing: Reminder: laundry.');
    // The record goes once it's out, and only once.
    await until(() => r.dms.sent.length === 1, 'the DM after the match');
    expect(String(r.dms.sent[0])).toContain('laundry');
    await sleep(50);
    expect(r.dms.sent).toHaveLength(1);
    await r.stack.stop();
  });

  it('a reminder that came due while she was offline is not called late after the match', async () => {
    const r = await rig({}, { prepare: due('reminder', 'laundry', 10 * 60_000) });
    const { conn } = r.connect();
    playing(conn);
    r.loggedIn();
    await until(() => kept(r) === 0, 'the file');
    expect(r.dms.sent).toEqual([]);
    conn.emit('activity', { gaming: false });
    await until(() => r.tts.calls.includes('While you were playing: Reminder: laundry.'), 'the line after the match');
    // The DM, the record, says it was late, as it would have when it came due.
    await until(() => r.dms.sent.length === 1, 'the DM after the match');
    expect(String(r.dms.sent[0])).toContain('late');
    await r.stack.stop();
  });

  it('still rings a timer', async () => {
    const r = await rig({}, { prepare: due('timer', 'tea') });
    const { conn } = r.connect();
    playing(conn);
    r.loggedIn();
    await until(() => r.tts.calls.includes('your tea timer is done.'), 'the timer');
    await r.stack.stop();
  });

  it('with the config off, says reminders as before', async () => {
    const r = await rig({ satellite: { enabled: true, port: 40000, unfinishedWaitMs: 0, quietWhileGaming: false } }, { prepare: due('reminder', 'laundry') });
    const { conn } = r.connect();
    playing(conn);
    r.loggedIn();
    await until(() => r.tts.calls.includes('reminder: laundry.'), 'the reminder');
    await r.stack.stop();
  });

  it('answers only to her name there, briefly, and tells the model the game', async () => {
    const r = await rig();
    const { conn, pipe } = r.connect();
    playing(conn, 'VALORANT');
    await answered(r, OWNER, pipe);
    expect(asPrompt(r.llmBodies[0])).toContain('is playing VALORANT at this PC right now');
    r.heard(pipe, OWNER, 'and the one for france');
    await sleep(80);
    expect(r.llmBodies).toHaveLength(1);
    // Out of the game: the follow-up works again.
    conn.emit('activity', { gaming: false });
    await answered(r, OWNER, pipe);
    expect(asPrompt(r.llmBodies[1])).not.toContain('is playing');
    r.heard(pipe, OWNER, 'and the one for france');
    await until(() => r.llmBodies.length === 3, 'the follow-up');
    await r.stack.stop();
  });

  it('leaves the Discord call alone', async () => {
    const r = await rig();
    const { conn } = r.connect();
    playing(conn);
    await answered(r, SAM);
    expect(asPrompt(r.llmBodies[0])).not.toContain('is playing');
    r.heard(r.discordPipe, SAM, 'and the one for france');
    await until(() => r.llmBodies.length === 2, 'the follow-up in the call');
    await r.stack.stop();
  });
});

describe('a music quiz in the call', () => {
  it('takes answers without her name, ignores side talk, holds music requests, and stops on request', async () => {
    const r = await rig(MUSIC);
    r.client.channels.cache.set(CALL, { members: { filter: () => ({ size: 2 }) }, isVoiceBased: () => true } as never);
    const songs = [
      { title: 'Blinding Lights', artist: 'The Weeknd' },
      { title: 'Seven Nation Army', artist: 'The White Stripes' },
      { title: 'Take on Me', artist: 'a-ha' },
      { title: 'Creep', artist: 'Radiohead' },
    ];
    vi.spyOn(YoutubeSource.prototype, 'playlist').mockResolvedValue({ tracks: songs.map((s, i) => ({ ...s, source: 'youtube', ref: '', id: `vidquiz000${i}` })) } as never);
    vi.spyOn(MusicPlayer.prototype, 'clipTrack').mockImplementation(async (t) => ({ ...t, ref: 'https://stream/x', durationS: 200 }));
    const clips: string[] = [];
    vi.spyOn(MusicPlayer.prototype, 'clip').mockImplementation(async (t) => {
      clips.push(t.title);
      return { track: t, startS: 60, seconds: 20, done: new Promise(() => {}), stop() {} };
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.999); // no shuffle: the list's order
    r.heard(r.discordPipe, SAM, 'hey adrian start a music quiz', 'start a music quiz');
    await until(() => r.tts.calls.includes('Round 1.'), 'the first round');
    expect(r.tts.calls.some((t) => t.startsWith('Music quiz! 8 rounds'))).toBe(true);
    await until(() => clips.length === 1, 'the first clip');
    const first = clips[0]!;
    const answer = songs.find((s) => s.title === first)!;
    // Side talk: nothing said, no model call.
    const said = r.tts.calls.length;
    r.heard(r.discordPipe, SAM, 'what are we eating tonight');
    await sleep(40);
    expect(r.tts.calls.slice(said)).toEqual([]);
    r.heard(r.discordPipe, SAM, `is it ${answer.title}`);
    await until(() => r.tts.calls.some((t) => t.includes(`That's ${answer.title} by ${answer.artist}.`)), 'the reveal');
    expect(r.llmBodies).toHaveLength(0);
    await order(r, r.discordPipe, SAM, 'play despacito', "We're in the middle of a music quiz. Say stop the quiz first, then ask again.");
    r.heard(r.discordPipe, SAM, 'hey adrian stop the quiz', 'stop the quiz');
    await until(() => r.tts.calls.some((t) => t.startsWith('Quiz over.')), 'the end');
    expect(r.llmBodies).toHaveLength(0);
    await r.stack.stop();
  });
});

describe('a ringing alarm', () => {
  /** One alarm of the owner's, due a second ago, before the stack starts. */
  const ringing = (dir: string) =>
    writeFileSync(
      join(dir, 'alarms.json'),
      JSON.stringify({ version: 1, alarms: [{ id: 'al1', userId: OWNER, speaker: 'Rique', kind: 'alarm', label: '', at: Date.now() - 1000, base: Date.now() - 1000, time: '07:00', tz: 'UTC', enabled: true }], prefs: {}, sounds: [] }),
    );
  const alarmsLeft = (dir: string) => JSON.parse(readFileSync(join(dir, 'alarms.json'), 'utf8')).alarms.length;

  it("the owner's stop turns it off and never reaches the model", async () => {
    const r = await rig({}, { prepare: ringing });
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    r.loggedIn();
    await until(() => r.logged.some((l) => l.m === 'alarm sound' && l.f.place === 'discord'), 'the ring in the call');
    r.heard(r.discordPipe, OWNER, 'stop');
    await until(() => alarmsLeft(r.dir) === 0, 'the alarm off');
    await sleep(50);
    expect(r.llmBodies).toHaveLength(0);
    expect(r.tts.calls).toContain('Alarm off.');
    await r.stack.stop();
  });

  it("someone else's stop leaves it ringing, and the PC copy of the owner's words is ignored while they're in her call", async () => {
    const r = await rig({}, { prepare: ringing });
    r.voiceStates.set(OWNER, { channelId: CALL, mute: false, deaf: false });
    const { pipe } = r.connect();
    r.loggedIn();
    await until(() => r.logged.some((l) => l.m === 'alarm sound'), 'the ring');
    r.heard(r.discordPipe, SAM, 'stop');
    r.heard(pipe, OWNER, 'stop');
    await sleep(100);
    expect(alarmsLeft(r.dir)).toBe(1);
    expect(r.logged.some((l) => l.m === 'alarm words')).toBe(false);
    r.heard(r.discordPipe, OWNER, 'snooze');
    await until(() => r.logged.some((l) => l.m === 'alarm snoozed'), 'the snooze');
    await r.stack.stop();
  });

  it('muted in her call, with a PC whose speakers play it: it rings in the call, and the DM has the buttons', async () => {
    const r = await rig({}, { prepare: ringing });
    r.voiceStates.set(OWNER, { channelId: CALL, mute: true, deaf: false });
    const { pipe } = r.connect();
    r.loggedIn();
    await until(() => r.logged.some((l) => l.m === 'alarm sound' && l.f.place === 'discord'), 'the ring in the call');
    await until(() => r.dms.sent.length === 1, 'the DM');
    expect(JSON.stringify(r.dms.sent[0])).toContain("you're muted there");
    expect(JSON.stringify(r.dms.sent[0])).toContain('components');
    r.heard(pipe, OWNER, 'stop'); // maybe someone in the call
    await sleep(100);
    expect(alarmsLeft(r.dir)).toBe(1);
    await r.stack.stop();
  });

  it('muted in her call, with a PC on headphones: it rings at the PC, and a spoken stop there ends it', async () => {
    const r = await rig({}, { prepare: ringing });
    r.voiceStates.set(OWNER, { channelId: CALL, mute: true, deaf: false });
    const { conn, pipe } = r.connect();
    conn.output = 'headphones';
    r.loggedIn();
    await until(() => r.logged.some((l) => l.m === 'alarm sound' && String(l.f.place).startsWith('sat:')), 'the ring at the PC');
    r.heard(pipe, OWNER, "I'm up");
    await until(() => alarmsLeft(r.dir) === 0, 'the alarm off');
    await r.stack.stop();
  });

  it('at a PC whose speakers play another call: rings there, the DM has the buttons, and only push-to-talk or a button stops it', async () => {
    const r = await rig({}, { prepare: ringing });
    r.voiceStates.set(OWNER, { channelId: OTHER_CALL, mute: false, deaf: false });
    const { conn, pipe } = r.connect();
    r.loggedIn();
    await until(() => r.logged.some((l) => l.m === 'alarm sound' && String(l.f.place).startsWith('sat:')), 'the ring at the PC');
    await until(() => r.dms.sent.length === 1, 'the DM');
    expect(JSON.stringify(r.dms.sent[0])).toContain('ringing at your PC');
    r.heard(pipe, OWNER, 'stop'); // maybe someone in the call
    r.heard(pipe, OWNER, "I'm up");
    await sleep(100);
    expect(alarmsLeft(r.dir)).toBe(1);
    expect(conn.transcripts).toContain(CALL_PLAYS_HERE); // not just silence
    expect(conn.notices).toEqual(['ptt_only']); // and a chime, with the window closed
    conn.emit('ptt');
    r.heard(pipe, OWNER, 'snooze');
    await until(() => r.logged.some((l) => l.m === 'alarm snoozed'), 'the snooze');
    await r.stack.stop();
  });

  it('rings at the PC when they are not in her call, and stops from there', async () => {
    const r = await rig({}, { prepare: ringing });
    const { pipe } = r.connect();
    r.loggedIn();
    await until(() => r.logged.some((l) => l.m === 'alarm sound' && String(l.f.place).startsWith('sat:')), 'the ring at the PC');
    expect(r.stack.busy()).toBe(true);
    r.heard(pipe, OWNER, "I'm up");
    await until(() => alarmsLeft(r.dir) === 0, 'the alarm off');
    await r.stack.stop();
  });
});

describe('the local voice at start', () => {
  const kokoroFile = (dir: string) => writeFileSync(join(dir, 'model.onnx'), '');

  it('is loaded and calibrated when it speaks English', async () => {
    const r = await rig();
    expect(r.logged.some((l) => l.m === 'tts loaded and calibrated')).toBe(true);
    await r.stack.stop();
  });

  it('waits for its first use when the cloud voice speaks English, and stands in when the cloud fails', async () => {
    const r = await rig({ cloudVoice: { enabled: true } }, { prepare: kokoroFile });
    expect(r.logged.some((l) => l.m === 'tts loaded and calibrated')).toBe(false);
    expect(r.logged.some((l) => l.m === 'local voice loads on first use')).toBe(true);
    // The rig's fetch refuses Speechify: every line falls to the local voice.
    r.steps.push({ parts: [text('Canberra.'), usage(10, 2)] });
    r.heard(r.connect().pipe, OWNER, 'hey adrian capital', 'capital of australia');
    await until(() => r.tts.calls.includes('Canberra.'), 'the answer in the local voice');
    expect(r.warned).toContain('cloud voice failed; local voice for a minute');
    await r.stack.stop();
  });

  it('stands in for a long sentence the cloud voice would have streamed, loaded on the spot', async () => {
    const r = await rig({ cloudVoice: { enabled: true } }, { prepare: kokoroFile });
    expect(r.logged.some((l) => l.m === 'local voice loads on first use')).toBe(true);
    const long = 'Canberra is the capital, not Sydney, which surprises a lot of people.';
    expect(long.length).toBeGreaterThan(40);
    // The rig's fetch refuses Speechify, so the stream fails before any audio.
    r.steps.push({ parts: [text(long), usage(10, 2)] });
    r.heard(r.connect().pipe, OWNER, 'hey adrian capital', 'capital of australia');
    await until(() => r.tts.calls.includes(long), 'the long answer in the local voice');
    expect(r.warned).toContain('cloud voice failed; local voice for a minute');
    await r.stack.stop();
  });

  it('stays unloaded while the cloud voice works: answers, fixed replies and the short lines all go to the cloud', async () => {
    const cloudSaid: string[] = [];
    // Audible samples: the Speaker drops a sentence that is all silence, and the
    // stack then says its "didn't get that" line. Sentences over 40 characters
    // stream, so the stream is the cloud's too.
    const tone = () => Float32Array.from({ length: 960 }, (_, i) => 0.3 * Math.sin(i / 4));
    vi.spyOn(SpeechifyTts.prototype, 'synthesize').mockImplementation(async (t: string) => {
      cloudSaid.push(t);
      return { samples: tone(), sampleRate: 48_000, synthMs: 1 } as never;
    });
    vi.spyOn(SpeechifyTts.prototype, 'stream').mockImplementation(async function* (t: string) {
      cloudSaid.push(t);
      yield { samples: tone(), sampleRate: 48_000 };
    });
    const r = await rig({ cloudVoice: { enabled: true } }, { prepare: kokoroFile });
    r.loggedIn();
    const { pipe } = r.connect();
    r.steps.push({ parts: [text('Canberra.'), usage(10, 2)] });
    r.heard(pipe, OWNER, 'hey adrian capital', 'capital of australia');
    await until(() => cloudSaid.includes('Canberra.'), 'the answer in the cloud voice');
    r.heard(pipe, OWNER, 'hey adrian what time is it', 'what time is it');
    await until(() => cloudSaid.some((t) => t.startsWith("It's ")), 'the time, said without the model');
    await until(() => cloudSaid.includes('Yes?'), 'the short lines fetched at start');
    expect(r.tts.calls).toEqual([]);
    await r.stack.stop();
  });

  it('loads at start when the month of cloud characters is already spent', async () => {
    const r = await rig({ cloudVoice: { enabled: true, monthlyChars: 10 } }, {
      prepare: (dir) => {
        kokoroFile(dir);
        const month = new Date().toISOString().slice(0, 7);
        writeFileSync(join(dir, 'voice-usage.json'), JSON.stringify({ version: 1, months: { [month]: 10 } }));
      },
    });
    expect(r.logged.some((l) => l.m === 'tts loaded and calibrated')).toBe(true);
    await r.stack.stop();
  });
});

describe('someone with no PC connected', () => {
  const NO_PC = 'has no PC connected: never offer or use the pc_ tools for them.';

  it("is told so in their turn, while someone else's PC is connected", async () => {
    const r = await rig();
    r.connect(OWNER);
    r.heard(r.discordPipe, SAM, 'hey adrian lock the front door', 'lock the front door');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(asPrompt(r.llmBodies[0])).toContain(NO_PC);
    await r.stack.stop();
  });

  it('not when they have one, in the call or at it', async () => {
    const r = await rig();
    const { pipe } = r.connect(OWNER);
    r.heard(r.discordPipe, OWNER, 'hey adrian lock my pc', 'lock my pc');
    await until(() => r.stack.answers().length === 1, 'the call answer');
    r.heard(pipe, OWNER, 'hey adrian open spotify', 'open spotify');
    await until(() => r.llmBodies.length === 2, 'the PC answer');
    for (const b of r.llmBodies) expect(asPrompt(b)).not.toContain(NO_PC);
    await r.stack.stop();
  });

  it('not when PCs are off altogether', async () => {
    const r = await rig({ satellite: { enabled: false } });
    r.heard(r.discordPipe, SAM, 'hey adrian lock the front door', 'lock the front door');
    await until(() => r.llmBodies.length === 1, 'the model');
    expect(asPrompt(r.llmBodies[0])).not.toContain(NO_PC);
    await r.stack.stop();
  });
});
