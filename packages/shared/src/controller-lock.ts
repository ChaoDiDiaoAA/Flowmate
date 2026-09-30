import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { appError, fail, ok } from '@flowmate/contracts';
import type { ProductPaths, Result } from '@flowmate/contracts';
import { validateProductPaths } from './paths.ts';

export type ProductControllerLease = { release(): Promise<Result<void>> };

/**
 * Keeps the desktop Host and CLI from opening the same formal SQLite database
 * as concurrent product controllers. proper-lockfile uses an atomic lock
 * directory with a heartbeat and can recover a stale lock after a crash.
 */
export async function acquireProductControllerLock(paths: ProductPaths): Promise<Result<ProductControllerLease>> {
  const validated = validateProductPaths(paths);
  if (!validated.ok) return validated;
  try {
    await mkdir(dirname(paths.databaseFile), { recursive: true });
    const created = validateProductPaths(paths, validated.data);
    if (!created.ok) return created;
    const releaseLock = await lockfile.lock(paths.databaseFile, {
      realpath: false,
      stale: 15_000,
      update: 3_000,
      retries: 0,
    });
    const locked = validateProductPaths(paths, validated.data);
    if (!locked.ok) {
      await releaseLock();
      return locked;
    }
    let released = false;
    return ok({
      async release() {
        if (released) return ok(undefined);
        try {
          await releaseLock();
          released = true;
          return ok(undefined);
        } catch {
          return fail(appError('runtime_lock_release_failed', 'runtime', '产品数据目录控制锁释放失败。', true));
        }
      },
    });
  } catch (error) {
    const locked = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED';
    return fail(locked
      ? appError('runtime_already_owned', 'runtime', '产品数据目录已由另一个 Flowmate 进程使用。', true)
      : appError('runtime_lock_failed', 'runtime', '产品数据目录控制锁不可用。', true));
  }
}
