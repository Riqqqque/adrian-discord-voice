import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canRecover, configProblems, StackManager } from '../src/app/manager.js';
import { createLogger } from '../src/core/logger.js';
import { UsageLedger } from '../src/limits/usage-ledger.js';
import { SecretsFile } from '../src/web/secrets-file.js';
import { applySettings } from '../src/web/settings.js';

const paths = { secretsFile: '/etc/adrian/secrets.env', stateDir: '/var/lib/adrian', modelsDir: '/var/lib/adrian/models' };

function manager(configFile: string): StackManager {
  const ledger = new UsageLedger(undefined, { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, 'UTC');
  return new StackManager(configFile, new SecretsFile(`${configFile}.secrets`), ledger, createLogger('error', () => undefined), paths);
}

describe('starting from the config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adrian-manager-'));

  it('fails with the reason when the file does not parse, and leaves it alone', async () => {
    const configFile = join(dir, 'config.json');
    const broken = '{\n  "guildId": "100000000000000010",\n}\n';
    writeFileSync(configFile, broken);
    const m = manager(configFile);
    await expect(m.restart()).resolves.toBe('failed');
    expect(m.error).toContain('config.json');
    expect(m.error).toContain('line 3');
    expect(() => m.rawConfig()).toThrow(/config\.json/);
    expect(readFileSync(configFile, 'utf8')).toBe(broken);
  });

  it('is plain setup mode when there is no file yet', async () => {
    const m = manager(join(dir, 'none.json'));
    await expect(m.restart()).resolves.toBe('setup');
    expect(m.error).toBeUndefined();
    expect(m.rawConfig().secretsFile).toBeDefined();
  });
});

describe('a start that failed', () => {
  // The shapes client.login really rejects with (checked against a local stub).
  const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
  const dns = coded('ENOTFOUND', 'getaddrinfo ENOTFOUND discord.com');
  const down = Object.assign(new Error('Service Unavailable'), { name: 'HTTPError', status: 503 });
  const badToken = Object.assign(new Error('An invalid token was provided.'), { name: 'DiscordjsError [TokenInvalid]', code: 'TokenInvalid' });

  it.each([
    ['a name that does not resolve', dns, true],
    ['DNS not up yet', coded('EAI_AGAIN'), true],
    ['nothing listening', coded('ECONNREFUSED'), true],
    ['a cut connection', coded('ECONNRESET'), true],
    ['no route', coded('ENETUNREACH'), true],
    ['undici timing out', coded('UND_ERR_CONNECT_TIMEOUT'), true],
    ['a request that ran out of time', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), true],
    ['Discord answering 503', down, true],
    ['the gateway answering 503', new Error('Unexpected server response: 503'), true],
    ['a network error wrapped by fetch', new TypeError('fetch failed', { cause: dns }), true],
    ['a bad token', badToken, false],
    ['Discord refusing the request', Object.assign(new Error('Forbidden'), { name: 'HTTPError', status: 403 }), false],
    ['intents that are off', new Error('Used disallowed intents'), false],
    ['a missing model', Object.assign(new Error("ENOENT: no such file or directory, open 'model.onnx'"), { code: 'ENOENT' }), false],
    ['a port in use', coded('EADDRINUSE'), false],
    ['a config that does not parse', new Error('/etc/adrian/config.json is not valid JSON: Expected double-quoted property name.'), false],
    ['a thrown string', 'ENOTFOUND', false],
  ])('%s: can it recover?', (_, e, yes) => {
    expect(canRecover(e)).toBe(yes);
  });

  describe('retrying', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adrian-retry-'));
    const configFile = join(dir, 'config.json');
    writeFileSync(
      configFile,
      JSON.stringify(applySettings({}, { guildId: '100000000000000010', channelId: '100000000000000020', llm: { preset: 'groq' }, fallback: { preset: 'none' }, search: false }, paths)),
    );
    const secrets = new SecretsFile(`${configFile}.secrets`);
    secrets.set('DISCORD_TOKEN', 'x');
    secrets.set('GROQ_API_KEY', 'y');
    const running = { stop: async () => undefined } as unknown as Awaited<ReturnType<StartFn>>;
    type StartFn = NonNullable<ConstructorParameters<typeof StackManager>[5]>;

    /** A manager whose start plays back `outcomes` (an error fails it), then succeeds. */
    function rig(outcomes: unknown[], file = configFile) {
      const start = vi.fn(async () => {
        const o = outcomes.shift();
        if (o) throw o;
        return running;
      });
      const ledger = new UsageLedger(undefined, { perUserPerHour: 30, dailyUsd: 1, monthlyUsd: 10 }, 'UTC');
      const m = new StackManager(file, secrets, ledger, createLogger('error', () => undefined), paths, start as unknown as StartFn);
      return { m, start };
    }

    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    it('comes up by itself once the network is back', async () => {
      const r = rig([dns]);
      await expect(r.m.restart()).resolves.toBe('failed');
      expect(r.m.error).toContain('ENOTFOUND');
      await vi.advanceTimersByTimeAsync(29_999);
      expect(r.start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(r.start).toHaveBeenCalledTimes(2);
      expect(r.m.state).toBe('running');
      expect(r.m.error).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('waits longer each time, up to five minutes', async () => {
      const r = rig(Array.from({ length: 7 }, () => dns));
      await r.m.restart();
      const waits: number[] = [];
      for (let i = 0; i < 6; i++) {
        const before = r.start.mock.calls.length;
        let waited = 0;
        while (r.start.mock.calls.length === before) {
          await vi.advanceTimersByTimeAsync(10_000);
          waited += 10_000;
        }
        waits.push(waited / 1000);
      }
      expect(waits).toEqual([30, 60, 120, 240, 300, 300]);
    });

    it('starts from the short wait again after it has run', async () => {
      const r = rig([dns, dns]);
      await r.m.restart();
      await vi.advanceTimersByTimeAsync(30_000 + 60_000);
      expect(r.m.state).toBe('running');
      r.start.mockImplementationOnce(async () => {
        throw dns;
      });
      await r.m.restart();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(r.m.state).toBe('running');
    });

    it('leaves what a wait can not fix failed, with its reason', async () => {
      const r = rig([badToken]);
      await expect(r.m.restart()).resolves.toBe('failed');
      expect(r.m.error).toContain('invalid token');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not loop on a config that does not parse', async () => {
      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{\n  "guildId": "100000000000000010",\n}\n');
      const r = rig([], broken);
      await expect(r.m.restart()).resolves.toBe('failed');
      expect(r.m.error).toContain('line 3');
      expect(r.start).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stop() ends the wait', async () => {
      const r = rig([dns, dns]);
      await r.m.restart();
      await r.m.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(r.start).toHaveBeenCalledTimes(1);
      expect(r.m.state).toBe('stopped');
    });

    it('stop() during a start that fails leaves nothing waiting', async () => {
      const r = rig([dns]);
      const started = r.m.restart();
      const stopped = r.m.stop();
      await Promise.all([started, stopped]);
      expect(vi.getTimerCount()).toBe(0);
      expect(r.m.state).toBe('stopped');
    });

    it('a restart by hand takes over from the wait', async () => {
      const r = rig([dns]);
      await r.m.restart();
      await expect(r.m.restart()).resolves.toBe('running');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(r.start).toHaveBeenCalledTimes(2);
    });
  });
});

describe('setup readiness', () => {
  it('lists what is missing in plain words', () => {
    const p = configProblems({ secretsFile: paths.secretsFile }, new Map());
    expect(p).toEqual([
      'The Discord bot token is not set.',
      'No Discord server and voice channel chosen.',
      'No language model chosen.',
      expect.stringContaining('Speech models are not configured'),
    ]);
  });

  it('is ready once the wizard has filled everything in', () => {
    const raw = applySettings(
      {},
      { guildId: '100000000000000010', channelId: '100000000000000020', llm: { preset: 'groq' }, fallback: { preset: 'none' }, search: false },
      paths,
    );
    expect(configProblems(raw, new Map([['DISCORD_TOKEN', 'x']]))).toEqual(['The language model key (GROQ_API_KEY) is not set.']);
    expect(configProblems(raw, new Map([['DISCORD_TOKEN', 'x'], ['GROQ_API_KEY', 'y']]))).toEqual([]);
  });

  it('still reports a malformed section that is present', () => {
    const raw = applySettings({}, { guildId: '100000000000000010', channelId: '100000000000000020', llm: { preset: 'groq' } }, paths);
    (raw.brain as Record<string, unknown>).baseUrl = 'not a url';
    const p = configProblems(raw, new Map([['DISCORD_TOKEN', 'x'], ['GROQ_API_KEY', 'y']]));
    expect(p.some((x) => x.startsWith('Config brain.baseUrl'))).toBe(true);
  });
});
