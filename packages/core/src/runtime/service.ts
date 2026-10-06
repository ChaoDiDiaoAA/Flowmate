import { appError, fail, ok, RuntimeRequestOverridesSchema, normalizeSessionInputRequest, formatExecutionPrompt, WorkspaceContextSchema, INVOICE_CHAT_GOAL, INVOICE_CHAT_SYSTEM_PROMPT, INVOICE_TOOLS_SYSTEM_PROMPT, INVOICE_FILL_FORM_SYSTEM_PROMPT, NATIVE_TOOL_NAMES, RUNTIME_CONFIG } from '@flowmate/contracts';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CompactionObservationSchema, SessionCompactionSnapshotSchema, CompactionPolicySchema } from '@flowmate/contracts';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { FrozenResourcesSchema, AssemblySelectionSnapshotSchema, FrozenExtensionsSchema, ExtensionAssemblyEvidenceSchema, matchesExtensionAssembly, EMPTY_RESOURCE_SELECTION, resourceRefKey } from '@flowmate/contracts';
import type { FrozenResources, ResourceBinding, ResourceSelectionResult, AssemblySelectionSnapshot, FrozenExtensions } from '@flowmate/contracts';
import { invoiceToolNamesForRun } from '../storage/repositories.ts';
import type { ExtensionService } from '../extensions/service.ts';
import { resolveRequiredSkill, type createResourceService } from '../resources/service.ts';
import type {
  AgentConfigFacts,
  P3AgentConfigFacts,
  AgentControl,
  AgentExecutionInput,
  AgentNativeOutcome,
  AgentOutcome,
  AgentPort,
  AgentRunEvent,
  AppError,
  Application,
  ChatScope,
  CloseReport,
  CleanupRecord,
  InputRecord,
  NativeOutcome,
  NormalizedAgentRunRequest,
  OutputRecord,
  PreparedProvider,
  ProviderControl,
  ProviderObservation,
  ProviderOutcome,
  ProviderPort,
  ProviderRequest,
  Result,
  RunSnapshot,
  RunStatus,
  RuntimeState,
  RunAccepted,
  SafeConfigSnapshot,
  UsageRecord,
  NativeToolAvailability,
  RunScope,
  NormalizedSessionInputRequest,
  NormalizedActiveInputRequest,
  SessionInputContentV2,
  SessionInputAccepted,
  RuntimeAgentConfigFacts,
  RuntimeRequestOverrides,
  ResolvedRuntimeBudget,
  RuntimeStrategySnapshot,
  RuntimeStrategyPolicy,
  ContextHooks,
  MemoryStore,
  CompactionObservation, CompactionAccepted, SessionCompactionRequest, SessionCompactionQuery,
  SessionCompactionCancel, SessionCompactionSnapshot, NativeCompactionOutcome,
} from '@flowmate/contracts';
import type { AgentOutputRecord, RunRepository, SessionRepository, SessionRow, TerminalWrite, WorkspaceRunAdmission } from '../storage/repositories.ts';
import { ensureNativeSession } from '../sessions/service.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import type { SessionInputAdmission, SessionInputLedger } from '../sessions/input-ledger.ts';
import type { WorkspaceVerifier } from '../workspace/verification.ts';
import type { ContextService } from '../context/service.ts';
import type { ContextRepository } from '../context/repository.ts';

export interface RuntimeLogger {
  write(event: { at: string; level: 'info' | 'warn' | 'error'; component: string; runId?: number; event: string; code?: string }): void;
  close(): Promise<void>;
}

export type RuntimeDependencies = {
  memory: Pick<MemoryStore, 'load' | 'commit'>;
  runs: RunRepository;
  recoveryError?: AppError | null;
  provider: ProviderPort;
  agent?: AgentPort;
  sessions?: SessionRepository;
  sessionInputs?: SessionInputLedger;
  workspaceVerifier?: WorkspaceVerifier;
  contextService?: Pick<ContextService, 'build'>;
  contextRepository?: Pick<ContextRepository, 'bindRequest' | 'recordRequest' | 'resolveToolResult'>
    & Partial<Pick<ContextRepository, 'recordCompactionEvidence' | 'readCompactionEvidence' | 'recordResourceRead' | 'recordResourceRequest'>>;
  isSessionManaging?: (sessionId: number) => boolean;
  tools?: ToolExecutor;
  runtimeDefaults?: () => Result<RuntimeRequestOverrides>;
  resources?: ReturnType<typeof createResourceService>;
  extensions?: ExtensionService;
  resourceDefaults?: () => Result<AssemblySelectionSnapshot | ResourceSelectionResult>;
  runtimePolicy?: RuntimeStrategyPolicy;
  sampleSource?: 'production' | 'test' | 'evaluation';
  observeCompaction?: (value: CompactionObservation) => void;
  nativeTools?: {
    runtimeDir: string;
    availability: readonly NativeToolAvailability[];
  };
  log: RuntimeLogger;
  now: () => string;
  monotonicNow: () => number;
};

type StopReason = 'user' | 'timeout' | 'shutdown' | 'input-failure';
type StopIntent = { reason: StopReason; at: string; monotonicMs: number };

type ActiveCall = {
  runId: number;
  kind: 'provider' | 'agent';
  sessionId: number | null;
  nativeSessionId: string | null;
  controller: AbortController;
  startedAt: number;
  terminalCommitted: boolean;
  stop: (reason: StopReason) => boolean;
  stopIntent?: StopIntent;
  storageError?: AppError;
  inputFailure?: AppError;
  providerFailureBeforeStop?: boolean;
  completion: Promise<Result<ProviderOutcome>>;
  poisoned: boolean;
  inputAdmissionClosed?: boolean;
  inputStreamingStarted?: boolean;
  observe: (type: ProviderObservation['type'], data?: Readonly<Record<string, unknown>>) => void;
};

type ActiveCompaction = {
  kind: 'compaction'; runId: null; sessionId: number; nativeSessionId: string;
  request: SessionCompactionRequest; controller: AbortController; startedAt: number;
  observation: CompactionObservation; stopIntent?: StopIntent;
  nativeObservationSequence?: number;
  stopTimer?: ReturnType<typeof setTimeout>; baseline?: import('@flowmate/contracts').HistoryCommitState;
  stop: (reason: StopReason) => boolean; completion: Promise<Result<NativeCompactionOutcome>>;
};

type AgentEventPayload =
  | { type: 'run_progress'; phase: 'created' | 'running' | 'stopping'; reason?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'message_upsert'; message: import('@flowmate/contracts').SessionMessageView }
  | { type: 'tool_progress'; toolName: string; label: string; phase: 'running' | 'succeeded' | 'failed' | 'cancelled' }
  | { type: 'run_finished'; result: Result<AgentOutcome> };

type AgentExecutionContext = {
  active: ActiveCall;
  request: FrozenAgentRunRequest;
  session: SessionRow;
  input: InputRecord;
  admission: WorkspaceRunAdmission | null;
  scope: RunScope | null;
  maxModelCalls?: number;
  runtimeStrategy?: RuntimeStrategySnapshot;
  workingDirectory?: string;
  inputId?: number;
  contextSnapshotId?: number;
  promptText: string;
  resources: FrozenResources | null;
  extensions: FrozenExtensions | null;
  resourceBinding?: ResourceBinding;
  control: AgentControl;
  stopPromise: Promise<StopIntent>;
  readStop: () => StopIntent | undefined;
  emit: (event: AgentEventPayload) => void;
};
type FrozenAgentRunRequest = NormalizedAgentRunRequest & { goalMode: import('@flowmate/contracts').GoalMode;
  timeoutMs: number; stopGraceMs: number; budget: ResolvedRuntimeBudget };

function originalOverrides(request: NormalizedAgentRunRequest): RuntimeRequestOverrides {
  return { ...(request.budget === undefined ? {} : { budget: request.budget }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.stopGraceMs === undefined ? {} : { stopGraceMs: request.stopGraceMs }) };
}

const chatScope: ChatScope = { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] };
const agentPolicy: Omit<AgentConfigFacts, 'nativeSessionId'> = {
  policyVersion: 'p2-invoice-chat-v1',
  systemPrompt: INVOICE_CHAT_SYSTEM_PROMPT,
  thinkingLevel: 'off',
  resourcePolicy: 'none',
  historyPolicy: 'memory-only',
  maxContextBytes: RUNTIME_CONFIG.llmPayload.maxChatContextBytes,
  maxOutputBytes: RUNTIME_CONFIG.llmPayload.maxOutputTextBytes,
  maxAssistantContentBytes: RUNTIME_CONFIG.llmPayload.maxAssistantContentBytes,
  maxModelCalls: 1,
  sessionRetry: false,
};

const p3AgentPolicy: Omit<P3AgentConfigFacts, 'nativeSessionId'> = {
  policyVersion: 'p3-invoice-tools-v1',
  systemPrompt: INVOICE_TOOLS_SYSTEM_PROMPT,
  thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
  maxContextBytes: RUNTIME_CONFIG.llmPayload.maxWorkspaceContextBytes, maxOutputBytes: RUNTIME_CONFIG.llmPayload.maxOutputTextBytes, maxAssistantContentBytes: RUNTIME_CONFIG.llmPayload.maxAssistantContentBytes,
  maxModelCalls: RUNTIME_CONFIG.runBudget.maxModelCalls.workspace, maxToolCalls: RUNTIME_CONFIG.runBudget.maxToolCalls, toolTimeoutMs: RUNTIME_CONFIG.runBudget.toolTimeoutMs, sessionRetry: false,
};

function initialAgentSnapshot(request: FrozenAgentRunRequest, nativeSessionId: string): SafeConfigSnapshot & { agent: RuntimeAgentConfigFacts } {
  return {
    version: 2,
    name: request.config.name,
    revision: request.config.revision,
    requestedModel: request.config.modelRef,
    resolvedModel: null,
    api: request.config.connection?.api ?? null,
    endpoint: request.config.connection?.baseUrl ?? null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: request.config.parameters,
    limits: { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs },
    native: { authSource: 'unknown', modelsSelection: request.config.native.modelsPath },
    runtimeBudget: request.budget,
    agent: { ...agentPolicy, policyVersion: 'runtime-v1', taskPolicyVersion: 'p5-session-inputs-v1', ...request.budget, nativeSessionId },
  };
}

function initialP3AgentSnapshot(request: FrozenAgentRunRequest, nativeSessionId: string): SafeConfigSnapshot & { agent: RuntimeAgentConfigFacts } {
  return {
    version: 2,
    name: request.config.name,
    revision: request.config.revision,
    requestedModel: request.config.modelRef,
    resolvedModel: null,
    api: request.config.connection?.api ?? null,
    endpoint: request.config.connection?.baseUrl ?? null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: request.config.parameters,
    limits: { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs },
    native: { authSource: 'unknown', modelsSelection: request.config.native.modelsPath },
    runtimeBudget: request.budget,
    agent: { ...p3AgentPolicy, policyVersion: 'runtime-v1', taskPolicyVersion: 'p3-invoice-tools-v1', ...request.budget, nativeSessionId,
      ...(request.goalMode === 'fill-form' ? { systemPrompt: INVOICE_FILL_FORM_SYSTEM_PROMPT } : {}) },
  };
}

function initialSnapshot(request: ProviderRequest): SafeConfigSnapshot {
  return {
    version: 1,
    name: request.config.name,
    revision: request.config.revision,
    requestedModel: request.config.modelRef,
    resolvedModel: null,
    api: null,
    endpoint: null,
    sdk: { codingAgent: '0.85.1', ai: '0.85.1' },
    parameters: request.config.parameters,
    limits: { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs },
    native: {
      authSource: request.config.connection ? 'pi-runtime-api-key' : 'pi-native',
      modelsSelection: request.config.native.modelsPath,
    },
  };
}

function initialUsage(now: string): UsageRecord {
  return {
    version: 1,
    source: 'unknown',
    reason: 'request-not-finished',
    sdkValues: null,
    attempts: null,
    attemptsComplete: false,
    costSource: null,
    updatedAt: now,
  };
}

function initialCleanup(): CleanupRecord {
  return { version: 1, stopped: false, stopReason: null, errors: [], lateObservationRequired: false };
}

function outputRecord(outcome: NativeOutcome): OutputRecord {
  return {
    version: 1,
    wireMaxTokens: outcome.wireMaxTokens ?? null,
    text: outcome.text,
    partial: outcome.partial,
    stopReason: outcome.stopReason,
    responseId: outcome.responseId,
    responseModel: outcome.responseModel,
  };
}

function errorForStop(reason: StopReason, runId: number, kind: ActiveCall['kind'] = 'provider') {
  if (reason === 'user') return appError(kind === 'agent' ? 'agent_cancelled' : 'provider_cancelled', kind === 'agent' ? 'runtime' : 'provider', kind === 'agent' ? 'Agent Run 已取消。' : 'Provider 请求已取消。', false, runId);
  if (reason === 'timeout') return appError(kind === 'agent' ? 'agent_timeout' : 'provider_timeout', kind === 'agent' ? 'runtime' : 'provider', kind === 'agent' ? 'Agent Run 超时。' : 'Provider 请求超时。', true, runId);
  if (reason === 'input-failure') return appError('input_delivery_unknown', 'session', 'Native input delivery failed.', true, runId);
  return appError('runtime_shutdown', 'runtime', '运行实例正在关闭。', true, runId);
}

function stopStatus(reason: StopReason): Extract<RunStatus, 'failed' | 'cancelled'> {
  return reason === 'user' ? 'cancelled' : 'failed';
}

function withinGrace<T>(promise: Promise<T>, graceMs: number): Promise<{ kind: 'settled'; value: T } | { kind: 'grace' }> {
  if (graceMs <= 0) return Promise.resolve({ kind: 'grace' });
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then((value) => ({ kind: 'settled' as const, value })),
    new Promise<{ kind: 'grace' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'grace' }), graceMs); }),
  ]).finally(() => clearTimeout(timer!));
}

export class RuntimeService {
  private readonly dependencies: RuntimeDependencies;
  private active: ActiveCall | ActiveCompaction | null = null;
  private readonly compactions = new Map<string, ActiveCompaction>();
  private readonly lastManualCompaction = new Map<number, string>();
  private closing = false;
  private closed = false;
  private poisoned = false;
  private closeInFlight: Promise<CloseReport> | null = null;
  private finalCloseReport: CloseReport | null = null;
  private readonly closeErrors = new Map<string, ReturnType<typeof appError>>();

  public constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies;
    this.poisoned = dependencies.recoveryError != null;
  }

  public state(): RuntimeState {
    return {
      active: this.active?.kind === 'compaction' ? { kind: 'compaction', runId: null, sessionId: this.active.sessionId,
        operationId: this.active.request.operationId }
        : this.active ? { runId: this.active.runId, sessionId: this.active.sessionId, kind: this.active.kind } : null,
      blocked: this.poisoned,
      error: this.poisoned ? this.dependencies.recoveryError
        ?? appError('runtime_unusable', 'runtime', 'Runtime 暂不可复用，需要重启。') : null,
    };
  }
  private notifyCompaction(value: CompactionObservation): void {
    try { this.dependencies.observeCompaction?.(structuredClone(value)); }
    catch { /* Transient notifications are repaired by readonly queries. */ }
  }

  private compactionHistory(sessionId: number) {
    const sessions = this.dependencies.sessions;
    if (!sessions) return fail<import('../storage/repositories.ts').SessionHistorySnapshot>(
      appError('compaction_unavailable', 'runtime', 'Session history is unavailable.'));
    return sessions.readHistorySnapshot(sessionId, value => value.bundle.history && value.bundle.commit
      ? ok(value) : fail(appError('session_history_unavailable', 'session', 'Committed history is unavailable.')));
  }

  private compactionEligibility(value: import('../storage/repositories.ts').SessionHistorySnapshot): Result<void> {
    if (this.poisoned || this.closing || this.closed)
      return fail(appError('runtime_unusable', 'runtime', 'Runtime cannot compact this Session.'));
    if (value.row.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Complete Session deletion first.', true));
    if (value.row.status !== 'active') return fail(appError('session_archived', 'session', 'Archived Sessions cannot be compacted.'));
    if (value.blocked) return fail(appError('session_scope_revoked', 'session', 'Material access was revoked.'));
    if (value.row.nativeUnusable || value.bundle.history?.unusable)
      return fail(appError('agent_session_unusable', 'session', 'Committed history is unusable.'));
    if (value.bundle.commit?.commitRevision === Number.MAX_SAFE_INTEGER)
      return fail(appError('storage_write_failed', 'storage', 'Conversation history commit revision is exhausted.', false));
    if (this.dependencies.isSessionManaging?.(value.row.sessionId))
      return fail(appError('session_busy', 'session', 'Session management is in progress.', true));
    return ok(undefined);
  }

  public async compactSession(request: SessionCompactionRequest): Promise<Result<CompactionAccepted>> {
    const prior = this.compactions.get(request.operationId);
    if (prior) {
      if (!isDeepStrictEqual(prior.request, request))
        return fail(appError('state_conflict', 'session', 'Operation identity has different content.', true));
      return this.active === prior
        ? ok({ sessionId: request.sessionId, operationId: request.operationId })
        : fail(appError('operation_result_unknown', 'runtime', 'The operation is no longer available.'));
    }
    const { agent } = this.dependencies;
    if (!agent?.compactSession || !agent.inspectSessionCompaction)
      return fail(appError('compaction_unavailable', 'runtime', 'Native compaction is unavailable.'));
    if (this.active) return fail(appError('runtime_busy', 'runtime', 'A native operation is active.'));
    const current = this.compactionHistory(request.sessionId);
    if (!current.ok) return current;
    const eligible = this.compactionEligibility(current.data);
    if (!eligible.ok) return eligible;
    if (!isDeepStrictEqual(current.data.bundle.commit, request.expected))
      return fail(appError('state_conflict', 'session', 'Conversation history has changed.', true));
    try {
      const availability = agent.inspect(current.data.row.nativeSessionId).availability;
      if (availability === 'busy') return fail(appError('session_busy', 'session', 'Native Session is active.', true));
      if (availability === 'unusable') return fail(appError('agent_session_unusable', 'session', 'Native Session is unusable.'));
    } catch { return fail(appError('agent_session_unavailable', 'session', 'Native Session state cannot be confirmed.')); }
    const inspected = agent.inspectSessionCompaction({ history: current.data.bundle.history!, seed: current.data.bundle.seed, commit: current.data.bundle.commit! });
    if (!inspected.ok) return inspected;
    const frozen = structuredClone(request);
    const controller = new AbortController();
    let resolveCompletion!: (value: Result<NativeCompactionOutcome>) => void;
    const completion = new Promise<Result<NativeCompactionOutcome>>(resolve => { resolveCompletion = resolve; });
    const active: ActiveCompaction = {
      kind: 'compaction', runId: null, sessionId: request.sessionId, nativeSessionId: current.data.row.nativeSessionId,
      request: frozen, controller, startedAt: this.dependencies.monotonicNow(), completion,
      observation: { sessionId: request.sessionId, nativeSessionId: current.data.row.nativeSessionId, operationId: request.operationId,
        runId: null, reason: 'manual', observationSequence: 1, phase: 'preparing', generated: false, nativeOutcome: 'pending',
        entryId: null, saved: null, error: null, stopRequested: false, stopped: false, continuation: 'next-run', mayContinue: false,
        capacity: inspected.data.capacity, usage: { version: 1, source: 'not-requested', reason: 'not-started', sdkValues: null,
          attempts: 0, attemptsComplete: true, costSource: null, updatedAt: this.dependencies.now() },
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } },
      stop: reason => {
        if (active.stopIntent || active.observation.stopped) return false;
        active.stopIntent = { reason, at: this.dependencies.now(), monotonicMs: this.dependencies.monotonicNow() };
        active.observation = { ...active.observation, observationSequence: active.observation.observationSequence + 1,
          phase: 'stopping', stopRequested: true, mayContinue: false };
        controller.abort();
        this.notifyCompaction(active.observation);
        active.stopTimer = setTimeout(() => {
          if (this.active !== active || active.observation.stopped) return;
          this.poisoned = true;
          active.observation = { ...active.observation, observationSequence: active.observation.observationSequence + 1,
            phase: 'stopping', stopped: false, mayContinue: false,
            error: appError('stop_unconfirmed', 'runtime', 'Native compaction stop was not confirmed within grace.', true) };
          this.notifyCompaction(active.observation);
        }, RUNTIME_CONFIG.request.stopGraceMs);
        return true;
      },
    };
    // The shared Runtime slot is claimed before ensure/prepare can yield.
    this.active = active;
    this.compactions.set(request.operationId, active);
    this.lastManualCompaction.set(request.sessionId, request.operationId);
    this.notifyCompaction(active.observation);
    void this.executeManualCompaction(active).then(resolveCompletion, () => {
      this.poisoned = true;
      active.observation = { ...active.observation, phase: 'stopping', mayContinue: false,
        error: appError('stop_unconfirmed', 'runtime', 'Native operation stop cannot be confirmed.', true) };
      resolveCompletion(ok({ observation: active.observation, stopped: false, cleanupErrors: [] }));
    });
    return ok({ sessionId: request.sessionId, operationId: request.operationId });
  }

  private verifyCompactionUse(active: ActiveCompaction): Result<void> {
    if (this.active !== active) return fail(appError('compaction_unavailable', 'runtime', 'Operation ownership was lost.'));
    if (active.stopIntent || active.controller.signal.aborted) return fail(appError(
      active.stopIntent?.reason === 'timeout' ? 'compaction_timeout' : active.stopIntent?.reason === 'shutdown' ? 'runtime_shutdown' : 'compaction_cancelled',
      'runtime', 'Compaction was stopped.'));
    if (this.dependencies.monotonicNow() - active.startedAt >= RUNTIME_CONFIG.request.timeoutMs) {
      active.stop('timeout'); return fail(appError('compaction_timeout', 'runtime', 'Compaction deadline expired.'));
    }
    const current = this.compactionHistory(active.sessionId);
    if (!current.ok) return current;
    const eligible = this.compactionEligibility(current.data);
    if (!eligible.ok) return eligible;
    if (current.data.row.nativeSessionId !== active.nativeSessionId)
      return fail(appError('session_history_invalid', 'session', 'Native Session identity changed.'));
    const native = this.dependencies.agent?.exportSession?.(active.nativeSessionId);
    if (!native?.ok || !isDeepStrictEqual(JSON.parse(JSON.stringify(native.data)), current.data.bundle.history))
      return fail(appError('session_history_invalid', 'session', 'Native history is not the committed prefix.'));
    return ok(undefined);
  }

  private async executeManualCompaction(active: ActiveCompaction): Promise<Result<NativeCompactionOutcome>> {
    const agent = this.dependencies.agent!, sessions = this.dependencies.sessions!;
    const timer = setTimeout(() => active.stop('timeout'), RUNTIME_CONFIG.request.timeoutMs);
    let stopped = true;
    let cleanupErrors: readonly AppError[] = [];
    let baseline: import('@flowmate/contracts').HistoryCommitState | null = null;
    try {
      const current = this.compactionHistory(active.sessionId);
      if (!current.ok) throw current.error;
      const installed = ensureNativeSession(sessions, agent, current.data.row, this.dependencies.memory);
      if (!installed.ok) throw installed.error;
      const verified = this.verifyCompactionUse(active);
      if (!verified.ok) throw verified.error;
      // Summary inherits the committed history's trusted scope, including fork origins.
      // It receives no tool permission and does not depend on the current desktop workspace.
      let workspaceHistory = false;
      for (const runId of new Set(current.data.bundle.seed.origins.flatMap(origin => origin.originRunId === null ? [] : [origin.originRunId]))) {
        const run = this.dependencies.runs.get(runId);
        if (!run.ok) throw run.error;
        if (run.data.kind !== 'agent') throw appError('session_history_invalid', 'session', 'Native history has an invalid Run origin.');
        if (run.data.scope.version === 2) workspaceHistory = true;
      }
      stopped = false;
      const prepared = await agent.prepare(active.nativeSessionId, active.request.config,
        { timeoutMs: RUNTIME_CONFIG.request.timeoutMs, stopGraceMs: RUNTIME_CONFIG.request.stopGraceMs },
        active.controller.signal, { compactionPolicy: RUNTIME_CONFIG.compaction,
          ...(workspaceHistory ? { activeToolNames: [] } : {}),
          runtimeBudget: { maxModelCalls: 2, maxToolCalls: 0, toolTimeoutMs: RUNTIME_CONFIG.runBudget.toolTimeoutMs } });
      if (!prepared.ok) {
        stopped = prepared.error.code !== 'stop_unconfirmed';
        throw prepared.error;
      }
      stopped = true;
      const valid = this.verifyCompactionUse(active);
      if (!valid.ok) throw valid.error;
      if (!isDeepStrictEqual(prepared.data.snapshot.compactionPolicy, RUNTIME_CONFIG.compaction))
        throw appError('compaction_unavailable', 'runtime', 'Prepared compaction policy differs from frozen policy.');
      const afterPrepare = this.compactionHistory(active.sessionId);
      if (!afterPrepare.ok) throw afterPrepare.error;
      baseline = afterPrepare.data.bundle.commit!;
      active.baseline = baseline;
      stopped = false;
      const outcome = await agent.compactSession!(active.nativeSessionId, {
        sessionId: active.sessionId, operationId: active.request.operationId, signal: active.controller.signal, maxModelCalls: 2,
        remainingMs: () => Math.max(0, RUNTIME_CONFIG.request.timeoutMs - (this.dependencies.monotonicNow() - active.startedAt)),
        verifyUse: () => this.verifyCompactionUse(active),
        observe: value => {
          if (this.active !== active || value.observationSequence <= (active.nativeObservationSequence ?? 0)) return;
          const parsed = CompactionObservationSchema.safeParse(value);
          if (!parsed.success || value.sessionId !== active.sessionId || value.nativeSessionId !== active.nativeSessionId
            || value.operationId !== active.request.operationId || value.reason !== 'manual' || value.runId !== null)
            throw appError('compaction_failed', 'runtime', 'Native compaction observation is invalid.');
          active.nativeObservationSequence = value.observationSequence;
          active.observation = { ...parsed.data, observationSequence: active.observation.observationSequence + 1,
            stopRequested: active.stopIntent !== undefined || value.stopRequested, mayContinue: false,
            phase: active.stopIntent && !value.stopped ? 'stopping' : value.phase };
          this.notifyCompaction(active.observation);
        },
      });
      stopped = outcome.stopped; cleanupErrors = outcome.cleanupErrors;
      const parsed = CompactionObservationSchema.safeParse(outcome.observation);
      if (!parsed.success || parsed.data.operationId !== active.request.operationId || parsed.data.sessionId !== active.sessionId
        || parsed.data.nativeSessionId !== active.nativeSessionId || parsed.data.reason !== 'manual' || parsed.data.runId !== null
        || parsed.data.stopped !== stopped) throw appError('compaction_failed', 'runtime', 'Native compaction outcome is invalid.');
      active.observation = { ...parsed.data, observationSequence: active.observation.observationSequence + 1,
        stopRequested: active.stopIntent !== undefined || parsed.data.stopRequested, mayContinue: false };
    } catch (error) {
      const known = typeof error === 'object' && error !== null && 'code' in error ? error as AppError
        : appError('compaction_failed', 'runtime', 'Native compaction failed.');
      active.observation = { ...active.observation, observationSequence: active.observation.observationSequence + 1,
        phase: stopped ? 'ended' : 'stopping', nativeOutcome: active.stopIntent ? 'cancelled' : 'failed',
        stopped, stopRequested: active.stopIntent !== undefined, mayContinue: false, error: known };
    } finally { clearTimeout(timer); clearTimeout(active.stopTimer); }
    const current = this.compactionHistory(active.sessionId);
    const valid = this.verifyCompactionUse(active);
    const observed = active.observation;
    const committed = current.ok && (observed.generated ? observed.saved !== null
      && isDeepStrictEqual(current.data.bundle.commit, observed.saved)
      && current.data.bundle.history!.entries.some(entry => entry.id === observed.entryId && entry.type === 'compaction')
      : baseline !== null && isDeepStrictEqual(current.data.bundle.commit, baseline));
    const mayContinue = stopped && !active.stopIntent && observed.nativeOutcome !== 'cancelled'
      && observed.capacity.fitsEstimate === true && committed && valid.ok;
    active.observation = { ...observed, observationSequence: observed.observationSequence + 1,
      phase: stopped ? 'ended' : 'stopping', stopped, mayContinue, stopRequested: active.stopIntent !== undefined || observed.stopRequested,
      error: !valid.ok && !observed.error ? valid.error : observed.error };
    if (!stopped) this.poisoned = true;
    else if (this.active === active) this.active = null;
    this.notifyCompaction(active.observation);
    return ok({ observation: active.observation, stopped, cleanupErrors });
  }

  public async querySessionCompaction(request: SessionCompactionQuery): Promise<Result<SessionCompactionSnapshot>> {
    const current = this.compactionHistory(request.sessionId);
    if (!current.ok) return current;
    const agent = this.dependencies.agent;
    if (!agent?.inspectSessionCompaction) return fail(appError('compaction_unavailable', 'runtime', 'Native compaction inspection is unavailable.'));
    const inspected = agent.inspectSessionCompaction({ history: current.data.bundle.history!, seed: current.data.bundle.seed, commit: current.data.bundle.commit! });
    if (!inspected.ok) return inspected;
    const operationId = request.operationId ?? (request.runId === undefined && !inspected.data.operation
      ? this.lastManualCompaction.get(request.sessionId) : undefined);
    const manual = operationId === undefined ? undefined : this.compactions.get(operationId);
    if (manual && (manual.sessionId !== request.sessionId || request.runId !== undefined))
      return fail(appError('state_conflict', 'runtime', 'Compaction identity does not belong to this query.'));
    if (request.runId !== undefined) {
      const run = this.dependencies.runs.get(request.runId);
      if (!run.ok) return run;
      if (run.data.kind !== 'agent' || run.data.sessionId !== request.sessionId)
        return fail(appError('state_conflict', 'runtime', 'Run and Session do not match.'));
    }
    const eligible = this.compactionEligibility(current.data);
    let blockCode = eligible.ok ? null : eligible.error.code;
    if (blockCode === null && this.active) blockCode = 'runtime_busy';
    if (blockCode === null) {
      try {
        const availability = agent.inspect(current.data.row.nativeSessionId).availability;
        if (availability === 'busy') blockCode = 'session_busy';
        else if (availability === 'unusable') blockCode = 'agent_session_unusable';
      }
      catch { blockCode = 'agent_session_unavailable'; }
    }
    let recorded: CompactionObservation | null = null;
    const native = inspected.data.operation;
    const liveMatches = native && (request.operationId === undefined || native.operationId === request.operationId)
      && (request.runId === undefined || native.runId === request.runId);
    if (!manual && !liveMatches && request.runId !== undefined && this.dependencies.contextRepository?.readCompactionEvidence) {
      const evidence = this.dependencies.contextRepository.readCompactionEvidence({ ...request, runId: request.runId });
      if (!evidence.ok) return evidence;
      recorded = evidence.data.at(-1)?.observation ?? null;
    }
    const candidate = manual?.observation ?? (liveMatches ? native : recorded);
    const currentOwner = candidate?.runId === null ? this.active === null
      : this.active?.kind === 'agent' && this.active.runId === candidate?.runId && !this.active.stopIntent && !this.active.terminalCommitted;
    const samePosition = candidate?.saved !== null && candidate?.saved !== undefined
      ? isDeepStrictEqual(candidate.saved, current.data.bundle.commit)
      : manual !== undefined && isDeepStrictEqual(manual.baseline ?? manual.request.expected, current.data.bundle.commit);
    const operation = candidate && (request.operationId === undefined || request.operationId === candidate.operationId)
      && (request.runId === undefined || request.runId === candidate.runId)
      ? { ...candidate, mayContinue: candidate.mayContinue && eligible.ok && currentOwner && samePosition
        && inspected.data.capacity.fitsEstimate === true } : null;
    const snapshot = SessionCompactionSnapshotSchema.safeParse({
      sessionId: request.sessionId, nativeSessionId: current.data.row.nativeSessionId, commit: current.data.bundle.commit,
      policy: RUNTIME_CONFIG.compaction, capacity: inspected.data.capacity, lastSaved: inspected.data.lastSaved,
      operation, operationAvailability: operation ? recorded ? 'recorded' : 'live' : request.operationId || request.runId ? 'unknown' : 'none',
      manualAllowed: blockCode === null, blockCode,
    });
    return snapshot.success ? ok(snapshot.data) : fail(appError('session_history_invalid', 'session', 'Compaction projection is invalid.'));
  }

  public async cancelSessionCompaction(request: SessionCompactionCancel): Promise<Result<{ sessionId: number; operationId: string; accepted: boolean }>> {
    const operation = this.compactions.get(request.operationId);
    if (!operation || operation.sessionId !== request.sessionId)
      return fail(appError('operation_result_unknown', 'runtime', 'The operation is no longer available.'));
    return ok({ ...request, accepted: this.active === operation && operation.stop('user') });
  }

  public queryNativeTools(): Result<readonly NativeToolAvailability[]> {
    const registered = new Set(this.dependencies.tools?.listTools().map((tool) => tool.name) ?? []);
    return ok(NATIVE_TOOL_NAMES.map((name) => {
      const available = this.dependencies.nativeTools?.availability.find((tool) => tool.name === name);
      return available?.available && registered.has(name) ? { name, available: true, reason: null }
        : { name, available: false, reason: available?.reason ?? 'Native tool is not configured.' };
    }));
  }

  public cancel(runId: number): Result<{ runId: number; accepted: boolean }> {
    if (this.active && this.active.kind !== 'compaction' && this.active.runId === runId) {
      const active = this.active;
      const accepted = active.stop('user');
      return active.storageError ? fail(active.storageError, runId) : ok({ runId, accepted });
    }
    const existing = this.dependencies.runs.get(runId);
    return existing.ok ? ok({ runId, accepted: false }) : existing;
  }

  public verifySessionMutation(sessionId: number, intent?: 'cleanup'): Result<void> {
    if (this.poisoned && intent !== 'cleanup' || this.closing || this.closed) return fail(appError('runtime_unusable', 'runtime', 'Runtime cannot manage Sessions.', true));
    if (this.active && this.active.kind !== 'provider' && this.active.sessionId === sessionId)
      return fail(appError('session_busy', 'session', 'This Session has an active Run.', true));
    return ok(undefined);
  }

  public async appendInput(request: NormalizedActiveInputRequest): Promise<Result<SessionInputAccepted>> {
    const { sessionInputs: ledger, agent, runs } = this.dependencies;
    if (!ledger) return fail(appError('session_input_unavailable', 'session', 'Session input storage is unavailable.'));
    const prior = ledger.lookup(request);
    if (!prior.ok) return prior;
    if (prior.data) return prior.data.runId === null ? fail(appError('operation_result_unknown', 'session', 'Original Run is unknown.'))
      : ok({ inputId: prior.data.inputId, runId: prior.data.runId, sessionId: prior.data.sessionId });
    const active = this.active;
    if (this.poisoned || this.closing || this.closed || !active || active.kind !== 'agent' || active.runId !== request.runId
      || active.sessionId !== request.sessionId || !active.inputStreamingStarted || active.terminalCommitted || active.stopIntent || active.inputAdmissionClosed)
      return fail(appError('input_admission_closed', 'session', 'The Run is no longer accepting input.', true));
    if (this.dependencies.isSessionManaging?.(request.sessionId)) return fail(appError('session_busy', 'session', 'Session management is in progress.', true));
    if (!agent?.enqueueInput || !active.nativeSessionId) return fail(appError('agent_input_unavailable', 'runtime', 'Active input dispatch is unavailable.'));
    try {
      if (agent.inspect(active.nativeSessionId).availability !== 'busy') return fail(appError('input_admission_closed', 'session', 'The native Run is not streaming.', true));
      if (agent.inspectSessionCompaction) {
        const current = this.compactionHistory(request.sessionId);
        if (!current.ok) return current;
        const view = agent.inspectSessionCompaction({ history: current.data.bundle.history!, seed: current.data.bundle.seed,
          commit: current.data.bundle.commit! });
        if (!view.ok) return view;
        if (view.data.operation && !view.data.operation.stopped && view.data.operation.runId === active.runId)
          return fail(appError('session_busy', 'session', 'Compaction is not accepting new input.', true));
      }
    } catch { return fail(appError('agent_session_unavailable', 'session', 'Native state cannot be confirmed.', true)); }
    const savedRun = runs.get(request.runId);
    if (!savedRun.ok) return savedRun;
    const resources = savedRun.data.config.resources === undefined ? null : FrozenResourcesSchema.safeParse(savedRun.data.config.resources);
    if (resources && !resources.success) return fail(appError('storage_corrupt', 'storage', 'Saved resource binding is invalid.'));
    const fixed = resources?.success ? resources.data : null;
    const required = resolveRequiredSkill(request.text, request.requiredSkill, fixed?.discoveredSkills ?? []);
    if (!required.ok) return required;
    if (fixed) {
      const verified = this.dependencies.resources?.verifyFrozen(fixed);
      if (!verified || !verified.ok) return verified ?? fail(appError('resource_bundle_unavailable', 'storage', 'Frozen resource verification is unavailable.', true));
    }
    const resourceBinding: ResourceBinding | undefined = fixed ? { bundleHash: fixed.bundleHash, requiredSkill: required.data as ResourceBinding['requiredSkill'] } : undefined;
    const at = this.dependencies.now();
    const admitted = ledger.admit(request, () => {
      const frozen = runs.freezeInput({ runId: request.runId, sessionId: request.sessionId,
        text: request.text, expected: request.workspace, at }, this.dependencies.workspaceVerifier);
      return frozen.ok ? this.buildInput(frozen.data.runId, request.sessionId, { ...frozen.data.content,
        ...(resourceBinding ? { resourceBinding } : {}) }, at) : frozen;
    }, at);
    if (!admitted.ok) return admitted;
    const input = admitted.data.input;
    if (!admitted.data.created) return ok({ inputId: input.inputId, runId: request.runId, sessionId: request.sessionId });
    if (input.content.version !== 2) return fail(appError('input_processing_unconfirmed', 'runtime', 'Frozen input is invalid.'));
    const dispatched = ledger.dispatch(input.inputId, this.dependencies.now());
    if (!dispatched.ok) { active.inputFailure = dispatched.error; active.stop('input-failure'); return dispatched; }
    let enqueued: Result<void>;
    try { enqueued = await agent.enqueueInput(active.nativeSessionId, { inputId: input.inputId, runId: request.runId,
      sessionId: request.sessionId, mode: request.mode, text: input.content.text, promptText: input.content.promptText,
      ...(input.content.resourceBinding ? { resourceBinding: input.content.resourceBinding } : {}),
      ...(input.contextSnapshotId === null ? {} : { contextSnapshotId: input.contextSnapshotId }) }); }
    catch { enqueued = fail(appError('input_delivery_unknown', 'session', 'Native input delivery could not be confirmed.', true, request.runId)); }
    if (!enqueued.ok) { active.inputFailure = enqueued.error; active.stop('input-failure'); return enqueued; }
    return ok({ inputId: input.inputId, runId: request.runId, sessionId: request.sessionId });
  }

  private buildInput(runId: number, sessionId: number, content: SessionInputContentV2, at: string): Result<SessionInputAdmission> {
    const contextService = this.dependencies.contextService;
    if (!contextService) return ok({ runId, content }); // Explicit legacy Runtime construction.
    const run = this.dependencies.runs.get(runId);
    if (!run.ok) return run;
    if (run.data.kind !== 'agent') return fail(appError('run_state_invalid', 'runtime', 'Context requires an Agent Run.'));
    const goalMode = run.data.config.goalMode ?? 'answer';
    if (goalMode !== 'answer' && goalMode !== 'save-candidate' && goalMode !== 'fill-form')
      return fail(appError('storage_corrupt', 'storage', 'Saved Context goal is invalid.'));
    const built = contextService.build({ runId, sessionId, jobId: run.data.jobId, text: content.text,
      goalMode, workspaceContext: content.workspaceContext, workspaceInput: content.workspaceInput,
      ...(content.resourceBinding ? { resourceBinding: content.resourceBinding } : {}),
      allowedDocumentIds: content.allowedDocumentIds, allowedArtifactIds: content.allowedArtifactIds,
      workingDirectory: typeof run.data.config.workingDirectory === 'string' ? run.data.config.workingDirectory : null, createdAt: at });
    return built.ok ? ok({ runId, content: { ...content, promptText: built.data.promptText },
      contextPolicyVersion: 'p8-context-v1', contextSnapshotId: built.data.snapshot.id }) : built;
  }

  private verifyInputUse(context: AgentExecutionContext, inputId: number): Result<void> {
    const { active, session } = context;
    const stored = this.dependencies.sessionInputs?.get(inputId);
    if (!stored || !stored.ok || !stored.data || stored.data.runId !== active.runId || stored.data.sessionId !== session.sessionId
      || stored.data.content.version !== 2 || !['queued', 'consumed'].includes(stored.data.status))
      return fail(appError('input_delivery_unknown', 'session', 'Input identity cannot be confirmed.', true, active.runId));
    const row = this.dependencies.sessions?.get(session.sessionId);
    const run = this.dependencies.runs.get(active.runId);
    if (!row || !row.ok || !run.ok) return fail(appError('storage_read_failed', 'storage', 'Input use cannot be confirmed.', true, active.runId));
    if (this.poisoned || active.poisoned || active.terminalCommitted || active.stopIntent || run.data.cancelRequestedAt !== null
      || !['created', 'running'].includes(run.data.status)) return fail(appError('input_admission_closed', 'session', 'Input use is closed.', true, active.runId));
    if (row.data.deletePending || row.data.status !== 'active' || row.data.nativeSessionId !== session.nativeSessionId)
      return fail(appError('session_history_invalid', 'session', 'Input Session is unavailable.', false, active.runId));
    const permission = this.dependencies.sessions?.isModelUseBlocked(session.sessionId);
    if (!permission) return fail(appError('storage_read_failed', 'storage', 'Input material access cannot be verified.', true, active.runId));
    if (!permission.ok) return permission;
    if (permission.data) return fail(appError('session_scope_revoked', 'session', 'Input material access was revoked.', false, active.runId));
    if (row.data.nativeUnusable) return fail(appError('agent_session_unusable', 'session', 'Saved history is unusable.', false, active.runId));
    const content = stored.data.content;
    const corrupt = () => fail(appError('storage_corrupt', 'storage', 'Saved input does not match its fixed Run scope.', false, active.runId));
    if (run.data.kind !== 'agent') return corrupt();
    const frozenResources = run.data.config.resources === undefined ? null : FrozenResourcesSchema.safeParse(run.data.config.resources);
    if (frozenResources && !frozenResources.success || Boolean(frozenResources) !== Boolean(content.resourceBinding)) return corrupt();
    if (frozenResources?.success) {
      const binding = content.resourceBinding!;
      if (binding.bundleHash !== frozenResources.data.bundleHash || binding.requiredSkill && !frozenResources.data.discoveredSkills.some(ref =>
        resourceRefKey(ref) === resourceRefKey(binding.requiredSkill!))) return corrupt();
      const verified = this.dependencies.resources?.verifyFrozen(frozenResources.data);
      if (!verified || !verified.ok) return verified ?? fail(appError('resource_bundle_unavailable', 'storage', 'Frozen resource verification is unavailable.', true));
    }
    if (run.data.scope.version === 1) {
      if (content.workspaceContext !== null || content.workspaceInput !== null
        || content.allowedDocumentIds.length !== 0 || content.allowedArtifactIds.length !== 0) return corrupt();
    } else if (run.data.scope.version === 2) {
      const frozen = content.workspaceContext;
      const initial = WorkspaceContextSchema.safeParse(run.data.config.workspaceContext);
      const sameIds = (left: readonly number[], right: readonly number[]) => left.length === right.length
        && left.every(id => right.includes(id));
      if (!frozen || !content.workspaceInput || !initial.success || run.data.input.version !== 2
        || frozen.sessionId !== run.data.sessionId || frozen.sessionId !== initial.data.sessionId
        || frozen.jobId !== run.data.jobId || frozen.jobId !== initial.data.jobId
        || JSON.stringify(frozen.documentRef) !== JSON.stringify(initial.data.documentRef)
        || JSON.stringify(frozen.candidateRef) !== JSON.stringify(initial.data.candidateRef)
        || JSON.stringify(content.workspaceInput) !== JSON.stringify(run.data.input.workspaceInput)
        || JSON.stringify(frozen.documentRef) !== JSON.stringify(content.workspaceInput.documentRef)
        || frozen.jobId !== (content.workspaceInput.job?.id ?? null)
        || frozen.candidateRef?.id !== content.workspaceInput.candidate?.id
        || frozen.candidateRef?.sequence !== content.workspaceInput.candidate?.sequence
        || !sameIds(content.allowedDocumentIds, run.data.scope.allowedDocumentIds)
        || !sameIds(content.allowedArtifactIds, run.data.scope.allowedArtifactIds)) return corrupt();
    } else return corrupt();
    return this.dependencies.runs.verifyInputUse(content, this.dependencies.workspaceVerifier, {
      runId: active.runId, sessionId: session.sessionId, contextSnapshotId: stored.data.contextSnapshotId });
  }

  private qualifyInputResult(context: AgentExecutionContext, inputIds: readonly number[], resultEntryId: string): Result<boolean> {
    const evidence = this.dependencies.sessionInputs!.resultEvidence(context.active.runId, inputIds, resultEntryId);
    if (!evidence.ok) return evidence;
    for (const input of evidence.data.inputs) {
      const allowed = this.verifyInputUse(context, input.inputId);
      if (!allowed.ok) return allowed;
    }
    if (context.scope && this.dependencies.tools) {
      const facts = this.dependencies.tools.candidateFacts(context.active.runId, evidence.data.toolCallIds);
      if (!facts.ok) return facts;
      if (facts.data.cleanupErrors.length) return fail(facts.data.cleanupErrors[0]!);
      if (!facts.data.stopped) return ok(false);
      if (context.request.goalMode === 'save-candidate' && evidence.data.inputs.some(input => input.mode === 'prompt') && !facts.data.deliveredCandidateIds.length)
        return fail(appError('agent_goal_not_met', 'runtime', 'This response batch did not deliver a saved candidate.', false, context.active.runId));
      if (context.request.goalMode === 'fill-form') return ok(false);
    }
    return ok(true);
  }

  private completeInputResult(context: AgentExecutionContext, inputIds: readonly number[], resultEntryId: string): Result<void> {
    const qualified = this.qualifyInputResult(context, inputIds, resultEntryId);
    let completed: Result<void>;
    if (!qualified.ok) {
      if (qualified.error.code !== 'agent_goal_not_met') return qualified;
      completed = this.dependencies.sessionInputs!.failResult(context.active.runId, inputIds, resultEntryId, qualified.error, this.dependencies.now());
    } else {
      if (!qualified.data) return ok(undefined);
      completed = this.dependencies.sessionInputs!.completeResult(context.active.runId, inputIds, resultEntryId, this.dependencies.now());
    }
    if (!completed.ok) {
      context.active.storageError = completed.error;
      context.active.stop('shutdown');
      context.active.poisoned = this.poisoned = true;
    }
    return completed;
  }

  private persistCancellation(active: ActiveCall, at: string): boolean {
    try {
      const recorded = this.dependencies.runs.recordCancel(active.runId, at);
      if (recorded.ok) return recorded.data;
    } catch { /* an unexpected storage exception must not prevent abort */ }
    active.storageError = appError('storage_write_failed', 'storage', '取消意图保存失败。', true, active.runId);
    active.poisoned = this.poisoned = true;
    try { this.dependencies.log.write({ at, level: 'error', component: 'runtime', runId: active.runId,
      event: 'cancel_record_failed', code: active.storageError.code }); } catch { /* diagnostics are best effort */ }
    return false;
  }

  public async revokeDocumentUse(documentId: number): Promise<Result<{ affectedSessionIds: number[]; stopRequested: boolean }>> {
    if (!Number.isSafeInteger(documentId) || documentId < 1 || !this.dependencies.sessions) {
      return fail(appError('input_invalid', 'input', '撤回材料使用权限的参数无效。'));
    }
    const persisted = this.dependencies.sessions.revokeDocumentUse({ documentId, at: this.dependencies.now() });
    if (!persisted.ok) {
      if (persisted.error.code === 'document_not_found') return persisted;
      this.poisoned = true;
      if (this.active && this.active.kind !== 'provider') this.active.stop('user');
      return fail(appError('model_access_revocation_failed', 'storage', '模型使用权限未能持久撤回；当前 Runtime 已停止接纳新请求。', true));
    }
    const active = this.active;
    const affected = active && active.kind !== 'provider' && active.sessionId !== null
      && persisted.data.affectedSessionIds.includes(active.sessionId);
    const stopRequested = affected ? active!.stop('user') : false;
    return ok({ ...persisted.data, stopRequested });
  }

  public async start(rawRequest: NormalizedAgentRunRequest, control: AgentControl = {}, inputSubmission?: NormalizedSessionInputRequest): Promise<Result<RunAccepted>> {
    if (!this.dependencies.sessionInputs) return fail(appError('session_input_unavailable', 'session', 'Session input storage is unavailable.'));
    if (inputSubmission) {
      const normalized = normalizeSessionInputRequest({ ...inputSubmission, ...rawRequest });
      if (inputSubmission.mode !== 'prompt' || !normalized.ok || JSON.stringify(normalized.data) !== JSON.stringify(inputSubmission)) {
        return fail(appError('input_invalid', 'input', 'Input and Run request do not match.'));
      }
      const previous = this.dependencies.sessionInputs.lookup(inputSubmission, control.desktopRequestHash);
      if (!previous.ok) return previous;
      if (previous.data) return previous.data.runId === null
        ? fail(appError('operation_result_unknown', 'session', 'The original input has no confirmed Run.'))
        : ok({ runId: previous.data.runId, sessionId: previous.data.sessionId, inputId: previous.data.inputId });
    } else if (rawRequest.goalMode === 'fill-form') {
      return fail(appError('input_invalid', 'input', 'Fill requires the dedicated input admission.'));
    }
    if (rawRequest.workspace && !this.dependencies.workspaceVerifier)
      return fail(appError('workspace_unavailable', 'storage', 'Workspace verification is unavailable.', true));
    const settings = this.dependencies.runtimeDefaults?.() ?? ok({});
    if (!settings.ok) return settings;
    const defaults = RuntimeRequestOverridesSchema.safeParse(settings.data);
    if (!defaults.success) return fail(appError('config_settings_invalid', 'input', 'Runtime defaults are invalid.'));
    if (!rawRequest.workspace && (rawRequest.budget?.maxToolCalls ?? 0) !== 0)
      return fail(appError('input_invalid', 'input', 'A text-only Run cannot receive tool permission.'));
    const request: FrozenAgentRunRequest = { ...rawRequest,
      goalMode: rawRequest.goalMode ?? 'answer',
      timeoutMs: rawRequest.timeoutMs ?? defaults.data.timeoutMs ?? (rawRequest.goalMode === 'save-candidate' ? RUNTIME_CONFIG.request.saveCandidateTimeoutMs : RUNTIME_CONFIG.request.timeoutMs),
      stopGraceMs: rawRequest.stopGraceMs ?? defaults.data.stopGraceMs ?? RUNTIME_CONFIG.request.stopGraceMs,
      budget: Object.freeze({ maxToolCalls: RUNTIME_CONFIG.runBudget.maxToolCalls, maxModelCalls: rawRequest.workspace
          ? RUNTIME_CONFIG.runBudget.maxModelCalls.workspace : RUNTIME_CONFIG.runBudget.maxModelCalls.chat,
        toolTimeoutMs: RUNTIME_CONFIG.runBudget.toolTimeoutMs,
        ...defaults.data.budget, ...rawRequest.budget, ...(!rawRequest.workspace ? { maxToolCalls: 0 } : {}) }) };
    const { agent, sessions } = this.dependencies;
    if (!agent || !sessions) return fail(appError('agent_unavailable', 'runtime', 'Agent Runtime 尚未组装。'));
    if (this.poisoned) return fail(appError('runtime_unusable', 'runtime', 'Agent 停止或 Run 保存未确认，运行实例不可复用。'));
    if (this.closing || this.closed || this.active !== null) return fail(appError('runtime_busy', 'runtime', '已有 Run 正在执行。'));
    if (this.dependencies.isSessionManaging?.(request.sessionId)) return fail(appError('session_busy', 'session', 'Session management is in progress.', true));
    if (request.goalMode === 'fill-form' && !this.dependencies.tools?.listTools().some(tool => tool.name === 'fill_invoice_form')) {
      return fail(appError('tool_runtime_unavailable', 'runtime', 'The trusted invoice form tool is unavailable.'));
    }

    const sessionResult = sessions.get(request.sessionId);
    if (!sessionResult.ok) return sessionResult;
    const session = sessionResult.data;
    let workingDirectory: string | undefined;
    const availability = this.queryNativeTools();
    const nativeNames = availability.ok ? availability.data.filter((tool) => tool.available).map((tool) => tool.name) : [];
    if (request.workingDirectory !== undefined) {
      if (!request.workspace) return fail(appError('input_invalid', 'input', 'A working directory requires the current workspace context.'));
      try {
        workingDirectory = realpathSync(request.workingDirectory);
        if (!statSync(workingDirectory).isDirectory()) throw new Error('not_directory');
      } catch { return fail(appError('input_unavailable', 'input', 'The selected working directory is unavailable.')); }
    }
    if (session.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Retry Delete to finish removing this Session.', true));
    if (session.status !== 'active') return fail(appError('session_archived', 'session', '归档 Session 不能继续执行。'));
    const modelUseBlocked = sessions.isModelUseBlocked(request.sessionId);
    if (!modelUseBlocked.ok) return modelUseBlocked;
    if (modelUseBlocked.data) return fail(appError('session_scope_revoked', 'session', '此 Session 已撤回材料使用权限，请新建 Session。'));
    const restored = ensureNativeSession(sessions, agent, session, this.dependencies.memory);
    if (!restored.ok) return restored;
    let inspected: ReturnType<AgentPort['inspect']>;
    try {
      inspected = agent.inspect(session.nativeSessionId);
    } catch {
      return fail(appError('agent_session_unavailable', 'session', 'Agent Session 状态无法读取。'));
    }
    if (inspected.availability !== 'ready') {
      const code = inspected.availability === 'busy' ? 'agent_session_busy'
        : inspected.availability === 'unusable' ? 'agent_session_unusable' : 'session_history_unavailable';
      const message = inspected.availability === 'busy' ? 'Agent Session 正在执行。'
        : inspected.availability === 'unusable' ? 'Agent Session 已不可继续使用，请新建会话。' : '此会话的原生历史不可用，请新建会话。';
      return fail(appError(code, 'session', message, false));
    }
    const hub = this.dependencies.resources;
    if (hub && !this.dependencies.contextService) return fail(appError('resource_evidence_write_failed', 'storage', 'Resource admission requires Context persistence.', true));
    let selected: AssemblySelectionSnapshot;
    try {
      const value = this.dependencies.resourceDefaults?.() ?? ok({ revision: 0, selection: EMPTY_RESOURCE_SELECTION });
      if (!value.ok) return value;
      const parsed = AssemblySelectionSnapshotSchema.safeParse(value.data);
      if (!parsed.success) return fail(appError('config_settings_invalid', 'input', 'Resource defaults are invalid.'));
      selected = parsed.data;
    } catch { return fail(appError('config_settings_invalid', 'input', 'Resource defaults could not be read.')); }
    const required = resolveRequiredSkill(request.text, request.requiredSkill, selected.selection.enabledSkills);
    if (!required.ok) return required;
    const activeToolNames = request.workspace ? [...invoiceToolNamesForRun(request.goalMode,
      request.workspace.documentRef !== null, request.workspace.jobId !== null), ...(request.goalMode === 'fill-form' ? [] : nativeNames)] : [];
    const extensionHub = this.dependencies.extensions;
    const fixedExtensions = extensionHub?.freeze({ selection: selected.extensions, settingsRevision: selected.revision, activeToolNames,
      policy: request.goalMode === 'fill-form' ? 'fill' : request.workspace ? 'p3' : 'p2' }) ?? ok(null);
    if (!fixedExtensions.ok) return fixedExtensions;
    if (!extensionHub && selected.extensions.enabledExtensions.length) return fail(appError('extension_config_invalid', 'input', 'Extension directory is unavailable.'));
    const extensions = fixedExtensions.data;
    const fixed = hub?.freeze({ selection: selected.selection, settingsRevision: selected.revision, activeToolNames, requiredSkill: required.data,
      availableExtensions: extensions?.included.map(item => item.ref) ?? [] }) ?? ok(null);
    if (!fixed.ok) return fixed;
    if (!hub && (selected.selection.prompt || selected.selection.enabledSkills.length || required.data))
      return fail(appError('resource_required_unavailable', 'input', 'Managed resources are unavailable.'));
    const resources = fixed.data;
    const resourceBinding: ResourceBinding | undefined = resources ? { bundleHash: resources.bundleHash,
      requiredSkill: required.data as ResourceBinding['requiredSkill'] } : undefined;
    const freezeConfig = (config: ReturnType<typeof initialAgentSnapshot>) => ({ ...config,
      ...(resources ? { resources } : {}), ...(extensions ? { extensions } : {}),
      agent: { ...config.agent, ...(resources ? { resourcePolicy: 'p11-resources-v1' as const } : {}),
        ...(extensions ? { extensionPolicy: extensions.included.length ? 'p12-managed-extensions-v1' as const : 'none' as const } : {}) } });
    const createdAt = this.dependencies.now();
    const input: InputRecord = { version: 1, goal: INVOICE_CHAT_GOAL,
      text: request.text, messageTimestamp: Date.now() };
    let admission: WorkspaceRunAdmission | null = null;
    let scope: RunScope | null = null;
    let inputId: number | undefined;
    let frozenContent: SessionInputContentV2 | undefined;
    const createInput = (submission: NormalizedSessionInputRequest) => this.dependencies.sessionInputs!.admit(submission, () => {
      if (submission.mode !== 'prompt') return fail(appError('input_invalid', 'input', 'Initial input must be a prompt.'));
      let runId: number;
      if (request.workspace) {
        const verify = this.dependencies.workspaceVerifier;
        if (!verify) return fail(appError('workspace_unavailable', 'storage', 'Workspace verification is unavailable.', true));
        const created = this.dependencies.runs.createWorkspaceAgent({ sessionId: request.sessionId,
          expected: request.workspace, goalMode: request.goalMode ?? 'answer', text: request.text,
          messageTimestamp: input.messageTimestamp, goal: INVOICE_CHAT_GOAL,
          config: { ...freezeConfig(initialP3AgentSnapshot(request, session.nativeSessionId)),
            ...(this.dependencies.contextService ? { contextPolicyVersion: 'p8-context-v1' as const } : {}),
            ...(this.dependencies.agent?.compactSession && this.dependencies.contextRepository?.recordCompactionEvidence
              ? { compactionPolicy: RUNTIME_CONFIG.compaction } : {}) }, usage: initialUsage(createdAt),
          cleanup: initialCleanup(), createdAt,
          ...(hub ? { collectResourceEvidence: true as const } : {}),
          ...(submission.goalMode === 'fill-form' ? { formTarget: submission.formTarget } : {}),
          ...(this.dependencies.nativeTools && submission.goalMode !== 'fill-form' ? { nativeTools: {
            runtimeDir: this.dependencies.nativeTools.runtimeDir, allowedTools: nativeNames,
            ...(workingDirectory ? { workingDirectory } : {}) } } : {}) }, verify);
        if (!created.ok) return created;
        admission = created.data;
        scope = created.data.scope;
        runId = created.data.runId;
        if (this.dependencies.nativeTools && submission.goalMode !== 'fill-form')
          workingDirectory ??= join(this.dependencies.nativeTools.runtimeDir, String(runId), 'work');
      } else {
        const created = this.dependencies.runs.createAgent({ goal: INVOICE_CHAT_GOAL, input,
          config: { ...freezeConfig(initialAgentSnapshot(request, session.nativeSessionId)),
            ...(this.dependencies.contextService ? { contextPolicyVersion: 'p8-context-v1' as const } : {}),
            ...(this.dependencies.agent?.compactSession && this.dependencies.contextRepository?.recordCompactionEvidence
              ? { compactionPolicy: RUNTIME_CONFIG.compaction } : {}) }, usage: initialUsage(createdAt),
          cleanup: initialCleanup(), createdAt, sessionId: request.sessionId, scope: chatScope,
          ...(hub ? { collectResourceEvidence: true as const } : {}) });
        if (!created.ok) return created;
        runId = created.data;
      }
      const content: SessionInputContentV2 = { version: 2, text: request.text,
        ...(resourceBinding ? { resourceBinding } : {}),
        requestIdentityVersion: 1, originalBudgetOverrides: originalOverrides(rawRequest),
        workspaceContext: admission?.workspaceContext ?? null, workspaceInput: admission?.workspaceInput ?? null,
        allowedDocumentIds: admission ? [...admission.scope.allowedDocumentIds] : [],
        allowedArtifactIds: admission ? [...admission.scope.allowedArtifactIds] : [],
        ...(control.desktopRequestHash === undefined ? {} : { desktopRequestHash: control.desktopRequestHash }),
        promptText: formatExecutionPrompt({ text: request.text, business: admission !== null,
          ...(admission ? { workspaceInput: admission.workspaceInput, workspaceContext: admission.workspaceContext,
            goalMode: request.goalMode ?? 'answer' } : {}),
          ...(workingDirectory ? { workingDirectory } : {}) }) };
      return this.buildInput(runId, request.sessionId, content, createdAt);
    }, createdAt, control.desktopRequestHash);
    const accepted = inputSubmission ? createInput(inputSubmission)
      : this.dependencies.sessionInputs.allocateSequence(request.sessionId, sequence => {
        const normalized = normalizeSessionInputRequest({ ...rawRequest, mode: 'prompt', clientSequence: sequence });
        return normalized.ok ? createInput(normalized.data) : normalized;
      });
    if (!accepted.ok) return accepted;
    inputId = accepted.data.input.inputId;
    if (!accepted.data.created) return accepted.data.input.runId === null
      ? fail(appError('operation_result_unknown', 'session', 'The original input has no confirmed Run.'))
      : ok({ runId: accepted.data.input.runId, sessionId: request.sessionId, inputId });
    if (accepted.data.input.content.version !== 2 || accepted.data.input.runId === null)
      return fail(appError('input_processing_unconfirmed', 'runtime', 'New input evidence is invalid.'));
    frozenContent = accepted.data.input.content;
    const runId = accepted.data.input.runId;
    const controller = new AbortController();
    let sequence = 0;
    let stopIntent: StopIntent | undefined;
    let resolveStop: ((intent: StopIntent) => void) | undefined;
    const stopPromise = new Promise<StopIntent>((resolve) => { resolveStop = resolve; });
    const emit = (payload: AgentEventPayload) => {
      sequence += 1;
      const event: AgentRunEvent = {
        ...payload,
        runId,
        sessionId: request.sessionId,
        nativeSessionId: session.nativeSessionId,
        sequence,
        at: this.dependencies.now(),
      } as AgentRunEvent;
      try { control.onEvent?.(event); }
      catch {
        try { this.dependencies.log.write({ at: this.dependencies.now(), level: 'warn', component: 'runtime', runId, event: 'agent_event_callback_failed' }); } catch { /* diagnostics are best effort */ }
      }
    };
    const active: ActiveCall = {
      runId,
      kind: 'agent',
      sessionId: request.sessionId,
      nativeSessionId: session.nativeSessionId,
      controller,
      startedAt: this.dependencies.monotonicNow(),
      terminalCommitted: false,
      stop: () => false,
      completion: Promise.resolve(fail(appError('runtime_not_started', 'runtime', 'Run 尚未开始。', false, runId))),
      poisoned: false,
      observe: () => undefined,
    };
    active.stop = (reason) => {
      if (stopIntent || active.poisoned || active.terminalCommitted) return false;
      stopIntent = { reason, at: this.dependencies.now(), monotonicMs: this.dependencies.monotonicNow() };
      active.stopIntent = stopIntent;
      active.inputAdmissionClosed = true;
      try {
        if (reason === 'user') this.persistCancellation(active, stopIntent.at);
      } finally {
        resolveStop?.(stopIntent);
        controller.abort(reason);
      }
      emit({ type: 'run_progress', phase: 'stopping', reason });
      return true;
    };
    let resolveCompletion!: (result: Result<ProviderOutcome>) => void;
    active.completion = new Promise((resolve) => { resolveCompletion = resolve; });
    this.active = active;
    const context: AgentExecutionContext = { active, request, session, input, admission, scope, workingDirectory, promptText: frozenContent.promptText,
      resources, extensions, ...(resourceBinding ? { resourceBinding } : {}),
      ...(inputId === undefined ? {} : { inputId }),
      ...(accepted.data.input.contextSnapshotId === null ? {} : { contextSnapshotId: accepted.data.input.contextSnapshotId }),
      control, stopPromise, readStop: () => stopIntent, emit };
    const timer = setTimeout(() => active.stop('timeout'), request.timeoutMs);
    emit({ type: 'run_progress', phase: 'created' });
    const execution = this.executeAgent(context).catch(() => this.finishAgent(context, null,
      appError('agent_runtime_error', 'runtime', 'Agent 执行失败。', true, runId), false, true));
    void execution.then((result) => {
      clearTimeout(timer);
      if (this.active === active) this.active = null;
      resolveCompletion(result);
      emit({ type: 'run_finished', result });
    }, () => {
      clearTimeout(timer);
      active.poisoned = true;
      this.poisoned = true;
      if (this.active === active) this.active = null;
      const failed = fail<AgentOutcome>(appError('storage_write_failed', 'storage', 'Run 终态保存失败。', true, runId), runId);
      resolveCompletion(failed);
      emit({ type: 'run_finished', result: failed });
    });
    return ok({ runId, sessionId: request.sessionId, ...(inputId === undefined ? {} : { inputId }) });
  }

  public async callProvider(request: ProviderRequest, control: ProviderControl = {}): Promise<Result<ProviderOutcome>> {
    if (this.poisoned) {
      return fail(appError('runtime_unusable', 'runtime', 'Provider 停止未确认，运行实例不可复用。'));
    }
    if (this.closing || this.closed || this.active !== null) {
      return fail(appError('runtime_busy', 'runtime', '已有 Provider Run 正在执行。'));
    }

    const startedAt = this.dependencies.monotonicNow();
    const createdAt = this.dependencies.now();
    const input: InputRecord = { version: 1, goal: request.goal, text: request.text, messageTimestamp: Date.now() };
    const created = this.dependencies.runs.create({
      goal: request.goal,
      input,
      config: initialSnapshot(request),
      usage: initialUsage(createdAt),
      cleanup: initialCleanup(),
      createdAt,
    });
    if (!created.ok) return created;

    const runId = created.data;
    const controller = new AbortController();
    let sequence = 0;
    let stopIntent: StopIntent | undefined;
    let stopResolver: ((intent: StopIntent) => void) | undefined;
    const stopPromise = new Promise<StopIntent>((resolve) => { stopResolver = resolve; });
    const observe = (type: ProviderObservation['type'], data: Readonly<Record<string, unknown>> = {}) => {
      sequence += 1;
      try {
        control.onObservation?.({
          runId,
          sequence,
          at: this.dependencies.now(),
          monotonicMs: this.dependencies.monotonicNow(),
          type,
          data,
        });
      } catch {
        try { this.dependencies.log.write({ at: this.dependencies.now(), level: 'warn', component: 'runtime', runId, event: 'observation_callback_failed' }); } catch { /* diagnostics are best effort */ }
      }
    };
    const active: ActiveCall = {
      runId,
      kind: 'provider',
      sessionId: null,
      nativeSessionId: null,
      controller,
      startedAt,
      terminalCommitted: false,
      stop: () => false,
      completion: Promise.resolve(fail(appError('runtime_not_started', 'runtime', 'Run 尚未开始。', false, runId))),
      poisoned: false,
      observe,
    };
    let resolveLifecycle!: (result: Result<ProviderOutcome>) => void;
    active.completion = new Promise((resolve) => { resolveLifecycle = resolve; });
    const requestStop = (reason: StopReason) => {
      if (stopIntent || active.poisoned || active.terminalCommitted) return false;
      stopIntent = { reason, at: this.dependencies.now(), monotonicMs: this.dependencies.monotonicNow() };
      active.stopIntent = stopIntent;
      active.inputAdmissionClosed = true;
      const elapsedMs = Math.max(0, Math.round(stopIntent.monotonicMs - active.startedAt));
      let cancelPersisted: boolean | undefined;
      try {
        if (reason === 'user') cancelPersisted = this.persistCancellation(active, stopIntent.at);
      } finally {
        stopResolver?.(stopIntent);
        controller.abort(reason);
      }
      observe('stop_requested', { reason, elapsedMs, deadlineElapsedMs: request.timeoutMs, stopGraceMs: request.stopGraceMs });
      if (reason === 'user') observe('cancel_requested', { persisted: cancelPersisted });
      return true;
    };
    active.stop = requestStop;
    this.active = active;
    const timer = setTimeout(() => requestStop('timeout'), Math.max(0, request.timeoutMs - (this.dependencies.monotonicNow() - startedAt)));
    observe('run_created', { status: 'created' });
    const externalAbort = () => requestStop('user');
    control.signal?.addEventListener('abort', externalAbort, { once: true });
    if (control.signal?.aborted) requestStop('user');

    const readStop = () => {
      if (!stopIntent && this.dependencies.monotonicNow() - startedAt >= request.timeoutMs) requestStop('timeout');
      return stopIntent;
    };
    const completion = this.execute(active, request, input, observe, stopPromise, readStop);
    active.completion = completion;
    const result = completion.finally(() => {
      clearTimeout(timer);
      control.signal?.removeEventListener('abort', externalAbort);
      if (this.active === active) this.active = null;
    });
    void result.then(resolveLifecycle, () => resolveLifecycle(fail(appError('provider_runtime_error', 'runtime', 'Provider 执行失败。', true, runId), runId)));
    return result;
  }

  private remainingGrace(context: AgentExecutionContext, intent: StopIntent): number {
    const elapsed = Math.max(0, this.dependencies.monotonicNow() - intent.monotonicMs);
    return Math.max(0, context.request.stopGraceMs - elapsed);
  }

  private agentStop(context: AgentExecutionContext): StopIntent | undefined {
    if (!context.readStop() && this.dependencies.monotonicNow() - context.active.startedAt >= context.request.timeoutMs) {
      context.active.stop('timeout');
    }
    return context.readStop();
  }

  private async executeAgent(context: AgentExecutionContext): Promise<Result<AgentOutcome>> {
    const { active, request, session, input } = context;
    const agent = this.dependencies.agent;
    if (context.scope) this.dependencies.tools?.setRunDeadline(active.runId, active.startedAt + request.timeoutMs);
    if (!agent) return this.finishAgent(context, null, appError('agent_unavailable', 'runtime', 'Agent Runtime 尚未组装。'), true);
    const savedRun = this.dependencies.runs.get(active.runId);
    if (!savedRun.ok) return this.finishAgent(context, null, savedRun.error, true);
    const p8 = savedRun.data.config.contextPolicyVersion === 'p8-context-v1';
    const compactionPolicy = savedRun.data.config.compactionPolicy === undefined ? undefined
      : CompactionPolicySchema.safeParse(savedRun.data.config.compactionPolicy);
    if (compactionPolicy && !compactionPolicy.success)
      return this.finishAgent(context, null, appError('agent_config_invalid', 'runtime', 'Frozen compaction policy is invalid.', false, active.runId), true);
    const frozenCompactionPolicy = compactionPolicy?.success ? compactionPolicy.data : undefined;
    const repository = this.dependencies.contextRepository;
    if (p8 && (!repository || context.contextSnapshotId === undefined))
      return this.finishAgent(context, null, appError('context_binding_unknown', 'runtime', 'Context persistence is unavailable.', false, active.runId), true);
    if (this.dependencies.resources && (!p8 || !repository?.recordResourceRead || !repository.recordResourceRequest))
      return this.finishAgent(context, null, appError('resource_evidence_write_failed', 'storage', 'Resource evidence persistence is unavailable.', true, active.runId), true);
    const contextHooks: ContextHooks | undefined = p8 && repository ? {
      ...(this.dependencies.resources && repository.recordResourceRead ? { recordResourceRead: value => repository.recordResourceRead!(value,
        { runId: active.runId, sessionId: request.sessionId }) } : {}),
      ...(this.dependencies.resources && repository.recordResourceRequest ? { recordResourceRequest: value => repository.recordResourceRequest!(value,
        { runId: active.runId, sessionId: request.sessionId }) } : {}),
      ...(repository.recordCompactionEvidence ? { compaction: (value: Parameters<ContextRepository['recordCompactionEvidence']>[0]) => {
        if (value.runId !== active.runId || value.sessionId !== request.sessionId || value.nativeSessionId !== session.nativeSessionId)
          return fail(appError('context_binding_unknown', 'runtime', 'Compaction does not belong to this Run.'));
        const saved = repository.recordCompactionEvidence!(value);
        if (saved.ok) this.notifyCompaction(value.observation);
        return saved;
      } } : {}),
      resolveToolResult: source => source.sessionId === request.sessionId
        ? repository.resolveToolResult(source)
        : fail(appError('context_binding_unknown', 'runtime', 'Tool result does not belong to this Session.')),
      bind: value => value.binding.runId === active.runId && value.binding.sessionId === request.sessionId
        && value.binding.nativeSessionId === session.nativeSessionId ? repository.bindRequest(value)
        : fail(appError('context_binding_unknown', 'runtime', 'Request does not belong to this Run.')),
      record: (binding, update) => binding.runId === active.runId && binding.sessionId === request.sessionId
        && binding.nativeSessionId === session.nativeSessionId ? repository.recordRequest(binding, update)
        : fail(appError('context_binding_unknown', 'runtime', 'Request does not belong to this Run.')),
    } : undefined;
    if (context.admission && context.workingDirectory) {
      try {
        if (request.workingDirectory === undefined) mkdirSync(context.workingDirectory, { recursive: true });
        if (!statSync(context.workingDirectory).isDirectory()) throw new Error('not_directory');
        if (request.workingDirectory !== undefined && realpathSync(request.workingDirectory) !== context.workingDirectory) {
          throw new Error('working_directory_changed');
        }
      } catch {
        return this.finishAgent(context, null, appError('input_unavailable', 'input', 'The Run working directory is unavailable.', true, active.runId), true);
      }
    }
    const requestedStop = this.agentStop(context);
    if (requestedStop) return this.finishAgent(context, null, errorForStop(requestedStop.reason, active.runId, 'agent'), true);

    const extensionPreparation = context.extensions ? { extensions: context.extensions,
      verifyExtensions: () => this.dependencies.extensions?.validateSelection({ enabledExtensions: context.extensions!.selected }) ?? ok(undefined) } : {};
    const preparation = Promise.resolve().then(() => agent.prepare(
      session.nativeSessionId,
      request.config,
      { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs },
      active.controller.signal,
      context.scope ? { activeToolNames: context.scope.allowedTools, goalMode: request.goalMode ?? 'answer', runtimeBudget: request.budget,
        ...(context.resources ? { resources: context.resources } : {}),
        ...extensionPreparation,
        ...(frozenCompactionPolicy ? { compactionPolicy: frozenCompactionPolicy } : {}),
        sessionInputs: true, ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}) }
        : { sessionInputs: true, runtimeBudget: request.budget,
          ...(context.resources ? { resources: context.resources } : {}),
        ...extensionPreparation,
          ...(frozenCompactionPolicy ? { compactionPolicy: frozenCompactionPolicy } : {}) },
    )).then(
      (result) => ({ ok: true as const, result }),
      () => ({ ok: false as const }),
    );
    const first = await Promise.race([
      preparation.then((value) => ({ kind: 'prepared' as const, value })),
      context.stopPromise.then((intent) => ({ kind: 'stop' as const, intent })),
    ]);
    const finishForStop = async (intent: StopIntent): Promise<Result<AgentOutcome>> => {
      const settled = await withinGrace(preparation, this.remainingGrace(context, intent));
      if (settled.kind === 'grace') {
        void preparation.then(async (late) => {
          if (late.ok && late.result.ok) {
            try {
              const released = await agent.releaseSession(session.nativeSessionId);
              if (!released.closed) this.logAgentCleanup(active.runId, 'late_prepare_release_failed');
            } catch { this.logAgentCleanup(active.runId, 'late_prepare_release_failed'); }
          }
        });
        return this.finishAgent(context, null, errorForStop(intent.reason, active.runId, 'agent'), false, true);
      }
      if (settled.value.ok && !settled.value.result.ok && settled.value.result.error.code === 'stop_unconfirmed') {
        return this.finishAgent(context, null, { ...settled.value.result.error, runId: active.runId }, false, true);
      }
      return this.finishAgent(context, null, errorForStop(intent.reason, active.runId, 'agent'), true);
    };
    if (first.kind === 'stop') return finishForStop(first.intent);
    const prepareDeadline = this.agentStop(context);
    if (prepareDeadline) return finishForStop(prepareDeadline);
    if (!first.value.ok) {
      return this.finishAgent(context, null, appError('agent_runtime_init_failed', 'runtime', 'Agent Runtime 初始化失败。', true, active.runId), false, true);
    }
    if (!first.value.result.ok) {
      const stop = this.agentStop(context);
      const unconfirmed = first.value.result.error.code === 'stop_unconfirmed';
      const error = stop && !unconfirmed ? errorForStop(stop.reason, active.runId, 'agent') : { ...first.value.result.error, runId: active.runId };
      return this.finishAgent(context, null, error, !unconfirmed, unconfirmed);
    }
    const prepared = first.value.result.data;
    if (!isDeepStrictEqual(prepared.snapshot.resources ?? null, context.resources)
      || prepared.snapshot.agent.resourcePolicy !== (context.resources ? 'p11-resources-v1' : 'none'))
      return this.finishAgent(context, null, appError('agent_config_invalid', 'runtime', 'Prepared resources differ from Run admission.', false, active.runId), true);
    if (frozenCompactionPolicy && !isDeepStrictEqual(prepared.snapshot.compactionPolicy, frozenCompactionPolicy))
      return this.finishAgent(context, null, appError('agent_config_invalid', 'runtime', 'Prepared compaction policy differs from Run admission.', false, active.runId), true);
    if (context.extensions && (!isDeepStrictEqual(prepared.snapshot.extensions, context.extensions)
      || !prepared.snapshot.extensionAssembly || !matchesExtensionAssembly(context.extensions, prepared.snapshot.extensionAssembly, session.nativeSessionId)
      || prepared.snapshot.agent.extensionPolicy !== (context.extensions.included.length ? 'p12-managed-extensions-v1' : 'none')))
      return this.finishAgent(context, null, appError('agent_config_invalid', 'runtime', 'Prepared Extensions differ from Run admission.', false, active.runId), true);
    const stopBeforeStart = this.agentStop(context);
    if (stopBeforeStart) {
      return this.finishAgent(context, null, errorForStop(stopBeforeStart.reason, active.runId, 'agent'), true);
    }
    const modelUseBlocked = this.dependencies.sessions?.isModelUseBlocked(request.sessionId);
    if (modelUseBlocked && (!modelUseBlocked.ok || modelUseBlocked.data)) {
      return this.finishAgent(context, null, modelUseBlocked.ok
        ? appError('session_scope_revoked', 'session', '此 Session 已撤回材料使用权限。', false, active.runId, request.sessionId)
        : appError('storage_read_failed', 'storage', 'Session 使用权限无法确认。', true, active.runId, request.sessionId), true);
    }

    let startedConfig: SafeConfigSnapshot = prepared.snapshot;
    if (context.inputId !== undefined) {
      const initial = this.dependencies.runs.get(active.runId);
      if (!initial.ok) return this.finishAgent(context, null, { ...initial.error, runId: active.runId }, false, true);
      const saved = initial.data.config as Record<string, unknown>;
      const preparedFacts = prepared.snapshot as SafeConfigSnapshot & Record<string, unknown>;
      const { agent: _preparedAgent, goalMode: _preparedGoal, workspaceContext: _preparedWorkspace,
        workingDirectory: _preparedDirectory, formTarget: _preparedTarget, contextPolicyVersion: _preparedContext, ...preparedWithoutAgent } = preparedFacts;
      const { agent: frozenAgent, contextPolicyVersion: savedContextPolicy, ...frozenExtensions } = saved;
      const actualAgent = prepared.snapshot.agent;
      const frozenFacts = frozenAgent as typeof actualAgent;
      const frozenRuntime = frozenFacts as RuntimeAgentConfigFacts;
      const compatiblePolicy = actualAgent.policyVersion === 'runtime-v1'
        ? actualAgent.taskPolicyVersion === frozenRuntime.taskPolicyVersion : actualAgent.policyVersion === frozenRuntime.taskPolicyVersion;
      const actualBudget = { maxModelCalls: actualAgent.maxModelCalls,
        maxToolCalls: 'maxToolCalls' in actualAgent ? actualAgent.maxToolCalls : 0,
        toolTimeoutMs: 'toolTimeoutMs' in actualAgent ? actualAgent.toolTimeoutMs : 10_000 };
      if (actualAgent.nativeSessionId !== frozenFacts.nativeSessionId || !compatiblePolicy
        || context.resources && !actualAgent.systemPrompt.startsWith(`${frozenFacts.systemPrompt}\n`)
        || actualAgent.maxContextBytes !== frozenFacts.maxContextBytes
        || actualBudget.maxModelCalls !== request.budget.maxModelCalls || actualBudget.maxToolCalls !== request.budget.maxToolCalls
        || actualBudget.toolTimeoutMs !== request.budget.toolTimeoutMs)
        return this.finishAgent(context, null, appError('agent_config_invalid', 'runtime', 'Prepared Agent policy differs from Run admission.', false, active.runId), true);
      startedConfig = { ...frozenExtensions, ...preparedWithoutAgent, version: 2, runtimeBudget: request.budget,
        ...(context.extensions ? { extensions: saved.extensions, extensionAssembly: prepared.snapshot.extensionAssembly } : {}),
        ...(savedContextPolicy === 'p8-context-v1' ? { contextPolicyVersion: 'p8-context-v1' as const } : {}),
        limits: { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs },
        agent: { ...actualAgent, policyVersion: 'runtime-v1', taskPolicyVersion: frozenRuntime.taskPolicyVersion,
          ...request.budget } } as SafeConfigSnapshot;
    }
    if (context.scope && this.dependencies.tools) {
      const strategy = this.dependencies.tools.freezeStrategy({ allowedTools: context.scope.allowedTools,
        configuredToolTimeoutMs: request.budget.toolTimeoutMs, sdk: prepared.snapshot.sdk,
        environment: `${process.platform}-${process.arch}-${process.versions.bun ? 'bun' : 'node'}`,
        sampleSource: this.dependencies.sampleSource ?? 'production', taskType: request.goalMode,
        modelKey: JSON.stringify(prepared.snapshot.resolvedModel ?? prepared.snapshot.requestedModel), promptVersion: 'runtime-v1' });
      if (!strategy.ok) return this.finishAgent(context, null, strategy.error, true);
      context.runtimeStrategy = strategy.data;
      startedConfig = { ...startedConfig, runtimeStrategy: strategy.data };
      this.dependencies.tools.configureRun(active.runId, { budget: request.budget, strategy: strategy.data,
        deadlineAt: active.startedAt + request.timeoutMs });
    }
    context.maxModelCalls = request.budget.maxModelCalls;
    const started = this.dependencies.runs.start(active.runId, startedConfig, this.dependencies.now());
    if (!started.ok) {
      active.poisoned = true;
      this.poisoned = true;
      const terminal = this.finishAgent(context, null, { ...started.error, runId: active.runId }, true);
      return terminal.ok ? fail({ ...started.error, runId: active.runId }, active.runId) : terminal;
    }
    context.emit({ type: 'run_progress', phase: 'running' });
    const stopBeforePrompt = this.agentStop(context);
    if (stopBeforePrompt) return this.finishAgent(context, null, errorForStop(stopBeforePrompt.reason, active.runId, 'agent'), true);

    if (context.scope && !this.dependencies.tools) {
      return this.finishAgent(context, null, appError('tool_runtime_unavailable', 'runtime', 'P3 工具执行链尚未组装。', true, active.runId), true);
    }
    const productContext = context.scope ? Object.freeze({ runId: active.runId, sessionId: request.sessionId,
      scope: context.scope }) : undefined;
    const agentInput: AgentExecutionInput = {
      ...input,
      runId: active.runId,
      sessionId: request.sessionId,
      inputId: context.inputId,
      contextSnapshotId: context.contextSnapshotId,
      ...(contextHooks ? { contextHooks } : {}),
      promptText: context.promptText,
      ...(context.resources ? { resources: context.resources } : {}),
        ...(context.extensions ? { extensions: context.extensions } : {}),
      ...(context.resourceBinding ? { resourceBinding: context.resourceBinding } : {}),
      runtimeBudget: request.budget, runtimeStrategy: context.runtimeStrategy,
      budgetAwareness: this.dependencies.runtimePolicy?.budgetAwareness ?? true,
      remainingRunMs: () => Math.max(0, active.startedAt + request.timeoutMs - this.dependencies.monotonicNow()),
      verifyInputUse: inputId => this.verifyInputUse(context, inputId),
      completeInputResult: (inputIds, resultEntryId) => this.completeInputResult(context, inputIds, resultEntryId),
      onInputAdmissionClosed: () => { active.inputAdmissionClosed = true; },
      verifyModelUse: () => {
        const row = this.dependencies.sessions?.get(request.sessionId);
        if (!row || !row.ok) return fail(appError('storage_read_failed', 'storage', 'Session 使用资格无法确认。', true, active.runId, request.sessionId));
        if (row.data.nativeSessionId !== session.nativeSessionId || row.data.status !== 'active' || row.data.deletePending) {
          return fail(appError('session_history_invalid', 'session', 'Run 与 Session 身份不一致。', false, active.runId, request.sessionId));
        }
        const permission = this.dependencies.sessions?.isModelUseBlocked(request.sessionId);
        if (!permission) return fail(appError('storage_read_failed', 'storage', 'Material access cannot be verified.', true, active.runId, request.sessionId));
        if (!permission.ok) return permission;
        if (permission.data) return fail(appError('session_scope_revoked', 'session', '此 Session 已撤回材料使用权限。', false, active.runId, request.sessionId));
        if (row.data.nativeUnusable) return fail(appError('agent_session_unusable', 'session', '会话历史不可继续使用。', false, active.runId, request.sessionId));
        if (context.extensions?.included.length) {
          const instance = agent.inspectExtensions?.(session.nativeSessionId);
          const expected = prepared.snapshot.extensionAssembly!.instances[0]!;
          if (!instance?.ok || !instance.data.instance || instance.data.instance.instanceId !== expected.instanceId
            || instance.data.instance.state !== 'active' || instance.data.instance.admission !== 'open')
            return fail(appError('extension_hook_failed', 'extension', 'Run Extension instance is no longer active.'));
        }
        if (context.resources) return this.dependencies.resources!.verifyFrozen(context.resources);
        return ok(undefined);
      },
      ...(context.admission ? { workspaceInput: context.admission.workspaceInput, workspaceContext: context.admission.workspaceContext,
        goalMode: request.goalMode ?? 'answer' as const } : {}),
      ...(context.workingDirectory ? { workingDirectory: context.workingDirectory } : {}),
      ...(productContext && this.dependencies.tools ? { toolBinding: {
        context: productContext,
        observeRequest: (name, raw, call) => {
          const result = this.dependencies.tools!.observeRequest(name, raw, { ...productContext,
            nativeToolCallId: call.nativeToolCallId, signal: call.signal, ...(call.requestBinding ? { requestBinding: call.requestBinding } : {}) });
          return result.ok ? ok(undefined) : result;
        },
        rejectRequest: (name, raw, call, error, stage) => {
          const result = this.dependencies.tools!.rejectRequest(name, raw, { ...productContext,
            nativeToolCallId: call.nativeToolCallId, signal: call.signal, ...(call.requestBinding ? { requestBinding: call.requestBinding } : {}) }, error, stage);
          return result.ok ? ok(undefined) : result;
        },
        recordDelivery: (nativeToolCallId, delivery) => this.dependencies.tools!.recordDelivery(productContext, nativeToolCallId, delivery),
        queryCall: nativeToolCallId => this.dependencies.tools!.queryCall(productContext, nativeToolCallId),
        execute: async (name, input, call, rawArguments = input) => {
          const label = this.dependencies.tools!.listTools().find((tool) => tool.name === name)?.label ?? 'Working';
          context.emit({ type: 'tool_progress', toolName: name, label, phase: 'running' });
          const result = await this.dependencies.tools!.execute(name, input, {
            ...productContext, nativeToolCallId: call.nativeToolCallId, signal: call.signal,
            ...(call.requestBinding ? { requestBinding: call.requestBinding } : {}),
          }, rawArguments);
          context.emit({ type: 'tool_progress', toolName: name, label,
            phase: result.result.status === 'succeeded' ? 'succeeded' : result.result.status === 'cancelled' ? 'cancelled' : 'failed' });
          return result;
        },
      } } : {}),
    };
    let nativeWork: Promise<AgentNativeOutcome>;
    if (context.inputId !== undefined) {
      const dispatched = this.dependencies.sessionInputs!.dispatch(context.inputId, this.dependencies.now());
      if (!dispatched.ok) return this.finishAgent(context, null, dispatched.error, true);
    }
    try {
      nativeWork = Promise.resolve(prepared.execute(agentInput, active.controller.signal, (event) => {
        if (event.type === 'agent_event' && event.data.eventName === 'agent_start') active.inputStreamingStarted = true;
        if (event.type === 'display_message' && !active.terminalCommitted) {
          context.emit({ type: 'message_upsert', message: event.message });
        }
        if (event.type === 'display_text_delta' && !active.terminalCommitted && !active.controller.signal.aborted) {
          context.emit({ type: 'text_delta', text: event.text });
        }
      }));
    } catch {
      return this.finishAgent(context, null, appError('agent_runtime_error', 'runtime', 'Agent 执行失败。', true, active.runId), false, true);
    }
    const work = nativeWork.then(
      (outcome) => {
        if (active.terminalCommitted && active.poisoned) this.supplementLateAgentUsage(active.runId, outcome);
        return { kind: 'outcome' as const, outcome };
      },
      () => ({ kind: 'error' as const }),
    );
    const result = await Promise.race([
      work,
      context.stopPromise.then((intent) => ({ kind: 'stop' as const, intent })),
    ]);
    if (result.kind === 'stop') {
      const settled = await withinGrace(work, this.remainingGrace(context, result.intent));
      if (settled.kind === 'grace') {
        active.poisoned = true;
        this.poisoned = true;
        return this.finishAgent(context, null, errorForStop(result.intent.reason, active.runId, 'agent'), false, true);
      }
      return settled.value.kind === 'outcome'
        ? this.finishAgent(context, settled.value.outcome, errorForStop(result.intent.reason, active.runId, 'agent'), settled.value.outcome.stopped, !settled.value.outcome.stopped)
        : this.finishAgent(context, null, errorForStop(result.intent.reason, active.runId, 'agent'), false, true);
    }
    return result.kind === 'outcome'
      ? this.finishAgent(context, result.outcome, result.outcome.error, result.outcome.stopped, !result.outcome.stopped)
      : this.finishAgent(context, null, appError('agent_runtime_error', 'runtime', 'Agent 执行失败。', true, active.runId), false, true);
  }

  private finishAgent(
    context: AgentExecutionContext,
    outcome: AgentNativeOutcome | null,
    error: AppError | null,
    stopped: boolean,
    unconfirmed = false,
  ): Result<AgentOutcome> {
    const { active, request, session } = context;
    if (active.terminalCommitted) return fail(appError('run_state_invalid', 'runtime', 'Agent Run 终态已开始提交。', false, active.runId), active.runId);
    active.inputAdmissionClosed = true;
    const toolExecutor = context.scope ? this.dependencies.tools : undefined;
    toolExecutor?.closeRun(active.runId);
    const intent = this.agentStop(context);
    let cleanupFailure = outcome?.cleanupErrors[0];
    let finalError: AppError | null = cleanupFailure ? { ...cleanupFailure, runId: active.runId }
      : intent?.reason === 'input-failure' ? { ...(active.inputFailure ?? errorForStop(intent.reason, active.runId, 'agent')), runId: active.runId }
        : intent ? errorForStop(intent.reason, active.runId, 'agent')
        : error ? { ...error, runId: active.runId } : null;
    let inputUnconfirmed = false;
    let unresolvedDispatched: number[] = [];
    if (context.inputId !== undefined) {
      const inputs = this.dependencies.sessionInputs!.forRun(active.runId);
      if (!inputs.ok) {
        finalError ??= { ...inputs.error, runId: active.runId };
        inputUnconfirmed = true;
      }
      else {
        if (inputs.data.some(input => input.processingStatus === 'failed')) finalError ??= inputs.data.find(input => input.processingStatus === 'failed')!.error
          ?? appError('input_processing_unconfirmed', 'runtime', 'An input failed processing.', true, active.runId);
        unresolvedDispatched = inputs.data.filter(input => input.status !== 'consumed' && input.dispatchedAt !== null).map(input => input.inputId);
      }
    }
    if (!finalError && (!outcome || !stopped)) finalError = appError('agent_stop_unconfirmed', 'runtime', 'Agent 执行结束，但停止状态未确认。', true, active.runId);
    if (!finalError && outcome && (outcome.partial || outcome.stopReason !== 'stop' || !outcome.text.trim())) {
      finalError = appError('agent_incomplete_response', 'runtime', 'Agent 未产生完整的文本回复。', false, active.runId);
    }
    let candidateIds: number[] = [];
    let deliveredCandidateIds: number[] = [];
    let formAppliedAndDelivered = false;
    const toolCleanupErrors: AppError[] = [];
    if (context.scope && toolExecutor) {
      const facts = toolExecutor.candidateFacts(active.runId);
      if (!facts.ok) finalError ??= appError('storage_read_failed', 'storage', 'Run 候选事实无法核验。', true, active.runId);
      else {
        if (context.admission) {
          candidateIds = facts.data.candidateIds;
          deliveredCandidateIds = facts.data.deliveredCandidateIds;
          const target = context.admission.formTarget;
          const candidate = context.admission.workspaceContext.candidateRef;
          formAppliedAndDelivered = !!target && !!candidate && facts.data.deliveredFormApplications.some(receipt =>
            receipt.formInstanceId === target.formInstanceId && receipt.appliedRevision === target.expectedRevision + 1
            && receipt.candidateId === candidate.id && receipt.candidateSequence === candidate.sequence);
        }
        toolCleanupErrors.push(...facts.data.cleanupErrors);
        if (!facts.data.stopped) {
          stopped = false;
          unconfirmed = true;
          cleanupFailure ??= appError('stop_not_confirmed', 'runtime', 'A native tool process has not confirmed termination.', true, active.runId);
          finalError ??= cleanupFailure;
        }
        if (facts.data.cleanupErrors.length) {
          cleanupFailure ??= facts.data.cleanupErrors[0];
          finalError ??= cleanupFailure!;
        }
      }
    }
    if (!finalError && outcome) {
      const modelCallLimit = context.maxModelCalls ?? 0;
      const validCounts = outcome.agent.turnCount >= 1 && outcome.agent.turnCount <= modelCallLimit
        && outcome.agent.modelCallCount >= 1 && outcome.agent.modelCallCount <= modelCallLimit;
      if (outcome.agent.nativeSessionId !== session.nativeSessionId || !validCounts) {
        finalError = appError('agent_mechanical_check_failed', 'runtime', 'Agent execution exceeded its model call budget.', false, active.runId);
      }
    }
    if (!finalError && context.admission && request.goalMode === 'save-candidate' && deliveredCandidateIds.length === 0) {
      finalError = appError('agent_goal_not_met', 'runtime', '候选未在模型后续请求中成功回送，保存目标未完成。', false, active.runId);
    }
    if (!finalError && request.goalMode === 'fill-form' && !formAppliedAndDelivered) {
      finalError = appError('agent_goal_not_met', 'runtime', '表单应用及结果进入后续模型请求未确认，录入目标未完成。', false, active.runId);
    }
    const confirmedUnconsumedInputIds = stopped && !unconfirmed ? outcome?.agent.confirmedUnconsumedInputIds : undefined;
    inputUnconfirmed ||= unresolvedDispatched.some(id => !confirmedUnconsumedInputIds?.includes(id));
    if (inputUnconfirmed && !intent) finalError ??= appError('input_delivery_unknown', 'session', 'Input consumption could not be confirmed.', false, active.runId);
    const inputResults: import('../sessions/input-ledger.ts').InputResultBatch[] = [];
    if (!finalError && context.inputId !== undefined) {
      const inputs = this.dependencies.sessionInputs!.forRun(active.runId);
      if (!inputs.ok) {
        finalError = { ...inputs.error, runId: active.runId };
        inputUnconfirmed = true;
      }
      else {
        const pending = inputs.data.filter(input => input.processingStatus === 'pending' && input.status === 'consumed');
        for (const input of pending) if (input.resultEntryId === null) {
          finalError = appError('input_processing_unconfirmed', 'runtime', 'Input has no saved final result.', true, active.runId);
          inputUnconfirmed = true;
        }
        for (const resultEntryId of new Set(pending.flatMap(input => input.resultEntryId ? [input.resultEntryId] : []))) {
          const members = inputs.data.filter(input => input.resultEntryId === resultEntryId).map(input => input.inputId);
          const qualified = this.qualifyInputResult(context, members, resultEntryId);
          if (!qualified.ok) finalError ??= qualified.error;
          else if (qualified.data || request.goalMode === 'fill-form' && formAppliedAndDelivered && stopped)
            inputResults.push({ inputIds: members, resultEntryId });
          else finalError ??= appError('input_processing_unconfirmed', 'runtime', 'Input result is not qualified.', true, active.runId);
        }
      }
    }
    const status: AgentOutcome['status'] = cleanupFailure ? 'failed'
      : intent ? intent.reason === 'user' && stopped ? 'cancelled' : 'failed'
        : finalError ? 'failed' : 'completed';
    const cleanupErrors = new Map<string, AppError>();
    for (const cleanupError of outcome?.cleanupErrors ?? []) cleanupErrors.set(cleanupError.code, cleanupError);
    for (const cleanupError of toolCleanupErrors) cleanupErrors.set(cleanupError.code, cleanupError);
    if (active.storageError) cleanupErrors.set(active.storageError.code, active.storageError);
    if (unconfirmed) cleanupErrors.set('stop_unconfirmed', appError('stop_unconfirmed', 'runtime', 'Agent 停止未确认。', true, active.runId));
    const cleanup: CleanupRecord = {
      version: 1,
      stopped,
      stopReason: intent?.reason ?? outcome?.stopReason ?? null,
      errors: [...cleanupErrors.values()],
      lateObservationRequired: unconfirmed || !stopped,
    };
    const { confirmedUnconsumedInputIds: _proof, ...productAgent } = outcome?.agent ?? { nativeSessionId: session.nativeSessionId, turnCount: 0, modelCallCount: 0 };
    const output: AgentOutputRecord | null = outcome ? {
      ...outputRecord(outcome),
      version: 2,
      agent: { ...productAgent, ...(context.admission ? { candidateIds } : {}) },
    } : null;
    const usage = outcome?.usage ?? initialUsage(this.dependencies.now());
    const tokens = outcome?.tokens ?? { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
    const terminal: TerminalWrite = {
      status,
      inputResults: status === 'completed' ? inputResults : [],
      confirmedUnconsumedInputIds,
      nativeHistoryUnusable: inputUnconfirmed || unconfirmed || !stopped || this.dependencies.agent?.inspect(session.nativeSessionId).availability === 'unusable',
      output,
      error: finalError,
      usage,
      tokens,
      cleanup,
      endedAt: this.dependencies.now(),
      stoppedAt: stopped ? this.dependencies.now() : null,
      durationMs: Math.max(0, Math.round(this.dependencies.monotonicNow() - active.startedAt)),
      cancelRequestedAt: intent?.reason === 'user' ? intent.at : undefined,
    };
    active.terminalCommitted = true;
    let committed: ReturnType<RunRepository['finish']>;
    try { committed = this.dependencies.runs.finish(active.runId, terminal); }
    catch { committed = fail(appError('storage_write_failed', 'storage', 'Run 终态保存失败。', true, active.runId), active.runId); }
    if (!committed.ok) {
      active.poisoned = true;
      this.poisoned = true;
      // The terminal transaction rolled back. This independent conservative block
      // preserves that failure while preventing reuse of SQL's last committed prefix.
      if (terminal.nativeHistoryUnusable && this.dependencies.sessions) {
        const blocked = this.dependencies.sessions.markHistoryUnusable(session.sessionId);
        if (!blocked.ok) return fail(blocked.error, active.runId);
      }
      return fail(appError('storage_write_failed', 'storage', 'Run 终态保存失败。', true, active.runId), active.runId);
    }
    if (!committed.data) {
      active.poisoned = true;
      this.poisoned = true;
      return fail(appError('run_state_invalid', 'runtime', 'Agent Run 终态已由其他路径提交。', false, active.runId), active.runId);
    }
    if (stopped && !unconfirmed) toolExecutor?.releaseRun(active.runId);
    active.poisoned ||= unconfirmed || !!cleanupFailure;
    if (unconfirmed || cleanupFailure) this.poisoned = true;
    if (active.storageError) return fail(active.storageError, active.runId);
    return ok({
      runId: active.runId,
      sessionId: request.sessionId,
      nativeSessionId: session.nativeSessionId,
      status,
      text: outcome?.text ?? '',
      error: finalError,
      stopped,
      cleanupErrors: cleanup.errors,
    });
  }

  private supplementLateAgentUsage(runId: number, outcome: AgentNativeOutcome): void {
    try {
      const supplemented = this.dependencies.runs.supplementUsage(runId, outcome.usage, outcome.tokens);
      if (!supplemented.ok || !supplemented.data) this.logAgentCleanup(runId, 'late_usage_not_applied');
    } catch { this.logAgentCleanup(runId, 'late_usage_not_applied'); }
    finally { this.dependencies.tools?.releaseRun(runId); }
  }

  private logAgentCleanup(runId: number, event: string): void {
    try { this.dependencies.log.write({ at: this.dependencies.now(), level: 'warn', component: 'runtime', runId, event }); } catch { /* diagnostics are best effort */ }
  }

  private async execute(
    active: ActiveCall,
    request: ProviderRequest,
    input: InputRecord,
    observe: (type: ProviderObservation['type'], data?: Readonly<Record<string, unknown>>) => void,
    stopPromise: Promise<StopIntent>,
    readStop: () => StopIntent | undefined,
  ): Promise<Result<ProviderOutcome>> {
    const initialStop = readStop();
    if (initialStop) {
      return this.finish(active, request, input, errorForStop(initialStop.reason, active.runId), null, true, undefined, initialStop);
    }
    let prepared: Result<PreparedProvider>;
    try {
      const preparePromise = this.dependencies.provider.prepare(request.config, { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs }, active.controller.signal);
      const first = await Promise.race([
        preparePromise.then((value) => ({ kind: 'prepared' as const, value })),
        stopPromise.then((intent) => ({ kind: 'stop' as const, intent })),
      ]);
      if (first.kind === 'stop') {
        const remaining = Math.max(0, request.stopGraceMs - (this.dependencies.monotonicNow() - first.intent.monotonicMs));
        const settled = await withinGrace(preparePromise.then(() => undefined, () => undefined), remaining);
        if (settled.kind === 'grace') {
          void preparePromise.catch(() => undefined);
          return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, false, undefined, first.intent, true);
        }
        return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, true, undefined, first.intent);
      }
      prepared = first.value;
    } catch {
      const stop = readStop();
      return this.finish(active, request, input, stop ? errorForStop(stop.reason, active.runId)
        : appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 初始化失败。', true, active.runId), null, true, undefined, stop);
    }
    if (!prepared.ok) {
      const stop = readStop();
      return this.finish(active, request, input, stop ? errorForStop(stop.reason, active.runId) : prepared.error, null, true, undefined, stop);
    }
    const preparedStop = readStop();
    if (preparedStop) {
      return this.finish(active, request, input, errorForStop(preparedStop.reason, active.runId), null, true, undefined, preparedStop);
    }
    const started = this.dependencies.runs.start(active.runId, prepared.data.snapshot, this.dependencies.now());
    if (!started.ok) {
      active.poisoned = true;
      this.poisoned = true;
      return fail(started.error, active.runId);
    }
    const startStop = readStop();
    if (startStop) {
      return this.finish(active, request, input, errorForStop(startStop.reason, active.runId), null, true, undefined, startStop);
    }
    let work: Promise<NativeOutcome>;
    try {
      work = prepared.data.execute(input, active.controller.signal, (event) => {
        if (event.type === 'native_terminal' && event.data.failed === true
          && typeof event.data.failureMonotonicMs === 'number' && Number.isFinite(event.data.failureMonotonicMs)) {
          // Pi observations and the Runtime clock use the same process monotonic clock.
          active.providerFailureBeforeStop ||= !active.stopIntent || event.data.failureMonotonicMs < active.stopIntent.monotonicMs;
        }
        if (event.type !== 'agent_event') observe(event.type, event.data);
      });
    } catch {
      work = Promise.reject();
    }
    const workResult = work.then((outcome) => {
      if (active.terminalCommitted && active.poisoned) {
        const supplemented = this.dependencies.runs.supplementUsage(active.runId, outcome.usage, outcome.tokens);
        if (!supplemented.ok || !supplemented.data) {
          try { this.dependencies.log.write({ at: this.dependencies.now(), level: 'warn', component: 'runtime', runId: active.runId, event: 'late_usage_not_applied' }); } catch { /* diagnostics are best effort */ }
        }
      }
      return { kind: 'work' as const, outcome };
    }, () => ({ kind: 'error' as const }));
    const stopResult = stopPromise.then((intent) => ({ kind: 'stop' as const, intent }));
    const first = await Promise.race([workResult, stopResult]);
    let finished: Awaited<typeof workResult>;
    if (first.kind === 'stop') {
      const remaining = Math.max(0, request.stopGraceMs - (this.dependencies.monotonicNow() - first.intent.monotonicMs));
      const settled = await withinGrace(workResult, remaining);
      if (settled.kind === 'grace') {
        active.poisoned = true;
        void work.catch(() => undefined);
        return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, false, undefined, first.intent, true);
      }
      finished = settled.value;
    } else {
      finished = first;
    }
    const stop = readStop();
    if (finished.kind === 'error') {
      active.controller.abort('provider_runtime_error');
      return this.finish(active, request, input, stop ? errorForStop(stop.reason, active.runId)
        : appError('provider_runtime_error', 'provider', 'Provider 执行失败。', true, active.runId), null, false, undefined, stop, true);
    }
    return this.finishFromOutcome(active, request, input, finished.outcome, stop);
  }

  private async finishFromOutcome(
    active: ActiveCall,
    request: ProviderRequest,
    input: InputRecord,
    outcome: NativeOutcome,
    stopIntent: StopIntent | undefined,
  ): Promise<Result<ProviderOutcome>> {
    if (stopIntent && !(active.providerFailureBeforeStop && outcome.error)) {
      const error = errorForStop(stopIntent.reason, active.runId);
      const confirmedCancellation = stopIntent.reason === 'user' && outcome.stopped;
      return this.finish(active, request, input, error, outcome, outcome.stopped, outcome, stopIntent, !outcome.stopped && !confirmedCancellation);
    }
    if (outcome.error) return this.finish(active, request, input, { ...outcome.error, runId: active.runId }, outcome, outcome.stopped, outcome, stopIntent, !outcome.stopped);
    if (!outcome.stopped) return this.finish(active, request, input, appError('provider_stop_unconfirmed', 'provider', 'Provider 停止未确认。', true, active.runId), outcome, false, outcome, undefined, true);
    return this.finish(active, request, input, null, outcome, true, outcome, undefined);
  }

  private async finish(
    active: ActiveCall,
    request: ProviderRequest,
    input: InputRecord,
    error: ReturnType<typeof appError> | null,
    rawOutcome: NativeOutcome | null,
    stopped: boolean,
    outcomeForUsage: NativeOutcome | undefined,
    stopIntent: StopIntent | undefined,
    unconfirmed = false,
  ): Promise<Result<ProviderOutcome>> {
    const status: ProviderOutcome['status'] = stopIntent && !(active.providerFailureBeforeStop && rawOutcome?.error)
      ? (stopIntent.reason === 'user' && stopped ? stopStatus(stopIntent.reason) : 'failed')
      : error ? 'failed' : 'completed';
    const finalError = error === null && status === 'completed' && rawOutcome ? null : error ?? appError('provider_incomplete_response', 'provider', 'Provider 响应不完整。', false, active.runId);
    const output = rawOutcome ? outputRecord(rawOutcome) : null;
    const cleanupErrors = new Map<string, AppError>();
    for (const cleanupError of rawOutcome?.cleanupErrors ?? []) cleanupErrors.set(cleanupError.code, cleanupError);
    if (active.storageError) cleanupErrors.set(active.storageError.code, active.storageError);
    if (unconfirmed) cleanupErrors.set('stop_unconfirmed', appError('stop_unconfirmed', 'runtime', 'Provider 停止未确认。', true, active.runId));
    const cleanup: CleanupRecord = {
      version: 1,
      stopped,
      stopReason: stopIntent?.reason ?? (rawOutcome?.stopReason ?? null),
      errors: [...cleanupErrors.values()],
      lateObservationRequired: unconfirmed || !stopped,
    };
    const usage = outcomeForUsage?.usage ?? initialUsage(this.dependencies.now());
    const tokens = outcomeForUsage?.tokens ?? { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
    const terminal: TerminalWrite = {
      status,
      output,
      error: finalError,
      usage,
      tokens,
      cleanup,
      endedAt: this.dependencies.now(),
      stoppedAt: stopped ? this.dependencies.now() : null,
      durationMs: Math.max(0, Math.round(this.dependencies.monotonicNow() - active.startedAt)),
      cancelRequestedAt: stopIntent?.reason === 'user' ? stopIntent.at : undefined,
    };
    const committed = this.dependencies.runs.finish(active.runId, terminal);
    if (!committed.ok) {
      // The provider has stopped (or the stop grace was exhausted), but the
      // durable terminal fact is unknown. Do not let a later call reuse the
      // instance and create a second request against an ambiguous Run.
      active.poisoned = true;
      this.poisoned = true;
      return fail(appError('storage_write_failed', 'storage', 'Run 终态保存失败。', true, active.runId), active.runId);
    }
    if (!committed.data) {
      active.poisoned = true;
      this.poisoned = true;
      return fail(appError('run_state_invalid', 'runtime', 'Run 终态已由其他路径提交。', false, active.runId), active.runId);
    }
    active.terminalCommitted = true;
    active.poisoned ||= unconfirmed;
    if (unconfirmed) this.poisoned = true;
    active.observe('stopped', { stopped, reason: cleanup.stopReason, cleanupErrors: cleanup.errors.map((entry) => entry.code) });
    if (active.storageError) return fail(active.storageError, active.runId);
    const productOutcome: ProviderOutcome = {
      runId: active.runId,
      status,
      text: rawOutcome?.text ?? '',
      error: finalError,
      stopped,
      cleanupErrors: cleanup.errors,
    };
    return ok(productOutcome);
  }

  public close(): Promise<CloseReport> {
    if (this.finalCloseReport) return Promise.resolve(this.finalCloseReport);
    if (this.closeInFlight) return this.closeInFlight;
    this.closeInFlight = this.closeOnce().then((report) => {
      for (const error of report.errors) this.closeErrors.set(error.code, error);
      const complete = { ...report, errors: [...this.closeErrors.values()] };
      if (complete.closed) this.finalCloseReport = complete;
      return complete;
    }).finally(() => { this.closeInFlight = null; });
    return this.closeInFlight;
  }

  private async closeOnce(): Promise<CloseReport> {
    if (this.closed) return { stopped: true, closed: true, errors: [...this.closeErrors.values()] };
    this.closing = true;
    const active = this.active;
    let activeStopped = true;
    if (active) {
      active.stop('shutdown');
      const awaited = active.kind === 'compaction'
        ? await withinGrace(active.completion, RUNTIME_CONFIG.request.stopGraceMs)
        : { kind: 'settled' as const, value: await active.completion };
      const result = awaited.kind === 'settled' ? awaited.value
        : ok({ stopped: false });
      if (!result.ok || !result.data.stopped) {
        activeStopped = false;
        const error = result.ok ? appError('stop_unconfirmed', 'runtime', 'Native operation stop was not confirmed.', true, active.runId ?? undefined) : result.error;
        this.closeErrors.set(error.code, error);
      }
    }
    let agentReport: CloseReport = { stopped: true, closed: true, errors: [] };
    if (this.dependencies.agent) {
      try { agentReport = await this.dependencies.agent.close(); }
      catch {
        agentReport = { stopped: false, closed: false, errors: [appError('agent_close_failed', 'runtime', 'Agent Session 资源关闭失败。', true)] };
      }
      for (const error of agentReport.errors) this.closeErrors.set(error.code, error);
    }
    try {
      const providerReport = await this.dependencies.provider.close();
      this.closed = activeStopped && agentReport.closed && providerReport.closed;
      const stopped = activeStopped && agentReport.stopped && providerReport.stopped;
      this.poisoned ||= !stopped;
      for (const error of providerReport.errors) this.closeErrors.set(error.code, error);
      return { stopped, closed: this.closed, errors: [...this.closeErrors.values()] };
    } catch {
      const error = appError('provider_close_failed', 'provider', 'Provider 资源关闭失败。', true);
      this.closeErrors.set(error.code, error);
      return { stopped: false, closed: false, errors: [...this.closeErrors.values()] };
    }
  }
}
