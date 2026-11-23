import { describe, expect, it } from 'vitest';
import { isLocalBase, type ModelInfo, ModelPicker, modelTool } from '../src/brain/models.js';
import { PocConfigSchema } from '../src/config.js';
import { modelCommands } from '../src/app/model-commands.js';

const OWNER = '100000000000000001';
const GUEST = '200000000000000001';

const models: ModelInfo[] = [
  { name: 'main', model: 'quick-1', local: false, ownersOnly: false },
  { name: 'smart', model: 'big-2', local: false, ownersOnly: true, about: 'careful writing' },
  { name: 'cheap', model: 'tiny-1', local: false, ownersOnly: false },
  { name: 'private', model: 'llama-local', local: true, ownersOnly: false },
];

function rig(o: ConstructorParameters<typeof ModelPicker>[1] = {}) {
  let now = 1_000_000;
  const p = new ModelPicker(models, { now: () => now, ...o });
  const tool = modelTool({ picker: p, isOwner: (id) => id === OWNER });
  const run = (by: string, args: Record<string, unknown>) => tool.run(args, AbortSignal.timeout(1000), { userId: by, speaker: 'x' }) as Promise<string>;
  return { p, tool, run, advance: (ms: number) => (now += ms) };
}

describe('model picker', () => {
  it('uses the main model unless a job has its own', () => {
    const r = rig({ routes: { writing: 'smart', background: 'private' } });
    expect(r.p.pick(GUEST, 'chat', false).name).toBe('main');
    expect(r.p.pick(GUEST, 'writing', false).name).toBe('smart');
    expect(r.p.pick(GUEST, 'background', false).name).toBe('private');
  });

  it('a switch lasts while they keep talking and ends half an hour after', async () => {
    const r = rig();
    expect(await r.run(OWNER, { action: 'use', model: 'smart' })).toBe('Okay, using smart for you now.');
    expect(r.p.pick(OWNER, 'chat', true).name).toBe('smart');
    r.advance(29 * 60_000);
    expect(r.p.pick(OWNER, 'chat', true).name).toBe('smart');
    r.advance(29 * 60_000);
    expect(r.p.pick(OWNER, 'chat', true).name).toBe('smart');
    r.advance(31 * 60_000);
    expect(r.p.pick(OWNER, 'chat', true).name).toBe('main');
  });

  it('only owners switch by default; everyone may when set; off means nobody', async () => {
    const r = rig();
    expect(await r.run(GUEST, { action: 'use', model: 'cheap' })).toMatch(/^Not done: only the bot's owners/);
    expect(r.p.pick(GUEST, 'chat', false).name).toBe('main');
    const e = rig({ switching: 'everyone' });
    expect(await e.run(GUEST, { action: 'use', model: 'cheap' })).toBe('Okay, using cheap for you now.');
    expect(await e.run(GUEST, { action: 'use', model: 'smart' })).toMatch(/smart model is for the bot's owners/);
    const off = rig({ switching: 'off' });
    expect(await off.run(OWNER, { action: 'use', model: 'smart' })).toMatch(/turned off/);
  });

  it('finds a model by its name, "the X model" or its model id, and says what there is', async () => {
    const r = rig();
    expect(r.p.find('Smart model')?.name).toBe('smart');
    expect(r.p.find('llama-local')?.name).toBe('private');
    expect(await r.run(OWNER, { action: 'use', model: 'genius' })).toBe("Not done: I don't have a model called genius. I have main, smart, cheap, private.");
    expect(await r.run(GUEST, { action: 'list' })).toBe('Models: main; smart, careful writing, owners only; cheap; private (runs here).');
    expect(await r.run(GUEST, { action: 'which' })).toBe("You're on the usual one, main (quick-1).");
    await r.run(OWNER, { action: 'use', model: 'private' });
    expect(await r.run(OWNER, { action: 'which' })).toBe("Right now you're on private (runs here) (llama-local).");
    expect(await r.run(OWNER, { action: 'reset' })).toBe('Okay, back to main.');
    expect(await r.run(OWNER, { action: 'reset' })).toBe("You're already on main.");
  });

  it('guests move to the cheap model when the budget runs low; owners keep theirs', () => {
    const r = rig({ lowBudget: { model: 'cheap', at: 0.8 }, routes: { writing: 'smart' } });
    expect(r.p.pick(GUEST, 'chat', false, 0.79).name).toBe('main');
    expect(r.p.pick(GUEST, 'chat', false, 0.8).name).toBe('cheap');
    expect(r.p.pick(GUEST, 'writing', false, 0.95).name).toBe('cheap');
    expect(r.p.pick(OWNER, 'writing', true, 0.95).name).toBe('smart');
  });

  it("a guest's switch to an owners-only model never sticks", () => {
    const r = rig();
    r.p.use(GUEST, models[1]!);
    expect(r.p.pick(GUEST, 'chat', false).name).toBe('main');
  });

  it('is offered for talk about models, not for everything', () => {
    const route = rig().tool.route!;
    for (const t of ['use the smart model for this', 'switch to private', 'what model are you on', 'go back to normal', 'can you use something faster'])
      expect([t, route.test(t)]).toEqual([t, true]);
    for (const t of ['play some lofi', 'what time is it', 'remind me at five']) expect([t, route.test(t)]).toEqual([t, false]);
  });

  it('switching and resetting are actions; which and list only look', () => {
    const acts = rig().tool.acts as (a: Record<string, unknown>) => boolean;
    expect([acts({ action: 'use' }), acts({ action: 'reset' }), acts({ action: 'which' }), acts({ action: 'list' })]).toEqual([true, true, false, false]);
  });
});

describe('/model', () => {
  it('builds for a full list with long descriptions', () => {
    const many: ModelInfo[] = Array.from({ length: 13 }, (_, i) => ({ name: `m${i}`, model: `x-${i}`, local: false, ownersOnly: false, about: 'a'.repeat(80) }));
    const [cmd] = modelCommands(new ModelPicker(many)) as { name: string; options: { name: string; options?: { choices?: { name: string }[] }[] }[] }[];
    expect(cmd!.name).toBe('model');
    expect(cmd!.options.map((o) => o.name)).toEqual(['list', 'which', 'use', 'reset']);
    const choices = cmd!.options[2]!.options![0]!.choices!;
    expect(choices).toHaveLength(13);
    expect(Math.max(...choices.map((c) => c.name.length))).toBeLessThanOrEqual(100);
  });
});

describe('isLocalBase', () => {
  it('accepts loopback, private networks and local names', () => {
    for (const u of ['http://127.0.0.1:11434/v1', 'http://localhost:8080', 'http://10.0.0.5/v1', 'http://192.168.1.20:11434', 'http://172.20.0.1', 'http://100.100.1.1', 'http://[::1]:11434', 'http://[fd00::5]/v1', 'http://gpu-box:8000', 'http://llm.lan', 'http://box.local'])
      expect([u, isLocalBase(u)]).toEqual([u, true]);
  });
  it('refuses public hosts', () => {
    for (const u of ['https://api.anthropic.com', 'https://api.groq.com/openai/v1', 'http://8.8.8.8', 'http://172.32.0.1', 'http://[2001:db8::1]', 'not a url'])
      expect([u, isLocalBase(u)]).toEqual([u, false]);
  });
});

describe('brain.models config', () => {
  const base = { guildId: '123456789012345678', channelId: '123456789012345679', secretsFile: '/etc/adrian/secrets.env' };
  const brain = (extra: object) => ({ provider: 'anthropic', model: 'quick-1', apiKeySecret: 'ANTHROPIC_API_KEY', ...extra });
  const parse = (extra: object) => PocConfigSchema.safeParse({ ...base, brain: brain(extra) });

  it('is optional: a config without it parses as before', () => {
    const r = parse({});
    expect(r.success).toBe(true);
    expect(r.data!.brain!.models).toBeUndefined();
  });

  it('takes a list with routes, a fallback and a low-budget pick', () => {
    const r = parse({
      models: [
        { name: 'smart', provider: 'anthropic', model: 'big-2', apiKeySecret: 'ANTHROPIC_API_KEY', priceInPerM: 3, priceOutPerM: 15, maxTokens: 4000, fallback: 'main' },
        { name: 'private', model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
      ],
      routes: { writing: 'smart', background: 'private' },
      lowBudget: { model: 'main' },
    });
    expect(r.success).toBe(true);
    expect(r.data!.brain!.lowBudget).toEqual({ model: 'main', atPercent: 80 });
  });

  it('refuses a cloud model without prices, a fake local one, a local one falling back to the cloud, and unknown names', () => {
    const msgs = (extra: object) => (parse(extra).error?.issues ?? []).map((i) => i.message).join(' | ');
    expect(msgs({ models: [{ name: 'smart', model: 'big' }] })).toMatch(/needs its prices/);
    expect(msgs({ models: [{ name: 'private', model: 'x', baseUrl: 'https://api.example.com/v1', local: true }] })).toMatch(/loopback or private/);
    expect(msgs({ models: [{ name: 'private', model: 'x', baseUrl: 'http://127.0.0.1:1/v1', local: true, fallback: 'main' }] })).toMatch(/only fall back to another local/);
    expect(msgs({ models: [{ name: 'private', model: 'x', baseUrl: 'http://127.0.0.1:1/v1', local: true }], routes: { writing: 'genius' } })).toMatch(/no model called genius/);
    expect(msgs({ models: [{ name: 'main', model: 'x', baseUrl: 'http://127.0.0.1:1/v1', local: true }] })).toMatch(/used twice/);
  });
});
