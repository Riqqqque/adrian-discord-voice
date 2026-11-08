import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/core/interfaces.js';
import { routeTools } from '../src/brain/tool-router.js';
import { PocConfigSchema, privateHost, SECRET_PURPOSE } from '../src/config.js';
import { redact } from '../src/core/logger.js';

const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/etc/adrian/secrets.env' };
const server = { name: 'Survival', host: '127.0.0.1', port: 25565 };
const parse = (extra: Record<string, unknown>) => PocConfigSchema.safeParse({ ...base, ...extra });

describe('helix config', () => {
  it('needs the dashboard address: https, or http on the home network, nothing after the port', () => {
    for (const ok of ['http://192.168.1.50:3100', 'http://192.168.1.50:3100/', 'http://127.0.0.1:3100', 'http://10.0.0.5:3100', 'http://100.100.1.2:3100', 'https://helix.example.com']) expect(parse({ helix: { url: ok } }).success, ok).toBe(true);
    for (const bad of ['http://203.0.113.9:3100', 'http://helix.example.com', 'ftp://192.168.1.50', 'http://user:pw@192.168.1.50:3100', 'http://192.168.1.50:3100/api', 'http://192.168.1.50:3100/?x=1', 'not a url'])
      expect(parse({ helix: { url: bad } }).success, bad).toBe(false);
    expect(parse({}).success).toBe(true); // off unless set
  });

  it('defaults: owners only, generous waits', () => {
    const r = parse({ helix: { url: 'http://192.168.1.50:3100' } });
    expect(r.success && r.data.helix).toEqual({ url: 'http://192.168.1.50:3100', allow: { start: [], stop: [], restart: [], whitelist: [], say: [] }, startWaitSec: 420, stopWaitSec: 180, sayMaxChars: 200 });
    expect(parse({ helix: { url: 'http://192.168.1.50:3100', allow: { restart: ['123456789012345678'] } } }).success).toBe(true);
    expect(parse({ helix: { url: 'http://192.168.1.50:3100', allow: { restart: ['Alex'] } } }).success).toBe(false);
  });

  it('a server links by its exact Helix ID; Bedrock is opt-in', () => {
    const r = parse({ gameServers: [{ ...server, helix: { instanceId: 'helix:0b9a6c7e-5d0f-4f7e-8f0e-2f6d2b1c9a41' } }] });
    expect(r.success && r.data.gameServers[0]!.helix).toEqual({ instanceId: 'helix:0b9a6c7e-5d0f-4f7e-8f0e-2f6d2b1c9a41', bedrock: false, bedrockPrefix: '.' });
    for (const bad of ['0b9a6c7e', 'helix:', 'helix:a b', 'helix:x\ny', 'Survival']) expect(parse({ gameServers: [{ ...server, helix: { instanceId: bad } }] }).success, bad).toBe(false);
    for (const bad of ['ab', 'a', ' ', '§']) expect(parse({ gameServers: [{ ...server, helix: { instanceId: 'helix:x', bedrockPrefix: bad } }] }).success, bad).toBe(false);
    expect(parse({ gameServers: [{ ...server }] }).success).toBe(true); // status only, as before
  });

  it('HELIX_TOKEN has its own purpose: no model, search or voice setting can take it', () => {
    expect(SECRET_PURPOSE.HELIX_TOKEN).toBe('helix');
    expect(parse({ brain: { model: 'm', apiKeySecret: 'HELIX_TOKEN' } }).success).toBe(false);
    expect(parse({ brain: { model: 'm', search: { apiKeySecret: 'HELIX_TOKEN' } } }).success).toBe(false);
    expect(parse({ cloudVoice: { apiKeySecret: 'HELIX_TOKEN' } }).success).toBe(false);
  });

  it('private addresses', () => {
    expect(['localhost', '127.0.0.1', '192.168.1.50', '172.20.0.1', '[::1]', 'fd12::1'].every(privateHost)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', 'example.com', '192.169.0.1'].some(privateHost)).toBe(false);
  });

  it('bearer tokens never reach the log', () => {
    expect(redact('{"auth":"Bearer ' + 'Ab_-'.repeat(11) + '"}')).toBe('{"auth":"[redacted]"}');
  });
});

describe('routing', () => {
  const names = ['get_time', 'web_search', 'game_server_status', 'game_server_control', 'game_server_whitelist', 'game_server_say', 'plex_search'];
  const all = names.map((name) => ({ spec: { name, description: '', parameters: {} }, run: async () => '' }) as Tool);
  const pick = (t: string) => routeTools(all, t).map((x) => x.spec.name);
  it('server orders reach the server tools', () => {
    for (const t of ['restart the survival server', 'start survival', 'whitelist Steve on creative', "tell everyone on survival that dinner's ready", 'add my friend to the whitelist', 'can you reboot the smp'])
      expect(pick(t), t).toContain('game_server_control');
    expect(pick('what is the capital of Peru')).toEqual(['get_time', 'web_search']);
  });
});
