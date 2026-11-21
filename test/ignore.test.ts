import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationController, DEFAULT_CONTROLLER_OPTIONS } from '../src/conversation/controller.js';
import type { ToolContext } from '../src/core/interfaces.js';
import { IgnoreList, ignoreTool, MAX_MINUTES, musicRefusal, type Person } from '../src/features/ignore.js';

const OWNER = '100000000000000001';
const CO_OWNER = '100000000000000002';
const SAM = '200000000000000001';
const SAMANTHA = '200000000000000002';
const ALEX = '200000000000000003';
const BOT = '300000000000000001';

const people: Person[] = [
  { id: OWNER, name: 'Morgan' },
  { id: CO_OWNER, name: 'Jamie' },
  { id: SAM, name: 'Sam' },
  { id: SAMANTHA, name: 'Samantha' },
  { id: ALEX, name: 'Alex' },
  { id: BOT, name: 'Jukebox', bot: true },
];

/** The name lookup the bot uses, in short: exact names first, else partial. */
async function find(name: string): Promise<Person[]> {
  const q = name.toLowerCase();
  const exact = people.filter((p) => p.name.toLowerCase() === q);
  return exact.length ? exact : people.filter((p) => p.name.toLowerCase().includes(q));
}

function rig(file?: string) {
  let now = 1_000_000;
  const list = new IgnoreList(file, () => now);
  const dropped: string[] = [];
  const tool = ignoreTool({
    list,
    isOwner: (id) => id === OWNER || id === CO_OWNER,
    isAppOwner: (id) => id === OWNER,
    find,
    onIgnored: (id) => dropped.push(id),
    now: () => now,
  });
  const ctx = (userId: string): ToolContext => ({ userId, speaker: 'x' });
  const run = (by: string, args: Record<string, unknown>) => tool.run(args, AbortSignal.timeout(1000), ctx(by)) as Promise<string>;
  return { list, tool, run, dropped, advance: (ms: number) => (now += ms) };
}

describe('ignore list', () => {
  it('an owner ignores someone: everything is blocked until an owner listens again', async () => {
    const r = rig();
    expect(await r.run(OWNER, { action: 'ignore', person: 'Sam' })).toBe('Okay, ignoring Sam.');
    expect(r.list.blocks(SAM, 'everything')).toBe(true);
    expect(r.list.blocks(SAM, 'music')).toBe(true);
    expect(r.list.blocks(ALEX, 'everything')).toBe(false);
    expect(r.dropped).toEqual([SAM]);
    // Sam can't undo it, and nobody but an owner can.
    expect(await r.run(SAM, { action: 'listen_again', person: 'Sam' })).toMatch(/^Not done: only the bot's owners/);
    expect(await r.run(ALEX, { action: 'listen_again', person: 'Sam' })).toMatch(/^Not done/);
    expect(r.list.blocks(SAM, 'everything')).toBe(true);
    expect(await r.run(CO_OWNER, { action: 'listen_again', person: 'Sam' })).toBe("Okay, I'm listening to Sam again.");
    expect(r.list.blocks(SAM, 'everything')).toBe(false);
  });

  it("someone who isn't an owner can't ignore anyone", async () => {
    const r = rig();
    expect(await r.run(SAM, { action: 'ignore', person: 'Alex' })).toMatch(/^Not done: only the bot's owners/);
    expect(await r.run(SAM, { action: 'ignore', person: 'Morgan' })).toMatch(/^Not done/);
    expect(r.list.list()).toEqual([]);
  });

  it('music only: their music is refused, the rest still works', async () => {
    const r = rig();
    expect(await r.run(OWNER, { action: 'ignore', person: 'alex', scope: 'music' })).toBe('Okay, no music requests from Alex.');
    expect(r.list.blocks(ALEX, 'music')).toBe(true);
    expect(r.list.blocks(ALEX, 'everything')).toBe(false);
    expect(musicRefusal(r.list, ALEX)).toMatch(/not to take music requests/);
    expect(musicRefusal(r.list, SAM)).toBeUndefined();
    expect(await r.run(OWNER, { action: 'listen_again', person: 'Alex' })).toBe("Okay, I'll take Alex's music requests again.");
  });

  it('protects the app owner, and only the app owner can ignore another owner', async () => {
    const r = rig();
    expect(await r.run(CO_OWNER, { action: 'ignore', person: 'Morgan' })).toMatch(/owns me/);
    expect(await r.run(OWNER, { action: 'ignore', person: 'Morgan' })).toMatch(/can't ignore yourself/);
    expect(await r.run(CO_OWNER, { action: 'ignore', person: 'Jamie' })).toMatch(/can't ignore yourself/);
    expect(await r.run(CO_OWNER, { action: 'ignore', person: 'Jamie' })).not.toBe('Okay, ignoring Jamie.');
    expect(r.list.list()).toEqual([]);
    expect(await r.run(OWNER, { action: 'ignore', person: 'Jamie' })).toBe('Okay, ignoring Jamie.');
    // An ignored co-owner still can't touch the list: they aren't heard at all,
    // and the app owner's word is the last one.
    expect(r.list.blocks(CO_OWNER, 'everything')).toBe(true);
  });

  it('asks which one when a name fits several people, and never picks a bot', async () => {
    const r = rig();
    expect(await r.run(OWNER, { action: 'ignore', person: 'sa' })).toBe('Not done: which one? Sam, Samantha.');
    // A whole name is that person, even if it starts another one's.
    expect(await r.run(OWNER, { action: 'ignore', person: 'Sam' })).toBe('Okay, ignoring Sam.');
    expect(await r.run(OWNER, { action: 'ignore', person: 'Jukebox' })).toMatch(/can't find anyone called Jukebox/);
    expect(await r.run(OWNER, { action: 'ignore', person: 'Nobody' })).toMatch(/can't find anyone called Nobody/);
    expect(await r.run(OWNER, { action: 'ignore' })).toBe('Not done: say who.');
  });

  it('a timed ignore ends by itself', async () => {
    const r = rig();
    expect(await r.run(OWNER, { action: 'ignore', person: 'Sam', minutes: 30 })).toBe('Okay, ignoring Sam for 30 more minutes.');
    r.advance(29 * 60_000);
    expect(r.list.blocks(SAM, 'everything')).toBe(true);
    expect(await r.run(OWNER, { action: 'list' })).toBe('Ignoring: Sam (everything, for 1 more minute).');
    r.advance(60_000);
    expect(r.list.blocks(SAM, 'everything')).toBe(false);
    expect(await r.run(OWNER, { action: 'list' })).toBe("I'm not ignoring anyone.");
    // Capped at a week; nonsense times mean "until I say so".
    await r.run(OWNER, { action: 'ignore', person: 'Alex', minutes: 10 ** 9 });
    expect(r.list.get(ALEX)!.until).toBe(1_000_000 + 30 * 60_000 + MAX_MINUTES * 60_000);
    await r.run(OWNER, { action: 'ignore', person: 'Sam', minutes: -5 });
    expect(r.list.get(SAM)!.until).toBeUndefined();
  });

  it('survives a restart, and a broken file is kept aside instead of written over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ignore-'));
    const file = join(dir, 'ignored.json');
    const a = rig(file);
    await a.run(OWNER, { action: 'ignore', person: 'Sam' });
    await a.run(OWNER, { action: 'ignore', person: 'Alex', scope: 'music' });
    const b = rig(file);
    expect(b.list.blocks(SAM, 'everything')).toBe(true);
    expect(b.list.blocks(ALEX, 'everything')).toBe(false);
    expect(b.list.blocks(ALEX, 'music')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).people).toHaveLength(2);

    writeFileSync(file, '{ not json');
    const c = rig(file);
    expect(c.list.list()).toEqual([]);
    expect(readdirSync(dir).some((f) => f.startsWith('ignored.json.bad-'))).toBe(true);
  });

  it('only list is a look-up; ignoring is an action, and her line is the result', () => {
    const r = rig();
    const acts = r.tool.acts as (a: Record<string, unknown>) => boolean;
    expect(acts({ action: 'list' })).toBe(false);
    expect(acts({ action: 'ignore' })).toBe(true);
    expect(r.tool.speak!({}, 'Okay, ignoring Sam.', { userId: OWNER, speaker: 'x' })).toBe('Okay, ignoring Sam.');
  });
});

describe('controller.forget', () => {
  function rig() {
    let now = 0;
    const answers: { user: string; command: string; signal: AbortSignal; finish: () => void }[] = [];
    const c = new ConversationController(
      {
        now: () => now,
        respond: (user, command, signal) =>
          new Promise<void>((resolve) => {
            answers.push({ user, command, signal, finish: resolve });
            signal.addEventListener('abort', () => resolve());
          }),
        say: async () => {},
        isPriority: () => false,
      },
      DEFAULT_CONTROLLER_OPTIONS,
    );
    // Wakes a few seconds apart: two at once read as one wake heard twice.
    const wake = (userId: string, command: string) => ((now += 3_000), c.heard({ userId, text: `Hey Adrian, ${command}`, woke: true, command }));
    return { c, answers, wake, tick: () => new Promise((r) => setTimeout(r, 0)) };
  }

  it("aborts the answer to them that's running", async () => {
    const r = rig();
    r.wake('sam', 'call Morgan a clown');
    await r.tick();
    expect(r.answers.map((a) => a.command)).toEqual(['call Morgan a clown']);
    r.c.forget('sam');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
    expect(r.c.listeningTo('sam')).toBe(false);
  });

  it("drops their queued question; others' stay", async () => {
    const r = rig();
    r.wake('alex', 'what time is it');
    await r.tick();
    r.wake('sam', 'play something loud');
    r.wake('jo', 'tell me a joke');
    await r.tick();
    r.c.forget('sam');
    r.answers[0]!.finish();
    for (let i = 0; i < 5; i++) await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(false);
    expect(r.answers.map((a) => a.command)).toEqual(['what time is it', 'tell me a joke']);
  });
});
