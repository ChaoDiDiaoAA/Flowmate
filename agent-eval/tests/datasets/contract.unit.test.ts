import { test, expect } from 'bun:test';
import { caseSchema, checkSchema, resolveCase } from '../../src/datasets/local.ts';
import { evaluateAll } from '../../src/scoring/evaluate.ts';
import { task, dataset, observed, projected } from '../support/fixtures.ts';

test('a conversation-only task needs neither invoice material nor invoice Gold', () => {
    const draft = { ...task, input: { prompt: '请记住本次任务代号青竹。' }, expected: {
        success: ['后续追问正确使用代号'], failure: ['混入其他会话代号'],
        checks: [{ metric: 'fact-check', required: true, evidence: 'answer-facts', path: ['project'], equals: '青竹' }]
    } };
    const parsed = caseSchema.parse(draft);
    expect(parsed.input.materials).toEqual([]);
    expect(parsed.expected.reference).toBeUndefined();
    // No invoice tree exists here: source lookup must be lazy for material-free tasks.
    expect(resolveCase(dataset, parsed, '/no-invoice-source').projected).toEqual({ prompt: draft.input.prompt, materials: [] });
});

test('selecting field or line grading still requires the corresponding reference', () => {
    const draft = { ...task, expected: { success: ['字段正确'], failure: ['字段错误'], checks: [{ metric: 'reference-fields', required: true }] } };
    expect(() => caseSchema.parse(draft)).toThrow();
    expect(() => caseSchema.parse({ ...draft, expected: { ...draft.expected, reference: task.expected.reference,
        checks: [{ metric: 'line-items', required: true }] } })).toThrow();
});

test('evidence relations compare two actual objects; absent facts cannot become equality or zero', async () => {
    const check = checkSchema.parse({ metric: 'fact-check', required: true, evidence: 'export', path: ['candidateId'],
        compareTo: { evidence: 'acceptance', path: ['candidateId'] } });
    const result = observed();
    result.evidence.export = { present: true, actual: { candidateId: 42 }, source: 'file-readback:trial/export.json' };
    result.evidence.acceptance = { present: true, actual: { candidateId: 42 }, source: 'db-query:job-1' };
    const run = () => evaluateAll({ task, result, projected, judge: null }, [check]);
    expect((await run()).scores[0]!.status).toBe('PASS');
    result.evidence.acceptance.actual = { candidateId: 43 };
    expect((await run()).scores[0]!.status).toBe('FAIL');
    result.evidence.acceptance.actual = {};
    expect((await run()).scores[0]!.status).toBe('UNJUDGEABLE');
    result.evidence.export.actual = { candidateId: null };
    result.evidence.acceptance.actual = { candidateId: null };
    expect((await run()).scores[0]!.status).toBe('UNJUDGEABLE');
    delete result.evidence.acceptance;
    expect((await run()).scores[0]!.value).toBeNull();
    expect(() => checkSchema.parse({ ...check, equals: 42 })).toThrow();
});

test('required tool membership permits other legal calls but not missing or malformed evidence', async () => {
    const check = checkSchema.parse({ metric: 'fact-check', required: true, evidence: 'tools', path: ['names'],
        operator: 'includes', equals: 'read_parsed_document' });
    const result = observed();
    const run = () => evaluateAll({ task, result, projected, judge: null }, [check]);
    for (const [names, wanted] of [
        [['read_evidence', 'read_parsed_document', 'save_invoice_candidate'], 'PASS'],
        [['save_invoice_candidate'], 'FAIL'], ['read_parsed_document', 'UNJUDGEABLE']
    ] as const) {
        result.evidence.tools = { present: true, actual: { names }, source: 'gateway:trial/tool-calls' };
        expect((await run()).scores[0]!.status).toBe(wanted);
    }
});
