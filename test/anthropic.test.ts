import { describe, expect, it } from 'vitest';
import { toClaude } from '../src/brain/anthropic.js';

describe('Claude message conversion', () => {
  it('puts a cache breakpoint after the stable system block only', () => {
    const r = toClaude([
      { role: 'system', content: 'Rules and identity.', cache: true },
      { role: 'system', content: 'You are talking with Sam. Today is Friday.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(r.system).toEqual([
      { type: 'text', text: 'Rules and identity.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'You are talking with Sam. Today is Friday.' },
    ]);
  });

  it('moves system text out, replays tool turns and groups tool results', () => {
    const claudeContent = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'get_time', input: {} }, { type: 'tool_use', id: 't2', name: 'roll_dice', input: { dice: 'd20' } }];
    const r = toClaude([
      { role: 'system', content: 'You are Adrian.' },
      { role: 'user', content: 'what time is it and roll a d20' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'get_time', arguments: '{}', extra: { claudeContent } }, { id: 't2', name: 'roll_dice', arguments: '{"dice":"d20"}' }] },
      { role: 'tool', toolCallId: 't1', content: '9 PM' },
      { role: 'tool', toolCallId: 't2', content: '17' },
    ]);
    expect(r.system).toEqual([{ type: 'text', text: 'You are Adrian.' }]);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[1]).toEqual({ role: 'assistant', content: claudeContent }); // thinking kept, replayed as sent
    expect(r.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: '9 PM' },
        { type: 'tool_result', tool_use_id: 't2', content: '17' },
      ],
    });
  });

  it('drops empty assistant turns', () => {
    expect(toClaude([{ role: 'user', content: 'hi' }, { role: 'assistant', content: '  ' }, { role: 'user', content: 'yo' }]).messages).toHaveLength(2);
  });
});
