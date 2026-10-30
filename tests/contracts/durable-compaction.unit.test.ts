import { expect, it } from 'bun:test';
import { DurableCompactionRequestSchema, DurableCompactionObservationSchema } from '../../packages/contracts/src/durable-compaction.ts';

const request = { workId: 1, sessionId: 2, attemptId: 3, requestId: 'original-phase', operationId: 'original-compaction',
  reason: 'threshold', expectedTailEntryId: 7, instructions: null };

it('keeps the compaction operation separate from its original phase and rejects foreign child ownership', () => {
  expect(DurableCompactionRequestSchema.safeParse(request).success).toBe(true);
  expect(DurableCompactionRequestSchema.safeParse({ ...request, nativeTaskId: 9 }).success).toBe(false);
  expect(DurableCompactionRequestSchema.safeParse({ ...request, child: { workId: 4, sessionId: 2, attemptId: 3,
    requestId: 'original-phase', childRunId: 5, childSessionId: 6, originToolCallId: 7, nativeToolTaskId: 8 } }).success).toBe(false);
});

it('does not infer a saved summary or stopped write from a completed native task', () => {
  const observation = { ...request, nativeConversationId: 11, nativeTaskId: 12, nativeTaskStatus: 'terminal', outcome: 'completed',
    firstKeptEntryId: 6, summaryEntryId: null, writeSubmissionId: 13, writeStatus: 'queued',
    summaryGenerated: true, summarySaved: false, stopped: false, cancelRequestedAt: null, error: null, usage: null };
  expect(DurableCompactionObservationSchema.safeParse(observation).success).toBe(true);
  expect(DurableCompactionObservationSchema.safeParse({ ...observation, summarySaved: true }).success).toBe(false);
  expect(DurableCompactionObservationSchema.safeParse({ ...observation, stopped: true }).success).toBe(false);
  expect(DurableCompactionObservationSchema.safeParse({ ...observation, summaryEntryId: 14, writeStatus: 'done', summarySaved: true, stopped: true }).success).toBe(true);
  for (const outcome of ['faulted', 'orphaned'])
    expect(DurableCompactionObservationSchema.safeParse({ ...observation, outcome, summaryGenerated: false,
      writeSubmissionId: null, writeStatus: null, stopped: true }).success).toBe(true);
});
