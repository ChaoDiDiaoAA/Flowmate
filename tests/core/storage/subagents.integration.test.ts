import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTestDatabase } from '../../support/database.ts';
import { mkdtempSync } from '../../support/resources.ts';
import type { ProductPaths, Result } from '@flowmate/contracts';
import { ContextSnapshotJsonSchema, RunScopeSchema, SUBAGENT_TOOL_NAMES, ok } from '@flowmate/contracts';
import { saveTestHistory } from '../../support/history.ts';

const at = '2026-10-06T08:00:00.000Z';
function need<T>(value: Result<T>): T { if (!value.ok) throw new Error(value.error.code); return value.data; }
function paths(): ProductPaths {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-p13-storage-'));
  return { root, databaseFile: join(root, 'data', 'app.sqlite'), runtimeDir: join(root, 'runtime'),
    logsDir: join(root, 'logs'), artifactsDir: join(root, 'artifacts'), outputsDir: join(root, 'outputs') };
}
function schema16(p: ProductPaths) {
  mkdirSync(dirname(p.databaseFile), { recursive: true });
  const db = new Database(p.databaseFile); db.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../../packages/core/src/storage/migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 16).sort()) {
    const version = Number(name.slice(0, 3)), sql = readFileSync(new URL(name, dir), 'utf8');
    for (const statement of sql.split(version >= 15 ? /^\s*-- statement\s*$/m : ';').map(value => value.trim()).filter(Boolean)) db.exec(statement);
    if ([4, 10, 11, 14, 15, 16].includes(version)) db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys=ON');
  }
  return db;
}
function session(db: Database, id: number) {
  db.query('INSERT INTO sessions(id,native_session_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, `native-${id}`, `Session ${id}`, at, at);
}
function rootRun(db: Database, id = 1) {
  session(db, id);
  db.query(`INSERT INTO runs(id,kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
    VALUES(?,'agent',?,'{}','running','Parent','{}','{}','{}','{}',?)`).run(id, id, at);
}
function origin(db: Database, id = 1, name = 'Agent', runId = 1, sessionId = 1) {
  db.query(`INSERT INTO tool_calls(id,run_id,session_id,native_tool_call_id,tool_name,tool_version,effect,args_json,status,
    delivery_json,cleanup_json,requested_at,started_at) VALUES(?,?,?,?,?,'0.19.0-p13.1','READ','{}','running','{}','{}',?,?)`)
    .run(id, runId, sessionId, `delegate-${id}`, name, at, at);
}
function child(db: Database, { id = 2, parent = 1, tool = 1, sessionId = 2, pluginId = 'plugin-1' } = {}) {
  db.query(`INSERT INTO runs(id,kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at,
    parent_run_id,origin_tool_call_id,plugin_agent_id) VALUES(?,'subagent',?,'{}','created','Child','{}','{}','{}','{}',?,?,?,?)`)
    .run(id, sessionId, at, parent, tool, pluginId);
}
function failRun(db: Database, id: number) { db.query("UPDATE runs SET status='failed',ended_at=?,error_json='{}',stopped_at=? WHERE id=?").run(at, at, id); }

function admissionFixture() {
  const p = paths(), store = need(openTestDatabase(p));
  const parent = need(store.sessions.create({ nativeSessionId: 'parent-native', title: 'Parent', at }));
  const scope = RunScopeSchema.parse({ version: 2, allowedTools: ['Agent', 'read_invoice_document', 'read_invoice_evidence', 'check_invoice_sources', 'read'],
    allowedDocumentIds: [1], allowedArtifactIds: [2], allowedResourcePaths: [] });
  const config = { version: 2 as const, name: 'fixture', revision: 1, requestedModel: { provider: 'fixture', model: 'fixture' },
    resolvedModel: null, api: null, endpoint: null, sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: { maxRetries: 0, maxRetryDelayMs: 100 }, limits: { timeoutMs: 1000, stopGraceMs: 100 },
    native: { authSource: 'unknown' as const, modelsSelection: null }, contextPolicyVersion: 'p8-context-v1' as const, historyPolicyVersion: 'p9-native-history-v1' as const,
    workingDirectory: p.runtimeDir, runtimeBudget: { maxModelCalls: 16, maxToolCalls: 24, toolTimeoutMs: 1000 },
    agent: { policyVersion: 'runtime-v1' as const, taskPolicyVersion: 'p3-invoice-tools-v1' as const, nativeSessionId: parent.nativeSessionId,
      systemPrompt: 'fixture', thinkingLevel: 'off', resourcePolicy: 'none' as const, historyPolicy: 'memory-only' as const,
      maxContextBytes: 8388608 as const, maxOutputBytes: 262144 as const, maxAssistantContentBytes: 524288 as const,
      maxModelCalls: 16, maxToolCalls: 24, toolTimeoutMs: 1000, sessionRetry: false as const } };
  const runId = need(store.runs.createAgent({ sessionId: parent.sessionId, scope, goal: 'Parent',
    input: { version: 1, goal: 'Parent', text: 'Check', messageTimestamp: 1 }, config, createdAt: at,
    cleanup: { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false },
    usage: { version: 1, source: 'unknown', reason: 'fixture', sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: at } }));
  const parentJson = ContextSnapshotJsonSchema.parse({ version: 1, policyVersion: 'p8-context-v1', text: 'Check', goalMode: 'answer',
    workingDirectory: p.runtimeDir, workspaceContext: null, allowedDocumentIds: [1], allowedArtifactIds: [2], resourcePolicy: 'none',
    modelProjection: { taskGoal: 'Parent evidence', candidate: null, fragments: [], issues: [], gaps: [] },
    budgets: { projectionBytes: 65536, fragmentBytes: 4096, fragments: 32, issueCount: 20, snapshotBytes: 262144 } });
  const snapshot = store.runtimeEventStore.withTransaction(() => need(store.context.appendInTransaction({ runId, sessionId: parent.sessionId, jobId: null, json: parentJson, at })));
  const inputId = Number(store.db.query(`INSERT INTO session_inputs(session_id,client_sequence,mode,goal_mode,request_hash,run_id,
    context_snapshot_id,content_json,status,processing_status,created_at,updated_at) VALUES(?,1,'prompt','answer',?,?,?,?,'queued','pending',?,?)`)
    .run(parent.sessionId, 'a'.repeat(64), runId, snapshot.id, JSON.stringify({ version: 2, text: 'Check', workspaceContext: null,
      workspaceInput: null, allowedDocumentIds: [1], allowedArtifactIds: [2], promptText: 'Check' }), at, at).lastInsertRowid);
  need(saveTestHistory(store.db, store.runtimeEventStore, parent.sessionId, { storageVersion: 1,
    header: { type: 'session', version: 3, id: parent.nativeSessionId, timestamp: at, cwd: p.runtimeDir },
    entries: [{ type: 'message', id: 'parent-user', parentId: null, timestamp: at, message: { role: 'user', content: 'Check', timestamp: 1 } }],
    leafId: 'parent-user', unusable: false }, { runId, entryId: 'parent-user', inputId }));
  need(store.runs.start(runId, config, at));
  const binding = { runId, sessionId: parent.sessionId, nativeSessionId: parent.nativeSessionId, snapshotId: snapshot.id,
    inputId, requestSequence: 1, callSequence: 1,
    includedBindings: [{ originRunId: runId, inputId, snapshotId: snapshot.id, nativeEntryId: 'parent-user' }], includedToolResults: [], includedNativeContexts: [] };
  need(store.context.bindRequest({ binding, api: 'openai-responses', transport: 'observed-fetch', at }));
  const args = { prompt: 'Review the frozen evidence', description: 'Evidence review', subagent_type: 'invoice-evidence-checker' as const };
  const call = need(store.toolCalls.request({ runId, sessionId: parent.sessionId, nativeToolCallId: 'delegate-actual',
    toolName: 'Agent', toolVersion: '0.19.0-p13.1', effect: 'READ', rawArguments: args, requestedAt: at,
    context: { snapshotId: snapshot.id, requestSequence: 1 } }));
  need(store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: args }));
  need(store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
  const origin = { parentRunId: runId, parentSessionId: parent.sessionId, parentNativeSessionId: parent.nativeSessionId,
    originToolCallId: call.toolCallId, parentNativeToolCallId: call.nativeToolCallId,
    extensionInstanceId: '5c080336-167f-437b-9959-0888e7708045', requestBinding: binding };
  const childScope = { ...scope, allowedTools: SUBAGENT_TOOL_NAMES.filter(name => scope.allowedTools.includes(name)) };
  const childConfig = { ...config, goalMode: 'answer' as const, agent: { ...config.agent, nativeSessionId: 'child-native' },
    subagent: { version: 1 as const, role: 'invoice-evidence-checker' as const, pluginVersion: '0.19.0' as const, patchVersion: 'flowmate-p13.1' as const,
      extensionInstanceId: origin.extensionInstanceId, parentNativeSessionId: parent.nativeSessionId,
      parentContextSnapshotId: snapshot.id, parentInputId: inputId, parentRequestSequence: 1 } };
  const request = { origin, pluginAgentId: 'plugin-real-id', nativeSessionId: 'child-native', args, scope: childScope, config: childConfig, at,
    history: { storageVersion: 1 as const, header: { type: 'session' as const, version: 3, id: 'child-native', timestamp: at, cwd: p.runtimeDir },
      entries: [], leafId: null, unusable: false } };
  return { p, store, parent, scope, config, runId, parentJson, snapshot, inputId, args, call, origin, childScope, childConfig, request };
}

describe('P13 SQLite ownership and migration', () => {
  it('018 limits four owned children, including terminal children whose stop is unconfirmed', () => {
    const { db } = need(openTestDatabase(paths())); rootRun(db);
    for (let index = 0; index < 4; index++) {
      origin(db, index+1); session(db, index+2);
      child(db, { id: index+2, tool: index+1, sessionId: index+2, pluginId: 'parallel-'+index });
    }
    origin(db, 5); session(db, 6);
    expect(() => child(db, { id: 6, tool: 5, sessionId: 6, pluginId: 'fifth' })).toThrow('subagent_busy');
    db.query("UPDATE runs SET status='failed',ended_at=?,error_json='{}' WHERE id=2").run(at);
    expect(() => child(db, { id: 6, tool: 5, sessionId: 6, pluginId: 'fifth' })).toThrow('subagent_busy');
    db.query('UPDATE runs SET stopped_at=? WHERE id=2').run(at);
    expect(() => child(db, { id: 6, tool: 5, sessionId: 6, pluginId: 'fifth' })).not.toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it.each(['DROP INDEX runs_one_active_child', 'CREATE TRIGGER subagent_parallel_limit', 'VALUES (18,', 'COMMIT'])
    ('018 rolls back migration failure at %s with its original single-child index', failure => {
      const p = paths(), old = schema16(p);
      old.exec('PRAGMA foreign_keys=OFF'); old.exec('PRAGMA legacy_alter_table=ON');
      const sql = readFileSync(new URL('../../../packages/core/src/storage/migrations/017_subagent_runs.sql', import.meta.url), 'utf8');
      for (const statement of sql.split(/^\s*-- statement\s*$/m).map(value => value.trim()).filter(Boolean)) old.exec(statement);
      old.exec('COMMIT'); old.exec('PRAGMA foreign_keys=ON'); old.exec('PRAGMA legacy_alter_table=OFF'); old.close();
      const original = Database.prototype.exec; let in18 = false, fired = false;
      const exec = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
        if (sql.includes('DROP INDEX runs_one_active_child')) in18 = true;
        if (in18 && !fired && sql.includes(failure)) { fired = true; throw new Error('injected-018'); }
        return Reflect.apply(original, this, [sql]);
      });
      try { expect(openTestDatabase(p)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } }); expect(fired).toBe(true); }
      finally { exec.mockRestore(); }
      const after = new Database(p.databaseFile);
      try { expect(after.query('SELECT max(version) AS version FROM schema_migrations').get()).toEqual({ version: 17 });
        expect(after.query("SELECT name FROM sqlite_master WHERE name='runs_one_active_child'").get()).not.toBeNull();
        expect(after.query("SELECT name FROM sqlite_master WHERE name='subagent_parallel_limit'").get()).toBeNull(); }
      finally { after.close(); }
    });
  it('[F13-12/25] derives parent and every child token totals independently of pagination without writing them back', () => {
    const f = admissionFixture(), child = need(f.store.runs.createSubagent(f.request));
    f.store.db.query('UPDATE runs SET input_tokens=?,output_tokens=?,total_tokens=?,cost=?,usage_complete=1 WHERE id=?').run(10, 4, 14, '0.25', f.runId);
    f.store.db.query('UPDATE runs SET input_tokens=?,output_tokens=?,total_tokens=?,cost=?,usage_complete=1 WHERE id=?').run(20, 6, 26, '0.5', child.runId);
    const page = need(f.store.runs.listSubagents({ parentRunId: f.runId, beforeRunId: child.runId, limit: 1 }));
    expect(page.items).toEqual([]);
    expect(Reflect.get(page, 'totals')).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40, cost: '0.75', usageComplete: true });
    expect(need(f.store.runs.get(f.runId)).tokens).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14, cost: '0.25', usageComplete: true });
    f.store.db.query('UPDATE runs SET cost=NULL,input_tokens=NULL,usage_complete=0 WHERE id=?').run(child.runId);
    expect(Reflect.get(need(f.store.runs.listSubagents({ parentRunId: f.runId, limit: 1 })), 'totals'))
      .toEqual({ inputTokens: null, outputTokens: 10, totalTokens: 40, cost: null, usageComplete: false });
  });
  it('[F13-07/12] rejects expanded child model budgets before creating any identity', () => {
    const f = admissionFixture();
    expect(f.store.runs.createSubagent({ ...f.request, config: { ...f.childConfig,
      runtimeBudget: { ...f.config.runtimeBudget, maxModelCalls: 17 }, agent: { ...f.childConfig.agent, maxModelCalls: 17 } } }))
      .toMatchObject({ ok: false, error: { code: 'subagent_origin_invalid' } });
    expect(f.store.db.query('SELECT (SELECT count(*) FROM sessions) AS sessions,(SELECT count(*) FROM runs) AS runs').get())
      .toEqual({ sessions: 1, runs: 1 });
  });
  it('[F13-09/24/27] rejects child public mutations and preserves parent-child facts when deleting the root', () => {
    const f = admissionFixture(), created = need(f.store.runs.createSubagent(f.request));
    expect(f.store.sessions.rename({ sessionId: created.sessionId, title: 'forged', at }))
      .toMatchObject({ ok: false, error: { code: 'subagent_origin_invalid' } });
    expect(f.store.sessions.setStatus({ sessionId: created.sessionId, expectedStatus: 'active', status: 'archived', at }))
      .toMatchObject({ ok: false, error: { code: 'subagent_origin_invalid' } });
    expect(f.store.sessions.prepareDelete(created.sessionId, at)).toMatchObject({ ok: false });
    expect(f.store.sessions.delete(created.sessionId, at)).toMatchObject({ ok: false });
    const workspace = need(f.store.workspace.read(at));
    expect(f.store.workspace.update({ expectedRevision: workspace.revision, change: { kind: 'session', sessionId: created.sessionId }, at },
      () => { throw new Error('Child selection must reject before material verification'); })).toMatchObject({ ok: false, error: { code: 'subagent_origin_invalid' } });
    failRun(f.store.db, created.runId); failRun(f.store.db, f.runId);
    f.store.db.query('UPDATE runs SET error_json=? WHERE id IN (?,?)')
      .run(JSON.stringify({ version: 1, code: 'agent_goal_not_met', category: 'runtime', message: 'Fixture ended.', retryable: false }), created.runId, f.runId);
    need(f.store.sessions.prepareDelete(f.parent.sessionId, at));
    expect(need(f.store.sessions.delete(f.parent.sessionId, at))).toBe('hidden');
    expect(need(f.store.runs.get(created.runId))).toMatchObject({ parentRunId: f.runId, originToolCallId: f.call.toolCallId });
    expect(f.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it.each([
    ['sessions', "NEW.native_session_id='child-native'"], ['runs', "NEW.kind='subagent'"],
    ['context_snapshots', "EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND kind='subagent')"],
    ['session_inputs', "EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND kind='subagent')"],
    ['session_native_history', "EXISTS(SELECT 1 FROM runs WHERE session_id=NEW.session_id AND kind='subagent')"],
    ['runtime_events', "EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND kind='subagent')"],
  ])('[F13-23] rolls back child admission and unpublished events on %s write failure', (table, condition) => {
    const f = admissionFixture();
    const tables = ['sessions', 'runs', 'context_snapshots', 'session_inputs', 'session_native_history', 'runtime_events'];
    const counts = () => tables.map(name => f.store.db.query(`SELECT count(*) AS count FROM ${name}`).get());
    const before = counts();
    f.store.db.exec(`CREATE TRIGGER reject_child BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'injected-child-write'); END`);
    expect(f.store.runs.createSubagent(f.request)).toMatchObject({ ok: false });
    expect(counts()).toEqual(before);
    expect(f.store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('[F13-07/10/24] records child tools and consumed Input independently, then recovers tools before children before roots with zero replay', () => {
    const f = admissionFixture(), created = need(f.store.runs.createSubagent(f.request));
    const config = { ...f.childConfig, subagent: { ...f.childConfig.subagent, childInputId: created.inputId } };
    need(f.store.runs.start(created.runId, config, at));
    const input = need(f.store.sessionInputs.get(created.inputId))!;
    if (input.content.version !== 2) throw new Error('Missing child frozen input');
    need(f.store.sessionInputs.dispatch(input.inputId, at));
    need(saveTestHistory(f.store.db, f.store.runtimeEventStore, created.sessionId, { ...f.request.history,
      entries: [{ type: 'message', id: 'child-user', parentId: null, timestamp: at,
        message: { role: 'user', content: input.content.promptText, timestamp: 1 } }], leafId: 'child-user' },
      { runId: created.runId, entryId: 'child-user', inputId: input.inputId }));
    const binding = { runId: created.runId, sessionId: created.sessionId, nativeSessionId: f.request.nativeSessionId,
      snapshotId: created.contextSnapshotId, inputId: input.inputId, requestSequence: 1, callSequence: 1,
      includedBindings: [{ originRunId: created.runId, inputId: input.inputId, snapshotId: created.contextSnapshotId, nativeEntryId: 'child-user' }],
      includedToolResults: [], includedNativeContexts: [] };
    need(f.store.context.bindRequest({ binding, api: 'openai-responses', transport: 'observed-fetch', at }));
    const childContext = { runId: created.runId, sessionId: created.sessionId, scope: f.childScope };
    expect(f.store.toolCalls.verifyUse(childContext)).toMatchObject({ ok: true });
    expect(f.store.toolCalls.getNativeWorkingDirectory(childContext)).toEqual(ok(f.p.runtimeDir));
    need(f.store.runs.recordCancel(f.runId, at));
    expect(f.store.toolCalls.verifyUse(childContext)).toMatchObject({ ok: false, error: { code: 'subagent_origin_invalid' } });
    f.store.db.query('UPDATE runs SET cancel_requested_at=NULL WHERE id=?').run(f.runId);
    const call = need(f.store.toolCalls.request({ runId: created.runId, sessionId: created.sessionId,
      nativeToolCallId: f.call.nativeToolCallId, toolName: 'read', toolVersion: '0.85.1', effect: 'READ',
      rawArguments: { path: 'evidence.txt' }, requestedAt: at, context: { snapshotId: created.contextSnapshotId, requestSequence: 1 } }));
    need(f.store.toolCalls.fixArguments({ toolCallId: call.toolCallId, finalArguments: { path: 'evidence.txt' } }));
    need(f.store.toolCalls.start({ toolCallId: call.toolCallId, startedAt: at }));
    expect(call.toolCallId).not.toBe(f.call.toolCallId);
    expect(need(f.store.runs.listSubagents({ parentRunId: f.runId, limit: 20 })).items).toMatchObject([{ childRunId: created.runId,
      childSessionId: created.sessionId, originToolCallId: f.call.toolCallId }]);
    expect(need(f.store.runs.getByOriginToolCall(f.call.toolCallId))).toMatchObject({ runId: created.runId });
    const counts = f.store.db.query('SELECT (SELECT count(*) FROM sessions) AS sessions,(SELECT count(*) FROM runs) AS runs').get();
    f.store.close();
    const reopened = need(openTestDatabase(f.p));
    expect(need(reopened.runs.get(created.runId))).toMatchObject({ kind: 'subagent', status: 'failed', stoppedAt: null,
      error: { code: 'runtime_interrupted' } });
    expect(need(reopened.runs.get(f.runId))).toMatchObject({ status: 'failed', stoppedAt: null });
    expect(reopened.recoveryError).toMatchObject({ code: 'runtime_recovery_blocked' });
    expect(need(reopened.toolCalls.getById(call.toolCallId))).toMatchObject({ runId: created.runId, status: 'failed' });
    expect(need(reopened.sessionInputs.get(created.inputId))).toMatchObject({ status: 'consumed', processingStatus: 'failed', nativeEntryId: 'child-user' });
    expect(reopened.db.query('SELECT (SELECT count(*) FROM sessions) AS sessions,(SELECT count(*) FROM runs) AS runs').get()).toEqual(counts);
    expect(reopened.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('[F13-07/09/10/11] creates child identity, frozen Context, Input and native header in one product transaction', () => {
    const { p, store, parent, config, runId, parentJson, args, call, childScope, request } = admissionFixture();
    const create = Reflect.get(store.runs, 'createSubagent'); expect(typeof create).toBe('function');
    const created = need(create.call(store.runs, request) as Result<{ runId: number; sessionId: number; contextSnapshotId: number; inputId: number }>);
    expect(need(store.runs.get(created.runId))).toMatchObject({ kind: 'subagent', parentRunId: runId, originToolCallId: call.toolCallId,
      pluginAgentId: request.pluginAgentId, scope: childScope, config: { subagent: { childInputId: created.inputId } } });
    expect(need(store.context.queryContextSnapshot({ runId: created.runId, sessionId: created.sessionId, snapshotId: created.contextSnapshotId })))
      .toMatchObject({ snapshot: { json: { modelProjection: parentJson.modelProjection, workspaceContext: null, text: args.prompt } } });
    const childInput = need(store.sessionInputs.get(created.inputId))!;
    expect(childInput).toMatchObject({ mode: 'prompt', goalMode: 'answer', clientSequence: 1, status: 'queued', processingStatus: 'pending',
      content: { workspaceContext: null, workspaceInput: null, allowedDocumentIds: [1], allowedArtifactIds: [2] } });
    if (childInput.content.version !== 2) throw new Error('Child input has no frozen prompt');
    const childContent = childInput.content;
    expect(childContent.promptText).toContain('Parent evidence');
    expect(need(store.memory.load(created.sessionId))!.history).toEqual(request.history);
    expect(need(store.sessions.list({ limit: 20 })).items.map(item => item.sessionId)).toEqual([parent.sessionId]);
    expect(need(store.runs.listBySession({ sessionId: parent.sessionId, limit: 20 })).items.map(item => item.runId)).toEqual([runId]);
    expect(create.call(store.runs, request)).toMatchObject({ ok: false });
    expect(store.db.query('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 2 });
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.sessionInputs.admit({ sessionId: created.sessionId, clientSequence: 2, mode: 'prompt', goalMode: 'answer', text: 'forged',
      config: { version: 1, name: 'fixture', revision: 1, modelRef: { provider: 'fixture', model: 'fixture' },
        native: { authPath: join(p.runtimeDir, 'auth.json'), modelsPath: null }, parameters: config.parameters } },
      () => ok({ runId: created.runId, content: { ...childContent, text: 'forged' } }), at)).toMatchObject({ ok: false });
  });
  it('[F13-08/26] upgrades real 001..016 data without guessing parent relationships', () => {
    const p = paths(), old = schema16(p);
    rootRun(old); failRun(old, 1); origin(old);
    old.query(`INSERT INTO runs(id,goal,input_json,config_json,cleanup_json,usage_json,status,ended_at,error_json,created_at)
      VALUES(2,'Provider','{}','{}','{}','{}','failed',?,'{}',?)`).run(at, at);
    const before = old.query('SELECT * FROM runs ORDER BY id').all();
    const columns = (old.query('PRAGMA table_info(runs)').all() as { name: string }[]).map(row => row.name);
    const objects = old.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name!='runs' AND name!='context_snapshot_insert_guard' ORDER BY name").all();
    old.close();
    const store = need(openTestDatabase(p));
    expect(store.db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 18 });
    expect(store.db.query(`SELECT ${columns.join(',')} FROM runs ORDER BY id`).all()).toEqual(before);
    expect(store.db.query('SELECT parent_run_id,origin_tool_call_id,plugin_agent_id FROM runs').all()).toEqual([
      { parent_run_id: null, origin_tool_call_id: null, plugin_agent_id: null }, { parent_run_id: null, origin_tool_call_id: null, plugin_agent_id: null }]);
    expect(store.db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name!='runs' AND name NOT IN ('context_snapshot_insert_guard','subagent_parallel_limit') ORDER BY name").all()).toEqual(objects);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(store.db.query('PRAGMA legacy_alter_table').get()).toEqual({ legacy_alter_table: 0 });
  });

  it('[F13-08/15] preserves root ownership, immutable origins and terminal ordering with parallel child capacity', () => {
    const { db } = need(openTestDatabase(paths())); rootRun(db); origin(db); session(db, 2); child(db);
    session(db, 3); origin(db, 2);
    expect(() => rootRun(db, 4)).toThrow();
    expect(() => failRun(db, 1)).toThrow('subagent_active_child');
    expect(() => db.query('UPDATE runs SET plugin_agent_id=? WHERE id=2').run('forged')).toThrow('subagent_identity_immutable');
    expect(() => child(db, { id: 3, parent: 2, tool: 2, sessionId: 3 })).toThrow('subagent_origin_invalid');
    failRun(db, 2);
    expect(() => child(db, { id: 3, tool: 1, sessionId: 3, pluginId: 'plugin-2' })).toThrow();
    expect(() => child(db, { id: 3, tool: 2, sessionId: 2, pluginId: 'plugin-2' })).toThrow();
    expect(() => child(db, { id: 3, tool: 2, sessionId: 3, pluginId: 'plugin-1' })).toThrow();
    child(db, { id: 3, tool: 2, sessionId: 3, pluginId: 'plugin-2' }); failRun(db, 3); failRun(db, 1);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('[F13-07/09] rejects wrong tool, parent Session, cancelled parent and forged child Context', () => {
    const { db } = need(openTestDatabase(paths())); rootRun(db); origin(db, 1, 'read'); session(db, 2);
    expect(() => child(db)).toThrow('subagent_origin_invalid');
    db.query("UPDATE tool_calls SET tool_name='Agent' WHERE id=1").run();
    expect(() => child(db, { sessionId: 1 })).toThrow('subagent_origin_invalid');
    db.query('UPDATE runs SET cancel_requested_at=? WHERE id=1').run(at);
    expect(() => child(db)).toThrow('subagent_origin_invalid');
    db.query('UPDATE runs SET cancel_requested_at=NULL WHERE id=1').run(); child(db);
    db.query('UPDATE runs SET cancel_requested_at=? WHERE id=1').run(at);
    expect(() => db.query("UPDATE runs SET status='running' WHERE id=2").run()).toThrow('subagent_parent_closed');
    expect(() => db.query(`INSERT INTO context_snapshots(run_id,session_id,job_id,sequence,snapshot_json,created_at)
      VALUES(2,1,NULL,1,'{}',?)`).run(at)).toThrow('context_identity_invalid');
  });

  it.each(['DROP TABLE runs', 'ALTER TABLE runs_p13', 'CREATE UNIQUE INDEX runs_one_active_root',
    'CREATE TRIGGER subagent_insert_guard', 'VALUES(17,', 'FK', 'COMMIT'])('[F13-26] rolls back 017 failure at %s and restores PRAGMAs', failure => {
    const p = paths(), old = schema16(p); rootRun(old); failRun(old, 1);
    const before = old.query('SELECT * FROM runs').all(); old.close();
    const original = Database.prototype.exec, query = Database.prototype.query; let in17 = false, fired = false, restored = false;
    const exec = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
      if (sql.includes('legacy_alter_table=ON')) in17 = true;
      if (in17 && !fired && (sql.includes(failure) || failure === 'COMMIT' && sql === 'COMMIT')) { fired = true; throw new Error('injected-017'); }
      const result = Reflect.apply(original, this, [sql]);
      if (in17 && fired && sql === 'PRAGMA foreign_keys=ON') restored = (Reflect.apply(query, this, ['PRAGMA foreign_keys']).get() as { foreign_keys: number }).foreign_keys === 1;
      return result;
    });
    const select = spyOn(Database.prototype, 'query').mockImplementation((function (this: Database, sql: string) {
      if (in17 && !fired && failure === 'FK' && sql === 'PRAGMA foreign_key_check') { fired = true; throw new Error('injected-017-fk'); }
      return Reflect.apply(query, this, [sql]);
    }) as typeof Database.prototype.query);
    try { expect(openTestDatabase(p)).toMatchObject({ ok: false, error: { code: 'storage_open_failed' } }); expect(fired).toBe(true); expect(restored).toBe(true); }
    finally { exec.mockRestore(); select.mockRestore(); }
    const after = new Database(p.databaseFile);
    try {
      expect(after.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 16 });
      expect(after.query('SELECT * FROM runs').all()).toEqual(before);
      expect(after.query("SELECT name FROM sqlite_master WHERE name='runs_p13'").get()).toBeNull();
      expect(after.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { after.close(); }
  });
});
