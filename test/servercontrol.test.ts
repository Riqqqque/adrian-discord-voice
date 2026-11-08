import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HelixClient, HelixError } from '../src/features/helix.js';
import {
  chatText,
  clean,
  playerNames,
  playerTarget,
  rejectedText,
  resolveServer,
  safeCommand,
  ServerControl,
  TOKEN_MISSING,
  whitelistReply,
  type ControlledServer,
  type ControlSettings,
} from '../src/features/servercontrol.js';
import type { McStatus } from '../src/features/gameservers.js';
import type { ToolContext } from '../src/core/interfaces.js';

// --- a fake Helix gateway -------------------------------------------------

const SURVIVAL = 'helix:0b9a6c7e-5d0f-4f7e-8f0e-2f6d2b1c9a41';
const CREATIVE = 'helix:1c8b5d6f-4e0a-4b3c-9d2e-3a5c7b9d1e20';
const TOKEN = 'A'.repeat(43);

interface Inst {
  status: 'online' | 'starting' | 'stopped';
  players: number;
  busy?: string | null;
  container?: Record<string, unknown>;
}
interface Job {
  id: string;
  server: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  stage: string | null;
  result: unknown;
  error: string | null;
}
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | 'hang' | undefined;

class MockHelix {
  insts = new Map<string, Inst>();
  jobs = new Map<string, Job>();
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> | undefined }[] = [];
  /** Answer a request yourself (return undefined to let the mock handle it). */
  override?: (op: string, body: Record<string, unknown> | undefined, path: string) => Reply;
  /** How a lifecycle job ends, and after how many ms. */
  jobPlan: { ms: number; status: 'complete' | 'failed'; error?: string; detail?: Record<string, unknown> } = { ms: 0, status: 'complete' };
  console: (cmd: string) => Reply | string = () => '';
  waitRefused = false;
  inFlight = 0;
  maxInFlight = 0;
  private n = 0;
  server = http.createServer((req, res) => this.handle(req, res));
  url = '';

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  ops(op: string) {
    return this.requests.filter((r) => r.body?.operation === op);
  }

  private send(res: http.ServerResponse, r: Exclude<Reply, 'hang' | undefined>) {
    res.writeHead(r.status, { 'content-type': r.raw !== undefined ? 'text/html' : 'application/json', ...r.headers });
    res.end(r.raw ?? JSON.stringify(r.body ?? {}));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = data ? (JSON.parse(data) as Record<string, unknown>) : undefined;
      this.requests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body });
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      const done = (r: Exclude<Reply, 'hang' | undefined>) => {
        this.inFlight--;
        this.send(res, r);
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return done({ status: 401, body: { code: 'authentication_required', message: 'Authentication is required.' } });
      if (req.headers.origin || req.headers.cookie) return done({ status: 403, body: { code: 'authorization_denied', message: 'mixed credentials' } });
      const op = String(body?.operation ?? '');
      const o = this.override?.(op, body, url.pathname);
      if (o === 'hang') return void (this.inFlight--, setTimeout(() => res.destroy(), 3000));
      if (o) return done(o);
      if (req.method === 'GET' && url.pathname === '/api/v1/automation/jobs') return done({ status: 200, body: { jobs: [...this.jobs.values()].map((j) => ({ job_id: j.id, server_id: j.server })) } });
      const wait = /^\/api\/v1\/automation\/jobs\/([^/]+)\/wait$/.exec(url.pathname);
      if (wait) {
        if (this.waitRefused) return done({ status: 403, body: { code: 'authorization_denied', message: 'no' } });
        // Waits run at a tenth of real time, so tests stay quick.
        const until = Date.now() + Number(url.searchParams.get('timeout_seconds') ?? 12) * 100;
        while (Date.now() < until && !['complete', 'failed'].includes(this.jobs.get(wait[1]!)?.status ?? 'complete')) await new Promise((r) => setTimeout(r, 10));
        const j = this.jobs.get(wait[1]!);
        if (!j) return done({ status: 403, body: { code: 'authorization_denied', message: 'no' } });
        return done({ status: 200, body: { ...this.record(j), finished: j.status === 'complete' || j.status === 'failed' } });
      }
      const inst = this.insts.get(String(body?.instance_id ?? ''));
      if (op === 'job_status') {
        const j = this.jobs.get(String(body?.job_id));
        return j ? done({ status: 200, body: this.record(j) }) : done({ status: 403, body: { code: 'authorization_denied', message: 'no' } });
      }
      if (!inst) return done({ status: 403, body: { code: 'authorization_denied', message: 'not on token' } });
      if (op === 'server_capabilities') return done({ status: 200, body: { manager: 'helix', game: 'minecraft' } });
      if (op === 'server_detail')
        return done({
          status: 200,
          body: { status: inst.status, ready: inst.status === 'online', busy_with: inst.busy ?? null, players_online: inst.players, max_players: 20, container_state: inst.container ?? { Running: inst.status !== 'stopped', ExitCode: 0 } },
        });
      if (op === 'server_console') {
        if (inst.status === 'stopped') return done({ status: 400, body: { code: 'broker_operation_rejected', message: 'start the server before using its console' } });
        const r = this.console(String(body?.command));
        return typeof r === 'string' ? done({ status: 200, body: { response: r } }) : r === 'hang' ? void (this.inFlight--, res.destroy()) : done(r!);
      }
      if (op === 'server_action') {
        const action = String(body?.action);
        const id = `job-${++this.n}`;
        const job: Job = { id, server: String(body?.instance_id), status: 'running', stage: 'Waiting until the game is ready', result: null, error: null };
        this.jobs.set(id, job);
        const plan = this.jobPlan;
        const finish = () => {
          job.status = plan.status;
          if (plan.status === 'failed') job.error = plan.error ?? 'it broke';
          else {
            const was = inst.status !== 'stopped';
            inst.status = action === 'stop' ? 'stopped' : 'online';
            job.result = { instance_id: job.server, action, accepted: true, detail: { online: action !== 'stop', ...(action === 'start' ? { already_running: was } : action === 'stop' ? { already_stopped: !was } : { previously_running: was }), ...plan.detail } };
          }
        };
        if (plan.ms === 0) finish();
        else if (plan.ms > 0) setTimeout(finish, plan.ms);
        return done({ status: 200, body: { job_id: id, reused: false } });
      }
      return done({ status: 400, body: { code: 'invalid_json', message: 'unknown operation' } });
    });
  }
  private record(j: Job) {
    return { id: j.id, kind: 'server_action', status: j.status, stage: j.stage, progress_percent: 50, result: j.result, error: j.error };
  }
}

// --- the control under test ---------------------------------------------------

const OWNER = '111111111111111111';
const FRIEND = '222222222222222222';
const MOD = '333333333333333333';
const MOD_ROLE = '444444444444444444';

const servers: ControlledServer[] = [
  { name: 'Survival', host: '127.0.0.1', port: 25565, kind: 'minecraft', helix: { instanceId: SURVIVAL, bedrock: true, bedrockPrefix: '.' } },
  { name: 'Creative', host: '127.0.0.1', port: 25566, kind: 'minecraft', helix: { instanceId: CREATIVE, bedrock: false, bedrockPrefix: '.' } },
  { name: 'Old World', host: '127.0.0.1', port: 25567, kind: 'minecraft' },
];

let mock: MockHelix;
let announced: { userId: string; text: string }[];
let logs: { msg: string; fields?: Record<string, unknown> }[];
let pings: Record<number, McStatus>;
const settings = (over: Partial<ControlSettings> = {}): ControlSettings => ({
  allow: { start: [], stop: [], restart: [], whitelist: [], say: [], ...over.allow },
  startWaitSec: 30,
  stopWaitSec: 30,
  sayMaxChars: 200,
  ...over,
});
const logger = () => {
  const push = (msg: string, fields?: Record<string, unknown>) => void logs.push({ msg, ...(fields ? { fields } : {}) });
  return { debug: push, info: push, warn: push, error: push };
};

function make(o: { token?: boolean; settings?: ControlSettings; list?: ControlledServer[]; client?: HelixClient } = {}) {
  return new ServerControl({
    servers: o.list ?? servers,
    client: o.token === false ? undefined : (o.client ?? new HelixClient({ url: mock.url, token: TOKEN, timeoutMs: 2000 })),
    settings: o.settings ?? settings(),
    isOwner: (id) => id === OWNER,
    hasRole: (id, _g, roles) => id === MOD && roles.includes(MOD_ROLE),
    announce: (to, text) => void announced.push({ userId: to.userId, text }),
    log: logger(),
    ping: async (_h, port) => pings[port] ?? { online: false, error: 'offline' },
    timing: { inlineSec: 1, pollMs: 30, retryMs: 30, verifyMs: 20 },
  });
}
const ctx = (userId = OWNER, turn = 1, said = ''): ToolContext => ({ userId, speaker: userId === OWNER ? 'Alex' : 'Sam', channelId: '555555555555555555', turn, said });
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

beforeAll(async () => {
  mock = new MockHelix();
  await mock.start();
});
afterAll(() => mock.server.close());
beforeEach(() => {
  mock.insts = new Map([
    [SURVIVAL, { status: 'online', players: 0 }],
    [CREATIVE, { status: 'online', players: 0 }],
  ]);
  mock.jobs.clear();
  mock.requests = [];
  mock.override = undefined;
  mock.jobPlan = { ms: 0, status: 'complete' };
  mock.console = () => '';
  mock.waitRefused = false;
  mock.maxInFlight = 0;
  announced = [];
  logs = [];
  pings = {};
});
afterEach(() => {
  // Nothing in this file may ever carry the token, a cookie or an Origin.
  for (const r of mock.requests) {
    expect(r.headers.origin).toBeUndefined();
    expect(r.headers.cookie).toBeUndefined();
  }
  expect(JSON.stringify(logs)).not.toContain(TOKEN);
});

describe('the Helix client', () => {
  it('sends only the bearer token and JSON headers, one request at a time', async () => {
    const c = new HelixClient({ url: `${mock.url}/`, token: TOKEN });
    mock.override = (op) => (op === 'server_detail' ? undefined : undefined);
    await Promise.all([c.detail(SURVIVAL), c.detail(CREATIVE), c.detail(SURVIVAL)]);
    expect(mock.maxInFlight).toBe(1);
    const h = mock.requests[0]!.headers;
    expect(h.authorization).toBe(`Bearer ${TOKEN}`);
    expect(h['content-type']).toBe('application/json');
    expect(mock.requests[0]!.path).toBe('/api/v1/automation/server');
  });

  it('maps every refusal to its own kind', async () => {
    const c = new HelixClient({ url: mock.url, token: TOKEN, sleep: async () => {} });
    const kind = async () => c.detail(SURVIVAL).then(() => 'ok', (e: HelixError) => e.failure.kind);
    mock.override = () => ({ status: 401, body: { code: 'authentication_required', message: 'x' } });
    expect(await kind()).toBe('auth');
    mock.override = () => ({ status: 403, body: { code: 'authorization_denied', message: 'x' } });
    expect(await kind()).toBe('denied');
    mock.override = () => ({ status: 400, body: { code: 'invalid_json', message: 'x' } });
    expect(await kind()).toBe('invalid');
    mock.override = () => ({ status: 503, body: { code: 'host_broker_unavailable', message: 'x' } });
    expect(await kind()).toBe('broker');
    mock.override = () => ({ status: 421, raw: '<html>421</html>' });
    expect(await kind()).toBe('gateway');
    mock.override = () => ({ status: 400, body: { code: 'broker_operation_rejected', message: 'a backup (started 3 seconds ago) is still running on this server, so a server action was not started. Try again when it finishes.' } });
    const e = await c.detail(SURVIVAL).catch((x: HelixError) => x.failure);
    expect(e).toEqual({ kind: 'rejected', message: expect.stringContaining('is still running') });
  });

  it('retries a full request line a few times, then gives up', async () => {
    const c = new HelixClient({ url: mock.url, token: TOKEN, sleep: async () => {} });
    let n = 0;
    mock.override = () => (++n <= 2 ? { status: 503, body: { code: 'request_capacity_exhausted', message: 'x' }, headers: { 'retry-after': '1' } } : undefined);
    expect((await c.detail(SURVIVAL)).status).toBe('online');
    expect(n).toBe(3);
    mock.override = () => ({ status: 503, body: { code: 'request_capacity_exhausted', message: 'x' } });
    await expect(c.detail(SURVIVAL)).rejects.toMatchObject({ failure: { kind: 'busy' } });
  });

  it('a 429 (either code) pauses every request until Retry-After', async () => {
    let t = 1_000_000;
    for (const code of ['token_rate_limited', 'too_many_attempts']) {
      const c = new HelixClient({ url: mock.url, token: TOKEN, now: () => t });
      mock.override = () => ({ status: 429, body: { code, message: 'x' }, headers: { 'retry-after': code === 'too_many_attempts' ? '900' : '60' } });
      await expect(c.detail(SURVIVAL)).rejects.toMatchObject({ failure: { kind: 'rate' } });
      mock.override = undefined;
      const before = mock.requests.length;
      await expect(c.detail(SURVIVAL)).rejects.toMatchObject({ failure: { kind: 'rate' } });
      expect(mock.requests.length).toBe(before); // never sent
      t += 901_000;
      expect((await c.detail(SURVIVAL)).status).toBe('online');
    }
  });

  it('keeps under its own ceiling a minute', async () => {
    const c = new HelixClient({ url: mock.url, token: TOKEN, perMinute: 2, now: () => 5 });
    await c.detail(SURVIVAL);
    await c.detail(SURVIVAL);
    await expect(c.detail(SURVIVAL)).rejects.toMatchObject({ failure: { kind: 'rate' } });
    expect(mock.requests.length).toBe(2);
  });

  it('never follows a redirect (it would carry the token)', async () => {
    let hit = 0;
    const other = http.createServer((_q, s) => ((hit++, s.end('{}'))));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    mock.override = () => ({ status: 302, raw: '', headers: { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/` } });
    const c = new HelixClient({ url: mock.url, token: TOKEN });
    await expect(c.detail(SURVIVAL)).rejects.toMatchObject({ failure: { kind: 'gateway', status: 302 } });
    expect(hit).toBe(0);
    other.close();
  });

  it('nothing listening is "unreachable"; a change with no answer is "lost"', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    const c = new HelixClient({ url: `http://127.0.0.1:${port}`, token: TOKEN });
    await expect(c.action(SURVIVAL, 'restart')).rejects.toMatchObject({ failure: { kind: 'unreachable' } });
    mock.override = () => 'hang';
    const slow = new HelixClient({ url: mock.url, token: TOKEN, timeoutMs: 200 });
    await expect(slow.action(SURVIVAL, 'restart')).rejects.toMatchObject({ failure: { kind: 'lost' } });
    await expect(slow.detail(SURVIVAL)).rejects.toMatchObject({ failure: { kind: 'unreachable' } });
  });
});

describe('which server', () => {
  const list = [{ name: 'Survival' }, { name: 'Creative' }, { name: 'Creative Hardcore' }];
  it('exact, part, word and near misses; ambiguity is a question', () => {
    expect(resolveServer('survival', list)).toEqual({ server: list[0] });
    expect(resolveServer('the survival server', list)).toEqual({ server: list[0] });
    expect(resolveServer('survivor', list)).toEqual({ server: list[0] }); // speech recognition
    expect(resolveServer('hardcore', list)).toEqual({ server: list[2] });
    expect(resolveServer('creative', list)).toEqual({ server: list[1] });
    expect(resolveServer('creativ', list)).toEqual({ reply: 'Which one: Creative or Creative Hardcore?', ask: true });
    expect(resolveServer('', list)).toEqual({ reply: 'Which server: Survival, Creative or Creative Hardcore?', ask: true });
    expect(resolveServer('the server', [list[0]!])).toEqual({ server: list[0] });
    expect(resolveServer('skyblock', list)).toEqual({ reply: 'There\'s no server called "skyblock". The servers are Survival, Creative and Creative Hardcore.' });
    expect(resolveServer('x', [])).toEqual({ reply: 'No game servers are set up.' });
  });
});

describe('start, stop, restart', () => {
  it('without the token or a link it says so in one sentence and sends nothing', async () => {
    expect(await make({ token: false }).lifecycle('start', 'survival', ctx())).toBe(TOKEN_MISSING);
    expect(await make().lifecycle('start', 'old world', ctx())).toBe("Old World isn't linked to Helix, so I can only check whether it's up.");
    expect(mock.requests).toHaveLength(0);
  });

  it('owners by default; others by user or role ID', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    expect(await make().lifecycle('start', 'survival', ctx(FRIEND))).toBe('Only the owners can start Survival.');
    const s = settings({ allow: { start: [FRIEND, MOD_ROLE], stop: [], restart: [MOD], whitelist: [], say: [] } });
    expect(await make({ settings: s }).lifecycle('restart', 'survival', ctx(FRIEND))).toBe("You're not on the list of people who can restart Survival.");
    expect(await make({ settings: s }).lifecycle('stop', 'survival', ctx(FRIEND))).toBe('Only the owners can stop Survival.');
    expect(await make({ settings: s }).lifecycle('start', 'survival', ctx(FRIEND))).toBe('Survival is up.');
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    expect(await make({ settings: s }).lifecycle('start', 'survival', ctx(MOD))).toBe('Survival is up.');
    expect(logs.find((l) => l.fields?.result === 'not allowed')?.fields).toMatchObject({ action: 'start', server: 'Survival', by: FRIEND });
  });

  it('start: done within the tool, already up, already starting', async () => {
    const c = make();
    expect(await c.lifecycle('start', 'survival', ctx())).toBe('Survival is already up.');
    mock.insts.get(SURVIVAL)!.players = 2;
    expect(await c.lifecycle('start', 'survival', ctx())).toBe('Survival is already up, with 2 on.');
    mock.insts.get(SURVIVAL)!.status = 'starting';
    expect(await c.lifecycle('start', 'survival', ctx())).toBe('Survival is already starting.');
    expect(mock.ops('server_action')).toHaveLength(0);
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    expect(await c.lifecycle('start', 'survival', ctx())).toBe('Survival is up.');
    expect(mock.ops('server_action')[0]!.body).toEqual({ operation: 'server_action', instance_id: SURVIVAL, action: 'start' });
    const audit = logs.filter((l) => l.msg === 'game server action').map((l) => l.fields?.result);
    expect(audit).toEqual(['started', 'complete']);
  });

  it('a long start is announced once it is up; a second asker joins the same job', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    mock.jobPlan = { ms: 400, status: 'complete' };
    const c = make();
    expect(await c.lifecycle('start', 'survival', ctx(OWNER))).toBe("Starting Survival. I'll tell you when it's up.");
    expect(c.busyWith(SURVIVAL)).toBe('start');
    const s = settings({ allow: { start: [FRIEND], stop: [], restart: [], whitelist: [], say: [] } });
    void s;
    expect(await c.lifecycle('start', 'survival', ctx(OWNER, 2))).toBe("Survival is already starting. I'll tell you when it's up.");
    expect(await c.status('survival')).toContain('starting now (Waiting until the game is ready)');
    expect(await c.lifecycle('stop', 'survival', ctx(OWNER, 3))).toMatch(/^Survival is busy: Alex asked to start it just now/);
    await until(() => announced.length > 0);
    expect(announced).toEqual([{ userId: OWNER, text: 'Survival is up.' }]);
    expect(mock.ops('server_action')).toHaveLength(1);
    expect(c.busyWith(SURVIVAL)).toBeUndefined();
  });

  it('two yeses at once send one restart', async () => {
    mock.insts.get(SURVIVAL)!.players = 1;
    mock.jobPlan = { ms: 300, status: 'complete' };
    const s = settings({ allow: { start: [], stop: [], restart: [FRIEND], whitelist: [], say: [] } });
    const c = make({ settings: s });
    expect(await c.lifecycle('restart', 'survival', ctx(OWNER, 1))).toBe('1 person is on Survival. Restart it anyway?');
    expect(await c.lifecycle('restart', 'survival', ctx(FRIEND, 1))).toBe('1 person is on Survival. Restart it anyway?');
    const [x, y] = await Promise.all([c.lifecycle('restart', 'survival', ctx(OWNER, 2, 'yes')), c.lifecycle('restart', 'survival', ctx(FRIEND, 2, 'yeah restart it'))]);
    expect([x, y].sort()).toEqual(["Restarting Survival. I'll tell you when it's back.", "Survival is already restarting. I'll tell you when it's back."].sort());
    expect(mock.ops('server_action')).toHaveLength(1);
    await until(() => announced.length === 2);
    expect(announced.map((a) => a.text)).toEqual(['Survival is back up.', 'Survival is back up.']);
  });

  it('stop and restart need their own yes on their very next turn', async () => {
    mock.insts.get(SURVIVAL)!.players = 3;
    const c = make();
    const tools = c.tools();
    const control = tools.find((t) => t.spec.name === 'game_server_control')!;
    const q = await control.run({ action: 'stop', server: 'survival' }, AbortSignal.timeout(5000), ctx(OWNER, 1));
    expect(q).toBe('3 people are on Survival. Stop it anyway?');
    expect(control.asks!(q)).toBe(true);
    expect(control.speak!({}, q, ctx())).toBe(q);
    // "Okay" is not a yes; the question is used up.
    expect(await c.lifecycle('stop', 'survival', ctx(OWNER, 2, 'okay'))).toBe('3 people are on Survival. Stop it anyway?');
    // A yes two turns later doesn't count.
    expect(await c.lifecycle('stop', 'survival', ctx(OWNER, 4, 'yes'))).toBe('3 people are on Survival. Stop it anyway?');
    // Someone else's yes doesn't count.
    expect(await c.lifecycle('stop', 'survival', ctx(FRIEND, 5, 'yes'))).toBe('Only the owners can stop Survival.');
    expect(mock.ops('server_action')).toHaveLength(0);
    expect(await c.lifecycle('stop', 'survival', ctx(OWNER, 5, 'yes stop survival'))).toBe('Survival is stopped.');
    expect(mock.ops('server_action')).toHaveLength(1);
    expect(await c.lifecycle('stop', 'survival', ctx(OWNER, 6))).toBe('Survival is already stopped.');
  });

  it('nobody on: the question is short; a stopped server restarts as a plain start', async () => {
    const c = make();
    expect(await c.lifecycle('restart', 'creative', ctx())).toBe('Restart Creative?');
    mock.insts.get(CREATIVE)!.status = 'stopped';
    expect(await c.lifecycle('restart', 'creative', ctx(OWNER, 5))).toBe("Creative was stopped, so I'm starting it. Creative is up.");
    expect(mock.ops('server_action')[0]!.body?.action).toBe('start');
  });

  it('a backup or other Helix job blocks it before any question', async () => {
    mock.insts.get(SURVIVAL)!.busy = 'a backup (started 40 seconds ago)';
    expect(await make().lifecycle('restart', 'survival', ctx())).toBe('Helix is busy with a backup (started 40 seconds ago) on Survival. Try again when it finishes.');
    mock.insts.get(SURVIVAL)!.busy = null;
    mock.insts.get(SURVIVAL)!.status = 'starting';
    expect(await make().lifecycle('stop', 'survival', ctx())).toBe("Survival is still starting. Try again once it's up.");
    expect(mock.ops('server_action')).toHaveLength(0);
  });

  it('a job that fails says why, including a lock taken in the meantime', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    mock.jobPlan = { ms: 0, status: 'failed', error: 'Java said: §cError\nUnrecognized VM option' };
    expect(await make().lifecycle('start', 'survival', ctx())).toBe("Survival didn't start: Java said: Error Unrecognized VM option.");
    mock.jobPlan = { ms: 0, status: 'failed', error: 'an update (started 2 minutes ago) is still running on this server, so a server action was not started. Try again when it finishes.' };
    expect(await make().lifecycle('start', 'survival', ctx())).toBe('Helix is busy with an update (started 2 minutes ago) on Survival. Try again when it finishes.');
  });

  it('staged changes that failed to install are mentioned', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    mock.jobPlan = { ms: 0, status: 'complete', detail: { pending_error: 'plugins/X.jar: checksum mismatch' } };
    expect(await make().lifecycle('start', 'survival', ctx())).toBe("Survival is up. Staged file changes didn't install: plugins/X.jar: checksum mismatch.");
  });

  it('falls back to job_status polling where the wait route is refused', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    mock.jobPlan = { ms: 200, status: 'complete' };
    mock.waitRefused = true;
    expect(await make().lifecycle('start', 'survival', ctx())).toBe("Starting Survival. I'll tell you when it's up.");
    await until(() => announced.length > 0);
    expect(announced[0]!.text).toBe('Survival is up.');
    expect(mock.ops('job_status').length).toBeGreaterThan(0);
  });

  it('gives up after its limit, after one last look', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    mock.jobPlan = { ms: -1, status: 'complete' }; // never finishes
    const c = make({ settings: settings({ startWaitSec: 1 }) });
    expect(await c.lifecycle('start', 'survival', ctx())).toBe("Starting Survival. I'll tell you when it's up.");
    await until(() => announced.length > 0, 8000);
    expect(announced[0]!.text).toBe("Survival still isn't up after 1 minute. I've stopped watching; check the Helix panel.");
    expect(c.busyWith(SURVIVAL)).toBeUndefined();
    expect(logs.find((l) => l.fields?.result === 'gave up')).toBeTruthy();
  });

  it('a token revoked while it waits: says it lost access', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    mock.jobPlan = { ms: -1, status: 'complete' };
    const c = make();
    expect(await c.lifecycle('start', 'survival', ctx())).toBe("Starting Survival. I'll tell you when it's up.");
    mock.override = () => ({ status: 401, body: { code: 'authentication_required', message: 'x' } });
    await until(() => announced.length > 0);
    expect(announced[0]!.text).toBe("I lost access to Helix while Survival was starting, so I can't tell how it went. Check the panel.");
  });

  it('a lost answer is never sent again: it finds the job, or says it cannot tell', async () => {
    mock.insts.get(SURVIVAL)!.players = 0;
    const client = new HelixClient({ url: mock.url, token: TOKEN, timeoutMs: 300 });
    const c = make({ client });
    expect(await c.lifecycle('restart', 'survival', ctx(OWNER, 1))).toBe('Restart Survival?');
    mock.override = (op) => (op === 'server_action' ? 'hang' : undefined);
    expect(await c.lifecycle('restart', 'survival', ctx(OWNER, 2, 'yes'))).toBe("I didn't hear back from Helix, so I can't tell whether Survival restarted. Check the panel before asking again.");
    expect(mock.ops('server_action')).toHaveLength(1);
    // This time Helix took it before the answer was lost: the new job is watched.
    mock.override = (op, body) => {
      if (op !== 'server_action') return undefined;
      mock.jobs.set('job-lost', { id: 'job-lost', server: String(body?.instance_id), status: 'complete', stage: null, result: { detail: { previously_running: true } }, error: null });
      return 'hang';
    };
    expect(await c.lifecycle('restart', 'survival', ctx(OWNER, 3))).toBe('Restart Survival?');
    expect(await c.lifecycle('restart', 'survival', ctx(OWNER, 4, 'yes'))).toBe('Survival is back up.');
    expect(mock.ops('server_action')).toHaveLength(2);
  });

  it('a reused job is joined, and Helix errors become sentences', async () => {
    mock.insts.get(SURVIVAL)!.status = 'stopped';
    mock.override = (op) => (op === 'server_action' ? { status: 200, body: { job_id: 'job-x', reused: true } } : undefined);
    mock.jobs.set('job-x', { id: 'job-x', server: SURVIVAL, status: 'running', stage: null, result: null, error: null });
    expect(await make().lifecycle('start', 'survival', ctx())).toBe("Survival is already starting. I'll tell you when it's up.");
    mock.override = (op) => (op === 'server_detail' ? { status: 403, body: { code: 'authorization_denied', message: 'x' } } : undefined);
    expect(await make().lifecycle('start', 'survival', ctx())).toBe("The Helix token isn't allowed to do that on Survival: it needs Survival on its server list and the View permission.");
    mock.override = (op) => (op === 'server_action' ? { status: 403, body: { code: 'authorization_denied', message: 'x' } } : undefined);
    expect(await make().lifecycle('start', 'survival', ctx())).toBe("The Helix token isn't allowed to do that on Survival: it needs Survival on its server list and the Start permission.");
    mock.override = () => ({ status: 401, body: { code: 'authentication_required', message: 'x' } });
    expect(await make().lifecycle('start', 'survival', ctx())).toMatch(/^Helix turned down my token/);
    mock.override = () => ({ status: 429, body: { code: 'token_rate_limited', message: 'x' }, headers: { 'retry-after': '60' } });
    expect(await make().lifecycle('start', 'survival', ctx())).toBe('Helix asked me to slow down. Try again in a minute.');
    mock.override = () => ({ status: 421, raw: 'Misdirected' });
    expect(await make().lifecycle('start', 'survival', ctx())).toMatch(/helix\.url must be the dashboard address/);
  });

  it('Helix down: one sentence, no question', async () => {
    const c = make({ client: new HelixClient({ url: 'http://127.0.0.1:1', token: TOKEN }) });
    expect(await c.lifecycle('stop', 'survival', ctx())).toBe("I can't reach Helix right now.");
  });
});

describe('status', () => {
  it('merges Helix state with the status ping', async () => {
    pings[25565] = { online: true, players: 2, max: 20, names: ['Steve', 'Alex'], version: 'Paper 26.3' };
    mock.insts.get(CREATIVE)!.status = 'stopped';
    mock.insts.get(CREATIVE)!.container = { Running: false, ExitCode: 1 };
    const c = make();
    const out = await c.status('');
    expect(out).toBe(['Survival: up, 2 of 20 players; on now: Steve, Alex; version Paper 26.3', 'Creative: stopped; it crashed last time (exit code 1)', 'Old World: down (offline)'].join('\n'));
  });

  it('out of memory, stuck starting, a Helix job, and names from the console', async () => {
    mock.insts.get(CREATIVE)!.status = 'stopped';
    mock.insts.get(CREATIVE)!.container = { Running: false, OOMKilled: true, ExitCode: 137 };
    expect(await make().status('creative')).toBe('Creative: stopped; it ran out of memory last time');
    mock.insts.get(CREATIVE)!.status = 'starting';
    mock.insts.get(CREATIVE)!.container = { Running: true, StartedAt: new Date(Date.now() - 15 * 60_000).toISOString() };
    mock.insts.get(CREATIVE)!.busy = 'a server action (started 15 minutes ago)';
    expect(await make().status('creative')).toBe('Creative: starting, for 15 minutes now, so it may be stuck; Helix is busy with a server action (started 15 minutes ago)');
    mock.insts.get(SURVIVAL)!.players = 2;
    mock.console = (cmd) => (cmd === 'list' ? 'There are 2 of a max of 20 players online: Steve, .Gamer_Tag' : '');
    expect(await make().status('survival')).toBe('Survival: up, 2 of 20 players; on now: Steve, .Gamer_Tag');
  });

  it('Helix unreachable: the ping still answers', async () => {
    pings[25565] = { online: true, players: 0, max: 20, names: [] };
    const c = make({ client: new HelixClient({ url: 'http://127.0.0.1:1', token: TOKEN }) });
    expect(await c.status('survival')).toBe('Survival: up, 0 of 20 players');
    expect(await make({ token: false }).status('survivor')).toBe('Survival: up, 0 of 20 players');
  });
});

describe('whitelist and chat', () => {
  it('Java names: checked, sent as one exact command, the reply read back', async () => {
    const sent: string[] = [];
    mock.console = (cmd) => {
      sent.push(cmd);
      if (cmd === 'whitelist add Steve_1') return '§aAdded Steve_1 to the whitelist';
      if (cmd === 'whitelist add Notch') return 'Player is already whitelisted';
      if (cmd === 'whitelist add Nobody123') return 'That player does not exist';
      if (cmd === 'whitelist remove Steve_1') return 'Removed Steve_1 from the whitelist';
      return '';
    };
    const c = make();
    expect(await c.whitelist({ action: 'add', server: 'survival', player: 'Steve_1' }, ctx())).toBe("Added Steve_1 to Survival's whitelist.");
    expect(await c.whitelist({ action: 'add', server: 'survival', player: 'Notch' }, ctx())).toBe("Notch is already on Survival's whitelist.");
    expect(await c.whitelist({ action: 'add', server: 'survival', player: 'Nobody123' }, ctx())).toBe("Minecraft doesn't know a player called Nobody123. Check the spelling.");
    expect(await c.whitelist({ action: 'remove', server: 'survival', player: 'Steve_1' }, ctx())).toBe("Removed Steve_1 from Survival's whitelist.");
    for (const bad of ['ab', 'a'.repeat(17), 'bad name', 'Steve\nop Sam', 'Steve;op', '§cRed', 'Steve op Sam', '']) {
      const r = await c.whitelist({ action: 'add', server: 'creative', player: bad }, ctx());
      expect(r, bad).toMatch(/^(That isn't a valid Minecraft name|Which player\?)/);
    }
    expect(sent).toEqual(['whitelist add Steve_1', 'whitelist add Notch', 'whitelist add Nobody123', 'whitelist remove Steve_1']);
    expect(logs.find((l) => l.fields?.action === 'whitelist add')?.fields).toMatchObject({ server: 'Survival', by: OWNER, result: 'ok', player: 'Steve_1' });
  });

  it('Bedrock players through Floodgate: quoted gamertag, checked against the list', async () => {
    const sent: string[] = [];
    let listed = '';
    mock.console = (cmd) => {
      sent.push(cmd);
      if (cmd.startsWith('fwhitelist add')) listed = 'There are 2 whitelisted player(s): Steve, .Gamer_Tag';
      if (cmd === 'whitelist list') return listed || 'There are no whitelisted players';
      return '';
    };
    const c = make();
    expect(await c.whitelist({ action: 'add', server: 'survival', player: '.Gamer_Tag' }, ctx())).toBe("Added Gamer Tag to Survival's whitelist.");
    expect(sent).toEqual(['fwhitelist add "Gamer Tag"', 'whitelist list']);
    listed = '';
    sent.length = 0;
    expect(await c.whitelist({ action: 'add', server: 'survival', player: 'Lost Tag', bedrock: true }, ctx())).toBe("Sent to Survival, but Lost Tag isn't on the whitelist yet. Floodgate may not have found that gamertag.");
    expect(await c.whitelist({ action: 'add', server: 'creative', player: 'Some Tag', bedrock: true }, ctx())).toBe("Creative isn't set up for Bedrock players.");
    expect(await c.whitelist({ action: 'add', server: 'survival', player: 'Bad"Tag', bedrock: true }, ctx())).toMatch(/^That isn't a gamertag/);
    mock.console = (cmd) => (cmd.startsWith('fwhitelist') ? 'Unknown or incomplete command, see below for error' : '');
    expect(await c.whitelist({ action: 'add', server: 'survival', player: 'Gamer', bedrock: true }, ctx())).toBe("Survival doesn't have Floodgate, so it can't whitelist Bedrock players.");
  });

  it('list, permission, and a stopped server', async () => {
    mock.console = (cmd) => (cmd === 'whitelist list' ? 'There are 3 whitelisted player(s): Steve, Alex and .Gamer_Tag' : '');
    const c = make();
    expect(await c.whitelist({ action: 'list', server: 'survival' }, ctx())).toBe("3 on Survival's whitelist: Steve, Alex, .Gamer_Tag.");
    expect(await c.whitelist({ action: 'list', server: 'survival' }, ctx(FRIEND))).toBe("Only the owners can change Survival's whitelist.");
    mock.insts.get(CREATIVE)!.status = 'stopped';
    expect(await c.whitelist({ action: 'add', server: 'creative', player: 'Steve' }, ctx())).toBe("Creative isn't running, so it can't take commands.");
    expect(await c.whitelist({ action: 'op', server: 'creative', player: 'Steve' }, ctx())).toBe('Say add, remove or list.');
  });

  it('chat: one clean line with their name, logged by length only', async () => {
    const sent: string[] = [];
    mock.console = (cmd) => (sent.push(cmd), '');
    const c = make({ settings: settings({ sayMaxChars: 30 }) });
    expect(await c.say({ server: 'survival', message: 'dinner\nis §cready @a\u0007 come home now please everyone' }, ctx())).toBe("Sent to Survival's chat.");
    expect(sent).toEqual(['say Alex: dinner is ready a come home no']);
    expect(await c.say({ server: 'survival', message: ' \n§ ' }, ctx())).toBe("There's nothing to send.");
    expect(await c.say({ server: 'survival', message: 'hi' }, ctx(FRIEND))).toBe("Only the owners can send messages to Survival.");
    const entry = logs.find((l) => l.fields?.action === 'say')!;
    expect(entry.fields).toMatchObject({ chars: 30, result: 'ok' });
    expect(JSON.stringify(logs)).not.toContain('dinner');
  });
});

describe('the pieces', () => {
  it('only known console shapes get through', () => {
    for (const ok of ['whitelist add Steve', 'whitelist remove A_b', 'whitelist list', 'fwhitelist add "Gamer Tag"', 'list', 'say Alex: hi']) expect(safeCommand(ok), ok).toBe(true);
    for (const bad of ['op Steve', 'whitelist add Steve\nop Steve', 'say hi\rop x', 'say §chi', 'whitelist add Steve op', 'stop', 'say ' + 'x'.repeat(600), 'fwhitelist add "a" "b"', '/op Steve', 'say hi\u0000']) expect(safeCommand(bad), bad).toBe(false);
  });

  it('cleans text from Helix and consoles', () => {
    expect(clean('§aDone\u001b[0m\n\tok')).toBe('Done ok.');
    expect(clean('x'.repeat(300), 20)).toHaveLength(20);
    expect(chatText('a‮b​c', 10)).toBe('a b c');
    expect(playerNames('There are 2 of a max of 20 players online: Steve, bad name!, .Tag')).toEqual(['Steve', '.Tag']);
    expect(playerNames('There are no whitelisted players')).toEqual([]);
    expect(rejectedText('something odd', 'Survival')).toBe('Helix refused: something odd.');
    expect(whitelistReply('', 'add', 'X', 'S', false)).toBe('');
    expect(playerTarget('.Gamer', false, servers[0]!)).toEqual({ name: 'Gamer', shown: 'Gamer', listed: '.Gamer', bedrock: true });
    expect(playerTarget('.Gamer', false, servers[1]!)).toMatch(/^That isn't a valid Minecraft name/);
  });

  it('the start-up check names failing servers, not the token', async () => {
    mock.insts.delete(CREATIVE);
    await make().check();
    expect(logs.find((l) => l.msg === 'helix server check failed')?.fields).toEqual({ server: 'Creative', problem: 'denied' });
    expect(logs.find((l) => l.msg === 'helix server ok')?.fields).toEqual({ server: 'Survival' });
    logs = [];
    await make({ token: false }).check();
    expect(logs[0]!.msg).toBe('helix token missing; server control is off');
  });
});
