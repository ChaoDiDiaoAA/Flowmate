import { expect, test } from 'bun:test';
import { applyEvaluationEvent, applyEvaluationControl, createEvaluationView, evaluationBusy } from '../../apps/desktop/renderer/src/evaluation-state.ts';
import type { EvaluationControlState } from '@flowmate/contracts';

const control: EvaluationControlState = { version: 1, sessionId: 'session-1', batchId: 'batch-1', requestId: 'request-1',
  state: 'running', outcome: null, startedAt: '2026-01-01T00:00:00Z', endedAt: null, executionIds: [], progress: null, stop: 'pending', errors: [] };
test('late control receipts cannot replace newer progress or a confirmed terminal event', () => {
  const initial = createEvaluationView(), revision = initial.revision;
  const running = applyEvaluationEvent(initial, { version: 1, sessionId: 'session-1', sequence: 1, control });
  expect(applyEvaluationControl(running, { ...control, state: 'preparing' }, revision)).toBe(running);
  const finished = applyEvaluationEvent(running, { version: 1, sessionId: 'session-1', sequence: 2,
    control: { ...control, state: 'finished', outcome: 'completed', stop: 'confirmed', endedAt: '2026-01-01T00:00:01Z' } });
  expect(applyEvaluationEvent(finished, { version: 1, sessionId: 'session-1', sequence: 1, control })).toBe(finished);
  expect(finished.control?.state).toBe('finished'); expect(evaluationBusy(finished.control)).toBe(false);
});
test('foreign sessions never replace a bound view and unknown stopping remains busy', () => {
  const current = applyEvaluationControl(createEvaluationView(), control, 0);
  expect(applyEvaluationEvent(current, { version: 1, sessionId: 'other', sequence: 10,
    control: { ...control, sessionId: 'other' } })).toBe(current);
  expect(applyEvaluationControl(current, { ...control, sessionId: 'other' }, current.revision)).toBe(current);
  expect(evaluationBusy({ ...control, state: 'stop-unconfirmed', stop: 'unconfirmed' })).toBe(true);
  expect(evaluationBusy({ ...control, state: 'interrupted' })).toBe(true);
});

test('a current control query can bind a new idle Worker only after the previous batch is confirmed inactive', () => {
  const finished = applyEvaluationEvent(createEvaluationView(), { version: 1, sessionId: 'session-1', sequence: 9,
    control: { ...control, state: 'finished', outcome: 'completed', stop: 'confirmed', endedAt: '2026-01-01T00:00:01Z' } });
  const idle: EvaluationControlState = { ...control, sessionId: 'session-2', batchId: null, requestId: null,
    state: 'idle', outcome: null, startedAt: null, endedAt: null, stop: 'not-started' };
  const rebound = applyEvaluationControl(finished, idle, finished.revision);
  expect(rebound.control?.sessionId).toBe('session-2'); expect(rebound.sequence).toBe(0);
  const next = applyEvaluationEvent(rebound, { version: 1, sessionId: 'session-2', sequence: 1,
    control: { ...control, sessionId: 'session-2', batchId: 'batch-2', requestId: 'request-2' } });
  expect(next.control?.batchId).toBe('batch-2'); expect(next.sequence).toBe(1);
  expect(applyEvaluationEvent(next, { version: 1, sessionId: 'session-1', sequence: 10, control })).toBe(next);
  const unknown = { ...finished, control: { ...control, state: 'interrupted' as const, stop: 'unconfirmed' as const } };
  expect(applyEvaluationControl(unknown, idle, unknown.revision)).toBe(unknown);
});
