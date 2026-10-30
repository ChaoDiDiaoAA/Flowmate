import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../../../apps/composition.ts';
import { appError, fail, ok, PersonalAgentConfigurationSchema, type DocumentSnapshot, type InvoiceWorkWorkingContext,
  type ProductPaths, type ProviderConfig, type Result } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }

test('formal Durable compaction reaches the model, shares Work quota and does not leak a summary into the next invoice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-compaction-production-'));
  const paths: ProductPaths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const wire: Array<{ summary: boolean; documentId: number | null; body: string }> = [];
  const ordinals = new Map<number, number>(), documents: DocumentSnapshot[] = [];
  const summaryMarker = 'FIRST_PHASE_SUMMARY_NOTE', traceMarker = 'FIRST_PHASE_DISCUSSION';
  const verboseReads = 7;
  let legacyCalls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content: string }> };
    const summary = body.messages.some(message => message.role === 'system' && message.content.includes('context summarization assistant'));
    let tool: { name: string; arguments: unknown } | null = null, text: string;
    if (summary) {
      wire.push({ summary: true, documentId: null, body: JSON.stringify(body) });
      text = summaryMarker + ': Prior discussion read the first invoice. All field claims still require the original sources and human disposition.';
    } else {
      const material = body.messages.find(message => message.role === 'user' && message.content.startsWith('{'));
      if (!material) throw Error('Expected the saved current-invoice working set.');
      const context = JSON.parse(material.content) as InvoiceWorkWorkingContext, documentId = context.item.documentRef.id;
      const ordinal = ordinals.get(documentId) ?? 0; ordinals.set(documentId, ordinal + 1);
      wire.push({ summary: false, documentId, body: JSON.stringify(body) });
      const first = documentId === documents[0]!.documentRef.id;
      if (first && ordinal < verboseReads) {
        text = traceMarker + String(ordinal) + ': ' + 'original phase discussion; '.repeat(1000);
        tool = { name: 'read_invoice_document', arguments: { documentId, page: 1, afterBlockId: null, limit: 10 } };
      } else if (ordinal === (first ? verboseReads : 0)) {
        text = 'Prepare the candidate for the current invoice.';
        const document = documents.find(value => value.documentRef.id === documentId);
        if (!document) throw Error('Expected the current original invoice.');
        const candidate = invoiceWorkCandidateDraft();
        candidate.fields.totalAmount.sources = [{ documentId, version: document.documentRef.version,
          artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: 'Total 113.00' }];
        tool = { name: 'save_invoice_candidate', arguments: { documentId, candidate } };
      } else text = 'The current candidate is saved for human review.';
    }
    const delta = tool ? { role: 'assistant', content: text, tool_calls: [{ index: 0, id: 'compaction-product-call-' + wire.length,
      type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: text };
    const response = { id: 'compaction-product-response-' + wire.length, object: 'chat.completion.chunk', created: 1,
      model: 'compaction-original-model', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] };
    return new Response('data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const provider: ProviderConfig = { version: 1, name: 'compaction-original-profile', revision: 1,
    modelRef: { provider: 'compaction-controlled', model: 'compaction-original-model' },
    native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.port + '/v1',
      contextWindow: 64000, maxTokens: 8192, reasoning: false }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const configuration = PersonalAgentConfigurationSchema.parse({ modelId: provider.name, thinkingLevel: 'off',
    tools: ['read_invoice_document', 'save_invoice_candidate'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const app = need(await createApplication({ paths,
    provider: { prepare: async () => { legacyCalls++; return fail(appError('unexpected_legacy_model', 'provider', 'Durable compaction must retain its original model.')); },
      close: async () => ({ stopped: true, closed: true, errors: [] }) },
    personalAgent: { defaultConfiguration: configuration, resolveConfiguration: () => ok(provider), readApiKey: () => 'synthetic-compaction-product-key' } }));
  deferCleanup(() => app.close());
  for (const sample of ['first-compaction-invoice', 'second-compaction-invoice']) {
    const sourceText = sample + ': Total 113.00';
    documents.push(need(await app.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample, sourceText,
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] })));
  }
  const agent = need(await app.personalAgent.get()), created = need(await app.invoiceWorks.create({ personalAgentId: agent.personalAgentId,
    expectedAgentRevision: agent.revision, requestId: 'create-compaction-production', goal: 'Prepare both selected invoices for human review.',
    documents: documents.map(document => document.documentRef) }));
  if (!('attempt' in created.execution) || !created.execution.attempt) throw Error('Expected the admitted original attempt.');
  const attemptId = created.execution.attempt.attemptId;
  await waitFor(async () => need(await app.personalTasks.get({ workId: created.workId, attemptId })).task.stoppedAt !== null, 30000);
  const task = need(await app.personalTasks.get({ workId: created.workId, attemptId }));
  if (task.task.attempt.runId === null) throw Error('Expected the original product Root Run.');
  const run = need(await app.queryRun(task.task.attempt.runId));
  if (run.error) {
    const history = need(await app.personalTasks.history({ target: { workId: created.workId }, limit: 5 }));
    const audit = new Database(paths.databaseFile, { readonly: true });
    try {
      const native = audit.query(`SELECT id,kind,status,substr(json_extract(record,'$.state.outcome.error.message'),1,512) error
        FROM fm_durable_tasks WHERE kind IN ('pi.generation','pi.compaction') ORDER BY id LIMIT 16`).all();
      throw Error(JSON.stringify({ error: run.error, native, requests: wire.map(call => ({ summary: call.summary,
        documentId: call.documentId, bytes: call.body.length })), entries: history.entries.map(entry => ({ kind: entry.kind, id: entry.entryId })) }));
    } finally { audit.close(); }
  }
  expect(task.task.runStatus).toBe('completed'); expect(legacyCalls).toBe(0);
  expect(wire.filter(call => call.summary).length).toBeGreaterThan(0);
  expect(wire.filter(call => !call.summary && call.documentId === documents[0]!.documentRef.id).some(call => call.body.includes(summaryMarker))).toBe(true);
  const second = wire.filter(call => !call.summary && call.documentId === documents[1]!.documentRef.id);
  expect(second).toHaveLength(2);
  for (const call of second) { expect(call.body).not.toContain(traceMarker); expect(call.body).not.toContain(summaryMarker); }
  const view = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
  if (view.view !== 'work') throw Error('Expected the original fixed invoice collection.');
  expect(view.work.status).toBe('open'); expect(view.items.every(item => item.candidateRef !== null && item.disposition === 'unresolved')).toBe(true);
  const requests = wire.length;
  need(await app.personalTasks.history({ target: { workId: created.workId }, limit: 100 }));
  expect(wire).toHaveLength(requests);
  need(await app.close());
  const audit = new Database(paths.databaseFile, { readonly: true });
  try {
    expect(audit.query('SELECT sum(count) count FROM invoice_work_model_reservations').get()).toEqual({ count: requests });
    expect(audit.query('SELECT count(*) count FROM runs').get()).toEqual({ count: 1 });
    expect(audit.query('SELECT count(*) count FROM invoice_candidates').get()).toEqual({ count: 2 });
  } finally { audit.close(); }
}, 45000);
