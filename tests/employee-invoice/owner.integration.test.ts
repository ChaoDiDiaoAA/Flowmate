import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { CandidateDraftSchema, appError, fail } from '@flowmate/contracts';
import type { Result, ToolCallContext } from '@flowmate/contracts';
import { createFileStore } from '@flowmate/core';
import { createDocumentService } from '@flowmate/data';
import { createInvoiceTools } from '@flowmate/employee-invoice';
import { makeSelectedCandidate } from '../support/selected-candidate.ts';
import { openTestDatabase } from '../support/database.ts';
import { createTestWorkspaceVerifier } from '../support/workspace.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(pauseSave = false) {
  const seeded = makeSelectedCandidate();
  const paths = { root: seeded.root, databaseFile: seeded.db.filename, logsDir: join(seeded.root, 'logs'),
    artifactsDir: join(seeded.root, 'artifacts'), outputsDir: join(seeded.root, 'outputs'), runtimeDir: join(seeded.root, 'runtime') };
  await seeded.close();
  const database = need(openTestDatabase(paths));
  const store = { ...database, root: seeded.root, stamp: seeded.stamp, config: seeded.config, usage: seeded.usage,
    cleanup: seeded.cleanup, session: seeded.session, jobId: seeded.jobId, candidateId: seeded.candidateId,
    selectedWorkspace: seeded.selectedWorkspace, verify: createTestWorkspaceVerifier(database, seeded.root) };
  const files = createFileStore(paths, store), documents = createDocumentService({ paths,
    files, allowedSourceRoot: store.root, now: () => store.stamp,
    transaction: operation => store.transaction(scope => operation({ repository: scope.documents,
      files: { read: (artifact, name) => files.read(artifact, name, scope.contents) } })) });
  const saved = need(store.candidates.readByJob({ jobId: store.jobId, candidateId: store.candidateId })).candidate;
  const candidate = CandidateDraftSchema.parse({ fields: saved.fields, lines: saved.lines, notes: saved.notes });
  const input = { documentId: 1, candidate }, nativeToolCallId = 'owner-candidate-save';
  const context = await store.transaction(scope => {
    const view = store.selectedWorkspace;
    const admitted = need(scope.runs.createWorkspaceAgent({ sessionId: store.session.sessionId,
      expected: { revision: view.revision, sessionId: view.sessionId!, documentRef: view.documentRef, jobId: view.jobId, candidateRef: view.candidateRef },
      goalMode: 'save-candidate', text: 'Save through owner', messageTimestamp: 1, goal: 'Save through owner', config: store.config,
      usage: store.usage, cleanup: store.cleanup, createdAt: store.stamp }, store.verify));
    const startedConfig: typeof store.config & { goalMode: 'save-candidate'; workspaceContext: typeof admitted.workspaceContext } = {
      ...store.config, goalMode: 'save-candidate', workspaceContext: admitted.workspaceContext,
    };
    need(scope.runs.start(admitted.runId, startedConfig, store.stamp));
    const call = need(scope.toolCalls.request({ context: null, runId: admitted.runId, sessionId: store.session.sessionId,
      nativeToolCallId, toolName: 'save_invoice_candidate', toolVersion: '1', effect: 'LOCAL_WRITE', rawArguments: input, requestedAt: store.stamp }));
    need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: input }));
    need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: store.stamp }));
    return { runId: admitted.runId, sessionId: store.session.sessionId, scope: admitted.scope };
  });
  const saveEntered = Promise.withResolvers<ToolCallContext>(), releaseSave = Promise.withResolvers<void>();
  const tools = createInvoiceTools({
    documents: { readParsedForRun: (id, context) => store.transaction(scope => documents.readParsedForRun(id, context, {
      repository: scope.documents, files: { read: (artifact, name) => files.read(artifact, name, scope.contents) },
    })).catch(() => fail(appError('storage_read_failed', 'storage', 'Controlled material read failure'))) },
    documentRepository: { get: id => store.read(scope => scope.documents.get(id)) },
    candidates: {
      save: async (input, call) => {
        saveEntered.resolve(call);
        if (pauseSave) await releaseSave.promise;
        return store.transaction(scope => {
          if (call.signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'The run was cancelled; no candidate was saved.', false));
          if (call.deadlineAt !== undefined && performance.now() >= call.deadlineAt)
            return fail(appError('tool_timeout', 'tool', 'The tool deadline elapsed; no candidate was saved.', true));
          return scope.candidates.save(input);
        }).catch(() => fail(appError('storage_write_failed', 'storage', 'Controlled candidate write failure', true)));
      },
      listForRun: input => store.read(scope => scope.candidates.listForRun(input)),
      readForRun: input => store.read(scope => scope.candidates.readForRun(input)),
    }, now: () => store.stamp,
  });
  store.documents.get = () => { throw Error('Root document read escaped the owner'); };
  store.documents.getArtifact = () => { throw Error('Root artifact read escaped the owner'); };
  store.contents.read = () => { throw Error('Root content read escaped the owner'); };
  const controller = new AbortController(), call = { nativeToolCallId, signal: controller.signal };
  return { store, input, context, call, controller, saveEntered, releaseSave, read: tools.find(tool => tool.name === 'read_invoice_document')!,
    save: tools.find(tool => tool.name === 'save_invoice_candidate')! };
}

async function hold(f: Awaited<ReturnType<typeof fixture>>, revoke = false) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const completion = f.store.transaction(async scope => {
    if (revoke) need(scope.sessions.revokeDocumentUse({ documentId: 1, at: f.store.stamp }));
    entered.resolve(); await release.promise;
  });
  await entered.promise;
  return { release: release.resolve, completion };
}

test('Invoice material reads wait for the owner and use its repository and original content', async () => {
  const f = await fixture(), blocker = await hold(f);
  let settled = false;
  const pending = f.read.execute({ documentId: 1, page: 1, afterBlockId: null, limit: 10 }, f.call, f.context)
    .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false);
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ value: { documentRef: { id: 1, version: 'v1' }, blocks: [{ id: 'b1', text: 'Total 113.00' }] } });
  } finally { blocker.release(); await blocker.completion; await pending; }
});

test.each([false, true])('Invoice candidate saving waits for the current owner and rechecks revocation: %s', async revoke => {
  const f = await fixture(), blocker = await hold(f, revoke);
  let settled = false;
  const pending = f.save.execute(f.input, f.call, f.context).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await tick(); expect(settled).toBe(false);
    blocker.release(); await blocker.completion;
    if (revoke) expect(await pending).toMatchObject({ error: { code: 'session_scope_revoked', category: 'session', retryable: false } });
    else expect(await pending).toMatchObject({ value: { jobId: f.store.jobId, sequence: 2 } });
    expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get())).toEqual({ count: revoke ? 1 : 2 });
  } finally { blocker.release(); await blocker.completion; await pending; }
});

test('Invoice candidate saving returns no receipt before the actual owner COMMIT', async () => {
  const f = await fixture(), transaction = f.store.transaction, release = Promise.withResolvers<void>();
  let paused = false, settled = false;
  f.store.transaction = operation => transaction(async scope => {
    const value = await operation(scope);
    if (!paused && scope.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM invoice_candidates').get()!.count === 2) {
      paused = true; await release.promise;
    }
    return value;
  });
  const pending = f.save.execute(f.input, f.call, f.context).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await tick(); expect(paused).toBe(true); expect(settled).toBe(false);
    release.resolve();
    expect(await pending).toMatchObject({ value: { jobId: f.store.jobId, sequence: 2 } });
  } finally { release.resolve(); await pending; }
});

test('a scoped Invoice read commits the unavailable diagnostic for same-length altered material', async () => {
  const f = await fixture(), path = join(f.store.root, 'artifacts', '2', 'parsed.json');
  const original = readFileSync(path), changed = Buffer.from(original.toString('utf8').replace('113.00', '999.00'));
  expect(changed.length).toBe(original.length); expect(changed.equals(original)).toBe(false);
  writeFileSync(path, changed);
  await expect(f.read.execute({ documentId: 1, page: 1, afterBlockId: null, limit: 10 }, f.call, f.context))
    .rejects.toMatchObject({ code: 'input_unavailable' });
  expect(await f.store.read(scope => scope.documents.get(1))).toMatchObject({ ok: true, data: {
    status: 'unavailable', unavailableReason: 'parsed_artifact_missing_or_corrupt' } });
});

test.each(['cancel', 'deadline'] as const)('Invoice save retains the original %s control until its owner begins writing', async reason => {
  const f = await fixture(true), call = { ...f.call, ...(reason === 'deadline' ? { deadlineAt: performance.now() + 20 } : {}) };
  const pending = f.save.execute(f.input, call, f.context).then(value => ({ value }), error => ({ error }));
  await f.saveEntered.promise;
  const blocker = await hold(f);
  try {
    f.releaseSave.resolve(); await tick();
    if (reason === 'cancel') f.controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 30));
    blocker.release(); await blocker.completion;
    expect(await pending).toMatchObject({ error: { code: reason === 'cancel' ? 'agent_cancelled' : 'tool_timeout' } });
    expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get())).toEqual({ count: 1 });
  } finally { f.releaseSave.resolve(); blocker.release(); await blocker.completion; await pending; }
});

test('a failed Invoice candidate owner COMMIT publishes no receipt, candidate or Activity', async () => {
  const f = await fixture();
  await f.store.transaction(scope => scope.db.exec('CREATE TABLE invoice_owner_parent(id INTEGER PRIMARY KEY); '
    + 'CREATE TABLE invoice_owner_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES invoice_owner_parent(id) DEFERRABLE INITIALLY DEFERRED); '
    + 'CREATE TRIGGER invoice_owner_commit_fault AFTER INSERT ON invoice_candidates BEGIN INSERT INTO invoice_owner_child VALUES(1,404); END;'));
  await expect(f.save.execute(f.input, f.call, f.context)).rejects.toMatchObject({ code: 'storage_write_failed' });
  expect(await f.store.read(scope => scope.db.query('SELECT COUNT(*) AS count FROM invoice_candidates').get())).toEqual({ count: 1 });
  expect(await f.store.read(scope => scope.db.query("SELECT COUNT(*) AS count FROM business_events WHERE type='candidate_generated'").get())).toEqual({ count: 1 });
  expect(await f.store.read(scope => scope.db.query('SELECT id FROM invoice_owner_child').all())).toEqual([]);
});
