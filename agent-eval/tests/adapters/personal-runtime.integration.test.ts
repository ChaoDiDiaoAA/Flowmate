import { expect, test, spyOn } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { appError, fail, ok, CandidateDraftSchema, invoiceHeaderFields, PersonalAgentConfigurationSchema,
  type DocumentSnapshot, type InvoiceField, type InvoiceWorkWorkingContext, type ProviderConfig, type Result } from '@flowmate/contracts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import * as serviceLayout from '../../../packages/shared/src/service-layout.ts';
import * as management from '../../../packages/shared/src/service-management.ts';
import type { AgentTrial } from '../../src/adapters/agent.ts';
import type { CaseExecutionResult } from '../../src/types.ts';
import { readReport, type LocalReport } from '../../src/reports/store.ts';
import { exportEvents } from '../../src/langfuse/export.ts';
import { createHttpProvider, deferCleanup, mkdtempSync, waitFor } from '../../../tests/support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code + ': ' + result.error.message); return result.data; }
type Body = { messages: Array<{ role: string; content: unknown }> };
function reply(delta: Record<string, unknown>, tool = false) {
  return new Response('data: ' + JSON.stringify({ id: 'personal-engineering-response', model: 'personal-engineering-model',
    choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: tool ? 'tool_calls' : 'stop' }] })
    + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

// Engineering only: explicit product commands, not a new Case engine, quality Case, Judge or platform exporter.
async function fixture(trialId: string, key: string) {
  const directory = mkdtempSync(join(tmpdir(), 'flowmate-personal-eval-')), paths = need(resolveProductPaths(join(directory, 'product')));
  const sourceText = 'Invoice TEST-001; Issued 2026-10-29; Seller Original Seller; Buyer unreadable; Currency CNY; Net 100.00; Tax 13.00; Total 113.00; ' + trialId;
  const trial: AgentTrial = { identity: { executionId: 'personal-engineering', trialId, caseId: 'synthetic-personal-boundary', caseVersion: 1 },
    directory, requires: ['agent', 'invoice'], input: { prompt: 'Review this original invoice and retain human clarification until an explicit disposition.',
      materials: [{ sample: 'controlled-invoice', file: 'source.md', text: sourceText }] }, configuration: {} };
  const requests: Array<{ engine: 'agent_session' | 'durable'; body: Body; context: InvoiceWorkWorkingContext | null }> = [];
  let held: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  let document: DocumentSnapshot;
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer ' + key);
    const body = await request.json() as Body;
    const original = body.messages.find(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('{'));
    const context = original && typeof original.content === 'string' ? JSON.parse(original.content) as InvoiceWorkWorkingContext : null;
    requests.push({ engine: context === null ? 'agent_session' : 'durable', body, context });
    if (context === null) return reply({ content: 'The legacy AgentSession remains independent.' });
    expect(context.item.documentRef).toEqual(document.documentRef);
    if (held !== null) {
      const waiting = held; held = null; waiting.entered.resolve();
      await Promise.race([waiting.release.promise, new Promise<void>(resolve => {
        if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true });
      })]);
    }
    if (body.messages.some(message => message.role === 'tool')) return reply({ content: 'The saved original candidate still needs human clarification.' });
    const missing = { raw: null, normalized: null, state: 'missing' as const, alternatives: [], sources: [] };
    const source = { documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId,
      page: 1, blockId: 'b1', quote: sourceText };
    const fields: Record<string, InvoiceField> = Object.fromEntries(invoiceHeaderFields.map(name => [name, missing]));
    for (const [name, value] of Object.entries({ invoiceNumber: 'TEST-001', issueDate: '2026-10-29', sellerName: 'Original Seller',
      currency: 'CNY', netAmount: '100.00', taxAmount: '13.00', totalAmount: '113.00' }))
      fields[name] = { raw: value, normalized: value, state: 'present', alternatives: [], sources: [source] };
    fields.buyerName = { ...missing, sources: [source] };
    const candidate = CandidateDraftSchema.parse({ fields, lines: [], notes: [] });
    return reply({ tool_calls: [{ index: 0, id: 'personal-engineering-save-' + requests.length, type: 'function',
      function: { name: 'save_invoice_candidate', arguments: JSON.stringify({ documentId: document.documentRef.id, candidate }) } }] }, true);
  });
  deferCleanup(() => provider.stop());
  const config: ProviderConfig = { version: 1, name: 'engineering-eval-agent', revision: 1, credentialRef: 'engineering-eval-agent-credential',
    modelRef: { provider: 'controlled-personal-eval', model: 'personal-engineering-model' },
    native: { authPath: join(directory, 'eval-only-auth.json'), modelsPath: null },
    connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + provider.port + '/v1', contextWindow: 64000, maxTokens: 8192, reasoning: false },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  trial.configuration = { model: config.modelRef.model, api: config.connection!.api, baseUrl: config.connection!.baseUrl };
  const errors: string[] = [];
  const options: Parameters<typeof createApplication>[0] = { paths,
    runtimeDefaults: () => ok({ budget: { maxModelCalls: 16, maxToolCalls: 24 }, timeoutMs: 60000 }),
    logger: { write: event => { if (event.level === 'error') errors.push(event.code ?? event.event); }, close: async () => undefined },
    agentFactory: tools => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: key }),
    personalAgent: { defaultConfiguration: PersonalAgentConfigurationSchema.parse({ modelId: config.name, thinkingLevel: 'off',
      tools: ['read_invoice_document', 'save_invoice_candidate'], resources: { prompt: null, enabledSkills: [] },
      extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' }),
      resolveConfiguration: modelId => modelId === config.name ? ok(config) : fail(appError('model_not_configured', 'input', 'No other Trial model is available.')),
      readApiKey: original => original.credentialRef === config.credentialRef ? key : undefined } };
  let app = need(await createApplication(options)); deferCleanup(() => app.close());
  document = need(await app.importPreparedInvoiceMaterial({ contract: 'flowmate-prepared-invoice/v1', sample: 'controlled-invoice', sourceText,
    original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }] }));
  const create = async () => {
    const agent = need(await app.personalAgent.get());
    const request = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'create-original-work', goal: trial.input.prompt, documents: [document.documentRef] };
    return { request, receipt: need(await app.invoiceWorks.create(request)) };
  };
  const work = async (workId: number) => { const value = need(await app.invoiceWorks.get({ view: 'work', workId, limit: 100 }));
    if (value.view !== 'work') throw Error('Expected the original Work.'); return value; };
  const item = async (workId: number, itemId: number) => { const value = need(await app.invoiceWorks.get({ view: 'item', workId, itemId, limit: 100 }));
    if (value.view !== 'item') throw Error('Expected the original invoice item.'); return value; };
  const settled = async (workId: number) => {
    await waitFor(async () => { const tasks = need(await app.personalTasks.list({ workId, limit: 100 }));
      return tasks.items.length > 0 && tasks.items.every(task => task.stoppedAt !== null); }, 15000);
    return need(await app.personalTasks.list({ workId, limit: 100 }));
  };
  const counts = async () => {
    const works = need(await app.invoiceWorks.list({ personalAgentId: 1, limit: 100 }));
    let attempts = 0, candidates = 0, inputs = 0;
    for (const entry of works.items) {
      const saved = await work(entry.workId), tasks = need(await app.personalTasks.list({ workId: entry.workId, limit: 100 }));
      attempts += tasks.items.length;
      for (const item of saved.items) if (item.jobId !== null)
        candidates += need(await app.listJobCandidates({ jobId: item.jobId, limit: 100 })).items.length;
      const timeline = need(await app.invoiceWorks.timeline({ workId: entry.workId, limit: 100 }));
      expect(timeline.nextBefore).toBeNull(); inputs += timeline.entries.filter(entry => entry.kind === 'supplement_received').length;
    }
    return { works: works.items.length, attempts, candidates, inputs };
  };
  return { trial, paths, config, document, errors, requests, create, work, item, settled, counts, get app() { return app; },
    holdNext() { const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; held = gate;
      deferCleanup(() => gate.release.resolve()); return gate; },
    async reopen() { expect(need(await app.close())).toMatchObject({ closed: true, stopped: true }); app = need(await createApplication(options)); } };
}

function report(trial: AgentTrial, execution: CaseExecutionResult): LocalReport {
  return { contract: 'flowmate-agent-run/v1', executionId: trial.identity.executionId,
    dataset: { id: 'engineering-only', version: 1, subject: 'agent' }, selection: 'case', environment: 'isolated-local-engineering',
    startedAt: execution.startedAt ?? '2026-10-29T00:00:00.000Z', endedAt: execution.endedAt ?? '2026-10-29T00:00:01.000Z', repeat: 1, executionComplete: true,
    scoring: 'pending', manualReview: 'none', formalAcceptance: 'not-assessed', scoringConfiguration: { version: 1, judgeMode: 'off' },
    trials: [{ caseId: trial.identity.caseId, caseVersion: trial.identity.caseVersion, caseConditions: { task: { id: trial.identity.caseId, version: 1 } },
      caseName: 'Engineering boundary only', category: 'engineering', partition: 'smoke', repetition: 1,
      trialId: trial.identity.trialId, traceId: 'abcdef0123456789abcdef0123456789', status: 'UNJUDGEABLE',
      reason: 'Controlled local execution does not grade model quality or user efficiency.', counts: {}, execution, scores: [], judgeCalls: [], feedback: 'none' }],
    export: { backend: 'local', status: 'disabled' } };
}

test('one isolated engineering Trial retains original Personal Work through stop, saved-only supplement, reopen and continue while legacy stays AgentSession', async () => {
  const discovery = spyOn(serviceLayout, 'readDesktopServiceSelection').mockImplementation(() => { throw Error('Engineering Trials cannot discover production services.'); });
  const scm = spyOn(management, 'runServiceAction').mockImplementation(async () => { throw Error('Engineering Trials cannot manage Windows services.'); });
  try {
    const f = await fixture('trial-personal-original', 'synthetic-evaluation-agent-only'), identity = structuredClone(f.trial.identity);
    const legacy = need(await f.app.createSession({ title: 'Existing Case engine' })); expect(legacy.runtimeKind).toBe('agent_session');
    const accepted = need(await f.app.submitInput({ sessionId: legacy.sessionId, clientSequence: 1, mode: 'prompt', text: f.trial.input.prompt,
      config: f.config, timeoutMs: 10000, budget: { maxModelCalls: 2, maxToolCalls: 0 } }));
    await waitFor(async () => need(await f.app.queryRun(accepted.runId)).status === 'completed', 15000);
    const legacyRun = need(await f.app.queryRun(accepted.runId));
    expect(legacyRun).toMatchObject({ kind: 'agent', sessionId: legacy.sessionId, status: 'completed' });
    const created = await f.create(); await f.settled(created.receipt.workId);
    const original = await f.work(created.receipt.workId), selected = original.items[0]!, first = await f.item(original.work.workId, selected.itemId);
    expect(original.work.runtimeKind).toBe('durable'); expect(first.todos).toHaveLength(1);
    expect(first.todos[0]).toMatchObject({ action: 'supplement', fieldPath: 'fields.buyerName', applicable: true });
    const gate = f.holdNext(); let gateEntered = false;
    void gate.entered.promise.then(() => { gateEntered = true; });
    const triggered = need(await f.app.invoiceWorks.supplement({ workId: original.work.workId, itemId: selected.itemId, todoId: first.todos[0]!.todoId,
      requestId: 'first-original-buyer-clarification', expectedRevision: original.work.revision,
      text: 'Recheck this original invoice against the first saved clarification.', materials: [] }));
    expect(triggered.execution.authorizationAccepted).toBe(true);
    await waitFor(async () => gateEntered, 10000);
    const running = await f.work(original.work.workId);
    need(await f.app.personalTasks.stop({ workId: original.work.workId, attemptId: triggered.execution.attempt!.attemptId,
      requestId: 'stop-original-attempt', expectedRevision: running.work.revision }));
    gate.release.resolve(); await f.settled(original.work.workId);
    const stopped = await f.work(original.work.workId), todo = (await f.item(original.work.workId, selected.itemId)).todos[0]!;
    const supplement = { workId: original.work.workId, itemId: selected.itemId, todoId: todo.todoId,
      requestId: 'original-buyer-clarification', expectedRevision: stopped.work.revision, text: 'Retain this buyer clarification for the original invoice.', materials: [] };
    const saved = need(await f.app.invoiceWorks.supplement(supplement)); expect(saved.execution.authorizationAccepted).toBe(false);
    expect((await f.item(original.work.workId, selected.itemId)).todos[0]).toMatchObject({ todoId: todo.todoId, applicable: true });
    const beforeReopen = f.requests.length, beforeCounts = await f.counts();
    await f.reopen();
    expect(f.trial.identity).toEqual(identity); expect(await f.counts()).toEqual(beforeCounts);
    expect(await f.app.invoiceWorks.create(created.request)).toEqual(ok(created.receipt));
    expect(await f.app.invoiceWorks.supplement(supplement)).toEqual(ok(saved));
    expect((await f.work(original.work.workId)).work.execution.requiresContinue).toBe(true); expect(f.requests).toHaveLength(beforeReopen);
    const pending = await f.work(original.work.workId);
    need(await f.app.invoiceWorks.continueWork({ workId: original.work.workId, requestId: 'continue-original-after-reopen',
      expectedRevision: pending.work.revision, expectedAttemptId: triggered.execution.attempt!.attemptId }));
    const tasks = await f.settled(original.work.workId), final = await f.work(original.work.workId);
    expect(final.work).toMatchObject({ workId: original.work.workId, sessionId: original.work.sessionId, goal: f.trial.input.prompt,
      status: 'open', counts: { total: 1, unresolved: 1 } });
    expect(final.items.map(item => item.documentRef)).toEqual([f.document.documentRef]);
    expect(tasks.items.map(task => task.runStatus).sort()).toEqual(['cancelled', 'completed', 'completed']);
    expect(await f.counts()).toMatchObject({ works: 1, attempts: 3, candidates: 2, inputs: 2 });
    expect(f.requests.filter(request => request.engine === 'agent_session')).toHaveLength(1);
    expect(f.requests.filter(request => request.engine === 'durable')).toHaveLength(5);
    expect(f.requests.at(-1)!.context!.userInputs.map(input => input.inputId)).toContain(saved.inputId);
    const runs = await Promise.all(tasks.items.map(task => f.app.queryRun(task.attempt.runId!).then(need)));
    expect(runs.every(run => 'runtimeKind' in run && run.runtimeKind === 'durable')).toBe(true);
    const execution: CaseExecutionResult = { identity, started: true, status: 'completed', endpointReached: false,
      input: structuredClone(f.trial.input), answer: null, artifacts: [],
      observations: [legacyRun, ...runs].map(run => ({ id: 'attempt-run-' + run.runId, kind: 'span',
        name: run.runId === legacyRun.runId ? 'Legacy AgentSession reference' : 'Original Personal attempt',
        startedAt: run.startedAt!, endedAt: run.endedAt, output: { runId: run.runId, status: run.status } })),
      configuration: structuredClone(f.trial.configuration), usage: { modelRequests: f.requests.length, cost: null, inputTokens: null, outputTokens: null },
      startedAt: legacyRun.startedAt, endedAt: new Date().toISOString(), evidence: { 'personal-runtime': { present: true,
        actual: { work: final.work, attempts: tasks.items, supplement: saved, quality: null, userEfficiency: null }, source: 'Public product queries in one engineering Trial' } } };
    const beforeRead = await f.counts(), requests = f.requests.length;
    const events = exportEvents(report(f.trial, execution));
    expect(events.filter(event => event.type === 'trace-create')).toHaveLength(1);
    expect(events.filter(event => event.type === 'span-create' && event.body.name === 'Original Personal attempt')).toHaveLength(3);
    expect(events.filter(event => event.type === 'span-create' && event.body.name === 'Legacy AgentSession reference')).toHaveLength(1);
    expect(events.filter(event => event.type === 'trace-create')[0]!.body.metadata).toMatchObject({ trialId: identity.trialId });
    expect(JSON.stringify(events)).not.toContain('synthetic-evaluation-agent-only');
    expect(await f.counts()).toEqual(beforeRead); expect(f.requests).toHaveLength(requests);
    expect(discovery).not.toHaveBeenCalled(); expect(scm).not.toHaveBeenCalled(); expect(f.errors).toEqual([]);
  } finally { discovery.mockRestore(); scm.mockRestore(); }
}, 45000);

test('independent engineering Trials isolate product roots, native histories and dedicated credentials; old reports remain unknown and read-only', async () => {
  const first = await fixture('TRIAL_ONLY_FIRST', 'synthetic-first-eval-key'), second = await fixture('TRIAL_ONLY_SECOND', 'synthetic-second-eval-key');
  expect(first.paths.root).not.toBe(second.paths.root); expect(first.trial.identity.trialId).not.toBe(second.trial.identity.trialId);
  const created = await first.create(); await first.settled(created.receipt.workId);
  expect(need(await second.app.invoiceWorks.list({ personalAgentId: 1, limit: 100 })).items).toEqual([]);
  expect(await second.counts()).toMatchObject({ works: 0, attempts: 0, candidates: 0, inputs: 0 });
  const other = await second.create(); await second.settled(other.receipt.workId);
  expect(first.requests.map(request => JSON.stringify(request.body)).join('')).not.toContain(second.trial.identity.trialId);
  expect(second.requests.map(request => JSON.stringify(request.body)).join('')).not.toContain(first.trial.identity.trialId);
  expect(first.requests).toHaveLength(2); expect(second.requests).toHaveLength(2);
  expect(existsSync(join(first.paths.root, 'service-installation.json'))).toBe(false);
  expect(existsSync(join(second.paths.root, 'security/service-credentials'))).toBe(false);
  const oldExecution: CaseExecutionResult = { identity: first.trial.identity, started: false, status: 'not-started', endpointReached: false,
    input: first.trial.input, answer: null, artifacts: [], observations: [], evidence: {}, configuration: {}, usage: {}, startedAt: null, endedAt: null };
  const historical = report(first.trial, oldExecution); delete historical.trials[0]!.caseConditions;
  const file = join(first.trial.directory, 'legacy-report.json'), bytes = JSON.stringify(historical); writeFileSync(file, bytes);
  const before = [first.requests.length, second.requests.length], counts = await Promise.all([first.counts(), second.counts()]);
  const loaded = readReport(file);
  expect(loaded.history?.verification).toBe('unverified');
  expect(loaded.trials[0]!.execution!.evidence['personal-runtime']).toBeUndefined();
  expect(loaded.trials[0]!.execution!.usage.cost).toBeUndefined();
  expect(() => exportEvents(loaded)).toThrow('Historical reports are read-only');
  expect(readFileSync(file, 'utf8')).toBe(bytes); expect(await Promise.all([first.counts(), second.counts()])).toEqual(counts);
  expect([first.requests.length, second.requests.length]).toEqual(before); expect([first.errors, second.errors]).toEqual([[], []]);
}, 30000);
