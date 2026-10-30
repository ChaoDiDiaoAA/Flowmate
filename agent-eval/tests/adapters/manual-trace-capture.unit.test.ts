import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { createProductTraceRecorder, type CapturedRun } from '../../../packages/logging/src/product-trace.ts';
import type { CompactionObservation } from '@flowmate/contracts';
import { attachCapturedTrace } from '../../src/adapters/trace-capture.ts';
import { observed } from '../support/fixtures.ts';

function fixture(captureManual = true, foreign = false) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-manual-attachment-')), productRoot = join(root, 'product'); mkdirSync(productRoot);
  const at = '2026-10-28T01:00:00Z', endedAt = '2026-10-28T01:00:01Z';
  const operation: CompactionObservation = { operationId: randomUUID(), sessionId: 2, nativeSessionId: 'manual-native', runId: null, reason: 'manual',
    observationSequence: 4, phase: 'ended', generated: true, nativeOutcome: 'succeeded', entryId: 'summary-entry',
    saved: { commitRevision: 2, entryCount: 4, leafId: 'summary-entry' }, error: null, stopRequested: false, stopped: true, continuation: 'next-run', mayContinue: true,
    capacity: { tokens: 10, source: 'message-estimate', contextWindow: 64000, thresholdTokens: 47616, fitsEstimate: true },
    usage: { version: 1, source: 'sdk', reason: 'sdk-usage-presence-unconfirmed',
      sdkValues: { input: 19, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 29,
        costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0 },
      attempts: 1, attemptsComplete: true, costSource: null, updatedAt: endedAt },
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } };
  const run: CapturedRun = { kind: 'agent', runId: 7, sessionId: 2, status: 'completed', input: { version: 1, goal: 'read', text: 'Original user instruction', messageTimestamp: 1 },
    output: { text: 'Original answer' }, config: {}, cleanup: { stopped: true }, createdAt: at, startedAt: at, endedAt };
  const recorder = createProductTraceRecorder({ workspaceRoot: root, productRoot, enabled: () => true });
  for (const phase of ['request', 'response'] as const) recorder.observeModel({ runId: run.runId, sessionId: 2, callSequence: 1,
    phase, at: phase === 'request' ? at : endedAt, model: 'controlled', api: 'openai-completions', data: { text: phase } });
  recorder.complete({ run, tools: [], events: [] });
  if (captureManual) {
    for (const phase of ['request', 'response'] as const) recorder.observeModel({ runId: null, operationId: operation.operationId, sessionId: foreign ? 99 : 2,
      callSequence: 1, phase, purpose: 'summary-history', at: phase === 'request' ? at : endedAt, model: 'controlled', api: 'openai-completions', data: { nativeSummary: phase } });
    recorder.observeCompaction({ ...operation, sessionId: foreign ? 99 : 2 }, endedAt);
  }
  const execution = observed();
  execution.evidence.runs = { present: true, actual: [run], source: 'actual Run receipt' };
  execution.evidence['history-operations'] = { present: true, actual: [{ action: 'compact-history', operationId: operation.operationId,
    command: { type: 'compact_session', input: { sessionId: 2, operationId: operation.operationId } },
    after: { sessionId: 2, operation } }], source: 'actual compaction query receipt' };
  return { root, execution, operation };
}
test('manual spans merge into the Trial using original operation and session receipts', () => {
  const f = fixture(); attachCapturedTrace(f.execution, f.root);
  expect(f.execution.evidence['trace-capture']?.present).toBe(true);
  const span = f.execution.observations.find(item => item.id === f.execution.identity.trialId + ':operation:' + f.operation.operationId);
  expect(span).toMatchObject({ kind: 'span', parameters: { purpose: 'native-maintenance', operationId: f.operation.operationId, sessionId: 2 } });
  expect(f.execution.observations.some(item => item.kind === 'generation' && item.parentId === span?.id &&
    (item.input as { nativeSummary?: string }).nativeSummary === 'request')).toBe(true);
  expect(f.execution.observations.find(item => item.kind === 'generation' && item.parentId === span?.id))
    .toMatchObject({ usage: { input: 19, output: 7, cacheRead: 3, totalTokens: 29 }, parameters: { usageSource: 'sdk' } });
});
test('a complete Run capture cannot hide a missing manual summary capture', () => {
  const f = fixture(false); attachCapturedTrace(f.execution, f.root);
  expect(f.execution.evidence['trace-capture']?.present).toBe(false);
  expect(f.execution.evidence['trace-capture']?.actual).toHaveProperty('gaps', ['manual-compaction-capture-missing:' + f.operation.operationId]);
});
test('manual captures from a foreign session are rejected', () => {
  const f = fixture(true, true); expect(() => attachCapturedTrace(f.execution, f.root)).toThrow('Foreign Trace capture');
});
