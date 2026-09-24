import { appError, fail, ok } from '@flowmate/contracts';
import type {
  AppError,
  AgentControl,
  AgentExecutionInput,
  AgentNativeOutcome,
  AgentOutcome,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunSnapshot,
  AgentConfigFacts,
  AgentConfigSnapshot,
  ChatScope,
  CreateSessionRequest,
  Application,
  CloseReport,
  ProviderControl,
  ProviderOutcome,
  ProviderRequest,
  Result,
  RunAccepted,
  RunSnapshot,
  RuntimeState,
  SessionPage,
  SessionRunsPage,
  SessionRunsRequest,
  SessionSnapshot,
  ListSessionsRequest,
} from '@flowmate/contracts';
import type {
  CleanupRecord,
  InputRecord,
  OutputRecord,
  ProviderObservation,
  RunStatus,
  UsageRecord,
} from '@flowmate/contracts';
import type {
  NativeOutcome,
  AgentPort,
  PreparedAgent,
  PreparedProvider,
  ProviderPort,
  SafeConfigSnapshot,
} from '@flowmate/contracts';
import type { RunRepository, SessionRepository, TerminalWrite } from '../storage/repositories.ts';
import { SessionService } from '../sessions/service.ts';
import { INVOICE_CHAT_GOAL, INVOICE_CHAT_SYSTEM_PROMPT, normalizeAgentRunRequest, normalizeCreateSessionRequest, normalizeListSessionsRequest } from '@flowmate/contracts';

export interface RuntimeLogger {
  write(event: { at: string; level: 'info' | 'warn' | 'error'; component: string; runId?: number; event: string; code?: string }): void;
  close(): Promise<void>;
}

export type RuntimeDependencies = {
  runs: RunRepository;
  provider: ProviderPort;
  agent?: AgentPort;
  sessions?: SessionRepository;
  log: RuntimeLogger;
  now: () => string;
  monotonicNow: () => number;
};

type StopReason = 'user' | 'timeout' | 'shutdown';
type StopIntent = { reason: StopReason; at: string; monotonicMs: number };

type ActiveCall = {
  runId: number;
  kind: 'provider' | 'agent';
  sessionId: number | null;
  nativeSessionId: string | null;
  controller: AbortController;
  startedAt: number;
  terminalCommitted: boolean;
  stop: (reason: StopReason) => void;
  completion: Promise<Result<ProviderOutcome>>;
  poisoned: boolean;
  observe: (type: ProviderObservation['type'], data?: Readonly<Record<string, unknown>>) => void;
};

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

function initialAgentSnapshot(request: ProviderRequest, nativeSessionId: string): AgentConfigSnapshot {
  const agent: AgentConfigFacts = {
    policyVersion: 'p2-invoice-chat-v1', nativeSessionId, systemPrompt: INVOICE_CHAT_SYSTEM_PROMPT,
    thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
    maxContextBytes: 512 * 1024, maxOutputBytes: 256 * 1024, maxAssistantContentBytes: 512 * 1024,
    maxModelCalls: 1, sessionRetry: false,
  };
  return { ...initialSnapshot(request), agent };
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
    ...('agent' in outcome ? { agent: (outcome as AgentNativeOutcome).agent } : {}),
  };
}

function errorForStop(reason: StopReason, runId: number) {
  if (reason === 'user') return appError('provider_cancelled', 'provider', 'Provider 请求已取消。', false, runId);
  if (reason === 'timeout') return appError('provider_timeout', 'provider', 'Provider 请求超时。', true, runId);
  return appError('runtime_shutdown', 'runtime', '运行实例正在关闭。', true, runId);
}

function stopStatus(reason: StopReason): Extract<RunStatus, 'failed' | 'cancelled'> {
  return reason === 'user' ? 'cancelled' : 'failed';
}

export class RuntimeService {
  private readonly dependencies: RuntimeDependencies;
  private active: ActiveCall | null = null;
  private closing = false;
  private closed = false;
  private poisoned = false;
  private closeInFlight: Promise<CloseReport> | null = null;
  private finalCloseReport: CloseReport | null = null;
  private readonly closeErrors = new Map<string, ReturnType<typeof appError>>();
  private readonly sessionService?: SessionService;

  public constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies;
    if (dependencies.agent && dependencies.sessions) {
      this.sessionService = new SessionService({
        sessions: dependencies.sessions,
        runs: dependencies.runs,
        agent: dependencies.agent,
        active: () => this.active ? { runId: this.active.runId, sessionId: this.active.sessionId } : null,
      });
    }
  }

  public async callProvider(request: ProviderRequest, control: ProviderControl = {}): Promise<Result<ProviderOutcome>> {
    return this.runRequest(request, control);
  }

  public createSession(request: CreateSessionRequest): Promise<Result<SessionSnapshot>> {
    return Promise.resolve(this.sessionService?.create(request) ?? fail(appError('agent_unavailable', 'runtime', 'Agent Sessions 未配置。')));
  }

  public listSessions(request?: ListSessionsRequest): Promise<Result<SessionPage>> {
    return Promise.resolve(this.sessionService?.list(request) ?? fail(appError('agent_unavailable', 'runtime', 'Agent Sessions 未配置。')));
  }

  public querySession(sessionId: number): Promise<Result<SessionSnapshot>> {
    return Promise.resolve(this.sessionService?.query(sessionId) ?? fail(appError('agent_unavailable', 'runtime', 'Agent Sessions 未配置。')));
  }

  public listSessionRuns(request: SessionRunsRequest): Promise<Result<SessionRunsPage>> {
    return Promise.resolve(this.sessionService?.listRuns(request) ?? fail(appError('agent_unavailable', 'runtime', 'Agent Sessions 未配置。')));
  }

  public startRun(raw: AgentRunRequest, control: AgentControl = {}): Promise<Result<RunAccepted>> {
    const normalized = normalizeAgentRunRequest(raw);
    if (!normalized.ok) return Promise.resolve(normalized);
    if (!this.sessionService || !this.dependencies.agent) return Promise.resolve(fail(appError('agent_unavailable', 'runtime', 'Agent Runtime 未配置。')));
    const session = this.sessionService.resolve(normalized.data.sessionId);
    if (!session.ok) return Promise.resolve(session);
    const request: ProviderRequest = {
      goal: INVOICE_CHAT_GOAL,
      text: normalized.data.text,
      config: normalized.data.config,
      timeoutMs: normalized.data.timeoutMs,
      stopGraceMs: normalized.data.stopGraceMs,
    };
    let acceptedRunId: number | null = null;
    let eventSequence = 0;
    type AgentRunEventPayload =
      | { type: 'run_progress'; phase: 'created' | 'running' | 'stopping'; reason?: string }
      | { type: 'run_finished'; result: Result<AgentOutcome> };
    const emit = (event: AgentRunEventPayload, eventRunId?: number) => {
      try {
        if (acceptedRunId === null) return;
        control.onEvent?.({ ...event, runId: eventRunId ?? acceptedRunId, sessionId: normalized.data.sessionId, nativeSessionId: session.data.nativeSessionId, sequence: ++eventSequence, at: this.dependencies.now() } as AgentRunEvent);
      } catch { /* a UI listener cannot affect execution */ }
    };
    const completion = this.runRequest(request, {
      onObservation: (event) => {
        if (event.type === 'run_created') {
          acceptedRunId = event.runId;
          emit({ type: 'run_progress', phase: 'created' });
        } else if (event.type === 'request_budget' || (event.type === 'agent_event' && event.data.eventName === 'agent_start')) {
          emit({ type: 'run_progress', phase: 'running' });
        } else if (event.type === 'stop_requested') {
          emit({ type: 'run_progress', phase: 'stopping', reason: String(event.data.reason ?? 'unknown') });
        }
      },
    }, { sessionId: normalized.data.sessionId, nativeSessionId: session.data.nativeSessionId });
    if (acceptedRunId === null) {
      return completion.then((result) => result.ok
        ? fail(appError('agent_run_not_accepted', 'runtime', 'Agent Run 未能受理。'))
        : result);
    }
    const runId = acceptedRunId;
    void completion.then((result) => {
      const agentResult: Result<AgentOutcome> = result.ok
        ? ok({ ...result.data, sessionId: normalized.data.sessionId, nativeSessionId: session.data.nativeSessionId })
        : result;
      emit({ type: 'run_finished', result: agentResult }, runId);
    });
    return Promise.resolve(ok({ runId, sessionId: normalized.data.sessionId }));
  }

  public cancelRun(runId: number): Promise<Result<{ accepted: boolean; runId: number }>> {
    if (!Number.isSafeInteger(runId) || runId <= 0) return Promise.resolve(fail(appError('run_id_invalid', 'input', 'Run ID 无效。')));
    if (this.active?.kind === 'agent' && this.active.runId === runId) {
      this.active.stop('user');
      return Promise.resolve(ok({ accepted: true, runId }));
    }
    const run = this.dependencies.runs.get(runId);
    if (!run.ok) return Promise.resolve(run);
    return Promise.resolve(ok({ accepted: false, runId }));
  }

  public queryRuntimeState(): Promise<Result<RuntimeState>> {
    const active = this.active ? { runId: this.active.runId, sessionId: this.active.sessionId, kind: this.active.kind } : null;
    return Promise.resolve(ok({
      active,
      blocked: this.poisoned || this.closed || this.closing,
      error: this.poisoned ? appError('runtime_unusable', 'runtime', '运行实例因未收口或持久化错误而不可复用。', true) : null,
    }));
  }

  private async runRequest(
    request: ProviderRequest,
    control: ProviderControl = {},
    agentContext?: { sessionId: number; nativeSessionId: string },
  ): Promise<Result<ProviderOutcome>> {
    if (this.poisoned) {
      return fail(appError('runtime_unusable', 'runtime', 'Provider 停止未确认，运行实例不可复用。'));
    }
    if (this.closing || this.closed || this.active !== null) {
      return fail(appError('runtime_busy', 'runtime', '已有 Provider Run 正在执行。'));
    }

    const createdAt = this.dependencies.now();
    const input: InputRecord = { version: 1, goal: request.goal, text: request.text, messageTimestamp: Date.now() };
    const scope: ChatScope = { version: 1, mode: 'chat-text', toolNames: [], resourcePaths: [] };
    const created = agentContext
      ? this.dependencies.runs.createAgent({
        sessionId: agentContext.sessionId,
        scope,
        goal: request.goal,
        input,
        config: initialAgentSnapshot(request, agentContext.nativeSessionId),
        usage: initialUsage(createdAt),
        cleanup: initialCleanup(),
        createdAt,
      })
      : this.dependencies.runs.create({ goal: request.goal, input, config: initialSnapshot(request), usage: initialUsage(createdAt), cleanup: initialCleanup(), createdAt });
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
      kind: agentContext ? 'agent' : 'provider',
      sessionId: agentContext?.sessionId ?? null,
      nativeSessionId: agentContext?.nativeSessionId ?? null,
      controller,
      startedAt: this.dependencies.monotonicNow(),
      terminalCommitted: false,
      stop: () => undefined,
      completion: Promise.resolve(fail(appError('runtime_not_started', 'runtime', 'Run 尚未开始。', false, runId))),
      poisoned: false,
      observe,
    };
    const requestStop = (reason: StopReason) => {
      if (stopIntent || active.poisoned || active.terminalCommitted) return;
      stopIntent = { reason, at: this.dependencies.now(), monotonicMs: this.dependencies.monotonicNow() };
      const elapsedMs = Math.max(0, Math.round(stopIntent.monotonicMs - active.startedAt));
      observe('stop_requested', {
        reason,
        elapsedMs,
        deadlineElapsedMs: request.timeoutMs,
        stopGraceMs: request.stopGraceMs,
      });
      if (reason === 'user') {
        const persisted = this.dependencies.runs.recordCancel(runId, stopIntent.at);
        if (!persisted.ok) {
          try { this.dependencies.log.write({ at: this.dependencies.now(), level: 'error', component: 'runtime', runId, event: 'cancel_record_failed', code: persisted.error.code }); } catch { /* diagnostics are best effort */ }
        }
        observe('cancel_requested', { persisted: persisted.ok && persisted.data });
      }
      stopResolver?.(stopIntent);
      controller.abort(reason);
    };
    active.stop = requestStop;
    this.active = active;
    observe('run_created', { status: 'created' });
    const externalAbort = () => requestStop('user');
    control.signal?.addEventListener('abort', externalAbort, { once: true });
    if (control.signal?.aborted) requestStop('user');

    const completion = this.execute(active, request, input, observe, stopPromise, () => stopIntent);
    active.completion = completion;
    const timer = setTimeout(() => requestStop('timeout'), request.timeoutMs);
    const result = completion.finally(() => {
      clearTimeout(timer);
      control.signal?.removeEventListener('abort', externalAbort);
      if (this.active === active) this.active = null;
    });
    active.completion = result;
    return result;
  }

  private async execute(
    active: ActiveCall,
    request: ProviderRequest,
    input: InputRecord,
    observe: (type: ProviderObservation['type'], data?: Readonly<Record<string, unknown>>) => void,
    stopPromise: Promise<StopIntent>,
    readStop: () => StopIntent | undefined,
  ): Promise<Result<ProviderOutcome>> {
    if (readStop()) {
      return this.finish(active, request, input, errorForStop(readStop()!.reason, active.runId), null, true, undefined, readStop());
    }
    let prepared: Result<PreparedProvider | PreparedAgent>;
    try {
      const limits = { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs };
      const preparePromise = active.kind === 'agent'
        ? this.dependencies.agent!.prepare(active.nativeSessionId!, request.config, limits, active.controller.signal)
        : this.dependencies.provider.prepare(request.config, limits, active.controller.signal);
      const first = await Promise.race([
        preparePromise.then((value) => ({ kind: 'prepared' as const, value })),
        stopPromise.then((intent) => ({ kind: 'stop' as const, intent })),
      ]);
      if (first.kind === 'stop') {
        const settled = await Promise.race([
          preparePromise.then(
            (value) => ({ kind: 'prepared' as const, value }),
            () => ({ kind: 'prepared' as const, value: null }),
          ),
          new Promise<{ kind: 'grace' }>((resolve) => setTimeout(() => resolve({ kind: 'grace' }), request.stopGraceMs)),
        ]);
        if (settled.kind === 'grace') {
          void preparePromise.catch(() => undefined);
          return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, false, undefined, first.intent, true);
        }
        if (settled.value && !settled.value.ok && settled.value.error.code === 'stop_unconfirmed') {
          active.poisoned = true;
          return this.finish(active, request, input, { ...settled.value.error, runId: active.runId }, null, false, undefined, first.intent, true);
        }
        return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, true, undefined, first.intent);
      }
      prepared = first.value;
    } catch {
      return this.finish(active, request, input, appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 初始化失败。', true, active.runId), null, true, undefined, readStop());
    }
    if (!prepared.ok) {
      const stop = readStop();
      const unconfirmed = prepared.error.code === 'stop_unconfirmed';
      if (unconfirmed) active.poisoned = true;
      const error = unconfirmed ? { ...prepared.error, runId: active.runId } : stop ? errorForStop(stop.reason, active.runId) : prepared.error;
      return this.finish(active, request, input, error, null, !unconfirmed, undefined, stop, unconfirmed);
    }
    if (readStop()) {
      return this.finish(active, request, input, errorForStop(readStop()!.reason, active.runId), null, true, undefined, readStop());
    }
    const started = this.dependencies.runs.start(active.runId, prepared.data.snapshot, this.dependencies.now());
    if (!started.ok) {
      active.poisoned = true;
      this.poisoned = true;
      return fail(started.error, active.runId);
    }

    let work: Promise<NativeOutcome>;
    try {
      work = active.kind === 'agent'
        ? (prepared.data as PreparedAgent).execute({ ...input, runId: active.runId, sessionId: active.sessionId! }, active.controller.signal, (event) => observe(event.type, event.data))
        : (prepared.data as PreparedProvider).execute(input, active.controller.signal, (event) => observe(event.type, event.data));
    } catch {
      const stop = readStop();
      return this.finish(active, request, input, stop ? errorForStop(stop.reason, active.runId) : appError('provider_runtime_error', 'provider', 'Provider 执行失败。', true, active.runId), null, false, undefined, stop);
    }
    const workResult = work.then((outcome) => {
      if (active.terminalCommitted && active.poisoned) {
        const supplemented = this.dependencies.runs.supplementUsage(active.runId, outcome.usage, outcome.tokens);
        if (!supplemented.ok || !supplemented.data) {
          try { this.dependencies.log.write({ at: this.dependencies.now(), level: 'warn', component: 'runtime', runId: active.runId, event: 'late_usage_not_applied' }); } catch { /* diagnostics are best effort */ }
        }
      }
      return { kind: 'work' as const, outcome };
    });
    const stopResult = stopPromise.then((intent) => ({ kind: 'stop' as const, intent }));
    const first = await Promise.race([workResult, stopResult]);
    if (first.kind === 'stop') {
      const settled = await Promise.race([
        workResult,
        new Promise<{ kind: 'grace' }>((resolve) => setTimeout(() => resolve({ kind: 'grace' }), request.stopGraceMs)),
      ]);
      if (settled.kind === 'grace') {
        active.poisoned = true;
        void work.catch(() => undefined);
        return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, false, undefined, first.intent, true);
      }
      return this.finishFromOutcome(active, request, input, settled.outcome, first.intent);
    }
    return this.finishFromOutcome(active, request, input, first.outcome, readStop());
  }

  private async finishFromOutcome(
    active: ActiveCall,
    request: ProviderRequest,
    input: InputRecord,
    outcome: NativeOutcome,
    stopIntent: StopIntent | undefined,
  ): Promise<Result<ProviderOutcome>> {
    if (stopIntent) {
      const error = errorForStop(stopIntent.reason, active.runId);
      const confirmedCancellation = stopIntent.reason === 'user' && outcome.stopped;
      return this.finish(active, request, input, error, outcome, outcome.stopped, outcome, stopIntent, !outcome.stopped && !confirmedCancellation);
    }
    if (outcome.error) return this.finish(active, request, input, { ...outcome.error, runId: active.runId }, outcome, outcome.stopped, outcome, undefined, !outcome.stopped);
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
    const status: ProviderOutcome['status'] = stopIntent
      ? (stopIntent.reason === 'user' && stopped ? stopStatus(stopIntent.reason) : 'failed')
      : error ? 'failed' : 'completed';
    const finalError = error === null && status === 'completed' && rawOutcome ? null : error ?? appError('provider_incomplete_response', 'provider', 'Provider 响应不完整。', false, active.runId);
    const output = rawOutcome ? outputRecord(rawOutcome) : null;
    const cleanupErrors = new Map<string, AppError>();
    for (const cleanupError of rawOutcome?.cleanupErrors ?? []) cleanupErrors.set(cleanupError.code, cleanupError);
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
    if (active) {
      active.stop('shutdown');
      const result = await active.completion;
      if (!result.ok || !result.data.stopped) {
        const error = result.ok ? appError('stop_unconfirmed', 'runtime', 'Provider 停止未确认。', true, active.runId) : result.error;
        this.closeErrors.set(error.code, error);
      }
    }
    try {
      const providerReport = await this.dependencies.provider.close();
      const agentReport = await this.dependencies.agent?.close() ?? { stopped: true, closed: true, errors: [] };
      this.closed = providerReport.closed && agentReport.closed;
      this.poisoned = !providerReport.stopped || !agentReport.stopped;
      for (const error of [...providerReport.errors, ...agentReport.errors]) this.closeErrors.set(error.code, error);
      return { stopped: providerReport.stopped && agentReport.stopped, closed: this.closed, errors: [...this.closeErrors.values()] };
    } catch {
      const error = appError('provider_close_failed', 'provider', 'Provider 资源关闭失败。', true);
      this.closeErrors.set(error.code, error);
      return { stopped: false, closed: false, errors: [...this.closeErrors.values()] };
    }
  }
}
