import { _electron as electron, type Page } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { INVOICE_REVIEW_TOOL_NAMES as INVOICE_TOOL_NAMES, NATIVE_TOOL_NAMES } from '@flowmate/contracts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, installReadGate, mkdtemp, waitFor } from '../support/resources.ts';

it.afterEach(cleanupResources);

const electronPath = resolve(import.meta.dirname, '../../node_modules/electron/dist/electron.exe');
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64');

it('P6 Activity reads persistent processing through Electron without another model request', async () => {
  it.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p6-activity-ui-'));
  let requestCount = 0;
  const server = await createHttpProvider(() => { requestCount++; return streamText('P6 controlled saved answer.'); });
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ executablePath: electronPath, args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p6-observation', credentialRef: '00000000000000000000000000000003',
        name: 'Controlled P6', kind: 'custom', providerId: null, baseUrl: `${baseUrl}/v1`, model: 'p6-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'p6-observation' },
      { modelId: 'p6-observation', apiKey: 'synthetic-p6-controlled-key' });
    }, `http://127.0.0.1:${server.port}`)).toMatchObject({ ok: true });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message to model' }).fill('P6 original body must never appear in a runtime event.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.chat-transcript')).toContainText('P6 controlled saved answer.', { timeout: 20_000 });
    await expect.poll(() => requestCount).toBe(1);
    const identity = await page.evaluate(async () => {
      const chats = await window.flowmate.listSessions({ limit: 50 }); if (!chats.ok || !chats.data.items[0]) return null;
      const sessionId = chats.data.items[0].sessionId;
      const runs = await window.flowmate.listSessionRuns({ sessionId, limit: 50 });
      return runs.ok && runs.data.items[0] ? { runId: runs.data.items[0].runId, sessionId } : null;
    });
    expect(identity).not.toBeNull(); if (!identity) return;
    expect(await page.locator('.rail .nav-item').count()).toBe(12);
    await page.locator('.rail').getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(page.getByTestId('activity-page')).toBeVisible();
    await page.getByLabel('Conversation', { exact: true }).selectOption(String(identity.sessionId));
    await page.getByLabel('Processing request', { exact: true }).selectOption(String(identity.runId));
    await expect(page.getByTestId('processing-details')).toContainText('Processing completed', { timeout: 15_000 });
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'query_runtime_events'));
    const pendingPage = page.evaluate(id => window.flowmate.queryRuntimeEvents({ ...id,
      cursor: { runId: id.runId, lastPersistedSequence: 0 }, limit: 100 }), identity);
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    let persisted = await page.evaluate(id => window.flowmate.queryRuntimeEvents({ ...id,
      cursor: { runId: id.runId, lastPersistedSequence: 0 }, limit: 100 }), identity);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').release(0));
    const pendingResult = await pendingPage;
    expect(pendingResult.ok || pendingResult.error.code === 'event_query_busy', JSON.stringify(pendingResult)).toBe(true);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    expect(persisted).toMatchObject({ ok: false, error: { code: 'event_query_busy' } });
    await expect.poll(async () => {
      persisted = await page.evaluate(id => window.flowmate.queryRuntimeEvents({ ...id,
        cursor: { runId: id.runId, lastPersistedSequence: 0 }, limit: 100 }), identity);
      if (!persisted.ok && persisted.error.code !== 'event_query_busy') throw new Error(JSON.stringify(persisted));
      return persisted;
    }, { timeout: 15_000 }).toMatchObject({ ok: true, data: { coverage: 'from-created' } });
    if (persisted.ok) {
      expect(persisted.data.items.map(item => item.sequence)).toEqual(persisted.data.items.map((_, index) => index + 1));
      expect(persisted.data.items.map(item => item.type)).toContain('run_completed');
      expect(JSON.stringify(persisted)).not.toContain('P6 original body');
    }
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await page.getByText('Model request diagnostics', { exact: true }).click();
    await expect(page.getByText('This diagnostic buffer belongs to the current process and is separate from saved activity.', { exact: true })).toBeVisible();
    expect(requestCount).toBe(1);
    const screenshots = process.env.FLOWMATE_SCREENSHOT_ROOT ? join(process.env.FLOWMATE_SCREENSHOT_ROOT, 'p6') : join(userData, 'p6-ui');
    mkdirSync(screenshots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.rail').getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByLabel('Theme').selectOption(theme);
      await page.getByRole('button', { name: 'Save appearance', exact: true }).click();
      await page.locator('.rail').getByRole('button', { name: 'Activity', exact: true }).click();
      await expect(page.getByTestId('processing-details')).toContainText('Processing completed');
      for (const [width, height] of [[1440, 900], [1280, 800], [980, 720]] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.locator('.desktop-shell')).toHaveClass(new RegExp(`theme-${theme}`));
      await page.getByRole('button', { name: 'Refresh activity', exact: true }).focus();
      await page.screenshot({ path: join(screenshots, `${width}x${height}-${theme}-activity.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await page.getByRole('button', { name: 'Refresh activity', exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
      }
    }
    await page.reload();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.locator('.rail').getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Conversation', { exact: true }).selectOption(String(identity.sessionId));
    await page.getByLabel('Processing request', { exact: true }).selectOption(String(identity.runId));
    await expect(page.getByTestId('processing-details')).toContainText('Processing completed');
    expect(requestCount).toBe(1);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { try { if (app) { await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); } } finally { await server.stop(true); } }
});

it('P6 Activity preserves drafts and verified history across a gap, a lost wake and a late page', async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p6-replay-ui-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: electronPath, args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let failure: Error | undefined;
  try {
    const page = await app.firstWindow();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    await app.evaluate(({ ipcMain }) => {
      const at = '2026-10-03T00:00:00.000Z';
      const session = (id: number) => ({ sessionId: id, nativeSessionId: `p6-${id}`, title: `Observation ${id}`, status: 'active',
        createdAt: at, updatedAt: at, availability: 'ready', historyState: 'recoverable', activeRunId: null,
        modelUseBlocked: false, deletePending: false, hasBusinessHistory: false });
      const run = (id: number) => ({ kind: 'agent', runId: id, sessionId: id === 101 ? 12 : 13, jobId: null, status: 'completed',
        input: { version: 1, goal: 'Read saved activity', text: 'Saved question', messageTimestamp: 1 },
        config: { runtimeBudget: { maxToolCalls: 0, maxModelCalls: 12, toolTimeoutMs: 10_000 } },
        output: { agent: { modelCallCount: 1 } }, usage: { version: 1, source: 'unknown', reason: null, sdkValues: null,
          attempts: null, attemptsComplete: false, costSource: null, updatedAt: at },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        durationMs: 100, toolCallCount: 0, error: null, cleanup: { stopped: true, lateObservationRequired: false },
        createdAt: at, startedAt: at, endedAt: at, cancelRequestedAt: receipt.stopping ? at : null, stoppedAt: at,
        scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] } });
      const context = (id: number, h: number) => ({ runId: id, sessionId: id === 101 ? 12 : 13, highWatermark: h,
        coverage: h === 0 ? 'none' : id === 201 ? 'partial' : 'from-created', availableRange: h === 0 ? null : { fromSequence: 1, toSequence: h } });
      const event = (id: number, seq: number) => ({ eventId: id * 10 + seq, runId: id, sessionId: id === 101 ? 12 : 13,
        toolCallId: null, sequence: seq, sourceConnection: null, sourceSequence: null, occurredAt: at, receivedAt: at,
        type: id === 201 ? seq === 1 ? 'run_started' : 'run_completed' : seq === 1 ? 'run_created' : 'run_started',
        payload: { version: 1, status: id === 201 ? seq === 1 ? 'running' : 'completed' : seq === 1 ? 'created' : 'running',
          origin: 'live', errorCode: null, stopped: id === 201 && seq === 2 ? true : null } });
      const receipt = { bHigh: 0, failNext: false, reads: 0, activeReads: 0, maxReads: 0, holds: 0, holdRun: null as number | null,
        release: null as (() => void) | null, removed: [] as string[], commands: 0,
        failDetails: false, showTools: false, heldTool: null as (() => void) | null, toolRequests: [] as number[],
        stopping: false, blocked: false, traceAvailability: 'evicted', failTrace: false, cursors: [] as number[], historyReads: 0 };
      Reflect.set(globalThis, 'p6Replay', receipt);
      const replace = (channel: string, handler: (...args: any[]) => unknown) => {
        ipcMain.removeHandler(channel); ipcMain.handle(channel, handler);
      };
      replace('flowmate:list-sessions', () => ({ ok: true, data: { items: [session(12), session(13)], next: null } }));
      replace('flowmate:query-session', (_event, id) => ({ ok: true, data: session(id) }));
      replace('flowmate:list-session-messages', (_event, input) => {
        receipt.historyReads++;
        return { ok: true, data: { session: session(input.sessionId), leafId: null, entryCount: 0, items: [], nextBeforeEntryId: null } };
      });
      replace('flowmate:list-session-runs', (_event, input) => ({ ok: true, data: { items: [run(input.sessionId === 12 ? 101 : 201)], nextBeforeRunId: null } }));
      const unavailable = { ok: false, error: { code: 'storage_read_failed', category: 'storage', retryable: true, message: 'Controlled details failed.' } };
      const tool = (id: number) => ({ toolCallId: id, runId: 201, sessionId: 13,
        toolName: id === 10 ? 'read_invoice_document' : 'list_invoice_pages', status: 'succeeded', requestedAt: at,
        startedAt: at, endedAt: at, stoppedAt: at, committedCandidateId: null, errorCode: null, stopped: true,
        deliveryState: 'request_observed', formApplicationOutcome: null });
      replace('flowmate:query-run', (_event, id) => receipt.failDetails ? unavailable : ({ ok: true,
        data: { ...run(id), status: receipt.stopping ? 'running' : 'completed' } }));
      replace('flowmate:query-runtime-state', () => ({ ok: true, data: { active: null, blocked: receipt.blocked,
        error: receipt.blocked ? { code: 'runtime_unusable', category: 'runtime', retryable: false, message: 'Controlled stop is unconfirmed.' } : null } }));
      replace('flowmate:query-prompt-trace', () => receipt.failTrace ? unavailable : ({ ok: true, data: { availability: receipt.traceAvailability, calls: [], droppedCalls: null } }));
      replace('flowmate:list-run-tool-calls', () => receipt.failDetails ? unavailable : ({ ok: true,
        data: { items: receipt.showTools ? [tool(10), tool(20)] : [], nextBeforeId: null } }));
      replace('flowmate:query-run-tool-call', async (_event, input) => {
        receipt.toolRequests.push(input.toolCallId);
        if (input.toolCallId === 10) await new Promise<void>(resolve => { receipt.heldTool = resolve; });
        return { ok: true, data: tool(input.toolCallId) };
      });
      replace('flowmate:subscribe-runtime-events', (_event, input) => ({ ok: true, data: { ...context(input.runId, input.runId === 101 ? 3 : receipt.bHigh), subscriptionId: `observed-${input.runId}` } }));
      replace('flowmate:unsubscribe-runtime-events', (_event, id) => { receipt.removed.push(id); return { ok: true }; });
      replace('flowmate:query-runtime-events', async (_event, input) => {
        receipt.reads++; receipt.activeReads++; receipt.maxReads = Math.max(receipt.maxReads, receipt.activeReads);
        const h = input.runId === 101 ? 3 : receipt.bHigh;
        try {
          if (receipt.holdRun === input.runId) { receipt.holds++; await new Promise<void>(resolve => { receipt.release = resolve; }); }
          const c = input.cursor.lastPersistedSequence, d = input.availableAfterSequence;
          if (input.runId === 201) receipt.cursors.push(c);
          if (receipt.failNext) { return { ok: false, error: { code: 'storage_read_failed', category: 'storage',
            retryable: true, message: 'Controlled observation read failed.' }, context: context(input.runId, h) }; }
          if (input.runId === 101 && c === 1 && d === undefined) return { ok: false, error: { code: 'event_gap', category: 'storage',
            retryable: false, message: 'A persisted event interval is missing.' }, context: { ...context(101, h),
              gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } };
          const position = d ?? c;
          const sequences = input.runId === 101 ? [1, 3] : h === 0 ? [] : [1, ...(h === 2 ? [2] : [])];
          const items = sequences.filter(seq => seq > position).slice(0, 1).map(seq => event(input.runId, seq));
          const last = items.at(-1)?.sequence ?? position;
          return { ok: true, data: { ...context(input.runId, h), items,
            nextCursor: { runId: input.runId, lastPersistedSequence: d === undefined ? last : c },
            nextAvailableAfterSequence: d === undefined ? null : last, hasMore: last < h } };
        } finally { receipt.activeReads--; }
      });
      for (const channel of ['flowmate:submit-input', 'flowmate:start-run', 'flowmate:call-provider', 'flowmate:cancel-run', 'flowmate:cancel-provider'])
        replace(channel, () => { receipt.commands++; return { ok: false }; });
    });
    await page.addInitScript(() => {
      const ids = new Set<number>(); Reflect.set(window, 'p6ObservationTimers', ids);
      const start = window.setInterval.bind(window), stop = window.clearInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const id = start(handler, timeout, ...args); if (timeout === 2000) ids.add(id); return id;
      }) as typeof window.setInterval;
      Reflect.set(window, 'clearInterval', (id?: number) => { if (id !== undefined) ids.delete(id); stop(id); });
    });
    await page.reload();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.locator('.sidebar-chat[data-session-id="13"]').click();
    await expect(page.getByRole('main', { name: 'Assistant', exact: true }).getByText('Observation 13', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh history', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Draft retained while reading activity');
    await page.locator('.rail').getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Conversation', { exact: true }).selectOption('12');
    await page.getByLabel('Processing request', { exact: true }).selectOption('101');
    await expect(page.getByRole('button', { name: 'View available activity after the gap', exact: true })).toBeVisible();
    await expect(page.getByTestId('processing-details')).toContainText('Missing recorded activity: 2 to 2.');
    await expect(page.getByTestId('processing-details')).toContainText('Available recorded activity: 1 to 3.');
    await page.getByRole('button', { name: 'View available activity after the gap', exact: true }).click();
    await expect(page.getByText('Showing an available segment. The continuous position is still 1.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '3']);
    // Saved running facts describe the original request; they never start a live request.
    await expect(page.getByTestId('processing-details').getByText('Processing started', { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('processing-details').getByText('completed', { exact: true })).toBeVisible();
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).count()).toBe(0);
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').holdRun = 101; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Replay').activeReads)).toBe(1);
    await page.getByLabel('Conversation', { exact: true }).selectOption('13');
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').failDetails = true; });
    await page.getByLabel('Processing request', { exact: true }).selectOption('201');
    await app.evaluate(() => { const receipt = Reflect.get(globalThis, 'p6Replay'); receipt.holdRun = null; receipt.release?.(); });
    await expect(page.getByText('No runtime events were recorded for this request. Saved messages and results remain available.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveCount(0);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Replay').removed)).toContain('observed-101');
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').failDetails = true; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(page.getByText('Processing details could not be confirmed.', { exact: false })).toBeVisible();
    await expect(page.getByText('Tool activity could not be confirmed.', { exact: false })).toBeVisible();
    await expect(page.getByText('Tool activity has not yet been verified.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('processing-details').getByText('Loading', { exact: true })).toBeVisible();
    await expect(page.getByText('No tools recorded.', { exact: true })).toHaveCount(0);
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').failDetails = false; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(page.getByText('Tool activity could not be confirmed.', { exact: false })).toHaveCount(0);
    await expect(page.getByText('No tools recorded.', { exact: true })).toBeVisible();
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').showTools = true; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await page.locator('.activity-tools').getByRole('button', { name: /Read invoice document/ }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Replay').toolRequests)).toEqual([10]);
    await page.locator('.activity-tools').getByRole('button', { name: /List invoice pages/ }).click();
    await expect(page.locator('.activity-tool-detail')).toContainText('List invoice pages');
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').heldTool?.(); });
    await page.waitForTimeout(100);
    await expect(page.locator('.activity-tool-detail')).toContainText('List invoice pages');
    await expect(page.locator('.activity-tool-detail')).not.toContainText('Read invoice document');
    // Change the saved-page source without sending any wake or touching the view.
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').bHigh = 1; });
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1'], { timeout: 5_000 });
    await expect(page.getByText('Partial recorded history', { exact: true })).toBeVisible();
    await expect(page.getByTestId('processing-details')).toContainText('Available recorded activity: 1 to 1.');
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').bHigh = 2; });
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '2'], { timeout: 5_000 });
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Replay').cursors.at(-1))).toBe(2);
    const historyBeforeTemporary = await app.evaluate(() => Reflect.get(globalThis, 'p6Replay').historyReads);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', {
      type: 'message_upsert', runId: 201, sessionId: 13, nativeSessionId: 'p6-13', sequence: 40,
      at: '2026-10-03T00:00:00.000Z', message: { entryId: null, runId: 201, liveOrdinal: 1,
        timestamp: 1790985600000, persistence: 'pending', truncated: false, role: 'assistant',
        blocks: [{ type: 'text', text: 'Temporary text is not a persisted position.' }], phase: 'streaming',
        stopReason: 'pending', toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' } }));
    // The native Session/Run binding is real in this Renderer fixture: its message receiver
    // requests saved history to reconcile sequence40, while the independent event C remains2.
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Replay').historyReads)).toBeGreaterThan(historyBeforeTemporary);
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Replay').cursors.at(-1))).toBe(2);
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '2']);
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').failTrace = true; });
    await page.getByText('Model request diagnostics', { exact: true }).click();
    await expect(page.getByText('Model request diagnostics are unavailable.', { exact: true })).toBeVisible();
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').failTrace = false; });
    await page.getByText('Model request diagnostics', { exact: true }).click();
    await page.getByText('Model request diagnostics', { exact: true }).click();
    await expect(page.getByText('Model request diagnostics are unavailable.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('These diagnostics were evicted from the process buffer.', { exact: false })).toBeVisible();
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').traceAvailability = 'process-exited'; });
    await page.getByText('Model request diagnostics', { exact: true }).click();
    await page.getByText('Model request diagnostics', { exact: true }).click();
    await expect(page.getByText('The process that collected these diagnostics has exited.', { exact: false })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      const r = Reflect.get(globalThis, 'p6Replay'); r.stopping = true; r.blocked = true;
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'provider_finished',
        requestId: 'p6-blocked-observation', runId: 300, result: { ok: false, error: { code: 'runtime_unusable',
          category: 'runtime', retryable: false, message: 'Controlled stop is unconfirmed.' } } });
    });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(page.getByTestId('processing-details').getByText('Stopping', { exact: true })).toBeVisible();
    await expect(page.getByText('New requests are blocked. Saved processing details remain available to read.', { exact: true })).toBeVisible({ timeout: 5_000 });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Replay').commands)).toBe(0);
    await app.evaluate(({ BrowserWindow }) => {
      const r = Reflect.get(globalThis, 'p6Replay'); r.stopping = false; r.blocked = false;
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'provider_finished',
        requestId: 'p6-cleared-observation', runId: 300, result: { ok: false, error: { code: 'runtime_unusable',
          category: 'runtime', retryable: false, message: 'Controlled status refresh.' } } });
    });
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').failNext = true; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(page.getByText('Controlled observation read failed.', { exact: false })).toBeVisible();
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '2']);
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Replay').failNext = false; });
    // The native 2s poll may already heal this transient error and remove its retry button.
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect(page.getByText('Controlled observation read failed.', { exact: false })).toHaveCount(0);
    await app.evaluate(() => { const receipt = Reflect.get(globalThis, 'p6Replay'); receipt.holdRun = 201; receipt.maxReads = 0; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Replay').activeReads)).toBe(1);
    const held = await app.evaluate(() => Reflect.get(globalThis, 'p6Replay').reads);
    await page.waitForTimeout(4_200);
    expect(await app.evaluate(() => ({ reads: Reflect.get(globalThis, 'p6Replay').reads, max: Reflect.get(globalThis, 'p6Replay').maxReads })))
      .toEqual({ reads: held, max: 1 });
    await app.evaluate(() => { const receipt = Reflect.get(globalThis, 'p6Replay'); receipt.holdRun = null; receipt.release?.(); });
    await expect(page.getByRole('textbox', { name: 'Message to model' })).toHaveValue('Draft retained while reading activity');
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Replay').commands)).toBe(0);
    await page.locator('.rail').getByRole('button', { name: 'Invoices', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'p6ObservationTimers').size)).toBe(0);
    const afterLeaving = await app.evaluate(() => Reflect.get(globalThis, 'p6Replay').reads);
    await page.waitForTimeout(2_200);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Replay').reads)).toBe(afterLeaving);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { await app.evaluate(() => { const receipt = Reflect.get(globalThis, 'p6Replay'); if (receipt) { receipt.holdRun = null; receipt.release?.(); } }).catch(() => {});
    await closeDesktopFixture(app, userData, failure); }
});

it('P6 Renderer checks beyond H and preserves C and D across late opens, expired subscriptions and visibility changes', async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p6-observer-lifecycle-'));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({ executablePath: electronPath, args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let failure: Error | undefined, stage = 'launch';
  try {
    const page = await app.firstWindow();
    await waitFor(() => page.evaluate(async () => { const result = await window.flowmate.getState(); return result.ok && result.data.ready; }));
    // These Main boundary responses exercise the real Renderer/preload receiver. SQL and Host
    // lease behavior are tested separately; no wake or timer can repair the H handoff here.
    await app.evaluate(({ ipcMain }) => {
      const at = '2026-10-03T00:00:00.000Z';
      const receipt = { holdOpen: true, releaseOpen: null as (() => void) | null, bHigh: 1, expireNext: false,
        opens: [] as Array<{ runId: number; subscriptionId: string; c: number }>, removed: [] as string[],
        reads: [] as Array<{ runId: number; subscriptionId: string; c: number; d: number | null; through: number | null }>, commands: 0 };
      Reflect.set(globalThis, 'p6Lifecycle', receipt);
      const session = (id: number) => ({ sessionId: id, nativeSessionId: `lifecycle-${id}`, title: `Lifecycle ${id}`, status: 'active',
        createdAt: at, updatedAt: at, availability: 'ready', historyState: 'recoverable', activeRunId: null,
        modelUseBlocked: false, deletePending: false, hasBusinessHistory: false });
      const run = (id: number) => ({ kind: 'agent', runId: id, sessionId: id === 101 ? 12 : 13, jobId: null, status: 'completed',
        input: { version: 1, goal: 'Observe', text: 'Saved lifecycle request', messageTimestamp: 1 },
        config: { runtimeBudget: { maxToolCalls: 0, maxModelCalls: 12 } }, output: { agent: { modelCallCount: 1 } },
        usage: { version: 1, source: 'unknown', reason: null, sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: at },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        durationMs: 100, toolCallCount: 0, error: null, cleanup: { stopped: true, lateObservationRequired: false },
        createdAt: at, startedAt: at, endedAt: at, cancelRequestedAt: null, stoppedAt: at,
        scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] } });
      const context = (id: number, h: number) => ({ runId: id, sessionId: id === 101 ? 12 : 13, highWatermark: h,
        coverage: 'from-created', availableRange: { fromSequence: 1, toSequence: h } });
      const event = (id: number, sequence: number) => ({ eventId: id * 10 + sequence, runId: id,
        sessionId: id === 101 ? 12 : 13, toolCallId: null, sequence, sourceConnection: null, sourceSequence: null,
        occurredAt: at, receivedAt: at, type: sequence === 1 ? 'run_created' : 'run_completed',
        payload: { version: 1, status: sequence === 1 ? 'created' : 'completed', origin: 'live', stopped: sequence === 1 ? null : true, errorCode: null } });
      const replace = (channel: string, handler: (...args: any[]) => unknown) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); };
      replace('flowmate:list-sessions', () => ({ ok: true, data: { items: [session(12), session(13)], next: null } }));
      replace('flowmate:query-session', (_event, id) => ({ ok: true, data: session(id) }));
      replace('flowmate:list-session-messages', (_event, input) => ({ ok: true, data: { session: session(input.sessionId), leafId: null,
        entryCount: 0, items: [], nextBeforeEntryId: null } }));
      replace('flowmate:list-session-runs', (_event, input) => ({ ok: true, data: { items: [run(input.sessionId === 12 ? 101 : 201)], nextBeforeRunId: null } }));
      replace('flowmate:query-run', (_event, id) => ({ ok: true, data: run(id) }));
      replace('flowmate:query-runtime-state', () => ({ ok: true, data: { active: null, blocked: false, error: null } }));
      replace('flowmate:list-run-tool-calls', () => ({ ok: true, data: { items: [], nextBeforeId: null } }));
      replace('flowmate:subscribe-runtime-events', async (_event, input) => {
        const subscriptionId = `lifecycle-${input.runId}-${receipt.opens.length + 1}`;
        const h = input.runId === 101 ? 3 : receipt.bHigh;
        receipt.opens.push({ runId: input.runId, subscriptionId, c: input.cursor.lastPersistedSequence });
        if (input.runId === 101 && receipt.holdOpen) await new Promise<void>(resolve => { receipt.releaseOpen = resolve; });
        return { ok: true, data: { ...context(input.runId, h), subscriptionId } };
      });
      replace('flowmate:unsubscribe-runtime-events', (_event, id) => { receipt.removed.push(id); return { ok: true }; });
      replace('flowmate:query-runtime-events', (_event, input) => {
        const c = input.cursor.lastPersistedSequence, d = input.availableAfterSequence ?? null;
        receipt.reads.push({ runId: input.runId, subscriptionId: input.subscriptionId, c, d, through: input.throughSequence ?? null });
        if (receipt.expireNext) {
          receipt.expireNext = false;
          return { ok: false, error: { code: 'event_subscription_invalid', category: 'input', retryable: false, message: 'The observation lease expired.' }, context: null };
        }
        const h = input.runId === 101 ? 3 : receipt.bHigh;
        if (input.runId === 101 && c === 1 && d === null) return { ok: false, error: { code: 'event_gap', category: 'storage',
          retryable: false, message: 'A recorded interval is missing.' }, context: { ...context(101, h), gap: { fromSequence: 2, toSequence: 2, continueAfterSequence: 2 } } };
        const through = input.throughSequence ?? h, position = d ?? c;
        const items = (input.runId === 101 ? [1, 3] : [1, 2]).filter(sequence => sequence > position && sequence <= through)
          .slice(0, 1).map(sequence => event(input.runId, sequence));
        const last = items.at(-1)?.sequence ?? position;
        // The next persisted event appears after the last bounded page; its wake is lost.
        if (input.runId === 201 && input.throughSequence === 1) receipt.bHigh = 2;
        return { ok: true, data: { ...context(input.runId, h), items, nextCursor: { runId: input.runId, lastPersistedSequence: d === null ? last : c },
          nextAvailableAfterSequence: d === null ? null : last, hasMore: last < through } };
      });
      for (const channel of ['flowmate:start-run', 'flowmate:submit-input', 'flowmate:cancel-run', 'flowmate:call-provider',
        'flowmate:cancel-provider', 'flowmate:start-task', 'flowmate:start-invoice-form-run'])
        replace(channel, () => { receipt.commands++; return { ok: false }; });
    });
    await page.addInitScript(() => {
      const start = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        start(timeout === 2000 ? () => {} : handler, timeout, ...args)) as typeof window.setInterval;
    });
    await page.reload();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Lifecycle observation preserves this draft');
    // Playwright normally forces document.hasFocus() to true, which masks native blur.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await page.locator('.rail').getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('Conversation', { exact: true }).selectOption('12');
    await page.getByLabel('Processing request', { exact: true }).selectOption('101');
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.length)).toBe(1);
    await page.getByLabel('Conversation', { exact: true }).selectOption('13');
    await page.getByLabel('Processing request', { exact: true }).selectOption('201');
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '2']);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').reads.filter((read: { runId: number }) => read.runId === 201)))
      .toMatchObject([{ c: 0, through: 1 }, { c: 1, through: null }]);
    await app.evaluate(() => { const receipt = Reflect.get(globalThis, 'p6Lifecycle'); receipt.holdOpen = false; receipt.releaseOpen?.(); });
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').removed)).toContain('lifecycle-101-1');
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '2']);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').reads.some((read: { runId: number }) => read.runId === 101))).toBe(false);
    const settledReads = await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').reads.length);
    await page.waitForTimeout(2_200);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').reads.length)).toBe(settledReads);

    await page.getByLabel('Conversation', { exact: true }).selectOption('12');
    await page.getByLabel('Processing request', { exact: true }).selectOption('101');
    await page.getByRole('button', { name: 'View available activity after the gap', exact: true }).click();
    await expect(page.getByText('Showing an available segment. The continuous position is still 1.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '3']);
    const beforeExpiry = await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.length);
    await app.evaluate(() => { Reflect.get(globalThis, 'p6Lifecycle').expireNext = true; });
    await page.getByRole('button', { name: 'Refresh activity', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.length)).toBe(beforeExpiry + 1);
    const renewedId = await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.at(-1).subscriptionId);
    await expect.poll(() => app.evaluate((_electron, id) => Reflect.get(globalThis, 'p6Lifecycle').reads.filter((read: { subscriptionId: string }) => read.subscriptionId === id), renewedId))
      .toMatchObject([{ runId: 101, c: 1, d: 3, through: 3 }, { runId: 101, c: 1, d: 3, through: null }]);
    await expect(page.getByText('Showing an available segment. The continuous position is still 1.', { exact: true })).toBeVisible();

    stage = 'secondary handoff';
    const primaryHandle = await app.browserWindow(page);
    const primaryId = await primaryHandle.evaluate(window => window.id); await primaryHandle.dispose();
    await page.evaluate(() => {
      const trace: unknown[] = [];
      const record = (event: Event | string) => { trace.push({ at: Date.now(), event: typeof event === 'string' ? event : event.type,
        hasFocus: document.hasFocus(), hidden: document.hidden, visibilityState: document.visibilityState }); if (trace.length > 32) trace.shift(); };
      window.addEventListener('focus', record); window.addEventListener('blur', record); document.addEventListener('visibilitychange', record);
      record('before-handoff'); Reflect.set(window, 'p6FocusTrace', trace);
    });
    await app.evaluate(async ({ BrowserWindow }, primaryId) => {
      const primary = BrowserWindow.fromId(primaryId)!;
      Reflect.set(globalThis, 'p6PrimaryWindow', primary);
      const focusWindow = new BrowserWindow({ width: 200, height: 160, show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      Reflect.set(globalThis, 'p6FocusWindow', focusWindow);
      const trace: unknown[] = [];
      const record = (event: string, id: number) => { trace.push({ at: Date.now(), event, id,
        primaryDestroyed: primary.isDestroyed(), secondaryDestroyed: focusWindow.isDestroyed(),
        primaryFocused: !primary.isDestroyed() && primary.isFocused(), secondaryFocused: !focusWindow.isDestroyed() && focusWindow.isFocused(), secondaryVisible: !focusWindow.isDestroyed() && focusWindow.isVisible(),
        focusedId: BrowserWindow.getFocusedWindow()?.id ?? null, webContentsFocused: !primary.isDestroyed() && primary.webContents.isFocused() }); if (trace.length > 32) trace.shift(); };
      Reflect.set(globalThis, 'p6NativeFocusTrace', trace);
      for (const window of [primary, focusWindow]) { const id = window.id; window.on('focus', () => record('focus', id)); window.on('blur', () => record('blur', id));
        window.on('show', () => record('show', id)); window.on('hide', () => record('hide', id)); }
      record('before-load', primary.id);
      await focusWindow.loadURL('about:blank'); record('before-show', focusWindow.id); focusWindow.show(); focusWindow.focus(); record('after-focus', focusWindow.id);
    }, primaryId);
    try {
      await expect.poll(async () => ({ ...await app.evaluate(({ BrowserWindow }) => {
        const primary = Reflect.get(globalThis, 'p6PrimaryWindow'), secondary = Reflect.get(globalThis, 'p6FocusWindow');
        return { primaryFocused: primary.isFocused(), secondaryVisible: secondary.isVisible(), secondaryFocused: secondary.isFocused(),
          focusedSecondary: BrowserWindow.getFocusedWindow()?.id === secondary.id };
      }), domFocused: await page.evaluate(() => document.hasFocus()) }), { timeout: 5_000 }).toEqual({ primaryFocused: false,
        secondaryVisible: true, secondaryFocused: true, focusedSecondary: true, domFocused: false });
    } catch (error) {
      try { console.error('[T08-P6-FOCUS]', JSON.stringify({ primaryId,
        native: await app.evaluate(() => Reflect.get(globalThis, 'p6NativeFocusTrace')),
        dom: await page.evaluate(() => ({ trace: Reflect.get(window, 'p6FocusTrace'), hasFocus: document.hasFocus() })) })); } catch { /* Preserve original assertion. */ }
      throw error;
    }
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').removed)).toContain(renewedId);
    stage = 'secondary destroyed primary refocus';
    await app.evaluate(() => { Reflect.get(globalThis, 'p6FocusWindow').destroy(); Reflect.get(globalThis, 'p6PrimaryWindow').focus(); });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.length)).toBe(beforeExpiry + 2);
    const focusedId = await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.at(-1).subscriptionId);
    await expect.poll(() => app.evaluate((_electron, id) => Reflect.get(globalThis, 'p6Lifecycle').reads.some((read: { subscriptionId: string; c: number; d: number }) =>
      read.subscriptionId === id && read.c === 1 && read.d === 3), focusedId)).toBe(true);
    await cdp.detach();
    stage = 'primary hidden';
    // CDP keeps document.visibilityState visible even for a hidden native window. Assert
    // the actual Electron visibility and focus, then the Renderer's release/reopen behavior.
    await app.evaluate(() => Reflect.get(globalThis, 'p6PrimaryWindow').hide());
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6PrimaryWindow').isVisible())).toBe(false);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').removed)).toContain(focusedId);
    const hiddenReads = await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').reads.length);
    await page.waitForTimeout(2_200);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').reads.length)).toBe(hiddenReads);
    stage = 'primary visible reopen';
    await app.evaluate(() => { const window = Reflect.get(globalThis, 'p6PrimaryWindow'); window.show(); window.focus(); });
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6PrimaryWindow').isVisible())).toBe(true);
    await expect.poll(() => page.evaluate(() => !document.hidden && document.hasFocus())).toBe(true);
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.length)).toBe(beforeExpiry + 3);
    const visibleId = await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').opens.at(-1).subscriptionId);
    await expect.poll(() => app.evaluate((_electron, id) => Reflect.get(globalThis, 'p6Lifecycle').reads.some((read: { subscriptionId: string; c: number; d: number }) =>
      read.subscriptionId === id && read.c === 1 && read.d === 3), visibleId)).toBe(true);
    await expect(page.getByTestId('processing-details').locator('.activity-sequence')).toHaveText(['1', '3']);
    await expect(page.getByText('Showing an available segment. The continuous position is still 1.', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message to model' })).toHaveValue('Lifecycle observation preserves this draft');
    expect(await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle').commands)).toBe(0);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const facts = await Promise.race([Promise.all([
      app.evaluate(() => { const value = Reflect.get(globalThis, 'p6Lifecycle'); return { native: Reflect.get(globalThis, 'p6NativeFocusTrace'),
        opens: value?.opens.slice(-32), reads: value?.reads.slice(-32), removed: value?.removed.slice(-32), commands: value?.commands }; }),
      app.firstWindow().then(page => page.evaluate(() => ({ dom: Reflect.get(window, 'p6FocusTrace'), focused: document.hasFocus(), hidden: document.hidden }))),
    ]), new Promise(resolve => { timer = setTimeout(() => resolve('diagnostic timeout'), 1000); })]);
      console.error('[T08-P6-STAGE]', JSON.stringify({ stage, facts }));
    } catch { /* Preserve the original assertion and cleanup. */ } finally { clearTimeout(timer); }
    throw failure;
  }
  finally {
    await app.evaluate(() => Reflect.get(globalThis, 'p6Lifecycle')?.releaseOpen?.()).catch(() => {});
    await closeDesktopFixture(app, userData, failure);
  }
});

function writeInvoiceSample(directory: string) {
  mkdirSync(directory, { recursive: true });
  const content = JSON.stringify([
    { type: 'header', text: 'Invoice number: INV-P3-1', bbox: [0, 0, 10, 10], page_idx: 0 },
    { type: 'table', table_body: '<tr><td>100.00</td><td>10.00</td><td>110.00</td></tr>', table_caption: 'Totals',
      bbox: [1, 2, 9, 8], page_idx: 0 },
  ]);
  const pages = JSON.stringify([{ pageNumber: 1, text: 'Invoice number: INV-P3-1', blockCount: 2 }]);
  writeFileSync(join(directory, 'original.png'), onePixelPng);
  writeFileSync(join(directory, 'content.json'), content);
  writeFileSync(join(directory, 'pages.json'), pages);
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify({
    schemaVersion: 1, sampleId: '000001', datasetId: 'voxel51-hq-invoice-ocr',
    sourceRecordId: 'desktop-p3-invoice', datasetRevision: 'rev-1', qualityStatus: 'complete',
    allowedUsesClaim: ['local review'], licenseVerification: 'not_verified', files: [
      { path: 'original.png', bytes: onePixelPng.length },
      { path: 'content.json', bytes: Buffer.byteLength(content) },
      { path: 'pages.json', bytes: Buffer.byteLength(pages) },
    ],
  }));
}

function streamToolCall(name: string, id: string, args: unknown): Response {
  return streamToolCalls([{ name, id, args }]);
}

function streamToolCalls(calls: Array<{ name: string; id: string; args: unknown }>): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: 'desktop-p3-tool-run', object: 'chat.completion.chunk', created: 1,
      model: 'desktop-p3-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const deltas = calls.map((call, index) => chunk({ tool_calls: [{ index, id: call.id, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
  return new Response(`${chunk({ role: 'assistant' })}${deltas.join('')}${chunk({}, 'tool_calls')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function streamText(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id: 'desktop-p3-final', object: 'chat.completion.chunk', created: 1,
      model: 'desktop-p3-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  return new Response(`${chunk({ role: 'assistant', content: text })}${chunk({}, 'stop')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function captureDesktopViews(page: Page) {
  const root = process.env.FLOWMATE_SCREENSHOT_ROOT;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  expect(await page.locator('.rail .nav-item').count()).toBe(12);
  for (const name of ['Invoices', 'Workspace', 'Processing History', 'Chats', 'Activity', 'Models', 'Evaluation', 'Prompts', 'Skills', 'Extensions', 'Settings']) {
    expect(await page.locator('.rail').getByRole('button', { name, exact: true }).count()).toBe(1);
  }
  for (const name of ['Connections', 'Approved Results']) {
    expect(await page.locator('.rail').getByRole('button', { name, exact: true }).count()).toBe(0);
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.locator('.rail').getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption(theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [label, slug] of [['Chats', 'chats'], ['Settings', 'settings']] as const) {
      await page.locator('.rail').getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible' });
      await page.screenshot({ path: join(root, `1440x900-${theme}-${slug}.png`), fullPage: false });
    }
    for (const [width, height] of [[1440, 900], [1280, 800], [980, 720]] as const) {
      await page.setViewportSize({ width, height });
      await nav.getByRole('button', { name: 'Models' }).click();
      await page.getByRole('heading', { name: 'Models', exact: true }).waitFor({ state: 'visible' });
      const name = `${width}x${height}-${theme}`;
      await page.screenshot({ path: join(root, `${name}-models.png`), fullPage: false });
      await nav.getByRole('button', { name: 'Invoices' }).click();
      await page.getByRole('button', { name: 'Results', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(root, `${name}.png`), fullPage: false });
      if (width === 980) {
        await page.getByRole('button', { name: 'Open Assistant' }).click();
        expect(await page.getByRole('textbox', { name: 'Message to model' }).evaluate((element) => document.activeElement === element)).toBe(true);
        await page.screenshot({ path: join(root, `${name}-assistant.png`), fullPage: false });
        await page.keyboard.press('Escape');
        expect(await page.getByRole('button', { name: 'Open Assistant' }).evaluate((element) => document.activeElement === element)).toBe(true);
        await page.getByRole('button', { name: 'Open navigation' }).click();
        expect(await nav.getByRole('button', { name: 'Processing History' }).isVisible()).toBe(true);
        expect(await nav.getByRole('button', { name: 'Models' }).isVisible()).toBe(true);
        await page.screenshot({ path: join(root, `${name}-navigation.png`), fullPage: false });
        await page.keyboard.press('Escape');
        expect(await page.getByRole('button', { name: 'Open navigation' }).evaluate((element) => document.activeElement === element)).toBe(true);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function capturePiModelViews(page: Page) {
  const root = process.env.FLOWMATE_SCREENSHOT_ROOT;
  if (!root) return;
  mkdirSync(root, { recursive: true });
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  for (const theme of ['light', 'dark'] as const) {
    await page.locator('.rail').getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption(theme);
    await nav.getByRole('button', { name: 'Models' }).click();
    for (const [width, height] of [[1440, 900], [1280, 800], [980, 720]] as const) {
      await page.setViewportSize({ width, height });
      const name = `${width}x${height}-${theme}-pi-model`;
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(root, `${name}.png`), fullPage: false });
      await page.getByRole('heading', { name: 'Connection check' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(root, `${name}-auth.png`), fullPage: false });
      await page.locator('.workspace').evaluate((element) => { element.scrollTop = 0; });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.rail').getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Theme').selectOption('system');
  await nav.getByRole('button', { name: 'Models' }).click();
}

for (const action of ['last-window', 'quit', 'main-exit'] as const) {
  it(`desktop ${action} aborts an in-flight Provider and releases its storage`, async () => {
    it.setTimeout(40_000);
    const userData = await mkdtemp(join(tmpdir(), `flowmate-desktop-${action}-`));
    let requests = 0;
    let markStarted!: () => void;
    let markDisconnected!: () => void;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    const disconnected = new Promise<void>((resolveDisconnected) => { markDisconnected = resolveDisconnected; });
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests += 1;
        response.on('close', markDisconnected);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'desktop-shutdown', choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial' }, finish_reason: null }] })}\n\n`);
        markStarted();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no port');
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.FLOWMATE_TEST_MODE = '1';
    env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
    let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
    let failure: Error | undefined;
    try {
      electronApp = await electron.launch({
        args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
      const page = await electronApp.firstWindow();
      await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      const saved = await page.evaluate(async (port) => {
        const state = await window.flowmate.getState();
        if (!state.ok) return state;
        return window.flowmate.saveSettings({ ...state.data.settings,
          models: [{ id: 'shutdown-model', credentialRef: '00000000000000000000000000000004', name: 'Shutdown model', kind: 'custom', providerId: null,
            baseUrl: `http://127.0.0.1:${port}/v1`, model: 'shutdown-model', api: 'openai-completions',
            contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'shutdown-model',
        }, { modelId: 'shutdown-model', apiKey: 'synthetic-desktop-shutdown-key' });
      }, address.port);
      expect(saved.ok).toBe(true);
      expect(requests).toBe(0);
      const accepted = await page.evaluate(() => window.flowmate.callProvider({
        modelId: 'shutdown-model', goal: 'Verify controlled shutdown.', text: 'Hold this response until the desktop closes.',
      }));
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      await started;
      expect(await page.evaluate((runId) => window.flowmate.queryRun(runId), accepted.data.runId))
        .toMatchObject({ ok: true, data: { status: 'running' } });
      const exited = once(electronApp.process(), 'exit');
      if (action === 'last-window') await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close(); });
      if (action === 'quit') await electronApp.evaluate(({ app }) => { app.quit(); });
      if (action === 'main-exit') await electronApp.evaluate(() => { process.exit(0); }).catch(() => undefined);
      await Promise.all([exited, disconnected]);
      electronApp = null;
      const databaseFile = join(userData, 'data', 'app.sqlite');
      for (let attempt = 0; existsSync(`${databaseFile}.lock`) && attempt < 200; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(existsSync(`${databaseFile}.lock`)).toBe(false);
      const db = new Database(databaseFile, { readonly: true });
      try {
        const row = db.query('SELECT status,error_json,cleanup_json,stopped_at,cancel_requested_at FROM runs WHERE id=?').get(accepted.data.runId) as {
          status: string; error_json: string; cleanup_json: string; stopped_at: string | null; cancel_requested_at: string | null;
        };
        expect(row.status).toBe('failed');
        expect(JSON.parse(row.error_json)).toMatchObject({ code: 'runtime_shutdown' });
        expect(JSON.parse(row.cleanup_json)).toMatchObject({ stopped: true, stopReason: 'shutdown', errors: [], lateObservationRequired: false });
        expect(row.stopped_at).not.toBeNull();
        expect(row.cancel_requested_at).toBeNull();
        expect(db.query('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 });
        expect(requests).toBe(1);
      } finally { db.close(); }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw failure;
    } finally {
      try { if (electronApp) await closeDesktopFixture(electronApp, userData, failure); }
      finally { server.closeAllConnections(); await new Promise<void>(resolveClosed => server.close(() => resolveClosed())); }
    }
  });
}

for (const unknownCode of ['operation_result_unknown', 'input_delivery_unknown'] as const) {
for (const unknownMode of ['steer', 'followUp'] as const) {
it(`desktop manages same-Run inputs, recovers whitespace ${unknownMode} ${unknownCode} and continues from a saved reply`, async () => {
  it.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p5-'));
  const requests: unknown[] = [];
  const firstResponse = { release: null as (() => void) | null };
  const server = await createHttpProvider(async request => {
    const body = await request.json();
    requests.push(body);
    if (JSON.stringify(body).includes('P5 stop input')) return new Promise<Response>(() => {});
    if (requests.length !== 1) return streamText(`P5 saved reply ${requests.length}`);
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
      `data: ${JSON.stringify({ id: 'p5-held', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: 'P5 first reply' })));
      firstResponse.release = () => { controller.enqueue(encoder.encode(`${chunk({}, 'stop')}data: [DONE]\n\n`)); controller.close(); };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[name]) env[name] = process.env[name];
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    electronApp = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await electronApp.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p5-model', credentialRef: '00000000000000000000000000000005',
        name: 'P5 model', kind: 'custom', providerId: null, baseUrl: `${baseUrl}/v1`, model: 'p5-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'p5-model' },
      { modelId: 'p5-model', apiKey: 'synthetic-p5-key' });
    }, `http://127.0.0.1:${server.port}`)).toMatchObject({ ok: true });
    await page.locator('.rail').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByLabel('Default model requests', { exact: true }).fill('32');
    await page.getByLabel('Default tool calls', { exact: true }).fill('40');
    await page.getByLabel('Default tool timeout (ms)', { exact: true }).fill('20000');
    await page.getByLabel('Default Run timeout (ms)', { exact: true }).fill('90000');
    await page.getByRole('button', { name: 'Save Run limits', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Run limits saved.' })).toBeVisible();
    expect(requests).toHaveLength(0);
    await expect(page.getByText('Next Run limits', { exact: true })).toHaveCount(0);
    await electronApp.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get('flowmate:submit-input'); if (!original) throw new Error('Missing submit-input');
      ipcMain.removeHandler('flowmate:submit-input');
      ipcMain.handle('flowmate:submit-input', async (event, ...args) => {
        const saved = globalThis as unknown as { originalP5Request?: import('@flowmate/contracts').DesktopSessionInputRequest };
        saved.originalP5Request ??= args[0] as import('@flowmate/contracts').DesktopSessionInputRequest;
        return original(event, ...args);
      });
    });
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    await composer.fill('P5 initial input');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(await page.evaluate(async () => {
      const active = await window.flowmate.queryRuntimeState();
      if (!active.ok || !active.data.active || active.data.active.kind === 'compaction') throw new Error('Missing active Run');
      return window.flowmate.queryRun(active.data.active.runId);
    })).toMatchObject({ ok: true, data: { config: { version: 2,
      runtimeBudget: { maxModelCalls: 32, maxToolCalls: 40, toolTimeoutMs: 20000 },
      limits: { timeoutMs: 90000, stopGraceMs: 5000 } } } });
    const active = await page.evaluate(() => window.flowmate.queryRuntimeState());
    expect(active).toMatchObject({ ok: true, data: { active: { runId: expect.any(Number), sessionId: expect.any(Number) } } });
    if (!active.ok || !active.data.active || active.data.active.kind === 'compaction' || active.data.active.sessionId === null) throw new Error('P5 Run did not start');
    const { runId, sessionId } = active.data.active;
    const crossSession = await page.evaluate(async ({ sessionId, runId }) => {
      const other = await window.flowmate.createSession({ title: 'Other P5 chat' });
      if (!other.ok) return other;
      return window.flowmate.submitInput({ sessionId: other.data.sessionId, runId, clientSequence: 1, mode: 'steer', text: 'Wrong Run' });
    }, { sessionId, runId });
    expect(crossSession.ok).toBe(false);
    await electronApp.evaluate(({ ipcMain }, code) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get('flowmate:submit-input'); if (!original) throw new Error('Missing submit-input');
      ipcMain.removeHandler('flowmate:submit-input'); let lost = false;
      ipcMain.handle('flowmate:submit-input', async (event, ...args) => {
        const result = await original(event, ...args);
        if (!lost) { lost = true; return { ok: false, error: { code, category: 'session', message: 'Controlled active input receipt loss', retryable: true } }; }
        return result;
      });
    }, unknownCode);
    const submittedDraft = `  P5 ${unknownMode} input \n `;
    const laterDraft = '  Extra draft while receipt unknown  ';
    await composer.fill(submittedDraft);
    await page.getByRole('button', { name: unknownMode === 'steer' ? 'Steer' : 'Follow up', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toBeVisible();
    await expect(composer).toHaveValue(submittedDraft);
    await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Follow up', exact: true })).toBeDisabled();
    const originalActiveInput = await page.evaluate(id => window.flowmate.querySessionInput({ sessionId: id, clientSequence: 2 }), sessionId);
    expect(originalActiveInput).toMatchObject({ ok: true, data: { input: { mode: unknownMode, runId,
      content: { text: `P5 ${unknownMode} input` } } } });
    await composer.fill(`${submittedDraft}\n\n${laterDraft}`);
    await page.getByRole('button', { name: 'Check input status', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue(laterDraft);
    expect(await page.evaluate(id => window.flowmate.querySessionInput({ sessionId: id, clientSequence: 2 }), sessionId)).toEqual(originalActiveInput);
    const recoveredInputs = await page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), sessionId);
    expect(recoveredInputs.ok && recoveredInputs.data.items.length).toBe(2);
    expect(requests).toHaveLength(1);
    const acceptedMode = unknownMode === 'steer' ? 'followUp' : 'steer';
    await electronApp.evaluate(({ ipcMain }, mode) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get('flowmate:submit-input'); if (!original) throw new Error('Missing submit-input');
      const gate = { release: null as (() => void) | null };
      (globalThis as unknown as { acceptedAppendDraftGate: typeof gate }).acceptedAppendDraftGate = gate;
      ipcMain.removeHandler('flowmate:submit-input');
      ipcMain.handle('flowmate:submit-input', async (event, input) => {
        const result = await original(event, input);
        if (input.mode === mode) await new Promise<void>(resolveReceipt => { gate.release = resolveReceipt; });
        return result;
      });
    }, acceptedMode);
    const acceptedDraft = `  P5 ${acceptedMode} input  `;
    const acceptedLaterDraft = '  New draft while append is accepted  ';
    await composer.fill(acceptedDraft);
    await page.getByRole('button', { name: acceptedMode === 'steer' ? 'Steer' : 'Follow up', exact: true }).click();
    await expect.poll(() => electronApp!.evaluate(() => Boolean((globalThis as unknown as {
      acceptedAppendDraftGate: { release: (() => void) | null } }).acceptedAppendDraftGate.release))).toBe(true);
    await composer.fill(unknownCode === 'operation_result_unknown' ? `${acceptedDraft}\n\n${acceptedLaterDraft}` : acceptedLaterDraft);
    await electronApp.evaluate(() => (globalThis as unknown as { acceptedAppendDraftGate: { release: (() => void) | null } }).acceptedAppendDraftGate.release?.());
    await expect(page.getByRole('button', { name: acceptedMode === 'steer' ? 'Steer' : 'Follow up', exact: true })).toBeEnabled();
    await expect(composer).toHaveValue(acceptedLaterDraft);
    await expect.poll(async () => {
      const inputs = await page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), sessionId);
      return inputs.ok ? inputs.data.items.map(input => [input.mode, input.runId]) : [];
    }).toEqual([[acceptedMode, runId], [unknownMode, runId], ['prompt', runId]]);
    await expect(page.getByText(/^Inputs ·/)).toHaveCount(0);
    await expect(page.getByTestId('session-input')).toHaveCount(0);
    expect(requests).toHaveLength(1);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats', exact: true }).click();
    await expect(page.locator(`.chat-directory-row[data-session-id="${sessionId}"]`).getByRole('button', { name: 'Archive', exact: true })).toBeDisabled();
    firstResponse.release?.();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => {
      const inputs = await page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), sessionId);
      return inputs.ok ? inputs.data.items.map(input => [input.status, input.processingStatus, Boolean(input.nativeEntryId), Boolean(input.resultEntryId)]) : [];
    }).toEqual(Array.from({ length: 3 }, () => ['consumed', 'completed', true, true]));
    expect(await page.evaluate(id => window.flowmate.listSessionRuns({ sessionId: id }), sessionId))
      .toMatchObject({ ok: true, data: { items: [{ runId }] } });
    await expect(page.locator('[data-testid="chat-turn"][data-message-role="user"]')).toHaveCount(3);
    const callsBeforeManagement = requests.length;
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats', exact: true }).click();
    const row = page.locator(`.chat-directory-row[data-session-id="${sessionId}"]`);
    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible();
    await expect(page.locator('.chat-config-hint')).toHaveText('This chat is archived. Unarchive it in Chats to continue.');
    await composer.fill('P5 preserved archived draft');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    const archivedWorkspace = await page.evaluate(() => window.flowmate.readWorkspace());
    expect(archivedWorkspace).toMatchObject({ ok: true, data: { sessionId: null } });
    await row.getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(archivedWorkspace);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    expect(await composer.inputValue()).toBe('P5 preserved archived draft');
    const reply = page.locator('[data-testid="chat-turn"][data-message-role="assistant"]').first();
    const targetEntryId = await reply.getAttribute('data-message-entry');
    await reply.getByRole('button', { name: 'Continue from this reply', exact: true }).click();
    const branch = await page.evaluate(id => window.flowmate.listSessionMessages({ sessionId: id }), sessionId);
    expect(branch).toMatchObject({ ok: true, data: { leafId: targetEntryId } });
    expect(requests).toHaveLength(callsBeforeManagement);
    await electronApp.evaluate(({ ipcMain }, code) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get('flowmate:submit-input'); if (!original) throw new Error('Missing submit-input');
      ipcMain.removeHandler('flowmate:submit-input'); let lost = false;
      ipcMain.handle('flowmate:submit-input', async (event, ...args) => {
        const result = await original(event, ...args);
        if (!lost) { lost = true; (globalThis as typeof globalThis & { p5PromptLostReceiptResult?: unknown }).p5PromptLostReceiptResult = result;
          if ((result as { ok?: boolean }).ok !== true) return result;
          return { ok: false, error: { code, category: 'runtime', message: 'Controlled receipt loss', retryable: true } }; }
        return result;
      });
    }, unknownCode);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByLabel('Default model requests', { exact: true }).fill('31');
    await page.getByRole('button', { name: 'Save Run limits', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Run limits saved.' })).toBeVisible();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await composer.fill('P5 unknown receipt input');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toBeVisible();
    const actualPromptReceipt = await electronApp.evaluate(() => (globalThis as typeof globalThis & { p5PromptLostReceiptResult?: unknown }).p5PromptLostReceiptResult);
    expect(actualPromptReceipt, JSON.stringify({ actualPromptReceipt, workspace: await page.evaluate(() => window.flowmate.readWorkspace()) })).toMatchObject({ ok: true });
    await expect(composer).toHaveValue('P5 unknown receipt input');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { runtime: { budget: { maxModelCalls: 31 } } } } });
    await page.getByRole('button', { name: 'Check input status', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue('');
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { runtime: { budget: { maxModelCalls: 31 } } } } });
    await expect.poll(async () => {
      const inputs = await page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), sessionId);
      return inputs.ok ? inputs.data.items.length : 0;
    }).toBe(4);
    await waitFor(() => page.evaluate(async () => { const runtime = await window.flowmate.queryRuntimeState();
      return runtime.ok && runtime.data.active === null && !runtime.data.blocked; }));
    await composer.fill('P5 stop input');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => JSON.stringify(requests.at(-1)).includes('P5 stop input')).toBe(true);
    for (const button of await page.getByRole('button', { name: 'Continue from this reply', exact: true }).all())
      await expect(button).toBeDisabled();
    await composer.fill('Draft typed while stopping');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({ timeout: 20_000 });
    await waitFor(() => page.evaluate(async () => { const runtime = await window.flowmate.queryRuntimeState();
      return runtime.ok && runtime.data.active === null && !runtime.data.blocked; }));
    await expect(composer).toHaveValue('Draft typed while stopping');
    await expect.poll(async () => {
      const inputs = await page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), sessionId);
      return inputs.ok ? inputs.data.items[0]?.processingStatus : null;
    }).toBe('cancelled');
    const callsAfterStop = requests.length;
    await row.getByRole('button', { name: 'Archive', exact: true }).click();
    await row.getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(composer).toHaveValue('Draft typed while stopping');
    expect(requests).toHaveLength(callsAfterStop);
    const originalPrompt = await electronApp.evaluate(() =>
      (globalThis as unknown as { originalP5Request: import('@flowmate/contracts').DesktopSessionInputRequest }).originalP5Request);
    if (originalPrompt.mode !== 'prompt') throw new Error('Original prompt request was not retained.');
    const originalInput = await page.evaluate(id => window.flowmate.querySessionInput({ sessionId: id, clientSequence: 1 }), sessionId);
    if (!originalInput.ok || !originalInput.data.input) throw new Error('Original input was not saved.');
    const originalReceipt = { ok: true, data: { sessionId, runId, inputId: originalInput.data.input.inputId } };
    expect(await page.evaluate(async () => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: state.data.settings.models.map(model => ({ ...model,
        name: 'Changed after admission', model: 'changed-model', baseUrl: 'http://127.0.0.1:1/v1' })) });
    })).toMatchObject({ ok: true });
    expect(await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      return state.ok ? state.data.modelCredentials['p5-model'] : null;
    })).toBe('missing');
    expect(await page.evaluate(request => window.flowmate.submitInput(request), originalPrompt)).toMatchObject(originalReceipt);
    expect(await page.evaluate(request => window.flowmate.submitInput({ ...request, text: 'Changed original input' }), originalPrompt))
      .toMatchObject({ ok: false, error: { code: 'state_conflict' } });
    expect(await page.evaluate(async () => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [], defaultModelId: null });
    })).toMatchObject({ ok: true });
    expect(await page.evaluate(request => window.flowmate.submitInput(request), originalPrompt)).toMatchObject(originalReceipt);
    expect(requests).toHaveLength(callsAfterStop);
    expect(await page.locator('.rail .nav-item').count()).toBe(12);
    const closingApp = electronApp;
    electronApp = null;
    await closeDesktopFixture(closingApp, userData);
    const db = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
    try {
      expect(db.query('SELECT count(*) AS count FROM runs WHERE session_id=?').get(sessionId)).toEqual({ count: 3 });
      expect(db.query('SELECT count(*) AS count FROM session_inputs WHERE session_id=?').get(sessionId)).toEqual({ count: 5 });
      expect(db.query('SELECT mode,run_id,status,processing_status,native_entry_id IS NOT NULL AS user_saved,result_entry_id IS NOT NULL AS reply_saved FROM session_inputs WHERE run_id=? ORDER BY id').all(runId))
        .toEqual(['prompt', unknownMode, acceptedMode].map(mode => ({ mode, run_id: runId, status: 'consumed', processing_status: 'completed', user_saved: 1, reply_saved: 1 })));
    } finally { db.close(); }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (electronApp) {
      console.error('P5 desktop state at failure', await electronApp.firstWindow().then(page => page.evaluate(async () => ({
        runtime: await window.flowmate.queryRuntimeState(), sessions: await window.flowmate.listSessions(),
        assistant: document.querySelector('[data-testid="agent-chat-panel"]')?.textContent,
        draft: (document.querySelector('#agent-chat-input') as HTMLTextAreaElement | null)?.value,
      }))).catch(() => null));
    }
    throw failure;
  }
  finally { try { if (electronApp) await closeDesktopFixture(electronApp, userData, failure); } finally { await server.stop(true); } }
});
}
}

it('desktop discloses the active Run and frozen invoice after the viewed invoice changes', async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-active-context-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-desktop-active-context-source-'));
  const sources = [join(sourceRoot, '000001'), join(sourceRoot, '000002')];
  for (const [index, source] of sources.entries()) {
    writeInvoiceSample(source);
    const metadata = JSON.parse(readFileSync(join(source, 'metadata.json'), 'utf8'));
    writeFileSync(join(source, 'metadata.json'), JSON.stringify({ ...metadata,
      sampleId: index === 0 ? '000001' : '000002', sourceRecordId: `active-context-${index + 1}` }));
  }
  const requests: unknown[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolveResponse => { release = resolveResponse; });
  const server = await createHttpProvider(async request => {
    requests.push(await request.json()); await barrier; return streamText('Original invoice response.');
  });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[name]) env[name] = process.env[name];
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  env.FLOWMATE_TEST_INVOICE_SOURCE_ROOT = sourceRoot;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate(async port => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'active-context-model', credentialRef: '00000000000000000000000000000006',
        name: 'Active context model', kind: 'custom', providerId: null, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'active-context-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'active-context-model' },
      { modelId: 'active-context-model', apiKey: 'synthetic-active-context-key' });
    }, server.port)).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    for (const source of sources) {
      await app.evaluate(({ dialog }, selectedDirectory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedDirectory] }); }, source);
      await page.getByRole('button', { name: /Import invoice/ }).click();
      await page.getByRole('heading', { name: source.endsWith('000001') ? 'Invoice 000001' : 'Invoice 000002', exact: true }).waitFor();
    }
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices', exact: true }).click();
    await page.locator('.invoice-context .processing-open').filter({ hasText: 'Invoice 000001' }).click();
    await expect(page.locator('.chat-context')).toContainText('Working with Invoice 000001');
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    await composer.fill('Explain the original invoice.');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    const original = await page.evaluate(async () => {
      const state = await window.flowmate.queryRuntimeState();
      if (!state.ok || !state.data.active || state.data.active.kind === 'compaction') throw new Error('Missing active Run');
      const run = await window.flowmate.queryRun(state.data.active.runId); if (!run.ok) throw new Error('Missing frozen Run');
      return run.data;
    });
    expect(original.config).toMatchObject({ workspaceContext: { documentRef: { id: 1 }, sessionId: original.sessionId } });
    await page.locator('.invoice-context .processing-open').filter({ hasText: 'Invoice 000002' }).click();
    await page.getByRole('heading', { name: 'Invoice 000002', exact: true }).waitFor();
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { documentRef: { id: 2 } } });
    await expect(page.locator('.chat-context')).toContainText('Responding to Invoice 000001');
    await expect(page.locator('.chat-context')).toContainText('Invoice 000001');
    await expect(page.locator('.chat-context')).not.toContainText('Invoice 000002');
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models', exact: true }).click();
    await page.getByRole('button', { name: '＋ Add', exact: true }).click();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices', exact: true }).click();
    await expect(page.locator('.chat-context')).toContainText('Responding to Invoice 000001');
    await expect(page.locator('.chat-context')).toContainText('Invoice 000001');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.locator('.chat-context')).not.toContainText('Responding to Invoice 000001');
    await page.locator(`.sidebar-chat[data-session-id="${original.sessionId}"]`).click();
    await expect(page.locator('.chat-context')).toContainText('Responding to Invoice 000001');
    await expect(page.locator('.chat-context')).toContainText('Invoice 000001');
    await composer.fill('Keep this later draft.');
    expect(requests).toHaveLength(1);
    expect(await page.evaluate(id => window.flowmate.queryRun(id), original.runId)).toMatchObject({ ok: true,
      data: { sessionId: original.sessionId, config: { workspaceContext: { documentRef: { id: 1 } } } } });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue('Keep this later draft.');
    await expect.poll(() => page.evaluate(id => window.flowmate.queryRun(id), original.runId)).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(requests).toHaveLength(1);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { release(); try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await server.stop(true); } }
});

for (const outcome of ['accepted', 'accepted-appended', 'rejected', 'unknown', 'unknown-whitespace', 'unknown-whitespace-appended'] as const) {
it(`desktop preserves a newer draft during Send preparation and ${outcome} admission`, async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-preparation-draft-'));
  const requests: unknown[] = [];
  const server = await createHttpProvider(async request => { requests.push(await request.json()); return streamText('Saved preparation reply.'); });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[name]) env[name] = process.env[name];
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'preparation-model', credentialRef: '00000000000000000000000000000007',
        name: 'Preparation model', kind: 'custom', providerId: null, baseUrl: `${baseUrl}/v1`, model: 'preparation-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'preparation-model' },
      { modelId: 'preparation-model', apiKey: 'synthetic-preparation-key' });
    }, `http://127.0.0.1:${server.port}`)).toMatchObject({ ok: true });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    const originalDraft = outcome.startsWith('unknown-whitespace') ? '  Original preparation input  ' : 'Original preparation input';
    await composer.fill(originalDraft);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await app.evaluate(({ ipcMain }, result) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const query = handlers.get('flowmate:query-session-input'), submit = handlers.get('flowmate:submit-input');
      if (!query || !submit) throw new Error('Missing input handlers');
      const gate = { held: false, release: null as (() => void) | null, submitted: null as string | null };
      (globalThis as unknown as { preparationDraftGate: typeof gate }).preparationDraftGate = gate;
      ipcMain.removeHandler('flowmate:query-session-input');
      ipcMain.handle('flowmate:query-session-input', async (event, input) => {
        if (!gate.held && input.clientSequence === undefined) {
          gate.held = true;
          await new Promise<void>(resolveQuery => { gate.release = resolveQuery; });
        }
        return query(event, input);
      });
      ipcMain.removeHandler('flowmate:submit-input');
      ipcMain.handle('flowmate:submit-input', async (event, input) => {
        gate.submitted = input.text;
        if (result === 'rejected') return { ok: false, error: { code: 'input_invalid', category: 'input', message: 'Controlled admission rejection', retryable: false } };
        const accepted = await submit(event, input);
        return result.startsWith('unknown') ? { ok: false, error: { code: 'operation_result_unknown', category: 'runtime', message: 'Controlled receipt loss', retryable: true } } : accepted;
      });
    }, outcome);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { preparationDraftGate: { held: boolean } }).preparationDraftGate.held)).toBe(true);
    const draftDuringPreparation = outcome === 'unknown-whitespace' ? originalDraft
      : outcome.endsWith('-appended') ? `${originalDraft}\n\nNew draft typed while preparing` : 'New draft typed while preparing';
    if (outcome !== 'unknown-whitespace') await composer.fill(draftDuringPreparation);
    await app.evaluate(() => (globalThis as unknown as { preparationDraftGate: { release: (() => void) | null } }).preparationDraftGate.release?.());
    await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { preparationDraftGate: { submitted: string | null } }).preparationDraftGate.submitted))
      .toBe('Original preparation input');
    if (outcome.startsWith('unknown')) {
      await page.getByRole('button', { name: 'Check input status', exact: true }).waitFor();
      await expect(composer).toHaveValue(draftDuringPreparation);
      await page.getByRole('button', { name: 'Check input status', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toHaveCount(0);
    } else await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(composer).toHaveValue(outcome === 'unknown-whitespace' ? '' : 'New draft typed while preparing');
    await expect.poll(() => requests.length).toBe(outcome === 'rejected' ? 0 : 1);
    if (outcome.startsWith('unknown')) {
      if (outcome === 'unknown-whitespace') await composer.fill('Next unsent preparation draft');
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
      const inputs = await page.evaluate(async () => {
        const sessions = await window.flowmate.listSessions(); if (!sessions.ok || !sessions.data.items[0]) throw new Error('Missing preparation Session');
        return window.flowmate.listSessionInputs({ sessionId: sessions.data.items[0].sessionId });
      });
      expect(inputs).toMatchObject({ ok: true, data: { items: [{ content: { text: 'Original preparation input' }, mode: 'prompt' }] } });
      if (inputs.ok) expect(inputs.data.items).toHaveLength(1);
      expect(requests).toHaveLength(1);
    }
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally {
    if (app) await app.evaluate(() => (globalThis as unknown as { preparationDraftGate?: { release: (() => void) | null } }).preparationDraftGate?.release?.()).catch(() => undefined);
    try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await server.stop(true); }
  }
});
}

for (const limit of ['model', 'tool'] as const) {
it(`desktop shows the actual frozen ${limit} allowance after budget exhaustion`, async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-frozen-budget-'));
  const calls: unknown[] = [];
  const server = await createHttpProvider(async request => {
    calls.push(await request.json());
    return streamToolCall('read', `frozen-budget-${calls.length}`, { path: 'missing-budget-file' });
  });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[name]) env[name] = process.env[name];
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'frozen-budget-model', credentialRef: '00000000000000000000000000000008',
        name: 'Frozen budget model', kind: 'custom', providerId: null, baseUrl: `${baseUrl}/v1`, model: 'frozen-budget-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'frozen-budget-model' },
      { modelId: 'frozen-budget-model', apiKey: 'synthetic-frozen-budget-key' });
    }, `http://127.0.0.1:${server.port}`)).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByLabel('Default model requests', { exact: true }).fill(limit === 'model' ? '1' : '4');
    await page.getByLabel('Default tool calls', { exact: true }).fill(limit === 'tool' ? '1' : '3');
    await page.getByRole('button', { name: 'Save Run limits', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Run limits saved.' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message to model' }).fill(`Exhaust the frozen ${limit} allowance`);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const cause = limit === 'model' ? 'request' : 'tool';
    await page.getByRole('log').getByText(`The assistant reached the ${cause} limit before finishing. Check Processing History for any saved result.`, { exact: true })
      .waitFor({ timeout: 15_000 }).catch(async error => {
        console.error('[T08-BUDGET-FACTS]', JSON.stringify({ limit, calls: calls.length, facts: await page.evaluate(async () => {
          const sessions = await window.flowmate.listSessions(); return { runtime: await window.flowmate.queryRuntimeState(), sessions,
            runs: sessions.ok && sessions.data.items[0] ? await window.flowmate.listSessionRuns({ sessionId: sessions.data.items[0].sessionId }) : null,
            log: document.querySelector('[role="log"]')?.textContent?.slice(0, 10000) };
        }) }));
        await it.info().attach('budget-failure', { body: await page.screenshot(), contentType: 'image/png' });
        throw error;
      });
    const current = await page.evaluate(async () => {
      const sessions = await window.flowmate.listSessions(); if (!sessions.ok || !sessions.data.items[0]) throw new Error('Missing budget Session');
      return window.flowmate.listSessionRuns({ sessionId: sessions.data.items[0].sessionId });
    });
    expect(current).toMatchObject({ ok: true, data: { items: [{ status: 'failed', error: { code: limit === 'model' ? 'agent_model_call_budget' : 'tool_budget_exceeded' },
      config: { runtimeBudget: { maxModelCalls: limit === 'model' ? 1 : 4, maxToolCalls: limit === 'tool' ? 1 : 3 } } }] } });
    await expect(page.getByRole('log')).toContainText(limit === 'model' ? '1 model request · 3 tool calls' : '4 model requests · 1 tool call');
    await expect(page.locator('.chat-composer')).not.toContainText('Runtime is');
    await expect(page.getByText('This chat cannot continue safely. Start a new chat.', { exact: true })).toHaveCount(0);
    expect(calls).toHaveLength(limit === 'model' ? 1 : 2);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { try { if (app) await closeDesktopFixture(app, userData, failure); } finally { await server.stop(true); } }
});
}

for (const recovery of ['prompt-collision', 'active-collision', 'missing-prompt-identity'] as const) {
it(`desktop unknown input recovery preserves its draft for ${recovery}`, async () => {
  it.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p5-collision-'));
  const requests: unknown[] = [];
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const server = await createHttpProvider(async request => {
    requests.push(await request.json());
    if (recovery === 'active-collision' && requests.length === 1) await barrier;
    return streamText('Saved winning reply.');
  });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[name]) env[name] = process.env[name];
  env.FLOWMATE_TEST_MODE = '1'; env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    electronApp = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await electronApp.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'collision-model', credentialRef: '00000000000000000000000000000009',
        name: 'Collision model', kind: 'custom', providerId: null, baseUrl: `${baseUrl}/v1`, model: 'collision-model', api: 'openai-completions',
        contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'collision-model' },
      { modelId: 'collision-model', apiKey: 'synthetic-collision-key' });
    }, `http://127.0.0.1:${server.port}`)).toMatchObject({ ok: true });
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    if (recovery === 'active-collision') {
      await composer.fill('Initial held input'); await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => requests.length).toBe(1);
    }
    await electronApp.evaluate(({ ipcMain }, kind) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get('flowmate:submit-input'); if (!original) throw new Error('Missing submit-input');
      ipcMain.removeHandler('flowmate:submit-input');
      ipcMain.handle('flowmate:submit-input', async (event, request) => {
        const input = request as import('@flowmate/contracts').DesktopSessionInputRequest;
        const winner = kind === 'prompt-collision' ? { ...input, text: 'Another window winning input' }
          : kind === 'active-collision' ? { ...input, mode: 'followUp' } : input;
        const result = await original(event, winner);
        if (!(result as { ok: boolean }).ok) throw new Error('Winning input was not accepted.');
        return { ok: false, error: { code: 'input_delivery_unknown', category: 'session', message: 'Controlled competing receipt', retryable: true } };
      });
      if (kind === 'missing-prompt-identity') {
        const query = handlers.get('flowmate:query-session-input'); if (!query) throw new Error('Missing input query');
        ipcMain.removeHandler('flowmate:query-session-input');
        ipcMain.handle('flowmate:query-session-input', async (event, ...args) => {
          const result = await query(event, ...args) as { ok: boolean; data?: { input?: { content: { desktopRequestIdentity?: string } } } };
          if (result.ok && result.data?.input) delete result.data.input.content.desktopRequestIdentity;
          return result;
        });
      }
    }, recovery);
    await composer.fill('My retained input draft');
    await page.getByRole('button', { name: recovery === 'active-collision' ? 'Steer' : 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check input status', exact: true }).click();
    await expect(composer).toHaveValue('My retained input draft');
    if (recovery === 'missing-prompt-identity') {
      await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    } else {
      await expect(page.getByRole('button', { name: 'Check input status', exact: true })).toHaveCount(0);
      await expect(page.getByText('This input sequence belongs to another request. Your draft is preserved. Review it and send again.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: recovery === 'active-collision' ? 'Steer' : 'Send', exact: true })).toBeEnabled();
    }
    expect(requests).toHaveLength(1);
    release();
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { release(); try { if (electronApp) await closeDesktopFixture(electronApp, userData, failure); } finally { await server.stop(true); } }
});
}

it('desktop sends directly, keeps drafts editable and restores native history after restart', async () => {
  it.setTimeout(120_000);
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E requires Windows');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-chat-e2e-'));
  const requestBodies: unknown[] = [];
  let releaseLiveText: (() => void) | null = null;
  let holdNextConnection = false;
  let connectionStarted: (() => void) | null = null;
  const server = await createHttpProvider(async request => {
      const body = await request.json();
      requestBodies.push(body);
      if (holdNextConnection) {
        holdNextConnection = false;
        connectionStarted?.();
        return new Promise<Response>(() => {});
      }
      if (JSON.stringify(body).includes('B_HOLD')) return new Promise<Response>(() => {});
      if (JSON.stringify(body).includes('LIVE_TEXT')) {
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
          `data: ${JSON.stringify({ id: 'live-text', object: 'chat.completion.chunk', created: 1,
            model: 'desktop-p3-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(chunk({ role: 'assistant', content: 'Live preview' })));
            releaseLiveText = () => {
              controller.enqueue(encoder.encode(`${chunk({ content: ' complete' })}${chunk({}, 'stop')}data: [DONE]\n\n`));
              controller.close();
            };
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return streamText('Desktop connection verified.');
  });
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.FLOWMATE_TEST_MODE = '1';
  env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  env.DEEPSEEK_API_KEY = 'synthetic-ambient-key';
  const launch = () => electron.launch({
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    electronApp = await launch();
    let page = await electronApp.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices' }).waitFor({ state: 'visible', timeout: 20_000 });
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    expect(await composer.isDisabled()).toBe(false);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    const piKey = page.locator('.config-panel input[type="password"]');
    await piKey.fill('synthetic-before-provider');
    await page.getByLabel('Pi provider').selectOption('deepseek');
    expect(await piKey.inputValue()).toBe('synthetic-before-provider');
    const catalogModel = page.locator('.config-panel .form-grid select').nth(1);
    await catalogModel.selectOption('deepseek-v4-flash');
    await piKey.fill('');
    expect(await catalogModel.locator('option:checked').textContent()).toBe('DeepSeek V4 Flash');
    expect(await page.locator('.model-limit').allTextContents()).toEqual(['1,000,000 tokens', '384,000 tokens']);
    expect(await page.getByText('Context window', { exact: true }).count()).toBe(1);
    expect(await page.getByText('Maximum output', { exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: 'Refresh models' }).click();
    expect(await catalogModel.inputValue()).toBe('deepseek-v4-flash');
    expect(await page.getByLabel('Find provider').count()).toBe(0);
    expect(await page.getByLabel('Find model').count()).toBe(0);
    expect(await page.getByLabel('Service URL').count()).toBe(0);
    await page.getByRole('heading', { name: 'Authentication' }).waitFor({ state: 'visible' });
    expect(await piKey.isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/Configuration saved/).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('API key required before testing or sending.').waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    const missingKey = await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      if (!state.ok || !state.data.settings.defaultModelId) throw new Error('model_missing');
      return window.flowmate.callProvider({ goal: 'Check', text: 'OK', modelId: state.data.settings.defaultModelId });
    });
    expect(missingKey).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    const missingChatKey = await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      if (!state.ok || !state.data.settings.defaultModelId) throw new Error('model_missing');
      return window.flowmate.startRun({ sessionId: 1, text: 'Check', modelId: state.data.settings.defaultModelId, goalMode: 'answer' });
    });
    expect(missingChatKey).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    expect(requestBodies).toHaveLength(0);
    await piKey.fill('synthetic-pi-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('API key saved in system secure storage.').waitFor({ state: 'visible' });
    expect(await piKey.inputValue()).toBe('');
    expect(await page.getByRole('button', { name: 'Remove API key' }).isEnabled()).toBe(true);
    expect(requestBodies).toHaveLength(0);
    await capturePiModelViews(page);
    const oauthProvider = page.getByLabel('Pi provider').locator('option[value="openai-codex"]');
    expect(await oauthProvider.evaluate((option) => (option as HTMLOptionElement).disabled)).toBe(true);
    expect(await oauthProvider.textContent()).toContain('API key unavailable');
    expect(requestBodies).toHaveLength(0);
    await piKey.fill('synthetic-pi-key-replaced');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('API key saved in system secure storage.').waitFor({ state: 'visible' });
    expect(JSON.stringify(await page.evaluate(() => window.flowmate.getState()))).not.toContain('synthetic-pi-key-replaced');
    for (const path of [join(userData, 'data', 'settings.json'), join(userData, 'data', 'app.sqlite'),
      join(userData, 'data', 'app.sqlite-wal'), join(userData, 'logs', 'flowmate.log')]) {
      if (existsSync(path)) expect(readFileSync(path).includes('synthetic-pi-key-replaced')).toBe(false);
    }
    await page.getByLabel('Pi provider').selectOption('openai');
    expect(await piKey.getAttribute('placeholder')).toBe('Enter API Key');
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    await page.getByLabel('Pi provider').selectOption('deepseek');
    await catalogModel.selectOption('deepseek-v4-flash');
    expect(await piKey.getAttribute('placeholder')).toBe('Leave blank to keep the saved key');
    await page.getByRole('button', { name: 'Remove API key' }).click();
    await page.getByText('API key removed. Add a key before testing or sending.').waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    expect((await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      if (!state.ok || !state.data.settings.defaultModelId) throw new Error('model_missing');
      return window.flowmate.callProvider({ goal: 'Check', text: 'OK', modelId: state.data.settings.defaultModelId });
    }))).toMatchObject({ ok: false, error: { code: 'model_credential_missing' } });
    await page.getByRole('button', { name: 'Custom model' }).click();
    const modelDetails = page.locator('.config-panel');
    await modelDetails.getByLabel('Display name').fill('Controlled model');
    await modelDetails.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await modelDetails.getByLabel('Model ID').fill('desktop-controlled-model');
    await modelDetails.getByLabel('Pi API type').fill('openai-completions');
    await modelDetails.getByLabel('Context window').fill('64000');
    await modelDetails.getByLabel('Maximum output tokens').fill('16384');
    await modelDetails.getByLabel(/API Key/).fill('synthetic-desktop-key');
    expect(await composer.isDisabled()).toBe(false);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/Configuration saved/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestBodies).toHaveLength(0);
    await modelDetails.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/other`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('write only', { exact: true }).waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    const olderSettings = await page.evaluate(async () => {
      const result = await window.flowmate.getState();
      if (!result.ok) throw new Error('older_settings_missing');
      return result.data;
    });
    await modelDetails.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await modelDetails.getByLabel(/API Key/).fill('synthetic-desktop-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText(/Configuration saved/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(requestBodies).toHaveLength(0);
    const latestSettings = await page.evaluate(async () => {
      const result = await window.flowmate.getState();
      if (!result.ok) throw new Error('latest_settings_missing');
      return result.data;
    });
    expect(latestSettings.settings.revision).toBeGreaterThan(olderSettings.settings.revision);
    await electronApp.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'host_state', state });
    }, olderSettings);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(modelDetails.getByLabel(/Base URL/)).toHaveValue(`http://127.0.0.1:${server.port}/v1`);
    await expect(page.getByRole('button', { name: 'Test connection' })).toBeEnabled();

    await composer.fill('Invoice total is 1060 CNY.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Desktop connection verified.' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('[data-message-role="assistant"][data-persistence="saved"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.locator('[data-message-role="user"]').count()).toBe(1);
    expect(await page.locator('[data-message-role="assistant"]').count()).toBe(1);
    expect(await page.locator('[data-message-role="assistant"]').getByText('Saved', { exact: true }).count()).toBe(1);
    expect(requestBodies).toHaveLength(1);
    expect(((requestBodies[0] as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map(tool => tool.function.name).sort())
      .toEqual([...NATIVE_TOOL_NAMES, 'calculate_invoice_amounts', 'normalize_invoice_values', 'list_skill_resources', 'read_skill_resource'].sort());
    const firstSessionId = Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'));
    expect(firstSessionId).toBeGreaterThan(0);
    await composer.fill('What was the total?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"] .chat-assistant-message.completed').length === 2,
      null, { timeout: 20_000 });
    expect(JSON.stringify(requestBodies[1])).toContain('Invoice total is 1060 CNY.');
    expect(JSON.stringify(requestBodies[1])).toContain('Desktop connection verified.');

    await electronApp.evaluate(({ ipcMain }) => {
      const gate = { channels: ['flowmate:create-session'], calls: 0, failCreateNext: true, release: null as (() => void) | null,
        waiting: null as Promise<void> | null };
      gate.waiting = new Promise<void>((resolveGate) => { gate.release = resolveGate; });
      (globalThis as unknown as { sessionIpcGate: typeof gate }).sessionIpcGate = gate;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      for (const channel of ['flowmate:create-session', 'flowmate:query-session', 'flowmate:list-session-runs', 'flowmate:list-session-messages']) {
        const original = handlers.get(channel);
        if (!original) throw new Error(`Missing Session IPC: ${channel}`);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          if (gate.channels.includes(channel)) { gate.calls += 1; await gate.waiting; }
          if (channel === 'flowmate:create-session' && gate.failCreateNext) {
            gate.failCreateNext = false;
            return { ok: false, error: { code: 'storage_write_failed', category: 'storage', message: 'Controlled creation failure.', retryable: true } };
          }
          return original(event, ...args);
        });
      }
    });
    await page.locator('.sidebar-new-chat').click();
    await page.keyboard.type('Draft after creation failure.');
    await electronApp.evaluate(() => (globalThis as unknown as { sessionIpcGate: { release: (() => void) | null } }).sessionIpcGate.release?.());
    await page.getByText('Controlled creation failure.', { exact: true }).waitFor({ state: 'visible' });
    expect(await page.locator('.sidebar-chat.selected').count()).toBe(0);
    expect(await composer.inputValue()).toBe('Draft after creation failure.');
    expect(requestBodies).toHaveLength(2);
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    expect(await composer.inputValue()).toBe('');
    await electronApp.evaluate(() => {
      const gate = (globalThis as unknown as { sessionIpcGate: { calls: number; waiting: Promise<void> | null; release: (() => void) | null } }).sessionIpcGate;
      gate.calls = 0;
      gate.waiting = new Promise<void>((resolveGate) => { gate.release = resolveGate; });
    });
    await page.locator('.sidebar-new-chat').click();
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.type('Draft for second conversation.');
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2_000);
    expect(await composer.inputValue()).toBe('Draft for second conversation.');
    expect(requestBodies).toHaveLength(2);
    await electronApp.evaluate(() => {
      const gate = (globalThis as unknown as { sessionIpcGate: { channels: string[]; calls: number; release: (() => void) | null } }).sessionIpcGate;
      if (gate.calls !== 1) throw new Error('New Session did not reach the held IPC');
      gate.channels = [];
      gate.release?.();
    });
    await page.waitForFunction((firstId) => {
      const selected = document.querySelector('.sidebar-chat.selected')?.getAttribute('data-session-id');
      return selected !== null && Number(selected) !== firstId;
    }, firstSessionId, { timeout: 10_000 });
    const secondSessionId = Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'));
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(await composer.inputValue()).toBe('Draft for second conversation.');
    await electronApp.evaluate(() => {
      const gate = (globalThis as unknown as { sessionIpcGate: { channels: string[]; waiting: Promise<void> | null; release: (() => void) | null } }).sessionIpcGate;
      gate.channels = ['flowmate:create-session'];
      gate.waiting = new Promise<void>((resolveGate) => { gate.release = resolveGate; });
    });
    await page.locator('.sidebar-new-chat').click();
    await page.keyboard.type('Draft for the pending conversation.');
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    expect(await composer.inputValue()).toBe('');
    await electronApp.evaluate(() => {
      const gate = (globalThis as unknown as { sessionIpcGate: { channels: string[]; release: (() => void) | null } }).sessionIpcGate;
      gate.channels = [];
      gate.release?.();
    });
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-chat').length === 3);
    expect(Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'))).toBe(firstSessionId);
    const pendingChatId = await page.locator('.sidebar-chat').evaluateAll((elements, existingIds) =>
      elements.map((element) => Number(element.getAttribute('data-session-id'))).find((id) => !existingIds.includes(id))!,
    [firstSessionId, secondSessionId]);
    expect(pendingChatId).not.toBe(firstSessionId);
    expect(pendingChatId).not.toBe(secondSessionId);
    await page.locator(`.sidebar-chat[data-session-id="${pendingChatId}"]`).click();
    expect(await composer.inputValue()).toBe('Draft for the pending conversation.');
    await page.locator(`.sidebar-chat[data-session-id="${secondSessionId}"]`).click();
    expect(await composer.inputValue()).toBe('Draft for second conversation.');
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    const deletePending = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await page.locator(`.chat-directory-row[data-session-id="${pendingChatId}"]`).getByRole('button', { name: 'Delete' }).click();
    await deletePending;
    await page.locator(`.chat-directory-row[data-session-id="${pendingChatId}"]`).waitFor({ state: 'detached' });
    expect(Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'))).toBe(secondSessionId);
    await electronApp.evaluate(() => {
      const gate = (globalThis as unknown as { sessionIpcGate: { channels: string[]; waiting: Promise<void> | null; release: (() => void) | null } }).sessionIpcGate;
      gate.channels = ['flowmate:query-session', 'flowmate:list-session-runs', 'flowmate:list-session-messages'];
      gate.waiting = new Promise<void>((resolveGate) => { gate.release = resolveGate; });
    });
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.type('Draft for first conversation.');
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2_000);
    expect(await composer.inputValue()).toBe('Draft for first conversation.');
    expect(requestBodies).toHaveLength(2);
    await page.locator('.sidebar-new-chat').click();
    await page.keyboard.type('Draft while the previous history is loading.');
    await page.waitForFunction((previousId) => {
      const selected = document.querySelector('.sidebar-chat.selected')?.getAttribute('data-session-id');
      return selected !== null && Number(selected) !== previousId;
    }, firstSessionId);
    const createdWhileLoadingId = Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'));
    expect(await composer.inputValue()).toBe('Draft while the previous history is loading.');
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(false);
    await electronApp.evaluate(() => {
      const gate = (globalThis as unknown as { sessionIpcGate: { channels: string[]; release: (() => void) | null } }).sessionIpcGate;
      gate.channels = [];
      gate.release?.();
    });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    const deleteLoadingChat = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await page.locator(`.chat-directory-row[data-session-id="${createdWhileLoadingId}"]`).getByRole('button', { name: 'Delete' }).click();
    await deleteLoadingChat;
    await page.locator(`.chat-directory-row[data-session-id="${createdWhileLoadingId}"]`).waitFor({ state: 'detached' });
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.chat-composer button[type="submit"]')?.disabled);
    expect(await composer.inputValue()).toBe('Draft for first conversation.');
    await page.locator(`.sidebar-chat[data-session-id="${secondSessionId}"]`).click();
    expect(await composer.inputValue()).toBe('Draft for second conversation.');
    await page.evaluate(() => {
      const current = window as unknown as { flowmate: { subscribe(listener: (event: unknown) => void): void }; testEvents: unknown[] };
      current.testEvents = [];
      current.flowmate.subscribe((event) => current.testEvents.push(event));
    });
    await composer.fill('LIVE_TEXT: show a preview.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.chat-assistant-message.sending').getByText('Live preview').waitFor({ state: 'visible', timeout: 10_000 });
    const liveRunId = await page.evaluate(() => {
      const events = (window as unknown as { testEvents: Array<{ type: string; runId?: number }> }).testEvents;
      return events.find((event) => event.type === 'text_delta')?.runId ?? null;
    });
    expect(liveRunId).toBeGreaterThan(0);
    await electronApp.evaluate(({ BrowserWindow }, input) => {
      const send = (event: Record<string, unknown>) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', event);
      send({ type: 'text_delta', runId: input.runId, sessionId: input.sessionId, sequence: 1, text: 'STALE TEXT' });
      send({ type: 'tool_progress', runId: input.runId, sessionId: input.sessionId, sequence: 1,
        toolName: 'stale_tool', label: 'STALE PROGRESS', phase: 'running' });
    }, { runId: liveRunId, sessionId: secondSessionId });
    await page.waitForFunction(() => (window as unknown as { testEvents: Array<{ type: string; text?: string; label?: string }> }).testEvents
      .some((event) => event.text === 'STALE TEXT')
      && (window as unknown as { testEvents: Array<{ label?: string }> }).testEvents.some((event) => event.label === 'STALE PROGRESS'));
    expect(await page.locator('.chat-assistant-message.sending').textContent()).not.toContain('STALE');
    const release = releaseLiveText as (() => void) | null;
    expect(release).not.toBeNull();
    release?.();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Live preview complete' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill('B_HOLD: wait for Stop.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.chat-pending').waitFor({ state: 'visible', timeout: 10_000 });
    await composer.fill('Next message drafted during response.');
    expect(await composer.isDisabled()).toBe(false);
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByText('Request cancelled.', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    expect(await composer.inputValue()).toBe('Next message drafted during response.');

    await closeDesktopFixture(electronApp, userData);
    electronApp = null;
    const databaseFile = join(userData, 'data', 'app.sqlite');
    const database = new Database(databaseFile);
    const native = database.query('SELECT entry_count,leaf_id,header_json FROM session_native_history WHERE session_id=?')
      .get(firstSessionId) as { entry_count: number; leaf_id: string | null; header_json: string } | null;
    expect(native?.entry_count).toBeGreaterThan(2);
    expect(native?.leaf_id).toBeTruthy();
    expect(JSON.parse(native!.header_json).type).toBe('session');
    database.query('UPDATE sessions SET updated_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', secondSessionId);
    database.query('INSERT INTO sessions(native_session_id,title,created_at,updated_at) VALUES (?,?,?,?)')
      .run('old-native-without-history', 'Older chat', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
    const legacyId = Number((database.query("SELECT id FROM sessions WHERE title='Older chat'").get() as { id: number }).id);
    database.close();

    electronApp = await launch();
    page = await electronApp.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    const restartedComposer = page.getByRole('textbox', { name: 'Message to model' });
    await restartedComposer.fill('Do you remember the total?');
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim().startsWith('Send'));
      return button instanceof HTMLButtonElement && !button.disabled;
    }, null, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-turn"] .chat-assistant-message.completed').length === 3,
      null, { timeout: 20_000 });
    expect(JSON.stringify(requestBodies.at(-1))).toContain('Invoice total is 1060 CNY.');
    expect(JSON.stringify(requestBodies.at(-1))).toContain('What was the total?');
    await page.screenshot({ path: it.info().outputPath('main-conversation-history.png') });

    const requestsBeforeNewChatEntry = requestBodies.length;
    await electronApp.evaluate(({ ipcMain }) => {
      const gate = { createCalls: 0, submitCalls: 0, blockRestore: false,
        releaseUpdate: null as (() => void) | null, releaseRestore: null as (() => void) | null };
      let enterUpdate: (() => void) | null = null, enterRestore: (() => void) | null = null;
      const updateEntered = new Promise<void>(done => { enterUpdate = done; });
      const restoreEntered = new Promise<void>(done => { enterRestore = done; });
      const updateWaiting = new Promise<void>(done => { gate.releaseUpdate = done; });
      const restoreWaiting = new Promise<void>(done => { gate.releaseRestore = done; });
      (globalThis as typeof globalThis & { newChatEntryGate?: typeof gate & { updateEntered: Promise<void>; restoreEntered: Promise<void> } }).newChatEntryGate = Object.assign(gate, { updateEntered, restoreEntered });
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      let holdUpdate = true;
      for (const channel of ['flowmate:create-session', 'flowmate:submit-input', 'flowmate:update-workspace', 'flowmate:restore-workspace']) {
        const original = handlers.get(channel); if (!original) throw new Error(`Missing IPC: ${channel}`);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          if (channel === 'flowmate:create-session') gate.createCalls++;
          if (channel === 'flowmate:submit-input') gate.submitCalls++;
          if (channel === 'flowmate:update-workspace' && holdUpdate) {
            holdUpdate = false; enterUpdate?.(); await updateWaiting;
          }
          if (channel === 'flowmate:restore-workspace' && gate.blockRestore) {
            gate.blockRestore = false; enterRestore?.(); await restoreWaiting;
            return { ok: false, error: { code: 'workspace_recovery_blocked', category: 'storage', message: 'Synthetic unavailable material root', retryable: true } };
          }
          return original(event, ...args);
        });
      }
    });
    await page.locator(`.sidebar-chat[data-session-id="${legacyId}"]`).click();
    await page.getByText('Read only · older conversation').waitFor({ state: 'visible', timeout: 10_000 });
    await restartedComposer.fill('Continue the older chat.');
    const newChatSendButton = page.getByRole('button', { name: 'New chat and send', exact: true });
    await electronApp.evaluate(() => (globalThis as typeof globalThis & { newChatEntryGate: { updateEntered: Promise<void> } }).newChatEntryGate.updateEntered);
    await expect(newChatSendButton).toBeDisabled();
    await newChatSendButton.evaluate(button => (button as HTMLButtonElement).click());
    await expect(restartedComposer).toHaveValue('Continue the older chat.');
    expect(await electronApp.evaluate(() => { const gate = (globalThis as typeof globalThis & { newChatEntryGate: { createCalls: number; submitCalls: number } }).newChatEntryGate;
      return { createCalls: gate.createCalls, submitCalls: gate.submitCalls }; })).toEqual({ createCalls: 0, submitCalls: 0 });
    expect(requestBodies).toHaveLength(requestsBeforeNewChatEntry);
    await electronApp.evaluate(() => (globalThis as typeof globalThis & { newChatEntryGate: { releaseUpdate: (() => void) | null } }).newChatEntryGate.releaseUpdate?.());
    await expect(newChatSendButton).toBeEnabled();
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { sessionId: legacyId } });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Workspace', exact: true }).click();
    await electronApp.evaluate(() => { (globalThis as typeof globalThis & { newChatEntryGate: { blockRestore: boolean } }).newChatEntryGate.blockRestore = true; });
    await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
    await electronApp.evaluate(() => (globalThis as typeof globalThis & { newChatEntryGate: { restoreEntered: Promise<void> } }).newChatEntryGate.restoreEntered);
    await expect(newChatSendButton).toBeDisabled();
    await expect(restartedComposer).toHaveValue('Continue the older chat.');
    await electronApp.evaluate(() => (globalThis as typeof globalThis & { newChatEntryGate: { releaseRestore: (() => void) | null } }).newChatEntryGate.releaseRestore?.());
    await expect(page.getByText('Workspace recovery is blocked. Check access to the saved invoice material, then refresh.', { exact: true })).toBeVisible();
    await expect(newChatSendButton).toBeDisabled();
    await newChatSendButton.evaluate(button => (button as HTMLButtonElement).click());
    await expect(restartedComposer).toHaveValue('Continue the older chat.');
    expect(await electronApp.evaluate(() => { const gate = (globalThis as typeof globalThis & { newChatEntryGate: { createCalls: number; submitCalls: number } }).newChatEntryGate;
      return { createCalls: gate.createCalls, submitCalls: gate.submitCalls }; })).toEqual({ createCalls: 0, submitCalls: 0 });
    expect(requestBodies).toHaveLength(requestsBeforeNewChatEntry);
    await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
    await expect(newChatSendButton).toBeEnabled();
    await page.locator(`.sidebar-chat[data-session-id="${legacyId}"]`).locator('..').getByRole('button', { name: /Rename chat/ }).click();
    await page.getByRole('textbox', { name: 'Chat title' }).fill('Renamed older chat');
    await page.locator('.sidebar-chat-edit').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Open chat Renamed older chat' }).waitFor({ state: 'visible', timeout: 10_000 });
    await restartedComposer.fill('Continue the older chat.');
    expect(await restartedComposer.isDisabled()).toBe(false);
    await electronApp.evaluate(({ ipcMain }) => {
      const gate = { releaseCreate: null as (() => void) | null, releaseStart: null as (() => void) | null,
        enterStart: null as (() => void) | null, enterWorkspace: null as (() => void) | null,
        releaseWorkspace: null as (() => void) | null, applyWorkspace: null as (() => void) | null, sessionId: 0, submittedWorkspace: undefined as unknown };
      const creating = new Promise<void>((done) => { gate.releaseCreate = done; });
      const starting = new Promise<void>((done) => { gate.releaseStart = done; });
      const startEntered = new Promise<void>((done) => { gate.enterStart = done; });
      const workspaceEntered = new Promise<void>(done => { gate.enterWorkspace = done; });
      const workspaceWaiting = new Promise<void>(done => { gate.releaseWorkspace = done; });
      const workspaceApplied = new Promise<void>(done => { gate.applyWorkspace = done; });
      (globalThis as unknown as { newChatSendGate: typeof gate & { startEntered: Promise<void>; workspaceEntered: Promise<void> } }).newChatSendGate = { ...gate, startEntered, workspaceEntered };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      let firstWorkspace = true;
      for (const channel of ['flowmate:create-session', 'flowmate:submit-input', 'flowmate:update-workspace']) {
        const original = handlers.get(channel);
        if (!original) throw new Error(`Missing IPC: ${channel}`);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          if (channel === 'flowmate:create-session') await creating;
          else if (channel === 'flowmate:submit-input') {
            const current = (globalThis as unknown as { newChatSendGate: typeof gate }).newChatSendGate;
            current.sessionId = (args[0] as { sessionId: number }).sessionId;
            current.submittedWorkspace = (args[0] as { workspace?: unknown }).workspace ?? null;
            current.enterStart?.();
            await starting;
          } else if (firstWorkspace) {
            firstWorkspace = false;
            gate.enterWorkspace?.();
            await workspaceWaiting;
            const result = await original(event, ...args);
            gate.applyWorkspace?.();
            return result;
          } else {
            // A concurrent Send must use the revision after the earlier selection commits.
            await workspaceApplied;
          }
          return original(event, ...args);
        });
      }
    });
    await page.getByRole('button', { name: 'New chat and send' }).click();
    await page.locator(`.sidebar-chat[data-session-id="${firstSessionId}"]`).click();
    await electronApp.evaluate(() => (globalThis as unknown as { newChatSendGate: { workspaceEntered: Promise<void> } }).newChatSendGate.workspaceEntered);
    await electronApp.evaluate(() => (globalThis as unknown as { newChatSendGate: { releaseCreate: (() => void) | null } }).newChatSendGate.releaseCreate?.());
    await page.waitForTimeout(100);
    await electronApp.evaluate(() => (globalThis as unknown as { newChatSendGate: { releaseWorkspace: (() => void) | null } }).newChatSendGate.releaseWorkspace?.());
    const currentSessionId = await electronApp.evaluate(async () => {
      const gate = (globalThis as unknown as { newChatSendGate: { startEntered: Promise<void>; sessionId: number } }).newChatSendGate;
      await Promise.race([gate.startEntered, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('New chat Send did not reach start-run')), 5000))]);
      return gate.sessionId;
    });
    await page.locator('.chat-run-model').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'visible' });
    expect(currentSessionId).not.toBe(legacyId);
    expect(currentSessionId).not.toBe(firstSessionId);
    expect(Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'))).toBe(firstSessionId);
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { sessionId: firstSessionId } });
    expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { newChatSendGate: { submittedWorkspace: unknown } }).newChatSendGate.submittedWorkspace)).toBeNull();
    expect(await page.locator('.chat-input-intent').filter({ hasText: 'Continue the older chat.' }).count()).toBe(0);
    await electronApp.evaluate(() => (globalThis as unknown as { newChatSendGate: { releaseStart: (() => void) | null } }).newChatSendGate.releaseStart?.());
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached', timeout: 20_000 });
    const detached = await page.evaluate(async id => {
      const inputs = await window.flowmate.listSessionInputs({ sessionId: id }); if (!inputs.ok || !inputs.data.items[0]?.runId) throw new Error('Detached input missing');
      return { inputs, run: await window.flowmate.queryRun(inputs.data.items[0].runId) };
    }, currentSessionId);
    expect(detached.inputs).toMatchObject({ ok: true, data: { items: [{ content: {
      workspaceContext: null, workspaceInput: null, allowedDocumentIds: [], allowedArtifactIds: [] } }] } });
    expect(detached.run).toMatchObject({ ok: true, data: { scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] } } });
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toMatchObject({ ok: true, data: { sessionId: firstSessionId } });
    expect(JSON.stringify(requestBodies.at(-1))).toContain('Continue the older chat.');
    expect(JSON.stringify(requestBodies.at(-1))).not.toContain('Invoice total is 1060 CNY.');
    await page.locator(`.sidebar-chat[data-session-id="${currentSessionId}"]`).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'Continue the older chat.' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    expect(Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'))).toBe(currentSessionId);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    const olderRow = page.locator(`.chat-directory-row[data-session-id="${legacyId}"]`);
    const cancelDelete = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Permanently delete this chat');
      await dialog.dismiss();
    });
    await olderRow.getByRole('button', { name: 'Delete' }).click();
    await cancelDelete;
    expect(await olderRow.count()).toBe(1);
    const confirmDelete = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await olderRow.getByRole('button', { name: 'Delete' }).click();
    await confirmDelete;
    await olderRow.waitFor({ state: 'detached', timeout: 10_000 });
    expect(Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'))).toBe(currentSessionId);
    await page.getByText('Chat deleted.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    const deleteCurrent = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await page.locator(`.chat-directory-row[data-session-id="${currentSessionId}"]`).getByRole('button', { name: 'Delete' }).click();
    await deleteCurrent;
    await page.locator(`.chat-directory-row[data-session-id="${currentSessionId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
    expect(Number(await page.locator('.sidebar-chat.selected').getAttribute('data-session-id'))).toBe(firstSessionId);
    expect(await page.locator(`.sidebar-chat[data-session-id="${secondSessionId}"]`).count()).toBe(1);
    const beforeCheck = requestBodies.length;
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    expect(requestBodies).toHaveLength(beforeCheck);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText('Connection succeeded. Your model is ready.').waitFor({ state: 'visible', timeout: 20_000 });
    expect(requestBodies).toHaveLength(beforeCheck + 1);
    const started = new Promise<void>((resolve) => { connectionStarted = resolve; });
    holdNextConnection = true;
    await page.getByRole('button', { name: 'Test connection' }).click();
    await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Connection test did not start')), 10_000))]);
    await page.getByRole('button', { name: 'Stop check' }).click();
    await page.getByText('Connection check stopped.').waitFor({ state: 'visible', timeout: 20_000 });
    expect(requestBodies).toHaveLength(beforeCheck + 2);
  } catch (error) {
    const diagnostic = await electronApp?.firstWindow().then(page => page.evaluate(async () => {
      const state = await window.flowmate.getState();
      const runtime = await window.flowmate.queryRuntimeState();
      return { state: state.ok ? { ready: state.data.ready, revision: state.data.settings.revision,
        defaultModelId: state.data.settings.defaultModelId, models: state.data.settings.models.map(model => ({ id: model.id, model: model.model })),
        credentials: state.data.modelCredentials } : { error: state.error.code }, runtime,
        selectedSession: document.querySelector('.sidebar-chat.selected')?.getAttribute('data-session-id'),
        selectedModel: document.querySelector('.route-row.selected .route-name')?.textContent,
        feedback: document.querySelector('[data-testid="runtime-feedback"]')?.textContent,
        statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent),
        modelFields: [...document.querySelectorAll<HTMLInputElement>('.config-panel input:not([type="password"])')]
          .map(element => ({ name: element.name, value: element.value })),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent) };
    })).catch(() => null);
    failure = new Error(`Direct Send regression: ${JSON.stringify(diagnostic)}`, { cause: error });
    throw failure;
  } finally {
    try { if (electronApp) await closeDesktopFixture(electronApp, userData, failure); }
    finally { await server.stop(true); }
  }
});

it('desktop keeps requests blocked by actual Runtime state after finish and ignores stale state queries', async () => {
  it.setTimeout(60_000);
  if (process.platform !== 'win32') throw new Error('desktop E2E requires Windows');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-runtime-state-'));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  env.FLOWMATE_TEST_MODE = '1';
  env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let runtimeCheckpoint = 'real Host readiness';
  let runtimePage: Page | null = null;
  let runtimeFailure: Error | undefined;
  try {
    const page = await app.firstWindow();
    runtimePage = page;
    page.setDefaultTimeout(10_000);
    await waitFor(() => page.evaluate(async () => {
      const state = await window.flowmate.getState();
      return state.ok && state.data.ready && state.data.host === 'ready';
    }));
    runtimeCheckpoint = 'save synthetic model';
    const saved = await page.evaluate(async () => {
      const state = await window.flowmate.getState();
      if (!state.ok) throw new Error('desktop_state_missing');
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'runtime-check-model',
        credentialRef: '00000000000000000000000000000010', name: 'Runtime check', kind: 'custom', providerId: null,
        baseUrl: 'http://127.0.0.1:1/v1', model: 'controlled-runtime-model', api: 'openai-completions',
        contextWindow: 16_384, maxTokens: 4_096, reasoning: false }], defaultModelId: 'runtime-check-model' },
      { modelId: 'runtime-check-model', apiKey: 'synthetic-runtime-ui-key' });
    });
    expect(saved.ok).toBe(true);
    await app.evaluate(({ ipcMain }) => {
      const gate = { state: { active: null, blocked: true, error: { code: 'runtime_unusable', category: 'runtime',
        message: 'Controlled stop was not confirmed.', retryable: false } } as import('@flowmate/contracts').RuntimeState,
        queries: 0, dispatches: 0, holdNext: false, failNext: false,
        heldQuery: null as number | null, settledQueries: [] as number[], release: null as (() => void) | null };
      (globalThis as unknown as { runtimeUiGate: typeof gate }).runtimeUiGate = gate;
      ipcMain.removeHandler('flowmate:query-runtime-state');
      ipcMain.handle('flowmate:query-runtime-state', async () => {
        const query = ++gate.queries;
        const snapshot = structuredClone(gate.state);
        const failThisQuery = gate.failNext;
        gate.failNext = false;
        try {
          if (gate.holdNext) {
            gate.holdNext = false;
            gate.heldQuery = query;
            await new Promise<void>(resolveQuery => { gate.release = resolveQuery; });
          }
          if (failThisQuery) return { ok: false, error: { code: 'runtime_state_unavailable', category: 'runtime',
            message: 'Controlled Runtime read failed.', retryable: true } };
          return { ok: true, data: snapshot };
        } finally {
          gate.settledQueries.push(query);
        }
      });
      for (const channel of ['flowmate:call-provider', 'flowmate:submit-input']) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async () => { gate.dispatches += 1; return { ok: false, error: {
          code: 'runtime_unusable', category: 'runtime', message: 'Controlled Runtime is blocked.', retryable: false } }; });
      }
    });
    runtimeCheckpoint = 'initial blocked Runtime';
    await page.reload();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    const check = page.getByRole('button', { name: 'Test connection', exact: true });
    await check.waitFor({ state: 'visible' });
    expect(await check.isDisabled()).toBe(true);
    expect(await page.getByTestId('runtime-feedback').count()).toBe(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByText('Diagnostics', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('Runtime is blocked'));
    expect(await page.getByTestId('runtime-feedback').textContent()).toContain('blocked');
    const openAssistant = page.getByRole('button', { name: 'Open Assistant', exact: true });
    if (await openAssistant.isVisible()) await openAssistant.click();
    const composer = page.getByRole('textbox', { name: 'Message to model' });
    await composer.fill('Preserve this unsent draft.');
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await expect.soft(page.locator('.chat-composer')).not.toContainText('Runtime is blocked', { timeout: 1000 });

    // A newer finish-triggered read must win over an older idle snapshot.
    runtimeCheckpoint = 'older idle query enters Main';
    await app.evaluate(() => {
      const gate = (globalThis as unknown as { runtimeUiGate: { state: import('@flowmate/contracts').RuntimeState; holdNext: boolean } }).runtimeUiGate;
      gate.state = { active: null, blocked: false, error: null };
      gate.holdNext = true;
    });
    await page.getByRole('button', { name: 'Check runtime status', exact: true }).click();
    await app.evaluate(async () => {
      const gate = (globalThis as unknown as { runtimeUiGate: { release: (() => void) | null } }).runtimeUiGate;
      for (let attempt = 0; gate.release === null && attempt < 100; attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      if (!gate.release) throw new Error('Runtime state query did not reach Main');
    });
    runtimeCheckpoint = 'finish preserves blocked Runtime';
    await app.evaluate(({ BrowserWindow }) => {
      const gate = (globalThis as unknown as { runtimeUiGate: { state: import('@flowmate/contracts').RuntimeState } }).runtimeUiGate;
      gate.state = { active: { runId: 7, sessionId: null, kind: 'provider' }, blocked: true,
        error: { code: 'runtime_unusable', category: 'runtime', message: 'Controlled stop was not confirmed.', retryable: false } };
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'provider_finished',
        requestId: 'controlled-finished-provider', runId: 7,
        result: { ok: false, error: { code: 'storage_write_failed', category: 'storage',
          message: 'Controlled terminal save failed.', retryable: true, runId: 7 } } });
    });
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('blocked'));
    await app.evaluate(async () => {
      const gate = (globalThis as unknown as { runtimeUiGate: { release: (() => void) | null; heldQuery: number | null; settledQueries: number[] } }).runtimeUiGate;
      const query = gate.heldQuery;
      gate.release?.();
      for (let attempt = 0; query !== null && !gate.settledQueries.includes(query) && attempt < 100; attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      if (query === null || !gate.settledQueries.includes(query)) throw new Error('Older idle query did not settle after release');
    });
    await page.waitForTimeout(100);
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    expect(await composer.inputValue()).toBe('Preserve this unsent draft.');
    expect(await page.getByTestId('runtime-feedback').textContent()).toContain('blocked');

    runtimeCheckpoint = 'a newer manual Runtime read wins over the active observation timer';
    await app.evaluate(() => {
      const gate = Reflect.get(globalThis, 'runtimeUiGate');
      gate.state = { active: { runId: 7, sessionId: null, kind: 'provider' }, blocked: false, error: null };
      gate.holdNext = true; gate.heldQuery = null; gate.release = null;
    });
    // Wait for the real 2s active-Run observation timer, without issuing a manual read.
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'runtimeUiGate').heldQuery), { timeout: 5_000 }).not.toBeNull();
    await app.evaluate(() => { Reflect.get(globalThis, 'runtimeUiGate').state = {
      active: { runId: 8, sessionId: null, kind: 'provider' }, blocked: false, error: null }; });
    await page.getByRole('button', { name: 'Check runtime status', exact: true }).click();
    await expect(page.getByTestId('runtime-feedback')).toContainText('still occupied by Run 8');
    await app.evaluate(async () => {
      const gate = Reflect.get(globalThis, 'runtimeUiGate'); const query = gate.heldQuery;
      gate.release?.();
      for (let attempt = 0; !gate.settledQueries.includes(query) && attempt < 100; attempt++)
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
      if (!gate.settledQueries.includes(query)) throw new Error('Held observation timer did not settle');
    });
    await page.waitForTimeout(100);
    await expect(page.getByTestId('runtime-feedback')).toContainText('still occupied by Run 8');

    runtimeCheckpoint = 'explicit next-query failure';
    await app.evaluate(() => {
      const gate = (globalThis as unknown as { runtimeUiGate: { state: import('@flowmate/contracts').RuntimeState; failNext: boolean } }).runtimeUiGate;
      gate.state = { active: null, blocked: false, error: null };
      gate.failNext = true;
    });
    await page.getByRole('button', { name: 'Check runtime status', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('could not be confirmed'));
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    runtimeCheckpoint = 'explicit successful Runtime refresh';
    await page.getByRole('button', { name: 'Check runtime status', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('ready for a new request'));
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled()).toBe(true);
    // Admission rechecks the actual owner even when the displayed snapshot was idle.
    runtimeCheckpoint = 'Send admission rechecks active Run';
    await app.evaluate(() => {
      const gate = (globalThis as unknown as { runtimeUiGate: { state: import('@flowmate/contracts').RuntimeState } }).runtimeUiGate;
      gate.state = { active: { runId: 8, sessionId: null, kind: 'provider' }, blocked: false, error: null };
    });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('still occupied by Run 8'));
    expect(await composer.inputValue()).toBe('Preserve this unsent draft.');
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await expect.soft(page.locator('.chat-composer')).not.toContainText('Runtime is still occupied', { timeout: 1000 });
    await app.evaluate(() => {
      const gate = (globalThis as unknown as { runtimeUiGate: { state: import('@flowmate/contracts').RuntimeState } }).runtimeUiGate;
      gate.state = { active: null, blocked: false, error: null };
    });
    await page.getByRole('button', { name: 'Check runtime status', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('ready for a new request'));
    runtimeCheckpoint = 'tool budget failure keeps the draft and explains the limit';
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('flowmate:submit-input');
      ipcMain.handle('flowmate:submit-input', async () => {
        const gate = (globalThis as unknown as { runtimeUiGate: { dispatches: number } }).runtimeUiGate;
        gate.dispatches += 1;
        return { ok: false, error: { code: 'tool_budget_exceeded', category: 'runtime', message: '工具调用超过本轮上限。', retryable: false } };
      });
    });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.soft(page.locator('.notice.bad')).toContainText('The assistant reached the tool limit before finishing. Check Processing History for any saved result.', { timeout: 1000 });
    expect(await composer.inputValue()).toBe('Preserve this unsent draft.');
    expect(await app.evaluate(() => (globalThis as unknown as { runtimeUiGate: { dispatches: number } }).runtimeUiGate.dispatches)).toBe(1);
    runtimeCheckpoint = 'Test connection admission rechecks blocked Runtime';
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await app.evaluate(() => {
      const gate = (globalThis as unknown as { runtimeUiGate: { state: import('@flowmate/contracts').RuntimeState } }).runtimeUiGate;
      gate.state = { active: null, blocked: true, error: { code: 'runtime_unusable', category: 'runtime',
        message: 'Controlled persistence is unconfirmed.', retryable: false } };
    });
    await check.click();
    await expect(check).toBeDisabled();
    expect(await page.getByTestId('runtime-feedback').count()).toBe(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByText('Diagnostics', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('blocked'));

    // An idle response from an old Host connection must not reopen admission.
    runtimeCheckpoint = 'held Runtime query survives Host exit';
    await app.evaluate(() => {
      const gate = (globalThis as unknown as { runtimeUiGate: { state: import('@flowmate/contracts').RuntimeState; holdNext: boolean; release: (() => void) | null } }).runtimeUiGate;
      gate.state = { active: null, blocked: false, error: null };
      gate.holdNext = true;
      gate.release = null;
    });
    await page.getByRole('button', { name: 'Check runtime status', exact: true }).click();
    await app.evaluate(async () => {
      const gate = (globalThis as unknown as { runtimeUiGate: { release: (() => void) | null } }).runtimeUiGate;
      for (let attempt = 0; gate.release === null && attempt < 100; attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      if (!gate.release) throw new Error('Held Host query did not enter Main');
    });
    const connectedState = await page.evaluate(() => window.flowmate.getState());
    if (!connectedState.ok) throw new Error('desktop_state_missing');
    await app.evaluate(({ BrowserWindow }, desktop) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'host_state',
        state: { ...desktop, ready: false, host: 'error' } });
    }, connectedState.data);
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('Host is not ready'));
    await app.evaluate(async () => {
      const gate = (globalThis as unknown as { runtimeUiGate: { release: (() => void) | null; heldQuery: number | null; settledQueries: number[] } }).runtimeUiGate;
      const query = gate.heldQuery;
      gate.release?.();
      for (let attempt = 0; query !== null && !gate.settledQueries.includes(query) && attempt < 100; attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      if (query === null || !gate.settledQueries.includes(query)) throw new Error('Old Host Runtime query did not settle after release');
    });
    await page.waitForTimeout(100);
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByTestId('runtime-feedback').textContent()).toContain('Host is not ready');
    await app.evaluate(({ BrowserWindow }, desktop) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'host_state', state: desktop });
    }, connectedState.data);
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('ready for a new request'));
    expect(await page.getByRole('button', { name: 'Check runtime status', exact: true }).isEnabled()).toBe(true);

    // The initial Desktop snapshot has the same stale-Host boundary as Runtime reads.
    runtimeCheckpoint = 'initial Desktop query survives Host exit';
    await app.evaluate(({ ipcMain }, desktop) => {
      const gate = { release: null as (() => void) | null };
      (globalThis as unknown as { desktopStateUiGate: typeof gate }).desktopStateUiGate = gate;
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers.get('flowmate:get-state');
      if (!original) throw new Error('Missing Desktop state IPC');
      let first = true;
      ipcMain.removeHandler('flowmate:get-state');
      ipcMain.handle('flowmate:get-state', async (event, ...args) => {
        if (!first) return original(event, ...args);
        first = false;
        await new Promise<void>(releaseState => { gate.release = releaseState; });
        return { ok: true, data: desktop };
      });
    }, connectedState.data);
    await page.reload();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await app.evaluate(async () => {
      const gate = (globalThis as unknown as { desktopStateUiGate: { release: (() => void) | null } }).desktopStateUiGate;
      for (let attempt = 0; gate.release === null && attempt < 100; attempt += 1) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      if (!gate.release) throw new Error('Initial Desktop state query did not enter Main');
    });
    await app.evaluate(({ BrowserWindow }, desktop) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'host_state',
        state: { ...desktop, ready: false, host: 'error' } });
    }, connectedState.data);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByText('Diagnostics', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('Host is not ready'));
    await app.evaluate(() => (globalThis as unknown as { desktopStateUiGate: { release: (() => void) | null } }).desktopStateUiGate.release?.());
    await page.waitForTimeout(100);
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByTestId('runtime-feedback').textContent()).toContain('Host is not ready');
    await app.evaluate(({ BrowserWindow }, desktop) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'host_state', state: desktop });
    }, connectedState.data);
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-feedback"]')?.textContent?.includes('ready for a new request'));
    expect(await page.getByRole('button', { name: 'Check runtime status', exact: true }).isEnabled()).toBe(true);
    expect(await app.evaluate(() => (globalThis as unknown as { runtimeUiGate: { dispatches: number } }).runtimeUiGate.dispatches)).toBe(1);

    runtimeCheckpoint = 'late real model-removal reply cannot overwrite Host unavailability';
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const save = handlers.get('flowmate:save-settings');
      const read = handlers.get('flowmate:get-state');
      if (!save || !read) throw new Error('Missing settings IPC');
      const gate = { committed: false, release: null as (() => void) | null,
        unavailable: null as import('@flowmate/contracts').DesktopState | null };
      (globalThis as unknown as { modelRemovalGate: typeof gate }).modelRemovalGate = gate;
      ipcMain.removeHandler('flowmate:save-settings');
      ipcMain.handle('flowmate:save-settings', async (event, ...args) => {
        const result = await save(event, ...args) as { ok: boolean };
        if (!result.ok) return result;
        gate.committed = true;
        await new Promise<void>(release => { gate.release = release; });
        return result;
      });
      ipcMain.removeHandler('flowmate:get-state');
      ipcMain.handle('flowmate:get-state', (event, ...args) => gate.unavailable
        ? { ok: true, data: gate.unavailable } : read(event, ...args));
    });
    await page.getByRole('button', { name: 'Remove model', exact: true }).click();
    await waitFor(() => app.evaluate(() => {
      const gate = (globalThis as unknown as { modelRemovalGate: { committed: boolean; release: (() => void) | null } }).modelRemovalGate;
      return gate.committed && gate.release !== null;
    }));
    const removedState = await page.evaluate(() => window.flowmate.getState());
    if (!removedState.ok) throw new Error('removed_model_state_missing');
    expect(removedState.data.settings.models).toHaveLength(0);
    await app.evaluate(({ BrowserWindow }, desktop) => {
      const gate = (globalThis as unknown as { modelRemovalGate: { unavailable: import('@flowmate/contracts').DesktopState | null } }).modelRemovalGate;
      gate.unavailable = { ...desktop, ready: false, host: 'error' };
      BrowserWindow.getAllWindows()[0]!.webContents.send('flowmate:event', { type: 'host_state', state: gate.unavailable });
    }, removedState.data);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByText('Diagnostics', { exact: true }).click();
    await expect(page.getByTestId('runtime-feedback')).toContainText('Host is not ready');
    await app.evaluate(() => (globalThis as unknown as { modelRemovalGate: { release: (() => void) | null } }).modelRemovalGate.release?.());
    await page.getByText('Model profile removed.', { exact: true }).waitFor({ state: 'visible' });
    await expect(page.getByTestId('runtime-feedback')).toContainText('Host is not ready');
    await expect(page.getByRole('button', { name: 'Check runtime status', exact: true })).toBeDisabled();
    expect(await app.evaluate(() => (globalThis as unknown as { runtimeUiGate: { dispatches: number } }).runtimeUiGate.dispatches)).toBe(1);
    runtimeCheckpoint = 'normal desktop close';
  } catch (error) {
    const gate = await app.evaluate(() => {
      const value = (globalThis as unknown as { runtimeUiGate?: { queries: number; dispatches: number; heldQuery: number | null;
        settledQueries: number[]; holdNext: boolean; failNext: boolean; state: import('@flowmate/contracts').RuntimeState; release: (() => void) | null } }).runtimeUiGate;
      const desktop = (globalThis as unknown as { desktopStateUiGate?: { release: (() => void) | null } }).desktopStateUiGate;
      return value ? { queries: value.queries, dispatches: value.dispatches, heldQuery: value.heldQuery,
        settledQueries: value.settledQueries, holdNext: value.holdNext, failNext: value.failNext,
        state: value.state, hasRelease: value.release !== null, desktopQueryHeld: Boolean(desktop?.release) } : null;
    }).catch(() => null);
    const view = await runtimePage?.evaluate(() => ({
      feedback: document.querySelector('[data-testid="runtime-feedback"]')?.textContent,
      buttons: [...document.querySelectorAll('.model-check button,.agent-chat-panel button')].map(element => ({ text: element.textContent,
        disabled: element instanceof HTMLButtonElement && element.disabled })),
    })).catch(() => null);
    runtimeFailure = new Error(`Runtime admission checkpoint ${runtimeCheckpoint}: ${JSON.stringify({ gate, view })}`, { cause: error });
    throw runtimeFailure;
  } finally {
    await app.evaluate(() => (globalThis as unknown as { runtimeUiGate?: { release: (() => void) | null } }).runtimeUiGate?.release?.()).catch(() => undefined);
    await app.evaluate(() => (globalThis as unknown as { desktopStateUiGate?: { release: (() => void) | null } }).desktopStateUiGate?.release?.()).catch(() => undefined);
    await app.evaluate(() => (globalThis as unknown as { modelRemovalGate?: { release: (() => void) | null } }).modelRemovalGate?.release?.()).catch(() => undefined);
    await closeDesktopFixture(app, userData, runtimeFailure);
  }
});

async function verifyAmbientCatalog(failHostStartup = false) {
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E requires Windows');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-ambient-e2e-'));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.FLOWMATE_TEST_MODE = '1';
  env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  if (failHostStartup) env.FLOWMATE_BUN_EXECUTABLE = join(userData, 'missing-bun.exe');
  const app = await electron.launch({
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let ambientCheckpoint = 'first window';
  let ambientPage: Page | null = null;
  let ambientFailure: Error | undefined;
  try {
    const page = await app.firstWindow();
    ambientPage = page;
    page.setDefaultTimeout(10_000);
    ambientCheckpoint = 'real Host readiness';
    await waitFor(() => page.evaluate(async () => {
      const state = await window.flowmate.getState();
      return state.ok && state.data.ready;
    }), failHostStartup ? 1000 : 20_000);
    await app.evaluate(({ ipcMain }) => {
      (globalThis as unknown as { ambientCatalogCalls: string[] }).ambientCatalogCalls = [];
      ipcMain.removeHandler('flowmate:list-model-catalog');
      ipcMain.handle('flowmate:list-model-catalog', async () => {
        (globalThis as unknown as { ambientCatalogCalls: string[] }).ambientCatalogCalls.push('unavailable');
        return { ok: false, error: {
        code: 'provider_catalog_unavailable', category: 'provider', message: 'Pi model catalog is unavailable.', retryable: true,
      } }; });
    });

    ambientCheckpoint = 'reload with unavailable catalog';
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    ambientCheckpoint = 'catalog error visible';
    await page.getByRole('alert').filter({ hasText: 'Pi model catalog is unavailable.' }).waitFor({ state: 'visible' });
    expect(await page.getByRole('alert').filter({ hasText: 'Pi model catalog is unavailable.' }).isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Reload providers' }).isEnabled()).toBe(true);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('flowmate:list-model-catalog');
      ipcMain.handle('flowmate:list-model-catalog', async () => {
        (globalThis as unknown as { ambientCatalogCalls: string[] }).ambientCatalogCalls.push('ambient-only');
        return { ok: true, data: [{
        id: 'deepseek', name: 'DeepSeek', authMethods: ['ambient'], models: [{
          id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', api: 'openai-completions',
          endpoint: null, contextWindow: 128000, maxTokens: 32768, reasoning: false,
        }],
      }] }; });
    });
    ambientCheckpoint = 'reload ambient-only provider';
    await page.getByRole('button', { name: 'Reload providers' }).click();
    const desktopState = await page.evaluate(() => window.flowmate.getState());
    expect(desktopState.ok ? { ready: desktopState.data.ready, host: desktopState.data.host }
      : { error: desktopState.error.code }).toEqual({ ready: true, host: 'ready' });
    const provider = page.getByLabel('Pi provider').locator('option[value="deepseek"]');
    ambientCheckpoint = 'provider remains disabled';
    await page.waitForFunction(() => document.querySelector<HTMLOptionElement>('.config-panel option[value="deepseek"]')?.disabled === true);
    expect(await provider.evaluate((option) => (option as HTMLOptionElement).disabled)).toBe(true);
    expect(await provider.textContent()).toContain('API key unavailable');
    expect(await page.getByLabel('Service URL').count()).toBe(0);
    expect(await page.locator('.config-panel input[type="password"]').count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    ambientCheckpoint = 'normal desktop close';
  } catch (error) {
    const calls = await app.evaluate(() => (globalThis as unknown as { ambientCatalogCalls?: string[] }).ambientCatalogCalls).catch(() => null);
    const view = await ambientPage?.evaluate(() => ({
      feedback: document.querySelector('[data-testid="runtime-feedback"]')?.textContent,
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
      options: [...document.querySelectorAll<HTMLSelectElement>('.config-panel select')].map(element => ({ value: element.value, text: element.textContent })),
    })).catch(() => null);
    ambientFailure = new Error(`Ambient catalog checkpoint ${ambientCheckpoint}: ${JSON.stringify({ calls, view })}`, { cause: error });
    throw ambientFailure;
  } finally {
    await closeDesktopFixture(app, userData, ambientFailure);
  }
}
it('keeps an ambient-only Pi provider visible but unavailable without API-key support', async () => {
  it.setTimeout(60_000);
  await verifyAmbientCatalog();
});
it('reports the ambient catalog startup checkpoint when its Host cannot start', async () => {
  it.setTimeout(30_000);
  try { await verifyAmbientCatalog(true); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain('Ambient catalog checkpoint real Host readiness:');
    expect(error.message).not.toContain('; cleanup:');
    return;
  }
  throw new Error('Controlled missing Host unexpectedly became ready.');
});
it('reconciles Renderer messages from the public history IPC without replaying an input', async () => {
  it.setTimeout(60_000);
  if (process.platform !== 'win32') throw new Error('desktop E2E requires Windows');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-message-receipt-e2e-'));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  env.FLOWMATE_TEST_MODE = '1';
  env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
  const app = await electron.launch({
    args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
  let historyCheckpoint = 'real Host readiness';
  let historyPage: Page | null = null;
  let historyFailure: Error | undefined;
  try {
    const page = await app.firstWindow();
    historyPage = page;
    page.setDefaultTimeout(10_000);
    await waitFor(() => page.evaluate(async () => {
      const state = await window.flowmate.getState();
      return state.ok && state.data.ready && state.data.host === 'ready';
    }));
    historyCheckpoint = 'install controlled history';
    const desktop = await page.evaluate(() => window.flowmate.getState());
    if (!desktop.ok) throw new Error('desktop_state_missing');
    await app.evaluate(({ ipcMain, BrowserWindow }, data) => {
      const replace = (channel: string, value: unknown) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async () => ({ ok: true, data: value }));
      };
      const session = { sessionId: 12, nativeSessionId: 'renderer-native-s', title: 'Controlled receipt', status: 'active',
        createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z', availability: 'ready',
        historyState: 'recoverable', activeRunId: null, modelUseBlocked: false, deletePending: false, hasBusinessHistory: false };
      const otherSession = { ...session, sessionId: 13, nativeSessionId: 'renderer-native-t', title: 'Other receipt' };
      const user = { entryId: 'renderer-e1', runId: 101, liveOrdinal: 1, timestamp: 1790726400000,
        persistence: 'saved', truncated: false, role: 'user', blocks: [{ type: 'text', text: 'Controlled question' }],
        phase: 'ended', stopReason: null, toolCallId: null, toolName: null, isError: null, textOrigin: 'product-input' };
      replace('flowmate:get-state', { ...data, ready: true, host: 'ready' });
      replace('flowmate:list-model-catalog', []);
      const workspace = { revision: 0, documentRef: null, jobId: null, candidateRef: null, sessionId: 12 as number | null,
        activeView: 'original', selection: null, invalidReferences: [], nextTaskSequence: 1, updatedAt: '2026-09-30T00:00:00.000Z' };
      replace('flowmate:read-workspace', workspace);
      replace('flowmate:restore-workspace', { workspace, clearedReferences: [] });
      ipcMain.removeHandler('flowmate:update-workspace');
      ipcMain.handle('flowmate:update-workspace', async (_event, input) => {
        if (input.expectedRevision !== workspace.revision || input.change.kind !== 'session'
          || ![null, 12, 13].includes(input.change.sessionId)) return { ok: false,
          error: { code: 'state_conflict', category: 'input', message: 'Controlled Workspace changed.', retryable: true } };
        if (workspace.sessionId !== input.change.sessionId) { workspace.sessionId = input.change.sessionId; workspace.revision += 1; }
        return { ok: true, data: workspace };
      });
      replace('flowmate:list-sessions', { items: [session, otherSession], next: null });
      ipcMain.removeHandler('flowmate:query-session');
      ipcMain.handle('flowmate:query-session', async (_event, id) => ({ ok: true, data: id === 13 ? otherSession : session }));
      const runPage = { items: [{ kind: 'agent', runId: 101, sessionId: 12, jobId: null,
        status: 'completed', input: { version: 1, goal: 'Chat', text: 'Controlled question', messageTimestamp: 1790726400000 },
        config: {}, output: { text: 'Run summary is separate' }, usage: { version: 1, source: 'unknown', reason: null,
          sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: '2026-09-30T00:00:00.000Z' },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
        durationMs: 1, toolCallCount: 0, error: null, cleanup: {}, createdAt: '2026-09-30T00:00:00.000Z',
        startedAt: '2026-09-30T00:00:00.000Z', endedAt: '2026-09-30T00:00:00.000Z', cancelRequestedAt: null, stoppedAt: null,
        scope: { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] } }], nextBeforeRunId: null };
      ipcMain.removeHandler('flowmate:list-session-runs');
      ipcMain.handle('flowmate:list-session-runs', async (_event, input) => ({ ok: true,
        data: input.sessionId === 13 ? { items: [], nextBeforeRunId: null } : runPage }));
      const receipt = { session, items: [user] as unknown[], historyCalls: 0, activeQueries: 0, maxQueries: 0,
        navigation: 0, queries: [] as Array<{ id: number; navigation: number; frame: string; held: boolean; phase: string }>,
        startCalls: 0, hold: false, failNext: false, release: null as (() => void) | null };
      BrowserWindow.getAllWindows()[0]?.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) receipt.navigation += 1;
      });
      (globalThis as unknown as { rendererReceipt: typeof receipt }).rendererReceipt = receipt;
      ipcMain.removeHandler('flowmate:list-session-messages');
      ipcMain.handle('flowmate:list-session-messages', async (_event, input) => {
        if (input.sessionId === 13) return { ok: true, data: { session: otherSession, leafId: 'renderer-t1', entryCount: 1,
          items: [{ ...user, entryId: 'renderer-t1', runId: null, liveOrdinal: null, textOrigin: 'native-content',
            blocks: [{ type: 'text', text: 'Other Session question' }] }], nextBeforeEntryId: null } };
        receipt.historyCalls += 1;
        const query = { id: receipt.historyCalls, navigation: receipt.navigation,
          frame: `${_event.senderFrame?.processId}:${_event.senderFrame?.routingId}`, held: receipt.hold, phase: 'entered' };
        receipt.queries.push(query);
        receipt.activeQueries += 1;
        receipt.maxQueries = Math.max(receipt.maxQueries, receipt.activeQueries);
        const snapshot = structuredClone(receipt.items);
        const failThisQuery = receipt.failNext;
        receipt.failNext = false;
        try {
          if (receipt.hold) await new Promise<void>((resolve) => { receipt.release = resolve; });
          if (failThisQuery) {
            return { ok: false, error: { code: 'storage_read_failed', category: 'storage', message: 'Controlled history unavailable.', retryable: true } };
          }
          const entries = snapshot as Array<{ entryId: string }>;
          const end = input.beforeEntryId === undefined ? entries.length
            : entries.findIndex((item) => item.entryId === input.beforeEntryId);
          const start = Math.max(0, end - input.limit);
          return { ok: true, data: { session, leafId: entries.at(-1)?.entryId ?? null, entryCount: snapshot.length,
            items: entries.slice(start, end), nextBeforeEntryId: start > 0 ? entries[start]!.entryId : null } };
        } finally { query.phase = 'settled'; receipt.activeQueries -= 1; }
      });
      ipcMain.removeHandler('flowmate:submit-input');
      ipcMain.handle('flowmate:submit-input', async () => { receipt.startCalls += 1; return { ok: false }; });
    }, desktop.data);
    historyCheckpoint = 'initial saved message';
    await page.reload();
    await page.locator('[data-message-entry="renderer-e1"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Refresh history', exact: true }).waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-role="user"]').textContent()).toContain('Controlled question');
    expect(await page.locator('[data-message-role="user"]').getByText('Saved', { exact: true }).count()).toBe(1);
    expect(await page.locator('.chat-user-message').count()).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', {
      type: 'run_progress', runId: 101, sessionId: 12, nativeSessionId: 'renderer-native-s', sequence: 99,
      at: '2026-09-30T00:00:00.000Z', phase: 'running',
    }));
    await page.waitForTimeout(50);
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).count()).toBe(0);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Draft stays editable');
    await page.evaluate(() => {
      window.flowmate.subscribe((event) => {
        if (event.type === 'message_upsert' && event.runId === 102 && event.sequence === 4) {
          (window as unknown as { historyEventsConsumed: boolean }).historyEventsConsumed = true;
        }
      });
    });
    // The Main fixture spans the old and reloaded Renderer. Measure only the
    // controlled reconciliation window, after the new view has finished loading.
    const historyBaseline = await app.evaluate(({ BrowserWindow }) => {
      type Receipt = { hold: boolean; historyCalls: number; activeQueries: number; maxQueries: number };
      const receipt = (globalThis as unknown as { rendererReceipt: Receipt }).rendererReceipt;
      if (receipt.activeQueries !== 0) throw new Error('Initial history is still in flight.');
      const baseline = receipt.historyCalls;
      receipt.maxQueries = 0;
      receipt.hold = true;
      const send = (value: unknown) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', value);
      const envelope = { runId: 102, sessionId: 12, nativeSessionId: 'renderer-native-s', at: '2026-09-30T00:00:00.000Z' };
      const view = { entryId: null, runId: 102, liveOrdinal: 1, timestamp: 1790726400001, persistence: 'pending',
        truncated: false, role: 'assistant', blocks: [{ type: 'text', text: 'AB' }], phase: 'streaming', stopReason: 'pending',
        toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' };
      send({ ...envelope, type: 'run_progress', sequence: 1, phase: 'running' });
      send({ ...envelope, type: 'message_upsert', sequence: 3, message: view });
      send({ ...envelope, type: 'message_upsert', sequence: 2, message: { ...view, liveOrdinal: 2,
        timestamp: 1790726400002, blocks: [{ type: 'text', text: 'Another message' }] } });
      send({ ...envelope, type: 'message_upsert', sequence: 2, message: { ...view, blocks: [{ type: 'text', text: 'A' }] } });
      send({ ...envelope, type: 'message_upsert', sequence: 3, message: view });
      send({ ...envelope, type: 'message_upsert', sequence: 3, message: { ...view, blocks: [{ type: 'text', text: 'CONFLICT' }] } });
      return baseline;
    });
    historyCheckpoint = 'pending assistant messages';
    await page.locator('[data-message-role="assistant"]').filter({ hasText: 'AB' }).waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-role="assistant"]').count()).toBe(2);
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('CONFLICT');
    await app.evaluate(async () => {
      const receipt = (globalThis as unknown as { rendererReceipt: { activeQueries: number; release: (() => void) | null } }).rendererReceipt;
      const deadline = Date.now() + 10_000;
      while (!receipt.release || receipt.activeQueries !== 1) {
        if (Date.now() >= deadline) throw new Error('Controlled history never entered its hold.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await app.evaluate(({ BrowserWindow }) => {
      const send = (value: unknown) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', value);
      const envelope = { runId: 102, sessionId: 12, nativeSessionId: 'renderer-native-s', at: '2026-09-30T00:00:00.000Z' };
      send({ ...envelope, type: 'run_finished', sequence: 1, result: { ok: true, data: { runId: 102, sessionId: 12,
        nativeSessionId: 'renderer-native-s', status: 'completed', text: 'RUN TEXT IS NOT A MESSAGE', error: null,
        stopped: false, cleanupErrors: [] } } });
      send({ ...envelope, type: 'message_upsert', sequence: 4, message: { entryId: null, runId: 102, liveOrdinal: 1,
        timestamp: 1790726400001, persistence: 'pending', truncated: false, role: 'assistant',
        blocks: [{ type: 'text', text: 'LATE' }], phase: 'streaming', stopReason: 'pending', toolCallId: null,
        toolName: null, isError: null, textOrigin: 'native-content' } });
    });
    historyCheckpoint = 'finish preserves pending messages';
    await page.getByText('2 messages have not been confirmed as saved.', { exact: false }).waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Stop', exact: true }).count()).toBe(0);
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('LATE');
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('RUN TEXT IS NOT A MESSAGE');
    await page.waitForFunction(() => (window as unknown as { historyEventsConsumed?: boolean }).historyEventsConsumed === true);
    await app.evaluate(() => {
      type Receipt = { hold: boolean; items: unknown[]; release: (() => void) | null };
      const receipt = (globalThis as unknown as { rendererReceipt: Receipt }).rendererReceipt;
      const base = { runId: 102, persistence: 'saved', truncated: false, role: 'assistant', phase: 'ended', stopReason: 'stop',
        toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' };
      receipt.items.push({ ...base, entryId: 'renderer-e2', liveOrdinal: 1, timestamp: 1790726400001, blocks: [{ type: 'text', text: 'AB' }] },
        { ...base, entryId: 'renderer-e3', liveOrdinal: 2, timestamp: 1790726400002, blocks: [{ type: 'text', text: 'Another message' }] });
      receipt.hold = false;
      receipt.release?.();
    });
    historyCheckpoint = 'held history reconciles saved messages';
    await page.locator('[data-message-entry="renderer-e3"]').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Refresh history', exact: true }).waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-role="assistant"][data-persistence="saved"]').count()).toBe(2);
    expect(await page.getByRole('textbox', { name: 'Message to model' }).inputValue()).toBe('Draft stays editable');
    const counts = await app.evaluate(() => {
      const receipt = (globalThis as unknown as { rendererReceipt: { historyCalls: number; maxQueries: number; startCalls: number } }).rendererReceipt;
      return { historyCalls: receipt.historyCalls, maxQueries: receipt.maxQueries, startCalls: receipt.startCalls };
    });
    expect(counts).toEqual({ historyCalls: historyBaseline + 2, maxQueries: 1, startCalls: 0 });
    await app.evaluate(() => { (globalThis as unknown as { rendererReceipt: { failNext: boolean } }).rendererReceipt.failNext = true; });
    historyCheckpoint = 'explicit failed history refresh';
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Controlled history unavailable.' }).waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-entry="renderer-e3"]').count()).toBe(1);
    await page.waitForTimeout(100);
    expect(await app.evaluate(() => (globalThis as unknown as { rendererReceipt: { historyCalls: number } }).rendererReceipt.historyCalls)).toBe(historyBaseline + 3);
    await app.evaluate(({ BrowserWindow }) => {
      const send = (value: unknown) => BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', value);
      const envelope = { sessionId: 12, nativeSessionId: 'renderer-native-s', at: '2026-09-30T00:00:00.000Z' };
      send({ ...envelope, type: 'run_progress', runId: 103, sequence: 1, phase: 'running' });
      send({ ...envelope, type: 'run_finished', runId: 102, sequence: 1, result: { ok: true, data: { runId: 102,
        sessionId: 12, nativeSessionId: 'renderer-native-s', status: 'completed', text: 'OLD RUN TEXT',
        error: null, stopped: false, cleanupErrors: [] } } });
    });
    historyCheckpoint = 'new Run stays active after old finish';
    await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'visible' });
    expect(await page.getByRole('textbox', { name: 'Message to model' }).inputValue()).toBe('Draft stays editable');
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('OLD RUN TEXT');
    await app.evaluate(() => { (globalThis as unknown as { rendererReceipt: { hold: boolean } }).rendererReceipt.hold = true; });
    historyCheckpoint = 'switch Session while history is pending';
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
    await page.locator('.sidebar-chat[data-session-id="13"]').click();
    await page.locator('[data-message-entry="renderer-t1"]').waitFor({ state: 'visible' });
    await app.evaluate(({ BrowserWindow }) => {
      const receipt = (globalThis as unknown as { rendererReceipt: { hold: boolean; release: (() => void) | null } }).rendererReceipt;
      receipt.hold = false;
      receipt.release?.();
      BrowserWindow.getAllWindows()[0]?.webContents.send('flowmate:event', { type: 'message_upsert', runId: 103,
        sessionId: 12, nativeSessionId: 'renderer-native-s', sequence: 2, at: '2026-09-30T00:00:00.000Z',
        message: { entryId: null, runId: 103, liveOrdinal: 1, timestamp: 1790726400003, persistence: 'pending',
          truncated: false, role: 'assistant', blocks: [{ type: 'text', text: 'WRONG SESSION' }], phase: 'streaming',
          stopReason: 'pending', toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' } });
    });
    await page.waitForTimeout(100);
    expect(await page.locator('[data-message-entry="renderer-t1"]').count()).toBe(1);
    expect(await page.locator('[data-message-entry="renderer-e1"]').count()).toBe(0);
    expect(await page.locator('.chat-transcript').textContent()).not.toContain('WRONG SESSION');

    // The original short page exhausted its cursor. After missed observations,
    // the refreshed newest page must make the intervening saved history reachable.
    await app.evaluate(() => {
      const receipt = (globalThis as unknown as { rendererReceipt: { items: unknown[] } }).rendererReceipt;
      for (let index = 0; index < 60; index++) receipt.items.push({ entryId: `renderer-gap-${index}`,
        runId: null, liveOrdinal: null, timestamp: 1790726400010, persistence: 'saved', truncated: false,
        role: 'assistant', blocks: [{ type: 'text', text: `Recovered message ${index}` }], phase: 'ended',
        stopReason: 'stop', toolCallId: null, toolName: null, isError: null, textOrigin: 'native-content' });
    });
    historyCheckpoint = 'refreshed latest page restores its older cursor';
    await page.locator('.sidebar-chat[data-session-id="12"]').click();
    await page.locator('[data-message-entry="renderer-gap-59"]').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Earlier messages', exact: true }).waitFor({ state: 'visible', timeout: 1000 });
    expect(await page.locator('[data-message-entry="renderer-gap-0"]').count()).toBe(0);
    await page.getByRole('button', { name: 'Earlier messages', exact: true }).click();
    await page.locator('[data-message-entry="renderer-gap-0"]').waitFor({ state: 'visible' });
    expect(await page.locator('[data-message-entry]').count()).toBe(63);
    expect(await page.locator('[data-message-entry]').evaluateAll((items) => items.slice(3)
      .map((item) => item.getAttribute('data-message-entry')))).toEqual(Array.from({ length: 60 }, (_, index) => `renderer-gap-${index}`));
    expect(await page.getByRole('button', { name: 'Earlier messages', exact: true }).count()).toBe(0);
    expect(await app.evaluate(() => (globalThis as unknown as { rendererReceipt: { startCalls: number } })
      .rendererReceipt.startCalls)).toBe(0);
  } catch (error) {
    const receipt = await app.evaluate(() => {
      const value = (globalThis as unknown as { rendererReceipt?: { historyCalls: number; activeQueries: number; maxQueries: number; startCalls: number; hold: boolean; queries: unknown[]; release: (() => void) | null } }).rendererReceipt;
      return value ? { historyCalls: value.historyCalls, activeQueries: value.activeQueries, maxQueries: value.maxQueries,
        startCalls: value.startCalls, hold: value.hold, queries: value.queries, hasRelease: value.release !== null } : null;
    }).catch(() => null);
    const view = await historyPage?.evaluate(() => ({
      entries: [...document.querySelectorAll('[data-message-entry]')].map(element => element.getAttribute('data-message-entry')),
      buttons: [...document.querySelectorAll('.agent-chat-panel button')].map(element => element.textContent),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
    })).catch(() => null);
    historyFailure = new Error(`Renderer history checkpoint ${historyCheckpoint}: ${JSON.stringify({ receipt, view })}`, { cause: error });
    throw historyFailure;
  } finally {
    await app.evaluate(() => {
      const receipt = (globalThis as unknown as { rendererReceipt?: { hold: boolean; release: (() => void) | null } }).rendererReceipt;
      if (receipt) { receipt.hold = false; receipt.release?.(); }
    }).catch(() => undefined);
    await closeDesktopFixture(app, userData, historyFailure);
  }
});

it('desktop completes import, Start Task, Run, candidate source and Activity without leaving the local fixture', async () => {
  it.setTimeout(120_000);
  if (process.platform !== 'win32') throw new Error('safeStorage desktop E2E currently requires the Windows developer host');
  if (!existsSync(electronPath)) throw new Error('Electron runtime binary is not installed; run the Electron install script');

  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p3-e2e-'));
  const sourceRoot = await mkdtemp(join(tmpdir(), 'flowmate-desktop-p3-source-'));
  const sourceDirectory = join(sourceRoot, '000001');
  writeInvoiceSample(sourceDirectory);
  const source = { documentId: 1, version: 'pending-import', artifactId: 2, page: 1, blockId: 'b1', quote: 'INV-P3-1' };
  const field = () => ({ raw: null, normalized: null, state: 'missing', alternatives: [], sources: [] });
  const candidate = {
    fields: {
      invoiceNumber: { raw: 'INV-P3-1', normalized: 'INV-P3-1', state: 'present', alternatives: [], sources: [source] },
      issueDate: field(), sellerName: field(), sellerTaxId: field(), buyerName: field(), buyerTaxId: field(),
      currency: field(), netAmount: field(), taxAmount: field(), totalAmount: field(),
    }, lines: [], notes: [],
  };
  const toolBatch = [
    ['list_invoice_pages', { documentId: 1 }],
    ['read_invoice_document', { documentId: 1, page: 1, afterBlockId: null, limit: 10 }],
    ['search_invoice_document', { documentId: 1, query: 'INV-P3-1', page: null, afterBlockId: null, limit: 10 }],
    ['list_invoice_tables', { documentId: 1, page: null, afterBlockId: null, limit: 10 }],
    ['read_invoice_evidence', { documentId: 1, page: 1, kind: 'parsed', blockId: 'b1' }],
    ['check_invoice_sources', { documentId: 1, sources: [source] }],
    ['normalize_invoice_values', { items: [{ kind: 'decimal', raw: '100.00' }, { kind: 'date', raw: '2026-02-28' }] }],
    ['calculate_invoice_amounts', { operation: 'sum', values: ['100.00', '10.00'], scale: 2 }],
    ['validate_invoice_candidate', { documentId: 1, candidate }],
    ['list_invoice_candidates', { beforeSequence: null, limit: 10 }],
    ['get_invoice_candidate', { candidateId: 1 }],
    ['compare_invoice_candidates', { leftCandidateId: 1, rightCandidateId: 1, afterPath: null, limit: 10 }],
  ] as const;
  const requests: Array<{ body: { tools?: unknown[]; messages?: unknown[] }; authorization: string | null }> = [];
  const server = await createHttpProvider(async request => {
      requests.push({ body: await request.json(), authorization: request.headers.get('authorization') });
      if (requests.length === 1) {
        return streamToolCall('save_invoice_candidate', 'desktop-p3-save-1', { documentId: 1, candidate });
      }
      if (requests.length === 2) return streamToolCalls(toolBatch.map(([name, args], index) => ({
        name, args, id: `desktop-p3-parallel-${index + 1}`,
      })));
      if (requests.length === 4) return streamToolCall('validate_invoice_candidate',
        'desktop-p3-validate-only-1', { documentId: 1, candidate });
      return streamText('Candidate saved from the imported invoice and all twelve read tools returned results.');
  });

  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  try {
    const env: Record<string, string> = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'BUN_INSTALL']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.FLOWMATE_TEST_MODE = '1';
    env.FLOWMATE_TEST_USER_DATA_ROOT = userData;
    env.FLOWMATE_TEST_INVOICE_SOURCE_ROOT = sourceRoot;
    electronApp = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await electronApp.firstWindow();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices' }).waitFor({ state: 'visible', timeout: 20_000 });

    await electronApp.evaluate(({ dialog }, selectedDirectory) => {
      const testDialog = dialog as unknown as {
        showOpenDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
        __selectedDefaultPath?: string;
      };
      testDialog.showOpenDialog = async (...args) => {
        const options = args.find((value) => value !== null && typeof value === 'object' && 'defaultPath' in value);
        testDialog.__selectedDefaultPath = (options as { defaultPath?: string } | undefined)?.defaultPath;
        return { canceled: false, filePaths: [selectedDirectory] };
      };
    }, sourceDirectory);
    await page.getByRole('button', { name: /Import invoice/ }).click();
    const selectedDefaultPath = await electronApp.evaluate(({ dialog }) =>
      (dialog as unknown as { __selectedDefaultPath?: string }).__selectedDefaultPath);
    expect(selectedDefaultPath).toBe(sourceRoot);
    await page.getByRole('heading', { name: 'Invoice 000001' }).waitFor({ state: 'visible', timeout: 10_000 });
    const imported = await page.evaluate(() => window.flowmate.queryDocument(1));
    if (!imported.ok) throw new Error(imported.error.code);
    source.version = imported.data.documentRef.version;
    await page.locator('img[alt="Original invoice document page 1"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Parsed', exact: true }).click();
    await page.getByText('Text · Page 1').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'Process this invoice', exact: true }).click();
    await page.getByText(/Ready to process/).waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Models' }).click();
    await page.getByRole('button', { name: 'Custom model' }).click();
    const modelDetails = page.locator('.config-panel');
    await modelDetails.getByLabel('Display name').fill('P3 controlled invoice model');
    await modelDetails.getByLabel(/Base URL/).fill(`http://127.0.0.1:${server.port}/v1`);
    await modelDetails.getByLabel('Model ID').fill('desktop-p3-model');
    await modelDetails.getByLabel('Pi API type').fill('openai-completions');
    await modelDetails.getByLabel('Context window').fill('64000');
    await modelDetails.getByLabel('Maximum output tokens').fill('16384');
    await modelDetails.getByLabel(/API Key/).fill('synthetic-desktop-p3-key');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Configuration saved'), null, { timeout: 10_000 });
    expect(requests).toHaveLength(0);
    await page.evaluate(() => {
      const current = window as unknown as { flowmate: { subscribe(listener: (event: unknown) => void): void }; toolEvents: unknown[] };
      current.toolEvents = [];
      current.flowmate.subscribe((event) => {
        if ((event as { type?: string }).type === 'tool_progress') current.toolEvents.push(event);
      });
    });

    const composer = page.getByRole('textbox', { name: 'Message to model' });
    await composer.fill('Review this invoice and prepare a candidate with sources.');
    const changedBehindThePage = await page.evaluate(async () => {
      const api = (window as unknown as { flowmate: {
        readWorkspace(): Promise<{ ok: boolean; data?: { revision: number; activeView: string } }>;
        updateWorkspace(input: { expectedRevision: number; change: { kind: 'view'; view: 'original' | 'parsed' } }): Promise<{ ok: boolean; data?: { revision: number } }>;
      } }).flowmate;
      const current = await api.readWorkspace();
      if (!current.ok || !current.data) return false;
      const changed = await api.updateWorkspace({ expectedRevision: current.data.revision,
        change: { kind: 'view', view: current.data.activeView === 'original' ? 'parsed' : 'original' } });
      return changed.ok && changed.data?.revision === current.data.revision + 1;
    });
    expect(changedBehindThePage).toBe(true);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Invoice context changed. Review it and press Send again; your message is preserved.')
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(await composer.inputValue()).toBe('Review this invoice and prepare a candidate with sources.');
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('[data-testid="chat-turn"]').filter({ hasText: 'all twelve read tools returned results' })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-message-role="toolResult"][data-persistence="saved"]').length === 13,
      null, { timeout: 10_000 });
    expect(await page.locator('[data-message-role="assistant"]').count()).toBe(3);
    expect(await page.locator('.chat-tool-call').count()).toBe(13);
    const messageEntryIds = await page.locator('[data-message-entry]').evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-message-entry')));
    expect(new Set(messageEntryIds).size).toBe(messageEntryIds.length);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ authorization }) => authorization === 'Bearer synthetic-desktop-p3-key')).toBe(true);
    const toolNames = (requests[0]?.body.tools ?? []).map((tool) => (tool as { function?: { name?: string } }).function?.name ?? '').sort();
    expect(toolNames).toEqual([...INVOICE_TOOL_NAMES, ...NATIVE_TOOL_NAMES, 'list_skill_resources', 'read_skill_resource'].sort());
    const toolEvents = await page.evaluate(() =>
      (window as unknown as { toolEvents: Array<{ toolName: string; phase: string; [key: string]: unknown }> }).toolEvents);
    expect(toolEvents.filter((event) => event.phase === 'running').map((event) => event.toolName).sort()).toEqual([...INVOICE_TOOL_NAMES].sort());
    expect(toolEvents.every((event) => !('args' in event) && !('input' in event))).toBe(true);
    expect(JSON.stringify(requests[1]?.body.messages)).toContain('desktop-p3-save-1');
    const saveResult = ((requests[1]?.body.messages ?? []) as Array<{ role?: string; content?: unknown }>).find((message) => message.role === 'tool');
    const parsedSaveContent = Array.isArray(saveResult?.content)
      ? saveResult.content.find((part) => typeof part === 'object' && part !== null && 'text' in part)?.text
      : saveResult?.content;
    expect(JSON.parse(String(parsedSaveContent))).toMatchObject({ candidateId: 1, jobId: 1, sequence: 1 });
    const parallelMessages = (requests[2]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: unknown }>;
    const parallelOutput = (index: number): unknown => {
      const message = parallelMessages.find((item) => item.role === 'tool' && item.tool_call_id === `desktop-p3-parallel-${index}`);
      if (typeof message?.content === 'string') {
        try { return JSON.parse(message.content); } catch { return message.content; }
      }
      const textPart = Array.isArray(message?.content) ? message.content.find((part) => typeof part === 'object' && part !== null && 'text' in part) : null;
      if (!textPart || typeof textPart !== 'object' || !('text' in textPart)) return null;
      try { return JSON.parse(String(textPart.text)); } catch { return textPart.text; }
    };
    expect(parallelMessages.filter((message) => message.role === 'tool' && message.tool_call_id?.startsWith('desktop-p3-parallel-'))).toHaveLength(12);
    expect(parallelOutput(1)).toMatchObject({ pageCount: 1, pages: [{ page: 1 }] });
    expect(parallelOutput(2)).toMatchObject({ blocks: [{ id: 'b1' }, { id: 'b2' }] });
    expect(parallelOutput(3)).toMatchObject({ matches: [{ blockId: 'b1', source: { quote: 'INV-P3-1' } }] });
    expect(parallelOutput(4)).toMatchObject({ tables: [{ blockId: 'b2' }] });
    expect(parallelOutput(5)).toMatchObject({ kind: 'parsed', source: { blockId: 'b1' }, text: 'Invoice number: INV-P3-1' });
    expect(parallelOutput(6)).toMatchObject({ results: [{ status: 'valid', code: 'parsed_quote_matched' }] });
    expect(parallelOutput(7)).toMatchObject({ items: [{ status: 'normalized' }, { status: 'normalized' }] });
    expect(parallelOutput(8)).toMatchObject({ operation: 'sum', exact: '110', rounded: '110.00' });
    expect(parallelOutput(9)).toMatchObject({ documentRef: { id: 1 }, saveable: true });
    expect(parallelOutput(10)).toMatchObject({ candidates: [{ candidateId: 1, sequence: 1 }] });
    expect(parallelOutput(11)).toMatchObject({ candidate: { fields: { invoiceNumber: { raw: 'INV-P3-1' } } } });
    expect(parallelOutput(12)).toMatchObject({ leftCandidateId: 1, rightCandidateId: 1, differences: [], complete: true });

    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Processing History' }).click();
    await page.getByText('Result 1 · generated').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByText(/Page 1 · “INV-P3-1”/).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('Result prepared', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await captureDesktopViews(page);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    expect(await page.locator('.chat-directory-row.selected').getByRole('button', { name: 'Delete' }).isEnabled()).toBe(true);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices' }).click();
    await page.getByRole('button', { name: 'Generate result', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Generate result for next message' }).getAttribute('aria-pressed')).toBe('true');
    await composer.fill('Save another result.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('log').getByText('The requested outcome was not confirmed. Check Processing History for any saved result.', { exact: true })
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(requests).toHaveLength(5);
    const validationMessage = ((requests[4]?.body.messages ?? []) as Array<{ role?: string; tool_call_id?: string; content?: unknown }>)
      .find((message) => message.role === 'tool' && message.tool_call_id === 'desktop-p3-validate-only-1');
    expect(JSON.parse(String(validationMessage?.content))).toMatchObject({ saveable: true });
    expect(await page.getByRole('button', { name: 'Generate result', exact: true }).getAttribute('aria-pressed')).toBe('false');
    await page.getByText('Material access').click();
    const confirmRevocation = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Any active response will stop');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Revoke model access', exact: true }).click();
    await confirmRevocation;
    await page.getByText(/Model access was revoked for 1 chat/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Invoices' }).click();
    await page.setViewportSize({ width: 980, height: 720 });
    const invoiceRow = page.locator('.invoice-context .route-row').filter({ hasText: 'Invoice 000001' });
    const invoiceDelete = page.locator('.invoice-heading-delete');
    await invoiceDelete.focus();
    expect(await invoiceDelete.evaluate((element) => document.activeElement === element)).toBe(true);
    const cancelInvoiceDelete = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Processing history and saved results will remain');
      await dialog.dismiss();
    });
    await page.keyboard.press('Enter');
    await cancelInvoiceDelete;
    expect(await invoiceRow.count()).toBe(1);
    const confirmInvoiceDelete = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await invoiceDelete.focus();
    await page.keyboard.press('Enter');
    await confirmInvoiceDelete;
    await page.getByText(/Invoice removed from All invoices/).waitFor({ state: 'visible', timeout: 10_000 });
    expect(await invoiceRow.count()).toBe(0);
    expect(await page.getByRole('option', { name: 'Invoice 000001' }).count()).toBe(0);
    const hiddenWorkspace = await page.evaluate(() => window.flowmate.readWorkspace());
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Activity' }).click();
    await page.getByLabel('Invoice or processing record').selectOption('processing:1');
    await page.getByRole('button', { name: 'View invoice', exact: true }).first().click();
    await expect(page.getByText('You are viewing a read-only record;', { exact: false })).toBeVisible();
    await expect(page.locator('.invoice-sheet img')).toBeVisible();
    expect(await page.getByRole('button', { name: 'Process this invoice', exact: true }).count()).toBe(0);
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(hiddenWorkspace);
    expect(requests).toHaveLength(5);
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Processing History' }).click();
    await page.getByRole('button', { name: 'Invoice 000001' }).click();
    await page.getByText('Read only', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText('Result 1 · generated').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByText(/Page 1 · “INV-P3-1”/).waitFor({ state: 'visible', timeout: 10_000 });
    const hidePrompt = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await hidePrompt;
    await page.getByText('No processing yet').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Chats' }).click();
    const selectedChat = page.locator('.chat-directory-row.selected');
    const selectedChatId = Number(await selectedChat.getAttribute('data-session-id'));
    const cancelChatDelete = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('invoice history and saved results will remain');
      await dialog.dismiss();
    });
    await selectedChat.getByRole('button', { name: 'Delete' }).click();
    await cancelChatDelete;
    expect(await selectedChat.count()).toBe(1);
    const confirmChatDelete = page.waitForEvent('dialog').then((dialog) => dialog.accept());
    const chatDelete = selectedChat.getByRole('button', { name: 'Delete' });
    await chatDelete.focus();
    expect(await chatDelete.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press('Enter');
    await confirmChatDelete;
    await page.locator(`.chat-directory-row[data-session-id="${selectedChatId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
    expect(await page.locator('.chats-page .notice').textContent()).toContain('Chat removed from Conversations');

    await closeDesktopFixture(electronApp, userData);
    electronApp = null;
    const database = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
    try {
      const job = database.query('SELECT id,current_candidate_id FROM jobs').get() as { id: number; current_candidate_id: number | null };
      expect(job).toEqual({ id: 1, current_candidate_id: null });
      expect(database.query('SELECT hidden_at IS NOT NULL AS hidden FROM jobs WHERE id=1').get()).toEqual({ hidden: 1 });
      expect(database.query('SELECT hidden_at IS NOT NULL AS hidden FROM documents WHERE id=1').get()).toEqual({ hidden: 1 });
      expect(database.query('SELECT hidden_at IS NOT NULL AS hidden FROM sessions WHERE id=?').get(selectedChatId)).toEqual({ hidden: 1 });
      expect(database.query('SELECT id,job_id,run_id,status FROM invoice_candidates').get())
        .toMatchObject({ id: 1, job_id: 1, run_id: expect.any(Number), status: 'generated' });
      expect(database.query('SELECT kind,status,job_id,tool_call_count FROM runs WHERE job_id=1 ORDER BY id ASC LIMIT 1').get())
        .toMatchObject({ kind: 'agent', status: 'completed', job_id: 1, tool_call_count: 13 });
      expect(database.query("SELECT status,tool_call_count,json_extract(error_json,'$.code') AS error FROM runs WHERE job_id=1 ORDER BY id DESC LIMIT 1").get())
        .toEqual({ status: 'failed', tool_call_count: 1, error: 'agent_goal_not_met' });
      expect(database.query('SELECT tool_name,status FROM tool_calls WHERE run_id=(SELECT id FROM runs WHERE job_id=1 ORDER BY id DESC LIMIT 1)').get())
        .toEqual({ tool_name: 'validate_invoice_candidate', status: 'succeeded' });
      const calls = database.query('SELECT tool_name,status FROM tool_calls WHERE run_id=(SELECT id FROM runs WHERE job_id=1 ORDER BY id ASC LIMIT 1) ORDER BY id').all() as Array<{ tool_name: string; status: string }>;
      expect(calls).toHaveLength(13);
      expect(calls.map((call) => call.tool_name).sort()).toEqual([
        'calculate_invoice_amounts', 'check_invoice_sources', 'compare_invoice_candidates', 'get_invoice_candidate',
        'list_invoice_candidates', 'list_invoice_pages', 'list_invoice_tables', 'normalize_invoice_values',
        'read_invoice_document', 'read_invoice_evidence', 'save_invoice_candidate', 'search_invoice_document',
        'validate_invoice_candidate',
      ].sort());
      expect(calls.every((call) => call.status === 'succeeded')).toBe(true);
      const modelBody = JSON.stringify(requests.map((request) => request.body.messages));
      expect(modelBody).not.toContain('"type":"image"');
      expect(modelBody).not.toContain(onePixelPng.toString('base64'));
      expect(database.query("SELECT tool_name,status,json_extract(delivery_json,'$.state') AS delivery FROM tool_calls WHERE tool_name='save_invoice_candidate'").get())
        .toEqual({ tool_name: 'save_invoice_candidate', status: 'succeeded', delivery: 'request_observed' });
      expect(database.query("SELECT tool_name,status,json_extract(delivery_json,'$.state') AS delivery FROM tool_calls WHERE tool_name='read_invoice_evidence'").get())
        .toEqual({ tool_name: 'read_invoice_evidence', status: 'succeeded', delivery: 'request_observed' });
      expect(database.query("SELECT count(*) AS count FROM business_events WHERE job_id=1 AND type='candidate_generated' AND result='succeeded'").get())
        .toEqual({ count: 1 });
      expect(JSON.parse(String(database.query('SELECT metadata_json FROM sessions WHERE id=(SELECT session_id FROM runs WHERE job_id=1)').get()
        && (database.query('SELECT metadata_json FROM sessions WHERE id=(SELECT session_id FROM runs WHERE job_id=1)').get() as { metadata_json: string }).metadata_json)))
        .toMatchObject({ model_use_blocked: { documentIds: [1], reason: 'document_use_revoked' } });
    } finally { database.close(); }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    throw failure;
  } finally {
    try { if (electronApp) await closeDesktopFixture(electronApp, userData, failure); }
    finally { await server.stop(true); }
  }
});
