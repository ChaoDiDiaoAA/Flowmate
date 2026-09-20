import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { relative, resolve } from 'node:path';
import {
  buildP0FReport,
  type ArtifactRef,
  type CheckObservation,
  type EvidenceFile,
  type ProductBinding,
  type Purpose,
} from '../packages/contracts/src/index.ts';
import { nowUtc, sha256Bytes, sha256Canonical } from '../packages/shared/src/index.ts';
import { createProduct } from '../apps/composition.ts';
import { p0AssessmentBinding, readCases, requireBindingMatch, requireSeparateRoots, snapshotCode, writeNewJson, publicationCoverage } from '../agent-eval/src/runner/p0-binding.ts';

type Args = Record<string, string>;
type Publication = { manifest: ArtifactRef; documentRefs: Array<{ documentId: string; version: string; workspaceId: string; originalSha256: string; parseHash: string | null }> };
type SqliteFacts = { availableDocuments: number; pendingDocuments: number; datasetManifests: number; parsedDocuments: number; artifactCount: number; auditCount: number; migrationChecksums: string[] };
type WorkspaceBinding = { instanceId: string; workspaceId: string; policyHash: string };
type FaultSummary = { schemaVersion: 'p0-fault-probe/v1'; allPass: boolean; scenarios: Array<{ checkId: string; caseVariantId: string; status: 'PASS' | 'FAIL'; scenario: string; failureMessage: string | null; availableAfterFailure: number; pendingAfterFailure: number; retrySucceeded: boolean; oldPublicationReadable: boolean; responseReplaySame: boolean }> };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const instanceRoot = resolve(required(args, 'instance-root'));
  const outputRoot = resolve(required(args, 'output-root'));
  requireSeparateRoots(instanceRoot, outputRoot);
  if (!relative(resolve('agent-eval/runs'), outputRoot) || relative(resolve('agent-eval/runs'), outputRoot).startsWith('..') || !outputRoot.startsWith(resolve('agent-eval/runs') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('New P0 evidence must use a fresh child of agent-eval/runs');
  const sourceManifestSha256 = required(args, 'source-manifest-sha256');
  const purpose = (args.purpose ?? 'development') as Purpose;
  if (!['development', 'regression'].includes(purpose)) throw new Error('Unsupported purpose');
  const caseSet = await readCases(resolve(required(args, 'case-set')));
  const sourceRoot = resolve(process.env.FLOWMATE_SOURCE_ROOT ?? 'data/invoices/voxel51');
  if (sha256Bytes(await readFile(resolve(sourceRoot, 'manifest.json'))) !== sourceManifestSha256) throw new Error('Source manifest hash mismatch');
  const workspace = loadWorkspace(instanceRoot);
  const snapshot = await snapshotCode(process.cwd());
  const staticBinding = {
    ...p0AssessmentBinding(purpose),
    codeCommit: git('rev-parse', 'HEAD'), dirtyDiffSha256: snapshot.sha256,
    lockSha256: await sha256File(resolve('bun.lock')),
    configSha256: sha256Canonical({ schemaVersion: 'p0-default-config/v1', sourceRoot, purpose, policyHash: workspace.policyHash }),
    policySha256: workspace.policyHash, inputManifestSha256: sourceManifestSha256,
    productSpecSha256: await sha256File(resolve('docs/spec/00_Flowmate完整方案.md')),
    evalSpecSha256: await sha256File(resolve('agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md')),
    caseSetSha256: caseSet.sha256, oracleSha256: caseSet.oracleSha256,
    mapperVersion: 'p0-product-mapper/v2', os: process.platform, architecture: process.arch,
    bunVersion: process.versions.bun ?? 'unknown', nodeVersion: process.versions.node,
    pythonEnvironment: JSON.parse(execFileSync('python', ['-B', '-c', 'import sys,json,importlib.metadata as m; print(json.dumps({"python":sys.version,"executable":sys.executable,"pillow":m.version("Pillow"),"pytest":m.version("pytest")}))'], { encoding: 'utf8', windowsHide: true })),
    instanceId: workspace.instanceId, workspaceId: workspace.workspaceId, purpose,
  };
  await mkdir(outputRoot, { recursive: true });
  const bindingPath = resolve(outputRoot, 'expected-binding.json');
  if (args.freeze === 'true') {
    if (await exists(bindingPath) || await exists(resolve(outputRoot, 'cases.frozen.json'))) throw new Error('This execution is already frozen; choose a new output root');
    // Only freeze expectations; never starts Application or reads all source files.
    await writeNewJson(bindingPath, staticBinding);
    await writeFile(resolve(outputRoot, 'cases.frozen.json'), caseSet.bytes, { flag: 'wx' });
    await writeNewJson(resolve(outputRoot, 'execution-freeze.json'), {
      schemaVersion: 'p0-freeze/v1', frozenAt: nowUtc(), sourceRoot, instanceRoot,
      expectedSamples: (JSON.parse(await readFile(resolve(sourceRoot, 'manifest.json'), 'utf8')) as { samples: unknown[] }).samples.length,
      codeFiles: snapshot.files, expectedBindingSha256: await sha256File(bindingPath),
    });
    console.log(JSON.stringify({ frozen: true, bindingPath, caseSetSha256: caseSet.sha256 }));
    return;
  }
  const expected = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>;
  requireBindingMatch(expected, staticBinding);
  for (const name of ['inspect-summary.json', 'read-summary.json', 'sqlite-facts.json', 'restart-summary.json', 'publication-coverage.json', 'p0-f-evidence-v1.json']) {
    if (await exists(resolve(outputRoot, name))) throw new Error(`Refusing to overwrite ${name}`);
  }
  const publicationPath = resolve(required(args, 'publication-ref'));
  const publication = JSON.parse(await readFile(publicationPath, 'utf8')) as Publication;
  if (!publication.manifest || !Array.isArray(publication.documentRefs) || publication.documentRefs.length === 0) throw new Error('The publication reference is not a valid product output');

  const startedAt = nowUtc();
  const product = await createProduct({ instanceRoot, mode: 'open' });
  const processInstanceIds = [product.processInstanceId];
  const failures: Array<{ index?: number; documentId?: string; artifactId?: string; code: string }> = [];
  const evidenceRefs = new Map<string, ArtifactRef>();
  let inspected;
  let readCount = 0;
  let evidenceRead = 0;
  let captureProjection: ArtifactRef | undefined;
  let captureDocument: { documentId: string; version: string } | undefined;
  let captureContentHash = '';
  let restartRead = false;
  let coverage;
  try {
    const request = () => ({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId });
    inspected = await product.application.inspectSource(request(), { sourceKey: 'voxel51', manifestSha256: sourceManifestSha256, purpose });
    const approved = JSON.parse(await readFile(resolve(sourceRoot, 'manifest.json'), 'utf8')) as { samples: Array<{ sampleId: string }> };
    const committed = JSON.parse(new TextDecoder().decode(await product.application.readEvidence(request(), { artifact: publication.manifest }))) as { sourceManifestSha256: string; documents: Array<{ sampleId: string; aliases: string[]; excluded: Array<{ sampleId: string }>; documentId: string; version: string }> };
    coverage = publicationCoverage(approved.samples.map(s => s.sampleId), committed.documents);
    const returnedIds = publication.documentRefs.map(d => `${d.documentId}:${d.version}`).sort();
    const committedIds = committed.documents.map(d => `${d.documentId}:${d.version}`).sort();
    coverage.complete = coverage.complete && committed.sourceManifestSha256 === sourceManifestSha256 && sha256Canonical(returnedIds) === sha256Canonical(committedIds);

    for (let index = 0; index < publication.documentRefs.length; index += 1) {
      const ref = publication.documentRefs[index];
      try {
        const projection = await product.application.readDocument(request(), { document: ref, manifest: publication.manifest, purpose });
        if (projection.document.documentId !== ref.documentId || projection.document.version !== ref.version || projection.parsed.pages.length < 1 || !projection.parsed.contentHash) failures.push({ index, documentId: ref.documentId, code: 'PROJECTION_ASSERTION_FAILED' });
        else {
          readCount += 1;
          for (const evidence of projection.evidence) evidenceRefs.set(evidence.artifactId, evidence);
        }
      } catch (error) { failures.push({ index, documentId: ref.documentId, code: errorCode(error) }); }
    }
    for (const artifact of evidenceRefs.values()) {
      try {
        const bytes = await product.application.readEvidence(request(), { artifact });
        if (bytes.byteLength !== artifact.sizeBytes) failures.push({ artifactId: artifact.artifactId, code: 'EVIDENCE_SIZE_ASSERTION_FAILED' });
        else evidenceRead += 1;
      } catch (error) { failures.push({ artifactId: artifact.artifactId, code: errorCode(error) }); }
    }
    const first = publication.documentRefs[0];
    const projection = await product.application.readDocument(request(), { document: first, manifest: publication.manifest, purpose });
    const captured = await product.application.captureInput(request(), { document: first, manifest: publication.manifest, purpose });
    captureProjection = captured.projection;
    captureDocument = captured.document;
    captureContentHash = projection.parsed.contentHash;
  } finally {
    const closed = await product.close();
    if (!closed.closed || closed.cleanupErrors.length) throw Object.assign(new Error('Product cleanup failed; keep instance for diagnosis'), { cleanupErrors: closed.cleanupErrors });
  }

  let childPid = 0;
  try {
    if (!captureProjection || !captureDocument) throw new Error('Capture did not produce a projection');
    const referencePath = resolve(instanceRoot, 'p0-restart-projection-ref.json');
    await writeNewJson(referencePath, captureProjection);
    const result = JSON.parse(execFileSync(process.execPath, ['run', resolve('scripts/p0.ts'), 'read-captured', '--instance-root', instanceRoot, '--projection-ref', referencePath, '--purpose', purpose], { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4_194_304 })) as { document: { documentId: string; version: string }; contentHash: string; instanceId: string; workspaceId: string; processInstanceId: string; pid: number };
    processInstanceIds.push(result.processInstanceId);
    childPid = result.pid;
    restartRead = childPid !== process.pid && childPid > 0 && result.instanceId === product.instanceId && result.workspaceId === product.workspaceId && result.processInstanceId !== product.processInstanceId && result.document.documentId === captureDocument.documentId && result.document.version === captureDocument.version && result.contentHash === captureContentHash;
    if (!restartRead) failures.push({ code: 'RESTART_PROJECTION_ASSERTION_FAILED' });
  } catch (error) { failures.push({ code: errorCode(error) }); }

  const sqliteFacts = readSqliteFacts(`${instanceRoot}/data/app.sqlite`);
  const inspectSummary = { schemaVersion: 'p0-product-inspection-summary/v1', expectedSamples: inspected.expectedSamples, inspectedSamples: inspected.inspectedSamples, checkedFiles: inspected.checkedFiles, issueCount: inspected.issues.length, reportHash: inspected.reportHash, sourceManifestSha256 };
  const readSummary = { schemaVersion: 'p0-product-read-summary/v1', expectedDocuments: publication.documentRefs.length, readDocuments: readCount, uniqueEvidence: evidenceRefs.size, evidenceRead, failureCount: failures.length, failures: failures.slice(0, 20) };
  const restartSummary = { schemaVersion: 'p0-product-restart-summary/v1', projection: captureProjection, document: captureDocument, contentHash: captureContentHash, restartRead, processInstanceIds, parentPid: process.pid, childPid, distinctProcesses: childPid > 0 && childPid !== process.pid };
  const inspectPath = await writeEvidence(outputRoot, 'inspect-summary.json', inspectSummary);
  const readPath = await writeEvidence(outputRoot, 'read-summary.json', readSummary);
  const sqlitePath = await writeEvidence(outputRoot, 'sqlite-facts.json', sqliteFacts);
  const restartPath = await writeEvidence(outputRoot, 'restart-summary.json', restartSummary);
  const coveragePath = await writeEvidence(outputRoot, 'publication-coverage.json', coverage);
  const files: EvidenceFile[] = [];
  for (const path of [inspectPath, readPath, sqlitePath, restartPath, coveragePath]) files.push({ path: relative(outputRoot, path).replaceAll('\\', '/'), sha256: await sha256File(path), bytes: (await readFile(path)).byteLength, kind: path.endsWith('inspect-summary.json') ? 'input-check' : path.endsWith('sqlite-facts.json') ? 'facts' : 'process' });
  const sourceVerificationPath = resolve(outputRoot, 'source-verification.json');
  if (await exists(sourceVerificationPath)) files.push({ path: relative(outputRoot, sourceVerificationPath).replaceAll('\\', '/'), sha256: await sha256File(sourceVerificationPath), bytes: (await readFile(sourceVerificationPath)).byteLength, kind: 'input-check' });
  const sourceClosureAuditPath = resolve(outputRoot, 'source-closure-audit.json');
  if (await exists(sourceClosureAuditPath)) files.push({ path: relative(outputRoot, sourceClosureAuditPath).replaceAll('\\', '/'), sha256: await sha256File(sourceClosureAuditPath), bytes: (await readFile(sourceClosureAuditPath)).byteLength, kind: 'input-check' });
  const faultSummaryPath = resolve(outputRoot, 'fault-summary.json');
  const faultSummary = await readOptionalJson<FaultSummary>(faultSummaryPath);
  if (faultSummary) files.push({ path: relative(outputRoot, faultSummaryPath).replaceAll('\\', '/'), sha256: await sha256File(faultSummaryPath), bytes: (await readFile(faultSummaryPath)).byteLength, kind: 'fault' });
  // Optional supporting observations are produced by read-only verification
  // commands before this runner.  They are bound into the report when present
  // but never used to manufacture a product check or to change its verdict.
  for (const [name, kind] of [['vitest-product.json', 'process'], ['vitest-facility.json', 'process'], ['execution-freeze.json', 'binding'], ['execution-steps.json', 'binding']] as const) {
    const path = resolve(outputRoot, name);
    if (await exists(path)) files.push({ path: relative(outputRoot, path).replaceAll('\\', '/'), sha256: await sha256File(path), bytes: (await readFile(path)).byteLength, kind });
  }

  if ((await snapshotCode(process.cwd())).sha256 !== snapshot.sha256 || (await readCases(resolve(required(args, 'case-set')))).sha256 !== caseSet.sha256) throw new Error('Source code or Case changed during evaluation');
  const binding: ProductBinding = {
    ...staticBinding,
    migrationChecksums: sqliteFacts.migrationChecksums,
    os: process.platform,
    architecture: process.arch,
    bunVersion: process.versions.bun ?? 'unknown',
    nodeVersion: process.versions.node,
    instanceId: workspace.instanceId,
    workspaceId: workspace.workspaceId,
    processInstanceIds,
    purpose,
  };
  const checks: CheckObservation[] = [
    { checkId: 'P0-F01/full-source-structure/v1', caseVariantId: 'full-current-manifest', capabilityIds: ['P0-C05'], metricIds: [], required: true, applicable: true, status: inspectSummary.expectedSamples === inspectSummary.inspectedSamples && inspectSummary.issueCount === 0 ? 'PASS' : 'FAIL', reason: `inspect ${inspectSummary.inspectedSamples}/${inspectSummary.expectedSamples}; issues=${inspectSummary.issueCount}`, evidencePaths: [relative(outputRoot, inspectPath).replaceAll('\\', '/'), ...(await exists(sourceVerificationPath) ? [relative(outputRoot, sourceVerificationPath).replaceAll('\\', '/')] : []), ...(await exists(sourceClosureAuditPath) ? [relative(outputRoot, sourceClosureAuditPath).replaceAll('\\', '/')] : [])] },
    { checkId: 'P0-F03/full-publication/v1', caseVariantId: 'fresh-instance', capabilityIds: ['P0-C07'], metricIds: [], required: true, applicable: true, status: readSummary.expectedDocuments === sqliteFacts.availableDocuments && sqliteFacts.pendingDocuments === 0 ? 'PASS' : 'FAIL', reason: `published=${sqliteFacts.availableDocuments}; pending=${sqliteFacts.pendingDocuments}; manifest=${sqliteFacts.datasetManifests}`, evidencePaths: [relative(outputRoot, sqlitePath).replaceAll('\\', '/')] },
    { checkId: 'P0-F04/full-read-evidence-restart/v1', caseVariantId: 'all-documents-plus-capture', capabilityIds: ['P0-C07', 'P0-C08'], metricIds: [], required: true, applicable: true, status: readSummary.readDocuments === readSummary.expectedDocuments && readSummary.evidenceRead === readSummary.uniqueEvidence && restartRead && failures.length === 0 ? 'PASS' : 'FAIL', reason: `read=${readSummary.readDocuments}/${readSummary.expectedDocuments}; evidence=${readSummary.evidenceRead}/${readSummary.uniqueEvidence}; restart=${restartRead}; failures=${failures.length}`, evidencePaths: [relative(outputRoot, readPath).replaceAll('\\', '/'), relative(outputRoot, restartPath).replaceAll('\\', '/')] },
  ];
  if (faultSummary) {
    const faultEvidencePath = relative(outputRoot, faultSummaryPath).replaceAll('\\', '/');
    for (const scenario of faultSummary.scenarios) checks.push({ checkId: scenario.checkId, caseVariantId: scenario.caseVariantId, capabilityIds: scenario.checkId.startsWith('P0-F12') ? ['P0-C07'] : ['P0-C03', 'P0-C07'], metricIds: [], required: true, applicable: true, status: scenario.status, reason: `fault=${scenario.failureMessage ?? 'none'}; availableAfterFailure=${scenario.availableAfterFailure}; pendingAfterFailure=${scenario.pendingAfterFailure}; retry=${scenario.retrySucceeded}; oldReadable=${scenario.oldPublicationReadable}; responseReplaySame=${scenario.responseReplaySame}`, evidencePaths: [faultEvidencePath] });
  }
  const blockers: string[] = [];
  if (!faultSummary) blockers.push('fault-injection-evidence-missing');
  const report = buildP0FReport({ executionId: `e_${crypto.randomUUID().replaceAll('-', '')}`, phase: 'P0', evidenceKind: 'F', scope: 'product', executionEligibility: blockers.length ? 'blocked' : 'ready', blockers, window: { startedAt, endedAt: nowUtc() }, files, checks, caseCounts: { planned: checks.length, applicable: checks.length, executed: checks.length, confirmedPass: 0 }, binding });
  const reportPath = resolve(outputRoot, 'p0-f-evidence-v1.json');
  await writeNewJson(reportPath, report);
  console.log(JSON.stringify({ reportPath, executionId: report.executionId, counts: report.counts, blockers: report.blockers, outputRoot }, null, 2));
}

function parseArgs(values: string[]): Args { const result: Args = {}; for (let i = 0; i < values.length; i += 1) { const item = values[i]; if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`); const key = item.slice(2); const value = values[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`); result[key] = value; } return result; }
function required(args: Args, name: string): string { const value = args[name]; if (!value) throw new Error(`Missing --${name}`); return value; }
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'descriptor' in error && (error as { descriptor?: { code?: string } }).descriptor?.code ? (error as { descriptor: { code: string } }).descriptor.code : 'UNKNOWN'; }
function git(...args: string[]): string { return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim(); }
async function sha256File(path: string): Promise<string> { return sha256Bytes(await readFile(path)); }
async function writeEvidence(root: string, name: string, value: unknown): Promise<string> { const path = resolve(root, name); await writeNewJson(path, value); return path; }
async function exists(path: string): Promise<boolean> { try { await readFile(path); return true; } catch (error) { if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
async function readOptionalJson<T>(path: string): Promise<T | undefined> { if (!(await exists(path))) return undefined; return JSON.parse(await readFile(path, 'utf8')) as T; }
function readSqliteFacts(dbPath: string): SqliteFacts {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const available = db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='available'").get() as { count: number };
  const pending = db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='pending'").get() as { count: number };
  const parsed = db.prepare('SELECT COUNT(*) AS count FROM documents WHERE parse_hash IS NOT NULL').get() as { count: number };
  const artifacts = db.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as { count: number };
  const manifests = db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE kind='dataset/manifest'").get() as { count: number };
  const audits = db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number };
  const migrationChecksums = db.prepare('SELECT checksum FROM schema_migrations ORDER BY version').all().map((item) => String((item as { checksum: string }).checksum));
  db.close();
  return { availableDocuments: Number(available.count), pendingDocuments: Number(pending.count), parsedDocuments: Number(parsed.count), artifactCount: Number(artifacts.count), datasetManifests: Number(manifests.count), auditCount: Number(audits.count), migrationChecksums };
}
function loadWorkspace(instanceRoot: string): WorkspaceBinding {
  const db = new DatabaseSync(`${instanceRoot}/data/app.sqlite`, { readOnly: true });
  const row = db.prepare('SELECT workspace_id AS workspaceId, policy_hash AS policyHash FROM workspaces WHERE workspace_key=\'default\'').get() as { workspaceId: string; policyHash: string };
  const identity = JSON.parse(readFileSync(`${instanceRoot}/instance.json`, 'utf8')) as { instanceId: string };
  db.close();
  return { instanceId: identity.instanceId, workspaceId: row.workspaceId, policyHash: row.policyHash };
}

main().catch((error) => { process.stderr.write(`${JSON.stringify({ code: errorCode(error), message: error instanceof Error ? error.message : String(error), ...(error && typeof error === 'object' && 'cleanupErrors' in error ? { cleanupErrors: error.cleanupErrors } : {}) })}\n`); process.exitCode = 1; });
