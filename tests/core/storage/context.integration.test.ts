import { saveTestHistory, nativeAssistantFacts } from '../../support/history.ts';
import { createHash } from 'node:crypto';
import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase } from '../../support/database.ts';
import { deferCleanup, mkdtempSync } from '../../support/resources.ts';
import { makeSelectedCandidate } from '../../support/selected-candidate.ts';
import { createContextRepository, readRunContext, readRunContextOwner } from '../../../packages/core/src/context/repository.ts';
import { SessionService } from '../../../packages/core/src/sessions/service.ts';
import { projectSessionMessages } from '../../../packages/runtime-pi/src/messages.ts';
import { createNativeOriginReader, resolveNativeEntryOrigin } from '../../../packages/core/src/memory/origins.ts';
import { ContextSnapshotJsonSchema, ContextSnapshotResultSchema, ContextRequestsResultSchema, ContextObservationsSchema,
  NativeContextObservationsSchema, PublicContextObservationsSchema, invoiceHeaderFields, normalizeSessionInputRequest, ok, RUNTIME_CONFIG, emptyResourceJournal } from '@flowmate/contracts';
import type { ContextSnapshotJson, RequestContextBinding, NativeSessionHistory, Result, ToolRuntimeObservation, RunCompactionEvidence } from '@flowmate/contracts';

const at = '2026-10-03T00:00:00.000Z';
const later = '2026-10-03T00:00:01.000Z';
const failure = { version: 1, code: 'agent_execution_failed', category: 'runtime', message: 'fixture', retryable: false };
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
      const content = { version: 2 as const, text, workspaceContext: null, workspaceInput: null,
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

function compactionEvidence(f: ReturnType<typeof fixture>): RunCompactionEvidence {
  f.store.db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify({
    ...f.config, historyPolicyVersion: 'p9-native-history-v1', compactionPolicy: RUNTIME_CONFIG.compaction,
  }), f.runId);
  const baseline = need(f.store.memory.load(f.session.sessionId))!.commit;
  return { operationId: 'ae6ec812-c44f-4382-9ff6-641461f779e7', runId: f.runId, sessionId: f.session.sessionId,
    nativeSessionId: f.session.nativeSessionId, reason: 'threshold', baseline, firstKeptEntryId: null, splitTurn: null,
    calls: [], observation: { operationId: 'ae6ec812-c44f-4382-9ff6-641461f779e7', runId: f.runId,
      sessionId: f.session.sessionId, nativeSessionId: f.session.nativeSessionId, reason: 'threshold', observationSequence: 1,
      phase: 'preparing', generated: false, nativeOutcome: 'pending', entryId: null, saved: null, error: null,
      stopRequested: false, stopped: false, continuation: 'current-run', mayContinue: false,
      capacity: { tokens: null, source: 'unknown', contextWindow: null, thresholdTokens: null, fitsEstimate: null },
      usage: { version: 1, source: 'not-requested', reason: 'not-started', sdkValues: null, attempts: 0,
        attemptsComplete: true, costSource: null, updatedAt: at },
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } } };
}
it('P10 automatic journal preserves ordinary requests and rejects conflicting facts', () => {
  const f = fixture(), saved = f.append(); f.consume(saved.inputId, saved.content.text);
  const evidence = compactionEvidence(f), repository = f.store.context;
  need(repository.recordCompactionEvidence(evidence));
  need(repository.recordCompactionEvidence(evidence)); // identical payload is idempotent
  const binding = f.binding(saved.inputId, saved.snapshot.id);
  need(repository.bindRequest({ binding, api: 'openai-responses', transport: 'observed-fetch', at }));
  need(repository.recordRequest(binding, { kind: 'sdk-payload', at, inclusion: 'confirmed', reason: null }));
  expect(need(repository.readCompactionEvidence({ sessionId: f.session.sessionId, runId: f.runId }))).toEqual([evidence]);
  const next = { ...evidence, firstKeptEntryId: 'p8-user', splitTurn: false,
    observation: { ...evidence.observation, observationSequence: 2, phase: 'compacting' as const } };
  need(repository.recordCompactionEvidence(next));
  const raw = JSON.parse((f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId) as {context_observations_json:string}).context_observations_json);
  expect(raw.requests[0].sdkPayload).toEqual({ observedAt: at, inclusion: 'confirmed', reason: null });
  expect(raw.compactions).toEqual([next]);
  for (const value of [evidence, { ...next, splitTurn: true },
    { ...next, baseline: { ...next.baseline, commitRevision: next.baseline.commitRevision + 1 } }])
    expect(repository.recordCompactionEvidence(value)).toMatchObject({ ok: false, error: { code: 'context_binding_conflict' } });
  expect(repository.recordCompactionEvidence({ ...next, nativeSessionId: 'foreign',
    observation: { ...next.observation, nativeSessionId: 'foreign' } })).toMatchObject({ ok: false });
});
it('P10 journal accepts only real compaction receipts and retains historical prefixes', () => {
  const f = fixture(), saved = f.append(); f.consume(saved.inputId, saved.content.text);
  const initial = compactionEvidence(f), repository = f.store.context;
  need(repository.recordCompactionEvidence(initial));
  const history = need(f.store.memory.load(f.session.sessionId))!.history;
  const entry = { type: 'compaction' as const, id: 'p10-summary', parentId: history.leafId, timestamp: at,
    summary: 'fixture summary', firstKeptEntryId: 'p8-user', tokensBefore: 100 };
  const receipt = need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: initial.baseline, header: history.header,
    appendEntries: [entry], leafId: entry.id, contexts: [], unusable: false }));
  const completed: RunCompactionEvidence = { ...initial, firstKeptEntryId: entry.firstKeptEntryId, splitTurn: false,
    observation: { ...initial.observation, observationSequence: 2, phase: 'ended', generated: true,
      nativeOutcome: 'succeeded', stopped: true, entryId: entry.id, saved: receipt } };
  expect(repository.recordCompactionEvidence({ ...completed, observation: { ...completed.observation,
    saved: { ...receipt, commitRevision: receipt.commitRevision + 1 } } })).toMatchObject({ ok: false });
  need(repository.recordCompactionEvidence(completed));
  need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: receipt, header: history.header,
    appendEntries: [{ type: 'session_info', id: 'later', parentId: entry.id, timestamp: at, name: 'later' }],
    leafId: 'later', contexts: [], unusable: false }));
  expect(need(repository.readCompactionEvidence({ sessionId: f.session.sessionId, runId: f.runId,
    operationId: completed.operationId }))).toEqual([completed]);
  f.store.db.query("UPDATE session_native_entries SET entry_json=replace(entry_json,'p8-user','missing-cut') WHERE entry_id=?").run(entry.id);
  expect(repository.readCompactionEvidence({ sessionId: f.session.sessionId, runId: f.runId })).toMatchObject({ ok: false });
});
it('P10 journal refuses an uncommitted baseline and storage write failure before recording', () => {
  const f = fixture(), saved = f.append(); f.consume(saved.inputId, saved.content.text);
  const evidence = compactionEvidence(f);
  expect(f.store.context.recordCompactionEvidence({ ...evidence, baseline: { ...evidence.baseline,
    commitRevision: evidence.baseline.commitRevision + 1 } })).toMatchObject({ ok: false });
  f.store.db.exec("CREATE TRIGGER p10_reject_context BEFORE UPDATE OF context_observations_json ON runs BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(f.store.context.recordCompactionEvidence(evidence)).toMatchObject({ ok: false, error: { code: 'storage_write_failed' } });
  f.store.db.exec('DROP TRIGGER p10_reject_context');
  expect(need(f.store.context.readCompactionEvidence({ sessionId: f.session.sessionId, runId: f.runId }))).toEqual([]);
});
it('P10 derived summary cannot claim an Input that lies at or after its retained cut', () => {
  const f = fixture(), saved = f.append(); const history = f.consume(saved.inputId, saved.content.text);
  const entry = { type: 'compaction' as const, id: 'not-covering-input', parentId: history.leafId, timestamp: at,
    summary: 'summary before retained input', firstKeptEntryId: history.leafId!, tokensBefore: 10 };
  need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: need(f.store.memory.load(f.session.sessionId))!.commit,
    header: history.header, appendEntries: [entry], leafId: entry.id, contexts: [], unusable: false }));
  const binding: RequestContextBinding = { ...f.binding(saved.inputId, saved.snapshot.id), includedBindings: [],
    includedNativeContexts: [{ nativeEntryId: entry.id, originSessionId: f.session.sessionId, entryType: 'compaction',
      messageRole: 'compactionSummary', contextMessageIndex: 0, referenceEntryIds: [entry.firstKeptEntryId] }] };
  expect(f.store.context.bindRequest({ binding, api: 'openai-responses', transport: 'observed-fetch', at }))
    .toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
  expect(JSON.parse((f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId) as {context_observations_json:string})
    .context_observations_json).requests).toEqual([]);
});

// Represents already trusted T06 provenance in disposable SQLite; not a public fork implementation.
function frozenFork(f: ReturnType<typeof fixture>, source: number, nativeId: string, ids?: string[]) {
  const stored = need(f.store.memory.load(source))!;
  const entries = stored.history.entries.filter(entry => !ids || ids.includes(entry.id));
  const history = { ...stored.history, header: { ...stored.history.header, id: nativeId }, entries, leafId: entries.at(-1)!.id };
  const target = need(f.store.sessions.create({ nativeSessionId: nativeId, title: nativeId, at, nativeHistory: history }));
  f.store.db.query(`INSERT INTO session_forks(target_session_id,source_session_id,source_commit_revision,source_entry_count,
    source_leaf_id,selected_entry_id,inherited_entry_count,client_operation_id,request_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(target.sessionId,source,stored.commit.commitRevision,stored.commit.entryCount,stored.commit.leafId,history.leafId,
      entries.length,nativeId,JSON.stringify({selectedEntryId:history.leafId}),at);
  return target;
}
it('P9 T03 resolves nested inherited origins without degrading null copies', () => {
  const f=fixture(), saved=f.append(), history=f.consume(saved.inputId,saved.content.text);
  need(f.store.context.bindRequest({binding:f.binding(saved.inputId,saved.snapshot.id),api:'openai-responses',transport:'observed-fetch',at}));
  const sourceBytes=f.store.db.query('SELECT * FROM session_inputs WHERE session_id=?').all(f.session.sessionId);
  const child=frozenFork(f,f.session.sessionId,'child'),local=p9TargetInput(f,child),grandchild=frozenFork(f,child.sessionId,'grandchild');
  expect(f.store.db.query('SELECT run_id FROM session_native_entries WHERE session_id=?').all(grandchild.sessionId)).toEqual([{run_id:null},{run_id:null}]);
  const bundle=need(f.store.sessions.loadHistoryForContext(grandchild.sessionId));
  expect(bundle).toMatchObject({commit:{commitRevision:1,entryCount:2,leafId:'target-user'},seed:{sessionId:grandchild.sessionId,
    origins:[{nativeEntryId:'p8-user',originSessionId:f.session.sessionId,originRunId:f.runId},{nativeEntryId:'target-user',originSessionId:child.sessionId,originRunId:local.runId}],
    inputs:[{nativeEntryId:'p8-user',originRunId:f.runId,inputId:saved.inputId,snapshotId:saved.snapshot.id},
      {nativeEntryId:'target-user',originRunId:local.runId,inputId:local.inputId,snapshotId:local.snapshot.id}]}});
  const display=need(f.store.sessions.readHistoryForDisplay(grandchild.sessionId));
  expect(display.bindings).toContainEqual({entryId:'p8-user',runId:f.runId});
  expect(display.sessionInputs).toContainEqual({inputId:saved.inputId,runId:f.runId,nativeEntryId:'p8-user',content:saved.content});
  need(saveTestHistory(f.store.db,f.store.runtimeEventStore,f.session.sessionId,{...history,entries:[...history.entries,
    {type:'session_info',id:'later',parentId:null,timestamp:at,name:'later'}],leafId:'later'}));
  expect(need(f.store.sessions.loadHistoryForContext(grandchild.sessionId))).toEqual(bundle);
  expect(f.store.db.query('SELECT * FROM session_inputs WHERE session_id=?').all(f.session.sessionId)).toEqual(sourceBytes);
});
it('P9 T03 rejects changed inherited JSON instead of treating copy NULL as legacy', () => {
  const f=fixture(),saved=f.append();f.consume(saved.inputId,saved.content.text);
  const target=frozenFork(f,f.session.sessionId,'changed');
  const raw=f.store.db.query('SELECT entry_json FROM session_native_entries WHERE session_id=?').get(target.sessionId) as {entry_json:string};
  const entry=JSON.parse(raw.entry_json);entry.message.content='forged';
  f.store.db.query('UPDATE session_native_entries SET entry_json=? WHERE session_id=?').run(JSON.stringify(entry),target.sessionId);
  expect(f.store.sessions.loadHistoryForContext(target.sessionId)).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  expect(f.store.sessions.readHistoryForDisplay(target.sessionId)).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
});

function p9ToolHistory(f: ReturnType<typeof fixture>, nativeId='inherited-call') {
  const saved=f.append(),history=f.consume(saved.inputId,saved.content.text);
  need(f.store.context.bindRequest({binding:f.binding(saved.inputId,saved.snapshot.id),api:'openai-responses',transport:'observed-fetch',at}));
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const entries=[...history.entries,{type:'session_info',id:'off-branch',parentId:null,timestamp:at,name:'unselected'},
    {type:'message',id:'native-call',parentId:'p8-user',timestamp:at,message:{role:'assistant',
    content:[{type:'toolCall',id:nativeId,name:'read_fixture',arguments:{}}],api:'openai-responses',provider:'fixture',model:'fixture',usage,stopReason:'toolUse',timestamp:2}},
    {type:'message',id:'native-result',parentId:'native-call',timestamp:at,message:{role:'toolResult',toolCallId:nativeId,toolName:'read_fixture',content:[{type:'text',text:'result'}],isError:false,timestamp:3}}];
  need(f.store.memory.commit({sessionId:f.session.sessionId,expected:need(f.store.memory.load(f.session.sessionId))!.commit,
    header:history.header,appendEntries:entries,leafId:'native-result',unusable:false,
    contexts:[{entryId:'native-call',runId:f.runId},{entryId:'native-result',runId:f.runId}]}));
  const toolId=tool(f,nativeId,saved.snapshot.id,1);
  return {saved,toolId};
}
function p9TargetInput(f: ReturnType<typeof fixture>, target: ReturnType<typeof frozenFork>) {
  finish(f);
  const db=f.store.db,config={...f.config,historyPolicyVersion:'p9-native-history-v1',agent:{...f.config.agent,nativeSessionId:target.nativeSessionId}};
  const runId=Number(db.query(`INSERT INTO runs(kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,context_observations_json,created_at)
    SELECT 'agent',?,scope_json,'running',goal,input_json,?,cleanup_json,usage_json,'{"version":1,"requests":[]}',? FROM runs WHERE id=?`)
    .run(target.sessionId,JSON.stringify(config),at,f.runId).lastInsertRowid);
  const snapshot=need(f.store.runtimeEventStore.withTransaction(()=>f.store.context.appendInTransaction({runId,sessionId:target.sessionId,jobId:null,json:json('target'),at})));
  const content={version:2,text:'target',promptText:'target',workspaceContext:null,workspaceInput:null,allowedDocumentIds:[],allowedArtifactIds:[]};
  const inputId=Number(db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,context_snapshot_id,content_json,status,processing_status,created_at,updated_at)
    VALUES(?,1,'prompt','answer',?,?,?,?,'queued','pending',?,?)`).run(target.sessionId,'c'.repeat(64),runId,snapshot.id,JSON.stringify(content),at,at).lastInsertRowid);
  const history=need(f.store.memory.load(target.sessionId))!.history;
  need(saveTestHistory(db,f.store.runtimeEventStore,target.sessionId,{...history,entries:[...history.entries,
    {type:'message',id:'target-user',parentId:history.leafId,timestamp:at,message:{role:'user',content:'target',timestamp:4}}],leafId:'target-user'},
    {entryId:'target-user',runId,inputId}));
  return {runId,inputId,snapshot};
}
it('P9 T05 bounds repeated tool proofs to one read snapshot and keeps saved-path keys distinct', () => {
  const f = fixture(); p9ToolHistory(f);
  const db = f.store.db, query = spyOn(db, 'query');
  db.transaction(() => {
    const reader = createNativeOriginReader(db);
    expect(Object.isFrozen(reader.history(f.session.sessionId)!.history.entries)).toBe(true);
    const original = reader.tool(f.session.sessionId, 'inherited-call', true);
    expect(reader.tool(f.session.sessionId, 'inherited-call', true)).toEqual(original);
    expect(query.mock.calls.filter(([sql]) => sql === 'SELECT * FROM tool_calls WHERE session_id=? AND native_tool_call_id=?')).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql === 'SELECT * FROM context_snapshots WHERE id=?')).toHaveLength(1);
  }).deferred();
  query.mockRestore();
  const saved = need(f.store.memory.load(f.session.sessionId))!;
  need(f.store.memory.commit({ sessionId: f.session.sessionId, expected: saved.commit, header: saved.history.header,
    appendEntries: [], contexts: [], leafId: 'p8-user', unusable: false }));
  db.transaction(() => {
    const reader = createNativeOriginReader(db);
    expect(reader.tool(f.session.sessionId, 'inherited-call', true).toolCallId).toBeGreaterThan(0);
    expect(() => reader.tool(f.session.sessionId, 'inherited-call', false)).toThrow('context_binding_unknown');
  }).deferred();
  db.query("UPDATE tool_calls SET tool_name='corrupted-original' WHERE native_tool_call_id='inherited-call'").run();
  expect(f.store.context.resolveToolResult({ sessionId: f.session.sessionId, nativeToolCallId: 'inherited-call' }))
    .toMatchObject({ ok: false, error: { code: 'context_binding_unknown' } });
  expect(() => db.transaction(() => createNativeOriginReader(db).tool(f.session.sessionId, 'inherited-call', true)).deferred())
    .toThrow('context_binding_unknown');
});
for (const fault of ['owner-run', 'owner-session', 'owner-job', 'missing', 'corrupt'] as const) it(`P9 T05 snapshot proof rejects ${fault} after a prior successful proof`, () => {
  const f=fixture(),{saved}=p9ToolHistory(f),db=f.store.db;
  expect(() => db.transaction(() => createNativeOriginReader(db).tool(f.session.sessionId,'inherited-call',true)).deferred()).not.toThrow();
  // Simulate an externally corrupted database after the first coherent read.
  db.exec('DROP TRIGGER context_run_update_guard; DROP TRIGGER context_snapshot_update_guard');
  if(fault==='missing') { db.exec('PRAGMA foreign_keys=OFF'); db.query('UPDATE runs SET current_context_snapshot_id=999999 WHERE id=?').run(f.runId); db.exec('PRAGMA foreign_keys=ON'); }
  else if(fault==='corrupt') db.query("UPDATE context_snapshots SET snapshot_json='{}' WHERE id=?").run(saved.snapshot.id);
  else {
    const otherSession=need(f.store.sessions.create({nativeSessionId:'other-owner',title:'Other',at}));
    const otherRun=legacyRun(f,otherSession.nativeSessionId,otherSession.sessionId);
    const jobId=fault==='owner-job'?business(f):null;
    const history=need(f.store.memory.load(f.session.sessionId))!.history;
    need(saveTestHistory(db,f.store.runtimeEventStore,otherSession.sessionId,{...history,header:{...history.header,id:otherSession.nativeSessionId},
      entries:[{type:'message',id:'other-message',parentId:null,timestamp:at,message:{role:'assistant',content:[{type:'text',text:'Other'}],...nativeAssistantFacts,stopReason:'stop',timestamp:5}}],leafId:'other-message'}));
    db.query("UPDATE session_native_entries SET run_id=? WHERE session_id=? AND entry_id='other-message'").run(otherRun,otherSession.sessionId);
    db.query('UPDATE runs SET config_json=?,current_context_snapshot_id=?,context_observations_json=?,job_id=?,session_id=? WHERE id=?')
      .run(JSON.stringify({...f.config,agent:{...f.config.agent,nativeSessionId:otherSession.nativeSessionId}}),saved.snapshot.id,JSON.stringify({version:1,requests:[]}),jobId,
        fault==='owner-session'?f.session.sessionId:otherSession.sessionId,otherRun);
    db.transaction(() => {
      const reader=createNativeOriginReader(db);
      expect(reader.tool(f.session.sessionId,'inherited-call',true).context?.snapshotId).toBe(saved.snapshot.id);
      expect(() => reader.resolve(otherSession.sessionId,'other-message')).toThrow('context_binding_unknown');
    }).deferred();
    return;
  }
  expect(() => db.transaction(() => createNativeOriginReader(db).tool(f.session.sessionId,'inherited-call',true)).deferred())
    .toThrow('context_binding_unknown');
});
it('P9 T03 shares origin verification across five read paths and keeps target primary facts', () => {
  const f=fixture(),{saved,toolId}=p9ToolHistory(f),target=frozenFork(f,f.session.sessionId,'five',['p8-user','native-call','native-result']),local=p9TargetInput(f,target);
  const binding:RequestContextBinding={...f.binding(saved.inputId,saved.snapshot.id),sessionId:target.sessionId,nativeSessionId:target.nativeSessionId,
    runId:local.runId,inputId:local.inputId,snapshotId:local.snapshot.id,includedBindings:[...f.binding(saved.inputId,saved.snapshot.id).includedBindings,
      {nativeEntryId:'target-user',originRunId:local.runId,inputId:local.inputId,snapshotId:local.snapshot.id}],
    includedToolResults:[{nativeToolCallId:'inherited-call',toolCallId:toolId,originRunId:f.runId,context:{snapshotId:saved.snapshot.id,requestSequence:1}}]};
  const original=['runs','session_inputs','context_snapshots','tool_calls'].map(table=>f.store.db.query(`SELECT * FROM ${table} WHERE ${table==='runs'?'id':'run_id'}=?`).all(f.runId));
  const service=new SessionService(f.store.sessions,{projectSessionMessages,inspect:()=>({availability:'missing'}),
    createSession(){throw new Error('No native create during projection');},async prepare(){throw new Error('No model prepare during projection');},
    async close(){return {stopped:true,closed:true,errors:[]};},async releaseSession(){return {stopped:true,closed:true,errors:[]};}},
    ()=>({active:null,blocked:false,error:null}),()=>at,f.store.runs, f.store.memory);
  readRunContextOwner(f.store.db,f.store.db.query('SELECT * FROM runs WHERE id=?').get(f.runId) as Parameters<typeof readRunContextOwner>[1]);
  expect(f.store.runs.get(f.runId).ok).toBe(true);
  expect(f.store.runs.get(local.runId).ok).toBe(true);
  const projected=need(service.listMessages({sessionId:target.sessionId,limit:50}));
  expect(projected.items.find(item=>item.entryId==='p8-user')).toMatchObject({runId:f.runId,role:'user'});
  expect(need(f.store.sessions.loadHistoryForContext(target.sessionId)).seed.inputs).toEqual(binding.includedBindings);
  expect(f.store.db.query("SELECT session_id,sequence,run_id FROM session_native_entries WHERE entry_id='native-call' ORDER BY session_id").all())
    .toEqual([{session_id:f.session.sessionId,sequence:2,run_id:f.runId},{session_id:target.sessionId,sequence:1,run_id:null}]);
  expect(need(f.store.sessions.readHistoryForDisplay(target.sessionId)).bindings).toContainEqual({entryId:'native-result',runId:f.runId});
  expect(need(f.store.context.resolveToolResult({sessionId:target.sessionId,nativeToolCallId:'inherited-call'}))).toEqual(binding.includedToolResults[0]);
  need(f.store.context.bindRequest({binding,api:'openai-responses',transport:'observed-fetch',at}));
  expect(need(f.store.context.listContextRequests({sessionId:target.sessionId,runId:local.runId})).items[0]!.binding).toEqual(binding);
  const history=need(f.store.memory.load(target.sessionId))!.history;
  need(saveTestHistory(f.store.db,f.store.runtimeEventStore,target.sessionId,{...history,leafId:'p8-user'}));
  expect(need(f.store.context.listContextRequests({sessionId:target.sessionId,runId:local.runId})).items[0]!.binding).toEqual(binding);
  expect(['runs','session_inputs','context_snapshots','tool_calls'].map(table=>f.store.db.query(`SELECT * FROM ${table} WHERE ${table==='runs'?'id':'run_id'}=?`).all(f.runId))).toEqual(original);
  const raw=f.store.db.query('SELECT entry_json FROM session_native_entries WHERE session_id=? AND entry_id=?').get(target.sessionId,'p8-user') as {entry_json:string};
  f.store.db.query('UPDATE session_native_entries SET entry_json=? WHERE session_id=? AND entry_id=?').run(raw.entry_json.replace('Explain this input.','forged'),target.sessionId,'p8-user');
  for(const result of [f.store.sessions.loadHistoryForContext(target.sessionId),service.listMessages({sessionId:target.sessionId,limit:1}),f.store.sessions.readHistoryForDisplay(target.sessionId),
    f.store.context.resolveToolResult({sessionId:target.sessionId,nativeToolCallId:'inherited-call'}),
    f.store.context.bindRequest({binding,api:'openai-responses',transport:'observed-fetch',at}),
    f.store.context.listContextRequests({sessionId:target.sessionId,runId:local.runId})])
    expect(result).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
});

it.each(['source-missing','source-changed','frozen-range','inherited-range','missing-input','wrong-input-content','wrong-request','forged-request-source','target-tool-conflict','intermediate-tool-conflict'] as const)
  ('P9 T03 rejects broken source evidence through recovery and original tool readers: %s', scenario => {
  const f=fixture();p9ToolHistory(f);const child=frozenFork(f,f.session.sessionId,`fault-${scenario}`),
    target=scenario==='intermediate-tool-conflict'?frozenFork(f,child.sessionId,'nested-tool-conflict'):child,db=f.store.db;
  if(scenario==='source-missing') db.query("DELETE FROM session_native_entries WHERE session_id=? AND entry_id='native-call'").run(f.session.sessionId);
  if(scenario==='source-changed') db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','changed') WHERE session_id=? AND entry_id='p8-user'").run(f.session.sessionId);
  if(scenario==='frozen-range' || scenario==='inherited-range') {
    db.exec('DROP TRIGGER session_forks_immutable');
    db.query(`UPDATE session_forks SET ${scenario==='frozen-range'?'source_entry_count':'inherited_entry_count'}=1 WHERE target_session_id=?`).run(target.sessionId);
  }
  if(scenario==='missing-input') db.query('DELETE FROM session_inputs WHERE run_id=?').run(f.runId);
  if(scenario==='wrong-input-content') db.query("UPDATE session_inputs SET content_json=json_set(content_json,'$.text','wrong') WHERE run_id=?").run(f.runId);
  if(scenario==='wrong-request') db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run('{"version":1,"requests":[]}',f.runId);
  if(scenario==='forged-request-source') {
    const raw=db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId) as {context_observations_json:string};
    const journal=JSON.parse(raw.context_observations_json);
    journal.requests[0].binding.includedBindings.unshift({nativeEntryId:'nonexistent',originRunId:null,inputId:null,snapshotId:null});
    db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify(journal),f.runId);
  }
  if(scenario==='target-tool-conflict' || scenario==='intermediate-tool-conflict') {
    const local=p9TargetInput(f,child);
    db.query(`INSERT INTO tool_calls(run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,delivery_json,cleanup_json,requested_at,context_snapshot_id,request_sequence)
      VALUES(?,?,'inherited-call','read_fixture','1','READ',?,?,?,?,?,1)`).run(local.runId,child.sessionId,'{"version":1,"raw":{},"final":null}',JSON.stringify(delivery),JSON.stringify(toolCleanup),at,local.snapshot.id);
  }
  const before=db.query('SELECT entry_json,run_id FROM session_native_entries ORDER BY session_id,sequence').all();
  expect(f.store.sessions.loadHistoryForContext(target.sessionId)).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  expect(f.store.context.resolveToolResult({sessionId:target.sessionId,nativeToolCallId:'inherited-call'})).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  expect(db.query('SELECT entry_json,run_id FROM session_native_entries ORDER BY session_id,sequence').all()).toEqual(before);
});
it('P9 T03 rejects inherited tool ID collisions before repository effects', () => {
  const f=fixture();p9ToolHistory(f);const target=frozenFork(f,f.session.sessionId,'collision'),local=p9TargetInput(f,target);
  const binding:RequestContextBinding={runId:local.runId,sessionId:target.sessionId,nativeSessionId:target.nativeSessionId,inputId:local.inputId,
    snapshotId:local.snapshot.id,requestSequence:1,callSequence:1,includedBindings:[{nativeEntryId:'target-user',originRunId:local.runId,inputId:local.inputId,snapshotId:local.snapshot.id}],
    includedToolResults:[],includedNativeContexts:[]};
  need(f.store.context.bindRequest({binding,api:'openai-responses',transport:'observed-fetch',at}));
  const before=['tool_calls','runtime_events','runs','invoice_candidates'].map(table=>f.store.db.query(`SELECT * FROM ${table}`).all());
  expect(f.store.toolCalls.request({sessionId:target.sessionId,runId:local.runId,nativeToolCallId:'inherited-call',toolName:'read_fixture',
    toolVersion:'1',effect:'READ',rawArguments:{},context:{snapshotId:local.snapshot.id,requestSequence:1},requestedAt:at})).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  expect(['tool_calls','runtime_events','runs','invoice_candidates'].map(table=>f.store.db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
});
it.each(['valid','missing-request','wrong-snapshot'] as const)('P9 T03 standalone tool origin verifies original request and snapshot: %s', scenario => {
  const f=fixture(),{saved}=p9ToolHistory(f),target=frozenFork(f,f.session.sessionId,'standalone'),db=f.store.db;
  if(scenario==='missing-request') db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run('{"version":1,"requests":[]}',f.runId);
  if(scenario==='wrong-snapshot') {
    // Keep SQL owner columns valid while corrupting the saved original generating request.
    const second=f.append('second original snapshot',2);
    const raw=db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId) as {context_observations_json:string};
    const journal=JSON.parse(raw.context_observations_json);
    journal.requests[0].binding.snapshotId=second.snapshot.id;
    journal.requests[0].binding.includedBindings[0].snapshotId=second.snapshot.id;
    db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify(journal),f.runId);
  }
  const before=db.query('SELECT * FROM tool_calls').all();
  const result=resolveNativeEntryOrigin(db,{targetSessionId:target.sessionId,nativeEntryId:'native-result'});
  expect(result).toMatchObject(scenario==='valid'?{ok:true,data:{originSessionId:f.session.sessionId,nativeEntryId:'native-result',originRunId:f.runId,
    inputId:null,snapshotId:saved.snapshot.id}}:{ok:false,error:{code:'context_binding_unknown'}});
  expect(db.query('SELECT * FROM tool_calls').all()).toEqual(before);
});
function p9ReadFixture(appendAnswer=true) {
  const f=fixture(),{saved}=p9ToolHistory(f),target=frozenFork(f,f.session.sessionId,'read-target'),local=p9TargetInput(f,target),db=f.store.db;
  const binding:RequestContextBinding={...f.binding(saved.inputId,saved.snapshot.id),sessionId:target.sessionId,nativeSessionId:target.nativeSessionId,
    runId:local.runId,inputId:local.inputId,snapshotId:local.snapshot.id,includedBindings:[...f.binding(saved.inputId,saved.snapshot.id).includedBindings,
      {nativeEntryId:'target-user',originRunId:local.runId,inputId:local.inputId,snapshotId:local.snapshot.id}]};
  need(f.store.context.bindRequest({binding,api:'openai-responses',transport:'observed-fetch',at}));
  const request={sessionId:target.sessionId,clientSequence:1,mode:'prompt' as const,goalMode:'answer' as const,text:'target',
    config:{version:1 as const,name:'fixture',revision:1,modelRef:{provider:'fixture',model:'fixture'},native:{authPath:join(f.productPaths.root,'unused-auth.json'),modelsPath:null},
      parameters:{maxRetries:0,maxRetryDelayMs:100}}};
  const normalized=need(normalizeSessionInputRequest(request));
  db.query('UPDATE runs SET scope_json=? WHERE id=?').run(JSON.stringify({version:2,allowedTools:['read_fixture'],allowedDocumentIds:[],allowedArtifactIds:[],allowedResourcePaths:[]}),local.runId);
  db.query('UPDATE session_inputs SET request_hash=? WHERE id=?').run(createHash('sha256').update(JSON.stringify({...normalized,timeoutMs:60000,stopGraceMs:5000})).digest('hex'),local.inputId);
  const toolRequest={sessionId:target.sessionId,runId:local.runId,nativeToolCallId:'local-call',toolName:'read_fixture',toolVersion:'1',effect:'READ' as const,
    rawArguments:{},context:{snapshotId:local.snapshot.id,requestSequence:1},requestedAt:at};
  const call=need(f.store.toolCalls.request(toolRequest));
  const observation:ToolRuntimeObservation={version:1,groupKey:'fixture-read',strategyVersion:'runtime-v1',sampleSource:'test',beforeOutcome:'allowed',failureStage:null,diagnosticCode:null,
    afterStructure:'valid',afterDomain:'not_applicable',executionDurationMs:12,timingComplete:true,effectiveTimeoutMs:1000,timeoutSource:'configured',runDeadlineTruncated:false,
    commit:'none_confirmed',commitError:null};
  need(f.store.toolCalls.fixArguments({toolCallId:call.toolCallId,finalArguments:{}}));
  need(f.store.toolCalls.start({toolCallId:call.toolCallId,startedAt:at}));
  need(f.store.toolCalls.finish({toolCallId:call.toolCallId,result:{version:1,status:'succeeded',data:{},committedCandidateId:null},
    cleanup:{version:1,stopped:true,stopReason:'settled',errors:[]},endedAt:at,stoppedAt:at,runtimeObservation:observation}));
  const stored=need(f.store.memory.load(target.sessionId))!,history=stored.history;
  const answer={sessionId:target.sessionId,expected:stored.commit,header:history.header,appendEntries:[{type:'message',id:'local-answer',parentId:history.leafId,timestamp:at,
    message:{...nativeAssistantFacts,role:'assistant',content:[{type:'text',text:'answer'}],stopReason:'stop',timestamp:5}}],leafId:'local-answer',unusable:false,
    contexts:[{entryId:'local-answer',runId:local.runId,resultInputIds:[local.inputId]}]};
  if(appendAnswer) need(f.store.memory.commit(answer));
  const readers={
    runGet:()=>f.store.runs.get(local.runId),runList:()=>f.store.runs.listBySession({sessionId:target.sessionId,limit:20}),
    toolGet:()=>f.store.toolCalls.get({runId:local.runId,sessionId:target.sessionId,nativeToolCallId:'local-call'}),
    toolById:()=>f.store.toolCalls.getById(call.toolCallId),toolList:()=>f.store.toolCalls.list({runId:local.runId,limit:20}),
    candidateCommit:()=>f.store.toolCalls.queryCandidateCommit({toolCallId:call.toolCallId,runId:local.runId,sessionId:target.sessionId}),
    recentStarted:()=>f.store.toolCalls.recentStarted({groupKey:'fixture-read',cutoff:call.toolCallId}),
    recentObservations:()=>f.store.toolCalls.recentObservations({groupKey:'fixture-read',cutoff:call.toolCallId}),
    validateOutput:()=>f.store.toolCalls.validateOutput({toolCallId:call.toolCallId,data:{}}),
    formRequest:()=>f.store.toolCalls.readFormApplicationRequest(call.toolCallId),
    inputLookup:()=>f.store.sessionInputs.lookup(request),inputQuery:()=>f.store.sessionInputs.query({sessionId:target.sessionId,inputId:local.inputId}),
    inputList:()=>f.store.sessionInputs.list({sessionId:target.sessionId,limit:20}),inputGet:()=>f.store.sessionInputs.get(local.inputId),
    inputForRun:()=>f.store.sessionInputs.forRun(local.runId),
    resultEvidence:()=>f.store.sessionInputs.resultEvidence(local.runId,[local.inputId],'local-answer')};
  return {...f,target,local,readers,toolRequest,answer};
}
it('P9 T03 fix1 L1 commits actual P8 result Input and P6 only after native receipt COMMIT, then no-ops', () => {
  const f=p9ReadFixture(false),db=f.store.db,published:unknown[]=[];
  const journal=db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.local.runId);
  const beforeEvents=db.query('SELECT * FROM runtime_events ORDER BY id').all();
  f.store.runtimeEventStore.onCommitted(refs=>published.push({refs,inTransaction:db.inTransaction,
    stored:f.store.memory.load(f.target.sessionId),input:f.store.sessionInputs.get(f.local.inputId)}));
  const receipt=need(f.store.memory.commit(f.answer));
  expect(receipt).toEqual({commitRevision:f.answer.expected.commitRevision+1,entryCount:f.answer.expected.entryCount+1,leafId:'local-answer'});
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({inTransaction:false,stored:{ok:true,data:{commit:receipt}},input:{ok:true,data:{status:'consumed',processingStatus:'pending',resultEntryId:'local-answer'}}});
  const events=db.query('SELECT * FROM runtime_events ORDER BY id').all();expect(events).toHaveLength(beforeEvents.length+1);
  expect(db.query("SELECT dedupe_key,type,payload_json FROM runtime_events WHERE run_id=? ORDER BY id DESC LIMIT 1").get(f.local.runId))
    .toMatchObject({dedupe_key:`input:${f.local.inputId}:consumed:pending:target-user:local-answer`,type:'input_state_changed',
      payload_json:JSON.stringify({version:1,inputId:f.local.inputId,origin:'live',status:'consumed',processingStatus:'pending',nativeEntryId:'target-user',resultEntryId:'local-answer',errorCode:null})});
  expect(need(f.store.memory.commit({...f.answer,expected:receipt}))).toEqual(receipt);
  expect(db.query('SELECT * FROM runtime_events ORDER BY id').all()).toEqual(events);expect(published).toHaveLength(1);
  expect(db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.local.runId)).toEqual(journal);
  expect(f.readers.runGet()).toMatchObject({ok:true});expect(f.readers.resultEvidence()).toMatchObject({ok:true});
});
it.each(['event','cas'] as const)('P9 T03 fix1 L1 rolls back native result Input receipt and P6 without publication: %s', fault => {
  const f=p9ReadFixture(false),db=f.store.db,published:unknown[]=[];
  f.store.runtimeEventStore.onCommitted(refs=>published.push(refs));
  const facts=()=>['session_native_history','session_native_entries','session_inputs','runtime_events'].map(table=>db.query(`SELECT * FROM ${table}`).all());
  const before=facts();
  db.exec(fault==='event'?"CREATE TRIGGER reject_p6 BEFORE INSERT ON runtime_events BEGIN SELECT RAISE(ABORT,'event unavailable'); END"
    :'CREATE TRIGGER reject_cas BEFORE UPDATE ON session_native_history BEGIN SELECT RAISE(IGNORE); END');
  const query=db.query.bind(db),attempted:string[]=[];
  const spy=spyOn(db,'query').mockImplementation(((sql:string)=>{if(/INSERT INTO runtime_events|UPDATE session_native_history SET/.test(sql)) attempted.push(sql);return query(sql);}) as typeof db.query);
  try {expect(f.store.memory.commit(f.answer)).toMatchObject({ok:false,error:{code:fault==='event'?'storage_write_failed':'state_conflict'}});}
  finally {spy.mockRestore();}
  expect(attempted[0]).toContain('INSERT INTO runtime_events');
  expect(attempted).toHaveLength(fault==='event'?1:2);
  if(fault==='cas') expect(attempted[1]).toContain('UPDATE session_native_history SET');
  expect(facts()).toEqual(before);expect(published).toEqual([]);
});
it.each(['inherited-source','target-primary','owner-only'] as const)('P9 T03 fix1 L1 rejects corrupt existing evidence before first native INSERT: %s', fault => {
  const f=p9ReadFixture(false),db=f.store.db,published:unknown[]=[],inserts:string[]=[];
  if(fault!=='target-primary') db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','corrupt') WHERE session_id=? AND entry_id='p8-user'").run(f.target.sessionId);
  else db.query("UPDATE session_inputs SET content_json=json_set(content_json,'$.text','corrupt') WHERE id=?").run(f.local.inputId);
  const facts=()=>['session_native_history','session_native_entries','session_inputs','runtime_events'].map(table=>db.query(`SELECT * FROM ${table}`).all());
  const before=facts(),query=db.query.bind(db);
  f.store.runtimeEventStore.onCommitted(refs=>published.push(refs));
  const spy=spyOn(db,'query').mockImplementation(((sql:string)=>{if(/INSERT INTO session_native_entries/.test(sql)) inserts.push(sql);return query(sql);}) as typeof db.query);
  try {expect(f.store.memory.commit(fault==='owner-only'?{...f.answer,contexts:[{entryId:'local-answer',runId:f.local.runId}]}:f.answer))
    .toMatchObject({ok:false,error:{code:'context_binding_unknown',category:'runtime',retryable:false}});}
  finally {spy.mockRestore();}
  expect(inserts).toEqual([]);expect(facts()).toEqual(before);expect(published).toEqual([]);
});
it.each([false,true])('P9 T03 fix1 L1 validates later queued user before actual Input and P6 writes, corrupt=%s', corrupt => {
  const f=p9ReadFixture(false),db=f.store.db;
  const context=need(f.store.runtimeEventStore.withTransaction(()=>f.store.context.appendInTransaction({runId:f.local.runId,sessionId:f.target.sessionId,jobId:null,json:json('next'),at})));
  const input=need(f.store.sessionInputs.admit({sessionId:f.target.sessionId,clientSequence:2,mode:'followUp',runId:f.local.runId,text:'next'},
    ()=>ok({runId:f.local.runId,contextPolicyVersion:'p8-context-v1',contextSnapshotId:context.id,content:{version:2,text:'next',promptText:'next',workspaceContext:null,workspaceInput:null,allowedDocumentIds:[],allowedArtifactIds:[]}}),at)).input;
  const published:unknown[]=[];f.store.runtimeEventStore.onCommitted(refs=>published.push({refs,inTransaction:db.inTransaction}));
  if(corrupt) db.query("UPDATE session_inputs SET content_json=json_set(content_json,'$.text','wrong') WHERE id=?").run(input.inputId);
  const facts=()=>['session_native_history','session_native_entries','session_inputs','runtime_events'].map(table=>db.query(`SELECT * FROM ${table}`).all()),before=facts();
  const query=db.query.bind(db),inserts:string[]=[];
  const spy=spyOn(db,'query').mockImplementation(((sql:string)=>{if(/INSERT INTO session_native_entries/.test(sql)) inserts.push(sql);return query(sql);}) as typeof db.query);
  let result;
  try { result=f.store.memory.commit({...f.answer,appendEntries:[...f.answer.appendEntries,{type:'message',id:'next-user',parentId:'local-answer',timestamp:at,message:{role:'user',content:'next',timestamp:6}}],
    leafId:'next-user',contexts:[...f.answer.contexts,{entryId:'next-user',runId:f.local.runId,inputId:input.inputId}]}); }
  finally {spy.mockRestore();}
  if(corrupt) {expect(result).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});expect(inserts).toEqual([]);expect(facts()).toEqual(before);expect(published).toEqual([]);return;}
  const receipt=need(result);
  expect(receipt.commitRevision).toBe(f.answer.expected.commitRevision+1);
  expect(f.store.sessionInputs.get(input.inputId)).toMatchObject({ok:true,data:{status:'consumed',nativeEntryId:'next-user',contextSnapshotId:context.id}});
  expect(published).toHaveLength(1);expect(published[0]).toMatchObject({inTransaction:false});
});
const p9ReaderNames=['runGet','runList','toolGet','toolById','toolList','candidateCommit','recentStarted','recentObservations','validateOutput','formRequest',
  'inputLookup','inputQuery','inputList','inputGet','inputForRun','resultEvidence'] as const;
it.each([...p9ReaderNames])('P9 T03 fix1 public read snapshot and caller transaction reuse: %s', name => {
  const f=p9ReadFixture(),db=f.store.db,query=db.query.bind(db),transaction=db.transaction.bind(db);
  const states:boolean[]=[],transactions:boolean[]=[];
  const querySpy=spyOn(db,'query').mockImplementation(((...args:Parameters<typeof db.query>)=>{states.push(db.inTransaction);return query(...args);}) as typeof db.query);
  const txSpy=spyOn(db,'transaction').mockImplementation(((...args:Parameters<typeof db.transaction>)=>{transactions.push(db.inTransaction);return transaction(...args);}) as typeof db.transaction);
  try {
    const read=f.readers[name];
      states.length=0;transactions.length=0;
      const expected=name==='formRequest'?{ok:false,error:{code:'state_conflict'}}:{ok:true};
      expect(read(),name).toMatchObject(expected);
      expect(states.length,name).toBeGreaterThan(1);
      expect(states.every(Boolean),name).toBe(true);
      expect(transactions,name).toEqual([false]);
      for(const mode of ['deferred','immediate'] as const) transaction(()=>{
        states.length=0;transactions.length=0;
        expect(read(),`${name}:${mode}`).toMatchObject(expected);
        expect(states.every(Boolean),name).toBe(true);
        expect(transactions,name).toEqual([]);
      })[mode]();
  } finally {querySpy.mockRestore();txSpy.mockRestore();}
});
it.each(p9ReaderNames.flatMap(name=>(['provenance','sql','json'] as const).map(fault=>({name,fault}))))('P9 T03 fix1 public evidence typed failures: $name $fault', ({name,fault}) => {
  const f=p9ReadFixture(),db=f.store.db;
  if(fault==='provenance') db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','changed') WHERE session_id=? AND entry_id='p8-user'").run(f.target.sessionId);
  if(fault==='sql') db.exec('DROP TABLE session_forks');
  if(fault==='json') db.query("UPDATE runs SET config_json='[]' WHERE id=?").run(f.local.runId);
  const expected=fault==='provenance'?{code:'context_binding_unknown',category:'runtime',retryable:false}
    :fault==='sql'?{code:'storage_read_failed',category:'storage',retryable:true}:{code:'storage_corrupt',category:'storage',retryable:false};
  const read=f.readers[name];
    if(name==='resultEvidence') expect(read(),name).toMatchObject({ok:false,error:{code:'input_processing_unconfirmed'}});
    else expect(read(),name).toMatchObject({ok:false,error:expected});
});
it('P9 T03 fix1 tool request keeps actual original-context SQL failures distinct and writes nothing', () => {
  const f=p9ReadFixture(),db=f.store.db;
  const before=['tool_calls','runtime_events','runs'].map(table=>db.query(`SELECT * FROM ${table}`).all());
  db.exec('DROP TABLE session_forks');
  expect(f.store.toolCalls.request({...f.toolRequest,nativeToolCallId:'new-call'})).toMatchObject({ok:false,error:{code:'storage_write_failed',category:'storage',retryable:true}});
  expect(['tool_calls','runtime_events','runs'].map(table=>db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
});
it('P9 T03 fix1 WAL reader keeps initial product and original source facts in one committed snapshot', () => {
  const f=p9ReadFixture(),db=f.store.db;
  db.exec('PRAGMA locking_mode=NORMAL; PRAGMA journal_mode=WAL;');
  const writer=new Database(f.productPaths.databaseFile);
  deferCleanup(()=>writer.close());
  expect(db.query('PRAGMA journal_mode').get()).toEqual({journal_mode:'wal'});
  const query=db.query.bind(db);let sawProduct=false,changed=false,writerError:unknown=null;
  const spy=spyOn(db,'query').mockImplementation(((sql:string)=>{
    if(sawProduct&&!changed) {changed=true;try {writer.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.message.content','concurrent') WHERE session_id=? AND entry_id='p8-user'").run(f.target.sessionId);} catch(error) {writerError=error;throw error;}}
    if(sql==='SELECT * FROM runs WHERE id=?') sawProduct=true;
    return query(sql);
  }) as typeof db.query);
  try {const result=f.readers.runGet();expect(writerError).toBeNull();expect(result).toMatchObject({ok:true});expect(changed).toBe(true);}
  finally {spy.mockRestore();writer.close();}
  expect(f.readers.runGet()).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
});
it('P9 T03 rechecks ancestor material authorization and atomically propagates revocation', () => {
  const f=fixture();business(f);
  f.store.db.query('UPDATE runs SET job_id=1 WHERE id=?').run(f.runId);
  const saved=f.append();f.consume(saved.inputId,saved.content.text);
  const child=frozenFork(f,f.session.sessionId,'auth-child'),target=frozenFork(f,child.sessionId,'auth-target');
  p9TargetInput(f,target);
  f.store.db.query("UPDATE sessions SET status='archived',hidden_at=? WHERE id=?").run(at,f.session.sessionId);
  expect(need(f.store.sessions.isModelUseBlocked(target.sessionId))).toBe(false);
  expect(f.store.documents.hide(1,at)).toMatchObject({ok:false,error:{code:'document_busy'}});
  const before=f.store.db.query('SELECT metadata_json FROM sessions ORDER BY id').all();
  f.store.db.exec(`CREATE TRIGGER reject_descendant BEFORE UPDATE OF metadata_json ON sessions WHEN NEW.id=${target.sessionId} BEGIN SELECT RAISE(ABORT,'descendant'); END`);
  expect(f.store.sessions.revokeDocumentUse({documentId:1,at}).ok).toBe(false);
  expect(f.store.db.query('SELECT metadata_json FROM sessions ORDER BY id').all()).toEqual(before);
  f.store.db.exec('DROP TRIGGER reject_descendant');
  expect(need(f.store.sessions.revokeDocumentUse({documentId:1,at})).affectedSessionIds).toEqual([f.session.sessionId,child.sessionId,target.sessionId]);
  expect(need(f.store.sessions.isModelUseBlocked(target.sessionId))).toBe(true);
  // Simulate missed propagation: ancestor recheck must still refuse the descendant.
  f.store.db.query('UPDATE sessions SET metadata_json=? WHERE id IN (?,?)').run('{"version":1,"model_use_blocked":null}',child.sessionId,target.sessionId);
  expect(need(f.store.sessions.isModelUseBlocked(target.sessionId))).toBe(true);
  f.store.db.exec('DROP TABLE session_forks');
  expect(f.store.sessions.isModelUseBlocked(target.sessionId)).toMatchObject({ok:false,error:{code:'storage_read_failed'}});
});

it('P9 T03 preserves legacy journal bytes and public NULL while enforcing new native context evidence', () => {
  const f=fixture(),saved=f.append();f.consume(saved.inputId,saved.content.text);
  const {includedNativeContexts:_,...binding}=f.binding(saved.inputId,saved.snapshot.id);
  const raw=JSON.stringify({version:1,requests:[{binding,api:'openai-responses',boundAt:at,sdkPayload:null,transport:'observed-fetch',attempts:[]}]},null,2);
  f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(raw,f.runId);
  expect(need(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId})).items[0]!.binding.includedNativeContexts).toBeNull();
  expect(f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId)).toEqual({context_observations_json:raw});
  f.store.db.query('UPDATE runs SET config_json=? WHERE id=?').run(JSON.stringify({...f.config,historyPolicyVersion:'p9-native-history-v1'}),f.runId);
  expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId})).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  expect(f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId)).toEqual({context_observations_json:raw});
});
it('P9 T03 validates derived SDK direct references and preserves genuine legacy NULL origins', () => {
  const f=fixture(),saved=f.append(),history=f.consume(saved.inputId,saved.content.text);
  need(saveTestHistory(f.store.db,f.store.runtimeEventStore,f.session.sessionId,{...history,entries:[...history.entries,
    {type:'custom_message',id:'custom',parentId:'p8-user',timestamp:at,customType:'fixture',content:'native custom',display:false},
    {type:'branch_summary',id:'summary',parentId:'custom',timestamp:at,fromId:'p8-user',summary:'summary'},
    {type:'message',id:'legacy-user',parentId:'summary',timestamp:at,message:{role:'user',content:'legacy',timestamp:2}}],leafId:'legacy-user'}));
  const target=frozenFork(f,f.session.sessionId,'derived'),local=p9TargetInput(f,target);
  const sources=[{nativeEntryId:'custom',originSessionId:f.session.sessionId,entryType:'custom_message' as const,messageRole:'custom' as const,contextMessageIndex:1,referenceEntryIds:[]},
    {nativeEntryId:'summary',originSessionId:f.session.sessionId,entryType:'branch_summary' as const,messageRole:'branchSummary' as const,contextMessageIndex:2,referenceEntryIds:['p8-user']}];
  const binding:RequestContextBinding={runId:local.runId,sessionId:target.sessionId,nativeSessionId:target.nativeSessionId,inputId:local.inputId,snapshotId:local.snapshot.id,
    requestSequence:1,callSequence:1,includedBindings:need(f.store.sessions.loadHistoryForContext(target.sessionId)).seed.inputs,includedToolResults:[],includedNativeContexts:sources};
  expect(binding.includedBindings).toContainEqual({nativeEntryId:'legacy-user',originRunId:null,inputId:null,snapshotId:null});
  expect(need(f.store.sessions.loadHistoryForContext(target.sessionId)).seed.origins).toContainEqual({nativeEntryId:'legacy-user',originSessionId:f.session.sessionId,originRunId:null});
  for(const changed of [{...sources[1]!,originSessionId:target.sessionId},{...sources[1]!,referenceEntryIds:[]},{...sources[1]!,messageRole:'custom' as const}])
    expect(f.store.context.bindRequest({binding:{...binding,includedNativeContexts:[changed]},api:'openai-responses',transport:'observed-fetch',at}))
      .toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  need(f.store.context.bindRequest({binding,api:'openai-responses',transport:'observed-fetch',at}));
  expect(need(f.store.context.listContextRequests({sessionId:target.sessionId,runId:local.runId})).items[0]!.binding.includedNativeContexts).toEqual(sources);
});
it.each(['fork-cycle','reference-cycle','missing-summary-reference','missing-label'] as const)('P9 T03 rejects nested closure faults: %s', scenario => {
  const f=fixture(),saved=f.append(),history=f.consume(saved.inputId,saved.content.text);
  const entries=[...history.entries,{type:'branch_summary',id:'summary',parentId:'p8-user',timestamp:at,fromId:'p8-user',summary:'summary'},
    {type:'label',id:'label',parentId:'p8-user',timestamp:at,targetId:'p8-user',label:'important'}];
  need(saveTestHistory(f.store.db,f.store.runtimeEventStore,f.session.sessionId,{...history,entries,leafId:'summary'}));
  const child=frozenFork(f,f.session.sessionId,'closure-child'),target=frozenFork(f,child.sessionId,'closure-target');
  const db=f.store.db;
  if(scenario==='fork-cycle') {
    db.exec('DROP TRIGGER session_forks_immutable');
    db.query('UPDATE session_forks SET source_session_id=? WHERE target_session_id=?').run(target.sessionId,child.sessionId);
  }
  if(scenario==='reference-cycle') db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.fromId','summary') WHERE entry_id='summary'").run();
  if(scenario==='missing-summary-reference') db.query("UPDATE session_native_entries SET entry_json=json_set(entry_json,'$.fromId','missing') WHERE entry_id='summary'").run();
  if(scenario==='missing-label') {
    db.query("DELETE FROM session_native_entries WHERE session_id=? AND entry_id='label'").run(target.sessionId);
    db.query('UPDATE session_native_history SET entry_count=2 WHERE session_id=?').run(target.sessionId);
    db.exec('DROP TRIGGER session_forks_immutable');
    db.query("UPDATE session_forks SET inherited_entry_count=2,selected_entry_id='summary' WHERE target_session_id=?").run(target.sessionId);
  }
  expect(f.store.sessions.loadHistoryForContext(target.sessionId)).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
  expect(f.store.sessions.isModelUseBlocked(target.sessionId)).toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
});
describe('P8 Context storage', () => {
  it('keeps missing P11 evidence absent and commits request duplicates with original identity and failure rollback', () => {
    const f = fixture(), owner = { sessionId: f.session.sessionId, runId: f.runId };
    const reader = Reflect.get(f.store.context, 'readResourceEvidence');
    const writer = Reflect.get(f.store.context, 'recordResourceRequest');
    expect(typeof reader).toBe('function'); expect(typeof writer).toBe('function');
    if (typeof reader !== 'function' || typeof writer !== 'function') throw new Error('P11 resource journal is not connected');
    expect(reader(owner)).toEqual(ok(null));
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify({ version: 1, requests: [], resources: emptyResourceJournal() }), f.runId);
    const input = f.append(); f.consume(input.inputId, input.content.promptText);
    need(f.store.context.bindRequest({ binding: f.binding(input.inputId, input.snapshot.id), api: 'openai-responses', at, transport: 'observed-fetch' }));
    const value = { purpose: 'answer' as const, callSequence: 1, compactionOperationId: null, bundleHash: null,
      referencedBundleHashes: [], systemPromptHash: createHash('sha256').update('fixture').digest('hex'),
      inputIds: [input.inputId], toolCallIds: [], contentChecks: [], at };
    expect(writer(value, owner)).toEqual(ok(undefined));
    expect(writer({ ...value, at: later }, owner)).toEqual(ok(undefined));
    expect(reader(owner)).toMatchObject({ ok: true, data: { requests: [{ ...value, at }] } });
    const before = f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId);
    expect(writer({ ...value, systemPromptHash: 'b'.repeat(64) }, owner)).toMatchObject({ ok: false, error: { code: 'resource_evidence_conflict' } });
    expect(writer(value, { ...owner, sessionId: owner.sessionId + 1 }).ok).toBe(false);
    expect(writer({ ...value, inputIds: [input.inputId + 1] }, owner).ok).toBe(false);
    expect(f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId)).toEqual(before);
    const second = { ...f.binding(input.inputId, input.snapshot.id), requestSequence: 2, callSequence: 2 };
    need(f.store.context.bindRequest({ binding: second, api: 'openai-responses', at: later, transport: 'observed-fetch' }));
    const saved = f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId);
    f.store.db.exec("CREATE TRIGGER p11_fail_evidence BEFORE UPDATE OF context_observations_json ON runs BEGIN SELECT RAISE(ABORT,'P11 evidence fault'); END;");
    expect(writer({ ...value, callSequence: 2, at: later }, owner)).toMatchObject({ ok: false, error: { code: 'resource_evidence_write_failed' } });
    expect(f.store.db.query('SELECT context_observations_json FROM runs WHERE id=?').get(f.runId)).toEqual(saved);
    f.store.db.exec('DROP TRIGGER p11_fail_evidence');
    expect(writer({ ...value, callSequence: 2, at: later }, owner)).toEqual(ok(undefined));
  });
  it('migrates real 014 without rewriting legacy evidence and installs all guards', () => {
    const productPaths = paths(), old = schema14(productPaths);
    seedOldInputs(old);
    const before = old.query('SELECT content_json,request_hash FROM session_inputs ORDER BY id').all();
    old.close();
    const migrated = need(openTestDatabase(productPaths));
    expect(migrated.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 17 });
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
    const f=fixture(),toolFacts=scenario==='changed-tool-context'?p9ToolHistory(f,'changed-context'):null;
    const saved=toolFacts?.saved??f.append(); if(!toolFacts) f.consume(saved.inputId,saved.content.text);
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
      const call=toolFacts!.toolId;
      changed.includedToolResults=[{nativeToolCallId:'changed-context',toolCallId:call,originRunId:f.runId,context:{snapshotId:saved.snapshot.id,requestSequence:2}}];
    }
    f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(JSON.stringify({version:1,requests:[{binding:changed,api:'openai-responses',
      boundAt:at,sdkPayload:null,transport:'observed-fetch',attempts:[]}]}),f.runId);
    expect(f.store.context.listContextRequests({sessionId:f.session.sessionId,runId:f.runId}))
      .toMatchObject({ok:false,error:{code:'context_binding_unknown'}});
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
    const f=fixture(), {saved,toolId:call}=p9ToolHistory(f,'original-call');
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
    const f=fixture(), saved=f.append(), history=f.consume(saved.inputId,saved.content.text);
    const legacyEntries=Array.from({length:511},(_,index)=>({type:'message',id:`legacy-${index}`.padEnd(256,'x'),
      parentId:index===0?'p8-user':`legacy-${index-1}`.padEnd(256,'x'),timestamp:at,message:{role:'user',content:'old',timestamp:index+2}}));
    need(saveTestHistory(f.store.db,f.store.runtimeEventStore,f.session.sessionId,{...history,entries:[...history.entries,...legacyEntries],leafId:legacyEntries.at(-1)!.id}));
    const includedBindings=[...f.binding(saved.inputId,saved.snapshot.id).includedBindings,
      ...legacyEntries.map(entry=>({nativeEntryId:entry.id,originRunId:null,inputId:null,snapshotId:null}))];
    let accepted=0;
    for (let sequence=1;sequence<=64;sequence++) {
      const binding={...f.binding(saved.inputId,saved.snapshot.id),requestSequence:sequence,callSequence:sequence,includedBindings};
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
      for (const item of page.items) { expect(item.binding.includedBindings).toHaveLength(512); seen.push(item.binding.requestSequence); }
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

it('P9 T07 preserves genuinely absent historical markers and journal bytes after reopen', () => {
  // Historical P8 storage fixture: this Run is born without a P9 marker. It is
  // not claimed as an Application-generated request or an image authorization.
  const f = fixture(), saved = f.append(); f.consume(saved.inputId, saved.content.text);
  expect(Object.hasOwn(f.config, 'historyPolicyVersion')).toBe(false);
  const { includedNativeContexts: _notCollected, ...binding } = f.binding(saved.inputId, saved.snapshot.id);
  const raw = JSON.stringify({ version: 1, requests: [{ binding, api: 'openai-responses', boundAt: at,
    sdkPayload: null, transport: 'observed-fetch', attempts: [] }] }, null, 2);
  f.store.db.query('UPDATE runs SET context_observations_json=? WHERE id=?').run(raw, f.runId); finish(f);
  const before = f.store.db.query('SELECT config_json,context_observations_json FROM runs WHERE id=?').get(f.runId);
  f.store.close();
  const reopened = need(openTestDatabase(f.productPaths));
  const page = need(reopened.context.listContextRequests({ sessionId: f.session.sessionId, runId: f.runId }));
  expect(page.items[0]!.binding.includedNativeContexts).toBeNull();
  expect(reopened.db.query('SELECT config_json,context_observations_json FROM runs WHERE id=?').get(f.runId)).toEqual(before);
  expect(reopened.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});

it.each([false, true])('P9 T08 avoids duplicate native validation while preserving legacy public limits (native=%s)', marked => {
  const f = fixture(), saved = f.append(); f.consume(saved.inputId, saved.content.text);
  const full = f.binding(saved.inputId, saved.snapshot.id);
  const { includedNativeContexts: _, ...legacy } = full;
  const raw = { requests: [{ attempts: [], transport: 'observed-fetch', sdkPayload: null, boundAt: at,
    api: 'openai-responses', binding: marked ? full : legacy }], version: 1 };
  const row = { id: f.runId, kind: 'agent', session_id: f.session.sessionId, current_context_snapshot_id: saved.snapshot.id,
    config_json: JSON.stringify({ ...f.config, ...(marked ? { historyPolicyVersion: 'p9-native-history-v1' } : {}) }),
    context_observations_json: JSON.stringify(raw, null, 2) };
  const generic = spyOn(ContextObservationsSchema, 'safeParse'), native = spyOn(NativeContextObservationsSchema, 'safeParse'),
    projected = spyOn(PublicContextObservationsSchema, 'safeParse');
  try {
    const read = readRunContext(row);
    expect(JSON.stringify(read.observations)).toBe(JSON.stringify(raw));
    expect(generic).toHaveBeenCalledTimes(marked ? 0 : 2);
    expect(native).toHaveBeenCalledTimes(marked ? 1 : 0);
    expect(projected).toHaveBeenCalledTimes(marked ? 0 : 1);
  } finally { generic.mockRestore(); native.mockRestore(); projected.mockRestore(); }
});

it('P9 T08 retains the legacy public 4 MiB boundary when adding nullable fields exceeds it', () => {
  const f = fixture(), saved = f.append();
  const { includedNativeContexts: _, ...binding } = f.binding(saved.inputId, saved.snapshot.id);
  const requests = Array.from({ length: 64 }, (_unused, index) => ({ binding: { ...binding,
    requestSequence: index + 1, callSequence: index + 1, includedBindings: [...binding.includedBindings] },
    api: 'openai-responses', boundAt: at, sdkPayload: null, transport: 'observed-fetch', attempts: [] }));
  const raw = { version: 1, requests }, limit = 4 * 1024 * 1024;
  const extra = { nativeEntryId: 'legacy'.padEnd(256, 'x'), originRunId: null, inputId: null, snapshotId: null };
  const count = Math.floor((limit - 128 - Buffer.byteLength(JSON.stringify(raw))) / (Buffer.byteLength(JSON.stringify(extra)) + 1));
  for (let index = 0; index < count; index++) requests[index % requests.length]!.binding.includedBindings.unshift({ ...extra,
    nativeEntryId: String(index).padEnd(256, 'x') });
  expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(limit);
  expect(ContextObservationsSchema.safeParse(raw).success).toBe(true);
  expect(PublicContextObservationsSchema.safeParse({ ...raw, requests: requests.map(request => ({ ...request,
    binding: { ...request.binding, includedNativeContexts: null } })) }).success).toBe(false);
  expect(() => readRunContext({ id: f.runId, kind: 'agent', session_id: f.session.sessionId,
    config_json: JSON.stringify(f.config), current_context_snapshot_id: saved.snapshot.id, context_observations_json: JSON.stringify(raw) }))
    .toThrow('context_binding_unknown');
});

it('P9 T08 keeps malformed, missing-proof and unsupported-marker error precedence after journal read optimization', () => {
  const f = fixture(), saved = f.append(); f.consume(saved.inputId, saved.content.text);
  const { includedNativeContexts: _, ...legacy } = f.binding(saved.inputId, saved.snapshot.id);
  const request = { binding: legacy, api: 'openai-responses', boundAt: at, sdkPayload: null, transport: 'observed-fetch', attempts: [] };
  for (const [marker, journal, code] of [
    ['p9-native-history-v1', { version: 1, requests: [request] }, 'context_binding_unknown'],
    ['p9-native-history-v1', { version: 1 }, 'storage_corrupt'],
    ['future-history', { version: 1 }, 'storage_corrupt'],
    ['future-history', { version: 1, requests: [request] }, 'context_binding_unknown'],
  ] as const) {
    f.store.db.query('UPDATE runs SET config_json=?,context_observations_json=? WHERE id=?').run(
      JSON.stringify({ ...f.config, historyPolicyVersion: marker }), JSON.stringify(journal), f.runId);
    expect(f.store.context.listContextRequests({ sessionId: f.session.sessionId, runId: f.runId }))
      .toMatchObject({ ok: false, error: { code } });
  }
});
