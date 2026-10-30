import { expect, test, spyOn } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addFeedback, feedbackDirectory, feedbackStatus, readFeedbackRecords } from '../../src/review/local.ts';
import { ZodError } from 'zod';
import { dataset, fixtureRepo, fixtureDirectory } from '../support/fixtures.ts';
import { inspectCaseDeclaration } from '../../src/dataset-loader/declarations.ts';
import { findDataset } from '../../src/execution/plan.ts';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import * as reportFiles from '../../src/reports/files.ts';
import { createEvaluationService } from '../../src/desktop/service.ts';

test('a saved feedback retry returns its original conditions and time after Case changes without rewriting the record', () => {
  const task = dataset.cases[0]!, input = { dataset, caseId: task.id, id: 'synthetic-original-operation',
    reviewer: 'synthetic-reviewer', verdict: 'bad' as const, note: 'Original synthetic finding' };
  const first = addFeedback(fixtureRepo, input), file = join(feedbackDirectory(fixtureRepo), 'feedback.json'), before = readFileSync(file, 'utf8');
  const material = join(fixtureRepo, 'data/invoices/voxel51/000001/content.md'), source = readFileSync(material, 'utf8');
  try {
    writeFileSync(material, source.replace('TEST-001', 'TEST-009'));
    const retry = addFeedback(fixtureRepo, input);
    expect(retry.at).toBe(first.at); expect(retry.conditions).toEqual(first.conditions);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(addFeedback(fixtureRepo, { ...input, dataset: { ...dataset, cases: [] } }).id).toBe(first.id);
    expect(() => addFeedback(fixtureRepo, { ...input, note: 'Different finding' })).toThrow('Conflicting');
    expect(() => addFeedback(fixtureRepo, { ...input, dataset: { ...dataset, manifest: { ...dataset.manifest, id: 'another-dataset' } } })).toThrow('Conflicting');
  } finally { writeFileSync(material, source); }
});

test('registered Case feedback can record a material gap and rejects new feedback against changed inspection conditions', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-case-feedback-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  const before = inspectCaseDeclaration(repo, 'facility-test', 'test-fields');
  const input = { datasetId: 'facility-test', caseId: 'test-fields', id: 'synthetic-case-gap',
    reviewer: 'synthetic-reviewer', verdict: 'bad' as const, note: 'Required synthetic material is absent.' };
  const first = addFeedback(repo, input, before.conditions);
  expect(first.kind).toBe('case-quality'); expect(first.caseVersion).toBe(1);
  expect(first.conditions).toMatchObject({ contract: 'flowmate-case-inspection/v1', gaps: before.gaps });
  const file = join(feedbackDirectory(repo), 'feedback.json'), saved = readFileSync(file, 'utf8');
  const material = join(repo, 'data/invoices/voxel51/000001/content.md');
  mkdirSync(join(material, '..'), { recursive: true }); writeFileSync(material, 'New synthetic source.');
  expect(() => addFeedback(repo, { ...input, id: 'synthetic-new-stale-view' }, before.conditions)).toThrow('Case inspection changed');
  expect(readFileSync(file, 'utf8')).toBe(saved);
  const retry = addFeedback(repo, input, before.conditions);
  expect(retry.conditions).toEqual(first.conditions); expect(retry.at).toBe(first.at);
  expect(readFileSync(file, 'utf8')).toBe(saved);
  const current = inspectCaseDeclaration(repo, 'facility-test', 'test-fields');
  expect(addFeedback(repo, { ...input, id: 'synthetic-refreshed-view' }, current.conditions).id).toBe('synthetic-refreshed-view');
});

test('a saved valid feedback operation remains retryable beside a read-only historical record', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-mixed-feedback-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  const input = { datasetId: 'facility-test', caseId: 'test-fields', id: 'synthetic-valid-operation',
    reviewer: 'synthetic-reviewer', verdict: 'bad' as const, note: 'Original synthetic material gap.' };
  const first = addFeedback(repo, input), file = join(feedbackDirectory(repo), 'feedback.json');
  writeFileSync(file, JSON.stringify({ version: 'v1', records: [first, { ...first, id: 'synthetic-legacy', conditions: undefined }] }));
  const before = readFileSync(file, 'utf8');
  expect(addFeedback(repo, input)).toEqual(first);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(() => addFeedback(repo, { ...input, id: 'synthetic-new-operation' })).toThrow('Historical feedback is read-only');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('malformed feedback collections and rows fail validation before an append', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-invalid-feedback-')), directory = feedbackDirectory(repo);
  mkdirSync(directory, { recursive: true }); const file = join(directory, 'feedback.json');
  for (const records of [null, {}, 'invalid', [null], [7]]) {
    const source = JSON.stringify({ version: 'v1', records }); writeFileSync(file, source);
    expect(() => readFeedbackRecords(repo)).toThrow(ZodError);
    expect(readFileSync(file, 'utf8')).toBe(source);
  }
});

test('feedback saved before a write ownership failure remains queryable by its original operation', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-feedback-release-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  const input = { datasetId: 'facility-test', caseId: 'test-fields', id: 'synthetic-saved-before-release-failure',
    reviewer: 'synthetic-reviewer', verdict: 'bad' as const, note: 'Synthetic write receipt was interrupted.' };
  const file = join(feedbackDirectory(repo), 'feedback.json'), atomicJson = reportFiles.atomicJson;
  const writing = spyOn(reportFiles, 'atomicJson').mockImplementation((path, value) => {
    atomicJson(path, value); if (path === file) writeFileSync(file + '.write-lock', 'synthetic-replaced-owner');
  });
  try { expect(() => addFeedback(repo, input)).toThrow('ownership'); } finally { writing.mockRestore(); }
  const original = readFileSync(file, 'utf8'), service = createEvaluationService(repo);
  expect(service.feedback({ target: { kind: 'case-quality', datasetId: 'facility-test', caseId: 'test-fields' }, operationId: input.id }))
    .toMatchObject({ ok: true, data: { operation: { id: input.id, reviewer: input.reviewer, note: input.note }, formalAcceptance: 'pending' } });
  expect(() => addFeedback(repo, { ...input, id: 'synthetic-new-blocked-operation' })).toThrow('write conflict');
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readFileSync(file + '.write-lock', 'utf8')).toBe('synthetic-replaced-owner');
});

test('registered feedback targets remain exclusive and cannot be rebound to a Trial or different operation payload', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-case-feedback-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  const input = { datasetId: 'facility-test', caseId: 'test-fields', id: 'synthetic-target-identity',
    reviewer: 'synthetic-reviewer', verdict: 'bad' as const, note: 'Synthetic independent Case review.' };
  expect(() => addFeedback(repo, { ...input, dataset })).toThrow('Exactly one');
  expect(() => addFeedback(repo, { ...input, executionId: 'another-execution' })).toThrow('Exactly one');
  expect(() => addFeedback(repo, { ...input, trialId: 'another-trial' })).toThrow('cannot target a Trial');
  expect(() => addFeedback(repo, { ...input, datasetId: 'unregistered' })).toThrow('Unknown registered Case');
  addFeedback(repo, input);
  expect(() => addFeedback(repo, { ...input, note: 'Changed operation payload.' })).toThrow('Conflicting');
});

test('feedback queries keep a registered material-gap review current without loading an execution Dataset', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-case-query-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  addFeedback(repo, { datasetId: 'facility-test', caseId: 'test-fields', id: 'synthetic-current-gap',
    reviewer: 'synthetic-reviewer', verdict: 'bad', note: 'Synthetic material is missing.' });
  const status = feedbackStatus(repo, undefined, 'facility-test');
  expect(status.records.map(record => record.id)).toEqual(['synthetic-current-gap']);
  expect(status.stale).toBe(0); expect(status.formalAcceptance).toBe('pending');
});

test('CLI and registered queries recognize both original and inspected Case feedback and detect later material changes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'eval-case-query-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  cpSync(join(fixtureRepo, 'data'), join(repo, 'data'), { recursive: true });
  const current = findDataset(repo, { dataset: 'facility-test' });
  const input = { caseId: 'test-fields', reviewer: 'synthetic-reviewer', verdict: 'good' as const, note: 'Synthetic reviewed material.' };
  addFeedback(repo, { ...input, dataset: current, id: 'synthetic-original-format' });
  addFeedback(repo, { ...input, datasetId: 'facility-test', id: 'synthetic-inspected-format' });
  const ids = ['synthetic-original-format', 'synthetic-inspected-format'];
  expect(feedbackStatus(repo, undefined, current).records.map(record => record.id)).toEqual(ids);
  expect(feedbackStatus(repo, undefined, 'facility-test').records.map(record => record.id)).toEqual(ids);
  const material = join(repo, 'data/invoices/voxel51/000001/content.md');
  writeFileSync(material, readFileSync(material, 'utf8') + '\nSynthetic later material change.');
  expect(feedbackStatus(repo, undefined, current).records).toHaveLength(0);
  expect(feedbackStatus(repo, undefined, 'facility-test').stale).toBe(2);
});
