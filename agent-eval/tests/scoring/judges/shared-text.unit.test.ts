import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSharedTextInput, decodeJudgeInput, nativeJudgeMaxInputChars, sharedTextEncoding } from '../../../src/scoring/judges/shared-text.ts';
import { runCompactJudge } from '../../../src/scoring/judges/harness.ts';
import { compactRubricFor, compactScores, rubricsFor, type CompactPlan } from '../../../src/scoring/judges/compact.ts';
import type { NativeJudgeConfig } from '../../../src/scoring/judges/client.ts';
import type { ProcessRunner } from '../../../src/text-model/codex.ts';
import { evaluatorEvidence } from '../../../src/scoring/judges/evaluators.ts';
import { reportFixture } from '../../support/fixtures.ts';
import { saveReport, readReport } from '../../../src/reports/store.ts';
import { formalMetric } from '../../../src/scoring/catalog.ts';

const plan: CompactPlan = { contract: 'flowmate-semantic-plan/v1', criteria: [{ metricId: 'completion-verification', version: 1,
  unit: '终结机会', denominator: null, required: true, rule: 'Check every terminal opportunity against original evidence.', evidence: ['original'], trigger: 'started' }] };
const native: NativeJudgeConfig = { provider: 'codex-cli', executable: 'controlled-codex', model: 'gpt-6.1-terra', reasoningEffort: 'medium', timeoutMs: 10000 };
const long = 'Original source item, amount 12.00; preserve every character.\n'.repeat(7000);
const evidence = { original: long, inputs: [long, long, long], answer: 'Uncertain.' };
const original = (value: unknown, selected = plan) => ({ plan: selected, evidence: evaluatorEvidence(selected, value) });
const restored = (data: string, sharedText = true) => decodeJudgeInput<ReturnType<typeof original>>(data, sharedText);
function runnerFor(selected: CompactPlan, inspect: (data: string, args: string[]) => void): ProcessRunner {
  return async (_exe, args, options) => {
    if (args.includes('--version')) return { code: 0, stdout: 'codex-cli controlled', stderr: '' };
    inspect(options.stdin, args);
    const text = JSON.stringify({ v: 1, results: selected.criteria.map(c => ({ metricId: c.metricId, counts: null, failures: [] })) });
    return { code: 0, stderr: '', stdout: [
      { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed', usage: { input_tokens: 1 } },
    ].map(event => JSON.stringify(event)).join('\n') };
  };
}

test('shared text preserves every original value and never interprets marker-shaped user objects', () => {
  const input = original({ ...evidence, originalObject: { wireEncoding: sharedTextEncoding, input: null,
    textReferences: [{ path: ['answer'], source: ['original'] }] }, numericObject: { '0': long }, unicode: '金额😀\r\n', null: null });
  const before = structuredClone(input), data = encodeSharedTextInput(JSON.stringify(input));
  expect(data.length).toBeLessThan(nativeJudgeMaxInputChars);
  expect(restored(data)).toEqual(before);
  expect(input).toEqual(before);
  expect(restored(JSON.stringify(input), false)).toEqual(input);
  const encoded = JSON.parse(data); encoded.textReferences[0].source = ['missing'];
  expect(() => decodeJudgeInput(JSON.stringify(encoded), true)).toThrow('shared-text');
});

test.each(['array target', 'object target', 'array source', 'object source'] as const)('shared-text rejects coerced %s keys before restoring any text', mode => {
  const envelope = { wireEncoding: sharedTextEncoding,
    input: { evidence: { originals: ['ORIGINAL_A', 'ORIGINAL_B'], named: { '0': 'ORIGINAL_A' }, copies: [null], slots: { '0': null } } },
    textReferences: [
      { path: ['evidence', 'copies', 0], source: ['evidence', 'originals', 0] },
      { path: ['evidence', 'copies', '0'], source: ['evidence', 'originals', 1] },
    ] };
  if (mode === 'object target') envelope.textReferences = [
    { path: ['evidence', 'slots', '0'], source: ['evidence', 'originals', 0] },
    { path: ['evidence', 'slots', 0], source: ['evidence', 'originals', 1] },
  ];
  if (mode === 'array source') envelope.textReferences = [{ path: ['evidence', 'copies', 0], source: ['evidence', 'originals', '0'] }];
  if (mode === 'object source') envelope.textReferences = [{ path: ['evidence', 'copies', 0], source: ['evidence', 'named', 0] }];
  expect(() => decodeJudgeInput(JSON.stringify(envelope), true)).toThrow('shared-text');
});

test('research original frame strings, block positions and UTF-16 witness offsets are never projected', () => {
  const researchFrame = { blocks: [{ key: 'claim:1', text: long + '😀' }], links: [], sources: [{ text: long }] };
  const input = original({ ...evidence, researchFrame, facts: { 'research-frame': { present: true, actual: researchFrame, source: 'Original frame' } } });
  const encoded = JSON.parse(encodeSharedTextInput(JSON.stringify(input)));
  expect(encoded.input.evidence.researchFrame).toEqual(researchFrame);
  expect(encoded.input.evidence.facts['research-frame'].actual).toEqual(researchFrame);
  expect(restored(JSON.stringify(encoded))).toEqual(input);
});

test('only an oversized native request uses a declared shared-text rubric and one actual native submission', async () => {
  let submissions = 0;
  const call = await runCompactJudge(native, plan, evidence, undefined, undefined, runnerFor(plan, (data, args) => {
    submissions++;
    expect(JSON.parse(data).wireEncoding).toBe(sharedTextEncoding);
    expect(data.length).toBeLessThanOrEqual(nativeJudgeMaxInputChars);
    expect(restored(data)).toEqual(original(evidence));
    expect(args).toContain('--output-schema');
    expect(JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf8')).properties.results).toBeDefined();
  }));
  expect(submissions).toBe(1); expect(call.attempts).toBe(1); expect(call.error).toBeNull();
  expect(call.configuration.rubric).toEqual({ id: 'semantic-metric-batch', version: 1 });
  expect(rubricsFor([plan], true).some(r => r.id === call.configuration.rubric?.id && r.prompt === call.request.system)).toBe(true);
  expect(restored(call.request.data)).toEqual(original(evidence));
  expect(compactScores(call)[0]!.status).toBe('UNJUDGEABLE');
  const root = mkdtempSync(join(tmpdir(), 'flowmate-shared-text-report-'));
  try {
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2';
    report.scoringConfiguration = { version: 1, judgeMode: 'required', judge: call.configuration, rubrics: rubricsFor([plan], true) };
    Object.assign(report.trials[0]!, { semanticPlan: plan, metricPlan: plan.criteria.map(({metricId,version,unit,denominator})=>({metricId,version,unit,denominator})),
      judgeCalls: [call], scores: compactScores(call), counts: { UNJUDGEABLE: 1 }, status: 'UNJUDGEABLE' });
    saveReport(join(root, 'report.json'), report);
    const saved = readReport(join(root, 'report.json')).trials[0]!.judgeCalls[0]!;
    expect(saved.request!.data).toBe(call.request.data);
    expect(restored(saved.request!.data)).toEqual(original(evidence));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('small native inputs retain the original plain request and rubric', async () => {
  const small = { source: 'Actual short evidence' };
  const call = await runCompactJudge(native, plan, small, undefined, undefined, runnerFor(plan, data => {
    expect(data).toBe(JSON.stringify(original(small)));
  }));
  expect(call.error).toBeNull(); expect(call.configuration.rubric?.id).toBe(compactRubricFor(plan).id);
});

test('irreducible oversized evidence is recorded as a preflight error without any process or model submission', async () => {
  let invocations = 0;
  const call = await runCompactJudge(native, plan, { original: long.repeat(3) }, undefined, undefined,
    async () => { invocations++; throw Error('Must not launch'); });
  expect(invocations).toBe(0); expect(call.attempts).toBe(0); expect(call.responseComplete).toBe(false);
  expect(call.error).toContain('1048576');
  expect(restored(call.request.data)).toEqual(original({ original: long.repeat(3) }));
});

test('native shared-text research still derives counts only from unchanged original UTF-16 witnesses', async () => {
  const selected: CompactPlan = { ...plan, criteria: [{ ...plan.criteria[0]!, metricId: 'DR01', unit: formalMetric('DR01').unit }] };
  const text = 'Alpha owns Beta.', researchFrame = { contract: 'flowmate-research-frame/v1', complete: true, reportId: 1,
    blocks: [{ kind: 'claim', key: 'claim:1', claimId: 1, text: '😀' + text }], links: [], sources: [],
    integrity: { valid: true, issues: [], links: [], sourceBindings: [] },
    gold: { status: 'verified', claims: [], chains: [], forbidden: [] }, rule: 'Independent original synthetic frame.' };
  const proof = { atoms: [{ block: 0, start: 2, length: text.length, correct: 0, needsCitation: false, covered: 0, gold: 0, matchUncertain: false }], links: [], chains: [] };
  let submissions = 0;
  const call = await runCompactJudge(native, selected, { ...evidence, researchFrame }, undefined, undefined, async (_exe, args, options) => {
    if (args.includes('--version')) return { code: 0, stdout: 'codex-cli controlled', stderr: '' };
    submissions++; expect(JSON.parse(options.stdin).input.evidence.researchFrame).toEqual(researchFrame);
    return { code: 0, stderr: '', stdout: [
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ v: 1, results: [{ metricId: 'DR01', counts: null, failures: [] }], research: proof }) } },
      { type: 'turn.completed', usage: { input_tokens: 1 } },
    ].map(event => JSON.stringify(event)).join('\n') };
  });
  expect(submissions).toBe(1); expect(call.configuration.rubric?.id).toBe('semantic-metric-batch');
  expect(call.error).toBeNull(); expect(call.compact?.validationErrors).toEqual({});
  expect(call.compact?.judgment?.r).toEqual([[0, 1, 0]]);
  expect(compactScores(call)[0]).toMatchObject({ status: 'FAIL', value: 0, actual: { row: [0, 1, 0] } });
});

const observed = process.env.FLOWMATE_JUDGE_OVERSIZE_OBSERVATION;
test.skipIf(!observed)('the saved FM024 failure becomes sub-limit with exact original input recovery', async () => {
  const saved = JSON.parse(readFileSync(observed!, 'utf8')).judgeCalls[0];
  const input = JSON.parse(saved.request.data);
  expect(saved.request.data.length).toBe(2037986);
  expect(saved.request.data.length).toBeGreaterThan(nativeJudgeMaxInputChars);
  const encoded = encodeSharedTextInput(saved.request.data);
  expect(encoded.length).toBeLessThan(nativeJudgeMaxInputChars);
  expect(decodeJudgeInput(encoded, true)).toEqual(input);
  let submissions = 0;
  // Stored evaluator declarations are rebuilt by the same production path, not replaced by selected passing evidence.
  const { evaluatorRubrics: _, ...rawEvidence } = input.evidence;
  const call = await runCompactJudge(native, input.plan, rawEvidence, undefined, undefined, runnerFor(input.plan, data => {
    submissions++; expect(decodeJudgeInput(data, true)).toEqual(input);
  }));
  expect(submissions).toBe(1); expect(call.error).toBeNull();
  expect(call.compact?.judgment?.r).toEqual(input.plan.criteria.map(() => null));
  console.log(JSON.stringify({ originalChars: saved.request.data.length, wireChars: call.request.data.length, originalInputRecovered: true, submissions }));
});
