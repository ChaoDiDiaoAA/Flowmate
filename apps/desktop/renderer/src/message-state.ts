// The contracts barrel also exports Node-only request helpers. Import the same
// browser-safe DTO schemas directly rather than bundling those helpers into UI.
import { MessageUpsertEventSchema, SessionMessagesPageSchema } from '../../../../packages/contracts/src/runtime.ts';
import type { AgentRunEvent, DbId, SessionMessagesPage, SessionMessageView } from '@flowmate/contracts';

export type MessageViewState = {
  sessionId: DbId;
  byEntryId: Map<string, SessionMessageView>;
  liveByRun: Map<DbId, Map<number, SessionMessageView>>;
  lastSequenceByMessage: Map<string, number>;
  aliases: Map<string, string>;
  highestSeenSequenceByRun: Map<DbId, number>;
  closedRuns: Set<DbId>;
};

export type MessageMergeResult = { state: MessageViewState; queryRequired: boolean };

export function applyMessageUpsert(state: MessageViewState,
  event: Extract<AgentRunEvent, { type: 'message_upsert' }>): MessageMergeResult {
  const next = copyState(state);
  const parsed = MessageUpsertEventSchema.safeParse(event);
  if (!parsed.success) return { state: next, queryRequired: true };
  const update = parsed.data;
  if (update.sessionId !== state.sessionId) return { state: next, queryRequired: false };
  const view = update.message;
  // The event schema validates these against the trusted envelope. The app also
  // checks the actual Run/native Session binding before entering this reducer.
  const runId = update.runId;
  const ordinal = view.liveOrdinal!;
  const key = liveKey(runId, ordinal);
  const alias = next.aliases.get(key);
  const current = alias ? next.byEntryId.get(alias) : next.liveByRun.get(runId)?.get(ordinal);
  const highest = next.highestSeenSequenceByRun.get(runId) ?? 0;
  const gap = update.sequence > highest + 1;

  if (next.closedRuns.has(runId)) {
    const unresolved = !current || current.persistence !== 'saved' || current.entryId === null;
    const conflictingSaved = view.persistence === 'saved' && current !== undefined && !sameContent(current, view);
    return { state: next, queryRequired: gap || unresolved || conflictingSaved };
  }
  if (alias && (view.entryId !== null && view.entryId !== alias || !current)) {
    return { state: next, queryRequired: true };
  }
  const last = next.lastSequenceByMessage.get(key);
  if (last !== undefined && update.sequence < last) {
    return { state: next, queryRequired: view.persistence === 'saved' && alias === undefined };
  }
  if (last === update.sequence) {
    return { state: next, queryRequired: current === undefined || !sameMessage(current, view) };
  }
  if (current && !canAdvance(current, view)) return { state: next, queryRequired: true };

  if (view.persistence === 'saved') {
    if (!writeSaved(next, view)) return { state: next, queryRequired: true };
  } else {
    const messages = next.liveByRun.get(runId) ?? new Map();
    messages.set(ordinal, view);
    next.liveByRun.set(runId, messages);
  }
  next.lastSequenceByMessage.set(key, update.sequence);
  next.highestSeenSequenceByRun.set(runId, Math.max(highest, update.sequence));
  return { state: next, queryRequired: gap };
}

export function mergeSavedHistory(state: MessageViewState, page: SessionMessagesPage): MessageMergeResult {
  const next = copyState(state);
  const parsed = SessionMessagesPageSchema.safeParse(page);
  if (!parsed.success) return { state: next, queryRequired: true };
  if (parsed.data.session.sessionId !== state.sessionId) return { state: next, queryRequired: false };

  // Reject contradictory identities inside a response before trusting any item.
  const entries = new Map<string, SessionMessageView>();
  const identities = new Map<string, string>();
  for (const view of parsed.data.items) {
    const entryId = view.entryId!;
    const prior = entries.get(entryId);
    if (prior && !sameMessage(prior, view)) return { state: next, queryRequired: true };
    entries.set(entryId, view);
    if (view.runId !== null && view.liveOrdinal !== null) {
      const key = liveKey(view.runId, view.liveOrdinal);
      const priorEntry = identities.get(key);
      if (priorEntry !== undefined && priorEntry !== entryId) return { state: next, queryRequired: true };
      identities.set(key, entryId);
    }
  }
  let queryRequired = false;
  for (const view of entries.values()) {
    if (!writeSaved(next, view)) queryRequired = true;
  }
  // A page is a saved-history observation, not an event revision. Keep items
  // outside this page and leave sequence watermarks and Run closure unchanged.
  return { state: next, queryRequired };
}

function copyState(state: MessageViewState): MessageViewState {
  return { ...state, byEntryId: new Map(state.byEntryId), liveByRun: new Map([...state.liveByRun].map(([runId, messages]) => [runId, new Map(messages)])),
    lastSequenceByMessage: new Map(state.lastSequenceByMessage), aliases: new Map(state.aliases),
    highestSeenSequenceByRun: new Map(state.highestSeenSequenceByRun), closedRuns: new Set(state.closedRuns) };
}

function liveKey(runId: DbId, ordinal: number): string { return `${runId}:${ordinal}`; }

function sameContent(a: SessionMessageView, b: SessionMessageView): boolean {
  const content = (view: SessionMessageView) => [view.role, view.timestamp, view.blocks, view.phase,
    view.stopReason, view.toolCallId, view.toolName, view.isError, view.textOrigin, view.truncated];
  return JSON.stringify(content(a)) === JSON.stringify(content(b));
}

function sameMessage(a: SessionMessageView, b: SessionMessageView): boolean {
  return a.entryId === b.entryId && a.runId === b.runId && a.liveOrdinal === b.liveOrdinal
    && a.persistence === b.persistence && sameContent(a, b);
}

function canAdvance(current: SessionMessageView, incoming: SessionMessageView): boolean {
  if (current.runId !== incoming.runId || current.role !== incoming.role || current.timestamp !== incoming.timestamp
    || current.entryId !== null && incoming.entryId !== null && current.entryId !== incoming.entryId
    || current.liveOrdinal !== null && incoming.liveOrdinal !== null && current.liveOrdinal !== incoming.liveOrdinal) return false;
  if (current.phase === 'ended' && incoming.phase !== 'ended') return false;
  if (current.persistence !== 'pending' && current.persistence !== incoming.persistence) return false;
  return current.phase !== 'ended' || sameContent(current, incoming);
}

function writeSaved(state: MessageViewState, view: SessionMessageView): boolean {
  if (view.entryId === null || view.persistence !== 'saved' || view.phase !== 'ended') return false;
  const existing = state.byEntryId.get(view.entryId);
  if (existing && !canAdvance(existing, view)) return false;

  const key = view.runId !== null && view.liveOrdinal !== null ? liveKey(view.runId, view.liveOrdinal) : null;
  if (key !== null) {
    const alias = state.aliases.get(key);
    if (alias !== undefined && alias !== view.entryId) return false;
    for (const [otherKey, entryId] of state.aliases) {
      if (entryId === view.entryId && otherKey !== key) return false;
    }
    const pending = state.liveByRun.get(view.runId!)?.get(view.liveOrdinal!);
    if (pending && !canAdvance(pending, view)) return false;
  }

  state.byEntryId.set(view.entryId, view);
  if (key !== null) {
    state.aliases.set(key, view.entryId);
    const messages = state.liveByRun.get(view.runId!);
    messages?.delete(view.liveOrdinal!);
    if (messages?.size === 0) state.liveByRun.delete(view.runId!);
  }
  return true;
}
