import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import * as core from '@flowmate/core';
import { appError, fail, ok, type MemorySettings } from '@flowmate/contracts';
import { mkdtempSync } from '../support/resources.ts';
const userHealth = (async () => Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key', role: 'user', account_id: 'account', user_id: 'alice' })) as unknown as typeof fetch;

test('a lost service memory configuration response is reconciled by its original operation', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'flowmate-service-memory-'));
  const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const secureStorage = { isAvailable: async () => true, encrypt: async (text: string) => Buffer.from(`sealed:${text}`),
    decrypt: async (bytes: Uint8Array) => ({ plaintext: Buffer.from(bytes).toString().slice(7), shouldReEncrypt: false }) };
  let calls = 0, savedRef = '', view: { settings: MemorySettings; identity: { accountId: string; userId: string; peerId: string } } | null = null;
  const controller = {
    async configure(input: { credentialRef: string; expectedRevision: number; endpoint: string; accountId: string; userId: string; peerId: string;
      recallEnabled: boolean; captureMode: 'off' | 'explicit' | 'auto' }) {
      calls++; savedRef = input.credentialRef;
      view = { settings: { revision: input.expectedRevision + 1, provider: 'openviking', endpoint: input.endpoint,
        recallEnabled: input.recallEnabled, captureMode: input.captureMode, updatedAt: '2026-11-07T00:00:00.000Z' },
        identity: { accountId: input.accountId, userId: input.userId, peerId: input.peerId } };
      throw Error('controlled lost response');
    },
    async inspect(input: { credentialRef: string }) { return ok(input.credentialRef === savedRef ? view : null); },
  };
  const service = core.createServiceMemoryCredentialService({ installationId, dataRoot, secureStorage, controller, fetch: userHealth });
  const request = { installationId, operationId, expectedRevision: 0, endpoint: 'http://127.0.0.1:19338', accountId: 'account', userId: 'alice',
    peerId: 'flowmate.alice.agent', recallEnabled: true, captureMode: 'explicit' as const, apiKey: 'synthetic-service-key' };
  expect(await service.configure(request)).toMatchObject({ ok: false, error: { code: 'operation_result_unknown' } });
  const recovered = await service.query({ installationId, operationId });
  expect(recovered).toMatchObject({ ok: true, data: { operationId, phase: 'committed', settings: { settings: { revision: 1 } } } });
  expect(JSON.stringify(recovered)).not.toContain('synthetic-service-key');
  if (!recovered.ok || !recovered.data) throw Error('Missing recovered receipt.');
  expect(await service.configure(request)).toEqual({ ok: true, data: recovered.data });
  expect(await service.configure({ ...request, endpoint: 'http://127.0.0.1:19339' })).toMatchObject({ ok: false, error: { code: 'service_memory_operation_conflict' } });
  expect(await service.configure({ ...request, apiKey: 'different-key' })).toMatchObject({ ok: false, error: { code: 'service_memory_operation_conflict' } });
  expect(calls).toBe(1);
});

test('a rejected service identity is recorded as failed and never silently reconfigured', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'flowmate-service-memory-rejected-'));
  const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const secureStorage = { isAvailable: async () => true, encrypt: async (text: string) => Buffer.from(`sealed:${text}`),
    decrypt: async (bytes: Uint8Array) => ({ plaintext: Buffer.from(bytes).toString().slice(7), shouldReEncrypt: false }) };
  let attempts = 0;
  const service = core.createServiceMemoryCredentialService({ installationId, dataRoot, secureStorage, fetch: userHealth, controller: {
    configure: async () => { attempts++; return fail(appError('memory_identity_unavailable', 'runtime', 'Not authorized.')); },
    inspect: async () => ok(null) } });
  const input = { installationId, operationId, expectedRevision: 0, endpoint: 'http://127.0.0.1:19338', accountId: 'account', userId: 'alice',
    peerId: 'flowmate.alice.agent', recallEnabled: true, captureMode: 'explicit' as const, apiKey: 'synthetic-service-key' };
  expect(await service.configure(input)).toMatchObject({ ok: true, data: { phase: 'failed', errorCode: 'memory_identity_unavailable' } });
  expect(await service.query({ installationId, operationId })).toMatchObject({ ok: true, data: { phase: 'failed' } });
  expect(await service.configure(input)).toMatchObject({ ok: true, data: { phase: 'failed' } });
  expect(attempts).toBe(1);
});

test('service memory setup refuses a Root key before saving an operation or credential', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'flowmate-service-memory-root-'));
  const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const secureStorage = { isAvailable: async () => true, encrypt: async (text: string) => Buffer.from(`sealed:${text}`),
    decrypt: async (bytes: Uint8Array) => ({ plaintext: Buffer.from(bytes).toString().slice(7), shouldReEncrypt: false }) };
  const fetch = (async () => Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key', role: 'root', account_id: 'account', user_id: 'alice' })) as unknown as typeof globalThis.fetch;
  const service = core.createServiceMemoryCredentialService({ installationId, dataRoot, secureStorage, fetch,
    controller: { configure: async () => { throw Error('Must not configure.'); }, inspect: async () => ok(null) } });
  const input = { installationId, operationId, expectedRevision: 0, endpoint: 'http://127.0.0.1:19338', accountId: 'account', userId: 'alice',
    peerId: 'flowmate.alice.agent', recallEnabled: true, captureMode: 'explicit' as const, apiKey: 'synthetic-root-key' };
  expect(await service.configure(input)).toMatchObject({ ok: false, error: { code: 'memory_identity_unavailable' } });
  expect(existsSync(join(dataRoot, 'security/service-memory-credentials'))).toBe(false);
  expect(await service.query({ installationId, operationId })).toEqual({ ok: true, data: null });
});
