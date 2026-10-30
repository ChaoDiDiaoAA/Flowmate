import { _electron as electron } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanupResources, closeDesktopFixture, mkdtemp, waitFor } from '../support/resources.ts';

test.afterEach(cleanupResources);
test('P6 Refresh activity retries failed request and invoice lists without an execution', async () => {
  test.setTimeout(45_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p6-refresh-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'),
    args: [resolve('out/main/index.js')], env, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await waitFor(() => page.evaluate(async () => { const state = await window.flowmate.getState(); return state.ok && state.data.ready; }));
    await app.evaluate(({ ipcMain }) => {
      const at = '2026-10-03T00:00:00.000Z';
      const counts = { requests: 0, actions: 0, executions: 0, fail: true };
      Reflect.set(globalThis, 'activityRefresh', counts);
      const session = { sessionId: 12, nativeSessionId: 'p6-refresh', title: 'Refresh conversation', status: 'active',
        createdAt: at, updatedAt: at, availability: 'ready', historyState: 'recoverable', activeRunId: null,
        modelUseBlocked: false, deletePending: false, hasBusinessHistory: false };
      const replace = (channel: string, handler: (...args: any[]) => unknown) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); };
      const error = { ok: false, error: { code: 'storage_read_failed', category: 'storage', message: 'Controlled list failure.', retryable: true } };
      replace('flowmate:list-sessions', () => ({ ok: true, data: { items: [session], next: null } }));
      replace('flowmate:query-session', () => ({ ok: true, data: session }));
      replace('flowmate:list-session-messages', () => ({ ok: true, data: { session, leafId: null, entryCount: 0, items: [], nextBeforeEntryId: null } }));
      replace('flowmate:list-documents', () => ({ ok: true, data: { items: [{ documentRef: { id: 4, version: 'refresh:parsed-v3:fixture' },
        displayName: 'Refresh invoice', isHidden: false, status: 'available', pageCount: 1, originalArtifactId: 10,
        parsedArtifactId: 11, warnings: [], unavailableReason: null, createdAt: at, updatedAt: at }], nextBeforeId: null } }));
      replace('flowmate:list-jobs', () => ({ ok: true, data: { items: [], nextBeforeId: null } }));
      replace('flowmate:list-session-runs', () => {
        counts.requests++;
        return counts.fail ? error : { ok: true, data: { items: [{ runId: 101, sessionId: 12, kind: 'agent',
          status: 'completed', createdAt: at, input: { version: 1, goal: 'Read', text: 'Recovered saved request', messageTimestamp: 1 } }], nextBeforeRunId: null } };
      });
      replace('flowmate:list-activity', () => {
        counts.actions++;
        return counts.fail ? error : { ok: true, data: { items: [{ id: 1, type: 'document_imported', occurredAt: at,
          actorSource: 'user', operationRef: 'refresh-fixture', documentId: 4, jobId: null, candidateId: null,
          artifactId: 11, runId: null, result: 'succeeded', safeSummary: 'Invoice imported', errorCode: null }], nextBeforeId: null } };
      });
      for (const channel of ['flowmate:start-run', 'flowmate:submit-input', 'flowmate:cancel-run', 'flowmate:start-task',
        'flowmate:call-provider', 'flowmate:cancel-provider', 'flowmate:start-invoice-form-run'])
        replace(channel, () => { counts.executions++; return error; });
    });
    await page.reload();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.locator('.rail').getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Conversation', { exact: true }).selectOption('12');
    await page.getByLabel(/^Invoice or processing record/).selectOption('invoice:4');
    await expect(page.getByTestId('activity-page')).toContainText('could not be loaded');
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'activityRefresh').actions)).toBe(1);
    // A nonexistent request is a harmless positive control for the public cancel channel.
    // It proves that the mutation counter is wired before checking refresh's zero increment.
    const control = await page.evaluate(() => window.flowmate.cancelRun(Number.MAX_SAFE_INTEGER));
    expect(control).toMatchObject({ ok: false, error: { message: 'Controlled list failure.' } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activityRefresh').executions)).toBe(1);
    await app.evaluate(() => { Reflect.get(globalThis, 'activityRefresh').executions = 0; });
    const before = await app.evaluate(() => ({ ...Reflect.get(globalThis, 'activityRefresh') }));
    await app.evaluate(() => { Reflect.get(globalThis, 'activityRefresh').fail = false; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(page.getByLabel('Processing request', { exact: true }).locator('option')).toContainText(['Choose a processing request', 'Recovered saved request']);
    await expect(page.getByTestId('activity-page')).toContainText('document imported');
    await expect(page.getByTestId('activity-page').getByRole('alert')).toHaveCount(0);
    const after = await app.evaluate(() => ({ ...Reflect.get(globalThis, 'activityRefresh') }));
    expect(after.requests).toBe(before.requests + 1); expect(after.actions).toBe(before.actions + 1); expect(after.executions).toBe(0);
    const traceId = '00000000-0000-4000-8000-000000000006', traceRoot = join(userData, 'evaluation-fixture/agent-eval/traces', traceId);
    mkdirSync(traceRoot, { recursive: true });
    writeFileSync(join(traceRoot, 'trace.json'), JSON.stringify({ id: traceId, revision: 1, source: { kind: 'product', productRoot: userData, runId: '101', sessionId: '12' }, entry: 'chats',
      startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:01.000Z', input: { prompt: 'Recovered saved request' }, output: 'Controlled captured answer',
      status: 'completed', complete: true, gaps: [], configuration: {}, events: [], facts: {}, materials: [] }));
    const isolatedTraceId = '00000000-0000-4000-8000-000000000007', isolatedRoot = join(userData, 'evaluation-fixture/agent-eval/traces', isolatedTraceId);
    mkdirSync(isolatedRoot, { recursive: true });
    writeFileSync(join(isolatedRoot, 'trace.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(traceRoot, 'trace.json'), 'utf8')),
      id: isolatedTraceId, source: { kind: 'evaluation', runId: '101', sessionId: '12', executionId: 'isolated-execution', trialId: 'isolated-trial' } }));
    const foreignTraceId = '00000000-0000-4000-8000-000000000008', foreignRoot = join(userData, 'evaluation-fixture/agent-eval/traces', foreignTraceId);
    mkdirSync(foreignRoot, { recursive: true });
    writeFileSync(join(foreignRoot, 'trace.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(traceRoot, 'trace.json'), 'utf8')),
      id: foreignTraceId, source: { kind: 'product', productRoot: join(userData, 'isolated-host'), runId: '101', sessionId: '12' } }));
    await page.getByLabel('Processing request', { exact: true }).selectOption('101');
    await expect(page.getByRole('button', { name: 'Open evaluation trace', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open evaluation trace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Evaluation', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: `${traceId} · revision 1`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open source Activity', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open evaluation trace', exact: true }).click();
    await expect(page.getByRole('heading', { name: `${traceId} · revision 1`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh traces', exact: true }).click();
    await page.getByRole('button', { name: foreignTraceId, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open source Activity', exact: true })).toHaveCount(0);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activityRefresh').executions)).toBe(0);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await closeDesktopFixture(app, userData, failure); }
});
