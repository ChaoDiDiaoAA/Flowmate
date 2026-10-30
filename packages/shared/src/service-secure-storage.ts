import { join } from 'node:path';
import type { SecureStoragePort } from './secure-credential-store.ts';
import { readCurrentWindowsSid, windowsSystemDirectory } from './windows-identity.ts';

/** Windows DPAPI CurrentUser. The owner SID comes from the trusted installation record. */
export function createServiceSecureStorage(ownerSid: string): SecureStoragePort {
  async function account(): Promise<void> {
    const current = await readCurrentWindowsSid();
    if (!current.ok) throw new Error(current.error.code);
    if (current.data !== ownerSid) throw new Error('service_account_mismatch');
  }

  async function transform(input: Uint8Array, decrypt: boolean): Promise<Uint8Array> {
    await account();
    const failure = decrypt ? 'service_credential_decrypt_failed' : 'service_credential_encrypt_failed';
    if (!input.byteLength || input.byteLength > 0xffffffff) throw new Error(failure);
    const directory = await windowsSystemDirectory();
    const { dlopen, ptr, toBuffer } = await import('bun:ffi');
    const kernel = dlopen(join(directory, 'kernel32.dll'), { LocalFree: { args: ['u64'], returns: 'u64' } });
    try {
      const crypto = dlopen(join(directory, 'crypt32.dll'), {
        CryptProtectData: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'u32', 'ptr'], returns: 'i32' },
        CryptUnprotectData: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'u32', 'ptr'], returns: 'i32' },
      });
      // DATA_BLOB is DWORD + alignment + pointer on the supported Windows x64 runtime.
      const source = new BigUint64Array([BigInt(input.byteLength), BigInt(ptr(input))]);
      const output = new BigUint64Array(2);
      try {
        const operation = decrypt ? crypto.symbols.CryptUnprotectData : crypto.symbols.CryptProtectData;
        // UI_FORBIDDEN, without LOCAL_MACHINE: protection belongs to this Windows user.
        if (!operation(source, null, null, null, null, 1, output) || !output[1]) throw new Error(failure);
        const length = new DataView(output.buffer).getUint32(0, true);
        if (!length) throw new Error(failure);
        const native = toBuffer(output[1], 0, length);
        try { return Uint8Array.from(native); }
        finally { if (decrypt) native.fill(0); }
      } finally {
        if (output[1]) kernel.symbols.LocalFree(output[1]);
        crypto.close();
      }
    } catch { throw new Error(failure); }
    finally { kernel.close(); }
  }

  return {
    async isAvailable() {
      try {
        const probe = await transform(new Uint8Array([1]), false);
        const restored = await transform(probe, true);
        return restored.length === 1 && restored[0] === 1;
      } catch { return false; }
    },
    async encrypt(plaintext) {
      const input = new TextEncoder().encode(plaintext);
      try { return await transform(input, false); }
      finally { input.fill(0); }
    },
    async decrypt(ciphertext) {
      const plaintext = await transform(ciphertext, true);
      try { return { plaintext: new TextDecoder('utf-8', { fatal: true }).decode(plaintext), shouldReEncrypt: false }; }
      catch { throw new Error('service_credential_decrypt_failed'); }
      finally { plaintext.fill(0); }
    },
  };
}
