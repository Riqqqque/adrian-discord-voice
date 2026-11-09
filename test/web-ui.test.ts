// The real web/app.js, run against a small fake DOM and a fake API: there is no
// DOM library in this repo, and a real browser isn't needed to see what a button
// does when a request fails.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Kid = El | string;

class El {
  children: Kid[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => unknown)[]> = {};
  className = '';
  value = '';
  checked = false;
  disabled = false;
  style: Record<string, string> = {};
  scrollTop = 0;
  scrollHeight = 0;
  classList = { contains: (c: string) => this.className.split(' ').includes(c) };
  constructor(readonly tag: string) {}
  append(...kids: Kid[]) {
    this.children.push(...kids);
  }
  replaceChildren(...kids: Kid[]) {
    this.children = kids;
  }
  addEventListener(type: string, f: (e: unknown) => unknown) {
    (this.listeners[type] ??= []).push(f);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(t: string) {
    this.children = t ? [t] : [];
  }
  click() {
    return Promise.all((this.listeners.click ?? []).map((f) => f({ preventDefault() {} })));
  }
  submit() {
    return Promise.all((this.listeners.submit ?? []).map((f) => f({ preventDefault() {} })));
  }
  /** This element and everything under it. */
  all(): El[] {
    return [this, ...this.children.flatMap((c) => (typeof c === 'string' ? [] : c.all()))];
  }
}

const PRESETS = [
  { id: 'claude', label: 'Claude Haiku (Recommended)', note: 'Quick.', keySecret: 'ANTHROPIC_API_KEY' },
  { id: 'groq', label: 'Groq', note: 'Free.', keySecret: 'GROQ_API_KEY' },
];
const STATUS = {
  state: 'running',
  version: '1',
  voiceReady: true,
  botTag: 'A.D.R.I.A.N.#0671',
  uptimeS: 60,
  error: null,
  problems: [],
  warnings: [] as string[],
  latency: { stt: {}, llmFirst: {}, ttsFirst: {}, speechEndToAudio: {} },
  spend: { today: { costUsd: 0, requests: 0 }, monthUsd: 0, limits: {}, history: [] },
};
const SETTINGS = {
  guildId: null,
  channelId: null,
  timezone: 'UTC',
  voice: { voice: 'af_heart', speed: 1 },
  limits: {},
  llm: { preset: 'claude', model: 'claude-haiku' },
  fallback: { preset: 'none' },
  search: false,
};

type Reply = { status?: number; body?: unknown } | 'offline';
type Route = (method: string, body: Record<string, unknown> | undefined) => Reply;

/** Boots the page. `routes` overrides the fake API; `sent` is every call it got. */
async function page(routes: Record<string, Route> = {}, search = '', settings: unknown = SETTINGS, stored = ['ANTHROPIC_API_KEY']) {
  const els: Record<string, El> = { app: new El('main'), who: new El('span'), notice: new El('div') };
  const ticks: (((...a: unknown[]) => unknown) | undefined)[] = [];
  const sent: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const api: Record<string, Route> = {
    '/api/session': () => ({ body: { loggedIn: true, username: 'admin', csrf: 'x' } }),
    '/api/status': () => ({ body: STATUS }),
    '/api/settings': () => ({ body: { settings, presets: PRESETS, voices: ['af_heart'], ok: true } }),
    '/api/secrets': () => ({ body: { secrets: stored.map((name) => ({ name })) } }),
    '/api/logs': () => ({ body: { lines: [] } }),
    ...routes,
  };
  const sandbox = {
    document: { getElementById: (id: string) => els[id], createElement: (t: string) => new El(t) },
    window: { scrollTo() {} },
    location: { search },
    Node: El,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    queueMicrotask,
    setInterval: (f: () => unknown) => ticks.push(f),
    clearInterval: (id: number | undefined) => {
      if (id) ticks[id - 1] = undefined;
    },
    fetch: async (path: string, init: { method: string; body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      sent.push({ method: init.method, path, ...(body ? { body } : {}) });
      const r = (api[path] ?? (() => ({ status: 404, body: { error: 'not found' } })))(init.method, body);
      if (r === 'offline') throw new TypeError('Failed to fetch');
      const status = r.status ?? 200;
      return { ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => r.body ?? {} };
    },
  };
  vm.runInNewContext(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), sandbox);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  await settle();
  const app = els.app!;
  return {
    api,
    sent,
    settle,
    notice: () => els.notice!.textContent,
    text: () => app.textContent,
    puts: () => sent.filter((s) => s.method === 'PUT' && s.path === '/api/settings').map((s) => s.body),
    /** The 5 s refresh. */
    tick: async () => {
      await Promise.all(ticks.filter(Boolean).map((f) => f!()));
      await settle();
    },
    timers: () => ticks.filter(Boolean).length,
    button: (name: string, nth = 0) => app.all().filter((e) => e.tag === 'button' && e.textContent === name)[nth]!,
    radio: (value: string, nth = 0) => app.all().filter((e) => e.attrs.type === 'radio' && e.value === value)[nth],
    radios: () => app.all().filter((e) => e.attrs.type === 'radio'),
    keyBoxes: () => app.all().filter((e) => e.attrs.type === 'password'),
    form: () => app.all().find((e) => e.tag === 'form')!,
    logOut: async () => {
      await els.who!.all().find((e) => e.tag === 'button')!.click();
      await settle();
    },
    press: async (name: string, nth = 0) => {
      await app.all().filter((e) => e.tag === 'button' && e.textContent === name)[nth]!.click();
      await settle();
    },
  };
}
type Page = Awaited<ReturnType<typeof page>>;

const failing: Route = () => ({ status: 500, body: { error: 'the disk is full' } });
const loggedOut: Route = () => ({ status: 401, body: { error: 'log in first' } });
/** From now on the service has no session for this page. */
const sessionEnds = (p: Page) => {
  p.api['/api/session'] = () => ({ body: { loggedIn: false } });
  for (const path of ['/api/status', '/api/settings', '/api/secrets', '/api/logs']) p.api[path] = loggedOut;
};

describe('a session that ended', () => {
  it('takes an open dashboard back to the login page on its next refresh', async () => {
    const p = await page();
    expect(p.text()).toContain('Dashboard');
    expect(p.timers()).toBe(1);
    sessionEnds(p);
    await p.tick();
    expect(p.text()).toContain('Log in');
    expect(p.text()).toContain('Your session ended');
    expect(p.text()).not.toContain('Dashboard');
    expect(p.timers()).toBe(0);
    expect(p.notice()).toBe('');
  });

  it('takes a save back to the login page instead of doing nothing', async () => {
    const p = await page({}, '?step=4');
    sessionEnds(p);
    p.api['/api/settings'] = loggedOut;
    await p.press('Save and continue');
    expect(p.text()).toContain('Your session ended');
  });

  it('says so once, not at a later logout', async () => {
    const p = await page();
    sessionEnds(p);
    await p.tick();
    expect(p.text()).toContain('Your session ended');
    p.api['/api/login'] = () => ({ body: { ok: true, csrf: 'y' } });
    p.api['/api/session'] = () => ({ body: { loggedIn: true, username: 'admin', csrf: 'y' } });
    p.api['/api/status'] = () => ({ body: STATUS });
    await p.form().submit();
    await p.settle();
    expect(p.text()).toContain('Dashboard');
    sessionEnds(p);
    p.api['/api/logout'] = () => ({ body: { ok: true } });
    await p.logOut();
    await p.tick(); // the refresh that was running when they logged out
    expect(p.text()).toContain('Log in');
    expect(p.text()).not.toContain('session ended');
    expect(p.timers()).toBe(0);
  });

  it('leaves a wrong password on the login page, saying so', async () => {
    let tries = 0;
    const p = await page({
      '/api/session': () => ({ body: { loggedIn: false } }),
      '/api/login': () => {
        tries++;
        return { status: 401, body: { error: 'wrong username or password' } };
      },
    });
    expect(p.text()).not.toContain('session ended');
    await p.form().submit();
    await p.settle();
    expect(tries).toBe(1);
    expect(p.text()).toContain('wrong username or password');
    expect(p.text()).not.toContain('session ended');
  });
});

describe('a button whose request fails', () => {
  it.each([
    ['Voice', '?step=4', 'Save and continue'],
    ['Language model', '?step=2', 'Save and continue'],
  ])('%s says why, beside the button', async (_n, search, label) => {
    const p = await page({}, search);
    p.api['/api/settings'] = (m) => (m === 'PUT' ? failing(m, undefined) : { body: { settings: SETTINGS, presets: PRESETS, voices: ['af_heart'] } });
    await p.press(label);
    expect(p.text()).toContain('the disk is full');
    expect(p.button(label).disabled).toBe(false);
  });

  it('Search says why, beside the button', async () => {
    const p = await page({}, '?step=3', { ...SETTINGS, search: false, llm: SETTINGS.llm });
    p.api['/api/settings'] = (m) => (m === 'PUT' ? failing(m, undefined) : { body: { settings: SETTINGS, presets: PRESETS, voices: ['af_heart'] } });
    await p.press('Save and continue');
    expect(p.text()).toContain('the disk is full');
  });

  it('Delete key says why, beside the button', async () => {
    const p = await page({ '/api/secrets/ANTHROPIC_API_KEY': (m) => (m === 'DELETE' ? { status: 500, body: { error: 'the disk is full' } } : {}) });
    await p.press('Keys');
    await p.press('Delete');
    expect(p.text()).toContain('the disk is full');
  });

  it('Restart bot says why at the top of the page', async () => {
    const p = await page({ '/api/restart': failing });
    await p.press('Restart bot');
    expect(p.notice()).toContain('the disk is full');
    expect(p.button('Restart bot').disabled).toBe(false);
  });

  it('a tab says why at the top of the page, until a view opens', async () => {
    const p = await page({ '/api/secrets': failing });
    await p.press('Keys');
    expect(p.notice()).toContain('the disk is full');
    p.api['/api/secrets'] = () => ({ body: { secrets: [] } });
    await p.press('Keys');
    expect(p.notice()).toBe('');
  });

  it('the Keys tab lists the Helix and Steam keys before they are set', async () => {
    const p = await page({ '/api/secrets': () => ({ body: { secrets: [] } }) });
    await p.press('Keys');
    expect(p.text()).toContain('HELIX_TOKEN');
    expect(p.text()).toContain('STEAM_API_KEY');
  });

  it('Back says why at the top of the page', async () => {
    const p = await page({}, '?step=2');
    p.api['/api/check/discord'] = failing;
    p.api['/api/secrets'] = failing;
    await p.press('Back');
    expect(p.notice()).toContain('the disk is full');
  });
});

describe('a service that went quiet', () => {
  it('says so, and the next good refresh clears it', async () => {
    const p = await page();
    p.api['/api/status'] = () => 'offline';
    await p.tick();
    expect(p.notice()).toContain('Lost contact with the service');
    expect(p.text()).toContain('Dashboard');
    expect(p.timers()).toBe(1);
    p.api['/api/status'] = () => ({ body: STATUS });
    await p.tick();
    expect(p.notice()).toBe('');
  });

  it('leaves a message that is not its own for the next refresh to find', async () => {
    const p = await page({ '/api/restart': failing });
    await p.press('Restart bot');
    await p.tick();
    expect(p.notice()).toContain('the disk is full');
  });
});

describe('a brain set outside this page', () => {
  const byHand = { ...SETTINGS, llm: { preset: 'custom', model: 'my-local-model' }, fallback: { preset: 'custom', model: 'my-other-model' } };

  it('is offered, selected, by its model name', async () => {
    const p = await page({}, '?step=2', byHand);
    expect(p.radio('keep', 0)?.checked).toBe(true);
    expect(p.radio('keep', 1)?.checked).toBe(true);
    expect(p.text()).toContain('my-local-model');
    expect(p.text()).toContain('my-other-model');
  });

  it('saves nothing for either, so it stays as it is', async () => {
    const p = await page({ '/api/secrets': () => ({ body: { secrets: [] } }) }, '?step=2', byHand);
    await p.press('Save and continue');
    expect(p.text()).not.toContain('different fallback');
    expect(p.puts()).toEqual([{}]);
  });

  it('can be left for one and changed for the other', async () => {
    const p = await page({}, '?step=2', { ...SETTINGS, llm: { preset: 'custom', model: 'my-local-model' } });
    await p.press('Save and continue');
    expect(p.puts()).toEqual([{ fallback: { preset: 'none' } }]);
  });

  it('has nothing to test', async () => {
    const p = await page({}, '?step=2', byHand);
    await p.press('Test');
    expect(p.sent.some((s) => s.path === '/api/check/llm')).toBe(false);
  });

  it('adds no such choice when the saved one is on the list', async () => {
    const p = await page({}, '?step=2');
    expect(p.radio('keep')).toBeUndefined();
    expect(p.radio('claude', 0)?.checked).toBe(true);
    expect(p.radio('none')?.checked).toBe(true);
  });
});

describe('saving the language model step', () => {
  const pickFallback = (p: Page, id: string) => {
    for (const r of p.radios()) if (r.attrs.name === 'p-true') r.checked = r.value === id;
  };
  const worked = () => ({ body: { ok: true, reply: 'hi', totalMs: 5, estCostPerAnswerUsd: 0.001 } });

  it('refuses a fallback with no key', async () => {
    const p = await page({}, '?step=2');
    pickFallback(p, 'groq');
    await p.press('Save and continue');
    expect(p.text()).toContain('Paste and test a key for the fallback first, or pick No fallback.');
    expect(p.puts()).toEqual([]);
  });

  it('accepts a fallback whose key is stored', async () => {
    const p = await page({}, '?step=2', SETTINGS, ['ANTHROPIC_API_KEY', 'GROQ_API_KEY']);
    pickFallback(p, 'groq');
    await p.press('Save and continue');
    expect(p.puts()).toEqual([{ llm: { preset: 'claude' }, fallback: { preset: 'groq' } }]);
  });

  it('accepts one that needs no key', async () => {
    const p = await page({}, '?step=2');
    await p.press('Save and continue');
    expect(p.puts()).toEqual([{ llm: { preset: 'claude' }, fallback: { preset: 'none' } }]);
  });

  it('tests a key that was pasted but not tested, so it is stored, not dropped', async () => {
    const p = await page({ '/api/check/llm': worked }, '?step=2');
    pickFallback(p, 'groq');
    p.keyBoxes()[1]!.value = '  fake-pasted-key ';
    await p.press('Save and continue');
    expect(p.sent.find((s) => s.path === '/api/check/llm')?.body).toEqual({ preset: 'groq', key: 'fake-pasted-key' });
    expect(p.puts()).toEqual([{ llm: { preset: 'claude' }, fallback: { preset: 'groq' } }]);
  });

  it('saves nothing when that test fails, and shows why', async () => {
    const p = await page({ '/api/check/llm': () => ({ body: { ok: false, error: 'key rejected' } }) }, '?step=2');
    pickFallback(p, 'groq');
    p.keyBoxes()[1]!.value = 'fake-bad-key';
    await p.press('Save and continue');
    expect(p.text()).toContain('key rejected');
    expect(p.puts()).toEqual([]);
  });

  it('does the same for a key pasted over the main provider', async () => {
    const p = await page({ '/api/check/llm': worked }, '?step=2');
    p.keyBoxes()[0]!.value = 'fake-new-key';
    await p.press('Save and continue');
    expect(p.sent.find((s) => s.path === '/api/check/llm')?.body).toEqual({ preset: 'claude', key: 'fake-new-key' });
    expect(p.puts()).toHaveLength(1);
  });

  it('still refuses a main provider with no key', async () => {
    const p = await page({}, '?step=2', SETTINGS, []);
    await p.press('Save and continue');
    expect(p.text()).toContain('Paste and test a key for the main provider first.');
    expect(p.puts()).toEqual([]);
  });

  it('still refuses the same provider twice', async () => {
    const p = await page({}, '?step=2');
    pickFallback(p, 'claude');
    await p.press('Save and continue');
    expect(p.text()).toContain('Pick a different fallback');
    expect(p.puts()).toEqual([]);
  });
});

describe('what the status page warns about', () => {
  it('shows a warning while the bot runs', async () => {
    const p = await page({ '/api/status': () => ({ body: { ...STATUS, warnings: ['The fallback has no key.'] } }) });
    expect(p.text()).toContain('The fallback has no key.');
  });
});

describe('what the wizard says', () => {
  const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

  it('names every permission the invite asks for', async () => {
    const p = await page({ '/api/check/discord': () => ({ body: { ok: true, botTag: 'x', guilds: [], inviteUrl: 'https://x.test', publicBot: false } }) }, '?step=1', SETTINGS, ['DISCORD_TOKEN']);
    await p.settle();
    for (const name of ['View Channels', 'Connect', 'Speak', 'Use Voice Activity', 'Send Messages', 'Send Messages in Threads', 'Read Message History']) expect(p.text()).toContain(name);
    expect(p.text()).not.toContain('asks only for');
  });

  it('does not claim only the question goes to the model', () => {
    expect(source).not.toContain('Only the transcribed question');
    for (const what of ['saved notes', 'channel messages', 'said in the call']) expect(source).toContain(what);
  });
});
