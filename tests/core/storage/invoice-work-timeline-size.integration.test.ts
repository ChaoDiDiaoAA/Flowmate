import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createApplication } from '../../../apps/composition.ts';
import { appError, fail, ok, TOOL_CONFIG, InvoiceWorkTimelinePageSchema, InvoiceWorkWorkingContextSchema, PersonalAgentConfigurationSchema, SourceRefSchema,
  compareInvoiceWorkTimelineCursor, invoiceToolSchemas,
  type DocumentSnapshot, type InvoiceCandidateChildReportReference, type InvoiceWorkTimelineCursor, type InvoiceWorkTimelineEntry,
  type ProviderConfig, type Result } from '@flowmate/contracts';
import { createInvoiceWorkTimelineService } from '../../../packages/core/src/personal-agent/timeline.ts';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code + ': ' + value.error.message); return value.data; }
type Wire = { messages: Array<{ role: string; content: string }> };
const success = z.object({ status: z.literal('succeeded'), data: z.unknown() });

test('large legitimate child source references paginate the original timeline by UTF-8 bytes without losing facts or querying models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-timeline-source-size-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const goal = 'Prepare four original invoice candidates for explicit human review, preserving their source references.';
  const materials: Array<{ document: DocumentSnapshot; text: string; number: string }> = [];
  const requests: Array<{ child: boolean }> = [], savedArgumentBytes: number[] = [], errors: string[] = [];
  let legacyRequests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer controlled-timeline-size-key');
    const body = await request.json() as Wire;
    const context = InvoiceWorkWorkingContextSchema.parse(JSON.parse(body.messages.filter(message => message.role === 'user').at(-1)!.content));
    const child = context.delegation !== undefined, material = materials.find(value => value.document.documentRef.id === context.item.documentRef.id);
    if (!material) throw Error('Expected this original authorized invoice.');
    requests.push({ child });
    const replies = body.messages.filter(message => message.role === 'tool');
    let tool: { name: string; arguments: unknown } | null = null, text = '';
    if (replies.length === 0) tool = child
      ? { name: 'read_invoice_document', arguments: { documentId: material.document.documentRef.id, page: 1, afterBlockId: null, limit: 10 } }
      : { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker', run_in_background: false,
        description: 'Bounded check of this invoice header source',
        prompt: 'Read the original block and return its exact SourceRef for the invoice number, date, parties, currency and amounts; retain any gap.' } };
    else if (child) {
      const read = invoiceToolSchemas.read_invoice_document.output.parse(success.parse(JSON.parse(replies[0]!.content)).data);
      expect(read.blocks).toHaveLength(1); expect(read.blocks[0]!.text).toBe(material.text);
      expect(read.blocks[0]!.source.quote).toBe(material.text);
      text = JSON.stringify(read.blocks[0]!.source);
    } else if (replies.length === 1) {
      const returned = z.object({ details: z.object({ childRunId: z.number().int().positive(), text: z.string() }).passthrough() }).passthrough()
        .parse(success.parse(JSON.parse(replies[0]!.content)).data);
      const candidate = invoiceWorkCandidateDraft(), source = SourceRefSchema.parse(JSON.parse(returned.details.text));
      const values = { invoiceNumber: material.number, issueDate: '2026-10-29', sellerName: 'Original Seller', buyerName: 'Original Buyer',
        currency: 'CNY', netAmount: '100.00', taxAmount: '13.00', totalAmount: '113.00' };
      const childReportRefs: InvoiceCandidateChildReportReference[] = [];
      for (const [name, value] of Object.entries(values)) {
        candidate.fields[name as keyof typeof candidate.fields] = { raw: value, normalized: value, state: 'present', alternatives: [], sources: [source] };
        childReportRefs.push({ childRunId: returned.details.childRunId, fieldPath: 'fields.' + name, sourceRefs: [source], inputIds: [] });
      }
      const args = invoiceToolSchemas.save_invoice_candidate.input.parse({ documentId: material.document.documentRef.id, candidate, childReportRefs });
      const bytes = Buffer.byteLength(JSON.stringify(args), 'utf8'); savedArgumentBytes.push(bytes);
      expect(bytes).toBeLessThanOrEqual(TOOL_CONFIG.payload.maxRawArgumentsBytes);
      expect(bytes).toBeLessThanOrEqual(TOOL_CONFIG.payload.maxFinalArgumentsBytes);
      tool = { name: 'save_invoice_candidate', arguments: args };
    } else text = 'The original candidate is saved for explicit human review.';
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'timeline-size-wire-' + requests.length, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: text };
    return new Response('data: ' + JSON.stringify({ id: 'timeline-size-response-' + requests.length, object: 'chat.completion.chunk', created: 1,
      model: 'timeline-size-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const provider: ProviderConfig = { version: 1, name: 'timeline-size-profile', revision: 1,
    modelRef: { provider: 'controlled-timeline-size', model: 'timeline-size-model' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.port + '/v1', contextWindow: 262144, maxTokens: 32768, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const options: Parameters<typeof createApplication>[0] = { paths,
    runtimeDefaults: () => ok({ budget: { maxModelCalls: 32, maxToolCalls: 24 }, timeoutMs: 120000 }),
    logger: { write: event => { if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    provider: { prepare: async () => { legacyRequests++; return fail(appError('unexpected_legacy_model', 'provider', 'This fixture uses only the original Durable Work.')); },
      close: async () => ({ stopped: true, closed: true, errors: [] }) },
    personalAgent: { defaultConfiguration: PersonalAgentConfigurationSchema.parse({ modelId: provider.name, thinkingLevel: 'off',
      tools: ['Agent', 'read_invoice_document', 'save_invoice_candidate'], resources: { prompt: null, enabledSkills: [] },
      extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' }), resolveConfiguration: () => ok(provider),
    readApiKey: () => 'controlled-timeline-size-key' } };
  const app = need(await createApplication(options)); deferCleanup(() => app.close());
  for (let index = 1; index <= 4; index++) {
    const number = 'INV-TIMELINE-' + index;
    const prefix = `Invoice ${number}; Date 2026-10-29; Seller Original Seller; Buyer Original Buyer; Currency CNY; Net 100.00; Tax 13.00; Total 113.00; `;
    const text = prefix + '证'.repeat(1024 - prefix.length);
    const document = need(await app.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample: 'timeline-size-' + index, sourceText: text,
      original: { name: 'source.md', base64: Buffer.from(text).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
    materials.push({ document, text, number });
  }
  expect(requests).toHaveLength(0);
  const agent = need(await app.personalAgent.get()), created = need(await app.invoiceWorks.create({ personalAgentId: agent.personalAgentId,
    expectedAgentRevision: agent.revision, requestId: 'create-timeline-size', goal, documents: materials.map(value => value.document.documentRef) }));
  if (!('attempt' in created.execution) || !created.execution.attempt) throw Error('Expected one authorized original attempt.');
  const attemptId = created.execution.attempt.attemptId;
  await waitFor(async () => need(await app.personalTasks.get({ workId: created.workId, attemptId })).task.stoppedAt !== null, 90000);
  const task = need(await app.personalTasks.get({ workId: created.workId, attemptId }));
  expect(task.task.runStatus).toBe('completed'); expect(task.children).toHaveLength(4);
  expect(task.children.every(child => child.resultRecorded && child.stopConfirmed && child.parentModelReceivedAt !== null)).toBe(true);
  expect(savedArgumentBytes).toHaveLength(4); expect(requests).toHaveLength(20);
  expect(requests.filter(value => value.child)).toHaveLength(8);
  const view = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
  if (view.view !== 'work') throw Error('Expected the original Work.');
  expect(view.items).toHaveLength(4);
  const expectedRefs = new Map<number, InvoiceCandidateChildReportReference[]>();
  const calls = need(await app.listRunToolCalls({ runId: task.task.attempt.runId!, sessionId: created.sessionId, limit: 20 })).items;
  for (const item of view.items) {
    if (item.jobId === null || item.candidateRef === null) throw Error('Expected each genuinely saved original candidate.');
    const original = need(await app.queryJobCandidate({ jobId: item.jobId, candidateId: item.candidateRef.id }));
    if (original.candidate.toolCallId === null) throw Error('Expected the original model save ToolCall.');
    const bytes = need(await app.queryRunToolEvidence({ runId: task.task.attempt.runId!, sessionId: created.sessionId,
      toolCallId: original.candidate.toolCallId, limit: 32768 }));
    const chunks = [bytes.chunk]; let next = bytes.nextOffset;
    while (next !== null) {
      const page = need(await app.queryRunToolEvidence({ runId: task.task.attempt.runId!, sessionId: created.sessionId,
        toolCallId: original.candidate.toolCallId, expectedRevision: bytes.evidenceRevision, offset: next, limit: 32768 })); chunks.push(page.chunk); next = page.nextOffset;
    }
    const input = invoiceToolSchemas.save_invoice_candidate.input.parse(JSON.parse(chunks.join('')).args.final);
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThanOrEqual(TOOL_CONFIG.payload.maxFinalArgumentsBytes);
    expect(input.childReportRefs).toHaveLength(8); expectedRefs.set(item.candidateRef.id, input.childReportRefs!);
    need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'document', documentId: item.documentRef.id } }));
    need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'job', jobId: item.jobId } }));
    const workspace = need(await app.readWorkspace()), selected = need(await app.selectCandidate({ jobId: item.jobId, candidateId: item.candidateRef.id,
      expectedCandidateId: workspace.candidateRef?.id ?? null, expectedRevision: workspace.revision }));
    need(await app.acceptInvoiceCandidate({ operationRef: 'timeline-size-accept-' + item.itemId, jobId: item.jobId, candidateId: item.candidateRef.id,
      expectedCandidateId: item.candidateRef.id, expectedRevision: selected.workspace.revision, dirty: false }));
    need(await app.exportInvoiceCandidate({ operationRef: 'timeline-size-export-' + item.itemId, candidateId: item.candidateRef.id, format: 'json' }));
  }
  expect(calls.filter(call => call.toolName === 'save_invoice_candidate' && call.status === 'succeeded')).toHaveLength(4);
  expect(requests).toHaveLength(20); expect(legacyRequests).toBe(0); expect(errors).toEqual([]);
  need(await app.close());
  const database = need(openTestDatabase(paths)), timeline = createInvoiceWorkTimelineService({ database });
  const before = await database.read(store => ({ calls: store.db.query('SELECT id,args_json,result_json,cleanup_json,stopped_at FROM tool_calls ORDER BY id').all(),
    changes: store.db.query('SELECT total_changes() changes').get() }));
  async function collect(limit: number) {
    const entries: InvoiceWorkTimelineEntry[] = []; let cursor: InvoiceWorkTimelineCursor | undefined, pages = 0;
    do {
      const page = need(await timeline.timeline({ workId: created.workId, limit, ...(cursor ? { before: cursor } : {}) }));
      expect(InvoiceWorkTimelinePageSchema.safeParse(page).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(262144);
      expect(page.entries.length).toBeGreaterThan(0); entries.push(...page.entries); pages++;
      if (page.nextBefore === null) return { entries, pages };
      cursor = page.nextBefore;
    } while (pages < 200);
    throw Error('Original timeline continuation did not finish.');
  }
  const small = await collect(1), business = small.entries.filter(entry => ['candidate_generated', 'candidate_accepted', 'candidate_exported'].includes(entry.kind));
  expect(business).toHaveLength(12);
  for (const entry of business) {
    expect(entry.refs.childReportRefs).toEqual(expectedRefs.get(entry.refs.candidateRef!.id));
    expect(entry.refs.childReportRefs!.every(ref => ref.sourceRefs[0]!.quote?.length === 1024)).toBe(true);
  }
  const combinedBytes = Buffer.byteLength(JSON.stringify({ workId: created.workId, semantics: 'live-facts', entries: small.entries, nextBefore: null }), 'utf8');
  expect(combinedBytes).toBeGreaterThan(262144);
  const large = await collect(100);
  expect(large.pages).toBeGreaterThan(1); expect(large.entries).toEqual(small.entries);
  expect(new Set(large.entries.map(entry => entry.key)).size).toBe(large.entries.length);
  expect(large.entries.every((entry, index) => index === 0 || compareInvoiceWorkTimelineCursor(large.entries[index - 1]!, entry) > 0)).toBe(true);
  expect(await database.read(store => ({ calls: store.db.query('SELECT id,args_json,result_json,cleanup_json,stopped_at FROM tool_calls ORDER BY id').all(),
    changes: store.db.query('SELECT total_changes() changes').get() }))).toEqual(before);
  expect(requests).toHaveLength(20);
  console.info('Original timeline size fixture: ' + JSON.stringify({ savedArgumentBytes, combinedBytes, facts: large.entries.length, pages: large.pages }));
}, 120000);
