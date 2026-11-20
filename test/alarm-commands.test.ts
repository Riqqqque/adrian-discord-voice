// /alarm, the Stop / Snooze buttons on alarm DMs, and the command definitions,
// driven through discord.js itself: real interaction classes built from the
// gateway payloads Discord sends, with only the REST calls faked.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationCommandOptionType, Client, DiscordAPIError, MessageFlags, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { ALARM_COMMANDS, alarmButtons, registerAlarmCommands } from '../src/app/alarm-commands.js';
import { AlarmClock, type AlarmDeps } from '../src/features/alarms.js';
import { alarmTools } from '../src/features/alarm-tools.js';
import { Reminders } from '../src/features/reminders.js';

const TZ = 'America/Denver';
// Obviously fake snowflakes.
const APP = '100000000000000001';
const GUILD = '200000000000000002';
const TEXT = '300000000000000003';
const DMCH = '300000000000000004';
const SAM = '400000000000000005';
const ALEX = '400000000000000006';
const BOSS = '400000000000000007'; // an owner of the bot
const BOT = '400000000000000008';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };

type Raw = Record<string, unknown>;
interface Call {
  /** 4 reply, 5 deferReply, 6 deferUpdate, 7 update, 8 autocomplete; 'edit' editReply, 'follow' followUp. */
  kind: number | 'edit' | 'follow';
  interaction: string;
  data: Raw;
  ms: number;
  /** Discord refused it (an expired interaction, say). */
  failed?: boolean;
}

const DEF = ALARM_COMMANDS[0]!.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody;

/** The bot with /alarm on a fake Discord: who the user is, where, and what the clock says. */
function world(o: { file?: string; start?: number; place?: string | undefined; owners?: string[]; english?: boolean; reach?: 'call' | 'pc' | 'none' } = {}) {
  let now = o.start ?? Date.UTC(2026, 10, 18, 20, 0); // Wed Nov 18 2026, 1 PM in Denver
  let place: string | undefined = 'place' in o ? o.place : undefined; // default: nowhere, so DMs with buttons
  const dms: { user: string; text: string; components: Raw[] }[] = [];
  const said: { user: string; text: string }[] = [];
  const warnings: string[] = [];
  const deps: AlarmDeps = {
    placeFor: () => place,
    ring: () => ({ stop() {}, alive: () => true }),
    // As stack.ts sends them.
    dm: async (user, text, b) => (dms.push({ user, text, components: b ? [alarmButtons(user, b).toJSON() as unknown as Raw] : [] }), true),
  };
  const make = () => new AlarmClock(o.file, TZ, deps, () => now);
  let clock = make();
  const reminders = new Reminders(undefined, TZ, () => {}, () => now);
  const tools = () => alarmTools({ clock, reminders, english: () => o.english ?? true, reach: () => o.reach ?? 'call', preview: async () => true, musicOk: true, now: () => now });

  const calls: Call[] = [];
  let fail: ((kind: Call['kind']) => Error | undefined) | undefined;
  let client: Client;
  const boot = () => {
    client = new Client({ intents: [] });
    const rest = client.rest as unknown as Record<string, (route: string, opts: { body?: Raw }) => Promise<unknown>>;
    const t0 = new Map<string, number>();
    const record = (route: string, kind: Call['kind'], body: Raw) => {
      const id = /interactions\/(\d+)\//.exec(route)?.[1] ?? [...sent.entries()].find(([, tok]) => route.includes(tok))?.[0] ?? '?';
      const ms = performance.now() - (t0.get(id) ?? sentAt.get(id) ?? 0);
      const e = fail?.(kind);
      calls.push({ kind, interaction: id, data: body, ms, ...(e ? { failed: true } : {}) });
      if (e) throw e;
    };
    const message = (body: Raw) => ({ id: '600000000000000001', channel_id: DMCH, type: 0, content: body.content ?? '', author: { id: BOT, username: 'adrian', discriminator: '0', bot: true }, timestamp: new Date(now).toISOString(), edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, flags: body.flags ?? 0, components: [] });
    rest.post = async (route, opts) => {
      if (route.includes('/callback')) {
        const b = opts.body as { type: number; data?: Raw };
        record(route, b.type, b.data ?? {});
        return undefined;
      }
      record(route, 'follow', opts.body ?? {});
      return message(opts.body ?? {});
    };
    rest.patch = async (route, opts) => (record(route, 'edit', opts.body ?? {}), message(opts.body ?? {}));
    rest.get = async () => message({});
    rest.delete = async () => undefined;
    registerAlarmCommands({
      client,
      log: { ...quiet, warn: (m: string) => void warnings.push(m) } as never,
      clock,
      tools: tools(),
      name: (id) => (id === SAM ? 'Sam' : id === ALEX ? 'Alex' : 'Boss'),
      isOwner: (id) => (o.owners ?? [BOSS]).includes(id),
      said: (user, text) => void said.push({ user, text }),
    });
  };
  boot();

  const sent = new Map<string, string>(); // interaction id → token
  const sentAt = new Map<string, number>();
  let seq = 0;
  const raw = (type: number, who: string, where: 'dm' | 'guild', extra: Raw): Raw => {
    seq++;
    const id = String(500000000000000000n + BigInt(seq));
    const token = `fake-token-${seq}`;
    sent.set(id, token);
    const user = { id: who, username: `user${who.slice(-2)}`, discriminator: '0', global_name: null, avatar: null };
    return {
      id,
      application_id: APP,
      type,
      token,
      version: 1,
      locale: 'en-US',
      app_permissions: '0',
      entitlements: [],
      authorizing_integration_owners: { '0': GUILD },
      ...(where === 'guild'
        ? { guild_id: GUILD, guild_locale: 'en-US', channel_id: TEXT, channel: { id: TEXT, type: 0, guild_id: GUILD, name: 'general' }, member: { user, roles: [], joined_at: '2026-01-01T00:00:00.000Z', deaf: false, mute: false, permissions: '0', flags: 0 }, context: 0 }
        : { channel_id: DMCH, channel: { id: DMCH, type: 1, recipients: [user] }, user, context: 1 }),
      ...extra,
    };
  };
  const optionsFor = (sub: string, values: Raw, focused?: string) => {
    const s = DEF.options!.find((x) => x.name === sub) as { options?: { name: string; type: number }[] } | undefined;
    if (!s) throw new Error(`no subcommand ${sub}`);
    return [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: sub,
        options: Object.entries(values).map(([name, value]) => {
          const def = s.options?.find((x) => x.name === name);
          if (!def) throw new Error(`/alarm ${sub} has no option ${name}`);
          return { type: def.type, name, value, ...(focused === name ? { focused: true } : {}) };
        }),
      },
    ];
  };
  const emit = (r: Raw) => {
    sentAt.set(r.id as string, performance.now());
    (client as unknown as { actions: { InteractionCreate: { handle(d: Raw): void } } }).actions.InteractionCreate.handle(r);
    return r.id as string;
  };
  /** Wait until this interaction got its first answer (and anything that follows at once). */
  const answers = async (id: string) => {
    await vi.waitFor(() => expect(calls.some((c) => c.interaction === id)).toBe(true), { timeout: 2000, interval: 2 });
    await new Promise((r) => setTimeout(r, 20));
    return calls.filter((c) => c.interaction === id);
  };

  return {
    get clock() {
      return clock;
    },
    dms,
    said,
    calls,
    warnings,
    now: () => now,
    advance(ms: number) {
      now += ms;
      clock.tick();
    },
    setPlace(p: string | undefined) {
      place = p;
    },
    failWith(f: typeof fail) {
      fail = f;
    },
    /** The process restarts: a new clock from the same file, a new client. */
    restart() {
      clock.stop();
      clock = make();
      boot();
      clock.tick();
    },
    /** `/alarm <sub> ...` → every REST call it made. */
    async slash(sub: string, values: Raw = {}, who = SAM, where: 'dm' | 'guild' = 'dm') {
      return answers(emit(raw(2, who, where, { data: { id: '700000000000000001', name: 'alarm', type: 1, options: optionsFor(sub, values) } })));
    },
    /** The reply text of `/alarm <sub>`. */
    async text(sub: string, values: Raw = {}, who = SAM, where: 'dm' | 'guild' = 'dm') {
      const c = await this.slash(sub, values, who, where);
      expect(c[0]!.kind).toBe(4);
      return String(c[0]!.data.content);
    },
    async auto(sub: string, focused: string, values: Raw, who = SAM) {
      const c = await answers(emit(raw(4, who, 'dm', { data: { id: '700000000000000001', name: 'alarm', type: 1, options: optionsFor(sub, values, focused) } })));
      expect(c[0]!.kind).toBe(8);
      return (c[0]!.data as { choices: { name: string; value: string }[] }).choices;
    },
    /** A press on a button of a message that says `content`. */
    async press(customId: string, content: string, who = SAM, where: 'dm' | 'guild' = 'dm') {
      const message = {
        id: '600000000000000009',
        channel_id: where === 'dm' ? DMCH : TEXT,
        type: 0,
        content,
        author: { id: BOT, username: 'adrian', discriminator: '0', bot: true },
        timestamp: new Date(now).toISOString(),
        edited_timestamp: null,
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        pinned: false,
        flags: 0,
        components: [],
      };
      return answers(emit(raw(3, who, where, { data: { custom_id: customId, component_type: 2 }, message })));
    },
  };
}

/** The custom ids on a DM's buttons. */
const ids = (dm: { components: Raw[] } | undefined) => ((dm?.components[0] as { components?: { custom_id: string }[] } | undefined)?.components ?? []).map((b) => b.custom_id);
const ephemeral = (c: Call) => ((c.data.flags as number) & MessageFlags.Ephemeral) !== 0;
const MIN = 60_000;
const NO_MODEL_WORDS = /\bask (what|which|how)\b|\bthey\b|\btheir\b|\bthem\b|\(Note:|\[id /i;
const expired = () => new DiscordAPIError({ code: 10062, message: 'Unknown interaction' }, 10062, 404, 'POST', 'https://discord.com/api/v10/interactions/x/y/callback', { body: undefined });

/** A timer of `min` minutes that has just started ringing, and its DM. */
async function ringing(w: ReturnType<typeof world>, min = 1, label?: string) {
  await w.text('timer', { minutes: min, ...(label ? { label } : {}) });
  w.advance(min * MIN);
  const dm = w.dms.at(-1)!;
  expect(w.clock.ringingFor(SAM)).toHaveLength(1);
  return { dm, stop: ids(dm)[0]!, snooze: ids(dm)[1]! };
}

// --- the command definitions ---------------------------------------------------

type Opt = { type: number; name: string; description: string; required?: boolean; choices?: { name: string; value: string | number }[]; autocomplete?: boolean; options?: Opt[]; min_length?: number; max_length?: number; min_value?: number; max_value?: number };

/** Discord's rules for a chat-input command (docs: Application Commands). */
function problems(c: { name: string; description: string; options?: Opt[]; contexts?: number[] | null; integration_types?: number[] }): string[] {
  const out: string[] = [];
  const NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
  let chars = c.name.length + c.description.length;
  const check = (where: string, name: string, description: string) => {
    if (!NAME.test(name) || name !== name.toLowerCase()) out.push(`${where}: bad name "${name}"`);
    if (description.length < 1 || description.length > 100) out.push(`${where}: description is ${description.length} characters`);
  };
  check('/' + c.name, c.name, c.description);
  const walk = (where: string, opts: Opt[] | undefined) => {
    if (!opts) return;
    if (opts.length > 25) out.push(`${where}: ${opts.length} options`);
    const subs = opts.filter((o) => o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup);
    if (subs.length && subs.length !== opts.length) out.push(`${where}: subcommands mixed with options`);
    if (new Set(opts.map((o) => o.name)).size !== opts.length) out.push(`${where}: duplicate option names`);
    let optional = false;
    for (const o of opts) {
      const at = `${where} ${o.name}`;
      check(at, o.name, o.description);
      chars += o.name.length + o.description.length;
      if (o.required && optional) out.push(`${at}: required after an optional one`);
      if (!o.required) optional = true;
      if (o.choices) {
        if (o.choices.length > 25) out.push(`${at}: ${o.choices.length} choices`);
        if (o.autocomplete) out.push(`${at}: choices and autocomplete together`);
        for (const ch of o.choices) {
          chars += ch.name.length + String(ch.value).length;
          if (ch.name.length < 1 || ch.name.length > 100) out.push(`${at}: choice name "${ch.name}"`);
          if (typeof ch.value === 'string' && ch.value.length > 100) out.push(`${at}: choice value too long`);
        }
      }
      if (o.max_length !== undefined && (o.max_length < 1 || o.max_length > 6000)) out.push(`${at}: max_length ${o.max_length}`);
      if (o.min_length !== undefined && (o.min_length < 0 || o.min_length > 6000)) out.push(`${at}: min_length ${o.min_length}`);
      if (o.min_value !== undefined && o.max_value !== undefined && o.min_value > o.max_value) out.push(`${at}: min above max`);
      if (o.type === ApplicationCommandOptionType.Integer && [o.min_value, o.max_value].some((v) => v !== undefined && !Number.isInteger(v))) out.push(`${at}: integer limits not integers`);
      if (o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup) walk(at, o.options);
      if (o.type === ApplicationCommandOptionType.SubcommandGroup && o.options?.some((x) => x.type !== ApplicationCommandOptionType.Subcommand)) out.push(`${at}: a group holds subcommands only`);
    }
  };
  walk('/' + c.name, c.options);
  if (chars > 4000) out.push(`/${c.name}: ${chars} characters in all (limit 4000)`);
  return out;
}

describe('/alarm definition', () => {
  const json = ALARM_COMMANDS.map((c) => c.toJSON()) as unknown as Parameters<typeof problems>[0][];

  it("meets Discord's limits", () => {
    for (const c of json) expect(problems(c)).toEqual([]);
    // Every subcommand the docs list, nothing more.
    expect(json[0]!.options!.map((o) => o.name).sort()).toEqual(['delete', 'list', 'off', 'set', 'settings', 'skip', 'snooze', 'sounds', 'stop', 'timer']);
  });

  it('works in servers and in a DM with the bot, as a server-installed app', () => {
    expect(json[0]!.contexts).toEqual([0, 1]); // Guild, BotDM
    expect(json[0]!.integration_types).toEqual([0]); // GuildInstall
  });

  it('the validator catches what Discord would refuse', () => {
    const bad = {
      name: 'Alarm',
      description: '',
      options: [
        { type: 3, name: 'b', description: 'x', autocomplete: true, choices: [{ name: 'a', value: 'a' }] },
        { type: 3, name: 'a', description: 'x', required: true },
        { type: 3, name: 'c', description: 'x'.repeat(101), choices: Array.from({ length: 26 }, (_, i) => ({ name: `n${i}`, value: `v${i}` })) },
      ],
    };
    const p = problems(bad).join('\n');
    expect(p).toMatch(/bad name "Alarm"/);
    expect(p).toMatch(/description is 0/);
    expect(p).toMatch(/choices and autocomplete/);
    expect(p).toMatch(/required after an optional/);
    expect(p).toMatch(/26 choices/);
    expect(p).toMatch(/description is 101/);
  });

  it('autocomplete answers stay within 25 choices of 100 characters', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) w.clock.addSound({ name: `saved sound number ${i} with a long name`, owner: SAM, file: `f${i}.pcm`, seconds: 3 });
    for (let i = 0; i < 30; i++) await w.text('timer', { minutes: 5 + i, label: `a very long label for a timer, number ${i}, that goes on and on and on and on and on` });
    for (const [sub, f] of [['set', 'sound'], ['settings', 'timer_sound'], ['delete', 'which'], ['off', 'which']] as const) {
      const list = await w.auto(sub, f, sub === 'set' ? { time: '7', [f]: '' } : { [f]: '' });
      expect(list.length).toBeLessThanOrEqual(25);
      expect(list.length).toBeGreaterThan(0);
      for (const ch of list) {
        expect(ch.name.length).toBeGreaterThan(0);
        expect(ch.name.length).toBeLessThanOrEqual(100);
        expect(ch.value.length).toBeLessThanOrEqual(100);
      }
    }
  }, 30_000);
});

// --- /alarm ------------------------------------------------------------------------

describe('/alarm set', () => {
  it('answers at once, privately, never pinging, in a DM and in a server', async () => {
    const w = world();
    for (const where of ['dm', 'guild'] as const) {
      const c = await w.slash('set', { time: '7:00' }, SAM, where);
      expect(c).toHaveLength(1);
      expect(c[0]!.kind).toBe(4); // a reply, no defer needed
      expect(c[0]!.ms).toBeLessThan(3000);
      expect(ephemeral(c[0]!)).toBe(true);
      expect(c[0]!.data.allowed_mentions).toEqual({ parse: [] });
      expect(c[0]!.data.content).toBe('Alarm set for 7 AM tomorrow, Thursday.');
    }
    const [a, b] = w.clock.forUser(SAM);
    expect(a!.guildId).toBeUndefined();
    expect(b!.guildId).toBe(GUILD);
  });

  it("says when it couldn't ring anywhere they are now", async () => {
    const w = world({ reach: 'none' });
    expect(await w.text('set', { time: '7:00' })).toBe("Alarm set for 7 AM tomorrow, Thursday. Right now you're not in my call or at your PC, so if that's still true then, I'll message you.");
  });

  it('reads the times people type', async () => {
    const w = world(); // 1 PM Wednesday
    expect(await w.text('set', { time: '6:30am' })).toBe('Alarm set for 6:30 AM tomorrow, Thursday.');
    expect(await w.text('set', { time: '18:45' })).toBe('Alarm set for 6:45 PM today.');
    // A bare hour reads as 24-hour, like 7:00; the read-back says which it took.
    expect(await w.text('set', { time: '7' })).toBe('Alarm set for 7 AM tomorrow, Thursday.');
    expect(await w.text('set', { time: '7pm' })).toBe('Alarm set for 7 PM today.');
    expect(await w.text('set', { time: '12am' })).toBe('Alarm set for 12 AM tomorrow, Thursday.');
    expect(await w.text('set', { time: '1:00' })).toBe('Alarm set for 1 AM tomorrow, Thursday.'); // 1 PM is now: the next one
  });

  it('refuses times that are not times, in words meant for a person', async () => {
    const w = world();
    for (const time of ['25:99', 'banana', '24:00', '13pm', '7:60']) expect(await w.text('set', { time })).toBe('No clear time given. Try a time like 7:00, 6:30am or 18:45.');
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('repeats, days and dates', async () => {
    const w = world();
    expect(await w.text('set', { time: '6:30', repeat: 'weekdays', label: 'work' })).toBe('Alarm set for 6:30 AM on weekdays.');
    expect(await w.text('set', { time: '9:00', days: 'sat,sun' })).toBe('Alarm set for 9 AM on weekends.');
    expect(await w.text('set', { time: '8:00', repeat: 'once' })).toBe('Alarm set for 8 AM tomorrow, Thursday.');
    expect(await w.text('set', { time: '7:00', date: '2026-12-25', label: 'presents' })).toBe('Alarm set for 7 AM Friday, December 25.');
    const all = w.clock.forUser(SAM);
    expect(all.find((a) => a.label === 'work')!.days).toEqual([1, 2, 3, 4, 5]);
    expect(all.find((a) => a.label === 'presents')!.days).toBeUndefined();
  });

  it('bad days and dates say what to type', async () => {
    const w = world();
    expect(await w.text('set', { time: '7:00', days: 'blursday' })).toBe('Didn\'t understand the repeat "blursday". Use daily, weekdays, weekends, or days like mon,wed,fri.');
    expect(await w.text('set', { time: '7:00', date: 'tomorrow' })).toBe('The date must be YYYY-MM-DD.');
    expect(await w.text('set', { time: '7:00', date: '2026-11-01' })).toBe('That time has already passed.');
    // A day that isn't on the calendar must not roll over into March.
    expect(await w.text('set', { time: '7:00', date: '2027-02-30' })).toBe('There is no 2027-02-30.');
    expect(await w.text('set', { time: '7:00', date: '2026-13-01' })).toBe('There is no 2026-13-01.');
    // A date and a repeat at once: the date used to be dropped without a word.
    expect(await w.text('set', { time: '7:00', date: '2026-12-25', repeat: 'daily' })).toBe('Give a date for a one-off, or repeat or days for one that repeats, not both.');
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('sounds: a built-in, a saved one, or a list of what there is', async () => {
    const w = world();
    w.clock.addSound({ name: 'airhorn', owner: SAM, file: 'x.pcm', seconds: 4 });
    await w.text('set', { time: '7:00', sound: 'birds' });
    await w.text('set', { time: '8:00', sound: 'airhorn' });
    const t = await w.text('set', { time: '9:00', sound: 'kazoo' });
    expect(t).toMatch(/^There's no sound called "kazoo"\. Built-in sounds: classic/);
    expect(t).toContain('Your saved sounds: airhorn.');
    expect(t).not.toMatch(NO_MODEL_WORDS);
    expect(w.clock.forUser(SAM).map((a) => a.sound)).toEqual(['birds', 'clip:airhorn']);
  });

  it('uses their own time zone, and the clocks changing', async () => {
    const w = world();
    expect(await w.text('settings', { timezone: 'Europe/London' })).toContain('time zone Europe/London');
    expect(await w.text('set', { time: '7:00' })).toBe('Alarm set for 7 AM tomorrow, Thursday.');
    expect(w.clock.forUser(SAM)[0]!.at).toBe(Date.UTC(2026, 10, 19, 7, 0));
    expect(await w.text('settings', { timezone: 'Mars/Olympus' })).toBe('"Mars/Olympus" isn\'t a time zone name; use one like America/Chicago.');

    // Spring forward in Denver: 2:30 doesn't exist on March 14, 2027; it rings at 3:30.
    const s = world({ start: Date.UTC(2027, 2, 13, 19, 0) });
    expect(await s.text('set', { time: '2:30', date: '2027-03-14' })).toBe('Alarm set for 3:30 AM tomorrow, Sunday.');
    expect(s.clock.forUser(SAM)[0]!.at).toBe(Date.UTC(2027, 2, 14, 9, 30));
    // Fall back: 1:30 on November 1, 2026 comes twice; a daily one keeps 1:30 after.
    const f = world({ start: Date.UTC(2026, 9, 31, 18, 0) });
    expect(await f.text('set', { time: '1:30', repeat: 'daily' })).toBe('Alarm set for 1:30 AM every day.');
    const a = f.clock.forUser(SAM)[0]!;
    expect([Date.UTC(2026, 10, 1, 7, 30), Date.UTC(2026, 10, 1, 8, 30)]).toContain(a.at);
    f.advance(a.at - f.now());
    await f.text('stop');
    expect(f.clock.forUser(SAM)[0]!.at).toBe(Date.UTC(2026, 10, 2, 8, 30)); // 1:30 MST
  });

  it('a time in the minute now is tomorrow; the next minute rings in seconds', async () => {
    const w = world({ start: Date.UTC(2026, 10, 18, 20, 0, 30) }); // 1:00:30 PM
    expect(await w.text('set', { time: '13:00' })).toBe('Alarm set for 1 PM tomorrow, Thursday.');
    expect(await w.text('set', { time: '13:01' })).toBe('Alarm set for 1:01 PM today.');
    w.advance(30_000);
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
  });

  it('stops at 30 per person', async () => {
    const w = world();
    for (let i = 0; i < 30; i++) await w.text('timer', { minutes: 10 + i });
    expect(await w.text('set', { time: '7:00' })).toBe('You already have 30 alarms and timers; delete some first.');
  });

  it('a failed save is said, not dropped', async () => {
    // A folder where the file should be: every save fails.
    const w = world({ file: mkdtempSync(join(tmpdir(), 'alarm-cmd-')) });
    expect(await w.text('set', { time: '7:00' })).toBe('Alarm set: alarm at 7 AM tomorrow, Thursday, sound classic. Saving it to disk failed just now, so it may not survive a restart.');
  });
});

describe('/alarm timer and list', () => {
  it('timers from 6 seconds to 7 days', async () => {
    const w = world();
    expect(await w.text('timer', { minutes: 10, label: 'pizza' })).toBe('Timer set for 10 minutes.');
    expect(await w.text('timer', { minutes: 0.1 })).toBe('Timer set for 6 seconds.');
    expect(await w.text('timer', { minutes: 10_080 })).toBe('Timer set for 7 days.');
    expect(await w.text('timer', { minutes: 5, sound: 'kazoo' })).toMatch(/^There's no sound called "kazoo"/);
    expect(w.clock.forUser(SAM, 'timer')).toHaveLength(3);
  });

  it('lists alarms, timers and reminders without the ids meant for the model', async () => {
    const w = world();
    expect(await w.text('list')).toBe('No alarms, timers or reminders.');
    await w.text('set', { time: '7:00', repeat: 'weekdays', label: 'work' });
    await w.text('timer', { minutes: 10, label: 'pizza' });
    expect(await w.text('list')).toBe('pizza timer: 10 minutes left, rings 1:10 PM, sound chime\nalarm "work" at 7 AM on weekdays, next tomorrow, Thursday, sound classic');
    expect(await w.text('list', {}, ALEX)).toBe('No alarms, timers or reminders.');
  });
});

describe('/alarm stop and snooze', () => {
  it('nothing ringing', async () => {
    const w = world();
    expect(await w.text('stop')).toBe('Nothing is ringing.');
    expect(await w.text('snooze')).toBe('Nothing is ringing.');
  });

  it('stops and snoozes what rings, and says so where it rings', async () => {
    const w = world();
    await ringing(w);
    expect(await w.text('snooze', { minutes: 15 })).toBe('Okay, 15 minutes more.');
    w.advance(15 * MIN);
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    expect(await w.text('stop')).toBe('Timer stopped.');
    expect(w.said.map((s) => s.text)).toEqual(['Okay, 15 minutes more.', 'Timer stopped.']);
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('a typed stop always stops, even in firm mode', async () => {
    const w = world();
    await w.text('settings', { turn_off_by: 'firm' });
    await w.text('set', { time: '13:05' });
    w.advance(5 * MIN);
    expect(await w.text('stop')).toBe('Alarm off.');
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('a stop while it is snoozed turns it off, instead of "nothing is ringing"', async () => {
    const w = world();
    await w.text('set', { time: '13:05' });
    w.advance(5 * MIN);
    expect(await w.text('snooze')).toBe('Snoozed until 1:14 PM.');
    expect(await w.text('stop')).toBe('Alarm off.');
    w.advance(20 * MIN);
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('snooze right after a stop puts it back, within the undo window only', async () => {
    const w = world();
    await w.text('set', { time: '13:05' });
    w.advance(5 * MIN);
    await w.text('stop');
    w.advance(2 * MIN + 59_000);
    expect(await w.text('snooze')).toBe("Okay, it's back on. It rings again at 1:16 PM.");
    w.advance(9 * MIN);
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    await w.text('stop');
    w.advance(3 * MIN + 1000);
    expect(await w.text('snooze')).toBe('Nothing is ringing.');
  });

  it("someone else's ringing alarm is not theirs to stop, owners included", async () => {
    const w = world();
    await ringing(w);
    expect(await w.text('stop', {}, ALEX)).toBe('Nothing is ringing.');
    expect(await w.text('stop', {}, BOSS, 'guild')).toBe('Nothing is ringing.');
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
  });
});

describe('/alarm delete, off, skip', () => {
  it('delete picks from their own list', async () => {
    const w = world();
    await w.text('set', { time: '7:00', label: 'gym' });
    await w.text('set', { time: '8:00', repeat: 'daily' }, ALEX);
    const list = await w.auto('delete', 'which', { which: 'gym' });
    expect(list).toEqual([{ name: 'Alarm 7 AM: gym', value: w.clock.forUser(SAM)[0]!.id }]);
    // Alex's id typed by hand: not Sam's to delete.
    expect(await w.text('delete', { which: w.clock.forUser(ALEX)[0]!.id })).toBe('No alarm or timer like that. Pick one from the list.');
    expect(await w.text('delete', { which: 'gym' })).toBe('No alarm or timer like that. Pick one from the list.');
    expect(await w.text('delete', { which: list[0]!.value })).toBe('Deleted your 7 AM alarm (gym).');
    expect(w.clock.forUser(SAM)).toHaveLength(0);
    expect(w.clock.forUser(ALEX)).toHaveLength(1);
  });

  it('deleting one that rings stops it, and a snooze after does not bring it back', async () => {
    const w = world();
    await w.text('set', { time: '13:05', repeat: 'daily' });
    w.advance(5 * MIN);
    expect(await w.text('delete', { which: w.clock.forUser(SAM)[0]!.id })).toBe('Deleted your 1:05 PM alarm.');
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
    expect(await w.text('snooze')).toBe('Nothing is ringing.');
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('off and back on', async () => {
    const w = world();
    expect(await w.text('off', { which: 'x' })).toBe('You have no alarms or timers.');
    await w.text('set', { time: '7:00', repeat: 'daily' });
    const id = w.clock.forUser(SAM)[0]!.id;
    expect(await w.text('off', { which: id })).toBe('Changed: turned off. Now: alarm at 7 AM every day, next tomorrow, Thursday, sound classic (turned off).');
    w.advance(24 * 60 * MIN); // its time passes while off
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
    expect(await w.text('off', { which: id, on: true })).toBe('Changed: back on, next tomorrow, Friday at 7 AM. Now: alarm at 7 AM every day, next tomorrow, Friday, sound classic.');
  });

  it('turning off one that rings says what to do, to them', async () => {
    const w = world();
    await w.text('set', { time: '13:05', repeat: 'daily' });
    w.advance(5 * MIN);
    expect(await w.text('off', { which: w.clock.forUser(SAM)[0]!.id })).toBe('That one is ringing right now. Stop or snooze it first; it can be turned off after that.');
  });

  it('a snoozed alarm turned off and back on later is a plain alarm again', async () => {
    const w = world();
    await w.text('set', { time: '13:05', repeat: 'daily' });
    w.advance(5 * MIN);
    await w.text('snooze');
    const id = w.clock.forUser(SAM)[0]!.id;
    await w.text('off', { which: id });
    w.advance(2 * 24 * 60 * MIN);
    await w.text('off', { which: id, on: true });
    const a = w.clock.forUser(SAM)[0]!;
    expect(a.snoozed).toBeUndefined();
    expect(a.at).toBe(a.base);
  });

  it('skip: the next ring of a repeating one; one-offs refuse', async () => {
    const w = world();
    await w.text('set', { time: '7:00', date: '2026-11-20' });
    expect(await w.text('skip', { which: w.clock.forUser(SAM)[0]!.id })).toBe('That alarm only rings once; turn it off or delete it instead.');
    await w.text('set', { time: '7:00', repeat: 'weekdays', label: 'work' });
    const id = w.clock.forUser(SAM).find((a) => a.label === 'work')!.id;
    expect(await w.text('skip', { which: id })).toMatch(/^Changed: it won't ring tomorrow, Thursday; next it rings Friday at 7 AM\./);
  });

  it('skip while it rings skips the next day, not the ring going on now', async () => {
    const w = world();
    await w.text('set', { time: '13:05', repeat: 'daily' });
    w.advance(5 * MIN);
    const id = w.clock.forUser(SAM)[0]!.id;
    expect(await w.text('skip', { which: id })).toMatch(/^Changed: it won't ring tomorrow, Thursday; next it rings Friday at 1:05 PM\./);
    await w.text('stop');
    w.advance(24 * 60 * MIN); // Thursday 1:05 PM
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
    w.advance(24 * 60 * MIN); // Friday
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    expect(w.clock.forUser(SAM)[0]!.skip).toBeUndefined();
  });
});

describe('/alarm sounds and settings', () => {
  it('lists the sounds, in words for them', async () => {
    const w = world();
    const t = await w.text('sounds');
    expect(t).toMatch(/^Built-in sounds: classic \(classic beeping/);
    expect(t).toContain('Your default for alarms: classic; for timers: chime.');
    expect(t).not.toMatch(NO_MODEL_WORDS);
  });

  it('shows the settings, and changes every one of them', async () => {
    const w = world();
    expect(await w.text('settings')).toBe(
      'Settings: alarm sound classic, timer sound chime, snooze 9 minutes, each ring lasts 10 minutes (timers 5) and an unanswered alarm rings 3 times, fades in over 30 seconds, volume 100%, turn off by saying stop, her voice on, time zone America/Denver.',
    );
    const t = await w.text('settings', { sound: 'birds', timer_sound: 'bells', snooze: 15, ring: 5, fade_in: 0, volume: 70, turn_off_by: 'math', voice: false, timezone: 'America/New_York' });
    expect(t).toBe(
      'Saved. Settings: alarm sound birds, timer sound bells, snooze 15 minutes, each ring lasts 5 minutes (timers 5) and an unanswered alarm rings 3 times, fades in over 0 seconds, volume 70%, turn off by answering a sum, her voice off, time zone America/New_York. Alarms already set keep the time zone they were set in.',
    );
    expect(await w.text('settings', { sound: 'kazoo' })).toMatch(/^There's no sound called "kazoo"/);
    expect(await w.text('settings', { sound: 'voice' })).toMatch(/^Saved\. Settings: alarm sound her voice,/);
  });

  it('sound autocomplete: filters by what they typed, and their saved sounds', async () => {
    const w = world();
    w.clock.addSound({ name: 'airhorn', owner: SAM, file: 'x.pcm', seconds: 4 });
    expect(await w.auto('set', 'sound', { time: '7', sound: 'bir' })).toEqual([{ name: 'birds: chirping birds', value: 'birds' }]);
    expect(await w.auto('settings', 'sound', { sound: 'air' })).toEqual([{ name: 'airhorn (saved)', value: 'airhorn' }]);
    expect(await w.auto('settings', 'sound', { sound: 'air' }, ALEX)).toEqual([]);
  });
});

describe('/alarm when Discord fails', () => {
  it('an expired interaction is logged, and nothing is thrown', async () => {
    const w = world();
    w.failWith(() => expired());
    const c = await w.slash('set', { time: '7:00' });
    expect(c.every((x) => x.failed)).toBe(true);
    expect(w.warnings).toContain('alarm command failed');
    // The alarm is set even though Discord didn't take the answer.
    expect(w.clock.forUser(SAM)).toHaveLength(1);
  });
});

// --- the DM buttons ---------------------------------------------------------------------

describe('alarm DM buttons', () => {
  it('nowhere to ring: a DM with Stop and Snooze for that alarm', async () => {
    const w = world();
    const r = await ringing(w, 1, 'pizza');
    expect(r.dm.text).toBe("⏰ Your pizza timer is done. I couldn't ring it anywhere you are, so this is it.");
    const a = w.clock.forUser(SAM)[0]!;
    expect(r.stop).toBe(`alarm:stop:${SAM}:${a.id}:${a.base.toString(36)}`);
    expect(r.snooze).toBe(`alarm:snooze:${SAM}:${a.id}:${a.base.toString(36)}`);
    for (const id of ids(r.dm)) expect(id.length).toBeLessThanOrEqual(100);
  });

  it('Stop: the message keeps what it said, loses its buttons, and says what happened', async () => {
    const w = world();
    const r = await ringing(w);
    const c = await w.press(r.stop, r.dm.text);
    expect(c).toHaveLength(1);
    expect(c[0]!.kind).toBe(7); // update the message
    expect(c[0]!.ms).toBeLessThan(3000);
    expect(c[0]!.data.content).toBe(`${r.dm.text}\n→ Timer stopped.`);
    expect(c[0]!.data.components).toEqual([]);
    expect(w.said).toEqual([{ user: SAM, text: 'Timer stopped.' }]);
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('Snooze, then the next round sends fresh buttons', async () => {
    const w = world();
    await w.text('set', { time: '13:05', label: 'meds' });
    w.advance(5 * MIN);
    const dm = w.dms.at(-1)!;
    const c = await w.press(ids(dm)[1]!, dm.text);
    expect(c[0]!.data.content).toBe(`${dm.text}\n→ Snoozed until 1:14 PM.`);
    w.advance(9 * MIN);
    expect(w.dms).toHaveLength(2);
    const again = await w.press(ids(w.dms[1])[0]!, w.dms[1]!.text);
    expect(again[0]!.data.content).toBe(`${w.dms[1]!.text}\n→ Alarm off.`);
  });

  it('pressed twice: the second press keeps the first answer on the message', async () => {
    const w = world();
    const r = await ringing(w);
    await w.press(r.stop, r.dm.text);
    // The second click was made on the same, still-buttoned message.
    const c = await w.press(r.stop, r.dm.text);
    expect(c.map((x) => x.kind)).toEqual([7, 'follow']);
    expect(c[0]!.data.content).toBeUndefined(); // the text stays as the first press left it
    expect(c[0]!.data.components).toEqual([]);
    expect(c[1]!.data.content).toBe("That one isn't ringing any more.");
    expect(ephemeral(c[1]!)).toBe(true);
    expect(w.said).toHaveLength(1);
  });

  it('after it was stopped some other way', async () => {
    const w = world();
    const r = await ringing(w);
    await w.text('stop');
    const c = await w.press(r.stop, r.dm.text);
    expect(c[0]!.data.content).toBeUndefined();
    expect(c[1]!.data.content).toBe("That one isn't ringing any more.");
  });

  it("an old message's button leaves what rings now alone", async () => {
    const w = world();
    const old = await ringing(w, 1, 'tea');
    await w.text('stop');
    w.advance(5 * MIN); // past the undo window
    await ringing(w, 1, 'pizza');
    for (const b of [old.stop, old.snooze]) {
      const c = await w.press(b, old.dm.text);
      expect(c.at(-1)!.data.content).toBe("That one isn't ringing any more.");
    }
    expect(w.clock.ringingFor(SAM).map((a) => a.label)).toEqual(['pizza']);
  });

  it("yesterday's message for a repeating alarm leaves today's ring alone", async () => {
    const w = world();
    await w.text('set', { time: '13:05', repeat: 'daily' });
    w.advance(5 * MIN);
    const yesterday = w.dms.at(-1)!;
    await w.text('stop');
    w.advance(24 * 60 * MIN);
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    const c = await w.press(ids(yesterday)[0]!, yesterday.text);
    expect(c.at(-1)!.data.content).toBe("That one isn't ringing any more.");
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    const today = w.dms.at(-1)!;
    expect((await w.press(ids(today)[0]!, today.text))[0]!.data.content).toBe(`${today.text}\n→ Alarm off. Next one is tomorrow, Friday at 1:05 PM.`);
  });

  it('pressed while it snoozed itself because nobody answered: Stop turns it off', async () => {
    const w = world();
    await w.text('set', { time: '13:05' });
    w.advance(5 * MIN);
    const dm = w.dms.at(-1)!;
    w.advance(10 * MIN); // nobody answered: it snoozes itself until 1:24
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
    const s = await w.press(ids(dm)[1]!, dm.text);
    expect(s.at(-1)!.data.content).toBe("It's snoozed until 1:24 PM.");
    const c = await w.press(ids(dm)[0]!, dm.text);
    expect(c[0]!.data.content).toBe(`${dm.text}\n→ Alarm off.`);
    w.advance(30 * MIN);
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
    expect(w.dms).toHaveLength(1);
  });

  it('works after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alarm-btn-'));
    const w = world({ file: join(dir, 'alarms.json') });
    const r = await ringing(w);
    w.restart();
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    const c = await w.press(r.stop, r.dm.text);
    expect(c[0]!.data.content).toBe(`${r.dm.text}\n→ Timer stopped.`);
    w.restart();
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it("someone else's press changes nothing; an owner's works", async () => {
    const w = world();
    const r = await ringing(w);
    const c = await w.press(r.stop, r.dm.text, ALEX);
    expect(c).toHaveLength(1);
    expect(c[0]!.kind).toBe(4);
    expect(ephemeral(c[0]!)).toBe(true);
    expect(c[0]!.data.content).toBe("That's someone else's alarm.");
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    const b = await w.press(r.stop, r.dm.text, BOSS);
    expect(b[0]!.data.content).toBe(`${r.dm.text}\n→ Timer stopped.`);
    expect(w.said).toEqual([{ user: SAM, text: 'Timer stopped.' }]);
  });

  it('buttons on DMs sent before this version still work', async () => {
    const w = world();
    const r = await ringing(w);
    const c = await w.press(`alarm:stop:${SAM}`, r.dm.text);
    expect(c[0]!.data.content).toBe(`${r.dm.text}\n→ Timer stopped.`);
  });

  it('an expired press: the alarm still stops and nothing is thrown', async () => {
    const w = world();
    const r = await ringing(w);
    w.failWith(() => expired());
    const c = await w.press(r.stop, r.dm.text);
    expect(c.every((x) => x.failed)).toBe(true);
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('other buttons are left alone; a broken id is refused', async () => {
    const w = world();
    const r = await ringing(w);
    const before = w.calls.length;
    expect(await w.press('music:skip', 'x').catch(() => 'no answer')).toBe('no answer');
    expect(w.calls.length).toBe(before);
    expect((await w.press('alarm:stop:', r.dm.text))[0]!.data.content).toBe("That's someone else's alarm.");
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
  });
});


describe('review 9 fixes', () => {
  it('a repeating alarm deleted right after its stop stays deleted, however the snooze comes', async () => {
    for (const how of ['button', 'old button', 'slash', 'voice'] as const) {
      const w = world();
      await w.text('set', { time: '13:05', repeat: 'daily' });
      w.advance(5 * MIN);
      const dm = w.dms.at(-1)!;
      await w.text('stop');
      expect(await w.text('delete', { which: w.clock.forUser(SAM)[0]!.id })).toBe('Deleted your 1:05 PM alarm.');
      if (how === 'button') await w.press(ids(dm)[1]!, dm.text);
      else if (how === 'old button') await w.press(`alarm:snooze:${SAM}`, 'an old message');
      else if (how === 'slash') await w.text('snooze');
      else w.clock.heard(SAM, "wait, I'm not up");
      expect(w.clock.forUser(SAM), how).toHaveLength(0);
      w.advance(24 * 60 * MIN);
      expect(w.clock.forUser(SAM), how).toHaveLength(0);
    }
  });

  it('a stop then a snooze, without a delete, still puts it back', async () => {
    const w = world();
    await w.text('set', { time: '13:05', repeat: 'daily' });
    w.advance(5 * MIN);
    await w.text('stop');
    expect(await w.text('snooze')).toMatch(/^Okay, it's back on/);
  });

  it('a timer moved by a fractional add_minutes keeps buttons that work', async () => {
    const w = world();
    await w.text('timer', { minutes: 1, label: 'tea' });
    const edit = alarmTools({ clock: w.clock, reminders: new Reminders(undefined, TZ, () => {}, () => w.now()), english: () => true, reach: () => 'none', preview: async () => true, musicOk: true, now: () => w.now() }).find((x) => x.spec.name === 'edit_alarm')!;
    for (const m of [0.33333, 1 / 6]) await edit.run({ which: 'tea', add_minutes: m }, AbortSignal.timeout(1000), { userId: SAM, speaker: 'Sam' } as never);
    const t = w.clock.forUser(SAM)[0]!;
    expect(Number.isInteger(t.base)).toBe(true);
    expect(Number.isInteger(t.durationMs)).toBe(true);
    w.advance(3 * MIN);
    const dm = w.dms.at(-1)!;
    expect(ids(dm)[0]).toMatch(/^alarm:stop:\d+:\w+:[0-9a-z]+$/);
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    await w.press(ids(dm)[0]!, dm.text);
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
  });

  it('a fractional base from an older file still matches its button', async () => {
    const w = world();
    await w.text('timer', { minutes: 1 });
    const t = w.clock.forUser(SAM)[0]!;
    t.at = t.base = t.at + 0.8;
    w.advance(2 * MIN);
    const dm = w.dms.at(-1)!;
    expect(ids(dm)[0]).not.toContain('.');
    await w.press(ids(dm)[0]!, dm.text);
    expect(w.clock.ringingFor(SAM)).toHaveLength(0);
  });

  it("a button stops its own alarm only, not others ringing with it", async () => {
    const w = world();
    await w.text('timer', { minutes: 1, label: 'tea' });
    await w.text('timer', { minutes: 2, label: 'pizza' });
    w.advance(MIN);
    w.advance(MIN);
    const pizza = w.dms.at(-1)!;
    expect(w.clock.ringingFor(SAM).map((a) => a.label).sort()).toEqual(['pizza', 'tea']);
    await w.press(ids(pizza)[0]!, pizza.text);
    expect(w.clock.ringingFor(SAM).map((a) => a.label)).toEqual(['tea']);
    expect(w.clock.forUser(SAM).map((a) => a.label)).toEqual(['tea']);
  });

  it('a Snooze button snoozes its own alarm only', async () => {
    const w = world();
    await w.text('timer', { minutes: 1, label: 'tea' });
    await w.text('timer', { minutes: 2, label: 'pizza' });
    w.advance(MIN);
    w.advance(MIN);
    const pizza = w.dms.at(-1)!;
    await w.press(ids(pizza)[1]!, pizza.text);
    expect(w.clock.ringingFor(SAM).map((a) => a.label)).toEqual(['tea']);
    expect(w.clock.forUser(SAM).find((a) => a.label === 'pizza')!.snoozed).toBe(true);
  });

  it("an old-format Stop leaves a snoozed alarm alone; it acts only on what rings now", async () => {
    const w = world();
    await w.text('set', { time: '13:05', label: 'meds' });
    w.advance(5 * MIN);
    await w.text('snooze');
    const c = await w.press(`alarm:stop:${SAM}`, 'a message from last week');
    expect(c.map((x) => x.data.content)).toContain('Nothing is ringing.');
    expect(w.clock.forUser(SAM)[0]!.snoozed).toBe(true);
    w.advance(9 * MIN);
    expect(w.clock.ringingFor(SAM)).toHaveLength(1);
    await w.press(`alarm:stop:${SAM}`, 'a message from last week');
    expect(w.clock.forUser(SAM)).toHaveLength(0);
  });

  it('stopping a snoozed alarm is not spoken where they are; stopping a ring is', async () => {
    const w = world();
    await w.text('set', { time: '13:05' });
    w.advance(5 * MIN);
    const dm = w.dms.at(-1)!;
    await w.text('snooze');
    expect(w.said).toHaveLength(1); // it was ringing
    w.said.length = 0;
    expect(await w.text('stop', {}, SAM, 'guild')).toMatch(/^Alarm off/);
    expect(w.said).toHaveLength(0);
    // The same through a button.
    await w.text('set', { time: '13:20' });
    w.advance(15 * MIN);
    const dm2 = w.dms.at(-1)!;
    w.advance(10 * MIN); // nobody answered: snoozed itself
    expect(w.clock.forUser(SAM)[0]!.snoozed).toBe(true);
    w.said.length = 0;
    expect(dm2).not.toBe(dm);
    const c = await w.press(ids(dm2)[0]!, dm2.text);
    expect(String(c[0]!.data.content)).toContain('→ Alarm off');
    expect(w.said).toHaveLength(0);
  });

  it('an edit that fails for another reason still says what happened, never "that didn\'t work"', async () => {
    const w = world();
    const r = await ringing(w);
    w.failWith((kind) => (kind === 7 ? new DiscordAPIError({ code: 50035, message: 'Invalid Form Body' }, 50035, 400, 'POST', 'https://discord.com/api/v10/interactions/x/y/callback', { body: undefined }) : undefined));
    const c = await w.press(r.stop, r.dm.text);
    expect(w.clock.forUser(SAM)).toHaveLength(0);
    const ok = c.filter((x) => !x.failed);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.data.content).toBe('Timer stopped.');
    expect(ephemeral(ok[0]!)).toBe(true);
  });
});
