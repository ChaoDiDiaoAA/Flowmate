import { appError, fail } from '@flowmate/contracts';
import type { JobSnapshot, Result, StartTaskRequest, TaskOperation } from '@flowmate/contracts';
import { StartTaskRequestSchema } from '@flowmate/contracts';
import type { DbHandle } from '../storage/database.ts';

export class JobService {
  public constructor(private readonly database: Pick<DbHandle, 'read' | 'transaction'>, private readonly now: () => string) {}

  public async hide(jobId: number): Promise<Result<JobSnapshot>> {
    if (!Number.isSafeInteger(jobId) || jobId < 1) return fail(appError('input_invalid', 'input', 'Processing record ID is invalid.'));
    const at = this.now();
    return this.database.transaction(scope => scope.jobs.hide(jobId, at))
      .catch(() => fail(appError('storage_write_failed', 'storage', 'Processing record could not be hidden.', true)));
  }

  public async create(raw: StartTaskRequest): Promise<Result<TaskOperation>> {
    const parsed = StartTaskRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Start Task 参数无效。'));
    const goal = parsed.data.goal.trim();
    const byteLength = new TextEncoder().encode(goal).byteLength;
    if (byteLength < 1 || byteLength > 4096) return fail(appError('input_invalid', 'input', '任务目标必须为 1–4,096 UTF-8 字节。'));
    const input = { ...parsed.data, goal, at: this.now() };
    return this.database.transaction(scope => scope.jobs.create(input))
      .catch(() => fail(appError('storage_write_failed', 'storage', 'Task creation could not be confirmed.', true)));
  }

  public async queryOperation(clientSequence: number): Promise<Result<TaskOperation | null>> {
    if (!Number.isSafeInteger(clientSequence) || clientSequence < 1) {
      return fail(appError('input_invalid', 'input', 'Start Task 客户端序号无效。'));
    }
    const at = this.now();
    return this.database.read(scope => scope.jobs.queryOperation(clientSequence, at))
      .catch(() => fail(appError('storage_read_failed', 'storage', 'Task operation could not be read.', true)));
  }
}

export function createJobService(database: Pick<DbHandle, 'read' | 'transaction'>, now: () => string): JobService {
  return new JobService(database, now);
}
