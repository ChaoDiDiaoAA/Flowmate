import type { Application, Result } from '@flowmate/contracts';
import { providerCommand, providerQueryCommand, type CliIo } from './commands/provider.ts';

export type MainDependencies = {
  application?: Application;
  createApplication?: () => Promise<Result<Application>>;
};

function usage(io: CliIo): void {
  io.err('usage: provider call --input <text-file> --goal <text> [--config <provider-json>] [--timeout-ms <n>] [--stop-grace-ms <n>]');
  io.err('usage: provider query --run-id <positive-integer>');
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function hasUnknownOptions(argv: readonly string[], allowed: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    if (!allowed.includes(value) || argv[index + 1] === undefined || argv[index + 1].startsWith('--')) return true;
    index += 1;
  }
  return false;
}

async function withApplication(
  deps: MainDependencies,
  io: CliIo,
  action: (application: Application) => Promise<number>,
): Promise<number> {
  const factory = deps.createApplication ?? (async () => {
    // Keep the Bun SQLite composition out of pure CLI parser tests; production
    // entry execution still resolves the concrete application here.
    const compositionPath = '../composition.ts';
    const composition = await import(/* @vite-ignore */ compositionPath);
    return composition.createDefaultApplication() as Promise<Result<Application>>;
  });
  const opened = deps.application ? ({ ok: true as const, data: deps.application }) : await factory();
  if (!opened.ok) {
    io.err(`${opened.error.code}: ${opened.error.message}`);
    return 2;
  }
  let code = 2;
  try {
    code = await action(opened.data);
  } catch {
    io.err('internal_error: Provider 命令执行失败。');
    code = 2;
  }
  const closed = await opened.data.close();
  if (!closed.ok || !closed.data.closed) {
    io.err('runtime_close_failed: 运行资源未确认关闭。');
    return code === 0 ? 2 : code;
  }
  return code;
}

export async function main(argv: readonly string[], io: CliIo, deps: MainDependencies = {}): Promise<number> {
  if (argv[0] !== 'provider') {
    usage(io);
    return 2;
  }
  if (argv[1] === 'query') {
    if (hasUnknownOptions(argv.slice(2), ['--run-id'])) {
      usage(io);
      return 2;
    }
    const value = option(argv, '--run-id');
    const runId = value === undefined ? NaN : Number(value);
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      usage(io);
      return 2;
    }
    return withApplication(deps, io, (application) => providerQueryCommand(runId, application, io));
  }
  if (argv[1] === 'call') {
    if (hasUnknownOptions(argv.slice(2), ['--config', '--input', '--goal', '--timeout-ms', '--stop-grace-ms'])) {
      usage(io);
      return 2;
    }
    const configFile = option(argv, '--config');
    const inputFile = option(argv, '--input');
    const goal = option(argv, '--goal');
    const timeoutText = option(argv, '--timeout-ms');
    const stopGraceText = option(argv, '--stop-grace-ms');
    const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
    const stopGraceMs = stopGraceText === undefined ? undefined : Number(stopGraceText);
    if (!inputFile || !goal || (timeoutText !== undefined && !Number.isInteger(timeoutMs)) || (stopGraceText !== undefined && !Number.isInteger(stopGraceMs))) {
      usage(io);
      return 2;
    }
    return withApplication(deps, io, (application) => providerCommand({ configFile, inputFile, goal, timeoutMs, stopGraceMs }, application, io));
  }
  usage(io);
  return 2;
}

if (import.meta.main) {
  const io: CliIo = { out: (text) => console.log(text), err: (text) => console.error(text), signal: new AbortController().signal };
  void main(process.argv.slice(2), io).then((code) => { process.exitCode = code; });
}
