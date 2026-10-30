import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acquireEvaluationWrite as acquire } from '../../src/reports/files.ts';
import { addFeedback } from '../../src/review/local.ts';
import { exportReport } from '../../src/langfuse/export.ts';
import { saveReport } from '../../src/reports/store.ts';
import { createRunDirectory } from '../../src/reports/paths.ts';
import { humanFeedbackFile } from '../../src/reports/feedback.ts';
import { dataset, fixtureRepo, fixtureDirectory, reportFixture } from '../support/fixtures.ts';
import { deferCleanup, mkdtempSync as ownedTemp } from '../../../tests/support/resources.ts';
import { observationRowsFromOtlp } from '../langfuse/otlp-fixture.ts';

const repository = resolve(import.meta.dir, '../../..');
function processProgram(source: string) {
  const env: NodeJS.ProcessEnv = { PI_OFFLINE: '1' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, ['--no-env-file', '--eval', source], { cwd: repository, env, windowsHide: true, stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }); let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); }); child.stderr.on('data', bytes => { stderr += String(bytes); });
  const exited = new Promise<number | null>((done, reject) => { child.once('exit', done); child.once('error', reject); });
  child.once('close', () => lines.close());
  deferCleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; lines.close(); });
  return { child, lines, exited, stdout: () => stdout, stderr: () => stderr };
}
function cliProcess(repo: string, args: string[]) {
  const cli = join(repository, 'agent-eval/src/cli.ts').replaceAll('\\', '/');
  return processProgram(`import { main } from ${JSON.stringify(cli)};
await main(${JSON.stringify(args)}, ${JSON.stringify(repo)}).catch(error => { process.stderr.write(String(error.code || error.message)); process.exitCode = 1; });`);
}

for (const kind of ['case-quality', 'run-feedback'] as const) test(`two real processes preserve ${kind} records after a CLI write conflict and explicit retry`, async () => {
  const repo = ownedTemp(join(tmpdir(), 'p16-feedback-processes-'));
  cpSync(fixtureDirectory, join(repo, 'agent-eval/src/datasets/facility-test'), { recursive: true });
  cpSync(join(fixtureRepo, 'data'), join(repo, 'data'), { recursive: true });
  const trial = kind === 'run-feedback'; let originalReport: string | null = null;
  const reportFile = join(repo, 'agent-eval/runs/business/feedback-race/report.json');
  if (trial) {
    const report = reportFixture(); report.executionId = 'feedback-race'; report.trials[0]!.execution!.identity.executionId = report.executionId;
    saveReport(reportFile, report); originalReport = readFileSync(reportFile, 'utf8');
  }
  const file = humanFeedbackFile(repo, true);
  const input = { ...(trial ? { executionId: 'feedback-race', trialId: 'trial-1', caseId: 'sample' } : { datasetId: 'facility-test', caseId: 'test-fields' }),
    id: 'synthetic-held-feedback', reviewer: 'synthetic-first-reviewer', verdict: 'bad', note: 'First independent synthetic finding.' };
  const files = join(repository, 'agent-eval/src/reports/files.ts').replaceAll('\\', '/'), review = join(repository, 'agent-eval/src/review/local.ts').replaceAll('\\', '/');
  const first = processProgram(`import { spyOn } from 'bun:test'; import * as files from ${JSON.stringify(files)};
import { addFeedback } from ${JSON.stringify(review)}; import { readFileSync } from 'node:fs';
const save = files.atomicJson; spyOn(files, 'atomicJson').mockImplementation((path, value) => {
  if (path === ${JSON.stringify(file)}) { process.stdout.write('held\\n'); readFileSync(0, 'utf8'); } save(path, value);
}); addFeedback(${JSON.stringify(repo)}, ${JSON.stringify(input)});`);
  expect(await new Promise<string>(done => first.lines.once('line', done))).toBe('held');
  const args = ['review', 'add', ...(trial ? ['--execution-id', 'feedback-race', '--trial', 'trial-1', '--case', 'sample']
    : ['--dataset', 'facility-test', '--case', 'test-lines']), '--reviewer', 'synthetic-second-reviewer', '--verdict', 'good', '--note', 'Second independent synthetic finding.'];
  const conflicting = cliProcess(repo, args); expect(await conflicting.exited).toBe(1); expect(conflicting.stderr()).toContain('evaluation_write_conflict');
  expect(existsSync(file)).toBe(false);
  first.child.stdin.end('release'); expect(await first.exited).toBe(0);
  const firstSaved = JSON.parse(readFileSync(file, 'utf8')).records[0];
  const retried = cliProcess(repo, args); expect(await retried.exited).toBe(0);
  const records = JSON.parse(readFileSync(file, 'utf8')).records;
  expect(records).toHaveLength(2); expect(records[0]).toEqual(firstSaved);
  expect(records[1]).toMatchObject({ reviewer: 'synthetic-second-reviewer', caseId: trial ? 'sample' : 'test-lines' });
  if (trial) { expect(records.every((record: { trialId: string }) => record.trialId === 'trial-1')).toBe(true); expect(readFileSync(reportFile, 'utf8')).toBe(originalReport!); }
  expect(existsSync(file + '.write-lock')).toBe(false);
}, 45_000);

test('two real CLI processes preserve partial export receipts through a conflict and target-bound visibility recheck', async () => {
  const repo = ownedTemp(join(tmpdir(), 'p16-export-processes-')), report = reportFixture();
  report.executionId = 'export-race'; report.trials[0]!.execution!.identity.executionId = report.executionId;
  const file = join(repo, 'agent-eval/runs/business/export-race/report.json'); saveReport(file, report);
  const original = readFileSync(file, 'utf8'), batches: string[][] = []; let projects = 0, partial = true, release!: () => void, entered!: () => void;
  const observations: any[] = [], scores: any[] = []; let projectId = 'synthetic-process-project';
  const held = new Promise<void>(done => { release = done; }), querying = new Promise<void>(done => { entered = done; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('/projects')) {
      if (++projects === 1) { entered(); await held; }
      return Response.json({ data: [{ id: projectId, name: 'Synthetic', organization: { id: 'synthetic-org', name: 'Synthetic' }, metadata: {} }] });
    }
    const path = new URL(request.url).pathname;
    if (path.endsWith('/v2/observations')) return Response.json({
      data: partial ? observations.filter(row => !row.parentObservationId) : observations, meta: {} });
    if (path.endsWith('/v3/scores')) return Response.json({ data: partial ? [] : scores, meta: {} });
    if (path.endsWith('/scores') && request.method === 'POST') {
      const score = await request.json() as any; scores.push({ ...score, subject: { kind: 'trace', id: score.traceId } });
      return Response.json({ id: score.id });
    }
    if (!path.endsWith('/otel/v1/traces')) return new Response(null, { status: 404 });
    const rows = observationRowsFromOtlp(await request.json()); observations.push(...rows);
    batches.push(rows.map(row => row.metadata.localObservationId)); return Response.json({});
  } });
  const configs = join(repo, 'agent-eval/configs'); mkdirSync(configs, { recursive: true });
  writeFileSync(join(configs, '.env'), `LANGFUSE_BASE_URL=http://127.0.0.1:${server.port}\nLANGFUSE_PUBLIC_KEY=synthetic-process-public\nLANGFUSE_SECRET_KEY=synthetic-process-secret\n`);
  try {
    const args = ['resend', '--execution-id', 'export-race'], first = cliProcess(repo, args); await querying;
    const conflicting = cliProcess(repo, args); expect(await conflicting.exited).toBe(1); expect(conflicting.stderr()).toContain('evaluation_write_conflict');
    expect(projects).toBe(1); expect(batches).toHaveLength(0); release();
    expect(await first.exited).toBe(0);
    const receipt = join(file, '../export.json'), before = JSON.parse(readFileSync(receipt, 'utf8'));
    const root = observations.find(row => !row.parentObservationId)!; expect(root.type).toBe('AGENT');
    const rootId = root.metadata.localObservationId;
    expect(before).toMatchObject({ status: 'partial', target: { baseUrl: `http://127.0.0.1:${server.port}`, projectId },
      progress: { total: 2, acceptedEventIds: [rootId], rejectedEventIds: [] } });
    expect(batches).toHaveLength(1); expect(scores).toHaveLength(1);
    const stillUnknown = cliProcess(repo, args); expect(await stillUnknown.exited).toBe(0);
    expect(JSON.parse(readFileSync(receipt, 'utf8')).status).toBe('partial');
    expect(batches).toHaveLength(1); expect(scores).toHaveLength(1);
    const retained = readFileSync(receipt, 'utf8'); projectId = 'another-process-project';
    const wrongTarget = cliProcess(repo, args); expect(await wrongTarget.exited).toBe(1); expect(wrongTarget.stderr()).toContain('target');
    expect(readFileSync(receipt, 'utf8')).toBe(retained); expect(batches).toHaveLength(1); expect(scores).toHaveLength(1);
    projectId = 'synthetic-process-project';
    partial = false; const retry = cliProcess(repo, args); expect(await retry.exited).toBe(0);
    const after = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(after).toMatchObject({ status: 'complete', target: before.target });
    expect(batches).toHaveLength(1); expect(scores).toHaveLength(1);
    expect(after.progress).toEqual({ total: 2, acceptedEventIds: [rootId, ...scores.map(score => score.id)], rejectedEventIds: [],
      knownScoreIds: scores.map(score => score.id), submittedScoreIds: scores.map(score => score.id),
      scoreTimestamp: '2026-09-23T00:00:01Z' });
    expect(readFileSync(file, 'utf8')).toBe(original);
  } finally { release(); await server.stop(true); }
}, 45_000);

test('a sidecar writer excludes another operation until release without changing the saved content', () => {
  const root = mkdtempSync(join(tmpdir(), 'p16-file-write-')), file = join(root, 'review.json');
  try {
    writeFileSync(file, '{"records":[]}');
    const release = acquire?.(file); expect(release).toBeDefined();
    const unrelated = acquire(join(root, 'export.json')); unrelated();
    expect(() => acquire?.(file)).toThrow('write conflict');
    expect(readFileSync(file, 'utf8')).toBe('{"records":[]}');
    release!(); const next = acquire!(file); next();
    expect(existsSync(file + '.write-lock')).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared feedback refuses an occupied file before appending a Case record', () => {
  const file = humanFeedbackFile(fixtureRepo, true), release = acquire(file);
  try {
    expect(() => addFeedback(fixtureRepo, { dataset, caseId: dataset.cases[0]!.id,
      reviewer: 'synthetic-reviewer', verdict: 'bad', note: 'Synthetic review' })).toThrow('write conflict');
    expect(existsSync(file)).toBe(false);
  } finally { release(); }
});

test('shared export refuses an occupied file before sending any platform event or changing a receipt', async () => {
  const report = reportFixture(); report.executionId = 'locked-export'; report.trials[0]!.execution!.identity.executionId = report.executionId;
  const root = createRunDirectory(fixtureRepo, report.executionId, 'business'), file = join(root, 'report.json'); saveReport(file, report);
  const receipt = join(root, 'export.json'), before = existsSync(receipt) ? readFileSync(receipt, 'utf8') : null;
  const release = acquire(receipt); let sends = 0;
  try {
    await expect(exportReport(report, file, async () => { sends++; }, fixtureRepo)).rejects.toThrow('write conflict');
    expect(sends).toBe(0); expect(existsSync(receipt) ? readFileSync(receipt, 'utf8') : null).toBe(before);
  } finally { release(); }
});

test('a writer never releases a replaced ownership marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'p16-file-owner-')), file = join(root, 'export.json');
  try {
    const release = acquire?.(file); expect(release).toBeDefined();
    writeFileSync(file + '.write-lock', '{"owner":"someone-else"}');
    expect(() => release!()).toThrow('ownership');
    expect(readFileSync(file + '.write-lock', 'utf8')).toBe('{"owner":"someone-else"}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('two real processes cannot append competing records to the same sidecar', async () => {
  expect(acquire).toBeDefined();
  const root = mkdtempSync(join(tmpdir(), 'p16-file-processes-')), file = join(root, 'review.json');
  writeFileSync(file, '{"records":[]}');
  const module = resolve(import.meta.dir, '../../src/reports/files.ts').replaceAll('\\', '/');
  const program = `import { acquireEvaluationWrite } from ${JSON.stringify(module)};
const file = process.argv[1]; const release = acquireEvaluationWrite(file);
process.stdout.write('owned\\n');
process.stdin.once('data', () => { const data = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
data.records.push('first'); require('node:fs').writeFileSync(file, JSON.stringify(data)); release(); process.stdin.destroy(); });`;
  const env: NodeJS.ProcessEnv = {}; for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, ['--no-env-file', '--eval', program, file], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exited = new Promise<number | null>(done => child.once('exit', done));
  try {
    const owned = await new Promise<string>(done => lines.once('line', done)); expect(owned).toBe('owned');
    expect(() => acquire!(file)).toThrow('write conflict');
    child.stdin.write('release'); expect(await exited).toBe(0);
    const release = acquire!(file); const data = JSON.parse(readFileSync(file, 'utf8')); data.records.push('second'); writeFileSync(file, JSON.stringify(data)); release();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ records: ['first', 'second'] });
  } finally { lines.close(); if (child.exitCode === null) { child.kill(); await exited; } rmSync(root, { recursive: true, force: true }); }
});
