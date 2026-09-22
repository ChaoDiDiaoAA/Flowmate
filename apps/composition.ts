import { makeApplication, RuntimeService, openDatabase } from '@flowmate/core';
import { PiProviderAdapter } from '@flowmate/runtime-pi';
import { createLogger, resolveProductPaths, resolveWindowsUserData } from '@flowmate/shared';
import { ok } from '@flowmate/contracts';
import type { Application, ProductPaths, Result } from '@flowmate/contracts';
import type { ProviderPort } from '@flowmate/contracts';
import type { SafeLogger } from '@flowmate/shared';

export type ApplicationOptions = {
  paths: ProductPaths;
  provider?: ProviderPort;
  logger?: SafeLogger;
};

export async function createApplication(options: ApplicationOptions): Promise<Result<Application>> {
  const database = openDatabase(options.paths);
  if (!database.ok) return database;
  const logger = options.logger ?? createLogger(options.paths.logsDir);
  const provider = options.provider ?? new PiProviderAdapter();
  const runtime = new RuntimeService({
    runs: database.data.runs,
    provider,
    log: logger,
    now: () => new Date().toISOString(),
    monotonicNow: () => performance.now(),
  });
  return ok(makeApplication(runtime, database.data.runs, async () => {
    const errors = [] as never[];
    try { await logger.close(); } catch { errors.push(); }
    try { database.data.close(); } catch { errors.push(); }
    return { stopped: errors.length === 0, closed: errors.length === 0, errors };
  }));
}

export async function createDefaultApplication(): Promise<Result<Application>> {
  const userData = resolveWindowsUserData(process.env);
  if (!userData.ok) return userData;
  const paths = resolveProductPaths(userData.data);
  if (!paths.ok) return paths;
  return createApplication({ paths: paths.data });
}
