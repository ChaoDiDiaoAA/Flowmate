import { AppErrorSchema, FillInvoiceFormOutputSchema, NativeToolOutputSchema, RuntimeStrategySnapshotSchema, ToolEffectSchema, ToolExecutionContextSchema, ToolExecutionModeSchema, ToolExecutionFailure, NATIVE_TOOL_NAMES, INVOICE_REVIEW_TOOL_NAMES, TOOL_CONFIG, RUNTIME_CONFIG, appError, fail, ok } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import type { AppError, DbId, Result, ToolCallDelivery, ToolDefinition, ToolExecutionContext, ToolResult, ToolCallSnapshot, ToolRuntimeObservation, RuntimeStrategySnapshot, ResolvedRuntimeBudget, RuntimeStrategyPolicy } from '@flowmate/contracts';
import { RegisteredToolNameSchema, MAX_TOOL_VERSION_CHARS } from '@flowmate/contracts';
import { createToolRecorder } from './recorder.ts';
import type { ToolCallRepository } from '../storage/repositories.ts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';
import { createCaseEvaluationFault } from './evaluation-fault.ts';
type Recorder = ReturnType<typeof createToolRecorder>;
type ExecutorStorage = { database: Pick<DbHandle, 'read' | 'transaction'>; recorder?: never; isSessionModelUseBlocked?: never }
  | { database?: never; recorder: Recorder; isSessionModelUseBlocked?: (sessionId: DbId) => Result<boolean> };
export type ToolExecution = { call: ToolCallSnapshot; result: ToolResult<unknown>; fatal: boolean };
export type ToolExecutor = ReturnType<typeof createToolExecutor>;
type RunBudget = { ids: Set<string>; resultsBytes: number; closed: boolean; fatal: boolean; deadlineAt?: number;
  limit?: ResolvedRuntimeBudget; strategy?: RuntimeStrategySnapshot; shared?: RunBudget };
export type { RuntimeStrategyPolicy } from '@flowmate/contracts';
type PreparedToolUse = { call: ToolCallSnapshot; definition: ToolDefinition<any, any>; arguments: unknown;
  native: boolean; timeoutMs: number; observation: ToolRuntimeObservation };

const encodedSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;

function safeError(value: unknown): AppError {
  if (AppErrorSchema.safeParse(value).success) return AppErrorSchema.parse(value);
  return appError('tool_execution_failed', 'tool', '工具执行失败。', false);
}

type StrategyInput = { allowedTools: readonly string[]; configuredToolTimeoutMs: number; sdk: { codingAgent: string; ai: string };
  environment: string; sampleSource: ToolRuntimeObservation['sampleSource']; taskType: string; modelKey: string; promptVersion: string };

function isToolExperience(call: ToolCallSnapshot, observation: ToolRuntimeObservation): boolean {
  if (call.status === 'cancelled' || observation.runDeadlineTruncated) return false;
  const errors = [call.result && call.result.status !== 'succeeded' ? call.result.error : null, observation.commitError];
  if (errors.some(error => error !== null && !(error.category === 'tool'
    || error.category === 'input' && ['tool_invalid_input', 'input_invalid', 'source_invalid', 'tool_result_too_large'].includes(error.code)
    || error.category === 'runtime' && error.code === 'tool_timeout'))) return false;
  // Lifecycle failures do not describe tool reliability; an actual invalid output remains a tool diagnostic.
  return observation.afterStructure === 'invalid' || observation.afterDomain === 'invalid'
    || !['identity', 'sdk_before', 'commit', 'storage', 'sdk_after', 'delivery', 'history'].includes(observation.failureStage ?? '');
}

export function freezeRuntimeStrategy(input: StrategyInput & { recorder: Pick<Recorder,'observationCutoff'|'recentStarted'|'recentObservations'>; definitions: readonly Pick<ToolDefinition<any, any>,'name'|'version'|'effect'>[];
  policy?: RuntimeStrategyPolicy }): Result<RuntimeStrategySnapshot> {
  const cutoff = input.recorder.observationCutoff();
  const groups: RuntimeStrategySnapshot['calibration']['groups'] = [];
  const experience: RuntimeStrategySnapshot['experience'] = { version: 1, modelKey: input.modelKey,
    promptVersion: input.promptVersion, taskType: input.taskType, items: [] };
  for (const name of input.allowedTools) {
    const definition = input.definitions.find(tool => tool.name === name);
    if (!definition) continue;
    const groupKey = JSON.stringify([name, definition.version, input.sdk.codingAgent, input.sdk.ai, 'runtime-v1',
      input.environment, input.sampleSource, input.taskType, input.modelKey, input.promptVersion]);
    const group: RuntimeStrategySnapshot['calibration']['groups'][number] = { toolName: name, toolVersion: definition.version, groupKey,
      attemptCount: 0, eligibleCount: 0, p95Ms: null, selectedTimeoutMs: input.configuredToolTimeoutMs,
      timeoutSource: 'configured', fallbackReason: null };
    groups.push(group);
    const statistical = name !== 'Agent' && ['PURE', 'READ'].includes(definition.effect)
      && !NATIVE_TOOL_NAMES.includes(name as (typeof NATIVE_TOOL_NAMES)[number]);
    const recent = cutoff.ok ? input.recorder.recentStarted({ groupKey, cutoff: cutoff.data }) : cutoff;
    if (!recent.ok) { group.fallbackReason = 'read_failed'; continue; }
    const attempts = recent.data;
    group.attemptCount = attempts.length;
    const eligible = attempts.filter(call => call.status === 'succeeded' && call.cleanup.stopped && call.stoppedAt !== null
      && call.runtimeObservation?.beforeOutcome === 'allowed' && call.runtimeObservation.timingComplete
      && call.runtimeObservation.executionDurationMs !== null && !call.runtimeObservation.runDeadlineTruncated
      && call.runtimeObservation.afterStructure === 'valid' && ['valid', 'not_applicable'].includes(call.runtimeObservation.afterDomain));
    group.eligibleCount = eligible.length;
    const risky = attempts.slice(0, TOOL_CONFIG.statistics.riskWindowAttempts).some(call => !call.cleanup.stopped || call.runtimeObservation?.runDeadlineTruncated
      || ['tool_timeout', 'agent_timeout', 'stop_not_confirmed'].includes(call.runtimeObservation?.diagnosticCode ?? ''));
    if (!statistical) group.fallbackReason = 'ineligible_tool';
    else if (input.policy?.statistics === false) group.fallbackReason = 'disabled';
    else if (risky) group.fallbackReason = 'recent_risk';
    else if (eligible.length < TOOL_CONFIG.statistics.minEligibleSamples) group.fallbackReason = 'insufficient_samples';
    else {
      const sorted = eligible.map(call => call.runtimeObservation!.executionDurationMs!).sort((left, right) => left - right);
      // nearest-rank P95 是 p95Ms 的固定语义，不作为自由百分位配置。
      group.p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      group.selectedTimeoutMs = Math.min(input.configuredToolTimeoutMs,
        Math.max(TOOL_CONFIG.statistics.minTimeoutMs, Math.ceil(TOOL_CONFIG.statistics.timeoutMultiplier * group.p95Ms)));
      group.timeoutSource = 'statistical';
    }
    if (input.policy?.experience === false) continue;
    const known = cutoff.ok ? input.recorder.recentObservations({ groupKey, cutoff: cutoff.data }) : cutoff;
    for (const call of known.ok ? known.data : []) {
      const observation = call.runtimeObservation;
      if (!observation || observation.diagnosticCode === null && observation.afterStructure !== 'invalid' && observation.afterDomain !== 'invalid') continue;
      if (!isToolExperience(call, observation)) continue;
      const item = { toolName: name, failureStage: observation.failureStage, diagnosticCode: observation.diagnosticCode,
        afterStructure: observation.afterStructure, afterDomain: observation.afterDomain, timingComplete: observation.timingComplete,
        missingEvidence: observation.commit === 'unknown' || !call.cleanup.stopped || !observation.timingComplete, count: 1 };
      const prior = experience.items.find(candidate => JSON.stringify({ ...candidate, count: 1 }) === JSON.stringify(item));
      if (prior) prior.count++;
      else if (experience.items.length < TOOL_CONFIG.statistics.maxExperienceItems) experience.items.push(item);
    }
  }
  experience.items = experience.items.slice(0, TOOL_CONFIG.statistics.maxExperienceItems);
  return ok({ version: 'runtime-v1', sampleSource: input.sampleSource,
    calibration: { sourceCutoffToolCallId: cutoff.ok ? cutoff.data : 0, groups }, experience });
}

export function createToolExecutor(input: ExecutorStorage & {
  definitions: readonly ToolDefinition<any, any>[];
  now: () => string;
  maxToolCalls?: number;
  maxToolTimeoutMs?: number;
  maxResultBytes?: number;
  monotonicNow?: () => number;
  strategyPolicy?: RuntimeStrategyPolicy;
  sampleSource?: ToolRuntimeObservation['sampleSource'];
  caseFaultProfile?: import('@flowmate/contracts').CaseEvaluationFaultProfile;
}) {
  const caseFault=createCaseEvaluationFault(input.caseFaultProfile);
  if(caseFault&&input.sampleSource!=='evaluation')throw new Error('Case faults require independent evaluation provenance');
  const definitions = Object.freeze([...input.definitions]);
  const byName = new Map<string, ToolDefinition<any, any>>();
  const versionPattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_TOOL_VERSION_CHARS - 1}}$`);
  for (const definition of definitions) {
    if (!definition || !RegisteredToolNameSchema.safeParse(definition.name).success
      || typeof definition.version !== 'string' || !versionPattern.test(definition.version)
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
  // Run 默认额度集中在 packages/contracts/src/runtime-config.ts；载荷／统计策略见 tool-config.ts。
  const maxCalls = input.maxToolCalls ?? RUNTIME_CONFIG.runBudget.maxToolCalls;
  const singleToolTimeoutMs = input.maxToolTimeoutMs ?? RUNTIME_CONFIG.runBudget.toolTimeoutMs;
  const maxResultBytes = input.maxResultBytes ?? RUNTIME_CONFIG.runBudget.maxToolFeedbackBytes;
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const recorderFor = (repository?: ToolCallRepository): Recorder => {
    if (repository) return createToolRecorder(repository, input.now);
    if (input.recorder) return input.recorder;
    throw new Error('tool_storage_scope_required');
  };
  async function writeStorage<T>(database: Pick<DbHandle, 'transaction'>, operation: (store: SqlDatabaseStore) => Result<T>): Promise<Result<T>> {
    let rejected: Result<never> | undefined;
    let confirmed: Result<T> | undefined;
    try {
      return await database.transaction(store => {
        const result = operation(store);
        if (!result.ok) { rejected = result; throw new Error('tool_storage_rejected'); }
        store.db.afterCommit?.(() => { confirmed = result; });
        return result;
      });
    } catch { return confirmed ?? rejected ?? fail(appError('storage_write_failed', 'storage', 'Tool state could not be saved.', true)); }
  }
  const budgetFor = (runId: DbId): RunBudget => {
    let budget = budgets.get(runId);
    if (!budget) { budget = { ids: new Set<string>(), resultsBytes: 0, closed: false, fatal: false }; budgets.set(runId, budget); }
    return budget;
  };
  function acceptFeedback(call: ToolCallSnapshot, budget: RunBudget, data?: unknown, error?: AppError): AppError | undefined {
    budget = budget.shared ?? budget;
    const native = (call.toolName === 'Agent' || NATIVE_TOOL_NAMES.includes(call.toolName as (typeof NATIVE_TOOL_NAMES)[number]))
      ? NativeToolOutputSchema.safeParse(data) : null;
    const bytes = encodedSize({ role: 'toolResult', toolCallId: call.nativeToolCallId, toolName: call.toolName,
      content: native?.success ? native.data.content : [{ type: 'text', text: error ? error.message : JSON.stringify(data) }],
      details: native?.success ? native.data.details : error ? {} : data, isError: error !== undefined, timestamp: Date.now() });
    if (budget.resultsBytes + bytes > maxResultBytes) {
      budget.fatal = true;
      budget.closed = true;
      return appError('tool_context_limit', 'runtime', 'Tool feedback exceeds the shared Run context limit.', false, call.runId);
    }
    budget.resultsBytes += bytes;
  }
  const observationFor = (call: ToolCallSnapshot, budget: RunBudget, beforeOutcome: 'allowed' | 'rejected'): ToolRuntimeObservation => ({
    version: 1, groupKey: budget.strategy?.calibration.groups.find(group => group.toolName === call.toolName)?.groupKey
      ?? JSON.stringify([call.toolName, call.toolVersion, 'unknown-sdk', 'runtime-v1', `${process.platform}-${process.arch}`, input.sampleSource ?? 'production', 'unknown-task']),
    strategyVersion: 'runtime-v1', sampleSource: budget.strategy?.sampleSource ?? input.sampleSource ?? 'production', beforeOutcome,
    failureStage: null, diagnosticCode: null, afterStructure: 'not_applicable', afterDomain: 'not_applicable',
    executionDurationMs: null, timingComplete: false, effectiveTimeoutMs: null, timeoutSource: null,
    runDeadlineTruncated: false, commit: 'none_confirmed', commitError: null,
  });
  function reject(call: ToolCallSnapshot, budget: RunBudget, error: AppError,
    stage: ToolRuntimeObservation['failureStage'] = 'before', fatal = false, repository?: ToolCallRepository): ToolExecution {
    const recorder = recorderFor(repository);
    error = acceptFeedback(call, budget, undefined, error) ?? error;
    const persisted = recorder.reject({ toolCallId: call.toolCallId, error,
      status: error.code === 'agent_cancelled' ? 'cancelled' : 'failed',
      runtimeObservation: { ...observationFor(call, budget, 'rejected'), failureStage: stage, diagnosticCode: error.code } });
    budget.fatal ||= fatal || !persisted.ok;
    if (budget.fatal) budget.closed = true;
    return { call: persisted.ok ? persisted.data : call,
      result: persisted.ok ? persisted.data.result! : { status: 'failed', error: persisted.error }, fatal: budget.fatal };
  }

  function observeRequest(name: string, raw: unknown, context: ToolExecutionContext, store?: SqlDatabaseStore): Result<ToolCallSnapshot> {
    const recorder = recorderFor(store?.toolCalls);
    const parsed = ToolExecutionContextSchema.safeParse(context);
    if (!parsed.success) return fail(appError('tool_access_denied', 'runtime', '工具缺少可信 Run 上下文。'));
    const bound = Object.freeze({ ...parsed.data, scope: parsed.data.scope });
    const budget = budgetFor(bound.runId);
    const shared = budget.shared ?? budget;
    const prior = recorder.query({ runId: bound.runId, sessionId: bound.sessionId, nativeToolCallId: bound.nativeToolCallId });
    if (!prior.ok && prior.error.code !== 'tool_call_not_found') {
      budget.fatal = true;
      return prior;
    }
    if (!prior.ok && (budget.closed || budget.fatal || shared.closed || shared.fatal || bound.signal.aborted
      || shared.ids.size >= (shared.limit?.maxToolCalls ?? maxCalls))) {
      budget.fatal ||= !bound.signal.aborted;
      return fail(appError(bound.signal.aborted ? 'agent_cancelled' : 'tool_budget_exceeded', 'runtime',
        bound.signal.aborted ? 'Run 已取消，工具未执行。' : 'Run 已停止接纳新的工具调用。', false,
        bound.runId, bound.sessionId, bound.nativeToolCallId));
    }
    const requested = recorder.request({ context: bound, call: { nativeToolCallId: bound.nativeToolCallId, signal: bound.signal,
      ...(bound.requestBinding ? { requestBinding: bound.requestBinding } : {}) },
      name, definition: byName.get(name), raw });
    if (!requested.ok) { budget.fatal = true; return requested; }
    if (!prior.ok) shared.ids.add(`${bound.sessionId}:${bound.nativeToolCallId}`);
    return requested;
  }

  function rejectRequest(name: string, raw: unknown, context: ToolExecutionContext, error: AppError,
    stage: ToolRuntimeObservation['failureStage'] = 'unknown', store?: SqlDatabaseStore): Result<void> {
    const requested = observeRequest(name, raw, context, store);
    if (!requested.ok) return requested;
    if (requested.data.status !== 'requested') return ok(undefined);
    const rejected = reject(requested.data, budgetFor(context.runId), error, stage, false, store?.toolCalls);
    if (rejected.fatal && rejected.result.status !== 'succeeded') return fail(rejected.result.error);
    return rejected.call.result ? ok(undefined) : fail(rejected.result.status === 'succeeded'
      ? appError('storage_write_failed', 'storage', 'ToolCall rejection could not be saved.') : rejected.result.error);
  }

  function recordDelivery(context: Pick<ToolExecutionContext, 'runId' | 'sessionId'>, nativeToolCallId: string, delivery: ToolCallDelivery, repository?: ToolCallRepository): Result<void> {
    const recorder = recorderFor(repository);
    const call = recorder.query({ ...context, nativeToolCallId });
    if (!call.ok) return call;
    if(caseFault?.profile.id==='case-save-delivery-loss'&&call.data.toolName==='save_invoice_candidate'&&delivery.state==='message_observed'&&call.data.status==='succeeded'){
      const commit=recorder.queryCandidateCommit({toolCallId:call.data.toolCallId,...context});
      if(commit.ok&&commit.data!==null&&isDeepStrictEqual(call.data.result?.data,commit.data)&&caseFault.activate(call.data.toolName)){
        const error=appError('tool_execution_failed','tool','Committed candidate model delivery failed.',false,context.runId,context.sessionId,nativeToolCallId);
        const saved=recorder.recordDelivery(call.data.toolCallId,{version:1,state:'failed',messageObservedAt:null,includedInCallSequence:null,requestDispatchedAt:null,error});
        return saved.ok?fail(error):saved;
      }
    }
    const updated = recorder.recordDelivery(call.data.toolCallId, delivery);
    return updated.ok ? ok(undefined) : updated;
  }

  async function execute(name: string, finalArguments: unknown, context: ToolExecutionContext, rawArguments: unknown = finalArguments,
    resumeDelegation = false): Promise<ToolExecution> {
    const contextCheck = ToolExecutionContextSchema.safeParse(context);
    if (!contextCheck.success) {
      const failure = appError('tool_access_denied', 'runtime', '工具缺少可信 Run 上下文。');
      return { call: unavailableCall(context, name), result: { status: 'failed', error: failure }, fatal: true };
    }
    const bound = Object.freeze({ ...contextCheck.data, scope: contextCheck.data.scope });
    try { finalArguments = structuredClone(finalArguments); rawArguments = structuredClone(rawArguments); }
    catch { return { call: unavailableCall(bound, name), result: { status: 'failed',
      error: appError('tool_invalid_input', 'tool', '工具参数无法固定。') }, fatal: true }; }
    const definition = byName.get(name);
    const identity = `${bound.runId}:${bound.nativeToolCallId}`;
    const budget = budgetFor(bound.runId);
    const accept = (task: Promise<ToolExecution>, launch?: () => void) => ok({ task, launch });
    const immediate = (value: ToolExecution) => accept(Promise.resolve(value));
    const admit = (store?: SqlDatabaseStore) => {
      const recorder = recorderFor(store?.toolCalls);
      const requested = observeRequest(name, rawArguments, bound, store);
      if (!requested.ok) return requested;
      const call = requested.data;
      const parsed = definition?.inputSchema.safeParse(finalArguments);
      if (parsed?.success) {
        // Fix arguments before another queued caller can reuse this execution.
        const fixed = recorder.fixArguments(call.toolCallId, parsed.data);
        if (!fixed.ok) { budget.fatal = true; return fixed; }
      } else if (call.args.final !== null) return immediate({ call,
        result: { status: 'failed', error: appError('tool_invalid_input', 'tool', '工具参数不符合输入 Schema。') }, fatal: budget.fatal });
      const running = active.get(identity);
      if (running) return accept(running);
      if (call.result) return immediate({ call, result: call.result, fatal: budget.fatal });
      const resume = resumeDelegation && name === 'Agent' && call.status === 'running' && bound.nativeDelegate !== undefined
        && call.args.final !== null && isDeepStrictEqual(call.args.final, finalArguments);
      if (call.status !== 'requested' && !resume) {
        const failure = appError('tool_call_in_progress', 'runtime', 'ToolCall 已开始但当前 Runtime 无在途执行。', true, bound.runId, bound.sessionId, bound.nativeToolCallId);
        budget.fatal = true;
        return immediate({ call, result: { status: 'failed', error: failure }, fatal: true });
      }
      if (!resume && !(budget.shared ?? budget).ids.has(`${bound.sessionId}:${bound.nativeToolCallId}`)) return immediate({ call, result: { status: 'failed',
        error: appError('tool_call_in_progress', 'runtime', 'ToolCall has no reusable execution in this Runtime.') }, fatal: true });
      const completion = Promise.withResolvers<ToolExecution>();
      const publish = () => { active.set(identity, completion.promise); };
      if (store) store.db.afterCommit!(publish); else publish();
      return accept(completion.promise, () => {
        void runCall(definition, finalArguments, bound, call, budget, resume).then(completion.resolve, completion.reject).finally(() => {
          if (active.get(identity) === completion.promise) active.delete(identity);
        });
      });
    };
    const admitted = input.database ? await writeStorage(input.database, admit) : admit();
    if (!admitted.ok) {
      budget.closed = budget.fatal = true;
      return { call: unavailableCall(bound, name), result: { status: 'failed', error: admitted.error }, fatal: true };
    }
    admitted.data.launch?.();
    return admitted.data.task;
  }

  function beforeToolUse(definition: ToolDefinition<any, any> | undefined, raw: unknown, context: ToolExecutionContext,
    call: ToolCallSnapshot, budget: RunBudget, store?: SqlDatabaseStore, resumeDelegation = false): Result<PreparedToolUse> {
    const recorder = recorderFor(store?.toolCalls);
    if (!definition) return fail(appError('tool_not_found', 'tool', '此 Run 未注册请求的工具。'));
    const native = NATIVE_TOOL_NAMES.includes(definition.name as (typeof NATIVE_TOOL_NAMES)[number]);
    let argumentsBytes: number;
    try { argumentsBytes = encodedSize(raw); } catch { return fail(appError('tool_invalid_input', 'tool', '工具参数不是可记录的 JSON。')); }
    if (!native && argumentsBytes > TOOL_CONFIG.payload.maxRawArgumentsBytes) return fail(appError('tool_result_too_large', 'tool', '工具参数超过输入上限。'));
    const parsed = definition.inputSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('tool_invalid_input', 'tool', '工具参数不符合输入 Schema。'));
    const fixed = recorder.fixArguments(call.toolCallId, parsed.data);
    if (!fixed.ok) return fixed;
    const trusted = recorder.verifyUse(context);
    if (!trusted.ok) return trusted;
    if (!context.scope.allowedTools.includes(definition.name)) return fail(appError('tool_access_denied', 'runtime', '此 Run 未获准使用请求的工具。'));
    const sessionAccess = store ? store.sessions.isModelUseBlocked(context.sessionId) : input.isSessionModelUseBlocked?.(context.sessionId);
    if (sessionAccess && (!sessionAccess.ok || sessionAccess.data)) {
      return fail(sessionAccess.ok ? appError('session_scope_revoked', 'session', '此 Session 已撤回材料使用权限。') : sessionAccess.error);
    }
    if (context.signal.aborted || budget.closed || budget.fatal) return fail(appError(context.signal.aborted ? 'agent_cancelled' : 'tool_budget_exceeded', 'runtime',
      context.signal.aborted ? 'Run 已取消，工具未执行。' : 'Run 已停止接纳工具调用。', false, context.runId, context.sessionId, context.nativeToolCallId));
    const configuredMs = budget.limit?.toolTimeoutMs ?? singleToolTimeoutMs;
    const selected = !native && ['PURE', 'READ'].includes(definition.effect)
      ? budget.strategy?.calibration.groups.find(group => group.toolName === definition.name && group.toolVersion === definition.version) : undefined;
    const selectedMs = Math.min(configuredMs, selected?.selectedTimeoutMs ?? configuredMs);
    const remainingRunMs = budget.deadlineAt === undefined ? selectedMs : budget.deadlineAt - monotonicNow();
    // The SDK native bash timeout is already seconds; it can only shorten the Host ceiling.
    const nativeMs = ['bash', 'powershell'].includes(definition.name) && parsed.data && typeof parsed.data.timeout === 'number' && parsed.data.timeout > 0
      ? parsed.data.timeout * 1000 : Infinity;
    const remainingToolMs = resumeDelegation && call.startedAt !== null
      ? selectedMs - Math.max(0, Date.parse(input.now()) - Date.parse(call.startedAt)) : selectedMs;
    const timeoutMs = Math.min(remainingToolMs, remainingRunMs, nativeMs);
    if (!(timeoutMs > 0)) return fail(appError('agent_timeout', 'runtime', 'Run deadline elapsed before tool execution.', false,
      context.runId, context.sessionId, context.nativeToolCallId));
    const observation = observationFor(call, budget, 'allowed');
    observation.effectiveTimeoutMs = timeoutMs;
    observation.timeoutSource = timeoutMs < selectedMs && timeoutMs === remainingRunMs ? 'run_remaining'
      : timeoutMs < selectedMs && timeoutMs === nativeMs ? 'native' : selected?.timeoutSource ?? 'configured';
    observation.runDeadlineTruncated = remainingRunMs < selectedMs && remainingRunMs <= nativeMs;
    const started = resumeDelegation ? ok(call) : recorder.start(call.toolCallId);
    return started.ok ? ok({ call: started.data, definition, arguments: parsed.data, native, timeoutMs, observation }) : started;
  }

  async function runCall(definition: ToolDefinition<any, any> | undefined, raw: unknown, context: ToolExecutionContext,
    requestedCall: ToolCallSnapshot, budget: RunBudget, resumeDelegation = false): Promise<ToolExecution> {
    const prepare = (store?: SqlDatabaseStore): Result<{ use: PreparedToolUse | null; rejected: ToolExecution | null }> => {
      const prepared = beforeToolUse(definition, raw, context, requestedCall, budget, store, resumeDelegation);
      if (!prepared.ok) {
        const fatal = prepared.error.category === 'storage' || ['session_scope_revoked', 'agent_timeout', 'state_conflict', 'run_state_invalid'].includes(prepared.error.code);
        if (resumeDelegation) return ok({ use: null, rejected: { call: requestedCall,
          result: { status: 'failed' as const, error: prepared.error }, fatal } });
        const rejected = reject(requestedCall, budget, prepared.error,
          prepared.error.category === 'storage' ? 'storage' : 'before', fatal, store?.toolCalls);
        return rejected.call.result ? ok({ use: null, rejected })
          : fail(rejected.result.status === 'succeeded' ? appError('storage_write_failed', 'storage', 'Tool refusal was not saved.') : rejected.result.error);
      }
      return ok({ use: prepared.data, rejected: null });
    };
    const prepared = input.database ? await writeStorage(input.database, prepare) : prepare();
    if (!prepared.ok) {
      budget.closed = budget.fatal = true;
      return { call: requestedCall, result: { status: 'failed', error: prepared.error }, fatal: true };
    }
    if (prepared.data.rejected) return prepared.data.rejected;
    const use = prepared.data.use!;
    definition = use.definition;
    const native = use.native;

    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort('tool_timeout'); }, use.timeoutMs);
    let data: unknown;
    let status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
    let error: AppError | undefined;
    const startedMs = monotonicNow();
    let endedMs = startedMs;
    let afterStructure: ToolRuntimeObservation['afterStructure'] = 'unknown';
    try {
      const call = Object.freeze({ nativeToolCallId: context.nativeToolCallId, signal,
        deadlineAt: startedMs + use.timeoutMs,
        ...(context.nativeDelegate ? { nativeDelegate: context.nativeDelegate } : {}),
        ...(context.requestBinding ? { requestBinding: context.requestBinding } : {}) });
      const product = Object.freeze({ runId: context.runId, sessionId: context.sessionId, scope: context.scope });
      if(caseFault)await caseFault.commitGate('before-commit',definition.name,signal);
      const returned = await definition.execute(use.arguments, call, product);
      if(caseFault)await caseFault.commitGate('after-commit',definition.name,signal);
      if(caseFault?.profile.id==='case-evidence-read-execution-failure'&&caseFault.activate(definition.name))
        throw new ToolExecutionFailure(appError('tool_execution_failed','tool','Original evidence read execution failed.',false,context.runId,context.sessionId,context.nativeToolCallId));
      data = returned;
      endedMs = monotonicNow();
      timedOut ||= endedMs - startedMs >= use.timeoutMs;
      const output = definition.outputSchema?.safeParse(data);
      afterStructure = output?.success ? 'valid' : 'invalid';
      if (definition.outputSchema && !output?.success) {
        status = 'failed';
        error = appError('tool_invalid_output', 'tool', '工具返回值不符合输出 Schema。');
      } else if (!native && encodedSize(data) > TOOL_CONFIG.payload.maxOutputBytes) {
        status = 'failed';
        error = appError('tool_result_too_large', 'tool', '工具结果超过输出上限。');
      } else if (timedOut || context.signal.aborted) {
        status = context.signal.aborted ? 'cancelled' : 'failed';
        error = appError(context.signal.aborted ? 'agent_cancelled' : 'tool_timeout', 'runtime',
          context.signal.aborted ? 'Run 已取消。' : '工具执行超过时间上限。', false, context.runId, context.sessionId, context.nativeToolCallId);
      }
    } catch (thrown) {
      // Service shutdown leaves the owning native ToolTask recoverable; it is not a child result.
      if (definition.name === 'Agent' && context.nativeDelegate && thrown instanceof ToolExecutionFailure
        && thrown.error.code === 'durable_delegation_suspended')
        return { call: use.call, result: { status: 'failed', error: thrown.error }, fatal: false };
      endedMs = monotonicNow();
      timedOut ||= endedMs - startedMs >= use.timeoutMs;
      if (thrown instanceof ToolExecutionFailure && thrown.data !== undefined) {
        const checked = definition.outputSchema?.safeParse(thrown.data);
        afterStructure = checked?.success ? 'valid' : 'invalid';
        if (checked?.success && (native || encodedSize(checked.data) <= TOOL_CONFIG.payload.maxOutputBytes)) {
          data = checked.data;
        }
      }
      status = context.signal.aborted ? 'cancelled' : timedOut ? 'failed' : 'failed';
      error = timedOut ? appError('tool_timeout', 'runtime', '工具执行超过时间上限。', false, context.runId, context.sessionId, context.nativeToolCallId)
        : context.signal.aborted ? appError('agent_cancelled', 'runtime', 'Run 已取消。', false, context.runId, context.sessionId, context.nativeToolCallId)
          : safeError(thrown instanceof ToolExecutionFailure ? thrown.error : thrown);
      if (thrown instanceof ToolExecutionFailure && (thrown.error.code === 'stop_not_confirmed' || thrown.error.category === 'storage')) {
        error = thrown.error;
        budget.fatal = true;
        budget.closed = true;
      }
    } finally {
      clearTimeout(timer);
    }
    const settlement = { use, context, budget, data, status, error, startedMs, endedMs, timedOut, afterStructure };
    if (!input.database) return afterToolUse(settlement);
    const ended = await writeStorage(input.database, store => {
      const result = afterToolUse(settlement, store.toolCalls);
      return result.call.result ? ok(result) : fail(result.result.status === 'succeeded'
        ? appError('storage_write_failed', 'storage', 'Tool terminal was not saved.') : result.result.error);
    });
    if (ended.ok) return ended.data;
    budget.closed = budget.fatal = true;
    return { call: use.call, result: { status: 'failed', error: ended.error, ...(native && data !== undefined ? { data } : {}) }, fatal: true };
  }

  function afterToolUse(settlement: { use: PreparedToolUse; context: ToolExecutionContext; budget: RunBudget; data: unknown;
    status: 'succeeded' | 'failed' | 'cancelled'; error?: AppError; startedMs: number; endedMs: number; timedOut: boolean;
    afterStructure: ToolRuntimeObservation['afterStructure'] }, repository?: ToolCallRepository): ToolExecution {
    const recorder = recorderFor(repository);
    const { use, context, budget, data, startedMs, endedMs, timedOut, afterStructure } = settlement;
    let { status, error } = settlement;
    const observedCall = recorder.queryById(use.call.toolCallId);
    if (observedCall.ok && observedCall.data.result?.status === 'failed'
      && observedCall.data.result.error.code === 'stop_not_confirmed' && !observedCall.data.cleanup.stopped
      && use.definition.name === 'Agent' && budget.closed && budget.fatal)
      return { call: observedCall.data, result: observedCall.data.result, fatal: true };
    const stopped = error?.code !== 'stop_not_confirmed' && observedCall.ok
      && !observedCall.data.cleanup.nativeProcesses?.some(process => !process.stopped);
    const observation = { ...use.observation, afterStructure,
      executionDurationMs: Number.isFinite(endedMs - startedMs) && endedMs >= startedMs ? endedMs - startedMs : null,
      timingComplete: stopped && !context.signal.aborted && Number.isFinite(endedMs - startedMs) && endedMs >= startedMs,
      failureStage: error ? (error.code === 'tool_invalid_output' || error.code === 'tool_result_too_large' || error.code === 'tool_context_limit' ? 'validation' : 'execute') as ToolRuntimeObservation['failureStage'] : null,
      diagnosticCode: error?.code ?? null };
    let commitId: DbId | null = null;
    if (!observedCall.ok) {
      observation.commit = 'unknown'; observation.commitError = observedCall.error;
      observation.afterDomain = 'unknown'; observation.failureStage = 'commit'; error = observedCall.error; status = 'failed'; budget.fatal = true;
    } else if (use.definition.name === 'save_invoice_candidate') {
      const commit = recorder.queryCandidateCommit({ toolCallId: use.call.toolCallId, runId: context.runId, sessionId: context.sessionId });
      if (!commit.ok || !stopped && commit.data === null) {
        observation.commit = 'unknown'; observation.commitError = commit.ok
          ? error ?? appError('stop_not_confirmed', 'runtime', 'Execution stop has not been confirmed.') : commit.error;
        observation.afterDomain = 'unknown'; observation.failureStage = 'commit'; error = observation.commitError; status = 'failed'; budget.fatal = true;
      } else {
        commitId = commit.data?.candidateId ?? null;
        observation.commit = commitId === null ? 'none_confirmed' : 'committed';
        observation.afterDomain = status === 'succeeded' && commitId !== null && isDeepStrictEqual(data, commit.data)
          ? 'valid' : status === 'succeeded' ? 'invalid' : 'unknown';
        if (status === 'succeeded' && observation.afterDomain === 'invalid') {
          error = appError('tool_invalid_output', 'tool', 'Returned candidate receipt does not match the original ToolCall commit.');
          status = 'failed'; observation.failureStage = 'validation'; budget.fatal = true;
        }
        if (commitId !== null && status !== 'succeeded') budget.fatal = true;
      }
    } else if (use.definition.name === 'fill_invoice_form') {
      const receipt = observedCall.data.formApplication;
      observation.commit = receipt?.outcome === 'applied' ? 'committed' : receipt?.outcome === 'unknown' || !stopped ? 'unknown' : 'none_confirmed';
      if (observation.commit === 'unknown') {
        observation.commitError = error ?? appError('form_application_unknown', 'runtime', 'Form application could not be verified.');
        observation.afterDomain = 'unknown'; observation.failureStage = 'commit'; error = observation.commitError; status = 'failed'; budget.fatal = true;
      } else {
        const output = FillInvoiceFormOutputSchema.safeParse(data);
        observation.afterDomain = status === 'succeeded' && output.success && receipt?.outcome === 'applied'
          && output.data.candidateId === receipt.candidateId && output.data.candidateSequence === receipt.candidateSequence ? 'valid'
          : status === 'succeeded' ? 'invalid' : 'unknown';
        if (status === 'succeeded' && observation.afterDomain === 'invalid') {
          error = appError('tool_invalid_output', 'tool', 'Form output does not match the original application receipt.');
          status = 'failed'; observation.failureStage = 'validation'; budget.fatal = true;
        }
      }
    }
    if (status === 'succeeded' && use.definition.effect === 'READ'
      && INVOICE_REVIEW_TOOL_NAMES.includes(use.definition.name as (typeof INVOICE_REVIEW_TOOL_NAMES)[number])) {
      const domain = recorder.validateOutput({ toolCallId: use.call.toolCallId, data });
      observation.afterDomain = domain.ok ? domain.data : domain.error.category === 'storage' ? 'unknown' : 'invalid';
      if (!domain.ok) {
        status = 'failed'; error = domain.error; observation.failureStage = 'validation';
        budget.fatal ||= domain.error.category === 'storage';
      }
    }
    if (!stopped && observation.commit === 'none_confirmed') {
      observation.commit = 'unknown'; observation.commitError = error ?? appError('stop_not_confirmed', 'runtime', 'Execution stop has not been confirmed.');
    }
    if (!stopped && status === 'succeeded') { status = 'failed'; error = appError('stop_not_confirmed', 'runtime', 'Execution stop has not been confirmed.'); budget.fatal = true; }
    const feedbackError = acceptFeedback(use.call, budget, data, error);
    if (feedbackError) { status = 'failed'; error = feedbackError; observation.failureStage = 'validation'; }
    observation.diagnosticCode = error?.code ?? null;
    budget.fatal ||= !stopped || observation.commit === 'unknown'
      || timedOut && (!['PURE', 'READ'].includes(use.definition.effect) || observation.runDeadlineTruncated);
    if (budget.fatal) budget.closed = true;
    const endedAt = input.now();
    const ended = recorder.finish({ toolCallId: use.call.toolCallId, status, ...(data === undefined ? {} : { data }),
      ...(error ? { error } : {}), committedCandidateId: commitId, cleanup: { version: 1,
        stopReason: timedOut ? 'tool-timeout' : context.signal.aborted ? 'run-abort' : 'tool-settled', stopped,
        errors: !stopped && error ? [error] : [] }, endedAt, stoppedAt: stopped ? endedAt : null, runtimeObservation: observation });
    if (!ended.ok) {
      budget.fatal = true;
      budget.closed = true;
      return { call: use.call, result: { status: 'failed', error: appError('storage_write_failed', 'storage', 'ToolCall 终态无法保存。', true, context.runId, context.sessionId, context.nativeToolCallId),
        ...(use.native && data !== undefined ? { data } : {}) }, fatal: true };
    }
    const result: ToolResult<unknown> = status === 'succeeded' ? { status, data }
      : { status, error: error ?? appError('tool_execution_failed', 'tool', '工具执行失败。'), ...(data === undefined ? {} : { data }) };
    return { call: ended.data, result, fatal: budget.fatal };
  }

  return {
    close:():{stopped:boolean;closed:boolean;errors:AppError[]}=>({stopped:true,closed:true,errors:[]}),
    failUnconfirmedDelegation(context: { runId: DbId; sessionId: DbId }, nativeToolCallId: string, repository?: ToolCallRepository): Result<void> {
      const recorder = recorderFor(repository);
      const call = recorder.query({ ...context, nativeToolCallId });
      if (!call.ok) return call;
      if (call.data.toolName === 'Agent' && call.data.result?.status === 'failed'
        && call.data.result.error.code === 'stop_not_confirmed' && !call.data.cleanup.stopped) return ok(undefined);
      if (call.data.toolName !== 'Agent' || !['requested', 'running'].includes(call.data.status))
        return fail(appError('subagent_identity_conflict', 'runtime', 'No active original delegation is available.'));
      const budget = budgetFor(context.runId); budget.closed = budget.fatal = true;
      const error = appError('stop_not_confirmed', 'runtime', 'The managed child has not confirmed termination.', true, context.runId);
      const saved = recorder.finish({ toolCallId: call.data.toolCallId, status: 'failed', error,
        committedCandidateId: null, cleanup: { version: 1, stopReason: 'stop-grace-exhausted', stopped: false, errors: [error] }, stoppedAt: null });
      return saved.ok ? ok(undefined) : saved;
    },
    observeRequest,
    rejectRequest,
    recordDelivery,
    execute: (name: string, finalArguments: unknown, context: ToolExecutionContext, rawArguments: unknown = finalArguments) =>
      execute(name, finalArguments, context, rawArguments),
    async resumeDelegation(context: ToolExecutionContext): Promise<ToolExecution> {
      const original = input.database
        ? await input.database.read(store => recorderFor(store.toolCalls).query(context)) : recorderFor().query(context);
      if (!original.ok || original.data.toolName !== 'Agent' || original.data.args.final === null || !context.scope.invoiceWork
        || !/^durable-task:[1-9]\d*$/.test(context.nativeToolCallId)
        || !context.nativeDelegate || !['running', 'succeeded', 'failed', 'cancelled'].includes(original.data.status)) {
        return { call: original.ok ? original.data : unavailableCall(context, 'Agent'), fatal: true,
          result: { status: 'failed', error: appError('subagent_origin_invalid', 'runtime', 'Only the original fixed Agent delegation can resume.') } };
      }
      return execute('Agent', original.data.args.final, context, original.data.args.raw, true);
    },
    freezeStrategy(config: StrategyInput, repository?: ToolCallRepository) {
      return freezeRuntimeStrategy({ ...config, recorder: recorderFor(repository),
        definitions, policy: input.strategyPolicy });
    },
    queryCall(context: Pick<ToolExecutionContext, 'runId' | 'sessionId'>, nativeToolCallId: string, repository?: ToolCallRepository) {
      return recorderFor(repository).query({ ...context, nativeToolCallId });
    },
    configureRun(runId: DbId, config: { budget: ResolvedRuntimeBudget; strategy: RuntimeStrategySnapshot; deadlineAt?: number }) {
      const budget = budgetFor(runId);
      if (budget.limit && (!isDeepStrictEqual(budget.limit, config.budget) || !isDeepStrictEqual(budget.strategy, config.strategy))) {
        throw new Error('runtime_strategy_fixed');
      }
      budget.limit = Object.freeze({ ...config.budget });
      budget.strategy = RuntimeStrategySnapshotSchema.parse(structuredClone(config.strategy));
      if (config.deadlineAt !== undefined) budget.deadlineAt = config.deadlineAt;
    },
    attachChildBudget(childRunId: DbId, parentRunId: DbId) {
      const parent = budgets.get(parentRunId), child = budgets.get(childRunId);
      if (!parent?.limit || !child?.limit || childRunId === parentRunId || child.shared || parent.shared
        || child.ids.size || parent.closed || parent.fatal) throw new Error('subagent_budget_binding_invalid');
      child.shared = parent;
    },
    setRunDeadline(runId: DbId, deadlineAt: number) {
      const budget = budgets.get(runId) ?? { ids: new Set<string>(), resultsBytes: 0, closed: false, fatal: false };
      budget.deadlineAt = Number.isFinite(deadlineAt) ? deadlineAt : monotonicNow();
      budgets.set(runId, budget);
    },
    closeRun(runId: DbId) { const budget = budgets.get(runId); if (budget) budget.closed = true; },
    releaseRun(runId: DbId) { budgets.delete(runId); },
    candidateFacts(runId: DbId, nativeToolCallIds?: readonly string[], repository?: ToolCallRepository) {
      const listed = recorderFor(repository).list(runId, 100);
      if (!listed.ok) return listed;
      const calls = listed.data.items.filter(call => nativeToolCallIds === undefined || nativeToolCallIds.includes(call.nativeToolCallId)).reverse();
      const candidateIds = [...new Set(calls.flatMap((call) => call.result?.committedCandidateId ? [call.result.committedCandidateId] : []))];
      const deliveredCandidateIds = [...new Set(calls.flatMap((call) => call.result?.committedCandidateId
        && call.result.status === 'succeeded' && call.delivery.state === 'request_observed' ? [call.result.committedCandidateId] : []))];
      const deliveredFormApplications = calls.flatMap(call => {
        const receipt = call.formApplication;
        const output = FillInvoiceFormOutputSchema.safeParse(call.result?.status === 'succeeded' ? call.result.data : null);
        return call.toolName === 'fill_invoice_form' && call.status === 'succeeded' && call.delivery.state === 'request_observed'
          && receipt?.outcome === 'applied' && receipt.runId === runId && receipt.toolCallId === call.toolCallId
          && output.success && output.data.candidateId === receipt.candidateId
          && output.data.candidateSequence === receipt.candidateSequence ? [receipt] : [];
      });
      const stopped = calls.every(call => call.cleanup.stopped);
      const cleanupErrors = calls.flatMap(call => call.cleanup.errors);
      return ok({ candidateIds, deliveredCandidateIds, deliveredFormApplications, stopped, cleanupErrors });
    },
    listTools: () => definitions,
  };
}

function unavailableCall(context: Partial<ToolExecutionContext>, name: string): ToolCallSnapshot {
  return { toolCallId: 0, runId: context.runId ?? 0, sessionId: context.sessionId ?? 0,
    context: null,
    nativeToolCallId: context.nativeToolCallId ?? 'invalid', toolName: name, toolVersion: null, effect: null,
    status: 'failed', args: { version: 1, raw: null, final: null }, result: null,
    delivery: { version: 1, state: 'not_attempted', messageObservedAt: null, includedInCallSequence: null, requestDispatchedAt: null, error: null },
    cleanup: { version: 1, stopReason: null, stopped: false, errors: [] }, requestedAt: '', startedAt: null, endedAt: null, stoppedAt: null };
}
