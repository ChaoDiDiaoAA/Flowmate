import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProduct } from '../../apps/composition.ts';
import { sha256Bytes } from '../../packages/shared/src/index.ts';
import { FoundationDatabase } from '../../packages/core/src/storage/database.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function freshRoot() {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-p0-'));
  roots.push(root);
  return root;
}

describe('P0 product foundation', () => {
  it('initializes a stable default workspace and reopens it with the same owner', async () => {
    const root = await freshRoot();
    const first = await createProduct({ instanceRoot: root, mode: 'create' });
    const firstView = await first.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: first.workspaceId });
    const firstIdentity = { instanceId: first.instanceId, workspaceId: first.workspaceId, ownerActorId: firstView.ownerActorId };
    await first.close();

    const second = await createProduct({ instanceRoot: root, mode: 'open' });
    const secondView = await second.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: second.workspaceId });
    expect({ instanceId: second.instanceId, workspaceId: second.workspaceId, ownerActorId: secondView.ownerActorId }).toEqual(firstIdentity);
    expect(second.processInstanceId).not.toBe(first.processInstanceId);
    await second.close();
  });

  it('rejects an unknown workspace before reading any document', async () => {
    const root = await freshRoot();
    const product = await createProduct({ instanceRoot: root, mode: 'create' });
    await expect(product.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: crypto.randomUUID() }))
      .rejects.toMatchObject({ descriptor: { code: 'WORKSPACE_UNKNOWN' } });
    await product.close();
  });

  it('requires pause before archiving and reopens archived workspaces as paused', async () => {
    const root = await freshRoot();
    const product = await createProduct({ instanceRoot: root, mode: 'create' });
    try {
      const req = () => ({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId });
      await expect(product.application.setWorkspaceStatus(req(), { expectedStatus: 'active', expectedRevision: 1, targetStatus: 'archived', reason: 'must pause first' }))
        .rejects.toMatchObject({ descriptor: { code: 'STATE_TRANSITION_INVALID' } });
      const paused = await product.application.setWorkspaceStatus(req(), { expectedStatus: 'active', expectedRevision: 1, targetStatus: 'paused', reason: 'archive preparation' });
      const archived = await product.application.setWorkspaceStatus(req(), { expectedStatus: 'paused', expectedRevision: paused.version, targetStatus: 'archived', reason: 'archive' });
      expect(archived.status).toBe('archived');
      const reopened = await product.application.setWorkspaceStatus(req(), { expectedStatus: 'archived', expectedRevision: archived.version, targetStatus: 'paused', reason: 'reopen for review' });
      expect(reopened.status).toBe('paused');
    } finally { await product.close(); }
  });

  it('rejects new application calls after explicit close', async () => {
    const root = await freshRoot();
    const product = await createProduct({ instanceRoot: root, mode: 'create' });
    const req = { requestId: crypto.randomUUID(), workspaceId: product.workspaceId };
    await product.close();
    await expect(product.application.getWorkspace(req)).rejects.toMatchObject({ descriptor: { code: 'PRODUCT_CLOSED' } });
    expect((await product.close()).closed).toBe(true);
  });

  it('releases Windows file handles so a closed instance root can be moved', async () => {
    const root = await freshRoot();
    const product = await createProduct({ instanceRoot: root, mode: 'create' });
    await product.close();
    const moved = `${root}-moved`;
    roots.push(moved);
    await rename(root, moved);
    expect(await readFile(join(moved, 'instance.json'), 'utf8')).toContain('p0-instance/v1');
  });

  it('holds a single instance controller lock', async () => {
    const root = await freshRoot();
    const first = await createProduct({ instanceRoot: root, mode: 'create' });
    await expect(createProduct({ instanceRoot: root, mode: 'open' })).rejects.toMatchObject({ descriptor: { code: 'INSTANCE_LOCKED' } });
    await first.close();
  });

  it('rejects quality roots before creating a product instance', async () => {
    await expect(createProduct({ instanceRoot: join(process.cwd(), 'agent-eval', 'p0-test-instance'), mode: 'create' }))
      .rejects.toMatchObject({ descriptor: { code: 'QUALITY_ROOT_DENIED' } });
  });

  it('reopens with the persisted policy after a policy version change', async () => {
    const root = await freshRoot();
    const product = await createProduct({ instanceRoot: root, mode: 'create' });
    const workspace = await product.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId });
    const manifestSha256 = sha256Bytes(await readFile(join(process.cwd(), 'data', 'invoices', 'voxel51', 'manifest.json')));
    const policy = { schemaVersion: 'p0-policy/v1' as const, version: 2, grants: [{ actorId: workspace.ownerActorId, operations: ['evidence.read'] as const, sourceKeys: ['voxel51'], purposes: ['development'] as const }], sources: [{ sourceKey: 'voxel51', rootRef: 'data/invoices/voxel51', manifestSha256, allowedPurposes: ['development'] as const, useAuthorizationRef: `workspace:${product.workspaceId}` }] };
    const updated = await product.application.publishPolicy({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId }, { expectedRevision: workspace.version, policy });
    await product.close();
    const reopened = await createProduct({ instanceRoot: root, mode: 'open' });
    expect((await reopened.application.getWorkspace({ requestId: crypto.randomUUID(), workspaceId: product.workspaceId })).policyHash).toBe(updated.policyHash);
    await reopened.close();
  });

  it('rejects a changed source-root configuration on reopen', async () => {
    const root = await freshRoot();
    const configPath = join(root, 'flowmate.config.json');
    const sourceRoot = resolve('data/invoices/voxel51');
    await writeFile(configPath, JSON.stringify({ sourceRoot }), 'utf8');
    const product = await createProduct({ instanceRoot: root, configPath, mode: 'create' });
    await product.close();
    const alternateRoot = join(root, 'alternate-source');
    await mkdir(alternateRoot, { recursive: true });
    await cp(join(sourceRoot, 'manifest.json'), join(alternateRoot, 'manifest.json'));
    await writeFile(configPath, JSON.stringify({ sourceRoot: alternateRoot }), 'utf8');
    await expect(createProduct({ instanceRoot: root, configPath, mode: 'open' }))
      .rejects.toMatchObject({ descriptor: { code: 'CONFIG_LOCK_MISMATCH' } });
  });

  it('imports the public composition without starting a product or creating resources', async () => {
    const root = await freshRoot();
    const modulePath = resolve('apps/composition.ts').replaceAll('\\', '/');
    const output = execFileSync('bun', ['-e', `await import(${JSON.stringify(modulePath)}); console.log('imported')`], { cwd: root, encoding: 'utf8' });
    expect(output).toContain('imported');
    expect(await readdir(root)).toEqual([]);
  });

  it('drives the explicit P0 CLI init command without a desktop host', async () => {
    const root = await freshRoot();
    const output = execFileSync('bun', ['run', resolve('scripts/p0.ts'), 'init', '--instance-root', root], { cwd: process.cwd(), encoding: 'utf8' });
    const result = JSON.parse(output) as { instanceId: string; workspaceId: string; processInstanceId: string };
    expect(result.instanceId).toMatch(/^i_/);
    expect(result.workspaceId).toMatch(/^w_/);
    expect(result.processInstanceId).toMatch(/^p_/);
    const reopened = await createProduct({ instanceRoot: root, mode: 'open' });
    await reopened.close();
  });

  it('rolls back facts when a test-only commit or audit fault is injected', async () => {
    const root = await freshRoot();
    let fault: 'before-commit' | 'before-audit-insert' | undefined;
    const db = new FoundationDatabase(join(root, 'foundation.sqlite'), (point) => { if (point === fault) throw new Error(`injected ${point}`); });
    db.initialize();
    const workspaceId = 'w_fault_test';
    const actorId = 'a_fault_test';
    db.createOrLoadWorkspace({ workspaceId, ownerActorId: actorId, policyJson: '{}', policyHash: 'a'.repeat(64), instanceId: 'i_fault_test', dataRootRef: root });
    const baseline = Number((db.db.query('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count);
    fault = 'before-commit';
    expect(() => db.transaction(actorId, workspaceId, 'fault-commit', (tx) => {
      tx.addAudit({ actorId, action: 'test.commit', entityType: 'test', entityId: 'commit', requestId: 'fault-commit', afterRef: { ok: true } });
    })).toThrow('injected before-commit');
    expect(Number((db.db.query('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count)).toBe(baseline);
    fault = 'before-audit-insert';
    expect(() => db.transaction(actorId, workspaceId, 'fault-audit', (tx) => {
      tx.addAudit({ actorId, action: 'test.audit', entityType: 'test', entityId: 'audit', requestId: 'fault-audit', afterRef: { ok: true } });
    })).toThrow('injected before-audit-insert');
    expect(Number((db.db.query('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count)).toBe(baseline);
    db.close();
  });

  it('refuses a persisted migration checksum drift instead of rebuilding the database', async () => {
    const root = await freshRoot();
    const path = join(root, 'migration.sqlite');
    const first = new FoundationDatabase(path);
    first.initialize();
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('f'.repeat(64));
    raw.close();
    const reopened = new FoundationDatabase(path);
    let error: unknown;
    try {
      reopened.initialize();
    } catch (caught) {
      error = caught;
    } finally {
      reopened.close();
    }
    expect(error).toMatchObject({ descriptor: { code: 'MIGRATION_FAILED' } });
  });
});
