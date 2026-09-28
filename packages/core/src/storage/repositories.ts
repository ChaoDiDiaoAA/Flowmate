import type { Database } from 'bun:sqlite';
import { appError, fail, ok } from '@flowmate/contracts';
import type {
  AgentRunSnapshot,
  AppError,
  ChatScope,
  CleanupRecord,
  DbId,
  InputRecord,
  OutputRecord,
  Result,
  RunSnapshot,
  SessionCursor,
  NormalizedListSessionsRequest,
  NormalizedSessionRunsRequest,
  SessionStatus,
  SafeConfigSnapshot,
  SdkUsageValues,
  TokenColumns,
  UsageRecord,
} from '@flowmate/contracts';
import type { AgentConfigFacts, AgentFacts } from '@flowmate/contracts';

export type NewProviderRun = {
  goal: string;
  input: InputRecord;
  config: SafeConfigSnapshot;
  usage: UsageRecord;
  cleanup: CleanupRecord;
  createdAt: string;
};

export type NewAgentRun = Omit<NewProviderRun, 'config'> & {
  config: SafeConfigSnapshot & { agent: AgentConfigFacts };
  sessionId: DbId;
  scope: ChatScope;
};

export type SessionRow = {
  sessionId: DbId;
  nativeSessionId: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
};

export type NewSession = { nativeSessionId: string; title: string; at: string };

export type AgentOutputRecord = OutputRecord & { agent: AgentFacts };

export interface SessionRepository {
  create(input: NewSession): Result<SessionRow>;
  get(sessionId: DbId): Result<SessionRow>;
  list(request: NormalizedListSessionsRequest): Result<{ items: SessionRow[]; next: SessionCursor | null }>;
  rename(input: { sessionId: DbId; title: string; at: string }): Result<SessionRow>;
  prepareDelete(sessionId: DbId, at: string): Result<SessionRow>;
  delete(sessionId: DbId): Result<void>;
}

export type TerminalWrite = {
  status: 'completed' | 'failed' | 'cancelled';
  output: OutputRecord | AgentOutputRecord | null;
  error: AppError | null;
  usage: UsageRecord;
  tokens: TokenColumns;
  cleanup: CleanupRecord;
  endedAt: string;
  stoppedAt: string | null;
  durationMs: number | null;
  cancelRequestedAt?: string;
};

export interface RunRepository {
  create(input: NewProviderRun): Result<DbId>;
  createAgent(input: NewAgentRun): Result<DbId>;
  listBySession(request: NormalizedSessionRunsRequest): Result<{ items: AgentRunSnapshot[]; nextBeforeRunId: DbId | null }>;
  start(runId: DbId, config: SafeConfigSnapshot, startedAt: string): Result<void>;
  recordCancel(runId: DbId, requestedAt: string): Result<boolean>;
  finish(runId: DbId, terminal: TerminalWrite): Result<boolean>;
  get(runId: DbId): Result<RunSnapshot>;
  supplementUsage(runId: DbId, usage: UsageRecord, tokens: TokenColumns): Result<boolean>;
  failInterrupted(endedAt: string): Result<number>;
}

type RunRow = {
  id: number;
  kind: 'provider' | 'agent';
  session_id: number | null;
  scope_json: string | null;
  status: RunSnapshot['status'];
  goal: string;
  input_json: string;
  config_json: string;
  output_json: string | null;
  error_json: string | null;
  cleanup_json: string;
  usage_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost: string | null;
  duration_ms: number | null;
  tool_call_count: number;
  usage_complete: 0 | 1;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_requested_at: string | null;
  stopped_at: string | null;
};

function databaseError(message = '数据库操作失败。'): ReturnType<typeof appError> {
  return appError('storage_write_failed', 'storage', message, true);
}

function isBusyConstraint(error: unknown): boolean {
  return error instanceof Error && /runs_one_active|UNIQUE constraint failed/i.test(error.message);
}

function asJson(value: unknown): string {
  return JSON.stringify(value);
}

function readJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`invalid_${label}_json`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_${label}_shape`);
  return value as Record<string, unknown>;
}

function versioned(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const record = object(value, label);
  if (record.version !== 1 || keys.some((key) => !(key in record))) throw new Error(`invalid_${label}_version_or_shape`);
  return record;
}

function validAppError(value: unknown, label: string, requireVersion: boolean): AppError {
  const record = object(value, label);
  if ((requireVersion && record.version !== 1)
    || typeof record.code !== 'string'
    || !['provider', 'runtime', 'tool', 'session', 'storage', 'input', 'extension', 'internal'].includes(String(record.category))
    || typeof record.message !== 'string'
    || typeof record.retryable !== 'boolean'
    || (record.runId !== undefined && (!Number.isSafeInteger(record.runId) || Number(record.runId) <= 0))) {
    throw new Error(`invalid_${label}_shape`);
  }
  return record as unknown as AppError;
}

function validatedInput(value: unknown): Record<string, unknown> {
  const record = versioned(value, 'input', ['goal', 'text', 'messageTimestamp']);
  if (typeof record.goal !== 'string' || typeof record.text !== 'string' || typeof record.messageTimestamp !== 'number') throw new Error('invalid_input_shape');
  return record;
}

function validatedAgentConfig(value: unknown): Record<string, unknown> {
  const agent = object(value, 'config_agent');
  if (agent.policyVersion !== 'p2-invoice-chat-v1'
    || typeof agent.nativeSessionId !== 'string' || agent.nativeSessionId.length < 1 || agent.nativeSessionId.length > 128
    || typeof agent.systemPrompt !== 'string'
    || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(agent.thinkingLevel))
    || agent.resourcePolicy !== 'none'
    || agent.historyPolicy !== 'memory-only'
    || agent.maxContextBytes !== 524_288
    || agent.maxOutputBytes !== 262_144
    || agent.maxAssistantContentBytes !== 524_288
    || agent.maxModelCalls !== 1
    || agent.sessionRetry !== false) throw new Error('invalid_agent_config_shape');
  return agent;
}

function validatedConfig(value: unknown, kind: RunRow['kind'] = 'provider'): Record<string, unknown> {
  const record = versioned(value, 'config', ['name', 'revision', 'requestedModel', 'resolvedModel', 'api', 'endpoint', 'sdk', 'parameters', 'limits', 'native']);
  if (typeof record.name !== 'string' || !Number.isSafeInteger(record.revision) || Number(record.revision) <= 0) throw new Error('invalid_config_shape');
  const model = (candidate: unknown, label: string) => {
    if (candidate === null && label === 'resolvedModel') return;
    const value = object(candidate, label);
    if (typeof value.provider !== 'string' || typeof value.model !== 'string') throw new Error(`invalid_${label}_shape`);
  };
  model(record.requestedModel, 'requestedModel');
  model(record.resolvedModel, 'resolvedModel');
  object(record.sdk, 'config_sdk');
  object(record.parameters, 'config_parameters');
  object(record.limits, 'config_limits');
  object(record.native, 'config_native');
  if (record.outputBudget !== undefined) versioned(record.outputBudget, 'outputBudget', ['policy', 'selectedMaxTokens', 'source']);
  if (kind === 'agent') validatedAgentConfig(record.agent);
  else if (record.agent !== undefined) throw new Error('unexpected_provider_agent_config');
  return record;
}

function validatedAgentFacts(value: unknown): Record<string, unknown> {
  const agent = object(value, 'output_agent');
  if (typeof agent.nativeSessionId !== 'string' || agent.nativeSessionId.length < 1 || agent.nativeSessionId.length > 128
    || !Number.isSafeInteger(agent.turnCount) || Number(agent.turnCount) < 0
    || !Number.isSafeInteger(agent.modelCallCount) || Number(agent.modelCallCount) < 0) throw new Error('invalid_agent_output_shape');
  return agent;
}

function validatedScope(value: unknown): ChatScope {
  const record = object(value, 'scope');
  if (record.version !== 1 || record.mode !== 'chat-text'
    || !Array.isArray(record.toolNames) || record.toolNames.length !== 0
    || !Array.isArray(record.resourcePaths) || record.resourcePaths.length !== 0
    || Object.keys(record).some((key) => !['version', 'mode', 'toolNames', 'resourcePaths'].includes(key))) {
    throw new Error('invalid_agent_scope_shape');
  }
  return record as unknown as ChatScope;
}

function validatedOutput(value: unknown, kind: RunRow['kind'] = 'provider'): Record<string, unknown> {
  const record = versioned(value, 'output', ['text', 'partial', 'stopReason', 'responseId', 'responseModel']);
  if (typeof record.text !== 'string' || typeof record.partial !== 'boolean' || typeof record.stopReason !== 'string'
    || (record.wireMaxTokens !== undefined && record.wireMaxTokens !== null && (!Number.isSafeInteger(record.wireMaxTokens) || Number(record.wireMaxTokens) < 1))) throw new Error('invalid_output_shape');
  if (kind === 'agent') validatedAgentFacts(record.agent);
  else if (record.agent !== undefined) throw new Error('unexpected_provider_agent_output');
  return record;
}

function validatedUsage(value: unknown): UsageRecord {
  const record = versioned(value, 'usage', ['source', 'reason', 'sdkValues', 'attempts', 'attemptsComplete', 'costSource', 'updatedAt']);
  if (!['sdk', 'unknown', 'not-requested'].includes(String(record.source))
    || (record.reason !== null && typeof record.reason !== 'string')
    || (record.sdkValues !== null && typeof record.sdkValues !== 'object')
    || (record.attempts !== null && (!Number.isSafeInteger(record.attempts) || Number(record.attempts) < 0))
    || typeof record.attemptsComplete !== 'boolean'
    || (record.costSource !== null && typeof record.costSource !== 'string')
    || typeof record.updatedAt !== 'string') throw new Error('invalid_usage_shape');
  return record as unknown as UsageRecord;
}

function validatedCleanup(value: unknown): CleanupRecord {
  const record = versioned(value, 'cleanup', ['stopped', 'stopReason', 'errors', 'lateObservationRequired']);
  if (typeof record.stopped !== 'boolean' || (record.stopReason !== null && typeof record.stopReason !== 'string')
    || !Array.isArray(record.errors) || typeof record.lateObservationRequired !== 'boolean') throw new Error('invalid_cleanup_shape');
  record.errors.forEach((entry, index) => validAppError(entry, `cleanup_error_${index}`, false));
  return record as unknown as CleanupRecord;
}

function validatedError(value: unknown): AppError | null {
  if (value === null) return null;
  return validAppError(value, 'error', true);
}

function sessionRow(value: unknown): SessionRow {
  const row = value as {
    id: number; native_session_id: string; title: string; status: string; created_at: string; updated_at: string;
  } | null;
  if (!row || !Number.isSafeInteger(row.id) || row.id <= 0
    || typeof row.native_session_id !== 'string' || row.native_session_id.length < 1 || row.native_session_id.length > 128
    || typeof row.title !== 'string' || row.title.trim().length < 1 || [...row.title].length > 120
    || !['active', 'archived'].includes(row.status)
    || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') throw new Error('invalid_session_row');
  return {
    sessionId: row.id,
    nativeSessionId: row.native_session_id,
    title: row.title,
    status: row.status as SessionRow['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotFromRow(row: RunRow): RunSnapshot {
  const output = row.output_json === null ? null : validatedOutput(readJson(row.output_json, 'output'), row.kind);
  const error = validatedError(readJson(row.error_json ?? 'null', 'error'));
  const input = validatedInput(readJson(row.input_json, 'input'));
  const config = validatedConfig(readJson(row.config_json, 'config'), row.kind);
  const usage = validatedUsage(readJson(row.usage_json, 'usage'));
  const cleanup = validatedCleanup(readJson(row.cleanup_json, 'cleanup'));
  const base = {
    runId: row.id,
    status: row.status,
    input,
    config,
    output,
    usage,
    tokens: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      cost: row.cost,
      usageComplete: row.usage_complete === 1,
    },
    durationMs: row.duration_ms,
    toolCallCount: row.tool_call_count,
    error,
    cleanup,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    cancelRequestedAt: row.cancel_requested_at,
    stoppedAt: row.stopped_at,
  };
  if (row.kind === 'provider') {
    if (row.session_id !== null || row.scope_json !== null) throw new Error('invalid_provider_session_reference');
    return { ...base, kind: 'provider', sessionId: null, scope: null };
  }
  if (!Number.isSafeInteger(row.session_id) || Number(row.session_id) <= 0 || row.scope_json === null) {
    throw new Error('invalid_agent_session_reference');
  }
  return {
    ...base,
    kind: 'agent',
    sessionId: Number(row.session_id),
    scope: validatedScope(readJson(row.scope_json, 'scope')),
  };
}

const usageKeys: readonly (keyof SdkUsageValues)[] = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens',
  'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'costTotal',
];

function mergeUsage(current: UsageRecord, incoming: UsageRecord): UsageRecord {
  const currentValues = current.sdkValues;
  const incomingValues = incoming.sdkValues;
  const mergedValues = currentValues !== null || incomingValues !== null
    ? usageKeys.reduce<SdkUsageValues>((result, key) => {
      result[key] = currentValues?.[key] ?? incomingValues?.[key] ?? null;
      return result;
    }, {
      input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null,
      costInput: null, costOutput: null, costCacheRead: null, costCacheWrite: null, costTotal: null,
    })
    : null;
  const source = current.source === 'sdk' || incoming.source === 'sdk' ? 'sdk' : current.source;
  return {
    version: 1,
    source,
    reason: source === 'sdk' ? null : incoming.reason ?? current.reason,
    sdkValues: mergedValues,
    attempts: current.attempts ?? incoming.attempts,
    attemptsComplete: current.attemptsComplete || incoming.attemptsComplete,
    costSource: current.costSource ?? incoming.costSource,
    updatedAt: incoming.updatedAt,
  };
}

function transaction<T>(db: Database, fn: () => T): Result<T> {
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = fn();
    db.exec('COMMIT');
    return ok(result);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the original storage failure; the connection is closed by owner.
    }
    if (isBusyConstraint(error)) {
      return fail(appError('runtime_busy', 'runtime', '已有 Provider Run 正在执行。'));
    }
    return fail(databaseError());
  }
}

export function createSessionRepository(db: Database): SessionRepository {
  return {
    create(input) {
      return transaction(db, () => {
        const result = db.query('INSERT INTO sessions(native_session_id,title,created_at,updated_at) VALUES (?,?,?,?)')
          .run(input.nativeSessionId, input.title, input.at, input.at);
        const id = Number(result.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('unsafe_session_id');
        return sessionRow(db.query('SELECT * FROM sessions WHERE id=?').get(id));
      });
    },

    get(sessionId) {
      try {
        const row = db.query('SELECT * FROM sessions WHERE id=?').get(sessionId);
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        return ok(sessionRow(row));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Session 事实无法读取。'));
      }
    },

    list(request) {
      try {
        const rows = request.before
          ? db.query(`SELECT * FROM sessions
              WHERE updated_at < ? OR (updated_at = ? AND id < ?)
              ORDER BY updated_at DESC,id DESC LIMIT ?`)
            .all(request.before.updatedAt, request.before.updatedAt, request.before.sessionId, request.limit + 1)
          : db.query('SELECT * FROM sessions ORDER BY updated_at DESC,id DESC LIMIT ?').all(request.limit + 1);
        const mapped = (rows as unknown[]).map(sessionRow);
        const hasMore = mapped.length > request.limit;
        const items = hasMore ? mapped.slice(0, request.limit) : mapped;
        const last = items.at(-1);
        return ok({
          items,
          next: hasMore && last ? { updatedAt: last.updatedAt, sessionId: last.sessionId } : null,
        });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Session 列表无法读取。'));
      }
    },

    rename(input) {
      const result = transaction(db, () => {
        const changed = db.query('UPDATE sessions SET title=?,updated_at=? WHERE id=?')
          .run(input.title, input.at, input.sessionId).changes;
        return changed === 1
          ? ok(sessionRow(db.query('SELECT * FROM sessions WHERE id=?').get(input.sessionId)))
          : fail(appError('session_not_found', 'session', 'Session 不存在。'));
      });
      return result.ok ? result.data : result;
    },

    prepareDelete(sessionId, at) {
      const prepared = transaction(db, () => {
        const row = db.query('SELECT * FROM sessions WHERE id=?').get(sessionId);
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (db.query("SELECT id FROM runs WHERE kind='agent' AND session_id=? AND status IN ('created','running') LIMIT 1").get(sessionId)) {
          return fail(appError('session_busy', 'session', 'An Agent Run is active in this Session. Wait for it to finish before deleting this Session.', true));
        }
        db.query("UPDATE sessions SET status='archived',updated_at=? WHERE id=? AND status!='archived'").run(at, sessionId);
        return ok(sessionRow(db.query('SELECT * FROM sessions WHERE id=?').get(sessionId)));
      });
      return prepared.ok ? prepared.data : prepared;
    },

    delete(sessionId) {
      const deleted = transaction(db, () => {
        const row = db.query('SELECT status FROM sessions WHERE id=?').get(sessionId) as { status: string } | null;
        if (!row) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (row.status !== 'archived') {
          return fail(appError('session_delete_not_prepared', 'session', 'Session deletion has not been prepared.'));
        }
        if (db.query("SELECT id FROM runs WHERE kind='agent' AND session_id=? AND status IN ('created','running') LIMIT 1").get(sessionId)) {
          return fail(appError('session_busy', 'session', 'An Agent Run is active in this Session. Wait for it to finish before deleting this Session.', true));
        }
        db.query("DELETE FROM runs WHERE kind='agent' AND session_id=?").run(sessionId);
        if (db.query('DELETE FROM sessions WHERE id=?').run(sessionId).changes !== 1) {
          return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        }
        return ok(undefined);
      });
      return deleted.ok ? deleted.data : deleted;
    },
  };
}

export function createRunRepository(db: Database): RunRepository {
  return {
    create(input) {
      const result = transaction(db, () => {
        const inserted = db
          .query(
            `INSERT INTO runs
              (kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
             VALUES ('provider',NULL,NULL,'created',?,?,?,?,?,?)`,
          )
          .run(input.goal, asJson(input.input), asJson(input.config), asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const id = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(id)) throw new Error('unsafe_run_id');
        return id;
      });
      return result;
    },

    createAgent(input) {
      const created = transaction(db, () => {
        const session = db.query('SELECT status FROM sessions WHERE id=?').get(input.sessionId) as { status: string } | null;
        if (!session) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        if (session.status !== 'active') return fail(appError('session_archived', 'session', '归档 Session 不能继续执行。'));
        validatedScope(input.scope);
        const inserted = db.query(`INSERT INTO runs
          (kind,session_id,scope_json,status,goal,input_json,config_json,cleanup_json,usage_json,created_at)
          VALUES ('agent',?,?,'created',?,?,?,?,?,?)`)
          .run(input.sessionId, asJson(input.scope), input.goal, asJson(input.input), asJson(input.config),
            asJson(input.cleanup), asJson(input.usage), input.createdAt);
        const id = Number(inserted.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('unsafe_run_id');
        db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(input.createdAt, input.sessionId);
        return ok(id);
      });
      return created.ok ? created.data : created;
    },

    start(runId, config, startedAt) {
      try {
        const changed = db
          .query("UPDATE runs SET status='running', config_json=?, started_at=? WHERE id=? AND status='created'")
          .run(asJson(config), startedAt, runId).changes;
        return changed === 1
          ? ok(undefined)
          : fail(appError('run_state_invalid', 'runtime', 'Run 不处于可启动状态。', false, runId));
      } catch {
        return fail(databaseError(), runId);
      }
    },

    recordCancel(runId, requestedAt) {
      try {
        const changed = db
          .query("UPDATE runs SET cancel_requested_at=? WHERE id=? AND status IN ('created','running')")
          .run(requestedAt, runId).changes;
        return ok(changed === 1);
      } catch {
        return fail(databaseError(), runId);
      }
    },

    finish(runId, terminal) {
      const result = transaction(db, () => {
        const active = db.query("SELECT kind,session_id FROM runs WHERE id=? AND status IN ('created','running')")
          .get(runId) as { kind: 'provider' | 'agent'; session_id: number | null } | null;
        const changed = db
          .query(
            `UPDATE runs SET
              status=?, output_json=?, error_json=?, cleanup_json=?, usage_json=?,
              input_tokens=?, output_tokens=?, total_tokens=?, cost=?, usage_complete=?,
              duration_ms=?, cancel_requested_at=COALESCE(cancel_requested_at,?), ended_at=?, stopped_at=?
             WHERE id=? AND status IN ('created','running')`,
          )
          .run(
            terminal.status,
            terminal.output === null ? null : asJson(terminal.output),
            terminal.error === null ? null : asJson({ version: 1, ...terminal.error }),
            asJson(terminal.cleanup),
            asJson(terminal.usage),
            terminal.tokens.inputTokens,
            terminal.tokens.outputTokens,
            terminal.tokens.totalTokens,
            terminal.tokens.cost,
            terminal.tokens.usageComplete ? 1 : 0,
            terminal.durationMs,
            terminal.cancelRequestedAt ?? null,
            terminal.endedAt,
            terminal.stoppedAt,
            runId,
          ).changes;
        if (changed === 1 && active?.kind === 'agent' && active.session_id !== null) {
          db.query('UPDATE sessions SET updated_at=? WHERE id=?').run(terminal.endedAt, active.session_id);
        }
        return changed === 1;
      });
      return result.ok ? result : { ...result, ...(result.error && runId !== undefined ? { runId } : {}) };
    },

    get(runId) {
      try {
        const row = db.query('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | null;
        if (!row) return fail(appError('run_not_found', 'input', 'Run 不存在。', false, runId));
        return ok(snapshotFromRow(row));
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Run 事实无法读取。', false, runId));
      }
    },

    listBySession(request) {
      try {
        const session = db.query('SELECT id FROM sessions WHERE id=?').get(request.sessionId);
        if (!session) return fail(appError('session_not_found', 'session', 'Session 不存在。'));
        const rows = request.beforeRunId === undefined
          ? db.query("SELECT * FROM runs WHERE session_id=? AND kind='agent' ORDER BY id DESC LIMIT ?")
            .all(request.sessionId, request.limit + 1)
          : db.query("SELECT * FROM runs WHERE session_id=? AND kind='agent' AND id<? ORDER BY id DESC LIMIT ?")
            .all(request.sessionId, request.beforeRunId, request.limit + 1);
        const mapped = (rows as RunRow[]).map((row) => snapshotFromRow(row) as AgentRunSnapshot);
        const hasMore = mapped.length > request.limit;
        const items = hasMore ? mapped.slice(0, request.limit) : mapped;
        return ok({ items, nextBeforeRunId: hasMore ? items.at(-1)?.runId ?? null : null });
      } catch {
        return fail(appError('storage_corrupt', 'storage', 'Session Run 列表无法读取。'));
      }
    },

    supplementUsage(runId, usageValue, tokens) {
      const result = transaction(db, () => {
        const row = db.query('SELECT usage_json,input_tokens,output_tokens,total_tokens,cost FROM runs WHERE id=? AND status IN (\'completed\',\'failed\',\'cancelled\')').get(runId) as { usage_json: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; cost: string | null } | null;
        if (!row) return false;
        const current = validatedUsage(readJson(row.usage_json, 'usage'));
        const currentValues = current.sdkValues;
        const incomingValues = usageValue.sdkValues;
        const conflicts = usageKeys.some((key) => currentValues?.[key] !== null && currentValues?.[key] !== undefined
          && incomingValues?.[key] !== null && incomingValues?.[key] !== undefined && currentValues[key] !== incomingValues[key]);
        const tokenConflicts = (row.input_tokens !== null && tokens.inputTokens !== null && row.input_tokens !== tokens.inputTokens)
          || (row.output_tokens !== null && tokens.outputTokens !== null && row.output_tokens !== tokens.outputTokens)
          || (row.total_tokens !== null && tokens.totalTokens !== null && row.total_tokens !== tokens.totalTokens)
          || (row.cost !== null && tokens.cost !== null && row.cost !== tokens.cost);
        if (conflicts || tokenConflicts) return false;
        const merged = mergeUsage(current, usageValue);
        const changed = db
          .query(
            `UPDATE runs SET
              usage_json=?,
              input_tokens=COALESCE(input_tokens,?),
              output_tokens=COALESCE(output_tokens,?),
              total_tokens=COALESCE(total_tokens,?),
              cost=COALESCE(cost,?),
              usage_complete=CASE WHEN usage_complete=1 THEN 1 ELSE ? END
             WHERE id=? AND status IN ('completed','failed','cancelled')`,
          )
          .run(
            asJson(merged), tokens.inputTokens, tokens.outputTokens, tokens.totalTokens,
            tokens.cost, tokens.usageComplete ? 1 : 0, runId,
          ).changes;
        return changed === 1;
      });
      return result.ok ? result : { ...result, ...(result.error && runId !== undefined ? { runId } : {}) };
    },

    failInterrupted(endedAt) {
      try {
        const error = asJson({ version: 1, ...appError('runtime_interrupted', 'runtime', '上一次进程退出，Run 未收口。') });
        const cleanup = asJson({ version: 1, stopped: false, stopReason: 'process-exit', errors: [], lateObservationRequired: true });
        const changed = db
          .query("UPDATE runs SET status='failed',error_json=?,cleanup_json=?,ended_at=? WHERE status IN ('created','running')")
          .run(error, cleanup, endedAt).changes;
        return ok(changed);
      } catch {
        return fail(databaseError());
      }
    },
  };
}
