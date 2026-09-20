import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Bytes } from '../../packages/shared/src/index.ts';
import { createProduct } from '../../apps/composition.ts';
import type { InputProjection } from '../../packages/contracts/src/index.ts';

const roots: string[] = [];
const previousSourceRoot = process.env.FLOWMATE_SOURCE_ROOT;

afterEach(async () => {
  if (previousSourceRoot === undefined) delete process.env.FLOWMATE_SOURCE_ROOT;
  else process.env.FLOWMATE_SOURCE_ROOT = previousSourceRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(sampleId = '000001') {
  const root = await (await import('node:fs/promises')).mkdtemp(join(resolve(process.env.TEMP ?? process.env.TMP ?? '.'), 'flowmate-data-'));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  const originalRoot = resolve('data/invoices/voxel51');
  const manifest = JSON.parse(await readFile(join(originalRoot, 'manifest.json'), 'utf8')) as { samples: Array<{ sampleId: string; originalSha256: string }> };
  const sample = manifest.samples.find((candidate) => candidate.sampleId === sampleId);
  if (!sample) throw new Error(`Fixture sample ${sampleId} not found`);
  await mkdir(sourceRoot, { recursive: true });
  await cp(join(originalRoot, sample.sampleId), join(sourceRoot, sample.sampleId), { recursive: true });
  const single = { ...JSON.parse(await readFile(join(originalRoot, 'manifest.json'), 'utf8')), samples: [sample] };
  await writeFile(join(sourceRoot, 'manifest.json'), JSON.stringify(single));
  process.env.FLOWMATE_SOURCE_ROOT = sourceRoot;
  return { root, sourceRoot, manifestSha256: sha256Bytes(new TextEncoder().encode(JSON.stringify(single))), sampleId: sample.sampleId, originalSha256: sample.originalSha256 };
}

async function rewriteSourceFile(data: { sourceRoot: string; sampleId: string }, relativePath: string, transform: (bytes: Uint8Array) => Uint8Array): Promise<string> {
  const sourcePath = join(data.sourceRoot, data.sampleId, relativePath);
  const bytes = transform(await readFile(sourcePath));
  await writeFile(sourcePath, bytes);
  const manifestPath = join(data.sourceRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { samples: Array<{ sampleId: string; metadata: { path: string; bytes: number; sha256: string } }> };
  const sample = manifest.samples.find((candidate) => candidate.sampleId === data.sampleId);
  if (!sample) throw new Error(`Fixture sample ${data.sampleId} not found in manifest`);
  const metadataPath = join(data.sourceRoot, sample.metadata.path);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { files: Array<{ path: string; bytes: number; sha256: string }> };
  const descriptor = metadata.files.find((candidate) => candidate.path === relativePath);
  if (!descriptor) throw new Error(`Fixture descriptor ${relativePath} not found`);
  descriptor.bytes = bytes.byteLength;
  descriptor.sha256 = sha256Bytes(bytes);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  await writeFile(metadataPath, metadataBytes);
  sample.metadata.bytes = metadataBytes.byteLength;
  sample.metadata.sha256 = sha256Bytes(metadataBytes);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  return sha256Bytes(manifestBytes);
}

async function makeSecondParseVersion(data: { sourceRoot: string; sampleId: string }): Promise<string> {
  return rewriteSourceFile(data, 'content.json', (bytes) => {
    const content = JSON.parse(new TextDecoder().decode(bytes)) as Array<Record<string, unknown>>;
    const textBlock = content.find((candidate) => typeof candidate.text === 'string');
    if (!textBlock) throw new Error('Fixture sample has no text block to revise');
    textBlock.text = `${String(textBlock.text)} [revision]`;
    return new TextEncoder().encode(JSON.stringify(content));
  });
}

async function addParseVariant(data: { sourceRoot: string; sampleId: string }): Promise<string> {
  const manifestPath = join(data.sourceRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { samples: Array<{ sampleId: string; originalSha256: string; metadata: { path: string; bytes: number; sha256: string } }> };
  const original = manifest.samples.find((candidate) => candidate.sampleId === data.sampleId);
  if (!original) throw new Error(`Fixture sample ${data.sampleId} not found`);
  const variantId = `${data.sampleId}-parse-variant`;
  await cp(join(data.sourceRoot, data.sampleId), join(data.sourceRoot, variantId), { recursive: true });
  const contentPath = join(data.sourceRoot, variantId, 'content.json');
  const content = JSON.parse(await readFile(contentPath, 'utf8')) as Array<Record<string, unknown>>;
  const textBlock = content.find((candidate) => typeof candidate.text === 'string');
  if (!textBlock) throw new Error('Fixture sample has no text block to revise');
  textBlock.text = `${String(textBlock.text)} [alternate parse]`;
  const contentBytes = new TextEncoder().encode(JSON.stringify(content));
  await writeFile(contentPath, contentBytes);
  const metadataPath = join(data.sourceRoot, variantId, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { sampleId: string; sourceRecordId: string; files: Array<{ path: string; bytes: number; sha256: string }> };
  metadata.sampleId = variantId;
  const contentDescriptor = metadata.files.find((candidate) => candidate.path === 'content.json');
  if (!contentDescriptor) throw new Error('Variant metadata has no content descriptor');
  contentDescriptor.bytes = contentBytes.byteLength;
  contentDescriptor.sha256 = sha256Bytes(contentBytes);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  await writeFile(metadataPath, metadataBytes);
  const variant = { ...original, sampleId: variantId, metadata: { path: `${variantId}/metadata.json`, bytes: metadataBytes.byteLength, sha256: sha256Bytes(metadataBytes) } };
  manifest.samples.push(variant);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  return sha256Bytes(manifestBytes);
}

async function approveManifest(product: Awaited<ReturnType<typeof createProduct>>, data: { sourceRoot: string }, manifestSha256: string): Promise<void> {
  const workspace = await product.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId });
  const operations = ['source.inspect', 'source.register', 'source.publish', 'document.read', 'input.capture', 'document.setStatus', 'workspace.setStatus', 'policy.publish', 'evidence.read'] as const;
  await product.application.publishPolicy(
    { requestId: crypto.randomUUID(), workspaceId: product.workspaceId },
    {
      expectedRevision: workspace.version,
      policy: {
        schemaVersion: 'p0-policy/v1',
        version: workspace.version + 1,
        grants: [{ actorId: workspace.ownerActorId, operations, sourceKeys: ['voxel51'], purposes: ['development', 'regression'] }],
        sources: [{ sourceKey: 'voxel51', rootRef: resolve(data.sourceRoot), manifestSha256, allowedPurposes: ['development', 'regression'], useAuthorizationRef: `workspace:${product.workspaceId}` }],
      },
    },
  );
}

describe('P0 product input lifecycle', () => {
  it('publishes, reads, captures, closes and reopens one real input', async () => {
    const data = await fixture();
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const request = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(request(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, purpose: 'development' });
      expect(inspection.expectedSamples).toBe(1);
      expect(inspection.inspectedSamples).toBe(1);
      expect(inspection.issues).toEqual([]);
      const registerRequestId = crypto.randomUUID();
      const pending = await product.application.registerSourceDocument(request(registerRequestId), { sourceKey: 'voxel51', sampleId: data.sampleId, manifestSha256: data.manifestSha256, purpose: 'development' });
      expect(pending.status).toBe('pending');
      expect(await product.application.findReceipt(request(), { originalRequestId: registerRequestId })).not.toBeNull();
      const publication = await product.application.publishDataset(request(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' });
      expect(publication.documentRefs).toHaveLength(1);
      expect(publication.manifest.kind).toBe('dataset/manifest');
      const projection = await product.application.readDocument(request(), { document: publication.documentRefs[0], manifest: publication.manifest, purpose: 'development' });
      expect(projection.schemaVersion).toBe('p0-input/v1');
      expect(projection.parsed.pages.length).toBeGreaterThan(0);
      expect(projection.evidence.length).toBeGreaterThan(0);
      const captured = await product.application.captureInput(request(), { document: publication.documentRefs[0], manifest: publication.manifest, purpose: 'development' });
      const recaptured = await product.application.readCapturedInput(request(), { projection: captured.projection, purpose: 'development' });
      expect((recaptured as InputProjection).document.documentId).toBe(publication.documentRefs[0].documentId);
      const workspaceId = product.workspaceId;
      const manifest = publication.manifest;
      const ref = publication.documentRefs[0];
      await product.close();

      const reopened = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'open' });
      try {
        expect(reopened.workspaceId).toBe(workspaceId);
        const afterRestart = await reopened.application.readDocument(request(), { document: ref, manifest, purpose: 'development' });
        expect(afterRestart.parsed.contentHash).toBe(projection.parsed.contentHash);
        expect(afterRestart.document.version).toBe(ref.version);
      } finally { await reopened.close(); }
    } finally {
      // The explicit close above is idempotent; this also cleans up when an
      // assertion or an input failure occurs before the restart step.
      await product.close();
    }
  }, 30_000);

  it('replays the same publication receipt and rejects a different command under one request ID', async () => {
    const data = await fixture();
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const requestId = crypto.randomUUID();
      const req = { requestId, workspaceId: product.workspaceId };
      const input = { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' as const };
      const first = await product.application.publishDataset(req, input);
      const duplicate = await product.application.publishDataset({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId }, input);
      expect(duplicate.documentRefs).toEqual(first.documentRefs);
      const replay = await product.application.publishDataset(req, input);
      expect(replay.manifest).toEqual(first.manifest);
      expect(replay.documentRefs).toEqual(first.documentRefs);
      await expect(product.application.publishDataset(req, { ...input, purpose: 'regression' }))
        .rejects.toMatchObject({ descriptor: { code: 'IDEMPOTENCY_CONFLICT' } });
    } finally { await product.close(); }
  }, 30_000);

  it('recovers a committed publication when the caller loses the response across restart', async () => {
    const data = await fixture();
    const instanceRoot = join(data.root, 'instance');
    const requestId = crypto.randomUUID();
    const first = await createProduct({ instanceRoot, mode: 'create' });
    const input = { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' as const };
    const expected = await first.application.publishDataset({ requestId, workspaceId: first.workspaceId }, input);
    const workspaceId = first.workspaceId;
    await first.close();

    const reopened = await createProduct({ instanceRoot, mode: 'open' });
    try {
      const receipt = await reopened.application.findReceipt({ requestId: crypto.randomUUID(), workspaceId }, { originalRequestId: requestId });
      expect(receipt?.operation).toBe('source.publish');
      const replay = await reopened.application.publishDataset({ requestId, workspaceId }, input);
      expect(replay.manifest).toEqual(expected.manifest);
      expect(replay.documentRefs).toEqual(expected.documentRefs);
    } finally { await reopened.close(); }
  }, 30_000);

  it('keeps the previous publication readable when file finalization is interrupted', async () => {
    const data = await fixture();
    const instanceRoot = join(data.root, 'instance');
    const first = await createProduct({ instanceRoot, mode: 'create' });
    const oldInput = { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' as const };
    const oldPublication = await first.application.publishDataset({ requestId: crypto.randomUUID(), workspaceId: first.workspaceId }, oldInput);
    await first.close();
    const nextManifestSha256 = await makeSecondParseVersion(data);
    let fail = false;
    const second = await createProduct({ instanceRoot, mode: 'open' }, { fileFault: (point) => { if (fail && point === 'before-content-finalize') throw new Error('injected before-content-finalize'); } });
    try {
      await approveManifest(second, data, nextManifestSha256);
      fail = true;
      const requestId = crypto.randomUUID();
      const nextInput = { sourceKey: 'voxel51', manifestSha256: nextManifestSha256, selection: [], purpose: 'development' as const };
      await expect(second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput)).rejects.toThrow('injected before-content-finalize');
      fail = false;
      expect(await second.application.findReceipt({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { originalRequestId: requestId })).toBeNull();
      const retry = await second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput);
      expect(retry.documentRefs).toHaveLength(1);
      await expect(second.application.readDocument({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { document: oldPublication.documentRefs[0], manifest: oldPublication.manifest, purpose: 'development' })).resolves.toMatchObject({ document: oldPublication.documentRefs[0] });
    } finally { await second.close(); }
  }, 30_000);

  it('rolls back the publication facts when the Application commit fails', async () => {
    const data = await fixture();
    const instanceRoot = join(data.root, 'instance');
    const first = await createProduct({ instanceRoot, mode: 'create' });
    const oldInput = { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' as const };
    const oldPublication = await first.application.publishDataset({ requestId: crypto.randomUUID(), workspaceId: first.workspaceId }, oldInput);
    await first.close();
    const nextManifestSha256 = await makeSecondParseVersion(data);
    let fail = false;
    const second = await createProduct({ instanceRoot, mode: 'open' }, { databaseFault: (point) => { if (fail && point === 'before-commit') throw new Error('injected before-commit'); } });
    try {
      await approveManifest(second, data, nextManifestSha256);
      fail = true;
      const requestId = crypto.randomUUID();
      const nextInput = { sourceKey: 'voxel51', manifestSha256: nextManifestSha256, selection: [], purpose: 'development' as const };
      await expect(second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput)).rejects.toThrow('injected before-commit');
      fail = false;
      expect(await second.application.findReceipt({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { originalRequestId: requestId })).toBeNull();
      const retry = await second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput);
      expect(retry.documentRefs).toHaveLength(1);
      await expect(second.application.readDocument({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { document: oldPublication.documentRefs[0], manifest: oldPublication.manifest, purpose: 'development' })).resolves.toMatchObject({ document: oldPublication.documentRefs[0] });
    } finally { await second.close(); }
  }, 30_000);

  it('rolls back the publication facts when the command audit insert fails', async () => {
    const data = await fixture();
    const instanceRoot = join(data.root, 'instance');
    const first = await createProduct({ instanceRoot, mode: 'create' });
    const oldInput = { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' as const };
    const oldPublication = await first.application.publishDataset({ requestId: crypto.randomUUID(), workspaceId: first.workspaceId }, oldInput);
    await first.close();
    const nextManifestSha256 = await makeSecondParseVersion(data);
    let fail = false;
    const second = await createProduct({ instanceRoot, mode: 'open' }, { databaseFault: (point) => { if (fail && point === 'before-audit-insert') throw new Error('injected before-audit-insert'); } });
    try {
      await approveManifest(second, data, nextManifestSha256);
      fail = true;
      const requestId = crypto.randomUUID();
      const nextInput = { sourceKey: 'voxel51', manifestSha256: nextManifestSha256, selection: [], purpose: 'development' as const };
      await expect(second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput)).rejects.toThrow('injected before-audit-insert');
      fail = false;
      expect(await second.application.findReceipt({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { originalRequestId: requestId })).toBeNull();
      const retry = await second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput);
      expect(retry.documentRefs).toHaveLength(1);
      await expect(second.application.readDocument({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { document: oldPublication.documentRefs[0], manifest: oldPublication.manifest, purpose: 'development' })).resolves.toMatchObject({ document: oldPublication.documentRefs[0] });
    } finally { await second.close(); }
  }, 30_000);

  it('recovers a committed publication when the response is lost after commit', async () => {
    const data = await fixture();
    const instanceRoot = join(data.root, 'instance');
    const first = await createProduct({ instanceRoot, mode: 'create' });
    const oldInput = { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' as const };
    const oldPublication = await first.application.publishDataset({ requestId: crypto.randomUUID(), workspaceId: first.workspaceId }, oldInput);
    await first.close();
    const nextManifestSha256 = await makeSecondParseVersion(data);
    let fail = false;
    const second = await createProduct({ instanceRoot, mode: 'open' }, { applicationFault: (point, operation) => { if (fail && point === 'before-response' && operation === 'source.publish') throw new Error('injected before-response'); } });
    try {
      await approveManifest(second, data, nextManifestSha256);
      fail = true;
      const requestId = crypto.randomUUID();
      const nextInput = { sourceKey: 'voxel51', manifestSha256: nextManifestSha256, selection: [], purpose: 'development' as const };
      await expect(second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput)).rejects.toThrow('injected before-response');
      fail = false;
      const receipt = await second.application.findReceipt({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { originalRequestId: requestId });
      expect(receipt?.operation).toBe('source.publish');
      const replay = await second.application.publishDataset({ requestId, workspaceId: second.workspaceId }, nextInput);
      expect(replay.documentRefs).toHaveLength(1);
      await expect(second.application.readDocument({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId }, { document: oldPublication.documentRefs[0], manifest: oldPublication.manifest, purpose: 'development' })).resolves.toMatchObject({ document: oldPublication.documentRefs[0] });
    } finally { await second.close(); }
  }, 30_000);

  it('enforces current workspace and document state before returning content', async () => {
    const data = await fixture();
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const publication = await product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' });
      const workspace = await product.application.setWorkspaceStatus(req(), { expectedStatus: 'active', expectedRevision: 1, targetStatus: 'paused', reason: 'pause for state test' });
      expect(workspace.status).toBe('paused');
      await expect(product.application.readDocument(req(), { document: publication.documentRefs[0], manifest: publication.manifest, purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'WORKSPACE_NOT_ACTIVE' } });
      const withdrawn = await product.application.setDocumentStatus(req(), { document: publication.documentRefs[0], change: { expectedStatus: 'available', expectedRevision: 2, targetStatus: 'withdrawn', reason: 'withdrawn for state test' } });
      expect(withdrawn.status).toBe('withdrawn');
      await product.application.setWorkspaceStatus(req(), { expectedStatus: 'paused', expectedRevision: 2, targetStatus: 'active', reason: 'resume for state test' });
      await expect(product.application.readDocument(req(), { document: publication.documentRefs[0], manifest: publication.manifest, purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'DOCUMENT_WITHDRAWN' } });
      await expect(product.application.setDocumentStatus(req(), { document: publication.documentRefs[0], change: { expectedStatus: 'withdrawn', expectedRevision: 3, targetStatus: 'available', reason: 'illegal recovery' } }))
        .rejects.toMatchObject({ descriptor: { code: 'STATE_TRANSITION_INVALID' } });
    } finally { await product.close(); }
  }, 30_000);

  it('rejects stale workspace and document revisions instead of applying an old command', async () => {
    const data = await fixture();
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const publication = await product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' });
      await expect(product.application.setWorkspaceStatus(req(), { expectedStatus: 'active', expectedRevision: 0, targetStatus: 'paused', reason: 'stale workspace command' }))
        .rejects.toMatchObject({ descriptor: { code: 'STALE_STATE' } });
      await expect(product.application.setDocumentStatus(req(), { document: publication.documentRefs[0], change: { expectedStatus: 'available', expectedRevision: 1, targetStatus: 'unavailable', reason: 'stale document command' } }))
        .rejects.toMatchObject({ descriptor: { code: 'STALE_STATE' } });
    } finally { await product.close(); }
  }, 30_000);

  it('rejects a manifest owned by another workspace before reading document bytes', async () => {
    const data = await fixture();
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const publication = await product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' });
      const foreignManifest = { ...publication.manifest, workspaceId: 'w_foreign_workspace' };
      await expect(product.application.readDocument(req(), { document: publication.documentRefs[0], manifest: foreignManifest, purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'OWNERSHIP_MISMATCH' } });
    } finally { await product.close(); }
  }, 30_000);

  it('enforces operation and purpose grants from the current workspace policy', async () => {
    const data = await fixture();
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const workspace = await product.application.getWorkspace(req());
      const baseSource = { sourceKey: 'voxel51', rootRef: resolve(data.sourceRoot), manifestSha256: data.manifestSha256, allowedPurposes: ['development', 'regression'] as const, useAuthorizationRef: `workspace:${product.workspaceId}` };
      const noInspect = await product.application.publishPolicy(req(), {
        expectedRevision: workspace.version,
        policy: { schemaVersion: 'p0-policy/v1', version: workspace.version + 1, grants: [{ actorId: workspace.ownerActorId, operations: ['policy.publish', 'evidence.read'], sourceKeys: ['voxel51'], purposes: ['development', 'regression'] }], sources: [baseSource] },
      });
      await expect(product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'OPERATION_DENIED' } });
      const onlyDevelopment = await product.application.publishPolicy(req(), {
        expectedRevision: noInspect.version,
        policy: { schemaVersion: 'p0-policy/v1', version: noInspect.version + 1, grants: [{ actorId: workspace.ownerActorId, operations: ['source.inspect', 'policy.publish', 'evidence.read'], sourceKeys: ['voxel51'], purposes: ['development'] }], sources: [{ ...baseSource, allowedPurposes: ['development'] }] },
      });
      expect(onlyDevelopment.version).toBe(noInspect.version + 1);
      await expect(product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, purpose: 'regression' }))
        .rejects.toMatchObject({ descriptor: { code: 'OPERATION_DENIED' } });
    } finally { await product.close(); }
  }, 30_000);

  it('only restores unavailable content after re-reading every stored artifact', async () => {
    const data = await fixture();
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const publication = await product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' });
      const unavailable = await product.application.setDocumentStatus(req(), { document: publication.documentRefs[0], change: { expectedStatus: 'available', expectedRevision: 2, targetStatus: 'unavailable', reason: 'integrity maintenance' } });
      expect(unavailable.status).toBe('unavailable');
      const recovered = await product.application.setDocumentStatus(req(), { document: publication.documentRefs[0], change: { expectedStatus: 'unavailable', expectedRevision: 3, targetStatus: 'available', reason: 'integrity reverified' } });
      expect(recovered.status).toBe('available');
      const read = await product.application.readDocument(req(), { document: recovered.ref, manifest: publication.manifest, purpose: 'development' });
      expect(read.parsed.integrity.status).toBe('verified');
    } finally { await product.close(); }
  }, 30_000);

  it('maps all text-like parser blocks from a real prepared sample', async () => {
    const data = await fixture('001452');
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const publication = await product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' });
      const projection = await product.application.readDocument(req(), { document: publication.documentRefs[0], manifest: publication.manifest, purpose: 'development' });
      const blocks = projection.parsed.pages.flatMap((page) => page.blocks);
      expect(blocks.filter((block) => block.kind === 'text')).toHaveLength(6);
      expect(blocks.filter((block) => block.kind === 'table')).toHaveLength(2);
      expect(blocks.every((block) => block.kind === 'text' ? Boolean(block.text) : Boolean(block.tableHtml))).toBe(true);
    } finally { await product.close(); }
  }, 30_000);

  it('requires an explicit selection when one original has different parses', async () => {
    const data = await fixture();
    const manifestSha256 = await addParseVariant(data);
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256, purpose: 'development' });
      expect(inspection.expectedSamples).toBe(2);
      const variant = inspection.variants.find((candidate) => candidate.originalSha256 === data.originalSha256);
      expect(variant?.parseHashes).toHaveLength(2);
      const input = { sourceKey: 'voxel51', manifestSha256, selection: [], purpose: 'development' as const };
      await expect(product.application.publishDataset(req(), input)).rejects.toMatchObject({ descriptor: { code: 'PARSE_SELECTION_REQUIRED' } });
      const publication = await product.application.publishDataset(req(), { ...input, selection: [{ originalSha256: data.originalSha256, selectedParseHash: variant!.parseHashes[0], reason: 'fixed test selection', evidenceRef: 'test:parse-variant' }] });
      expect(publication.documentRefs).toHaveLength(1);
      const manifestBytes = await product.application.readEvidence(req(), { artifact: publication.manifest });
      const published = JSON.parse(new TextDecoder().decode(manifestBytes)) as { documents: Array<{ aliases: string[]; excluded: Array<{ sampleId: string }> }> };
      expect(published.documents[0].excluded).toHaveLength(1);
      expect(published.documents[0].aliases).toHaveLength(0);
    } finally { await product.close(); }
  }, 30_000);

  it('does not publish a source copy with a missing required file', async () => {
    const data = await fixture();
    await rm(join(data.sourceRoot, data.sampleId, 'pages.json'));
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, purpose: 'development' });
      expect(inspection.issues.some((issue) => issue.code === 'FILE_MISSING')).toBe(true);
      await expect(product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'INPUT_INCOMPLETE' } });
    } finally { await product.close(); }
  }, 30_000);

  it('reports a source descriptor digest mismatch without accepting changed bytes', async () => {
    const data = await fixture();
    const contentPath = join(data.sourceRoot, data.sampleId, 'content.json');
    await writeFile(contentPath, `${await readFile(contentPath, 'utf8')}\nchanged-without-manifest-update`, 'utf8');
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, purpose: 'development' });
      expect(inspection.issues.some((issue) => issue.code === 'FILE_DIGEST_MISMATCH')).toBe(true);
      await expect(product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.manifestSha256, selection: [], purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'INPUT_INCOMPLETE' } });
    } finally { await product.close(); }
  }, 30_000);

  it('rejects an empty parsed content file while preserving valid zero-valued fields', async () => {
    const data = await fixture();
    const manifestSha256 = await rewriteSourceFile(data, 'content.json', () => new TextEncoder().encode('[]'));
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256, purpose: 'development' });
      expect(inspection.issues.some((issue) => issue.code === 'INPUT_INCOMPLETE')).toBe(true);
      await expect(product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256, selection: [], purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'INPUT_INCOMPLETE' } });
    } finally { await product.close(); }
  }, 30_000);

  it('rejects a parse pair whose page block count disagrees with content', async () => {
    const data = await fixture();
    const manifestSha256 = await rewriteSourceFile(data, 'pages.json', (bytes) => {
      const pages = JSON.parse(new TextDecoder().decode(bytes)) as Array<Record<string, unknown>>;
      if (pages.length === 0) throw new Error('Fixture sample has no pages');
      const blockCount = typeof pages[0].blockCount === 'number' ? pages[0].blockCount : 0;
      pages[0] = { ...pages[0], blockCount: blockCount + 1 };
      return new TextEncoder().encode(JSON.stringify(pages));
    });
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256, purpose: 'development' });
      expect(inspection.issues.some((issue) => issue.code === 'INPUT_PAIR_MISMATCH')).toBe(true);
      await expect(product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256, selection: [], purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'INPUT_INCOMPLETE' } });
    } finally { await product.close(); }
  }, 30_000);

  it('rejects unknown parser blocks before making a document available', async () => {
    const data = await fixture();
    const manifestSha256 = await rewriteSourceFile(data, 'content.json', (bytes) => {
      const content = JSON.parse(new TextDecoder().decode(bytes)) as Array<Record<string, unknown>>;
      content[0] = { ...content[0], type: 'unknown_block' };
      return new TextEncoder().encode(JSON.stringify(content));
    });
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256, purpose: 'development' });
      expect(inspection.issues.some((issue) => issue.code === 'PARSE_SCHEMA_INVALID')).toBe(true);
      await expect(product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256, selection: [], purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'INPUT_INCOMPLETE' } });
    } finally { await product.close(); }
  }, 30_000);

  it('rejects a parsed image reference outside the approved file set', async () => {
    const data = await fixture();
    const manifestSha256 = await rewriteSourceFile(data, 'content.json', (bytes) => {
      const content = JSON.parse(new TextDecoder().decode(bytes)) as Array<Record<string, unknown>>;
      const block = content.find((candidate) => typeof candidate.img_path === 'string');
      if (!block) throw new Error('Fixture sample has no image reference to mutate');
      block.img_path = 'assets/images/not-approved.jpg';
      return new TextEncoder().encode(JSON.stringify(content));
    });
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256, purpose: 'development' });
      expect(inspection.issues.some((issue) => issue.code === 'INPUT_PAIR_MISMATCH')).toBe(true);
      await expect(product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256, selection: [], purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'INPUT_INCOMPLETE' } });
    } finally { await product.close(); }
  }, 30_000);

  it('rejects a structurally truncated image even when its descriptor is updated', async () => {
    const data = await fixture();
    const metadata = JSON.parse(await readFile(join(data.sourceRoot, data.sampleId, 'metadata.json'), 'utf8')) as { files: Array<{ path: string }> };
    const image = metadata.files.find((candidate) => candidate.path.startsWith('assets/images/'));
    if (!image) throw new Error('Fixture sample has no image artifact to corrupt');
    const manifestSha256 = await rewriteSourceFile(data, image.path, (bytes) => bytes.slice(0, Math.max(0, bytes.byteLength - 2)));
    const product = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    try {
      const req = (requestId = crypto.randomUUID()) => ({ requestId, workspaceId: product.workspaceId });
      const inspection = await product.application.inspectSource(req(), { sourceKey: 'voxel51', manifestSha256, purpose: 'development' });
      expect(inspection.issues.some((issue) => issue.code === 'IMAGE_UNREADABLE')).toBe(true);
      await expect(product.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256, selection: [], purpose: 'development' }))
        .rejects.toMatchObject({ descriptor: { code: 'INPUT_INCOMPLETE' } });
    } finally { await product.close(); }
  }, 30_000);
});
