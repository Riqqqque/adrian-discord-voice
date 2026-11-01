import { describe, expect, it } from 'vitest';
import { ConversationController, DEFAULT_CONTROLLER_OPTIONS, type ControllerDeps } from '../src/conversation/controller.js';

/** Test rig: fake clock; each respond() call stays open until finished or
 *  aborted, so the test controls timing. */
function rig(priority: string[] = [], extra: Partial<ControllerDeps> = {}) {
  let now = 0;
  const said: string[] = [];
  const answers: { user: string; command: string; signal: AbortSignal; finish: (outcome?: 'silent' | 'done') => void }[] = [];
  const log: string[] = [];
  const c = new ConversationController(
    {
      now: () => now,
      respond: (user, command, signal) =>
        new Promise<void | 'silent' | 'done'>((resolve) => {
          answers.push({ user, command, signal, finish: resolve });
          signal.addEventListener('abort', () => resolve());
        }),
      say: async (t) => {
        said.push(t);
      },
      isPriority: (u) => priority.includes(u),
      log: (e) => log.push(e),
      ...extra,
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

  describe('a plain "stop" while she is listening to you', () => {
    const rigged = () => {
      let stopped = 0;
      const r = rig([], { stopOther: () => void stopped++ });
      return { ...r, stopped: () => stopped };
    };
    /** An answer finished: the follow-up window is open. */
    const inFollowUp = async (r: ReturnType<typeof rig>) => {
      r.wake('a', 'what is the time');
      await r.tick();
      r.answers[0]!.finish();
      await r.tick();
      expect(r.c.listeningTo('a')).toBe(true);
    };

    it('stops the music during a follow-up', async () => {
      const r = rigged();
      await inFollowUp(r);
      r.plain('a', 'stop');
      expect(r.stopped()).toBe(1);
      expect(r.c.listeningTo('a')).toBe(false);
    });

    it('stops the music after "Yes?"', async () => {
      const r = rigged();
      r.c.heard({ userId: 'a', text: 'Hey Adrian', woke: true, command: '' });
      await r.tick();
      expect(r.said).toEqual(['Yes?']);
      r.plain('a', 'stop');
      expect(r.stopped()).toBe(1);
    });

    it('goes by when they started saying it, not when the words landed', async () => {
      const r = rigged();
      await inFollowUp(r);
      const startedAt = r.at() + 7_000;
      await r.tick(DEFAULT_CONTROLLER_OPTIONS.followUpMs + 1_000); // the window closed while it was transcribed
      r.c.heard({ userId: 'a', text: 'stop', woke: false, command: '', startedAt });
      expect(r.stopped()).toBe(1);
    });

    it('still needs the window: from someone she is not listening to, nothing', async () => {
      const r = rigged();
      await inFollowUp(r);
      r.plain('b', 'stop');
      expect(r.stopped()).toBe(0);
    });

    it('an everyday word does not stop it, and neither does "stop listening"', async () => {
      const r = rigged();
      await inFollowUp(r);
      r.plain('a', 'done');
      expect(r.stopped()).toBe(0);
      const s = rigged();
      await inFollowUp(s);
      s.plain('a', 'stop listening');
      expect(s.stopped()).toBe(0);
    });
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

  it('a sentence that only mentions stopping leaves her answer alone', async () => {
    const r = rig();
    r.wake('a', 'tell me a story');
    await r.tick(3_000);
    r.plain('b', 'we need to stop that guy');
    r.plain('b', 'fair enough');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(false);
  });

  it('"play Shut Up and Dance" is a request, not a stop', async () => {
    let stopped = 0;
    const r = rig([], { stopOther: () => void stopped++ });
    r.wake('a', 'play Shut Up and Dance');
    await r.tick();
    expect(stopped).toBe(0);
    expect(r.answers.map((x) => x.command)).toEqual(['play Shut Up and Dance']);
  });
});

describe('orders that already ran', () => {
  const owners = { canStop: (u: string) => u === 'boss', preempts: (u: string) => u === 'boss' };
  const ran = (r: ReturnType<typeof rig>) => r.answers.map((x) => `${x.user}: ${x.command}`);

  it('talking on after a tool acted does not run the order again', async () => {
    const r = rig();
    r.wake('a', 'set a timer for five minutes');
    await r.tick();
    r.c.working('a', true);
    r.c.working('a', false); // the tool is done, the model is still writing her reply
    await r.tick(1_500);
    r.plain('a', 'for the pizza');
    await r.tick();
    expect(ran(r)).toEqual(['a: set a timer for five minutes']);
    expect(r.answers[0]!.signal.aborted).toBe(false);
  });

  it('a second tool in the same answer does not reopen it', async () => {
    const r = rig();
    r.wake('a', 'tell sam hi and set a timer');
    await r.tick();
    r.c.working('a', true);
    r.c.working('a', false);
    r.c.working('a', true);
    r.c.working('a', false);
    await r.tick(1_000);
    r.plain('a', 'for five minutes');
    await r.tick();
    expect(ran(r)).toEqual(['a: tell sam hi and set a timer']);
  });

  it('an owner wake does not rerun an order that already acted', async () => {
    for (const audible of [false, true]) {
      const r = rig([], owners);
      r.wake('sam', 'tell kim hi');
      await r.tick();
      r.c.working('sam', true);
      r.c.working('sam', false);
      if (audible) r.c.speaking('sam');
      await r.tick(2_000);
      r.wake('boss', 'what time is it');
      await r.tick();
      expect(r.answers[0]!.signal.aborted).toBe(true);
      r.answers[1]!.finish();
      await r.tick();
      await r.tick();
      expect(ran(r)).toEqual(['sam: tell kim hi', 'boss: what time is it']);
    }
  });

  it('an owner wake still reruns an order whose tool was cut off half way', async () => {
    const r = rig([], owners);
    r.wake('sam', 'play some drake');
    await r.tick();
    r.c.working('sam', true); // a lookup: the abort cancels it, so nothing has happened yet
    await r.tick(2_000);
    r.wake('boss', 'what time is it');
    await r.tick();
    r.answers[1]!.finish();
    await r.tick();
    await r.tick();
    expect(ran(r)).toEqual(['sam: play some drake', 'boss: what time is it', 'sam: play some drake']);
  });

  it('an owner wake still reruns a question no tool has touched', async () => {
    const r = rig([], owners);
    r.wake('sam', 'why is the sky blue');
    await r.tick(2_000);
    r.wake('boss', 'what time is it');
    await r.tick();
    r.answers[1]!.finish();
    await r.tick();
    await r.tick();
    expect(ran(r)).toEqual(['sam: why is the sky blue', 'boss: what time is it', 'sam: why is the sky blue']);
  });
});

describe('after being told to stop', () => {
  const owner = (r: () => ReturnType<typeof rig>) => ({ canStop: (u: string) => u === 'boss', onStopped: (u: string) => r().c.announce(u, 'Yes boss.') });

  it('the stop reply does not reopen the follow-up window', async () => {
    const r = rig([], owner(() => r));
    r.wake('boss', 'tell me a long story');
    await r.tick(2_000);
    r.plain('boss', 'shut up');
    await r.tick();
    await r.tick();
    expect(r.said).toEqual(['Yes boss.']);
    expect(r.c.listeningTo('boss')).toBe(false);
    expect(r.c.listenLeftMs('boss')).toBe(0);
    r.plain('boss', 'anyway what was i saying');
    await r.tick();
    expect(r.answers).toHaveLength(1);
  });

  it('nor does the reply to a stop with nothing playing', async () => {
    const r = rig([], owner(() => r));
    r.wake('boss', 'shut up');
    await r.tick();
    expect(r.said).toEqual(['Yes boss.']);
    expect(r.c.listenLeftMs('boss')).toBe(0);
  });

  it('nor does the reply after stopping someone else while waiting on "Yes?"', async () => {
    const r = rig([], owner(() => r));
    r.c.heard({ userId: 'boss', text: 'Hey Adrian.', woke: true, command: '' });
    await r.tick(2_000);
    r.wake('sam', 'tell me a long story');
    await r.tick(2_000);
    r.plain('boss', 'stop');
    await r.tick();
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
    expect(r.c.listenLeftMs('boss')).toBe(0);
  });

  it('a stop also ends what was waiting to replace the answer', async () => {
    for (const word of ['stop', 'wait']) {
      const r = rig();
      r.wake('a', 'play the');
      await r.tick(1_000);
      r.plain('a', 'new one'); // the rest of it: this answer is ending, the whole request is next
      r.plain('a', word); // before it has finished ending
      await r.tick();
      await r.tick();
      expect(r.answers.map((x) => x.command), word).toEqual(['play the']);
    }
  });

  it("an owner's stop on someone's answer ends what they had waiting to replace it", async () => {
    const r = rig([], { canStop: (u) => u === 'boss' });
    r.wake('sam', 'play the');
    await r.tick(1_000);
    r.plain('sam', 'new one');
    r.plain('boss', 'stop');
    await r.tick();
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['play the']);
  });

  it('someone bumped by an owner can still call it off', async () => {
    const r = rig([], { canStop: (u) => u === 'boss', preempts: (u) => u === 'boss' });
    r.wake('sam', 'tell me a story');
    await r.tick(2_000);
    r.wake('boss', 'what time is it');
    r.plain('sam', 'never mind');
    await r.tick();
    r.answers[1]!.finish();
    await r.tick();
    await r.tick();
    expect(r.answers.map((x) => x.user)).toEqual(['sam', 'boss']);
  });

  it('a timer waiting behind the answer is not lost with it', async () => {
    const r = rig();
    r.wake('a', 'tell me a story');
    await r.tick(1_000);
    r.c.announce('a', 'Your timer is up.');
    r.plain('a', 'stop');
    await r.tick();
    await r.tick();
    expect(r.said).toEqual(['Your timer is up.']);
  });

  it('a timer announcement still opens the window once it has been said', async () => {
    const r = rig();
    r.c.announce('a', 'Your timer is up.');
    await r.tick();
    expect(r.said).toEqual(['Your timer is up.']);
    expect(r.c.listenLeftMs('a')).toBe(DEFAULT_CONTROLLER_OPTIONS.followUpMs);
  });

  it('a timer announcement cut off with "stop" does not', async () => {
    const r = slowSay();
    r.c.announce('a', 'Your timer is up.');
    await r.tick();
    r.plain('a', 'stop');
    await r.tick();
    await r.tick();
    expect(r.c.listenLeftMs('a')).toBe(0);
  });
});

/** A rig whose say() stays open until finished or aborted, like a line being spoken. */
function slowSay(extra: Partial<ControllerDeps> = {}) {
  const lines: { text: string; finish: () => void }[] = [];
  const r = rig([], {
    say: (text, signal) =>
      new Promise<void>((resolve) => {
        lines.push({ text, finish: resolve });
        signal?.addEventListener('abort', () => resolve());
      }),
    ...extra,
  });
  return { ...r, lines };
}

describe('the listening window', () => {
  const bareWake = (r: ReturnType<typeof rig>) => r.c.heard({ userId: 'a', text: 'Hey Adrian.', woke: true, command: '' });

  it('words begun inside the follow-up window count, even if they land after it', async () => {
    const r = rig();
    r.wake('a', 'first');
    await r.tick();
    r.answers[0]!.finish();
    await r.tick();
    await r.tick(8_700);
    expect(r.c.listeningTo('a')).toBe(false);
    expect(r.c.listeningTo('a', r.at() - 2_200)).toBe(true);
    r.c.heard({ userId: 'a', text: 'and tomorrow', woke: false, command: '', startedAt: r.at() - 2_200 });
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['first', 'and tomorrow']);
  });

  it('words begun after it closed do not', async () => {
    const r = rig();
    r.wake('a', 'first');
    await r.tick();
    r.answers[0]!.finish();
    await r.tick();
    await r.tick(9_000);
    r.c.heard({ userId: 'a', text: 'side talk', woke: false, command: '', startedAt: r.at() - 500 });
    await r.tick();
    expect(r.answers).toHaveLength(1);
  });

  it('"wait" begun inside the window keeps it open', async () => {
    const r = rig();
    r.wake('a', 'first');
    await r.tick();
    r.answers[0]!.finish();
    await r.tick();
    await r.tick(8_500);
    r.c.heard({ userId: 'a', text: 'hold on', woke: false, command: '', startedAt: r.at() - 1_000 });
    expect(r.c.listeningTo('a')).toBe(true);
  });

  it('an everyday stop begun inside the window is for her', async () => {
    let stopped = 0;
    const r = rig([], { onStopped: () => void stopped++ });
    r.wake('a', 'first');
    await r.tick();
    r.answers[0]!.finish();
    await r.tick();
    await r.tick(8_500);
    r.c.heard({ userId: 'a', text: 'done', woke: false, command: '', startedAt: r.at() - 1_000 });
    expect(stopped).toBe(1);
    r.c.heard({ userId: 'a', text: 'done', woke: false, command: '' });
    expect(stopped).toBe(1); // the window is over: just a word
  });

  it('she is listening from the start of "Yes?": words over it are the question', async () => {
    const seen: { command: string; followUp: boolean | undefined }[] = [];
    const r = slowSay({ respond: async (_u, command, _s, followUp) => void seen.push({ command, followUp }) });
    bareWake(r);
    await r.tick();
    expect(r.lines.map((l) => l.text)).toEqual(['Yes?']);
    expect(r.c.listeningTo('a')).toBe(true);
    r.plain('a', 'what time');
    await r.tick();
    await r.tick();
    expect(seen).toEqual([{ command: 'what time', followUp: undefined }]); // the question, never judged "not for me"
  });

  it('the wait after "Yes?" lasts the 20 s it says, not just the 8 s follow-up', async () => {
    const r = rig();
    bareWake(r);
    await r.tick();
    await r.tick(12_000);
    expect(r.c.listenLeftMs('a')).toBe(8_000);
    r.plain('a', 'what is the weather');
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['what is the weather']);
    r.answers[0]!.finish();
    await r.tick();
    const late = rig();
    bareWake(late);
    await late.tick();
    await late.tick(20_100);
    late.plain('a', 'too late');
    await late.tick();
    expect(late.answers).toHaveLength(0);
  });

  it('a stop or cancelAll during "Yes?" leaves her not listening', async () => {
    const stopped = slowSay();
    bareWake(stopped);
    await stopped.tick();
    stopped.plain('a', 'never mind');
    await stopped.tick();
    await stopped.tick();
    expect(stopped.c.listenLeftMs('a')).toBe(0);

    const cancelled = slowSay();
    bareWake(cancelled);
    await cancelled.tick();
    cancelled.c.cancelAll();
    await cancelled.tick();
    await cancelled.tick();
    expect(cancelled.c.listenLeftMs('a')).toBe(0);
  });

  it('the name again during "Yes?" keeps her listening', async () => {
    const r = slowSay();
    bareWake(r);
    await r.tick();
    r.c.heard({ userId: 'a', text: 'Adrian', woke: true, command: '', loose: true });
    await r.tick();
    await r.tick();
    expect(r.c.listeningTo('a')).toBe(true);
  });
});

describe("the owner's everyday words", () => {
  const owners = { canStop: (u: string) => u === 'boss', preempts: (u: string) => u === 'boss' };

  it("leave someone else's answer running, with no follow-up and no stop reply", async () => {
    for (const word of ['done', 'wait', 'one sec', 'hold on', 'hold up', 'wait a sec', 'hang on a sec']) {
      const r = rig([], { ...owners, onStopped: (u) => r.c.announce(u, 'Yes boss.') });
      r.wake('kim', 'hi'); // she spoke a moment ago
      await r.tick();
      r.answers[0]!.finish();
      await r.tick(2_000);
      r.wake('sam', 'tell me a story');
      await r.tick(3_000);
      r.plain('boss', word);
      await r.tick();
      expect(r.answers[1]!.signal.aborted, word).toBe(false);
      expect(r.c.listenLeftMs('boss'), word).toBe(0);
      r.answers[1]!.finish();
      await r.tick();
      await r.tick();
      expect(r.said, word).toEqual([]);
    }
  });

  it('a clear stop, the name, or the word with her name still stop it', async () => {
    const cases: [string, boolean][] = [['stop', false], ['Adrian', false], ['done', true], ['wait stop', false]];
    for (const [word, woke] of cases) {
      const r = rig([], owners);
      r.wake('sam', 'tell me a story');
      await r.tick(3_000);
      r.c.heard({ userId: 'boss', text: woke ? `Hey Adrian, ${word}` : word, woke, command: woke ? word : '' });
      await r.tick();
      expect(r.answers[0]!.signal.aborted, word).toBe(true);
    }
  });

  it('the same words from a priority role are treated the same', async () => {
    const r = rig(['mod']);
    r.wake('sam', 'tell me a story');
    await r.tick(3_000);
    r.plain('mod', 'one sec');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(false);
  });

  it('"hold up" still stops the person being answered', async () => {
    const r = rig();
    r.wake('a', 'tell me a story');
    await r.tick(3_000);
    r.plain('a', 'hold up');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
    expect(r.c.listeningTo('a')).toBe(true);
  });

  it('"wait a sec" from a bystander no longer stops it', async () => {
    const r = rig();
    r.wake('a', 'tell me a story');
    await r.tick(3_000);
    r.plain('b', 'wait a sec');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(false);
  });
});

describe('end of turn', () => {
  it('respond resolving "done" or "silent" closes the window, nothing opens it', async () => {
    for (const outcome of ['done', 'silent'] as const) {
      const r = rig();
      r.wake('a', 'play drake');
      await r.tick();
      r.answers[0]!.finish(outcome);
      await r.tick();
      expect(r.c.listeningTo('a'), outcome).toBe(false);
      r.plain('a', 'side remark');
      await r.tick();
      expect(r.answers, outcome).toHaveLength(1);
    }
    const r = rig();
    r.wake('a', 'what is the weather');
    await r.tick();
    r.answers[0]!.finish();
    await r.tick();
    expect(r.c.listenLeftMs('a')).toBe(DEFAULT_CONTROLLER_OPTIONS.followUpMs);
    r.plain('a', 'and tomorrow');
    await r.tick();
    expect(r.answers).toHaveLength(2);
  });

  it('a stopped answer opens no window', async () => {
    const r = rig();
    r.wake('a', 'tell me a story');
    await r.tick();
    r.plain('a', 'stop');
    await r.tick();
    expect(r.c.listeningTo('a')).toBe(false);
  });

  it('working: talk and noise leave the order alone, "stop" still aborts it', async () => {
    const r = rig();
    r.wake('a', 'play drake');
    await r.tick(3_000);
    r.c.speaking('a'); // "One sec."
    r.c.working('a', true);
    r.plain('a', 'come on');
    r.c.voiceActivity('a', 3_000);
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['play drake']);
    expect(r.answers[0]!.signal.aborted).toBe(false);
    r.plain('a', 'stop');
    await r.tick();
    expect(r.answers[0]!.signal.aborted).toBe(true);
  });

  it('working only counts for the person being answered', async () => {
    const r = rig();
    r.wake('a', 'tell me about space');
    await r.tick(3_000);
    r.c.speaking('a');
    r.c.working('b', true);
    r.c.voiceActivity('a', 3_000);
    expect(r.answers[0]!.signal.aborted).toBe(true);
  });

  it('cancelAll drops the answer, the queue and every window', async () => {
    const r = rig();
    r.c.heard({ userId: 'x', text: 'Hey Adrian.', woke: true, command: '' }); // waiting after "Yes?"
    await r.tick(2_000);
    r.wake('y', 'hi');
    await r.tick();
    r.answers[0]!.finish(); // in a follow-up
    await r.tick(2_000);
    r.wake('a', 'one');
    await r.tick(2_000);
    r.wake('b', 'two');
    await r.tick();
    expect(r.c.queued).toBe(1);
    r.c.cancelAll();
    await r.tick();
    await r.tick();
    expect(r.c.queued).toBe(0);
    expect(r.c.busy).toBe(false);
    expect(r.answers.at(-1)!.signal.aborted).toBe(true);
    for (const u of ['x', 'y', 'a', 'b']) expect(r.c.listenLeftMs(u), u).toBe(0);
  });

  it('listenChanged reports every change to the windows', async () => {
    const seen: (string | undefined)[] = [];
    const r = rig([], { listenChanged: (u) => seen.push(u) });
    r.wake('a', 'hi');
    await r.tick();
    expect(seen).toEqual([]); // nothing was open, nothing changed
    r.answers[0]!.finish();
    await r.tick();
    expect(seen).toEqual(['a']);
    r.plain('a', 'stop');
    expect(seen).toEqual(['a', 'a']);
    r.c.cancelAll();
    expect(seen).toEqual(['a', 'a', undefined, undefined]);
  });
});

describe('her name said again and again', () => {
  const repeated = { userId: 'a', text: 'Hey Adrian. Hey Adrian. Hey Adrian.', woke: true, command: 'Hey Adrian. Hey Adrian.' };

  it('gets the quick "Yes?", not the model', async () => {
    const r = rig();
    r.c.heard(repeated);
    await r.tick();
    expect(r.said).toEqual(['Yes?']);
    expect(r.answers).toHaveLength(0);
    expect(r.c.listeningTo('a')).toBe(true);
  });

  it('then the next words are the question', async () => {
    const r = rig();
    r.c.heard(repeated);
    await r.tick();
    r.plain('a', 'set a timer');
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['set a timer']);
  });

  it('a name inside a real command is still the command', async () => {
    const r = rig();
    r.c.heard({ userId: 'a', text: 'Hey Adrian, is Adrian Peterson still playing', woke: true, command: 'is Adrian Peterson still playing' });
    await r.tick();
    expect(r.said).toEqual([]);
    expect(r.answers.map((x) => x.command)).toEqual(['is Adrian Peterson still playing']);
  });
});

describe('an answer that asks something back', () => {
  it('stays listening, and the next plain words reach her', async () => {
    const r = rig();
    r.wake('a', 'play');
    await r.tick();
    r.answers[0]!.finish(); // nothing to report: "Who do you want to hear?" was said
    await r.tick();
    expect(r.c.listeningTo('a')).toBe(true);
    r.plain('a', 'Ella Langley');
    await r.tick();
    expect(r.answers.map((x) => x.command)).toEqual(['play', 'Ella Langley']);
  });
});

describe('how an announcement went', () => {
  it('said in full', async () => {
    const r = rig();
    const said = r.c.announce('a', 'Your timer is up.');
    await expect(said).resolves.toBe(true);
    expect(r.said).toEqual(['Your timer is up.']);
  });

  it('only once it has really been said, not when it joined the queue', async () => {
    const r = rig();
    r.wake('b', 'a long question');
    await r.tick();
    let settled = false;
    const said = r.c.announce('a', 'Your timer is up.').finally(() => (settled = true));
    await r.tick();
    expect(settled).toBe(false);
    r.answers[0]!.finish();
    await expect(said).resolves.toBe(true);
  });

  it('stopped by them: they heard it, so it is done', async () => {
    let cut!: () => void;
    const r = rig([], { say: (_t, signal) => new Promise<void>((res) => { cut = res; signal?.addEventListener('abort', () => res()); }) });
    const said = r.c.announce('a', 'Your timer is up.');
    await r.tick();
    r.plain('a', 'stop');
    await expect(said).resolves.toBe(true);
    expect(cut).toBeDefined();
  });

  it('cut off because she left the call', async () => {
    const r = rig([], { say: (_t, signal) => new Promise<void>((res) => signal?.addEventListener('abort', () => res())) });
    const said = r.c.announce('a', 'Your timer is up.');
    await r.tick();
    r.c.cancelAll();
    await expect(said).resolves.toBe(false);
  });

  it('still waiting in the queue when she left', async () => {
    const r = rig();
    r.wake('b', 'a long question');
    await r.tick();
    const said = r.c.announce('a', 'Your timer is up.');
    r.c.cancelAll();
    await expect(said).resolves.toBe(false);
  });

  it('cut off by an owner who needed her first', async () => {
    const r = rig([], { preempts: (u) => u === 'boss', say: (_t, signal) => new Promise<void>((res) => signal?.addEventListener('abort', () => res())) });
    const said = r.c.announce('a', 'Your timer is up.');
    await r.tick();
    r.wake('boss', 'a question');
    await expect(said).resolves.toBe(false);
  });

  it('taken out of the queue by their own "never mind"', async () => {
    const r = rig();
    r.wake('b', 'a long question');
    await r.tick();
    const said = r.c.announce('a', 'Your timer is up.');
    r.plain('a', 'never mind'); // meant for something else: the timer must not vanish with it
    await expect(said).resolves.toBe(false);
  });

  it('the voice failing is not delivered', async () => {
    const r = rig([], { say: async (t) => { if (t.includes('timer')) throw new Error('no voice'); } });
    await expect(r.c.announce('a', 'Your timer is up.')).resolves.toBe(false);
  });
});
