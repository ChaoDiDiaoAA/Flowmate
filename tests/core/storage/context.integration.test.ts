import { saveTestHistory } from '../../support/history.ts';
import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { createContextRepository } from '../../../packages/core/src/context/repository.ts';
import { ContextSnapshotJsonSchema, ContextSnapshotResultSchema, ContextRequestsResultSchema, invoiceHeaderFields } from '@flowmate/contracts';
import type { ContextSnapshotJson, RequestContextBinding, NativeSessionHistory, Result } from '@flowmate/contracts';

const at = '2026-10-03T00:00:00.000Z';
const later = '2026-10-03T00:00:01.000Z';
const failure = { code: 'agent_execution_failed', category: 'runtime', message: 'fixture', retryable: false };
const delivery = { version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null };
const toolCleanup = { version: 1, stopped: false, stopReason: null, errors: [] };
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
function paths() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p8-storage-'));
  return { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs') };
}
function schema14(productPaths: ReturnType<typeof paths>, through = 14) {
  mkdirSync(dirname(productPaths.databaseFile), { recursive: true });
  const db = new Database(productPaths.databaseFile);
  db.exec('PRAGMA foreign_keys=ON');
  const names = ['001_provider','002_agent_sessions','003_invoice_tools','004_parsed_documents','005_native_session_history',
    '006_hidden_processing','007_hidden_chats_invoices','008_native_entry_runs','009_session_inputs','010_human_candidates',
    '011_session_management','012_tool_runtime_observations','013_runtime_events','014_workspace_selection'];
  for (const [index, name] of names.slice(0,through).entries()) {
    const sql = readFileSync(new URL(`../../../packages/core/src/storage/migrations/${name}.sql`, import.meta.url), 'utf8');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) db.exec(statement);
    if ([4,10,11,14].includes(index + 1)) db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys=ON');
  }
  return db;
}
function seedOldInputs(db: Database) {
  db.query("INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(1,'old','Old',?,?)").run(at,at);
  db.query(`INSERT INTO runs(id,kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,ended_at,error_json)
    VALUES(1,'agent',1,'{"version":1}','failed','old','{"old":"input"}','{"old":"config"}','{}','{}',?,?,'{}')`).run(at,at);
  for (const version of [1,2]) db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,
    content_json,status,processing_status,created_at,updated_at) VALUES(1,?,'prompt','answer',?,1,?,'failed','failed',?,?)`)
    .run(version,'b'.repeat(64),JSON.stringify({version,promptText:'old\\n"prompt',text:'Old input'}),at,at);
}
function finish(f: ReturnType<typeof fixture>) {
  f.store.db.query("UPDATE runs SET status='failed',ended_at=?,error_json=? WHERE id=?").run(at,JSON.stringify(failure),f.runId);
}
function legacyRun(f: ReturnType<typeof fixture>, nativeSessionId = f.session.nativeSessionId, sessionId = f.session.sessionId) {
  const { contextPolicyVersion: _policy, ...config } = f.config;
  config.agent = { ...config.agent,nativeSessionId };
  const inserted = f.store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,
    created_at,ended_at,error_json) SELECT 'agent',?,scope_json,'failed',goal,input_json,?,cleanup_json,usage_json,?,?,? FROM runs WHERE id=?`)
    .run(sessionId,JSON.stringify(config),at,at,JSON.stringify(failure),f.runId);
  return Number(inserted.lastInsertRowid);
}
function tool(f: ReturnType<typeof fixture>, nativeId: string, snapshotId: number | null, sequence: number | null, runId=f.runId) {
  return Number(f.store.db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,
    delivery_json,cleanup_json,requested_at,context_snapshot_id,request_sequence) VALUES(?,? ,?,'read_fixture','1','READ',?,?,?,?,?,?)`)
    .run(runId,f.session.sessionId,nativeId,JSON.stringify({version:1,raw:{},final:null}),JSON.stringify(delivery),JSON.stringify(toolCleanup),at,snapshotId,sequence).lastInsertRowid);
}
function business(f: ReturnType<typeof fixture>) {
  f.store.db.query("INSERT INTO artifacts(id,kind,relative_path,bytes,mime_type,metadata_json,created_at) VALUES(1,'original','a',1,'image/png','{}',?),(2,'parsed','b',1,'application/json','{}',?)").run(at,at);
  f.store.db.query(`INSERT INTO documents(id,source_key,source_record_id,version,original_artifact_id,parsed_artifact_id,status,metadata_json,created_at,updated_at)
    VALUES(1,'fixture','fixture','v1',1,2,'available','{}',?,?)`).run(at,at);
  f.store.db.query("INSERT INTO jobs(id,document_id,goal,input_json,created_at,updated_at) VALUES(1,1,'fixture','{}',?,?),(2,1,'other','{}',?,?)").run(at,at,at,at);
  return 1;
}
function persistLegacyTools(f: ReturnType<typeof fixture>, owner: number, nativeId='old-call') {
  const usage = { input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
  const history: NativeSessionHistory = { storageVersion:1,header:{type:'session',version:3,id:f.session.nativeSessionId,timestamp:at,cwd:f.productPaths.root},
    entries:[{type:'message',id:'old-assistant',parentId:null,timestamp:at,message:{role:'assistant',content:[{type:'toolCall',id:nativeId,name:'read_fixture',arguments:{}}],
      api:'openai-responses',provider:'fixture',model:'fixture',usage,stopReason:'toolUse',timestamp:1}},
      {type:'message',id:'old-result',parentId:'old-assistant',timestamp:at,message:{role:'toolResult',toolCallId:nativeId,toolName:'read_fixture',
        content:[{type:'text',text:'legacy result'}],isError:false,timestamp:2}}],leafId:'old-result',unusable:false };
  need(saveTestHistory(f.store.db, f.store.runtimeEventStore, f.session.sessionId,history));
  f.store.db.query('UPDATE session_native_entries SET run_id=? WHERE session_id=?').run(owner,f.session.sessionId);
  return history;
}
function json(text = 'Explain this input.'): ContextSnapshotJson {
  return ContextSnapshotJsonSchema.parse({ version: 1, policyVersion: 'p8-context-v1', text, goalMode: 'answer',
    workingDirectory: null, workspaceContext: null, allowedDocumentIds: [], allowedArtifactIds: [], resourcePolicy: 'none',
    modelProjection: { taskGoal: 'Explain', candidate: null, fragments: [], issues: [], gaps: [] },
    budgets: { projectionBytes: 65536, fragmentBytes: 4096, fragments: 32, issueCount: 20, snapshotBytes: 262144 } });
}
function fixture() {
  const productPaths = paths();
  const store = need(openTestDatabase(productPaths));
  const session = need(store.sessions.create({ nativeSessionId: 'p8-native', title: 'P8 fixture', at }));
  const config = { version: 1, name: 'fixture', revision: 1, requestedModel: { provider: 'fixture', model: 'fixture' },
    resolvedModel: null, api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 }, limits: { timeoutMs: 1000, stopGraceMs: 100 },
    native: { authSource: 'unknown', modelsSelection: null }, contextPolicyVersion: 'p8-context-v1',
    agent: { policyVersion: 'p2-invoice-chat-v1', nativeSessionId: session.nativeSessionId, systemPrompt: 'fixture',
      thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only', maxContextBytes: 524288,
      maxOutputBytes: 262144, maxAssistantContentBytes: 524288, maxModelCalls: 1, sessionRetry: false } };
  store.db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,
    context_observations_json,created_at) VALUES('agent',?,'{"version":1,"mode":"chat-text","toolNames":[],"resourcePaths":[]}', 'running','Explain',?,?,?,?,'{"version":1,"requests":[]}',?)`)
    .run(session.sessionId, JSON.stringify({ version: 1, goal: 'Explain', text: 'Explain this input.', messageTimestamp: 1 }),
      JSON.stringify(config), JSON.stringify({ version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false }),
      JSON.stringify({ version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: null, attemptsComplete: false,
        costSource: null, updatedAt: at }), at);
  const runId = Number((store.db.query('SELECT MAX(id) AS id FROM runs').get() as { id: number }).id);
  function append(text = 'Explain this input.', sequence = 1) {
    return store.runtimeEventStore.withTransaction(() => {
      const jobId=(store.db.query('SELECT job_id FROM runs WHERE id=?').get(runId) as {job_id:number|null}).job_id;
      const snapshot = need(store.context.appendInTransaction({ runId, sessionId: session.sessionId, jobId, json: json(text), at }));
      const content = { version: 2, text, workspaceContext: null, workspaceInput: null,
        allowedDocumentIds: [], allowedArtifactIds: [], promptText: text };
      const inserted = store.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,
        context_snapshot_id,content_json,status,processing_status,created_at,updated_at)
        VALUES(?,?,'prompt','answer',?,?,?,?,'queued','pending',?,?)`)
        .run(session.sessionId, sequence, 'a'.repeat(64), runId, snapshot.id, JSON.stringify(content), at, at);
      return { snapshot, inputId: Number(inserted.lastInsertRowid), content };
    });
  }
  function consume(inputId: number, text: string, entryId = 'p8-user') {
    const history: NativeSessionHistory = { storageVersion: 1,
      header: { type: 'session', version: 3, id: session.nativeSessionId, timestamp: at, cwd: productPaths.root },
      entries: [{ type: 'message', id: entryId, parentId: null, timestamp: at,
        message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } }],
      leafId: entryId, unusable: false };
    need(saveTestHistory(store.db, store.runtimeEventStore, session.sessionId, history, { runId, entryId, inputId }));
    return history;
  }
  function binding(inputId: number, snapshotId: number): RequestContextBinding {
    return { runId, sessionId: session.sessionId, nativeSessionId: session.nativeSessionId, requestSequence: 1, callSequence: 1,
      inputId, snapshotId, includedBindings: [{ originRunId: runId, inputId, snapshotId, nativeEntryId: 'p8-user' }],
      includedToolResults: [], includedNativeContexts: [] };
  }
  return { store, session, runId, config, append, consume, binding, productPaths };
}
describe('P8 Context storage', () => {
  it('migrates real 014 without rewriting legacy evidence and installs all guards', () => {
    const productPaths = paths(), old = schema14(productPaths);
    seedOldInputs(old);
    const before = old.query('SELECT content_json,request_hash FROM session_inputs ORDER BY id').all();
    old.close();
    const migrated = need(openTestDatabase(productPaths));
    expect(migrated.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
    expect(migrated.db.query('SELECT content_json,request_hash FROM session_inputs ORDER BY id').all()).toEqual(before);
    expect(migrated.db.query('SELECT current_context_snapshot_id,context_observations_json FROM runs').all())
      .toEqual([{ current_context_snapshot_id: null, context_observations_json: null }]);
    expect(migrated.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'context_%'").all()).toHaveLength(13);
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('rolls back every whole 015 statement and registration failure', () => {
    const source = readFileSync(new URL('../../../packages/core/src/storage/migrations/015_context_snapshots.sql', import.meta.url), 'utf8');
    const statements = source.split(/^\s*-- statement\s*$/m).map(part => part.trim()).filter(Boolean);
    for (const [target, statement] of statements.entries()) {
      const productPaths = paths(), old = schema14(productPaths);
      seedOldInputs(old);
      const before = old.query("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const oldInputs = old.query('SELECT * FROM session_inputs ORDER BY id').all();
      const oldRuns = old.query('SELECT * FROM runs ORDER BY id').all();
      old.close();
      const realExec = Database.prototype.exec;
      let hits = 0;
      const injected = spyOn(Database.prototype, 'exec').mockImplementation(function(this: Database, sql: string) {
        if (sql.trim() === statement) { hits++; throw new Error(`injected015:${target}`); }
        return realExec.call(this, sql);
      });
      try { expect(openTestDatabase(productPaths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } }); }
      finally { injected.mockRestore(); }
      expect(hits).toBe(1);
      const after = new Database(productPaths.databaseFile); deferCleanup(() => after.close());
      expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 14 });
      expect(after.query("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual(before);
      expect(after.query('SELECT * FROM session_inputs ORDER BY id').all()).toEqual(oldInputs);
      expect(after.query('SELECT * FROM runs ORDER BY id').all()).toEqual(oldRuns);
      expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
    }
    const productPaths = paths(), old = schema14(productPaths);
    old.exec("CREATE TRIGGER reject15 BEFORE INSERT ON schema_migrations WHEN NEW.version=15 BEGIN SELECT RAISE(ABORT,'injected'); END");
    old.close();
    expect(openTestDatabase(productPaths)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } });
    const after = new Database(productPaths.databaseFile); deferCleanup(() => after.close());
    expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 14 });
    expect(after.query("SELECT name FROM sqlite_master WHERE name='context_snapshots'").get()).toBeNull();
  });
  it('rolls 015 back before COMMIT when the real final foreign_key_check reports an orphan', () => {
    const productPaths=paths(),old=schema14(productPaths);
    old.exec('PRAGMA foreign_keys=OFF');
    old.query("INSERT INTO jobs(id,document_id,goal,input_json,created_at,updated_at) VALUES(1,999,'orphan','{}',?,?)").run(at,at);
    old.exec('PRAGMA foreign_keys=ON');
    const before=old.query("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const originalFk=old.query('PRAGMA foreign_key_check').all(); expect(originalFk).toHaveLength(1); old.close();
    expect(openTestDatabase(productPaths)).toMatchObject({ok:false,error:{code:'storage_open_failed'}});
    const after=new Database(productPaths.databaseFile); deferCleanup(()=>after.close());
    expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({version:14});
    expect(after.query("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual(before);
    expect(after.query('PRAGMA foreign_key_check').all()).toEqual(originalFk);
  });
  it('rolls 015 back when its final COMMIT fails', () => {
    const productPaths=paths(),old=schema14(productPaths); seedOldInputs(old);
    const before=old.query('SELECT * FROM session_inputs ORDER BY id').all(); old.close();
    const realExec=Database.prototype.exec;
    const injected=spyOn(Database.prototype,'exec').mockImplementation(function(this:Database,sql:string){
      if(sql==='COMMIT') throw new Error('commit injection'); return realExec.call(this,sql);
    });
    try { expect(openTestDatabase(productPaths)).toMatchObject({ok:false,error:{code:'storage_open_failed'}}); }
    finally { injected.mockRestore(); }
    const after=new Database(productPaths.databaseFile); deferCleanup(()=>after.close());
    expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({version:14});
    expect(after.query('SELECT * FROM session_inputs ORDER BY id').all()).toEqual(before);
    expect(after.query("SELECT name FROM sqlite_master WHERE name='context_snapshots'").get()).toBeNull();
    expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('appends only in a transaction and rolls back failed pointers without committing failed Results', () => {
    const f = fixture();
    expect(f.store.context.appendInTransaction({ runId: f.runId, sessionId: f.session.sessionId, jobId: null, json: json(), at }).ok).toBe(false);
    f.store.db.exec("CREATE TRIGGER reject_pointer BEFORE UPDATE OF current_context_snapshot_id ON runs BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => f.append()).toThrow();
    expect(f.store.runtimeEventStore.withTransaction(() => f.store.context.appendInTransaction({runId:f.runId,sessionId:f.session.sessionId,jobId:null,json:json(),at})).ok).toBe(false);
    expect(f.store.db.query('SELECT COUNT(*) AS count FROM context_snapshots').get()).toEqual({ count: 0 });
    expect(f.store.db.query('SELECT current_context_snapshot_id FROM runs').get()).toEqual({ current_context_snapshot_id: null });
    f.store.db.exec('DROP TRIGGER reject_pointer');
    const saved = f.append();
    expect(need(f.store.sessionInputs.get(saved.inputId))?.contextSnapshotId).toBe(saved.snapshot.id);
    expect(need(f.store.runs.get(f.runId)).currentContextSnapshotId).toBe(saved.snapshot.id);
    expect(() => f.store.db.exec('UPDATE context_snapshots SET created_at=created_at')).toThrow('context_snapshot_immutable');
    expect(() => f.store.db.exec('UPDATE session_inputs SET context_snapshot_id=NULL')).toThrow('context_binding_immutable');
    expect(() => f.store.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,
      context_snapshot_id,content_json,created_at,updated_at) VALUES(?,2,'steer','answer',?,?,?,'{}',?,?)`)
      .run(f.session.sessionId,'b'.repeat(64),f.runId,saved.snapshot.id,at,at)).toThrow();
  });
  it.each(['input','event'] as const)('rolls the complete admission back after a later %s rejection', kind => {
    const f=fixture();
    f.store.db.exec(kind==='input'
      ? "CREATE TRIGGER reject_input BEFORE INSERT ON session_inputs BEGIN SELECT RAISE(ABORT,'injected input'); END"
      : "CREATE TRIGGER reject_event BEFORE INSERT ON runtime_events BEGIN SELECT RAISE(ABORT,'injected event'); END");
    expect(() => f.store.runtimeEventStore.withTransaction(() => {
      const saved=f.append();
      f.store.runtimeEventStore.appendInTransaction({runId:f.runId,sessionId:f.session.sessionId,toolCallId:null,type:'input_state_changed',occurredAt:at,
        dedupeKey:`input:${saved.inputId}:queued:pending:none:none`,payload:{version:1,origin:'live',inputId:saved.inputId,status:'queued',processingStatus:'pending',nativeEntryId:null,resultEntryId:null,errorCode:null}});
    })).toThrow(kind==='input'?'injected input':'injected event');
    for (const name of ['context_snapshots','session_inputs','runtime_events']) expect(f.store.db.query(`SELECT COUNT(*) AS count FROM ${name}`).get()).toEqual({count:0});
    expect(f.store.db.query('SELECT current_context_snapshot_id FROM runs').get()).toEqual({current_context_snapshot_id:null});
  });
  it('guards NULL Job ownership, all immutable bindings and Tool/Candidate pairs with actual SQL', () => {
    const f=fixture(), jobId=business(f);
    f.store.db.query('UPDATE runs SET job_id=? WHERE id=?').run(jobId,f.runId);
    const savedInput=f.append(), saved=savedInput.snapshot;
    f.consume(savedInput.inputId,savedInput.content.text);
    need(f.store.context.bindRequest({binding:f.binding(savedInput.inputId,saved.id),api:'openai-responses',transport:'observed-fetch',at}));
    const other=need(f.store.sessions.create({nativeSessionId:'guard-other',title:'Other',at}));
    const old=legacyRun(f), otherRun=legacyRun(f,other.nativeSessionId,other.sessionId);
    f.store.db.query('UPDATE runs SET job_id=1 WHERE id=?').run(old);
    for (const [sessionId,runId,job] of [[f.session.sessionId,f.runId,null],[f.session.sessionId,f.runId,2],[other.sessionId,f.runId,jobId],[f.session.sessionId,otherRun,null]])
      expect(() => f.store.db.query('INSERT INTO context_snapshots(session_id,run_id,job_id,sequence,snapshot_json,created_at) VALUES(?,?,?,99,?,?)')
        .run(sessionId!,runId!,job!,JSON.stringify(json()),at)).toThrow();
    expect(() => f.store.db.query('UPDATE runs SET current_context_snapshot_id=? WHERE id=?').run(saved.id,otherRun)).toThrow('context_identity_invalid');
    expect(() => f.store.db.query('UPDATE runs SET job_id=NULL WHERE id=?').run(f.runId)).toThrow('context_identity_invalid');
    for (const pair of [[null,null],[saved.id,null],[null,1],[saved.id,0],[saved.id,9007199254740992]]) expect(() => tool(f,`bad-${String(pair)}`,pair[0]!,pair[1]!)).toThrow();
    const call=tool(f,'p8-paired',saved.id,1);
    expect(need(f.store.toolCalls.getById(call)).context).toEqual({snapshotId:saved.id,requestSequence:1});
    expect(() => f.store.db.query('UPDATE tool_calls SET request_sequence=2 WHERE id=?').run(call)).toThrow('context_binding_immutable');
    expect(() => f.store.db.query('UPDATE tool_calls SET run_id=? WHERE id=?').run(otherRun,call)).toThrow();
    const legacyCall=tool(f,'legacy-pair',null,null,old);
    expect(need(f.store.toolCalls.getById(legacyCall)).context).toBeNull();
    expect(() => f.store.db.query('UPDATE tool_calls SET context_snapshot_id=?,request_sequence=1 WHERE id=?').run(saved.id,legacyCall)).toThrow();
    const insertCandidate=(origin:string,runId:number|null,toolId:number|null,sequence:number,snapshotId:number|null,requestSequence:number|null,base:number|null=null) =>
      f.store.db.query(`INSERT INTO invoice_candidates(job_id,run_id,tool_call_id,sequence,origin,based_on_candidate_id,fields_json,lines_json,issues_json,
        created_at,context_snapshot_id,request_sequence) VALUES(1,?,?,?,?,?,'{}','{}','{}',?,?,?)`).run(runId,toolId,sequence,origin,base,at,snapshotId,requestSequence);
    expect(() => insertCandidate('model',f.runId,call,1,null,null)).toThrow('context_identity_invalid');
    expect(() => insertCandidate('model',f.runId,call,1,saved.id,2)).toThrow('context_identity_invalid');
    expect(() => insertCandidate('model',f.runId,legacyCall,1,saved.id,1)).toThrow();
    const candidate=Number(insertCandidate('model',f.runId,call,1,saved.id,1).lastInsertRowid);
    const fields=Object.fromEntries(invoiceHeaderFields.map(name=>[name,{raw:null,normalized:null,state:'missing',alternatives:[],sources:[]} ]));
    f.store.db.query('UPDATE invoice_candidates SET fields_json=?,lines_json=?,issues_json=? WHERE id=?')
      .run(JSON.stringify({version:1,values:fields}),JSON.stringify({version:1,items:[]}),JSON.stringify({version:1,notes:[],checks:[],items:[]}),candidate);
    expect(need(f.store.candidates.readByJob({jobId,candidateId:candidate})).candidate.context).toEqual({snapshotId:saved.id,requestSequence:1});
    expect(() => f.store.db.query('UPDATE invoice_candidates SET request_sequence=2 WHERE id=?').run(candidate)).toThrow();
    expect(() => f.store.db.query('UPDATE invoice_candidates SET job_id=2 WHERE id=?').run(candidate)).toThrow();
    expect(() => insertCandidate('human_edit',null,null,2,saved.id,1,candidate)).toThrow();
    insertCandidate('human_edit',null,null,2,null,null,candidate);
    insertCandidate('model',old,legacyCall,3,null,null);
    expect(f.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('refuses safe-sequence exhaustion and oversized journal without changing saved bytes', () => {
    const f=fixture();
    f.store.db.query('INSERT INTO context_snapshots(run_id,session_id,job_id,sequence,snapshot_json,created_at) VALUES(?,?,NULL,?,?,?)')
      .run(f.runId,f.session.sessionId,Number.MAX_SAFE_INTEGER,JSON.stringify(json()),at);
    expect(f.store.runtimeEventStore.withTransaction(() => f.store.context.appendInTransaction({runId:f.runId,sessionId:f.session.sessionId,jobId:null,json:json(),at})))
      .toMatchObject({ok:false,error:{code:'context_evidence_too_large'}});
    expect(f.store.db.query('SELECT COUNT(*) AS count FROM context_snapshots').get()).toEqual({count:1});
    const original=f.store.db.query('SELECT context_observations_json FROM runs').get();
    expect(() => f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify({version:1,requests:[],padding:'x'.repeat(4194304)}),f.runId)).toThrow();
    expect(f.store.db.query('SELECT context_observations_json FROM runs').get()).toEqual(original);
  });
  it('reports snapshot byte overflow before writing any partial evidence', () => {
    const f=fixture(),oversized={...json(),text:'\u0001'.repeat(50000)};
    expect(f.store.runtimeEventStore.withTransaction(()=>f.store.context.appendInTransaction({runId:f.runId,sessionId:f.session.sessionId,jobId:null,json:oversized,at})))
      .toMatchObject({ok:false,error:{code:'context_evidence_too_large'}});
    expect(f.store.db.query('SELECT COUNT(*) AS count FROM context_snapshots').get()).toEqual({count:0});
  });
  it('distinguishes invalid requests, missing Run, SQLite read failure and corrupt saved JSON', () => {
    const f=fixture();
    expect(f.store.context.listContextSnapshots({sessionId:f.session.sessionId,limit:21})).toMatchObject({ok:false,error:{code:'input_invalid'}});
    expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:999})).toMatchObject({ok:false,error:{code:'run_not_found',category:'runtime'}});
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run('{"version":1}',f.runId);
    expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId})).toMatchObject({ok:false,error:{code:'storage_corrupt'}});
    f.store.db.exec('DROP TABLE context_snapshots');
    expect(f.store.context.listContextSnapshots({sessionId:f.session.sessionId})).toMatchObject({ok:false,error:{code:'storage_read_failed',retryable:true}});
  });
  it('rejects arbitrary contextPolicyVersion and strictly pairs journal with the policy marker', () => {
    const f=fixture();
    for (const value of ['p8-other',null,1,{}]) {
      f.store.db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify({...f.config,contextPolicyVersion:value}),f.runId);
      expect(f.store.runs.get(f.runId).ok).toBe(false);
      expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId})).toMatchObject({ok:false,error:{code:'storage_corrupt'}});
    }
    f.store.db.query('UPDATE runs SET config_json=?,context_observations_json=NULL WHERE id=?').run(JSON.stringify(f.config),f.runId);
    expect(f.store.runs.get(f.runId).ok).toBe(false);
    const {contextPolicyVersion:_policy,...old}=f.config;
    f.store.db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify(old),f.runId);
    expect(need(f.store.runs.get(f.runId)).currentContextSnapshotId).toBeNull();
    expect(need(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId}))).toMatchObject({collection:'not-collected',items:[]});
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run('{"version":1,"requests":[]}',f.runId);
    expect(f.store.runs.get(f.runId).ok).toBe(false);
  });
  it('strict readers reject orphaned P8 Tool/Candidate requests and forged Run pointers', () => {
    const f=fixture(),saved=f.append(),call=tool(f,'unbound-call',saved.snapshot.id,1);
    expect(f.store.toolCalls.getById(call)).toMatchObject({ok:false,error:{code:'storage_corrupt'}});
    const other=legacyRun(f);
    f.store.db.query('INSERT INTO context_snapshots(run_id,session_id,job_id,sequence,snapshot_json,created_at) VALUES(?,?,NULL,1,?,?)')
      .run(other,f.session.sessionId,JSON.stringify(json()),at);
    const foreignSnapshot=(f.store.db.query('SELECT MAX(id) AS id FROM context_snapshots').get() as {id:number}).id;
    f.store.db.exec('DROP TRIGGER context_run_update_guard');
    f.store.db.query('UPDATE runs SET current_context_snapshot_id=? WHERE id=?').run(foreignSnapshot,f.runId);
    expect(f.store.runs.get(f.runId)).toMatchObject({ok:false,error:{code:'storage_corrupt'}});
    f.store.db.exec('DROP TRIGGER context_input_immutable_guard; DROP TRIGGER context_input_owner_guard');
    f.store.db.query('UPDATE session_inputs SET context_snapshot_id=? WHERE id=?').run(foreignSnapshot,saved.inputId);
    expect(f.store.sessionInputs.get(saved.inputId).ok).toBe(false);
  });
  it('refuses a structurally valid journal whose primary snapshot was never saved', () => {
    const f=fixture(),saved=f.append(); f.consume(saved.inputId,saved.content.text);
    const binding={...f.binding(saved.inputId,saved.snapshot.id),snapshotId:999,
      includedBindings:[{originRunId:f.runId,inputId:saved.inputId,snapshotId:999,nativeEntryId:'p8-user'}]};
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify({version:1,requests:[{binding,api:'openai-responses',
      boundAt:at,sdkPayload:null,transport:'not-observable',attempts:[]}]}),f.runId);
    expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId})).toMatchObject({ok:false,error:{code:'storage_corrupt'}});
    expect(f.store.runs.get(f.runId)).toMatchObject({ok:false,error:{code:'storage_corrupt'}});
  });
  it('rejects non-NULL legacy associations consistently in ledger, snapshot detail and list', () => {
    const f=fixture(),old=legacyRun(f);
    const snapshot=Number(f.store.db.query('INSERT INTO context_snapshots(run_id,session_id,job_id,sequence,snapshot_json,created_at) VALUES(?,?,NULL,1,?,?)')
      .run(old,f.session.sessionId,JSON.stringify(json()),at).lastInsertRowid);
    const content={version:2,text:json().text,workspaceContext:null,workspaceInput:null,allowedDocumentIds:[],allowedArtifactIds:[],promptText:json().text};
    const input=Number(f.store.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,context_snapshot_id,content_json,status,processing_status,created_at,updated_at)
      VALUES(?,1,'prompt','answer',?,?,?,?,'queued','pending',?,?)`).run(f.session.sessionId,'a'.repeat(64),old,snapshot,JSON.stringify(content),at,at).lastInsertRowid);
    expect(f.store.sessionInputs.get(input).ok).toBe(false);
    expect(f.store.context.queryContextSnapshot({sessionId:f.session.sessionId,runId:old,snapshotId:snapshot}))
      .toMatchObject({ok:false,error:{code:'storage_corrupt'}});
    expect(f.store.context.listContextSnapshots({sessionId:f.session.sessionId,runId:old}))
      .toMatchObject({ok:false,error:{code:'storage_corrupt'}});
  });
  it('retains the existing unique constraint for consumed native Input identity', () => {
    const f=fixture(),first=f.append(),second=f.append('Explain this input.',2); f.consume(first.inputId,first.content.text);
    expect(()=>f.store.db.query("UPDATE session_inputs SET status='consumed',native_entry_id='p8-user' WHERE id=?").run(second.inputId)).toThrow('UNIQUE constraint failed');
  });
  it.each(['foreign-user','changed-tool-context'] as const)('checks every saved request source on public read: %s', scenario => {
    const f=fixture(),saved=f.append(); f.consume(saved.inputId,saved.content.text);
    const binding=f.binding(saved.inputId,saved.snapshot.id);
    need(f.store.context.bindRequest({binding,api:'openai-responses',transport:'observed-fetch',at}));
    const changed:{-readonly [Key in keyof RequestContextBinding]:RequestContextBinding[Key]}=structuredClone(binding);
    if(scenario==='foreign-user') {
      const other=need(f.store.sessions.create({nativeSessionId:'foreign-source',title:'Other',at}));
      const otherRun=legacyRun(f,other.nativeSessionId,other.sessionId);
      const otherInput=Number(f.store.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,content_json,status,processing_status,created_at,updated_at)
        VALUES(?,1,'prompt','answer',?,?,?,'queued','pending',?,?)`).run(other.sessionId,'b'.repeat(64),otherRun,JSON.stringify(saved.content),at,at).lastInsertRowid);
      const history:NativeSessionHistory={storageVersion:1,header:{type:'session',version:3,id:other.nativeSessionId,timestamp:at,cwd:f.productPaths.root},
        entries:[{type:'message',id:'foreign-user',parentId:null,timestamp:at,message:{role:'user',content:saved.content.text,timestamp:1}}],leafId:'foreign-user',unusable:false};
      need(saveTestHistory(f.store.db, f.store.runtimeEventStore, other.sessionId,history,{runId:otherRun,inputId:otherInput,entryId:'foreign-user'}));
      changed.includedBindings=[{originRunId:otherRun,inputId:otherInput,snapshotId:null,nativeEntryId:'foreign-user'},...binding.includedBindings];
    } else {
      const call=tool(f,'changed-context',saved.snapshot.id,1);
      changed.includedToolResults=[{nativeToolCallId:'changed-context',toolCallId:call,originRunId:f.runId,context:{snapshotId:saved.snapshot.id,requestSequence:2}}];
    }
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify({version:1,requests:[{binding:changed,api:'openai-responses',
      boundAt:at,sdkPayload:null,transport:'observed-fetch',attempts:[]}]}),f.runId);
    expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId}))
      .toMatchObject({ok:false,error:{code:'storage_corrupt'}});
    if(scenario==='changed-tool-context') {
      f.store.db.exec('DROP TABLE tool_calls');
      expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId}))
        .toMatchObject({ok:false,error:{code:'storage_read_failed',retryable:true}});
    }
  });
  it('reads an original saved request after the native leaf moves to another legal branch', () => {
    const f=fixture(),saved=f.append(),history=f.consume(saved.inputId,saved.content.text);
    need(f.store.context.bindRequest({binding:f.binding(saved.inputId,saved.snapshot.id),api:'openai-responses',transport:'observed-fetch',at}));
    need(saveTestHistory(f.store.db, f.store.runtimeEventStore, f.session.sessionId,{...history,entries:[...history.entries,{type:'message',id:'alternate-user',parentId:null,timestamp:later,
      message:{role:'user',content:'another branch',timestamp:2}}],leafId:'alternate-user'}));
    expect(need(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId})).items[0]?.binding.snapshotId).toBe(saved.snapshot.id);
  });
  it('does not silently ignore a malformed duplicate legacy tool result on the legal path', () => {
    const f=fixture(),old=legacyRun(f),history=persistLegacyTools(f,old);
    const malformed={type:'message',id:'bad-duplicate',parentId:'old-result',timestamp:at,message:{role:'toolResult',toolCallId:'old-call'}};
    f.store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES(?,2,?,?,?)')
      .run(f.session.sessionId,malformed.id,JSON.stringify(malformed),old);
    f.store.db.query('UPDATE session_native_history SET leaf_id=?,entry_count=3 WHERE session_id=?').run(malformed.id,f.session.sessionId);
    expect(history.entries).toHaveLength(2);
    expect(f.store.context.resolveToolResult({sessionId:f.session.sessionId,nativeToolCallId:'old-call'}))
      .toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  });
  it.each(['before','after'] as const)('rejects complete duplicate assistant tool IDs %s the result even when only one tool name matches', position => {
    const f=fixture(),old=legacyRun(f),history=persistLegacyTools(f,old),another=legacyRun(f);
    const original=history.entries[0]!;
    const originalMessage=z.record(z.unknown()).parse(original.message);
    const duplicate={...original,id:'second-call',parentId:position==='before'?original.id:'old-result',message:{...originalMessage,
      content:[{type:'toolCall',id:'old-call',name:'different_tool',arguments:{}}]}};
    if(position==='before') f.store.db.query('UPDATE session_native_entries SET sequence=2,entry_json=? WHERE session_id=? AND entry_id=?')
      .run(JSON.stringify({...history.entries[1],parentId:duplicate.id}),f.session.sessionId,'old-result');
    f.store.db.query('INSERT INTO session_native_entries(session_id,sequence,entry_id,entry_json,run_id) VALUES(?,?,?,?,?)')
      .run(f.session.sessionId,position==='before'?1:2,duplicate.id,JSON.stringify(duplicate),another);
    f.store.db.query('UPDATE session_native_history SET leaf_id=?,entry_count=3 WHERE session_id=?').run(position==='before'?'old-result':duplicate.id,f.session.sessionId);
    const before=f.store.db.query('SELECT * FROM session_native_entries ORDER BY sequence').all();
    expect(f.store.context.resolveToolResult({sessionId:f.session.sessionId,nativeToolCallId:'old-call'}))
      .toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
    expect(f.store.db.query('SELECT * FROM session_native_entries ORDER BY sequence').all()).toEqual(before);
  });
  it('resolves original P8 Tool calls by Session and original journal, without mutating storage', () => {
    const f=fixture(), saved=f.append(); f.consume(saved.inputId,saved.content.text);
    need(f.store.context.bindRequest({binding:f.binding(saved.inputId,saved.snapshot.id),api:'openai-responses',transport:'observed-fetch',at}));
    const call=tool(f,'original-call',saved.snapshot.id,1);
    finish(f); const newer=legacyRun(f);
    const before=f.store.db.query('SELECT * FROM tool_calls').all();
    expect(need(f.store.context.resolveToolResult({sessionId:f.session.sessionId,nativeToolCallId:'original-call'})))
      .toEqual({nativeToolCallId:'original-call',toolCallId:call,originRunId:f.runId,context:{snapshotId:saved.snapshot.id,requestSequence:1}});
    expect(newer).not.toBe(f.runId);
    expect(f.store.db.query('SELECT * FROM tool_calls').all()).toEqual(before);
    const other=need(f.store.sessions.create({nativeSessionId:'tool-other',title:'Other',at}));
    expect(f.store.context.resolveToolResult({sessionId:other.sessionId,nativeToolCallId:'original-call'})).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run('{"version":1,"requests":[]}',f.runId);
    expect(f.store.context.resolveToolResult({sessionId:f.session.sessionId,nativeToolCallId:'original-call'})).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  });
  it.each(['valid','p8','missing-owner','bad-message','bad-call','other-branch','bad-header','bad-count'] as const)
    ('admits absent-product legacy tool result only for persisted legal history: %s', scenario => {
      const f=fixture(), original=legacyRun(f), history=persistLegacyTools(f,scenario==='p8'?f.runId:original);
      if (scenario==='missing-owner') f.store.db.query('UPDATE session_native_entries SET run_id=NULL WHERE session_id=?').run(f.session.sessionId);
      if (scenario==='bad-message' || scenario==='bad-call') {
        const index=scenario==='bad-message'?1:0;
        f.store.db.query('UPDATE session_native_entries SET entry_json=? WHERE session_id=? AND entry_id=?')
          .run(JSON.stringify({...history.entries[index],message:scenario==='bad-message'?{role:'toolResult',toolCallId:'old-call'}:{role:'assistant',content:[{type:'toolCall',id:'old-call'}]}}),f.session.sessionId,history.entries[index]!.id);
      }
      if (scenario==='other-branch') f.store.db.query("UPDATE session_native_history SET leaf_id='old-assistant' WHERE session_id=?").run(f.session.sessionId);
      if (scenario==='bad-header') f.store.db.query("UPDATE session_native_history SET header_json='{}' WHERE session_id=?").run(f.session.sessionId);
      if (scenario==='bad-count') f.store.db.query('UPDATE session_native_history SET entry_count=99 WHERE session_id=?').run(f.session.sessionId);
      const before={runs:f.store.db.query('SELECT * FROM runs').all(),entries:f.store.db.query('SELECT * FROM session_native_entries').all(),events:f.store.db.query('SELECT * FROM runtime_events').all()};
      const resolved=f.store.context.resolveToolResult({sessionId:f.session.sessionId,nativeToolCallId:'old-call'});
      expect(resolved).toMatchObject(scenario==='valid'?{ok:true,data:{nativeToolCallId:'old-call',toolCallId:null,originRunId:null,context:null}}
        :{ok:false,error:{code:'context_binding_unknown'}});
      expect(f.store.db.query('SELECT * FROM runs').all()).toEqual(before.runs);
      expect(f.store.db.query('SELECT * FROM session_native_entries').all()).toEqual(before.entries);
      expect(f.store.db.query('SELECT * FROM runtime_events').all()).toEqual(before.events);
      expect(f.store.db.query('SELECT COUNT(*) AS count FROM tool_calls').get()).toEqual({count:0});
    });
  it('preserves request facts, rejects conflicts and rolls back journal faults', () => {
    const f = fixture(), saved = f.append();
    f.consume(saved.inputId,saved.content.text);
    const binding = f.binding(saved.inputId,saved.snapshot.id);
    const input = { binding, api: 'openai-responses', transport: 'observed-fetch' as const, at };
    need(f.store.context.bindRequest(input)); need(f.store.context.bindRequest(input));
    expect(need(f.store.context.listContextRequests({ sessionId: f.session.sessionId,runId: f.runId })).items[0]?.sdkPayload).toBeNull();
    const payload={kind:'sdk-payload' as const,at,inclusion:'confirmed' as const,reason:null};
    need(f.store.context.recordRequest(binding,payload)); need(f.store.context.recordRequest(binding,payload));
    expect(f.store.context.recordRequest(binding,{...payload,at:later})).toMatchObject({ok:false,error:{code:'context_binding_conflict'}});
    expect(f.store.context.bindRequest({ ...input, api: 'openai-completions' })).toMatchObject({ ok: false, error: { code: 'context_binding_conflict' } });
    need(f.store.context.recordRequest(binding,{ kind: 'attempt-prepared', evidence: { attempt: 1, preparedAt: at, enteredAt: null,
      responseAt: null,responseStatus: null,transportErrorCode: null,nativeRequestId: null,wireInclusion: 'confirmed',wireReason: null } }));
    need(f.store.context.recordRequest(binding,{ kind: 'response', attempt: 1, at: later, status: 200, nativeRequestId: null }));
    need(f.store.context.recordRequest(binding,{ kind: 'response', attempt: 1, at: later, status: 200, nativeRequestId: 'actual-id' }));
    need(f.store.context.recordRequest(binding,{ kind: 'response', attempt: 1, at: later, status: 200, nativeRequestId: null }));
    expect(f.store.context.recordRequest(binding,{ kind: 'response', attempt: 1, at, status: 200,nativeRequestId: 'actual-id' }).ok).toBe(false);
    const before = f.store.db.query('SELECT context_observations_json FROM runs').get();
    f.store.db.exec("CREATE TRIGGER reject_journal BEFORE UPDATE OF context_observations_json ON runs BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(f.store.context.recordRequest(binding,{ kind: 'attempt-entered', attempt: 1, at }).ok).toBe(false);
    expect(f.store.db.query('SELECT context_observations_json FROM runs').get()).toEqual(before);
    const page = need(f.store.context.listContextRequests({ sessionId: f.session.sessionId, runId: f.runId }));
    expect(page.items[0]?.attempts[0]).toMatchObject({ enteredAt: null, responseAt: later, nativeRequestId: 'actual-id' });
    expect(ContextRequestsResultSchema.safeParse({ ok: true, data: page }).success).toBe(true);
  });
  it('keeps retries and late observations on the original snapshot after Run termination', () => {
    const f=fixture(), saved=f.append(); f.consume(saved.inputId,saved.content.text);
    const binding=f.binding(saved.inputId,saved.snapshot.id);
    need(f.store.context.bindRequest({binding,api:'openai-responses',transport:'observed-fetch',at}));
    const attempt=(attempt:number) => ({kind:'attempt-prepared' as const,evidence:{attempt,preparedAt:at,enteredAt:null,responseAt:null,responseStatus:null,
      nativeRequestId:null,transportErrorCode:null,wireInclusion:'unavailable' as const,wireReason:'body_unavailable' as const}});
    expect(f.store.context.recordRequest(binding,attempt(2))).toMatchObject({ok:false,error:{code:'context_binding_conflict'}});
    need(f.store.context.recordRequest(binding,attempt(1)));
    need(f.store.context.recordRequest(binding,{kind:'transport-failed',attempt:1,at:later,code:'provider_transport_error'}));
    need(f.store.context.recordRequest(binding,{kind:'transport-failed',attempt:1,at,code:'provider_transport_error'}));
    expect(f.store.context.recordRequest(binding,{kind:'transport-failed',attempt:1,at,code:'provider_timeout'})).toMatchObject({ok:false,error:{code:'context_binding_conflict'}});
    expect(f.store.context.recordRequest(binding,{kind:'response',attempt:1,at:later,status:200,nativeRequestId:null})).toMatchObject({ok:false,error:{code:'context_binding_conflict'}});
    need(f.store.context.recordRequest(binding,attempt(2)));
    f.append('later input',2); finish(f);
    const before=f.store.db.query('SELECT status,ended_at,error_json,current_context_snapshot_id FROM runs WHERE id=?').get(f.runId);
    const events=f.store.db.query('SELECT * FROM runtime_events').all();
    need(f.store.context.recordRequest(binding,{kind:'response',attempt:2,at:later,status:201,nativeRequestId:null}));
    expect(f.store.db.query('SELECT status,ended_at,error_json,current_context_snapshot_id FROM runs WHERE id=?').get(f.runId)).toEqual(before);
    expect(f.store.db.query('SELECT * FROM runtime_events').all()).toEqual(events);
    expect(need(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId})).items[0]?.binding.snapshotId).toBe(saved.snapshot.id);
  });
  it('paginates whole request bindings within the full Result budget and rolls back 4 MiB overflow', () => {
    const f=fixture(), saved=f.append(); f.consume(saved.inputId,saved.content.text);
    const old=legacyRun(f), nativeId='legacy-'.padEnd(256,'x'), oldCall=tool(f,nativeId,null,null,old);
    const includedToolResults=Array.from({length:511},()=>({nativeToolCallId:nativeId,toolCallId:oldCall,originRunId:old,context:null}));
    let accepted=0;
    for (let sequence=1;sequence<=64;sequence++) {
      const binding={...f.binding(saved.inputId,saved.snapshot.id),requestSequence:sequence,callSequence:sequence,includedToolResults};
      const before=f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId);
      const result=f.store.context.bindRequest({binding,api:'openai-responses',transport:'not-observable',at});
      if (!result.ok) {
        expect(result.error.code).toBe('context_evidence_too_large');
        expect(f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId)).toEqual(before);
        break;
      }
      accepted++;
    }
    expect(accepted).toBeGreaterThan(5); expect(accepted).toBeLessThan(64);
    const seen:number[]=[]; let beforeRequestSequence: number|undefined;
    do {
      const page=need(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId,beforeRequestSequence}));
      expect(new TextEncoder().encode(JSON.stringify({ok:true,data:page})).byteLength).toBeLessThanOrEqual(1048576);
      expect(page.items.length).toBeLessThan(20);
      for (const item of page.items) { expect(item.binding.includedToolResults).toHaveLength(511); seen.push(item.binding.requestSequence); }
      beforeRequestSequence=page.nextBeforeRequestSequence??undefined;
    } while (beforeRequestSequence!==undefined);
    expect(seen).toEqual(Array.from({length:accepted},(_,index)=>accepted-index));
  });
  it('paginates snapshot identities without truncating saved detail or exposing Input diagnostics', () => {
    const f=fixture(); for (let sequence=1;sequence<=23;sequence++) f.append(`input ${sequence}`,sequence);
    const first=need(f.store.context.listContextSnapshots({sessionId:f.session.sessionId}));
    expect(first.items).toHaveLength(20); expect(first.runId).toBeNull();
    expect(new TextEncoder().encode(JSON.stringify({ok:true,data:first})).byteLength).toBeLessThanOrEqual(131072);
    const next=need(f.store.context.listContextSnapshots({sessionId:f.session.sessionId,beforeId:first.nextBeforeId!}));
    expect(next.items).toHaveLength(3); expect(next.nextBeforeId).toBeNull();
    expect(first.items.at(-1)!.id).toBeGreaterThan(next.items[0]!.id);
    const snapshotId=next.items.at(-1)!.id;
    f.store.db.query("UPDATE session_inputs SET status='failed',processing_status='failed',error_json=? WHERE context_snapshot_id=?")
      .run(JSON.stringify({code:'sdk_unknown_failure',category:'runtime',retryable:true,message:'private absolute path and SDK exception'}),snapshotId);
    const detail=need(f.store.context.queryContextSnapshot({sessionId:f.session.sessionId,runId:f.runId,snapshotId}));
    expect(detail.input.error).toEqual({code:'internal_error',category:'internal',retryable:false});
    expect(JSON.stringify(detail)).not.toContain('private absolute');
  });
  it('keeps business Session snapshots when deletion hides it and preserves Provider rows', () => {
    const f=fixture(), jobId=business(f);
    f.store.db.query('UPDATE runs SET job_id=? WHERE id=?').run(jobId,f.runId);
    const saved=f.store.runtimeEventStore.withTransaction(()=>need(f.store.context.appendInTransaction({runId:f.runId,sessionId:f.session.sessionId,jobId,json:json(),at})));
    finish(f);
    f.store.db.query(`INSERT INTO runs(kind,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,ended_at,error_json)
      VALUES('provider','failed','Provider','{}','{}','{}','{}',?,?,'{}')`).run(at,at);
    const provider=f.store.db.query("SELECT * FROM runs WHERE kind='provider'").all();
    need(f.store.sessions.prepareDelete(f.session.sessionId,at));
    expect(f.store.sessions.delete(f.session.sessionId,at)).toEqual({ok:true,data:'hidden'});
    expect(f.store.db.query('SELECT id FROM context_snapshots WHERE id=?').get(saved.id)).toEqual({id:saved.id});
    expect(f.store.db.query("SELECT * FROM runs WHERE kind='provider'").all()).toEqual(provider);
    expect(() => f.store.db.query('UPDATE runs SET current_context_snapshot_id=? WHERE kind=?').run(saved.id,'provider')).toThrow();
    expect(f.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('preserves model and human candidate bytes through actual 014 to 015 and reads legacy associations as NULL', () => {
    const selected=makeSelectedCandidate(true);
    expect(need(selected.runs.get(selected.runId)).currentContextSnapshotId).toBeNull();
    expect(need(selected.toolCalls.getById(selected.toolCallId)).context).toBeNull();
    expect(need(selected.candidates.readByJob({jobId:selected.jobId,candidateId:selected.candidateId})).candidate.context).toBeNull();
    const productPaths={root:selected.root,databaseFile:join(selected.root,'data','flowmate.sqlite'),logsDir:join(selected.root,'logs'),
      artifactsDir:join(selected.root,'artifacts'),outputsDir:join(selected.root,'outputs'),runtimeDir:join(selected.root,'runtime')};
    for (const [version,name] of [[10,'010_human_candidates'],[11,'011_session_management'],[12,'012_tool_runtime_observations'],[13,'013_runtime_events'],[14,'014_workspace_selection']] as const) {
      const sql=readFileSync(new URL(`../../../packages/core/src/storage/migrations/${name}.sql`,import.meta.url),'utf8');
      for (const statement of sql.split(';').map(part=>part.trim()).filter(Boolean)) selected.db.exec(statement);
      if ([10,11,14].includes(version)) selected.db.exec('COMMIT');
      selected.db.exec('PRAGMA foreign_keys=ON');
    }
    selected.db.query(`INSERT INTO invoice_candidates(job_id,sequence,origin,based_on_candidate_id,fields_json,lines_json,issues_json,created_at)
      SELECT job_id,2,'human_edit',id,fields_json,lines_json,issues_json,created_at FROM invoice_candidates WHERE id=?`).run(selected.candidateId);
    const columns='id,job_id,run_id,tool_call_id,sequence,origin,based_on_candidate_id,fields_json,lines_json,issues_json,created_at';
    const before=selected.db.query(`SELECT ${columns} FROM invoice_candidates ORDER BY id`).all(); selected.close();
    const migrated=need(openTestDatabase(productPaths));
    expect(migrated.db.query(`SELECT ${columns} FROM invoice_candidates ORDER BY id`).all()).toEqual(before);
    expect(migrated.db.query('SELECT context_snapshot_id,request_sequence FROM invoice_candidates ORDER BY id').all())
      .toEqual([{context_snapshot_id:null,request_sequence:null},{context_snapshot_id:null,request_sequence:null}]);
    const context=createContextRepository({db:migrated.db,loadHistory:id=>migrated.sessions.loadHistory(id)});
    expect(need(context.listContextRequests({sessionId:selected.session.sessionId,runId:selected.runId})).collection).toBe('not-collected');
    expect(migrated.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('queries only original identity and public fields, including empty pages and near-limit detail', () => {
    const f = fixture();
    let text = 'A' + '\u0001'.repeat(43000);
    const saved = f.append(text);
    const detail = need(f.store.context.queryContextSnapshot({ sessionId: f.session.sessionId,runId: f.runId,snapshotId: saved.snapshot.id }));
    expect(detail.snapshot.json.text).toBe(text);
    expect(detail.snapshot.json).not.toHaveProperty('allowedDocumentIds');
    expect(detail.snapshot.json).not.toHaveProperty('workingDirectory');
    expect(detail.input).not.toHaveProperty('content');
    expect(ContextSnapshotResultSchema.safeParse({ ok: true,data: detail }).success).toBe(true);
    expect(need(f.store.context.listContextSnapshots({ sessionId: f.session.sessionId,beforeId: saved.snapshot.id })))
      .toMatchObject({ sessionId: f.session.sessionId, runId: null, items: [] });
    const other = need(f.store.sessions.create({ nativeSessionId: 'other',title: 'Other',at }));
    expect(f.store.context.listContextSnapshots({ sessionId: other.sessionId,runId: f.runId })).toMatchObject({ ok: false,error: { code: 'state_conflict',category:'runtime',retryable:false } });
    expect(f.store.context.queryContextSnapshot({ sessionId: f.session.sessionId,runId: f.runId,snapshotId: 999 }))
      .toMatchObject({ ok: false,error: { code: 'context_snapshot_not_found' } });
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run('{"version":1}',f.runId);
    expect(f.store.context.listContextRequests({ sessionId: f.session.sessionId,runId: f.runId })).toMatchObject({ ok: false,error: { code: 'storage_corrupt' } });
  });
  it('deletes prepared pure chat context atomically and preserves another Session', () => {
    const f = fixture(), saved = f.append();
    f.store.db.query("UPDATE runs SET status='failed',ended_at=?,error_json='{}' WHERE id=?").run(at,f.runId);
    const other = need(f.store.sessions.create({ nativeSessionId: 'retained',title: 'Retained',at }));
    need(f.store.sessions.prepareDelete(f.session.sessionId,at));
    f.store.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(f.store.sessions.delete(f.session.sessionId,at).ok).toBe(false);
    expect(f.store.db.query('SELECT context_snapshot_id FROM session_inputs WHERE id=?').get(saved.inputId))
      .toEqual({ context_snapshot_id: saved.snapshot.id });
    expect(f.store.db.query('SELECT current_context_snapshot_id FROM runs WHERE id=?').get(f.runId))
      .toEqual({ current_context_snapshot_id: saved.snapshot.id });
    f.store.db.exec('DROP TRIGGER reject_delete');
    expect(f.store.sessions.delete(f.session.sessionId,at)).toEqual({ ok: true,data: 'permanent' });
    expect(f.store.db.query('SELECT COUNT(*) AS count FROM context_snapshots').get()).toEqual({ count: 0 });
    expect(need(f.store.sessions.get(other.sessionId)).title).toBe('Retained');
    expect(f.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
