import { DatabaseSync } from 'node:sqlite';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProduct } from '../apps/composition.ts';
import type { WorkspacePolicy } from '../packages/contracts/src/index.ts';
import { sha256Bytes } from '../packages/shared/src/index.ts';

type ScenarioName = 'file-finalization' | 'database-commit' | 'audit-insert' | 'response-loss';
type ScenarioResult = {
  checkId: string;
  caseVariantId: string;
  status: 'PASS' | 'FAIL';
  scenario: ScenarioName;
  inputManifestSha256: string;
  requestId: string;
  triggered: boolean;
  failureMessage: string | null;
  receiptAfterFailure: boolean;
  availableAfterFailure: number;
  pendingAfterFailure: number;
  retrySucceeded: boolean;
  oldPublicationReadable: boolean;
  responseReplaySame: boolean;
  error?: string;
};

const operations = ['source.inspect', 'source.register', 'source.publish', 'document.read', 'input.capture', 'document.setStatus', 'workspace.setStatus', 'policy.publish', 'evidence.read'] as const;
const previousSourceRoot = process.env.FLOWMATE_SOURCE_ROOT;

async function main(): Promise<void> {
  const outputRoot = resolve(parseArgs(process.argv.slice(2))['output-root'] ?? 'agent-eval/reports/p0/20260920-full-product');
  await mkdir(outputRoot, { recursive: true });
  const scenarios: ScenarioResult[] = [];
  try {
    for (const scenario of ['file-finalization', 'database-commit', 'audit-insert', 'response-loss'] as const) {
      const fixture = await makeFixture();
      try {
        scenarios.push(await runScenario(scenario, fixture));
      } catch (error) {
        scenarios.push({
          checkId: checkIdFor(scenario), caseVariantId: `${scenario}-temporary-fixture`, status: 'FAIL', scenario,
          inputManifestSha256: fixture.manifestSha256, requestId: '', triggered: false, failureMessage: null,
          receiptAfterFailure: false, availableAfterFailure: -1, pendingAfterFailure: -1,
          retrySucceeded: false, oldPublicationReadable: false, responseReplaySame: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await removeTemporaryRoot(fixture.root);
      }
    }
  } finally {
    if (previousSourceRoot === undefined) delete process.env.FLOWMATE_SOURCE_ROOT;
    else process.env.FLOWMATE_SOURCE_ROOT = previousSourceRoot;
  }
  const summary = {
    schemaVersion: 'p0-fault-probe/v1',
    checkedAt: new Date().toISOString(),
    scope: 'temporary one-sample product instances; no repository source, Gold, published list or history mutation',
    allPass: scenarios.length === 4 && scenarios.every((scenario) => scenario.status === 'PASS'),
    scenarios,
  };
  await writeFile(join(outputRoot, 'fault-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputRoot, allPass: summary.allPass, scenarios: scenarios.map((scenario) => ({ checkId: scenario.checkId, status: scenario.status })) }, null, 2));
  if (!summary.allPass) process.exitCode = 1;
}

async function removeTemporaryRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EBUSY')) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  // The fixture is outside the repository and has no product authority. A
  // transient Windows handle must not erase the already-collected observation.
  process.stderr.write(`temporary fault fixture cleanup deferred: ${root}; ${lastError instanceof Error ? lastError.message : String(lastError)}\n`);
}

async function makeFixture(): Promise<{ root: string; sourceRoot: string; sampleId: string; originalSha256: string; manifestSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p0-fault-'));
  const sourceRoot = join(root, 'source');
  const originalRoot = resolve('data/invoices/voxel51');
  const sourceManifest = JSON.parse(await readFile(join(originalRoot, 'manifest.json'), 'utf8')) as { samples: Array<{ sampleId: string; originalSha256: string; metadata: { path: string; bytes: number; sha256: string } }> };
  const sample = sourceManifest.samples.find((candidate) => candidate.sampleId === '000001');
  if (!sample) throw new Error('Source sample 000001 is missing');
  await mkdir(sourceRoot, { recursive: true });
  await cp(join(originalRoot, sample.sampleId), join(sourceRoot, sample.sampleId), { recursive: true });
  const manifest = { ...sourceManifest, samples: [sample] };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  await writeFile(join(sourceRoot, 'manifest.json'), manifestBytes);
  process.env.FLOWMATE_SOURCE_ROOT = sourceRoot;
  return { root, sourceRoot, sampleId: sample.sampleId, originalSha256: sample.originalSha256, manifestSha256: sha256Bytes(manifestBytes) };
}

async function rewriteContent(fixture: { sourceRoot: string; sampleId: string }): Promise<string> {
  const contentPath = join(fixture.sourceRoot, fixture.sampleId, 'content.json');
  const content = JSON.parse(await readFile(contentPath, 'utf8')) as Array<Record<string, unknown>>;
  const textBlock = content.find((candidate) => typeof candidate.text === 'string');
  if (!textBlock) throw new Error('Source sample has no text block');
  textBlock.text = `${String(textBlock.text)} [fault probe revision]`;
  const contentBytes = new TextEncoder().encode(JSON.stringify(content));
  await writeFile(contentPath, contentBytes);
  const metadataPath = join(fixture.sourceRoot, fixture.sampleId, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { files: Array<{ path: string; bytes: number; sha256: string }> };
  const descriptor = metadata.files.find((candidate) => candidate.path === 'content.json');
  if (!descriptor) throw new Error('Source metadata has no content descriptor');
  descriptor.bytes = contentBytes.byteLength;
  descriptor.sha256 = sha256Bytes(contentBytes);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  await writeFile(metadataPath, metadataBytes);
  const manifestPath = join(fixture.sourceRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { samples: Array<{ metadata: { path: string; bytes: number; sha256: string } }> };
  manifest.samples[0].metadata.bytes = metadataBytes.byteLength;
  manifest.samples[0].metadata.sha256 = sha256Bytes(metadataBytes);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  return sha256Bytes(manifestBytes);
}

async function approveManifest(product: Awaited<ReturnType<typeof createProduct>>, fixture: { sourceRoot: string }, manifestSha256: string): Promise<void> {
  const workspace = await product.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId });
  const policy: WorkspacePolicy = {
    schemaVersion: 'p0-policy/v1', version: workspace.version + 1,
    grants: [{ actorId: workspace.ownerActorId, operations, sourceKeys: ['voxel51'], purposes: ['development', 'regression'] }],
    sources: [{ sourceKey: 'voxel51', rootRef: resolve(fixture.sourceRoot), manifestSha256, allowedPurposes: ['development', 'regression'], useAuthorizationRef: `workspace:${product.workspaceId}` }],
  };
  await product.application.publishPolicy({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId }, { expectedRevision: workspace.version, policy });
}

async function runScenario(scenario: ScenarioName, fixture: { root: string; sourceRoot: string; sampleId: string; originalSha256: string; manifestSha256: string }): Promise<ScenarioResult> {
  process.env.FLOWMATE_SOURCE_ROOT = fixture.sourceRoot;
  const instanceRoot = join(fixture.root, 'instance');
  const first = await createProduct({ instanceRoot, mode: 'create' });
  const oldInput = { sourceKey: 'voxel51', manifestSha256: fixture.manifestSha256, selection: [], purpose: 'development' as const };
  const oldPublication = await first.application.publishDataset({ requestId: crypto.randomUUID(), workspaceId: first.workspaceId }, oldInput);
  await first.close();
  const nextManifestSha256 = await rewriteContent(fixture);
  let enabled = false;
  let triggered = false;
  const second = await createProduct({ instanceRoot, mode: 'open' }, {
    fileFault: (point) => { if (enabled && !triggered && point === 'before-content-finalize' && scenario === 'file-finalization') { triggered = true; enabled = false; throw new Error('injected before-content-finalize'); } },
    databaseFault: (point) => { if (enabled && !triggered && point === 'before-commit' && scenario === 'database-commit') { triggered = true; enabled = false; throw new Error('injected before-commit'); } if (enabled && !triggered && point === 'before-audit-insert' && scenario === 'audit-insert') { triggered = true; enabled = false; throw new Error('injected before-audit-insert'); } },
    applicationFault: (point, operation) => { if (enabled && !triggered && point === 'before-response' && operation === 'source.publish' && scenario === 'response-loss') { triggered = true; enabled = false; throw new Error('injected before-response'); } },
  });
  const requestId = crypto.randomUUID();
  const nextInput = { sourceKey: 'voxel51', manifestSha256: nextManifestSha256, selection: [], purpose: 'development' as const };
  let failureMessage: string | null = null;
  let receiptAfterFailure = false;
  let retrySucceeded = false;
  let oldPublicationReadable = false;
  let responseReplaySame = false;
  try {
    await approveManifest(second, fixture, nextManifestSha256);
    enabled = true;
    try {
      await second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput);
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    await second.close();
    const factsAfterFailure = readDocumentFacts(instanceRoot);
    const reopened = await createProduct({ instanceRoot, mode: 'open' });
    try {
      const receipt = await reopened.application.findReceipt({ requestId: crypto.randomUUID(), workspaceId: reopened.workspaceId }, { originalRequestId: requestId });
      receiptAfterFailure = receipt !== null;
      if (scenario === 'response-loss') {
        if (!receipt) throw new Error('The committed response-loss request has no durable receipt');
        const replay = await reopened.application.publishDataset({ requestId, workspaceId: reopened.workspaceId }, nextInput);
        retrySucceeded = replay.documentRefs.length === 1;
        responseReplaySame = replay.manifest.artifactId === receipt.resultRef.artifactId;
      } else {
        const retry = await reopened.application.publishDataset({ requestId, workspaceId: reopened.workspaceId }, nextInput);
        retrySucceeded = retry.documentRefs.length === 1;
      }
      const oldRead = await reopened.application.readDocument({ requestId: crypto.randomUUID(), workspaceId: reopened.workspaceId }, { document: oldPublication.documentRefs[0], manifest: oldPublication.manifest, purpose: 'development' });
      oldPublicationReadable = oldRead.document.documentId === oldPublication.documentRefs[0].documentId && oldRead.document.version === oldPublication.documentRefs[0].version;
    } finally { await reopened.close(); }
    const expectedFacts = scenario === 'response-loss' ? factsAfterFailure.available === 2 && factsAfterFailure.pending === 0 : factsAfterFailure.available === 1 && factsAfterFailure.pending === 0;
    const expectedReceipt = scenario === 'response-loss' ? receiptAfterFailure : !receiptAfterFailure;
    const status = triggered && Boolean(failureMessage) && expectedFacts && expectedReceipt && retrySucceeded && oldPublicationReadable && (scenario !== 'response-loss' || responseReplaySame) ? 'PASS' : 'FAIL';
    return { checkId: checkIdFor(scenario), caseVariantId: `${scenario}-temporary-fixture`, status, scenario, inputManifestSha256: nextManifestSha256, requestId, triggered, failureMessage, receiptAfterFailure, availableAfterFailure: factsAfterFailure.available, pendingAfterFailure: factsAfterFailure.pending, retrySucceeded, oldPublicationReadable, responseReplaySame };
  } finally {
    await second.close();
  }
}

function checkIdFor(scenario: ScenarioName): string {
  const suffix: Record<ScenarioName, string> = { 'file-finalization': 'P0-F12/file-finalization/v1', 'database-commit': 'P0-F13/database-commit/v1', 'audit-insert': 'P0-F13/audit-insert/v1', 'response-loss': 'P0-F14/response-loss/v1' };
  return suffix[scenario];
}

function readDocumentFacts(instanceRoot: string): { available: number; pending: number } {
  const db = new DatabaseSync(join(instanceRoot, 'data', 'app.sqlite'), { readOnly: true });
  const available = Number((db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='available'").get() as { count: number }).count);
  const pending = Number((db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status='pending'").get() as { count: number }).count);
  db.close();
  return { available, pending };
}

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--') || !values[index + 1]) throw new Error(`Expected --name value, received ${value ?? '<end>'}`);
    result[value.slice(2)] = values[index + 1];
    index += 1;
  }
  return result;
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
