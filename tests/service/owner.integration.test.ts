import { afterAll, expect, it } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { defaultProductSettings } from '@flowmate/core';
import { createCredentialStore } from '../../packages/shared/src/secure-credential-store.ts';
import { createServiceSecureStorage } from '../../packages/shared/src/service-secure-storage.ts';
import type { DocumentSnapshot, Result } from '@flowmate/contracts';
import { Database } from 'bun:sqlite';
import * as P from '../../packages/contracts/src/personal-agent.ts';
import { servicePipeName } from '../../apps/service/protocol.ts';
import { installOwnerFixture, ownerClient, packageOwnerFixture, removeOwnerFixture, spawnOwnerFixture, waitOwner } from './owner-fixture.ts';

let packaged: Awaited<ReturnType<typeof packageOwnerFixture>> | undefined;
afterAll(() => { if (packaged) removeOwnerFixture(packaged.root); });
async function fixture(mode = '', enabled = true) {
  const module = await import('../../apps/service/owner.ts').catch(() => null);
  expect(module).not.toBeNull(); if (!module) throw Error('service_owner_missing');
  packaged ??= await packageOwnerFixture();
  const installation = await installOwnerFixture(packaged.runtimeRoot, enabled);
  const process = await spawnOwnerFixture(installation, mode);
  return { installation, process };
}
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
async function foregroundFixture(mode = '', enabled = true) {
  const f = await fixture(mode, enabled), requests: unknown[] = [];
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json()); await gate;
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Controlled foreground.' },
      finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const ref = 'service_foreground_key_01';
  need(await createCredentialStore(join(f.installation.dataRoot, 'security/service-credentials', ref + '.json'),
    createServiceSecureStorage(f.installation.ownerSid)).write(JSON.stringify({ type: 'api_key', key: 'synthetic-foreground-key' })));
  const client = await ownerClient(f.installation), profile = { id: 'service-foreground', name: 'Controlled foreground', credentialRef: ref,
    kind: 'custom', providerId: null, baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'service-foreground', api: 'openai-completions',
    contextWindow: 64000, maxTokens: 8192, reasoning: false };
  need(await client.call({ type: 'save_settings', settings: { ...defaultProductSettings(), revision: 0, models: [profile], defaultModelId: profile.id } }));
  return { ...f, ref, requests, client, releaseProvider: () => release(),
    holdProvider() { gate = new Promise<void>(resolve => { release = resolve; }); }, async dispose() {
    release(); client.socket.destroy(); await f.process.close(); await f.process.child.exited;
    server.stop(true); removeOwnerFixture(f.installation.dataRoot);
  } };
}

it('requires exact installation, release and data identity before service commands', async () => {
  const protocol = await import('../../apps/service/protocol.ts').catch(() => null);
  expect(protocol).not.toBeNull(); if (!protocol) return;
  const hello = { version: 1, type: 'service_connect', installationId: 'c4ec257c-fd14-4074-8271-391caf6a3330',
    releaseId: '688eae46-7e34-4025-b622-566d98d1fb38', protocolVersion: 1, dataVersion: 21 } as const;
  expect(protocol.parseServiceConnect(hello)).toEqual(hello);
  for (const change of [{ protocolVersion: 2 }, { dataVersion: 20 }, { installationId: '../data' },
    { releaseId: '' }, { dataRoot: 'C:\\other-data' }, { command: 'close' }, { ownerSid: 'S-1-5-18' }])
    expect(protocol.parseServiceConnect({ ...hello, ...change })).toBeNull();
  expect(protocol.parseServiceHandshake({ ...hello, type: 'service_ready', connectionId: '01a1c59e-d23d-44b6-b0be-6ef838a45dfd' }))
    .toMatchObject({ type: 'service_ready' });
  expect(protocol.parseServiceHandshake({ version: 1, type: 'service_error', result: { ok: false,
    error: { code: 'service_incompatible', category: 'runtime', message: 'The service identity is incompatible.', retryable: false } } }))
    .toMatchObject({ type: 'service_error', result: { ok: false } });
  const control = { version: 1, requestId: '381f9624-1260-4648-b4d8-c274dcdd9e29', type: 'service_credentials_status' } as const;
  expect(protocol.parseServicePrivateCommand(control)).toEqual(control);
  expect(protocol.parseServicePrivateCommand({ ...control, dataRoot: 'C:\\other' })).toBeNull();
  expect(protocol.parseServicePrivateCommand({ ...control, type: 'service_activate', input: {
    installationId: hello.installationId, operationId: '46955164-c356-40b7-961f-36d04ca0728d' } })).toMatchObject({ type: 'service_activate' });
  expect(protocol.parseServicePrivateResult('service_credentials_status', { ok: true, data: {
    installationId: hello.installationId, settingsRevision: 0, models: [], apiKey: 'never-in-a-response' } })).toBeNull();
  expect(protocol.parseServicePrivateCommand({ ...control, type: 'service_query_disconnect', input: {
    connectionId: '6469b89a-c03f-4a26-b7ae-fc9337e06d50' } })).toMatchObject({ type: 'service_query_disconnect' });
  const unsafe = protocol.parseServicePrivateResult('service_credentials_status', { ok: false, error: {
    code: 'secret_bearing_untrusted_code', category: 'runtime', retryable: false, message: 'synthetic-secret-and-private-path' } });
  expect(JSON.stringify(unsafe)).not.toContain('synthetic-secret');
  expect(JSON.stringify(unsafe)).not.toContain('secret_bearing');
});

it('keeps standby passive until a committed migration and the published original activation record', async () => {
  const f = await fixture('', false), client = await ownerClient(f.installation);
  try {
    expect(await client.call({ type: 'call_provider', input: { goal: 'Standby cannot execute', text: '', modelId: 'not-saved' } }))
      .toMatchObject({ ok: false, error: { code: 'service_standby' } });
    const status = need(await client.call<{ settingsRevision: number }>({ type: 'service_credentials_status' }));
    const input = { installationId: f.installation.installationId, operationId: '6e8ad362-400e-4489-b5de-2cfe3ce1b3e4' };
    expect(await client.call({ type: 'service_credentials_prepare', input: { ...input,
      expectedSettingsRevision: status.settingsRevision, credentials: [] } })).toMatchObject({ ok: true, data: { phase: 'prepared' } });
    expect(await client.call({ type: 'service_credentials_commit', input })).toMatchObject({ ok: true, data: { phase: 'committed' } });
    writeFileSync(join(f.installation.dataRoot, 'service-installation.json'), JSON.stringify({ ...f.installation, activationOperationId: input.operationId }));
    expect(await client.call({ type: 'service_query_activation', input })).toEqual({ ok: true, data: { ...input, active: false } });
    expect(await client.call({ type: 'service_prepare_activation', input: { ...input, expectedSettingsRevision: status.settingsRevision + 1 } }))
      .toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
    expect(await client.call({ type: 'service_prepare_activation', input: { ...input, operationId: 'a3861e08-0bf5-4ab6-b9cf-f3cd7ab3c8c7',
      expectedSettingsRevision: status.settingsRevision } })).toMatchObject({ ok: false, error: { code: 'service_activation_pending' } });
    writeFileSync(join(f.installation.dataRoot, 'service-installation.json'), JSON.stringify({ ...f.installation,
      activationOperationId: input.operationId, activationSettingsRevision: status.settingsRevision + 1 }));
    expect(await client.call({ type: 'service_prepare_activation', input: { ...input, expectedSettingsRevision: status.settingsRevision } }))
      .toMatchObject({ ok: false, error: { code: 'config_revision_conflict' } });
    writeFileSync(join(f.installation.dataRoot, 'service-installation.json'), JSON.stringify({ ...f.installation,
      activationOperationId: input.operationId, activationSettingsRevision: status.settingsRevision }));
    expect(await client.call({ type: 'service_prepare_activation', input: { ...input, expectedSettingsRevision: status.settingsRevision } }))
      .toEqual({ ok: true, data: { ...input, settingsRevision: status.settingsRevision, ready: true } });
    expect(await client.call({ type: 'service_query_activation', input })).toEqual({ ok: true, data: { ...input, active: false } });
    expect(await client.call({ type: 'service_activate', input })).toMatchObject({ ok: false, error: { code: 'service_activation_pending' } });
    writeFileSync(join(f.installation.dataRoot, 'service-installation.json'), JSON.stringify({ ...f.installation, enabled: true,
      activationOperationId: input.operationId, activationSettingsRevision: status.settingsRevision }));
    expect(await client.call({ type: 'service_activate', input })).toEqual({ ok: true, data: { ...input, active: true } });
    expect(await client.call({ type: 'service_query_activation', input })).toEqual({ ok: true, data: { ...input, active: true } });
    expect(await client.call({ type: 'service_activate', input })).toEqual({ ok: true, data: { ...input, active: true } });
    expect(await client.call({ type: 'call_provider', input: { goal: 'No model configured', text: '', modelId: 'not-saved' } }))
      .toMatchObject({ ok: false, error: { code: 'model_not_configured' } });
  } finally { client.socket.destroy(); await f.process.close(); await f.process.child.exited; removeOwnerFixture(f.installation.dataRoot); }
}, 90_000);

for (const mode of ['hold-start-recovery', 'fail-start-recovery']) it('reports the actual enabled boot recovery fact in ' + mode, async () => {
  const f = await fixture(mode), client = await ownerClient(f.installation);
  const input = { installationId: f.installation.installationId, operationId: f.installation.activationOperationId! };
  try {
    await waitOwner(() => f.process.messages.some(value => (value as { type: string }).type === 'fixture_recovery_entered'));
    expect(await client.call({ type: 'service_query_activation', input })).toEqual({ ok: true, data: { ...input, active: false } });
    expect(await client.call({ type: 'call_provider', input: { goal: 'No startup before recovery', text: '', modelId: 'not-saved' } }))
      .toMatchObject({ ok: false, error: { code: 'service_standby' } });
    if (mode === 'hold-start-recovery') {
      f.process.child.stdin.write('release-recovery\n'); await f.process.child.stdin.flush();
      let activated = false;
      const deadline = Date.now() + 10_000;
      while (!activated && Date.now() < deadline) {
        const result = need(await client.call<{ active: boolean }>({ type: 'service_query_activation', input }));
        activated = result.active; if (!activated) await Bun.sleep(20);
      }
      expect(activated).toBe(true);
    } else {
      expect(await client.call({ type: 'service_query_activation', input })).toEqual({ ok: true, data: { ...input, active: false } });
      expect(f.process.messages.filter(value => (value as { type: string }).type === 'fixture_recovery_entered')).toHaveLength(1);
    }
  } finally {
    f.process.child.stdin.write('release-recovery\n'); client.socket.destroy(); await f.process.close(); await f.process.child.exited;
    removeOwnerFixture(f.installation.dataRoot);
  }
}, 90_000);

it('reads actual migrated credentials for preparation while activation queries never decrypt or start scheduling', async () => {
  const f = await foregroundFixture('observe-activation', false);
  const stats = async () => {
    const before = f.process.messages.length;
    f.process.child.stdin.write('activation-stats\n'); await f.process.child.stdin.flush();
    await waitOwner(() => f.process.messages.slice(before).some(value => (value as { type: string }).type === 'fixture_activation_stats'));
    return f.process.messages.slice(before).find(value => (value as { type: string }).type === 'fixture_activation_stats') as { starts: number; decrypts: number };
  };
  try {
    const input = { installationId: f.installation.installationId, operationId: 'ac16c97c-3272-4763-b059-b3d18c3f3717' };
    writeFileSync(join(f.installation.dataRoot, 'service-installation.json'), JSON.stringify({ ...f.installation,
      activationOperationId: input.operationId, activationSettingsRevision: 1 }));
    need(await f.client.call({ type: 'service_credentials_prepare', input: { ...input, expectedSettingsRevision: 1,
      credentials: [{ modelId: 'service-foreground', credentialRef: f.ref, value: 'synthetic-foreground-key' }] } }));
    need(await f.client.call({ type: 'service_credentials_commit', input }));
    const before = await stats();
    expect(await f.client.call({ type: 'service_prepare_activation', input: { ...input, expectedSettingsRevision: 1 } }))
      .toEqual({ ok: true, data: { ...input, settingsRevision: 1, ready: true } });
    const prepared = await stats(); expect(prepared.decrypts).toBeGreaterThan(before.decrypts); expect(prepared.starts).toBe(0);
    for (let index = 0; index < 3; index++) expect(await f.client.call({ type: 'service_query_activation', input }))
      .toEqual({ ok: true, data: { ...input, active: false } });
    expect(await stats()).toEqual(prepared); expect(f.requests).toHaveLength(0);
    const file = join(f.installation.dataRoot, 'security/service-credentials', f.ref + '.json'), bytes = readFileSync(file);
    const envelope = JSON.parse(bytes.toString('utf8')) as { ciphertext: string }; envelope.ciphertext = 'invalid-current-user-ciphertext';
    writeFileSync(file, JSON.stringify(envelope));
    try {
      expect(await f.client.call({ type: 'service_prepare_activation', input: { ...input, expectedSettingsRevision: 1 } }))
        .toMatchObject({ ok: false, error: { code: 'service_credential_not_prepared' } });
      const failed = await stats();
      expect(await f.client.call({ type: 'service_query_activation', input })).toEqual({ ok: true, data: { ...input, active: false } });
      expect(await stats()).toEqual(failed); expect(f.requests).toHaveLength(0);
    } finally { writeFileSync(file, bytes); }
  } finally { await f.dispose(); }
}, 90_000);

it('keeps the original accepted Work passive when standby restarts without its final credential', async () => {
  const f = await foregroundFixture('', false);
  let restarted: Awaited<ReturnType<typeof spawnOwnerFixture>> | undefined, client: Awaited<ReturnType<typeof ownerClient>> | undefined;
  try {
    const sourceText = 'Original standby invoice total 113.00';
    const document = need(await f.client.call<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
      contract: 'flowmate-prepared-invoice/v1', sample: 'standby-original', sourceText,
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
    } }));
    const original = P.PersonalAgentSnapshotSchema.parse(need(await f.client.call({ type: 'personal_agent_get', input: {} })));
    const agent = P.PersonalAgentSnapshotSchema.parse(need(await f.client.call({ type: 'personal_agent_update', input: {
      personalAgentId: original.personalAgentId, expectedRevision: original.revision, configuration: { ...original.configuration,
        modelId: 'service-foreground', resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'] },
    } })));
    const input = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'original-standby-create', goal: 'Keep the original accepted Work.', documents: [document.documentRef] };
    const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await f.client.call({ type: 'invoice_work_create', input })));
    const before = need(await f.client.call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } }));
    expect(f.requests).toHaveLength(0);
    f.client.socket.destroy(); await f.process.close(); await f.process.child.exited;
    need(await createCredentialStore(join(f.installation.dataRoot, 'security/service-credentials', f.ref + '.json'),
      createServiceSecureStorage(f.installation.ownerSid)).remove());
    restarted = await spawnOwnerFixture(f.installation); client = await ownerClient(f.installation);
    expect(await client.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId,
      requestId: input.requestId } })).toEqual({ ok: true, data: created });
    expect(await client.call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } })).toEqual({ ok: true, data: before });
    expect(f.requests).toHaveLength(0);
  } finally {
    client?.socket.destroy(); if (restarted) { await restarted.close(); await restarted.child.exited; }
    await f.dispose();
  }
}, 90_000);

it('queries the original disconnected scope without stopping a new connection foreground', async () => {
  const f = await foregroundFixture('hold-foreground-facts');
  const oldId = (f.client.hello as { connectionId: string }).connectionId;
  let reconnected: Awaited<ReturnType<typeof ownerClient>> | undefined;
  try {
    const old = need(await f.client.call<{ runId: number }>({ type: 'call_provider', input: { goal: 'Old foreground', text: '', modelId: 'service-foreground' } }));
    await waitOwner(() => f.requests.length === 1); f.client.socket.destroy();
    reconnected = await ownerClient(f.installation);
    expect(await reconnected.call({ type: 'service_query_disconnect', input: { connectionId: oldId } })).toMatchObject({ ok: true,
      data: { connectionId: oldId, stopped: false, pending: [{ kind: 'run', runId: old.runId, sessionId: null }] } });
    const next = need(await reconnected.call<{ runId: number }>({ type: 'call_provider', input: { goal: 'New foreground', text: '', modelId: 'service-foreground' } }));
    await waitOwner(() => f.requests.length === 2);
    f.process.child.stdin.write('release-stop-facts\n'); await f.process.child.stdin.flush();
    expect(await reconnected.call({ type: 'service_query_disconnect', input: { connectionId: oldId } })).toMatchObject({ ok: true,
      data: { connectionId: oldId, stopped: true, pending: [] } });
    expect(await reconnected.call({ type: 'query_run', runId: next.runId })).toMatchObject({ ok: true, data: { stoppedAt: null } });
    expect(await reconnected.call({ type: 'service_query_disconnect', input: { connectionId: '1e7afbe0-bc87-4cbe-8e6e-8a53438ec7b0' } }))
      .toMatchObject({ ok: false, error: { code: 'service_connection_unknown' } });
  } finally { reconnected?.socket.destroy(); await f.dispose(); }
}, 90_000);

it('prepares only the authenticated connection for disconnect without closing its owner or another connection', async () => {
  const f = await fixture(), first = await ownerClient(f.installation), second = await ownerClient(f.installation);
  try {
    const id = '649578c1-de83-4685-b3dc-5a2248770e23';
    for (const change of [{ runId: 1 }, { connectionId: (second.hello as { connectionId: string }).connectionId },
      { control: { stop: true } }]) {
      expect(await first.call({ type: 'service_prepare_disconnect', requestId: id, ...change }))
        .toMatchObject({ ok: false, error: { code: 'host_protocol_invalid' } });
    }
    const report = await first.call({ type: 'service_prepare_disconnect' });
    expect(report).toEqual({ ok: true, data: { connectionId: (first.hello as { connectionId: string }).connectionId,
      stopped: true, pendingAdmissions: [], pending: [], errors: [] } });
    expect(first.socket.destroyed).toBe(false);
    expect(await first.call({ type: 'get_state' })).toMatchObject({ ok: true, data: { ready: true, host: 'ready' } });
    expect(await first.call({ type: 'start_run', input: { sessionId: 1, text: 'Must not start', modelId: 'not-saved', goalMode: 'answer' },
      expectedSettingsRevision: 1, expectedCredentialRef: 'service_owner_key_0001' }))
      .toMatchObject({ ok: false, error: { code: 'service_connection_draining' } });
    expect(await second.call({ type: 'create_session', input: { title: 'Other connection remains usable' } })).toMatchObject({ ok: true });
    expect(await first.call({ type: 'service_prepare_disconnect' })).toEqual(report);
  } finally {
    first.socket.destroy(); second.socket.destroy();
    await f.process.close(); await f.process.child.exited; removeOwnerFixture(f.installation.dataRoot);
  }
}, 90_000);

it('waits for the original owned foreground stop and does not abort another connection foreground', async () => {
  const f = await foregroundFixture(), other = await ownerClient(f.installation);
  let agent: Awaited<ReturnType<typeof ownerClient>> | undefined;
  try {
    const accepted = need(await f.client.call<{ runId: number }>({ type: 'call_provider', input: { goal: 'Controlled foreground',
      text: 'Hold until disconnect preparation.', modelId: 'service-foreground' } }));
    await waitOwner(() => f.requests.length === 1);
    expect(await other.call({ type: 'service_prepare_disconnect' })).toMatchObject({ ok: true, data: { stopped: true, pending: [] } });
    expect(await f.client.call({ type: 'query_run', runId: accepted.runId })).toMatchObject({ ok: true, data: { stoppedAt: null } });
    expect(await f.client.call({ type: 'service_prepare_disconnect' })).toMatchObject({ ok: true, data: { stopped: true,
      pending: [], pendingAdmissions: [] } });
    expect(await f.client.call({ type: 'query_run', runId: accepted.runId })).toMatchObject({ ok: true,
      data: { stoppedAt: expect.any(String), cleanup: { stopped: true } } });
    agent = await ownerClient(f.installation);
    const session = need(await agent.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Native foreground stop' } }));
    const running = need(await agent.call<{ runId: number }>({ type: 'start_run', input: { sessionId: session.sessionId,
      text: 'Hold native foreground until the original disconnect preparation.', goalMode: 'answer', modelId: 'service-foreground' },
      expectedSettingsRevision: 1, expectedCredentialRef: f.ref }));
    await waitOwner(() => f.requests.length === 2);
    expect(await agent.call({ type: 'service_prepare_disconnect' })).toMatchObject({ ok: true,
      data: { stopped: true, pending: [], pendingAdmissions: [] } });
    expect(await agent.call({ type: 'query_run', runId: running.runId })).toMatchObject({ ok: true,
      data: { stoppedAt: expect.any(String), cleanup: { stopped: true } } });
    expect(f.process.child.exitCode).toBeNull();
  } finally { agent?.socket.destroy(); other.socket.destroy(); await f.dispose(); }
}, 90_000);

it('drains the original owned native compaction and preserves another connection authority', async () => {
  const f = await foregroundFixture(), other = await ownerClient(f.installation);
  try {
    f.releaseProvider();
    const session = need(await f.client.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Native compaction drain' } }));
    for (let index = 0; index < 3; index++) {
      const accepted = need(await f.client.call<{ runId: number }>({ type: 'start_run', input: { sessionId: session.sessionId,
        text: 'original invoice item and controlled evidence '.repeat(1300), goalMode: 'answer', modelId: 'service-foreground' },
        expectedSettingsRevision: 1, expectedCredentialRef: f.ref }));
      let stopped = false;
      const end = Date.now() + 15_000;
      while (!stopped && Date.now() < end) {
        const run = need(await f.client.call<{ stoppedAt: string | null }>({ type: 'query_run', runId: accepted.runId }));
        stopped = run.stoppedAt !== null; if (!stopped) await Bun.sleep(25);
      }
      expect(stopped).toBe(true);
    }
    const snapshot = need(await f.client.call<{ commit: unknown; manualAllowed: boolean }>({ type: 'query_session_compaction', input: { sessionId: session.sessionId } }));
    expect(snapshot.manualAllowed).toBe(true);
    f.holdProvider();
    const operationId = 'acfb84d8-522f-4b5e-8885-78eb7fcaedb9';
    need(await f.client.call({ type: 'compact_session', input: { sessionId: session.sessionId, modelId: 'service-foreground',
      operationId, expected: snapshot.commit }, expectedSettingsRevision: 1, expectedCredentialRef: f.ref }));
    await waitOwner(() => f.requests.length === 4, () => JSON.stringify(f.client.frames.flatMap(frame => {
      if (frame.type !== 'event' || !('event' in frame)) return [];
      const event = frame.event as { type: string; observation?: { phase: string; nativeOutcome: string; stopped: boolean;
        generated: boolean; error: { code: string } | null } };
      return event.type === 'compaction_observation' && event.observation ? [{ phase: event.observation.phase,
        nativeOutcome: event.observation.nativeOutcome, stopped: event.observation.stopped, generated: event.observation.generated,
        errorCode: event.observation.error?.code }] : [];
    })));
    expect(await other.call({ type: 'service_prepare_disconnect' })).toMatchObject({ ok: true, data: { stopped: true } });
    expect(await f.client.call({ type: 'query_session_compaction', input: { sessionId: session.sessionId, operationId } }))
      .toMatchObject({ ok: true, data: { operation: { operationId, stopped: false } } });
    expect(await f.client.call({ type: 'service_prepare_disconnect' })).toMatchObject({ ok: true,
      data: { stopped: true, pending: [], pendingAdmissions: [] } });
    expect(await f.client.call({ type: 'query_session_compaction', input: { sessionId: session.sessionId, operationId } }))
      .toMatchObject({ ok: true, data: { operation: { operationId, stopped: true } } });
  } finally { other.socket.destroy(); await f.dispose(); }
}, 90_000);

it('keeps unknown original stop references queryable until a later positive proof on the same connection', async () => {
  const f = await foregroundFixture('hold-foreground-facts');
  try {
    const accepted = need(await f.client.call<{ runId: number }>({ type: 'call_provider', input: { goal: 'Controlled unknown foreground',
      text: 'Keep the original stop reference.', modelId: 'service-foreground' } }));
    await waitOwner(() => f.requests.length === 1);
    expect(await f.client.call({ type: 'service_prepare_disconnect' })).toMatchObject({ ok: true, data: { stopped: false,
      pending: [{ kind: 'run', runId: accepted.runId, sessionId: null }], errors: [{ code: 'foreground_stop_unconfirmed' }] } });
    expect(f.client.socket.destroyed).toBe(false);
    expect(await f.client.call({ type: 'query_run', runId: accepted.runId })).toMatchObject({ ok: true });
    f.process.child.stdin.write('release-stop-facts\n'); await f.process.child.stdin.flush();
    expect(await f.client.call({ type: 'service_prepare_disconnect' })).toMatchObject({ ok: true, data: { stopped: true,
      pending: [], pendingAdmissions: [] } });
  } finally { await f.dispose(); }
}, 90_000);

it('aborts a pending credential admission before it can create a Run and waits for its original callback', async () => {
  const f = await foregroundFixture('hold-credential-read');
  try {
    const pending = f.client.call({ type: 'call_provider', requestId: 'original-pending-admission', input: { goal: 'No admission after disconnect',
      text: 'Must not create a Run.', modelId: 'service-foreground' } });
    await waitOwner(() => f.process.messages.some(value => (value as { type: string }).type === 'fixture_credential_waiting'));
    const preparing = f.client.call({ type: 'service_prepare_disconnect' });
    need(await f.client.call({ type: 'get_state' }));
    f.process.child.stdin.write('release-credentials\n'); await f.process.child.stdin.flush();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'runtime_shutdown' } });
    expect(await preparing).toMatchObject({ ok: true, data: { stopped: true, pending: [], pendingAdmissions: [] } });
    expect(f.requests).toHaveLength(0);
    expect(f.process.child.exitCode).toBeNull();
    await f.process.close(); await f.process.child.exited;
    const db = new Database(join(f.installation.dataRoot, 'data/app.sqlite'), { readonly: true });
    try { expect(db.query('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 }); } finally { db.close(); }
  } finally { if (f.process.child.exitCode === null) f.process.child.stdin.write('release-credentials\n'); await f.dispose(); }
}, 90_000);

it('starts the actual bundled service entry only from its own installed artifact and verified account record', async () => {
  packaged ??= await packageOwnerFixture();
  const installation = await installOwnerFixture(packaged.runtimeRoot, false), file = join(installation.dataRoot, 'service-installation.json');
  const entry = join(packaged.runtimeRoot, 'apps/service.js');
  try {
    for (const args of [[], ['--installation-file', file, '--runtime-root', packaged.runtimeRoot],
      ['--installation-file', file, '--eval-case-fault-profile', '{}'], ['--installation-file', '.']]) {
      const process = Bun.spawn([Bun.which('bun')!, '--no-env-file', entry, ...args], { stdout: 'pipe', stderr: 'pipe' });
      expect(await process.exited).toBe(2);
      expect(await new Response(process.stderr).text()).toContain('service_arguments_invalid');
      expect(existsSync(join(installation.dataRoot, 'data/app.sqlite'))).toBe(false);
    }
    for (const change of [{ ownerSid: 'S-1-5-21-1-2-3-99999' }, { releaseId: '00000000-0000-4000-8000-000000000002' },
      { dataRoot: packaged.root }, { version: 2 }]) {
      writeFileSync(file, JSON.stringify({ ...installation, ...change }));
      const process = Bun.spawn([Bun.which('bun')!, '--no-env-file', entry, '--installation-file', file], { stdout: 'pipe', stderr: 'pipe' });
      expect(await process.exited).toBe(2);
      const error = await new Response(process.stderr).text();
      expect(error).toMatch(/service_(?:account_mismatch|installation_invalid|installation_incompatible)/);
      expect(error).not.toContain(installation.dataRoot);
      expect(existsSync(join(installation.dataRoot, 'data/app.sqlite'))).toBe(false);
    }
    for (const enabled of [false, true]) {
      writeFileSync(file, JSON.stringify({ ...installation, enabled, activationOperationId: '68d2369c-fbe2-43bd-857f-e3136d6ee7ce' }));
      const process = Bun.spawn([Bun.which('bun')!, '--no-env-file', entry, '--installation-file', file], { stdout: 'pipe', stderr: 'pipe' });
      expect(await process.exited).toBe(2);
      expect(await new Response(process.stderr).text()).toContain('maintenance_store_incompatible');
      expect(existsSync(join(installation.dataRoot, 'data/app.sqlite'))).toBe(false);
    }
  } finally { removeOwnerFixture(installation.dataRoot); }
}, 90_000);

it('expires a silent unauthenticated pipe candidate and accepts the next real client within a bounded wait', async () => {
  const f = await fixture();
  const silent = createConnection(servicePipeName(f.installation.installationId));
  silent.on('error', () => {});
  await once(silent, 'connect');
  let client: Awaited<ReturnType<typeof ownerClient>> | undefined;
  const connecting = ownerClient(f.installation).then(value => { client = value; return value; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const accepted = await Promise.race([connecting,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 7500); })]);
    clearTimeout(timer);
    expect(accepted?.hello).toMatchObject({ type: 'service_ready', installationId: f.installation.installationId });
    expect(silent.destroyed).toBe(true);
    expect(await accepted!.call({ type: 'get_state' })).toMatchObject({ ok: true, data: { ready: true } });
    expect(await accepted!.call({ type: 'list_sessions', input: { limit: 10 } })).toMatchObject({ ok: true, data: { items: [] } });
    expect(f.process.child.exitCode).toBeNull();
  } finally {
    clearTimeout(timer); silent.destroy(); client?.socket.destroy();
    await f.process.close(); await f.process.child.exited;
    (await connecting).socket.destroy(); removeOwnerFixture(f.installation.dataRoot);
  }
}, 90_000);

it('retains owner control and saved query access until the original Application confirms shutdown', async () => {
  packaged ??= await packageOwnerFixture();
  const installation = await installOwnerFixture(packaged.runtimeRoot), owner = await spawnOwnerFixture(installation, 'hold-close');
  const client = await ownerClient(installation);
  try {
    const session = need(await client.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Held close evidence' } }));
    expect(await owner.close()).toMatchObject({ ok: true, data: { stopped: false, closed: false,
      errors: [expect.objectContaining({ code: 'runtime_stop_unconfirmed' })] } });
    expect(owner.child.exitCode).toBeNull();
    expect(await client.call({ type: 'get_state' })).toMatchObject({ ok: true, data: { ready: false, host: 'closing' } });
    expect(await client.call({ type: 'query_session', sessionId: session.sessionId })).toMatchObject({ ok: true });
    expect(await client.call({ type: 'create_session', input: { title: 'Forbidden while closing' } }))
      .toMatchObject({ ok: false, error: { code: 'host_closing' } });
    const contender = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, 'owner-fixture.ts'), '--run',
      join(installation.dataRoot, 'service-installation.json'), installation.runtimeRoot], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    expect(await contender.exited).not.toBe(0);
    expect(await new Response(contender.stderr).text()).toContain('runtime_already_owned');
    expect(await owner.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
    expect(await owner.child.exited).toBe(0);
  } finally {
    client.socket.destroy();
    if (owner.child.exitCode === null) { await owner.close(); await owner.child.exited; }
    removeOwnerFixture(installation.dataRoot);
  }
}, 90_000);

it('rejects incompatible hello before commands and separates client disconnect from owner shutdown', async () => {
  const f = await fixture();
  try {
    for (const change of [{ protocolVersion: 2 }, { dataVersion: 20 }, { releaseId: '00000000-0000-4000-8000-000000000001' },
      { installationId: '00000000-0000-4000-8000-000000000002' }, { dataRoot: f.installation.dataRoot }]) {
      const client = await ownerClient(f.installation, change);
      if (client.hello) expect(client.hello).toMatchObject({ type: 'service_error', result: { ok: false } });
      else expect(client.socket.destroyed).toBe(true);
      client.socket.destroy();
    }
    const first = await ownerClient(f.installation), second = await ownerClient(f.installation);
    expect(first.hello).toMatchObject({ type: 'service_ready', installationId: f.installation.installationId });
    expect(second.hello).toMatchObject({ type: 'service_ready' });
    expect((first.hello as { connectionId: string }).connectionId).not.toBe((second.hello as { connectionId: string }).connectionId);
    expect(await first.call({ type: 'close' })).toMatchObject({ ok: false, error: { code: 'service_command_forbidden' } });
    expect(await first.call({ type: 'credential_response', value: { ok: true } })).toMatchObject({ ok: false });
    expect(await first.call({ type: 'cancel_run', runId: 1 })).toMatchObject({ ok: false, error: { code: 'service_command_forbidden' } });
    expect(await second.call({ type: 'invoice_form_response', requestId: 'forged-form', receipt: { runId: 1, toolCallId: 1,
      candidateId: 1, candidateSequence: 1, formInstanceId: '2dad96eb-37ea-46a4-ae5b-106a7e90f427', outcome: 'unknown',
      observedAt: '2026-10-29T00:00:00.000Z' } })).toMatchObject({ ok: false, error: { code: 'service_command_forbidden' } });
    expect(await first.call({ type: 'get_state', requestId: 'same-request' })).toMatchObject({ ok: true, data: { ready: true } });
    expect(await second.call({ type: 'get_state', requestId: 'same-request' })).toMatchObject({ ok: true, data: { ready: true } });
    expect(await first.call({ type: 'login_model', modelId: 'not-saved', authType: 'api_key', requestId: 'repeated-login' }))
      .toMatchObject({ ok: false, error: { code: 'model_not_configured' } });
    for (let index = 0; index < 4100; index++) first.socket.write(JSON.stringify({ version: 1, type: 'get_state', requestId: 'pure-read-' + index }) + '\n');
    await waitOwner(() => first.frames.filter(frame => frame.type === 'response' && 'requestId' in frame
      && typeof frame.requestId === 'string' && frame.requestId.startsWith('pure-read-')).length === 4100);
    expect(await first.call({ type: 'login_model', modelId: 'not-saved', authType: 'api_key', requestId: 'repeated-login' }))
      .toMatchObject({ ok: false, error: { code: 'auth_login_busy' } });
    expect(await second.call({ type: 'login_model', modelId: 'not-saved', authType: 'api_key', requestId: 'repeated-login' }))
      .toMatchObject({ ok: false, error: { code: 'model_not_configured' } });
    expect(await second.call({ type: 'list_sessions', input: { limit: 10 } })).toMatchObject({ ok: true, data: { items: [] } });
    first.socket.destroy();
    const session = need(await second.call<{ sessionId: number }>({ type: 'create_session', requestId: 'original-session-create',
      input: { title: 'Before rename' } }));
    expect(await second.call({ type: 'create_session', requestId: 'original-session-create', input: { title: 'Must not duplicate' } }))
      .toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    need(await second.call({ type: 'rename_session', requestId: 'original-session-rename', input: { sessionId: session.sessionId,
      title: 'Survives another client' } }));
    expect(await second.call({ type: 'rename_session', requestId: 'original-session-rename', input: { sessionId: session.sessionId,
      title: 'Must not change twice' } })).toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    const deletion = need(await second.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Delete once' } }));
    need(await second.call({ type: 'delete_session', requestId: 'original-session-delete', sessionId: deletion.sessionId }));
    expect(await second.call({ type: 'delete_session', requestId: 'original-session-delete', sessionId: deletion.sessionId }))
      .toMatchObject({ ok: false, error: { code: 'request_duplicate' } });
    expect(await second.call({ type: 'list_session_runs', input: { sessionId: session.sessionId } }))
      .toMatchObject({ ok: true, data: { items: [] } });
    second.socket.destroy();
    const reopened = await ownerClient(f.installation);
    expect(await reopened.call({ type: 'list_sessions', input: { limit: 10 } })).toMatchObject({ ok: true,
      data: { items: [expect.objectContaining({ title: 'Survives another client' })] } });
    reopened.socket.destroy();
    expect(await f.process.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
    expect(await f.process.child.exited).toBe(0);
  } finally {
    if (f.process.child.exitCode === null) { await f.process.close(); await f.process.child.exited; }
    removeOwnerFixture(f.installation.dataRoot);
  }
}, 90_000);

it('keeps a real Durable attempt alive without a desktop and reconnects and restarts by its saved receipt', async () => {
  const f = await fixture();
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer service-synthetic-key');
    requests.push(await request.json()); await gate;
    const chunk = { id: 'service-local', object: 'chat.completion.chunk', created: 1, model: 'service-local-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Review invoice evidence before accepting.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  let owner = f.process;
  const sockets: Array<{ destroy(): void }> = [];
  try {
    const ref = 'service_owner_key_0001';
    need(await createCredentialStore(join(f.installation.dataRoot, 'security/service-credentials', ref + '.json'),
      createServiceSecureStorage(f.installation.ownerSid)).write(JSON.stringify({ type: 'api_key', key: 'service-synthetic-key' })));
    const raw = readFileSync(join(f.installation.dataRoot, 'security/service-credentials', ref + '.json'), 'utf8');
    expect(raw).not.toContain('service-synthetic-key');
    const first = await ownerClient(f.installation); sockets.push(first.socket);
    const profile = { id: 'service-local', name: 'Service local', credentialRef: ref, kind: 'custom', providerId: null,
      baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'service-local-model', api: 'openai-completions',
      contextWindow: 64000, maxTokens: 8192, reasoning: false };
    need(await first.call({ type: 'save_settings', settings: { ...defaultProductSettings(), version: 6, revision: 0,
      profile: { displayName: 'Service owner test', theme: 'system' }, models: [profile], defaultModelId: profile.id,
      updatedAt: '2026-10-29T00:00:00.000Z' } }));
    const sourceText = 'Controlled invoice total 113.00';
    const document = need(await first.call<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
      contract: 'flowmate-prepared-invoice/v1', sample: 'service-owner-controlled', sourceText,
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
    } }));
    const original = P.PersonalAgentSnapshotSchema.parse(need(await first.call({ type: 'personal_agent_get', input: {} })));
    const agent = P.PersonalAgentSnapshotSchema.parse(need(await first.call({ type: 'personal_agent_update', input: {
      personalAgentId: original.personalAgentId, expectedRevision: original.revision, configuration: { ...original.configuration,
        modelId: profile.id, resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'] },
    } })));
    const input = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'owner-original-create', goal: 'Organize the original invoice.', documents: [document.documentRef] };
    const created = P.InvoiceWorkCreateReceiptSchema.parse(need(await first.call({ type: 'invoice_work_create', input })));
    await waitOwner(() => requests.length === 1);
    const tasks = P.PersonalTaskListResultSchema.parse(need(await first.call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } })));
    const runId = tasks.items[0]!.attempt.runId!;
    const subscriptionId = '652632a1-30e9-405c-9636-56b4dbcb298a';
    const eventInput = { runId, sessionId: created.sessionId, cursor: { runId, lastPersistedSequence: 0 } };
    need(await first.call({ type: 'subscribe_runtime_events', subscriptionId, ownerToken: 'arbitrary-client-owner', input: eventInput }));
    const foreign = await ownerClient(f.installation); sockets.push(foreign.socket);
    expect(await foreign.call({ type: 'unsubscribe_runtime_events', subscriptionId,
      ownerToken: (first.hello as { connectionId: string }).connectionId })).toMatchObject({ ok: false, error: { code: 'service_command_forbidden' } });
    expect(await foreign.call({ type: 'query_runtime_events', ownerToken: (first.hello as { connectionId: string }).connectionId,
      input: { ...eventInput, subscriptionId } })).toMatchObject({ ok: false, error: { code: 'service_command_forbidden' } });
    foreign.socket.destroy();
    first.socket.destroy();
    const second = await ownerClient(f.installation); sockets.push(second.socket);
    expect(await second.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId,
      requestId: input.requestId } })).toEqual({ ok: true, data: created });
    expect(requests).toHaveLength(1);
    release();
    let finished = false;
    const end = Date.now() + 15_000;
    while (!finished && Date.now() < end) {
      const tasks = P.PersonalTaskListResultSchema.parse(need(await second.call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } })));
      finished = tasks.items.some(task => task.attempt.attemptId === created.execution.attempt?.attemptId
        && task.stoppedAt !== null && task.runStatus === 'completed');
      if (!finished) await Bun.sleep(30);
    }
    expect(finished).toBe(true);
    second.socket.destroy();
    expect(await owner.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
    expect(await owner.child.exited).toBe(0);
    owner = await spawnOwnerFixture(f.installation);
    const third = await ownerClient(f.installation); sockets.push(third.socket);
    expect(await third.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId,
      requestId: input.requestId } })).toEqual({ ok: true, data: created });
    const restartedTasks = P.PersonalTaskListResultSchema.parse(need(await third.call({ type: 'personal_task_list', input: { workId: created.workId, limit: 10 } })));
    expect(restartedTasks.items).toHaveLength(1);
    expect(restartedTasks.items[0]!.attempt.attemptId).toBe(created.execution.attempt!.attemptId);
    expect(requests).toHaveLength(1);
    expect(owner.stderr()).not.toContain('service-synthetic-key');
    expect(existsSync(join(f.installation.dataRoot, 'security/credentials', ref + '.json'))).toBe(false);
    gate = new Promise<void>(resolve => { release = resolve; });
    const recoveryInput = { ...input, requestId: 'owner-original-interrupted' };
    const interrupted = P.InvoiceWorkCreateReceiptSchema.parse(need(await third.call({ type: 'invoice_work_create', input: recoveryInput })));
    await waitOwner(() => requests.length === 2);
    const beforeShutdown = P.PersonalTaskListResultSchema.parse(need(await third.call({ type: 'personal_task_list', input: { workId: interrupted.workId, limit: 10 } })));
    expect(beforeShutdown.items).toHaveLength(1);
    third.socket.destroy();
    expect(await owner.close()).toMatchObject({ ok: true, data: { stopped: true, closed: true } });
    expect(await owner.child.exited).toBe(0);
    owner = await spawnOwnerFixture(f.installation);
    const fourth = await ownerClient(f.installation); sockets.push(fourth.socket);
    expect(await fourth.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId,
      requestId: recoveryInput.requestId } })).toEqual({ ok: true, data: interrupted });
    await waitOwner(() => requests.length === 3);
    release();
    let recovered = false;
    const recoveryDeadline = Date.now() + 15_000;
    while (!recovered && Date.now() < recoveryDeadline) {
      const attempts = P.PersonalTaskListResultSchema.parse(need(await fourth.call({ type: 'personal_task_list', input: { workId: interrupted.workId, limit: 10 } })));
      expect(attempts.items).toHaveLength(1);
      expect(attempts.items[0]!.attempt.attemptId).toBe(beforeShutdown.items[0]!.attempt.attemptId);
      recovered = attempts.items[0]!.stoppedAt !== null && attempts.items[0]!.runStatus === 'completed';
      if (!recovered) await Bun.sleep(50);
    }
    expect(recovered).toBe(true);
    expect(requests).toHaveLength(3);
  } finally {
    release(); for (const socket of sockets) socket.destroy();
    if (owner.child.exitCode === null) { await owner.close(); await owner.child.exited; }
    server.stop(true); removeOwnerFixture(f.installation.dataRoot);
  }
}, 90_000);

it('recovers the original Durable Task after its owned Bun process is killed and preserves interrupted Legacy write uncertainty', async () => {
  const f = await fixture(), databaseFile = join(f.installation.dataRoot, 'data/app.sqlite');
  let owner = f.process, release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const children = new Set([owner.child]), sockets: Array<{ destroy(): void }> = [];
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-owner-crash-key');
    requests.push(await request.json()); await gate;
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant',
      content: 'The original invoice still needs human review.' }, finish_reason: 'stop' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  async function killOwned() {
    const child = owner.child, pid = child.pid;
    expect(children.has(child)).toBe(true);
    expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
    expect(owner.child).toBe(child); expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    expect(await child.exited).not.toBe(0);
    expect(owner.messages.some(value => (value as { type: string }).type === 'fixture_close')).toBe(false);
  }
  async function reopen() {
    // Wait for the existing 15-second controller heartbeat lease; never remove or age its lock.
    await waitOwner(() => !existsSync(databaseFile + '.lock') || Date.now() - statSync(databaseFile + '.lock').mtimeMs > 15_000);
    owner = await spawnOwnerFixture(f.installation); children.add(owner.child);
    const client = await ownerClient(f.installation); sockets.push(client.socket); return client;
  }
  function nativeFacts(workId: number) {
    const db = new Database(databaseFile, { readonly: true });
    try { return { phases: db.query(`SELECT id,attempt_id,request_id,native_conversation_id,native_submission_id
      FROM invoice_work_phases WHERE work_id=? ORDER BY id`).all(workId),
    tasks: db.query('SELECT id FROM fm_durable_tasks ORDER BY id').all() }; }
    finally { db.close(); }
  }
  try {
    const ref = 'service_owner_crash_key_01';
    need(await createCredentialStore(join(f.installation.dataRoot, 'security/service-credentials', ref + '.json'),
      createServiceSecureStorage(f.installation.ownerSid)).write(JSON.stringify({ type: 'api_key', key: 'synthetic-owner-crash-key' })));
    const first = await ownerClient(f.installation); sockets.push(first.socket);
    const profile = { id: 'owner-crash-model', name: 'Owner crash model', credentialRef: ref, kind: 'custom', providerId: null,
      baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'owner-crash-model', api: 'openai-completions',
      contextWindow: 64000, maxTokens: 8192, reasoning: false };
    need(await first.call({ type: 'save_settings', settings: { ...defaultProductSettings(), revision: 0,
      models: [profile], defaultModelId: profile.id } }));
    const sourceText = 'Isolated owner crash invoice total 113.00';
    const document = need(await first.call<DocumentSnapshot>({ type: 'import_prepared_invoice_material', input: {
      contract: 'flowmate-prepared-invoice/v1', sample: 'owner-crash', sourceText,
      original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
      pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
    } }));
    const initial = P.PersonalAgentSnapshotSchema.parse(need(await first.call({ type: 'personal_agent_get', input: {} })));
    const agent = P.PersonalAgentSnapshotSchema.parse(need(await first.call({ type: 'personal_agent_update', input: {
      personalAgentId: initial.personalAgentId, expectedRevision: initial.revision, configuration: { ...initial.configuration,
        modelId: profile.id, resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: ['read_invoice_document'] },
    } })));
    const input = { personalAgentId: agent.personalAgentId, expectedAgentRevision: agent.revision,
      requestId: 'owner-crash-original-work', goal: 'Review this isolated invoice.', documents: [document.documentRef] };
    const receipt = P.InvoiceWorkCreateReceiptSchema.parse(need(await first.call({ type: 'invoice_work_create', input })));
    await waitOwner(() => requests.length === 1);
    const before = P.PersonalTaskListResultSchema.parse(need(await first.call({ type: 'personal_task_list', input: { workId: receipt.workId, limit: 10 } })));
    expect(before.items).toHaveLength(1); expect(before.items[0]!.stoppedAt).toBeNull();
    await killOwned(); first.socket.destroy(); release();
    const native = nativeFacts(receipt.workId); expect(native.phases).toHaveLength(1); expect(native.tasks.length).toBeGreaterThan(0);
    gate = new Promise<void>(resolve => { release = resolve; });
    const second = await reopen();
    await waitOwner(() => requests.length === 2);
    expect(await second.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId,
      requestId: input.requestId } })).toEqual({ ok: true, data: receipt });
    const resumed = P.PersonalTaskListResultSchema.parse(need(await second.call({ type: 'personal_task_list', input: { workId: receipt.workId, limit: 10 } })));
    expect(resumed.items).toHaveLength(1); expect(resumed.items[0]!.attempt).toEqual(before.items[0]!.attempt);
    release();
    let finished = false;
    const deadline = Date.now() + 15_000;
    while (!finished && Date.now() < deadline) {
      const saved = P.PersonalTaskListResultSchema.parse(need(await second.call({ type: 'personal_task_list', input: { workId: receipt.workId, limit: 10 } })));
      expect(saved.items).toHaveLength(1); expect(saved.items[0]!.attempt).toEqual(before.items[0]!.attempt);
      finished = saved.items[0]!.runStatus === 'completed' && saved.items[0]!.stoppedAt !== null;
      if (!finished) await Bun.sleep(30);
    }
    expect(finished).toBe(true); expect(requests).toHaveLength(2);

    gate = new Promise<void>(resolve => { release = resolve; });
    const session = need(await second.call<{ sessionId: number }>({ type: 'create_session', input: { title: 'Interrupted Legacy foreground' } }));
    const legacy = need(await second.call<{ runId: number }>({ type: 'start_run', input: { sessionId: session.sessionId,
      text: 'Retain the original Legacy request after the owner disappears.', goalMode: 'answer', modelId: profile.id },
      expectedSettingsRevision: 1, expectedCredentialRef: ref }));
    await waitOwner(() => requests.length === 3);
    expect(await second.call({ type: 'query_run', runId: legacy.runId })).toMatchObject({ ok: true, data: { status: 'running', stoppedAt: null } });
    await killOwned(); second.socket.destroy(); release();
    const retainedNative = nativeFacts(receipt.workId);
    expect(retainedNative.phases).toEqual(native.phases); expect(retainedNative.tasks).toEqual(expect.arrayContaining(native.tasks));
    const db = new Database(databaseFile), stamp = new Date().toISOString();
    const argumentsJson = JSON.stringify({ version: 1, raw: { path: 'isolated-unknown.txt' }, final: { path: 'isolated-unknown.txt' } });
    let toolCallId: number;
    try {
      const binding = db.query<{ current_context_snapshot_id: number | null }, [number]>(
        'SELECT current_context_snapshot_id FROM runs WHERE id=?').get(legacy.runId);
      expect(binding?.current_context_snapshot_id).toBeGreaterThan(0);
      // Seed only an interrupted write record; no file, Shell or external write is executed.
      const inserted = db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,
        status,delivery_json,cleanup_json,requested_at,started_at,context_snapshot_id,request_sequence) VALUES (?,?,'owner-crash-unknown-write','write','1','LOCAL_WRITE',?,
        'running',?,?,?,?,?,1)`).run(legacy.runId, session.sessionId, argumentsJson,
        JSON.stringify({ version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null }),
        JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [] }), stamp, stamp, binding!.current_context_snapshot_id);
      toolCallId = Number(inserted.lastInsertRowid);
    } finally { db.close(); }
    const third = await reopen();
    expect(await third.call({ type: 'query_run', runId: legacy.runId })).toMatchObject({ ok: true, data: {
      status: 'failed', error: { code: 'runtime_interrupted' }, stoppedAt: null, cleanup: { stopped: false, lateObservationRequired: true } } });
    expect(await third.call({ type: 'query_runtime_state' })).toMatchObject({ ok: true, data: { blocked: true } });
    expect(await third.call({ type: 'call_provider', input: { goal: 'Must not replay an uncertain Legacy write', text: '', modelId: profile.id } }))
      .toMatchObject({ ok: false, error: { code: 'runtime_unusable' } });
    expect(await third.call({ type: 'invoice_work_query_operation', input: { operation: 'create', personalAgentId: agent.personalAgentId,
      requestId: input.requestId } })).toEqual({ ok: true, data: receipt });
    const retained = P.PersonalTaskListResultSchema.parse(need(await third.call({ type: 'personal_task_list', input: { workId: receipt.workId, limit: 10 } })));
    expect(retained.items).toHaveLength(1); expect(retained.items[0]!.attempt).toEqual(before.items[0]!.attempt);
    expect(retained.items[0]!).toMatchObject({ runStatus: 'completed', stoppedAt: expect.any(String) });
    expect(requests).toHaveLength(3);
    await killOwned(); third.socket.destroy();
    const audit = new Database(databaseFile, { readonly: true });
    try {
      const call = audit.query<{ args_json: string; started_at: string; stopped_at: string | null; status: string; cleanup_json: string; result_json: string }, [number]>(
        'SELECT args_json,started_at,stopped_at,status,cleanup_json,result_json FROM tool_calls WHERE id=?').get(toolCallId)!;
      expect(call).toMatchObject({ args_json: argumentsJson, started_at: stamp, stopped_at: null, status: 'failed' });
      expect(JSON.parse(call.cleanup_json)).toMatchObject({ stopped: false });
      expect(JSON.parse(call.result_json)).toMatchObject({ error: { code: 'runtime_interrupted' } });
      expect(audit.query('SELECT count(*) AS n FROM runs WHERE session_id=?').get(session.sessionId)).toEqual({ n: 1 });
    } finally { audit.close(); }
    expect(requests).toHaveLength(3);
  } finally {
    release(); for (const socket of sockets) socket.destroy();
    if (owner.child.exitCode === null) await killOwned();
    server.stop(true); removeOwnerFixture(f.installation.dataRoot);
  }
}, 90_000);
