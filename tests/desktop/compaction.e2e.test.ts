import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
function environment(root: string) {
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: root };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function open(root: string) {
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'),
    args: [join(repository, 'out/main/index.js')], env: environment(root), timeout: 30_000 });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
  await expect.poll(() => page.evaluate(async () => { const s = await window.flowmate.getState(); return s.ok && s.data.ready; })).toBe(true);
  return { app, page };
}
async function submit(page: Page, sessionId: number, index: number, text: string) {
  const accepted = await page.evaluate(input => window.flowmate.submitInput({ ...input, mode: 'prompt', modelId: 'p10-ui' }),
    { sessionId, clientSequence: index, text });
  expect(accepted.ok).toBe(true); if (!accepted.ok || !accepted.data.runId) throw new Error('No accepted Run');
  const runId = accepted.data.runId;
  return runId;
}
async function run(page: Page, sessionId: number, index: number, text: string) {
  const runId = await submit(page, sessionId, index, text);
  await expect.poll(() => page.evaluate(async id => { const r = await window.flowmate.queryRun(id);
    return r.ok ? r.data.status : r.error.code; }, runId), { timeout: 20_000 }).toBe('completed');
  return runId;
}

for (const mode of ['manual', 'threshold', 'overflow', 'cancel', 'auto-cancel'] as const) test(`P10 desktop real SDK ${mode} keeps execution, save and continuation separate`, async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p10-ui-')), payloads: unknown[] = [];
  let entered!: () => void, release!: () => void;
  const enteredSummary = new Promise<void>(resolve => { entered = resolve; });
  const summaryBarrier = new Promise<void>(resolve => { release = resolve; });
  const provider = await createHttpProvider(async request => {
    payloads.push(await request.json());
    const n = payloads.length, summary = n === (mode === 'overflow' ? 6 : 5);
    if (mode === 'overflow' && n === 5)
      return Response.json({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error' } }, { status: 400 });
    if ((mode === 'cancel' || mode === 'auto-cancel') && summary) {
      entered(); request.signal.addEventListener('abort', release, { once: true }); await summaryBarrier;
    }
    const text = summary ? 'P10 desktop native checkpoint' : n <= 4 ? `Saved invoice turn ${n}` : 'P10 explicit answer';
    const tokens = (mode === 'threshold' || mode === 'auto-cancel') && n === 4 ? 50000 : 10;
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p10-ui',
      choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop')
      + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: tokens, completion_tokens: 5, total_tokens: tokens + 5 } })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  let app: ElectronApplication | undefined, failure: Error | undefined;
  try {
    let opened = await open(root); app = opened.app; let page = opened.page;
    const sessionId = await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error(state.error.code);
      const saved = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'p10-ui', credentialRef: 'p10_ui_controlled_key',
        name: 'P10 controlled', kind: 'custom', providerId: null, baseUrl, model: 'p10-ui', api: 'openai-completions',
        contextWindow: 64000, maxTokens: 16384, reasoning: false }], defaultModelId: 'p10-ui' },
        { modelId: 'p10-ui', apiKey: 'synthetic-p10-ui-key' });
      if (!saved.ok) throw new Error(saved.error.code);
      const session = await window.flowmate.createSession({ title: 'P10 native history' }); if (!session.ok) throw new Error(session.error.code);
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error(workspace.error.code);
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision,
        change: { kind: 'session', sessionId: session.data.sessionId } }); if (!selected.ok) throw new Error(selected.error.code);
      return session.data.sessionId;
    }, `http://127.0.0.1:${provider.port}/v1`);
    let lastRun = 0;
    for (let index = 1; index <= 4; index++) {
      const text = `Invoice turn ${index} ` + 'x'.repeat(45000);
      lastRun = mode === 'auto-cancel' && index === 4 ? await submit(page, sessionId, index, text) : await run(page, sessionId, index, text);
    }
    if (mode === 'auto-cancel') await enteredSummary;
    if (mode === 'overflow') lastRun = await run(page, sessionId, 5, 'Explicit overflow question');
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = page.getByTestId('session-compaction');
    await expect(panel.getByRole('button', { name: 'Refresh compaction', exact: true })).toBeEnabled();
    let operationId: string, cancellationGenerated = false;
    if (mode === 'manual' || mode === 'cancel') {
      await expect(panel.getByRole('button', { name: 'Compact context', exact: true })).toBeEnabled();
      const before = await page.evaluate(id => window.flowmate.listSessionRuns({ sessionId: id, limit: 50 }), sessionId);
      await panel.getByRole('button', { name: 'Compact context', exact: true }).click();
      if (mode === 'cancel') {
        await enteredSummary;
        await expect(panel.getByRole('button', { name: 'Cancel compaction', exact: true })).toBeEnabled();
        // Exercise the real Host's 10-second request boundary once. Acceptance already returned.
        await new Promise(resolve => setTimeout(resolve, 10_200));
        expect(await page.evaluate(id => window.flowmate.querySessionCompaction({ sessionId: id }), sessionId))
          .toMatchObject({ ok: true, data: { operation: { phase: 'compacting', stopped: false } } });
        await panel.getByRole('button', { name: 'Cancel compaction', exact: true }).click();
        await expect.poll(() => page.evaluate(async id => { const f = await window.flowmate.querySessionCompaction({ sessionId: id });
          return f.ok && f.data.operation?.stopRequested; }, sessionId)).toBe(true);
        release();
      }
      await expect.poll(() => page.evaluate(async id => { const f = await window.flowmate.querySessionCompaction({ sessionId: id });
        return f.ok && f.data.operation?.stopped; }, sessionId)).toBe(true);
      const facts = await page.evaluate(id => window.flowmate.querySessionCompaction({ sessionId: id }), sessionId);
      expect(facts.ok).toBe(true); if (!facts.ok || !facts.data.operation) throw new Error('Missing operation');
      operationId = facts.data.operation.operationId;
      cancellationGenerated = facts.data.operation.generated;
      expect(facts.data.operation).toMatchObject({ reason: 'manual', stopped: true, runId: null,
        mayContinue: mode === 'manual', ...(mode === 'manual' ? { generated: true } : { saved: null }), stopRequested: mode === 'cancel' });
      expect(await page.evaluate(id => window.flowmate.listSessionRuns({ sessionId: id, limit: 50 }), sessionId)).toEqual(before);
    } else if (mode === 'auto-cancel') {
      await expect(panel.getByRole('button', { name: 'Cancel compaction', exact: true })).toBeEnabled();
      await panel.getByRole('button', { name: 'Cancel compaction', exact: true }).click();
      await expect.poll(() => page.evaluate(async input => { const f = await window.flowmate.querySessionCompaction(input);
        return f.ok && f.data.operation?.stopRequested; }, { sessionId, runId: lastRun })).toBe(true);
      release();
      await expect.poll(() => page.evaluate(async id => { const r = await window.flowmate.queryRun(id);
        return r.ok && r.data.status; }, lastRun)).toBe('cancelled');
      const facts = await page.evaluate(input => window.flowmate.querySessionCompaction(input), { sessionId, runId: lastRun });
      expect(facts.ok).toBe(true); if (!facts.ok || !facts.data.operation) throw new Error('Missing cancelled automatic operation');
      operationId = facts.data.operation.operationId;
      cancellationGenerated = facts.data.operation.generated;
      expect(facts.data.operation).toMatchObject({ reason: 'threshold', runId: lastRun, stopped: true, stopRequested: true,
        saved: null, mayContinue: false });
      expect(payloads).toHaveLength(5);
    } else {
      const facts = await page.evaluate(input => window.flowmate.querySessionCompaction(input), { sessionId, runId: lastRun });
      expect(facts.ok).toBe(true); if (!facts.ok || !facts.data.operation) throw new Error('Missing automatic operation');
      operationId = facts.data.operation.operationId;
      expect(facts.data.operation).toMatchObject({ reason: mode, stopped: true, generated: true, nativeOutcome: 'succeeded',
        runId: lastRun, mayContinue: false });
    }
    await panel.getByRole('button', { name: 'Refresh compaction', exact: true }).click();
    await expect(panel.getByTestId('compaction-operation')).toContainText('Execution ended');
    await expect(panel.getByTestId('compaction-operation')).toContainText(mode === 'cancel' || mode === 'auto-cancel'
      ? cancellationGenerated ? 'No confirmed commit' : 'No new summary generated' : 'History saved');
    const count = payloads.length;
    await panel.getByRole('button', { name: 'Refresh compaction', exact: true }).click();
    expect(payloads).toHaveLength(count);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    if (mode !== 'cancel' && mode !== 'auto-cancel' && mode !== 'overflow') {
      if (mode === 'manual') {
        await page.getByRole('textbox', { name: 'Message to model' }).fill('Explicit question after compaction');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(page.locator('.chat-transcript')).toContainText('P10 explicit answer', { timeout: 20_000 });
      } else await run(page, sessionId, 5, 'Explicit question after compaction');
      expect(JSON.stringify(payloads.at(-1))).toContain('P10 desktop native checkpoint');
    } else if (mode === 'overflow') expect(JSON.stringify(payloads.at(-1))).toContain('P10 desktop native checkpoint');
    if (mode === 'manual' || mode === 'cancel') {
      const count = payloads.length;
      await closeDesktopFixture(app, root); app = undefined;
      opened = await open(root); app = opened.app; page = opened.page;
      const restored = await page.evaluate(input => window.flowmate.querySessionCompaction(input), { sessionId, operationId });
      expect(restored).toMatchObject({ ok: true, data: { operationAvailability: 'unknown', operation: null } });
      if (restored.ok) expect(Boolean(restored.data.lastSaved)).toBe(mode === 'manual');
      expect(payloads).toHaveLength(count);
    }
    await closeDesktopFixture(app, root); app = undefined;
    const db = new Database(join(root, 'data/app.sqlite'), { readonly: true });
    try {
      const entries = db.query("SELECT entry_id,run_id,entry_json FROM session_native_entries WHERE json_extract(entry_json,'$.type')='compaction'").all();
      expect(entries.length).toBe(mode === 'cancel' || mode === 'auto-cancel' ? 0 : 1);
      if (entries[0]) expect(entries[0]).toMatchObject({ run_id: null });
    } finally { db.close(); }
  } catch (error) { failure = error as Error; throw error; }
  finally { release(); try { if (app) await closeDesktopFixture(app, root, failure); } finally { await provider.stop(); } }
});

test('P10 readonly UI lease discards a late query after switching Session', async () => {
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p10-ui-lease-'));
  const { app, page } = await open(root); let failure: Error | undefined;
  try {
    const ids = await page.evaluate(async () => {
      const a = await window.flowmate.createSession({ title: 'Compaction A' });
      const b = await window.flowmate.createSession({ title: 'Compaction B' });
      if (!a.ok || !b.ok) throw new Error('Session unavailable');
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error(workspace.error.code);
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision,
        change: { kind: 'session', sessionId: a.data.sessionId } }); if (!selected.ok) throw new Error(selected.error.code);
      const facts = await window.flowmate.querySessionCompaction({ sessionId: a.data.sessionId });
      if (!facts.ok) throw new Error(facts.error.code);
      return { a: a.data.sessionId, b: b.data.sessionId, facts };
    });
    // Inject only at the IPC delivery boundary. This proves UI identity isolation, not native compaction.
    await app.evaluate(({ ipcMain }, value) => {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      Reflect.set(globalThis, 'p10Lease', { release, calls: 0 });
      ipcMain.removeHandler('flowmate:query-session-compaction');
      ipcMain.handle('flowmate:query-session-compaction', async (_event, input) => {
        const gate = Reflect.get(globalThis, 'p10Lease'); gate.calls++;
        if (input.sessionId === value.a) await held;
        return { ok: true, data: { ...value.facts.data, sessionId: input.sessionId,
          lastSaved: input.sessionId === value.a ? { entryId: 'A-late-checkpoint', firstKeptEntryId: 'A-first', tokensBefore: 1,
            usage: null, originSessionId: value.a } : null } };
      });
    }, ids);
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'p10Lease').calls)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Close details', exact: true }).click();
    await page.locator(`.sidebar-chat[data-session-id="${ids.b}"]`).click();
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Session details', exact: true })).toContainText(`Session ${ids.b} · Recorded facts`);
    await expect(page.getByTestId('session-compaction')).toContainText('None observed');
    await app.evaluate(() => Reflect.get(globalThis, 'p10Lease').release());
    await page.getByTestId('session-compaction').getByRole('button', { name: 'Refresh compaction', exact: true }).click();
    await expect(page.getByTestId('session-compaction')).not.toContainText('A-late-checkpoint');
  } catch (error) { failure = error as Error; throw error; }
  finally { await app.evaluate(() => Reflect.get(globalThis, 'p10Lease')?.release()).catch(() => {}); await closeDesktopFixture(app, root, failure); }
});
