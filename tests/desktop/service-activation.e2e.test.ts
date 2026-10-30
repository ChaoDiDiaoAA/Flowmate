import { _electron as electron, type Page } from 'playwright';
import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { cleanupResources, closeDesktopFixture, createHttpProvider, deferCleanup, installReadGate } from '../support/resources.ts';

test.afterEach(cleanupResources);
const root = resolve(import.meta.dirname, '../..');
function environment(userData = '') {
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
async function fixture() {
  const child = spawn(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', 'tests/desktop/service-activation-fixture.ts'],
    { cwd: root, env: environment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let ready: { installation: ServiceInstallation; proxy: string } | undefined, stderr = '';
  const messages: Array<{ type: string; pid?: number }> = [], lines = createInterface({ input: child.stdout }), exited = once(child, 'close');
  child.stderr.on('data', data => { stderr += String(data); });
  lines.on('line', line => { try { const packet = JSON.parse(line); messages.push(packet); if (packet.type === 'ready') ready = packet; } catch { /* No raw fixture output crosses into product state. */ } });
  deferCleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.stdin.end('close\n'); const [code] = await exited; lines.close(); if (code !== 0) throw Error('Activation fixture failed: ' + stderr); });
  await expect.poll(() => { if (child.exitCode !== null) throw Error(stderr || 'Activation fixture exited.'); return ready !== undefined; }, { timeout: 60000 }).toBe(true);
  return { ...ready!, child, messages };
}
async function launch(userData: string) {
  return electron.launch({ executablePath: resolve(root, 'node_modules/electron/dist/electron.exe'), args: [resolve(root, 'out/main/index.js')], env: environment(userData), timeout: 30000 });
}
async function hasLocalHost(app: Awaited<ReturnType<typeof launch>>) {
  return app.evaluate(() => (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles()
    .some(handle => handle && typeof handle === 'object' && 'spawnargs' in handle && Array.isArray(handle.spawnargs)
      && handle.spawnargs.some(arg => typeof arg === 'string' && /(?:apps[\\/]host[\\/]main\.ts|start-host\.js)$/.test(arg))));
}
async function interceptScm(app: Awaited<ReturnType<typeof electron.launch>>, fixture: { installation: ServiceInstallation; proxy: string }, manualWait = false) {
  await app.evaluate((_electron, input) => {
    const cp = process.getBuiltinModule('node:child_process') as typeof import('node:child_process');
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module') as typeof import('node:module');
    const spawn = cp.spawn, manager = input.manager;
    const commands: string[] = [], maintenance: string[] = [];
    const originalHost = (process as typeof process & { _getActiveHandles(): unknown[] })._getActiveHandles()
      .find((handle): handle is import('node:child_process').ChildProcess => Boolean(handle && typeof handle === 'object' && 'spawnargs' in handle && Array.isArray(handle.spawnargs)
        && handle.spawnargs.some(arg => typeof arg === 'string' && /(?:apps[\\/]host[\\/]main\.ts|start-host\.js)$/.test(arg))));
    cp.spawn = function (...args: Parameters<typeof spawn>) {
      const argv = Array.isArray(args[1]) ? args[1] : [];
      if (String(args[0]).endsWith('FlowmateRuntime.exe')) throw Error('Actual WinSW invocation is forbidden.');
      const maintenanceEntry = argv.indexOf(input.maintenance);
      if (maintenanceEntry >= 0) maintenance.push(String(argv[maintenanceEntry + 1]));
      if (argv.includes(manager)) {
        if (originalHost && originalHost.exitCode === null) throw Error('The original Host has not exited.');
        commands.push(String(argv[argv.indexOf(manager) + 1]));
        if (argv[argv.indexOf(manager) + 1] !== 'start') throw Error('Only the isolated start controller is available.');
        return Reflect.apply(spawn, cp, [args[0], ['--no-env-file', input.proxy, ...(input.manualWait ? ['--manual-wait'] : [])], args[2]]);
      }
      return Reflect.apply(spawn, cp, args);
    } as typeof spawn;
    syncBuiltinESMExports();
    Reflect.set(globalThis, 'activationScmGate', { commands, maintenance, restore() { cp.spawn = spawn; syncBuiltinESMExports(); } });
  }, { manager: join(fixture.installation.runtimeRoot, 'apps/service-manager.js'), maintenance: join(fixture.installation.runtimeRoot, 'apps/maintenance.js'), proxy: fixture.proxy, manualWait });
}

async function credentialResponseGate(app: Awaited<ReturnType<typeof launch>>, dropType: string | null) {
  await app.evaluate((_electron, dropType) => {
    const { Socket } = process.getBuiltinModule('node:net') as typeof import('node:net'), emit = Socket.prototype.emit, write = Socket.prototype.write;
    let target: import('node:net').Socket | null = null, requestId: string | null = null, buffer = Buffer.alloc(0);
    const requests: Array<{ type: string; operationId: string }> = [];
    Socket.prototype.write = function (this: import('node:net').Socket, ...args: Parameters<typeof write>) {
      try { const packet = JSON.parse(String(args[0])); if (packet.input?.operationId && String(packet.type).startsWith('service_')) {
        requests.push({ type: packet.type, operationId: packet.input.operationId });
        if (packet.type === dropType) { target = this; requestId = packet.requestId; }
      } } catch { /* This gate retains only original business IDs and message types. */ }
      return Reflect.apply(write, this, args);
    } as typeof write;
    Socket.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
      if (this !== target || event !== 'data' || !Buffer.isBuffer(args[0])) return Reflect.apply(emit, this, [event, ...args]);
      buffer = Buffer.concat([buffer, args[0]]); const forward: Buffer[] = [];
      for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
        const line = buffer.subarray(0, newline + 1); buffer = buffer.subarray(newline + 1);
        try { const packet = JSON.parse(line.toString()); if (packet.type === 'response' && packet.requestId === requestId) continue; }
        catch { /* Invalid original bytes still reach the production parser. */ }
        forward.push(line);
      }
      return forward.length ? Reflect.apply(emit, this, [event, Buffer.concat(forward), ...args.slice(1)]) : true;
    };
    Reflect.set(globalThis, 'activationResponseGate', { requests, restore() { Socket.prototype.emit = emit; Socket.prototype.write = write;
      if (target && buffer.length) Reflect.apply(emit, target, ['data', buffer]); buffer = Buffer.alloc(0); } });
  }, dropType);
}

test('a real activation backup failure retains the original database and pending operation without starting a service or fallback Host', async () => {
  test.setTimeout(180000); const f = await fixture(), userData = f.installation.dataRoot;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined;
  const database = () => {
    const read = spawnSync(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', '-e', `
      import {Database} from 'bun:sqlite';const file=JSON.parse(await Bun.stdin.text()).file;
      const db=new Database(file,{readonly:true,create:false});
      try{console.log(JSON.stringify({sessions:db.query('SELECT id,title,native_session_id FROM sessions ORDER BY id').all(),
        runs:db.query('SELECT count(*) n FROM runs').get().n}));}finally{db.close();}
    `], { cwd: root, input: JSON.stringify({ file: join(userData, 'data/app.sqlite') }), encoding: 'utf8', windowsHide: true });
    if (read.status !== 0) throw Error('Original database read failed: ' + read.stderr);
    return JSON.parse(read.stdout) as { sessions: Array<{ id: number; title: string; native_session_id: string | null }>; runs: number };
  };
  try {
    app = await launch(userData); let page = await app.firstWindow(); await interceptScm(app, f);
    const original = await page.evaluate(() => window.flowmate.createSession({ title: 'Original session before the real backup failure' }));
    if (!original.ok) throw Error(original.error.code);
    expect(await hasLocalHost(app)).toBe(true);
    expect(await page.evaluate(() => window.flowmate.backgroundService.prepare({}))).toMatchObject({ ok: true });
    const current = await page.evaluate(() => window.flowmate.getState()); if (!current.ok) throw Error(current.error.code);
    const input = { installationId: f.installation.installationId, operationId: randomUUID(), expectedSettingsRevision: current.data.settings.revision };
    const destination = join(userData, 'backups/service-activation-' + input.operationId);
    await app.evaluate((_electron, input) => {
      const cp = process.getBuiltinModule('node:child_process') as typeof import('node:child_process');
      const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
      const { syncBuiltinESMExports } = process.getBuiltinModule('node:module') as typeof import('node:module');
      const spawn = cp.spawn, observed = { launches: 0, code: null as number | null, signal: null as string | null, stdout: '' };
      cp.spawn = function (...args: Parameters<typeof spawn>) {
        const argv = Array.isArray(args[1]) ? args[1] : [];
        const backup = argv.includes(input.maintenance) && argv[argv.indexOf(input.maintenance) + 1] === 'backup';
        if (backup) {
          if (argv[argv.indexOf('--destination') + 1] !== input.destination) throw Error('Unexpected backup destination.');
          // A real destination collision reaches the unchanged maintenance producer and backupStore.
          fs.mkdirSync(input.destination); observed.launches++;
        }
        const child = Reflect.apply(spawn, cp, args);
        if (backup) { child.stdout?.on('data', bytes => { observed.stdout += String(bytes); });
          child.on('exit', (code, signal) => { observed.code = code; observed.signal = signal; }); }
        return child;
      } as typeof spawn;
      syncBuiltinESMExports();
      Reflect.set(globalThis, 'activationBackupObservation', { observed, restore() { cp.spawn = spawn; syncBuiltinESMExports(); } });
    }, { maintenance: join(f.installation.runtimeRoot, 'apps/maintenance.js'), destination });
    const enabled = await page.evaluate(input => window.flowmate.backgroundService.enable(input), input);
    expect(enabled).toMatchObject({ ok: true, data: { accepted: true, enabled: false, connected: false,
      backupId: null, credentialsPublished: null, active: null, error: { code: 'maintenance_backup_failed' } } });
    const observed = await app.evaluate(() => Reflect.get(globalThis, 'activationBackupObservation').observed);
    expect(observed).toMatchObject({ launches: 1, code: 1, signal: null });
    expect(JSON.parse(observed.stdout)).toMatchObject({ operation: 'backup',
      result: { ok: false, error: { code: 'maintenance_backup_failed' } } });
    expect(await hasLocalHost(app)).toBe(false);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual([]);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').maintenance)).toEqual(['prepare-service', 'backup']);
    expect(f.messages.filter(message => message.type === 'fixture_start')).toHaveLength(0);
    expect(existsSync(join(destination, 'manifest.json'))).toBe(false);
    const retained = database();
    expect(retained.sessions).toContainEqual({ id: original.data.sessionId, title: original.data.title,
      native_session_id: original.data.runtimeKind === 'agent_session' ? original.data.nativeSessionId : null });
    expect(retained.runs).toBe(0);
    const saved = JSON.parse(readFileSync(join(userData, 'service-installation.json'), 'utf8')) as ServiceInstallation;
    expect(saved).toMatchObject({ enabled: false, activationOperationId: input.operationId, activationSettingsRevision: input.expectedSettingsRevision });
    expect(await page.evaluate(() => window.flowmate.backgroundService.getServiceState())).toMatchObject({ ok: true, data: { state: 'blocked' } });
    await app.evaluate(() => { Reflect.get(globalThis, 'activationBackupObservation').restore(); Reflect.get(globalThis, 'activationScmGate').restore(); });
    await closeDesktopFixture(app, userData); app = null;
    app = await launch(userData); page = await app.firstWindow();
    expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input),
      { installationId: input.installationId, operationId: input.operationId })).toMatchObject({ ok: true,
      data: { accepted: true, enabled: false, connected: false, backupId: null, expectedSettingsRevision: input.expectedSettingsRevision } });
    expect(await page.evaluate(() => window.flowmate.restartHost())).toMatchObject({ ok: true, data: { ready: false } });
    expect(await hasLocalHost(app)).toBe(false);
    expect(database()).toEqual(retained);
    expect(f.messages.filter(message => message.type === 'fixture_start')).toHaveLength(0);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) {
    await app.evaluate(() => { Reflect.get(globalThis, 'activationBackupObservation')?.restore(); Reflect.get(globalThis, 'activationScmGate')?.restore(); }).catch(() => {});
    await closeDesktopFixture(app, userData, failure);
  } }
  if (failure) throw failure;
});

async function activationBeginGate(app: Awaited<ReturnType<typeof launch>>, userData: string) {
  await app.evaluate((_electron, file) => {
    const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module') as typeof import('node:module'), rename = fs.rename;
    let release!: () => void, entered = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    fs.rename = async (source, destination) => {
      if (String(destination) === file && String(source).startsWith(file + '.')) { entered = true; await waiting; }
      return rename(source, destination);
    };
    syncBuiltinESMExports();
    Reflect.set(globalThis, 'activationBeginGate', { get entered() { return entered; }, release,
      restore() { release(); fs.rename = rename; syncBuiltinESMExports(); } });
  }, join(userData, 'service-installation.json'));
}
async function configurationSave(page: Page, kind: 'product' | 'evaluation' | 'resources' | 'extensions') {
  return page.evaluate(async kind => {
    const current = await window.flowmate.getState(); if (!current.ok) return current;
    const settings = current.data.settings;
    if (kind === 'product') return window.flowmate.saveSettings({ ...settings, profile: { ...settings.profile, displayName: 'Concurrent product save' } });
    if (kind === 'evaluation') return window.flowmate.saveEvaluationSettings({ role: 'agent', expectedRevision: settings.revision,
      connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'concurrent-evaluation', api: 'openai-completions' }, apiKey: 'concurrent-evaluation-synthetic-key' });
    if (kind === 'resources') return window.flowmate.updateResourceSelection({ expectedRevision: settings.revision,
      selection: settings.resources ?? { prompt: null, enabledSkills: [] } });
    return window.flowmate.updateExtensionSelection({ expectedRevision: settings.revision, selection: settings.extensions ?? { enabledExtensions: [] } });
  }, kind);
}

test('explicit service activation closes the original Host, verifies one backup and migrates only original product credentials before live connection swap', async () => {
  test.setTimeout(180000); const f = await fixture(), userData = f.installation.dataRoot;
  let app: Awaited<ReturnType<typeof electron.launch>> | null = null, failure: Error | undefined, requests = 0;
  const provider = await createHttpProvider(async request => {
    expect(request.headers.get('authorization')).toBe('Bearer activation-original-synthetic-key'); await request.json(); requests++;
    return new Response('data: ' + JSON.stringify({ id: 'activation-local', object: 'chat.completion.chunk', created: 1, model: 'activation-local',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'The original configured credential is readable.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    app = await launch(userData);
    const page = await app.firstWindow(); await interceptScm(app, f);
    expect(await hasLocalHost(app)).toBe(true);
    expect(await page.evaluate(async baseUrl => { const current = await window.flowmate.getState(); if (!current.ok) return current;
      return window.flowmate.saveSettings({ ...current.data.settings, models: [{ id: 'activation-original', credentialRef: '00000000000000000000000000000095', name: 'Original activation profile', kind: 'custom', providerId: null,
        baseUrl, model: 'activation-local', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'activation-original' },
        { modelId: 'activation-original', apiKey: 'activation-original-synthetic-key' }); }, 'http://127.0.0.1:' + provider.port + '/v1')).toMatchObject({ ok: true });
    expect(await page.evaluate(async () => { const current = await window.flowmate.getState(); if (!current.ok) return current;
      return window.flowmate.saveEvaluationSettings({ role: 'agent', expectedRevision: current.data.settings.revision,
        connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'activation-eval-isolated', api: 'openai-completions' }, apiKey: 'activation-evaluation-only-key' }); })).toMatchObject({ ok: true });
    const before = await page.evaluate(() => window.flowmate.getState()); if (!before.ok) throw Error(before.error.code);
    const profile = before.data.settings.models[0]!, oldCiphertext = readFileSync(join(userData, 'security/credentials', profile.credentialRef + '.json'));
    const evaluationRef = before.data.settings.evaluation?.agent?.credentialRef; if (!evaluationRef) throw Error('Expected an isolated evaluation reference.');
    const evaluationCiphertext = readFileSync(join(userData, 'security/credentials', evaluationRef + '.json'));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByRole('button', { name: 'Prepare service', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enable background service', exact: true })).toBeEnabled();
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'activationScmGate').maintenance)).toEqual(['prepare-service']);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual([]); expect(requests).toBe(0);
    const operationId = randomUUID(), input = { installationId: f.installation.installationId, operationId, expectedSettingsRevision: before.data.settings.revision };
    const queried = await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input), { installationId: input.installationId, operationId });
    expect(queried).toMatchObject({ ok: true, data: { accepted: false, backupId: null, enabled: false, active: null } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual([]); expect(requests).toBe(0);
    const enabled = await page.evaluate(input => window.flowmate.backgroundService.enable(input), input);
    expect(enabled).toMatchObject({ ok: true, data: { installationId: input.installationId, operationId, accepted: true,
      credentialsPublished: true, enabled: true, connected: true, active: true, expectedSettingsRevision: input.expectedSettingsRevision, error: null } });
    if (!enabled.ok || !enabled.data.backupId) throw Error('Expected the original complete backup receipt.');
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual(['start']); expect(f.messages.filter(message => message.type === 'fixture_start')).toHaveLength(1);
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { ready: true, backgroundService: { state: 'ready' },
      settings: { models: [{ id: profile.id, credentialRef: profile.credentialRef }] }, modelCredentials: { 'activation-original': 'configured' } } });
    expect(readFileSync(join(userData, 'security/credentials', profile.credentialRef + '.json')).equals(oldCiphertext)).toBe(true);
    expect(existsSync(join(userData, 'security/service-credentials', profile.credentialRef + '.json'))).toBe(true);
    expect(readFileSync(join(userData, 'security/credentials', evaluationRef + '.json')).equals(evaluationCiphertext)).toBe(true);
    expect(existsSync(join(userData, 'security/service-credentials', evaluationRef + '.json'))).toBe(false);
    expect(await hasLocalHost(app)).toBe(false);
    const after = await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input), { installationId: input.installationId, operationId });
    expect(after).toMatchObject({ ok: true, data: { backupId: enabled.data.backupId, credentialsPublished: true, active: true } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual(['start']); expect(requests).toBe(0);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').maintenance)).toEqual(['prepare-service', 'backup', 'verify-backup']);
    expect(await page.evaluate(input => window.flowmate.backgroundService.enable(input), input)).toMatchObject({ ok: true,
      data: { operationId, backupId: enabled.data.backupId, enabled: true, connected: true, active: true, error: null } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').maintenance)).toEqual(['prepare-service', 'backup', 'verify-backup']);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual(['start']);
    const probe = await page.evaluate(() => window.flowmate.callProvider({ goal: 'Explicit isolated activation probe', text: 'Read the original configured model.', modelId: 'activation-original' }));
    if (!probe.ok) throw Error(probe.error.code);
    await expect.poll(() => page.evaluate(async runId => { const run = await window.flowmate.queryRun(runId); return run.ok && run.data.status === 'completed'; }, probe.data.runId)).toBe(true);
    expect(requests).toBe(1);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { if (app) { await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); } } finally { await provider.stop(); } }
  if (failure) throw failure;
});

test('manual service start waits without elevation and a restarted desktop continues the original operation and verified backup', async () => {
  test.setTimeout(180000); const f = await fixture(), userData = f.installation.dataRoot;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined;
  try {
    app = await launch(userData); let page = await app.firstWindow(); await interceptScm(app, f, true);
    expect(await page.evaluate(() => window.flowmate.backgroundService.prepare({}))).toMatchObject({ ok: true });
    const before = await page.evaluate(() => window.flowmate.getState()); if (!before.ok) throw Error(before.error.code);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByRole('button', { name: 'Enable background service', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.flowmate.backgroundService.getServiceState()), { timeout: 30000 }).toMatchObject({ ok: true,
      data: { state: 'blocked', error: { code: 'service_elevation_required' } } });
    const original = JSON.parse(readFileSync(join(userData, 'service-installation.json'), 'utf8')) as ServiceInstallation;
    if (!original.activationOperationId || original.activationSettingsRevision === null || original.activationSettingsRevision === undefined) throw Error('Expected the saved original operation and revision.');
    const input = { installationId: original.installationId, operationId: original.activationOperationId, expectedSettingsRevision: original.activationSettingsRevision };
    expect(input.expectedSettingsRevision).toBe(before.data.settings.revision);
    const first = await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input), { installationId: input.installationId, operationId: input.operationId });
    expect(first).toMatchObject({ ok: true, data: { accepted: true, enabled: false, connected: false, active: null, credentialsPublished: null } });
    if (!first.ok || !first.data.backupId) throw Error('Expected the original complete backup.');
    const manifestFile = join(userData, 'backups/service-activation-' + input.operationId, 'manifest.json'), manifest = readFileSync(manifestFile);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual(['start']);
    expect(f.messages.filter(message => message.type === 'fixture_start')).toHaveLength(0); expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(() => window.flowmate.restartHost())).toMatchObject({ ok: true, data: { ready: false } });
    expect(await hasLocalHost(app)).toBe(false);
    await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').restore()); await closeDesktopFixture(app, userData); app = null;
    app = await launch(userData); page = await app.firstWindow(); await interceptScm(app, f);
    expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(() => window.flowmate.backgroundService.getServiceState())).toMatchObject({ ok: true, data: {
      state: 'blocked', activationOperationId: input.operationId, activationSettingsRevision: input.expectedSettingsRevision } });
    expect(await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input), { installationId: input.installationId, operationId: input.operationId }))
      .toMatchObject({ ok: true, data: { accepted: true, backupId: first.data.backupId, active: null, credentialsPublished: null } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual([]);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').maintenance)).toEqual([]);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Performance', exact: true }).click();
    await page.getByRole('button', { name: 'Continue original activation', exact: true }).click();
    await expect(page.getByTestId('service-activation-facts')).toContainText('Background scheduling: active.', { timeout: 30000 });
    expect(await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input), { installationId: input.installationId, operationId: input.operationId }))
      .toMatchObject({ ok: true, data: { backupId: first.data.backupId, expectedSettingsRevision: input.expectedSettingsRevision, credentialsPublished: true,
        enabled: true, connected: true, active: true, error: null } });
    expect(readFileSync(manifestFile).equals(manifest)).toBe(true);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual(['start']);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').maintenance)).toEqual(['verify-backup']);
    expect(f.messages.filter(message => message.type === 'fixture_start')).toHaveLength(1);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) { await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); } }
  if (failure) throw failure;
});

test('a lost credential commit reply is queried after Main restarts without reading or republishing the old product secret', async () => {
  test.setTimeout(180000); const f = await fixture(), userData = f.installation.dataRoot;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined, credentialFile: string | null = null, originalCipher: Buffer | null = null;
  try {
    app = await launch(userData); let page = await app.firstWindow(); await interceptScm(app, f);
    expect(await page.evaluate(async () => { const current = await window.flowmate.getState(); if (!current.ok) return current;
      return window.flowmate.saveSettings({ ...current.data.settings, models: [{ id: 'activation-commit', credentialRef: '00000000000000000000000000000096', name: 'Original commit profile', kind: 'custom', providerId: null,
        baseUrl: 'http://127.0.0.1:1/v1', model: 'activation-commit', api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'activation-commit' },
        { modelId: 'activation-commit', apiKey: 'activation-commit-original-key' }); })).toMatchObject({ ok: true });
    const before = await page.evaluate(() => window.flowmate.getState()); if (!before.ok) throw Error(before.error.code);
    const profile = before.data.settings.models[0]!;
    credentialFile = join(userData, 'security/credentials', profile.credentialRef + '.json'); originalCipher = readFileSync(credentialFile);
    expect(await page.evaluate(() => window.flowmate.backgroundService.prepare({}))).toMatchObject({ ok: true });
    await credentialResponseGate(app, 'service_credentials_commit');
    const input = { installationId: f.installation.installationId, operationId: randomUUID(), expectedSettingsRevision: before.data.settings.revision };
    const first = await page.evaluate(input => window.flowmate.backgroundService.enable(input), input);
    expect(first).toMatchObject({ ok: true, data: { accepted: true, credentialsPublished: true, enabled: false, active: false,
      error: { code: 'operation_result_unknown' } } });
    if (!first.ok || !first.data.backupId) throw Error('Expected the original complete backup.');
    const serviceCredential = join(userData, 'security/service-credentials', profile.credentialRef + '.json'), publishedCipher = readFileSync(serviceCredential);
    const sent = await app.evaluate(() => Reflect.get(globalThis, 'activationResponseGate').requests) as Array<{ type: string; operationId: string }>;
    expect(sent.filter(value => value.type === 'service_credentials_prepare')).toEqual([{ type: 'service_credentials_prepare', operationId: input.operationId }]);
    expect(sent.filter(value => value.type === 'service_credentials_commit')).toEqual([{ type: 'service_credentials_commit', operationId: input.operationId }]);
    expect(sent.some(value => value.type === 'service_activate')).toBe(false);
    await app.evaluate(() => { Reflect.get(globalThis, 'activationResponseGate').restore(); Reflect.get(globalThis, 'activationScmGate').restore(); });
    await closeDesktopFixture(app, userData); app = null;
    // The service publication is already authoritative; this synthetic old-store failure must not force a second submission.
    writeFileSync(credentialFile, 'synthetic-unreadable-original-ciphertext');
    app = await launch(userData); page = await app.firstWindow(); await interceptScm(app, f); await credentialResponseGate(app, null);
    expect(await page.evaluate(() => window.flowmate.backgroundService.getServiceState())).toMatchObject({ ok: true, data: {
      state: 'blocked', activationOperationId: input.operationId, activationSettingsRevision: input.expectedSettingsRevision } });
    expect(await hasLocalHost(app)).toBe(false);
    expect(await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input), { installationId: input.installationId, operationId: input.operationId }))
      .toMatchObject({ ok: true, data: { accepted: true, backupId: first.data.backupId, credentialsPublished: null, active: null } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationResponseGate').requests)).toEqual([]);
    expect(await page.evaluate(input => window.flowmate.backgroundService.enable(input), input)).toMatchObject({ ok: true, data: {
      backupId: first.data.backupId, credentialsPublished: true, enabled: true, connected: true, active: true, error: null } });
    const resumed = await app.evaluate(() => Reflect.get(globalThis, 'activationResponseGate').requests) as Array<{ type: string; operationId: string }>;
    expect(resumed.filter(value => ['service_credentials_prepare', 'service_credentials_commit'].includes(value.type))).toEqual([]);
    expect(resumed.every(value => value.operationId === input.operationId)).toBe(true);
    expect(readFileSync(serviceCredential).equals(publishedCipher)).toBe(true);
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { ready: true,
      settings: { models: [{ id: profile.id, credentialRef: profile.credentialRef }] }, modelCredentials: { 'activation-commit': 'configured' } } });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual([]);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').maintenance)).toEqual(['verify-backup']);
    expect(f.messages.filter(message => message.type === 'fixture_start')).toHaveLength(1);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (credentialFile && originalCipher) writeFileSync(credentialFile, originalCipher);
    if (app) { await app.evaluate(() => { Reflect.get(globalThis, 'activationResponseGate')?.restore(); Reflect.get(globalThis, 'activationScmGate')?.restore(); }).catch(() => {}); await closeDesktopFixture(app, userData, failure); } }
  if (failure) throw failure;
});

test('an activation that captured the original revision excludes every desktop configuration save while its original begin is pending', async () => {
  test.setTimeout(120000); const f = await fixture(), userData = f.installation.dataRoot;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined, enabling: Promise<unknown> | null = null;
  try {
    app = await launch(userData); const page = await app.firstWindow(); await interceptScm(app, f);
    expect(await page.evaluate(() => window.flowmate.backgroundService.prepare({}))).toMatchObject({ ok: true });
    const before = await page.evaluate(() => window.flowmate.getState()); if (!before.ok) throw Error(before.error.code);
    const record = readFileSync(join(userData, 'service-installation.json'));
    await activationBeginGate(app, userData);
    const input = { installationId: f.installation.installationId, operationId: randomUUID(), expectedSettingsRevision: before.data.settings.revision };
    enabling = page.evaluate(input => window.flowmate.backgroundService.enable(input), input);
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'activationBeginGate').entered)).toBe(true);
    const results = [];
    for (const kind of ['product', 'evaluation', 'resources', 'extensions'] as const) results.push({ kind, result: await configurationSave(page, kind) });
    expect(results).toEqual(['product', 'evaluation', 'resources', 'extensions'].map(kind => ({ kind,
      result: { ok: false, error: expect.objectContaining({ code: 'config_settings_write_busy' }) } })));
    expect(await page.evaluate(() => window.flowmate.getState())).toMatchObject({ ok: true, data: { settings: { revision: input.expectedSettingsRevision } } });
    expect(readFileSync(join(userData, 'service-installation.json')).equals(record)).toBe(true);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual([]);
    await app.evaluate(() => Reflect.get(globalThis, 'activationBeginGate').release());
    expect(await enabling).toMatchObject({ ok: true, data: { operationId: input.operationId, expectedSettingsRevision: input.expectedSettingsRevision,
      active: true, credentialsPublished: true, error: null } }); enabling = null;
    expect(await configurationSave(page, 'product')).toMatchObject({ ok: true, data: { revision: input.expectedSettingsRevision + 1 } });
    expect(await configurationSave(page, 'evaluation')).toMatchObject({ ok: true, data: { revision: input.expectedSettingsRevision + 2 } });
    expect(await page.evaluate(input => window.flowmate.backgroundService.queryActivation(input), { installationId: input.installationId, operationId: input.operationId }))
      .toMatchObject({ ok: true, data: { expectedSettingsRevision: input.expectedSettingsRevision, active: true, error: null } });
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) { await app.evaluate(() => Reflect.get(globalThis, 'activationBeginGate')?.restore()).catch(() => {});
    if (enabling) await enabling.catch(() => {});
    await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); } }
  if (failure) throw failure;
});

for (const kind of ['product', 'evaluation'] as const) test('an in-flight ' + kind + ' configuration save excludes activation before any original begin is written', async () => {
  test.setTimeout(120000); const f = await fixture(), userData = f.installation.dataRoot;
  let app: Awaited<ReturnType<typeof launch>> | null = null, failure: Error | undefined, saving: Promise<unknown> | null = null, enabling: Promise<unknown> | null = null;
  try {
    app = await launch(userData); const page = await app.firstWindow(); await interceptScm(app, f);
    expect(await page.evaluate(() => window.flowmate.backgroundService.prepare({}))).toMatchObject({ ok: true });
    await installReadGate(app, userData);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').hold(1, 'save_settings'));
    saving = configurationSave(page, kind);
    await expect.poll(() => app!.evaluate(() => Reflect.get(globalThis, 'contextReadGate').held.length)).toBe(1);
    const current = await page.evaluate(() => window.flowmate.getState()); if (!current.ok) throw Error(current.error.code);
    const record = readFileSync(join(userData, 'service-installation.json'));
    await activationBeginGate(app, userData);
    let activationResult: unknown;
    const input = { installationId: f.installation.installationId, operationId: randomUUID(), expectedSettingsRevision: current.data.settings.revision };
    enabling = page.evaluate(input => window.flowmate.backgroundService.enable(input), input).then(result => { activationResult = result; return result; });
    await expect.poll(async () => activationResult !== undefined || await app!.evaluate(() => Reflect.get(globalThis, 'activationBeginGate').entered)).toBe(true);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationBeginGate').entered)).toBe(false);
    expect(activationResult).toMatchObject({ ok: false, error: { code: 'service_activation_busy' } });
    expect(readFileSync(join(userData, 'service-installation.json')).equals(record)).toBe(true);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate').commands)).toEqual([]);
    await app.evaluate(() => Reflect.get(globalThis, 'contextReadGate').restore());
    expect(await saving).toMatchObject({ ok: true }); saving = null; await enabling; enabling = null;
    expect(await hasLocalHost(app)).toBe(true);
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { if (app) { await app.evaluate(() => { Reflect.get(globalThis, 'contextReadGate')?.restore(); Reflect.get(globalThis, 'activationBeginGate')?.restore(); }).catch(() => {});
    if (saving) await saving.catch(() => {}); if (enabling) await enabling.catch(() => {});
    await app.evaluate(() => Reflect.get(globalThis, 'activationScmGate')?.restore()).catch(() => {}); await closeDesktopFixture(app, userData, failure); } }
  if (failure) throw failure;
});
