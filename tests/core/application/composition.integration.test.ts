import { mkdtempSync, deferCleanup } from '../../support/resources.ts';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, mock } from 'bun:test';
import { createApplication } from '../../../apps/composition.ts';
import type { ProviderPort } from '../../../packages/contracts/src/ports.ts';

function paths(root: string) {
  return { root, databaseFile: join(root, 'data', 'trial.sqlite'), logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

describe('P1 application composition', () => {
  it('opens the injected ProductPaths and closes database/logger resources', async () => {
    const provider: ProviderPort = {
      prepare: async () => ({ ok: false as const, error: { code: 'provider_auth_failed', category: 'provider' as const, message: '认证失败。', retryable: false } }),
      close: async () => ({ stopped: true, closed: true, errors: [] }),
    };
    const root = mkdtempSync(join(tmpdir(), 'flowmate-composition-'));
    const result = await createApplication({ paths: paths(root), provider, logger: { write: () => undefined, close: async () => undefined } });

    if (result.ok) deferCleanup(() => result.data.close());
    expect(result.ok).toBe(true);
    if (result.ok) await expect(result.data.close()).resolves.toEqual({ ok: true, data: { stopped: true, closed: true, errors: [] } });
  });

  it('reports logger close failures and still closes the database exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-composition-close-failure-'));
    const closeLogger = mock(async () => {
      if (closeLogger.mock.calls.length === 1) throw new Error('synthetic private log path');
    });
    const provider: ProviderPort = { prepare: async () => ({ ok: false as const, error: { code: 'unused', category: 'provider' as const, message: 'unused', retryable: false } }), close: async () => ({ stopped: true, closed: true, errors: [] }) };
    const result = await createApplication({ paths: paths(root), provider, logger: { write: () => undefined, close: closeLogger } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = await result.data.close();
    const second = await result.data.close();

    expect(first).toMatchObject({ ok: true, data: { stopped: true, closed: false, errors: [{ code: 'logger_close_failed' }] } });
    expect(second).toMatchObject({ ok: true, data: { stopped: true, closed: true, errors: [{ code: 'logger_close_failed' }] } });
    expect(JSON.stringify(first)).not.toContain('synthetic private log path');
    expect(closeLogger).toHaveBeenCalledTimes(2);
    const reopened = await createApplication({ paths: paths(root), provider, logger: { write: () => undefined, close: async () => undefined } });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) await reopened.data.close();
  });
});
