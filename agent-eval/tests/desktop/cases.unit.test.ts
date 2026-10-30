import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { createEvaluationService } from '../../src/desktop/service.ts';
import { fixtureDirectory, fixtureRepo, reportFixture } from '../support/fixtures.ts';
import { feedbackDirectory } from '../../src/review/local.ts';

function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'eval-case-operations-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  return { repo, service: createEvaluationService(repo, { sessionId: 'synthetic-case-session' }) };
}
function invoke(service: ReturnType<typeof createEvaluationService>, name: string, input: unknown) {
  const method = Reflect.get(service, name); expect(method).toBeFunction(); return method(input);
}
const target = { kind: 'case-quality', datasetId: 'facility-test', caseId: 'test-fields' } as const;
const feedback = { operationId: 'synthetic-case-operation', reviewer: 'synthetic-reviewer', verdict: 'bad', note: 'Synthetic material gap.' } as const;

test('catalog pages retain their original member view and Case inspection is available without execution materials', () => {
  const { repo, service } = setup();
  const first = invoke(service, 'catalog', { view: 'list', limit: 2 });
  expect(first.ok).toBe(true); expect(first.data.items).toHaveLength(2); expect(first.data.page.total).toBe(3);
  const next = invoke(service, 'catalog', { view: 'list', viewId: first.data.viewId, offset: 2, limit: 2 });
  expect(next.ok).toBe(true); expect(next.data.items).toHaveLength(1);
  expect(new Set([...first.data.items, ...next.data.items].map((item: { caseId: string }) => item.caseId)).size).toBe(3);
  const selected = invoke(service, 'catalog', { view: 'case', datasetId: target.datasetId, caseId: target.caseId, limit: 160 });
  expect(selected.ok).toBe(true); expect(selected.data.summary).toContain('Save the stated number.');
  expect(selected.data.gaps.some((gap: { reason: string }) => gap.reason === 'missing')).toBe(true);
  expect(selected.data.text.length).toBeLessThanOrEqual(160); expect(selected.data.page.nextOffset).toBe(160);
  expect(existsSync(join(repo, 'agent-eval/runs'))).toBe(false);
  expect(existsSync(join(repo, 'agent-eval/records'))).toBe(false);
});

test('Case pagination and new feedback reject changed conditions while an already saved operation remains recoverable', () => {
  const { repo, service } = setup();
  const viewed = invoke(service, 'catalog', { view: 'case', datasetId: target.datasetId, caseId: target.caseId });
  expect(viewed.ok).toBe(true);
  const input = { ...feedback, target: { ...target, caseViewId: viewed.data.caseViewId } };
  const saved = invoke(service, 'addFeedback', input); expect(saved.ok).toBe(true);
  expect(saved.data.record.caseId).toBe(target.caseId); expect(saved.data.record.caseVersion).toBe(1);
  expect(JSON.stringify(saved.data)).not.toContain('conditions');
  const file = join(feedbackDirectory(repo), 'feedback.json'), original = readFileSync(file, 'utf8');
  cpSync(join(fixtureRepo, 'data'), join(repo, 'data'), { recursive: true });
  expect(invoke(service, 'catalog', { view: 'case', datasetId: target.datasetId, caseId: target.caseId,
    caseViewId: viewed.data.caseViewId, offset: 160 }).ok).toBe(false);
  expect(invoke(service, 'addFeedback', { ...input, operationId: 'synthetic-new-stale-operation' }).ok).toBe(false);
  const retry = invoke(service, 'addFeedback', input);
  expect(retry.ok).toBe(true); expect(retry.data.record.at).toBe(saved.data.record.at);
  expect(readFileSync(file, 'utf8')).toBe(original);
  const queried = invoke(service, 'feedback', { target, operationId: feedback.operationId });
  expect(queried.ok).toBe(true); expect(queried.data.operation.id).toBe(feedback.operationId);
  expect(queried.data.records[0].validity).toBe('stale');
  expect(invoke(service, 'addFeedback', { ...input, note: 'Changed operation payload.' }).ok).toBe(false);
});

test('a new Worker session refuses an old Case view but can query and retry the original saved feedback', () => {
  const { repo, service } = setup();
  const viewed = invoke(service, 'catalog', { view: 'case', datasetId: target.datasetId, caseId: target.caseId });
  const input = { ...feedback, target: { ...target, caseViewId: viewed.data.caseViewId } };
  expect(invoke(service, 'addFeedback', input).ok).toBe(true);
  const reopened = createEvaluationService(repo, { sessionId: 'synthetic-reopened-session' });
  expect(invoke(reopened, 'addFeedback', { ...input, operationId: 'synthetic-new-session-operation' }).ok).toBe(false);
  expect(invoke(reopened, 'addFeedback', input).ok).toBe(true);
  expect(invoke(reopened, 'feedback', { target, operationId: feedback.operationId }).data.operation.id).toBe(feedback.operationId);
});

test('Trial feedback keeps the original strict completion rule and a saved operation is readable after evidence becomes incomplete', () => {
  const { repo, service } = setup(), directory = join(repo, 'agent-eval/runs/unit');
  mkdirSync(directory, { recursive: true });
  const report = reportFixture(), file = join(directory, 'summary.json'); writeFileSync(file, JSON.stringify(report));
  const trial = { kind: 'run-feedback', executionId: 'unit', caseId: 'sample', trialId: 'trial-1' } as const;
  const input = { ...feedback, target: trial };
  const first = invoke(service, 'addFeedback', input); expect(first.ok).toBe(true);
  const saved = readFileSync(join(feedbackDirectory(repo), 'feedback.json'), 'utf8');
  writeFileSync(file, JSON.stringify({ ...report, endedAt: null, scoring: 'pending' }));
  expect(invoke(service, 'addFeedback', { ...input, operationId: 'synthetic-unfinished-trial-feedback' }).ok).toBe(false);
  const queried = invoke(service, 'feedback', { target: { kind: 'run-feedback', executionId: 'unit' }, operationId: feedback.operationId });
  expect(queried.ok).toBe(true); expect(queried.data.operation.id).toBe(feedback.operationId);
  expect(readFileSync(join(feedbackDirectory(repo), 'feedback.json'), 'utf8')).toBe(saved);
});

test('catalog request identities and untrusted paths are rejected without creating evaluation records', () => {
  const { repo, service } = setup();
  for (const input of [
    { view: 'case', datasetId: '../outside', caseId: target.caseId },
    { view: 'case', datasetId: target.datasetId, caseId: 'not-registered' },
    { view: 'list', root: repo },
    { view: 'case', datasetId: target.datasetId, caseId: target.caseId, caseViewId: 'unknown-view' },
  ]) expect(invoke(service, 'catalog', input).ok).toBe(false);
  expect(existsSync(join(repo, 'agent-eval/runs'))).toBe(false);
  expect(existsSync(join(repo, 'agent-eval/records'))).toBe(false);
});

test('feedback pagination cannot mix current and stale conditions under the same view identity', () => {
  const { repo, service } = setup();
  const viewed = invoke(service, 'catalog', { view: 'case', datasetId: target.datasetId, caseId: target.caseId });
  for (const index of [1, 2]) expect(invoke(service, 'addFeedback', { ...feedback, operationId: 'synthetic-page-' + index,
    target: { ...target, caseViewId: viewed.data.caseViewId } }).ok).toBe(true);
  const first = invoke(service, 'feedback', { target, limit: 1 });
  expect(first.data.records[0].validity).toBe('current');
  cpSync(join(fixtureRepo, 'data'), join(repo, 'data'), { recursive: true });
  expect(invoke(service, 'feedback', { target, viewId: first.data.viewId, offset: 1, limit: 1 }).ok).toBe(false);
  expect(invoke(service, 'feedback', { target, limit: 1 }).data.records[0].validity).toBe('stale');
});

test('duplicate feedback identities are faults rather than usable history and cannot be appended to', () => {
  const { repo, service } = setup();
  const viewed = invoke(service, 'catalog', { view: 'case', datasetId: target.datasetId, caseId: target.caseId });
  const input = { ...feedback, target: { ...target, caseViewId: viewed.data.caseViewId } };
  expect(invoke(service, 'addFeedback', input).ok).toBe(true);
  const file = join(feedbackDirectory(repo), 'feedback.json'), original = readFileSync(file, 'utf8'), duplicate = JSON.parse(original);
  duplicate.records.push({ ...duplicate.records[0] }); writeFileSync(file, JSON.stringify(duplicate));
  expect(invoke(service, 'feedback', { target }).ok).toBe(false);
  expect(invoke(service, 'addFeedback', { ...input, operationId: 'synthetic-after-duplicate' }).ok).toBe(false);
  expect(JSON.parse(readFileSync(file, 'utf8')).records).toHaveLength(2);
});

test('a broken linked feedback sidecar is a fault rather than empty history', () => {
  const { repo, service } = setup(), file = join(feedbackDirectory(repo), 'feedback.json');
  mkdirSync(join(file, '..'), { recursive: true }); symlinkSync(join(repo, 'missing-synthetic-feedback'), file, 'file');
  expect(invoke(service, 'feedback', { target }).ok).toBe(false);
});
