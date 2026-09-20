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

type Args = Record<string, string>;
type Publication = { manifest: ArtifactRef; documentRefs: Array<{ documentId: string; version: string; workspaceId: string; originalSha256: string; parseHash: string | null }> };
type SqliteFacts = { availableDocuments: number; pendingDocuments: number; datasetManifests: number; parsedDocuments: number; artifactCount: number; auditCount: number; migrationChecksums: string[] };
type WorkspaceBinding = { instanceId: string; workspaceId: string; policyHash: string };
type FaultSummary = { schemaVersion: 'p0-fault-probe/v1'; allPass: boolean; scenarios: Array<{ checkId: string; caseVariantId: string; status: 'PASS' | 'FAIL'; scenario: string; failureMessage: string | null; availableAfterFailure: number; pendingAfterFailure: number; retrySucceeded: boolean; oldPublicationReadable: boolean; responseReplaySame: boolean }> };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const instanceRoot = resolve(required(args, 'instance-root'));
  const publicationPath = resolve(required(args, 'publication-ref'));
  const outputRoot = resolve(required(args, 'output-root'));
  const sourceManifestSha256 = required(args, 'source-manifest-sha256');
  const purpose = (args.purpose ?? 'development') as Purpose;
  const publication = JSON.parse(await readFile(publicationPath, 'utf8')) as Publication;
  if (!publication.manifest || !Array.isArray(publication.documentRefs) || publication.documentRefs.length === 0) throw new Error('The publication reference is not a valid product output');
  await mkdir(outputRoot, { recursive: true });

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
  try {
    const request = () => ({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId });
    inspected = await product.application.inspectSource(request(), { sourceKey: 'voxel51', manifestSha256: sourceManifestSha256, purpose });
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
    await product.close();
  }

  const reopened = await createProduct({ instanceRoot, mode: 'open' });
  processInstanceIds.push(reopened.processInstanceId);
  try {
    if (!captureProjection || !captureDocument) throw new Error('Capture did not produce a projection');
    const projection = await reopened.application.readCapturedInput({ requestId: crypto.randomUUID(), workspaceId: reopened.workspaceId }, { projection: captureProjection, purpose });
    restartRead = projection.document.documentId === captureDocument.documentId && projection.document.version === captureDocument.version && projection.parsed.contentHash === captureContentHash;
    if (!restartRead) failures.push({ code: 'RESTART_PROJECTION_ASSERTION_FAILED' });
  } catch (error) { failures.push({ code: errorCode(error) }); }
  finally { await reopened.close(); }

  const sqliteFacts = readSqliteFacts(`${instanceRoot}/data/app.sqlite`);
  const inspectSummary = { schemaVersion: 'p0-product-inspection-summary/v1', expectedSamples: inspected.expectedSamples, inspectedSamples: inspected.inspectedSamples, checkedFiles: inspected.checkedFiles, issueCount: inspected.issues.length, reportHash: inspected.reportHash, sourceManifestSha256 };
  const readSummary = { schemaVersion: 'p0-product-read-summary/v1', expectedDocuments: publication.documentRefs.length, readDocuments: readCount, uniqueEvidence: evidenceRefs.size, evidenceRead, failureCount: failures.length, failures: failures.slice(0, 20) };
  const restartSummary = { schemaVersion: 'p0-product-restart-summary/v1', projection: captureProjection, document: captureDocument, contentHash: captureContentHash, restartRead, processInstanceIds };
  const inspectPath = await writeEvidence(outputRoot, 'inspect-summary.json', inspectSummary);
  const readPath = await writeEvidence(outputRoot, 'read-summary.json', readSummary);
  const sqlitePath = await writeEvidence(outputRoot, 'sqlite-facts.json', sqliteFacts);
  const restartPath = await writeEvidence(outputRoot, 'restart-summary.json', restartSummary);
  const files: EvidenceFile[] = [];
  for (const path of [inspectPath, readPath, sqlitePath, restartPath]) files.push({ path: relative(outputRoot, path).replaceAll('\\', '/'), sha256: await sha256File(path), bytes: (await readFile(path)).byteLength, kind: path.endsWith('inspect-summary.json') ? 'input-check' : path.endsWith('sqlite-facts.json') ? 'facts' : 'process' });
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
  for (const [name, kind] of [['vitest-product.json', 'process'], ['benchmark-pin-drift.json', 'input-check']] as const) {
    const path = resolve(outputRoot, name);
    if (await exists(path)) files.push({ path: relative(outputRoot, path).replaceAll('\\', '/'), sha256: await sha256File(path), bytes: (await readFile(path)).byteLength, kind });
  }

  const workspace = await loadWorkspace(instanceRoot);
  const binding: ProductBinding = {
    codeCommit: git('rev-parse', 'HEAD'),
    dirtyDiffSha256: sha256Bytes(new TextEncoder().encode(`${git('status', '--porcelain')}\n${git('diff', '--binary')}`)),
    lockSha256: await sha256File(resolve('bun.lock')),
    configSha256: sha256Canonical({ schemaVersion: 'p0-default-config/v1', sourceManifestSha256, purpose, policyHash: workspace.policyHash }),
    policySha256: workspace.policyHash,
    inputManifestSha256: sourceManifestSha256,
    productSpecSha256: await sha256File(resolve('docs/spec/00_Flowmate完整方案.md')),
    evalSpecSha256: await sha256File(resolve('agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md')),
    caseSetSha256: await sha256File(resolve('agent-eval/data/manifests/case-catalog.json')),
    oracleSha256: await hashDirectory(resolve('agent-eval/data/cases')),
    mapperVersion: 'p0-product-mapper/v1',
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
  const blockers = ['formal-case-oracle-review-pending', 'data-use-authorization-not-verified', 'benchmark-definition-pin-drift'];
  if (!faultSummary?.allPass) blockers.splice(1, 0, 'fault-injection-cases-not-run');
  const report = buildP0FReport({ executionId: `e_${crypto.randomUUID().replaceAll('-', '')}`, phase: 'P0', evidenceKind: 'F', scope: 'product', executionEligibility: 'blocked', blockers, window: { startedAt, endedAt: nowUtc() }, files, checks, caseCounts: { planned: checks.length, applicable: checks.length, executed: checks.length, confirmedPass: 0 }, binding });
  const reportPath = resolve(outputRoot, 'p0-f-evidence-v1.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportPath, executionId: report.executionId, counts: report.counts, blockers: report.blockers, outputRoot }, null, 2));
}

function parseArgs(values: string[]): Args { const result: Args = {}; for (let i = 0; i < values.length; i += 1) { const item = values[i]; if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}`); const key = item.slice(2); const value = values[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`); result[key] = value; } return result; }
function required(args: Args, name: string): string { const value = args[name]; if (!value) throw new Error(`Missing --${name}`); return value; }
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'descriptor' in error && (error as { descriptor?: { code?: string } }).descriptor?.code ? (error as { descriptor: { code: string } }).descriptor.code : 'UNKNOWN'; }
function git(...args: string[]): string { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
async function sha256File(path: string): Promise<string> { return sha256Bytes(await readFile(path)); }
async function hashDirectory(root: string): Promise<string> { const files = git('ls-files', '-co', '--exclude-standard', '--', relative(process.cwd(), root).replaceAll('\\', '/')).split(/\r?\n/).filter(Boolean).sort(); const entries = []; for (const file of files) { const absolute = resolve(file); entries.push({ path: file, sha256: await sha256File(absolute), bytes: (await readFile(absolute)).byteLength }); } return sha256Canonical(entries); }
async function writeEvidence(root: string, name: string, value: unknown): Promise<string> { const path = resolve(root, name); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); return path; }
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

main().catch((error) => { process.stderr.write(`${JSON.stringify({ code: errorCode(error), message: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
