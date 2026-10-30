import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { reportFixture } from '../support/fixtures.ts';
import { reportTraces } from '../../src/execution/trace.ts';
import { traceFiles, expandCandidate } from '../../src/curation/expansion.ts';
import { candidateSchema } from '../../src/curation/schemas.ts';
import { decodeFile } from '../../src/dataset-loader/flat.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';

test('producer local-text projections and byte-identical original files expand once without changing Trace material identities', () => {
  const report = reportFixture(), trial = report.trials[0]!, materials = Array.from({ length: 5 }, (_, index) => ({ sample: 'source-' + index, file: 'source.md', text: '  Source ' + index + ' 原文\n' }));
  trial.execution!.input = { prompt: 'Return the source value.', materials };
  const originals = materials.map(material => ({ path: 'materials/' + material.sample + '/' + material.file,
    encoding: 'base64' as const, content: Buffer.from(material.text).toString('base64'), bytes: Buffer.byteLength(material.text) }));
  const trace = reportTraces(report, { sample: originals })[0]!, original = structuredClone(trace);
  expect(trace.materials).toHaveLength(10);
  const files = traceFiles(trace); expect(Object.keys(files)).toHaveLength(5);
  for (const file of originals) expect(decodeFile(files[file.path]).bytes.equals(decodeFile(file).bytes)).toBe(true);
  const candidate = candidateSchema.parse({ id: randomUUID(), revision: 1, kind: 'regression', traceRef: { id: trace.id, revision: 1 }, reason: 'Controlled mirrored source fixture.', sourceLabels: ['source'],
    case: { name: 'task_local_source_mirrors', category: 'task', difficulty: 'regression', purpose: 'regression', source: 'regression-bug', input: { prompt: trace.input.prompt },
      expected: { success: ['Return source value.'], failure: ['Invent value.'], maxToolCalls: 0, mustHaveEvidence: true, expectedAnswerHint: 'Source 0' },
      scoring: { deterministic: ['fact-check'], judge: [], manual: 'Pending' }, risks: ['Data only'], tags: ['controlled'] },
    gold: { values: {}, checks: [{ metric: 'fact-check', required: true, evidence: 'answer', path: [], equals: 'Source 0' }], opportunities: { 'task-success': 1 }, sources: [originals[0]!.path], basis: 'Original source' },
    scenario: { requires: ['agent'], materials: materials.map(({ sample, file }) => ({ source: 'local-text', sample, file })), steps: [{ id: 'request', action: 'user-message', instruction: '$input' }], selection: { enabledSkills: [], enabledExtensions: [] } } });
  expect(expandCandidate(REPO_ROOT, candidate, trace, 'FM-999', 'mirrored-source', 1, REPO_ROOT).embedded!.inputs['FM-999']).toHaveLength(5);
  expect(trace).toEqual(original);
  trace.materials[5]!.content = Buffer.from('Conflicting original bytes').toString('base64');
  expect(() => traceFiles(trace)).toThrow('Conflicting trace material path');
});
