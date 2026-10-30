import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { ToolExecutionFailure, type Result } from '@flowmate/contracts';
import { createFileStore } from '../../../packages/core/src/storage/file-store.ts';
import { createResearchPlanTool } from '../../../packages/core/src/research/tools.ts';
import { createResearchReadTools } from '../../../packages/core/src/research/read-tools.ts';
import { createResearchSynthesisTools, readResearchEvidence } from '../../../packages/core/src/research/synthesis-tools.ts';
import { researchEvidenceRef } from '../../../packages/core/src/research/source-text.ts';
import { createToolExecutor } from '../../../packages/core/src/tools/executor.ts';
import { openTestDatabase } from '../../support/database.ts';
import { researchPlan } from '../../support/research.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-28T00:00:00.000Z', text = '\ufeffOriginal research evidence 😀\nMetered usage.';
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const failure = (error: unknown) => error instanceof ToolExecutionFailure ? error.error : error;

async function fixture(researching = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-owner-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs') };
  const database = need(openTestDatabase(paths)), files = createFileStore(paths, database);
  mkdirSync(join(paths.artifactsDir, '1')); writeFileSync(join(paths.artifactsDir, '1', 'source.txt'), text);
  const policy = { web: false, domains: [], documentIds: [], artifactIds: [1] };
  const body = { ...researchPlan, sourcePolicy: policy };
  const scope = { version: 2 as const, allowedDocumentIds: [], allowedArtifactIds: [1], allowedResourcePaths: [],
    allowedTools: ['save_research_plan', 'read_research_local', 'query_research_evidence', 'save_research_claim', 'save_research_report'] };
  const initial = await database.transaction(store => {
    need(store.research.registerMaterial({ artifactId: 1, kind: 'original', relativePath: 'artifacts/1/source.txt',
      bytes: Buffer.byteLength(text), mimeType: 'text/plain', createdAt: at, metadata: { version: 1,
        sourceKey: 'research-local-v1', sourceRecordId: 'Controlled evidence', sourceVersion: 'v1',
        files: [{ relativePath: 'source.txt', bytes: Buffer.byteLength(text), mimeType: 'text/plain' }] } }));
    store.contents.remember({ ownerKind: 'artifact', ownerId: '1', relativePath: 'source.txt' }, Buffer.from(text));
    const session = need(store.sessions.create({ nativeSessionId: 'research-owner', title: 'Research owner', at }));
    const task = need(store.research.create({ sessionId: session.sessionId, title: 'Owner study', sourcePolicy: policy, at }));
    const run = (phase: 'planning' | 'researching', plan: { planId: number; revision: number } | null) => {
      const row = store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,started_at)
        VALUES ('agent',?,?,'running','Isolated Research owner fixture','{}','{}','{}','{}',?,?)`)
        .run(session.sessionId, JSON.stringify(scope), at, at);
      const runId = Number(row.lastInsertRowid);
      return need(store.research.bindRun({ researchId: task.researchId, sessionId: session.sessionId, runId, phase, plan, at }));
    };
    const planning = run('planning', null);
    if (!researching) return { task, binding: planning };
    const call = need(store.toolCalls.request({ context: null, runId: planning.runId, sessionId: session.sessionId,
      nativeToolCallId: 'seed-plan', toolName: 'save_research_plan', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: body, requestedAt: at }));
    need(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: body }));
    need(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    const plan = need(store.research.savePlan({ researchId: task.researchId, runId: planning.runId, toolCallId: call.toolCallId, body, at }));
    need(store.toolCalls.finish({ toolCallId: call.toolCallId, result: { version: 1, committedCandidateId: null, status: 'succeeded', data: plan },
      cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] }, endedAt: at, stoppedAt: at }));
    store.db.query("UPDATE runs SET status='completed',output_json='{}',ended_at=?,stopped_at=? WHERE id=?").run(at, at, planning.runId);
    return { task, binding: run('researching', { planId: plan.planId, revision: plan.revision }) };
  });
  const context = { runId: initial.binding.runId, sessionId: initial.binding.sessionId, scope };
  const call = async (name: string) => database.transaction(store => {
    const result = need(store.toolCalls.request({ context: null, runId: context.runId, sessionId: context.sessionId,
      nativeToolCallId: name, toolName: name, toolVersion: '1', effect: name === 'read_research_local' || name === 'query_research_evidence' ? 'READ' : 'LOCAL_WRITE',
      rawArguments: {}, requestedAt: at }));
    need(store.toolCalls.fixArguments({ toolCallId: result.toolCallId, finalArguments: {} }));
    need(store.toolCalls.start({ toolCallId: result.toolCallId, startedAt: at }));
    return { toolCallId: result.toolCallId, nativeToolCallId: name, signal: new AbortController().signal };
  });
  return { root, paths, database, files, context, call, body, policy, ...initial };
}

async function hold(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const completion = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  return { release: release.resolve, completion };
}

async function source(f: Awaited<ReturnType<typeof fixture>>) {
  const call = await f.call('read_research_local');
  const published = need(await f.files.publishResearchSource({ researchId: f.task.researchId, toolCallId: call.toolCallId, text }));
  const saved = need(await f.database.transaction(store => store.research.saveSource({ researchId: f.task.researchId,
    runId: f.context.runId, toolCallId: call.toolCallId, source: { kind: 'local', address: 'artifact:1', title: 'Controlled evidence',
      artifactId: 1, documentId: null, ...published, fetchedAt: at, publishedAt: null, truncated: false }, at })));
  need(await f.database.transaction(store => store.toolCalls.finish({ toolCallId: call.toolCallId,
    result: { version: 1, committedCandidateId: null, status: 'succeeded', data: { source: saved } }, cleanup: { version: 1, stopped: true, stopReason: 'tool-completed', errors: [] },
    endedAt: at, stoppedAt: at })));
  return saved;
}

test.each([
  ['save_research_plan', 'research_plans'], ['read_research_local', 'research_sources'],
  ['save_research_claim', 'research_claims'], ['save_research_report', 'research_reports'],
] as const)('%s retains its unique successful business receipt after COMMIT response loss', async (name, table) => {
  const f = await fixture(name !== 'save_research_plan');
  let lost = false;
  const database: Pick<typeof f.database, 'read' | 'transaction'> = {
    read: operation => f.database.read(operation),
    transaction: async operation => {
      let wroteRecord = false;
      const receipt = await f.database.transaction(async store => {
        const before = store.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
        const value = await operation(store);
        wroteRecord = store.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count > before;
        return value;
      });
      if (wroteRecord && !lost) { lost = true; throw Error('Controlled Research response loss after actual COMMIT'); }
      return receipt;
    },
  };
  const definitions = [createResearchPlanTool(database, () => at),
    ...createResearchReadTools({ database, files: f.files, now: () => at,
      readDocument: () => { throw Error('This selected source is a local artifact'); } }),
    ...createResearchSynthesisTools({ database, files: f.files, now: () => at })];
  const executor = createToolExecutor({ database, definitions, now: () => at });
  const context = { ...f.context, signal: new AbortController().signal, nativeToolCallId: 'lost-research-receipt' };
  let body: unknown = name === 'save_research_plan' ? f.body : { artifactId: 1, documentId: null };
  if (name === 'save_research_claim' || name === 'save_research_report') {
    const saved = await source(f), ref = researchEvidenceRef(f.binding, saved, { start: 0, end: text.length, quote: text })!;
    const claim = { questionId: 'cost-1', text: 'The selected material states that usage is metered.', dependencies: [],
      evidence: [{ relation: 'supports', ref }], verification: { status: 'supported', reasons: ['The original body states the condition.'] } };
    body = claim;
    if (name === 'save_research_report') {
      expect((await executor.execute('save_research_claim', claim, { ...context, nativeToolCallId: 'seed-claim' })).result.status).toBe('succeeded');
      const claimId = need(await f.database.read(store => store.research.listClaims({ researchId: f.task.researchId, planId: f.binding.plan!.planId, limit: 10 }))).items[0]!.claimId;
      body = { answer: 'The selected evidence supports a metered condition.', sections: [{ title: 'Costs', text: 'Usage is metered.', claimIds: [claimId] }],
        conflicts: [], limitations: [], unresolvedQuestions: [], completeness: 'full',
        coverage: [{ questionId: 'cost-1', claimIds: [claimId], status: 'covered', reason: 'The saved claim has supporting evidence.' }] };
    }
  }
  const first = await executor.execute(name, body, context);
  expect(lost).toBe(true);
  const rows = await f.database.read(store => store.db.query<{ id: number; tool_call_id: number }, []>(`SELECT id,tool_call_id FROM ${table}`).all());
  expect(rows).toHaveLength(1); expect(rows[0]!.tool_call_id).toBe(first.call.toolCallId);
  if (name === 'save_research_plan' || name === 'save_research_report') {
    const task = need(await f.database.read(store => store.research.get(f.task.researchId)));
    expect(name === 'save_research_plan' ? task.currentPlanId : task.currentReportId).toBe(rows[0]!.id);
  }
  if (name === 'read_research_local') expect(await readResearchEvidence({ database, files: f.files },
    { researchId: f.task.researchId, sourceSnapshotId: rows[0]!.id }, f.policy)).toMatchObject({ ok: true, data: { excerpt: { quote: text } } });
  expect(first).toMatchObject({ fatal: false, call: { status: 'succeeded', cleanup: { stopped: true } }, result: { status: 'succeeded' } });
  const duplicate = await executor.execute(name, body, context);
  expect(duplicate.call).toEqual(first.call); expect(duplicate.result.status).toBe('succeeded');
  expect(await f.database.read(store => store.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get())).toEqual({ count: 1 });
});

test('Research plan saving waits for its owner and returns no receipt before actual COMMIT', async () => {
  const f = await fixture(), call = await f.call('save_research_plan'), blocker = await hold(f);
  const tool = createResearchPlanTool(f.database, () => at), transaction = f.database.transaction;
  const releaseCommit = Promise.withResolvers<void>(), commitEntered = Promise.withResolvers<void>();
  f.database.transaction = operation => transaction(async store => {
    const value = await operation(store);
    if (store.db.query('SELECT id FROM research_plans').get()) { commitEntered.resolve(); await releaseCommit.promise; }
    return value;
  });
  let settled = false;
  const pending = tool.execute(f.body, call, f.context).then(value => ({ value }), error => ({ error: failure(error) })).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false);
    blocker.release(); await blocker.completion; await commitEntered.promise;
    expect(settled).toBe(false); releaseCommit.resolve();
    expect(await pending).toMatchObject({ value: { researchId: f.task.researchId, revision: 1, body: f.body } });
  } finally { blocker.release(); releaseCommit.resolve(); await blocker.completion; await pending; }
});

test('Research acquisition waits for the owner and publishes actual UTF-8 body plus source metadata', async () => {
  const f = await fixture(true), call = await f.call('read_research_local'), blocker = await hold(f);
  const tool = createResearchReadTools({ database: f.database, files: f.files, now: () => at,
    readDocument: () => { throw Error('This selected source is a local artifact'); } })[0]!;
  let settled = false;
  const pending = tool.execute({ artifactId: 1, documentId: null }, call, f.context)
    .then(value => ({ value }), error => ({ error: failure(error) })).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false);
    expect(existsSync(join(f.paths.artifactsDir, 'research'))).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ value: { source: { researchId: f.task.researchId, characters: text.length },
      excerpt: { quote: text }, evidenceRef: { planId: f.binding.plan!.planId } } });
    expect(need(await f.database.read(store => store.research.listSources({ researchId: f.task.researchId, limit: 10 }))).items).toHaveLength(1);
  } finally { blocker.release(); await blocker.completion; await pending; }
});

test('Research evidence queries use committed acquisition receipts behind the owner', async () => {
  const f = await fixture(true), saved = await source(f), blocker = await hold(f);
  let settled = false;
  const pending = Promise.resolve().then(() => readResearchEvidence({ database: f.database, files: f.files },
    { researchId: f.task.researchId, sourceSnapshotId: saved.sourceSnapshotId }, f.policy))
    .then(value => { settled = true; return value; }, error => { settled = true; return { ok: false, error: failure(error) }; });
  try {
    await tick(); expect(settled).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ ok: true, data: { source: { sourceSnapshotId: saved.sourceSnapshotId }, excerpt: { quote: text } } });
  } finally { blocker.release(); await blocker.completion; await pending.catch(() => undefined); }
});

test('Research source body reads wait for the current owner', async () => {
  const f = await fixture(true), saved = await source(f), blocker = await hold(f);
  let settled = false;
  const pending = f.files.readResearchSource(saved).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await pending).toEqual({ ok: true, data: text });
  } finally { blocker.release(); await blocker.completion; await pending; }
});

test.each([false, true])('Research body publication acknowledges actual content COMMIT, fail=%s', async failCommit => {
  const f = await fixture(), transaction = f.database.transaction;
  await transaction(store => store.db.exec('CREATE TABLE research_body_parent(id INTEGER PRIMARY KEY); '
    + 'CREATE TABLE research_body_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES research_body_parent(id) DEFERRABLE INITIALLY DEFERRED)'));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.database.transaction = operation => transaction(async store => {
    const value = await operation(store);
    if (store.contents.read({ ownerKind: 'research-source', ownerId: '999', relativePath: 'artifacts/research/1/source-999.txt' })) {
      entered.resolve(); await release.promise;
      if (failCommit) store.db.query('INSERT INTO research_body_child(id,parent_id) VALUES (1,999)').run();
    }
    return value;
  });
  let settled = false;
  const pending = f.files.publishResearchSource({ researchId: 1, toolCallId: 999, text }).finally(() => { settled = true; });
  try {
    await entered.promise; expect(settled).toBe(false);
    expect(existsSync(join(f.paths.artifactsDir, 'research/1/source-999.txt'))).toBe(true);
    release.resolve();
    expect(await pending).toMatchObject(failCommit ? { ok: false, error: { code: 'research_source_unavailable' } }
      : { ok: true, data: { bytes: Buffer.byteLength(text), characters: text.length } });
    expect(await f.database.read(store => store.db.query("SELECT COUNT(*) AS count FROM managed_file_contents WHERE owner_kind='research-source' AND owner_id='999'").get()))
      .toEqual({ count: failCommit ? 0 : 1 });
  } finally { release.resolve(); await pending; }
});

test('an expired Research deadline is checked when queued plan saving reaches its owner', async () => {
  const f = await fixture(), call = await f.call('save_research_plan'), blocker = await hold(f);
  let settled = false;
  const pending = createResearchPlanTool(f.database, () => at).execute(f.body, { ...call, deadlineAt: 0 }, f.context)
    .then(value => ({ value }), error => ({ error: failure(error) })).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ error: { code: 'tool_timeout' } });
    expect(await f.database.read(store => store.db.query('SELECT COUNT(*) AS count FROM research_plans').get())).toEqual({ count: 0 });
  } finally { blocker.release(); await blocker.completion; await pending; }
});

test.each([
  ['save_research_claim', 'Stop'], ['save_research_report', 'Stop'],
  ['save_research_claim', 'same-length material change'], ['save_research_report', 'same-length material change'],
] as const)('queued %s refuses a late %s after evidence verification', async (name, action) => {
  const f = await fixture(true), saved = await source(f), controller = new AbortController();
  const ref = researchEvidenceRef(f.binding, saved, { start: 0, end: text.length, quote: text })!;
  const claim = { questionId: 'cost-1', text: 'The selected material states that usage is metered.', dependencies: [],
    evidence: [{ relation: 'supports' as const, ref }], verification: { status: 'supported' as const, reasons: ['The original body states the condition.'] } };
  const call = await f.call(name);
  const claimId = name === 'save_research_report' ? need(await f.database.transaction(async store => {
    const input = need(store.toolCalls.request({ context: null, runId: f.context.runId, sessionId: f.context.sessionId,
      nativeToolCallId: 'seed-claim', toolName: 'save_research_claim', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: claim, requestedAt: at }));
    need(store.toolCalls.fixArguments({ toolCallId: input.toolCallId, finalArguments: claim }));
    need(store.toolCalls.start({ toolCallId: input.toolCallId, startedAt: at }));
    return store.research.saveClaim({ researchId: f.task.researchId, runId: f.context.runId, toolCallId: input.toolCallId, claim, at });
  })).claimId : 0;
  const body = name === 'save_research_claim' ? claim : { answer: 'The selected evidence supports a metered condition.',
    sections: [{ title: 'Costs', text: 'Usage is metered.', claimIds: [claimId] }], conflicts: [], limitations: [], unresolvedQuestions: [],
    completeness: 'full', coverage: [{ questionId: 'cost-1', claimIds: [claimId], status: 'covered', reason: 'The saved claim has supporting evidence.' }] };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), read = f.files.readResearchSource.bind(f.files);
  let held: Promise<void> | undefined, reads = 0;
  f.files.readResearchSource = async (...args) => {
    const result = await read(...args);
    reads++;
    if (reads === (action === 'Stop' ? 1 : 2)) {
      held = f.database.transaction(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    }
    return result;
  };
  const tool = createResearchSynthesisTools({ database: f.database, files: f.files, now: () => at }).find(item => item.name === name)!;
  let settled = false;
  const pending = tool.execute(body, { ...call, signal: controller.signal }, f.context)
    .then(value => ({ value }), error => ({ error: failure(error) })).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false); await entered.promise;
    if (action === 'Stop') controller.abort();
    else writeFileSync(join(f.root, saved.relativePath), Buffer.alloc(Buffer.byteLength(text), 0x78));
    release.resolve(); await held;
    expect(await pending).toMatchObject({ error: { code: action === 'Stop' ? 'agent_cancelled' : 'research_source_unavailable' } });
    expect(await f.database.read(store => store.db.query(`SELECT COUNT(*) AS count FROM ${name === 'save_research_claim' ? 'research_claims' : 'research_reports'}`).get())).toEqual({ count: 0 });
  } finally { release.resolve(); await held; await pending; }
});
