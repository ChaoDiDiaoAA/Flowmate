import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductCommandDispatcher } from '../../apps/host/dispatch.ts';
import { parseHostCommand, type HostOutput } from '../../apps/host/protocol.ts';
import { mkdtempSync } from '../support/resources.ts';
import type { Result } from '@flowmate/contracts';
import { CloudMemoryCommandSchema, parseMemoryCommand, parseMemoryHostResult } from '@flowmate/contracts';
import { Database } from 'bun:sqlite';

function need<T>(value: Result<T>): T { if (!value.ok) throw Error(value.error.code); return value.data; }

test('the desktop Host exposes only owner-scoped memory commands and checks their inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-memory-host-')), outputs: HostOutput[] = [];
  const dispatcher = need(await createProductCommandDispatcher({ userDataRoot: root, invoiceSourceRoot: join(root, 'invoices'),
    send: async output => { outputs.push(output); }, memory: { owner: { environment: 'local', ownerId: 'local-owner' },
      readCredential: async () => 'synthetic-memory-secret', initialConnection: { endpoint: 'http://127.0.0.1:19338',
        accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent', credentialRef: 'synthetic-reference',
        recallEnabled: true, captureMode: 'explicit' } } }));
  try {
    const request = { version: 1, requestId: '11111111-1111-4111-8111-111111111111', type: 'memory_get_settings', input: {} };
    expect(parseHostCommand(request)).not.toBeNull();
    await dispatcher.dispatch(request);
    const reply = outputs.find(output => output.type === 'response' && output.requestId === request.requestId);
    expect(reply).toMatchObject({ value: { ok: true, data: { settings: { provider: 'openviking' }, identity: { userId: 'alice' } } } });
    expect(JSON.stringify(reply)).not.toContain('synthetic-memory-secret');
    expect(JSON.stringify(reply)).not.toContain('synthetic-reference');
    expect(parseHostCommand({ ...request, input: { ownerId: 'another-owner' } })).toBeNull();
  } finally { need(await dispatcher.close()); }
});

test('the memory transport rejects a receipt for a different original entry', () => {
  const command = parseMemoryCommand({ type: 'memory_forget', input: { entryId: 1, expectedRevision: 1, requestId: 'original-forget', confirmed: true } });
  if (!command) throw Error('Missing controlled command.');
  expect(parseMemoryHostResult(command, { ok: true, data: { entryId: 2, requestId: 'original-forget', state: 'completed' } })).toBeNull();
});

test('memory search accepts only scoped source identities across local and cloud transports', () => {
  const local = { query: 'invoice', source: { kind: 'session', sessionId: 1, inputId: 2 } };
  const command = parseMemoryCommand({ type: 'memory_search', input: local });
  expect(command).not.toBeNull();
  expect(parseMemoryCommand({ type: 'memory_search', input: { ...local, ownerId: 'forged' } })).toBeNull();
  expect(CloudMemoryCommandSchema.safeParse({ type: 'cloud_memory_search', input: local }).success).toBe(false);
  expect(CloudMemoryCommandSchema.safeParse({ type: 'cloud_memory_search', input: { query: 'invoice',
    source: { kind: 'work', workId: 1, itemId: 2, phaseId: 3 } } }).success).toBe(true);
  expect(parseMemoryHostResult(command!, { ok: true, data: { status: 'ready', items: [] } })).toBeNull();
});

test('a trusted local configuration creates one installation identity and restores it on Host restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-memory-host-setup-')), outputs: HostOutput[] = [];
  let role = 'admin';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ status: 'ok', version: '0.4.23',
    auth_mode: 'api_key', role, account_id: 'account', user_id: 'alice' }) });
  const create = async () => need(await createProductCommandDispatcher({ userDataRoot: root, invoiceSourceRoot: join(root, 'invoices'),
    send: async output => { outputs.push(output); }, memoryCredentialRead: async ref => ref === 'memory_12345678901234567890123456789012' ? 'synthetic-secret' : undefined }));
  let dispatcher = await create();
  const command = { version: 1, requestId: '22222222-2222-4222-8222-222222222222', type: 'memory_configure',
    input: { expectedRevision: 0, endpoint: `http://127.0.0.1:${server.port}`, accountId: 'account', userId: 'alice', peerId: 'flowmate.alice.agent',
      credentialRef: 'memory_12345678901234567890123456789012', recallEnabled: true, captureMode: 'explicit' as const } };
  try {
    expect(parseHostCommand({ ...command, input: { ...command.input, ownerId: 'forged' } })).toBeNull();
    await dispatcher.dispatch(command);
    expect(outputs.find(output => output.type === 'response' && output.requestId === command.requestId))
      .toMatchObject({ value: { ok: false, error: { code: 'memory_identity_unavailable' } } });
    outputs.length = 0; role = 'user';
    await dispatcher.dispatch(command);
    expect(outputs.find(output => output.type === 'response' && output.requestId === command.requestId))
      .toMatchObject({ value: { ok: true, data: { settings: { revision: 1, provider: 'openviking' } } } });
    expect(await dispatcher.inspectMemory(command.input)).toMatchObject({ ok: true, data: { settings: { revision: 1 } } });
    expect(await dispatcher.inspectMemory({ ...command.input, credentialRef: 'memory_99999999999999999999999999999999' })).toEqual({ ok: true, data: null });
    const inspection = { ...command, requestId: '44444444-4444-4444-8444-444444444444', type: 'memory_inspect_configuration' };
    await dispatcher.dispatch(inspection);
    expect(outputs.find(output => output.type === 'response' && output.requestId === inspection.requestId))
      .toMatchObject({ value: { ok: true, data: { settings: { revision: 1 } } } });
    need(await dispatcher.close());
    const db = new Database(join(root, 'data/app.sqlite'), { readonly: true });
    let ownerId: string;
    try { ownerId = db.query<{ owner_id: string }, []>("SELECT owner_id FROM memory_identities WHERE environment='local'").get()!.owner_id; }
    finally { db.close(); }
    expect(ownerId).toMatch(/^[0-9a-f-]{36}$/);
    dispatcher = await create();
    const query = { version: 1, requestId: '33333333-3333-4333-8333-333333333333', type: 'memory_get_settings', input: {} };
    await dispatcher.dispatch(query);
    expect(outputs.find(output => output.type === 'response' && output.requestId === query.requestId))
      .toMatchObject({ value: { ok: true, data: { settings: { revision: 1, provider: 'openviking' }, identity: { userId: 'alice' } } } });
  } finally { need(await dispatcher.close()); server.stop(true); }
});
