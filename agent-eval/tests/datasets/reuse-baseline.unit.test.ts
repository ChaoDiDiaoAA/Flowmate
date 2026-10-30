import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { candidateSchema, goldSchema } from '../../src/curation/schemas.ts';
import { goldByCaseId } from '../../src/datasets/gold.ts';
import { existingCaseSnapshots, resolveCandidateCase } from '../../src/curation/publication.ts';
import { expandCandidate } from '../../src/curation/expansion.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import type { TraceBundle } from '../../../packages/contracts/src/evaluation-loop.ts';
import { readDeclarationSource } from '../../src/dataset-loader/declarations.ts';
import { join } from 'node:path';

const formal = readDeclarationSource(join(REPO_ROOT, 'agent-eval/src/datasets'), REPO_ROOT);
for (const task of formal.dataset.cases) test(task.id + ' formal Case and Gold retain their exact original data contract', () => {
  const parsed = candidateSchema.parse({ id: randomUUID(), revision: 1, kind: 'regression', reuseCaseId: task.id,
    traceRef: { id: randomUUID(), revision: 1 }, reason: 'Formal data contract only; no unsafe workflow is executed.', sourceLabels: ['formal-original'],
    case: task, gold: formal.gold[task.id] });
  expect(parsed.case).toEqual(task); expect(parsed.gold).toEqual(formal.gold[task.id]);
  if (task.id >= 'FM-051') {
    expect(parsed.gold!.values.semantic).toEqual(formal.gold[task.id].values.semantic);
    expect(() => goldSchema.parse(formal.gold[task.id])).toThrow('semantic');
    const changed = structuredClone(formal.gold[task.id]); changed.values.semantic.criteria[0].criterion += ' Unapproved modification';
    expect(() => candidateSchema.parse({ ...parsed, gold: changed })).toThrow();
  }
});

const researchSnapshots = existingCaseSnapshots(REPO_ROOT).filter(snapshot => snapshot.case.id! >= 'FM-051');
for (const snapshot of researchSnapshots) test(snapshot.case.id + ' unchanged semantic requires verified formal reuse before research expansion', () => {
  const trace: TraceBundle = { id: randomUUID(), revision: 1, source: { kind: 'evaluation' }, entry: 'evaluation', startedAt: '2026-10-28T00:00:00Z', endedAt: '2026-10-28T00:00:01Z',
    input: { prompt: snapshot.case.input.prompt, ...(snapshot.case.input.turns ? { turns: snapshot.case.input.turns } : {}) }, output: null, status: 'FAIL', complete: true, gaps: [], configuration: {}, facts: {}, events: [],
    materials: Object.entries(snapshot.materials()).map(([path, content], index) => ({ id: 'source-' + index, path, content, encoding: 'base64' })) };
  const candidate = candidateSchema.parse({ id: randomUUID(), revision: 1, kind: 'regression', reuseCaseId: snapshot.case.id, traceRef: { id: trace.id, revision: 1 }, reason: 'Exact original research contract.', sourceLabels: ['formal-research'], case: snapshot.case, gold: snapshot.gold, scenario: snapshot.scenario });
  expect(() => expandCandidate(REPO_ROOT, candidate, trace, snapshot.case.id!, 'research-reuse', 1, REPO_ROOT)).toThrow('verified formal Case reuse');
  const target = resolveCandidateCase(REPO_ROOT, candidate, trace, [snapshot]);
  const data = expandCandidate(REPO_ROOT, candidate, trace, target.caseId!, 'research-reuse', 1, REPO_ROOT, false, target.caseVersion, target.goldFiles, target.formalCase);
  expect(data.embedded!.authored!.gold[target.caseId!].values.semantic).toEqual(formal.gold[target.caseId!].values.semantic);
  const forged = structuredClone(candidate); forged.case!.expected.expectedAnswerHint += ' Changed business requirement';
  expect(() => expandCandidate(REPO_ROOT, forged, trace, target.caseId!, 'research-reuse', 1, REPO_ROOT, false, target.caseVersion, target.goldFiles, target.formalCase)).toThrow('verified formal Case reuse');
});

test('a candidate preserves the existing formal Gold basis object without converting or dropping its source checks', () => {
  const original = goldByCaseId['FM-001'];
  const parsed = goldSchema.parse(original);
  expect(parsed).toEqual(original);
  expect(parsed.basis).toMatchObject({ method: '原材料逐项核对，答案不来自被测Agent', sample: '000001' });
});

let baseline: ReturnType<typeof existingCaseSnapshots>[number];
function reusedInvoice(alias = false) {
  baseline ??= existingCaseSnapshots(REPO_ROOT).find(snapshot => snapshot.case.id === 'FM-001')!;
  const files = Object.entries(baseline.materials()).filter(([path]) => path.startsWith('invoice-input/'));
  const trace: TraceBundle = { id: randomUUID(), revision: 1, source: { kind: 'evaluation', executionId: 'controlled-fixture', trialId: 'trial-1' }, entry: 'evaluation',
    startedAt: '2026-10-28T00:00:00Z', endedAt: '2026-10-28T00:00:01Z', input: { prompt: baseline.case.input.prompt }, output: null,
    status: 'FAIL', complete: true, gaps: [], configuration: {}, events: [], facts: {},
    materials: files.map(([path, content], index) => ({ id: 'source-' + index, path: alias ? path : path.replace(/^invoice-input\//, 'voxel51/'), content, encoding: 'base64' })) };
  for (const file of trace.materials.filter(material => /\/(content|pages)\.json$/.test(material.path!)))
    trace.materials.push({ id: 'visible-' + file.id, path: file.path!.replace(/^(invoice-input|voxel51)\//, 'materials/'), text: Buffer.from(file.content!, 'base64').toString('utf8') });
  const candidate = candidateSchema.parse({ id: randomUUID(), revision: 1, kind: 'regression', reuseCaseId: 'FM-001', traceRef: { id: trace.id, revision: 1 },
    reason: 'Controlled reuse of the original formal Case.', sourceLabels: ['formal-case-and-independent-original-source'],
    case: baseline.case, gold: baseline.gold, scenario: baseline.scenario });
  return { candidate, trace };
}

test.each([false, true])('formal invoice reuse preserves FM-001 while comparing only proven public bytes across aliases (alias=%s)', alias => {
  const { candidate, trace } = reusedInvoice(alias);
  expect(trace.materials.some(material => material.path?.endsWith('/content.md'))).toBe(false);
  const target = resolveCandidateCase(REPO_ROOT, candidate, trace, [baseline]);
  expect(target).toMatchObject({ caseId: 'FM-001', caseVersion: 1 });
});

test('formal Gold private references stay with the controller while the original Case remains runnable without putting them in Trace or Agent input', () => {
  const { candidate, trace } = reusedInvoice(), original = structuredClone(trace);
  const target = resolveCandidateCase(REPO_ROOT, candidate, trace, [baseline]);
  const expanded = expandCandidate(REPO_ROOT, candidate, trace, target.caseId!, 'reused-invoice', 1, REPO_ROOT, false, target.caseVersion, target.goldFiles);
  expect(expanded.cases[0]).toMatchObject({ id: 'FM-001', version: 1, source: 'hand-authored' });
  expect(expanded.embedded!.authored!.gold['FM-001']).toMatchObject(goldByCaseId['FM-001']);
  expect(expanded.embedded!.files['voxel51/000001/content.md']).toBeDefined();
  expect(expanded.embedded!.inputs['FM-001']!.some(file => file.path.endsWith('/content.md'))).toBe(false);
  expect(trace).toEqual(original);
});

test.each(['gold', 'basis', 'scenario', 'image', 'mirror', 'labels', 'unproven-source'] as const)('formal Case reuse rejects a changed %s', change => {
  const { candidate, trace } = reusedInvoice();
  let snapshots = [baseline];
  if (change === 'gold') candidate.gold!.checks[0]!.required = false;
  if (change === 'basis') candidate.gold!.basis = { method: 'Unapproved replacement' };
  if (change === 'scenario') candidate.scenario!.steps.push({ id: 'extra', action: 'user-message', instruction: 'Another request' });
  if (change === 'image') trace.materials.find(material => material.path?.endsWith('/original.jpg'))!.content = Buffer.from('Changed bytes').toString('base64');
  if (change === 'mirror') trace.materials.find(material => material.path === 'materials/000001/content.json')!.text += 'Changed bytes';
  if (change === 'labels') candidate.case!.source = 'regression-bug';
  if (change === 'unproven-source') {
    candidate.scenario!.materials = [{ source: 'local-text', sample: '000001', file: 'source.md' }];
    snapshots = [{ ...baseline, scenario: candidate.scenario }];
  }
  expect(() => resolveCandidateCase(REPO_ROOT, candidate, trace, snapshots)).toThrow('Reused Case conditions');
});
