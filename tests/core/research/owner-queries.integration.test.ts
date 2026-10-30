import { expect, spyOn, test } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as bootstrap from '../../../packages/core/src/storage/bootstrap.ts';
import { appError, fail, type Application, type CreateResearchTaskRequest, type ImportResearchMaterialRequest, type Result } from '@flowmate/contracts';
import { testDatabase, type TestDbHandle } from '../../support/database.ts';
import { createApplication } from '../../../apps/composition.ts';
import { PiAgentAdapter } from '../../../packages/runtime-pi/src/session.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-owner-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  let models = 0, database: TestDbHandle | undefined;
  const agent = new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir,
    credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-research-owner' });
  agent.prepare = async () => { models++; throw Error('Research metadata and queries must not start models.'); };
  const original = bootstrap.bootstrapDatabase;
  const opening = spyOn(bootstrap, 'bootstrapDatabase').mockImplementation(input => {
    const value = original(input); if (value.ok) database = testDatabase(value.data); return value;
  });
  let app: Application;
  try { app = need(await createApplication({ paths, agent, provider: {
    async prepare() { models++; throw Error('Research queries must not start Providers.'); },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  }, logger: { write() {}, async close() {} } })); }
  finally { opening.mockRestore(); }
  deferCleanup(() => app.close());
  if (!database) throw Error('The formal application database owner was not captured.');
  const session = need(await app.createSession({ title: 'Research owner' }));
  const request: CreateResearchTaskRequest = { sessionId: session.sessionId, title: 'Original research',
    sourcePolicy: { web: false, domains: [], artifactIds: [], documentIds: [] } };
  return { app, database, session, request, models: () => models, paths };
}

test('formal Research creation waits for the owner and its COMMIT while preserving the queued request', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const transaction = f.database.transaction;
  const holding = transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const commitEntered = Promise.withResolvers<void>(), commitRelease = Promise.withResolvers<void>();
  f.database.transaction = operation => {
    f.database.transaction = transaction;
    return transaction(async scope => { const value = await operation(scope);
      commitEntered.resolve(); await commitRelease.promise; return value; });
  };
  let settled = false;
  const creating = f.app.createResearchTask(f.request).then(value => { settled = true; return value; });
  f.request.title = 'Changed after queueing';
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    release.resolve(); await holding; await commitEntered.promise;
    expect(f.database.db.inTransaction).toBe(true); expect(settled).toBe(false);
    commitRelease.resolve();
    const task = need(await creating);
    expect(task).toMatchObject({ sessionId: f.session.sessionId, title: 'Original research', status: 'planning' });
    expect(await f.app.queryResearchForSession({ sessionId: f.session.sessionId })).toEqual({ ok: true, data: task });
    expect(f.models()).toBe(0);
  } finally { release.resolve(); commitRelease.resolve(); await holding; await creating; }
});

test('formal Research reads wait for the current owner, snapshot page input, and never start models', async () => {
  const f = await fixture(), task = need(await f.app.createResearchTask(f.request));
  const expired = () => fail(appError('research_read_failed', 'storage', 'Expired root Research repository.', true));
  f.database.research.list = expired; f.database.research.get = expired; f.database.research.forSession = expired;
  f.database.research.listMaterials = expired; f.database.research.getPlan = expired; f.database.research.getSource = expired;
  f.database.research.getClaim = expired; f.database.research.getReport = expired; f.database.research.listSources = expired;
  f.database.research.listClaims = expired; f.database.research.listReports = expired;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = 0;
  const page = { limit: 1 }, owner = { researchId: task.researchId };
  const reading = Promise.all([f.app.listResearchTasks(page), f.app.queryResearchTask(task.researchId),
    f.app.queryResearchForSession({ sessionId: task.sessionId }), f.app.listResearchMaterials(page),
    f.app.queryResearchPlan({ ...owner, planId: 999 }), f.app.queryResearchSource({ ...owner, sourceSnapshotId: 999 }),
    f.app.queryResearchClaim({ ...owner, claimId: 999 }), f.app.queryResearchReport({ ...owner, reportId: 999 }),
    f.app.listResearchSources({ ...owner, limit: 1 }), f.app.listResearchClaims({ ...owner, planId: 999, limit: 1 }),
    f.app.listResearchReports({ ...owner, limit: 1 }),
    f.app.queryResearchEvidence({ ...owner, sourceSnapshotId: 999 }), f.app.exportResearchReport({ ...owner, reportId: 999 })]
    .map(pending => pending.then(value => { settled++; return value; })));
  page.limit = 1000;
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(0);
    release.resolve(); await holding;
    const values = await reading;
    expect(values[0]).toEqual({ ok: true, data: { items: [task], nextBeforeId: null } });
    expect(values[1]).toEqual({ ok: true, data: task }); expect(values[2]).toEqual({ ok: true, data: task });
    expect(values[3]).toMatchObject({ ok: true, data: { items: [] } });
    for (const value of values.slice(4, 8)) expect(value).toMatchObject({ ok: false, error: { code: 'research_not_found' } });
    for (const value of values.slice(8, 11)) expect(value).toMatchObject({ ok: true, data: { items: [] } });
    for (const value of values.slice(11)) expect(value).toMatchObject({ ok: false, error: { code: 'research_not_found' } });
    expect(f.models()).toBe(0);
  } finally { release.resolve(); await holding; await reading; }
});

test('a Research creation COMMIT failure keeps its existing Session and publishes no task receipt', async () => {
  const f = await fixture();
  await f.database.transaction(scope => scope.db.exec(`
    CREATE TABLE research_commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE research_commit_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES research_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER research_commit_fault AFTER INSERT ON research_tasks BEGIN INSERT INTO research_commit_child VALUES(1,404); END;
  `));
  expect(await f.app.createResearchTask(f.request)).toMatchObject({ ok: false, error: { code: 'research_write_failed' } });
  expect(await f.app.queryResearchForSession({ sessionId: f.session.sessionId })).toEqual({ ok: true, data: null });
  expect(await f.app.querySession(f.session.sessionId)).toMatchObject({ ok: true, data: { sessionId: f.session.sessionId, status: 'active' } });
  expect(f.models()).toBe(0);
});

test('parallel Research material imports share the publication tail and keep legacy gaps explicit', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const expired = () => fail(appError('research_read_failed', 'storage', 'Expired root material repository.', true));
  f.database.research.findMaterials = expired; f.database.research.registerMaterial = expired;
  f.database.documents.getArtifact = expired; f.database.documents.listArtifactIds = expired;
  f.database.contents.read = () => { throw Error('Expired root material contents.'); };
  f.database.contents.remember = () => { throw Error('Expired root material contents.'); };
  const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const request: ImportResearchMaterialRequest = { title: 'Selected evidence.md', format: 'markdown', text: 'Original Unicode 😀 evidence.' };
  let settled = 0;
  const first = f.app.importResearchMaterial(request).then(value => { settled++; return value; });
  request.text = 'Changed after queueing';
  const second = f.app.importResearchMaterial({ ...request, text: 'Original Unicode 😀 evidence.' }).then(value => { settled++; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(0);
    release.resolve(); await holding;
    const material = need(await first);
    expect(await second).toEqual({ ok: true, data: material });
    expect(need(await f.app.listResearchMaterials()).items).toHaveLength(1);
    await f.database.transaction(scope => scope.db.query("UPDATE artifacts SET metadata_json=json_set(metadata_json,'$.verificationGap','legacy-original-unavailable') WHERE id=?")
      .run(material.artifactId));
    const imported = need(await f.app.importResearchMaterial({ ...request, text: 'Original Unicode 😀 evidence.' }));
    expect(imported.artifactId).not.toBe(material.artifactId);
    expect(imported.verificationGap).toBeUndefined();
    expect(need(await f.app.listResearchMaterials()).items).toHaveLength(2);
    expect(f.models()).toBe(0);
  } finally { release.resolve(); await holding; await first; await second; }
});

test('closed Research owners return safe errors for every public entry instead of empty facts', async () => {
  const f = await fixture();
  need(await f.app.close());
  const owner = { researchId: 1 };
  const values = await Promise.all([f.app.importResearchMaterial({ title: 'Evidence', format: 'text', text: 'Original' }),
    f.app.listResearchMaterials(), f.app.createResearchTask(f.request), f.app.listResearchTasks(), f.app.queryResearchTask(1),
    f.app.queryResearchForSession({ sessionId: f.session.sessionId }), f.app.queryResearchPlan({ ...owner, planId: 1 }),
    f.app.queryResearchSource({ ...owner, sourceSnapshotId: 1 }), f.app.queryResearchClaim({ ...owner, claimId: 1 }),
    f.app.queryResearchReport({ ...owner, reportId: 1 }), f.app.listResearchSources(owner),
    f.app.listResearchClaims({ ...owner, planId: 1 }), f.app.listResearchReports(owner),
    f.app.queryResearchEvidence({ ...owner, sourceSnapshotId: 1 }), f.app.exportResearchReport({ ...owner, reportId: 1 })]);
  for (const value of values) expect(value).toMatchObject({ ok: false, error: { category: 'storage' } });
  expect(f.models()).toBe(0);
});
