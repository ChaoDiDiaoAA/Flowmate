import { randomUUID } from "node:crypto";
import type { RunIdentity, RuntimeEvent } from "@flowmate/contracts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Stable Flowmate event names for the Pi session event stream. */
export function runtimeEventType(event: AgentSessionEvent): string {
  switch (event.type) {
    case "tool_execution_start": return "tool.started";
    case "tool_execution_end": return "tool.finished";
    case "agent_start": return "agent.started";
    case "agent_end": return "agent.finished";
    case "turn_start": return "turn.started";
    case "turn_end": return "turn.finished";
    case "message_start": return "message.started";
    case "message_end": return "message.finished";
    case "message_update": return "message.delta";
    default: return `pi.${event.type}`;
  }
}

/** Build a domain event without leaking the SDK event object across packages. */
export function toRuntimeEvent(identity: RunIdentity, sessionId: string, seq: number, event: AgentSessionEvent): RuntimeEvent {
  return {
    schemaVersion: "1",
    ...identity,
    eventId: randomUUID(),
    seq,
    at: new Date().toISOString(),
    sessionId,
    delegationId: null,
    type: runtimeEventType(event),
    payloadRef: null,
  };
}
