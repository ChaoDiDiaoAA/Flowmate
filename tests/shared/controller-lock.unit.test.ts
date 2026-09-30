import { mkdtemp } from '../support/resources.ts';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { resolveProductPaths } from '../../packages/shared/src/paths.ts';
import { acquireProductControllerLock } from '../../packages/shared/src/controller-lock.ts';

describe('Product controller lock', () => {
  it('rejects paths outside the product root before creating a directory or lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-lock-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'flowmate-lock-outside-'));
    const paths = resolveProductPaths(root);
    if (!paths.ok) throw new Error(paths.error.code);
    const result = await acquireProductControllerLock({
      ...paths.data, databaseFile: join(outside, 'must-not-create', 'trial.sqlite'),
    });
    if (result.ok) await result.data.release();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path_outside_root');
    expect(existsSync(join(outside, 'must-not-create'))).toBe(false);
  });

  it('allows one process owner, rejects a second owner, and releases for a later owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmate-lock-'));
    const paths = resolveProductPaths(root);
    expect(paths.ok).toBe(true);
    if (!paths.ok) return;
    const first = await acquireProductControllerLock(paths.data);
    expect(first.ok).toBe(true);
    const second = await acquireProductControllerLock(paths.data);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('runtime_already_owned');
    if (first.ok) await first.data.release();
    const third = await acquireProductControllerLock(paths.data);
    expect(third.ok).toBe(true);
    if (third.ok) await third.data.release();
  });
});
