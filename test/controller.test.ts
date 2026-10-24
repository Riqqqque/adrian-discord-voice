import { describe, expect, it } from 'vitest';
import { ConversationController, DEFAULT_CONTROLLER_OPTIONS } from '../src/conversation/controller.js';

/** Test rig: fake clock; each respond() call stays open until finished or
 *  aborted, so the test controls timing. */
function rig(priority: string[] = []) {
  let now = 0;
  const said: string[] = [];
  const answers: { user: string; command: string; signal: AbortSignal; finish: () => void }[] = [];
  const log: string[] = [];
  const c = new ConversationController(
    {
      now: () => now,
      respond: (user, command, signal) =>
        new Promise<void>((resolve) => {
          answers.push({ user, command, signal, finish: resolve });
          signal.addEventListener('abort', () => resolve());
        }),
      say: async (t) => {
        said.push(t);
      },
      isPriority: (u) => priority.includes(u),
      log: (e) => log.push(e),
    },
    DEFAULT_CONTROLLER_OPTIONS,
  );
  const tick = async (ms = 0) => {
    now += ms;
    await new Promise((r) => setTimeout(r, 0));
  };
  const wake = (user: string, command: string) => c.heard({ userId: user, text: `Hey Adrian, ${command}`, woke: true, command });
  const plain = (user: string, text: string) => c.heard({ userId: user, text, woke: false, command: '' });
  return { c, said, answers, log, tick, wake, plain, at: () => now };
}

describe('conversation controller', () => {
  it('answers a wake and ignores speech without one', async () => {
    const r = rig();
    r.plain('a', 'what time is it');
    await r.tick();
    expect(r.answers).toHaveLength(0);
    r.wake('a', 'what time is it');
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['what time is it']);
  });

  it('says "Yes?" to a bare wake, then takes the follow-up without a wake', async () => {
    const r = rig();
    r.c.heard({ userId: 'a', text: 'Hey Adrian.', woke: true, command: '' });
    await r.tick();
    expect(r.said).toEqual(['Yes?']);
    r.plain('a', 'what is the weather');
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['what is the weather']);
  });

  it('follow-up window is per user and expires after 8 s', async () => {
    const r = rig();
    r.wake('a', 'first');
    await r.tick();
    r.answers[0]!.finish();
    await r.tick(100);
    r.plain('b', 'not addressed to Adrian'); // other user: needs a wake
    await r.tick();
    expect(r.answers).toHaveLength(1);
    r.plain('a', 'second'); // same user within 8 s: accepted
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['first', 'second']);
    r.answers[1]!.finish();
    await r.tick();
    await r.tick(8_100);
    r.plain('a', 'too late');
    await r.tick();
    expect(r.answers).toHaveLength(2);
  });

  it('queues at most 2 and answers them in order', async () => {
    const r = rig();
    r.wake('a', 'one');
    await r.tick(2_000);
    r.wake('b', 'two');
    await r.tick(1_600); // outside the duplicate-wake window
    r.wake('c', 'three');
    await r.tick(1_600);
    r.wake('d', 'four'); // queue full
    await r.tick();
    expect(r.c.queued).toBe(2);
    expect(r.log).toContain('dropped (queue full)');
    r.answers[0]!.finish();
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['one', 'two']);
    r.answers[1]!.finish();
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['one', 'two', 'three']);
  });

  it('drops a request that waited more than 10 s with a short apology', async () => {
    const r = rig();
    r.wake('a', 'long one');
    await r.tick(2_000);
    r.wake('b', 'quick question');
    await r.tick(11_000);
    r.answers[0]!.finish();
    await r.tick();
    expect(r.said).toEqual(['Sorry, I missed that.']);
    expect(r.answers).toHaveLength(1);
  });

  it('only the first of several near-simultaneous wakes wins', async () => {
    const r = rig();
    r.wake('a', 'first');
    await r.tick(800);
    r.wake('b', 'second'); // within 1.5 s → ignored
    await r.tick();
    expect(r.c.queued).toBe(0);
    expect(r.log).toContain('wake ignored (duplicate)');
    await r.tick(1_000); // now outside the window
    r.wake('c', 'third');
    await r.tick();
    expect(r.c.queued).toBe(1);
  });

  it('stops when the asker says stop, never mind or Adrian', async () => {
    for (const word of ['stop', 'Never mind.', 'Adrian', 'cancel']) {
      const r = rig();
      r.wake('a', 'tell me a long story');
      await r.tick(2_000);
      r.plain('a', word);
      await r.tick();
      expect(r.answers[0]!.signal.aborted).toBe(true);
      expect(r.answers).toHaveLength(1); // the stop word is not a new request
    }
  });

  it("someone else saying just the name doesn't stop it; a priority role's does", async () => {
    const r = rig(['mod']);
    r.wake('a', 'story');
    await r.tick(2_000);
    r.plain('b', 'Adrian?');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(false);
    r.plain('mod', 'Adrian');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
  });

  it('barge-in: the asker talking over the answer for 2.5 s stops it', async () => {
    const r = rig();
    r.wake('a', 'story');
    await r.tick(3_000);
    r.c.speaking('a'); // the answer is playing
    r.c.voiceActivity('b', 2_000); // another user talking: no effect
    r.c.voiceActivity('a', 700); // a laugh or an uh-huh: no effect
    r.c.voiceActivity('a', 2_000); // a reaction or side talk: no effect
    expect(r.answers[0]!.signal.aborted).toBe(false);
    r.c.voiceActivity('a', 2_600);
    expect(r.answers[0]!.signal.aborted).toBe(true);
    await r.tick(100);
    r.plain('a', 'actually, what time is it'); // continues without a wake
    await r.tick();
    expect(r.answers.at(-1)!.command).toBe('actually, what time is it');
  });

  it('cancels a queued request when its owner says never mind', async () => {
    const r = rig();
    r.wake('a', 'one');
    await r.tick(2_000);
    r.wake('b', 'two');
    await r.tick();
    expect(r.c.queued).toBe(1);
    r.plain('b', 'never mind');
    await r.tick();
    expect(r.c.queued).toBe(0);
    expect(r.answers[0]!.signal.aborted).toBe(false);
  });

  it('apologizes when an answer fails', async () => {
    let now = 0;
    const said: string[] = [];
    const c = new ConversationController({
      now: () => now,
      respond: async () => {
        throw new Error('LLM HTTP 500');
      },
      say: async (t) => {
        said.push(t);
      },
      isPriority: () => false,
    });
    c.heard({ userId: 'a', text: 'Hey Adrian, hi', woke: true, command: 'hi' });
    await new Promise((r) => setTimeout(r, 0));
    now += 10;
    expect(said).toEqual(["Sorry, I couldn't get an answer just now."]);
  });

  it('"shut up" from the asker stops the answer and ends the follow-up', async () => {
    const r = rig();
    r.wake('a', 'tell me a long story');
    await r.tick(1000);
    r.plain('a', 'Shut up.');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
    r.plain('a', 'what is the weather'); // no wake: must not be taken as a follow-up
    await r.tick();
    expect(r.answers).toHaveLength(1);
  });

  it('anyone in the call can cut it off with a stop phrase', async () => {
    const r = rig();
    r.wake('a', 'tell me a long story');
    await r.tick(1000);
    r.plain('b', 'shut up'); // someone else, no name needed
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
  });

  it('after "Yes?" the next words are always taken as the question', async () => {
    let followUps: (boolean | undefined)[] = [];
    const { ConversationController: C } = await import('../src/conversation/controller.js');
    const c = new C({ now: () => 0, respond: async (_u, _c, _s, f) => void followUps.push(f), say: async () => {}, isPriority: () => false });
    c.heard({ userId: 'a', text: 'Hey Adrian.', woke: true, command: '' });
    await new Promise((res) => setTimeout(res, 0));
    c.heard({ userId: 'a', text: 'what time is it', woke: false, command: '' });
    await new Promise((res) => setTimeout(res, 0));
    expect(followUps).toEqual([undefined]); // direct: never judged "not for me"
    followUps = [];
    c.heard({ userId: 'a', text: 'lol nice', woke: false, command: '' }); // a later follow-up is judged
    await new Promise((res) => setTimeout(res, 0));
    expect(followUps).toEqual([true]);
  });

  it('loose wakes (bare name, mid-sentence) are judged by the model', async () => {
    const seen: (boolean | undefined)[] = [];
    const { ConversationController: C } = await import('../src/conversation/controller.js');
    const c = new C({ now: () => 0, respond: async (_u, _c, _s, f) => void seen.push(f), say: async () => {}, isPriority: () => false });
    c.heard({ userId: 'a', text: 'Adrian what time is it', woke: true, command: 'what time is it', loose: true });
    await new Promise((res) => setTimeout(res, 0));
    expect(seen).toEqual([true]);
  });

  it('a stop with nothing playing stays silent', async () => {
    const r = rig();
    r.wake('a', 'shut up');
    await r.tick();
    expect(r.answers).toHaveLength(0);
    expect(r.said).toEqual([]);
  });

  it('the owner can say stop to anyone, but talking does not cut others off', async () => {
    const r = rig();
    // rig() has no canStop; build one where 'owner' may stop anyone.
    const answers: { signal: AbortSignal }[] = [];
    let now = 0;
    const { ConversationController: C } = await import('../src/conversation/controller.js');
    const c = new C({
      now: () => now,
      respond: (_u, _c, signal) => new Promise<void>((res) => { answers.push({ signal }); signal.addEventListener('abort', () => res()); }),
      say: async () => {},
      isPriority: () => false,
      canStop: (u) => u === 'owner',
    });
    c.heard({ userId: 'friend', text: 'Hey Adrian, tell me a story', woke: true, command: 'tell me a story' });
    await r.tick();
    now += 2000;
    c.voiceActivity('owner', 2000); // the owner chatting with someone else
    expect(answers[0]!.signal.aborted).toBe(false);
    c.heard({ userId: 'owner', text: 'stop', woke: false, command: '' });
    expect(answers[0]!.signal.aborted).toBe(true);
  });

  it('an owner cuts the line and gets the stop reply', async () => {
    const answers: { user: string; signal: AbortSignal }[] = [];
    const said: string[] = [];
    const { ConversationController: C } = await import('../src/conversation/controller.js');
    const c = new C({
      now: () => 0,
      respond: (u, _c, signal) => new Promise<void>((res) => { answers.push({ user: u, signal }); signal.addEventListener('abort', () => res()); }),
      say: async (t) => void said.push(t),
      isPriority: () => false,
      canStop: (u) => u === 'boss',
      preempts: (u) => u === 'boss',
      onStopped: (u) => { if (u === 'boss') c.announce(u, 'Yes boss.'); },
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    c.heard({ userId: 'friend', text: 'Hey Adrian, long story', woke: true, command: 'long story' });
    await tick();
    c.heard({ userId: 'boss', text: 'Hey Adrian, what time is it', woke: true, command: 'what time is it' });
    await tick();
    expect(answers[0]!.signal.aborted).toBe(true); // the friend's answer stopped
    expect(answers[1]!.user).toBe('boss'); // owner answered next
    c.heard({ userId: 'boss', text: 'shut up', woke: false, command: '' });
    await tick();
    await tick();
    expect(answers[1]!.signal.aborted).toBe(true);
    expect(said).toEqual(['Yes boss.']);
    await tick();
    expect(answers[2]!.user).toBe('friend'); // the friend who was cut off is answered after
  });

  it("the owner's side talk in a follow-up doesn't cut off someone else", async () => {
    const answers: { user: string; command: string; signal: AbortSignal }[] = [];
    const { ConversationController: C } = await import('../src/conversation/controller.js');
    let t = 0;
    const c = new C({
      now: () => t,
      respond: (u, command, signal) => {
        answers.push({ user: u, command, signal });
        return u === 'boss' ? Promise.resolve() : new Promise<void>((res) => signal.addEventListener('abort', () => res()));
      },
      say: async () => {},
      isPriority: () => false,
      canStop: (u) => u === 'boss',
      preempts: (u) => u === 'boss',
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    c.heard({ userId: 'boss', text: 'Hey Adrian, what time is it', woke: true, command: 'what time is it' });
    await tick();
    t += 3_000; // past the duplicate-wake window, still in the boss's follow-up
    c.heard({ userId: 'friend', text: 'Hey Adrian, tell me a story', woke: true, command: 'tell me a story' });
    await tick();
    c.heard({ userId: 'boss', text: 'bro go left, left', woke: false, command: '' }); // boss is still in his follow-up window
    await tick();
    expect(answers[1]!.user).toBe('friend');
    expect(answers[1]!.signal.aborted).toBe(false);
  });

  it('the owner hears the stop reply every time the shut up is for the bot', async () => {
    let now = 0;
    const said: string[] = [];
    const { ConversationController: C } = await import('../src/conversation/controller.js');
    const c = new C({
      now: () => now,
      respond: async () => {},
      say: async (t) => void said.push(t),
      isPriority: () => false,
      canStop: (u) => u === 'boss',
      onStopped: (u) => { if (u === 'boss') c.announce(u, 'Yes boss.'); },
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    c.heard({ userId: 'boss', text: 'Hey Adrian, shut up', woke: true, command: 'shut up' }); // idle, but said its name
    await tick();
    expect(said).toEqual(['Yes boss.']);
    now += 5_000; // right after it spoke
    c.heard({ userId: 'boss', text: 'shut up', woke: false, command: '' });
    await tick();
    expect(said).toEqual(['Yes boss.', 'Yes boss.']);
    now += 60_000; // a minute of quiet: talking to a friend, not the bot
    c.heard({ userId: 'boss', text: 'shut up', woke: false, command: '' });
    await tick();
    expect(said).toHaveLength(2);
  });

  it('the name alone answers "Yes?" when quiet, and stops its own asker mid-answer', async () => {
    const r = rig();
    r.c.heard({ userId: 'a', text: 'Adrian?', woke: true, command: '', loose: true });
    await r.tick();
    expect(r.said).toEqual(['Yes?']);
    r.wake('a', 'tell me a long story');
    await r.tick(2000);
    r.c.heard({ userId: 'a', text: 'Adrian', woke: true, command: '', loose: true });
    await r.tick();
    expect(r.answers.at(-1)!.signal.aborted).toBe(true);
  });
});


describe('everyday words vs real stops', () => {
  it('"done" from someone else does not stop an answer; "shut up" does; "done" from the asker does', async () => {
    const r = rig();
    r.wake('a', 'tell me a story');
    await r.tick(3_000);
    r.plain('b', 'done'); // a friend finishing their game round
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(false);
    r.plain('b', 'shut up');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);

    r.wake('a', 'another story');
    await r.tick(3_000);
    r.plain('a', 'done'); // the person being answered
    await r.tick();
    expect(r.answers[1]!.signal.aborted).toBe(true);
  });

  it('"Hey Adrian, quiet" from anyone counts', async () => {
    const r = rig();
    r.wake('a', 'tell me a story');
    await r.tick(3_000);
    r.c.heard({ userId: 'b', text: 'Hey Adrian, quiet', woke: true, command: 'quiet' });
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
  });

  it('music only stops for a stop aimed at the bot', async () => {
    let stopped = 0;
    const c = new ConversationController(
      { now: () => 100_000, respond: async () => {}, say: async () => {}, isPriority: () => false, stopOther: () => void stopped++ },
      DEFAULT_CONTROLLER_OPTIONS,
    );
    c.heard({ userId: 'b', text: 'quiet', woke: false, command: '' }); // chatter, nothing playing
    expect(stopped).toBe(0);
    c.heard({ userId: 'b', text: 'Hey Adrian, stop', woke: true, command: 'stop' });
    expect(stopped).toBe(1);
  });

  it('a pause mid-sentence continues the same request instead of replacing it', async () => {
    const r = rig();
    r.wake('a', 'open spotify and');
    await r.tick(900);
    r.plain('a', 'play some drake');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
    expect(r.answers.at(-1)!.command).toBe('open spotify and play some drake');
  });

  it('talking only interrupts once she is actually speaking', async () => {
    const r = rig();
    r.wake('a', 'tell me about space');
    await r.tick(1000);
    r.c.voiceActivity('a', 3000); // still thinking: not an interruption
    expect(r.answers[0]!.signal.aborted).toBe(false);
    r.c.speaking('a');
    await r.tick(3000);
    r.c.voiceActivity('a', 3000);
    expect(r.answers[0]!.signal.aborted).toBe(true);
  });

  it('"wait" stops her but keeps listening; "shut up" ends it', async () => {
    const r = rig();
    r.wake('a', 'tell me a long story');
    await r.tick();
    r.plain('a', 'hold on');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
    r.plain('a', 'make it about pirates');
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['tell me a long story', 'make it about pirates']);
    r.plain('a', 'shut up');
    await r.tick();
    expect(r.answers[1]!.signal.aborted).toBe(true);
    r.plain('a', 'and another thing');
    await r.tick();
    expect(r.answers).toHaveLength(2);
  });
});
