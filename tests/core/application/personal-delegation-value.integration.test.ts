import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createApplication } from '../../../apps/composition.ts';
import { appError, fail, ok, DurableRunScopeSchema, DurableSubagentRunScopeSchema, InvoiceWorkWorkingContextSchema, PersonalAgentConfigurationSchema,
  SourceRefSchema, ToolCallSnapshotSchema, invoiceToolSchemas,
  type DocumentSnapshot, type ProviderConfig, type Result, type SourceRef } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';
import { readInvoiceCandidateChildReports } from '../../../packages/core/src/personal-agent/candidate-evidence.ts';
import { checkSource } from '../../../packages/employee-invoice/src/tools/check_invoice_sources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }
const goal = 'Verify the original invoice total and prepare its candidate for explicit human acceptance.';
const sourceText = 'Invoice INV-DELEGATION; Date 2026-10-29; Seller Original Seller; Buyer Original Buyer; Currency CNY; Net 100.00; Tax 13.00; Total 113.00';
const unreadText = 'UNREAD_PARENT_BLOCK: alternative amount 999.00';
const materialText = sourceText + '\n' + unreadText;
type Wire = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
const reportSchema = z.object({ fieldPath: z.literal('fields.totalAmount'), value: z.literal('113.00'), source: SourceRefSchema }).strict();
const toolSuccess = z.object({ status: z.literal('succeeded'), data: z.unknown() });

function candidateFrom(source: SourceRef) {
  const candidate = invoiceWorkCandidateDraft();
  for (const [name, value] of Object.entries({ invoiceNumber: 'INV-DELEGATION', issueDate: '2026-10-29', sellerName: 'Original Seller',
    buyerName: 'Original Buyer', currency: 'CNY', netAmount: '100.00', taxAmount: '13.00', totalAmount: '113.00' }))
    candidate.fields[name as keyof typeof candidate.fields] = { raw: value, normalized: value, state: 'present', alternatives: [],
      sources: [{ ...source, quote: value }] };
  return candidate;
}

async function scenario(mode: 'direct' | 'delegated') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-delegation-value-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  let document: DocumentSnapshot | undefined, legacyRequests = 0;
  const errors: string[] = [], requests: Array<{ child: boolean; body: Wire }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer controlled-delegation-value-' + mode);
    const body = await request.json() as Wire;
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content));
    const child = context.delegation !== undefined;
    requests.push({ child, body });
    expect(context.item.documentRef).toEqual(document!.documentRef); expect(context.work.goal).toBe(goal);
    const replies = body.messages.filter(message => message.role === 'tool');
    let tool: { name: string; arguments: unknown } | null = null, text = '';
    if (replies.length === 0) {
      if (mode === 'delegated' && !child) tool = { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker', run_in_background: false,
        description: 'Bounded independent review of the original total source',
        prompt: 'Read this invoice and verify the total against its original block. Return the field, observed value and exact original SourceRef; report any gap.' } };
      else tool = { name: 'read_invoice_document', arguments: { documentId: document!.documentRef.id, page: 1, afterBlockId: null, limit: 1 } };
    } else if (child) {
      const read = invoiceToolSchemas.read_invoice_document.output.parse(toolSuccess.parse(JSON.parse(replies[0]!.content)).data);
      expect(read.blocks).toHaveLength(1); expect(read.blocks[0]!.text).toBe(sourceText);
      text = JSON.stringify({ fieldPath: 'fields.totalAmount', value: '113.00', source: read.blocks[0]!.source });
    } else if (replies.length === 1) {
      let source: SourceRef;
      let childReportRefs: Array<{ childRunId: number; fieldPath: 'fields.totalAmount'; sourceRefs: SourceRef[]; inputIds: number[] }> | undefined;
      if (mode === 'delegated') {
        const returned = z.object({ details: z.object({ childRunId: z.number().int().positive(), text: z.string() }).passthrough() }).passthrough()
          .parse(toolSuccess.parse(JSON.parse(replies[0]!.content)).data);
        const report = reportSchema.parse(JSON.parse(returned.details.text)); source = report.source;
        childReportRefs = [{ childRunId: returned.details.childRunId, fieldPath: report.fieldPath,
          sourceRefs: [{ ...source, quote: report.value }], inputIds: [] }];
      } else {
        const read = invoiceToolSchemas.read_invoice_document.output.parse(toolSuccess.parse(JSON.parse(replies[0]!.content)).data);
        expect(read.blocks[0]!.text).toBe(sourceText); source = read.blocks[0]!.source;
      }
      tool = { name: 'save_invoice_candidate', arguments: { documentId: document!.documentRef.id, candidate: candidateFrom(source),
        ...(childReportRefs ? { childReportRefs } : {}) } };
    } else text = 'The original candidate is saved and still requires explicit human acceptance.';
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'delegation-value-wire-' + requests.length,
      type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: text };
    return new Response('data: ' + JSON.stringify({ id: 'delegation-value-response-' + requests.length, object: 'chat.completion.chunk', created: 1,
      model: 'delegation-value-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const provider: ProviderConfig = { version: 1, name: 'delegation-value-profile', revision: 1,
    modelRef: { provider: 'controlled-delegation-value', model: 'delegation-value-model' },
    native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.port + '/v1', contextWindow: 64000, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: provider.name, thinkingLevel: 'off',
    tools: ['Agent', 'read_invoice_document', 'save_invoice_candidate'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const options: Parameters<typeof createApplication>[0] = { paths,
    runtimeDefaults: () => ok({ budget: { maxModelCalls: 12, maxToolCalls: 24 }, timeoutMs: 60000 }),
    logger: { write: event => { if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    provider: { prepare: async () => { legacyRequests++; return fail(appError('unexpected_legacy_model', 'provider', 'The comparison uses only Personal Durable.')); },
      close: async () => ({ stopped: true, closed: true, errors: [] }) },
    personalAgent: { defaultConfiguration: configuration, resolveConfiguration: () => ok(provider), readApiKey: () => 'controlled-delegation-value-' + mode } };
  let app = need(await createApplication(options)); deferCleanup(() => app.close());
  const pages = [{ page: 1, blocks: [
    { id: 'b1', kind: 'text' as const, text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null },
    { id: 'b2', kind: 'text' as const, text: unreadText, sourceIndex: 1, sourceType: 'prepared-text', bbox: null },
  ] }];
  document = need(await app.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample: 'delegation-value-controlled', sourceText: materialText,
    original: { name: 'source.md', base64: Buffer.from(materialText).toString('base64') }, pages }));
  const agent = need(await app.personalAgent.get()), startedAt = performance.now();
  const created = need(await app.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
    requestId: 'same-delegation-value-create', goal, documents: [document.documentRef] }));
  if (!('attempt' in created.execution) || !created.execution.attempt) throw Error('Expected one authorized original attempt.');
  const attemptId = created.execution.attempt.attemptId;
  await waitFor(async () => need(await app.personalTasks.get({ workId: created.workId, attemptId })).task.stoppedAt !== null, 20000);
  const observedElapsedMs = performance.now() - startedAt;
  const task = need(await app.personalTasks.get({ workId: created.workId, attemptId }));
  expect(task.task).toMatchObject({ runStatus: 'completed', stoppedAt: expect.any(String) });
  const runId = task.task.attempt.runId; if (runId === null) throw Error('Expected the original product Run.');
  const run = need(await app.queryRun(runId)), scope = DurableRunScopeSchema.parse(run.scope);
  expect(run).toMatchObject({ kind: 'agent', runtimeKind: 'durable', status: 'completed' });
  expect(scope).toMatchObject({ workId: created.workId, attemptId });
  expect([...scope.allowedTools].sort()).toEqual([...configuration.tools].sort());
  const rootCalls = need(await app.listRunToolCalls({ runId, sessionId: created.sessionId, limit: 10 })).items;
  const expectedRootTools = mode === 'direct' ? ['read_invoice_document', 'save_invoice_candidate'] : ['Agent', 'save_invoice_candidate'];
  expect(rootCalls.map(call => call.toolName).sort()).toEqual(expectedRootTools.sort());
  const save = rootCalls.find(call => call.toolName === 'save_invoice_candidate')!;
  const evidence = need(await app.queryRunToolEvidence({ runId, sessionId: created.sessionId, toolCallId: save.toolCallId, limit: 32768 }));
  expect(evidence.nextOffset).toBeNull();
  const savedCall = ToolCallSnapshotSchema.parse(JSON.parse(evidence.chunk));
  expect(savedCall.result).toMatchObject({ status: 'succeeded' });
  expect(rootCalls.every(call => call.status === 'succeeded')).toBe(true);
  const view = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
  if (view.view !== 'work' || view.items.length !== 1 || view.items[0]!.jobId === null || view.items[0]!.candidateRef === null)
    throw Error('Expected the original one-invoice candidate and Job.');
  const item = view.items[0]!, jobId = item.jobId!, candidateRef = item.candidateRef!;
  expect(view.work).toMatchObject({ goal, status: 'open', counts: { total: 1, unresolved: 1, accepted: 0 } });
  const candidates = need(await app.listJobCandidates({ jobId })).items;
  expect(candidates).toHaveLength(1); expect(candidates[0]).toMatchObject({ runId, status: 'generated' });
  const candidate = need(await app.queryJobCandidate({ jobId, candidateId: candidateRef.id }));
  expect(candidate.candidate.fields.totalAmount.normalized).toBe('113.00');
  const savedInput = invoiceToolSchemas.save_invoice_candidate.input.parse(savedCall.args.final);
  expect(savedCall.result).toMatchObject({ status: 'succeeded', committedCandidateId: candidateRef.id });
  const source = savedInput.candidate.fields.totalAmount.sources[0]!;
  expect(source).toEqual({ documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId,
    page: 1, blockId: 'b1', quote: '113.00' });
  expect(savedInput.candidate.fields.totalAmount.sources).toHaveLength(1);
  const childTimings: Array<{ runId: number; elapsedMs: number | null }> = [];
  if (mode === 'delegated') {
    expect(task.children).toHaveLength(1);
    const child = task.children[0]!;
    expect(child).toMatchObject({ runStatus: 'completed', resultRecorded: true, stopConfirmed: true,
      parentModelReceivedAt: expect.any(String), delivery: { state: 'message_observed' } });
    expect(child.originToolCallId).toBe(rootCalls.find(call => call.toolName === 'Agent')!.toolCallId);
    const childRun = need(await app.queryRun(child.childRunId));
    expect(childRun).toMatchObject({ kind: 'subagent', runtimeKind: 'durable', parentRunId: runId, status: 'completed' });
    if (childRun.sessionId === null) throw Error('Expected the real owned child Session.');
    expect(childRun.sessionId).not.toBe(created.sessionId);
    const childCalls = need(await app.listRunToolCalls({ runId: child.childRunId, sessionId: childRun.sessionId, limit: 10 })).items;
    expect(childCalls.map(call => [call.toolName, call.status])).toEqual([['read_invoice_document', 'succeeded']]);
    expect(requests.filter(value => value.child).every(value => value.body.tools?.map(tool => tool.function.name).join(',') === 'read_invoice_document')).toBe(true);
    expect(savedInput.childReportRefs).toEqual([{ childRunId: child.childRunId, fieldPath: 'fields.totalAmount', sourceRefs: [source], inputIds: [] }]);
    const parentRequest = requests.filter(value => !value.child)[1]!;
    const returned = z.object({ details: z.object({ text: z.string() }).passthrough() }).passthrough()
      .parse(toolSuccess.parse(JSON.parse(parentRequest.body.messages.find(message => message.role === 'tool')!.content)).data);
    expect(reportSchema.parse(JSON.parse(returned.details.text))).toEqual({ fieldPath: 'fields.totalAmount', value: '113.00',
      source: { ...source, quote: sourceText } });
    const timeline = need(await app.invoiceWorks.timeline({ workId: created.workId, limit: 100 }));
    expect(timeline.entries.find(entry => entry.kind === 'candidate_generated')?.refs.childReportRefs).toEqual(savedInput.childReportRefs);
    childTimings.push({ runId: childRun.runId, elapsedMs: childRun.startedAt && childRun.endedAt
      ? Date.parse(childRun.endedAt) - Date.parse(childRun.startedAt) : null });
  } else { expect(task.children).toHaveLength(0); expect(savedInput.childReportRefs ?? []).toHaveLength(0); }
  expect(requests.filter(value => !value.child)).toHaveLength(3);
  expect(requests.filter(value => value.child)).toHaveLength(mode === 'delegated' ? 2 : 0);
  const requestsBeforeRead = requests.length;
  need(await app.close()); app = need(await createApplication(options));
  expect(need(await app.personalTasks.get({ workId: created.workId, attemptId }))).toEqual(task);
  expect(need(await app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: created.personalAgentId, requestId: created.requestId }))).toEqual(created);
  expect(need(await app.listJobCandidates({ jobId })).items).toEqual(candidates);
  expect(requests).toHaveLength(requestsBeforeRead);
  need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'document', documentId: document.documentRef.id } }));
  need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'job', jobId } }));
  const workspace = need(await app.readWorkspace());
  const selected = need(await app.selectCandidate({ jobId, candidateId: candidateRef.id,
    expectedCandidateId: workspace.candidateRef?.id ?? null, expectedRevision: workspace.revision }));
  const acceptRequest = { operationRef: 'same-delegation-value-accept', jobId, candidateId: candidateRef.id,
    expectedCandidateId: candidateRef.id, expectedRevision: selected.workspace.revision, dirty: false as const };
  expect(need(await app.acceptInvoiceCandidate(acceptRequest)).candidate.status).toBe('accepted');
  const beforeDisposition = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
  expect(beforeDisposition.work).toMatchObject({ status: 'open', counts: { accepted: 0, unresolved: 1 } });
  const disposition = { workId: created.workId, itemId: item.itemId, requestId: 'same-delegation-value-dispose',
    expectedRevision: beforeDisposition.work.revision, decision: { kind: 'accepted' as const, candidateRef, acceptRequest } };
  const disposed = need(await app.invoiceWorks.disposeItem(disposition));
  expect(need(await app.invoiceWorks.disposeItem(disposition))).toEqual(disposed);
  expect(need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }))).toMatchObject({ work: { status: 'completed', counts: { accepted: 1, unresolved: 0 } } });
  expect(requests).toHaveLength(requestsBeforeRead); expect(legacyRequests).toBe(0); expect(errors).toEqual([]);
  need(await app.close());
  const database = new Database(paths.databaseFile, { readonly: true });
  let budget: unknown;
  let productRuns = 0, toolCalls = 0;
  try {
    const expectedRuns = [{ kind: 'agent', status: 'completed' }];
    if (mode === 'delegated') expectedRuns.push({ kind: 'subagent', status: 'completed' });
    const runs = database.query('SELECT kind,status FROM runs ORDER BY id').all();
    expect(runs).toEqual(expectedRuns); productRuns = runs.length;
    expect(database.query('SELECT COUNT(*) count FROM invoice_candidates').get()).toEqual({ count: 1 });
    toolCalls = database.query<{ count: number }, []>('SELECT COUNT(*) count FROM tool_calls').get()!.count;
    expect(toolCalls).toBe(mode === 'direct' ? 2 : 3);
    expect(database.query('SELECT COUNT(*) count FROM invoice_work_tool_calls WHERE feedback_native_entry_id IS NULL OR feedback_bytes IS NULL').get()).toEqual({ count: 0 });
    expect(database.query('SELECT SUM(count) count FROM invoice_work_model_reservations').get()).toEqual({ count: requests.length });
    if (mode === 'delegated') {
      const childScope = DurableSubagentRunScopeSchema.parse(JSON.parse(database.query<{ scope_json: string }, [number]>(
        'SELECT scope_json FROM runs WHERE id=?').get(task.children[0]!.childRunId)!.scope_json));
      const owner = { workId: created.workId, itemId: item.itemId, attemptId, phaseId: childScope.phaseId, runId };
      expect(need(readInvoiceCandidateChildReports(database, owner, savedInput.childReportRefs!, savedInput.candidate, candidateRef))).toHaveLength(1);
      const unread = { ...source, blockId: 'b2', quote: '999.00' };
      expect(checkSource(unread, document, { formatVersion: 2, pages, completeness: { status: 'complete', checks: [], warnings: [] } }))
        .toEqual({ status: 'valid', code: 'parsed_quote_matched' });
      expect(readInvoiceCandidateChildReports(database, owner, [{ ...savedInput.childReportRefs![0]!, sourceRefs: [unread] }],
        { ...savedInput.candidate, fields: { ...savedInput.candidate.fields, totalAmount: { ...savedInput.candidate.fields.totalAmount, sources: [unread] } } }, candidateRef))
        .toMatchObject({ ok: false, error: { code: 'source_invalid' } });
    }
    budget = JSON.parse(database.query<{ budget_json: string }, [number]>('SELECT budget_json FROM invoice_works WHERE id=?').get(created.workId)!.budget_json);
  } finally { database.close(); }
  return { mode, root, sourceText: materialText, goal, authorization: agent.configuration, budget, candidateTotal: candidate.candidate.fields.totalAmount.normalized,
    original: { workId: created.workId, itemId: item.itemId, attemptId, runId, candidateRef,
      rootToolCalls: rootCalls.map(call => ({ toolCallId: call.toolCallId, name: call.toolName, status: call.status })), childReportRefs: savedInput.childReportRefs ?? [] },
    productRuns, toolCalls,
    modelHttp: { root: requests.filter(value => !value.child).length, child: requests.filter(value => value.child).length, total: requests.length },
    timing: { observedElapsedMs, rootRunMs: run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null, children: childTimings },
    billedCost: null, humanTimeMs: null, semanticQuality: null };
}

test('the same authorized invoice goal preserves original evidence and explicit disposition through direct tools and a bounded real child delegation', async () => {
  const direct = await scenario('direct'), delegated = await scenario('delegated');
  expect(direct.root).not.toBe(delegated.root);
  expect(delegated.sourceText).toBe(direct.sourceText); expect(delegated.goal).toBe(direct.goal);
  expect(delegated.authorization).toEqual(direct.authorization); expect(delegated.budget).toEqual(direct.budget);
  expect(delegated.candidateTotal).toBe(direct.candidateTotal);
  expect(direct.modelHttp).toEqual({ root: 3, child: 0, total: 3 });
  expect(delegated.modelHttp).toEqual({ root: 3, child: 2, total: 5 });
  expect([direct.productRuns, delegated.productRuns]).toEqual([1, 2]);
  expect([direct.toolCalls, delegated.toolCalls]).toEqual([2, 3]);
  // Both paths use one original block; another Agent does not make its shared source independent evidence.
  // Local timings include the controlled provider and product work; no speed, quality or user benefit is presumed.
  console.info('Controlled direct/delegated invoice comparison: ' + JSON.stringify({ direct, delegated }));
}, 45000);
