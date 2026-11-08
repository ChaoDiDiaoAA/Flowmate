import { z } from 'zod';
import { CloudRuntimeIdSchema, CloudWorkspaceIdSchema } from './durable-runtime.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const child = z.object({ childRunId: id, childSessionId: id, originToolCallId: id, nativeToolTaskId: id, nativeSubmissionId: id }).strict();
export const isRetryableCloudModelStatus = (status: number) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
export const CloudModelAttemptRequestSchema = z.object({ workspaceId: CloudWorkspaceIdSchema, cloudRuntimeId: CloudRuntimeIdSchema,
  workId: id, sessionId: id, itemId: id.optional(), attemptId: id, phaseId: id, requestId: name,
  nativeConversationId: id, nativeSubmissionId: id, nativeTaskId: id, checkpointEntryId: id,
  transportOrdinal: z.number().int().min(0).max(3), modelAttemptId: CloudRuntimeIdSchema,
  model: name, body: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 1_100_000),
  kind: z.enum(['generation', 'compaction']).default('generation'), compactionOperationId: name.optional(), child: child.optional(),
}).strict().refine(value => value.kind === 'compaction' ? value.compactionOperationId !== undefined : value.compactionOperationId === undefined)
  .refine(value => { try { const body: unknown = JSON.parse(value.body); return body !== null && typeof body === 'object'
    && !Array.isArray(body) && 'model' in body && body.model === value.model; } catch { return false; } },
  'The original model request body must name its bound model.');
export type CloudModelAttemptRequest = z.input<typeof CloudModelAttemptRequestSchema>;
export type CloudModelAttempt = z.output<typeof CloudModelAttemptRequestSchema>;
