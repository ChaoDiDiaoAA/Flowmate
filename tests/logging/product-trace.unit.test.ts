import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createProductTraceRecorder, type CapturedRun } from '../../packages/logging/src/product-trace.ts';
import { randomUUID } from 'node:crypto';
import type { CompactionObservation, UsageRecordV1 } from '@flowmate/contracts';
import { traceBundleToObservationTree } from '../../agent-eval/src/langfuse/otel.ts';
import { createCurationService } from '../../agent-eval/src/curation/index.ts';
import { readTraceState, updateTraceState, traceFile } from '../../agent-eval/src/curation/store.ts';
import { dispatchWorkflow } from '../../agent-eval/src/desktop/workflow.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-product-trace-')); roots.push(root);
  const recorder = createProductTraceRecorder({ workspaceRoot: root, enabled: () => enabled, secrets: () => ['private-provider-key'] });
  const run: CapturedRun = { kind: 'agent', runId: 7, sessionId: 2, status: 'completed',
    input: { version: 1, goal: 'answer', text: '  请核对原始资料。\n', messageTimestamp: 1 },
    output: { text: '已核对' }, config: { model: 'test' }, cleanup: { stopped: true },
    createdAt: '2026-10-28T01:00:00Z', startedAt: '2026-10-28T01:00:00Z', endedAt: '2026-10-28T01:00:01Z' };
  return { root, recorder, run };
}

test('opted-out product runs create no trace files', () => {
  const { root, recorder, run } = setup(false);
  recorder.observeModel({ runId: 7, sessionId: 2, callSequence: 1, phase: 'request', at: run.startedAt!, model: 'test', api: 'test', data: { messages: [] } });
  expect(recorder.complete({ run, tools: [], events: [] })).toBeNull();
  expect(existsSync(join(root, 'agent-eval/traces'))).toBe(false);
});

test('product capture flows into flat Trace discovery and processing while preserving controller operations', async () => {
  const { root, recorder, run } = setup();
  for (const phase of ['request', 'response'] as const) recorder.observeModel({ runId: 7, sessionId: 2, callSequence: 1, phase,
    at: phase === 'request' ? run.startedAt! : run.endedAt!, model: 'test', api: 'test', data: { text: phase } });
  const captured = recorder.complete({ run, tools: [], events: [] })!, curation = createCurationService(root);
  expect(curation.listTraces().map(value => value.id)).toEqual([captured.id]);
  expect(curation.readTrace(captured.id)).toEqual(captured);
  expect(traceFile(root, captured.id)).toMatch(/Trace-2026-10-28_090000-chats-task-01\.json$/);
  expect((await dispatchWorkflow(root, { action: 'trace.process', traceId: captured.id }, { env: {} })).exitCode).toBe(0);
  updateTraceState(root, captured.id, state => { state.operations.processing = { '1': { operation: 'controlled' } }; });
  run.output = { text: 'Later committed output' };
  const updated = recorder.complete({ run, tools: [], events: [] })!;
  expect(updated.revision).toBe(2); expect(curation.readTrace(captured.id)).toEqual(updated);
  expect(readTraceState(root, captured.id).operations.processing?.['1']).toEqual({ operation: 'controlled' });
});

test('captured native I/O preserves the original language and writes a stable source identity with secrets removed', () => {
  const { root, recorder, run } = setup();
  const request = { messages: [{ role: 'user', content: [{ type: 'text', text: '原件金额 12.00' }] }], apiKey: 'private-provider-key' };
  recorder.observeModel({ runId: 7, sessionId: 2, callSequence: 1, phase: 'request', at: run.startedAt!, model: 'test', api: 'test', data: request });
  recorder.observeModel({ runId: 7, sessionId: 2, callSequence: 1, phase: 'response', at: run.endedAt!, model: 'test', api: 'test', data: { content: [{ type: 'text', text: '已核对' }] } });
  const result = recorder.complete({ run, tools: [], events: [] })!;
  expect(result.input.prompt).toBe('  请核对原始资料。\n');
  expect(result.source).toEqual({ kind: 'product', runId: '7', sessionId: '2' });
  expect(result.complete).toBe(true);
  expect(result.entry).toBe('chats');
  expect(result.materials.some(material => material.text === '原件金额 12.00')).toBe(true);
  expect(result.materials.find(material => material.text === '原件金额 12.00')?.path).toBe('materials/request-7-1-0-0/source.txt');
  expect(JSON.stringify(result)).not.toContain('private-provider-key');
  expect(request.apiKey).toBe('private-provider-key');
  expect(JSON.parse(readFileSync(traceFile(root, result.id), 'utf8'))).toEqual(result);
  expect(recorder.complete({ run, tools: [], events: [] })!.id).toBe(result.id);
  expect(recorder.complete({ run, tools: [], events: [] })!.revision).toBe(result.revision);
  const restarted = createProductTraceRecorder({ workspaceRoot: root, enabled: () => true });
  expect(restarted.complete({ run, tools: [], events: [] })).toEqual(result);
  expect(JSON.stringify(JSON.parse(readFileSync(traceFile(root, result.id), 'utf8')).events)).toContain('model-7-1');
});

test('explicit entry and consumed multi-turn input retain their real order', () => {
  const { recorder, run } = setup();
  const turns = [{ id: 'input-9', role: 'user' as const, content: ' 原始提问\n', mode: 'prompt' as const },
    { id: 'input-12', role: 'user' as const, content: '追问', mode: 'followUp' as const }];
  const trace = recorder.complete({ run, tools: [], events: [], entry: 'research', turns })!;
  expect(trace.entry).toBe('research');
  expect(trace.input.turns).toEqual(turns);
});

test('missing model response and unconfirmed stopping remain capture gaps', () => {
  const { recorder, run } = setup(); run.cleanup = { stopped: false };
  recorder.observeModel({ runId: 7, sessionId: 2, callSequence: 1, phase: 'request', at: run.startedAt!, model: 'test', api: 'test', data: { messages: [] } });
  const result = recorder.complete({ run, tools: [], events: [] })!;
  expect(result.complete).toBe(false);
  expect(result.gaps).toContain('run-stop-unconfirmed:7');
  expect(result.gaps).toContain('model-response-missing:7:1');
});

test('summary generations retain their purpose and independent logical call identity', () => {
  const { recorder, run } = setup();
  for (const phase of ['request', 'response'] as const) recorder.observeModel({ runId: 7, sessionId: 2, callSequence: 2,
    purpose: 'summary-history', phase, at: phase === 'request' ? run.startedAt! : run.endedAt!, model: 'test', api: 'test', data: { text: phase } });
  const trace = recorder.complete({ run, tools: [], events: [] })!;
  expect(trace.events[0]).toMatchObject({ id: 'model-7-2', parameters: { purpose: 'summary-history' } });
});

test('generation usage follows logical call identity and never substitutes aggregate or unknown counters', () => {
  const { recorder, run } = setup();
  const measured: UsageRecordV1 = { version: 1, source: 'sdk', reason: 'sdk-usage-presence-unconfirmed', attempts: 1,
    attemptsComplete: true, costSource: null, updatedAt: run.endedAt!,
    sdkValues: { input: 19, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 31,
      costInput: 1, costOutput: 2, costCacheRead: 0, costCacheWrite: 0, costTotal: 3 } };
  const unknown: UsageRecordV1 = { ...measured, source: 'unknown', reason: 'sdk-zero-or-missing-presence-proof',
    sdkValues: { ...measured.sdkValues!, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
  run.usage = { ...unknown, version: 2, calls: [
    { callSequence: 1, usage: unknown, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } },
    { callSequence: 2, usage: measured, tokens: { inputTokens: 19, outputTokens: 7, totalTokens: 31, cost: null, usageComplete: false } },
  ] };
  for (const sequence of [2, 1, 3]) for (const phase of ['request', 'response'] as const) recorder.observeModel({ runId: 7, sessionId: 2,
    callSequence: sequence, phase, at: phase === 'request' ? run.startedAt! : run.endedAt!, model: 'test', api: 'test', data: { sequence } });
  const trace = recorder.complete({ run, tools: [], events: [] })!;
  const events = trace.events.map(event => event as Record<string, unknown>);
  expect(events.find(event => event.id === 'model-7-2')).toMatchObject({
    usage: { input: 19, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 31 }, parameters: { usageSource: 'sdk' } });
  for (const sequence of [1, 3]) expect(events.find(event => event.id === 'model-7-' + sequence)).not.toHaveProperty('usage');
  expect(traceBundleToObservationTree(trace).find(event => event.id.endsWith(':model-7-2'))?.usage)
    .toEqual({ input: 19, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 31 });
  // A legacy aggregate cannot be assigned to several generations without per-call evidence.
  run.usage = measured;
  expect(traceBundleToObservationTree(recorder.complete({ run, tools: [], events: [] })!).every(event => event.usage === undefined)).toBe(true);
});

function manualOperation(): CompactionObservation {
  return { operationId: randomUUID(), sessionId: 2, nativeSessionId: 'native-manual', runId: null, reason: 'manual', observationSequence: 4,
    phase: 'ended', generated: true, nativeOutcome: 'succeeded', entryId: 'saved-summary', saved: { commitRevision: 3, entryCount: 5, leafId: 'saved-summary' },
    error: null, stopRequested: false, stopped: true, continuation: 'next-run', mayContinue: true,
    capacity: { tokens: 100, source: 'message-estimate', contextWindow: 64000, thresholdTokens: 47616, fitsEstimate: true },
    usage: { version: 1, source: 'unknown', reason: 'controlled', sdkValues: null, attempts: 1, attemptsComplete: true, costSource: null,
      updatedAt: '2026-10-28T01:00:01Z' }, tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } };
}
test('manual maintenance stores actual summarizer I/O with operation identity and no invented Run or user turn', () => {
  const { root } = setup(); let automatic = 0;
  const recorder = createProductTraceRecorder({ workspaceRoot: root, productRoot: 'controlled-product', enabled: () => true, onComplete() { automatic++; } });
  const operation = manualOperation(), wireRequest = { messages: [{ role: 'user', content: 'Summarize the original native history.' }] };
  const request = { ...wireRequest, optionalTransportField: undefined };
  recorder.observeCompaction({ ...operation, phase: 'preparing', generated: false, entryId: null, saved: null, stopped: false, nativeOutcome: 'pending', mayContinue: false }, '2026-10-28T01:00:00Z');
  for (const phase of ['request', 'response'] as const) recorder.observeModel({ runId: null, operationId: operation.operationId, sessionId: operation.sessionId,
    callSequence: 1, purpose: 'summary-history', phase, at: phase === 'request' ? '2026-10-28T01:00:00Z' : '2026-10-28T01:00:01Z',
    model: 'controlled', api: 'openai-completions', data: phase === 'request' ? request : { content: [{ type: 'text', text: 'Actual native summary.' }] } });
  const awaitingCore = recorder.observeCompaction({ ...operation, mayContinue: false }, '2026-10-28T01:00:01Z')!;
  expect(awaitingCore.complete).toBe(false); expect(automatic).toBe(0);
  const trace = recorder.observeCompaction(operation, '2026-10-28T01:00:01Z')!;
  expect(trace.source).toEqual({ kind: 'product', sessionId: '2', operationId: operation.operationId, productRoot: 'controlled-product' });
  expect(trace.configuration).toMatchObject({ purpose: 'native-maintenance', operation: 'manual-compaction' });
  expect(JSON.parse(trace.input.prompt)).toEqual(wireRequest); expect(trace.input.turns).toBeUndefined();
  expect(trace.complete).toBe(true); expect(trace.facts.compaction).toEqual(operation); expect(automatic).toBe(1);
  expect(trace.events).toHaveLength(1);
  expect(trace.events[0]).toMatchObject({ kind: 'generation', input: wireRequest, output: { content: [{ type: 'text', text: 'Actual native summary.' }] } });
  expect(traceBundleToObservationTree(trace).find(node => node.type === 'generation')).toMatchObject({ type: 'generation', input: wireRequest });
  expect(recorder.observeCompaction(operation, '2026-10-28T01:00:01Z')!.id).toBe(trace.id);
});

test('manual capture keeps missing saving and stopping proof as gaps', () => {
  const { recorder } = setup(), operation = manualOperation();
  const trace = recorder.observeCompaction({ ...operation, saved: null, stopped: false, mayContinue: false }, '2026-10-28T01:00:01Z')!;
  expect(trace.complete).toBe(false);
  expect(trace.gaps).toContain('manual-summary-request-missing:' + operation.operationId);
  expect(trace.gaps).toContain('manual-compaction-save-unconfirmed:' + operation.operationId);
  expect(trace.gaps).toContain('manual-compaction-stop-unconfirmed:' + operation.operationId);
});
