import { expect, test } from 'bun:test';
import { DesktopActionDecisionRequestSchema, DesktopActionExecuteSchema, DesktopActionProposalSchema,
  DesktopActionViewSchema, DesktopActionListResultSchema } from '../../packages/contracts/src/index.ts';
import * as contracts from '../../packages/contracts/src/index.ts';

const observationId = '84c2bb96-6c56-48e0-aab0-f49f059cb1ba';

test('desktop bridge results must match the original operation', () => {
  const parse = Reflect.get(contracts, 'parseDesktopBridgeResult');
  expect(typeof parse).toBe('function');
  if (typeof parse !== 'function') return;
  const request = { kind: 'observe' as const, workId: 7, itemId: 71 };
  const window = { id: 42, app: 'Invoice', title: 'Draft' };
  expect(parse(request, { ok: true, data: { kind: 'observe', observationId, window, tree: '[3] Submit', truncated: false } })).toMatchObject({ ok: true });
  expect(parse(request, { ok: true, data: { kind: 'list', windows: [window] } })).toBeNull();
  expect(parse(request, { ok: true, data: { kind: 'observe', observationId, window, tree: 'x'.repeat(22001), truncated: true } })).toBeNull();
  const form = { kind: 'form' as const, workId: 7, itemId: 71 };
  expect(parse(form, { ok: true, data: { kind: 'form', candidateId: 4, candidateSequence: 1,
    target: { formInstanceId: 'form-1', expectedRevision: 0 } } })).toMatchObject({ ok: true });
});

test('desktop proposals accept only a grounded control and a supported action', () => {
  const schema = DesktopActionProposalSchema;
  const click = { kind: 'click', observationId, elementIndex: 3 };
  expect(schema?.safeParse(click).success).toBe(true);
  expect(schema?.safeParse({ kind: 'set_value', observationId, elementIndex: 3, value: '' }).success).toBe(true);
  expect(schema?.safeParse({ kind: 'type_text', observationId, elementIndex: 3, text: '113.00' }).success).toBe(true);
  for (const invalid of [
    { ...click, elementIndex: -1 }, { ...click, observationId: 'stale' },
    { ...click, script: 'arbitrary JavaScript' }, { ...click, kind: 'press_key', key: 'Enter' },
    { ...click, x: 10, y: 20 }, { kind: 'set_value', observationId, elementIndex: 3 },
  ]) expect(schema?.safeParse(invalid).success).toBe(false);
});

test('an approved action can be requested only by its original proposal identity', () => {
  const schema = DesktopActionExecuteSchema;
  expect(schema?.safeParse({ proposalId: 7 }).success).toBe(true);
  expect(schema?.safeParse({ proposalId: 0 }).success).toBe(false);
  expect(schema?.safeParse({ proposalId: 7, kind: 'click', elementIndex: 4 }).success).toBe(false);
});

test('a desktop decision binds one work item and an idempotent request', () => {
  const schema = DesktopActionDecisionRequestSchema;
  const decision = { workId: 7, itemId: 71, proposalId: 9, expectedRevision: 2, requestId: 'confirm-original', decision: 'approve' };
  expect(schema?.safeParse(decision).success).toBe(true);
  for (const invalid of [
    { ...decision, itemId: 0 }, { ...decision, expectedRevision: -1 }, { ...decision, requestId: '  ' },
    { ...decision, decision: 'approve_all' }, { ...decision, action: { kind: 'click' } },
  ]) expect(schema?.safeParse(invalid).success).toBe(false);
});

test('a desktop action view preserves ownership and distinguishes a claimed input from a waiting proposal', () => {
  const viewSchema = DesktopActionViewSchema;
  const pageSchema = DesktopActionListResultSchema;
  const view = { proposalId: 9, workId: 7, itemId: 71, proposalToolCallId: 14,
    target: { connectionId: observationId, window: { id: 42, app: 'Invoice', title: 'Draft' }, element: '[3] Submit' },
    action: { kind: 'click', observationId, elementIndex: 3 }, status: 'waiting', canDecide: true, canReject: true, executionToolCallId: null,
    createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' };
  expect(viewSchema?.safeParse(view).success).toBe(true);
  expect(viewSchema?.safeParse({ ...view, status: 'claimed', canDecide: false, canReject: false, executionToolCallId: 15 }).success).toBe(true);
  expect(viewSchema?.safeParse({ ...view, status: 'claimed', executionToolCallId: 15 }).success).toBe(false);
  expect(viewSchema?.safeParse({ ...view, status: 'claimed' }).success).toBe(false);
  expect(viewSchema?.safeParse({ ...view, executionToolCallId: 15 }).success).toBe(false);
  expect(viewSchema?.safeParse({ ...view, target: { ...view.target, element: '[4] Delete' } }).success).toBe(false);
  expect(pageSchema?.safeParse({ workId: 7, itemId: 71, items: [view], nextAfterProposalId: null }).success).toBe(true);
  expect(pageSchema?.safeParse({ workId: 7, itemId: 72, items: [view], nextAfterProposalId: null }).success).toBe(false);
});
