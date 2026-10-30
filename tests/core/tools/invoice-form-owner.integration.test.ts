import { expect, test } from 'bun:test';
import { fail, ok } from '@flowmate/contracts';
import type { InvoiceFormApplicationReceipt, InvoiceFormBridgeRequest, ProductToolContext, Result } from '@flowmate/contracts';
import { createInvoiceFormService } from '../../../packages/core/src/tools/invoice-form.ts';
import { makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture() {
  const store = await makeCurrentSelectedCandidate(), nativeToolCallId = 'owner-fill';
  const target = { formInstanceId: 'owner-form', expectedRevision: 0 };
  const context = await store.transaction(scope => {
    const selected = store.selectedWorkspace;
    const created = need(scope.runs.createWorkspaceAgent({ sessionId: store.session.sessionId,
      expected: { revision: selected.revision, sessionId: store.session.sessionId, documentRef: selected.documentRef,
        jobId: selected.jobId, candidateRef: selected.candidateRef }, goalMode: 'fill-form', formTarget: target,
      goal: 'Fill the original form', text: 'Fill', messageTimestamp: 1, config: store.config, usage: store.usage,
      cleanup: store.cleanup, createdAt: store.stamp }, input => store.verify(input, scope)));
    const config = { ...store.config, goalMode: 'fill-form' as const, workspaceContext: created.workspaceContext, formTarget: target };
    need(scope.runs.start(created.runId, config, store.stamp));
    const args = { candidateId: store.candidateId };
    const call = need(scope.toolCalls.request({ context: null, runId: created.runId, sessionId: store.session.sessionId,
      nativeToolCallId, toolName: 'fill_invoice_form', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: args, requestedAt: store.stamp }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: store.stamp }));
    return { toolCallId: call.toolCallId, product: { runId: created.runId, sessionId: store.session.sessionId,
      scope: created.scope } satisfies ProductToolContext };
  });
  const calls: InvoiceFormBridgeRequest[] = [];
  const service = createInvoiceFormService({ database: store, now: () => store.stamp, async bridge(request) {
      calls.push(request);
      return { runId: request.runId, toolCallId: request.toolCallId, candidateId: request.candidateId,
        candidateSequence: request.candidateSequence, formInstanceId: request.target.formInstanceId,
        outcome: 'applied', appliedRevision: request.target.expectedRevision + 1, appliedAt: store.stamp,
        observedAt: store.stamp } satisfies InvoiceFormApplicationReceipt;
    } });
  const controller = new AbortController();
  const call = { nativeToolCallId, signal: controller.signal };
  return { store, service, calls, context, controller, call };
}

for (const disposition of ['apply', 'cancel'] as const) test(`Fill ${disposition} waits for current owner eligibility before the bridge`, async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = f.store.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const applying = f.service.apply({ candidateId: f.store.candidateId }, f.call, f.context.product)
    .then(value => ok(value), error => fail(error)).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false); expect(f.calls).toHaveLength(0);
    if (disposition === 'cancel') f.controller.abort();
  } finally { release.resolve(); await held; }
  const result = await applying;
  if (disposition === 'apply') { expect(result).toMatchObject({ ok: true, data: { applied: true } }); expect(f.calls).toHaveLength(1); }
  else { expect(result).toMatchObject({ ok: false, error: { code: 'agent_cancelled' } }); expect(f.calls).toHaveLength(0); }
});

test('Fill result is not acknowledged until its actual receipt transaction commits', async () => {
  const f = await fixture(), transaction = f.store.transaction, release = Promise.withResolvers<void>();
  let entered = false, settled = false;
  f.store.transaction = operation => {
    f.store.transaction = transaction;
    return transaction(async scope => { const value = await operation(scope); entered = true; await release.promise; return value; });
  };
  const applying = f.service.apply({ candidateId: f.store.candidateId }, f.call, f.context.product)
    .then(value => ok(value), error => fail(error)).finally(() => { settled = true; });
  try { await tick(); expect(entered).toBe(true); expect(settled).toBe(false); expect(f.calls).toHaveLength(1); }
  finally { release.resolve(); }
  expect(await applying).toMatchObject({ ok: true, data: { applied: true } });
  expect(await f.service.query({ runId: f.context.product.runId, toolCallId: f.context.toolCallId }))
    .toMatchObject({ ok: true, data: { outcome: 'applied' } });
  expect(f.calls).toHaveLength(1);
});
