import { expect, test } from 'bun:test';
import { createFileStore, createMemoryRuntime } from '@flowmate/core';
import { join } from 'node:path';
import { appError, fail, ok, type DurableRuntimePort, type ProviderConfig, type Result } from '@flowmate/contracts';
import { createPersonalAgentRuntime } from '../../../apps/personal-agent.ts';
import { startCloudAuthorityEndpoints } from '../../../apps/cloud-authority-service.ts';
import { createCloudAuthorityCallbacksClient } from '../../../apps/cloud-authority-rpc.ts';
import { invoiceWorkToolsFixture } from '../../support/invoice-work-tools.ts';
import { openVikingContentFixture, openVikingSessionFixture } from '../../support/openviking.ts';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

for (const transport of ['direct', 'socket'] as const) test.skipIf(transport === 'socket' && process.platform !== 'linux')
('cloud Authority checks the original invoice phase before reading an approved memory through ' + transport, async () => {
  const at = new Date().toISOString(), workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const provider: ProviderConfig = { version: 1, name: 'controlled', revision: 1, modelRef: { provider: 'controlled', model: 'fixture' },
    native: { authPath: 'unused.json', modelsPath: null }, connection: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:12345/v1',
      contextWindow: 64000, maxTokens: 8192 }, parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  const f = await invoiceWorkToolsFixture({ at, provider, itemLane: true, durableRuntimeId: '11111111-1111-4111-8111-111111111111' });
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const session = await openVikingSessionFixture(request); if (session) return session;
    const content = openVikingContentFixture(request, 'Authorized cloud Work preference'); if (content) return content;
    calls++; return Response.json({ status: 'ok', result: {
    memories: [{ uri: 'viking://user/alice/memories/work.md', abstract: 'Authorized cloud Work preference' }] } }); } });
  const native = { close: async () => ok(undefined) } as unknown as DurableRuntimePort;
  try {
    f.database.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'cloud',?,'account','alice','flowmate.alice.agent','synthetic-reference','active',?,?)").run(workspaceId, at, at);
    f.database.db.query("INSERT INTO memory_entries(id,identity_id,endpoint,uri,revision,state,source_json,created_at,updated_at) VALUES(1,1,?,'viking://user/alice/memories/work.md',1,'active',?,?,?)")
      .run(`http://127.0.0.1:${server.port}`, JSON.stringify({ version: 1, approvedContent: 'Authorized cloud Work preference' }), at, at);
    f.database.db.query("INSERT INTO memory_grants(entry_id,scope_kind,scope_id,revision) VALUES(1,'work',?,1)").run(String(f.created.workId));
    need(await f.database.transaction(scope => scope.memoryIntegration.saveSettings({ expectedRevision: 0, provider: 'openviking',
      recallEnabled: true, captureMode: 'off', endpoint: `http://127.0.0.1:${server.port}`, at })));
    const memory = createMemoryRuntime({ database: f.database, now: () => at, readCredential: async () => 'synthetic-key' });
    const personal = need(await createPersonalAgentRuntime({ database: f.database, definitions: f.definitions,
      resourceRoot: f.paths.root, bundleRoot: f.paths.root, now: () => at, foregroundBusy: () => false,
      resolveConfiguration: () => fail(appError('unavailable', 'input', 'No model.')), readApiKey: () => undefined,
      cloud: { workspaceId, runtime: native }, memory: { owner: { environment: 'cloud', ownerId: workspaceId }, runtime: memory } }));
    try {
      const socket = join(f.paths.root, 'authority.sock');
      const endpoints = transport === 'socket' ? need(await startCloudAuthorityEndpoints({ workspaceId, database: f.database, personal, runtime: native,
        files: createFileStore(f.paths, f.database), inspect: () => fail(appError('unavailable', 'runtime', 'Not used.')),
        now: () => at, readApiKey: () => undefined, desktopSocket: join(f.paths.root, 'desktop.sock'),
        authoritySocket: socket, modelSocket: join(f.paths.root, 'model.sock') })) : undefined;
      const callback = transport === 'socket' ? createCloudAuthorityCallbacksClient(socket).readMemory : personal.cloudAuthority?.callbacks.readMemory;
      if (!callback) throw Error('Missing Authority memory callback');
      try {
      const phase = { workId: f.created.workId, sessionId: f.created.sessionId, itemId: f.itemId, attemptId: f.attemptId, requestId: f.phase.requestId };
      expect(await callback(phase)).toMatchObject({ ok: true, data: { status: 'ready', items: [{ content: 'Authorized cloud Work preference' }] } });
      expect(await callback({ ...phase, itemId: phase.itemId + 1 })).toMatchObject({ ok: false });
      expect(await callback(phase)).toMatchObject({ ok: true, data: { status: 'ready' } });
      expect(calls).toBe(1);
      const binding = f.database.db.query<{ id: number }, [number, number]>(
        "SELECT id FROM memory_bindings WHERE runtime_kind='durable' AND work_id=? AND item_id=?").get(f.created.workId, f.itemId);
      if (!binding) throw Error('Missing original Work memory binding.');
      const search = { bindingId: binding.id, inputId: null, phaseId: f.phase.phaseId,
        owner: { environment: 'cloud' as const, ownerId: workspaceId }, query: 'preference', timeoutMs: 2000 };
      expect(await memory.search(search)).toMatchObject({ ok: true, data: { status: 'ready', items: [{ content: 'Authorized cloud Work preference' }] } });
      expect(await memory.search({ ...search, owner: { ...search.owner, ownerId: 'another-workspace' } })).toMatchObject({ ok: false });
      } finally { if (endpoints) need(await endpoints.close()); }
    } finally { need(await personal.close()); }
  } finally { server.stop(true); await f.database.close(); }
});
