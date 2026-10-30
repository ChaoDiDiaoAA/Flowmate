import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { reportFixture } from '../support/fixtures.ts';
import { createArchive, archiveReference, readArchivePart, writeArchivePart } from '../../src/reports/archive.ts';
import { readReport, saveReport } from '../../src/reports/store.ts';
import { acquireEvaluationWrite } from '../../src/reports/files.ts';
import { addFeedback, readFeedbackRecords } from '../../src/review/local.ts';
import { deriveBadcases, saveBadcases } from '../../src/reports/badcases.ts';
import { writeRunReadme } from '../../src/reports/readme.ts';

test('one Run retains two original executions with shared Case conditions and no evidence sidecars', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-inline-'));
    const archive = createArchive(repo, { selection: 'smoke', compare: true });
    const original = reportFixture();
    const left = archiveReference(archive.file, 'executions', original.executionId);
    saveReport(left, original);
    const other = structuredClone(original);
    other.executionId = 'second-execution';
    other.trials[0]!.trialId = 'second-trial';
    other.trials[0]!.traceId = 'b'.repeat(32);
    other.trials[0]!.execution!.identity.executionId = other.executionId;
    other.trials[0]!.execution!.identity.trialId = other.trials[0]!.trialId;
    const right = archiveReference(archive.file, 'executions', other.executionId);
    saveReport(right, other);
    expect(readReport(left).trials).toEqual(original.trials);
    expect(readReport(right).trials).toEqual(other.trials);
    expect(readdirSync(dirname(archive.file)).sort()).toEqual(['README.md', 'run.json']);
    const stored = JSON.parse(readFileSync(archive.file, 'utf8'));
    expect(Object.keys(stored.caseSnapshots)).toHaveLength(1);
    expect(stored.executions[original.executionId].trials[0].caseConditions).toBeUndefined();
    expect(stored.executions[original.executionId].trials[0].caseConditionsRef).toBe('sample@1');
    const altered = readReport(left); altered.trials[0]!.reason = 'changed';
    expect(() => saveReport(left, altered)).toThrow(/immutable/);
});

test('upload updates and analysis preserve original execution facts in the same Run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-inline-export-'));
    const archive = createArchive(repo, { selection: 'full', compare: true });
    const report = reportFixture(), ref = archiveReference(archive.file, 'executions', report.executionId);
    saveReport(ref, report);
    const state: ReturnType<typeof reportFixture>['export'] = { backend: 'langfuse', status: 'pending', error: 'remote visibility unknown' };
    writeArchivePart(archiveReference(archive.file, 'exports', report.executionId), state);
    writeArchivePart(archiveReference(archive.file, 'gates', 'gate-1'), { status: 'blocked' });
    expect(readReport(ref).export).toEqual(state);
    expect(readReport(ref).trials).toEqual(report.trials);
    expect(readArchivePart(archiveReference(archive.file, 'gates', 'gate-1'))).toEqual({ status: 'blocked' });
    saveReport(ref, report);
    expect(readReport(ref).export).toEqual(state);
    expect(() => archiveReference(archive.file, 'executions', '../outside')).toThrow();
});

test('all Run section writes respect the existing coordinator on the canonical archive', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-inline-owner-')), archive = createArchive(repo, { selection: 'full' });
    const before = readFileSync(archive.file, 'utf8'), release = acquireEvaluationWrite(archive.file);
    try { expect(() => writeArchivePart(archiveReference(archive.file, 'gates', 'one'), { status: 'blocked' })).toThrow(/write conflict/i); }
    finally { release(); }
    expect(readFileSync(archive.file, 'utf8')).toBe(before);
});

test('a necessary binary material is saved once and hydrated for original evidence readers', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-inline-material-')), archive = createArchive(repo, { selection: 'full' });
    const report = reportFixture(), material = { path: 'materials/invoice/original.pdf', encoding: 'base64', content: Buffer.from('%PDF-controlled-source').toString('base64') };
    report.trials[0]!.caseConditions!.files = [material];
    const ref = archiveReference(archive.file, 'executions', report.executionId); saveReport(ref, report);
    expect(readdirSync(dirname(archive.file)).sort()).toEqual(['README.md', 'materials', 'run.json']);
    expect(readdirSync(join(dirname(archive.file), 'materials'))).toHaveLength(1);
    expect(readFileSync(archive.file, 'utf8')).not.toContain(material.content);
    expect(readReport(ref).trials[0]!.caseConditions!.files).toEqual([material]);
    saveReport(ref, readReport(ref));
    expect(readdirSync(join(dirname(archive.file), 'materials'))).toHaveLength(1);
});

test('feedback returns the same canonical JSON record as its persisted readback', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-feedback-readback-')), archive = createArchive(repo, { selection: 'full' }), report = reportFixture();
    saveReport(archiveReference(archive.file, 'executions', report.executionId), report);
    const feedback = addFeedback(repo, { executionId: report.executionId, caseId: 'sample', reviewer: 'controlled', verdict: 'good', note: 'Observed result.' });
    expect(Object.hasOwn(feedback.conditions!, 'semanticPlan')).toBe(false);
    expect(feedback).toStrictEqual(readFeedbackRecords(repo, report.executionId)[0]);
});

test('binary materials with byte metadata are externalized once and restore their exact shape', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-binary-bytes-')), archive = createArchive(repo, { selection: 'full' });
    const content = Buffer.from('%PDF-controlled-source'), material = { path: 'original.pdf', encoding: 'base64',
        content: content.toString('base64'), bytes: content.length };
    const report = reportFixture(), files = [material, { path: material.path, encoding: material.encoding, content: material.content }];
    report.trials[0]!.caseConditions!.files = files;
    const ref = archiveReference(archive.file, 'executions', report.executionId);
    saveReport(ref, report);
    expect(readdirSync(join(dirname(archive.file), 'materials'))).toHaveLength(1);
    expect(readFileSync(archive.file, 'utf8')).not.toContain(material.content);
    expect(readReport(ref).trials[0]!.caseConditions!.files).toEqual(files);
    const before = readFileSync(archive.file, 'utf8');
    expect(() => writeArchivePart(ref, { files: [{ ...material, bytes: material.bytes + 1 }] })).toThrow(/byte/i);
    expect(readFileSync(archive.file, 'utf8')).toBe(before);
});

test('the readable failure report includes the original Run JSON evidence location', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-readable-evidence-')), archive = createArchive(repo, { selection: 'smoke' });
    const report = reportFixture(); report.trials[0]!.status = 'FAIL'; report.trials[0]!.reason = 'Required task failed';
    const ref = archiveReference(archive.file, 'executions', report.executionId);
    saveReport(ref, report); saveBadcases(ref, deriveBadcases(report, { file: ref })); writeRunReadme(archive.file);
    expect(readFileSync(join(dirname(archive.file), 'README.md'), 'utf8')).toContain('/executions/unit/trials/0');
});
