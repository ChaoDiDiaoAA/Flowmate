import { safeStorage } from 'electron';
import type { SecureStoragePort } from '../../../packages/shared/src/secure-credential-store.ts';

export const systemSecureStorage: SecureStoragePort = {
  async isAvailable() {
    try {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'system';
      return available && safeStorage.isEncryptionAvailable() && backend !== 'basic_text' && backend !== 'unknown';
    } catch { return false; }
  },
  encrypt: (plaintext) => safeStorage.encryptStringAsync(plaintext),
  async decrypt(ciphertext) {
    const result = await safeStorage.decryptStringAsync(Buffer.from(ciphertext));
    return { plaintext: result.result, shouldReEncrypt: result.shouldReEncrypt };
  },
};
