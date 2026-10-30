import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { observed } from '../support/fixtures.ts';
import { executeCase } from '../../src/execution/execute-case.ts';
import type { AgentKernel, AgentTrial } from '../../src/adapters/agent.ts';
import type { CaseExecutionResult } from '../../src/types.ts';

const at = '2026-10-28T01:00:00.000Z';
function stoppedExecution(): CaseExecutionResult {
  const result = observed();
  result.evidence.runs = { present: true, source: 'Original owned root and child queries', actual: [
    { runId: 1, sessionId: 1, kind: 'agent', status: 'completed', endedAt: at, stoppedAt: at,
      cleanup: { stopped: true, lateObservationRequired: false } },
    { runId: 2, sessionId: 2, kind: 'subagent', parentRunId: 1, status: 'completed', endedAt: at, stoppedAt: at,
      cleanup: { stopped: true, lateObservationRequired: false } },
  ] };
  result.evidence.subagents = { present: true, source: 'Complete owned child pages and detail', actual: { children: [
    { childRunId: 2, childSessionId: 2, parentRunId: 1, parentSessionId: 1, status: 'completed', stopConfirmed: true,
      cleanup: { stopped: true, lateObservationRequired: false } },
  ], stopUnconfirmed: [] } };
  result.evidence['history-operations'] = { present: true, source: 'Original manual operation query', actual: [
    { action: 'compact-history', after: { operation: { phase: 'ended', stopped: true } } },
  ] };
  result.evidence.cleanup = { present: true, actual: { closed: true, stopped: true, errors: [] }, source: 'Owned Host close receipt and actual child exit' };
  return result;
}
async function fixture(change?: (result: CaseExecutionResult) => void, failure: 'error' | 'deadline' = 'error', failFinal = false, snapshot = stoppedExecution()) {
  const result = structuredClone(snapshot); change?.(result);
  const directory = mkdtempSync(join(tmpdir(), 'flowmate-stop-reconcile-'));
  const trial: AgentTrial = { identity: result.identity, input: result.input, directory, requires: [], configuration: {} };
  let snapshots = 0, stopSnapshots = 0, fullSnapshots = 0, cancellations = 0, closes = 0, executions = 0;
  const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'Controlled lifecycle only' }), async prepare() {
    return { input: result.input, async execute() { executions++; return new Promise(() => {}); },
      async snapshot(options) {
        snapshots++;
        if(options?.stopOnly)stopSnapshots++;else fullSnapshots++;
        if (snapshots === 1) {
          if (failure === 'deadline') return new Promise(() => {});
          throw Error('Original first snapshot transport failure');
        }
        if (failFinal) throw Error('Final snapshot unavailable');
        return result;
      }, async cancel() { cancellations++; }, async close() { closes++; return result.evidence.cleanup!; } };
  } };
  const value = await executeCase(kernel, trial, 5, 30);
  return { ...value, directory, counts: { snapshots, stopSnapshots, fullSnapshots, cancellations, closes, executions } };
}

test.each(['error', 'deadline'] as const)('a recovered %s snapshot does not erase timeout quality or block a proven stopped Trial', async failure => {
  const result = await fixture(undefined, failure);
  expect(result.stopFailed).toBe(false);
  expect(result.execution).toMatchObject({ status: 'timeout', endpointReached: false, error: { code: 'task_timeout', message: 'Error: Task budget exhausted' } });
  // Two bounded stop observations are followed by one separately bounded full collection.
  expect(result.counts).toEqual({ snapshots: 3, stopSnapshots: 2, fullSnapshots: 1, cancellations: 1, closes: 1, executions: 1 });
  expect(result.execution.evidence['lifecycle-diagnostics']).toMatchObject({ present: true, actual: { stopReconciled: true,
    executionError: { code: 'task_timeout' }, errors: [{ stage: 'snapshot-after-execution-error', error: failure === 'error'
      ? 'Error: Original first snapshot transport failure' : 'Error: Lifecycle timeout' }] } });
  const saved = JSON.parse(readFileSync(join(result.directory, 'execution.json'), 'utf8'));
  expect(saved.error.code).toBe('task_timeout');
  expect(saved.evidence['lifecycle-diagnostics']).toEqual(result.execution.evidence['lifecycle-diagnostics']);
});

test.each(['root-running', 'original-stop', 'snapshot-stop-unconfirmed', 'run-collection-gap', 'child-stop', 'child-collection-gap', 'missing-child-run', 'manual-operation', 'restart-host', 'host-unconfirmed'] as const)
('Host exit alone cannot reconcile %s', async mode => {
  const result = await fixture(execution => {
    const runs = execution.evidence.runs!.actual as Array<Record<string, unknown>>;
    const children = execution.evidence.subagents!.actual as { children: Array<Record<string, unknown>>; stopUnconfirmed: number[] };
    if (mode === 'root-running') runs[0]!.status = 'running';
    if (mode === 'original-stop') runs[0]!.cleanup = { stopped: false, lateObservationRequired: true };
    if (mode === 'snapshot-stop-unconfirmed') execution.error = { code: 'stop_unconfirmed', message: 'Actual original descendant stop gap', infrastructure: true };
    if (mode === 'run-collection-gap') execution.evidence.runs!.present = false;
    if (mode === 'child-stop') { children.children[0]!.stopConfirmed = false; children.stopUnconfirmed.push(2); }
    if (mode === 'child-collection-gap') execution.evidence.subagents!.present = false;
    if (mode === 'missing-child-run') runs.pop();
    if (mode === 'manual-operation') execution.evidence['history-operations']!.actual = [{ action: 'compact-history', after: { operation: { phase: 'ended', stopped: false } } }];
    if (mode === 'restart-host') execution.evidence['history-operations']!.actual = [{ action: 'restart-host', verified: false }];
    if (mode === 'host-unconfirmed') execution.evidence.cleanup!.actual = { closed: true, stopped: false };
  });
  expect(result.execution.evidence.cleanup).toMatchObject({ present: true, actual: { closed: true, stopped: mode !== 'host-unconfirmed' } });
  expect(result.stopFailed).toBe(true);
  expect(result.execution.evidence['lifecycle-diagnostics']).toMatchObject({ actual: { stopReconciled: false, executionError: { code: 'task_timeout' } } });
  if (mode === 'snapshot-stop-unconfirmed') expect(result.execution.evidence['lifecycle-diagnostics']).toMatchObject({ actual: {
    stopError: { code: 'stop_unconfirmed', message: 'Actual original descendant stop gap', infrastructure: true } } });
});

test('a missing final snapshot preserves both observed failures and remains unconfirmed after Host exit', async () => {
  const result = await fixture(undefined, 'error', true);
  expect(result.stopFailed).toBe(true);
  expect(result.execution.evidence['lifecycle-diagnostics']).toMatchObject({ actual: { stopReconciled: false,
    executionError: { code: 'task_timeout' }, errors: [{ stage: 'snapshot-after-execution-error', error: 'Error: Original first snapshot transport failure' },
      { stage: 'snapshot-after-cancel', error: 'Error: Final snapshot unavailable' }] } });
  expect(result.execution.error).toMatchObject({ code: 'task_timeout', message: 'Error: Task budget exhausted' });
});

test('absent child and maintenance channels do not block a Trial which cannot own those actors', async () => {
  const result = await fixture(execution => {
    (execution.evidence.runs!.actual as unknown[]).pop();
    delete execution.evidence.subagents; delete execution.evidence['history-operations'];
  });
  expect(result.stopFailed).toBe(false); expect(result.execution.error?.code).toBe('task_timeout');
});

const actualSnapshot = process.env.FLOWMATE_STOP_RECONCILIATION_EXECUTION;
test.skipIf(!actualSnapshot)('the original FM005 final snapshot and actual close receipt satisfy stop reconciliation without changing old facts', async () => {
  const bytes = readFileSync(actualSnapshot!, 'utf8'), snapshot: CaseExecutionResult = JSON.parse(bytes);
  expect(snapshot.identity.caseId).toBe('FM-005');
  expect(snapshot.evidence.cleanup).toMatchObject({ present: true, actual: { stopped: true, closed: true, errors: [] } });
  // Only the first collection fault is controlled; final stop evidence is read unchanged from the original owned Host.
  const result = await fixture(undefined, 'error', false, snapshot);
  expect(result.stopFailed).toBe(false); expect(result.execution.error?.code).toBe('task_timeout');
  expect(result.execution.evidence.runs).toEqual(snapshot.evidence.runs);
  expect(result.execution.evidence.cleanup).toEqual(snapshot.evidence.cleanup);
  expect(readFileSync(actualSnapshot!, 'utf8')).toBe(bytes);
});
