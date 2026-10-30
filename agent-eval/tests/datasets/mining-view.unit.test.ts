import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';

async function project(trace: TraceBundle, limit?: number) {
    const path = '../../src/curation/mining-view.ts', module = await import(path).catch(() => ({}));
    expect(module.buildMiningView).toBeFunction(); return module.buildMiningView(trace, limit);
}
function sample(): TraceBundle {
    const at = '2026-10-28T00:00:00.000Z';
    return { id: '43a5944e-4c49-47a8-8337-435377d26aab', revision: 1, source: { kind: 'evaluation', executionId: 'controlled', trialId: 'trial-1' }, entry: 'evaluation',
        startedAt: at, endedAt: at, input: { prompt: '  请根据原始资料保存候选。\n', turns: [{ id: 'later', role: 'user', content: '\n保留币种。  ' }] },
        output: { answer: 'Agent claimed completion.', artifacts: [{ id: 'candidate-1', kind: 'candidate', content: { candidateId: 1, fields: { currency: 'WRONG' } } }] },
        status: 'FAIL', complete: true, gaps: [], configuration: { agent: { model: 'controlled-model' } },
        materials: [{ id: 'source', path: 'materials/source/source.md', text: 'Independent contract says CNY.' },
            { id: 'image', path: 'invoice-input/source/original.jpg', encoding: 'base64', content: 'BINARY_CANARY'.repeat(30000) }],
        facts: { scores: [{ metricId: 'reference-fields', status: 'FAIL', required: true, reason: 'Currency differs from the independent contract.' }],
            evidence: { 'candidate-values': { present: true, actual: { fields: { currency: { normalized: 'WRONG' } } }, source: 'Original committed candidate' },
                'context-requests': { present: true, actual: [{ snapshots: [{ text: 'SDK_COPY_CANARY'.repeat(20000) }] }], source: 'Actual contexts' },
                environment: { present: true, actual: { fresh: true, runtimeSource: { files: [{ text: 'ENV_CODE_CANARY'.repeat(20000) }] } }, source: 'Actual isolation' } } },
        events: [{ id: 'tool-1', kind: 'tool', name: 'save_invoice_candidate', startedAt: at, endedAt: at,
            input: { raw: { currency: 'cny' }, final: { currency: 'WRONG' } }, output: { status: 'failed', error: { code: 'candidate_invalid', message: 'Original tool failure' } } },
            ...Array.from({ length: 5 }, (_, index) => ({ id: 'gen-' + index, kind: 'generation', name: 'Model', startedAt: at, endedAt: at,
                input: { tools: [{ name: 'save_invoice_candidate', input_schema: { type: 'object' } }], messages: [{ content: 'SDK_COPY_CANARY'.repeat(20000) }] },
                output: { role: 'assistant', content: [{ type: 'text', text: 'Original step ' + index }] } }))] };
}
test('mining view preserves whole business facts, goals and source pointers while excluding binary and duplicate SDK/environment copies', async () => {
    const trace = sample(), original = JSON.stringify(trace), view = await project(trace);
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(192 * 1024);
    expect(view.input).toEqual(trace.input); expect(view.status).toBe('FAIL'); expect(view.gaps).toEqual([]);
    expect(view.output).toEqual(trace.output); expect(view.facts.scores[0]).toMatchObject({ metricId: 'reference-fields', status: 'FAIL', required: true, pointer: '/facts/scores/0' });
    const tool = view.events.find((event: any) => event.kind === 'tool');
    expect(tool).toMatchObject({ pointer: '/events/0', input: { raw: { currency: 'cny' }, final: { currency: 'WRONG' } }, output: { error: { code: 'candidate_invalid' } } });
    expect(view.materials[0]).toMatchObject({ id: 'source', text: 'Independent contract says CNY.', pointer: '/materials/0' });
    expect(JSON.stringify(view)).not.toContain('BINARY_CANARY'); expect(JSON.stringify(view)).not.toContain('SDK_COPY_CANARY'); expect(JSON.stringify(view)).not.toContain('ENV_CODE_CANARY');
    expect(view.audit.omitted.some((item: any) => item.pointer === '/materials/1/content')).toBe(true);
    expect(view.audit.projectionComplete).toBe(false); expect(view.audit.unknown.length).toBeGreaterThan(0); expect(JSON.stringify(trace)).toBe(original);
});
test('a budget omits entire optional entries and never slices a field into seemingly complete evidence', async () => {
    const trace = sample(); trace.events.push({ kind: 'tool', id: 'large-tool', name: 'read_invoice_document', input: { raw: {}, final: {} },
        output: { text: 'LARGE_VALUE_BEGIN' + 'x'.repeat(50000) + 'LARGE_VALUE_END' } });
    const view = await project(trace, 16000), serialized = JSON.stringify(view);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16000);
    expect(serialized).not.toContain('LARGE_VALUE_BEGIN'); expect(serialized).not.toContain('LARGE_VALUE_END');
    expect(view.audit.omitted.some((item: any) => item.pointer === '/events/6' && item.reason.includes('budget'))).toBe(true);
    expect(view.input.prompt).toBe(trace.input.prompt);
});
const livePath = join(REPO_ROOT, 'agent-eval/traces/43a5944e-4c49-47a8-8337-435377d26aab/trace.json');
test.skipIf(!existsSync(livePath))('the local FM001 failure artifact is projected without changing its original Trace or scoring facts', async () => {
    const path = livePath;
    const original = readFileSync(path, 'utf8'), trace = JSON.parse(original), view = await project(trace);
    expect(view.audit.sourceJsonBytes).toBe(Buffer.byteLength(JSON.stringify(trace)));
    expect(view.audit.ready).toBe(true); expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(192 * 1024);
    expect(view.input.prompt).toBe(trace.input.prompt); expect(view.events.filter((event: any) => event.kind === 'tool')).toHaveLength(20);
    expect(view.facts.scores.filter((score: any) => score.status === 'FAIL').map((score: any) => [score.metricId, score.required]))
        .toEqual(trace.facts.scores.filter((score: any) => score.status === 'FAIL').map((score: any) => [score.metricId, score.required]));
    expect(view.output.artifacts[0].content.fields).toEqual(trace.output.artifacts[0].content.fields);
    expect(readFileSync(path, 'utf8')).toBe(original);
});
test('mandatory Goal overflow is explicit and distinct changed tool definitions are retained', async () => {
    const trace = sample(); trace.input.prompt = 'x'.repeat(300000);
    const unavailable = await project(trace); expect(unavailable.audit.ready).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(unavailable))).toBeLessThanOrEqual(192 * 1024);
    const changed = sample(), event = changed.events[2] as any;
    event.input.tools[0].input_schema = { type: 'object', required: ['currency'] };
    const view = await project(changed); expect(view.toolDefinitions).toHaveLength(2);
});
