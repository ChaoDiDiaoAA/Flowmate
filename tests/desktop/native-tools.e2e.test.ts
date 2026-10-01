import { _electron as electron } from 'playwright';
import { expect, test as it } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupResources, closeDesktopFixture, createHttpProvider, Database, mkdtemp, waitFor } from '../support/resources.ts';

it.setTimeout(60_000);
it.afterEach(cleanupResources);

type ToolCall = { name: string; args: unknown; id: string };
function streamResponse(text: string | ToolCall): Response {
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'desktop-native', object: 'chat.completion.chunk', created: 1,
    model: 'desktop-native-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const delta = typeof text === 'string' ? { role: 'assistant', content: text } : { role: 'assistant', tool_calls: [
    { index: 0, id: text.id, type: 'function', function: { name: text.name, arguments: JSON.stringify(text.args) } },
  ] };
  return new Response(`${chunk(delta, null)}${chunk({}, typeof text === 'string' ? 'stop' : 'tool_calls')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}

it('ordinary desktop Send executes SDK tools, freezes each Run directory, restores history and confirms Stop', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-desktop-native-'));
  const directoryA = join(userData, 'selected-a');
  const directoryB = join(userData, 'selected-b');
  mkdirSync(directoryA); mkdirSync(directoryB);
  writeFileSync(join(directoryB, 'seed.txt'), 'SECOND_DIRECTORY');
  const calls: ToolCall[] = [
    { name: 'write', id: 'native-write', args: { path: 'created.txt', content: 'BEFORE_EDIT' } },
    { name: 'read', id: 'native-read', args: { path: 'created.txt' } },
    { name: 'edit', id: 'native-edit', args: { path: 'created.txt', edits: [{ oldText: 'BEFORE_EDIT', newText: 'AFTER_EDIT' }] } },
    { name: 'ls', id: 'native-ls', args: { path: '.' } },
    { name: 'find', id: 'native-find', args: { pattern: '*.txt', path: '.' } },
    { name: 'grep', id: 'native-grep', args: { pattern: 'AFTER_EDIT', path: '.', glob: '*.txt' } },
    { name: 'bash', id: 'native-bash', args: { command: "printf 'BASH_NATIVE_OK'" } },
    { name: 'powershell', id: 'native-powershell', args: { command: "Write-Output 'POWERSHELL_NATIVE_OK'" } },
  ];
  type Body = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
  const requests: Body[] = [];
  const server = await createHttpProvider(async request => {
    const body = await request.json() as Body; requests.push(body);
    const user = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content);
    const results = body.messages.filter(message => message.role === 'tool');
    if (user.includes('NATIVE_STOP')) return streamResponse({ name: 'powershell', id: 'native-stop',
      args: { command: "Set-Content -LiteralPath 'started.txt' -Value 'started'; Start-Sleep -Seconds 60; Set-Content -LiteralPath 'late.txt' -Value 'late'" } });
    if (user.includes('NATIVE_SECOND')) {
      if (!results.some(message => message.tool_call_id === 'native-second-read'))
        return streamResponse({ name: 'read', id: 'native-second-read', args: { path: 'seed.txt' } });
      return streamResponse('Second directory verified.');
    }
    const next = calls.find(call => !results.some(message => message.tool_call_id === call.id));
    return streamResponse(next ?? 'Native tools completed.');
  });
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[name]) env[name] = process.env[name]!;
  // Use installed Git Bash on this test's PATH; Pi itself still discovers and runs the shell.
  let git: string | null = null;
  try { git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean) ?? null; }
  catch { /* An absent installed Git leaves Pi's ordinary shell availability check intact. */ }
  const gitBin = git && resolve(dirname(git), '..', 'bin');
  if (gitBin && existsSync(join(gitBin, 'bash.exe'))) {
    const pathKey = env.PATH ? 'PATH' : 'Path';
    env[pathKey] = gitBin + delimiter + (env[pathKey] ?? '');
  }
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null;
  let failure: Error | undefined;
  let checkpoint = 'launch';
  try {
    app = await electron.launch({ args: [resolve(import.meta.dirname, '../../out/main/index.js')], env, timeout: 30_000 });
    const page = await app.firstWindow();
    checkpoint = 'ready invoice view and directory tools';
    const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
    await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor({ timeout: 20_000 });
    await nav.getByRole('button', { name: 'Chats', exact: true }).click();
    const before = await page.evaluate(() => window.flowmate.readWorkspace());
    expect(await page.getByRole('button', { name: 'New local task', exact: true }).count()).toBe(0);
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directoryA);
    await page.getByRole('button', { name: 'Choose directory', exact: true }).click();
    await page.waitForFunction(directory => (document.querySelector('.run-tools-panel input') as HTMLInputElement)?.value === directory, directoryA);
    await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
    await page.getByLabel('Native tool availability').getByText('powershell', { exact: true }).waitFor();
    expect(await page.evaluate(() => window.flowmate.readWorkspace())).toEqual(before);
    expect(await page.evaluate(() => window.flowmate.listSessions())).toMatchObject({ ok: true, data: { items: [] } });
    expect(requests).toHaveLength(0);
    const saved = await page.evaluate(async port => {
      const state = await window.flowmate.getState(); if (!state.ok) return state;
      return window.flowmate.saveSettings({ ...state.data.settings, models: [{ id: 'native-model', credentialRef: 'desktop_native_credential',
        name: 'Native fixture', kind: 'custom', providerId: null, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'desktop-native-model',
        api: 'openai-completions', contextWindow: 64_000, maxTokens: 16_384, reasoning: false }], defaultModelId: 'native-model' },
        { modelId: 'native-model', apiKey: 'synthetic-desktop-native-key' });
    }, server.port);
    expect(saved.ok).toBe(true); expect(requests).toHaveLength(0);
    checkpoint = 'native tool sequence';
    await page.getByRole('textbox', { name: 'Message to model' }).fill('NATIVE_ALL');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Native tools completed.', { exact: true }).waitFor({ timeout: 25_000 });
    expect(readFileSync(join(directoryA, 'created.txt'), 'utf8')).toBe('AFTER_EDIT');
    const results = requests.at(-1)!.messages.filter(message => message.role === 'tool');
    expect(results.map(message => message.tool_call_id)).toEqual(calls.map(call => call.id));
    for (const [id, evidence] of [['native-read', 'BEFORE_EDIT'], ['native-find', 'created.txt'], ['native-grep', 'AFTER_EDIT'],
      ['native-bash', 'BASH_NATIVE_OK'], ['native-powershell', 'POWERSHELL_NATIVE_OK']])
      expect(JSON.stringify(results.find(message => message.tool_call_id === id)?.content)).toContain(evidence);
    const sessions = await page.evaluate(() => window.flowmate.listSessions());
    if (!sessions.ok) throw new Error('Sessions unavailable');
    const sessionId = sessions.data.items[0]!.sessionId;
    expect(sessions.data.items).toHaveLength(1);
    expect(sessions.data.items[0]).not.toHaveProperty('toolProfile');
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directoryB);
    await page.getByRole('button', { name: 'Choose directory', exact: true }).click();
    await page.waitForFunction(directory => (document.querySelector('.run-tools-panel input') as HTMLInputElement)?.value === directory, directoryB);
    expect(requests).toHaveLength(9);
    checkpoint = 'second Run directory and restored history';
    await page.getByRole('textbox', { name: 'Message to model' }).fill('NATIVE_SECOND');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Second directory verified.', { exact: true }).waitFor({ timeout: 15_000 });
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('SECOND_DIRECTORY');
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('Native tools completed.');
    const requestCount = requests.length;
    await page.reload();
    await nav.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByText('Second directory verified.', { exact: true }).waitFor();
    expect(requests).toHaveLength(requestCount);
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directoryB);
    await page.getByRole('button', { name: 'Choose directory', exact: true }).click();
    await page.waitForFunction(directory => (document.querySelector('.run-tools-panel input') as HTMLInputElement)?.value === directory, directoryB);
    await page.getByRole('textbox', { name: 'Message to model' }).fill('NATIVE_STOP');
    checkpoint = 'real native Stop confirmation';
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    for (let attempt = 0; !existsSync(join(directoryB, 'started.txt')) && attempt < 100; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 100));
    expect(existsSync(join(directoryB, 'started.txt'))).toBe(true);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitFor(() => page.evaluate(async () => { const value = await window.flowmate.queryRuntimeState(); return value.ok && value.data.active === null && !value.data.blocked; }), 15_000);
    expect(existsSync(join(directoryB, 'late.txt'))).toBe(false);
    checkpoint = 'unusable Conversations row after confirmed Stop';
    const stoppedSession = await page.evaluate(id => window.flowmate.querySession(id), sessionId);
    if (!stoppedSession.ok || stoppedSession.data.availability !== 'unusable') throw new Error('The stopped fixture Session must be unusable.');
    await page.reload();
    await nav.getByRole('button', { name: 'Chats', exact: true }).click();
    const stoppedRow = page.locator(`.chat-directory-row[data-session-id="${sessionId}"] small`);
    await stoppedRow.waitFor({ state: 'visible' });
    expect(await stoppedRow.textContent()).toContain('Cannot continue');
    checkpoint = 'normal desktop close after confirmed Stop';
    await closeDesktopFixture(app, userData); app = null;
    checkpoint = 'persisted Run and tool facts';
    const db = new Database(join(userData, 'data', 'app.sqlite'), { readonly: true });
    try {
      const rows = db.query('SELECT status,job_id,scope_json,config_json FROM runs WHERE session_id=? ORDER BY id').all(sessionId) as Array<{ status: string; job_id: number | null; scope_json: string; config_json: string }>;
      expect(rows.map(row => row.status)).toEqual(['completed', 'completed', 'cancelled']);
      expect(rows.every(row => row.job_id === null)).toBe(true);
      expect(rows.map(row => JSON.parse(row.config_json).workingDirectory)).toEqual([directoryA, directoryB, directoryB]);
      for (const row of rows) {
        const scope = JSON.parse(row.scope_json);
        expect(scope.version).toBe(2); expect(scope).not.toHaveProperty('commandAccess'); expect(scope).not.toHaveProperty('allowedWritePaths');
      }
      expect(db.query('SELECT count(*) AS count FROM jobs').get()).toEqual({ count: 0 });
      expect(db.query('SELECT tool_name AS name,status FROM tool_calls ORDER BY id').all()).toEqual([
        ...calls.map(call => ({ name: call.name, status: 'succeeded' })), { name: 'read', status: 'succeeded' }, { name: 'powershell', status: 'cancelled' },
      ]);
    } finally { db.close(); }
  } catch (error) {
    failure = new Error(`Native tools checkpoint ${checkpoint}`, { cause: error });
    throw failure;
  } finally {
    try { if (app) await closeDesktopFixture(app, userData, failure); }
    finally { await server.stop(true); }
  }
});
