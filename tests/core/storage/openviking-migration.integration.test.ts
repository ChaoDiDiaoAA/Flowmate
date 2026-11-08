import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';

const at = '2026-11-07T00:00:00.000Z';

test('schema 27 keeps existing Sessions and a waiting invoice phase while memory defaults off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-ov-migration-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') };
  mkdirSync(dirname(paths.databaseFile), { recursive: true });
  const old = new Database(paths.databaseFile);
  deferCleanup(() => old.close());
  old.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../../../packages/core/src/storage/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 26).sort()) {
    const version = Number(name.slice(0, 3));
    if ([17, 21, 23].includes(version)) old.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
    for (const sql of readFileSync(new URL(name, directory), 'utf8').split(/^\s*-- statement\s*$/m).filter(value => value.trim())) old.exec(sql);
    if (old.inTransaction) old.exec('COMMIT');
    if ([10, 17, 21, 23].includes(version)) old.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF');
  }
  old.query("INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,'original-chat','Chat',?,?)").run(at, at);
  old.query("INSERT INTO sessions(id,runtime_kind,native_session_id,durable_conversation_id,title,created_at,updated_at) VALUES(2,'durable',NULL,17,'Work',?,?)").run(at, at);
  old.query("INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(1,'original','a',1,'image/png','{}',?),(2,'parsed','b',1,'application/json','{}',?)").run(at, at);
  old.query("INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at) VALUES(1,'fixture','fixture','v1',1,2,'available','{}',?,?)").run(at, at);
  old.query("INSERT INTO personal_agents(id,revision,configuration_json,created_at,updated_at) VALUES(1,0,'{}',?,?)").run(at, at);
  old.query("INSERT INTO invoice_works(id,personal_agent_id,session_id,agent_revision,configuration_json,budget_json,goal,status,created_at,updated_at) VALUES(1,1,2,0,'{}','{}','Original work','open',?,?)").run(at, at);
  old.query("INSERT INTO invoice_work_items(id,work_id,document_id,document_version,updated_at) VALUES(1,1,1,'v1',?)").run(at);
  old.query("INSERT INTO invoice_work_operations(personal_agent_id,work_id,kind,request_id,request_json,receipt_json,received_at) VALUES(1,1,'create','original','{}','{}',?)").run(at);
  old.query("INSERT INTO invoice_work_attempts(id,work_id,trigger_kind,trigger_request_id,created_at) VALUES(1,1,'create','original',?)").run(at);
  old.query("INSERT INTO invoice_work_phases(id,work_id,attempt_id,item_id,request_id,kind,basis_json,native_conversation_id,native_submission_id,durable_runtime_id,scheduler_state,created_at) VALUES(1,1,1,1,'original-phase','prompt','{}',17,101,'local','waiting_approval',?)").run(at);
  old.query("INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(1,1,'prompt','answer','{\"version\":1}','failed','failed',?,?)").run(at, at);
  const sessions = old.query('SELECT * FROM sessions ORDER BY id').all();
  const phase = old.query('SELECT * FROM invoice_work_phases WHERE id=1').get();
  old.close();
  const opened = openTestDatabase(paths);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.error.code);
  try {
    expect(opened.data.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 30 });
    expect(opened.data.db.query('SELECT * FROM sessions ORDER BY id').all()).toEqual(sessions);
    expect(opened.data.db.query('SELECT * FROM invoice_work_phases WHERE id=1').get()).toEqual(phase);
    expect(opened.data.db.query('SELECT provider,recall_enabled,capture_mode FROM memory_config WHERE id=1').get())
      .toEqual({ provider: 'native', recall_enabled: 0, capture_mode: 'off' });
    expect(opened.data.db.query('SELECT runtime_kind,session_id,work_id,item_id,provider FROM memory_bindings ORDER BY session_id').all()).toEqual([
      { runtime_kind: 'agent_session', session_id: 1, work_id: null, item_id: null, provider: 'native' },
      { runtime_kind: 'durable', session_id: 2, work_id: 1, item_id: 1, provider: 'native' },
    ]);
    expect(opened.data.db.query(`SELECT i.session_id,b.branch,b.provider FROM memory_input_bindings m
      JOIN session_inputs i ON i.id=m.input_id JOIN memory_bindings b ON b.id=m.binding_id`).all())
      .toEqual([{ session_id: 1, branch: 0, provider: 'native' }]);
    expect(opened.data.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { await opened.data.close(); }
});

test('an input cannot be attached to a different memory branch of the same Session', async () => {
  const store = newStore();
  try {
    store.db.query(`INSERT INTO memory_bindings(id,runtime_kind,session_id,branch,provider,identity_id,remote_session_id,endpoint,remote_state,created_at)
      VALUES(1,'agent_session',1,0,'openviking',1,'remote-one','http://127.0.0.1:19338','pending',?),
        (2,'agent_session',1,1,'openviking',1,'remote-two','http://127.0.0.1:19338','pending',?)`).run(at, at);
    store.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(5,1,1,'prompt','answer','{\"version\":1}','queued','pending',?,?)").run(at, at);
    store.db.query('INSERT INTO memory_input_bindings(input_id,binding_id) VALUES(5,1)').run();
    expect(() => store.db.query("INSERT INTO memory_recalls(binding_id,input_id,status,created_at) VALUES(2,5,'empty',?)").run(at)).toThrow();
    expect(() => store.db.query("INSERT INTO memory_sync(binding_id,input_id,state,source_json,created_at,updated_at) VALUES(2,5,'pending','{}',?,?)").run(at, at)).toThrow();
    expect(() => store.db.query(`INSERT INTO memory_remember_requests(identity_id,binding_id,input_id,request_id,uri,content,scope_kind,scope_id,state,created_at,updated_at)
      VALUES(1,2,5,'request','viking://user/user/memories/a.md','fact','session','1','pending',?,?)`).run(at, at)).toThrow();
    expect(await store.transaction(scope => scope.memoryIntegration.bindSessionInput({ sessionId: 2, inputId: 5, bindingId: 1 }))).toMatchObject({ ok: false });
  } finally { await store.close(); }
});

function newStore() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-ov-owner-'));
  const result = openTestDatabase({ root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    outputsDir: join(root, 'outputs'), runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs') });
  if (!result.ok) throw new Error(result.error.code);
  const store = result.data;
  store.db.query("INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,'one','One',?,?),(2,'two','Two',?,?)").run(at, at, at, at);
  store.db.query("INSERT INTO memory_identities(id,environment,owner_id,account_id,user_id,peer_id,credential_ref,state,created_at,updated_at) VALUES(1,'local','owner','account','user','peer','synthetic-reference','active',?,?)").run(at, at);
  return store;
}

test('an OpenViking binding cannot omit its original remote Session identity', async () => {
  const store = newStore();
  try {
    expect(() => store.db.query("INSERT INTO memory_bindings(runtime_kind,session_id,provider,identity_id,remote_session_id,created_at) VALUES('agent_session',1,'openviking',1,NULL,?)").run(at)).toThrow();
  } finally { await store.close(); }
});

test('memory snapshots and synchronization cannot attach another Session input', async () => {
  const store = newStore();
  try {
    store.db.query("INSERT INTO memory_bindings(id,runtime_kind,session_id,provider,identity_id,remote_session_id,endpoint,remote_state,created_at) VALUES(1,'agent_session',1,'openviking',1,'remote-one','http://127.0.0.1:19338','pending',?)").run(at);
    store.db.query("INSERT INTO session_inputs(id,session_id,client_sequence,mode,goal_mode,content_json,status,processing_status,created_at,updated_at) VALUES(5,2,1,'prompt','answer','{\"version\":1}','queued','pending',?,?)").run(at, at);
    expect(() => store.db.query("INSERT INTO memory_recalls(binding_id,input_id,status,created_at) VALUES(1,5,'empty',?)").run(at)).toThrow();
    expect(() => store.db.query("INSERT INTO memory_sync(binding_id,input_id,state,source_json,created_at,updated_at) VALUES(1,5,'pending','{}',?,?)").run(at, at)).toThrow();
  } finally { await store.close(); }
});
