import { makeApplication, RuntimeService, SessionService, openDatabase } from '@flowmate/core';
import { createPromptTraceBuffer } from '@flowmate/logging';
import { PiAgentAdapter, PiProviderAdapter } from '@flowmate/runtime-pi';
import { acquireProductControllerLock, createLogger, resolveProductPaths, resolveWindowsUserData } from '@flowmate/shared';
import { appError, ok } from '@flowmate/contracts';
import type { Application, ProductPaths, PromptTraceBuffer, Result } from '@flowmate/contracts';
import type { AgentPort, ProviderPort } from '@flowmate/contracts';
import type { SafeLogger } from '@flowmate/shared';

export type ApplicationOptions = {
  paths: ProductPaths;
  provider?: ProviderPort;
  agent?: AgentPort;
  promptTrace?: PromptTraceBuffer;
  logger?: SafeLogger;
};

export async function createApplication(options: ApplicationOptions): Promise<Result<Application>> {
  const lock = await acquireProductControllerLock(options.paths);
  if (!lock.ok) return lock;
  const database = openDatabase(options.paths);
  if (!database.ok) {
    await lock.data.release();
    return database;
  }
  let logger: SafeLogger;
  try {
    logger = options.logger ?? createLogger(options.paths.logsDir);
  } catch {
    try { database.data.close(); } catch { /* preserve logger initialization failure */ }
    await lock.data.release();
    return { ok: false, error: appError('logger_init_failed', 'runtime', '运行日志初始化失败。', true) };
  }
  const provider = options.provider ?? new PiProviderAdapter();
  const promptTrace = options.promptTrace ?? createPromptTraceBuffer();
  const agent = options.agent ?? new PiAgentAdapter({ cwd: options.paths.runtimeDir, agentDir: options.paths.runtimeDir, promptTrace });
  let loggerClosed = false;
  let databaseClosed = false;
  const now = () => new Date().toISOString();
  const runtime = new RuntimeService({
    runs: database.data.runs,
    sessions: database.data.sessions,
    provider,
    agent,
    log: logger,
    now,
    monotonicNow: () => performance.now(),
  });
  const sessionService = new SessionService(database.data.sessions, agent, () => runtime.state(), now);
  return ok(makeApplication(runtime, database.data.runs, async () => {
    const errors = [];
    if (!loggerClosed) {
      try { await logger.close(); loggerClosed = true; } catch { errors.push(appError('logger_close_failed', 'runtime', '日志资源关闭失败。', true)); }
    }
    if (!databaseClosed) {
      try { database.data.close(); databaseClosed = true; } catch { errors.push(appError('database_close_failed', 'storage', '数据库资源关闭失败。', true)); }
    }
    let lockReleased = false;
    if (loggerClosed && databaseClosed) {
      const released = await lock.data.release();
      lockReleased = released.ok;
      if (!released.ok) errors.push(released.error);
    }
    return { stopped: true, closed: loggerClosed && databaseClosed && lockReleased, errors };
  }, sessionService, promptTrace));
}

export async function createDefaultApplication(): Promise<Result<Application>> {
  const userData = resolveWindowsUserData(process.env);
  if (!userData.ok) return userData;
  const paths = resolveProductPaths(userData.data);
  if (!paths.ok) return paths;
  return createApplication({ paths: paths.data });
}
