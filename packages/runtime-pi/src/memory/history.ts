import { MemoryObservationSchema, type MemoryObservation } from "@flowmate/contracts";
import type { MemoryScope, MemorySessionLike } from "./policy.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? value as UnknownRecord : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    const item = record(content);
    return typeof item?.text === "string" ? item.text : "";
  }
  return content.map((part) => {
    const item = record(part);
    if (!item) return "";
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "toolCall" && typeof item.name === "string") return `[tool:${item.name}]`;
    if (item.type === "toolResult") return contentText(item.content);
    return "";
  }).filter(Boolean).join("\n");
}

function role(value: unknown): MemoryObservation["role"] {
  if (value === "user" || value === "assistant" || value === "tool") return value;
  return "unknown";
}

function fromEntry(entry: unknown, scope: MemoryScope, sessionId: string): MemoryObservation | null {
  const item = record(entry);
  if (!item) return null;
  if (item.type === "message") {
    const message = record(item.message);
    if (!message) return null;
    return MemoryObservationSchema.parse({
      schemaVersion: "1",
      scopeId: scope.scopeId,
      sessionId,
      entryId: typeof item.id === "string" ? item.id : null,
      role: role(message.role),
      source: "session-history",
      text: contentText(message.content),
      at: typeof item.timestamp === "string" ? item.timestamp : null,
    });
  }
  if (item.type === "custom_message") {
    return MemoryObservationSchema.parse({
      schemaVersion: "1",
      scopeId: scope.scopeId,
      sessionId,
      entryId: typeof item.id === "string" ? item.id : null,
      role: "custom",
      source: "session-history",
      text: contentText(item.content),
      at: typeof item.timestamp === "string" ? item.timestamp : null,
    });
  }
  return null;
}

export function observeSessionHistory(session: MemorySessionLike, scope: MemoryScope): MemoryObservation[] {
  const sessionId = session.sessionId ?? session.sessionManager.getSessionId();
  return session.sessionManager.getEntries().map((entry) => fromEntry(entry, scope, sessionId)).filter((item): item is MemoryObservation => item !== null);
}
