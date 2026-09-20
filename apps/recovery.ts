import { open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RecoveryCheckpoint } from '../packages/contracts/src/index.ts';
import { productError } from '../packages/contracts/src/errors.ts';
import { sha256Canonical } from '../packages/shared/src/index.ts';
import { assertNoLinkedAncestors } from '../packages/core/src/storage/file-store.ts';

/** Offline checkpoint for the single-controller P0 instance; never starts Application. */
export async function readRecoveryCheckpoint(instanceRoot: string): Promise<RecoveryCheckpoint> {
  const root = resolve(instanceRoot);
  if (root.split(/[\\/]/).some(part => part.toLowerCase() === 'agent-eval')) throw new Error('Quality root cannot be a product recovery instance');
  await assertNoLinkedAncestors(root);
  const lock = await open(join(root, 'instance.lock'), 'wx');
  try {
    return await readAuthorityCheckpoint(root);
  } finally { await lock.close(); await rm(join(root, 'instance.lock')); }
}

/** Called only while composition owns the instance controller lock. */
export async function verifyRecoveryCheckpoint(instanceRoot: string, expected: RecoveryCheckpoint): Promise<void> {
  const actual = await readAuthorityCheckpoint(instanceRoot);
  if (expected?.schemaVersion !== 'p0-recovery-checkpoint/v1' || sha256Canonical(expected) !== sha256Canonical(actual)) {
    throw productError({ code: 'RECOVERY_STATE_MISMATCH', category: 'state', source: { component: 'composition', operation: 'restore' }, safeMessage: 'The restored facts do not match the independently retained current checkpoint', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} });
  }
}

export async function requireRecoveryForMovedInstance(instanceRoot: string, checkpoint?: RecoveryCheckpoint): Promise<void> {
  const path = join(instanceRoot, 'data', 'app.sqlite');
  await assertNoLinkedAncestors(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT data_root_ref FROM workspaces WHERE workspace_key='default'").get() as { data_root_ref: string } | undefined;
    if (!row || (resolve(row.data_root_ref) !== resolve(instanceRoot) && !checkpoint)) throw productError({ code: 'RECOVERY_CHECKPOINT_REQUIRED', category: 'state', source: { component: 'composition', operation: 'restore' }, safeMessage: 'An independently retained current checkpoint is required for this recovered instance', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} });
  } finally { db.close(); }
}

async function readAuthorityCheckpoint(root: string): Promise<RecoveryCheckpoint> {
  const identityPath = join(root, 'instance.json');
  const databasePath = join(root, 'data', 'app.sqlite');
  await assertNoLinkedAncestors(identityPath); await assertNoLinkedAncestors(databasePath);
  const identity = JSON.parse(await readFile(identityPath, 'utf8')) as { instanceId: string; workspaceId: string };
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const facts = {
      identity,
      migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      workspaces: db.prepare('SELECT * FROM workspaces ORDER BY workspace_id').all(),
      documents: db.prepare('SELECT * FROM documents ORDER BY document_id').all(),
      artifacts: db.prepare('SELECT * FROM artifacts ORDER BY artifact_id').all(),
      audit: db.prepare('SELECT * FROM audit_events ORDER BY audit_id').all(),
    };
    return { schemaVersion: 'p0-recovery-checkpoint/v1', instanceId: identity.instanceId, workspaceId: identity.workspaceId, authoritySha256: sha256Canonical(facts) };
  } finally { db.close(); }
}
