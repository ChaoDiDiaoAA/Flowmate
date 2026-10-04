import { expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApplication, openDatabase, RuntimeService } from '../../../packages/core/src/index.ts';
import { ok, type NativeOutcome, type ProviderPort, type ProviderRequest, type SafeConfigSnapshot } from '../../../packages/contracts/src/index.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function fixture(provider: ProviderPort) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-provider-boundary-'));
  const database = openDatabase({ root, databaseFile: join(root, 'data', 'trial.sqlite'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') });
  if (!database.ok) throw new Error(database.error.code);
  const runtime = new RuntimeService({ memory: database.data.memory, runs: database.data.runs, provider,
    log: { write() {}, async close() {} }, now: () => new Date().toISOString(), monotonicNow: () => performance.now() });
  const app = makeApplication(runtime, database.data.runs, async () => {
    database.data.close();
    return { stopped: true, closed: true, errors: [] };
  });
  deferCleanup(() => app.close());
  const request: ProviderRequest = { goal: 'Original goal', text: 'Original text', timeoutMs: 1_000, stopGraceMs: 100,
    config: { version: 1, name: 'original', revision: 1, modelRef: { provider: 'fixture', model: 'before' },
      native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
      parameters: { maxRetries: 0, maxRetryDelayMs: 2_000 } } };
  return { app, db: database.data.db, request, root };
}

const success: NativeOutcome = { text: 'OK', partial: false, stopReason: 'stop', responseId: null, responseModel: null, error: null,
  usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: null, attemptsComplete: false,
    costSource: null, updatedAt: '2026-09-30T00:00:00.000Z' },
  tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false }, stopped: true, cleanupErrors: [] };

it.each(['empty-goal', 'secret-config'] as const)('rejects a public %s request before creating a Run or entering Provider', async (invalid) => {
  const prepare = mock(async () => ({ ok: false as const, error: {
    code: 'unexpected_prepare', category: 'provider' as const, message: 'Unexpected prepare', retryable: false } }));
  const { app, db, request } = fixture({ prepare, async close() { return { stopped: true, closed: true, errors: [] }; } });
  const raw = invalid === 'empty-goal' ? { ...request, goal: '' }
    : { ...request, config: { ...request.config, apiKey: 'synthetic-secret-must-not-be-stored' } };

  expect(await app.callProvider(raw)).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
  expect(prepare).not.toHaveBeenCalled();
  expect(db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
});

it('keeps the accepted Provider request and durable configuration independent from caller mutations', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolvePrepared) => { release = resolvePrepared; });
  const provider: ProviderPort = {
    async prepare(config, limits) {
      await gate;
      const snapshot: SafeConfigSnapshot = { version: 1, name: config.name, revision: config.revision,
        requestedModel: config.modelRef, resolvedModel: config.modelRef, parameters: config.parameters, limits,
        api: 'openai-completions', endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
        native: { authSource: 'unknown', modelsSelection: config.native.modelsPath } };
      return ok({ snapshot, execute: async (input) => ({ ...success,
        text: `${config.modelRef.model}: ${input.goal}: ${input.text}`, responseModel: config.modelRef.model }) });
    },
    async close() { return { stopped: true, closed: true, errors: [] }; },
  };
  const { app, request } = fixture(provider);
  const original = structuredClone(request);
  const pending = app.callProvider(request);
  request.goal = 'Changed goal';
  request.text = 'Changed text';
  request.timeoutMs = 100;
  request.stopGraceMs = 10_000;
  request.config.name = 'changed';
  request.config.revision = 2;
  request.config.modelRef.model = 'after';
  request.config.native.modelsPath = join(tmpdir(), 'changed-models.json');
  request.config.parameters.maxRetries = 1;
  request.config.parameters.maxRetryDelayMs = 5_000;
  release();

  const result = await pending;
  expect(result).toMatchObject({ ok: true, data: { status: 'completed', text: 'before: Original goal: Original text' } });
  if (!result.ok) throw new Error(result.error.code);
  const saved = await app.queryRun(result.data.runId);
  expect(saved).toMatchObject({ ok: true, data: { input: { goal: original.goal, text: original.text }, config: {
    name: original.config.name, revision: original.config.revision, requestedModel: original.config.modelRef,
    resolvedModel: original.config.modelRef, parameters: original.config.parameters,
    limits: { timeoutMs: original.timeoutMs, stopGraceMs: original.stopGraceMs }, native: { modelsSelection: null },
  } } });
});

it('[F-db-create-abort] rejects a real SQLite create failure before entering Provider', async () => {
  const prepare = mock(async () => ({ ok: false as const, error: {
    code: 'unexpected_prepare', category: 'provider' as const, message: 'Unexpected prepare', retryable: false } }));
  const { app, db, request } = fixture({ prepare, async close() { return { stopped: true, closed: true, errors: [] }; } });
  db.exec("CREATE TRIGGER reject_run_create BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'forced-create-failure'); END");

  expect(await app.callProvider(request)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  expect(prepare).not.toHaveBeenCalled();
  expect(db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  expect(await app.queryRun(1)).toMatchObject({ ok: false, error: { code: 'run_not_found' } });
});

it.each(['start', 'finish'] as const)('[F-db-transition-abort] preserves the committed row and blocks reuse after a real %s write failure', async (stage) => {
  let committedSnapshot: unknown;
  let committedRow: unknown;
  const execute = mock(async () => {
    committedSnapshot = await app.queryRun(1);
    committedRow = db.query('SELECT * FROM runs WHERE id=1').get();
    return { ...success, text: 'Uncommitted final result', usage: { ...success.usage,
      source: 'sdk' as const, reason: null, sdkValues: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
        costInput: 0.005, costOutput: 0.005, costCacheRead: 0, costCacheWrite: 0, costTotal: 0.01 }, attempts: 1, attemptsComplete: true },
      tokens: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: '0.01', usageComplete: true } };
  });
  const prepare = mock(async (config: ProviderRequest['config'], limits: { timeoutMs: number; stopGraceMs: number }) => {
    committedSnapshot = await app.queryRun(1);
    committedRow = db.query('SELECT * FROM runs WHERE id=1').get();
    const snapshot: SafeConfigSnapshot = { version: 1, name: config.name, revision: config.revision,
      requestedModel: config.modelRef, resolvedModel: { ...config.modelRef, model: 'resolved' }, parameters: config.parameters, limits,
      api: 'openai-completions', endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
      native: { authSource: 'unknown', modelsSelection: null } };
    return ok({ snapshot, execute });
  });
  const { app, db, request } = fixture({ prepare, async close() { return { stopped: true, closed: true, errors: [] }; } });
  db.exec(`CREATE TRIGGER reject_run_transition BEFORE UPDATE ON runs
    WHEN NEW.status='${stage === 'start' ? 'running' : 'completed'}'
    BEGIN SELECT RAISE(ABORT, 'forced-transition-failure'); END`);

  expect(await app.callProvider(request)).toMatchObject({ ok: false, runId: 1, error: { code: 'storage_write_failed' } });
  expect(committedSnapshot).toMatchObject({ ok: true, data: {
    status: stage === 'start' ? 'created' : 'running', output: null, error: null, endedAt: null, stoppedAt: null,
    cleanup: { stopped: false, stopReason: null, errors: [], lateObservationRequired: false },
  } });
  expect(committedSnapshot).toEqual(await app.queryRun(1));
  expect(db.query('SELECT * FROM runs WHERE id=1').get()).toEqual(committedRow);
  expect(await app.queryRuntimeState()).toMatchObject({ ok: true, data: { blocked: true } });
  expect(await app.callProvider(request)).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(stage === 'start' ? 0 : 1);
  expect(db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
});

it('[F-run-query-read-failure] distinguishes a missing Run from a closed database without changing committed facts', async () => {
  const prepare = mock(async () => ({ ok: false as const, error: {
    code: 'provider_runtime_init_failed', category: 'provider' as const, message: 'Preparation failed', retryable: false } }));
  const { app, db, request, root } = fixture({ prepare, async close() { return { stopped: true, closed: true, errors: [] }; } });
  const result = await app.callProvider(request);
  expect(result).toMatchObject({ ok: true, data: { status: 'failed', stopped: true } });
  if (!result.ok) throw new Error(result.error.code);
  const committedRow = db.query('SELECT * FROM runs WHERE id=?').get(result.data.runId);
  const saved = await app.queryRun(result.data.runId);
  expect(saved).toMatchObject({ ok: true, data: {
    status: 'failed', output: null, startedAt: null, error: { code: 'provider_runtime_init_failed' },
    cleanup: { stopped: true, errors: [], lateObservationRequired: false },
  } });
  expect(await app.queryRun(result.data.runId + 1)).toMatchObject({ ok: false, error: { code: 'run_not_found' } });
  expect(await app.queryRun(result.data.runId)).toEqual(saved);
  expect(db.query('SELECT * FROM runs WHERE id=?').get(result.data.runId)).toEqual(committedRow);
  db.close();
  const unreadable = await app.queryRun(result.data.runId);
  expect(unreadable).toMatchObject({ ok: false, error: { code: 'storage_corrupt' } });
  expect('data' in unreadable).toBe(false);
  const raw = new Database(join(root, 'data', 'trial.sqlite'), { readonly: true });
  deferCleanup(() => raw.close());
  expect(raw.query('SELECT * FROM runs WHERE id=?').get(result.data.runId)).toEqual(committedRow);
  expect(prepare).toHaveBeenCalledTimes(1);
});
