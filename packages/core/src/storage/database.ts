import { DatabaseSync } from 'node:sqlite';
import type {
  ArtifactRef,
  CommandReceipt,
  DocumentRef,
  DocumentStatus,
  DocumentView,
  StateChange,
  WorkspaceStatus,
  WorkspaceView,
} from '../../../contracts/src/index.ts';
import type { ArtifactDraft, DocumentDraft, FoundationTx } from '../../../contracts/src/ports.ts';
import { canonicalJson, nowUtc, sha256Canonical } from '../../../shared/src/index.ts';
import { ProductError, productError } from '../../../contracts/src/errors.ts';

interface WorkspaceRow {
  workspace_id: string;
  owner_actor_id: string;
  status: WorkspaceStatus;
  version: number;
  policy_hash: string;
  policy_json: string;
}

interface DocumentRow {
  document_id: string;
  workspace_id: string;
  version: string;
  original_sha256: string;
  parse_hash: string | null;
  status: DocumentStatus;
  state_revision: number;
  availability_reason: string | null;
  verification_ref: string | null;
}

export interface ArtifactRow {
  artifact_id: string;
  workspace_id: string;
  kind: string;
  storage_root: 'instance';
  relative_path: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  source_ref: string;
}

export interface DocumentRecord extends DocumentRow {
  source_key: string;
  source_record_id: string;
  original_artifact_id: string;
  parsed_artifact_id: string | null;
  content_hash: string;
  source_metadata_json: string;
  parser_ref: string | null;
  parser_version: string | null;
}

export interface FoundationIdentity {
  instanceId: string;
  workspaceId: string;
  ownerActorId: string;
  policyHash: string;
}

type SqliteStatement = {
  get<T = unknown>(...params: unknown[]): T | null;
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
};

/** Test-only storage fault points; production composition never supplies this hook. */
export type FoundationFaultPoint = 'before-commit' | 'before-audit-insert' | 'before-migration-commit';

/** A tiny compatibility surface shared by Bun and Node's built-in SQLite. */
class SqliteCompat {
  private readonly database: DatabaseSync;
  constructor(path: string) { this.database = new DatabaseSync(path); }
  exec(sql: string): void { this.database.exec(sql); }
  query(sql: string): SqliteStatement { return this.database.prepare(sql) as unknown as SqliteStatement; }
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.database.exec('BEGIN IMMEDIATE');
      try { const result = fn(); this.database.exec('COMMIT'); return result; }
      catch (error) { try { this.database.exec('ROLLBACK'); } catch { /* preserve primary failure */ } throw error; }
    };
  }
  close(): void { this.database.close(); }
}

export class FoundationDatabase {
  readonly db: SqliteCompat;

  constructor(readonly dbPath: string, private readonly faultInjector?: (point: FoundationFaultPoint) => void) {
    this.db = new SqliteCompat(dbPath);
    try { this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;'); }
    catch (error) { try { this.db.close(); } catch { /* preserve the database initialization error */ } throw error; }
  }

  initialize(): void {
    const sql = `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        application_version TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL UNIQUE CHECK (workspace_key = 'default'),
        name TEXT NOT NULL,
        owner_actor_id TEXT NOT NULL,
        environment_ref TEXT NOT NULL,
        data_root_ref TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        storage_root TEXT NOT NULL CHECK (storage_root = 'instance'),
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        mime_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        retention_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        UNIQUE (workspace_id, sha256, kind),
        UNIQUE (workspace_id, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS documents (
        document_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        version TEXT NOT NULL,
        original_sha256 TEXT NOT NULL,
        original_artifact_id TEXT NOT NULL,
        parsed_artifact_id TEXT,
        content_hash TEXT NOT NULL,
        parse_hash TEXT,
        source_metadata_json TEXT NOT NULL,
        parser_ref TEXT,
        parser_version TEXT,
        parent_document_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','available','unavailable','withdrawn')),
        state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
        availability_reason TEXT,
        verification_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, original_artifact_id) REFERENCES artifacts(workspace_id, artifact_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_id, parsed_artifact_id) REFERENCES artifacts(workspace_id, artifact_id) ON DELETE RESTRICT,
        UNIQUE (workspace_id, source_key, source_record_id, version)
      );
      CREATE INDEX IF NOT EXISTS document_current_scope
        ON documents(workspace_id, source_key, content_hash, status);
      CREATE TABLE IF NOT EXISTS audit_events (
        audit_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        actor_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        before_ref TEXT,
        after_ref TEXT NOT NULL,
        reason TEXT,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
        UNIQUE (workspace_id, actor_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS audit_entity
        ON audit_events(workspace_id, entity_type, entity_id, occurred_at);
    `;
    this.db.transaction(() => {
    // Bootstrap the migration table before reading its history. This keeps a new
    // SQLite file on the same verified path as a reopened file.
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      application_version TEXT NOT NULL
    );`);
    const latest = this.db.query('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if (latest.version !== null && latest.version > 1) throw productError({ code: 'MIGRATION_FAILED', category: 'storage', source: { component: 'database', operation: 'migrate' }, safeMessage: 'Database schema is newer than this product', impactScope: 'instance', recoveryAction: 'manual_review', correlation: {} });
    const migrationChecksum = sha256Canonical({ version: 1, name: 'foundation', sql });
    const existing = this.db.query('SELECT version, checksum FROM schema_migrations WHERE version = 1').get() as { version: number; checksum: string } | null;
    if (existing && existing.checksum !== migrationChecksum) {
      throw productError({
        code: 'MIGRATION_FAILED', category: 'storage', source: { component: 'database', operation: 'migrate' },
        safeMessage: 'Schema migration checksum does not match the installed database', impactScope: 'instance',
        recoveryAction: 'manual_review', correlation: {},
      });
    }
    this.db.exec(sql);
    if (!existing) {
      this.db.query('INSERT INTO schema_migrations(version,name,checksum,applied_at,application_version) VALUES (1,?,?,?,?)')
        .run('foundation', migrationChecksum, nowUtc(), 'p0-product-v1');
    }
      this.faultInjector?.('before-migration-commit');
    })();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(actorId: string, workspaceId: string, requestId: string, fn: (tx: FoundationTx) => T): T {
    const transaction = this.db.transaction(() => {
      const result = fn(new DbFoundationTx(this, actorId, workspaceId, requestId));
      this.faultInjector?.('before-commit');
      return result;
    });
    return transaction() as T;
  }

  triggerFault(point: FoundationFaultPoint): void { this.faultInjector?.(point); }

  createOrLoadWorkspace(input: {
    workspaceId: string;
    ownerActorId: string;
    policyJson: string;
    policyHash: string;
    instanceId: string;
    dataRootRef: string;
  }): WorkspaceView {
    const existing = this.getWorkspace(input.workspaceId);
    if (existing) {
      const row = this.db.query('SELECT owner_actor_id FROM workspaces WHERE workspace_id = ?').get(input.workspaceId) as { owner_actor_id: string };
      if (row.owner_actor_id !== input.ownerActorId) {
        throw productError({
          code: 'IDENTITY_UNTRUSTED', category: 'authorization', source: { component: 'database', operation: 'openWorkspace' },
          safeMessage: 'The persisted workspace identity does not match this instance', impactScope: 'instance',
          recoveryAction: 'manual_review', correlation: { workspaceId: input.workspaceId },
        });
      }
      return existing;
    }
    const now = nowUtc();
    const initRequestId = `init-${input.instanceId}`;
    this.transaction(input.ownerActorId, input.workspaceId, initRequestId, (tx) => {
      this.db.query(`INSERT INTO workspaces(workspace_id,workspace_key,name,owner_actor_id,environment_ref,data_root_ref,policy_json,policy_hash,schema_version,version,status,created_at,updated_at)
        VALUES (?, 'default', 'Default Workspace', ?, 'development', ?, ?, ?, 'p0-workspace/v1', 1, 'active', ?, ?)`)
        .run(input.workspaceId, input.ownerActorId, input.dataRootRef, input.policyJson, input.policyHash, now, now);
      tx.addAudit({ actorId: input.ownerActorId, action: 'workspace.initialize', entityType: 'workspace', entityId: input.workspaceId, requestId: initRequestId, afterRef: { schemaVersion: 'p0-workspace/v1', workspaceId: input.workspaceId, ownerActorId: input.ownerActorId, policyHash: input.policyHash, instanceId: input.instanceId } });
    });
    return this.getWorkspace(input.workspaceId)!;
  }

  getWorkspace(workspaceId: string): WorkspaceView | null {
    const row = this.db.query('SELECT workspace_id, owner_actor_id, status, version, policy_hash FROM workspaces WHERE workspace_id = ?').get(workspaceId) as WorkspaceRow | null;
    return row ? { workspaceId: row.workspace_id, ownerActorId: row.owner_actor_id, status: row.status, version: row.version, policyHash: row.policy_hash } : null;
  }

  getDocument(ref: DocumentRef): DocumentView | null {
    const row = this.db.query(`SELECT document_id,workspace_id,version,original_sha256,parse_hash,status,state_revision,availability_reason,verification_ref
      FROM documents WHERE workspace_id=? AND document_id=? AND version=? AND original_sha256=? AND (parse_hash=? OR (parse_hash IS NULL AND ? IS NULL))`).get(ref.workspaceId, ref.documentId, ref.version, ref.originalSha256, ref.parseHash, ref.parseHash) as DocumentRow | null;
    if (!row) return null;
    return this.toDocumentView(row);
  }

  findReceipt(workspaceId: string, actorId: string, requestId: string): CommandReceipt | null {
    const row = this.db.query(`SELECT after_ref FROM audit_events WHERE workspace_id=? AND actor_id=? AND request_id=? AND action='command.receipt'`)
      .get(workspaceId, actorId, requestId) as { after_ref: string } | null;
    return row ? JSON.parse(row.after_ref) as CommandReceipt : null;
  }

  policy(workspaceId: string): { json: string; hash: string; version: number } {
    const row = this.db.query('SELECT policy_json,policy_hash,version FROM workspaces WHERE workspace_id=?').get(workspaceId) as { policy_json: string; policy_hash: string; version: number } | null;
    if (!row) throw productError({ code: 'WORKSPACE_UNKNOWN', category: 'authorization', source: { component: 'database', operation: 'policy' }, safeMessage: 'Workspace is not registered', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId } });
    return { json: row.policy_json, hash: row.policy_hash, version: row.version };
  }

  toDocumentView(row: DocumentRow): DocumentView {
    const ref: DocumentRef = { documentId: row.document_id, workspaceId: row.workspace_id, version: row.version, originalSha256: row.original_sha256, parseHash: row.parse_hash };
    return { ref, status: row.status, stateRevision: row.state_revision, ...(row.verification_ref ? { verificationRef: JSON.parse(row.verification_ref) as ArtifactRef } : {}), ...(row.availability_reason ? { availabilityReason: row.availability_reason } : {}) };
  }

  getDocumentRecord(ref: DocumentRef): DocumentRecord | null {
    return this.db.query(`SELECT document_id,workspace_id,source_key,source_record_id,version,original_sha256,original_artifact_id,parsed_artifact_id,content_hash,parse_hash,source_metadata_json,parser_ref,parser_version,status,state_revision,availability_reason,verification_ref
      FROM documents WHERE workspace_id=? AND document_id=? AND version=? AND original_sha256=? AND (parse_hash=? OR (parse_hash IS NULL AND ? IS NULL))`).get(ref.workspaceId, ref.documentId, ref.version, ref.originalSha256, ref.parseHash, ref.parseHash) as DocumentRecord | null;
  }

  getLatestDocumentById(workspaceId: string, documentId: string): DocumentView | null {
    const row = this.db.query(`SELECT document_id,workspace_id,version,original_sha256,parse_hash,status,state_revision,availability_reason,verification_ref
      FROM documents WHERE workspace_id=? AND document_id=? ORDER BY updated_at DESC LIMIT 1`).get(workspaceId, documentId) as DocumentRow | null;
    return row ? this.toDocumentView(row) : null;
  }

  getArtifact(workspaceId: string, artifactId: string): ArtifactRow | null {
    return this.db.query('SELECT artifact_id,workspace_id,kind,storage_root,relative_path,sha256,size_bytes,mime_type,source_ref FROM artifacts WHERE workspace_id=? AND artifact_id=?').get(workspaceId, artifactId) as ArtifactRow | null;
  }

  isOriginalWithdrawn(workspaceId: string, sourceKey: string, originalSha256: string): boolean {
    return Boolean(this.db.query("SELECT 1 AS found FROM documents WHERE workspace_id=? AND source_key=? AND original_sha256=? AND status='withdrawn' LIMIT 1").get(workspaceId, sourceKey, originalSha256));
  }
}

class DbFoundationTx implements FoundationTx {
  constructor(private readonly owner: FoundationDatabase, private readonly actorId: string, private readonly workspaceId: string, private readonly requestId: string) {}

  getWorkspace(workspaceId: string): WorkspaceView | null { return this.owner.getWorkspace(workspaceId); }
  findReceipt(workspaceId: string, actorId: string, requestId: string): CommandReceipt | null { return this.owner.findReceipt(workspaceId, actorId, requestId); }

  registerArtifact(draft: ArtifactDraft): ArtifactRef {
    if (draft.workspaceId !== this.workspaceId) throw productError({ code: 'OWNERSHIP_MISMATCH', category: 'authorization', source: { component: 'database', operation: 'registerArtifact' }, safeMessage: 'The artifact belongs to another workspace', impactScope: 'call', recoveryAction: 'correct_input', correlation: { workspaceId: this.workspaceId, artifactId: draft.artifactId } });
    const existing = this.owner.db.query('SELECT artifact_id,workspace_id,sha256,size_bytes,kind FROM artifacts WHERE workspace_id=? AND sha256=? AND kind=?').get(draft.workspaceId, draft.sha256, draft.kind) as { artifact_id: string; workspace_id: string; sha256: string; size_bytes: number; kind: string } | null;
    if (existing) return { artifactId: existing.artifact_id, workspaceId: existing.workspace_id, sha256: existing.sha256, sizeBytes: existing.size_bytes, kind: existing.kind };
    this.owner.db.query(`INSERT INTO artifacts(artifact_id,workspace_id,kind,storage_root,relative_path,sha256,size_bytes,mime_type,source_ref,retention_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(draft.artifactId, draft.workspaceId, draft.kind, draft.storageRoot, draft.relativePath, draft.sha256, draft.sizeBytes, draft.mimeType, draft.sourceRef, JSON.stringify({ mode: 'retain', reason: 'p0-foundation' }), nowUtc());
    return { artifactId: draft.artifactId, workspaceId: draft.workspaceId, sha256: draft.sha256, sizeBytes: draft.sizeBytes, kind: draft.kind };
  }

  registerDocument(draft: DocumentDraft, status: DocumentStatus = 'pending'): DocumentView {
    const original = this.owner.getArtifact(this.workspaceId, draft.originalArtifactId);
    if (original && this.owner.isOriginalWithdrawn(this.workspaceId, draft.sourceKey, original.sha256)) throw productError({ code: 'DOCUMENT_WITHDRAWN', category: 'state', source: { component: 'database', operation: 'registerDocument' }, safeMessage: 'The source original is withdrawn in this workspace', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: this.workspaceId } });
    if (draft.workspaceId !== this.workspaceId || status !== 'pending') throw productError({ code: 'STATE_TRANSITION_INVALID', category: 'state', source: { component: 'database', operation: 'registerDocument' }, safeMessage: 'Documents enter the foundation in pending state', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: this.workspaceId } });
    const existing = this.owner.db.query(`SELECT document_id,workspace_id,version,original_sha256,parse_hash,status,state_revision,availability_reason,verification_ref
      FROM documents WHERE workspace_id=? AND source_key=? AND source_record_id=? AND version=?`).get(draft.workspaceId, draft.sourceKey, draft.sourceRecordId, draft.version) as DocumentRow | null;
    if (existing) return this.owner.toDocumentView(existing);
    const now = nowUtc();
    const originalArtifact = this.owner.getArtifact(draft.workspaceId, draft.originalArtifactId);
    if (!originalArtifact) throw productError({ code: 'FILE_MISSING', category: 'storage', source: { component: 'database', operation: 'registerDocument' }, safeMessage: 'The document references an artifact that is not registered', impactScope: 'call', recoveryAction: 'manual_review', correlation: { workspaceId: draft.workspaceId } });
    this.owner.db.query(`INSERT INTO documents(document_id,workspace_id,source_key,source_record_id,version,original_sha256,original_artifact_id,parsed_artifact_id,content_hash,parse_hash,source_metadata_json,parser_ref,parser_version,parent_document_id,status,state_revision,availability_reason,verification_ref,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,NULL,?,?)`).run(draft.documentId, draft.workspaceId, draft.sourceKey, draft.sourceRecordId, draft.version, originalArtifact.sha256, draft.originalArtifactId, draft.parsedArtifactId, draft.contentHash, draft.parseHash, draft.sourceMetadataJson, draft.parserRef, draft.parserVersion, draft.parentDocumentId, status, now, now);
    return this.owner.getDocument({ documentId: draft.documentId, workspaceId: draft.workspaceId, version: draft.version, originalSha256: originalArtifact.sha256, parseHash: draft.parseHash })!;
  }

  compareAndSetDocument(ref: DocumentRef, change: StateChange<DocumentStatus>, verificationRef?: ArtifactRef): DocumentView {
    const now = nowUtc();
    const result = this.owner.db.query(`UPDATE documents SET status=?,state_revision=state_revision+1,availability_reason=?,verification_ref=?,updated_at=?
      WHERE workspace_id=? AND document_id=? AND version=? AND original_sha256=? AND (parse_hash=? OR (parse_hash IS NULL AND ? IS NULL)) AND status=? AND state_revision=?`).run(change.targetStatus, change.reason, verificationRef ? JSON.stringify(verificationRef) : null, now, ref.workspaceId, ref.documentId, ref.version, ref.originalSha256, ref.parseHash, ref.parseHash, change.expectedStatus, change.expectedRevision);
    if (result.changes !== 1) throw productError({ code: 'STALE_STATE', category: 'state', source: { component: 'database', operation: 'compareAndSetDocument' }, safeMessage: 'The document changed before this operation committed', impactScope: 'call', recoveryAction: 'retry_read', correlation: { workspaceId: ref.workspaceId, documentId: ref.documentId } });
    if (change.targetStatus === 'withdrawn') {
      const record = this.owner.getDocumentRecord(ref)!;
      // Withdrawal is about the source original in this workspace, including its parse versions.
      this.owner.db.query("UPDATE documents SET status='withdrawn',state_revision=state_revision+1,availability_reason=?,updated_at=? WHERE workspace_id=? AND source_key=? AND original_sha256=? AND status<>'withdrawn'").run(change.reason, now, ref.workspaceId, record.source_key, ref.originalSha256);
    }
    return this.owner.getDocument(ref)!;
  }

  compareAndSetWorkspace(workspaceId: string, change: StateChange<WorkspaceStatus>): WorkspaceView {
    const result = this.owner.db.query(`UPDATE workspaces SET status=?,version=version+1,updated_at=? WHERE workspace_id=? AND status=? AND version=?`).run(change.targetStatus, nowUtc(), workspaceId, change.expectedStatus, change.expectedRevision);
    if (result.changes !== 1) throw productError({ code: 'STALE_STATE', category: 'state', source: { component: 'database', operation: 'compareAndSetWorkspace' }, safeMessage: 'The workspace changed before this operation committed', impactScope: 'call', recoveryAction: 'retry_read', correlation: { workspaceId } });
    return this.owner.getWorkspace(workspaceId)!;
  }

  updatePolicy(workspaceId: string, expectedVersion: number, policyJson: string, policyHash: string): WorkspaceView {
    const result = this.owner.db.query('UPDATE workspaces SET policy_json=?,policy_hash=?,version=version+1,updated_at=? WHERE workspace_id=? AND version=?').run(policyJson, policyHash, nowUtc(), workspaceId, expectedVersion);
    if (result.changes !== 1) throw productError({ code: 'STALE_STATE', category: 'configuration', source: { component: 'database', operation: 'updatePolicy' }, safeMessage: 'The workspace policy changed before this operation committed', impactScope: 'call', recoveryAction: 'retry_read', correlation: { workspaceId } });
    return this.owner.getWorkspace(workspaceId)!;
  }

  appendCommandAudit(input: CommandReceipt, beforeRef?: ArtifactRef): void {
    this.addAudit({ auditId: input.auditId, actorId: input.actorId, action: 'command.receipt', entityType: input.operation, entityId: input.resultRef.artifactId, requestId: input.requestId, beforeRef, afterRef: input });
  }

  addAudit(input: { auditId?: string; actorId: string; action: string; entityType: string; entityId: string; requestId: string; beforeRef?: ArtifactRef; afterRef: unknown; reason?: string; }): string {
    const auditId = input.auditId ?? crypto.randomUUID();
    try {
      this.owner.triggerFault('before-audit-insert');
      this.owner.db.query(`INSERT INTO audit_events(audit_id,workspace_id,actor_id,actor_type,action,entity_type,entity_id,request_id,before_ref,after_ref,reason,occurred_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(auditId, this.workspaceId, input.actorId, 'local-user', input.action, input.entityType, input.entityId, input.requestId, input.beforeRef ? canonicalJson(input.beforeRef) : null, canonicalJson(input.afterRef), input.reason ?? null, nowUtc());
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) throw productError({ code: 'IDEMPOTENCY_CONFLICT', category: 'state', source: { component: 'database', operation: 'audit' }, safeMessage: 'This request ID is already associated with a different command', impactScope: 'call', recoveryAction: 'query_action', correlation: { workspaceId: this.workspaceId, requestId: input.requestId } }, { cause: error });
      throw error;
    }
    return auditId;
  }
}
