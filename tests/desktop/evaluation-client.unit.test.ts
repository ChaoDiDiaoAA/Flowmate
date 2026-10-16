import { expect, test } from 'bun:test';
import type { EvaluationControlState } from '@flowmate/contracts';
import { retainEvaluationControl as retain } from '../../apps/desktop/main/evaluation-client.ts';

test('an older control reply cannot replace newer progress in the same batch or session', () => {
  const current: EvaluationControlState = { version: 1, sessionId: 'worker-1', batchId: 'batch-1', requestId: 'start-1', state: 'running',
    outcome: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, executionIds: ['execution-1'], progress: null, stop: 'pending', errors: [] };
  const stale = { ...current, state: 'preparing' as const, executionIds: [], stop: 'not-started' as const };
  expect(retain?.(current, 4, stale, 1)).toEqual(current);
  expect(retain?.(current, 4, { ...current, state: 'cancelling' }, 5)).toMatchObject({ state: 'cancelling' });
  expect(retain?.(current, 4, { ...stale, batchId: 'other-batch' }, 1)).toMatchObject({ batchId: 'other-batch' });
});
