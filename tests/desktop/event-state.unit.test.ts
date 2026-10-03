import { describe, expect, it } from 'bun:test';
import type { RuntimeEvent, RuntimeEventsReadResult, RuntimeSubscriptionInfo } from '@flowmate/contracts';
import { createEventView, bindEventSubscription, applyEventWake, applyEventRead, selectEventSegment,
  retryEventPrefix, eventReadRequest, enqueueEventRead } from '../../apps/desktop/renderer/src/event-state.ts';

const context = { runId: 11, sessionId: null, highWatermark: 3,
  availableRange: { fromSequence: 1, toSequence: 3 }, coverage: 'from-created' as const };
const info: RuntimeSubscriptionInfo = { ...context, subscriptionId: 'subscription-1' };
function event(sequence: number): RuntimeEvent {
  return { eventId: sequence, runId: 11, sessionId: null, toolCallId: null, sequence,
    sourceConnection: null, sourceSequence: null, occurredAt: '2026-10-03T00:00:00.000Z', receivedAt: '2026-10-03T00:00:00.000Z',
    type: sequence === 1 ? 'run_created' : 'run_started', payload: { version: 1,
      status: sequence === 1 ? 'created' : 'running', origin: 'live', stopped: null, errorCode: null } };
}
function page(items: RuntimeEvent[], c: number, d: number | null = null, hasMore = false): RuntimeEventsReadResult {
  return { ok: true, data: { ...context, items, nextCursor: { runId: 11, lastPersistedSequence: c },
    nextAvailableAfterSequence: d, hasMore } };
}
function initial() { return bindEventSubscription(createEventView(11, null, 1), info, 1); }

describe('P6 pure event observation', () => {
  it('keeps eight waiting subscriptions unique and gives each one a FIFO turn despite a hot first request', () => {
    let queue: string[] = [];
    const ids = Array.from({ length: 8 }, (_, index) => `subscription-${index}`);
    for (const id of ids) queue = enqueueEventRead(enqueueEventRead(queue, id), id);
    const served: string[] = [];
    for (let turn = 0; turn < 16; turn++) {
      const id = queue.shift()!; served.push(id);
      queue = enqueueEventRead(queue, ids[0]!);
      queue = enqueueEventRead(queue, id);
      expect(new Set(queue).size).toBe(queue.length);
    }
    expect(served.slice(0, 8)).toEqual(ids);
    expect(served.slice(8)).toEqual(ids);
  });
  it('uses matching wake only as a hint and never changes the persisted cursor', () => {
    let s = initial();
    s = applyEventWake(s, { type: 'runtime_events_available', subscriptionId: info.subscriptionId, runId: 11, sequence: 2 }, 1);
    s = applyEventWake(s, { type: 'runtime_events_available', subscriptionId: info.subscriptionId, runId: 11, sequence: 1 }, 1);
    expect(s.cursor.lastPersistedSequence).toBe(0);
    expect(s.wakeSequence).toBe(2);
    expect(s.needsRefresh).toBe(true);
    expect(applyEventWake(s, { type: 'runtime_events_available', subscriptionId: 'old', runId: 11, sequence: 40 }, 1)).toBe(s);
    expect(applyEventWake(s, { type: 'runtime_events_available', subscriptionId: info.subscriptionId, runId: 11, sequence: 40 }, 0)).toBe(s);
    expect(Object.keys(s)).not.toContain('busy');
  });

  it('only confirms a fully validated matching page and ignores stale generation/Run/Session responses', () => {
    const s = initial();
    const request = eventReadRequest(s);
    const p = page([event(1), event(2)], 2, null, true);
    for (const generation of [0, 2]) expect(applyEventRead(s, p, request, generation)).toBe(s);
    expect(applyEventRead(s, p, { ...request, runId: 12 }, 1)).toBe(s);
    expect(applyEventRead(s, p, { ...request, sessionId: 12 }, 1)).toBe(s);
    const broken = applyEventRead(s, page([event(1), event(3)], 3), request, 1);
    expect(broken.cursor.lastPersistedSequence).toBe(0);
    expect(broken.events.size).toBe(0);
    const applied = applyEventRead(s, p, request, 1);
    expect(applied.cursor.lastPersistedSequence).toBe(2);
    expect([...applied.events.keys()]).toEqual([1, 2]);
    expect(applyEventRead(applied, p, request, 1)).toBe(applied);
  });

  it('preserves C at a gap, explicitly advances D, and verifies a repaired prefix again', () => {
    let s = initial();
    s = applyEventRead(s, page([event(1)], 1, null, true), eventReadRequest(s), 1);
    const gap: RuntimeEventsReadResult = { ok: false, error: { code: 'event_gap', category: 'storage',
      message: 'Missing.', retryable: false, runId: 11 }, context: { ...context,
        gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } };
    s = applyEventRead(s, gap, eventReadRequest(s), 1);
    expect(s.cursor.lastPersistedSequence).toBe(1);
    expect(s.gap?.fromSequence).toBe(2);
    expect(selectEventSegment(s, 1)).toBe(s);
    s = selectEventSegment(s, 2);
    expect(eventReadRequest(s)).toMatchObject({ availableAfterSequence: 2, cursor: { lastPersistedSequence: 1 } });
    s = applyEventRead(s, page([event(3)], 1, 3), eventReadRequest(s), 1);
    expect(s.cursor.lastPersistedSequence).toBe(1);
    expect(s.displayAfterSequence).toBe(3);
    s = applyEventRead(s, page([], 1, 3), eventReadRequest(s), 1);
    expect(s.displayAfterSequence).toBe(3);
    s = retryEventPrefix(s);
    s = applyEventRead(s, page([event(2), event(3)], 3), eventReadRequest(s), 1);
    expect(s.cursor.lastPersistedSequence).toBe(3);
    expect([...s.events.keys()].sort()).toEqual([1, 2, 3]);
    expect(s.gap).toBeNull();
  });

  it('rejects a failure gap that skips the original prefix or segment position', () => {
    const gap: RuntimeEventsReadResult = { ok: false, error: { code: 'event_gap', category: 'storage',
      message: 'Missing.', retryable: false }, context: { ...context,
        gap: { fromSequence: 1, toSequence: 1, continueAfterSequence: 1 } } };
    let segment = applyEventRead(initial(), gap, eventReadRequest(initial()), 1);
    segment = selectEventSegment(segment, 1);
    segment = applyEventRead(segment, page([event(2)], 0, 2, true), eventReadRequest(segment), 1);
    for (const state of [initial(), segment]) {
      const wrongGap: RuntimeEventsReadResult = { ...gap, context: { ...context,
        gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } };
      const rejected = applyEventRead(state, wrongGap, eventReadRequest(state), 1);
      expect(rejected.error?.code).toBe('storage_corrupt');
      expect(rejected.cursor).toBe(state.cursor);
      expect(rejected.displayAfterSequence).toBe(state.displayAfterSequence);
      expect(rejected.events).toBe(state.events);
      expect(rejected.context).toBe(state.context);
      expect(rejected.gap).toBe(state.gap);
      expect(selectEventSegment(rejected, 2)).toBe(rejected);
    }
  });

  it('checks failure context bounds while preserving cursor errors and a through position inside a gap', () => {
    const readFailure: RuntimeEventsReadResult = { ok: false, error: { code: 'storage_read_failed', category: 'storage',
      message: 'Temporary.', retryable: true }, context };
    const gap: RuntimeEventsReadResult = { ok: false, error: { code: 'event_gap', category: 'storage',
      message: 'Missing.', retryable: false }, context: { ...context,
        gap: { fromSequence: 1, toSequence: 1, continueAfterSequence: 1 } } };
    const full = applyEventRead(initial(), page([event(1), event(2), event(3)], 3), eventReadRequest(initial()), 1);
    const segment = selectEventSegment(applyEventRead(initial(), gap, eventReadRequest(initial()), 1), 1);
    const lowerContext = { ...context, highWatermark: 2, availableRange: { fromSequence: 1, toSequence: 2 } };
    const invalid = [
      { state: initial(), request: eventReadRequest(initial(), 4), response: readFailure },
      { state: full, request: eventReadRequest(full), response: { ...readFailure, context: lowerContext } },
      { state: segment, request: eventReadRequest(segment, 0), response: readFailure },
      { state: initial(), request: eventReadRequest(initial(), 0), response: gap },
    ];
    for (const { state, request, response } of invalid) {
      const rejected = applyEventRead(state, response, request, 1);
      expect(rejected.error?.code).toBe('storage_corrupt');
      expect(rejected.cursor).toBe(state.cursor);
      expect(rejected.displayAfterSequence).toBe(state.displayAfterSequence);
      expect(rejected.context).toBe(state.context);
      expect(rejected.gap).toBe(state.gap);
    }
    const cursorError: RuntimeEventsReadResult = { ok: false, error: { code: 'event_cursor_invalid', category: 'input',
      message: 'Position is outside the available range.', retryable: false }, context: lowerContext };
    const changedRange = applyEventRead(full, cursorError, eventReadRequest(full), 1);
    expect(changedRange.error?.code).toBe('event_cursor_invalid');
    expect(changedRange.cursor.lastPersistedSequence).toBe(3);
    expect(changedRange.context?.highWatermark).toBe(2);
    const boundedGap: RuntimeEventsReadResult = { ...gap, context: { ...context, highWatermark: 5,
      availableRange: { fromSequence: 4, toSequence: 5 }, coverage: 'partial',
      gap: { fromSequence: 1, toSequence: 3, continueAfterSequence: 3 } } };
    const insideGap = applyEventRead(initial(), boundedGap, eventReadRequest(initial(), 2), 1);
    expect(insideGap.error?.code).toBe('event_gap');
    expect(insideGap.gap?.continueAfterSequence).toBe(3);
    expect(insideGap.cursor.lastPersistedSequence).toBe(0);
    const verifiedFailure = applyEventRead(initial(), readFailure, eventReadRequest(initial(), 2), 1);
    expect(verifiedFailure.error?.code).toBe('storage_read_failed');
    expect(verifiedFailure.cursor.lastPersistedSequence).toBe(0);
  });

  it('rejects fabricated cursor advancement, wrong identities, and conflicting persisted facts atomically', () => {
    const s = initial();
    const request = eventReadRequest(s);
    const wrongEmpty = applyEventRead(s, page([], 2), request, 1);
    expect(wrongEmpty.cursor.lastPersistedSequence).toBe(0);
    const wrongStart = applyEventRead(s, page([event(2)], 2), request, 1);
    expect(wrongStart.cursor.lastPersistedSequence).toBe(0);
    const wrongIdentity = applyEventRead(s, page([{ ...event(1), sessionId: 12 }], 1), request, 1);
    expect(wrongIdentity.events.size).toBe(0);
    let advanced = applyEventRead(s, page([event(1)], 1, null, true), request, 1);
    advanced = applyEventRead(advanced, { ok: false, error: { code: 'storage_read_failed', category: 'storage',
      message: 'Temporary.', retryable: true }, context: null }, eventReadRequest(advanced), 1);
    expect(advanced.cursor.lastPersistedSequence).toBe(1);
    expect(advanced.events.size).toBe(1);
    // A segment cannot overwrite the already persisted identity with another fact.
    const forged = { ...event(2), eventId: 1 };
    const rejected = applyEventRead(advanced, page([forged], 2), eventReadRequest(advanced), 1);
    expect(rejected.cursor.lastPersistedSequence).toBe(1);
    expect(rejected.events.size).toBe(1);
    expect(rejected.error?.code).toBe('storage_corrupt');
  });
});
