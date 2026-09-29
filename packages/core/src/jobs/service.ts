import { appError, fail } from '@flowmate/contracts';
import type { Result, StartTaskRequest, TaskOperation } from '@flowmate/contracts';
import { StartTaskRequestSchema } from '@flowmate/contracts';
import type { JobRepository } from '../storage/repositories.ts';

export class JobService {
  public constructor(private readonly repository: JobRepository, private readonly now: () => string) {}

  public hide(jobId: number) {
    if (!Number.isSafeInteger(jobId) || jobId < 1) return fail(appError('input_invalid', 'input', 'Processing record ID is invalid.'));
    return this.repository.hide(jobId, this.now());
  }

  public create(raw: StartTaskRequest): Result<TaskOperation> {
    const parsed = StartTaskRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Start Task 参数无效。'));
    const goal = parsed.data.goal.trim();
    const byteLength = new TextEncoder().encode(goal).byteLength;
    if (byteLength < 1 || byteLength > 4096) return fail(appError('input_invalid', 'input', '任务目标必须为 1–4,096 UTF-8 字节。'));
    return this.repository.create({ ...parsed.data, goal, at: this.now() });
  }

  public queryOperation(clientSequence: number): Result<TaskOperation | null> {
    if (!Number.isSafeInteger(clientSequence) || clientSequence < 1) {
      return fail(appError('input_invalid', 'input', 'Start Task 客户端序号无效。'));
    }
    return this.repository.queryOperation(clientSequence, this.now());
  }
}

export function createJobService(repository: JobRepository, now: () => string): JobService {
  return new JobService(repository, now);
}
