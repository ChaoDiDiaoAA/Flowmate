import { describe, expect, it, mock } from 'bun:test';
import { appError, fail, ok } from '../../../packages/contracts/src/errors.ts';
import { makeApplication, type ProductApplicationOptions, type RuntimeServicePort } from '../../../packages/core/src/application.ts';

const at = '2026-10-29T00:00:00.000Z';
const configuration = { modelId: null, thinkingLevel: 'off', preferences: '', workingDirectory: null,
  resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [] } as const;
const snapshot = { personalAgentId: 1, revision: 2, runtimeKind: 'durable', configuration, createdAt: at, updatedAt: at } as const;
const continued = { workId: 7, requestId: 'continue-1', expectedRevision: 3, expectedAttemptId: 21 };
const attempt = { attemptId: 22, runId: 32, runtimeLinked: true };
const receipt = { operation: 'continueWork', workId: 7, requestId: 'continue-1', revision: 4, receivedAt: at,
  execution: { kind: 'accepted', authorizationAccepted: true, attempt, relation: 'new' } } as const;
const denied = () => fail(appError('state_conflict', 'runtime', 'Service rejected this request.'));
const unavailable = { ok: false, error: { code: 'personal_agent_unavailable' } };

function fixture(assembled = true) {
  const personal: NonNullable<ProductApplicationOptions['personal']> = {
    agent: { get: mock(async () => denied()), update: mock(async () => denied()), openConversation: mock(async () => denied()) },
    works: { create: mock(async () => denied()), list: mock(async () => denied()), get: mock(async () => denied()),
      supplement: mock(async () => denied()), disposeItem: mock(async () => denied()), continueWork: mock(async () => denied()),
      cancelWork: mock(async () => denied()), queryOperation: mock(async () => denied()), timeline: mock(async () => denied()) },
    tasks: { list: mock(async () => denied()), get: mock(async () => denied()), stop: mock(async () => denied()), resume: mock(async () => ok(undefined)),
      history: mock(async () => denied()), historyEntry: mock(async () => denied()) },
  };
  const runtime: RuntimeServicePort = {
    compactSession: async () => denied(), querySessionCompaction: async () => denied(), cancelSessionCompaction: async () => denied(),
    callProvider: mock(async () => denied()), start: mock(async () => denied()), cancel: mock(() => denied()),
    revokeDocumentUse: async () => denied(), state: () => ({ active: null, blocked: false, error: null }),
    close: async () => ({ stopped: true, closed: true, errors: [] }),
  };
  const products: ProductApplicationOptions = {
    ...(assembled ? { personal } : {}),
    documents: { list: denied, get: denied }, jobs: { list: denied, get: denied },
    candidates: { listByJob: denied, readByJob: denied }, events: { list: denied },
    importInvoiceMaterial: async () => denied(), importPreparedInvoiceMaterial: async () => denied(),
    readDocumentPage: denied, listDocumentPages: denied, readDocumentOriginal: denied,
  };
  const app = makeApplication(runtime, { get: denied }, runtime.close, undefined, undefined, undefined, undefined, products);
  return { app, personal, runtime, products };
}

describe('P18 Application public routes', () => {
  it('keeps all namespaces available and explicitly rejects an unassembled capability without starting a model', async () => {
    const { app, runtime } = fixture(false);
    const results = await Promise.all([
      app.personalAgent.get(), app.personalAgent.update({ personalAgentId: 1, expectedRevision: 1, configuration }),
      app.personalAgent.openConversation({ workId: 7 }),
      app.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 2, requestId: 'create-1', goal: 'Organize.', documents: [{ id: 11, version: 'v1' }] }),
      app.invoiceWorks.list({ personalAgentId: 1 }), app.invoiceWorks.get({ view: 'work', workId: 7 }),
      app.invoiceWorks.supplement({ workId: 7, itemId: 71, todoId: 81, requestId: 'supplement-1', expectedRevision: 3, text: 'Clarification.', materials: [] }),
      app.invoiceWorks.disposeItem({ workId: 7, itemId: 71, requestId: 'dispose-1', expectedRevision: 3, decision: { kind: 'excluded', reason: 'Explicitly excluded.' } }),
      app.invoiceWorks.continueWork(continued), app.invoiceWorks.cancelWork({ workId: 7, requestId: 'cancel-1', expectedRevision: 3 }),
      app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'create-1' }),
      app.personalTasks.list({ workId: 7 }), app.personalTasks.get({ workId: 7, attemptId: 21 }),
      app.personalTasks.stop({ workId: 7, attemptId: 21, requestId: 'stop-1', expectedRevision: 3 }),
      app.personalTasks.resume({ workId: 7, attemptId: 21 }),
      app.personalTasks.history({ target: { workId: 7 } }),
      app.personalTasks.historyEntry({ target: { workId: 7 }, throughEntryId: 9, entryId: 8 }),
      app.invoiceWorks.timeline({ workId: 7 }),
    ]);
    for (const result of results) expect(result).toMatchObject(unavailable);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.callProvider).not.toHaveBeenCalled();
  });

  it('validates first, delegates each public route once, and supplies schema page defaults', async () => {
    const { app, personal, runtime } = fixture();
    const requests: { invoke: () => Promise<unknown>; called: Function; input?: unknown }[] = [
      { invoke: () => app.personalAgent.get(), called: personal.agent.get },
      { invoke: () => app.personalAgent.update({ personalAgentId: 1, expectedRevision: 1, configuration }), called: personal.agent.update,
        input: { personalAgentId: 1, expectedRevision: 1, configuration } },
      { invoke: () => app.personalAgent.openConversation({ workId: 7 }), called: personal.agent.openConversation, input: { workId: 7 } },
      { invoke: () => app.invoiceWorks.create({ personalAgentId: 1, expectedAgentRevision: 2, requestId: 'create-1', goal: 'Organize.', documents: [{ id: 11, version: 'v1' }] }),
        called: personal.works.create, input: { personalAgentId: 1, expectedAgentRevision: 2, requestId: 'create-1', goal: 'Organize.', documents: [{ id: 11, version: 'v1' }] } },
      { invoke: () => app.invoiceWorks.list({ personalAgentId: 1 }), called: personal.works.list, input: { personalAgentId: 1, limit: 50 } },
      { invoke: () => app.invoiceWorks.get({ view: 'work', workId: 7 }), called: personal.works.get, input: { view: 'work', workId: 7, limit: 50 } },
      { invoke: () => app.invoiceWorks.supplement({ workId: 7, itemId: 71, todoId: 81, requestId: 'supplement-1', expectedRevision: 3, text: 'Clarification.', materials: [] }),
        called: personal.works.supplement, input: { workId: 7, itemId: 71, todoId: 81, requestId: 'supplement-1', expectedRevision: 3, text: 'Clarification.', materials: [] } },
      { invoke: () => app.invoiceWorks.disposeItem({ workId: 7, itemId: 71, requestId: 'dispose-1', expectedRevision: 3, decision: { kind: 'excluded', reason: 'Excluded.' } }),
        called: personal.works.disposeItem, input: { workId: 7, itemId: 71, requestId: 'dispose-1', expectedRevision: 3, decision: { kind: 'excluded', reason: 'Excluded.' } } },
      { invoke: () => app.invoiceWorks.continueWork(continued), called: personal.works.continueWork, input: continued },
      { invoke: () => app.invoiceWorks.cancelWork({ workId: 7, requestId: 'cancel-1', expectedRevision: 3 }), called: personal.works.cancelWork,
        input: { workId: 7, requestId: 'cancel-1', expectedRevision: 3 } },
      { invoke: () => app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'create-1' }), called: personal.works.queryOperation,
        input: { operation: 'create', personalAgentId: 1, requestId: 'create-1' } },
      { invoke: () => app.personalTasks.list({ workId: 7 }), called: personal.tasks.list, input: { workId: 7, limit: 50 } },
      { invoke: () => app.personalTasks.get({ workId: 7, attemptId: 21 }), called: personal.tasks.get, input: { workId: 7, attemptId: 21, limit: 50 } },
      { invoke: () => app.personalTasks.stop({ workId: 7, attemptId: 21, requestId: 'stop-1', expectedRevision: 3 }), called: personal.tasks.stop,
        input: { workId: 7, attemptId: 21, requestId: 'stop-1', expectedRevision: 3 } },
      { invoke: () => app.personalTasks.history({ target: { workId: 7 } }), called: personal.tasks.history,
        input: { target: { workId: 7 }, limit: 50 } },
      { invoke: () => app.personalTasks.historyEntry({ target: { workId: 7 }, throughEntryId: 9, entryId: 8 }), called: personal.tasks.historyEntry,
        input: { target: { workId: 7 }, throughEntryId: 9, entryId: 8, offset: 0, limit: 16384 } },
      { invoke: () => app.invoiceWorks.timeline({ workId: 7 }), called: personal.works.timeline, input: { workId: 7, limit: 50 } },
    ];
    for (const request of requests) {
      expect(await request.invoke()).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
      expect(request.called).toHaveBeenCalledTimes(1);
      if (request.input === undefined) expect(request.called).toHaveBeenCalledWith();
      else expect(request.called).toHaveBeenCalledWith(request.input);
    }
    expect(personal.tasks.resume).not.toHaveBeenCalled();
    expect(personal.tasks.stop).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.callProvider).not.toHaveBeenCalled();
  });

  it('rejects invalid product identities and extra authority before service or runtime calls', async () => {
    for (const assembled of [true, false]) {
      const { app, personal, runtime } = fixture(assembled);
      for (const result of await Promise.all([
        app.personalAgent.update({ personalAgentId: 0, expectedRevision: 1, configuration }),
        app.personalAgent.openConversation({ workId: 0 }), app.invoiceWorks.list({ personalAgentId: 0 }),
        app.invoiceWorks.get({ view: 'work', workId: 0 }),
        app.invoiceWorks.continueWork({ ...continued, nativeTaskId: 'native' } as never),
        app.invoiceWorks.queryOperation({ operation: 'create', requestId: 'create-1' } as never),
        app.personalTasks.list({ workId: 0 }), app.personalTasks.get({ workId: 7, attemptId: 0 }),
        app.personalTasks.stop({ workId: 7, attemptId: 21, requestId: ' ', expectedRevision: 3 }),
        app.personalTasks.resume({ workId: 7, attemptId: 21, nativeTaskId: 'native' } as never),
      ])) expect(result).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
      for (const group of Object.values(personal)) for (const method of Object.values(group)) expect(method).not.toHaveBeenCalled();
      expect(runtime.start).not.toHaveBeenCalled();
      expect(runtime.callProvider).not.toHaveBeenCalled();
    }
  });

  it('returns confirmed product results and rejects foreign or malformed service replies', async () => {
    const { app, personal, runtime } = fixture();
    personal.agent.get = mock(async () => ok(snapshot));
    personal.works.continueWork = mock(async () => ok(receipt));
    personal.works.queryOperation = mock(async () => ok(null));
    expect(await app.personalAgent.get()).toEqual(ok(snapshot));
    expect(await app.invoiceWorks.continueWork(continued)).toEqual(ok(receipt));
    expect(await app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: 1, requestId: 'lost-create' })).toEqual(ok(null));
    personal.works.continueWork = mock(async () => ok({ ...receipt, workId: 8 }));
    expect(await app.invoiceWorks.continueWork(continued)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
    personal.agent.get = mock(async () => ok({ ...snapshot, nativeConversationId: 'secret' }));
    expect(await app.personalAgent.get()).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
    personal.works.get = mock(async () => { throw new Error('native secret path'); });
    expect(JSON.stringify(await app.invoiceWorks.get({ view: 'work', workId: 7 }))).not.toContain('native secret path');
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.callProvider).not.toHaveBeenCalled();
  });

  it('keeps authorized internal resume separate from the user continue command', async () => {
    const { app, personal, runtime } = fixture();
    expect(await app.personalTasks.resume({ workId: 7, attemptId: 21 })).toEqual(ok(undefined));
    expect(personal.tasks.resume).toHaveBeenCalledWith({ workId: 7, attemptId: 21 });
    expect(personal.works.continueWork).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.callProvider).not.toHaveBeenCalled();
  });

  it.each(['failed-result', 'throw'] as const)('retains the data owner after Personal close %s and confirms both runtimes before disposal', async kind => {
    const f = fixture(), dispose = mock(async () => ({ stopped: true, closed: true, errors: [] }));
    let confirmed = false;
    const closePersonal = mock(async () => {
      if (confirmed) return ok(undefined);
      if (kind === 'throw') throw Error('PRIVATE_NATIVE_STOP_DETAIL');
      return fail(appError('stop_unconfirmed', 'runtime', 'The original background stop is unconfirmed.', true));
    });
    f.personal.close = closePersonal;
    const closeLegacy = mock(f.runtime.close); f.runtime.close = closeLegacy;
    const app = makeApplication(f.runtime, { get: denied }, dispose, undefined, undefined, undefined, undefined, f.products);
    const code = kind === 'throw' ? 'personal_agent_close_failed' : 'stop_unconfirmed';
    const first = await app.close();
    expect(first).toMatchObject({ ok: true, data: { stopped: false, closed: false, errors: [{ code }] } });
    expect(JSON.stringify(first)).not.toContain('PRIVATE_NATIVE_STOP_DETAIL');
    expect(closePersonal).toHaveBeenCalledTimes(1); expect(closeLegacy).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(await app.invoiceWorks.continueWork(continued)).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(f.personal.works.continueWork).not.toHaveBeenCalled();
    expect(await app.invoiceWorks.list({ personalAgentId: 1 })).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(f.personal.works.list).toHaveBeenCalledTimes(1);
    confirmed = true;
    const final = await app.close();
    expect(final).toMatchObject({ ok: true, data: { stopped: true, closed: true, errors: [{ code }] } });
    expect(dispose).toHaveBeenCalledTimes(1); expect(closeLegacy).toHaveBeenCalledTimes(2);
    expect(await app.close()).toEqual(final); expect(closePersonal).toHaveBeenCalledTimes(2);
  });
});
