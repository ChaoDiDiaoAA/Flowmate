import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';
import type { CandidateJobDetail, DocumentSnapshot, InvoiceWorkFeedback, PromptTraceResult, Result } from '@flowmate/contracts';
import { CandidateDraftSchema, invoiceHeaderFields, InvoiceWorkCreateReceiptSchema, InvoiceWorkGetResultSchema, InvoiceWorkSupplementReceiptSchema, InvoiceWorkTimelinePageSchema, PersonalTaskGetResultSchema } from '@flowmate/contracts';
import { controlledHost, invoke } from './support/personal-agent-host.ts';
import { stream } from './support/personal-agent-stream.ts';
import { waitFor } from '../../tests/support/resources.ts';
import { scenario } from './report.ts';
import { scenarios } from './scenarios.ts';

it('records HTTP and visible output timings on the original Durable Run', scenario('model-timing', async ({ check, refs, measurements }) => {
  const { client, agent, document, wire } = await controlledHost();
  const created = await invoke(client, { type: 'invoice_work_create', input: {
    personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
    requestId: 'eval-personal-timing', goal: 'Read the synthetic invoice.', documents: [document.documentRef],
  } }, InvoiceWorkCreateReceiptSchema);
  const taskCommand = { type: 'personal_task_get', input: { workId: created.workId, attemptId: created.execution.attempt!.attemptId, limit: 10 } } as const;
  await waitFor(async () => (await invoke(client, taskCommand, PersonalTaskGetResultSchema)).task.stoppedAt !== null);
  const task = (await invoke(client, taskCommand, PersonalTaskGetResultSchema)).task;
  const trace = await client.request({ type: 'query_prompt_trace', runId: task.attempt.runId! }) as Result<PromptTraceResult>;
  expect(trace).toMatchObject({ ok: true, data: { availability: 'available', calls: [{
    runId: task.attempt.runId, sessionId: task.sessionId, durable: { workId: task.workId, attemptId: task.attempt.attemptId },
    timing: { transport: 'entered', outcome: 'done', attempts: [{ status: 200, outcome: 'headers' }] },
  }] } });
  if (!trace.ok) throw Error(trace.error.code);
  const timing = trace.data.calls[0]!.timing!;
  Object.assign(measurements, { elapsedMs: timing.elapsedMs, budgetMs: timing.budgetMs, beforeHttpMs: timing.beforeHttpMs,
    headersMs: timing.attempts[0]?.headersMs ?? null, firstTextMs: timing.firstTextMs });
  expect(timing.budgetMs).toBeGreaterThanOrEqual(0);
  expect(timing.firstTextMs).toBeGreaterThanOrEqual(timing.beforeHttpMs!);
  expect(timing.elapsedMs).toBeGreaterThanOrEqual(timing.firstTextMs!);
  expect(JSON.stringify(trace)).not.toContain('Review the original invoice');
  expect(wire).toHaveLength(1);
  Object.assign(refs, { workId: task.workId, attemptId: task.attempt.attemptId, runId: task.attempt.runId, phaseId: trace.data.calls[0]!.durable?.phaseId });
  check('http-status', 200, timing.attempts[0]?.status ?? null);
  check('visible-output', true, timing.firstTextMs !== null);
  check('provider-calls', 1, wire.length);
}), scenarios['model-timing'].timeoutMs);

it('identifies an HTTP failure even when the model produced no visible text', scenario('provider-failure', async ({ check, refs, measurements }) => {
  const { client, agent, document, wire } = await controlledHost({ respond: () => new Response('Synthetic unavailable', { status: 503 }) });
  const created = await invoke(client, { type: 'invoice_work_create', input: {
    personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
    requestId: 'eval-personal-http-error', goal: 'Read the synthetic invoice.', documents: [document.documentRef],
  } }, InvoiceWorkCreateReceiptSchema);
  const command = { type: 'personal_task_get', input: { workId: created.workId, attemptId: created.execution.attempt!.attemptId, limit: 10 } } as const;
  await waitFor(async () => (await invoke(client, command, PersonalTaskGetResultSchema)).task.stoppedAt !== null);
  const { task } = await invoke(client, command, PersonalTaskGetResultSchema);
  const trace = await client.request({ type: 'query_prompt_trace', runId: task.attempt.runId! }) as Result<PromptTraceResult>;
  expect(trace).toMatchObject({
    ok: true, data: { calls: [{ timing: { outcome: 'error', firstTextMs: null, attempts: [{ status: 503, outcome: 'headers' }] } }] },
  });
  expect(wire).toHaveLength(1);
  if (!trace.ok) throw Error(trace.error.code);
  measurements.headersMs = trace.data.calls[0]!.timing!.attempts[0]?.headersMs ?? null;
  Object.assign(refs, { workId: task.workId, attemptId: task.attempt.attemptId, runId: task.attempt.runId, phaseId: trace.data.calls[0]!.durable?.phaseId });
  check('http-status', 503, trace.data.calls[0]!.timing!.attempts[0]?.status ?? null);
  check('no-visible-output', null, trace.data.calls[0]!.timing!.firstTextMs);
  check('provider-calls', 1, wire.length);
}), scenarios['provider-failure'].timeoutMs);

it('keeps observations for two simultaneously submitted Works separate', scenario('work-isolation', async ({ check, refs }) => {
  const { client, agent, document, wire } = await controlledHost();
  const create = (suffix: string) => invoke(client, { type: 'invoice_work_create', input: {
    personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
    requestId: 'eval-personal-isolation-' + suffix, goal: 'Read synthetic invoice ' + suffix, documents: [document.documentRef],
  } }, InvoiceWorkCreateReceiptSchema);
  const works = await Promise.all([create('a'), create('b')]);
  const traces = await Promise.all(works.map(async work => {
    const command = { type: 'personal_task_get', input: { workId: work.workId, attemptId: work.execution.attempt!.attemptId, limit: 10 } } as const;
    await waitFor(async () => (await invoke(client, command, PersonalTaskGetResultSchema)).task.stoppedAt !== null);
    const { task } = await invoke(client, command, PersonalTaskGetResultSchema);
    const trace = await client.request({ type: 'query_prompt_trace', runId: task.attempt.runId! }) as Result<PromptTraceResult>;
    if (!trace.ok || trace.data.calls.length !== 1) throw Error('Missing the original Work observation');
    return { work, call: trace.data.calls[0]! };
  }));
  refs.firstWorkId = works[0].workId;
  refs.secondWorkId = works[1].workId;
  check('original-work', true, traces.every(({ work, call }) => call.sessionId === work.sessionId && call.durable?.workId === work.workId));
  check('separate-observations', true, traces.every(({ call }) => Boolean(call.observationId))
    && traces[0].call.observationId !== traces[1].call.observationId);
  check('provider-calls', 2, wire.length);
}), scenarios['work-isolation'].timeoutMs);

it('keeps a candidate vote bound to its original execution after a newer candidate and Host restart', scenario('candidate-provenance', async ({ check, refs }) => {
  let document!: DocumentSnapshot;
  let candidate!: ReturnType<typeof CandidateDraftSchema.parse>;
  const f = await controlledHost({ tools: ['read_invoice_document', 'save_invoice_candidate'], sourceText: 'Total 113.00, tax 13.00',
    respond: count => stream(count % 2 ? { document, id: count, candidate } : 'Candidate saved.', 'personal-local-model') });
  document = f.document;
  const sourced = (normalized: string, quote: string) => ({ raw: normalized, normalized, state: 'present', alternatives: [],
    sources: [{ documentId: document.documentRef.id, version: document.documentRef.version, artifactId: document.parsedArtifactId, page: 1, blockId: 'b1', quote }] });
  candidate = CandidateDraftSchema.parse({ fields: { ...Object.fromEntries(invoiceHeaderFields.map(key => [key,
    { raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] }])),
    totalAmount: sourced('113.00', 'Total 113.00'), taxAmount: sourced('13.00', 'tax 13.00') }, lines: [], notes: [] });
  const created = await invoke(f.client, { type: 'invoice_work_create', input: {
    personalAgentId: f.agent.personalAgentId, expectedAgentRevision: f.agent.revision,
    requestId: 'eval-personal-feedback', goal: 'Save the original synthetic candidate.', documents: [document.documentRef],
  } }, InvoiceWorkCreateReceiptSchema);
  const task = { type: 'personal_task_get', input: { workId: created.workId, attemptId: created.execution.attempt!.attemptId, limit: 10 } } as const;
  await waitFor(async () => (await invoke(f.client, task, PersonalTaskGetResultSchema)).task.stoppedAt !== null);
  const readTimeline = () => invoke(f.client, { type: 'invoice_work_timeline', input: { workId: created.workId, limit: 50 } }, InvoiceWorkTimelinePageSchema);
  const timeline = await readTimeline();
  const entry = timeline.entries.find(event => event.kind === 'candidate_generated');
  expect(entry?.refs.toolCallId).toBeGreaterThan(0);
  if (!entry?.refs.candidateRef || entry.itemId === null) throw Error('Missing original candidate receipt');
  if (!entry.refs.jobId) throw Error('Missing candidate Job');
  const committed = await f.client.request({ type: 'query_job_candidate', input: { jobId: entry.refs.jobId, candidateId: entry.refs.candidateRef.id } }) as Result<CandidateJobDetail>;
  if (!committed.ok) throw Error(committed.error.code);
  check('amount', 113, Number(committed.data.candidate.fields.totalAmount.normalized));
  check('tax', 13, Number(committed.data.candidate.fields.taxAmount.normalized));
  expect(committed.data.candidate.fields.totalAmount.sources).toMatchObject([{ documentId: document.documentRef.id, blockId: 'b1' }]);
  const detail = await invoke(f.client, { type: 'invoice_work_get', input: { view: 'item', workId: created.workId, itemId: entry.itemId, limit: 10 } }, InvoiceWorkGetResultSchema);
  if (detail.view !== 'item' || !detail.todos[0]) throw Error('Missing synthetic invoice clarification');
  const supplemented = await invoke(f.client, { type: 'invoice_work_supplement', input: { workId: detail.work.workId,
    itemId: entry.itemId, todoId: detail.todos[0].todoId, expectedRevision: detail.work.revision,
    requestId: 'eval-personal-feedback-supplement', text: 'Review the original invoice total again.', materials: [] } }, InvoiceWorkSupplementReceiptSchema);
  expect(supplemented.execution.authorizationAccepted).toBe(true);
  const nextTask = { ...task, input: { ...task.input, attemptId: supplemented.execution.attempt!.attemptId } };
  await waitFor(async () => (await invoke(f.client, nextTask, PersonalTaskGetResultSchema)).task.stoppedAt !== null);
  const saves = (await readTimeline()).entries.filter(event => event.kind === 'candidate_generated' && event.itemId === entry.itemId);
  check('candidate-saves', 2, saves.length);
  const newer = saves.find(event => event.refs.candidateRef?.id !== entry.refs.candidateRef?.id);
  expect(newer?.refs.toolCallId).toBeGreaterThan(0);
  expect(newer?.refs.runId).not.toBe(entry.refs.runId);
  if (!newer?.refs.candidateRef || !newer.refs.toolCallId) throw Error('Missing newer candidate receipt');
  const restart = async () => {
    expect(await f.client.start(f.root, '0.1.0', resolve(import.meta.dirname, '../..'))).toMatchObject({ ok: true, data: { ready: true } });
  };
  expect(await f.client.close()).toMatchObject({ ok: true, data: { closed: true } });
  const legacy = new Database(join(f.root, 'data', 'app.sqlite'));
  try {
    const trigger = legacy.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='invoice_work_tool_call_preserved'").get();
    if (!trigger) throw Error('Missing provenance trigger');
    legacy.transaction(() => {
      // This fixture represents an older candidate with no Phase-to-ToolCall provenance.
      legacy.exec('DROP TRIGGER invoice_work_tool_call_preserved');
      legacy.query('DELETE FROM invoice_work_tool_calls WHERE tool_call_id=?').run(newer.refs.toolCallId!);
      legacy.exec(trigger.sql);
    })();
  } finally { legacy.close(); }
  await restart();
  const target = { workId: created.workId, itemId: entry.itemId, candidateId: entry.refs.candidateRef.id, candidateSequence: entry.refs.candidateRef.sequence };
  const submit = { type: 'invoice_work_feedback_submit', input: { ...target, helpful: true } } as const;
  const saved = await f.client.request(submit) as Result<InvoiceWorkFeedback>;
  expect(saved).toMatchObject({ ok: true, data: { ...target, helpful: true, association: {
    status: 'associated', attemptId: task.input.attemptId, runId: entry.refs.runId, toolCallId: entry.refs.toolCallId,
  } } });
  if (!saved.ok || saved.data.association.status !== 'associated') throw Error('Original candidate source unavailable');
  const { attemptId, phaseId, runId, toolCallId } = saved.data.association;
  Object.assign(refs, { workId: target.workId, itemId: target.itemId, candidateId: target.candidateId, attemptId, phaseId, runId, toolCallId });
  check('original-tool-call', entry.refs.toolCallId!, toolCallId);
  expect(await f.client.request(submit)).toEqual(saved);
  expect(await f.client.request({ ...submit, input: { ...target, itemId: target.itemId + 1, helpful: true } }))
    .toMatchObject({ ok: false });
  expect(await f.client.request({ ...submit, input: { ...target, helpful: false } }))
    .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  const newerTarget = { ...target, candidateId: newer.refs.candidateRef.id, candidateSequence: newer.refs.candidateRef.sequence };
  const unlinked = await f.client.request({ ...submit, input: { ...newerTarget, helpful: false } });
  expect(unlinked).toMatchObject({ ok: true, data: { helpful: false, association: { status: 'unavailable' } } });
  expect(await f.client.close()).toMatchObject({ ok: true, data: { closed: true } });
  await restart();
  expect(await f.client.request({ type: 'invoice_work_feedback_get', input: target })).toEqual(saved);
  expect(await f.client.request({ type: 'invoice_work_feedback_get', input: newerTarget })).toEqual(unlinked);
  const source = saved.data.association.source;
  expect(source?.callSequence).toBeGreaterThan(0);
  const recovered = await f.client.request({ type: 'query_prompt_trace', runId, callSequence: source?.callSequence }) as Result<PromptTraceResult>;
  expect(recovered).toMatchObject({ ok: true, data: { availability: 'available' } });
  check('original-model-call', true, recovered.ok && Array.isArray(recovered.data.calls) && Boolean(source?.observationId) && recovered.data.calls.some(call =>
    call.observationId === source?.observationId && call.durable?.nativeTaskId === source?.generationTaskId
    && call.callSequence === source?.callSequence));
  const persistedTimeline = await readTimeline();
  check('timeline-observations', true, persistedTimeline.entries.some(event =>
    event.refs.runId === runId && event.refs.nativeModelTaskId === source?.generationTaskId && event.summary.startsWith('Model observation')));
  expect(f.wire).toHaveLength(4);
  check('old-feedback', true, saved.data.helpful);
  check('legacy-unlinked', true, (unlinked as Result<InvoiceWorkFeedback>).ok && (unlinked as { data: InvoiceWorkFeedback }).data.association.status === 'unavailable');
  check('provider-calls', 4, f.wire.length);
}), scenarios['candidate-provenance'].timeoutMs);
