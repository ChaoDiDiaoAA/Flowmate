import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { resolveRuntimeLayout } from '@flowmate/shared';
import type { EvaluationRuntime } from '../execution/source.ts';
import { appError, EvaluationIdSchema } from '@flowmate/contracts';
import { REPO_ROOT } from '../dataset-loader/local.ts';
import { scanEvidence } from '../execution/evidence-safety.ts';
import { createEvaluationService } from './service.ts';
import { EVALUATION_FRAME_LIMIT, parseEvaluationWorkerCommand, parseEvaluationWorkerOutput,
  type EvaluationWorkerCommand } from './protocol.ts';

export async function runEvaluationWorker(repo: string, sessionId: string,
  input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, runtime?: EvaluationRuntime) {
  const pending = new Set<Promise<void>>();
  const protocolError = { version: 1, type: 'protocol-error', sessionId,
    error: appError('evaluation_protocol_invalid', 'runtime', '评测进程消息无效，未执行该操作。', true) };
  let writable = true, sequence = 0;
  const send = (value: unknown) => {
    if (!writable) return;
    const checked = parseEvaluationWorkerOutput(scanEvidence(value).value);
    const line = checked ? JSON.stringify(checked) : '';
    const safe = !line || Buffer.byteLength(line) > EVALUATION_FRAME_LIMIT ? JSON.stringify(protocolError) : line;
    try { output.write(safe + '\n'); } catch { writable = false; }
  };
  const service = createEvaluationService(realpathSync(repo), { sessionId, runtime,
    onEvent: event => { sequence = event.sequence; send({ version: 1, type: 'event', sessionId, event }); } });
  const reader = createInterface({ input, crlfDelay: Infinity });
  output.on('error', () => { writable = false; void service.shutdown(); });
  async function dispatch(command: EvaluationWorkerCommand) {
    const result = command.type === 'export_evaluation' ? await service.export(command.input, command.connection)
      : command.type === 'query_evaluation_catalog' ? service.catalog(command.input)
      : command.type === 'add_evaluation_feedback' ? service.addFeedback(command.input)
        : command.type === 'query_evaluation_feedback' ? service.feedback(command.input)
      : command.type === 'preview_evaluation' ? service.preview(command.input, command.settings)
      : command.type === 'start_evaluation' ? service.start(command.input, command.context)
        : command.type === 'query_evaluation_control' ? service.control(command.input)
          : command.type === 'cancel_evaluation' ? service.cancel(command.input)
            : command.type === 'list_evaluation_executions' ? service.listExecutions(command.input)
              : command.type === 'query_evaluation_result' ? service.result(command.input)
                : command.type === 'compare_evaluation' ? service.compare(command.input) : await service.shutdown();
    send({ version: 1, type: 'response', sessionId, messageId: command.messageId, operation: command.type, sequence, result });
    if (command.type === 'shutdown' && result.ok && 'closed' in result.data && result.data.closed && result.data.stopped) reader.close();
  }
  send({ version: 1, type: 'ready', sessionId });
  try {
    for await (const line of reader) {
      let command: EvaluationWorkerCommand | null = null;
      try { if (Buffer.byteLength(line) <= EVALUATION_FRAME_LIMIT) command = parseEvaluationWorkerCommand(JSON.parse(line)); }
      catch { /* Never echo an invalid frame, which may contain credentials. */ }
      if (!command || command.sessionId !== sessionId) { send(protocolError); continue; }
      const work = dispatch(command).catch(() => { send(protocolError); }); pending.add(work);
      void work.finally(() => pending.delete(work));
    }
  } finally {
    await service.shutdown(); await Promise.allSettled(pending); reader.close();
  }
  return service.shutdown();
}

export async function startEvaluationWorker(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    for (const flag of ['--repo', '--session-id', '--runtime-root'])
      if (argv.filter(value => value.split('=')[0] === flag).length > 1) throw Error('Invalid Worker arguments');
    const args = parseArgs({ args: argv, options: { repo: { type: 'string' }, 'session-id': { type: 'string' }, 'runtime-root': { type: 'string' } }, strict: true, allowPositionals: false });
    const sessionId = EvaluationIdSchema.parse(args.values['session-id']);
    let runtime: EvaluationRuntime | undefined;
    const runtimeRoot = args.values['runtime-root'];
    if (runtimeRoot) {
      if (!isAbsolute(runtimeRoot) || !args.values.repo || !isAbsolute(args.values.repo)) throw Error('Invalid installed Worker root');
      const repo = realpathSync(args.values.repo);
      const checked = resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(runtimeRoot), 'app.asar'),
        resourcesPath: dirname(runtimeRoot), userDataRoot: dirname(repo) });
      if (!checked.ok || !checked.data.release || resolve(runtimeRoot) !== checked.data.runtimeRoot || repo !== checked.data.evaluationRoot
        || Bun.version !== checked.data.release.bunVersion || process.env.PI_PACKAGE_DIR !== checked.data.sdkRoot
        || process.env.PI_CODING_AGENT_DIR !== join(repo, 'runtime')) throw Error('Invalid installed Worker runtime');
      runtime = { mode: 'installed', layout: checked.data, release: checked.data.release };
    }
    await runEvaluationWorker(args.values.repo ?? REPO_ROOT, sessionId, process.stdin, process.stdout, runtime);
  } catch { process.stderr.write('[Flowmate Evaluation] evaluation_worker_start_failed\n'); process.exitCode = 1; }
}

if (import.meta.main) await startEvaluationWorker();
