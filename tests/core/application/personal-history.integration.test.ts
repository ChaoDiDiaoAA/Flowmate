import { expect, test } from 'bun:test';
import { DurableSubagentConfigSnapshotSchema, DurableSubagentRunScopeSchema, PersonalAgentConfigurationSchema,
  ok, type DurablePublicHistoryEntryQuery, type DurablePublicHistoryQuery, type PersonalHistoryPage, type Result } from '@flowmate/contracts';
import { createPersonalHistoryService } from '../../../packages/core/src/personal-agent/history.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

const at = '2026-10-29T00:00:00.000Z';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
async function fixture() {
  const f = await invoiceWorkToolsFixture({ configuration: PersonalAgentConfigurationSchema.parse({ modelId: null, thinkingLevel: 'off',
    tools: ['Agent', 'read_invoice_document'], resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
    workingDirectory: null, preferences: '' }) });
  const args = { prompt: 'Check the original invoice total.', description: 'Check total', subagent_type: 'invoice-evidence-checker', run_in_background: false as const };
  const child = await f.database.transaction(store => {
    const call = need(store.toolCalls.request({ runId: f.runId, sessionId: f.created.sessionId, nativeToolCallId: 'durable-task:91',
      toolName: 'Agent', toolVersion: '1.4.0-p18', effect: 'READ', invoiceWorkScope: f.product.scope,
      rawArguments: args, context: null, requestedAt: at }));
    need(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
    need(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    const subagent = { parentRunId: f.runId, originToolCallId: call.toolCallId, phaseId: f.phase.phaseId, itemId: f.itemId,
      parentRequestId: f.phase.requestId, role: 'invoice-evidence-checker' as const };
    const child = need(store.runs.createDurableSubagent({ parentRunId: f.runId, originToolCallId: call.toolCallId, nativeToolTaskId: 91, args, at,
      config: DurableSubagentConfigSnapshotSchema.parse({ ...f.config, version: 4, subagent }),
      scope: DurableSubagentRunScopeSchema.parse({ version: 5, workId: f.created.workId, attemptId: f.attemptId, ...subagent,
        allowedTools: ['read_invoice_document'], allowedDocumentIds: [1], allowedArtifactIds: [1, 2], allowedResourcePaths: [] }) }));
    return { ...child, originToolCallId: call.toolCallId };
  });
  const calls: Array<DurablePublicHistoryQuery | DurablePublicHistoryEntryQuery> = [];
  let foreign = false;
  const owner = (input: DurablePublicHistoryQuery) => ({ runtimeKind: 'durable' as const,
    workId: input.workId, sessionId: input.child?.childSessionId ?? input.sessionId, childRunId: input.child?.childRunId ?? null });
  const service = createPersonalHistoryService({ database: f.database, runtime: {
    queryHistoryPage: async input => { calls.push(input); return ok({ owner: { ...owner(input), workId: foreign ? 999 : input.workId },
      throughEntryId: 0, entries: [], nextBeforeEntryId: null } satisfies PersonalHistoryPage); },
    queryHistoryEntry: async input => { calls.push(input); return ok({ owner: owner(input), throughEntryId: input.throughEntryId,
      entryId: input.entryId, kind: 'flowmate.test.fact', format: 'pi-durable-entry/v1', offset: input.offset ?? 0,
      totalBytes: 2, text: '{}', nextOffset: null }); },
  } });
  return { ...f, child, service, calls, setForeign: () => { foreign = true; } };
}

test('product history resolves original root and child owners without execution, even after a user stop', async () => {
  const f = await fixture();
  try {
    const before = await f.database.read(store => store.db.query('SELECT COUNT(*) count FROM runs').get());
    const target = { workId: f.created.workId };
    expect(need(await f.service.history({ target })).owner).toEqual({ ...target, sessionId: f.created.sessionId, runtimeKind: 'durable', childRunId: null });
    need(await f.database.transaction(store => store.runs.recordCancel(f.runId, at)));
    expect(need(await f.service.history({ target: { ...target, childRunId: f.child.runId } })).owner).toEqual({ ...target,
      sessionId: f.child.sessionId, runtimeKind: 'durable', childRunId: f.child.runId });
    expect(f.calls[0]).toMatchObject({ workId: f.created.workId, sessionId: f.created.sessionId, limit: 50 });
    expect(f.calls[1]).toMatchObject({ workId: f.created.workId, sessionId: f.created.sessionId,
      child: { attemptId: f.attemptId, requestId: f.phase.requestId, childRunId: f.child.runId, childSessionId: f.child.sessionId,
        originToolCallId: f.child.originToolCallId, nativeToolTaskId: 91 } });
    expect(await f.database.read(store => store.db.query('SELECT COUNT(*) count FROM runs').get())).toEqual(before);
    expect(await f.service.historyEntry({ target: { ...target, childRunId: f.child.runId }, entryId: 1, throughEntryId: 1 })).toMatchObject({ ok: true });
  } finally { await f.database.close(); }
});

test('product history rejects invalid, foreign and corrupt owners before crossing the native read port', async () => {
  const f = await fixture();
  try {
    for (const target of [{ workId: f.created.workId, childRunId: f.runId }, { workId: 999, childRunId: f.child.runId },
      { workId: f.created.workId, childRunId: 999 }, { workId: 0 }])
      expect(await f.service.history({ target })).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
    const originalRead = f.database.read;
    f.database.read = action => originalRead(store => action({ ...store, runs: { ...store.runs,
      get: id => {
        const result = store.runs.get(id);
        return result.ok && id === f.child.runId ? ok({ ...result.data,
          scope: { ...DurableSubagentRunScopeSchema.parse(result.data.scope), workId: 999 } }) : result;
      },
    } }));
    expect(await f.service.history({ target: { workId: f.created.workId, childRunId: f.child.runId } })).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
    f.database.read = originalRead;
    f.setForeign();
    expect(await f.service.history({ target: { workId: f.created.workId } })).toMatchObject({ ok: false });
  } finally { await f.database.close(); }
});
