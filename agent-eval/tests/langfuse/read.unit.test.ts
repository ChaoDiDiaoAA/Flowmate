import { test, expect } from 'bun:test';
import { pullLangfuseTraces, queryLangfuseObservations } from '../../src/langfuse/read.ts';
import { traceBundleToObservationTree } from '../../src/langfuse/otel.ts';
const connection = { baseUrl: 'http://localhost:1234', publicKey: 'test-public', secretKey: 'test-secret' };
const range = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
const traceId = '123456789abc4def8abc123456789abc';
test('observation read follows cursor with bounded range and complete field groups', async () => {
  const urls: URL[] = [];
  const rows = await queryLangfuseObservations(connection, { ...range, traceId }, { fetcher: async url => {
    const u = new URL(url); urls.push(u);
    return Response.json({ data: [{ id: String(urls.length), traceId }], meta: { cursor: urls.length === 1 ? 'next' : null } });
  } });
  expect(rows).toHaveLength(2); expect(urls[1]!.searchParams.get('cursor')).toBe('next');
  expect(urls[0]!.pathname).toBe('/api/public/v2/observations');
  expect(urls[0]!.searchParams.get('fromStartTime')).toBe(range.from);
  expect(urls[0]!.searchParams.get('fields')).toContain('io,metadata,model,usage');
});
test('a complete product trace round trips original material bytes and a normalized observation tree', async () => {
  const rows = [{ id: 'root', traceId, parentObservationId: null, startTime: range.from, endTime: range.to,
    input: JSON.stringify({ prompt: 'Invoice', materials: [{ sample: 'one', file: 'invoice.pdf', text: '12.00' }] }), output: 'saved',
    metadata: { flowmate: true, sourceKind: 'product', entry: 'invoices', runId: '1', sessionId: '2', userId: 'eval-demo-user', productRoot: 'C:/product/canary', revision: 1, configuration: { model: 'test' } } },
  { id: 'model', traceId, parentObservationId: 'root', type: 'GENERATION', name: 'Generate', startTime: range.from, endTime: range.to,
    input: '{"question":"total"}', output: '{"total":12}', providedModelName: 'actual-model', usageDetails: { input: 3 } }];
  const [bundle] = await pullLangfuseTraces('.', range, { connection, fetcher: async () => Response.json({ data: rows, meta: {} }) });
  expect(bundle!.complete).toBe(true); expect(bundle!.materials[0]).toMatchObject({ path: 'invoice.pdf', text: '12.00' });
  expect(bundle!.source).toEqual({ kind: 'product', runId: '1', sessionId: '2', userId: 'eval-demo-user', productRoot: 'C:/product/canary' });
  const tree = traceBundleToObservationTree(bundle!);
  expect(tree[1]!.type).toBe('generation'); expect(tree[1]!.parentId).toBe(tree[0]!.id);
  expect(tree[1]!.input).toEqual({ question: 'total' }); expect(tree[1]!.output).toEqual({ total: 12 });
  expect(tree[1]!.model).toBe('actual-model');
});
test('pull preserves source data and marks missing parents and untrusted provenance incomplete', async () => {
  const rows = [{ id: 'root', traceId, parentObservationId: null, startTime: range.from, endTime: range.to,
    input: JSON.stringify({ prompt: 'Invoice', materials: [] }), output: JSON.stringify({ answer: 'Saved' }),
    metadata: { flowmate: true, sourceKind: 'product', entry: 'invoices', runId: 'run-1', revision: 1, configuration: { model: 'test' } } },
  { id: 'tool', traceId, parentObservationId: 'missing', startTime: range.from }];
  const result = await pullLangfuseTraces('.', range, { connection, fetcher: async () => Response.json({ data: rows, meta: {} }) });
  expect(result[0]!.id).toBe('12345678-9abc-4def-8abc-123456789abc');
  expect(result[0]!.complete).toBe(false); expect(result[0]!.gaps.join(' ')).toContain('parent');
  expect(result[0]!.facts.langfuseObservations).toEqual(rows);
  expect(result[0]!.output).toEqual({ answer: 'Saved' });
  const unsupported = await pullLangfuseTraces('.', range, { connection, fetcher: async () => Response.json({ data: [{ ...rows[0], metadata: {} }], meta: {} }) });
  expect(unsupported[0]!.gaps.join(' ')).toContain('provenance');
});
test('read refuses invalid pages, repeated cursors and HTTP errors instead of claiming an empty successful pull', async () => {
  await expect(queryLangfuseObservations(connection, range, { fetcher: async () => Response.json({ data: [], meta: { cursor: 'same' } }) })).rejects.toThrow('cursor');
  await expect(queryLangfuseObservations(connection, range, { fetcher: async () => Response.json({ message: 'not a page' }) })).rejects.toThrow();
  await expect(queryLangfuseObservations(connection, range, { fetcher: async () => new Response(null, { status: 503 }) })).rejects.toThrow('503');
});

test('v2 numeric IDs normalize to identity strings while existing string IDs retain leading zeros', async () => {
  const rows = [{ id: 'root', traceId, parentObservationId: null, startTime: range.from, endTime: range.to,
    input: { prompt: 'Original', materials: [] }, output: { answer: 'Original' },
    metadata: { flowmate: true, sourceKind: 'product', entry: 'chats', runId: 12, sessionId: '00012', revision: 1, configuration: { model: 'test' } } }];
  const [bundle] = await pullLangfuseTraces('.', range, { connection, fetcher: async () => Response.json({ data: rows, meta: {} }) });
  expect(bundle!.source).toEqual({ kind: 'product', runId: '12', sessionId: '00012' });
});

test('only a declared protected evaluator input may be absent from an otherwise complete Agent trace', async () => {
  const metadata = { flowmate: true, sourceKind: 'evaluation', entry: 'evaluation', executionId: 'execution', trialId: 'trial', configuration: { model: 'test' } };
  const root = { id: 'root', traceId, parentObservationId: null, name: 'Task', type: 'AGENT', startTime: range.from, endTime: range.to,
    input: { prompt: 'Task', materials: [] }, output: 'Done', metadata };
  const judge = { id: 'judge', traceId, parentObservationId: 'root', name: 'Judge', type: 'EVALUATOR', startTime: range.from, endTime: range.to,
    input: null, output: [{ value: 1 }], metadata: { ...metadata, inputOmittedReason: 'independent-quality-reference', inputOmittedSource: 'local-judge-request' } };
  const pull = async (child: any) => (await pullLangfuseTraces('.', range, { connection, fetcher: async () => Response.json({ data: [root, child], meta: {} }) }))[0]!;
  expect((await pull(judge)).complete).toBe(true);
  expect((await pull({ ...judge, metadata })).gaps).toContain('Missing original observation input/output');
  expect((await pull({ ...judge, type: 'GENERATION' })).complete).toBe(false);
  expect((await pull({ ...judge, output: null })).complete).toBe(false);
});
