import { appError, fail } from '@flowmate/contracts';
import type { CandidateSelection, Result, WorkspaceSnapshot } from '@flowmate/contracts';
import { SelectCandidateRequestSchema, WorkspaceChangeSchema } from '@flowmate/contracts';
import type { WorkspaceRepository } from '../storage/repositories.ts';

export class WorkspaceService {
  public constructor(private readonly repository: WorkspaceRepository, private readonly now: () => string) {}

  public read(): Result<WorkspaceSnapshot> {
    return this.repository.read(this.now());
  }

  public update(raw: unknown): Result<WorkspaceSnapshot> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidWorkspace();
    const input = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) return invalidWorkspace();
    const change = WorkspaceChangeSchema.safeParse(input.change);
    if (!change.success || Object.keys(input).some((key) => !['expectedRevision', 'change'].includes(key))) return invalidWorkspace();
    return this.repository.update({ expectedRevision: Number(input.expectedRevision), change: change.data, at: this.now() });
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

export function createWorkspaceService(repository: WorkspaceRepository, now: () => string): WorkspaceService {
  return new WorkspaceService(repository, now);
}
