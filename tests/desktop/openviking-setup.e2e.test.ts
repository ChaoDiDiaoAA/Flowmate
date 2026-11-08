import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { cleanupResources, closeDesktopFixture, createHttpProvider, deferCleanup, mkdtemp } from '../support/resources.ts';

test.afterEach(cleanupResources);
test.skip(process.platform !== 'win32', 'The secure desktop credential store uses Windows DPAPI.');

test('P/A/S management connects by a verified role and checks a lost mutation after restart', async () => {
  test.setTimeout(90000);
  const root = process.env.FLOWMATE_E2E_ROOT ?? resolve(import.meta.dirname, '../..');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-openviking-management-'));
  const inputDir = await mkdtemp(join(tmpdir(), 'flowmate-openviking-management-input-'));
  const key = 'synthetic-management-account-secret';
  let creates = 0;
  const server = await createHttpProvider(request => {
    const url = new URL(request.url);
    const credential = request.headers.get('x-api-key');
    const role = credential === key ? 'admin' : credential === 'synthetic-p' ? 'user' : credential === 'synthetic-s' ? 'root' : null;
    if (!role) return new Response('denied', { status: 401 });
    if (url.pathname === '/health') return Response.json({ status: 'ok', auth_mode: 'api_key', version: '0.4.23', role, account_id: 'account', user_id: 'alice' });
    if (role === 'admin' && url.pathname === '/api/v1/admin/accounts/account/groups') {
      if (request.method === 'POST') {
        creates++;
        return new Response('lost response', { status: 503 });
      }
      return Response.json({ status: 'ok', result: creates ? [{ group_id: 'isolated-test' }] : [] });
    }
    return new Response('not expected', { status: 403 });
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const files = {
    A: { role: 'A', endpoint, accountId: 'account', userId: 'alice', apiKey: key },
    P: { role: 'P', endpoint, accountId: 'account', userId: 'alice', peerId: 'flowmate', apiKey: 'synthetic-p' },
    S: { role: 'S', endpoint, apiKey: 'synthetic-s' },
  };
  for (const [role, file] of Object.entries(files)) writeFileSync(join(inputDir, role + '.json'), JSON.stringify(file));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'FLOWMATE_BUN_EXECUTABLE'])
    if (process.env[name]) env[name] = process.env[name]!;
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
      args: [join(root, 'out/main/index.js')], env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData } });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const panel = page.locator('details').filter({ has: page.getByText('OpenViking management', { exact: true }) });
    await panel.locator('summary').click();
    return panel;
  };
  const choose = async (role: keyof typeof files) => {
    await app!.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, join(inputDir, role + '.json'));
  };
  try {
    let panel = await launch();
    await choose('P');
    await panel.getByRole('button', { name: 'Select management identity' }).click();
    await expect(panel.getByRole('option', { name: 'ListPage', exact: true })).toHaveCount(1);
    await expect(panel.getByRole('option', { name: 'AdminCreateGroup', exact: true })).toHaveCount(0);
    await choose('S');
    await panel.getByRole('button', { name: 'Select management identity' }).click();
    await expect(panel.getByRole('option', { name: 'AdminListAccounts', exact: true })).toHaveCount(1);
    await expect(panel.getByRole('option', { name: 'AdminCreateGroup', exact: true })).toHaveCount(0);
    await choose('A');
    await panel.getByRole('button', { name: 'Select management identity' }).click();
    await panel.getByRole('combobox').selectOption('AdminCreateGroup');
    await panel.getByLabel('Parameters and options (JSON)').fill('{"groupId":"isolated-test"}');
    await panel.getByRole('button', { name: 'Review change' }).click();
    await expect(panel.getByText(/AdminCreateGroup.*unknown/)).toBeVisible();
    expect(creates).toBe(1);
    await expect(panel).not.toContainText(key);
    const receipt = join(userData, 'security', 'openviking-management', String(server.port), 'A', 'id-account', 'id-alice', 'receipt.json');
    expect(readFileSync(receipt, 'utf8')).not.toContain('isolated-test');
    await closeDesktopFixture(app!, userData);
    app = undefined;
    panel = await launch();
    await choose('A');
    await panel.getByRole('button', { name: 'Select management identity' }).click();
    await panel.getByRole('button', { name: 'Check original target' }).click();
    await expect(panel.getByText(/AdminCreateGroup.*verified/)).toBeVisible();
    expect(creates).toBe(1);
  } finally {
    if (app) await closeDesktopFixture(app, userData);
    await server.stop();
  }
});

test('the desktop recovers a lost local memory configuration receipt without exposing the user key', async ({}, testInfo) => {
  test.setTimeout(90000);
  const root = process.env.FLOWMATE_E2E_ROOT ?? resolve(import.meta.dirname, '../..');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-memory-desktop-'));
  const inputDir = await mkdtemp(join(tmpdir(), 'flowmate-memory-input-')), input = join(inputDir, 'connection.json');
  const key = 'synthetic-memory-desktop-secret';
  const server = await createHttpProvider(request => new URL(request.url).pathname === '/health'
    && request.headers.get('x-api-key') === key ? Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key',
      role: 'user', account_id: 'account', user_id: 'alice' }) : new Response('unavailable', { status: 404 }));
  writeFileSync(input, JSON.stringify({ endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice',
    peerId: 'flowmate.alice.agent', apiKey: key, recallEnabled: true, captureMode: 'explicit' }));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  if (process.env.FLOWMATE_BUN_EXECUTABLE) env.FLOWMATE_BUN_EXECUTABLE = process.env.FLOWMATE_BUN_EXECUTABLE;
  const launch = async () => {
    const app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
      args: [join(root, 'out/main/index.js')], env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30000 });
    const page = await app.firstWindow();
    await expect.poll(async () => { const state = await page.evaluate(() => window.flowmate.getState()); return state.ok && state.data.ready; }).toBe(true);
    return { app, page };
  };
  let app: ElectronApplication | undefined, failure: Error | undefined;
  try {
    let opened = await launch(); app = opened.app;
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, input);
    await app.evaluate(() => {
      const handles = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles();
      const child = handles.find(value => value && typeof value === 'object' && 'spawnargs' in value && Array.isArray(value.spawnargs)
        && value.spawnargs.some(arg => typeof arg === 'string' && /apps[\\/]host[\\/]main\.ts$/.test(arg))) as import('node:child_process').ChildProcessWithoutNullStreams | undefined;
      if (!child) throw Error('Controlled Host was not found.');
      const write = child.stdin.write, emit = child.stdout.emit; let requestId: string | null = null, buffer = Buffer.alloc(0);
      child.stdin.write = function (this: NodeJS.WritableStream, ...args: Parameters<typeof write>) {
        try { const packet = JSON.parse(String(args[0])); if (packet.type === 'memory_configure') requestId = packet.requestId; }
        catch { /* The gate keeps no credential or request body. */ }
        return Reflect.apply(write, this, args);
      } as typeof write;
      child.stdout.emit = function (event: string | symbol, ...args: unknown[]) {
        if (event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
        buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
        for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
          const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
          try { const packet = JSON.parse(line.toString()); if (packet.type === 'response' && packet.requestId === requestId) continue; }
          catch { /* Forward original invalid bytes. */ }
          forward.push(line);
        }
        return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
      };
      Reflect.set(globalThis, 'localMemoryReceiptGate', { restore() { child.stdin.write = write; child.stdout.emit = emit;
        if (buffer.length) Reflect.apply(emit, child.stdout, ['data', buffer]); } });
    });
    await opened.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await opened.page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const panel = opened.page.getByRole('region', { name: 'Long-term memory' });
    await panel.getByRole('button', { name: 'Connect OpenViking from file' }).click();
    await expect(panel.getByRole('alert')).toContainText('could not be confirmed', { timeout: 45000 });
    await expect(panel).not.toContainText(key);
    const pending = join(userData, 'data/desktop-memory-request.json');
    expect(existsSync(pending)).toBe(true); expect(readFileSync(pending, 'utf8')).not.toContain(key);
    const configured = await opened.page.evaluate(() => window.flowmate.memory.getSettings());
    expect(configured).toMatchObject({ ok: true, data: { settings: { provider: 'openviking', recallEnabled: true }, identity: { userId: 'alice' } } });
    expect(JSON.stringify(configured)).not.toContain(key);
    const directory = join(userData, 'security/memory-credentials'), files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(directory, files[0]!), 'utf8')).not.toContain(key);
    await app.evaluate(() => Reflect.get(globalThis, 'localMemoryReceiptGate').restore());
    await closeDesktopFixture(app, userData); app = undefined;
    opened = await launch(); app = opened.app;
    expect(await opened.page.evaluate(() => window.flowmate.memory.getSettings())).toMatchObject({ ok: true,
      data: { settings: { provider: 'openviking', revision: 1 }, identity: { accountId: 'account', userId: 'alice' } } });
    await opened.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await opened.page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const reopenedPanel = opened.page.getByRole('region', { name: 'Long-term memory' });
    await reopenedPanel.getByRole('button', { name: 'Connect OpenViking from file' }).click();
    await expect(reopenedPanel).toContainText('The local connection was saved.');
    await expect(reopenedPanel).toContainText('account account, user alice');
    expect(existsSync(pending)).toBe(false); expect(readdirSync(directory)).toEqual(files);
    await reopenedPanel.screenshot({ path: testInfo.outputPath('memory-settings.png') });
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { if (app) { await app.evaluate(() => Reflect.get(globalThis, 'localMemoryReceiptGate')?.restore()).catch(() => {});
    await closeDesktopFixture(app, userData, failure); } await server.stop(); }
});

test('the desktop recovers a lost service memory configuration receipt after reconnecting', async () => {
  test.setTimeout(120000);
  const source = resolve(import.meta.dirname, '../..'), root = process.env.FLOWMATE_E2E_ROOT ?? source;
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  const fixture = spawn(process.env.FLOWMATE_BUN_EXECUTABLE ?? 'bun', ['--no-env-file', join(source, 'tests/desktop/service-mode-fixture.ts'), 'enabled'],
    { cwd: source, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let installation: { dataRoot: string; installationId: string } | undefined, stderr = '';
  const lines = createInterface({ input: fixture.stdout }), exited = once(fixture, 'close');
  fixture.stderr.on('data', value => { stderr += String(value); });
  lines.on('line', line => { try { const value = JSON.parse(line); if (value.type === 'ready') installation = value.installation; } catch { /* Ignore non-protocol output. */ } });
  deferCleanup(async () => { if (fixture.exitCode === null && fixture.signalCode === null) fixture.stdin.end('close\n');
    const [code] = await exited; lines.close(); if (code !== 0) throw Error('Controlled service fixture failed.'); });
  await expect.poll(() => { if (fixture.exitCode !== null) throw Error(stderr || 'Controlled service fixture exited.'); return !!installation; }, { timeout: 60000 }).toBe(true);
  if (!installation) throw Error('Missing controlled service installation.');
  const userData = installation.dataRoot, inputDir = await mkdtemp(join(tmpdir(), 'flowmate-memory-service-input-')),
    input = join(inputDir, 'connection.json'), key = 'synthetic-memory-service-secret';
  const server = await createHttpProvider(request => new URL(request.url).pathname === '/health' && request.headers.get('x-api-key') === key
    ? Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key', role: 'user', account_id: 'account', user_id: 'alice' })
    : new Response('unavailable', { status: 404 }));
  writeFileSync(input, JSON.stringify({ endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice',
    peerId: 'flowmate.alice.agent', apiKey: key, recallEnabled: true, captureMode: 'explicit' }));
  const launch = async () => {
    const app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'out/main/index.js')],
      env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30000 });
    const page = await app.firstWindow();
    await expect.poll(async () => { const state = await page.evaluate(() => window.flowmate.getState()); return state.ok && state.data.ready; }).toBe(true);
    return { app, page };
  };
  let app: ElectronApplication | undefined, failure: Error | undefined;
  try {
    let opened = await launch(); app = opened.app;
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }, input);
    await app.evaluate(() => {
      const { Socket } = process.getBuiltinModule('node:net') as typeof import('node:net');
      const emit = Socket.prototype.emit, write = Socket.prototype.write;
      let target: import('node:net').Socket | null = null, requestId: string | null = null, buffer = Buffer.alloc(0);
      Socket.prototype.write = function (this: import('node:net').Socket, ...args: Parameters<typeof write>) {
        try { const packet = JSON.parse(String(args[0])); if (packet.type === 'service_memory_configure') { target = this; requestId = packet.requestId; } }
        catch { /* The gate keeps no credential or request body. */ }
        return Reflect.apply(write, this, args);
      } as typeof write;
      Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
        if (this !== target || event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
        buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
        for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
          const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
          try { const packet = JSON.parse(line.toString()); if (packet.type === 'response' && packet.requestId === requestId) continue; }
          catch { /* Forward original invalid bytes. */ }
          forward.push(line);
        }
        return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
      };
      Reflect.set(globalThis, 'memoryReceiptGate', { restore() { Socket.prototype.emit = emit; Socket.prototype.write = write;
        if (target && buffer.length) Reflect.apply(emit, target, ['data', buffer]); } });
    });
    await opened.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await opened.page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const panel = opened.page.getByRole('region', { name: 'Long-term memory' });
    await panel.getByRole('button', { name: 'Connect OpenViking from file' }).click();
    await expect(panel.getByRole('alert')).toContainText('could not be confirmed', { timeout: 45000 });
    const pending = join(userData, 'data/desktop-service-memory-request.json');
    expect(existsSync(pending)).toBe(true); expect(readFileSync(pending, 'utf8')).not.toContain(key);
    const directory = join(userData, 'security/service-memory-credentials');
    const files = readdirSync(directory).filter(name => name.startsWith('memory_') && name.endsWith('.json'));
    expect(files).toHaveLength(1); expect(readFileSync(join(directory, files[0]!), 'utf8')).not.toContain(key);
    await app.evaluate(() => Reflect.get(globalThis, 'memoryReceiptGate').restore());
    await closeDesktopFixture(app, userData); app = undefined;
    expect(fixture.exitCode).toBeNull();
    opened = await launch(); app = opened.app;
    expect(await opened.page.evaluate(() => window.flowmate.memory.getSettings())).toMatchObject({ ok: true,
      data: { settings: { provider: 'openviking', revision: 1 }, identity: { userId: 'alice' } } });
    await opened.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await opened.page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const reopenedPanel = opened.page.getByRole('region', { name: 'Long-term memory' });
    await reopenedPanel.getByRole('button', { name: 'Connect OpenViking from file' }).click();
    await expect(reopenedPanel).toContainText('The local connection was saved.');
    expect(existsSync(pending)).toBe(false);
    expect(readdirSync(directory).filter(name => name.startsWith('memory_') && name.endsWith('.json'))).toEqual(files);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { if (app) { await app.evaluate(() => Reflect.get(globalThis, 'memoryReceiptGate')?.restore()).catch(() => {});
    await closeDesktopFixture(app, userData, failure); } await server.stop(); }
});

test('the desktop searches an authorized memory through its original chat input', async () => {
  test.setTimeout(90000);
  const root = process.env.FLOWMATE_E2E_ROOT ?? resolve(import.meta.dirname, '../..');
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-memory-search-ui-'));
  const inputDir = await mkdtemp(join(tmpdir(), 'flowmate-memory-search-input-')), file = join(inputDir, 'connection.json');
  const key = 'synthetic-memory-search-key'; let uri = '', content = '', searches = 0;
  const session = (id: string) => ({ session_id: id, uri: `viking://user/alice/sessions/${id}`,
    user: { account_id: 'account', user_id: 'alice' }, auto_commit_policy: null });
  const memory = await createHttpProvider(async request => {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/health') return Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key',
      role: 'user', account_id: 'account', user_id: 'alice' });
    if (path === '/api/v1/sessions' && request.method === 'POST') return Response.json({ status: 'ok', result: session((await request.json() as { session_id: string }).session_id) });
    if (path.startsWith('/api/v1/sessions/') && request.method === 'GET') return Response.json({ status: 'ok', result: session(path.split('/').at(-1)!) });
    if (path === '/api/v1/content/write') { const body = await request.json() as { uri: string; content: string }; uri = body.uri; content = body.content;
      return Response.json({ status: 'ok', result: { uri, mode: 'create', context_type: 'memory', content_updated: true, vector_status: 'complete' } }); }
    if (path === '/api/v1/content/read') return Response.json({ status: 'ok', result: content });
    if (path === '/api/v1/search/find') { searches++; return Response.json({ status: 'ok', result: { memories: [
      { uri }, { uri: 'viking://user/alice/memories/unapproved.md', abstract: 'Unapproved memory.' }] } }); }
    return new Response('unavailable', { status: 404 });
  });
  const model = await createHttpProvider(() => {
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'memory-search-answer',
      choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'Controlled answer.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'memory-search-response' } });
  });
  writeFileSync(file, JSON.stringify({ endpoint: `http://127.0.0.1:${memory.port}`, accountId: 'account', userId: 'alice',
    peerId: 'flowmate.alice.agent', apiKey: key, recallEnabled: false, captureMode: 'explicit' }));
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  if (process.env.FLOWMATE_BUN_EXECUTABLE) env.FLOWMATE_BUN_EXECUTABLE = process.env.FLOWMATE_BUN_EXECUTABLE;
  let app: ElectronApplication | undefined, failure: Error | undefined;
  try {
    app = await electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [join(root, 'out/main/index.js')],
      env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData }, timeout: 30000 });
    const page = await app.firstWindow();
    await expect.poll(async () => { const value = await page.evaluate(() => window.flowmate.getState()); return value.ok && value.data.ready; }).toBe(true);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }, file);
    expect(await page.evaluate(() => window.flowmate.memory.configureFromFile())).toMatchObject({ ok: true, data: { cancelled: false } });
    const original = await page.evaluate(async baseUrl => {
      const state = await window.flowmate.getState(); if (!state.ok) throw Error(state.error.code);
      const settings = await window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'memory-search',
        credentialRef: '00000000000000000000000000000003', name: 'Memory search', kind: 'custom', providerId: null,
        baseUrl, model: 'memory-search', api: 'openai-completions', contextWindow: 64000, maxTokens: 4096, reasoning: false }],
        defaultModelId: 'memory-search' }, { modelId: 'memory-search', apiKey: 'synthetic-model-key' });
      if (!settings.ok) throw Error(settings.error.code);
      const chat = await window.flowmate.createSession({ title: 'Memory search chat' }); if (!chat.ok) throw Error(chat.error.code);
      const workspace = await window.flowmate.readWorkspace(); if (!workspace.ok) throw Error(workspace.error.code);
      const selected = await window.flowmate.updateWorkspace({ expectedRevision: workspace.data.revision,
        change: { kind: 'session', sessionId: chat.data.sessionId } }); if (!selected.ok) throw Error(selected.error.code);
      const run = await window.flowmate.submitInput({ sessionId: chat.data.sessionId, clientSequence: 1, mode: 'prompt',
        text: 'Original search input.', modelId: 'memory-search' }); if (!run.ok) throw Error(run.error.code);
      return { sessionId: chat.data.sessionId, inputId: run.data.inputId };
    }, `http://127.0.0.1:${model.port}/v1`);
    await expect.poll(() => page.evaluate(() => window.flowmate.queryRuntimeState())).toMatchObject({ ok: true, data: { active: null } });
    expect(await page.evaluate(source => window.flowmate.memory.remember({ requestId: 'desktop-search-remember', source: { kind: 'session', ...source },
      content: 'Keep invoice explanations concise.', scope: { kind: 'personal' }, confirmed: true }), original))
      .toMatchObject({ ok: true, data: { state: 'completed' } });
    await page.reload();
    await page.getByRole('button', { name: 'Invoices', exact: true }).click();
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Long-term memory' });
    await panel.getByText('Search authorized memories', { exact: true }).click();
    const searchPanel = panel.locator('details').filter({ hasText: 'Search authorized memories' });
    await searchPanel.getByLabel('Search input').selectOption(String(original.inputId));
    await searchPanel.getByLabel('Search text').fill('invoice explanations');
    await searchPanel.getByRole('button', { name: 'Search memory', exact: true }).click();
    await expect(panel).toContainText('Keep invoice explanations concise.');
    await expect(panel).not.toContainText('Unapproved memory.');
    expect(searches).toBe(1);
  } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); throw failure; }
  finally { if (app) await closeDesktopFixture(app, userData, failure); await memory.stop(); await model.stop(); }
});
