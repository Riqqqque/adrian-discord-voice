import { EventEmitter } from 'node:events';
import { ChannelType, Collection, Events } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { type AskOptions, historyBlock, NAME_IN_TEXT, registerTextChat } from '../src/app/textchat.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const BOT = 'bot';

interface Fake {
  id: string;
  author: string;
  content: string;
  mentions?: string[];
  replyTo?: string;
}

function rig(opts: { readChannels?: boolean; answer?: (text: string, o: AskOptions) => string } = {}) {
  const client = Object.assign(new EventEmitter(), { user: { id: BOT } });
  const sent: string[] = [];
  const asked: { text: string; opts: AskOptions }[] = [];
  const past: Fake[] = [];
  let t = 1_000;
  const user = (id: string) => ({ id, bot: id === BOT, username: id, globalName: id });
  const channel = {
    type: ChannelType.GuildText,
    sendTyping: async () => undefined,
    messages: {
      fetch: async () => {
        const c = new Collection<string, unknown>();
        for (const p of [...past].reverse()) c.set(p.id, msg(p, false));
        return c;
      },
    },
  };
  function msg(f: Fake, live = true) {
    const users = new Collection<string, ReturnType<typeof user>>();
    for (const u of f.mentions ?? []) users.set(u, user(u));
    return {
      id: f.id,
      author: user(f.author),
      system: false,
      channel,
      guildId: 'G',
      channelId: 'C',
      content: f.content,
      cleanContent: f.content.replace(/<@!?(\w+)>/g, '@$1'),
      attachments: new Collection(),
      stickers: new Collection(),
      member: null,
      mentions: { users, roles: new Collection(), everyone: false, members: null, repliedUser: f.replyTo ? user(f.replyTo) : null },
      reference: f.replyTo ? { messageId: 'r' } : null,
      fetchReference: async () => undefined,
      reply: async ({ content }: { content: string }) => {
        if (live) sent.push(content);
        past.push({ id: `b${past.length}`, author: BOT, content });
      },
    };
  }
  registerTextChat({
    client: client as never,
    log: quiet as never,
    ask: (_u, _n, text, _p, _s, o) => {
      asked.push({ text, opts: o });
      const a = opts.answer?.(text, o) ?? 'Sure thing.';
      return (async function* () {
        if (a === 'SILENT') o.onSilent();
        else yield a;
      })();
    },
    limited: () => undefined,
    enabled: true,
    dms: true,
    allowedGuilds: [],
    maxQuestionChars: 500,
    maxReplyChars: 1800,
    readChannels: opts.readChannels ?? true,
    historyMessages: 30,
    followUpMs: 180_000,
    maxPings: 5,
    now: () => t,
  });
  let n = 0;
  const say = async (author: string, content: string, extra: Partial<Fake> = {}) => {
    const f = { id: `m${n++}`, author, content, ...extra };
    client.emit(Events.MessageCreate, msg(f));
    await new Promise((r) => setTimeout(r, 5));
    past.push(f);
  };
  return { say, sent, asked, tick: (ms: number) => (t += ms) };
}

describe('reading channels', () => {
  it('formats earlier messages oldest first, newest kept when long', () => {
    const block = historyBlock([
      { author: 'Sam', mine: false, text: 'who won last night' },
      { author: 'x', mine: true, text: 'The Nuggets, 112-104.' },
    ]);
    expect(block[0]).toContain('Sam: who won last night\nYou: The Nuggets, 112-104.');
    const many = Array.from({ length: 50 }, (_, i) => ({ author: 'A', mine: false, text: `message ${i} ${'x'.repeat(200)}` }));
    const kept = historyBlock(many, 1_000)[0]!;
    expect(kept).toContain('message 49');
    expect(kept).not.toContain('message 0 ');
    expect(historyBlock([{ author: 'A', mine: false, text: '  ' }])).toEqual([]);
  });

  it('spots its name written out', () => {
    for (const s of ['adrian what do you think', 'what about you, Adrian?', 'A.D.R.I.A.N. help']) expect(NAME_IN_TEXT.test(s)).toBe(true);
    for (const s of ['adriana is here', 'hadrian wall', 'nothing here']) expect(NAME_IN_TEXT.test(s)).toBe(false);
  });

  it('answers an @ with the channel history as context', async () => {
    const r = rig();
    await r.say('sam', 'anyone know a good pizza place');
    expect(r.asked).toEqual([]); // not for it, no conversation open
    await r.say('rique', `<@${BOT}> what do you think`, { mentions: [BOT] });
    expect(r.sent).toEqual(['Sure thing.']);
    expect(r.asked[0]!.opts.followUp).toBe(false);
    expect(r.asked[0]!.opts.extra[0]).toContain('sam: anyone know a good pizza place');
  });

  it('carries on the conversation without another @, and stays out of side talk', async () => {
    const r = rig({ answer: (t) => (t.startsWith('lol') ? 'SILENT' : 'Yep.') });
    await r.say('rique', `<@${BOT}> hi`, { mentions: [BOT] });
    await r.say('rique', 'and what about tomorrow');
    expect(r.asked[1]!.opts.followUp).toBe(true);
    expect(r.sent).toEqual(['Yep.', 'Yep.']);
    await r.say('rique', 'lol ok');
    expect(r.sent.length).toBe(2); // SILENT: nothing sent
    await r.say('sam', 'and me?'); // not in the conversation
    expect(r.asked.length).toBe(3);
    await r.say('rique', 'hey <@sam> look', { mentions: ['sam'] }); // aimed at someone else
    expect(r.asked.length).toBe(3);
  });

  it('closes the conversation after the window or two misses', async () => {
    const r = rig({ answer: (t) => (t.startsWith('lol') ? 'SILENT' : 'Yep.') });
    await r.say('rique', `<@${BOT}> hi`, { mentions: [BOT] });
    r.tick(181_000);
    await r.say('rique', 'still there?');
    expect(r.asked.length).toBe(1);
    await r.say('rique', `<@${BOT}> back`, { mentions: [BOT] });
    await r.say('rique', 'lol');
    await r.say('rique', 'lol again');
    await r.say('rique', 'so anyway');
    expect(r.asked.length).toBe(4); // closed after two misses
  });

  it('its name counts as a follow-up from anyone', async () => {
    const r = rig();
    await r.say('sam', 'adrian you there');
    expect(r.asked[0]!.opts.followUp).toBe(true);
    expect(r.sent).toEqual(['Sure thing.']);
  });

  it('without Message Content: only @mentions, no history', async () => {
    const r = rig({ readChannels: false });
    await r.say('sam', 'adrian you there');
    expect(r.asked).toEqual([]);
    await r.say('rique', `<@${BOT}> hi`, { mentions: [BOT] });
    await r.say('rique', 'and tomorrow?');
    expect(r.asked.length).toBe(1);
    expect(r.asked[0]!.opts.extra).toEqual([]);
  });
});
