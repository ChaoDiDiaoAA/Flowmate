import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../../apps/composition.ts';
import { createFileStore } from '@flowmate/core';
import { PiAgentAdapter, PiProviderAdapter } from '@flowmate/runtime-pi';
import { ok, PersonalAgentConfigurationSchema, type AgentRunEvent, type DocumentRef, type InvoiceWorkWorkingContext,
  type ProviderConfig, type ProviderObservation, type Result } from '@flowmate/contracts';
import { openTestDatabase } from '../../support/database.ts';
import { createHttpProvider, deferCleanup, mkdtempSync, waitFor } from '../../support/resources.ts';
import { invoiceWorkCandidateDraft } from '../../support/invoice-work-tools.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }
type Wire = { messages: Array<{ role: string; content: string }> };
function response(delta: unknown, finishReason: string, model: string): Response {
  const chunk = { id: 'personal-foreground-local', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function observed(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 8000); })])).toBe(true);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function fixture(hold: 'none' | 'response' | 'tool' | 'child' | 'closing') {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-foreground-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  const database = need(openTestDatabase(paths)), files = createFileStore(paths, database);
  const documentRefs: DocumentRef[] = [], artifacts = new Map<number, number>();
  for (const index of [1, 2]) {
    const at = new Date().toISOString(), sourceRecordId = String(index);
    const published = need(await files.publish({ sourceKey: 'personal-foreground', sourceRecordId, sourceVersion: 'v1', at,
      original: { kind: 'original', primaryName: 'original.pdf', files: [{ name: 'original.pdf', bytes: Buffer.from('Controlled original invoice'), mimeType: 'application/pdf' }] },
      parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [{ name: 'parsed.json', mimeType: 'application/json',
        bytes: Buffer.from(JSON.stringify({ formatVersion: 2, pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: 'Total 113.00',
          sourceIndex: 0, sourceType: 'synthetic', bbox: null }] }], completeness: { status: 'complete', checks: [], warnings: [] } })) }] } }));
    const document = need(await database.transaction(scope => scope.documents.register({ documentId: published.documentId,
      sourceKey: 'personal-foreground', sourceRecordId, version: 'v1', originalArtifact: { ...published.original, kind: 'original' },
      parsedArtifact: { ...published.parsed, kind: 'parsed' }, status: 'available', createdAt: at, updatedAt: at,
      metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled foreground cooperation'],
        licenseVerification: 'not_verified', unavailableReason: null } })));
    documentRefs.push(document.documentRef); artifacts.set(document.documentRef.id, document.parsedArtifactId);
  }
  await database.close();
  const foregroundEntered = Promise.withResolvers<void>(), foregroundRelease = Promise.withResolvers<void>();
  const foregroundStopped = Promise.withResolvers<void>(), foregroundDisconnected = Promise.withResolvers<void>();
  const personalEntered = Promise.withResolvers<void>(), responseRelease = Promise.withResolvers<void>();
  const childEntered = Promise.withResolvers<void>();
  const toolEntered = Promise.withResolvers<void>(), toolRelease = Promise.withResolvers<void>(), secondItemEntered = Promise.withResolvers<void>();
  const legacyCloseEntered = Promise.withResolvers<void>(), legacyCloseRelease = Promise.withResolvers<void>();
  const foregroundWire: Wire[] = [], personalWire: InvoiceWorkWorkingContext[] = [];
  const agentEvents: AgentRunEvent[] = [], personalDisconnected: InvoiceWorkWorkingContext[] = [];
  let heldResponse = false, heldTool = false;
  const server = await createHttpProvider(async request => {
    const body = await request.json() as Wire;
    if (new URL(request.url).pathname.startsWith('/foreground/')) {
      request.signal.addEventListener('abort', () => foregroundDisconnected.resolve(), { once: true });
      foregroundWire.push(body); foregroundEntered.resolve(); await foregroundRelease.promise;
      return response({ role: 'assistant', content: 'Original foreground request completed.' }, 'stop', 'foreground-local-model');
    }
    const context = JSON.parse(body.messages.find(message => message.role === 'user')!.content) as InvoiceWorkWorkingContext;
    let responded = false;
    request.signal.addEventListener('abort', () => { if (!responded) personalDisconnected.push(context); }, { once: true });
    personalWire.push(context); personalEntered.resolve();
    if (context.delegation) childEntered.resolve();
    if (context.item.documentRef.id === documentRefs[1]!.id) secondItemEntered.resolve();
    if ((hold === 'response' || hold === 'closing' || hold === 'child' && context.delegation) && !heldResponse) {
      heldResponse = true; await responseRelease.promise;
    }
    const documentId = context.item.documentRef.id, ordinal = body.messages.filter(message => message.role === 'tool').length;
    const candidate = invoiceWorkCandidateDraft();
    candidate.fields.totalAmount.sources = [{ documentId, version: 'v1', artifactId: artifacts.get(documentId)!, page: 1, blockId: 'b1', quote: 'Total 113.00' }];
    const delegated = hold === 'child' && documentId === documentRefs[0]!.id;
    const itemOrdinal = ordinal - (delegated ? 1 : 0);
    const read = { name: 'read_invoice_document', arguments: { documentId, page: 1, afterBlockId: null, limit: 10 } };
    let tool: { name: string; arguments: unknown } | null = null;
    if (context.delegation) { if (ordinal === 0) tool = read; }
    else if (delegated && ordinal === 0) tool = { name: 'Agent', arguments: { subagent_type: 'invoice-evidence-checker', run_in_background: false,
      description: 'Check the current original invoice', prompt: 'Verify the total against the original block and return a bounded evidence report.' } };
    else if (itemOrdinal === 0) tool = read;
    else if (itemOrdinal === 1) tool = { name: 'save_invoice_candidate', arguments: { documentId, candidate } };
    responded = true;
    return response(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `personal-foreground-tool-${personalWire.length}`, type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
      : { role: 'assistant', content: 'The original invoice candidate is ready for human review.' }, tool ? 'tool_calls' : 'stop', 'personal-local-model');
  });
  deferCleanup(() => server.stop(true));
  const config = (name: 'foreground' | 'personal'): ProviderConfig => ({ version: 1, name: `${name}-local`, revision: 1,
    modelRef: { provider: `controlled-${name}`, model: `${name}-local-model` }, native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/${name}/v1`, contextWindow: 64000, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } });
  const errors: string[] = [], observations: ProviderObservation[] = [];
  const app = need(await createApplication({ paths, provider: new PiProviderAdapter({ credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-foreground-key' }),
    agentFactory: definitions => {
      const agent = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools: definitions,
        credentials: new InMemoryCredentialStore(), runtimeApiKey: 'controlled-legacy-agent-key' });
      const close = agent.close.bind(agent);
      if (hold === 'closing') agent.close = async () => { legacyCloseEntered.resolve(); await legacyCloseRelease.promise; return close(); };
      return agent;
    },
    logger: { write: event => { if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    toolDefinitions: definitions => definitions.map(definition => hold === 'tool' && definition.name === 'read_invoice_document'
      ? { ...definition, execute: async (args, context, product) => {
        if (!heldTool) { heldTool = true; toolEntered.resolve(); await toolRelease.promise; }
        return definition.execute(args, context, product);
      } } : definition),
    personalAgent: { defaultConfiguration: PersonalAgentConfigurationSchema.parse({ modelId: 'personal-local', thinkingLevel: 'off',
      resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] },
      tools: [...(hold === 'child' ? ['Agent'] : []), 'read_invoice_document', 'save_invoice_candidate'], workingDirectory: null, preferences: '' }),
    resolveConfiguration: () => ok(config('personal')), readApiKey: () => 'controlled-personal-key' } }));
  deferCleanup(async () => { foregroundRelease.resolve(); responseRelease.resolve(); toolRelease.resolve(); legacyCloseRelease.resolve(); need(await app.close()); });
  const agent = need(await app.personalAgent.get());
  const create = (documents: readonly DocumentRef[] = documentRefs) => app.invoiceWorks.create({ personalAgentId: agent.personalAgentId,
    expectedAgentRevision: agent.revision, requestId: 'original-personal-work', goal: 'Prepare the fixed original invoices for human review.', documents: [...documents] }).then(need);
  const foreground = () => app.callProvider({ goal: 'Original foreground goal', text: 'Original foreground input', config: config('foreground'),
    timeoutMs: 15_000, stopGraceMs: 1000 }, { onObservation: event => observations.push(event) }).then(need);
  const foregroundAgent = async () => {
    const session = need(await app.createSession({ title: 'Original foreground AgentSession' }));
    return app.submitInput({ sessionId: session.sessionId, clientSequence: 1, mode: 'prompt', text: 'Original foreground AgentSession input',
      config: config('foreground'), timeoutMs: 15_000, stopGraceMs: 1000 }, { onEvent: event => {
        agentEvents.push(event); if (event.type === 'run_finished') foregroundStopped.resolve();
      } }).then(need);
  };
  const work = async (workId: number) => {
    const page = need(await app.invoiceWorks.get({ view: 'work', workId, limit: 100 }));
    if (page.view !== 'work') throw Error('Expected the original fixed invoice members.'); return page;
  };
  return { app, paths, create, foreground, foregroundAgent, work, documentRefs, foregroundWire, personalWire, observations, agentEvents, errors, personalDisconnected,
    foregroundEntered, foregroundRelease, foregroundStopped, foregroundDisconnected, personalEntered, childEntered,
    responseRelease, toolEntered, toolRelease, secondItemEntered, legacyCloseEntered, legacyCloseRelease };
}

test('a real foreground Provider Run leaves Personal creation persisted and queued, then its actual completion wakes Personal without a read or continue command', async () => {
  const f = await fixture('none'), foreground = f.foreground(); await observed(f.foregroundEntered.promise);
  expect(need(await f.app.queryRuntimeState()).active).toMatchObject({ kind: 'provider' });
  const receipt = await f.create([f.documentRefs[0]!]);
  expect(receipt.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true, attempt: { runId: null } });
  expect(need(await f.app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: receipt.personalAgentId, requestId: receipt.requestId }))).toEqual(receipt);
  expect(f.personalWire).toHaveLength(0);
  f.foregroundRelease.resolve(); const completed = await foreground;
  expect(completed).toMatchObject({ status: 'completed', stopped: true, text: 'Original foreground request completed.' });
  await observed(f.personalEntered.promise);
  const attemptId = receipt.execution.attempt!.attemptId;
  await waitFor(async () => need(await f.app.personalTasks.get({ workId: receipt.workId, attemptId })).task.stoppedAt !== null);
  expect((await f.work(receipt.workId)).work.execution).toMatchObject({ runStatus: 'completed', requiresContinue: false });
  expect(f.personalWire).toHaveLength(3);
  expect(f.foregroundWire[0]!.messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'Original foreground goal\n\nOriginal foreground input' }));
  expect(need(await f.app.queryRun(completed.runId))).toMatchObject({ input: { goal: 'Original foreground goal', text: 'Original foreground input' } });
  expect(f.observations.filter(event => event.type === 'run_created')).toHaveLength(1); expect(f.errors).toEqual([]);
}, 20_000);

test.each(['response', 'tool'] as const)('a foreground request arriving during Personal %s preserves its current phase and delays the next invoice boundary', async hold => {
  const f = await fixture(hold), receipt = await f.create();
  await observed(hold === 'response' ? f.personalEntered.promise : f.toolEntered.promise);
  const initial = await f.work(receipt.workId), attemptId = receipt.execution.attempt!.attemptId;
  const foreground = f.foreground(); await observed(f.foregroundEntered.promise);
  f.responseRelease.resolve(); f.toolRelease.resolve();
  await waitFor(async () => { const page = await f.work(receipt.workId);
    return page.work.execution.runStatus === 'failed' || page.items[0]!.candidateRef !== null && f.personalWire.length === 3; });
  const boundary = await f.work(receipt.workId);
  const originalRoot = need(await f.app.queryRun(initial.work.execution.attempt!.runId!));
  expect({ execution: boundary.work.execution, error: originalRoot.error }).toMatchObject({ execution: { runStatus: 'running', requiresContinue: false,
    attempt: { attemptId, runId: initial.work.execution.attempt!.runId } }, error: null });
  expect(boundary.items[0]!.candidateRef).not.toBeNull(); expect(boundary.items[1]!.candidateRef).toBeNull();
  expect(f.personalWire.map(context => context.item.documentRef.id)).toEqual(Array(3).fill(f.documentRefs[0]!.id));
  f.foregroundRelease.resolve(); expect(await foreground).toMatchObject({ status: 'completed', stopped: true });
  await observed(f.secondItemEntered.promise);
  await waitFor(async () => need(await f.app.personalTasks.get({ workId: receipt.workId, attemptId })).task.stoppedAt !== null);
  const final = await f.work(receipt.workId);
  expect(final.work.execution).toMatchObject({ runStatus: 'completed', requiresContinue: false, attempt: { attemptId, runId: initial.work.execution.attempt!.runId } });
  expect(final.items.every(item => item.candidateRef !== null && item.disposition === 'unresolved')).toBe(true);
  expect(f.personalWire.map(context => context.item.documentRef.id)).toEqual(f.documentRefs.flatMap(reference => Array(3).fill(reference.id)));
  need(await f.app.close());
  const audit = new Database(f.paths.databaseFile, { readonly: true });
  try {
    expect(audit.query('SELECT kind,status FROM runs ORDER BY id').all()).toEqual([{ kind: 'agent', status: 'completed' }, { kind: 'provider', status: 'completed' }]);
    expect(audit.query('SELECT COUNT(*) count FROM invoice_work_attempts').get()).toEqual({ count: 1 });
    expect(audit.query('SELECT COUNT(*) count FROM invoice_work_phases WHERE consumed_at IS NOT NULL AND closed_at IS NOT NULL').get()).toEqual({ count: 2 });
  } finally { audit.close(); }
  expect(f.errors).toEqual([]);
}, 25_000);

test.each(['response', 'tool', 'child'] as const)('cancelling only the real foreground AgentSession during Personal %s preserves the original running Durable attempt and descendants', async hold => {
  const f = await fixture(hold), receipt = await f.create();
  await observed({ response: f.personalEntered, tool: f.toolEntered, child: f.childEntered }[hold].promise);
  const identity = { workId: receipt.workId, attemptId: receipt.execution.attempt!.attemptId };
  const original = need(await f.app.personalTasks.get(identity)), originalPhase = f.personalWire[0]!.phase;
  expect(original.task).toMatchObject({ runStatus: 'running', stopRequestedAt: null, stoppedAt: null });
  if (hold === 'child') expect(original.children).toMatchObject([{ runStatus: 'running', stopConfirmed: false, stoppedAt: null }]);
  const rootRunId = original.task.attempt.runId!, foreground = await f.foregroundAgent();
  await observed(f.foregroundEntered.promise);
  expect(need(await f.app.queryRuntimeState()).active).toEqual({ kind: 'agent', runId: foreground.runId, sessionId: foreground.sessionId });
  expect(need(await f.app.querySession(foreground.sessionId))).toMatchObject({ runtimeKind: 'agent_session', nativeSessionId: expect.any(String) });
  expect(need(await f.app.cancelRun(foreground.runId))).toEqual({ accepted: true, runId: foreground.runId });
  await observed(f.foregroundStopped.promise); await observed(f.foregroundDisconnected.promise);
  expect(f.agentEvents.find(event => event.type === 'run_finished')).toMatchObject({ type: 'run_finished',
    result: { ok: true, data: { runId: foreground.runId, status: 'cancelled', stopped: true, error: { code: 'agent_cancelled' } } } });
  expect(need(await f.app.queryRun(foreground.runId))).toMatchObject({ status: 'cancelled', cancelRequestedAt: expect.any(String), stoppedAt: expect.any(String) });
  expect(need(await f.app.queryRuntimeState())).toMatchObject({ active: null, blocked: false });
  const afterCancel = need(await f.app.personalTasks.get(identity));
  expect(afterCancel.task).toEqual(original.task); expect(afterCancel.children).toEqual(original.children);
  expect(need(await f.app.queryRun(rootRunId))).toMatchObject({ status: 'running', cancelRequestedAt: null, stoppedAt: null });
  expect(f.foregroundWire).toHaveLength(1); expect(f.personalDisconnected).toEqual([]);
  f.responseRelease.resolve(); f.toolRelease.resolve();
  await observed(f.secondItemEntered.promise);
  await waitFor(async () => need(await f.app.personalTasks.get(identity)).task.stoppedAt !== null);
  const final = need(await f.app.personalTasks.get(identity)), work = await f.work(receipt.workId);
  expect(final.task).toMatchObject({ attempt: original.task.attempt, sessionId: original.task.sessionId, runStatus: 'completed',
    stopRequestedAt: null, stoppedAt: expect.any(String) });
  expect(work.work).toMatchObject({ status: 'open', execution: { runStatus: 'completed', requiresContinue: false, attempt: original.task.attempt } });
  expect(work.items.every(item => item.candidateRef !== null && item.disposition === 'unresolved')).toBe(true);
  if (hold === 'child') {
    expect(final.children).toMatchObject([{ childRunId: original.children[0]!.childRunId, originToolCallId: original.children[0]!.originToolCallId,
      runStatus: 'completed', resultRecorded: true, stopConfirmed: true, parentModelReceivedAt: expect.any(String) }]);
    expect(need(await f.app.queryRun(final.children[0]!.childRunId))).toMatchObject({ runtimeKind: 'durable', status: 'completed', cancelRequestedAt: null });
  }
  expect(f.personalWire).toHaveLength(hold === 'child' ? 9 : 6); expect(f.personalDisconnected).toEqual([]);
  expect(need(await f.app.personalTasks.list({ workId: receipt.workId })).items.map(task => task.attempt)).toEqual([original.task.attempt]);
  need(await f.app.close());
  const audit = new Database(f.paths.databaseFile, { readonly: true });
  try {
    expect(audit.query('SELECT id,run_id,stop_requested_at FROM invoice_work_attempts').all()).toEqual([
      { id: identity.attemptId, run_id: rootRunId, stop_requested_at: null }]);
    expect(audit.query('SELECT COUNT(*) count FROM invoice_work_phases WHERE consumed_at IS NOT NULL AND closed_at IS NOT NULL').get()).toEqual({ count: 2 });
    expect(audit.query('SELECT COUNT(*) count FROM invoice_work_attempt_stop_requests').get()).toEqual({ count: 0 });
    expect(audit.query('SELECT id,attempt_id,request_id,native_submission_id FROM invoice_work_phases WHERE id=?').get(originalPhase.phaseId))
      .toEqual({ id: originalPhase.phaseId, attempt_id: identity.attemptId, request_id: originalPhase.requestId, native_submission_id: expect.any(Number) });
    expect(audit.query('SELECT COUNT(*) count FROM fm_durable_tasks WHERE abort_requested<>0').get()).toEqual({ count: 0 });
    expect(audit.query('SELECT COUNT(*) count FROM fm_durable_submissions').get()).toEqual({ count: hold === 'child' ? 3 : 2 });
    expect(audit.query('SELECT s.runtime_kind,r.status FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=?').get(foreground.runId))
      .toEqual({ runtime_kind: 'agent_session', status: 'cancelled' });
  } finally { audit.close(); }
  expect(f.errors).toEqual([]);
}, 25_000);

test('formal Application close quiesces queued Personal work before the legacy Agent close returns', async () => {
  const f = await fixture('closing'), foreground = f.foreground(); await observed(f.foregroundEntered.promise);
  const created = await f.create([f.documentRefs[0]!]);
  const agent = need(await f.app.personalAgent.get());
  expect(created.execution).toMatchObject({ kind: 'queued', authorizationAccepted: true, attempt: { runId: null } });
  const closing = f.app.close();
  let startedDuringClose: boolean;
  try {
    await observed(f.legacyCloseEntered.promise);
    const request = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'rejected-during-close', goal: 'This valid new work must not be accepted during close.', documents: [f.documentRefs[0]!] };
    expect(await f.app.invoiceWorks.create(request)).toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(await f.app.personalTasks.resume({ workId: created.workId, attemptId: created.execution.attempt!.attemptId }))
      .toMatchObject({ ok: false, error: { code: 'runtime_closing' } });
    expect(need(await f.app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: agent.personalAgentId, requestId: created.requestId }))).toEqual(created);
    expect(need(await f.app.invoiceWorks.queryOperation({ operation: 'create', personalAgentId: agent.personalAgentId, requestId: request.requestId }))).toBeNull();
    expect(need(await f.app.invoiceWorks.list({ personalAgentId: agent.personalAgentId })).items.map(work => work.workId)).toEqual([created.workId]);
    expect(need(await f.app.personalTasks.list({ workId: created.workId })).items).toMatchObject([{ queued: true, stopRequestedAt: null }]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      startedDuringClose = await Promise.race([f.personalEntered.promise.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  } finally { f.legacyCloseRelease.resolve(); }
  expect(await closing).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
  expect(await foreground).toMatchObject({ status: 'failed', stopped: true, error: { code: 'runtime_shutdown' } });
  expect({ startedDuringClose, personalRequests: f.personalWire.length }).toEqual({ startedDuringClose: false, personalRequests: 0 });
  const audit = new Database(f.paths.databaseFile, { readonly: true });
  try {
    expect(audit.query('SELECT kind FROM runs').all()).toEqual([{ kind: 'provider' }]);
    expect(audit.query('SELECT COUNT(*) count FROM invoice_works').get()).toEqual({ count: 1 });
    expect(audit.query('SELECT COUNT(*) count FROM invoice_work_phases').get()).toEqual({ count: 0 });
  } finally { audit.close(); }
}, 15_000);
