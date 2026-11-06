import { appError, fail, type DurableRuntimePort, type Result } from '@flowmate/contracts';
import type { DbHandle } from '../packages/core/src/storage/database.ts';
import type { SessionRow } from '../packages/core/src/storage/repositories.ts';

/** A local native store must never receive a cloud-owned Session. */
export function createLocalDurableRuntime(native: DurableRuntimePort, database: Pick<DbHandle, 'read'>): DurableRuntimePort {
  async function local<T>(input: { sessionId: number }, action: () => Promise<Result<T>>): Promise<Result<T>> {
    let session: Result<SessionRow>;
    try { session = await database.read(scope => scope.sessions.get(input.sessionId)); }
    catch { return fail(appError('storage_read_failed', 'storage', 'The original runtime owner could not be read.', true)); }
    if (!session.ok) return session;
    if (session.data.runtimeKind !== 'durable' || session.data.durableRuntimeId !== 'local')
      return fail(appError('cloud_runtime_unavailable', 'runtime', 'The original cloud runtime is not connected.', true));
    return action();
  }
  return {
    openConversation: input => local(input, () => native.openConversation(input)),
    prepareModel: input => local(input, () => native.prepareModel(input)),
    restoreModel: input => local(input, () => native.restoreModel(input)),
    submit: input => local(input, () => native.submit(input)),
    getSubmission: input => local(input, () => native.getSubmission(input)),
    observeSubmission: input => local(input, () => native.observeSubmission(input)),
    observeSubagent: input => local(input, () => native.observeSubagent(input)),
    waitForSubmission: input => local(input, () => native.waitForSubmission(input)),
    stopAttempt: input => local(input, () => native.stopAttempt(input)),
    resumeAttempt: input => local(input, () => native.resumeAttempt(input)),
    queryHistory: input => local(input, () => native.queryHistory(input)),
    queryHistoryPage: input => local(input, () => native.queryHistoryPage(input)),
    queryHistoryEntry: input => local(input, () => native.queryHistoryEntry(input)),
    compact: input => local(input, () => native.compact(input)),
    queryCompaction: input => local(input, () => native.queryCompaction(input)),
    cancelCompaction: input => local(input, () => native.cancelCompaction(input)),
    close: () => native.close(),
  };
}
