import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appError, normalizeProviderRequest, ok } from '@flowmate/contracts';
import type { Application, DbId, ProviderConfig, Result } from '@flowmate/contracts';
import { loadProviderConfig } from '@flowmate/core';
import { loadLiveProviderEnvironment, resolveProductPaths, resolveWindowsUserData } from '@flowmate/shared';

export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  signal: AbortSignal;
};

export type ProviderCommandArgs = {
  configFile?: string;
  inputFile: string;
  goal: string;
  timeoutMs?: number;
  stopGraceMs?: number;
};

async function resolveConfig(configFile: string | undefined): Promise<Result<ProviderConfig>> {
  if (configFile) return loadProviderConfig(resolve(configFile));
  const userData = resolveWindowsUserData(process.env);
  if (!userData.ok) return userData;
  const paths = resolveProductPaths(userData.data);
  if (!paths.ok) return paths;
  const live = loadLiveProviderEnvironment(process.env, paths.data);
  return live.ok ? ok(live.data.config) : live;
}

function printError(io: CliIo, error: { code: string; message: string }): void {
  io.err(`${error.code}: ${error.message}`);
}

export async function providerCommand(args: ProviderCommandArgs, app: Application, io: CliIo): Promise<number> {
  const config = await resolveConfig(args.configFile);
  if (!config.ok) {
    printError(io, config.error);
    return 2;
  }
  let text: string;
  try {
    text = await readFile(resolve(args.inputFile), 'utf8');
  } catch {
    const error = appError('input_read_failed', 'input', '输入文件不可读。');
    printError(io, error);
    return 2;
  }
  const request = normalizeProviderRequest({
    goal: args.goal,
    text,
    config: config.data,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    ...(args.stopGraceMs === undefined ? {} : { stopGraceMs: args.stopGraceMs }),
  });
  if (!request.ok) {
    printError(io, request.error);
    return 2;
  }
  const result = await app.callProvider(request.data, { signal: io.signal });
  if (!result.ok) {
    printError(io, result.error);
    return 2;
  }
  io.out(`runId=${result.data.runId} status=${result.data.status}`);
  if (result.data.text) io.out(result.data.text);
  if (result.data.status === 'completed') return 0;
  if (result.data.status === 'cancelled') return 130;
  if (result.data.error) io.err(`${result.data.error.code}: ${result.data.error.message}`);
  return 1;
}

export async function providerQueryCommand(runId: DbId, app: Application, io: CliIo): Promise<number> {
  const result: Result<unknown> = await app.queryRun(runId);
  if (!result.ok) {
    printError(io, result.error);
    return 2;
  }
  const snapshot = result.data as { runId: number; status: string; output?: { text?: string } | null; error?: { code: string; message: string } | null };
  io.out(`runId=${snapshot.runId} status=${snapshot.status}`);
  if (snapshot.output?.text) io.out(snapshot.output.text);
  if (snapshot.error) io.err(`${snapshot.error.code}: ${snapshot.error.message}`);
  return 0;
}
