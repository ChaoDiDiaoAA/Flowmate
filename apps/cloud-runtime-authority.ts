import { z } from 'zod';
import { appError, DurableSubagentRunScopeSchema, fail, ok, type Result } from '@flowmate/contracts';
import type { DbHandle } from '../packages/core/src/storage/database.ts';
import type { CloudRuntimeGrant, CloudRuntimeOperation } from './cloud-runtime-router.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const request = z.object({ workId: id, sessionId: id, itemId: id.optional(), attemptId: id.optional(), requestId: z.string().min(1).max(128).optional(),
  childRunId: id.optional(), childSessionId: id.optional(), originToolCallId: id.optional(), nativeToolTaskId: id.optional(),
  child: z.object({ childRunId: id, childSessionId: id, originToolCallId: id, nativeToolTaskId: id, itemId: id.optional(),
    workId: id, sessionId: id, attemptId: id, requestId: z.string().min(1).max(128) }).strict().optional() }).passthrough();
const attemptMethods = new Set<CloudRuntimeOperation>(['prepareModel', 'restoreModel', 'submit', 'getSubmission', 'observeSubmission',
  'observeSubagent', 'waitForSubmission', 'stopAttempt', 'resumeAttempt', 'compact', 'queryCompaction', 'cancelCompaction',
  'readQueue', 'controlQueue', 'queryQueueControl', 'resultStatus', 'retryResult']);
const phaseMethods = new Set<CloudRuntimeOperation>(['restoreModel', 'submit', 'getSubmission', 'observeSubmission', 'observeSubagent',
  'waitForSubmission', 'compact', 'queryCompaction', 'cancelCompaction', 'retryResult']);
const scheduling = new Set<CloudRuntimeOperation>(['openConversation', 'prepareModel', 'submit', 'waitForSubmission', 'resumeAttempt', 'compact', 'controlQueue']);
const denied = () => fail(appError('cloud_runtime_forbidden', 'runtime', 'The original cloud operation is not authorized.'));

/** The Runtime receives only the owner and readiness facts for the original product Work. */
export function createCloudRuntimeAuthorizer(database: Pick<DbHandle, 'read'>):
  (operation: CloudRuntimeOperation, raw: unknown) => Promise<Result<CloudRuntimeGrant>> {
  return async (operation, raw) => {
    const parsed = request.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data;
    try {
      return await database.read(scope => {
        const row = scope.db.query<{ session_id: number; status: string; current_attempt_id: number | null }, [number]>(
          'SELECT session_id,status,current_attempt_id FROM invoice_works WHERE id=?').get(input.workId);
        const session = scope.sessions.get(input.sessionId);
        if (!row || row.session_id !== input.sessionId || !session.ok || session.data.runtimeKind !== 'durable'
          || session.data.durableRuntimeId === 'local' || session.data.cloudWorkspaceId === null) return denied();
        if (input.itemId !== undefined && (!scope.db.query('SELECT id FROM invoice_work_items WHERE work_id=? AND id=?')
          .get(input.workId, input.itemId) || input.child !== undefined && !['compact', 'queryCompaction', 'cancelCompaction'].includes(operation))) return denied();
        const current = row.current_attempt_id === null ? null : scope.db.query<{ id: number; run_id: number | null;
          stop_requested_at: string | null; stopped_at: string | null }, [number, number]>(
          'SELECT id,run_id,stop_requested_at,stopped_at FROM invoice_work_attempts WHERE id=? AND work_id=?').get(row.current_attempt_id, input.workId);
        const original = input.attemptId === undefined ? null : scope.db.query<{ id: number; run_id: number | null;
          stop_requested_at: string | null; stopped_at: string | null }, [number, number]>(
          'SELECT id,run_id,stop_requested_at,stopped_at FROM invoice_work_attempts WHERE id=? AND work_id=?').get(input.attemptId, input.workId);
        if (attemptMethods.has(operation) && !original) return denied();
        if (phaseMethods.has(operation)) {
          if (input.requestId === undefined || input.attemptId === undefined) return denied();
          const phase = scope.db.query<{ item_id: number | null; scheduler_state: string }, [number, number, string]>(
            'SELECT item_id,scheduler_state FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
            .get(input.workId, input.attemptId, input.requestId);
          if (!phase || (phase.scheduler_state === 'legacy' ? input.itemId !== undefined : input.itemId !== phase.item_id)) return denied();
        }
        if (scheduling.has(operation)) {
          const target = original ?? current;
          if (row.status !== 'open' || session.data.status !== 'active' || session.data.deletePending || session.data.modelUseBlocked
            || !target || target.id !== row.current_attempt_id || target.stop_requested_at !== null || target.stopped_at !== null) return denied();
          if (['submit', 'waitForSubmission', 'resumeAttempt', 'compact', 'controlQueue'].includes(operation)) {
            if (target.run_id === null) return denied();
            const run = scope.runs.get(target.run_id);
            if (!run.ok || run.data.status !== 'running' || run.data.cancelRequestedAt !== null) return denied();
          }
        }
        const nested = input.child ?? (input.childRunId && input.childSessionId && input.originToolCallId && input.nativeToolTaskId
          ? { workId: input.workId, sessionId: input.sessionId, ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
            attemptId: input.attemptId, requestId: input.requestId,
            childRunId: input.childRunId, childSessionId: input.childSessionId, originToolCallId: input.originToolCallId, nativeToolTaskId: input.nativeToolTaskId } : null);
        if (nested) {
          if (nested.workId !== input.workId || nested.sessionId !== input.sessionId
            || phaseMethods.has(operation) && (nested.attemptId !== input.attemptId || nested.requestId !== input.requestId || nested.itemId !== input.itemId)) return denied();
          const run = scope.runs.get(nested.childRunId);
          if (!run.ok || run.data.kind !== 'subagent' || run.data.sessionId !== nested.childSessionId) return denied();
          const childScope = DurableSubagentRunScopeSchema.safeParse(run.data.scope);
          if (!childScope.success || childScope.data.workId !== input.workId || childScope.data.attemptId !== nested.attemptId
            || childScope.data.parentRequestId !== nested.requestId || childScope.data.originToolCallId !== nested.originToolCallId) return denied();
          const phase = scope.db.query<{ scheduler_state: string }, [number]>('SELECT scheduler_state FROM invoice_work_phases WHERE id=?').get(childScope.data.phaseId);
          if (!phase || (phase.scheduler_state === 'legacy' ? nested.itemId !== undefined : nested.itemId !== childScope.data.itemId)) return denied();
          const originalCall = scope.toolCalls.getById(nested.originToolCallId);
          if (!originalCall.ok || originalCall.data.nativeToolCallId !== `durable-task:${nested.nativeToolTaskId}`) return denied();
        } else if (operation === 'observeSubagent') return denied();
        const binding = { workspaceId: session.data.cloudWorkspaceId, cloudRuntimeId: session.data.durableRuntimeId,
          workId: input.workId, sessionId: input.sessionId };
        return session.data.durableConversationId === null ? ok({ binding, state: 'allocated' as const })
          : ok({ binding, state: 'ready' as const, nativeConversationId: session.data.durableConversationId });
      });
    } catch { return fail(appError('cloud_authorization_unavailable', 'storage', 'The original cloud authorization could not be verified.', true)); }
  };
}
