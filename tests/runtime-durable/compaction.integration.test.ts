import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { CompactionTask, configure, createRegistry, GenerationTask, Harness, hook, LiveDoc, StorageRequestError, type EntryId, type TaskId } from '@earendil-works/pi-durable';
import { appError, fail, ok, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createDatabaseCoordinator } from '../../packages/core/src/storage/write-coordinator.ts';
import { createDurableModels, prepareDurableModelBinding, type DurableModelAccess } from '../../packages/runtime-durable/src/models.ts';
import { createDurableSqliteStorage } from '../../packages/runtime-durable/src/storage.ts';
import { createDurableCompactionRuntime } from '../../packages/runtime-durable/src/compaction.ts';

const context = BACKGROUND_CONTEXT;
const query = { workId: 7, sessionId: 70, attemptId: 700, requestId: 'original-compression-phase' };
function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
function answer(text: string) {
  const chunk = { id: 'original-response', object: 'chat.completion.chunk', created: 1, model: 'compaction-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(hold = false, api: 'openai-completions' | 'google-generative-ai' = 'openai-completions') {
  const coordinator = createDatabaseCoordinator(new Database(':memory:'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const requests: Array<{ summary: boolean; key: string | null; body: { messages?: Array<{ role: string; content?: unknown }>; tools?: unknown[] } }> = [];
  let building = true, allowed = true, normalChecks = 0, projections = 0, reserved = 0, key = 'before-reopen';
  const server = Bun.serve({ port: 0, fetch: async request => {
    const body = await request.json() as typeof requests[number]['body'];
    const summary = JSON.stringify(body).includes('context summarization assistant');
    requests.push({ summary, key: request.headers.get('authorization'), body });
    if (summary && hold && requests.filter(item => item.summary).length === 1) { entered.resolve(); await release.promise; }
    const text = summary ? 'NATIVE-ORIGINAL-SUMMARY' : `NATIVE-SAME-PHASE-ASSISTANT:${'y'.repeat(90000)}`;
    return api === 'google-generative-ai' ? new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : answer(text);
  } });
  const config: ProviderConfig = { version: 1, name: 'compaction-profile', revision: 1,
    modelRef: { provider: 'compaction-controlled', model: 'compaction-model' }, native: { authPath: 'unused.json', modelsPath: null },
    connection: { api, baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 256000, maxTokens: 16384 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const binding = need(await prepareDurableModelBinding(config));
  let compactions: ReturnType<typeof createDurableCompactionRuntime>;
  let storage = await createDurableSqliteStorage(coordinator), registry = createRegistry();
  const access: DurableModelAccess = { readApiKey: () => key,
    verifyModelUse: () => { normalChecks++; return building ? ok(undefined) : fail(appError('normal_generation_blocked', 'runtime', 'This closed input cannot generate again.')); },
    reserveModelRequest: () => ok(undefined),
    readCompactionUse: (signal, model) => compactions ? compactions.modelUse(signal, model) : Promise.resolve(ok(null)) };
  let source = need(await createDurableModels(config, access, binding));
  let harness = await Harness.open(storage, { models: source.models, registry,
    settings: { compaction: { enabled: false }, retry: { enabled: false }, stream: { maxRetries: 0, deferred: false }, afterFailedRun: 'keep' } }, context);
  const conversationId = (await harness.commit(async tx => {
    const record = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    await configure(tx, record.id, { model: source.modelRef, thinkingLevel: 'off', tools: [], modelTools: [] }); return record;
  }, context)).id;
  const conversation = (await harness.conversation(conversationId, context))!;
  const submission = await conversation.submit({ type: 'input', requestId: JSON.stringify([query.attemptId, query.requestId]),
    content: `NATIVE-SAME-PHASE-USER:${'x'.repeat(90000)}`, entry: { kind: 'flowmate.input', data: query } }, context);
  await submission.wait(context);
  const original = (await storage.submission(submission.id, context))!;
  if (original.type !== 'input' || original.entry === undefined) throw Error('Expected an actual original input.');
  const tail = (await storage.scanEntries({ conversationId }, 1, undefined, context)).items[0]!.id;
  const plan = { ...query, operationId: 'original-compaction', reason: 'manual' as const, expectedTailEntryId: tail,
    instructions: 'Retain exact evidence references.', binding, thinkingLevel: 'off' as const };
  const callbacks = { readPlan: async () => ok(plan), verify: async () => allowed ? ok(undefined)
    : fail(appError('compaction_revoked', 'runtime', 'Original compaction permission was revoked.')),
  reserveModelRequest: async () => { reserved++; return ok(undefined); } };
  const openCompactions = () => createDurableCompactionRuntime({ harness, storage, registry, models: source.models, callbacks,
    resolvePhase: async () => ({ ...query, nativeConversationId: conversationId, nativeSubmissionId: submission.id, nativeEntryId: original.entry!, model: source.modelRef }),
    read: <T>(action: () => Promise<T>) => action(), isClosed: () => false, isStopping: () => false });
  compactions = openCompactions(); building = false;
  access.readWorkingContext = () => { projections++; return fail(appError('generation_projection_used', 'runtime', 'Summaries must retain their native request.')); };
  return { coordinator, binding, plan, entered, release, requests, get storage() { return storage; }, get harness() { return harness; }, get registry() { return registry; },
    get compactions() { return compactions; }, conversationId, originalEntry: original.entry,
    counters: () => ({ normalChecks, projections, reserved }), revoke: () => { allowed = false; },
    async restart() {
      await harness.close(context); release.resolve(); key = 'after-reopen';
      storage = await createDurableSqliteStorage(coordinator); registry = createRegistry();
      source = need(await createDurableModels(config, access, binding));
      harness = await Harness.open(storage, { models: source.models, registry,
        settings: { compaction: { enabled: false }, retry: { enabled: false }, stream: { maxRetries: 0, deferred: false } } }, context);
      compactions = openCompactions();
    },
    async close() { release.resolve(); await harness.close(context); await coordinator.close(); server.stop(true); } };
}

test('the official CompactionTask keeps its summary request, original entries and operation identity despite the generation working-set adapter', async () => {
  const f = await fixture();
  try {
    const before = f.counters(), started = need(await f.compactions.start(f.plan));
    await f.harness.waitForTask(started.nativeTaskId as TaskId, context);
    const saved = need(await f.compactions.observe(f.plan));
    expect(saved).toMatchObject({ nativeTaskId: started.nativeTaskId, outcome: 'completed', writeStatus: 'done', summarySaved: true });
    expect(saved!.summaryEntryId!).toBeGreaterThan(0);
    expect(f.counters()).toEqual({ ...before, reserved: 1 });
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.body.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(f.requests[1]!.body)).toContain('NATIVE-SAME-PHASE-USER');
    expect((await f.storage.entry(f.originalEntry as EntryId, context))?.entry.kind).toBe('flowmate.input');
    const found = await f.storage.entry(saved!.summaryEntryId as EntryId, context);
    if (!found) throw Error(JSON.stringify({ saved, entries: (await f.storage.scanEntries({ conversationId: f.conversationId }, 20, undefined, context)).items.map(entry => ({ id: entry.id, kind: entry.kind })) }));
    const summary = found.entry;
    expect(summary.kind).toBe('pi.compaction'); expect(JSON.stringify(summary)).toContain('NATIVE-ORIGINAL-SUMMARY');
    expect(need(await f.compactions.start(f.plan))?.nativeTaskId).toBe(started.nativeTaskId);
    for (let i = 0; i < 3; i++) need(await f.compactions.observe(f.plan));
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 15000);

test('compaction rejects a changed owner or operation intent and never replays the original completed summary', async () => {
  const f = await fixture();
  try {
    const started = need(await f.compactions.start(f.plan)); await f.harness.waitForTask(started.nativeTaskId as TaskId, context);
    expect(await f.compactions.observe({ ...f.plan, workId: 8 })).toMatchObject({ ok: false });
    expect(await f.compactions.start({ ...f.plan, instructions: 'Changed original summary purpose.' })).toMatchObject({ ok: false });
    expect(await f.compactions.start({ ...f.plan, expectedTailEntryId: f.originalEntry })).toMatchObject({ ok: false });
    expect(need(await f.compactions.start(f.plan)).nativeTaskId).toBe(started.nativeTaskId);
    expect(f.requests).toHaveLength(2); expect(f.counters().reserved).toBe(1);
  } finally { await f.close(); }
}, 15000);

test('cancelling a real in-flight compaction stops only its original task and preserves the original input', async () => {
  const f = await fixture(true);
  try {
    const started = need(await f.compactions.start(f.plan)); await f.entered.promise;
    const accepted = need(await f.compactions.cancel(f.plan)); expect(typeof accepted.cancelRequestedAt).toBe('string');
    await f.harness.waitForTask(started.nativeTaskId as TaskId, context);
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ nativeTaskId: started.nativeTaskId, nativeTaskStatus: 'terminal', outcome: 'aborted', summaryGenerated: false, summarySaved: false, stopped: true });
    expect((await f.storage.task(started.nativeTaskId as TaskId, context))?.abortRequested).toBe(true);
    expect((await f.storage.entry(f.originalEntry as EntryId, context))?.entry.kind).toBe('flowmate.input');
    expect(need(await f.compactions.start(f.plan)).nativeTaskId).toBe(started.nativeTaskId);
    expect(f.requests).toHaveLength(2); expect(f.counters().reserved).toBe(1);
  } finally { await f.close(); }
}, 15000);

test('a compaction whose permission is revoked while its HTTP is in flight records usage and keeps the original history without a summary', async () => {
  const f = await fixture(true);
  try {
    const started = need(await f.compactions.start(f.plan)); await f.entered.promise; f.revoke(); f.release.resolve();
    await f.harness.waitForTask(started.nativeTaskId as TaskId, context);
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ nativeTaskId: started.nativeTaskId, outcome: 'faulted',
      summarySaved: false, stopped: true, usage: { source: 'sdk', attempts: 1 } });
    expect((await f.storage.entry(f.originalEntry as EntryId, context))?.entry.kind).toBe('flowmate.input');
    expect(need(await f.compactions.start(f.plan)).nativeTaskId).toBe(started.nativeTaskId); expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 15000);

test('native SDK summary usage survives a provider without observable custom fetch and never invents an HTTP attempt count', async () => {
  const f = await fixture(false, 'google-generative-ai');
  try {
    const started = need(await f.compactions.start(f.plan)); await f.harness.waitForTask(started.nativeTaskId as TaskId, context);
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ outcome: 'completed', summarySaved: true,
      usage: { source: 'sdk', attempts: null, attemptsComplete: false, sdkValues: { input: 10, output: 5, totalTokens: 15 } } });
    expect(f.requests).toHaveLength(2); expect(f.counters().reserved).toBe(1);
  } finally { await f.close(); }
}, 15000);

test('a lost native creation receipt reopens the one committed operation and official task instead of creating another summary', async () => {
  const f = await fixture(), commit = f.storage.commit.bind(f.storage); let lost = false;
  f.storage.commit = async (batch, native) => {
    const seq = await commit(batch, native);
    if (!lost && batch.some(write => write.type === 'task' && write.value.kind === CompactionTask.definition.name)) {
      lost = true; throw new StorageRequestError('Controlled lost receipt after the actual native creation commit.');
    }
    return seq;
  };
  try {
    expect(await f.compactions.start(f.plan)).toMatchObject({ ok: false }); expect(lost).toBe(true);
    await f.restart();
    const original = need(await f.compactions.observe(f.plan)); expect(original!.nativeTaskId).toBeGreaterThan(0);
    expect(need(await f.compactions.start(f.plan)).nativeTaskId).toBe(original!.nativeTaskId);
    expect(f.requests).toHaveLength(1);
    need(await f.compactions.restoreAll()); f.harness.resume(); await f.harness.waitForTask(original!.nativeTaskId as TaskId, context);
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ nativeTaskId: original!.nativeTaskId, summarySaved: true, stopped: true });
    const tasks = await f.storage.scanTasks({ kind: CompactionTask.definition.name }, 10, undefined, context);
    expect(tasks.items.map(task => Number(task.id))).toEqual([original!.nativeTaskId]); expect(f.requests).toHaveLength(2); expect(f.counters().reserved).toBe(1);
  } finally { await f.close(); }
}, 15000);

test('an ended native summary task does not prove its queued write stopped; original-attempt cleanup withdraws that write only', async () => {
  const f = await fixture(true), generationEntered = Promise.withResolvers<void>(), generationRelease = Promise.withResolvers<void>();
  try {
    const started = need(await f.compactions.start(f.plan)); await f.entered.promise;
    f.registry.install({ name: 'controlled-live-generation', hooks: [hook(GenerationTask, { beforeRequest: async (_request, _api, native) => {
      generationEntered.resolve(); await Promise.race([generationRelease.promise, new Promise<void>(resolve => native.abortSignal?.addEventListener('abort', () => resolve(), { once: true }))]);
      return undefined;
    } })] });
    const conversation = (await f.harness.conversation(f.conversationId, context))!;
    const next = await conversation.submit({ type: 'input', requestId: 'actual-other-native-input', content: 'Another actual SDK input.',
      entry: { kind: 'flowmate.input', data: { ...query, attemptId: 701, requestId: 'other-attempt' } } }, context);
    await generationEntered.promise;
    const live = await f.harness.snapshot(LiveDoc, f.conversationId, context), otherTaskId = live!.run!.taskId;
    f.release.resolve(); await f.harness.waitForTask(started.nativeTaskId as TaskId, context);
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ nativeTaskStatus: 'terminal', outcome: 'completed', writeStatus: 'queued', summaryGenerated: true, summarySaved: false, stopped: false });
    need(await f.compactions.stopAttempt(query));
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ writeStatus: 'unanswered', summaryGenerated: true, summarySaved: false, stopped: true });
    expect((await f.storage.task(otherTaskId, context))?.abortRequested).toBe(false);
    expect((await f.storage.submission(next.id, context))?.status).toBe('placed'); expect(f.requests).toHaveLength(2);
    await conversation.abort(context, { background: true });
  } finally { generationRelease.resolve(); await f.close(); }
}, 15000);

test('a service interruption resumes the same official summarize checkpoint using the current key without cancelling or duplicating the operation', async () => {
  const f = await fixture(true);
  try {
    const started = need(await f.compactions.start(f.plan)); await f.entered.promise;
    await f.restart();
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ nativeTaskId: started.nativeTaskId, outcome: null, cancelRequestedAt: null });
    expect(f.requests).toHaveLength(2);
    need(await f.compactions.restoreAll()); f.harness.resume();
    await f.harness.waitForTask(started.nativeTaskId as TaskId, context);
    expect(need(await f.compactions.observe(f.plan))).toMatchObject({ nativeTaskId: started.nativeTaskId, outcome: 'completed', writeStatus: 'done' });
    expect(f.requests).toHaveLength(3); expect(f.requests.at(-1)!.key).toBe('Bearer after-reopen');
    expect(f.counters().reserved).toBe(2); expect(f.counters().projections).toBe(0);
  } finally { await f.close(); }
}, 15000);
