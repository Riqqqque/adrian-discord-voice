import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfigFile, writeConfigFile } from '../src/web/secrets-file.js';

// chmod does next to nothing on Windows, so the mode is checked twice: on the
// call made here, and on the file wherever the platform keeps real modes.
const chmods = vi.hoisted(() => [] as [string, number][]);
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    chmodSync: (path: string, mode: number) => {
      chmods.push([path, mode]);
      fs.chmodSync(path, mode);
    },
  };
});

const BROKEN = '{\n  "guildId": "100000000000000010",\n  "owners": ["100000000000000030"],\n}\n';
const GOOD = { guildId: '100000000000000010', owners: ['100000000000000030'], music: { volume: 0.5 } };
const modeOf = (f: string) => statSync(f).mode & 0o777;

let dir = '';
let configFile = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adrian-config-'));
  configFile = join(dir, 'config.json');
  chmods.length = 0;
});

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Run the real CLI here: it does its work when imported. */
async function tool(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const argv = process.argv;
  process.argv = ['node', 'tool.js', ...args];
  vi.stubEnv('ADRIAN_CONFIG', configFile);
  vi.stubEnv('ADRIAN_STATE', join(dir, 'state'));
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => void out.push(String(s)));
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    err.push(String(s));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    throw new Exit(c ?? 0);
  }) as typeof process.exit);
  vi.resetModules();
  let code = 0;
  try {
    await import('../src/cli/tool.js');
    code = Number(process.exitCode ?? 0);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  } finally {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
  return { code, out: out.join('\n'), err: err.join('') };
}

describe('readConfigFile', () => {
  it('reads a config, and treats a missing file as no config yet', () => {
    writeFileSync(configFile, JSON.stringify(GOOD));
    expect(readConfigFile(configFile)).toEqual(GOOD);
    expect(readConfigFile(join(dir, 'nope.json'))).toBeUndefined();
  });

  it('throws on a file that does not parse, naming the file and the line', () => {
    writeFileSync(configFile, BROKEN);
    expect(() => readConfigFile(configFile)).toThrow(/config\.json.*line 4/);
  });

  it.each([['an empty file', ''], ['an array', '[]'], ['null', 'null'], ['a number', '42']])('throws on %s', (_, text) => {
    writeFileSync(configFile, text);
    expect(() => readConfigFile(configFile)).toThrow(/config\.json/);
  });

  it('throws when the file exists but cannot be read', () => {
    mkdirSync(configFile);
    expect(() => readConfigFile(configFile)).toThrow(/config\.json/);
  });
});

describe('writeConfigFile', () => {
  it('replaces the file and leaves nothing else behind', () => {
    writeFileSync(configFile, JSON.stringify(GOOD));
    writeConfigFile(configFile, { a: 1 });
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ a: 1 });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('gives a new file the installer mode, whatever the umask', () => {
    writeConfigFile(configFile, { a: 1 });
    expect(chmods).toEqual([[expect.stringContaining('config.json.'), 0o640]]);
  });

  it.skipIf(process.platform === 'win32')('the service umask does not cut the mode', () => {
    const umask = process.umask(0o077);
    try {
      writeConfigFile(configFile, { a: 1 });
    } finally {
      process.umask(umask);
    }
    expect(modeOf(configFile)).toBe(0o640);
  });
});

describe('adrian config on a config.json with a typo', () => {
  it.each([
    ['config', ['config', 'music.volume', '0.4']],
    ['voice', ['voice', 'af_heart', '1.1']],
  ])('%s fails and changes nothing', async (_, args) => {
    writeFileSync(configFile, BROKEN);
    const r = await tool(...args);
    expect(r.code).toBe(1);
    expect(r.err).toContain('config.json');
    expect(r.err).toContain('line 4');
    expect(r.err).toContain('Nothing was changed');
    expect(r.out).toBe('');
    expect(readFileSync(configFile, 'utf8')).toBe(BROKEN);
  });

  it('also refuses a file that parses but is not an object', async () => {
    writeFileSync(configFile, '[]\n');
    expect((await tool('config', 'music.volume', '0.4')).code).toBe(1);
    expect(readFileSync(configFile, 'utf8')).toBe('[]\n');
  });

  it('does not show made-up values', async () => {
    writeFileSync(configFile, BROKEN);
    expect((await tool('config', 'guildId')).code).toBe(1);
    expect((await tool('voice')).code).toBe(1);
  });

  it('check says what is wrong instead of listing everything as missing', async () => {
    writeFileSync(configFile, BROKEN);
    const r = await tool('check');
    expect(r.code).toBe(1);
    expect(r.err).toContain('config.json');
    expect(r.out).not.toContain('token');
  });

  it('secrets still work, and port still answers for the health check', async () => {
    writeFileSync(configFile, BROKEN);
    expect((await tool('secret-list')).code).toBe(0);
    const r = await tool('port');
    expect(r.code).toBe(0);
    expect(r.out).toBe('http 127.0.0.1 8790');
    expect(r.err).toContain('config.json');
  });
});

describe('adrian check', () => {
  // `adrian update` asks a new release this before switching: only 3 means no.
  it('answers 3, with the reasons, for a config the schema refuses', async () => {
    writeFileSync(configFile, JSON.stringify({ ...GOOD, music: { volume: 99 } }));
    const r = await tool('check');
    expect(r.code).toBe(3);
    expect(r.out).toContain('Config music.volume');
  });
});

describe('adrian config on a good file', () => {
  it('saves the change and keeps everything else', async () => {
    writeFileSync(configFile, JSON.stringify(GOOD));
    const r = await tool('config', 'music.volume', '0.4');
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ ...GOOD, music: { volume: 0.4 } });
    expect(readdirSync(dir).filter((f) => f.startsWith('config.json'))).toEqual(['config.json']);
  });

  it('keeps the mode the file has', async () => {
    writeFileSync(configFile, JSON.stringify(GOOD));
    chmodSync(configFile, 0o600);
    const mode = modeOf(configFile);
    chmods.length = 0;
    expect((await tool('voice', 'af_heart', '1.1')).code).toBe(0);
    expect(chmods).toEqual([[expect.stringContaining('config.json.'), mode]]);
    expect(modeOf(configFile)).toBe(mode);
  });

  it('a missing file is still fine: it just starts one', async () => {
    expect((await tool('config', 'music.volume', '0.4')).code).toBe(0);
    expect(existsSync(configFile)).toBe(true);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ music: { volume: 0.4 } });
  });

  it('a long ID stays exact (as a number it would lose digits), and a bad SteamID is refused', async () => {
    writeFileSync(configFile, JSON.stringify(GOOD));
    expect((await tool('config', 'steam.accounts.123456789012345678', '76561198000000001')).code).toBe(0);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).steam).toEqual({ accounts: { '123456789012345678': '76561198000000001' } });
    expect((await tool('config', 'steam.accounts.123456789012345678', '76561208000000001')).code).toBe(1);
    expect((await tool('config', 'steam.shareWithServer', 'true')).code).toBe(0);
  });
});
