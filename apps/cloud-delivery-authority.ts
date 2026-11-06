import { appError, CloudRuntimeRetryReceiptSchema, CloudRuntimeRetryRequestSchema, CloudRuntimeStatusRequestSchema, CloudRuntimeStatusSchema,
  CloudWorkspaceIdSchema, fail, ok, type CloudRuntimeDeliveryPort, type Result } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../packages/core/src/storage/database.ts';

type Owner = { workId: number; sessionId: number; attemptId: number };
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
    return !!row && work?.session_id === input.sessionId && session.ok && session.data.runtimeKind === 'durable'
      && session.data.durableRuntimeId !== 'local' && session.data.cloudWorkspaceId === this.workspaceId;
  }
  private phase(scope: SqlDatabaseStore, input: Owner & { requestId: string; nativeSubmissionId?: number }): boolean {
    const row = scope.db.query<{ native_submission_id: number | null }, [number, number, string]>(
      'SELECT native_submission_id FROM invoice_work_phases WHERE work_id=? AND attempt_id=? AND request_id=?')
      .get(input.workId, input.attemptId, input.requestId);
    return !!row && (input.nativeSubmissionId === undefined || row.native_submission_id === null || row.native_submission_id === input.nativeSubmissionId);
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
          && (!checked.data.wake?.requestId || this.phase(scope, { ...input, requestId: checked.data.wake.requestId }))
          && checked.data.results.items.every(item => this.phase(scope, { ...input, requestId: item.requestId, nativeSubmissionId: item.nativeSubmissionId }));
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
        && checked.data.attemptId === input.attemptId && checked.data.requestId === input.requestId
        && checked.data.nativeSubmissionId === input.nativeSubmissionId ? ok(checked.data) : unavailable();
    } catch { return unavailable(); }
  }
}
