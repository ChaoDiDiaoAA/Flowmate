import { appError, fail } from '@flowmate/contracts';
import type { CandidateSelection, Result, WorkspaceSnapshot, WorkspaceRestoreResult } from '@flowmate/contracts';
import { SelectCandidateRequestSchema, WorkspaceUpdateRequestSchema } from '@flowmate/contracts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import type { WorkspaceVerifier } from './verification.ts';

export class WorkspaceService {
  public constructor(private readonly database: Pick<DbHandle, 'transaction'>, private readonly now: () => string, private readonly verify: WorkspaceVerifier) {}

  private async command<T>(operation: (store: SqlDatabaseStore) => Result<T>, failureCode: 'storage_read_failed' | 'storage_write_failed'): Promise<Result<T>> {
    let rejected: Result<never> | undefined;
    try {
      return await this.database.transaction(store => {
        const result = operation(store);
        if (!result.ok) { rejected = result; throw new Error('workspace_command_rejected'); }
        return result;
      });
    } catch { return rejected ?? fail(appError(failureCode, 'storage', 'Workspace operation could not be confirmed.', true)); }
  }

  public async read(): Promise<Result<WorkspaceSnapshot>> {
    if (typeof this.verify !== 'function') return unavailableWorkspace();
    return this.command(store => store.workspace.read(this.now(), input => this.verify(input, store)), 'storage_read_failed');
  }

  public async update(raw: unknown): Promise<Result<WorkspaceSnapshot>> {
    const parsed = WorkspaceUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidWorkspace();
    if (typeof this.verify !== 'function') return unavailableWorkspace();
    return this.command(store => store.workspace.update({ ...parsed.data, at: this.now() }, input => this.verify(input, store)), 'storage_write_failed');
  }

  public async restore(): Promise<Result<WorkspaceRestoreResult>> {
    if (typeof this.verify !== 'function') return unavailableWorkspace();
    return this.command(store => {
      const at = this.now();
      const current = store.workspace.read(at);
      return current.ok ? store.workspace.restore({ expectedRevision: current.data.revision, at }, input => this.verify(input, store)) : current;
    }, 'storage_write_failed');
  }

  public async selectCandidate(raw: unknown): Promise<Result<CandidateSelection>> {
    const parsed = SelectCandidateRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', '候选选择参数无效。'));
    return this.command(store => store.workspace.selectCandidate({ ...parsed.data, at: this.now() }), 'storage_write_failed');
  }
}

function invalidWorkspace<T>(): Result<T> {
  return fail(appError('input_invalid', 'input', 'Workspace 更新参数无效。'));
}
function unavailableWorkspace<T>(): Result<T> { return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true)); }

export function createWorkspaceService(database: Pick<DbHandle, 'transaction'>, now: () => string, verify: WorkspaceVerifier): WorkspaceService {
  return new WorkspaceService(database, now, verify);
}
