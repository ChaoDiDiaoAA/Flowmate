import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InstanceFileStore, validateRelativePath } from '../../packages/core/src/storage/file-store.ts';
import { sha256Bytes } from '../../packages/shared/src/index.ts';
import { JsonlLogger } from '../../packages/logging/src/writer.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('P0 controlled infrastructure', () => {
  it('rejects traversal, Windows device and alternate separator paths', () => {
    for (const value of ['../secret', 'a/../../secret', 'C:/secret', '\\\\server\\share', 'CON.txt', 'a\\b', 'a/thing:stream', 'a/file.', 'a/file ', '//server/share', '/absolute', '', 'https://invalid.example/file']) {
      expect(() => validateRelativePath(value)).toThrow();
    }
    expect(validateRelativePath('assets/images/file.jpg')).toBe('assets/images/file.jpg');
  });

  it('redacts diagnostic fields and enters visible degraded mode at the quota', async () => {
    const root = await mkdtemp(join(process.env.TEMP ?? '.', 'flowmate-log-'));
    roots.push(root);
    const logger = new JsonlLogger({ instanceId: 'i_test', processInstanceId: 'p_test', logRoot: root, config: { minLevel: 'info', maxRecordBytes: 512, maxFileBytes: 1024, maxTotalBytes: 600, retentionDays: 7, queueLimit: 2, flushTimeoutMs: 100 } });
    logger.write({ level: 'info', component: 'test', eventCode: 'safe', safeMessage: 'operation failed', attributes: { token: 'secret-value', count: 1 } });
    const path = join(root, 'p0-p_test.jsonl');
    const line = await readFile(path, 'utf8');
    expect(line).not.toContain('secret-value');
    expect(line).toContain('count');
    logger.write({ level: 'info', component: 'test', eventCode: 'large', safeMessage: 'x'.repeat(400) });
    expect(logger.health().degraded).toBe(true);
    expect(logger.health().droppedRecords).toBeGreaterThan(0);
    await logger.close(100);
  });

  it('rejects an actual Windows junction component before reading bytes', async () => {
    if (process.platform !== 'win32') throw new Error('[P0_FACILITY] Windows junction case requires Windows; must not report a no-op PASS');
    const root = await mkdtemp(join(process.env.TEMP ?? '.', 'flowmate-links-'));
    roots.push(root);
    const source = join(root, 'source');
    const instance = join(root, 'instance');
    const outside = join(root, 'outside');
    await mkdir(source, { recursive: true });
    await mkdir(join(outside, 'dir'), { recursive: true });
    const bytes = new TextEncoder().encode('canary');
    await writeFile(join(outside, 'dir', 'file.txt'), bytes);
    await symlink(join(outside, 'dir'), join(source, 'linked-dir'), 'junction').catch(error => { throw new Error('[P0_FACILITY] Cannot create Windows junction', { cause: error }); });
    const store = new InstanceFileStore({ sourceRoot: source, instanceRoot: instance });
    await expect(store.readVerified({ root: 'source', relativePath: 'linked-dir/file.txt', expectedSha256: sha256Bytes(bytes), expectedBytes: bytes.byteLength, maxBytes: 1024 }))
      .rejects.toMatchObject({ descriptor: { code: 'REPARSE_POINT_DENIED' } });
  });
});
