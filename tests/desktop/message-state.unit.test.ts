import { describe, expect, it } from 'bun:test';
import type { AgentRunEvent, SessionAssistantMessageView, SessionMessagesPage } from '@flowmate/contracts';
import { applyMessageUpsert, mergeSavedHistory, type MessageViewState } from '../../apps/desktop/renderer/src/message-state.ts';

function state(): MessageViewState {
  return { sessionId: 12, byEntryId: new Map(), liveByRun: new Map(), lastSequenceByMessage: new Map(),
    aliases: new Map(), highestSeenSequenceByRun: new Map(), closedRuns: new Set() };
}

function message(overrides: Partial<SessionAssistantMessageView> = {}): SessionAssistantMessageView {
  return { entryId: null, runId: 101, liveOrdinal: 1, timestamp: 1790726400000, persistence: 'pending', truncated: false,
    role: 'assistant', blocks: [{ type: 'text', text: 'A' }], phase: 'streaming', stopReason: 'pending',
    toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content', ...overrides };
}

function event(sequence: number, view = message()): Extract<AgentRunEvent, { type: 'message_upsert' }> {
  return { type: 'message_upsert', runId: 101, sessionId: 12, nativeSessionId: 'native-session-s',
    sequence, at: '2026-09-30T00:00:00.000Z', message: view };
}

function page(items: SessionMessagesPage['items']): SessionMessagesPage {
  return { session: { sessionId: 12, nativeSessionId: 'native-session-s', title: 'Invoice', status: 'active',
    createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', availability: 'ready',
    historyState: 'recoverable', activeRunId: null, modelUseBlocked: false, hasBusinessHistory: true },
    leafId: 'entry-1', entryCount: items.length, items, nextBeforeEntryId: null };
}

function saved(overrides: Partial<SessionAssistantMessageView> = {}): SessionAssistantMessageView {
  return message({ entryId: 'entry-1', persistence: 'saved', phase: 'ended', stopReason: 'stop', ...overrides });
}

describe('P4 message snapshots', () => {
  it('keeps the newer complete snapshot when the same message arrives out of order', () => {
    const first = applyMessageUpsert(state(), event(2, message({ blocks: [{ type: 'text', text: 'AB' }] })));
    const result = applyMessageUpsert(first.state, event(1));
    expect(result.state.liveByRun.get(101)?.get(1)?.blocks).toEqual([{ type: 'text', text: 'AB' }]);
    expect(result.state.lastSequenceByMessage.get('101:1')).toBe(2);
  });

  it('accepts a different message below the Run high watermark', () => {
    const first = applyMessageUpsert(state(), event(2, message({ liveOrdinal: 2 })));
    const result = applyMessageUpsert(first.state, event(1));
    expect([...result.state.liveByRun.get(101)!.keys()]).toEqual([2, 1]);
    expect(result.state.highestSeenSequenceByRun.get(101)).toBe(2);
    expect(first.queryRequired).toBe(true);
    expect(result.queryRequired).toBe(false);
  });

  it('ignores an identical duplicate without adding a second message', () => {
    const first = applyMessageUpsert(state(), event(1));
    const result = applyMessageUpsert(first.state, event(1));
    expect(result.queryRequired).toBe(false);
    expect(result.state.liveByRun.get(101)?.size).toBe(1);
  });

  it('retains trusted content and requests facts on conflicting same-version snapshots', () => {
    const first = applyMessageUpsert(state(), event(1));
    const result = applyMessageUpsert(first.state, event(1, message({ blocks: [{ type: 'text', text: 'changed' }] })));
    expect(result.queryRequired).toBe(true);
    expect(result.state.liveByRun.get(101)?.get(1)?.blocks).toEqual([{ type: 'text', text: 'A' }]);
  });

  it('keeps ended content immutable when a higher-version final snapshot conflicts', () => {
    const first = applyMessageUpsert(state(), event(1, message({ phase: 'ended', stopReason: 'stop' })));
    const result = applyMessageUpsert(first.state, event(2, message({ phase: 'ended', stopReason: 'stop', blocks: [{ type: 'text', text: 'changed' }] })));
    expect(result.queryRequired).toBe(true);
    expect(result.state.liveByRun.get(101)?.get(1)?.blocks).toEqual([{ type: 'text', text: 'A' }]);
    expect(result.state.lastSequenceByMessage.get('101:1')).toBe(1);
  });

  it.each([
    [message({ phase: 'ended', stopReason: 'stop' }), message()],
    [saved(), message({ phase: 'ended', stopReason: 'stop' })],
    [message({ phase: 'ended', stopReason: 'stop', persistence: 'failed' }), saved()],
    [message({ phase: 'ended', stopReason: 'stop', persistence: 'failed' }), message({ phase: 'ended', stopReason: 'stop' })],
  ])('refuses phase or persistence regression', (before, after) => {
    const first = applyMessageUpsert(state(), event(1, before));
    const result = applyMessageUpsert(first.state, event(2, after));
    expect(result.queryRequired).toBe(true);
    const current = result.state.byEntryId.get('entry-1') ?? result.state.liveByRun.get(101)?.get(1);
    expect(current?.phase).toBe(before.phase);
    expect(current?.persistence).toBe(before.persistence);
  });

  it('establishes a stable alias before replacing the saved temporary item', () => {
    const first = applyMessageUpsert(state(), event(1, message({ phase: 'ended', stopReason: 'stop' })));
    const result = applyMessageUpsert(first.state, event(2, saved()));
    expect(result.queryRequired).toBe(false);
    expect(result.state.byEntryId.get('entry-1')?.persistence).toBe('saved');
    expect(result.state.aliases.get('101:1')).toBe('entry-1');
    expect(result.state.liveByRun.get(101)?.size ?? 0).toBe(0);
  });

  it('requests history when an older saved frame is ignored without a trusted alias', () => {
    const first = applyMessageUpsert(state(), event(3, message()));
    const result = applyMessageUpsert(first.state, event(2, saved()));
    expect(result.queryRequired).toBe(true);
    expect(result.state.aliases.size).toBe(0);
    expect(result.state.liveByRun.get(101)?.get(1)?.persistence).toBe('pending');
  });

  it('does not let an entry be rebound to a different Run or ordinal', () => {
    const first = applyMessageUpsert(state(), event(1, saved()));
    const result = applyMessageUpsert(first.state, event(2, saved({ liveOrdinal: 2 })));
    expect(result.queryRequired).toBe(true);
    expect(result.state.aliases.get('101:1')).toBe('entry-1');
    expect(result.state.aliases.has('101:2')).toBe(false);
    expect(result.state.byEntryId.get('entry-1')?.liveOrdinal).toBe(1);
  });

  it('does not apply a late upsert after the app has independently closed the Run', () => {
    const first = applyMessageUpsert(state(), event(1));
    first.state.closedRuns.add(101);
    const result = applyMessageUpsert(first.state, event(2, saved()));
    expect(result.queryRequired).toBe(true);
    expect(result.state.byEntryId.size).toBe(0);
    expect(result.state.liveByRun.get(101)?.get(1)?.persistence).toBe('pending');
    expect(result.state.closedRuns.has(101)).toBe(true);
    expect(result.state.lastSequenceByMessage.get('101:1')).toBe(1);
  });

  it('does not change another Session or accept a message with a mismatched Run envelope', () => {
    const wrongSession = applyMessageUpsert(state(), { ...event(1), sessionId: 13 });
    expect(wrongSession.state.liveByRun.size).toBe(0);
    expect(wrongSession.queryRequired).toBe(false);
    const wrongRun = applyMessageUpsert(state(), event(1, message({ runId: 102 })));
    expect(wrongRun.state.liveByRun.size).toBe(0);
    expect(wrongRun.queryRequired).toBe(true);
  });

  it('leaves all input maps and nested Run maps unchanged', () => {
    const original = applyMessageUpsert(state(), event(1)).state;
    const result = applyMessageUpsert(original, event(2, message({ blocks: [{ type: 'text', text: 'AB' }] })));
    expect(original.liveByRun.get(101)?.get(1)?.blocks).toEqual([{ type: 'text', text: 'A' }]);
    expect(original.lastSequenceByMessage.get('101:1')).toBe(1);
    expect(result.state.liveByRun.get(101)).not.toBe(original.liveByRun.get(101));
    expect(result.state.closedRuns).not.toBe(original.closedRuns);
  });
});

describe('P4 saved history reconciliation', () => {
  it('establishes the same alias when query wins the race with the saved notification', () => {
    const first = applyMessageUpsert(state(), event(1));
    const queried = mergeSavedHistory(first.state, page([saved()]));
    const result = applyMessageUpsert(queried.state, event(2, saved()));
    expect(queried.queryRequired).toBe(false);
    expect(result.state.byEntryId.size).toBe(1);
    expect(result.state.aliases.get('101:1')).toBe('entry-1');
    expect(result.state.liveByRun.get(101)?.size ?? 0).toBe(0);
    expect(result.state.lastSequenceByMessage.get('101:1')).toBe(2);
  });

  it('reconciles a dropped saved frame after Run termination using the real query bridge', () => {
    const first = applyMessageUpsert(state(), event(1));
    first.state.closedRuns.add(101);
    const result = mergeSavedHistory(first.state, page([saved()]));
    expect(result.queryRequired).toBe(false);
    expect(result.state.byEntryId.get('entry-1')?.phase).toBe('ended');
    expect(result.state.aliases.get('101:1')).toBe('entry-1');
    expect(result.state.liveByRun.get(101)?.size ?? 0).toBe(0);
    expect(result.state.closedRuns.has(101)).toBe(true);
    expect(result.state.lastSequenceByMessage.get('101:1')).toBe(1);
  });

  it('keeps an unbridged temporary item as unconfirmed instead of guessing by text or timestamp', () => {
    const first = applyMessageUpsert(state(), event(1));
    first.state.closedRuns.add(101);
    const result = mergeSavedHistory(first.state, page([saved({ liveOrdinal: null })]));
    expect(result.queryRequired).toBe(false);
    expect(result.state.byEntryId.size).toBe(1);
    expect(result.state.liveByRun.get(101)?.get(1)?.persistence).toBe('pending');
    expect(result.state.aliases.size).toBe(0);
    expect(result.state.byEntryId.get('entry-1')?.liveOrdinal).toBeNull();
  });

  it('retains saved items outside the latest queried page and merges older pages idempotently', () => {
    const first = mergeSavedHistory(state(), page([saved({ entryId: 'entry-2', liveOrdinal: 2, timestamp: 1790726400001 })]));
    const olderPage = { ...page([saved({ liveOrdinal: null })]), nextBeforeEntryId: 'entry-1' };
    const second = mergeSavedHistory(first.state, olderPage);
    const result = mergeSavedHistory(second.state, olderPage);
    expect(result.queryRequired).toBe(false);
    expect([...result.state.byEntryId.keys()].sort()).toEqual(['entry-1', 'entry-2']);
    expect(result.state.byEntryId.get('entry-2')?.liveOrdinal).toBe(2);
    expect(result.state.highestSeenSequenceByRun.size).toBe(0);
    expect(result.state.lastSequenceByMessage.size).toBe(0);
  });

  it('enriches a saved entry received without a bridge when a true saved event later arrives', () => {
    const first = mergeSavedHistory(state(), page([saved({ liveOrdinal: null })]));
    const result = applyMessageUpsert(first.state, event(1, saved()));
    expect(result.queryRequired).toBe(false);
    expect(result.state.byEntryId.size).toBe(1);
    expect(result.state.byEntryId.get('entry-1')?.liveOrdinal).toBe(1);
    expect(result.state.aliases.get('101:1')).toBe('entry-1');
    expect(result.state.liveByRun.get(101)?.size ?? 0).toBe(0);
  });

  it('does not regress authoritative saved history when a pending event arrives after query', () => {
    const first = mergeSavedHistory(state(), page([saved()]));
    const result = applyMessageUpsert(first.state, event(1));
    expect(result.queryRequired).toBe(true);
    expect(result.state.byEntryId.get('entry-1')?.persistence).toBe('saved');
    expect(result.state.liveByRun.get(101)?.size ?? 0).toBe(0);
  });

  it('retains already trusted content when query conflicts with a final message', () => {
    const first = applyMessageUpsert(state(), event(1, message({ phase: 'ended', stopReason: 'stop' })));
    const result = mergeSavedHistory(first.state, page([saved({ blocks: [{ type: 'text', text: 'changed' }] })]));
    expect(result.queryRequired).toBe(true);
    expect(result.state.byEntryId.size).toBe(0);
    expect(result.state.liveByRun.get(101)?.get(1)?.blocks).toEqual([{ type: 'text', text: 'A' }]);
  });

  it('does not turn a failed save into a saved item through query reconciliation', () => {
    const first = applyMessageUpsert(state(), event(1, message({ phase: 'ended', stopReason: 'stop', persistence: 'failed' })));
    const result = mergeSavedHistory(first.state, page([saved()]));
    expect(result.queryRequired).toBe(true);
    expect(result.state.byEntryId.size).toBe(0);
    expect(result.state.liveByRun.get(101)?.get(1)?.persistence).toBe('failed');
  });

  it('rejects a page which binds two different entries to the same temporary identity', () => {
    const result = mergeSavedHistory(state(), page([saved(), saved({ entryId: 'entry-2' })]));
    expect(result.queryRequired).toBe(true);
    expect(result.state.byEntryId.size).toBe(0);
    expect(result.state.aliases.size).toBe(0);
  });

  it('does not rebind an existing saved entry to a different Run', () => {
    const first = mergeSavedHistory(state(), page([saved()]));
    const result = mergeSavedHistory(first.state, page([saved({ runId: 102 })]));
    expect(result.queryRequired).toBe(true);
    expect(result.state.byEntryId.get('entry-1')?.runId).toBe(101);
    expect(result.state.aliases.has('102:1')).toBe(false);
  });

  it('ignores a late query response for another Session', () => {
    const wrongPage = page([saved()]);
    wrongPage.session.sessionId = 13;
    const result = mergeSavedHistory(state(), wrongPage);
    expect(result.queryRequired).toBe(false);
    expect(result.state.byEntryId.size).toBe(0);
  });

  it('does not mutate the original pending maps during saved reconciliation', () => {
    const original = applyMessageUpsert(state(), event(1)).state;
    const result = mergeSavedHistory(original, page([saved()]));
    expect(original.byEntryId.size).toBe(0);
    expect(original.aliases.size).toBe(0);
    expect(original.liveByRun.get(101)?.size).toBe(1);
    expect(result.state.byEntryId.size).toBe(1);
    expect(result.state.aliases).not.toBe(original.aliases);
  });
});
