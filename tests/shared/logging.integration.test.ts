import { mkdtemp } from '../support/resources.ts';
import { readFile, rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { createLogger } from '../../packages/shared/src/logging.ts';

describe('safe structured logger', () => {
  it('writes JSONL and rotates bounded files without throwing to the product path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-logs-'));
    const logger = createLogger(root, { maxBytes: 180, backups: 2 });
    logger.write({ at: '2026-09-21T00:00:00.000Z', level: 'info', component: 'test', event: 'first' });
    logger.write({ at: '2026-09-21T00:00:00.001Z', level: 'error', component: 'test', event: 'second', runId: 1, code: 'provider_auth_failed' });
    await logger.close();

    const current = await readFile(join(root, 'flowmate.log'), 'utf8');
    expect(current).toContain('provider_auth_failed');
    expect((await stat(join(root, 'flowmate.log'))).size).toBeLessThanOrEqual(180);
  });

  it('[F-log-write-failure] keeps a log write failure diagnostic-only and does not throw into the caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-logs-failure-'));
    const logger = createLogger(root);
    await rm(root, { recursive: true, force: true });

    expect(() => logger.write({ at: '2026-09-21T00:00:00.000Z', level: 'error', component: 'test', event: 'disk-failure' })).not.toThrow();
    await expect(logger.close()).resolves.toBeUndefined();
  });
});
