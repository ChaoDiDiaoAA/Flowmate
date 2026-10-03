import { appError, fail } from '@flowmate/contracts';
import type { CandidateSelection, Result, WorkspaceSnapshot, WorkspaceRestoreResult } from '@flowmate/contracts';
import { SelectCandidateRequestSchema, WorkspaceUpdateRequestSchema } from '@flowmate/contracts';
import type { WorkspaceRepository } from '../storage/repositories.ts';
import type { WorkspaceVerifier } from './verification.ts';

export class WorkspaceService {
  public constructor(private readonly repository: WorkspaceRepository, private readonly now: () => string, private readonly verify: WorkspaceVerifier) {}

  public read(): Result<WorkspaceSnapshot> {
    if (typeof this.verify !== 'function') return unavailableWorkspace();
    return this.repository.read(this.now(), this.verify);
  }

  public update(raw: unknown): Result<WorkspaceSnapshot> {
    const parsed = WorkspaceUpdateRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidWorkspace();
    return this.repository.update({ ...parsed.data, at: this.now() }, this.verify);
  }

  public restore(): Result<WorkspaceRestoreResult> {
    if (typeof this.verify !== 'function') return unavailableWorkspace();
    const at = this.now();
    const current = this.repository.read(at);
    return current.ok ? this.repository.restore({ expectedRevision: current.data.revision, at }, this.verify) : current;
  }

  public selectCandidate(raw: unknown): Result<CandidateSelection> {
    const parsed = SelectCandidateRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', '候选选择参数无效。'));
    return this.repository.selectCandidate({ ...parsed.data, at: this.now() });
  }
}

function invalidWorkspace<T>(): Result<T> {
  return fail(appError('input_invalid', 'input', 'Workspace 更新参数无效。'));
}
function unavailableWorkspace<T>(): Result<T> { return fail(appError('workspace_unavailable', 'storage', 'Workspace verifier is unavailable.', true)); }

export function createWorkspaceService(repository: WorkspaceRepository, now: () => string, verify: WorkspaceVerifier): WorkspaceService {
  return new WorkspaceService(repository, now, verify);
}
