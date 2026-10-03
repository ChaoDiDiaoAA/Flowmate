import { describe, expect, it } from 'bun:test';
import type { RuntimeEvent, RuntimeEventsReadResult } from '@flowmate/contracts';
import { createEventView, applyEventRead, eventReadRequest } from '../../apps/desktop/renderer/src/event-state.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { Children, isValidElement, type ReactNode } from 'react';
import { ContextRequestEvidenceSchema, ContextRequestsPageSchema, ContextSnapshotDetailSchema } from '@flowmate/contracts';
import * as contextUi from '../../apps/desktop/renderer/src/session-details.tsx';

const api = await import('../../apps/desktop/renderer/src/context-state.ts').catch(() => null);
const identity = { hostEpoch: 1, sessionId: 5, runId: 11, selectionToken: 1 };
function required() { expect(api).not.toBeNull(); if (!api) throw new Error('Context read state is not implemented.'); return api; }

describe('P8 independent Context reads', () => {
  it('ignores old object success error and finally without clearing new loading', () => {
    const c = required();
    const a = c.beginContextRead(c.createContextRead<string>(identity), 1, 'snapshot:10');
    const lease = c.contextReadLease(a);
    const b = c.beginContextRead(c.createContextRead<string>({ ...identity, runId: 12, selectionToken: 2 }), 2, 'snapshot:20');
    expect(c.acceptContextRead(b, lease, 'A')).toBe(b);
    expect(c.failContextRead(b, lease, 'A failed')).toBe(b);
    expect(c.finishContextRead(b, lease)).toBe(b);
    expect(b).toMatchObject({ data: null, pending: true, error: null });
  });
  it('keeps confirmed content after a same-object failure and never invents first-read empty success', () => {
    const c = required();
    let read = c.beginContextRead(c.createContextRead<string[]>(identity), 1, 'requests:first');
    read = c.acceptContextRead(read, c.contextReadLease(read), ['original']);
    read = c.beginContextRead(read, 2, 'requests:first');
    read = c.failContextRead(read, c.contextReadLease(read), 'Could not read.');
    expect(read).toMatchObject({ data: ['original'], pending: false, error: 'Could not read.' });
    let first = c.beginContextRead(c.createContextRead<string[]>(identity), 1, 'requests:first');
    first = c.failContextRead(first, c.contextReadLease(first), 'Could not read.');
    expect(first).toMatchObject({ data: null, pending: false, error: 'Could not read.' });
  });
  it('rejects an old Host and every different captured identity or read key', () => {
    const c = required(); const read = c.beginContextRead(c.createContextRead<string>(identity), 4, 'detail:10');
    const lease = c.contextReadLease(read);
    for (const patch of [{ hostEpoch: 2 }, { sessionId: 6 }, { runId: 12 }, { selectionToken: 2 }]) {
      const wrong = { ...lease, identity: { ...lease.identity, ...patch } };
      expect(c.acceptContextRead(read, wrong, 'foreign')).toBe(read);
      expect(c.failContextRead(read, wrong, 'foreign')).toBe(read);
      expect(c.finishContextRead(read, wrong)).toBe(read);
    }
    for (const wrong of [{ ...lease, token: 3 }, { ...lease, key: 'detail:20' }]) {
      expect(c.acceptContextRead(read, wrong, 'foreign')).toBe(read);
      expect(c.finishContextRead(read, wrong)).toBe(read);
    }
  });
  it('retains a later read while an earlier request of the same object settles', () => {
    const c = required(); const first = c.beginContextRead(c.createContextRead<string>(identity), 1, 'page:before10:limit20');
    const earlier = c.contextReadLease(first), later = c.beginContextRead(first, 2, 'page:before5:limit20');
    expect(c.acceptContextRead(later, earlier, 'old page')).toBe(later);
    expect(c.finishContextRead(later, earlier)).toBe(later);
    expect(c.acceptContextRead(later, c.contextReadLease(later), 'new page')).toMatchObject({ data: 'new page', pending: false });
  });
  it('wakes only for newly applied matching P6 facts, never a wake gap repeated or foreign page', () => {
    const c = required(); const before = createEventView(11, 5, 1);
    const event: RuntimeEvent = { eventId: 1, runId: 11, sessionId: 5, toolCallId: null, sequence: 1,
      sourceConnection: null, sourceSequence: null, occurredAt: '2026-10-03T00:00:00.000Z', receivedAt: '2026-10-03T00:00:00.000Z',
      type: 'run_started', payload: { version: 1, status: 'running', origin: 'live', stopped: null, errorCode: null } };
    const page: RuntimeEventsReadResult = { ok: true, data: { runId: 11, sessionId: 5, highWatermark: 1,
      availableRange: { fromSequence: 1, toSequence: 1 }, coverage: 'from-created', items: [event],
      nextCursor: { runId: 11, lastPersistedSequence: 1 }, nextAvailableAfterSequence: null, hasMore: false } };
    const after = applyEventRead(before, page, eventReadRequest(before), 1);
    expect(c.hasNewContextEvents(before, after, identity)).toBe(true);
    expect(c.hasNewContextEvents(after, after, identity)).toBe(false);
    expect(c.hasNewContextEvents(before, { ...before, wakeSequence: 1 }, identity)).toBe(false);
    expect(c.hasNewContextEvents(before, after, { ...identity, runId: 12 })).toBe(false);
    expect(c.hasNewContextEvents(before, after, { ...identity, sessionId: 6 })).toBe(false);
    const broken = applyEventRead(before, { ...page, data: { ...page.data, nextCursor: { runId: 11, lastPersistedSequence: 2 } } }, eventReadRequest(before), 1);
    expect(c.hasNewContextEvents(before, broken, identity)).toBe(false);
  });
});

// These are validated public DTO rendering cases, not SDK/transport observations or Application success substitutes.
function renderPublicFacts(name: string, props: object) {
  const component: unknown = Reflect.get(contextUi, name);
  expect(component).toBeFunction();
  if (typeof component !== 'function') throw new Error(`${name} is missing.`);
  return renderToStaticMarkup(component(props));
}
const at = '2026-10-03T00:00:00.000Z';
const publicRequest = { binding: { runId: 31, sessionId: 5, nativeSessionId: 'native-5', requestSequence: 1, callSequence: 1,
  inputId: 100, snapshotId: 51, includedBindings: [{ originRunId: 31, inputId: 100, nativeEntryId: 'e100', snapshotId: 51 }],
  includedToolResults: [] }, api: 'openai-completions', boundAt: at, sdkPayload: null, transport: 'observed-fetch', attempts: [] };
describe('P8 public facts rendering only', () => {
  it('retains original Run and full request reference for primary and tool sources while user entry has no invented request', () => {
    const request = ContextRequestEvidenceSchema.parse({ ...publicRequest, binding: { ...publicRequest.binding,
      includedToolResults: [{ nativeToolCallId: 'original-call', toolCallId: 71, originRunId: 30, context: { snapshotId: 41, requestSequence: 2 } }] } });
    const basis: unknown[] = [], snapshots: unknown[] = [], buttons: Array<() => void> = [];
    const component: unknown = Reflect.get(contextUi, 'ContextRequestFacts');
    if (typeof component !== 'function') throw new Error('ContextRequestFacts is missing.');
    const tree = component({ request, onSnapshot(runId: number, snapshotId: number) { snapshots.push([runId, snapshotId]); },
      onRequestBasis(runId: number, context: { snapshotId: number; requestSequence: number }) { basis.push([runId, context]); } });
    function visit(node: ReactNode) { Children.forEach(node, child => {
      if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
      if (child.type === 'button' && child.props.onClick) buttons.push(child.props.onClick);
      visit(child.props.children);
    }); }
    visit(tree); expect(buttons).toHaveLength(3); for (const click of buttons) click();
    expect(basis).toEqual([[31, { snapshotId: 51, requestSequence: 1 }], [30, { snapshotId: 41, requestSequence: 2 }]]);
    expect(snapshots).toEqual([[31, 51]]);
  });
  it('keeps payload NULL and prepared-only distinct from observed transport response and request ID', () => {
    const request = ContextRequestEvidenceSchema.parse({ ...publicRequest, attempts: [{ attempt: 1, preparedAt: at, enteredAt: null,
      responseAt: null, responseStatus: null, transportErrorCode: null, nativeRequestId: null, wireInclusion: 'confirmed', wireReason: null }] });
    const html = renderPublicFacts('ContextRequestFacts', { request, onSnapshot() {}, onRequestBasis() {} });
    expect(html).toContain('Request context observed'); expect(html).toContain('Attempt 1 prepared');
    expect(html).toContain('<dt>Payload</dt><dd>Not observed</dd>');
    expect(html).toContain('<dt>Transport call</dt><dd>Not observed</dd>');
    expect(html).toContain('<dt>Response</dt><dd>Not observed</dd>');
    expect(html).toContain('<dt>Native request ID</dt><dd>Not observed</dd>');
    expect(html).not.toContain('Payload observed'); expect(html).not.toContain('Transport call observed'); expect(html).not.toContain('Response observed');
  });
  it('shows explicit unavailable and legacy collection gaps without inventing an unobserved attempt', () => {
    const request = ContextRequestEvidenceSchema.parse({ ...publicRequest, transport: 'not-observable',
      sdkPayload: { observedAt: null, inclusion: 'unavailable', reason: 'payload_codec_unavailable' } });
    const html = renderPublicFacts('ContextRequestFacts', { request, onSnapshot() {}, onRequestBasis() {} });
    expect(html).toContain('Evidence unavailable'); expect(html).toContain('payload_codec_unavailable'); expect(html).not.toContain('Attempt 1');
    for (const collection of ['not-collected', 'collected']) {
      const page = ContextRequestsPageSchema.parse({ sessionId: 5, runId: 31, collection, items: [], nextBeforeRequestSequence: null });
      const content = renderPublicFacts('ContextCollectionNotice', { page });
      expect(content).toContain(collection === 'not-collected' ? 'Legacy request evidence was not collected' : 'No request bindings recorded');
      expect(content).not.toContain(collection === 'not-collected' ? 'No request bindings recorded' : 'Legacy request evidence');
    }
  });
  it('renders Fill as its saved reference and keeps omissions conflicts and safe Input error facts visible', () => {
    const detail = ContextSnapshotDetailSchema.parse({ snapshot: { id: 51, sessionId: 5, runId: 31, jobId: 12, sequence: 1, createdAt: at,
      json: { version: 1, policyVersion: 'p8-context-v1', text: 'Fill the original form.', goalMode: 'fill-form', resourcePolicy: 'none', hasWorkingDirectory: true,
        workspaceContext: { formatVersion: 1, revision: 4, sessionId: 5, documentRef: { id: 7, version: 'vA' }, jobId: 12,
          candidateRef: { id: 42, sequence: 3 }, activeView: 'candidate', selection: null },
        budgets: { projectionBytes: 65536, fragmentBytes: 4096, fragments: 32, issueCount: 20, snapshotBytes: 262144 },
        modelProjection: { taskGoal: 'Original goal', candidate: { id: 42, sequence: 3, origin: 'human_edit', statusAtSelection: 'generated', values: [] },
          fragments: [], issues: [{ code: 'conflict', severity: 'warning', origin: 'rule', fieldPaths: ['fields.taxAmount'], message: 'Tax conflicts with total.', rule: null }],
          gaps: [{ code: 'issues_omitted', fieldPaths: [], source: null, omittedCount: 2 }] } } },
      input: { inputId: 100, sessionId: 5, runId: 31, clientSequence: 1, mode: 'prompt', goalMode: 'fill-form', status: 'failed', processingStatus: 'failed',
        nativeEntryId: null, resultEntryId: null, dispatchedAt: at, createdAt: at, updatedAt: at, error: { code: 'internal_error', category: 'internal', retryable: false } } });
    const html = renderPublicFacts('ContextSnapshotFacts', { detail, pendingCandidate: false, canQueryCandidate: true, onInspectCandidate() {} });
    for (const text of ['Saved', 'Not consumed', 'Fill reference', 'Saved candidate 42', 'sequence 3', 'Tax conflicts with total.', 'Omissions', 'issues_omitted',
      'internal_error', 'Not retryable', '7 / vA']) expect(html).toContain(text);
    expect(html).not.toContain('Input consumed'); expect(html).not.toContain('Transport call observed'); expect(html).not.toContain('model has adopted');
  });
});
