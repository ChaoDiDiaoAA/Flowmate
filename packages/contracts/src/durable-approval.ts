import { z } from 'zod';
import type { Result } from './runtime.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DurableApprovalWaitIdentitySchema = z.object({ workId: id, sessionId: id, attemptId: id, phaseId: id,
  requestId: z.string().min(1).max(128), itemId: id, nativeConversationId: id, nativeTaskId: id, proposalId: id,
  kind: z.enum(['desktop', 'browser']) }).strict();
export type DurableApprovalWaitIdentity = z.infer<typeof DurableApprovalWaitIdentitySchema>;
export const DurableApprovalWaitStateSchema = z.object({ status: z.enum(['waiting', 'approved', 'rejected', 'invalidated', 'unknown']),
  scheduling: z.enum(['active', 'waiting_approval', 'ready']), decisionRequestId: z.string().min(1).max(128).nullable(),
  deviceReady: z.boolean().optional() }).strict();
export type DurableApprovalWaitState = z.infer<typeof DurableApprovalWaitStateSchema>;
export type DurableApprovalWaitCallbacks = {
  begin(input: DurableApprovalWaitIdentity): Promise<Result<DurableApprovalWaitState>>;
  read(input: DurableApprovalWaitIdentity): Promise<Result<DurableApprovalWaitState>>;
};
