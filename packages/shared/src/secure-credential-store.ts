import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appError, fail, ok } from '@flowmate/contracts';
import type { Result } from '@flowmate/contracts';

export type SecureStoragePort = {
  isAvailable(): Promise<boolean>;
  encrypt(plaintext: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<{ plaintext: string; shouldReEncrypt: boolean }>;
};

export type CredentialStatus = 'missing' | 'configured' | 'unavailable';

export type CredentialStore = {
  status(): Promise<CredentialStatus>;
  read(): Promise<Result<string | null>>;
  write(apiKey: string): Promise<Result<void>>;
  remove(): Promise<Result<void>>;
};

function parseEnvelope(value: unknown): { version: 1; ciphertext: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.ciphertext === 'string' && record.ciphertext.length > 0
    ? { version: 1, ciphertext: record.ciphertext }
    : null;
}

export function createCredentialStore(file: string, secureStorage: SecureStoragePort): CredentialStore {
  async function readEnvelope(): Promise<{ version: 1; ciphertext: string } | null> {
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new Error('credential_file_unavailable');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error('credential_file_invalid'); }
    const envelope = parseEnvelope(parsed);
    if (!envelope) throw new Error('credential_file_invalid');
    return envelope;
  }

  async function writeCiphertext(ciphertext: Uint8Array): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(dirname(file), { recursive: true });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ version: 1, ciphertext: Buffer.from(ciphertext).toString('base64') })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
    } catch {
      try { await handle?.close(); } catch { /* preserve original failure */ }
      try { await rm(temporary, { force: true }); } catch { /* preserve original failure */ }
      throw new Error('credential_write_failed');
    }
  }

  return {
    async status() {
      try {
        if (!await secureStorage.isAvailable()) return 'unavailable';
        return await readEnvelope() ? 'configured' : 'missing';
      } catch { return 'unavailable'; }
    },
    async read() {
      try {
        if (!await secureStorage.isAvailable()) return fail(appError('credential_storage_unavailable', 'input', '系统安全存储不可用。'));
        const envelope = await readEnvelope();
        if (!envelope) return ok(null);
        const decrypted = await secureStorage.decrypt(Buffer.from(envelope.ciphertext, 'base64'));
        if (!decrypted.plaintext) return fail(appError('credential_invalid', 'storage', '本地模型凭据不可用。'));
        if (decrypted.shouldReEncrypt) await writeCiphertext(await secureStorage.encrypt(decrypted.plaintext));
        return ok(decrypted.plaintext);
      } catch {
        return fail(appError('credential_read_failed', 'storage', '本地模型凭据读取失败。'));
      }
    },
    async write(apiKey) {
      try {
        if (!apiKey.trim()) return fail(appError('credential_invalid', 'input', 'API Key 不能为空。'));
        if (!await secureStorage.isAvailable()) return fail(appError('credential_storage_unavailable', 'input', '系统安全存储不可用，拒绝明文保存。'));
        await writeCiphertext(await secureStorage.encrypt(apiKey));
        return ok(undefined);
      } catch {
        return fail(appError('credential_write_failed', 'storage', '本地模型凭据保存失败。'));
      }
    },
    async remove() {
      try {
        await rm(file, { force: true });
        return ok(undefined);
      } catch {
        return fail(appError('credential_remove_failed', 'storage', '本地模型凭据删除失败。'));
      }
    },
  };
}
