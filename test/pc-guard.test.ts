import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/core/interfaces.js';
import { judge } from '../src/satellite/target.js';
import { confirmation, pcTools } from '../src/satellite/tools.js';
import { allCases, falseRefusal, outcome, passes, wrongPc } from './pc-guard-cases.js';

describe('the house guard table', () => {
  const cases = allCases();
  const cats = [...new Set(cases.map((c) => c.cat))];
  for (const cat of cats)
    it(cat, async () => {
      const bad: string[] = [];
      for (const c of cases.filter((x) => x.cat === cat)) {
        const { out, result } = await outcome(pcTools as never, c.said, c.call);
        if (!passes(c, out)) bad.push(`${c.want} but ${out}${wrongPc(c, out) ? ' (REACHED THE PC)' : falseRefusal(c, out) ? ' (refused)' : ''}: ${c.call[0]} ${JSON.stringify(c.call[1])} for ${JSON.stringify(c.said)} -> ${result.slice(0, 80)}`);
      }
      expect(bad).toEqual([]);
    });

  it('stays quick on a long text message', () => {
    const long = 'so about the party tomorrow, my mom said the front door should be locked and the lights in the kitchen turned off, then '.repeat(25);
    const t = performance.now();
    expect(judge(`${long} lock my pc`, 'pc_system', 'lock').go).toBe(true);
    expect(performance.now() - t).toBeLessThan(250);
  });

  it('is big enough to mean something', () => {
    expect(cases.filter((c) => !c.cat.startsWith('generated') && !c.cat.startsWith('house-only')).length).toBeGreaterThan(400);
  });
});

function kit() {
  const sent: { name: string; args: Record<string, unknown> }[] = [];
  const pc = { version: '0.17.1', action: async (name: string, args: Record<string, unknown>) => (sent.push({ name, args }), { ok: true, result: 'Done.' }) };
  const tools = pcTools({ pcFor: () => pc as never });
  const tool = (name: string) => tools.find((t) => t.spec.name === name)!;
  const run = (name: string, args: Record<string, unknown>, said: string, turn: number) => {
    const ctx: ToolContext = { userId: 'u1', speaker: 'Alex', said, turn, channelId: 'sat:x' };
    return tool(name).run(args, AbortSignal.timeout(1000), ctx) as Promise<string>;
  };
  return { sent, run, tool };
}

describe('when it is not clear the PC is meant, lock and screen_off ask first', () => {
  it('asks, says the question itself, and a yes on the next turn does it', async () => {
    const { sent, run, tool } = kit();
    const q = await run('pc_system', { action: 'lock' }, 'lock the windows', 1);
    expect(q).toBe('Lock the PC?');
    expect(sent).toEqual([]);
    // The question is her line, and its answer is listened for.
    expect(tool('pc_system').speak!({ action: 'lock' }, q, {} as never)).toBe('Lock the PC?');
    expect(tool('pc_system').asks!(q)).toBe(true);
    expect(confirmation('pc_system', { action: 'lock' }, q)).toBe('Lock the PC?');
    expect(await run('pc_system', { action: 'lock' }, 'yes', 2)).toBe('Done.');
    expect(sent.map((s) => s.args.action)).toEqual(['lock']);
    expect(sent[0]!.args.confirmed).toBeUndefined();
  });

  it('does nothing on a no, or on a yes that comes too late', async () => {
    const { sent, run } = kit();
    expect(await run('pc_system', { action: 'screen_off' }, 'turn off the computer room lights', 1)).toBe("Turn off the PC's screens?");
    expect(await run('pc_system', { action: 'screen_off' }, 'no, the lights', 2)).toMatch(/^Didn't happen: .*lights/);
    expect(await run('pc_system', { action: 'lock' }, 'turn off the fan and lock it', 3)).toBe('Lock the PC?');
    // The turn that asked can't answer itself.
    expect(await run('pc_system', { action: 'lock' }, 'turn off the fan and lock it', 3)).toMatch(/^Didn't happen: a question is already waiting/);
    expect(sent).toEqual([]);
  });

  it('a clear house order is refused, not asked', async () => {
    const { sent, run } = kit();
    expect(await run('pc_system', { action: 'lock' }, 'lock the office door', 1)).toMatch(/^Didn't happen: Alex asked about the door/);
    expect(await run('pc_system', { action: 'screen_off' }, 'turn off the ceiling fan', 2)).toMatch(/fan/);
    expect(await run('pc_system', { action: 'shutdown' }, 'shut down the office tv', 3)).toMatch(/^Didn't happen: .*tv/);
    expect(sent).toEqual([]);
  });

  it('a clear PC order is not asked', async () => {
    const { sent, run } = kit();
    for (const [said, action] of [['lock my pc', 'lock'], ['lock it', 'lock'], ['turn off my screens', 'screen_off'], ["lock my pc, I'm heading out the front door", 'lock']] as const)
      expect(await run('pc_system', { action }, said, 1), said).toBe('Done.');
    expect(sent.length).toBe(4);
  });
});
