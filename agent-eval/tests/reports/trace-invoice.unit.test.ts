import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { reportFixture } from '../support/fixtures.ts';
import { reportTraces } from '../../src/execution/trace.ts';
import { expandHarness } from '../../src/dataset-loader/harness.ts';
import { decodeFile } from '../../src/dataset-loader/flat.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { miningModelInput } from '../../src/curation/mining-contract.ts';
import { candidateSchema } from '../../src/curation/schemas.ts';
import { expandCandidate } from '../../src/curation/expansion.ts';

function invoice() {
  const prompt = '  根据原始发票回答。\n', sample = '000001', privatePath = 'quality-controls/FM-999/reference.md';
  const bytes: Record<string, Buffer> = {
    'voxel51/000001/content.json': Buffer.from('{"sellerName":"SOURCE-VALUE"}'),
    'voxel51/000001/pages.json': Buffer.from('[{"text":"SOURCE-VALUE"}]'),
    'voxel51/000001/metadata.json': Buffer.from('{"files":[{"path":"original.jpg","bytes":3}]}'),
    'voxel51/000001/original.jpg': Buffer.from([1, 2, 3]),
    [privatePath]: Buffer.from('PRIVATE_GOLD_CAPTURE_CANARY'),
  };
  const materials = ['content.json', 'pages.json'].map(file => ({ source: 'voxel51', sample, file }));
  const checks = [{ metric: 'fact-check', required: true, evidence: 'answer', path: [], equals: 'SOURCE-VALUE' }];
  const expected = { success: ['Answer the source value.'], failure: ['Invent a different value.'], maxToolCalls: 2, mustHaveEvidence: true, expectedAnswerHint: 'SOURCE-VALUE' };
  const harness = expandHarness({ contract: 'flowmate-eval-case/v4', id: 'FM-999', version: 1, name: 'invoice_source_boundary', category: 'task',
    purpose: 'regression', source: { type: 'controlled-workflow', basis: 'Synthetic invoice source identity' }, dataset: 'synthetic', smoke: false,
    tags: ['synthetic'], requires: ['agent', 'invoice', 'workspace'], input: { prompt, materials }, environment: 'isolated', expected: { ...expected, checks },
    scoring: { methods: ['deterministic'], metrics: { 'task-success': 1 }, humanReview: 'Pending' }, risks: ['Isolated data only.'] },
    { contract: 'flowmate-eval-gold/v4', caseId: 'FM-999', version: 1, values: {}, sources: [privatePath] },
    { contract: 'flowmate-eval-review/v4', caseId: 'FM-999', version: 1, status: 'agent-reviewed', humanReview: 'pending' },
    { datasets: { synthetic: {} }, files: Object.fromEntries(Object.keys(bytes).map(path => [path, path])), resources: [] }, REPO_ROOT, path => bytes[path]!);
  const report = reportFixture(), trial = report.trials[0]!;
  trial.caseId = 'FM-999'; trial.caseVersion = 1;
  trial.caseConditions = { task: harness.task, files: Object.entries(bytes).map(([path, value]) => ({ path, encoding: 'base64', content: value.toString('base64'), bytes: value.length })) };
  trial.execution!.input = { prompt, materials: materials.map(ref => ({ sample, file: ref.file, text: bytes['voxel51/' + sample + '/' + ref.file]!.toString('utf8') })) };
  return { report, harness, bytes, expected, checks };
}

test('actual Harness invoice package retains its proven source through capture, mining references and four-file expansion', () => {
  const fixture = invoice(), visible = fixture.harness.task.input.files;
  expect(visible.map(file => file.path).sort()).toEqual(['content.json', 'metadata.json', 'original.jpg', 'pages.json'].map(file => 'invoice-input/000001/' + file));
  const trace = reportTraces(fixture.report, { 'FM-999': visible })[0]!;
  const request = miningModelInput(JSON.stringify({ kind: 'regression', trace }), candidateSchema);
  const references = request.contract.materials.flatMap(material => material.replayReference ? [material.replayReference] : []);
  expect(references).toEqual([{ source: 'voxel51', sample: '000001', file: 'content.json' }, { source: 'voxel51', sample: '000001', file: 'pages.json' }]);
  expect(trace.input.prompt).toBe('  根据原始发票回答。\n');
  expect(trace.materials[0]).toMatchObject({ id: 'material-1', path: 'materials/000001/content.json' });
  expect(JSON.stringify(trace)).not.toContain('PRIVATE_GOLD_CAPTURE_CANARY');
  expect(trace.materials.some(material => material.path?.startsWith('quality-controls/'))).toBe(false);
  expect(visible.every(file => file.path.startsWith('invoice-input/'))).toBe(true);
  const candidate = candidateSchema.parse({ id: randomUUID(), revision: 1, kind: 'regression', traceRef: { id: trace.id, revision: 1 },
    reason: 'Original source value mismatch.', sourceLabels: ['visible-invoice-source'],
    case: { name: 'invoice_source_boundary', category: 'task', difficulty: 'regression', purpose: 'regression', source: 'regression-bug', input: { prompt: trace.input.prompt },
      expected: fixture.expected, scoring: { deterministic: ['fact-check'], judge: [], manual: 'Pending human review.' }, risks: ['Isolated invoice.'], tags: ['synthetic'] },
    gold: { values: {}, checks: fixture.checks, opportunities: { 'task-success': 1 }, sources: ['materials/000001/content.json'], basis: 'Visible original invoice.' },
    scenario: { requires: ['agent', 'invoice', 'workspace'], materials: references,
      steps: [{ id: 'request', action: 'invoice-message', instruction: '$input', sample: '000001', workspaceMode: 'selected-document', goalMode: 'answer' }],
      selection: { enabledSkills: [], enabledExtensions: [] } } });
  const expanded = expandCandidate(REPO_ROOT, candidate, trace, 'FM-999', 'invoice-replay', 1, REPO_ROOT);
  const replayFiles = expanded.embedded!.inputs['FM-999']!;
  expect(replayFiles.map(file => file.path).sort()).toEqual(visible.map(file => file.path).sort());
  for (const file of replayFiles) expect(decodeFile(file).bytes.equals(fixture.bytes[file.path.replace(/^invoice-input\//, 'voxel51/')]!)).toBe(true);
});

test('unproven invoice source, another Case revision or another sample never becomes a guessed Voxel51 reference', () => {
  for (const change of ['missing', 'case', 'version', 'sample'] as const) {
    const fixture = invoice(), trial = fixture.report.trials[0]!;
    if (change === 'missing') trial.caseConditions = undefined;
    if (change === 'case') fixture.harness.task.id = 'FM-998';
    if (change === 'version') fixture.harness.task.version = 2;
    if (change === 'sample') fixture.harness.task.input.materials.forEach(ref => { ref.sample = '000002'; });
    const trace = reportTraces(fixture.report, { 'FM-999': fixture.harness.task.input.files })[0]!;
    expect(trace.materials.some(material => material.path?.startsWith('voxel51/'))).toBe(false);
    const request = miningModelInput(JSON.stringify({ kind: 'regression', trace }), candidateSchema);
    expect(request.contract.materials.every(material => material.replayReference === null)).toBe(true);
  }
});
