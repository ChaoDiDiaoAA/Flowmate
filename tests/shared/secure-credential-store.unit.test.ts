import { mkdtemp } from '../support/resources.ts';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createCredentialStore } from '../../packages/shared/src/secure-credential-store.ts';
import type { SecureStoragePort } from '../../packages/shared/src/secure-credential-store.ts';

function fakeSecureStorage(available = true): SecureStoragePort {
  return {
    isAvailable: async () => available,
    encrypt: async (plaintext) => Buffer.from(`sealed:${plaintext}`),
    decrypt: async (ciphertext) => ({ plaintext: Buffer.from(ciphertext).toString('utf8').replace(/^sealed:/, ''), shouldReEncrypt: false }),
  };
}

describe('encrypted credential store', () => {
  it('stores ciphertext only and reports status without revealing the value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-credential-'));
    const file = join(root, 'secrets', 'key.json');
    const store = createCredentialStore(file, fakeSecureStorage());
    expect(await store.status()).toBe('missing');
    expect(await store.write('synthetic-test-key')).toEqual({ ok: true, data: undefined });
    expect(await store.status()).toBe('configured');
    expect(await readFile(file, 'utf8')).not.toContain('synthetic-test-key');
    expect(await store.read()).toEqual({ ok: true, data: 'synthetic-test-key' });
    expect(await store.remove()).toEqual({ ok: true, data: undefined });
    expect(await store.status()).toBe('missing');
  });

  it('refuses plaintext fallback when system secure storage is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-credential-'));
    const file = join(root, 'key.json');
    const store = createCredentialStore(file, fakeSecureStorage(false));
    const result = await store.write('synthetic-test-key');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('credential_storage_unavailable');
    expect(await store.status()).toBe('unavailable');
  });
});
