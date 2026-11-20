// The setup wizard's checks, offline: what a person sees for the usual
// mistakes (the wrong value pasted, a key for another service, a bot that
// can't speak in its channel) and for a start that failed.

import { describe, expect, it } from 'vitest';
import { checkDiscordToken, checkVoiceAccess, cleanToken, keyMismatch, llmError, tokenShapeProblem } from '../src/web/checks.js';
import { explainStartError } from '../src/web/explain.js';

// Token-shaped, assembled so secret scanners don't flag it.
const TOKEN = ['MTAwMDAwMDAwMDAwMDAwMDMw', 'Gabcde', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12'].join('.');
const GUILD = '100000000000000010';
const CHANNEL = '100000000000000020';
const BOT = '100000000000000001';
const ROLE = '100000000000000050';
const P = { view: 1n << 10n, connect: 1n << 20n, speak: 1n << 21n, admin: 1n << 3n };
const all = String(P.view | P.connect | P.speak);

const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** A fake Discord API for one server, one voice channel and the bot. */
function discord(o: { everyone?: string; role?: string; overwrites?: unknown[]; owner?: string; inGuild?: boolean; channel?: number; flags?: number; down?: boolean } = {}) {
  return (async (input: string | URL) => {
    if (o.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const u = String(input).replace('https://discord.com/api/v10', '');
    if (u === '/users/@me') return reply({ id: BOT, username: 'A.D.R.I.A.N.', discriminator: '0' });
    if (u === '/oauth2/applications/@me') return reply({ id: '100000000000000030', bot_public: false, flags: o.flags ?? 0 });
    if (u === '/users/@me/guilds') return reply([{ id: GUILD, name: 'Test' }]);
    if (o.inGuild === false && u.startsWith('/guilds/')) return reply({ message: 'Unknown Guild' }, 404);
    if (u === `/guilds/${GUILD}`) {
      return reply({
        id: GUILD,
        owner_id: o.owner ?? '100000000000000099',
        roles: [
          { id: GUILD, permissions: o.everyone ?? all },
          { id: ROLE, permissions: o.role ?? '0' },
        ],
      });
    }
    if (u === `/guilds/${GUILD}/members/${BOT}`) return reply({ roles: [ROLE] });
    if (u === `/channels/${CHANNEL}`) return o.channel ? reply({ message: 'Missing Access' }, o.channel) : reply({ id: CHANNEL, name: 'Lounge', type: 2, permission_overwrites: o.overwrites ?? [] });
    return reply({}, 404);
  }) as typeof fetch;
}

describe('a pasted Discord token', () => {
  it('works with "Bot " in front, quotes or spaces around it', () => {
    expect(cleanToken(`  "Bot ${TOKEN}" `)).toBe(TOKEN);
    expect(cleanToken(`bot ${TOKEN}`)).toBe(TOKEN);
  });

  it.each([
    ['100000000000000030', 'Application ID'],
    ['a'.repeat(64), 'Public Key'],
    ['AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'Client Secret'],
    ['hello there', "doesn't look like a bot token"],
  ])('%s is named for what it is, with where the token is', (value, what) => {
    const p = tokenShapeProblem(value)!;
    expect(p).toContain(what);
    expect(p).toContain('Reset Token');
  });

  it('a real-looking token goes on to Discord', () => {
    expect(tokenShapeProblem(TOKEN)).toBeUndefined();
  });

  it("says when Discord can't be reached at all, instead of a bare error", async () => {
    const r = await checkDiscordToken(TOKEN, discord({ down: true }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Could not reach Discord');
  });

  it('reports which privileged intents are on', async () => {
    const r = await checkDiscordToken(TOKEN, discord({ flags: (1 << 19) | (1 << 15) }));
    expect(r.intents).toEqual({ messageContent: true, members: true, presences: false });
    expect((await checkDiscordToken(TOKEN, discord())).intents).toEqual({ messageContent: false, members: false, presences: false });
  });
});

describe('can the bot be heard in its channel', () => {
  it('yes, with the default @everyone permissions', async () => {
    expect(await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord())).toMatchObject({ ok: true, channel: 'Lounge' });
  });

  it('no, when the channel takes Connect and Speak from @everyone', async () => {
    const r = await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord({ overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(P.connect | P.speak) }] }));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['Connect', 'Speak']);
    expect(r.error).toContain("can't Connect and Speak in Lounge");
    expect(r.error).toContain('Permissions');
  });

  it("yes, when the bot's role gets them back on that channel", async () => {
    const overwrites = [
      { id: GUILD, type: 0, allow: '0', deny: String(P.connect | P.speak) },
      { id: ROLE, type: 0, allow: String(P.connect | P.speak), deny: '0' },
    ];
    expect((await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord({ overwrites }))).ok).toBe(true);
  });

  it('no, when an overwrite for the bot itself denies Speak, whatever its roles allow', async () => {
    const overwrites = [{ id: ROLE, type: 0, allow: String(P.speak), deny: '0' }, { id: BOT, type: 1, allow: '0', deny: String(P.speak) }];
    expect((await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord({ overwrites }))).missing).toEqual(['Speak']);
  });

  it('yes, for an administrator role, overwrites or not', async () => {
    const overwrites = [{ id: GUILD, type: 0, allow: '0', deny: all }];
    expect((await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord({ everyone: '0', role: String(P.admin), overwrites }))).ok).toBe(true);
  });

  it('no, when the server gives @everyone nothing and the bot has no role that does', async () => {
    expect((await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord({ everyone: '0' }))).missing).toEqual(['View Channel', 'Connect', 'Speak']);
  });

  it("says when the bot isn't in the server, or can't see the channel", async () => {
    expect((await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord({ inGuild: false }))).error).toContain("isn't in that server");
    expect((await checkVoiceAccess(TOKEN, GUILD, CHANNEL, discord({ channel: 403 }))).error).toContain("can't see that voice channel");
  });
});

describe('a language-model key', () => {
  it("is refused before it's sent anywhere when it is plainly another service's", () => {
    expect(keyMismatch('claude', 'gsk_testtesttesttesttest')).toContain('looks like a Groq key, but Anthropic (Claude) is chosen');
    expect(keyMismatch('claude', 'gsk_testtesttesttesttest')).toContain('starts with sk-ant-');
    expect(keyMismatch('search', 'sk-ant-api03-test')).toContain('Anthropic');
    expect(keyMismatch('groq', 'gsk_testtesttesttesttest')).toBeUndefined();
    expect(keyMismatch('groq', 'some-new-key-format')).toBeUndefined();
  });

  it('with no credit left says so, and where to add it, instead of "could not reach"', () => {
    const anthropic = llmError(400, 'Claude API 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.', 'claude-haiku');
    expect(anthropic).toContain('no credit left');
    expect(anthropic).toContain('console.anthropic.com');
    expect(llmError(429, '{"error":{"code":"insufficient_quota"}}', 'm')).toContain('no credit left');
  });

  it('for a model the key can not use, names it', () => {
    expect(llmError(404, 'model_not_found', 'gemini-9')).toContain('gemini-9');
  });

  it('on a provider outage says to try later or switch', () => {
    expect(llmError(503, 'overloaded', 'm')).toContain('Try again in a few minutes');
  });
});

describe('a start that failed', () => {
  it.each([
    ['An invalid token was provided.', 'Reset Token'],
    ['Used disallowed intents', 'Privileged Gateway Intents'],
    ['DiscordAPIError[50001]: Missing Access', 'View Channel, Connect and Speak'],
    ['DiscordAPIError[10003]: Unknown Channel', 'Pick another one'],
    ['getaddrinfo ENOTFOUND discord.com', 'DNS'],
    ['connect ETIMEDOUT 192.0.2.1:443', 'firewall'],
    ["ENOENT: no such file or directory, open '/var/lib/adrian/models/kokoro-multi-lang-v1_0/model.onnx'", 'adrian update'],
    ['EACCES: permission denied, open /var/lib/adrian/usage.json', 'adrian doctor'],
    ['Config limits.dailyUsd: Too big', 'adrian check'],
  ])('%s comes with what to do', (error, fix) => {
    expect(explainStartError(error)).toContain(fix);
  });

  it('adds nothing for a reason it does not know', () => {
    expect(explainStartError('something new went wrong')).toBeUndefined();
    expect(explainStartError(null)).toBeUndefined();
  });
});
