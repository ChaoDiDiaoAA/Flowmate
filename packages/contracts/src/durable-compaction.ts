import { z } from 'zod';
import { AppErrorSchema, UsageRecordSchema, type Result } from './runtime.ts';
import { PersonalAgentConfigurationSchema } from './personal-agent.ts';
import { DurableModelBindingSchema } from './durable-runtime.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestId = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const phase = z.object({ workId: id, sessionId: id, attemptId: id, requestId }).strict();
const child = phase.extend({ childRunId: id, childSessionId: id, originToolCallId: id, nativeToolTaskId: id });
const identity = phase.extend({ operationId: requestId, child: child.optional() });
const ownsChild = (value: z.infer<typeof identity>) => !value.child || value.child.workId === value.workId
  && value.child.sessionId === value.sessionId && value.child.attemptId === value.attemptId && value.child.requestId === value.requestId;
export const DurableCompactionIdentitySchema = identity.refine(ownsChild, 'The summary belongs to another phase.');
export type DurableCompactionIdentity = z.infer<typeof DurableCompactionIdentitySchema>;
const request = identity.extend({ reason: z.enum(['manual', 'threshold', 'overflow']), expectedTailEntryId: id,
  instructions: z.string().max(22000).refine(value => new TextEncoder().encode(value).byteLength <= 22000).nullable() });
export const DurableCompactionRequestSchema = request.refine(ownsChild, 'The summary belongs to another phase.');
export type DurableCompactionRequest = z.infer<typeof DurableCompactionRequestSchema>;
export const DurableCompactionPlanSchema = request.extend({ binding: DurableModelBindingSchema,
  thinkingLevel: PersonalAgentConfigurationSchema.unwrap().innerType().shape.thinkingLevel,
}).refine(ownsChild, 'The summary belongs to another phase.');
export type DurableCompactionPlan = z.infer<typeof DurableCompactionPlanSchema>;
export const DurableCompactionObservationSchema = request.extend({ nativeConversationId: id, nativeTaskId: id,
  nativeTaskStatus: z.enum(['pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal']),
  outcome: z.enum(['completed', 'failed', 'aborted', 'faulted', 'orphaned']).nullable(), firstKeptEntryId: id.nullable(),
  summaryEntryId: id.nullable(), writeSubmissionId: id.nullable(),
  writeStatus: z.enum(['queued', 'placed', 'done', 'unanswered']).nullable(), summaryGenerated: z.boolean(), summarySaved: z.boolean(),
  stopped: z.boolean(), cancelRequestedAt: z.string().datetime({ offset: true }).nullable(),
  error: AppErrorSchema.nullable(), usage: UsageRecordSchema.nullable(),
}).refine(value => ownsChild(value) && (!value.summarySaved || value.summaryGenerated && value.summaryEntryId !== null
  && (value.writeSubmissionId === null || value.writeStatus === 'done'))
  && (value.summaryEntryId === null || value.summarySaved)
  && (!value.stopped || value.nativeTaskStatus === 'terminal'
    && (value.writeSubmissionId === null || value.writeStatus === 'done' || value.writeStatus === 'unanswered')),
  'A finished Task does not prove that its summary write was placed or stopped.');
export type DurableCompactionObservation = z.infer<typeof DurableCompactionObservationSchema>;

/** Summary requests reuse original phase authority and Work budgets; they are not business continuations. */
export type DurableCompactionCallbacks = {
  readPlan(input: DurableCompactionRequest): Promise<Result<DurableCompactionPlan>>;
  verify(input: DurableCompactionPlan): Promise<Result<void>>;
  reserveModelRequest(input: DurableCompactionPlan): Promise<Result<void>>;
};
