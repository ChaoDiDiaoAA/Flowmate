import { appError, CloudRuntimeRetryReceiptSchema, CloudRuntimeRetryRequestSchema, CloudRuntimeStatusRequestSchema, CloudRuntimeStatusSchema,
  CloudWorkspaceIdSchema, fail, ok, type CloudRuntimeDeliveryPort, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';

type Owner = { workId: number; sessionId: number; attemptId: number; itemId?: number; participant?: 'reviewer' };
const denied = () => fail(appError('cloud_workspace_forbidden', 'input', 'The original cloud result is unavailable.'));
const unavailable = () => fail(appError('cloud_result_unavailable', 'runtime', 'The original cloud result delivery could not be confirmed.', true));

/** Delivery diagnostics never execute a model or transfer ownership to another Work. */
export class CloudDeliveryAuthority {
  private readonly workspaceId: string;
  constructor(private readonly options: { database: Pick<DbHandle, 'read'>; workspaceId: string; runtime: CloudRuntimeDeliveryPort }) {
    this.workspaceId = CloudWorkspaceIdSchema.parse(options.workspaceId);
  }
  private owner(scope: SqlDatabaseStore, input: Owner): boolean {
    const row = scope.db.query('SELECT id FROM invoice_work_attempts WHERE id=? AND work_id=?').get(input.attemptId, input.workId);
    const work = scope.db.query<{ session_id: number }, [number]>('SELECT session_id FROM invoice_works WHERE id=?').get(input.workId);
    const session = scope.sessions.get(input.sessionId);
    return !!row && work?.session_id === input.sessionId && (input.itemId === undefined
      || !!scope.db.query('SELECT id FROM invoice_work_items WHERE work_id=? AND id=?').get(input.workId, input.itemId)) && session.ok && session.data.runtimeKind === 'durable'
      && session.data.durableRuntimeId !== 'local' && session.data.cloudWorkspaceId === this.workspaceId;
  }
  private phase(scope: SqlDatabaseStore, input: Owner & { requestId: string; nativeSubmissionId?: number }, checkItem = true): boolean {
    const row = scope.db.query<{ native_submission_id: number | null; item_id: number | null; scheduler_state: string; reviewer_phase: number | null }, [number, number, string]>(
      `SELECT p.native_submission_id,p.item_id,p.scheduler_state,r.phase_id reviewer_phase FROM invoice_work_phases p
        LEFT JOIN invoice_work_peer_reviews r ON r.phase_id=p.id AND r.attempt_id=p.attempt_id AND r.work_id=p.work_id AND r.item_id=p.item_id
        WHERE p.work_id=? AND p.attempt_id=? AND p.request_id=?`)
      .get(input.workId, input.attemptId, input.requestId);
    return !!row && (!checkItem || ((input.participant === 'reviewer') === (row.reviewer_phase !== null)
      && (row.scheduler_state === 'legacy' ? input.itemId === undefined : input.itemId === row.item_id)))
      && (input.nativeSubmissionId === undefined || row.native_submission_id === null || row.native_submission_id === input.nativeSubmissionId);
  }
  async status(raw: unknown) {
    const parsed = CloudRuntimeStatusRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data;
    try {
      if (!await this.options.database.read(scope => this.owner(scope, input))) return denied();
      const result = await this.options.runtime.status(input); if (!result.ok) return result;
      const checked = CloudRuntimeStatusSchema.safeParse(result.data);
      if (!checked.success || checked.data.workId !== input.workId || checked.data.sessionId !== input.sessionId
        || checked.data.attemptId !== input.attemptId || checked.data.results.items.length > input.limit
        || input.afterSubmissionId !== undefined && checked.data.results.items.some(item => item.nativeSubmissionId <= input.afterSubmissionId!)) return unavailable();
      const valid = await this.options.database.read(scope => {
        const session = scope.sessions.get(input.sessionId);
        return this.owner(scope, input) && session.ok && session.data.runtimeKind === 'durable'
          && session.data.durableConversationId === checked.data.native.conversationId
          && (!checked.data.wake?.requestId || this.phase(scope, { ...input, requestId: checked.data.wake.requestId }, false))
          && checked.data.results.items.every(item => this.phase(scope, { ...input, itemId: item.itemId, participant: item.participant,
            requestId: item.requestId, nativeSubmissionId: item.nativeSubmissionId }));
      });
      return valid ? ok(checked.data) : denied();
    } catch { return unavailable(); }
  }
  async retry(raw: unknown) {
    const parsed = CloudRuntimeRetryRequestSchema.safeParse(raw); if (!parsed.success) return denied();
    const input = parsed.data;
    try {
      if (!await this.options.database.read(scope => this.owner(scope, input) && this.phase(scope, input))) return denied();
      const result = await this.options.runtime.retry(input); if (!result.ok) return result;
      const checked = CloudRuntimeRetryReceiptSchema.safeParse(result.data);
      return checked.success && checked.data.workId === input.workId && checked.data.sessionId === input.sessionId
        && checked.data.itemId === input.itemId && checked.data.participant === input.participant && checked.data.attemptId === input.attemptId && checked.data.requestId === input.requestId
        && checked.data.nativeSubmissionId === input.nativeSubmissionId ? ok(checked.data) : unavailable();
    } catch { return unavailable(); }
  }
}
