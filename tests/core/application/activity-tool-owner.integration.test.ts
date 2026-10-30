import { expect, test } from 'bun:test';
import { appError, fail, invoiceToolSchemas, type Result } from '@flowmate/contracts';
import { makeApplication } from '../../../packages/core/src/application.ts';
import { RuntimeService } from '../../../packages/core/src/runtime/service.ts';
import { makeCurrentSelectedCandidate } from '../../support/selected-candidate.ts';
import { deferCleanup } from '../../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

async function fixture() {
  const database = await makeCurrentSelectedCandidate();
  const runtime = new RuntimeService({ database, provider: {
    async prepare() { throw Error('Activity and Tool queries must not start models.'); },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  }, log: { write() {}, async close() {} }, now: () => database.stamp, monotonicNow: () => performance.now() });
  const app = makeApplication(runtime, { get: id => database.read(scope => scope.runs.get(id)) },
    async () => { await database.close(); return { stopped: true, closed: true, errors: [] }; },
    undefined, undefined, undefined, undefined, { documents: database.documents, jobs: database.jobs, candidates: database.candidates,
      events: { list: input => database.read(scope => scope.businessEvents.list(input)) },
      toolCalls: {
        list: input => database.read(scope => scope.toolCalls.list(input)),
        getById: id => database.read(scope => scope.toolCalls.getById(id)),
        request: input => database.transaction(scope => scope.toolCalls.request(input)),
        fixArguments: input => database.transaction(scope => scope.toolCalls.fixArguments(input)),
      },
      importInvoiceMaterial: async () => fail(appError('input_unavailable', 'input', 'No imports in query tests.')),
      importPreparedInvoiceMaterial: async () => fail(appError('input_unavailable', 'input', 'No imports in query tests.')),
      readDocumentPage: () => fail(appError('input_unavailable', 'input', 'No documents in query tests.')),
      listDocumentPages: () => fail(appError('input_unavailable', 'input', 'No documents in query tests.')),
      readDocumentOriginal: () => fail(appError('input_unavailable', 'input', 'No documents in query tests.')),
    });
  deferCleanup(() => app.close());
  const expired = () => fail(appError('storage_read_failed', 'storage', 'Expired root query repository.'));
  database.businessEvents.list = expired;
  database.toolCalls.list = expired; database.toolCalls.getById = expired;
  database.toolCalls.request = expired; database.toolCalls.fixArguments = expired;
  return { database, app, owner: { runId: database.runId, sessionId: database.session.sessionId }, toolCallId: database.toolCallId };
}

test('Activity and Tool reads wait for the real owner and keep Tool arguments out of the public projection', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = 0;
  const reading = Promise.all([
    f.app.listActivity({ jobId: f.database.jobId }).then(value => { settled++; return value; }),
    f.app.listRunToolCalls(f.owner).then(value => { settled++; return value; }),
    f.app.queryRunToolCall({ ...f.owner, toolCallId: f.toolCallId }).then(value => { settled++; return value; }),
    f.app.queryRunToolEvidence({ ...f.owner, toolCallId: f.toolCallId }).then(value => { settled++; return value; }),
  ]);
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(0);
    release.resolve(); await holding;
    const [activity, tools, detail, evidence] = await reading;
    expect(need(activity).items.map(item => item.type)).toContain('candidate_generated');
    expect(tools).toMatchObject({ ok: true, data: { items: [{ toolCallId: f.toolCallId, status: 'succeeded' }] } });
    const page = need(tools);
    for (const field of ['args', 'result', 'cleanup', 'nativeToolCallId']) expect(Object.hasOwn(page.items[0]!, field)).toBe(false);
    expect(detail).toMatchObject({ ok: true, data: { toolCallId: f.toolCallId, status: 'succeeded' } });
    expect(evidence).toMatchObject({ ok: true, data: { version: 2, ...f.owner, toolCallId: f.toolCallId, offset: 0 } });
  } finally { release.resolve(); await holding; await reading; }
});

test('an asynchronous Tool lookup cannot return a successful ToolCall owned by another Run', async () => {
  const f = await fixture();
  const selected = f.database.selectedWorkspace;
  const other = need(await f.database.transaction(scope => scope.runs.createWorkspaceAgent({ sessionId: f.owner.sessionId,
    expected: { revision: selected.revision, sessionId: f.owner.sessionId, documentRef: selected.documentRef,
      jobId: selected.jobId, candidateRef: selected.candidateRef },
    goalMode: 'answer', text: 'Readonly alternate owner', goal: 'Readonly alternate owner', messageTimestamp: 2,
    config: f.database.config, usage: f.database.usage, cleanup: f.database.cleanup, createdAt: f.database.stamp },
  input => f.database.verify(input, scope))));
  const foreign = { runId: other.runId, sessionId: f.owner.sessionId, toolCallId: f.toolCallId };
  expect(await f.app.queryRunToolCall(foreign)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.app.queryRunToolEvidence(foreign)).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
});

test('invoice replay awaits the original owner receipt and never invokes the save tool again', async () => {
  const f = await fixture(), call = need(await f.database.read(scope => scope.toolCalls.getById(f.toolCallId)));
  const rawArguments = invoiceToolSchemas.save_invoice_candidate.input.parse(call.args.raw);
  const finalArguments = invoiceToolSchemas.save_invoice_candidate.input.parse(call.args.final);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = false;
  const replaying = f.app.replayInvoiceSave({ ...f.owner, toolCallId: f.toolCallId, nativeToolCallId: call.nativeToolCallId,
    rawArguments, arguments: finalArguments }).then(value => { settled = true; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    release.resolve(); await holding;
    expect(await replaying).toMatchObject({ ok: true, data: { ...f.owner, toolCallId: f.toolCallId,
      nativeToolCallId: call.nativeToolCallId, created: false, receipt: { candidateId: f.database.candidateId } } });
    expect(need(await f.app.listRunToolCalls(f.owner)).items).toHaveLength(1);
    expect(need(await f.database.read(scope => scope.candidates.listByJob({ jobId: f.database.jobId, beforeSequence: null, limit: 10 }))).items).toHaveLength(1);
  } finally { release.resolve(); await holding; await replaying; }
});
