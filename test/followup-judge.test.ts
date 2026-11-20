import { describe, expect, it } from 'vitest';
import { callFollowUp, deskFollowUp } from '../src/brain/followup.js';
import { ConversationOrchestrator } from '../src/brain/orchestrator.js';
import { SessionMemory } from '../src/brain/sessions.js';
import type { ChatMessage, LlmEvent, LlmProvider } from '../src/core/interfaces.js';

/** Answers with `reply` and keeps the last user message it was sent. */
class Echo implements LlmProvider {
  readonly model = 'fake';
  last = '';
  constructor(private readonly reply: string) {}
  async *stream(messages: ChatMessage[]): AsyncIterable<LlmEvent> {
    this.last = (messages.filter((m) => m.role === 'user').at(-1) as { content: string }).content;
    yield { type: 'text', delta: this.reply };
  }
}

function rig(reply = 'Sure.') {
  const llm = new Echo(reply);
  const o = new ConversationOrchestrator(llm, new SessionMemory(16, 60_000), [], {
    spokenName: 'Adrian', writtenName: 'A.D.R.I.A.N.', timezone: 'America/Denver', firstEventTimeoutMs: 5000, maxTokens: 100, maxToolRounds: 0, stablePrefix: true,
  });
  return { llm, o };
}

async function ask(o: ConversationOrchestrator, opts: Parameters<ConversationOrchestrator['ask']>[6] = {}) {
  let silent = false;
  const out: string[] = [];
  for await (const c of o.ask('u', 'Sam', 'and tomorrow?', AbortSignal.timeout(5000), undefined, { channelId: 'c' }, { ...opts, onSilent: () => (silent = true) })) out.push(c);
  return { out, silent };
}

describe('follow-up judge lines', () => {
  it('go only into follow-ups: a request said with her name is unchanged', async () => {
    const r = rig();
    await ask(r.o);
    expect(r.llm.last).not.toContain('SILENT');
    expect(r.llm.last).not.toContain('without using your name');
    await ask(r.o, { desk: true });
    expect(r.llm.last).not.toContain('SILENT');
  });

  it('pick the PC line at a PC and the call line in a call', async () => {
    const r = rig();
    await ask(r.o, { followUp: true, desk: true });
    expect(r.llm.last).toContain(deskFollowUp('Sam'));
    await ask(r.o, { followUp: true });
    expect(r.llm.last).toContain(callFollowUp('Sam'));
    expect(r.llm.last).not.toContain("PC's microphone");
  });

  it('leave the text-chat line as it was', async () => {
    const r = rig();
    await ask(r.o, { followUp: true, text: true });
    expect(r.llm.last).toContain('wrote this in the channel without @mentioning you');
    expect(r.llm.last).not.toContain("PC's microphone");
    expect(r.llm.last).not.toContain('the call list marks');
  });

  it('still hold back a SILENT reply', async () => {
    const r = rig('SILENT');
    const got = await ask(r.o, { followUp: true, desk: true });
    expect(got).toEqual({ out: [], silent: true });
  });
});
