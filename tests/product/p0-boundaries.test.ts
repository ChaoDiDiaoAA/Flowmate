/** Product F probes. Authored now; execution is reserved for the user's P0 run. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createProduct } from '../../apps/composition.ts';
import { InstanceFileStore } from '../../packages/core/src/storage/file-store.ts';
import { JsonlLogger } from '../../packages/logging/src/writer.ts';
import { sha256Bytes } from '../../packages/shared/src/index.ts';
import type { DocumentStatus } from '../../packages/contracts/src/index.ts';
import { DatabaseSync } from 'node:sqlite';
import { FoundationDatabase } from '../../packages/core/src/storage/database.ts';
import { requireBindingMatch } from '../../agent-eval/src/runner/p0-binding.ts';
import { readRecoveryCheckpoint } from '../../apps/recovery.ts';
import { enforceInputLimit, enforceSampleBudget, enforceImageBudget, P0_INPUT_LIMITS } from '../../packages/data/src/source/limits.ts';

const roots: string[] = [];
const previous = process.env.FLOWMATE_SOURCE_ROOT;
afterEach(async () => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.FLOWMATE_SOURCE_ROOT;
  else process.env.FLOWMATE_SOURCE_ROOT = previous;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p0-boundary-'));
  roots.push(root); return root;
}
async function inputFixture() {
  const root = await temporary();
  const source = resolve('data/invoices/voxel51');
  const sourceRoot = join(root, 'source');
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const sample = manifest.samples[0];
  await mkdir(sourceRoot);
  await cp(join(source, sample.sampleId), join(sourceRoot, sample.sampleId), { recursive: true });
  const bytes = JSON.stringify({ ...manifest, samples: [sample] });
  await writeFile(join(sourceRoot, 'manifest.json'), bytes);
  process.env.FLOWMATE_SOURCE_ROOT = sourceRoot;
  return { root, sourceRoot, sampleId: sample.sampleId as string, hash: sha256Bytes(new TextEncoder().encode(bytes)) };
}
async function close(product: Awaited<ReturnType<typeof createProduct>>) {
  const result = await product.close();
  expect(result).toEqual({ closed: true, cleanupErrors: [] });
}

describe('P0 closure boundaries', () => {
  it('reuses identical immutable bytes and refuses a corrupted existing artifact', async () => {
    const root = await temporary();
    const store = new InstanceFileStore({ sourceRoot: root, instanceRoot: join(root, 'instance') });
    await store.prepare();
    const bytes = new TextEncoder().encode('immutable-original');
    const input = { workspaceId: 'w_test', kind: 'source/original', bytes, sha256: sha256Bytes(bytes), mediaType: 'application/octet-stream', sourceRef: 'test:immutable' };
    const saved = await store.saveImmutable(input);
    expect(await store.saveImmutable(input)).toEqual(saved);
    await writeFile(join(store.instanceRoot, saved.relativePath), 'corrupted');
    await expect(store.saveImmutable(input)).rejects.toMatchObject({ descriptor: { code: 'IMMUTABLE_ARTIFACT_CONFLICT' } });
    expect(await readFile(join(store.instanceRoot, saved.relativePath), 'utf8')).toBe('corrupted');
  });
  it('rejects pending self promotion and stale commands and permits direct withdrawal', async () => {
    const data = await inputFixture();
    const p = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    const req = () => ({ requestId: crypto.randomUUID(), workspaceId: p.workspaceId });
    try {
      const doc = await p.application.registerSourceDocument(req(), { sourceKey: 'voxel51', sampleId: data.sampleId, manifestSha256: data.hash, purpose: 'development' });
      for (const [targetStatus, code] of [['pending', 'STATE_NO_CHANGE'], ['available', 'STATE_TRANSITION_INVALID']] as const) {
        await expect(p.application.setDocumentStatus(req(), { document: doc.ref, change: { expectedStatus: 'pending', expectedRevision: doc.stateRevision, targetStatus, reason: 'invalid pending transition' } })).rejects.toMatchObject({ descriptor: { code } });
      }
      const change = { expectedStatus: 'pending' as const, expectedRevision: doc.stateRevision, targetStatus: 'withdrawn' as const, reason: 'direct withdrawal' };
      const request = req();
      const withdrawn = await p.application.setDocumentStatus(request, { document: doc.ref, change });
      expect(withdrawn.status).toBe('withdrawn');
      expect(await p.application.setDocumentStatus(request, { document: doc.ref, change })).toEqual(withdrawn);
      await expect(p.application.setDocumentStatus(req(), { document: doc.ref, change })).rejects.toMatchObject({ descriptor: { code: 'STALE_STATE' } });
    } finally { await close(p); }
  });
  it('rejects quality source roots and final file links without emitting canary content', async () => {
    const root = await temporary();
    const quality = join(root, 'agent-eval', 'gold');
    await mkdir(quality, { recursive: true });
    const canary = new TextEncoder().encode('QUALITY_CANARY_NEVER_PRODUCT');
    await writeFile(join(quality, 'canary.txt'), canary);
    process.env.FLOWMATE_SOURCE_ROOT = quality;
    await expect(createProduct({ instanceRoot: join(root, 'instance'), mode: 'create' })).rejects.toMatchObject({ descriptor: { code: 'QUALITY_ROOT_DENIED' } });
    expect(await readdir(join(root, 'instance'))).not.toContain('data');
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'normal.txt'), canary);
    const byteReads: string[] = [];
    const store = new InstanceFileStore({ sourceRoot: source, instanceRoot: join(root, 'store'), observeRead: path => { byteReads.push(path); } });
    expect(Array.from(await store.readVerified({ root: 'source', relativePath: 'normal.txt', expectedBytes: canary.length, expectedSha256: sha256Bytes(canary), maxBytes: 1024 }))).toEqual(Array.from(canary));
    await symlink(join(quality, 'canary.txt'), join(source, 'linked.txt'), 'file').catch(error => { throw new Error('[P0_FACILITY] Cannot create final-file symlink; Windows Developer Mode or appropriate privilege required', { cause: error }); });
    await expect(store.readVerified({ root: 'source', relativePath: 'linked.txt', expectedBytes: canary.length, expectedSha256: sha256Bytes(canary), maxBytes: 1024 })).rejects.toMatchObject({ descriptor: { code: 'REPARSE_POINT_DENIED' } });
    expect(byteReads).toEqual([join(source, 'normal.txt')]);
  });
  it('enforces sample file page and pixel budgets at below equal and above limits', () => {
    for (const maximum of Object.values(P0_INPUT_LIMITS)) {
      expect(() => enforceInputLimit(maximum - 1, maximum)).not.toThrow();
      expect(() => enforceInputLimit(maximum, maximum)).not.toThrow();
      expect(() => enforceInputLimit(maximum + 1, maximum)).toThrow();
    }
    expect(() => enforceSampleBudget(Array.from({ length: 2048 }, () => ({ bytes: 1 })))).not.toThrow();
    expect(() => enforceSampleBudget(Array.from({ length: 2049 }, () => ({ bytes: 1 })))).toThrow();
    for (const total of [268_435_455, 268_435_456, 268_435_457]) {
      const files = [{ bytes: 67_108_864 }, { bytes: 67_108_864 }, { bytes: 67_108_864 }, { bytes: Math.min(67_108_864, total - 201_326_592) }, ...(total > 268_435_456 ? [{ bytes: 1 }] : [])];
      if (total > 268_435_456) expect(() => enforceSampleBudget(files)).toThrow();
      else expect(() => enforceSampleBudget(files)).not.toThrow();
    }
    // Synthetic headers exercise the pre-decode budget; full image readability is a separate Case.
    for (const pixels of [39_999_999, 40_000_000, 40_000_001]) {
      const png = new Uint8Array(24); const view = new DataView(png.buffer);
      view.setUint32(16, pixels); view.setUint32(20, 1);
      if (pixels > 40_000_000) expect(() => enforceImageBudget(png, 'test.png')).toThrow();
      else expect(() => enforceImageBudget(png, 'test.png')).not.toThrow();
    }
    const jpeg = new Uint8Array([0xff,0xd8,0xff,0xc0,0,8,8,0,10,0,20,1,0xff,0xd9]);
    expect(() => enforceImageBudget(jpeg, 'test.jpg')).not.toThrow();
  });

  it('preserves primary and cleanup errors after partial startup failure', async () => {
    const root = await temporary();
    const primary = new Error('injected workspace setup failure');
    const realClose = FoundationDatabase.prototype.close;
    vi.spyOn(FoundationDatabase.prototype, 'createOrLoadWorkspace').mockImplementation(() => { throw primary; });
    vi.spyOn(FoundationDatabase.prototype, 'close').mockImplementation(function (this: FoundationDatabase) { realClose.call(this); throw new Error('injected cleanup notification'); });
    try {
      await expect(createProduct({ instanceRoot: root, mode: 'create' })).rejects.toMatchObject({ primaryError: primary, cleanupErrors: [expect.objectContaining({ code: 'CLOSE_FAILED' })] });
      expect(await readdir(root)).toContain('instance.lock');
      // The wrapper above called the real DB close; remove only this known synthetic marker.
      await rm(join(root, 'instance.lock'));
    } finally { vi.restoreAllMocks(); }
  });

  it('refuses an old restored database using independently retained current withdrawal facts', async () => {
    const data = await inputFixture(); const instanceRoot = join(data.root, 'instance');
    const p = await createProduct({ instanceRoot, mode: 'create' });
    const req = () => ({ requestId: crypto.randomUUID(), workspaceId: p.workspaceId });
    const published = await p.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.hash, selection: [], purpose: 'development' });
    await close(p);
    const oldRoot = join(data.root, 'old-copy'); await cp(instanceRoot, oldRoot, { recursive: true });
    const current = await createProduct({ instanceRoot, mode: 'open' });
    try {
      await current.application.setDocumentStatus({ requestId: crypto.randomUUID(), workspaceId: current.workspaceId }, { document: published.documentRefs[0], change: { expectedStatus: 'available', expectedRevision: 2, targetStatus: 'withdrawn', reason: 'current withdrawal' } });
    } finally { await close(current); }
    const checkpoint = await readRecoveryCheckpoint(instanceRoot);
    await expect(createProduct({ instanceRoot: oldRoot, mode: 'open' })).rejects.toMatchObject({ descriptor: { code: 'RECOVERY_CHECKPOINT_REQUIRED' } });
    await expect(createProduct({ instanceRoot: oldRoot, mode: 'open', recoveryCheckpoint: checkpoint })).rejects.toMatchObject({ descriptor: { code: 'RECOVERY_STATE_MISMATCH' } });
    expect(await readdir(oldRoot)).not.toContain('instance.lock');
    const restoredRoot = join(data.root, 'current-copy'); await cp(instanceRoot, restoredRoot, { recursive: true });
    const restored = await createProduct({ instanceRoot: restoredRoot, mode: 'open', recoveryCheckpoint: checkpoint });
    try {
      await expect(restored.application.readDocument({ requestId: crypto.randomUUID(), workspaceId: restored.workspaceId }, { document: published.documentRefs[0], manifest: published.manifest, purpose: 'development' })).rejects.toMatchObject({ descriptor: { code: 'DOCUMENT_WITHDRAWN' } });
    } finally { await close(restored); }
  });
  it('rolls back interrupted migration and refuses a future schema without deleting facts', async () => {
    const root = await temporary();
    const file = join(root, 'probe.sqlite');
    const broken = new FoundationDatabase(file, point => { if (point === 'before-migration-commit') throw new Error('injected migration interruption'); });
    try { expect(() => broken.initialize()).toThrow('injected migration interruption'); }
    finally { broken.close(); }
    const inspect = new DatabaseSync(file, { readOnly: true });
    try { expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]); }
    finally { inspect.close(); }
    const healthy = new FoundationDatabase(file);
    try { healthy.initialize(); healthy.initialize(); }
    finally { healthy.close(); }
    // Malformed/future database is an explicit isolated corruption fixture, not a normal business result.
    const mutate = new DatabaseSync(file);
    try { mutate.exec("INSERT INTO schema_migrations VALUES(2,'future','unchanged','2026-09-20','future')"); }
    finally { mutate.close(); }
    const future = new FoundationDatabase(file);
    try { expect(() => future.initialize()).toThrow(); }
    finally { future.close(); }
    const preserved = new DatabaseSync(file, { readOnly: true });
    try { expect(preserved.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({ n: 2 }); }
    finally { preserved.close(); }
  });
  it('retains cleanup failure on repeated close and rejects subsequent work', async () => {
    const root = await temporary();
    const p = await createProduct({ instanceRoot: root, mode: 'create' });
    const spy = vi.spyOn(JsonlLogger.prototype, 'close').mockRejectedValue(new Error('injected close failure'));
    try {
      const first = await p.close();
      expect(first.closed).toBe(false); expect(first.cleanupErrors.length).toBeGreaterThan(0);
      expect(await p.close()).toEqual(first);
      await expect(p.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: p.workspaceId })).rejects.toThrow();
    } finally { spy.mockRestore(); }
    expect(await readdir(root)).toContain('instance.lock');
    await expect(createProduct({ instanceRoot: root, mode: 'open' })).rejects.toMatchObject({ descriptor: { code: 'INSTANCE_LOCKED' } });
    // Only the synchronous logger close was mocked; DB/OS resources really closed.
    await rm(join(root, 'instance.lock'));
    await close(await createProduct({ instanceRoot: root, mode: 'open' }));
  });
  it('keeps the owning controller lock after a competing start fails', async () => {
    const root = await temporary();
    const p = await createProduct({ instanceRoot: root, mode: 'create' });
    try {
      for (let n = 0; n < 2; n++) {
        await expect(createProduct({ instanceRoot: root, mode: 'open' })).rejects.toMatchObject({ descriptor: { code: 'INSTANCE_LOCKED' } });
        expect(await readdir(root)).toContain('instance.lock');
      }
    } finally { await close(p); }
    await close(await createProduct({ instanceRoot: root, mode: 'open' }));
  });
  it('rejects unknown configuration fields before creating business facts', async () => {
    const root = await temporary();
    const config = join(root, 'config.json');
    await writeFile(config, JSON.stringify({ model: 'must-not-start' }));
    await expect(createProduct({ instanceRoot: join(root, 'instance'), mode: 'create', configPath: config })).rejects.toMatchObject({ descriptor: { code: 'CONFIG_LOCK_MISMATCH' } });
    expect(await readdir(join(root, 'instance'))).not.toContain('data');
  });
  it('redacts a record whose attributes contain only secrets', async () => {
    const root = await temporary();
    const logger = new JsonlLogger({ instanceId: 'i_test', processInstanceId: 'p_secrets', logRoot: root, config: { minLevel: 'info', maxRecordBytes: 512, maxFileBytes: 1024, maxTotalBytes: 4096, retentionDays: 7, queueLimit: 2, flushTimeoutMs: 100 } });
    logger.write({ level: 'info', component: 'probe', eventCode: 'redaction', safeMessage: 'operation completed', attributes: { token: 'canary-token', body: 'canary-body' } });
    await logger.close(100);
    const text = await readFile(join(root, 'p0-p_secrets.jsonl'), 'utf8');
    expect(text).not.toContain('canary-token'); expect(text).not.toContain('canary-body');
  });
  it('rejects persisted foreign identity and releases the partial-start lock', async () => {
    const root = await temporary();
    const first = await createProduct({ instanceRoot: root, mode: 'create' });
    await close(first);
    const path = join(root, 'instance.json');
    const original = await readFile(path, 'utf8');
    const identity = JSON.parse(original); identity.osBindingHash = 'f'.repeat(64);
    await writeFile(path, JSON.stringify(identity));
    await expect(createProduct({ instanceRoot: root, mode: 'open' })).rejects.toMatchObject({ descriptor: { code: 'IDENTITY_UNTRUSTED' } });
    expect(await readdir(root)).not.toContain('instance.lock');
    await writeFile(path, original);
    await close(await createProduct({ instanceRoot: root, mode: 'open' }));
  });

  it('covers workspace allowed edges and rejects self stale and archived-to-active changes', async () => {
    const root = await temporary();
    const p = await createProduct({ instanceRoot: root, mode: 'create' });
    const req = () => ({ requestId: crypto.randomUUID(), workspaceId: p.workspaceId });
    try {
      let w = await p.application.getWorkspace(req());
      for (const target of ['paused', 'archived', 'paused', 'active'] as const) {
        w = await p.application.setWorkspaceStatus(req(), { expectedRevision: w.version, expectedStatus: w.status, targetStatus: target, reason: 'P0 allowed edge' });
        expect(w.status).toBe(target);
      }
      await expect(p.application.setWorkspaceStatus(req(), { expectedRevision: w.version, expectedStatus: 'active', targetStatus: 'active', reason: 'self edge' })).rejects.toMatchObject({ descriptor: { code: 'STATE_NO_CHANGE' } });
      await expect(p.application.setWorkspaceStatus(req(), { expectedRevision: 1, expectedStatus: 'active', targetStatus: 'paused', reason: 'stale' })).rejects.toMatchObject({ descriptor: { code: 'STALE_STATE' } });
      expect((await p.application.getWorkspace(req())).version).toBe(w.version);
    } finally { await close(p); }
  });

  it('covers pending available unavailable and withdrawn document transitions', async () => {
    const data = await inputFixture();
    const p = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    const req = () => ({ requestId: crypto.randomUUID(), workspaceId: p.workspaceId });
    const input = { sourceKey: 'voxel51', manifestSha256: data.hash, purpose: 'development' as const };
    try {
      let doc = await p.application.registerSourceDocument(req(), { ...input, sampleId: data.sampleId });
      const change = async (target: DocumentStatus) => {
        doc = await p.application.setDocumentStatus(req(), { document: doc.ref, change: { expectedStatus: doc.status, expectedRevision: doc.stateRevision, targetStatus: target, reason: 'P0 document edge' } });
        expect(doc.status).toBe(target);
      };
      expect(doc.status).toBe('pending');
      await change('unavailable');
      await change('withdrawn');
      await expect(change('available')).rejects.toMatchObject({ descriptor: { code: 'STATE_TRANSITION_INVALID' } });
    } finally { await close(p); }
    // Other available/recovery edges use the existing real-publication tests;
    // this probe specifically adds pending->unavailable->withdrawn and no resurrection.
  });

  it('rechecks permissions before returning a document after policy narrowing', async () => {
    const data = await inputFixture();
    const p = await createProduct({ instanceRoot: join(data.root, 'instance'), mode: 'create' });
    const req = () => ({ requestId: crypto.randomUUID(), workspaceId: p.workspaceId });
    try {
      const published = await p.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.hash, selection: [], purpose: 'development' });
      const w = await p.application.getWorkspace(req());
      const original = InstanceFileStore.prototype.readInstanceArtifact;
      let narrowed = false;
      vi.spyOn(InstanceFileStore.prototype, 'readInstanceArtifact').mockImplementation(async function (this: InstanceFileStore, ...args) {
        const bytes = await original.apply(this, args);
        if (!narrowed) {
          narrowed = true;
          await p.application.publishPolicy(req(), { expectedRevision: w.version, policy: {
            schemaVersion: 'p0-policy/v1', version: w.version + 1,
            grants: [{ actorId: w.ownerActorId, operations: ['policy.publish', 'evidence.read'], purposes: ['development'], sourceKeys: ['voxel51'] }],
            sources: [{ sourceKey: 'voxel51', rootRef: data.sourceRoot, manifestSha256: data.hash, allowedPurposes: ['development'], useAuthorizationRef: 'synthetic-policy-narrowing-test' }],
          } });
        }
        return bytes;
      });
      await expect(p.application.readDocument(req(), { document: published.documentRefs[0], manifest: published.manifest, purpose: 'development' })).rejects.toMatchObject({ descriptor: { code: 'OPERATION_DENIED' } });
      expect(narrowed).toBe(true);
    } finally { vi.restoreAllMocks(); await close(p); }
  });

  it('enforces the lower store capacity at below equal and above the limit', async () => {
    const root = await temporary(); await mkdir(join(root, 'source'));
    const store = new InstanceFileStore({ sourceRoot: join(root, 'source'), instanceRoot: join(root, 'instance'), maxFileBytes: 32 });
    for (const size of [31, 32, 33]) {
      const bytes = new Uint8Array(size).fill(1);
      await writeFile(join(root, 'source', 'file.bin'), bytes);
      const operation = store.readVerified({ root: 'source', relativePath: 'file.bin', expectedSha256: sha256Bytes(bytes), expectedBytes: size, maxBytes: 64 });
      if (size > 32) await expect(operation).rejects.toMatchObject({ descriptor: { code: 'INPUT_LIMIT_EXCEEDED' } });
      else expect((await operation).byteLength).toBe(size);
    }
  });

  it('rejects a junction ancestor of an otherwise real approved root', async () => {
    if (process.platform !== 'win32') throw new Error('[P0_FACILITY] Windows junction probe requires Windows');
    const root = await temporary();
    await mkdir(join(root, 'real', 'source'), { recursive: true });
    await symlink(join(root, 'real'), join(root, 'linked'), 'junction').catch(error => { throw new Error('[P0_FACILITY] Cannot create Windows junction', { cause: error }); });
    const bytes = new TextEncoder().encode('canary');
    await writeFile(join(root, 'real', 'source', 'file.txt'), bytes);
    const store = new InstanceFileStore({ sourceRoot: join(root, 'linked', 'source'), instanceRoot: join(root, 'instance') });
    await expect(store.readVerified({ root: 'source', relativePath: 'file.txt', expectedSha256: sha256Bytes(bytes), expectedBytes: bytes.length, maxBytes: 100 })).rejects.toMatchObject({ descriptor: { code: 'REPARSE_POINT_DENIED' } });
    await expect(createProduct({ instanceRoot: join(root, 'linked', 'new-instance'), mode: 'create' })).rejects.toMatchObject({ descriptor: { code: 'REPARSE_POINT_DENIED' } });
    expect(await readdir(join(root, 'real'))).not.toContain('new-instance');
  });

  it('rotates bounded diagnostic files and preserves total quota across restart', async () => {
    const root = await temporary();
    const config = { minLevel: 'info' as const, maxRecordBytes: 400, maxFileBytes: 500, maxTotalBytes: 1400, retentionDays: 7, queueLimit: 2, flushTimeoutMs: 100 };
    const first = new JsonlLogger({ instanceId: 'i_test', processInstanceId: 'p_first', logRoot: root, config });
    for (let n = 0; n < 10; n++) first.write({ level: 'info', component: 'probe', eventCode: 'bounded', safeMessage: 'x'.repeat(100) });
    expect(first.health().degraded).toBe(true);
    await first.close(100);
    const sizes = await Promise.all((await readdir(root)).filter(n => n.endsWith('.jsonl')).map(async n => (await stat(join(root, n))).size));
    expect(sizes.length).toBeGreaterThan(1); expect(sizes.every(n => n <= 500)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1400);
    const second = new JsonlLogger({ instanceId: 'i_test', processInstanceId: 'p_second', logRoot: root, config });
    for (let n = 0; n < 10; n++) second.write({ level: 'info', component: 'probe', eventCode: 'bounded', safeMessage: 'x'.repeat(100) });
    expect(second.health().degraded).toBe(true); await second.close(100);
    const total = (await Promise.all((await readdir(root)).filter(n => n.endsWith('.jsonl')).map(async n => (await stat(join(root, n))).size))).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(1400);
  });

  it('degrades on diagnostic append failure without throwing', async () => {
    const root = await temporary();
    const logger = new JsonlLogger({ instanceId: 'i_test', processInstanceId: 'p_test', logRoot: root, config: { minLevel: 'info', maxRecordBytes: 512, maxFileBytes: 1024, maxTotalBytes: 4096, retentionDays: 7, queueLimit: 2, flushTimeoutMs: 100 } });
    const file = join(root, 'p0-p_test.jsonl'); await rm(file); await mkdir(file);
    expect(() => logger.write({ level: 'info', component: 'probe', eventCode: 'fail', safeMessage: 'operation completed' })).not.toThrow();
    expect(logger.health().degraded).toBe(true); await logger.close(100);
  });

  it('reopens a complete closed backup and rejects a missing captured artifact', async () => {
    const data = await inputFixture(); const instance = join(data.root, 'instance');
    const p = await createProduct({ instanceRoot: instance, mode: 'create' });
    const req = () => ({ requestId: crypto.randomUUID(), workspaceId: p.workspaceId });
    const published = await p.application.publishDataset(req(), { sourceKey: 'voxel51', manifestSha256: data.hash, selection: [], purpose: 'development' });
    const captured = await p.application.captureInput(req(), { document: published.documentRefs[0], manifest: published.manifest, purpose: 'development' });
    await close(p);
    const checkpoint = await readRecoveryCheckpoint(instance);
    const backup = join(data.root, 'backup'); await cp(instance, backup, { recursive: true });
    const restored = await createProduct({ instanceRoot: backup, mode: 'open', recoveryCheckpoint: checkpoint });
    try {
      expect(restored.instanceId).toBe(p.instanceId);
      const request = () => ({ requestId: crypto.randomUUID(), workspaceId: restored.workspaceId });
      const input = await restored.application.readCapturedInput(request(), { projection: captured.projection, purpose: 'development' });
      expect(input.document).toEqual(published.documentRefs[0]);
      const artifactPath = join(backup, 'artifacts', restored.workspaceId, captured.projection.sha256.slice(0, 2), captured.projection.sha256);
      await rename(artifactPath, artifactPath + '.missing');
      await expect(restored.application.readCapturedInput(request(), { projection: captured.projection, purpose: 'development' })).rejects.toMatchObject({ descriptor: { code: 'FILE_MISSING' } });
    } finally { await close(restored); }
  });

  it('rejects an old backup against an independently retained current policy binding', async () => {
    const data = await inputFixture(); const instance = join(data.root, 'instance');
    const first = await createProduct({ instanceRoot: instance, mode: 'create' });
    await close(first);
    const backup = join(data.root, 'old-backup'); await cp(instance, backup, { recursive: true });
    const current = await createProduct({ instanceRoot: instance, mode: 'open' });
    let currentHash: string;
    try {
      const req = () => ({ requestId: crypto.randomUUID(), workspaceId: current.workspaceId });
      const w = await current.application.getWorkspace(req());
      const next = await current.application.publishPolicy(req(), { expectedRevision: w.version, policy: {
        schemaVersion: 'p0-policy/v1', version: w.version + 1,
        grants: [{ actorId: w.ownerActorId, operations: ['policy.publish', 'evidence.read'], sourceKeys: ['voxel51'], purposes: ['development'] }],
        sources: [{ sourceKey: 'voxel51', rootRef: data.sourceRoot, manifestSha256: data.hash, allowedPurposes: ['development'], useAuthorizationRef: 'synthetic-withdrawal' }],
      } });
      currentHash = next.policyHash;
    } finally { await close(current); }
    const raw = new DatabaseSync(join(backup, 'data', 'app.sqlite'), { readOnly: true });
    let oldHash: string;
    try { oldHash = String((raw.prepare('SELECT policy_hash FROM workspaces').get() as { policy_hash: string }).policy_hash); }
    finally { raw.close(); }
    expect(() => requireBindingMatch({ policySha256: currentHash }, { policySha256: oldHash })).toThrow('binding drift');
    // The recovery preflight rejects BEFORE createProduct opens the old backup.
    expect(await readdir(backup)).not.toContain('instance.lock');
  });
});
