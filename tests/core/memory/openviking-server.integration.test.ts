import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { OpenVikingClient } from '@openviking/sdk';
import { createFileStore, createMemoryManager, createMemoryRuntime, createOpenVikingGroupAdmin, createOpenVikingService } from '@flowmate/core';
import { appError, fail, ok, type DurableRuntimePort, type ProviderConfig } from '@flowmate/contracts';
import { createPersonalAgentRuntime } from '../../../apps/personal-agent.ts';
import { startCloudAuthorityEndpoints } from '../../../apps/cloud-authority-service.ts';
import { createCloudAuthorityCallbacksClient } from '../../../apps/cloud-authority-rpc.ts';
import { startCloudOpenVikingManagement } from '../../../apps/cloud-openviking-authority.ts';
import { callCloudUnixRpc } from '../../../apps/cloud-unix-rpc.ts';
import { mkdtempSync, waitFor } from '../../support/resources.ts';
import { openTestDatabase } from '../../support/database.ts';
import { researchFixture } from '../../support/research.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';
import type { Result } from '@flowmate/contracts';
import { runOpenVikingManagement } from '../../../packages/core/src/openviking/management.ts';
import type { OpenVikingManagementConnection, OpenVikingManagementMethod } from '../../../packages/contracts/src/openviking-management.ts';
import type { CloudOpenVikingManagementCommand } from '../../../packages/contracts/src/cloud-openviking-management.ts';

const executable = process.env.FLOWMATE_OPENVIKING_TEST_SERVER;
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }

test.skipIf(process.platform !== 'linux' || !executable)('an isolated OpenViking Server accepts the original user Session and messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-ov-server-')), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let modelCalls = 0;
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { input?: string | string[] };
    if (new URL(request.url).pathname.endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ object: 'list', model: 'controlled-embedding', data: inputs.map((_, index) =>
        ({ object: 'embedding', index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })), usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    const result = JSON.stringify({ preferences: [{ page_id: 100, user: 'alice',
      topic: `invoice_style_${++modelCalls}`, content: '- Prefers concise invoice explanations.' }] });
    return Response.json({ id: 'controlled', object: 'chat.completion', model: 'controlled-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: result } }] });
  } });
  const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reserved.port!, endpoint = `http://127.0.0.1:${port}`; reserved.stop(true);
  const rootKey = 'synthetic-openviking-root-key', config = join(root, 'ov.conf');
  writeFileSync(config, JSON.stringify({ server: { host: '127.0.0.1', port, root_api_key: rootKey },
    storage: { workspace: join(root, 'data') },
    memory: { extraction_output_format: 'json' },
    embedding: { dense: { provider: 'openai', model: 'controlled-embedding', api_base: `http://127.0.0.1:${model.port}/v1`,
      api_key: 'synthetic-model-key', dimension: 8 } },
    vlm: { provider: 'openai', model: 'controlled-model', api_base: `http://127.0.0.1:${model.port}/v1`, api_key: 'synthetic-model-key' } }), { mode: 0o600 });
  const child = Bun.spawn([executable!, '--config', config], { cwd: root, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' } });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw Error(`The isolated OpenViking process exited with ${child.exitCode}.`);
      try { return (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, 30000);
    const admin = async (path: string, body: object) => {
      const response = await fetch(`${endpoint}${path}`, { method: 'POST', headers: { 'X-API-Key': rootKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error(`Controlled OpenViking setup failed with HTTP ${response.status}.`);
      return (await response.json() as { result: { user_key?: string } }).result;
    };
    const account = await admin('/api/v1/admin/accounts', { account_id: 'account', admin_user_id: 'admin' });
    const created = await admin('/api/v1/admin/accounts/account/users', { user_id: 'alice', role: 'user' });
    if (!created.user_key || !account.user_key) throw Error('Controlled user credentials were not returned.');
    const groups = createOpenVikingGroupAdmin({ endpoint, apiKey: account.user_key, accountId: 'account', role: 'account-admin' });
    for (const command of [{ operation: 'create', groupId: 'controlled-group' }, { operation: 'list' },
      { operation: 'add', groupId: 'controlled-group', userId: 'alice' }, { operation: 'members', groupId: 'controlled-group' },
      { operation: 'remove', groupId: 'controlled-group', userId: 'alice' }, { operation: 'delete', groupId: 'controlled-group' }] as const)
      expect((await groups.execute(command)).ok).toBe(true);
    expect((await createOpenVikingGroupAdmin({ endpoint, apiKey: created.user_key, accountId: 'account', role: 'account-admin' })
      .execute({ operation: 'list' })).ok).toBe(false);
    const owner = { accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent' };
    const profiles = {
      P: { ...owner, role: 'P', endpoint, apiKey: created.user_key },
      A: { role: 'A', accountId: 'account', userId: 'admin', endpoint, apiKey: account.user_key },
      S: { role: 'S', endpoint, apiKey: rootKey },
    } satisfies Record<string, OpenVikingManagementConnection>;
    const manage = (role: keyof typeof profiles, method: OpenVikingManagementMethod, input: Record<string, unknown>) =>
      runOpenVikingManagement(profiles[role], { connectionId: randomUUID(), method, input }, async () => true);
    expect(need(await manage('S', 'AdminListAccountsWithOptions', { name: 'account', limit: 1, page: 1 }))).toEqual(expect.any(Array));
    expect(need(await manage('A', 'AdminListUsersWithOptions', { name: 'alice', role: 'user', limit: 1, page: 1 }))).toEqual(expect.any(Array));
    expect(need(await manage('A', 'AdminListGroups', {}))).toEqual([]);
    expect(await manage('A', 'AdminListUsers', { accountId: 'other' })).toMatchObject({ ok: false });
    expect(need(await manage('S', 'GetStatus', { format: 'json' }))).toEqual(expect.any(Object));
    const managedSession = 'flowmate-management-' + randomUUID();
    expect(await manage('P', 'CreateSession', { sessionId: managedSession, disableAutoCommit: true })).toMatchObject({ ok: true });
    expect(await manage('P', 'GetSession', { sessionId: managedSession })).toMatchObject({ ok: true, data: { auto_commit_policy: null } });
    expect(await manage('P', 'AddMessage', { sessionId: managedSession, role: 'user', content: 'Isolated management test.' })).toMatchObject({ ok: true });
    expect(await manage('P', 'DeleteSession', { sessionId: managedSession })).toMatchObject({ ok: true });
    expect(await manage('P', 'SessionExists', { sessionId: managedSession })).toMatchObject({ ok: true, data: false });
    const service = createOpenVikingService({ endpoint, apiKey: created.user_key, owner }), sessionId = randomUUID();
    expect((await service.createMirrorSession(sessionId)).ok).toBe(true);
    expect(await service.verifyMirrorSession(sessionId)).toBe(true);
    expect((await service.appendMirrorMessage(sessionId, { role: 'user', content: 'Controlled original message.',
      sourceMessageIds: ['input-1'], turnId: 'turn-1' })).ok).toBe(true);
    const messages = await service.readMirrorMessages(sessionId);
    expect(messages.ok && messages.data.includes('Controlled original message.')).toBe(true);
    const committed = need(await service.commitMirrorSession(sessionId));
    if (typeof committed.task_id !== 'string') throw Error('The controlled commit did not return a task ID.');
    let taskStatus: unknown;
    await waitFor(async () => {
      const task = await service.readMirrorTask(committed.task_id as string);
      if (task.ok) taskStatus = task.data?.status;
      return taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled';
    }, 30000);
    expect(taskStatus).toBe('completed');
    const finished = need(await service.readMirrorTask(committed.task_id));
    const taskResult = finished!.result as { memory_diff_uri: string; memories_extracted: { memory_write: number } };
    expect(taskResult.memories_extracted.memory_write).toBe(1);
    expect(typeof taskResult.memory_diff_uri).toBe('string');
    const diffUrl = new URL('/api/v1/content/read', endpoint); diffUrl.searchParams.set('uri', taskResult.memory_diff_uri);
    diffUrl.searchParams.set('offset', '0'); diffUrl.searchParams.set('limit', '-1'); diffUrl.searchParams.set('raw', 'true');
    const diffReply = await fetch(diffUrl, { headers: { 'X-API-Key': created.user_key, 'X-OpenViking-Actor-Peer': owner.peerId } });
    if (!diffReply.ok) throw Error(`Controlled memory diff failed: ${diffReply.status} ${await diffReply.text()}`);
    const diffEnvelope = await diffReply.json() as { result: string }, diff = JSON.parse(diffEnvelope.result) as {
      operations: { adds: Array<{ uri: string; after: string }> } };
    expect(diff.operations.adds).toHaveLength(1);
    expect(await service.readMemoryItem(diff.operations.adds[0]!.uri)).toEqual({ ok: true, data: diff.operations.adds[0]!.after });
    expect((await createOpenVikingService({ endpoint, apiKey: rootKey, owner }).createMirrorSession(randomUUID())).ok).toBe(false);
    const uri = `viking://user/alice/memories/flowmate-${randomUUID()}.md`, content = 'Controlled invoice preference.';
    expect(await service.createMemoryItem(uri, content)).toMatchObject({ ok: true, data: { contentConfirmed: true, indexComplete: true } });
    expect(await service.readMemoryItem(uri)).toEqual({ ok: true, data: content });
    expect(await manage('P', 'Stat', { uri })).toMatchObject({ ok: true, data: { uri } });
    expect(await manage('P', 'ListPage', { uri: 'viking://user/alice/memories', limit: 1, include_abstract: false }))
      .toMatchObject({ ok: true, data: { result: expect.any(Array), hasMore: expect.any(Boolean) } });
    expect(await manage('P', 'Read', { uri, offset: 0, limit: -1 })).toEqual({ ok: true, data: content });
    let downloaded = '';
    expect(await runOpenVikingManagement(profiles.P, { connectionId: randomUUID(), method: 'DownloadBytes', input: { uri } },
      async () => false, globalThis.fetch, {
        selectUpload: async () => null, selectPrivateOptions: async () => null,
        selectOutput: async () => async stream => { downloaded = await new Response(stream).text(); },
      })).toEqual({ ok: true, data: { saved: true } });
    const downloadUrl = new URL('/api/v1/content/download', endpoint);
    downloadUrl.searchParams.set('uri', uri);
    const storedBytes = await fetch(downloadUrl, {
      headers: { 'X-API-Key': created.user_key, 'X-OpenViking-Actor-Peer': owner.peerId },
      signal: AbortSignal.timeout(10000),
    });
    expect(storedBytes.ok).toBe(true);
    expect(downloaded).toBe(await storedBytes.text());
    expect(downloaded).toStartWith(content);
    const socketPaths = { P: '', A: '', S: '' };
    const roleBindings = (['P', 'A', 'S'] as const).map(role => {
      const directory = join(root, `management-${role}`);
      mkdirSync(directory, { mode: 0o750 });
      const socketPath = socketPaths[role] = join(directory, 'management.sock');
      return { socketPath, connection: profiles[role] };
    });
    const management = need(await startCloudOpenVikingManagement({ workspaceId, productRoot: root, roles: roleBindings }));
    const dedicated = async (role: keyof typeof profiles, command: CloudOpenVikingManagementCommand) =>
      need(await callCloudUnixRpc(socketPaths[role], { version: 1, workspaceId, requestId: randomUUID(), command }));
    try {
      for (const role of ['P', 'A', 'S'] as const) {
        const hello = await dedicated(role, { type: 'info' });
        expect(hello).toMatchObject({ ok: true, data: { role, workspaceId } });
        expect(JSON.stringify(hello)).not.toContain(profiles[role].apiKey);
      }
      expect(await dedicated('A', { type: 'execute', input: { operationId: randomUUID(),
        request: { connectionId: randomUUID(), method: 'AdminListGroups', input: {} } } }))
        .toEqual({ ok: true, data: [] });
      expect(await dedicated('A', { type: 'execute', input: { operationId: randomUUID(),
        request: { connectionId: randomUUID(), method: 'AdminListUsers', input: { accountId: 'other' } } } }))
        .toMatchObject({ ok: false, error: { code: 'memory_scope_denied' } });
      const operationId = randomUUID();
      const download: CloudOpenVikingManagementCommand = { type: 'execute', input: { operationId, output: true,
        request: { connectionId: randomUUID(), method: 'DownloadBytes', input: { uri } } } };
      expect(await dedicated('P', download)).toMatchObject({ ok: true, data: { saved: true } });
      expect(await dedicated('P', { type: 'download_status', input: { operationId } }))
        .toMatchObject({ ok: true, data: { operationId, bytes: Buffer.byteLength(downloaded) } });
      expect(await dedicated('P', { type: 'download_read', input: { operationId, offset: 0 } }))
        .toMatchObject({ ok: true, data: { operationId, offset: 0, base64: Buffer.from(downloaded).toString('base64') } });
      expect(await dedicated('A', { type: 'download_read', input: { operationId, offset: 0 } })).toMatchObject({ ok: false });
      expect(await dedicated('P', download)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
      expect(await dedicated('P', { type: 'download_release', input: { operationId } })).toMatchObject({ ok: true });
    } finally { need(await management.close()); }
    expect(await service.recall({ query: 'invoice preference', timeoutMs: 2000,
      allowedEntries: [{ uri, revision: 1, approvedContent: content }] }))
      .toMatchObject({ ok: true, data: { status: 'ready', items: [{ uri, content }] } });
    const exact = await new OpenVikingClient({ baseUrl: endpoint, apiKey: created.user_key, actorPeerId: owner.peerId })
      .find('invoice preference', { targetUri: [uri], limit: 5, contextType: 'memory' });
    expect(exact.memories?.some(item => typeof item === 'object' && item !== null && 'uri' in item && item.uri === uri)).toBe(true);
    const workAt = new Date().toISOString();
    const provider: ProviderConfig = { version: 1, name: 'controlled', revision: 1, modelRef: { provider: 'controlled', model: 'fixture' },
      native: { authPath: 'unused', modelsPath: null }, connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:12345/v1',
        contextWindow: 64000, maxTokens: 8192 }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
    const work = await invoiceWorkToolsFixture({ at: workAt, provider, itemLane: true, durableRuntimeId: '11111111-1111-4111-8111-111111111111' });
    const native = { close: async () => ok(undefined) } as unknown as DurableRuntimePort;
    try {
      work.database.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'cloud',?,'account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)")
        .run(workspaceId, workAt, workAt);
      work.database.db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(1,1,?,?,1,'active',?,?,?)")
        .run(endpoint, uri, JSON.stringify({ version: 1, approvedContent: content }), workAt, workAt);
      work.database.db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(1,'work',?,1)").run(String(work.created.workId));
      need(await work.database.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
        recallEnabled: true, captureMode: 'off', endpoint, at: workAt })));
      const owner = { environment: 'cloud' as const, ownerId: workspaceId };
      const workMemory = createMemoryRuntime({ database: work.database, owner, readCredential: async () => created.user_key, now: () => workAt });
      need(await work.database.transaction(scope => workMemory.bindWorkInStore(scope, { workId: work.created.workId, sessionId: work.created.sessionId }, owner)));
      const lanes = work.database.db.query<{ remote_session_id: string }, [number]>(
        "SELECT remote_session_id FROM memory_bindings WHERE work_id=? ORDER BY item_id").all(work.created.workId);
      expect(lanes).toHaveLength(2); expect(lanes[0]!.remote_session_id).not.toBe(lanes[1]!.remote_session_id);
      const personal = need(await createPersonalAgentRuntime({ database: work.database, definitions: work.definitions, resourceRoot: work.paths.root,
        bundleRoot: work.paths.root, now: () => workAt, foregroundBusy: () => false,
        resolveConfiguration: () => fail(appError('unavailable', 'input', 'Not used.')), readApiKey: () => undefined,
        cloud: { workspaceId, runtime: native }, memory: { owner, runtime: workMemory } }));
      try {
        const socket = join(work.paths.root, 'authority.sock');
        const endpoints = need(await startCloudAuthorityEndpoints({ workspaceId, database: work.database, personal, runtime: native,
          files: createFileStore(work.paths, work.database), inspect: () => fail(appError('unavailable', 'runtime', 'Not used.')),
          now: () => workAt, readApiKey: () => undefined, desktopSocket: join(work.paths.root, 'desktop.sock'),
          authoritySocket: socket, modelSocket: join(work.paths.root, 'model.sock') }));
        try {
          const client = createCloudAuthorityCallbacksClient(socket), phase = { workId: work.created.workId, sessionId: work.created.sessionId,
            itemId: work.itemId, attemptId: work.attemptId, requestId: work.phase.requestId };
          expect(await client.readMemory!(phase)).toMatchObject({ ok: true, data: { status: 'ready', items: [{ uri, content }] } });
          expect(await client.readMemory!({ ...phase, itemId: phase.itemId + 1 })).toMatchObject({ ok: false });
        } finally { need(await endpoints.close()); }
      } finally { need(await personal.close()); await workMemory.sync.close(); }
    } finally { await work.database.close(); }
    const productRoot = join(root, 'product'), paths = { root: productRoot, databaseFile: join(productRoot, 'data/app.sqlite'),
      artifactsDir: join(productRoot, 'artifacts'), outputsDir: join(productRoot, 'outputs'), runtimeDir: join(productRoot, 'runtime'), logsDir: join(productRoot, 'logs') };
    const database = need(openTestDatabase(paths)), at = new Date().toISOString(), localOwner = { environment: 'local' as const, ownerId: randomUUID() };
    const key = created.user_key, readCredential = async () => key, now = () => new Date().toISOString();
    const runtime = createMemoryRuntime({ database, readCredential, now, owner: localOwner });
    try {
      need(await createMemoryManager({ database, owner: localOwner, readCredential, now }).configure({ expectedRevision: 0, endpoint,
        ...owner, credentialRef: 'synthetic-reference', recallEnabled: true, captureMode: 'explicit' }));
      const first = need(await database.transaction(scope => scope.sessions.create({ nativeSessionId: 'first-controlled', title: 'First', at })));
      const second = need(await database.transaction(scope => scope.sessions.create({ nativeSessionId: 'second-controlled', title: 'Second', at })));
      for (const [inputId, session] of [[41, first], [42, second]] as const)
        database.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(?,?,1,'prompt','answer','{\"version\":1}','failed','failed',?,?)")
          .run(inputId, session.sessionId, at, at);
      const firstBinding = need(await database.transaction(scope => runtime.bindSessionInStore(scope, first.sessionId, localOwner)));
      const secondBinding = need(await database.transaction(scope => runtime.bindSessionInStore(scope, second.sessionId, localOwner)));
      if (!firstBinding || !secondBinding) throw Error('Controlled Session binding is unavailable.');
      need(await database.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: first.sessionId, inputId: 41, bindingId: firstBinding.id })));
      need(await database.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: second.sessionId, inputId: 42, bindingId: secondBinding.id })));
      const remembered = need(await runtime.remember({ bindingId: firstBinding.id, inputId: 41, phaseId: null, owner: localOwner,
        requestId: 'controlled-remember', content: 'Use concise invoice explanations.', scope: { kind: 'personal' }, confirmed: true }));
      expect(remembered.state).toBe('completed');
      expect(await runtime.recall({ bindingId: secondBinding.id, inputId: 42, phaseId: null, owner: localOwner,
        query: 'invoice explanations', timeoutMs: 2000 })).toMatchObject({ ok: true, data: {
          status: 'ready', items: [{ content: 'Use concise invoice explanations.' }] } });
      if (!remembered.entryId) throw Error('The controlled memory has no entry ID.');
      expect(await runtime.forget({ entryId: remembered.entryId, expectedRevision: 1, requestId: 'controlled-forget', owner: localOwner, confirmed: true }))
        .toMatchObject({ ok: true, data: { state: 'completed' } });
      expect((await service.readMemoryItem(remembered.uri)).ok).toBe(false);
      expect(await service.memoryItemAbsent(remembered.uri)).toBe(true);
      expect(await runtime.recall({ bindingId: secondBinding.id, inputId: 42, phaseId: null, owner: localOwner,
        query: 'invoice explanations', timeoutMs: 2000 })).toMatchObject({ ok: true, data: { status: 'disabled' } });
    } finally { await runtime.sync.close(); await database.close(); }
    const f = await researchFixture(() => ({ text: 'Controlled assistant response.' }), undefined,
      { memory: { owner: { environment: 'local', ownerId: randomUUID() }, readCredential: async () => key,
        initialConnection: { endpoint, ...owner, credentialRef: 'synthetic-reference', recallEnabled: true, captureMode: 'auto' } } });
    try {
      const chat = need(await f.app.createSession({ title: 'Actual server capture' }));
      const result = await f.run({ sessionId: chat.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
        text: 'Controlled original capture.', focus: { page: 'chats' } });
      expect(result.terminal.result.ok).toBe(true);
      await waitFor(async () => {
        const saved = await f.app.memory.listOperations({ kind: 'sync' });
        const state = saved.ok ? saved.data.items[0]?.state : undefined;
        return state === 'completed' || state === 'failed' || state === 'unknown';
      }, 30000);
      const saved = await f.app.memory.listOperations({ kind: 'sync' });
      expect(saved).toMatchObject({ ok: true, data: { items: [{ state: 'completed' }] } });
      await f.reopen();
      expect(await f.app.memory.listOperations({ kind: 'sync' })).toEqual(saved);
      const entries = need(await f.app.memory.listEntries({})).items;
      expect(entries).toHaveLength(1);
      const extracted = need(await service.readMemoryItem(entries[0]!.uri));
      expect(extracted).toContain('Prefers concise invoice explanations.');
      await waitFor(async () => { const result = await service.recall({ query: 'invoice explanations', timeoutMs: 2000,
        allowedEntries: [{ uri: entries[0]!.uri, revision: 1, approvedContent: extracted }] });
        return result.ok && result.data.status === 'ready'; }, 10000);
      const later = need(await f.app.createSession({ title: 'Later actual server chat' }));
      expect((await f.run({ sessionId: later.sessionId, clientSequence: 1, mode: 'prompt', config: f.config,
        text: 'Explain the invoice.', focus: { page: 'chats' } })).terminal.result.ok).toBe(true);
      expect(JSON.stringify(f.requests.at(-1))).toContain('Prefers concise invoice explanations.');
      await f.app.close();
      const audit = new Database(f.paths.databaseFile, { readonly: true });
      try { expect(audit.query('SELECT state,remote_task_id FROM memory_sync ORDER BY id LIMIT 1').get())
        .toMatchObject({ state: 'completed', remote_task_id: expect.any(String) }); }
      finally { audit.close(); }
    } finally { await f.app.close(); }
  } finally {
    child.kill('SIGTERM'); await child.exited; await Promise.all([stdout, stderr]); model.stop(true);
  }
}, 60000);
