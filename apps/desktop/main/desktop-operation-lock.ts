import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import lockfile from 'proper-lockfile';
import { appError, fail, type Result } from '@flowmate/contracts';

export function createDesktopOperationLock(path: string) {
  const unavailable = () => fail(appError('desktop_busy', 'runtime', 'Another Flowmate process is using the desktop, or its operation lock is unavailable.', true));
  return async <T>(signal: AbortSignal, operation: (valid: () => boolean) => Promise<Result<T>>): Promise<Result<T>> => {
    if (!isAbsolute(path) || signal.aborted) return unavailable();
    let release: () => Promise<void>, compromised = false;
    try {
      await mkdir(dirname(path), { recursive: true });
      release = await lockfile.lock(path, { realpath: false, retries: 0, stale: 60_000, update: 10_000,
        onCompromised: () => { compromised = true; } });
    } catch { return unavailable(); }
    let result: Result<T>;
    try { result = signal.aborted ? unavailable() : await operation(() => !compromised && !signal.aborted); }
    catch { result = unavailable(); }
    try { await release(); } catch { return unavailable(); }
    return compromised ? unavailable() : result;
  };
}
