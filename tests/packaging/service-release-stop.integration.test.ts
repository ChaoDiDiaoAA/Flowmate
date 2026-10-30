import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appError, ok, ToolRuntimeObservationSchema, type Result } from '@flowmate/contracts';
import { changeServiceRelease } from '../../apps/maintenance/service-release.ts';
import * as registration from '../../packages/shared/src/service-registration.ts';
import * as publication from '../../packages/shared/src/service-upgrade.ts';
import { prepareServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { acquireProductControllerLock } from '../../packages/shared/src/controller-lock.ts';
import { defaultProductSettings } from '../../packages/core/src/configuration/settings.ts';
import { backupStore } from '../../packages/core/src/storage/maintenance.ts';
import { inspectRuntimeRecovery } from '../../packages/core/src/storage/repositories.ts';
import { invoiceWorkToolsFixture, invoiceWorkCandidateDraft } from '../support/invoice-work-tools.ts';
import { packageOwnerFixture, removeOwnerFixture } from '../service/owner-fixture.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code + ': ' + value.error.message); return value.data; }
let packaged: Awaited<ReturnType<typeof packageOwnerFixture>>;
beforeAll(async () => { packaged = await packageOwnerFixture(); }, 45000);
afterAll(() => { if (packaged) removeOwnerFixture(packaged.root); });
afterEach(() => mock.restore());

type ToolCase = 'failed-stop-missing' | 'cancelled-stop-missing' | 'write-unknown';
async function fixture(confirmed: boolean, toolCase?: ToolCase) {
  const f = await invoiceWorkToolsFixture(), at = f.created.receivedAt;
  const runtimeRoot = join(f.paths.root, 'program/resources/flowmate-runtime'); cpSync(packaged.runtimeRoot, runtimeRoot, { recursive: true });
  await f.database.transaction(scope => {
    if (toolCase) {
      const writing = toolCase === 'write-unknown', status = toolCase === 'cancelled-stop-missing' ? 'cancelled' : 'failed';
      const argumentsValue = writing ? { documentId: 1, candidate: invoiceWorkCandidateDraft() }
        : { documentId: 1, page: 1, afterBlockId: null, limit: 10 };
      const call = need(scope.toolCalls.request({ context: null, invoiceWorkScope: f.product.scope, runId: f.runId, sessionId: f.created.sessionId,
        nativeToolCallId: 'original-maintenance-tool-' + toolCase, toolName: writing ? 'save_invoice_candidate' : 'read_invoice_document',
        toolVersion: '1', effect: writing ? 'LOCAL_WRITE' : 'READ', rawArguments: argumentsValue, requestedAt: at }));
      need(scope.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: argumentsValue }));
      need(scope.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
      const observation = writing ? ToolRuntimeObservationSchema.parse({ version: 1, groupKey: 'original-maintenance-write',
        strategyVersion: 'runtime-v1', sampleSource: 'test', beforeOutcome: 'allowed', failureStage: 'commit', diagnosticCode: 'operation_result_unknown',
        afterStructure: 'valid', afterDomain: 'valid', executionDurationMs: 0, timingComplete: true, effectiveTimeoutMs: null,
        timeoutSource: null, runDeadlineTruncated: false, commit: 'unknown',
        commitError: appError('operation_result_unknown', 'storage', 'The original local write has no confirmed commit receipt.') }) : undefined;
      const finished = need(scope.toolCalls.finish({ toolCallId: call.toolCallId,
        result: { version: 1, status, committedCandidateId: null,
          error: appError(writing ? 'operation_result_unknown' : 'controlled_tool_failure', 'tool', 'The original controlled ToolCall ended.') },
        cleanup: { version: 1, stopped: true, stopReason: 'controlled-tool-return', errors: [] }, endedAt: at,
        stoppedAt: writing ? at : null, ...(observation ? { runtimeObservation: observation } : {}) }));
      expect(finished).toMatchObject({ status, stoppedAt: writing ? at : null, cleanup: { stopped: true } });
      if (writing) expect(need(scope.toolCalls.queryCandidateCommit({ toolCallId: call.toolCallId, runId: f.runId, sessionId: f.created.sessionId }))).toBeNull();
    }
    const work = need(scope.invoiceWorks.get({ view: 'work', workId: f.created.workId }));
    need(scope.invoiceWorkAttempts.requestStop({ workId: f.created.workId, attemptId: f.attemptId,
      requestId: 'original-maintenance-stop', expectedRevision: work.work.revision }, { at }));
    need(scope.invoiceWorks.closeUnsubmittedPhase({ workId: f.created.workId, attemptId: f.attemptId,
      requestId: f.phase.requestId, at, stopResult: { workId: f.created.workId, sessionId: f.created.sessionId,
        attemptId: f.attemptId, stopped: true, reason: 'not-started' } }));
    const run = need(scope.runs.get(f.runId));
    need(scope.runs.finish(f.runId, { status: 'failed', output: null,
      error: appError('controlled_original_failure', 'runtime', 'The original maintenance Run failed.'), usage: run.usage,
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      cleanup: { version: 1, stopped: confirmed, stopReason: confirmed ? 'confirmed-native-stop' : 'unknown',
        errors: [], lateObservationRequired: !confirmed }, endedAt: at, stoppedAt: confirmed ? at : null, durationMs: 0 }));
    if (confirmed && !toolCase) expect(need(scope.invoiceWorkAttempts.finish({ workId: f.created.workId, attemptId: f.attemptId,
      runId: f.runId, at, effectsReconciled: true })).closed).toBe(true);
    const saved = need(scope.invoiceWorks.get({ view: 'work', workId: f.created.workId, limit: 100 }));
    if (saved.view !== 'work') throw Error('Expected the original invoice membership.');
    for (const item of saved.items) need(scope.invoiceWorks.replaceTodos({ workId: f.created.workId, itemId: item.itemId,
      expectedRevision: item.revision, at, todos: [{ actor: 'user', action: 'continue', fieldPath: null,
        problem: 'The original invoice is waiting for explicit human continuation.', needed: 'Review the original invoice before continuing.',
        satisfiedBy: 'The user submits an explicit original continuation.', basis: { origin: 'rule', documentRefs: [item.documentRef],
          sourceRefs: [], inputIds: [], candidateRef: null } }] }));
  });
  expect(inspectRuntimeRecovery(f.database.db)).toBeNull();
  expect(need(await f.database.read(scope => scope.runs.get(f.runId)))).toMatchObject({ runtimeKind: 'durable', status: 'failed',
    stoppedAt: confirmed ? at : null, cleanup: { stopped: confirmed, lateObservationRequired: !confirmed } });
  await f.database.close();
  const prepared = need(await prepareServiceInstallation({ runtimeRoot, dataRoot: f.paths.root }));
  const installation = { ...prepared, enabled: true, activationOperationId: randomUUID(), activationSettingsRevision: 0 };
  const file = join(f.paths.root, 'service-installation.json'); writeFileSync(file, JSON.stringify(installation));
  writeFileSync(join(f.paths.root, 'data/settings.json'), JSON.stringify(defaultProductSettings()));
  const release = JSON.parse(readFileSync(join(runtimeRoot, 'release.json'), 'utf8'));
  writeFileSync(join(f.paths.root, 'data/installed-release.json'), JSON.stringify({ version: 1, releaseId: release.releaseId,
    productVersion: release.productVersion, schemaVersion: 22, settingsVersion: 7 }));
  const backups = join(f.paths.root, 'backups'); mkdirSync(backups);
  const lease = need(await acquireProductControllerLock(f.paths));
  let source: Awaited<ReturnType<typeof backupStore>>;
  try { source = await backupStore(f.paths, join(backups, 'selected-original')); }
  finally { need(await lease.release()); }
  const selected = need(source);
  spyOn(registration, 'readServiceRegistration').mockResolvedValue(ok(null));
  const ffi = await import('bun:ffi'), actual = ffi.dlopen;
  spyOn(ffi, 'dlopen').mockImplementation((library, definitions) => {
    if (Object.prototype.hasOwnProperty.call(definitions, 'OpenSCManagerW')) throw Error('The isolated stop fixture forbids SCM access.');
    return actual(library, definitions);
  });
  return { ...f, file, installation, selected, request: { operation: 'restore-service-release' as const, paths: f.paths,
    runtimeRoot, destination: join(backups, 'before-restore'),
    backup: { directory: selected.directory, backupId: selected.manifest.backupId } } };
}

test('restore rejects a real Durable failed Run with unknown stopping even when the Legacy recovery scan is empty', async () => {
  const f = await fixture(false), authority = readFileSync(f.file), database = readFileSync(f.paths.databaseFile);
  const publish = spyOn(publication, 'publishServiceRelease');
  const result = await changeServiceRelease(f.request);
  expect(result).toMatchObject({ ok: false, error: { code: 'maintenance_stop_unconfirmed' } });
  expect(publish).not.toHaveBeenCalled(); expect(existsSync(join(f.paths.root, 'data/service-restore.json'))).toBe(false);
  expect(readFileSync(f.file)).toEqual(authority); expect(readFileSync(f.paths.databaseFile)).toEqual(database);
  expect(existsSync(join(f.request.destination, 'manifest.json'))).toBe(true);
}, 45000);

test('restore permits an open Work whose actual Run and Tool execution are closed and only original human actions remain', async () => {
  const f = await fixture(true), authority = readFileSync(f.file);
  const result = need(await changeServiceRelease(f.request));
  expect(result).toMatchObject({ installation: f.installation, restoredBackupId: f.selected.manifest.backupId, productReadyVerified: false, leaseReleased: true });
  expect(readFileSync(f.file)).toEqual(authority); expect(existsSync(join(f.paths.root, 'data/service-restore.json'))).toBe(false);
}, 45000);

for (const status of ['failed', 'cancelled'] as const) test('restore rejects a legal ' + status + ' ToolCall with positive cleanup but no original stoppedAt', async () => {
  const toolCase = status === 'failed' ? 'failed-stop-missing' : 'cancelled-stop-missing';
  const f = await fixture(true, toolCase), authority = readFileSync(f.file), database = readFileSync(f.paths.databaseFile);
  const publisher = spyOn(publication, 'publishServiceRelease');
  expect(await changeServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'maintenance_stop_unconfirmed' } });
  expect(publisher).not.toHaveBeenCalled(); expect(existsSync(join(f.paths.root, 'data/service-restore.json'))).toBe(false);
  expect(readFileSync(f.file)).toEqual(authority); expect(readFileSync(f.paths.databaseFile)).toEqual(database);
}, 45000);

test('restore rejects an ended local-write ToolCall whose original candidate commit remains unknown', async () => {
  const f = await fixture(true, 'write-unknown'), authority = readFileSync(f.file), database = readFileSync(f.paths.databaseFile);
  const publisher = spyOn(publication, 'publishServiceRelease');
  expect(await changeServiceRelease(f.request)).toMatchObject({ ok: false, error: { code: 'maintenance_stop_unconfirmed' } });
  expect(publisher).not.toHaveBeenCalled(); expect(existsSync(join(f.paths.root, 'data/service-restore.json'))).toBe(false);
  expect(readFileSync(f.file)).toEqual(authority); expect(readFileSync(f.paths.databaseFile)).toEqual(database);
}, 45000);
