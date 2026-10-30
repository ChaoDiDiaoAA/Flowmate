import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { ConversationId, Storage } from '@earendil-works/pi-durable';
import type { DurableSqliteCoordinator } from '../../packages/runtime-durable/src/storage.ts';
import type { ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import type { CloseReport, Result } from '@flowmate/contracts';
import { waitOwner } from '../service/owner-fixture.ts';

export const CHILD_STOP_TRIGGER = 'test_original_child_terminal_failure';
export const CHILD_STOP_FAILURE = 'controlled_original_child_terminal_commit_failure';
export type ChildStopTarget = { workId: number; attemptId: number; rootRunId: number; childRunId: number;
  childSessionId: number; nativeConversationId: number; nativeTaskId: number };
export type ChildStopSnapshot = { target: ChildStopTarget; task: { id: number; conversation_id: number; status: string; abort_requested: number; record: string };
  attempt: { id: number; run_id: number; stop_requested_at: string | null; stopped_at: string | null };
  runs: Array<{ id: number; parent_run_id: number | null; status: string; cancel_requested_at: string | null; stopped_at: string | null; cleanup_json: string }>;
  phases: Array<{ id: number; request_id: string; native_conversation_id: number | null; native_submission_id: number | null; closed_at: string | null }>;
  changes: number; faultInstalled: boolean };
type Frame = { type: string; id?: number; value?: unknown; error?: string; report?: Result<CloseReport> };

export async function spawnOwnerChildStopFixture(installation: ServiceInstallation, observe?: { target: ChildStopTarget; queuedWorkId: number }) {
  const child = Bun.spawn([process.execPath, '--no-env-file', import.meta.filename, '--run',
    join(installation.dataRoot, 'service-installation.json'), installation.runtimeRoot, ...(observe ? [JSON.stringify(observe)] : [])],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OPENAI_API_KEY: 'must-not-be-used' } });
  let stdout = '', stderr = '', sequence = 0;
  const messages: Frame[] = [];
  void (async () => { for await (const bytes of child.stdout) {
    stdout += Buffer.from(bytes).toString('utf8'); let end: number;
    while ((end = stdout.indexOf('\n')) >= 0) { messages.push(JSON.parse(stdout.slice(0, end)) as Frame); stdout = stdout.slice(end + 1); }
  } })();
  void (async () => { for await (const bytes of child.stderr) stderr += Buffer.from(bytes).toString('utf8'); })();
  const ready = waitOwner(() => messages.some(message => message.type === 'fixture_ready'), () => stderr);
  async function control(input: { type: 'arm'; workId: number; attemptId: number; childRunId: number } | { type: 'snapshot' }) {
    const id = ++sequence;
    child.stdin.write(JSON.stringify({ ...input, id }) + '\n'); await child.stdin.flush();
    await waitOwner(() => messages.some(message => message.id === id && message.type.startsWith('fixture_control')), () => stderr);
    const result = messages.find(message => message.id === id && message.type.startsWith('fixture_control'))!;
    if (result.type === 'fixture_control_error') throw Error(result.error);
    return result.value;
  }
  return { child, ready, messages, stderr: () => stderr,
    arm: async (input: { workId: number; attemptId: number; childRunId: number }) => await control({ type: 'arm', ...input }) as ChildStopTarget,
    snapshot: async () => await control({ type: 'snapshot' }) as ChildStopSnapshot,
    async close() {
      const before = messages.length; child.stdin.write('close\n'); await child.stdin.flush();
      await waitOwner(() => messages.slice(before).some(message => message.type === 'fixture_close'), () => stderr);
      return messages.slice(before).find(message => message.type === 'fixture_close')!.report!;
    } };
}

if (import.meta.main && process.argv[2] === '--run') {
  const { spyOn } = await import('bun:test');
  const durable = await import('@flowmate/runtime-durable');
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  const { GenerationTask } = await import('@earendil-works/pi-durable');
  const { InvoiceWorkWorkingContextSchema } = await import('@flowmate/contracts');
  const actualStorage = durable.createDurableSqliteStorage;
  let coordinator: DurableSqliteCoordinator | undefined, storage: Storage | undefined, target: ChildStopTarget | undefined;
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  const observe = process.argv[5] === undefined ? undefined : z.object({ queuedWorkId: id, target: z.object({
    workId: id, attemptId: id, rootRunId: id, childRunId: id, childSessionId: id, nativeConversationId: id, nativeTaskId: id,
  }).strict() }).strict().parse(JSON.parse(process.argv[5]));
  async function snapshot(original: ChildStopTarget): Promise<ChildStopSnapshot> {
    if (!coordinator) throw Error('The actual product owner queue is unavailable.');
    return coordinator.read(async sql => {
      const task = await sql.get<ChildStopSnapshot['task']>('SELECT id,conversation_id,status,abort_requested,record FROM fm_durable_tasks WHERE id=?', original.nativeTaskId);
      const attempt = await sql.get<ChildStopSnapshot['attempt']>('SELECT id,run_id,stop_requested_at,stopped_at FROM invoice_work_attempts WHERE work_id=? AND id=?', original.workId, original.attemptId);
      if (!task || !attempt || task.conversation_id !== original.nativeConversationId || attempt.run_id !== original.rootRunId)
        throw Error('Original child stop facts disappeared or changed owner.');
      const runs = await sql.all<ChildStopSnapshot['runs'][number]>(
        'SELECT id,parent_run_id,status,cancel_requested_at,stopped_at,cleanup_json FROM runs WHERE id IN (?,?) ORDER BY id', original.rootRunId, original.childRunId);
      const phases = await sql.all<ChildStopSnapshot['phases'][number]>(
        'SELECT id,request_id,native_conversation_id,native_submission_id,closed_at FROM invoice_work_phases WHERE work_id=? AND attempt_id=? ORDER BY id', original.workId, original.attemptId);
      const changes = await sql.get<{ changes: number }>('SELECT total_changes() changes');
      const trigger = await sql.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?", CHILD_STOP_TRIGGER);
      return { target: original, task, attempt, runs, phases, changes: changes!.changes, faultInstalled: trigger?.name === CHILD_STOP_TRIGGER };
    });
  }
  if (observe) {
    const fetch = globalThis.fetch;
    const observingFetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      let bodyText: string | null = null;
      if (typeof init?.body === 'string') bodyText = init.body;
      else if (input instanceof Request) bodyText = await input.clone().text();
      if (bodyText) {
        const body = JSON.parse(bodyText) as { messages?: Array<{ role: string; content: unknown }> };
        const content = body.messages?.filter(message => message.role === 'user').at(-1)?.content;
        if (typeof content === 'string' && content.startsWith('{')) {
          const context = InvoiceWorkWorkingContextSchema.safeParse(JSON.parse(content));
          if (context.success && context.data.work.workId === observe.queuedWorkId) {
            // Capture on the actual client path before the original fetch can dispatch this queued Work.
            emit({ type: 'fixture_before_queued_fetch', value: await snapshot(observe.target) });
          }
        }
      }
      return fetch(...args);
    }, { preconnect: fetch.preconnect });
    spyOn(globalThis, 'fetch').mockImplementation(observingFetch);
  }
  spyOn(durable, 'createDurableSqliteStorage').mockImplementation(async originalCoordinator => {
    coordinator = originalCoordinator;
    const actual = await actualStorage(originalCoordinator), commit = actual.commit.bind(actual), close = actual.close.bind(actual);
    actual.commit = async (writes, context) => {
      const closing = writes.find(write => write.type === 'task' && write.value.id === target?.nativeTaskId
        && ['completing', 'terminal'].includes(write.value.state.status));
      try { return await commit(writes, context); }
      catch (error) {
        if (closing?.type === 'task' && error instanceof Error && error.message.includes(CHILD_STOP_FAILURE)) emit({
          type: 'fixture_native_commit_failed', taskId: closing.value.id, conversationId: closing.value.conversationId,
          attemptedStatus: closing.value.state.status, message: error.message,
          code: 'code' in error ? String(error.code) : null,
        });
        throw error;
      }
    };
    actual.close = async context => { await close(context); emit({ type: 'fixture_native_storage_closed', value: target?.nativeTaskId ?? null }); };
    storage = actual; return actual;
  });
  const { createServiceOwner } = await import('../../apps/service/owner.ts');
  const opened = await createServiceOwner({ installationFile: resolve(process.argv[3]!), runtimeRoot: resolve(process.argv[4]!) });
  if (!opened.ok) throw Error(opened.error.code);
  if (!coordinator || !storage) throw Error('The actual product SQLite storage factory was not observed.');
  const owner = opened.data, sqlOwner = coordinator, nativeStorage = storage;
  const commands = z.discriminatedUnion('type', [
    z.object({ type: z.literal('arm'), id, workId: id, attemptId: id, childRunId: id }).strict(),
    z.object({ type: z.literal('snapshot'), id }).strict(),
  ]);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async line => {
    if (line === 'close') {
      const report = await owner.close(); emit({ type: 'fixture_close', report });
      if (report.ok && report.data.stopped && report.data.closed) { input.close(); process.exitCode = 0; }
      return;
    }
    let requestId = 0;
    try {
      const command = commands.parse(JSON.parse(line)); requestId = command.id;
      if (command.type === 'arm') {
        if (target) throw Error('The one original child fault is already armed.');
        const child = await sqlOwner.read(sql => sql.get<{ parent_run_id: number; session_id: number; durable_conversation_id: number | null }>(
          `SELECT r.parent_run_id,r.session_id,s.durable_conversation_id FROM runs r
           JOIN sessions s ON s.id=r.session_id AND s.runtime_kind='durable'
           JOIN invoice_work_attempts a ON a.run_id=r.parent_run_id AND a.work_id=? AND a.id=?
           WHERE r.id=? AND r.kind='subagent'`, command.workId, command.attemptId, command.childRunId));
        if (!child?.durable_conversation_id) throw Error('The real original child conversation is unavailable.');
        const page = await nativeStorage.scanTasks({ conversationId: child.durable_conversation_id as ConversationId,
          kind: GenerationTask.definition.name }, 100, undefined, BACKGROUND_CONTEXT);
        const live = page.items.filter(task => task.state.status !== 'terminal');
        if (live.length !== 1 || page.next !== undefined) throw Error('Expected one exact live child GenerationTask.');
        const task = live[0]!;
        const original: ChildStopTarget = { workId: command.workId, attemptId: command.attemptId, rootRunId: child.parent_run_id,
          childRunId: command.childRunId, childSessionId: child.session_id, nativeConversationId: child.durable_conversation_id, nativeTaskId: task.id };
        await sqlOwner.transaction(sql => sql.exec(`CREATE TRIGGER ${CHILD_STOP_TRIGGER} BEFORE INSERT ON fm_durable_tasks
          WHEN NEW.id=${original.nativeTaskId} AND NEW.status IN ('completing','terminal')
          BEGIN SELECT RAISE(ABORT,'${CHILD_STOP_FAILURE}'); END`));
        target = original; emit({ type: 'fixture_control', id: command.id, value: original }); return;
      }
      if (!target) throw Error('The original child fault target is not armed.');
      emit({ type: 'fixture_control', id: command.id, value: await snapshot(target) });
    } catch (error) { emit({ type: 'fixture_control_error', id: requestId, error: error instanceof Error ? error.message : String(error) }); }
  });
  emit({ type: 'fixture_ready', pid: process.pid, storageObserved: true });
}
