import { RuntimeEventSchema, type RuntimeEvent } from "@flowmate/contracts";
import type { Store } from "../jobs/repository.js";

/** Persist the canonical Runtime event before forwarding it to a UI observer. */
export function persistRuntimeEvent(store: Store, event: RuntimeEvent): RuntimeEvent {
  const parsed = RuntimeEventSchema.parse(event);
  return store.recordRuntimeEvent(parsed);
}

export function orderedRuntimeEvents(store: Store, runId: string): RuntimeEvent[] {
  return store.getRuntimeEvents(runId).sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));
}
