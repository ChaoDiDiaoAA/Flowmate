import { expect, test } from 'bun:test';
import { reportFixture } from '../support/fixtures.ts';
import { buildObservationTree, sendObservationTree } from '../../src/langfuse/otel.ts';

test('OTEL projection preserves actual root and child input/output without exporting independent Gold', () => {
  const report = reportFixture(), trial = report.trials[0]!;
  trial.execution!.input = { prompt: 'Extract the invoice', materials: [] };
  trial.execution!.answer = 'Saved candidate 7';
  trial.execution!.artifacts = [];
  trial.execution!.observations = [{ id: 'model-1', kind: 'generation', name: 'model', startedAt: report.startedAt, endedAt: report.endedAt,
    input: { message: 'Extract the invoice' }, output: { answer: 'Saved candidate 7' }, model: 'test-model' },
    { id: 'tool-1', parentId: 'model-1', kind: 'tool', name: 'save_invoice_candidate', startedAt: report.startedAt, endedAt: report.endedAt,
      input: { amount: 12 }, output: { candidateId: 7 } }];
  trial.caseConditions = { gold: { answer: 'PRIVATE_REFERENCE_ONLY' } };
  const tree = buildObservationTree(report);
  const root = tree.find(span => span.type === 'agent')!;
  expect(root.input).toEqual({ prompt: 'Extract the invoice', materials: [] });
  expect(root.output).toEqual({ answer: 'Saved candidate 7', endpointReached: true, status: 'PASS', artifacts: [] });
  const generation = tree.find(span => span.type === 'generation')!;
  const tool = tree.find(span => span.type === 'tool')!;
  expect(generation.parentId).toBe(root.id);
  expect(tool.parentId).toBe(generation.id);
  expect(tool.output).toEqual({ candidateId: 7 });
  expect(tree.every(span => span.metadata.executionId === 'unit' && span.metadata.trialId === 'trial-1')).toBe(true);
  expect(JSON.stringify(tree)).not.toContain('PRIVATE_REFERENCE_ONLY');
});

test('OTEL projection refuses unfinished spans instead of exporting an invented finish time', () => {
  const report = reportFixture();
  report.trials[0]!.execution!.observations = [{ id: 'unfinished', kind: 'tool', name: 'read', startedAt: report.startedAt, endedAt: null }];
  expect(() => buildObservationTree(report)).toThrow('unfinished');
});

test('real SDK processor exports parentage, original I/O, timing and searchable metadata on every observation', async () => {
  const report = reportFixture(); report.userId = 'eval-demo-user'; report.trials[0]!.sessionId = 'Eval-trial-one';
  report.trials[0]!.execution!.observations = [{ id: 'model', kind: 'generation', name: 'Model', startedAt: report.startedAt,
    endedAt: report.endedAt, input: { question: 'actual' }, output: 'answer', model: 'test', usage: { inputTokens: 3, outputTokens: 2 } }];
  const captured: any[] = [];
  const sent = await sendObservationTree(buildObservationTree(report), { baseUrl: 'http://localhost:1', publicKey: 'test', secretKey: 'test' },
    { exporter: { export(spans, callback) { captured.push(...spans); callback({ code: 0 }); }, async shutdown() {} } });
  expect(captured).toHaveLength(2);
  const root = captured.find(s => s.name === 'Sample')!, model = captured.find(s => s.name === 'Model')!;
  expect(model.parentSpanContext.spanId).toBe(root.spanContext().spanId);
  expect(sent.traceIds).toEqual([report.trials[0]!.traceId]);
  expect(model.attributes['langfuse.observation.input']).toBe('{"question":"actual"}');
  expect(model.attributes['langfuse.observation.usage_details']).toBe('{"input":3,"output":2}');
  expect(root.attributes['langfuse.trace.input']).toBe(JSON.stringify(report.trials[0]!.execution!.input));
  expect(captured.every(s => s.attributes['langfuse.observation.metadata.executionId'] === 'unit')).toBe(true);
  expect(captured.every(s => s.attributes['user.id'] === 'eval-demo-user' && s.attributes['session.id'] === 'Eval-trial-one')).toBe(true);
  expect(root.endTime[0] - root.startTime[0]).toBe(1);
});

test('native Codex observed usage survives the real OTEL processor without inventing a total or cost', async () => {
  const captured: any[] = [];
  const usage = { input_tokens: 11, cached_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 2 };
  await sendObservationTree([{ id: 'native-judge', traceId: '123456789abc4def8abc123456789abc', name: 'Native Judge', type: 'evaluator',
    start: '2026-10-28T00:00:00.000Z', end: '2026-10-28T00:00:01.000Z', model: 'gpt-6.1-terra', metadata: { originalUsage: usage }, usage }],
    { baseUrl: 'http://localhost:1', publicKey: 'test', secretKey: 'test' },
    { exporter: { export(spans, callback) { captured.push(...spans); callback({ code: 0 }); }, async shutdown() {} } });
  expect(JSON.parse(captured[0].attributes['langfuse.observation.usage_details'])).toEqual({ input: 11, output: 4 });
  expect(JSON.parse(captured[0].attributes['langfuse.observation.metadata.originalUsage'])).toEqual(usage);
});

test('a trial root ends at its own last actual Judge end and declares why protected Judge input is absent', () => {
  const report = reportFixture(); report.endedAt = '2026-09-23T00:01:00Z';
  report.trials[0]!.judgeCalls = [{ callId: 'judge', configuration: { transport: 'codex-cli', provider: 'codex-cli', model: 'terra', reasoningEffort: 'medium', timeoutMs: 1000,
    protocolVersion: 'flowmate-judge/v2' }, startedAt: '2026-09-23T00:00:02Z', endedAt: '2026-09-23T00:00:04Z', attempts: 1,
    request: { system: 'PRIVATE_GOLD', data: 'PRIVATE_GOLD', redacted: false }, raw: '', error: null, judgment: null, responseComplete: true,
    stopReason: 'stop', usageSource: 'unknown', usage: undefined, compact: undefined } as any];
  const tree = buildObservationTree(report), root = tree[0]!, judge = tree.find(node => node.type === 'evaluator')!;
  expect(root.end).toBe('2026-09-23T00:00:04Z'); expect(judge.end).toBe(root.end);
  expect(judge.input).toBeUndefined(); expect(judge.metadata).toMatchObject({ inputOmittedReason: 'independent-quality-reference', inputOmittedSource: 'local-judge-request' });
  expect(JSON.stringify(tree)).not.toContain('PRIVATE_GOLD');
  report.trials[0]!.execution!.endedAt = null;
  expect(buildObservationTree(report)[0]!.end).toBe('2026-09-23T00:00:04Z');
});
