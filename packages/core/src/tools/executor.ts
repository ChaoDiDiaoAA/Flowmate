import { AppErrorSchema, ToolEffectSchema, ToolExecutionContextSchema, ToolExecutionModeSchema, appError, fail, ok } from '@flowmate/contracts';
import type { AppError, DbId, Result, ToolCallDelivery, ToolDefinition, ToolExecutionContext, ToolResult, ToolCallSnapshot } from '@flowmate/contracts';
import { createToolRecorder } from './recorder.ts';
type Recorder = ReturnType<typeof createToolRecorder>;
export type ToolExecution = { call: ToolCallSnapshot; result: ToolResult<unknown>; fatal: boolean };
export type ToolExecutor = ReturnType<typeof createToolExecutor>;
type RunBudget = { ids: Set<string>; resultsBytes: number; closed: boolean; fatal: boolean; deadlineAt?: number };

const encodedSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;
const candidateId = (value: unknown): DbId | null => value && typeof value === 'object'
  && Number.isSafeInteger((value as { candidateId?: unknown }).candidateId)
  && Number((value as { candidateId: number }).candidateId) > 0 ? Number((value as { candidateId: number }).candidateId) : null;

function safeError(value: unknown): AppError {
  if (AppErrorSchema.safeParse(value).success) return AppErrorSchema.parse(value);
  return appError('tool_execution_failed', 'tool', '工具执行失败。', false);
}

export function createToolExecutor(input: {
  definitions: readonly ToolDefinition<any, any>[];
  recorder: Recorder;
  isSessionModelUseBlocked?: (sessionId: DbId) => Result<boolean>;
  now: () => string;
  maxToolCalls?: number;
  maxToolTimeoutMs?: number;
  maxResultBytes?: number;
  monotonicNow?: () => number;
}) {
  const definitions = Object.freeze([...input.definitions]);
  const byName = new Map<string, ToolDefinition<any, any>>();
  for (const definition of definitions) {
    if (!definition || typeof definition.name !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(definition.name)
      || typeof definition.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(definition.version)
      || typeof definition.description !== 'string' || !definition.description.trim() || definition.description.length > 4096
      || !ToolEffectSchema.safeParse(definition.effect).success
      || !ToolExecutionModeSchema.safeParse(definition.executionMode).success
      || !definition.inputSchema || typeof definition.inputSchema.safeParse !== 'function'
      || !definition.outputSchema || typeof definition.outputSchema.safeParse !== 'function'
      || typeof definition.execute !== 'function'
      || (definition.label !== undefined && (typeof definition.label !== 'string' || !definition.label.trim() || definition.label.length > 128))) {
      throw new Error('tool_definition_invalid');
    }
    if (byName.has(definition.name)) throw new Error('tool_name_duplicate');
    byName.set(definition.name, Object.freeze(definition));
  }
  const budgets = new Map<DbId, RunBudget>();
  const active = new Map<string, Promise<ToolExecution>>();
  const maxCalls = input.maxToolCalls ?? 24;
  const maxTimeoutMs = input.maxToolTimeoutMs ?? 10_000;
  const maxResultBytes = input.maxResultBytes ?? 8_388_608;
  const monotonicNow = input.monotonicNow ?? (() => performance.now());

  function observeRequest(name: string, raw: unknown, context: ToolExecutionContext): Result<ToolCallSnapshot> {
    const parsed = ToolExecutionContextSchema.safeParse(context);
    if (!parsed.success) return fail(appError('tool_access_denied', 'runtime', '工具缺少可信 Run 上下文。'));
    const bound = Object.freeze({ ...parsed.data, scope: parsed.data.scope });
    const budget = budgets.get(bound.runId) ?? { ids: new Set<string>(), resultsBytes: 0, closed: false, fatal: false };
    budgets.set(bound.runId, budget);
    const access = input.isSessionModelUseBlocked?.(bound.sessionId);
    if (access && (!access.ok || access.data)) {
      budget.fatal = true;
      budget.closed = true;
      return fail(access.ok ? appError('session_scope_revoked', 'session', '此 Session 已撤回材料使用权限。') : access.error);
    }
    const prior = input.recorder.query({ runId: bound.runId, sessionId: bound.sessionId, nativeToolCallId: bound.nativeToolCallId });
    if (!prior.ok && prior.error.code !== 'tool_call_not_found') {
      budget.fatal = true;
      return prior;
    }
    if (!prior.ok && (budget.closed || budget.fatal || bound.signal.aborted || budget.ids.size >= maxCalls)) {
      budget.fatal ||= !bound.signal.aborted;
      return fail(appError(bound.signal.aborted ? 'agent_cancelled' : 'tool_budget_exceeded', 'runtime',
        bound.signal.aborted ? 'Run 已取消，工具未执行。' : 'Run 已停止接纳新的工具调用。', false,
        bound.runId, bound.sessionId, bound.nativeToolCallId));
    }
    const requested = input.recorder.request({ context: bound, call: { nativeToolCallId: bound.nativeToolCallId, signal: bound.signal },
      name, definition: byName.get(name), raw });
    if (!requested.ok) { budget.fatal = true; return requested; }
    if (!prior.ok) budget.ids.add(bound.nativeToolCallId);
    return requested;
  }

  function rejectRequest(name: string, raw: unknown, context: ToolExecutionContext, error: AppError): Result<void> {
    const requested = observeRequest(name, raw, context);
    if (!requested.ok) return requested;
    if (requested.data.status !== 'requested') return ok(undefined);
    const rejected = input.recorder.reject({ toolCallId: requested.data.toolCallId, error });
    if (!rejected.ok) {
      const budget = budgets.get(context.runId);
      if (budget) budget.fatal = true;
      return rejected;
    }
    return ok(undefined);
  }

  function recordDelivery(context: Pick<ToolExecutionContext, 'runId' | 'sessionId'>, nativeToolCallId: string, delivery: ToolCallDelivery): Result<void> {
    const call = input.recorder.query({ ...context, nativeToolCallId });
    if (!call.ok) return call;
    const updated = input.recorder.recordDelivery(call.data.toolCallId, delivery);
    return updated.ok ? ok(undefined) : updated;
  }

  async function execute(name: string, raw: unknown, context: ToolExecutionContext): Promise<ToolExecution> {
    const contextCheck = ToolExecutionContextSchema.safeParse(context);
    if (!contextCheck.success) {
      const failure = appError('tool_access_denied', 'runtime', '工具缺少可信 Run 上下文。');
      return { call: unavailableCall(context, name), result: { status: 'failed', error: failure }, fatal: true };
    }
    const bound = Object.freeze({ ...contextCheck.data, scope: context.scope });
    const definition = byName.get(name);
    const identity = `${bound.runId}:${bound.nativeToolCallId}`;
    const budget = budgets.get(bound.runId) ?? { ids: new Set<string>(), resultsBytes: 0, closed: false, fatal: false };
    budgets.set(bound.runId, budget);
    const requested = observeRequest(name, raw, bound);
    if (!requested.ok) return { call: unavailableCall(bound, name), result: { status: 'failed', error: requested.error }, fatal: true };
    const call = requested.data;
    const running = active.get(identity);
    if (running) return running;
    if (call.result) return { call, result: call.result, fatal: budget.fatal };
    if (call.status !== 'requested') {
      const failure = appError('state_conflict', 'runtime', 'ToolCall 已开始但当前 Runtime 无在途执行。', true, bound.runId, bound.sessionId, bound.nativeToolCallId);
      budget.fatal = true;
      return { call, result: { status: 'failed', error: failure }, fatal: true };
    }
    if (budget.ids.has(bound.nativeToolCallId)) {
      // A requested row can be registered by the Agent observer before the SDK invokes execute.
    } else {
      budget.ids.add(bound.nativeToolCallId);
    }
    if (budget.closed || budget.fatal || bound.signal.aborted) {
      const failure = appError(bound.signal.aborted ? 'agent_cancelled' : 'tool_budget_exceeded', 'runtime',
        bound.signal.aborted ? 'Run 已取消，工具未执行。' : 'Run 已停止接纳工具调用。', false, bound.runId, bound.sessionId, bound.nativeToolCallId);
      const rejected = input.recorder.reject({ toolCallId: call.toolCallId, error: failure, status: bound.signal.aborted ? 'cancelled' : 'failed' });
      if (!rejected.ok) budget.fatal = true;
      return { call: rejected.ok ? rejected.data : call, result: { status: bound.signal.aborted ? 'cancelled' : 'failed', error: failure }, fatal: budget.fatal };
    }
    const task = runCall(definition, raw, bound, call, budget);
    active.set(identity, task);
    try { return await task; }
    finally { if (active.get(identity) === task) active.delete(identity); }
  }

  async function runCall(definition: ToolDefinition<any, any> | undefined, raw: unknown, context: ToolExecutionContext,
    requestedCall: ToolCallSnapshot, budget: RunBudget): Promise<ToolExecution> {
    const reject = (error: AppError, fatal = false): ToolExecution => {
      const persisted = input.recorder.reject({ toolCallId: requestedCall.toolCallId, error });
      if (!persisted.ok) budget.fatal = true;
      return { call: persisted.ok ? persisted.data : requestedCall, result: { status: 'failed', error }, fatal: fatal || !persisted.ok };
    };
    if (!definition) return reject(appError('tool_not_found', 'tool', '此 Run 未注册请求的工具。'));
    if (!context.scope.allowedTools.includes(definition.name)) return reject(appError('tool_access_denied', 'runtime', '此 Run 未获准使用请求的工具。'));
    const sessionAccess = input.isSessionModelUseBlocked?.(context.sessionId);
    if (sessionAccess && (!sessionAccess.ok || sessionAccess.data)) {
      return reject(sessionAccess.ok ? appError('session_scope_revoked', 'session', '此 Session 已撤回材料使用权限。') : sessionAccess.error, true);
    }
    let argumentsBytes: number;
    try { argumentsBytes = encodedSize(raw); } catch { return reject(appError('tool_invalid_input', 'tool', '工具参数不是可记录的 JSON。')); }
    if (argumentsBytes > 256 * 1024) return reject(appError('tool_result_too_large', 'tool', '工具参数超过输入上限。'));
    const parsed = definition.inputSchema.safeParse(raw);
    if (!parsed.success) return reject(appError('tool_invalid_input', 'tool', '工具参数不符合输入 Schema。'));
    const fixed = input.recorder.fixArguments(requestedCall.toolCallId, parsed.data);
    if (!fixed.ok) { budget.fatal = true; return { call: requestedCall, result: { status: 'failed', error: fixed.error }, fatal: true }; }
    const started = input.recorder.start(requestedCall.toolCallId);
    if (!started.ok) { budget.fatal = true; return { call: requestedCall, result: { status: 'failed', error: started.error }, fatal: true }; }

    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const remainingRunMs = budget.deadlineAt === undefined ? maxTimeoutMs : budget.deadlineAt - monotonicNow();
    const timeoutMs = Math.max(1, Math.min(maxTimeoutMs, remainingRunMs));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort('tool_timeout'); }, timeoutMs);
    let result: ToolResult<unknown>;
    let data: unknown;
    let commitId: DbId | null = null;
    let status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
    let error: AppError | undefined;
    try {
      const call = Object.freeze({ nativeToolCallId: context.nativeToolCallId, signal });
      const product = Object.freeze({ runId: context.runId, sessionId: context.sessionId, scope: context.scope });
      data = await definition.execute(parsed.data, call, product);
      commitId = candidateId(data);
      const output = definition.outputSchema?.safeParse(data);
      if (definition.outputSchema && !output?.success) {
        status = 'failed';
        error = appError('tool_invalid_output', 'tool', '工具返回值不符合输出 Schema。');
      } else if (encodedSize(data) > 256 * 1024) {
        status = 'failed';
        error = appError('tool_result_too_large', 'tool', '工具结果超过输出上限。');
      } else if (timedOut || context.signal.aborted) {
        status = context.signal.aborted ? 'cancelled' : 'failed';
        error = appError(context.signal.aborted ? 'agent_cancelled' : 'tool_timeout', 'runtime',
          context.signal.aborted ? 'Run 已取消。' : '工具执行超过时间上限。', false, context.runId, context.sessionId, context.nativeToolCallId);
      } else if (budget.resultsBytes + encodedSize(data) > maxResultBytes) {
        status = 'failed';
        error = appError('tool_context_limit', 'runtime', '工具结果累计超过 Run 上下文上限。', false, context.runId);
        budget.fatal = true;
      } else budget.resultsBytes += encodedSize(data);
    } catch (thrown) {
      status = context.signal.aborted ? 'cancelled' : timedOut ? 'failed' : 'failed';
      error = timedOut ? appError('tool_timeout', 'runtime', '工具执行超过时间上限。', false, context.runId, context.sessionId, context.nativeToolCallId)
        : context.signal.aborted ? appError('agent_cancelled', 'runtime', 'Run 已取消。', false, context.runId, context.sessionId, context.nativeToolCallId)
          : safeError(thrown);
    } finally {
      clearTimeout(timer);
    }
    if (status === 'succeeded') result = { status: 'succeeded', data };
    else result = { status, error: error ?? appError('tool_execution_failed', 'tool', '工具执行失败。'), ...(data === undefined ? {} : { data }) };
    const ended = input.recorder.finish({ toolCallId: requestedCall.toolCallId, status, ...(data === undefined ? {} : { data }),
      ...(error ? { error } : {}), committedCandidateId: commitId, cleanup: { version: 1, stopReason: timedOut ? 'tool-timeout' : context.signal.aborted ? 'run-abort' : 'tool-settled', stopped: true, errors: [] },
      stoppedAt: input.now() });
    if (!ended.ok) {
      budget.fatal = true;
      return { call: requestedCall, result: { status: 'failed', error: appError('storage_write_failed', 'storage', 'ToolCall 终态无法保存。', true, context.runId, context.sessionId, context.nativeToolCallId) }, fatal: true };
    }
    if (error?.code === 'tool_context_limit' || status === 'cancelled' || timedOut) budget.fatal ||= timedOut;
    return { call: ended.data, result, fatal: budget.fatal };
  }

  return {
    observeRequest,
    rejectRequest,
    recordDelivery,
    execute,
    setRunDeadline(runId: DbId, deadlineAt: number) {
      const budget = budgets.get(runId) ?? { ids: new Set<string>(), resultsBytes: 0, closed: false, fatal: false };
      budget.deadlineAt = Number.isFinite(deadlineAt) ? deadlineAt : monotonicNow();
      budgets.set(runId, budget);
    },
    closeRun(runId: DbId) { const budget = budgets.get(runId); if (budget) budget.closed = true; },
    releaseRun(runId: DbId) { budgets.delete(runId); },
    candidateFacts(runId: DbId) {
      const listed = input.recorder.list(runId, 100);
      if (!listed.ok) return listed;
      const calls = listed.data.items.slice().reverse();
      const candidateIds = [...new Set(calls.flatMap((call) => call.result?.committedCandidateId ? [call.result.committedCandidateId] : []))];
      const deliveredCandidateIds = [...new Set(calls.flatMap((call) => call.result?.committedCandidateId
        && call.result.status === 'succeeded' && call.delivery.state === 'request_observed' ? [call.result.committedCandidateId] : []))];
      return ok({ candidateIds, deliveredCandidateIds });
    },
    listTools: () => definitions,
  };
}

function unavailableCall(context: Partial<ToolExecutionContext>, name: string): ToolCallSnapshot {
  return { toolCallId: 0, runId: context.runId ?? 0, sessionId: context.sessionId ?? 0,
    nativeToolCallId: context.nativeToolCallId ?? 'invalid', toolName: name, toolVersion: null, effect: null,
    status: 'failed', args: { version: 1, raw: null, final: null }, result: null,
    delivery: { version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null },
    cleanup: { version: 1, stopReason: null, stopped: false, errors: [] }, requestedAt: '', startedAt: null, endedAt: null, stoppedAt: null };
}
