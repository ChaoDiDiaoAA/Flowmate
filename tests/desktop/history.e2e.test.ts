import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
const repository = resolve(import.meta.dirname, '../..');
function environment() {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function fixture(withQueued = false) {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p9-history-ui-'));
  let requests = 0;
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), first = new Promise<void>(resolve => { entered = resolve; });
  const provider = await createHttpProvider(async () => {
    requests++; if (withQueued && requests === 1) { entered(); await barrier; }
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'history-ui', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'Saved history answer.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  let app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
    env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  let page = await app.firstWindow();
  try {
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    const seed = await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw new Error(state.error.code);
      const settings = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'history-ui', credentialRef: 'history_ui_controlled_key', name: 'History UI', kind: 'custom', providerId: null,
        baseUrl, model: 'history-ui', api: 'openai-completions', contextWindow: 64000, maxTokens: 16384, reasoning: false }], defaultModelId: 'history-ui' }, { modelId: 'history-ui', apiKey: 'synthetic-history-key' });
      if (!settings.ok) throw new Error(settings.error.code);
      const session = await window.flowmate.createSession({ title: 'History original' }); if (!session.ok) throw new Error(session.error.code);
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error(workspace.error.code);
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'session', sessionId: session.data.sessionId } });
      if (!selected.ok) throw new Error(selected.error.code);
      const run = await window.flowmate.submitInput({ sessionId: session.data.sessionId, clientSequence: 1, mode: 'prompt', text: 'Saved original user', modelId: 'history-ui' });
      if (!run.ok) throw new Error(run.error.code);
      return { sessionId: session.data.sessionId, runId: run.data.runId };
    }, `http://127.0.0.1:${provider.port}/v1`);
    let queuedInputId: number | null = null, consumedPrimary: { inputId: number; nativeEntryId: string | null } | null = null;
    if (withQueued) { await first;
      const queued = await page.evaluate(seed => window.flowmate.submitInput({ sessionId: seed.sessionId, runId: seed.runId, clientSequence: 2, mode: 'followUp', text: 'Unconfirmed follow-up gap' }), seed);
      if (!queued.ok) throw new Error(queued.error.code); queuedInputId = queued.data.inputId;
      const inputs = await page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), seed.sessionId); if (!inputs.ok) throw new Error(inputs.error.code);
      const primary = inputs.data.items.find(item => item.clientSequence === 1)!;
      expect(primary.status).toBe('consumed'); expect(primary.nativeEntryId).not.toBeNull(); consumedPrimary = { inputId: primary.inputId, nativeEntryId: primary.nativeEntryId };
      expect(inputs.data.items.find(item => item.inputId === queuedInputId)).toMatchObject({ status: 'queued', nativeEntryId: null });
      console.log('T08 lost-outcome admitted inputs', JSON.stringify(inputs));
      await app.evaluate(async (_electron, root) => {
        const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
        const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
          && value.spawnargs.includes(root) && value.spawnargs.includes('apps/host/main.ts')) as import('node:child_process').ChildProcess;
        if (!child) throw new Error('Owned Host missing');
        await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
      }, userData);
      console.log('T08 lost-outcome Host exit confirmed');
      release();
      // The process-loss fixture intentionally cannot attest graceful Host cleanup.
      // Main correctly refuses normal quit; end only this owned desktop and await exit.
      const exited = new Promise<void>(resolve => app.process().once('exit', () => resolve()));
      await app.evaluate(({ app }) => { setImmediate(() => app.exit(0)); }).catch(() => {}); await exited; await app.close();
      console.log('T08 lost-outcome Desktop exit confirmed');
      // The real controller lock remains leased for 15 seconds after abrupt death.
      await expect.poll(async () => { try { return Date.now() - (await stat(join(userData, 'data/app.sqlite.lock'))).mtimeMs > 15_000; } catch { return true; } }, { timeout: 20_000 }).toBe(true);
      app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
        env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
      page = await app.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    }
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    await page.reload(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    return { app, page, seed, userData, provider, queuedInputId, consumedPrimary, requests: () => requests };
  } catch (error) { release(); await provider.stop(); await closeDesktopFixture(app, userData, error as Error); throw error; }
}

test('P9 T08 browses saved history and exact Continue through the real public IPC', async () => {
  const f = await fixture(); let failure: Error | undefined;
  try {
    expect(await f.page.evaluate(() => typeof window.flowmate.querySessionHistory)).toBe('function');
    const invalid = await f.page.evaluate(async () => Promise.all([
      window.flowmate.querySessionHistory({ sessionId: 1, cwd: 'private' } as never),
      window.flowmate.querySessionHistoryEntry({ sessionId: 1, entryId: 'x' } as never),
      window.flowmate.forkSession({ sourceSessionId: 1 } as never),
    ]));
    for (const result of invalid) expect(result).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    await installHistoryGate(f.app, f.userData); await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').hold('query_session_history'));
    const poisoned = f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId);
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').held.length)).toBe(1);
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').release(0, false, true));
    expect(await poisoned).toMatchObject({ ok: false, error: { code: 'internal_error', message: 'History is unavailable.' } });
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').restore());
    const page = await f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId);
    expect(page.ok).toBe(true); if (!page.ok) throw new Error(page.error.code);
    const user = page.data.items.find(item => item.preview === 'Saved original user'); expect(user?.canSelect).toBe(true);
    const oldBranch = await f.page.evaluate(input => window.flowmate.branchSession(input as never), { sessionId: f.seed.sessionId, expectedLeafId: page.data.commit.leafId, expectedEntryCount: page.data.commit.entryCount, targetEntryId: user!.entryId });
    expect(oldBranch).toMatchObject({ ok: false, error: { code: 'input_invalid' } });
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(panel.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Browse history', exact: true }).click();
    await expect(panel.getByText('Saved revision', { exact: false })).toBeVisible();
    await panel.getByTestId(`history-entry-${user!.entryId}`).click();
    await expect(panel.getByTestId('history-text')).toHaveText('Saved original user');
    await panel.getByRole('button', { name: 'Continue here', exact: true }).click();
    await expect.poll(() => f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId))
      .toMatchObject({ ok: true, data: { commit: { leafId: user!.entryId, entryCount: page.data.commit.entryCount } } });
    expect(f.requests()).toBe(1);
    console.log('T08 history focus before Escape', await f.page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 100), inDialog: !!document.activeElement?.closest('[role="dialog"]') })));
    await f.page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Session details', exact: true })).toBeFocused();
    const saved = await f.page.evaluate(async id => ({ history: await window.flowmate.querySessionHistory({ sessionId: id }), workspace: await window.flowmate.readWorkspace() }), f.seed.sessionId);
    await closeDesktopFixture(f.app, f.userData);
    f.app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
      env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: f.userData }, timeout: 30_000 });
    f.page = await f.app.firstWindow(); await f.page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    expect(await f.page.evaluate(async id => ({ history: await window.flowmate.querySessionHistory({ sessionId: id }), workspace: await window.flowmate.readWorkspace() }), f.seed.sessionId)).toEqual(saved);
    expect(f.requests()).toBe(1);
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
  const db = new Database(join(f.userData, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); expect(db.query('SELECT COUNT(*) count FROM runs').get()).toEqual({ count: 1 }); }
  finally { db.close(); }
});

async function installHistoryGate(app: ElectronApplication, root: string) {
  await app.evaluate((_electron, root) => {
    const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
    const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
      && value.spawnargs.includes(root) && value.spawnargs.includes('apps/host/main.ts')) as import('node:child_process').ChildProcessWithoutNullStreams;
    if (!child) throw new Error('Owned Host missing');
    const write = child.stdin.write, emit = child.stdout.emit, commands: unknown[] = [], kinds = new Map<string, string>();
    const held: Buffer[] = [], writes: Parameters<typeof write>[] = []; let kind = '', count = 0, writeKind = '', writeCount = 0, buffer = Buffer.alloc(0);
    child.stdin.write = function (this: typeof child.stdin, ...args: Parameters<typeof write>) {
      try { const command = JSON.parse(String(args[0])); commands.push(command); kinds.set(command.requestId, command.type);
        if (command.type === writeKind && writeCount > 0) { writeCount--; writes.push(args); return true; }
      } catch {}
      return Reflect.apply(write, this, args);
    } as typeof write;
    child.stdout.emit = function (this: typeof child.stdout, event: string | symbol, ...args: unknown[]) {
      if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
      buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline !== -1; newline = buffer.indexOf(10)) {
        const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        try { const packet = JSON.parse(String(line)); if (packet.type === 'response' && kinds.get(packet.requestId) === kind && count > 0) { count--; held.push(Buffer.from(line)); continue; } } catch {}
        forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, this, ['data', Buffer.concat(forward)]) : true;
    };
    Reflect.set(globalThis, 'historyGate', { commands, held, hold(type: string, amount = 1) { kind = type; count = amount; },
      writes, holdWrite(type: string) { writeKind = type; writeCount = 1; },
      releaseWrite() { const args = writes.shift(); if (args) Reflect.apply(write, child.stdin, args); },
      packet(index: number) { return JSON.parse(String(held[index])); },
      release(index: number, lose = false, poison = false) {
        let line = held[index]; if (!line?.length) return;
        if (poison) { const packet = JSON.parse(String(line)); packet.value.data.sdk = { secret: 'PRIVATE-HISTORY' }; line = Buffer.from(JSON.stringify(packet) + '\n'); }
        if (lose) { const packet = JSON.parse(String(line)); packet.value = { ok: false, error: { code: 'operation_result_unknown', category: 'runtime', retryable: false, message: 'Unknown receipt' } }; line = Buffer.from(JSON.stringify(packet) + '\n'); }
        Reflect.apply(emit, child.stdout, ['data', line]); held[index] = Buffer.alloc(0);
      },
      restore() { for (const args of writes.splice(0)) Reflect.apply(write, child.stdin, args); for (const line of held) if (line.length) Reflect.apply(emit, child.stdout, ['data', line]); child.stdin.write = write; child.stdout.emit = emit; } });
  }, root);
}

test('P9 T08 retries the whole frozen fork body after the source revision title and selected node change', async () => {
  const f = await fixture(); let failure: Error | undefined;
  try {
    const composer = f.page.getByRole('textbox', { name: 'Message to model' }); await composer.fill('Source draft stays here');
    const before = await f.page.evaluate(() => window.flowmate.readWorkspace()); if (!before.ok) throw new Error(before.error.code);
    const history = await f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId); if (!history.ok) throw new Error(history.error.code);
    const user = history.data.items.find(item => item.preview === 'Saved original user')!, assistant = history.data.items.find(item => item.preview === 'Saved history answer.')!;
    await installHistoryGate(f.app, f.userData);
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true }); await panel.getByRole('button', { name: 'Browse history' }).click();
    await panel.getByTestId(`history-entry-${assistant.entryId}`).click(); await panel.getByRole('button', { name: 'Fork chat', exact: true }).click();
    await panel.getByLabel('Fork title').fill(' '); await panel.getByRole('button', { name: 'Confirm fork' }).click();
    await expect(panel.getByRole('status')).toHaveText('Session history request is invalid.');
    await panel.getByLabel('Fork title').fill('  Frozen child  ');
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').hold('fork_session'));
    await panel.getByRole('button', { name: 'Confirm fork' }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').held.length)).toBe(1);
    const created = await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').packet(0).value);
    expect(created).toMatchObject({ ok: true, data: { sourceSessionId: f.seed.sessionId, selectedEntryId: assistant.entryId } });
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').release(0, true));
    await expect(panel.getByRole('status')).toContainText('receipt is unknown');
    const sourceMoved = await f.page.evaluate(input => window.flowmate.branchSession(input), { sessionId: f.seed.sessionId, expectedCommitRevision: history.data.commit.commitRevision,
      expectedLeafId: history.data.commit.leafId, expectedEntryCount: history.data.commit.entryCount, targetEntryId: user.entryId }); expect(sourceMoved.ok).toBe(true);
    const targetMoved = await f.page.evaluate(input => window.flowmate.branchSession(input), { sessionId: created.data.session.sessionId, expectedCommitRevision: created.data.commit.commitRevision,
      expectedLeafId: created.data.commit.leafId, expectedEntryCount: created.data.commit.entryCount, targetEntryId: user.entryId }); expect(targetMoved.ok).toBe(true);
    await panel.getByRole('button', { name: 'Reload history' }).click(); await panel.getByTestId(`history-entry-${user.entryId}`).click(); await panel.getByLabel('Fork title').fill('Different title');
    await panel.getByRole('button', { name: 'Retry same fork' }).click(); await expect(panel).toHaveCount(0);
    await expect(composer).toHaveValue('');
    const after = await f.page.evaluate(() => window.flowmate.readWorkspace()); expect(after).toMatchObject({ ok: true, data: { ...before.data, sessionId: created.data.session.sessionId, revision: before.data.revision + 1, updatedAt: expect.any(String) } });
    const commands = await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').commands);
    const forks = commands.filter((command: { type: string }) => command.type === 'fork_session'); expect(forks).toHaveLength(2); expect(forks[1].input).toEqual(forks[0].input);
    expect(forks[1].input).toMatchObject({ title: 'Frozen child', targetEntryId: assistant.entryId, expected: history.data.commit });
    expect(commands.filter((command: { type: string }) => ['submit_session_input', 'start_run', 'start_task', 'select_candidate'].includes(command.type))).toEqual([]);
    expect(f.requests()).toBe(1);
    await test.info().attach('frozen-fork-actual-pipe', { body: Buffer.from(JSON.stringify(commands)), contentType: 'application/json' });
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const targetPanel = f.page.getByRole('dialog', { name: 'Session details', exact: true }); await targetPanel.getByRole('button', { name: 'Browse history' }).click();
    await targetPanel.getByRole('button', { name: `Source Session ${f.seed.sessionId} / Run ${f.seed.runId}`, exact: true }).first().click();
    await expect(targetPanel.getByTestId('context-snapshot-detail')).toContainText('Saved original user');
    await expect(targetPanel).toContainText(`Session ${f.seed.sessionId} · Recorded facts`);
    expect((await f.page.evaluate(() => window.flowmate.readWorkspace()))).toMatchObject({ ok: true, data: { sessionId: created.data.session.sessionId } });
    await f.page.keyboard.press('Escape');
    await f.page.locator(`.sidebar-chat[data-session-id="${f.seed.sessionId}"]`).click(); await expect(composer).toHaveValue('Source draft stays here');
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate')?.restore()).catch(() => {}); await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
});

test('P9 T08 ignores late real pages details and branch replies without changing the newer selection', async () => {
  const f = await fixture(); let failure: Error | undefined;
  try {
    const b = await f.page.evaluate(() => window.flowmate.createSession({ title: 'Other history' })); if (!b.ok) throw new Error(b.error.code);
    await f.page.reload(); await f.page.getByRole('button', { name: 'Session details', exact: true }).waitFor();
    const original = await f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId); if (!original.ok) throw new Error(original.error.code);
    const user = original.data.items.find(item => item.preview === 'Saved original user')!, assistant = original.data.items.find(item => item.preview === 'Saved history answer.')!;
    await installHistoryGate(f.app, f.userData);
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').hold('query_session_history'));
    await panel.getByRole('button', { name: 'Browse history' }).click();
    await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').held.length)).toBe(1);
    await f.page.keyboard.press('Escape'); await f.page.locator(`.sidebar-chat[data-session-id="${b.data.sessionId}"]`).click();
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click(); await panel.getByRole('button', { name: 'Browse history' }).click();
    await expect(panel).toContainText('0 entries'); await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').release(0));
    await expect(panel).toContainText('0 entries'); await expect(panel).not.toContainText('Saved original user');
    await f.page.keyboard.press('Escape'); await f.page.locator(`.sidebar-chat[data-session-id="${f.seed.sessionId}"]`).click();
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click(); await panel.getByRole('button', { name: 'Browse history' }).click();
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').hold('query_session_history_entry', 2));
    await panel.getByTestId(`history-entry-${user.entryId}`).click(); await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').held.length)).toBe(2);
    await panel.getByTestId(`history-entry-${assistant.entryId}`).click(); await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').held.length)).toBe(3);
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').release(1)); await expect(panel.getByTestId('history-text')).toHaveCount(0);
    await expect(panel.getByText('Loading entry…', { exact: true })).toBeVisible();
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').release(2)); await expect(panel.getByTestId('history-text')).toHaveText('Saved history answer.');
    await panel.getByTestId(`history-entry-${user.entryId}`).click(); await expect(panel.getByTestId('history-text')).toHaveText('Saved original user');
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').hold('branch_session'));
    await panel.getByRole('button', { name: 'Continue here' }).click(); await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').held.length)).toBe(4);
    await panel.getByTestId(`history-entry-${assistant.entryId}`).click();
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').release(3));
    await expect(panel.getByTestId(`history-entry-${assistant.entryId}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).not.toContainText('Chat position saved.');
    await expect(panel.getByRole('alert')).toContainText('History changed. Reload to continue.');
    expect(f.requests()).toBe(1);
    await test.info().attach('late-history-actual-pipe', { body: Buffer.from(JSON.stringify(await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').commands))), contentType: 'application/json' });
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate')?.restore()).catch(() => {}); await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
});

test('P9 T08 preserves a durable fork across late navigation and a real Workspace CAS conflict', async () => {
  const f = await fixture(); let failure: Error | undefined;
  try {
    const other = await f.page.evaluate(() => window.flowmate.createSession({ title: 'Concurrent selection' })); if (!other.ok) throw new Error(other.error.code);
    await f.page.reload();
    const composer = f.page.getByRole('textbox', { name: 'Message to model' }); await composer.fill('Unmoved source draft');
    await installHistoryGate(f.app, f.userData);
    const history = await f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId); if (!history.ok) throw new Error(history.error.code);
    const entry = history.data.items.find(item => item.preview === 'Saved original user')!;
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true });
    const openFork = async () => {
      await f.page.getByRole('button', { name: 'Session details', exact: true }).click(); await panel.getByRole('button', { name: 'Browse history' }).click();
      await panel.getByTestId(`history-entry-${entry.entryId}`).click(); await panel.getByRole('button', { name: 'Fork chat', exact: true }).click();
    };
    await openFork(); await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').hold('fork_session'));
    await panel.getByRole('button', { name: 'Confirm fork' }).click(); await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').held.length)).toBe(1);
    const late = await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').packet(0).value); expect(late.ok).toBe(true);
    await f.page.keyboard.press('Escape'); await f.page.locator(`.sidebar-chat[data-session-id="${other.data.sessionId}"]`).click(); await composer.fill('Other draft');
    const beforeLate = await f.page.evaluate(() => window.flowmate.readWorkspace());
    await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').release(0));
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(beforeLate); await expect(composer).toHaveValue('Other draft');
    expect(await f.page.evaluate(id => window.flowmate.querySession(id), late.data.session.sessionId)).toMatchObject({ ok: true });
    await f.page.locator(`.sidebar-chat[data-session-id="${f.seed.sessionId}"]`).click(); await expect(composer).toHaveValue('Unmoved source draft');
    await openFork(); await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').holdWrite('update_workspace'));
    await panel.getByRole('button', { name: 'Confirm fork' }).click(); await expect.poll(() => f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').writes.length)).toBe(1);
    const changed = await f.page.evaluate(async id => { const current = await window.flowmate.readWorkspace(); if (!current.ok) return current;
      return window.flowmate.updateWorkspace({ expectedRevision: current.data.revision, change: { kind: 'session', sessionId: id } }); }, other.data.sessionId);
    expect(changed.ok).toBe(true); await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').releaseWrite());
    await expect(panel.getByRole('status')).toContainText('is saved. Workspace selection was not confirmed.');
    expect(await f.page.evaluate(() => window.flowmate.readWorkspace())).toEqual(changed);
    const commands = await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').commands);
    const target = commands.filter((command: { type: string }) => command.type === 'update_workspace').at(-2).input.change.sessionId;
    expect(await f.page.evaluate(id => window.flowmate.querySession(id), target)).toMatchObject({ ok: true });
    await f.page.keyboard.press('Escape'); await f.page.locator(`.sidebar-chat[data-session-id="${f.seed.sessionId}"]`).click(); await expect(composer).toHaveValue('Unmoved source draft');
    expect(f.requests()).toBe(1);
    await test.info().attach('late-fork-and-selection-conflict', { body: Buffer.from(JSON.stringify(commands)), contentType: 'application/json' });
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate')?.restore()).catch(() => {}); await f.provider.stop(); await closeDesktopFixture(f.app, f.userData, failure); }
});

test('P9 T08 restores the saved leaf after relaunch and keeps valid unknown inputs readable with unusable history', async () => {
  test.setTimeout(60_000);
  const f = await fixture(true); let failure: Error | undefined, active = f.app;
  try {
    const original = await f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId); if (!original.ok) throw new Error(original.error.code);
    const user = original.data.items.find(item => item.preview === 'Saved original user')!;
    const branch = await f.page.evaluate(input => window.flowmate.branchSession(input), { sessionId: f.seed.sessionId, targetEntryId: user.entryId,
      expectedCommitRevision: original.data.commit.commitRevision, expectedLeafId: original.data.commit.leafId, expectedEntryCount: original.data.commit.entryCount });
    console.log('T08 queued source branch', JSON.stringify({ original, branch })); expect(branch).toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
    const recovered = await f.page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), f.seed.sessionId); if (!recovered.ok) throw new Error(recovered.error.code);
    expect(recovered.data.items.find(item => item.inputId === f.queuedInputId)).toMatchObject({ status: 'delivery_unknown', nativeEntryId: null });
    expect(recovered.data.items.find(item => item.inputId === f.consumedPrimary!.inputId)).toMatchObject({ ...f.consumedPrimary, status: 'consumed' });
    expect(f.requests()).toBe(1);
    const saved = await f.page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId);
    const workspace = await f.page.evaluate(() => window.flowmate.readWorkspace());
    await closeDesktopFixture(active, f.userData);
    const launch = async () => {
      active = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
        env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: f.userData }, timeout: 30_000 });
      const page = await active.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor(); return page;
    };
    let page = await launch();
    expect(await page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId)).toEqual(saved);
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(workspace);
    expect(f.requests()).toBe(1);
    console.log('T08 actual queued lost-outcome facts', JSON.stringify(await page.evaluate(async id => ({ session: await window.flowmate.querySession(id), inputs: await window.flowmate.listSessionInputs({ sessionId: id }), workspace: await window.flowmate.readWorkspace() }), f.seed.sessionId)));
    await expect(page.getByTestId('session-input').filter({ hasText: 'Unconfirmed follow-up gap' })).toContainText('delivery_unknown');
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(workspace);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('Do not replay an unknown input');
    await expect(page.getByRole('button', { name: /^Send/ })).toBeDisabled();
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Session details', exact: true }); await panel.getByRole('button', { name: 'Browse history' }).click();
    await expect(panel.getByText('History is unavailable.', { exact: true })).toBeVisible();
    expect(f.requests()).toBe(1);
    await test.info().attach('history-unavailable-workspace-readable', { body: await page.screenshot(), contentType: 'image/png' });
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.provider.stop(); if (active.process().exitCode === null && active.process().signalCode === null) await closeDesktopFixture(active, f.userData, failure); }
});

test('P9 T08 keeps Workspace readable and reports unprovable input evidence when the original tree is corrupt', async () => {
  const f = await fixture(); let active = f.app, failure: Error | undefined;
  try {
    const workspace = await f.page.evaluate(() => window.flowmate.readWorkspace());
    await closeDesktopFixture(active, f.userData);
    const db = new Database(join(f.userData, 'data/app.sqlite'));
    try { db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.type','future-unknown') WHERE session_id=? AND sequence=2").run(f.seed.sessionId);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); } finally { db.close(); }
    active = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
      env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: f.userData }, timeout: 30_000 });
    const page = await active.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(workspace);
    const inputs = await page.evaluate(id => window.flowmate.listSessionInputs({ sessionId: id }), f.seed.sessionId);
    console.log('T08 malformed tree input boundary', JSON.stringify(inputs)); expect(inputs.ok).toBe(false);
    await expect(page.getByText('Saved inputs are unavailable.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('session-input')).toHaveCount(0);
    await page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Session details', exact: true }); await panel.getByRole('button', { name: 'Browse history' }).click();
    await expect(panel.getByText('History is unavailable.', { exact: true })).toBeVisible(); expect(f.requests()).toBe(1);
    await test.info().attach('corrupt-history-retains-workspace', { body: await page.screenshot(), contentType: 'image/png' });
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.provider.stop(); if (active.process().exitCode === null && active.process().signalCode === null) await closeDesktopFixture(active, f.userData, failure); }
});

async function treeFixture() {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-p9-tree-'));
  const script = `
    import { openDatabase } from './packages/core/src/storage/database.ts';
    import { createHash } from 'node:crypto';
    import { resolveProductPaths } from '@flowmate/shared';
    import { SessionManager } from '@earendil-works/pi-coding-agent';
    import { nativeAssistantFacts } from './tests/support/history.ts';
    const need=r=>{if(!r.ok)throw new Error(r.error.code);return r.data;};
    const root=await Bun.stdin.text(), paths=need(resolveProductPaths(root)), db=need(openDatabase(paths));
    try {
      const at='2026-10-04T00:00:00.000Z', long='界'.repeat(23000);
      const base=(id,parentId,type)=>({id,parentId,type,timestamp:at});
      const entries=[{...base('metadata',null,'custom'),customType:'opaque',data:{secret:'PRIVATE-HISTORY'}},
        {...base('user','metadata','message'),message:{role:'user',content:'Original tree user',timestamp:1}},
        {...base('assistant','user','message'),message:{...nativeAssistantFacts,role:'assistant',content:[{type:'thinking',thinking:long},{type:'text',text:''},{type:'text',text:long}],stopReason:'stop',timestamp:2}},
        {...base('bash','assistant','message'),message:{role:'bashExecution',command:long,output:long,fullOutputPath:'PRIVATE-HISTORY',cancelled:false,truncated:false,timestamp:3}},
        {...base('custom-message','bash','custom_message'),customType:'fixture',display:false,content:long,details:{secret:'PRIVATE-HISTORY'}},
        {...base('label','custom-message','label'),targetId:'user',label:long},
        {...base('name','label','session_info'),name:long},
        {...base('model','name','model_change'),provider:'fixture',modelId:'fixture'},
        {...base('thinking','model','thinking_level_change'),thinkingLevel:'off'},
        {...base('compact','thinking','compaction'),summary:long,firstKeptEntryId:'user',tokensBefore:1},
        {...base('branch','compact','branch_summary'),fromId:'user',summary:long},
        {...base('incomplete','user','message'),message:{...nativeAssistantFacts,role:'assistant',content:[{type:'toolCall',id:'unclosed',name:'fixture',arguments:{secret:'PRIVATE-HISTORY'}}],stopReason:'toolUse',timestamp:4}},
      ];
      for(let i=0;i<45;i++)entries.push({...base('side-'+i,'user','custom_message'),customType:'side',display:true,content:'Side branch '+i});
      const header=SessionManager.inMemory(paths.runtimeDir).getHeader();
      const session=need(db.sessions.create({nativeSessionId:header.id,title:'Complete tree',at,nativeHistory:{storageVersion:1,header,entries,leafId:'branch',unusable:false}}));
      if(db.db.query('PRAGMA foreign_key_check').all().length)throw new Error('FK failure');
      console.log(JSON.stringify({sessionId:session.sessionId,count:entries.length,entriesHash:createHash('sha256').update(JSON.stringify(db.db.query('SELECT * FROM session_native_entries ORDER BY sequence').all())).digest('hex')}));
    } finally {db.close();}
  `;
  const child = spawn('bun', ['--no-env-file', '--eval', script], { cwd: repository, env: environment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
  child.stdin.end(userData);
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  expect(exit, stderr).toBe(0); const seed = JSON.parse(stdout.trim());
  const app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
    env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
  await page.evaluate(async id => { const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw new Error(workspace.error.code);
    const result = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision, change: { kind: 'session', sessionId: id } }); if (!result.ok) throw new Error(result.error.code);
  }, seed.sessionId);
  await page.reload(); await page.getByRole('button', { name: 'Session details', exact: true }).waitFor();
  return { app, page, userData, seed };
}

test('P9 T08 browses every branch nine entry types and complete UTF8 text without read side effects', async () => {
  const f = await treeFixture(); let failure: Error | undefined;
  try {
    await installHistoryGate(f.app, f.userData);
    const eof = await f.page.evaluate(async id => {
      const history = await window.flowmate.querySessionHistory({ sessionId: id }); if (!history.ok) return history;
      return window.flowmate.querySessionHistoryEntry({ sessionId: id, entryId: 'assistant', expectedCommitRevision: history.data.commit.commitRevision, partIndex: 0, offset: 69000 });
    }, f.seed.sessionId);
    expect(eof).toMatchObject({ ok: true, data: { partIndex: 2, offset: 0, part: { kind: 'text' } } });
    await f.page.getByRole('button', { name: 'Session details', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: 'Session details', exact: true }); await panel.getByRole('button', { name: 'Browse history' }).click();
    await expect(panel.locator('.history-tree > li')).toHaveCount(50);
    await panel.getByRole('button', { name: 'More history' }).click(); await expect(panel.locator('.history-tree > li')).toHaveCount(f.seed.count);
    await expect(panel.getByTestId('history-entry-side-44')).toBeVisible();
    await panel.getByTestId('history-entry-metadata').click(); await expect(panel.getByRole('button', { name: 'Continue here' })).toBeDisabled();
    await panel.getByTestId('history-entry-incomplete').click(); await expect(panel.getByRole('button', { name: 'Continue here' })).toBeDisabled();
    const long = '界'.repeat(23000);
    for (const [entryId, text] of [['assistant', long + long], ['bash', long + long], ['custom-message', long], ['label', long], ['name', long], ['compact', long], ['branch', long]]) {
      await panel.getByTestId(`history-entry-${entryId}`).click(); await expect(panel.getByTestId('history-text')).toBeVisible();
      while (await panel.getByRole('button', { name: 'More text' }).count()) {
        await panel.getByRole('button', { name: 'More text' }).click();
        await expect(panel.getByText('Loading entry…', { exact: true })).toHaveCount(0);
      }
      await expect(panel.getByTestId('history-text')).toHaveText(text!);
    }
    await expect(panel).not.toContainText('PRIVATE-HISTORY');
    const commands = await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate').commands);
    expect(commands.filter((command: { type: string }) => ['submit_session_input', 'start_run', 'branch_session', 'fork_session', 'update_workspace'].includes(command.type))).toEqual([]);

    await test.info().attach('complete-history-tree', { body: await panel.screenshot(), contentType: 'image/png' });
    await test.info().attach('actual-history-read-commands', { body: Buffer.from(JSON.stringify(commands)), contentType: 'application/json' });
  } catch (error) { failure = error as Error; throw error; }
  finally { await f.app.evaluate(() => Reflect.get(globalThis, 'historyGate')?.restore()).catch(() => {}); await closeDesktopFixture(f.app, f.userData, failure); }
  const db = new Database(join(f.userData, 'data/app.sqlite'), { readonly: true });
  try { expect(createHash('sha256').update(JSON.stringify(db.query('SELECT * FROM session_native_entries ORDER BY sequence').all())).digest('hex')).toBe(f.seed.entriesHash);
    expect(db.query('SELECT COUNT(*) count FROM runs').get()).toEqual({ count: 0 }); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); } finally { db.close(); }
});

test('P9 T08 returns explicit safe fork save failure revocation and tombstone feedback through public IPC', async () => {
  const f = await treeFixture(); let failure: Error | undefined, active = f.app, page = f.page;
  let activeChild = active.process();
  const launch = async () => {
    active = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
      env: { ...environment(), FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: f.userData }, timeout: 30_000 });
    activeChild = active.process();
    page = await active.firstWindow(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
  };
  try {
    const history = await page.evaluate(id => window.flowmate.querySessionHistory({ sessionId: id }), f.seed.sessionId); if (!history.ok) throw new Error(history.error.code);
    const input = { sourceSessionId: f.seed.sessionId, expected: history.data.commit, targetEntryId: 'user', title: 'Failure child', clientOperationId: '00e651b8-0065-4f94-9666-f8d40f3d0577' };
    await closeDesktopFixture(active, f.userData);
    let db = new Database(join(f.userData, 'data/app.sqlite'));
    try { db.query("CREATE TRIGGER reject_t08_fork BEFORE INSERT ON session_forks BEGIN SELECT RAISE(ABORT,'PRIVATE-HISTORY storage fault'); END;").run(); } finally { db.close(); }
    await launch();
    expect(await page.evaluate(input => window.flowmate.forkSession(input), input)).toMatchObject({ ok: false, error: { code: 'storage_write_failed', message: 'History could not be saved. Check the saved history before continuing.' } });
    await closeDesktopFixture(active, f.userData);
    db = new Database(join(f.userData, 'data/app.sqlite'));
    try { db.query('DROP TRIGGER reject_t08_fork').run(); expect(db.query('SELECT COUNT(*) count FROM sessions').get()).toEqual({ count: 1 }); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); } finally { db.close(); }
    await launch();
    const created = await page.evaluate(input => window.flowmate.forkSession(input), input); if (!created.ok) throw new Error(created.error.code);
    expect(await page.evaluate(id => window.flowmate.deleteSession(id), created.data.session.sessionId)).toMatchObject({ ok: true });
    expect(await page.evaluate(input => window.flowmate.forkSession(input), input)).toMatchObject({ ok: false, error: { code: 'session_history_unavailable', message: 'The original fork target was deleted.' } });
    await closeDesktopFixture(active, f.userData);
    db = new Database(join(f.userData, 'data/app.sqlite'));
    try { db.query('UPDATE sessions SET metadata_json=? WHERE id=?').run(JSON.stringify({ version: 1, model_use_blocked: { reason: 'document_use_revoked', documentIds: [1], at: '2026-10-04T00:00:00.000Z' } }), f.seed.sessionId); } finally { db.close(); }
    await launch();
    expect(await page.evaluate(input => window.flowmate.forkSession(input), { ...input, clientOperationId: 'b26ed92e-c40f-4c6c-894e-e261a578df9c' })).toMatchObject({ ok: false, error: { code: 'session_scope_revoked', message: 'The source chat is no longer authorized.' } });
  } catch (error) { failure = error as Error; throw error; }
  finally { if (activeChild.exitCode === null && activeChild.signalCode === null) await closeDesktopFixture(active, f.userData, failure); }
  const db = new Database(join(f.userData, 'data/app.sqlite'), { readonly: true });
  try { expect(db.query('SELECT COUNT(*) count FROM runs').get()).toEqual({ count: 0 }); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]); } finally { db.close(); }
});
