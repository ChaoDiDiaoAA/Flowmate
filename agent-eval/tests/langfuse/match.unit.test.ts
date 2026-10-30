import { test, expect } from 'bun:test';
import { matchObservationTree, type ObservationRow } from '../../src/langfuse/read.ts';
import type { ObservationNode } from '../../src/langfuse/otel.ts';
const traceId = '123456789abc4def8abc123456789abc';
const nodes: ObservationNode[] = [
  { id: 'root', traceId, name: 'Task', type: 'agent', start: '2026-10-28T00:00:00Z', end: '2026-10-28T00:00:03Z',
    input: { prompt: 'Task' }, output: 'Done', metadata: { configuration: { model: 'luna' }, runId: '0012' } },
  { id: 'judge', traceId, parentId: 'root', name: 'Judge', type: 'evaluator', start: '2026-10-28T00:00:01Z', end: '2026-10-28T00:00:03Z',
    output: [{ value: 1 }], model: 'terra', parameters: { reasoningEffort: 'medium' }, usage: { input_tokens: 3 },
    metadata: { inputOmittedReason: 'independent-quality-reference', inputOmittedSource: 'local-judge-request', judge: { model: 'terra' } } },
];
const rows: ObservationRow[] = [
  { id: 'span-root', traceId, parentObservationId: null, name: 'Task', type: 'AGENT', startTime: '2026-10-28T00:00:00.000Z', endTime: '2026-10-28T00:00:03.000Z',
    input: '{"prompt":"Task"}', output: 'Done', metadata: { localObservationId: 'root', configuration: '{"model":"luna"}', runId: '0012' } },
  { id: 'span-judge', traceId, parentObservationId: 'span-root', name: 'Judge', type: 'EVALUATOR', startTime: '2026-10-28T00:00:01.000Z', endTime: '2026-10-28T00:00:03.000Z',
    input: null, output: '[{"value":1}]', model: 'terra', modelParameters: { reasoningEffort: 'medium' }, usageDetails: { input: 3, total: 3 },
    metadata: { localObservationId: 'judge', inputOmittedReason: 'independent-quality-reference', inputOmittedSource: 'local-judge-request', judge: { model: 'terra' } } },
];
test('strict observation matching accepts API-null omitted Judge input and rejects every declared field drift', () => {
  expect(matchObservationTree(nodes, rows)).toMatchObject({ complete: true, matchedIds: ['root', 'judge'], gaps: [] });
  for (const change of [{ name: 'Foreign' }, { type: 'TOOL' }, { startTime: '2026-10-28T00:00:02Z' }, { endTime: '2026-10-28T00:00:04Z' },
    { parentObservationId: null }, { input: 'LEAKED_REFERENCE' }, { output: null }, { model: 'different' }, { modelParameters: {} }, { usageDetails: {} },
    { metadata: { ...rows[1]!.metadata as object, judge: { model: 'different' } } }]) {
    expect(matchObservationTree(nodes, [rows[0]!, { ...rows[1]!, ...change }]).complete, JSON.stringify(change)).toBe(false);
  }
  expect(matchObservationTree(nodes, [{ ...rows[0]!, metadata: { localObservationId: 'root', configuration: { model: 'different' } } }, rows[1]!]).complete).toBe(false);
  expect(matchObservationTree(nodes, [...rows, rows[1]!]).complete).toBe(false);
  expect(matchObservationTree(nodes, [rows[0]!]).complete).toBe(false);
});
test('omission is allowed only for an undeclared value, while explicit null and root input stay declared', () => {
  expect(matchObservationTree(nodes, [{ ...rows[0]!, input: null }, rows[1]!]).complete).toBe(false);
  const declaredNull = [{ ...nodes[0]!, input: null }];
  expect(matchObservationTree(declaredNull, [{ ...rows[0]!, input: undefined }]).complete).toBe(false);
  expect(matchObservationTree(declaredNull, [{ ...rows[0]!, input: null }]).complete).toBe(true);
  expect(matchObservationTree([{ ...nodes[0]!, output: { answer: 'Done', unused: undefined } }],
    [{ ...rows[0]!, output: '{"answer":"Done"}' }]).complete).toBe(true);
});

const causalNodes: ObservationNode[] = [{ ...nodes[0]!, type: 'generation', end: '2026-10-28T00:00:01Z' },
  { id: 'tool', traceId, parentId: 'root', name: 'save_invoice_candidate', type: 'tool',
    start: '2026-10-28T00:00:01.164Z', end: '2026-10-28T00:00:01.262Z', input: { amount: 12 }, output: { candidateId: 1 }, metadata: {} }];
const causalRows: ObservationRow[] = [{ ...rows[0]!, type: 'GENERATION', endTime: '2026-10-28T00:00:01.000Z' },
  { id: 'span-tool', traceId, parentObservationId: 'span-root', name: 'save_invoice_candidate', type: 'TOOL',
    startTime: '2026-10-28T00:00:01.164Z', endTime: '2026-10-28T00:00:01.262Z',
    input: '{"amount":12}', output: '{"candidateId":1}', metadata: { localObservationId: 'tool' } }];

test('an exact tool observation may start after its causal generation parent has ended', () => {
  expect(matchObservationTree(causalNodes, causalRows)).toEqual({ complete: true, matchedIds: ['root', 'tool'], gaps: [] });
});

test('causal parent timing never excuses invalid own intervals, remote time drift or a foreign parent', () => {
  expect(matchObservationTree([causalNodes[0]!, { ...causalNodes[1]!, start: '2026-10-28T00:00:02Z', end: '2026-10-28T00:00:01Z' }],
    [causalRows[0]!, { ...causalRows[1]!, startTime: '2026-10-28T00:00:02Z', endTime: '2026-10-28T00:00:01Z' }]).complete).toBe(false);
  expect(matchObservationTree(causalNodes, [causalRows[0]!, { ...causalRows[1]!, startTime: '2026-10-28T00:00:01.165Z' }]).complete).toBe(false);
  expect(matchObservationTree(causalNodes, [causalRows[0]!, { ...causalRows[1]!, parentObservationId: 'foreign-span' }]).complete).toBe(false);
  expect(matchObservationTree(causalNodes, [{ ...causalRows[0]!, traceId: 'abcdef0123456789abcdef0123456789' }, causalRows[1]!]).complete).toBe(false);
  expect(matchObservationTree(causalNodes, [...causalRows, causalRows[0]!]).complete).toBe(false);
});
