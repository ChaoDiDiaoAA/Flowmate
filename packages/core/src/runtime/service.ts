import { appError, fail, ok } from '@flowmate/contracts';
import type {
  AppError,
  Application,
  CloseReport,
  ProviderControl,
  ProviderOutcome,
  ProviderRequest,
  Result,
  RunSnapshot,
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
  PreparedProvider,
  ProviderPort,
  SafeConfigSnapshot,
} from '@flowmate/contracts';
import type { RunRepository, TerminalWrite } from '../storage/repositories.ts';

export interface RuntimeLogger {
  write(event: { at: string; level: 'info' | 'warn' | 'error'; component: string; runId?: number; event: string; code?: string }): void;
  close(): Promise<void>;
}

export type RuntimeDependencies = {
  runs: RunRepository;
  provider: ProviderPort;
  log: RuntimeLogger;
  now: () => string;
  monotonicNow: () => number;
};

type StopReason = 'user' | 'timeout' | 'shutdown';
type StopIntent = { reason: StopReason; at: string; monotonicMs: number };

type ActiveCall = {
  runId: number;
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

  public constructor(dependencies: RuntimeDependencies) {
    this.dependencies = dependencies;
  }

  public async callProvider(request: ProviderRequest, control: ProviderControl = {}): Promise<Result<ProviderOutcome>> {
    if (this.poisoned) {
      return fail(appError('runtime_unusable', 'runtime', 'Provider 停止未确认，运行实例不可复用。'));
    }
    if (this.closing || this.closed || this.active !== null) {
      return fail(appError('runtime_busy', 'runtime', '已有 Provider Run 正在执行。'));
    }

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
    observe('run_created', { status: 'created' });

    const active: ActiveCall = {
      runId,
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
    let prepared: Result<PreparedProvider>;
    try {
      const preparePromise = this.dependencies.provider.prepare(request.config, { timeoutMs: request.timeoutMs, stopGraceMs: request.stopGraceMs }, active.controller.signal);
      const first = await Promise.race([
        preparePromise.then((value) => ({ kind: 'prepared' as const, value })),
        stopPromise.then((intent) => ({ kind: 'stop' as const, intent })),
      ]);
      if (first.kind === 'stop') {
        const settled = await Promise.race([
          preparePromise.then(() => ({ kind: 'prepared' as const }), () => ({ kind: 'prepared' as const })),
          new Promise<{ kind: 'grace' }>((resolve) => setTimeout(() => resolve({ kind: 'grace' }), request.stopGraceMs)),
        ]);
        if (settled.kind === 'grace') {
          void preparePromise.catch(() => undefined);
          return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, false, undefined, first.intent, true);
        }
        return this.finish(active, request, input, errorForStop(first.intent.reason, active.runId), null, true, undefined, first.intent);
      }
      prepared = first.value;
    } catch {
      return this.finish(active, request, input, appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 初始化失败。', true, active.runId), null, true, undefined, readStop());
    }
    if (!prepared.ok) {
      const stop = readStop();
      return this.finish(active, request, input, stop ? errorForStop(stop.reason, active.runId) : prepared.error, null, true, undefined, stop);
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
      work = prepared.data.execute(input, active.controller.signal, (event) => observe(event.type, event.data));
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
      const report = await this.dependencies.provider.close();
      this.closed = report.closed;
      this.poisoned = !report.stopped;
      for (const error of report.errors) this.closeErrors.set(error.code, error);
      return { stopped: report.stopped, closed: report.closed, errors: [...this.closeErrors.values()] };
    } catch {
      const error = appError('provider_close_failed', 'provider', 'Provider 资源关闭失败。', true);
      this.closeErrors.set(error.code, error);
      return { stopped: false, closed: false, errors: [...this.closeErrors.values()] };
    }
  }
}
