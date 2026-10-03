import { expect, it } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { projectSessionEvent } from '../../packages/runtime-pi/src/events.ts';

const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Private invoice text.' }],
  api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 1, stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

it('projects the existing SDK whitelist without message bodies, tool arguments or progress results', () => {
  expect(projectSessionEvent({ type: 'agent_start' }, 3)).toEqual({ eventName: 'agent_start' });
  expect(projectSessionEvent({ type: 'turn_start' }, 3)).toEqual({ eventName: 'turn_start', turnOrdinal: 3 });
  expect(projectSessionEvent({ type: 'message_end', message }, 3))
    .toEqual({ eventName: 'message_end', role: 'assistant', stopReason: 'stop' });
  expect(projectSessionEvent({ type: 'message_update', message,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '票据', partial: message } }, 3))
    .toEqual({ eventName: 'message_update', role: 'assistant', stopReason: 'stop', textBytes: 6 });
  expect(projectSessionEvent({ type: 'tool_execution_end', toolCallId: 'real-tool', toolName: 'read_fixture',
    result: { content: [{ type: 'text', text: 'Private result.' }], details: { private: 'arguments' } }, isError: false }, 3))
    .toEqual({ eventName: 'tool_execution_end' });
  expect(projectSessionEvent({ type: 'compaction_start', reason: 'manual' }, 3)).toBeNull();
});
