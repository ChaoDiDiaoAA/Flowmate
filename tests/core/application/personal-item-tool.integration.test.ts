import { expect, test } from 'bun:test';
import { type Result } from '@flowmate/contracts';
import { createInvoiceWorkToolBridge } from '../../../packages/core/src/personal-agent/tool-scope.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

test('product tool receipts stay bound to the original invoice phase and its conversation', async () => {
  const at = '2026-10-29T00:00:00.000Z', f = await invoiceWorkToolsFixture({ itemLane: true });
  try {
    await f.database.transaction(scope => {
      need(scope.sessions.bindDurableConversation(f.created.sessionId, 101, at));
      need(scope.invoiceWorks.linkPhase({ workId: f.created.workId, attemptId: f.attemptId, phaseId: f.phase.phaseId,
        nativeConversationId: 102, nativeSubmissionId: 201, at }));
    });
    const bridge = createInvoiceWorkToolBridge({ database: f.database, executor: f.executor });
    const call = { workId: f.created.workId, sessionId: f.created.sessionId, itemId: f.itemId, attemptId: f.attemptId,
      requestId: f.phase.requestId, nativeConversationId: 102, nativeTaskId: 71, nativeToolCallId: 'model-call',
      name: 'read_invoice_document', arguments: { documentId: 1, page: 1, afterBlockId: null, limit: 10 }, signal: new AbortController().signal };
    expect(await bridge.executeTool(call)).toMatchObject({ ok: true, data: { status: 'succeeded' } });
    const { signal: _signal, ...identity } = call;
    expect(await bridge.readToolResult(identity)).toMatchObject({ ok: true, data: { status: 'succeeded' } });
    expect(await bridge.readToolResult({ ...identity, itemId: f.itemId + 1 })).toMatchObject({ ok: false });
    expect(await bridge.readToolResult({ ...identity, nativeConversationId: 101 })).toMatchObject({ ok: false });
    expect(await f.database.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM tool_calls').get())).toEqual({ count: 1 });
  } finally { await f.database.close(); }
});
