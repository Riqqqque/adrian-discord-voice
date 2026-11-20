import { describe, expect, it } from 'vitest';
import { ConversationOrchestrator } from '../src/brain/orchestrator.js';
import { SessionMemory } from '../src/brain/sessions.js';
import { asksMore } from '../src/brain/tools.js';
import type { ChatMessage, LlmEvent, LlmProvider, Tool, ToolContext } from '../src/core/interfaces.js';
import { alarmTools } from '../src/features/alarm-tools.js';
import { AlarmClock } from '../src/features/alarms.js';
import { discordTools, RelayLimiter } from '../src/features/discordinfo.js';
import { GameNightSignups, gameNightTool, signupLine } from '../src/features/gamenight.js';
import { UserNotes } from '../src/features/notes.js';
import { Reminders } from '../src/features/reminders.js';
import { MusicTaste } from '../src/features/taste.js';

const ctx = (said: string): ToolContext => ({ userId: 'u1', speaker: 'Sean', said, turn: 1 });
const sig = () => AbortSignal.timeout(2000);
async function say(tool: Tool, args: Record<string, unknown>, said: string) {
  const raw = (await tool.run(args, sig(), ctx(said))) as string;
  return tool.speak?.(args, raw, ctx(said));
}

describe('asking something besides', () => {
  it('sees a question in the words, with or without a question mark', () => {
    for (const s of ["remember my wifi password is on the fridge, and what's a good router?", 'I love Frank Ocean, what should I play', 'remember this and tell me a joke', 'is that saved'])
      expect(asksMore(s), s).toBe(true);
    for (const s of ['remember that my anniversary is June 12', 'I love Radiohead by the way', "I can't stand country music, don't ever play that", 'remember my sister is Maya and she hates cats', '', undefined])
      expect(asksMore(s), String(s)).toBe(false);
  });
});

describe('game-night sign-ups said back', () => {
  it('turns every join and leave result into a line to them', () => {
    const s = new GameNightSignups(undefined);
    expect(signupLine(s.join('u1'))).toBe("You're signed up for game-night pings.");
    expect(signupLine(s.join('u1', 'Valorant'))).toBe("You're already signed up for every game.");
    expect(signupLine(s.leave('u1', 'Valorant'))).toBe('No more Valorant pings for you; other games still will.');
    expect(signupLine(s.leave('u1'))).toBe('No more game-night pings for you.');
    expect(signupLine(s.join('u2', 'Valorant'))).toBe("You're signed up for Valorant pings.");
    expect(signupLine('Nobody has signed up for Valorant pings yet.')).toBeUndefined();
    expect(signupLine('Signed up for Valorant pings: Sam, Kim.')).toBeUndefined();
  });

  it('is said by the tool for English speakers only', () => {
    const deps = { guild: () => undefined, allowedGuilds: [], presences: false, signups: new GameNightSignups(undefined), lastText: () => undefined, voiceChannel: () => undefined, cooldownMs: 1, maxMentions: 10, perUserPerHour: 4 };
    const raw = 'No more game-night pings for them.';
    expect(gameNightTool(deps).speak?.({ action: 'leave' }, raw, ctx('stop pinging me'))).toBe('No more game-night pings for you.');
    expect(gameNightTool({ ...deps, english: () => false }).speak?.({ action: 'leave' }, raw, ctx('stop pinging me'))).toBeUndefined();
  });
});

describe('a music opinion of theirs', () => {
  const tool = () => new MusicTaste(undefined).tools()[0]!;
  it('gets a word back', async () => {
    expect(await say(tool(), { who: 'them', what: 'like', name: 'Radiohead' }, 'I love Radiohead by the way')).toBe('Got it, you like Radiohead.');
    expect(await say(tool(), { who: 'them', what: 'dislike', name: 'country' }, "I can't stand country music, don't ever play that")).toBe('Got it, no country.');
  });
  it('leaves the model her own taste, questions, and other languages', async () => {
    const owner = new MusicTaste(undefined, Date.now, () => true).tools()[0]!;
    expect(await say(owner, { who: 'you', what: 'like', name: 'Portishead' }, 'what music do you like')).toBeUndefined();
    expect(await say(tool(), { who: 'them', what: 'like', name: 'Frank Ocean' }, 'I love Frank Ocean, what should I play')).toBeUndefined();
    const other = new MusicTaste(undefined).tools(() => false)[0]!;
    expect(await say(other, { who: 'them', what: 'like', name: 'Radiohead' }, 'me encanta Radiohead')).toBeUndefined();
  });
});

describe('remember', () => {
  const remember = () => new UserNotes(undefined).tools()[0]!;
  it('says a word once it is saved', async () => {
    expect(await say(remember(), { note: 'anniversary is June 12' }, 'remember that my anniversary is June 12')).toBe('Got it.');
    const t = remember();
    await say(t, { note: 'takes coffee black' }, 'remember I take my coffee black');
    expect(await say(t, { note: 'takes coffee black' }, 'remember I take my coffee black')).toBe('I already have that.');
  });
  it('leaves a question with it, a full list, and other languages to the model', async () => {
    expect(await say(remember(), { note: 'wifi password is on the fridge' }, "remember my wifi password is on the fridge, and what's a good router?")).toBeUndefined();
    expect(await say(remember(), { note: '' }, 'remember that')).toBeUndefined();
    expect(await say(new UserNotes(undefined).tools(() => false)[0]!, { note: 'x' }, 'recuerda x')).toBeUndefined();
  });
});

describe('a message that went out', () => {
  it('needs only a word; the read-back stays word for word', () => {
    const [, message] = discordTools({ client: {} as never, allowedGuilds: [], members: false, presences: false, timezone: 'UTC' }, { limiter: new RelayLimiter(10, 5), isOwner: () => false, maxChars: 500 });
    expect(message!.speak?.({}, 'Sent Sam a DM.', ctx('tell sam hi'))).toBe('Sent.');
    expect(message!.speak?.({}, 'Posted in #general and pinged Sam.', ctx('tell sam hi in general'))).toBe('Posted it.');
    expect(message!.speak?.({}, "Couldn't DM Sam: their DMs are closed to me. Try how=channel.", ctx('tell sam hi'))).toBeUndefined();
  });
});

class Scripted implements LlmProvider {
  readonly model = 'fake';
  calls = 0;
  constructor(private readonly rounds: { call?: [string, Record<string, unknown>][]; say?: string }[]) {}
  async *stream(_m: ChatMessage[]): AsyncIterable<LlmEvent> {
    const r = this.rounds[this.calls++] ?? { say: 'Okay.' };
    if (r.say) yield { type: 'text', delta: r.say };
    if (r.call) yield { type: 'toolCalls', calls: r.call.map(([name, a], i) => ({ id: `t${i}`, name, arguments: JSON.stringify(a) })) };
  }
}

describe('a whole turn', () => {
  const base = { spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'UTC', firstEventTimeoutMs: 2000, maxTokens: 200, maxToolRounds: 2 };
  const rig = () => {
    const clock = new AlarmClock(undefined, 'UTC', { placeFor: () => 'discord', ring: () => ({ stop() {}, alive: () => true }), dm: async () => true });
    return { clock, tools: alarmTools({ clock, reminders: new Reminders(undefined, 'UTC', () => {}), english: () => true, reach: () => 'call', preview: async () => true, musicOk: true }) };
  };
  const ask = async (o: ConversationOrchestrator, text: string) => {
    let out = '';
    for await (const c of o.ask('u1', 'Sean', text, sig())) out += (out ? ' ' : '') + c;
    return out;
  };

  it('takes one model call for an edit that went through', async () => {
    const { clock, tools } = rig();
    clock.add({ userId: 'u1', speaker: 'Sean', kind: 'timer', label: 'pizza', at: Date.now() + 12 * 60_000, durationMs: 12 * 60_000, tz: 'UTC' });
    const llm = new Scripted([{ call: [['edit_alarm', { which: 'pizza', add_minutes: 5 }]] }]);
    const o = new ConversationOrchestrator(llm, new SessionMemory(), tools, base);
    expect(await ask(o, 'add five minutes to the pizza timer')).toBe('17 minutes left on the pizza timer.');
    expect(llm.calls).toBe(1);
  });

  it('still asks the model when the edit needs explaining', async () => {
    const { tools } = rig();
    const llm = new Scripted([{ call: [['edit_alarm', { which: 'pizza', add_minutes: 5 }]] }, { say: "You don't have a pizza timer." }]);
    const o = new ConversationOrchestrator(llm, new SessionMemory(), tools, base);
    expect(await ask(o, 'add five minutes to the pizza timer')).toBe("You don't have a pizza timer.");
    expect(llm.calls).toBe(2);
  });
});
