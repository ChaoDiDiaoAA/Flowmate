import { expect, spyOn, test } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '@flowmate/runtime-pi';
import { CandidateDraftSchema, ok, PersonalAgentConfigurationSchema, ToolCallSnapshotSchema,
  type AgentRunEvent, type Application, type DocumentSnapshot, type InvoiceWorkCreateReceipt,
  type InvoiceWorkWorkingContext, type ProviderConfig, type Result } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }
const goal = 'Prepare this original invoice and retain its result until explicit human acceptance.';
const sourceText = 'Invoice INV-VALUE; Date 2026-10-29; Seller Value Seller; Buyer Value Buyer; Currency CNY; Net 100.00; Tax 13.00; Total 113.00';
type Wire = { messages: Array<{ role: string; content: unknown }> };

function observeBusinessCommands(app: Application) {
  const commands = { task: spyOn(app, 'startTask'), run: spyOn(app, 'startRun'), workspace: spyOn(app, 'updateWorkspace'),
    create: spyOn(app.invoiceWorks, 'create'), continue: spyOn(app.invoiceWorks, 'continueWork'),
    select: spyOn(app, 'selectCandidate'), accept: spyOn(app, 'acceptInvoiceCandidate'), dispose: spyOn(app.invoiceWorks, 'disposeItem') };
  deferCleanup(() => { for (const command of Object.values(commands)) command.mockRestore(); });
  return () => ({ taskGoals: commands.task.mock.calls.map(([input]) => input.goal),
    runInputs: commands.run.mock.calls.map(([input]) => input.text),
    workRequests: commands.create.mock.calls.map(([input]) => ({ requestId: input.requestId, goal: input.goal, documents: input.documents })),
    selectedDocuments: commands.workspace.mock.calls.flatMap(([input]) => input.change.kind === 'document' ? [input.change.documentId] : []),
    continueRequests: commands.continue.mock.calls.map(([input]) => input.requestId),
    selectedCandidates: commands.select.mock.calls.map(([input]) => input.candidateId),
    acceptRequests: commands.accept.mock.calls.map(([input]) => input.operationRef),
    disposeRequests: commands.dispose.mock.calls.map(([input]) => input.requestId) });
}

async function scenario(mode: 'agent_session' | 'durable') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-invoice-work-value-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  let document: DocumentSnapshot;
  const wires: Wire[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer controlled-value-' + mode);
    const wire = await request.json() as Wire; wires.push(wire);
    const candidate = invoiceWorkCandidateDraft();
    for (const [name, value] of Object.entries({ invoiceNumber: 'INV-VALUE', issueDate: '2026-10-29', sellerName: 'Value Seller',
      buyerName: 'Value Buyer', currency: 'CNY', netAmount: '100.00', taxAmount: '13.00', totalAmount: '113.00' })) {
      candidate.fields[name as keyof typeof candidate.fields] = { raw: value, normalized: value, state: 'present', alternatives: [],
        sources: [{ documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId,
          page: 1, blockId: 'b1', quote: value }] };
    }
    const ordinal = wire.messages.filter(message => message.role === 'tool').length;
    let tool: { name: string; input: unknown } | null = null;
    if (ordinal === 0) tool = { name: 'read_invoice_document', input: { documentId: document.documentRef.id, page: 1, afterBlockId: null, limit: 10 } };
    else if (ordinal === 1) tool = { name: 'save_invoice_candidate', input: { documentId: document.documentRef.id, candidate } };
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'value-tool-' + wires.length, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { role: 'assistant', content: 'The original candidate awaits human review.' };
    return new Response('data: ' + JSON.stringify({ id: 'value-response-' + wires.length, object: 'chat.completion.chunk', created: 1,
      model: 'value-local', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const config: ProviderConfig = { version: 1, name: 'value-local', revision: 1, modelRef: { provider: 'controlled-value', model: 'value-local' },
    native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.port + '/v1', contextWindow: 64000, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const options: Parameters<typeof createApplication>[0] = { paths, logger: { write() {}, async close() {} },
    agentFactory: tools => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-value-' + mode }),
    personalAgent: { defaultConfiguration: PersonalAgentConfigurationSchema.parse({ modelId: config.name, thinkingLevel: 'off',
      tools: ['read_invoice_document', 'save_invoice_candidate'], resources: { prompt: null, enabledSkills: [] },
      extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' }),
    resolveConfiguration: () => ok(config), readApiKey: () => 'controlled-value-' + mode } };
  let app = need(await createApplication(options)); deferCleanup(() => app.close());
  document = need(await app.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample: 'value-controlled', sourceText,
    original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  const session = need(await app.createSession({ title: 'Original value comparison', expectedRevision: need(await app.readWorkspace()).revision }));
  const initialCommands = observeBusinessCommands(app), executionStarted = performance.now();
  let runId: number, jobId: number, created: InvoiceWorkCreateReceipt | null = null;
  if (mode === 'agent_session') {
    const selected = need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision,
      change: { kind: 'document', documentId: document.documentRef.id } }));
    const task = need(await app.startTask({ clientSequence: 1, expectedRevision: selected.revision, documentRef: document.documentRef, goal }));
    jobId = task.job.jobId;
    const finished = Promise.withResolvers<AgentRunEvent & { type: 'run_finished' }>();
    const workspace = task.workspace;
    const accepted = need(await app.startRun({ sessionId: session.sessionId, goalMode: 'save-candidate', text: goal, config,
      workspace: { revision: workspace.revision, sessionId: session.sessionId, documentRef: workspace.documentRef,
        jobId: workspace.jobId, candidateRef: workspace.candidateRef }, timeoutMs: 10000, stopGraceMs: 500 },
    { onEvent(event) { if (event.type === 'run_finished') finished.resolve(event); } }));
    runId = accepted.runId;
    expect(need((await finished.promise).result).status).toBe('completed');
  } else {
    const agent = need(await app.personalAgent.get());
    created = need(await app.invoiceWorks.create({ personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'value-original-create', goal, documents: [document.documentRef] }));
    const original = created;
    await waitFor(async () => need(await app.personalTasks.list({ workId: original.workId, limit: 10 })).items
      .some(task => task.runStatus === 'completed' && task.stoppedAt !== null));
    const view = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
    if (view.view !== 'work' || view.work.execution.attempt?.runId === null || !view.work.execution.attempt || !view.items[0]?.jobId)
      throw Error('Expected the original completed execution and unresolved invoice.');
    runId = view.work.execution.attempt.runId; jobId = view.items[0].jobId;
    expect(view.work).toMatchObject({ status: 'open', counts: { unresolved: 1, accepted: 0 } });
    expect(view.items[0].disposition).toBe('unresolved');
    for (const wire of wires) {
      const context = JSON.parse(wire.messages.find(message => message.role === 'user')!.content as string) as InvoiceWorkWorkingContext;
      expect(context.item.documentRef).toEqual(document.documentRef); expect(context.work.goal).toBe(goal);
    }
  }
  const executionMs = performance.now() - executionStarted, initial = initialCommands();
  const candidates = need(await app.listJobCandidates({ jobId })).items;
  expect(candidates).toHaveLength(1);
  const candidate = candidates[0]!;
  expect(candidate).toMatchObject({ runId, status: 'generated' });
  expect(wires).toHaveLength(3);
  expect(JSON.stringify(wires[0]!.messages)).toContain(goal);
  expect(JSON.stringify(wires[1]!.messages.find(message => message.role === 'tool')?.content)).toContain(sourceText);
  const run = need(await app.queryRun(runId));
  expect('runtimeKind' in run ? run.runtimeKind : 'agent_session').toBe(mode);
  const beforeCalls = wires.length;
  const reopenStarted = performance.now();
  need(await app.close()); app = need(await createApplication(options));
  const reopenedCommands = observeBusinessCommands(app);
  for (let index = 0; index < 3; index++) {
    expect(need(await app.listJobCandidates({ jobId })).items).toEqual(candidates);
    expect(need(await app.queryRun(runId)).status).toBe('completed');
    if (created) {
      expect(need(await app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: created.personalAgentId,
        requestId: created.requestId }))).toEqual(created);
      expect(need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }))).toMatchObject({ work: { goal, status: 'open' } });
    }
  }
  expect(wires).toHaveLength(beforeCalls);
  const restored = reopenedCommands(), reopenAndQueryMs = performance.now() - reopenStarted;
  const sessionId = created?.sessionId ?? session.sessionId;
  const calls = need(await app.listRunToolCalls({ runId, sessionId, limit: 10 })).items;
  expect(calls.map(call => [call.toolName, call.status])).toEqual([['save_invoice_candidate', 'succeeded'], ['read_invoice_document', 'succeeded']]);
  const originalSave = calls.find(call => call.toolName === 'save_invoice_candidate')!;
  const evidence = need(await app.queryRunToolEvidence({ runId, sessionId, toolCallId: originalSave.toolCallId, limit: 32768 }));
  expect(evidence.nextOffset).toBeNull();
  const saved = ToolCallSnapshotSchema.parse(JSON.parse(evidence.chunk));
  expect(saved).toMatchObject({ runId, toolCallId: originalSave.toolCallId, toolName: 'save_invoice_candidate', status: 'succeeded',
    result: { status: 'succeeded', committedCandidateId: candidate.candidateId } });
  const savedInput = z.object({ documentId: z.number(), candidate: CandidateDraftSchema }).parse(saved.args.final);
  expect(savedInput.candidate.fields.totalAmount.sources).toEqual([{ documentId: document.documentRef.id,
    version: document.documentRef.version, artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote: '113.00' }]);
  const reviewStarted = performance.now();
  need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision,
    change: { kind: 'document', documentId: document.documentRef.id } }));
  need(await app.updateWorkspace({ expectedRevision: need(await app.readWorkspace()).revision, change: { kind: 'job', jobId } }));
  const current = need(await app.readWorkspace());
  const selected = need(await app.selectCandidate({ jobId, candidateId: candidate.candidateId,
    expectedCandidateId: current.candidateRef?.id ?? null, expectedRevision: current.revision }));
  const acceptRequest = { operationRef: 'value-original-accept', jobId, candidateId: candidate.candidateId,
    expectedCandidateId: candidate.candidateId, expectedRevision: selected.workspace.revision, dirty: false as const };
  expect(need(await app.acceptInvoiceCandidate(acceptRequest)).candidate.status).toBe('accepted');
  if (created) {
    const view = need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }));
    if (view.view !== 'work') throw Error('Expected the original business work.');
    const disposition = { workId: created.workId, itemId: view.items[0]!.itemId, requestId: 'value-original-dispose',
      expectedRevision: view.work.revision, decision: { kind: 'accepted' as const,
        candidateRef: { id: candidate.candidateId, sequence: candidate.sequence }, acceptRequest } };
    const disposed = need(await app.invoiceWorks.disposeItem(disposition));
    expect(need(await app.invoiceWorks.disposeItem(disposition))).toEqual(disposed);
    expect(need(await app.invoiceWorks.get({ view: 'work', workId: created.workId }))).toMatchObject({ work: { status: 'completed', counts: { accepted: 1 } } });
  }
  expect(need(await app.listJobCandidates({ jobId })).items).toHaveLength(1);
  expect(wires).toHaveLength(beforeCalls);
  const reviewAndDispositionMs = performance.now() - reviewStarted, review = reopenedCommands();
  const runs = need(await app.listSessionRuns({ sessionId, limit: 10 }));
  expect(runs.nextBeforeRunId).toBeNull(); expect(runs.items.map(run => [run.runId, run.status])).toEqual([[runId, 'completed']]);
  const attempts = created ? need(await app.personalTasks.list({ workId: created.workId, limit: 10 })) : null;
  if (attempts) {
    expect(attempts.nextBeforeAttemptId).toBeNull(); expect(attempts.items).toHaveLength(1);
    expect(attempts.items[0]!.attempt).toMatchObject({ runId, runtimeLinked: true });
    expect(attempts.items[0]!.attempt.attemptId).toBeGreaterThan(0);
  }
  need(await app.close());
  return { mode, modelRequests: wires.length, sourceText, operationEvidence: { kind: 'synthetic-public-api',
    initial, restored, review, runs: runs.items, attempts: attempts?.items ?? [],
    measuredMs: { executionMs, reopenAndQueryMs, reviewAndDispositionMs }, humanTimeMs: null, billedCost: null, semanticQuality: null } };
}

test('the same invoice and explicit acceptance target retain original evidence through both runtimes without repeat input, candidate copies or waiting calls', async () => {
  const legacy = await scenario('agent_session'), personal = await scenario('durable');
  expect(personal.sourceText).toBe(legacy.sourceText);
  expect(personal.modelRequests).toBe(legacy.modelRequests);
  expect(personal).toMatchObject({ operationEvidence: { kind: 'synthetic-public-api',
    restored: { taskGoals: [], runInputs: [], workRequests: [], selectedDocuments: [], continueRequests: [] },
    humanTimeMs: null, billedCost: null, semanticQuality: null } });
  expect(legacy.operationEvidence.initial.taskGoals).toEqual([goal]);
  expect(legacy.operationEvidence.initial.runInputs).toEqual([goal]);
  expect(legacy.operationEvidence.initial.selectedDocuments).toHaveLength(1);
  expect(personal.operationEvidence.initial.workRequests).toHaveLength(1);
  expect(personal.operationEvidence.initial.workRequests[0]!.goal).toBe(goal);
  expect(personal.operationEvidence.initial.workRequests[0]!.documents).toHaveLength(1);
  expect(personal.operationEvidence.initial.taskGoals).toEqual([]); expect(personal.operationEvidence.initial.runInputs).toEqual([]);
  for (const evidence of [legacy.operationEvidence, personal.operationEvidence]) {
    expect(evidence.restored).toEqual({ taskGoals: [], runInputs: [], workRequests: [], selectedDocuments: [], continueRequests: [],
      selectedCandidates: [], acceptRequests: [], disposeRequests: [] });
    expect(evidence.review.selectedDocuments).toHaveLength(1); expect(evidence.review.selectedCandidates).toHaveLength(1);
    expect(evidence.review.acceptRequests).toEqual(['value-original-accept']);
    expect(evidence.review.continueRequests).toEqual([]);
    for (const measured of Object.values(evidence.measuredMs)) { expect(Number.isFinite(measured)).toBe(true); expect(measured).toBeGreaterThan(0); }
    expect(evidence.runs).toHaveLength(1);
  }
  expect(legacy.operationEvidence.review.disposeRequests).toEqual([]);
  expect(personal.operationEvidence.review.disposeRequests).toEqual(['value-original-dispose', 'value-original-dispose']);
  expect(personal.operationEvidence.attempts).toHaveLength(1);
  console.info('invoice-work-value-evidence', JSON.stringify([legacy, personal].map(({ mode, modelRequests, operationEvidence: evidence }) => ({
    mode, modelRequests, ...evidence, runs: evidence.runs.map(run => ({ runId: run.runId, status: run.status })),
    attempts: evidence.attempts.map(attempt => ({ ...attempt.attempt, runStatus: attempt.runStatus })) }))));
  // Controlled protocol requests establish behavior, not billed model cost, semantic quality or human time savings.
}, 35000);
