import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appError, fail, ok, type PersonalAgentConfiguration, type Result } from '@flowmate/contracts';
import { PersonalAgentService, type PersonalAgentServiceOptions } from '../../../packages/core/src/personal-agent/service.ts';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';

const at = '2026-10-29T00:00:00.000Z';
const configuration: PersonalAgentConfiguration = { modelId: null, thinkingLevel: 'off',
  resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: [],
  workingDirectory: null, preferences: 'Original default.' };

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
function validateConfiguration(config: PersonalAgentConfiguration): Result<void> {
  if (config.modelId !== null && config.modelId !== 'offline-model')
    return fail(appError('model_unavailable', 'input', 'The selected model is unavailable.'));
  if (config.resources.prompt || config.resources.enabledSkills.length || config.extensions.enabledExtensions.length
    || config.workingDirectory !== null || config.tools.some(name => name !== 'read_invoice_document'))
    return fail(appError('resource_required_unavailable', 'input', 'The selected configuration reference is unavailable.'));
  return ok(undefined);
}

async function fixture(validate: PersonalAgentServiceOptions['validateConfiguration'] = validateConfiguration) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-agent-service-'));
  const paths = { root, databaseFile: join(root, 'data/app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), logsDir: join(root, 'logs'), runtimeDir: join(root, 'runtime') };
  const database = need(openTestDatabase(paths));
  const service = new PersonalAgentService({ database, now: () => at, validateConfiguration: validate });
  const effects = () => database.read(scope => scope.db.query(`SELECT
    (SELECT COUNT(*) FROM personal_agents) agents,(SELECT COUNT(*) FROM sessions) sessions,
    (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM tool_calls) tools,
    (SELECT COUNT(*) FROM invoice_works) works,(SELECT COUNT(*) FROM invoice_work_attempts) attempts,
    (SELECT COUNT(*) FROM invoice_work_phases) phases,(SELECT COUNT(*) FROM business_events) events`).get());
  const createWork = async () => {
    const agent = need(await service.get());
    return need(await database.transaction(scope => {
      const metadata = { version: 1 as const, sourceKey: 'personal-agent-service', sourceRecordId: 'invoice-1', sourceVersion: 'v1' };
      need(scope.documents.register({ documentId: 1, sourceKey: metadata.sourceKey, sourceRecordId: metadata.sourceRecordId,
        version: 'v1', originalArtifact: { artifactId: 1, kind: 'original', relativePath: 'artifacts/1/source.md', bytes: 1,
          mimeType: 'text/markdown', metadata: { ...metadata, files: [{ relativePath: 'source.md', bytes: 1, mimeType: 'text/markdown' }] }, createdAt: at },
        parsedArtifact: { artifactId: 2, kind: 'parsed', relativePath: 'artifacts/2/parsed.json', bytes: 1,
          mimeType: 'application/json', metadata: { ...metadata, files: [{ relativePath: 'parsed.json', bytes: 1, mimeType: 'application/json' }] }, createdAt: at },
        status: 'available', metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['Controlled product record fixture'],
          licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
      return scope.invoiceWorks.create({ personalAgentId: agent.personalAgentId,
        expectedAgentRevision: agent.revision, requestId: 'create-service-work', goal: 'Review the fixed invoice.',
        documents: [{ id: 1, version: 'v1' }] }, { at, admission: { kind: 'queued' } });
    }));
  };
  return { root, paths, database, service, effects, createWork };
}

test('get and missing conversation reads never initialize or execute the Personal Agent', async () => {
  let validations = 0;
  const f = await fixture(config => { validations++; return validateConfiguration(config); });
  expect(await f.service.get()).toMatchObject({ ok: false, error: { code: 'personal_agent_not_found' } });
  expect(await f.service.openConversation({ workId: 404 })).toMatchObject({ ok: false, error: { code: 'invoice_work_not_found' } });
  expect(validations).toBe(0);
  expect(await f.effects()).toEqual({ agents: 0, sessions: 0, runs: 0, tools: 0, works: 0, attempts: 0, phases: 0, events: 0 });
});

test('explicit initialization preserves user configuration even when a later default is invalid', async () => {
  let validations = 0;
  const f = await fixture(config => { validations++; return validateConfiguration(config); });
  const initial = need(await f.service.initialize(configuration));
  const edited = need(await f.service.update({ personalAgentId: initial.personalAgentId, expectedRevision: initial.revision,
    configuration: { ...configuration, modelId: 'offline-model', preferences: 'Keep the user preference.' } }));
  const invalidDefault = { ...configuration, tools: ['read_invoice_document', 'read_invoice_document'] as const,
    apiKey: 'SYNTHETIC_PRIVATE_VALUE' };
  expect(await f.service.initialize(invalidDefault)).toEqual({ ok: true, data: edited });
  expect(await f.service.get()).toEqual({ ok: true, data: edited });
  expect(validations).toBe(2);
  expect(JSON.stringify(await f.database.read(scope => scope.db.query('SELECT * FROM personal_agents').all())))
    .not.toContain('SYNTHETIC_PRIVATE_VALUE');
  expect(await f.effects()).toMatchObject({ agents: 1, sessions: 0, runs: 0, tools: 0, works: 0, attempts: 0, phases: 0 });
});

test('invalid schema and credential fields never reach reference validation or stored configuration', async () => {
  let validations = 0;
  const f = await fixture(config => { validations++; return validateConfiguration(config); });
  const unsafeConfiguration = { ...configuration, apiKey: 'SYNTHETIC_PRIVATE_VALUE' };
  expect(await f.service.initialize(unsafeConfiguration)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(validations).toBe(0);
  need(await f.service.initialize(configuration));
  const before = need(await f.service.get());
  expect(await f.service.update({ personalAgentId: 1, expectedRevision: 0, configuration: unsafeConfiguration }))
    .toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(validations).toBe(1);
  expect(await f.service.get()).toEqual({ ok: true, data: before });
  expect(JSON.stringify(await f.database.read(scope => scope.db.query('SELECT * FROM personal_agents').all())))
    .not.toContain('SYNTHETIC_PRIVATE_VALUE');
});

test('configuration reference failures remain explicit Results and preserve the prior revision', async () => {
  const f = await fixture(); need(await f.service.initialize(configuration));
  const before = need(await f.service.get());
  expect(await f.service.update({ personalAgentId: 1, expectedRevision: before.revision,
    configuration: { ...configuration, modelId: 'missing-model' } }))
    .toEqual(fail(appError('model_unavailable', 'input', 'The selected model is unavailable.')));
  expect(await f.service.update({ personalAgentId: 1, expectedRevision: before.revision,
    configuration: { ...configuration, resources: { prompt: { kind: 'prompt', id: 'missing-prompt', version: 'v1' }, enabledSkills: [] } } }))
    .toEqual(fail(appError('resource_required_unavailable', 'input', 'The selected configuration reference is unavailable.')));
  expect(await f.service.get()).toEqual({ ok: true, data: before });
});

test('concurrent updates use the current owner CAS and never overwrite a winning revision', async () => {
  const f = await fixture(); need(await f.service.initialize(configuration));
  const results = await Promise.all(['First user choice.', 'Second user choice.'].map(preferences => f.service.update({
    personalAgentId: 1, expectedRevision: 0, configuration: { ...configuration, preferences } })));
  expect(results[0]).toMatchObject({ ok: true, data: { revision: 1, configuration: { preferences: 'First user choice.' } } });
  expect(results[1]).toMatchObject({ ok: false, error: { code: 'state_conflict' } });
  expect(await f.service.get()).toEqual(results[0]);
});

test('queued configuration updates capture their input before validation and the owner wait', async () => {
  const checking = Promise.withResolvers<void>(), checked = Promise.withResolvers<void>();
  const f = await fixture(async config => {
    if (config.preferences === 'Captured before the queue.') { checking.resolve(); await checked.promise; }
    return validateConfiguration(config);
  });
  need(await f.service.initialize(configuration));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const input = { personalAgentId: 1, expectedRevision: 0, configuration: { ...configuration,
    preferences: 'Captured before the queue.', resources: { prompt: null, enabledSkills: [] } } };
  let settled = false;
  const updating = f.service.update(input).then(value => { settled = true; return value; });
  try {
    await checking.promise;
    input.expectedRevision = 100;
    input.configuration.preferences = 'Changed after validation began.';
    checked.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve(); await holding;
    expect(await updating).toMatchObject({ ok: true, data: { revision: 1,
      configuration: { preferences: 'Captured before the queue.' } } });
  } finally { checked.resolve(); release.resolve(); await holding; await updating; }
});

test('get, conversation and original operation queries wait for the same owner without creating execution', async () => {
  const f = await fixture(); need(await f.service.initialize(configuration)); const created = await f.createWork(), before = await f.effects();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = f.database.transaction(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let settled = 0;
  const reading = f.service.get().then(value => { settled++; return value; });
  const opening = f.service.openConversation({ workId: created.workId }).then(value => { settled++; return value; });
  const querying = f.database.read(scope => scope.invoiceWorks.queryOperation({ operation: 'create',
    personalAgentId: 1, requestId: 'create-service-work' })).then(value => { settled++; return value; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(0);
    release.resolve(); await holding;
    expect(await reading).toMatchObject({ ok: true, data: { personalAgentId: 1, revision: 0 } });
    expect(await opening).toEqual({ ok: true, data: { workId: created.workId, sessionId: created.sessionId, runtimeKind: 'durable' } });
    expect(await querying).toEqual({ ok: true, data: created });
    expect(await f.effects()).toEqual(before);
  } finally { release.resolve(); await holding; await reading; await opening; await querying; }
});

test('reconnecting read APIs return the original product conversation and receipt with no model, tool or new admission', async () => {
  const f = await fixture(); const agent = need(await f.service.initialize(configuration)), created = await f.createWork(), before = await f.effects();
  await f.database.close();
  const reopened = need(openTestDatabase(f.paths));
  const service = new PersonalAgentService({ database: reopened, now: () => at,
    validateConfiguration: () => { throw Error('Read APIs must not prepare configuration or execution.'); } });
  expect(await service.get()).toEqual({ ok: true, data: agent });
  expect(await service.openConversation({ workId: created.workId }))
    .toEqual({ ok: true, data: { workId: created.workId, sessionId: created.sessionId, runtimeKind: 'durable' } });
  expect(await reopened.read(scope => scope.invoiceWorks.queryOperation({ operation: 'create',
    personalAgentId: 1, requestId: 'create-service-work' }))).toEqual({ ok: true, data: created });
  expect(await reopened.read(scope => scope.db.query(`SELECT
    (SELECT COUNT(*) FROM personal_agents) agents,(SELECT COUNT(*) FROM sessions) sessions,
    (SELECT COUNT(*) FROM runs) runs,(SELECT COUNT(*) FROM tool_calls) tools,
    (SELECT COUNT(*) FROM invoice_works) works,(SELECT COUNT(*) FROM invoice_work_attempts) attempts,
    (SELECT COUNT(*) FROM invoice_work_phases) phases,(SELECT COUNT(*) FROM business_events) events`).get())).toEqual(before);
  expect(before).toMatchObject({ agents: 1, sessions: 1, runs: 0, tools: 0, works: 1, attempts: 1, phases: 0 });
});

test('a real deferred COMMIT failure returns no successful configuration receipt', async () => {
  const f = await fixture(); const before = need(await f.service.initialize(configuration));
  await f.database.transaction(scope => scope.db.exec(`
    CREATE TABLE agent_config_commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE agent_config_commit_child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES agent_config_commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
  `));
  const transaction = f.database.transaction;
  f.database.transaction = operation => {
    f.database.transaction = transaction;
    return transaction(async scope => {
      const result = await operation(scope);
      scope.db.query('INSERT INTO agent_config_commit_child VALUES(1,404)').run();
      return result;
    });
  };
  expect(await f.service.update({ personalAgentId: 1, expectedRevision: 0, configuration: { ...configuration, preferences: 'Uncommitted choice.' } }))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(await f.service.get()).toEqual({ ok: true, data: before });
});

test('a throwing required validator fails closed without disclosing its exception or changing configuration', async () => {
  const f = await fixture(); const before = need(await f.service.initialize(configuration));
  const service = new PersonalAgentService({ database: f.database, now: () => at,
    validateConfiguration: () => { throw Error('SYNTHETIC_PRIVATE_VALUE'); } });
  const result = await service.update({ personalAgentId: 1, expectedRevision: 0, configuration });
  expect(result).toMatchObject({ ok: false, error: { code: 'personal_agent_configuration_unavailable' } });
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
  expect(await service.get()).toEqual({ ok: true, data: before });
});

test('closed owners return safe read and write Results instead of starting or silently recreating anything', async () => {
  const f = await fixture(); need(await f.service.initialize(configuration)); const created = await f.createWork();
  await f.database.close();
  expect(await f.service.get()).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await f.service.openConversation({ workId: created.workId })).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await f.service.initialize(configuration)).toMatchObject({ ok: false, error: { code: 'storage_read_failed' } });
  expect(await f.service.update({ personalAgentId: 1, expectedRevision: 0, configuration }))
    .toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
});
