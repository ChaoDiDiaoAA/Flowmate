import { expect, it } from 'bun:test';
import { appError, fail, ok, InvoiceWorkCreateReceiptSchema } from '@flowmate/contracts';
import { capturePersonalWrite, personalOperationQuery, recoverPersonalWrite, executePersonalWrite,
  readPersonalDraft, savePersonalDraft, emptyPersonalDraft, type PersonalWriteBridge } from '../../apps/desktop/renderer/src/personal-state.ts';

const create = { type: 'invoice_work_create', input: { personalAgentId: 1, expectedAgentRevision: 0,
  requestId: 'original-create', goal: 'Review these invoices.', documents: [{ id: 11, version: 'v1' }] } } as const;
const receipt = InvoiceWorkCreateReceiptSchema.parse({ operation: 'create', personalAgentId: 1, workId: 7, sessionId: 70, revision: 0,
  requestId: 'original-create', receivedAt: '2026-10-29T00:00:00.000Z',
  execution: { kind: 'waiting', authorizationAccepted: false, attempt: null, reason: 'Select a model.', todoIds: [] } });
const denied = async () => fail(appError('state_conflict', 'runtime', 'Refused.'));

it('keeps an unconfirmed create request across reload and queries it without a Work ID or another write', async () => {
  let writes = 0, queries = 0;
  const bridge: PersonalWriteBridge = { invoiceWorks: { create: async () => { writes++; return fail(appError('operation_result_unknown', 'runtime', 'Receipt lost.')); },
    continueWork: denied, supplement: denied, disposeItem: denied, cancelWork: denied,
    queryOperation: async input => { queries++; expect(input).toEqual({ operation: 'create', personalAgentId: 1, requestId: 'original-create' }); return ok(receipt); } },
    personalTasks: { stop: denied, get: denied } };
  const pending = capturePersonalWrite(create); if (!pending) throw Error('Expected a valid create.');
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  expect(savePersonalDraft(storage, { ...emptyPersonalDraft(), pending })).toBe(true);
  expect(await executePersonalWrite(bridge, pending)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  const restored = readPersonalDraft(storage); if (!restored.ok || !restored.data.pending) throw Error('Original pending command was lost.');
  expect(restored.data.pending).toEqual(pending);
  expect(await recoverPersonalWrite(bridge, restored.data.pending)).toEqual(ok(receipt));
  expect(writes).toBe(1); expect(queries).toBe(1);
});

it('rejects native authority and foreign receipts and preserves the original stopped-attempt target', async () => {
  expect(capturePersonalWrite({ type: 'personal_task_resume', input: { workId: 7, attemptId: 2 } })).toBeNull();
  expect(capturePersonalWrite({ ...create, input: { ...create.input, nativeTaskId: 9 } })).toBeNull();
  const pending = capturePersonalWrite(create); if (!pending) throw Error('Expected original request.');
  const bridge: PersonalWriteBridge = { invoiceWorks: { create: async () => ok({ ...receipt, workId: 8, requestId: 'foreign' }),
    continueWork: denied, supplement: denied, disposeItem: denied, cancelWork: denied, queryOperation: async () => ok({ ...receipt, requestId: 'foreign' }) },
    personalTasks: { stop: denied, get: denied } };
  expect(await executePersonalWrite(bridge, pending)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  expect(await recoverPersonalWrite(bridge, pending)).toMatchObject({ ok: false });
  const stop = capturePersonalWrite({ type: 'personal_task_stop', input: { workId: 7, attemptId: 21, expectedRevision: 3, requestId: 'original-stop' } });
  expect(stop && personalOperationQuery(stop)).toEqual({ workId: 7, attemptId: 21, stopRequestId: 'original-stop', limit: 1 });
});

it('reports unreadable saved drafts instead of replacing an unknown operation with an empty successful state', () => {
  expect(readPersonalDraft({ getItem: () => '{broken' })).toMatchObject({ ok: false });
  expect(readPersonalDraft({ getItem: () => null })).toEqual(ok(emptyPersonalDraft()));
  expect(savePersonalDraft({ setItem: () => { throw Error('Storage unavailable.'); } }, emptyPersonalDraft())).toBe(false);
});
