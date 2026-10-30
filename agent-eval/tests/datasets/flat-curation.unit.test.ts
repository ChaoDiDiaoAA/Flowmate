import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCurationService } from '../../src/curation/index.ts';
import { addFeedback as addCaseFeedback, readFeedbackRecords, type Feedback } from '../../src/review/local.ts';
import { fixtureDirectory, reportFixture } from '../support/fixtures.ts';
import { dispatchWorkflow } from '../../src/desktop/workflow.ts';
import { createArchive, archiveReference, readArchive, writeArchivePart } from '../../src/reports/archive.ts';
import { saveReport } from '../../src/reports/store.ts';
import { writeTraceOperation } from '../../src/curation/store.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const repo = () => { const root = mkdtempSync(join(tmpdir(), 'flat-curation-')); roots.push(root); return root; };
const trace = () => ({ id: randomUUID(), revision: 1, source: { kind: 'product' as const, runId: 'internal-run' }, entry: 'chats' as const,
  startedAt: '2026-10-28T01:00:00.000Z', endedAt: '2026-10-28T01:00:00.000Z', input: { prompt: 'private-name@example.invalid 原文' },
  output: { answer: 'Observation' }, status: 'FAIL' as const, complete: true, gaps: [], configuration: { purpose: 'private-purpose@example.invalid' },
  events: [], facts: {}, materials: [] });

test('Trace and candidate revisions use readable single files without exposing arbitrary input in names', () => {
  const root = repo(), service = createCurationService(root), source = trace();
  service.saveTrace(source); service.saveTrace({ ...source, id: randomUUID() });
  const names = readdirSync(join(root, 'agent-eval/traces'));
  expect(names).toEqual(['Trace-2026-10-28_090000-chats-task-01.json', 'Trace-2026-10-28_090000-chats-task-02.json']);
  const saved = service.saveCandidate({ id: randomUUID(), revision: 1, kind: 'bad', traceRef: { id: source.id, revision: 1 }, reason: 'Original failure', sourceLabels: ['original-facts'] });
  const collection = join(root, 'agent-eval/src/datasets/bad-candidates');
  expect(readdirSync(collection)).toEqual([expect.stringMatching(/^Bad-\d{4}-\d{2}-\d{2}_\d{6}-chats-01\.json$/)]);
  service.editCandidate(saved.id, { expectedRevision: 1, reason: 'Reviewed facts' });
  expect(readdirSync(collection)).toHaveLength(1);
  expect(service.readCandidate(saved.id)).toMatchObject({ revision: 2, reason: 'Reviewed facts' });
  expect(service.readTrace(source.id)).toEqual(source);
});

test('unknown mining receipt stays in the original Trace JSON and is never automatically repeated', async () => {
  const root = repo(), source = trace(); let calls = 0;
  const service = createCurationService(root, { generateJSON: async () => { calls++; throw Error('unknown transport result'); } });
  service.saveTrace(source);
  const request = { operationId: randomUUID(), traceId: source.id, expectedRevision: 1, kind: 'bad' };
  const first = await service.mine(request);
  expect(first.status).toBe('unknown'); expect(await service.mine(request)).toEqual(first); expect(calls).toBe(1);
  const rootPath = join(root, 'agent-eval/traces'), names = readdirSync(rootPath);
  expect(names).toHaveLength(1); expect(names[0]).toEndWith('.json');
  const record = JSON.parse(readFileSync(join(rootPath, names[0]!), 'utf8'));
  expect(record.operations.mining[request.operationId]).toEqual(first);
  service.saveTrace({ ...source, revision: 2, status: 'completed' });
  expect(await service.mine(request)).toEqual(first); expect(calls).toBe(1);
  expect(service.readTrace(source.id).revision).toBe(2);
});

test('the shared HumanFeedback collection preserves distinct targets and sources when either service appends', () => {
  const root = repo(), service = createCurationService(root), source = trace(); service.saveTrace(source);
  cpSync(fixtureDirectory, join(root, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  const saved = service.saveCandidate({ id: randomUUID(), revision: 1, kind: 'bad', traceRef: { id: source.id, revision: 1 }, reason: 'Failure signal', sourceLabels: ['original-facts'] });
  const input = { reviewer: 'human-reviewer', source: 'human', verdict: 'bad', note: 'Independent review.' };
  const traceTarget = { kind: 'trace-feedback', id: source.id, revision: 1 }, candidateTarget = { kind: 'candidate-review', id: saved.id, revision: 1 };
  const traceFeedback = service.addFeedback({ ...input, operationId: randomUUID(), target: traceTarget });
  const caseFeedback = addCaseFeedback(root, { datasetId: 'facility-test', caseId: 'test-fields', id: randomUUID(), reviewer: 'case-reviewer', verdict: 'bad', note: 'Original material gap.' });
  const agentReview = service.addFeedback({ ...input, source: 'agent', verdict: 'approve', operationId: randomUUID(), target: candidateTarget });
  const report = reportFixture(), archive = createArchive(root, { selection: 'smoke' });
  saveReport(archiveReference(archive.file, 'executions', report.executionId), report);
  const runFeedback = addCaseFeedback(root, { executionId: report.executionId, caseId: 'sample', trialId: 'trial-1', reviewer: 'run-reviewer', verdict: 'good', note: 'Original scored result.' });
  expect(readFeedbackRecords(root)).toEqual([caseFeedback]);
  expect(readFeedbackRecords(root, report.executionId)).toEqual([runFeedback]);
  expect(service.listFeedback(traceTarget)).toEqual([traceFeedback]);
  expect(service.listFeedback(candidateTarget)).toEqual([agentReview]);
  const all = JSON.parse(readFileSync(join(root, 'agent-eval/feedback.json'), 'utf8')).records;
  expect(all).toHaveLength(4); expect(all[2].source).toBe('agent');
  expect(() => service.addFeedback({ ...input, operationId: caseFeedback.id, target: traceTarget })).toThrow();
  expect(() => addCaseFeedback(root, { datasetId: 'facility-test', caseId: 'test-fields', id: traceFeedback.id, reviewer: 'case-reviewer', verdict: 'bad', note: 'Other target' })).toThrow();
  expect(service.listFeedback(traceTarget)).toEqual([traceFeedback]);
});

test('Benchmark Traces derive saved execution and material facts without creating a Trace file', () => {
  const root = repo(), service = createCurationService(root), report = reportFixture(), archive = createArchive(root, { selection: 'smoke' });
  const reference = archiveReference(archive.file, 'executions', report.executionId);
  saveReport(reference, report);
  const material = { path: 'references/source.md', encoding: 'utf8', content: 'Independent original source.', bytes: 28 };
  writeArchivePart(archiveReference(archive.file, 'snapshots', report.executionId), { dataset: 'test', version: 1,
    cases: [{ id: 'sample', version: 1 }], materials: [{ caseId: 'sample', materials: [], files: [material] }] });
  const derived = service.listTraces()[0]!;
  expect(derived.source).toMatchObject({ kind: 'evaluation', executionId: report.executionId, trialId: 'trial-1' });
  expect(derived.materials).toContainEqual({ id: 'source-1', path: material.path, encoding: 'utf8', content: material.content });
  expect(derived.materials).toHaveLength(2);
  expect(service.readTrace(derived.id)).toEqual(derived);
  writeTraceOperation(root, derived.id, 'mining', 'original-operation', { status: 'unknown' });
  expect(readArchive(archive.file).workflow).toMatchObject({ traceOperations: { [derived.id]: { operations: { mining: { 'original-operation': { status: 'unknown' } } } } } });
  expect(existsSync(join(root, 'agent-eval/traces'))).toBe(false);
  expect(() => service.saveTrace(derived)).toThrow('derived');
});

test('read-only historical Case feedback does not block unrelated completed Execution feedback', () => {
  const root = repo(), report = reportFixture(), archive = createArchive(root, { selection: 'smoke' });
  saveReport(archiveReference(archive.file, 'executions', report.executionId), report);
  const historical: Feedback = { id: 'historical-case', kind: 'case-quality', caseId: 'sample', caseVersion: 1, reviewer: 'original-reviewer',
    at: report.startedAt, verdict: 'bad', note: 'Historical source unavailable.', source: 'local' };
  const file = join(root, 'agent-eval/feedback.json'); writeFileSync(file, JSON.stringify({ version: 'v1', records: [historical] }));
  const saved = addCaseFeedback(root, { executionId: report.executionId, caseId: 'sample', trialId: 'trial-1', reviewer: 'run-reviewer', verdict: 'good', note: 'Completed original scoring.' });
  expect(readFeedbackRecords(root, report.executionId)).toEqual([saved]);
  expect(readFeedbackRecords(root)).toEqual([historical]);
  expect(() => addCaseFeedback(root, { datasetId: 'unavailable', caseId: 'sample', reviewer: 'new-reviewer', verdict: 'bad', note: 'Unverified old case.' })).toThrow('Historical feedback is read-only');
});

test('unknown upload and platform readback remain inside the same original Trace file', async () => {
  const root = repo(), service = createCurationService(root), source = trace(); service.saveTrace(source);
  const request = { action: 'trace.upload', traceId: source.id, expectedRevision: 1, operationId: randomUUID() };
  let sends = 0;
  const deps = { env: {}, connection: { baseUrl: 'https://fixture.invalid', publicKey: 'public', secretKey: 'secret' },
    queryProjects: async () => ({ data: [{ id: 'project' }] }), pullTraces: async () => [],
    sendTrace: async () => { sends++; throw Error('Unknown remote outcome'); } };
  const first = await dispatchWorkflow(root, request, deps);
  expect(first.exitCode).toBe(2); expect((await dispatchWorkflow(root, request, deps)).data).toEqual(first.data);
  await expect(dispatchWorkflow(root, { ...request, operationId: randomUUID() }, deps)).rejects.toThrow('original upload operation');
  expect(sends).toBe(1);
  await dispatchWorkflow(root, { action: 'trace.pull', from: source.startedAt, to: '2026-10-29T00:00:00Z' }, {
    ...deps, pullTraces: async () => [{ ...source, output: 'Remote copy', facts: { langfuseObservations: [] } }] });
  const rootPath = join(root, 'agent-eval/traces'), names = readdirSync(rootPath);
  expect(names).toHaveLength(1);
  const saved = JSON.parse(readFileSync(join(rootPath, names[0]!), 'utf8'));
  expect(saved.operations.uploads[request.operationId].status).toBe('unknown');
  expect(saved.platformSnapshot.trace.output).toBe('Remote copy');
  expect(service.readTrace(source.id)).toEqual(source);
});
