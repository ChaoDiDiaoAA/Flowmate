import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { z } from 'zod';
import { createApplication } from '../../../apps/composition.ts';
import { appError, fail, ok, PersonalAgentConfigurationSchema, InvoiceWorkWorkingContextSchema, invoiceToolSchemas, type DocumentSnapshot, type InvoiceWorkWorkingContext,
  type ProductPaths, type ProviderConfig, type RuntimeRequestOverrides, type Result } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';
import { readInvoiceCandidateChildReports } from '../../../packages/core/src/personal-agent/candidate-evidence.ts';
import type { SynchronousDatabaseExecutor } from '../../../packages/core/src/storage/write-coordinator.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }
async function observed(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Expected original native observation.')), 12_000); })]); }
  finally { clearTimeout(timer); }
}

test.each([
  ['supported conclusion', '113.00', '113.00'],
  ['valid source with a wrong child conclusion', '226.00', '113.00'],
  ['parent and child disagree about a valid source', '113.00', '226.00'],
] as const)('formal Personal Master delegates to a real read-only Durable child and records completion, feedback and model consumption separately: %s', async (scenario, childTotal, parentTotal) => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-native-child-'));
  const paths: ProductPaths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const report = `CHECKER_REPORT: Total ${childTotal} is supported by the original block; the invoice number remains missing.`;
  const parentReport = `MASTER_CONCLUSION: Total ${parentTotal}; the saved candidate requires human review.`;
  const parentPreferences = 'PARENT_PREFERENCES_SENTINEL', parentHistory = 'PARENT_PRIVATE_HISTORY_SENTINEL';
  const returned = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  deferCleanup(() => release.resolve());
  const wire: Array<{ child: boolean; body: { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> } }> = [];
  let document: DocumentSnapshot | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as typeof wire[number]['body'];
    const context = JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content) as InvoiceWorkWorkingContext;
    const child = context.delegation !== undefined; wire.push({ child, body });
    const ordinal = body.messages.filter(message => message.role === 'tool').length;
    let tool: { name: string; arguments: unknown } | null = null, text = '';
    if (context.userInputs.length > 0) {
      expect(context.modelReports).toEqual([]);
      text = 'The new clarification needs its own review; the old child report is historical.';
    } else if (child) {
      if (ordinal === 0) tool = { name: 'read_invoice_document', arguments: { documentId: document!.documentRef.id, page: 1, afterBlockId: null, limit: 10 } };
      else text = report;
    } else if (ordinal === 0) {
      text = parentHistory;
      tool = { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker', run_in_background: false,
        description: 'Independent source check for the current invoice', prompt: 'Verify the total against the current original invoice. Return source references and unresolved evidence.' } };
    } else if (ordinal === 1) {
      returned.resolve(); await release.promise;
      const candidate = invoiceWorkCandidateDraft();
      candidate.fields.totalAmount.raw = parentTotal; candidate.fields.totalAmount.normalized = parentTotal;
      candidate.fields.totalAmount.sources = [{ documentId: document!.documentRef.id, version: document!.documentRef.version,
        artifactId: document!.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' }];
      const feedback = JSON.parse(body.messages.find(message => message.role === 'tool')!.content);
      tool = { name: 'save_invoice_candidate', arguments: { documentId: document!.documentRef.id, candidate,
        childReportRefs: [{ childRunId: feedback.data.details.childRunId, fieldPath: 'fields.totalAmount',
          sourceRefs: candidate.fields.totalAmount.sources, inputIds: [] }] } };
    } else text = parentReport;
    const delta = tool ? { role: 'assistant', ...(text ? { content: text } : {}), tool_calls: [{ index: 0,
      id: 'actual-native-child-wire-' + wire.length, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: text };
    const chunk = { id: 'actual-native-child-response-' + wire.length, object: 'chat.completion.chunk', created: 1,
      model: 'personal-native-child-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const provider: ProviderConfig = { version: 1, name: 'personal-native-child-profile', revision: 1,
    modelRef: { provider: 'controlled-personal-native-child', model: 'personal-native-child-model' },
    native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.port + '/v1',
      contextWindow: 64000, maxTokens: 8192, reasoning: false }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: provider.name, thinkingLevel: 'off',
    tools: ['Agent', 'read_invoice_document', 'save_invoice_candidate'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: parentPreferences });
  const errors: string[] = []; let legacyModels = 0;
  const options: Parameters<typeof createApplication>[0] = { paths,
    logger: { write: event => { if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    provider: { prepare: async () => { legacyModels++; return fail(appError('unexpected_legacy_model', 'provider', 'A Durable child cannot use the legacy adapter.')); },
      close: async () => ({ stopped: true, closed: true, errors: [] }) },
    personalAgent: { defaultConfiguration: configuration, resolveConfiguration: () => ok(provider), readApiKey: () => 'controlled-native-child-key' } };
  let app = need(await createApplication(options)); deferCleanup(() => app.close());
  document = need(await app.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1',
    sample: 'personal-native-child', sourceText: 'Total 113.00', original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  const agent = need(await app.personalAgent.get()), created = need(await app.invoiceWorks.create({ personalAgentId: agent.personalAgentId,
    expectedAgentRevision: agent.revision, requestId: 'create-native-child', goal: 'Independently verify the current invoice and prepare a candidate.',
    documents: [document.documentRef] }));
  if (!('attempt' in created.execution) || !created.execution.attempt) throw Error('Expected the original admitted attempt.');
  const attemptId = created.execution.attempt.attemptId;
  try {
    await observed(returned.promise);
    const beforeResponse = need(await app.personalTasks.get({ workId: created.workId, attemptId }));
    expect(beforeResponse.task).toMatchObject({ runStatus: 'running', stoppedAt: null });
    expect(beforeResponse.children).toHaveLength(1);
    expect(beforeResponse.children[0]).toMatchObject({ runtimeKind: 'durable', role: 'invoice-evidence-checker',
      runStatus: 'completed', resultRecorded: true, stopConfirmed: true, parentModelReceivedAt: null,
      delivery: { state: 'message_observed' } });
    expect(wire.at(-1)!.body.messages.some(message => message.role === 'tool' && message.content.includes(report))).toBe(true);
    for (const parentRequest of wire.filter(entry => !entry.child)) {
      expect(parentRequest.body.messages.find(message => message.role === 'system')?.content).toContain(
        'Delegate only when specialist review, independent parallel work, or local context isolation offers a clear benefit; use tools directly for routine reading, arithmetic, and deterministic checks.');
      expect(parentRequest.body.tools?.find(tool => tool.function.name === 'Agent')?.function.description).toContain(
        'Delegate only when specialist review, independent parallel work, or local context isolation offers a clear benefit; use tools directly for routine reading, arithmetic, and deterministic checks.');
    }
    for (const childRequest of wire.filter(entry => entry.child)) {
      expect(JSON.stringify(childRequest.body)).not.toContain(parentPreferences);
      expect(JSON.stringify(childRequest.body)).not.toContain(parentHistory);
      expect(childRequest.body.tools?.map(tool => tool.function.name)).toEqual(['read_invoice_document']);
    }
  } finally { release.resolve(); }
  await waitFor(async () => need(await app.personalTasks.get({ workId: created.workId, attemptId })).task.stoppedAt !== null, 15_000);
  const final = need(await app.personalTasks.get({ workId: created.workId, attemptId }));
  expect(final.task.runStatus).toBe('completed'); expect(final.children[0]!.parentModelReceivedAt).not.toBeNull();
  const childRun = need(await app.queryRun(final.children[0]!.childRunId));
  expect(childRun).toMatchObject({ kind: 'subagent', runtimeKind: 'durable', status: 'completed' });
  if (childRun.kind !== 'subagent' || !('runtimeKind' in childRun) || childRun.runtimeKind !== 'durable' || childRun.sessionId === null)
    throw Error('Expected the original Durable child Session.');
  expect('pluginAgentId' in childRun).toBe(false);
  const view = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
  if (view.view !== 'work') throw Error('Expected original invoice Work.');
  expect(view.work).toMatchObject({ status: 'open', counts: { total: 1, unresolved: 1, accepted: 0, rejected: 0, excluded: 0 } });
  expect(view.items[0]!.disposition).toBe('unresolved'); expect(view.items[0]!.candidateRef).not.toBeNull(); expect(legacyModels).toBe(0);
  const candidate = need(await app.queryJobCandidate({ jobId: view.items[0]!.jobId!, candidateId: view.items[0]!.candidateRef!.id }));
  expect(candidate.candidate).toMatchObject({ status: 'generated', fields: { totalAmount: { raw: parentTotal, normalized: parentTotal } } });
  const childRead = wire.find(entry => entry.child && entry.body.messages.some(message => message.role === 'tool'))!;
  const read = invoiceToolSchemas.read_invoice_document.output.parse(z.object({ status: z.literal('succeeded'), data: z.unknown() })
    .parse(JSON.parse(childRead.body.messages.find(message => message.role === 'tool')!.content)).data);
  expect(read.blocks).toHaveLength(1); expect(read.blocks[0]!.text).toBe('Total 113.00');
  expect(read.blocks[0]!.source).toEqual(candidate.candidate.fields.totalAmount.sources[0]);
  expect(candidate.candidate.fields.totalAmount.sources).toHaveLength(1);
  expect(childRun.output).toMatchObject({ text: report });
  expect(need(await app.queryRun(final.task.attempt.runId!)).output).toMatchObject({ text: parentReport });
  expect(wire.filter(entry => entry.child)).toHaveLength(2); expect(wire.filter(entry => !entry.child)).toHaveLength(3);
  const requests = wire.length; need(await app.close()); app = need(await createApplication(options));
  expect(need(await app.personalTasks.get({ workId: created.workId, attemptId }))).toEqual(final);
  const rootHistory = need(await app.personalTasks.history({ target: { workId: created.workId }, limit: 100 }));
  const childHistory = need(await app.personalTasks.history({ target: { workId: created.workId, childRunId: childRun.runId }, limit: 100 }));
  expect(rootHistory.owner).toEqual({ runtimeKind: 'durable', workId: created.workId, sessionId: final.task.sessionId, childRunId: null });
  expect(childHistory.owner).toEqual({ runtimeKind: 'durable', workId: created.workId, sessionId: childRun.sessionId, childRunId: childRun.runId });
  expect(rootHistory.entries.length).toBeGreaterThan(0); expect(childHistory.entries.length).toBeGreaterThan(0);
  const entry = childHistory.entries[0]!;
  const detail = need(await app.personalTasks.historyEntry({ target: { workId: created.workId, childRunId: childRun.runId },
    throughEntryId: childHistory.throughEntryId, entryId: entry.entryId, limit: 100 }));
  expect(detail).toMatchObject({ owner: childHistory.owner, entryId: entry.entryId, format: 'pi-durable-entry/v1', totalBytes: entry.byteLength });
  const timeline = need(await app.invoiceWorks.timeline({ workId: created.workId, limit: 100 }));
  expect(timeline.semantics).toBe('live-facts');
  for (const kind of ['work_created', 'candidate_generated', 'child_result_recorded', 'child_result_returned', 'child_result_consumed'])
    expect(timeline.entries.some(fact => fact.kind === kind)).toBe(true);
  expect(timeline.entries.find(fact => fact.kind === 'child_result_consumed')).toMatchObject({
    refs: { childRunId: childRun.runId, originToolCallId: final.children[0]!.originToolCallId },
    evidence: { resultRecorded: true, returnedToParent: true, parentConsumed: true } });
  expect(timeline.entries.find(fact => fact.kind === 'candidate_generated')).toMatchObject({ refs: {
    candidateRef: view.items[0]!.candidateRef, childReportRefs: [{ childRunId: childRun.runId,
      fieldPath: 'fields.totalAmount', sourceRefs: candidate.candidate.fields.totalAmount.sources, inputIds: [] }] } });
  expect(wire).toHaveLength(requests); need(await app.close()); expect(errors).toEqual([]);
  const audit = new Database(paths.databaseFile, { readonly: true });
  try {
    const savedArguments = audit.query<{ args_json: string }, [number]>('SELECT args_json FROM tool_calls WHERE id=?')
      .get(candidate.candidate.toolCallId!)!;
    expect(JSON.parse(savedArguments.args_json).final).toMatchObject({ childReportRefs: [{ childRunId: childRun.runId,
      fieldPath: 'fields.totalAmount', sourceRefs: candidate.candidate.fields.totalAmount.sources, inputIds: [] }] });
    const original = invoiceToolSchemas.save_invoice_candidate.input.parse(JSON.parse(savedArguments.args_json).final);
    const refs = original.childReportRefs!;
    const owner = { workId: created.workId, itemId: view.items[0]!.itemId, attemptId,
      phaseId: childRun.scope.phaseId, runId: childRun.parentRunId };
    const reports = need(readInvoiceCandidateChildReports(audit, owner, refs, original.candidate, view.items[0]!.candidateRef));
    expect(reports[0]).toMatchObject({ child: { childRunId: childRun.runId, originToolCallId: childRun.originToolCallId,
      parentModelReceivedAt: final.children[0]!.parentModelReceivedAt }, fieldPath: 'fields.totalAmount', summary: report,
      candidateRef: view.items[0]!.candidateRef, sourceRefs: [{ documentId: document!.documentRef.id, blockId: 'b1' }] });
    for (const changed of [
      [{ ...refs[0]!, childRunId: childRun.runId + 1 }],
      [{ ...refs[0]!, fieldPath: 'fields.taxAmount' }],
      [{ ...refs[0]!, inputIds: [999] }],
      [{ ...refs[0]!, sourceRefs: [{ ...refs[0]!.sourceRefs[0]!, version: 'unread-version' }] }],
      [refs[0]!, refs[0]!],
    ]) expect(readInvoiceCandidateChildReports(audit, owner, changed, original.candidate, view.items[0]!.candidateRef))
      .toMatchObject({ ok: false, error: { code: 'source_invalid' } });
    // Isolated parent-snapshot copy; the completed child and every other query retain their real SQLite facts.
    const contextSql = 'SELECT context_json FROM invoice_work_context_snapshots WHERE phase_id=? AND work_id=? AND attempt_id=? AND item_id=?';
    const originalContext = audit.query<{ context_json: string }, [number, number, number, number]>(contextSql)
      .get(owner.phaseId, owner.workId, owner.attemptId, owner.itemId);
    if (!originalContext) throw Error('Expected the original parent phase snapshot.');
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(originalContext.context_json));
    const hiddenHistory = 'HISTORICAL_TEXT_NOT_DELIVERED_TO_THIS_CHILD';
    const isolatedContext = InvoiceWorkWorkingContextSchema.parse({ ...context, historicalInputReferences: [
      ...context.historicalInputReferences, { provenance: 'historical-user-input-reference', inputId: 999,
        requestId: 'isolated-parent-history', todoId: 999, phaseId: owner.phaseId + 1, attemptId,
        consumedAt: context.item.updatedAt, content: { provenance: 'user-provided', text: hiddenHistory, documentRefs: [] } }] });
    expect(JSON.stringify(wire.filter(entry => entry.child))).not.toContain(hiddenHistory);
    const isolatedParent: SynchronousDatabaseExecutor = {
      get inTransaction() { return audit.inTransaction; },
      exec() { throw Error('The isolated report check is read-only.'); },
      transaction() { throw Error('The isolated report check is read-only.'); },
      query<Row extends object, Bindings extends SQLQueryBindings | SQLQueryBindings[]>(sql: string) {
        const statement = audit.query<Row, Bindings>(sql);
        return {
          get(...parameters: Parameters<typeof statement.get>) {
            const row = statement.get(...parameters);
            return sql === contextSql && row !== null ? Object.assign(row, { context_json: JSON.stringify(isolatedContext) }) : row;
          },
          all(...parameters: Parameters<typeof statement.all>) { return statement.all(...parameters); },
          run(...parameters: Parameters<typeof statement.run>) { return statement.run(...parameters); },
        };
      },
    };
    expect(readInvoiceCandidateChildReports(isolatedParent, owner, [{ ...refs[0]!, sourceRefs: [], inputIds: [999] }],
      original.candidate, view.items[0]!.candidateRef)).toMatchObject({ ok: false, error: { code: 'source_invalid' } });
    expect(audit.query('SELECT kind,status FROM runs ORDER BY id').all()).toEqual([{ kind: 'agent', status: 'completed' }, { kind: 'subagent', status: 'completed' }]);
    expect(audit.query('SELECT count(*) count FROM session_inputs').get()).toEqual({ count: 0 });
    expect(audit.query("SELECT count(*) count FROM sessions WHERE runtime_kind='durable'").get()).toEqual({ count: 2 });
    expect(audit.query('SELECT sum(count) count FROM invoice_work_model_reservations').get()).toEqual({ count: 5 });
    expect(audit.query('SELECT count(*) count FROM tool_calls').get()).toEqual({ count: 3 });
    expect(audit.query('SELECT count(*) count FROM invoice_work_tool_calls WHERE parent_received_model_task_id IS NOT NULL AND parent_received_at IS NOT NULL').get())
      .toEqual({ count: 1 });
  } finally { audit.close(); }
  app = need(await createApplication(options));
  if (scenario !== 'supported conclusion') {
    const current = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
    if (current.view !== 'work') throw Error('Expected the original unresolved invoice.');
    expect(current.work).toMatchObject({ status: 'open', counts: { unresolved: 1, accepted: 0 } });
    expect(current.items[0]!.candidateRef).toEqual(view.items[0]!.candidateRef);
    const disposed = need(await app.invoiceWorks.disposeItem({ workId: created.workId, itemId: current.items[0]!.itemId,
      requestId: 'explicit-human-rejection', expectedRevision: current.work.revision,
      decision: { kind: 'rejected', reason: 'The human explicitly ends processing after reviewing the original source and conflicting model conclusions.' } }));
    const ended = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
    expect(ended.work).toMatchObject({ status: 'completed', counts: { unresolved: 0, accepted: 0, rejected: 1 } });
    expect(need(await app.invoiceWorks.queryOperation({ operation: 'disposeItem', workId: created.workId,
      requestId: 'explicit-human-rejection' }))).toEqual(disposed);
    expect(need(await app.queryJobCandidate({ jobId: view.items[0]!.jobId!, candidateId: view.items[0]!.candidateRef!.id })).candidate)
      .toMatchObject({ candidateId: candidate.candidate.candidateId, status: 'generated' });
    expect(need(await app.personalTasks.get({ workId: created.workId, attemptId })).children).toEqual(final.children);
    expect(need(await app.invoiceWorks.timeline({ workId: created.workId, limit: 100 })).entries
      .find(fact => fact.kind === 'candidate_generated')?.refs.childReportRefs)
      .toEqual(timeline.entries.find(fact => fact.kind === 'candidate_generated')?.refs.childReportRefs);
    expect(wire).toHaveLength(requests); need(await app.close()); return;
  }
  const currentItem = need(await app.invoiceWorks.get({ view: 'item', workId: created.workId, itemId: view.items[0]!.itemId }));
  if (currentItem.view !== 'item') throw Error('Expected the original invoice and current Todo.');
  const todo = currentItem.todos.find(value => value.applicable && value.action === 'supplement');
  if (!todo) throw Error('Expected the original missing-field clarification.');
  const supplemented = need(await app.invoiceWorks.supplement({ workId: created.workId, itemId: currentItem.item.itemId,
    todoId: todo.todoId, requestId: 'clarify-after-child-report', expectedRevision: currentItem.item.revision,
    text: 'The invoice number requires a fresh check; retain the old candidate as history.', materials: [] }));
  if (!supplemented.execution.authorizationAccepted) throw Error('Expected the authorized new input to continue automatically.');
  const nextAttemptId = supplemented.execution.attempt.attemptId;
  expect(nextAttemptId).not.toBe(attemptId);
  await waitFor(async () => need(await app.personalTasks.get({ workId: created.workId, attemptId: nextAttemptId })).task.stoppedAt !== null, 15_000);
  expect(wire).toHaveLength(requests + 1);
  const nextContext = JSON.parse(wire.at(-1)!.body.messages.filter(message => message.role === 'user').at(-1)!.content) as InvoiceWorkWorkingContext;
  expect(nextContext.userInputs).toHaveLength(1); expect(nextContext.modelReports).toEqual([]);
  expect(need(await app.personalTasks.get({ workId: created.workId, attemptId })).children[0]).toEqual(final.children[0]);
  const oldEvidence = need(await app.invoiceWorks.timeline({ workId: created.workId, limit: 100 }));
  expect(oldEvidence.entries.find(fact => fact.kind === 'candidate_generated')?.refs.childReportRefs)
    .toEqual(timeline.entries.find(fact => fact.kind === 'candidate_generated')?.refs.childReportRefs);
  need(await app.close());
}, 35_000);

test('a rejected product tool schema returns a safe initialization error and releases the original data owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-schema-failure-'));
  const paths: ProductPaths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const options: Parameters<typeof createApplication>[0] = { paths,
    personalAgent: { resolveConfiguration: () => fail(appError('model_not_configured', 'input', 'No model selected.')), readApiKey: () => undefined } };
  const invalid = await createApplication({ ...options, toolDefinitions: definitions => definitions.map(tool =>
    tool.name === 'read_invoice_document' ? { ...tool, inputSchema: z.object({ unsupported: z.number().default(1) }).strict() } : tool) });
  expect(invalid).toMatchObject({ ok: false, error: { code: 'personal_agent_initialization_failed' } });
  expect(JSON.stringify(invalid)).not.toContain('tool_schema_unsupported');
  const app = need(await createApplication(options));
  try { expect(need(await app.personalAgent.get()).runtimeKind).toBe('durable'); }
  finally { need(await app.close()); }
}, 15_000);

async function interruptedChildFixture(parallel = false, runtimeDefaults?: () => Result<RuntimeRequestOverrides>) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-child-interruption-'));
  const paths: ProductPaths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const requests: Array<{ child: boolean; key: string | null; text: string }> = [];
  const errors: string[] = []; let childRequests = 0, key = 'controlled-before-interruption';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as InvoiceWorkWorkingContext;
    const child = context.delegation !== undefined, hasToolResult = body.messages.some(message => message.role === 'tool');
    requests.push({ child, key: request.headers.get('authorization'), text: JSON.stringify(body) });
    if (child && !hasToolResult) {
      childRequests++;
      if (parallel) { if (childRequests === 2) entered.resolve(); await release.promise; }
      else if (childRequests === 1) { entered.resolve(); await release.promise; }
    }
    const delegate = !child && body.messages.every(message => message.role !== 'tool');
    const slowRead = parallel && child && !hasToolResult && context.delegation!.description === 'Slow independent check';
    const call = (index: number, description: string) => ({ index, id: 'interrupted-original-agent-' + index, type: 'function',
      function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'invoice-evidence-checker', run_in_background: false,
        description, prompt: 'Return a bounded evidence report for this invoice.' }) } });
    let delta: Record<string, unknown>;
    if (delegate) {
      const toolCalls = parallel ? [call(0, 'Fast independent check'), call(1, 'Slow independent check')]
        : [call(0, 'Check the original evidence independently')];
      delta = { role: 'assistant', tool_calls: toolCalls };
    } else if (slowRead) {
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'slow-child-source-read', type: 'function',
        function: { name: 'read_invoice_document', arguments: JSON.stringify({ documentId: context.item.documentRef.id, page: 1, afterBlockId: null, limit: 10 }) } }] };
    } else {
      let content = 'The original child report needs human review.';
      if (child) content = 'The original child evidence report is complete.';
      if (child && parallel) content = context.delegation!.description === 'Fast independent check' ? 'PARALLEL_FAST_REPORT' : 'PARALLEL_SLOW_REPORT';
      delta = { role: 'assistant', content };
    }
    const chunk = { id: 'interruption-response-' + requests.length, object: 'chat.completion.chunk', created: 1,
      model: 'interruption-model', choices: [{ index: 0, delta, finish_reason: delegate || slowRead ? 'tool_calls' : 'stop' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true)); deferCleanup(() => release.resolve());
  const provider: ProviderConfig = { version: 1, name: 'child-interruption', revision: 1,
    modelRef: { provider: 'controlled-child-interruption', model: 'interruption-model' },
    native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.port + '/v1', contextWindow: 64000, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: provider.name, thinkingLevel: 'off',
    tools: ['Agent', 'read_invoice_document'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const options: Parameters<typeof createApplication>[0] = { paths, runtimeDefaults,
    logger: { write: event => { if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    personalAgent: { defaultConfiguration: configuration, resolveConfiguration: () => ok(provider), readApiKey: () => key } };
  let app = need(await createApplication(options)); deferCleanup(() => app.close());
  const document = need(await app.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1',
    sample: 'controlled-child-interruption', sourceText: 'Total 113.00',
    original: { name: 'source.md', base64: Buffer.from('Total 113.00').toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00', sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  const agent = need(await app.personalAgent.get()), work = need(await app.invoiceWorks.create({ personalAgentId: agent.personalAgentId,
    expectedAgentRevision: agent.revision, requestId: 'original-interrupted-child-work', goal: 'Maintain the original independent evidence check.',
    documents: [document.documentRef] }));
  if (!('attempt' in work.execution) || !work.execution.attempt) throw Error('Expected the original accepted attempt.');
  const attemptId = work.execution.attempt.attemptId;
  await observed(entered.promise);
  return { get app() { return app; }, paths, work, attemptId, requests, release, errors,
    async restart() { key = 'controlled-after-interruption'; app = need(await createApplication(options)); } };
}

test('explicit Work model limits are shared by the real parent and child and refuse the next transport', async () => {
  const f = await interruptedChildFixture(false, () => ok({ budget: { maxModelCalls: 2 }, timeoutMs: 60000 }));
  try {
    f.release.resolve();
    await waitFor(async () => need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId })).task.stoppedAt !== null, 15000);
    const task = need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId }));
    expect(task.task.runStatus).toBe('failed'); expect(task.children).toHaveLength(1);
    expect(task.children[0]!.runStatus).toBe('completed');
    expect(f.requests.filter(request => request.child)).toHaveLength(1);
    expect(f.requests.filter(request => !request.child)).toHaveLength(1);
    const root = need(await f.app.queryRun(task.task.attempt.runId!));
    expect(root.config).toMatchObject({ runtimeBudget: { maxModelCalls: 2 } });
    const child = need(await f.app.queryRun(task.children[0]!.childRunId));
    expect(child.config).toMatchObject({ runtimeBudget: { maxModelCalls: 2 } });
  } finally { f.release.resolve(); }
}, 25000);

test('formal root stop reaches its in-flight native child and reopening cannot remove the explicit-continue gate', async () => {
  const f = await interruptedChildFixture();
  const current = need(await f.app.invoiceWorks.get({ view: 'work', workId: f.work.workId }));
  const stop = need(await f.app.personalTasks.stop({ workId: f.work.workId, attemptId: f.attemptId,
    requestId: 'stop-original-native-child', expectedRevision: current.work.revision }));
  expect(stop.accepted).toBe(true);
  try {
    await waitFor(async () => need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId })).task.stoppedAt !== null, 15_000);
    const closed = need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId }));
    expect(closed.task).toMatchObject({ runStatus: 'cancelled', stoppedAt: expect.any(String) });
    expect(closed.children).toHaveLength(1); expect(closed.children[0]!.stopConfirmed).toBe(true);
    const work = need(await f.app.invoiceWorks.get({ view: 'work', workId: f.work.workId }));
    expect(work.work).toMatchObject({ status: 'open', execution: { requiresContinue: true, stopUnconfirmed: false } });
    const count = f.requests.length; need(await f.app.close()); f.release.resolve(); await f.restart();
    expect(need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId }))).toEqual(closed);
    expect(f.requests).toHaveLength(count);
  } finally { f.release.resolve(); need(await f.app.close()); }
}, 35_000);

test('a completed parallel delegation does not invalidate another child still reading evidence and requesting its next model', async () => {
  const f = await interruptedChildFixture(true);
  try {
    f.release.resolve();
    await waitFor(async () => need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId })).task.stoppedAt !== null, 15_000);
    const final = need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId }));
    expect(final.task.runStatus).toBe('completed');
    expect(final.children).toHaveLength(2);
    expect(final.children.map(child => child.runStatus)).toEqual(['completed', 'completed']);
    expect(final.children.every(child => child.parentModelReceivedAt !== null)).toBe(true);
    expect(f.requests.filter(request => request.child)).toHaveLength(3);
    expect(f.requests.at(-1)!.text).toContain('PARALLEL_FAST_REPORT');
    expect(f.requests.at(-1)!.text).toContain('PARALLEL_SLOW_REPORT');
    expect(f.errors).toEqual([]);
  } finally { f.release.resolve(); need(await f.app.close()); }
}, 35_000);

test('formal service interruption preserves the running child and original Agent receipt for same-identity recovery', async () => {
  const f = await interruptedChildFixture(), original = need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId }));
  expect(original.children).toHaveLength(1);
  expect(original.children[0]).toMatchObject({ runStatus: 'running', resultRecorded: false, stopConfirmed: false });
  need(await f.app.close());
  const paused = new Database(f.paths.databaseFile, { readonly: true });
  let originalConversation: Array<{ id: number; durable_conversation_id: number | null }>;
  try {
    expect(paused.query('SELECT kind,status,cancel_requested_at,stopped_at FROM runs ORDER BY id').all()).toEqual([
      { kind: 'agent', status: 'running', cancel_requested_at: null, stopped_at: null },
      { kind: 'subagent', status: 'running', cancel_requested_at: null, stopped_at: null },
    ]);
    expect(paused.query("SELECT status,result_json FROM tool_calls WHERE tool_name='Agent'").get()).toEqual({ status: 'running', result_json: null });
    originalConversation = paused.query<{ id: number; durable_conversation_id: number | null }, []>(
      'SELECT id,durable_conversation_id FROM sessions ORDER BY id').all();
  } finally { paused.close(); f.release.resolve(); }
  await f.restart();
  await waitFor(async () => need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId })).task.stoppedAt !== null, 15_000);
  const final = need(await f.app.personalTasks.get({ workId: f.work.workId, attemptId: f.attemptId }));
  expect(final.task).toMatchObject({ runStatus: 'completed', stopRequestedAt: null });
  expect(final.children[0]).toMatchObject({ childRunId: original.children[0]!.childRunId,
    originToolCallId: original.children[0]!.originToolCallId, runStatus: 'completed', stopConfirmed: true });
  expect(final.children[0]!.parentModelReceivedAt).not.toBeNull();
  expect(f.requests.filter(request => request.child)).toHaveLength(2);
  expect(f.requests.filter(request => !request.child)).toHaveLength(2);
  expect(f.requests.at(-1)!.key).toBe('Bearer controlled-after-interruption');
  need(await f.app.close());
  const recovered = new Database(f.paths.databaseFile, { readonly: true });
  try {
    expect(recovered.query<{ id: number; durable_conversation_id: number | null }, []>(
      'SELECT id,durable_conversation_id FROM sessions ORDER BY id').all()).toEqual(originalConversation);
    expect(recovered.query('SELECT count(*) count FROM runs').get()).toEqual({ count: 2 });
    expect(recovered.query("SELECT count(*) count FROM tool_calls WHERE tool_name='Agent'").get()).toEqual({ count: 1 });
    expect(recovered.query('SELECT sum(count) count FROM invoice_work_model_reservations').get()).toEqual({ count: 4 });
    expect(recovered.query('SELECT count(*) count FROM session_inputs').get()).toEqual({ count: 0 });
  } finally { recovered.close(); }
  expect(f.errors).toEqual([]);
}, 35_000);
