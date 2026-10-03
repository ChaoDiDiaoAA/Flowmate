import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { NativeObservation } from '@flowmate/contracts';

type SessionEvent = Parameters<Parameters<AgentSession['subscribe']>[0]>[0];
type AgentEventData = Extract<NativeObservation, { type: 'agent_event' }>['data'];
const encoder = new TextEncoder();

export function projectSessionEvent(event: SessionEvent, turnOrdinal: number): AgentEventData | null {
  const name = event.type;
  if (name !== 'agent_start' && name !== 'agent_end' && name !== 'agent_settled'
    && name !== 'turn_start' && name !== 'turn_end' && name !== 'message_start'
    && name !== 'message_update' && name !== 'message_end'
    && name !== 'tool_execution_start' && name !== 'tool_execution_update' && name !== 'tool_execution_end') return null;
  const message = 'message' in event ? event.message : undefined;
  const role = message?.role === 'user' || message?.role === 'assistant' || message?.role === 'toolResult' ? message.role : undefined;
  return { eventName: name, ...(role ? { role } : {}),
    ...(message?.role === 'assistant' && message.stopReason ? { stopReason: message.stopReason } : {}),
    ...(name.startsWith('turn_') ? { turnOrdinal } : {}),
    ...(name === 'message_update' && event.assistantMessageEvent.type === 'text_delta'
      ? { textBytes: encoder.encode(event.assistantMessageEvent.delta).byteLength } : {}) };
}
