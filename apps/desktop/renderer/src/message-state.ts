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
  const ordinal = event.message.liveOrdinal!;
  const key = `${event.runId}:${ordinal}`;
  const last = next.lastSequenceByMessage.get(key);
  if (last !== undefined && event.sequence <= last) return { state: next, queryRequired: false };
  const messages = next.liveByRun.get(event.runId) ?? new Map();
  messages.set(ordinal, event.message);
  next.liveByRun.set(event.runId, messages);
  next.lastSequenceByMessage.set(key, event.sequence);
  return { state: next, queryRequired: false };
}

export function mergeSavedHistory(state: MessageViewState, _page: SessionMessagesPage): MessageMergeResult {
  return { state, queryRequired: false };
}

function copyState(state: MessageViewState): MessageViewState {
  return { ...state, byEntryId: new Map(state.byEntryId), liveByRun: new Map([...state.liveByRun].map(([runId, messages]) => [runId, new Map(messages)])),
    lastSequenceByMessage: new Map(state.lastSequenceByMessage), aliases: new Map(state.aliases),
    highestSeenSequenceByRun: new Map(state.highestSeenSequenceByRun), closedRuns: new Set(state.closedRuns) };
}
