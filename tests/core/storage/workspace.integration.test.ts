import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

function fixturePaths() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-workspace-migration-'));
  return { root, databaseFile: join(root, 'data', 'flowmate.sqlite'), logsDir: join(root, 'logs'),
    artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime') };
}

function schema13(paths: ReturnType<typeof fixturePaths>) {
  mkdirSync(join(paths.root, 'data'), { recursive: true });
  const db = new Database(paths.databaseFile);
  db.exec('PRAGMA foreign_keys=ON');
  const files = ['001_provider', '002_agent_sessions', '003_invoice_tools', '004_parsed_documents',
    '005_native_session_history', '006_hidden_processing', '007_hidden_chats_invoices', '008_native_entry_runs',
    '009_session_inputs', '010_human_candidates', '011_session_management', '012_tool_runtime_observations', '013_runtime_events'];
  for (const [index, file] of files.entries()) {
    const sql = readFileSync(new URL(`../../../packages/core/src/storage/migrations/${file}.sql`, import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) db.exec(statement);
    if ([4, 10, 11].includes(index + 1)) db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys=ON');
  }
  return db;
}

describe('P7 Workspace migration', () => {
  it('creates schema 14 and initializes one empty workspace at revision zero', () => {
    const opened = openTestDatabase(fixturePaths());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
    expect(opened.data.workspace.read('2026-10-03T00:00:00.000Z')).toMatchObject({ ok: true, data: { revision: 0, selection: null } });
    expect(opened.data.workspace.read('2026-10-03T00:00:01.000Z')).toMatchObject({ ok: true, data: { revision: 0 } });
    expect(opened.data.db.query('SELECT COUNT(*) AS count FROM workspace').get()).toEqual({ count: 1 });
  });

  it('migrates 13 to 14 without changing workspace facts and preserves all foreign keys', () => {
    const paths = fixturePaths();
    const db = schema13(paths);
    db.exec(`INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at)
      VALUES(1,'original','artifacts/1/original.png',1,'image/png','{}','created'),(2,'parsed','artifacts/2/parsed.json',1,'application/json','{}','created');
      INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at)
      VALUES(1,'synthetic','p7','v1',1,2,'available','{}','created','updated');
      INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,'p7-migration','Migration','created','updated');
      INSERT INTO jobs(id,document_id,goal,input_json,created_at,updated_at) VALUES(1,1,'Migration','{}','created','updated');
      INSERT INTO workspace(id,active_document_id,active_job_id,active_session_id,active_view,selection_json,revision,created_at,updated_at)
      VALUES(1,1,1,1,'parsed',NULL,17,'created','updated');`);
    const before = db.query('SELECT * FROM workspace').get();
    db.close();
    const opened = openTestDatabase(paths);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.db.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => opened.data.db.exec('UPDATE workspace SET active_document_id=900')).toThrow();
    expect(() => opened.data.db.exec('UPDATE workspace SET active_session_id=900')).toThrow();
    expect(() => opened.data.db.exec('UPDATE workspace SET active_job_id=900')).toThrow();
    expect(() => opened.data.db.exec('UPDATE workspace SET active_document_id=NULL')).toThrow();
    expect(() => opened.data.db.exec("INSERT INTO workspace(id,created_at,updated_at) VALUES(2,'created','updated')")).toThrow();
    expect(() => opened.data.db.exec('UPDATE workspace SET selection_json=\'not json\'')).toThrow();
    expect(() => opened.data.db.exec('UPDATE workspace SET selection_json=\'{"formatVersion":2}\'')).toThrow();
    for (const invalid of ['null', '[]', '1', '"text"', '{}', '{"formatVersion":null}'])
      expect(() => opened.data.db.query('UPDATE workspace SET selection_json=?').run(invalid)).toThrow();
    opened.data.db.query('UPDATE workspace SET selection_json=?').run(JSON.stringify({ formatVersion: 1,
      kind: 'source', target: 'document', targetId: 1, targetVersion: 'v1', artifactId: 2, page: 1 }));
    expect(opened.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
  });

  it('rolls back a failed copy of incompatible historical bytes', () => {
    const paths = fixturePaths(), db = schema13(paths);
    db.exec("INSERT INTO workspace(id,revision,created_at,updated_at) VALUES(1,9,'created','updated'); PRAGMA ignore_check_constraints=ON;");
    db.exec("UPDATE workspace SET selection_json='[]'; PRAGMA ignore_check_constraints=OFF;");
    const before = db.query('SELECT * FROM workspace').get(); db.close();
    expect(openTestDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile); deferCleanup(() => after.close());
    expect(after.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 });
    expect(after.query("SELECT name FROM sqlite_master WHERE name='workspace_p7'").get()).toBeNull();
  });

  it('rolls the replacement and marker back when final foreign_key_check finds an unrelated orphan', () => {
    const paths = fixturePaths(), db = schema13(paths);
    db.exec("INSERT INTO workspace(id,revision,created_at,updated_at) VALUES(1,9,'created','updated'); PRAGMA foreign_keys=OFF;");
    db.exec("INSERT INTO jobs(id,document_id,goal,input_json,created_at,updated_at) VALUES(1,900,'Orphan','{}','created','updated'); PRAGMA foreign_keys=ON;");
    const before = db.query('SELECT * FROM workspace').get(); db.close();
    expect(openTestDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile); deferCleanup(() => after.close());
    expect(after.query('SELECT * FROM workspace').get()).toEqual(before);
    expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 });
    expect(after.query("SELECT name FROM sqlite_master WHERE name='workspace_p7'").get()).toBeNull();
  });

  it.each(['gap', 'higher'] as const)('rejects the unsupported %s version sequence', kind => {
    const paths = fixturePaths(), db = schema13(paths);
    if (kind === 'gap') db.exec('DELETE FROM schema_migrations WHERE version=7');
    else db.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(14,'fixture'),(15,'fixture'),(16,'fixture'),(17,'fixture')");
    const before = db.query('SELECT * FROM schema_migrations ORDER BY version').all(); db.close();
    expect(openTestDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_schema_unsupported' } });
    const after = new Database(paths.databaseFile); deferCleanup(() => after.close());
    expect(after.query('SELECT * FROM schema_migrations ORDER BY version').all()).toEqual(before);
  });

  it('rolls back table copy when schema registration fails', () => {
    const paths = fixturePaths();
    const db = schema13(paths);
    db.exec("INSERT INTO workspace(id,active_view,revision,created_at,updated_at) VALUES(1,'candidate',5,'created','updated')");
    const before = db.query('SELECT * FROM workspace').get();
    db.exec("CREATE TRIGGER reject_schema14 BEFORE INSERT ON schema_migrations WHEN NEW.version=14 BEGIN SELECT RAISE(ABORT,'fixture'); END");
    db.close();
    expect(openTestDatabase(paths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(paths.databaseFile);
    try {
      expect(after.query('SELECT * FROM workspace').get()).toEqual(before);
      expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 13 });
      expect(after.query("SELECT name FROM sqlite_master WHERE name='workspace_p7'").get()).toBeNull();
    } finally { after.close(); }
  });
});
