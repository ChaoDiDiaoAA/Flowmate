import {
  ModelsError,
  type AssistantMessage,
  type CredentialStore,
  type FetchFunction,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { appError, fail, ok } from '@flowmate/contracts';
import { INVOICE_CHAT_SYSTEM_PROMPT } from '@flowmate/contracts';
import type { AgentExecutionInput, AgentConfigFacts, CloseReport, ProviderConfig, Result, SafeConfigSnapshot } from '@flowmate/contracts';
import type { AgentPort, AgentConfigSnapshot, AgentNativeOutcome, NativeObservation, PreparedAgent } from '@flowmate/contracts';
import type { PiModelRuntimeDependencies } from './model-runtime.ts';
import { prepareModelRuntime } from './model-runtime.ts';
import type { FetchLike } from './provider.ts';

const systemPrompt = INVOICE_CHAT_SYSTEM_PROMPT;
const maxContextBytes = 512 * 1024;
const maxOutputBytes = 256 * 1024;
const maxAssistantContentBytes = 512 * 1024;

type SessionState = { manager: SessionManager; agent?: AgentSession; runtimeKey?: string; busy: boolean; unusable: boolean };
type RefreshTracker = { pending: Set<Promise<unknown>>; errors: string[] };
type ActiveStream = { config: ProviderConfig; limits: { timeoutMs: number; stopGraceMs: number }; signal: AbortSignal; observe(event: NativeObservation): void; calls: number };
type RuntimeState = { runtime: ModelRuntime; refresh: RefreshTracker; providers: Set<string>; apiKeys: Set<string>; active?: ActiveStream };

export type PiAgentDependencies = PiModelRuntimeDependencies & {
  cwd: string;
  credentials?: CredentialStore;
  fetch?: FetchLike;
};

function emptyResourceLoader(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('p2_resources_disabled'); },
    reload: async () => undefined,
  };
}

function safeError(error: unknown): ReturnType<typeof appError> {
  if (error instanceof ModelsError && (error.code === 'auth' || error.code === 'oauth')) return appError('provider_auth_failed', 'provider', 'Provider 认证失败。');
  if (error instanceof Error && error.message === 'agent_unexpected_continuation') return appError('agent_unexpected_continuation', 'runtime', 'P2 无工具会话尝试启动额外模型轮次。');
  return appError('agent_execution_failed', 'runtime', 'Agent 执行失败。', true);
}

function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }

function truncateUtf8(value: string, limit: number): string {
  let text = '';
  let bytes = 0;
  for (const character of value) {
    const length = utf8Length(character);
    if (bytes + length > limit) break;
    text += character;
    bytes += length;
  }
  return text;
}

function assistantMessage(session: AgentSession): AssistantMessage | null {
  const value = session.agent.state.messages.at(-1);
  return value?.role === 'assistant' ? value as AssistantMessage : null;
}

function emptyUsage(reason: string): AgentNativeOutcome['usage'] {
  return { version: 1, source: 'unknown', reason, sdkValues: null, attempts: null, attemptsComplete: false, costSource: null, updatedAt: new Date().toISOString() };
}

function emptyTokens(): AgentNativeOutcome['tokens'] {
  return { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false };
}

export class PiAgentAdapter implements AgentPort {
  private readonly dependencies: PiAgentDependencies;
  private readonly sessions = new Map<string, SessionState>();
  private readonly runtimes = new Map<string, RuntimeState>();
  private activePreparations = 0;
  private activeExecutions = 0;
  private unusable = false;
  private closed = false;
  private readonly closeErrors = new Map<string, ReturnType<typeof appError>>();

  public constructor(dependencies: PiAgentDependencies) { this.dependencies = dependencies; }

  public createSession(): Result<{ nativeSessionId: string }> {
    if (this.closed || this.unusable) return fail(appError('agent_closed', 'runtime', 'Agent Runtime 已关闭或不可复用。'));
    try {
      const manager = SessionManager.inMemory(this.dependencies.cwd);
      const nativeSessionId = manager.getSessionId();
      if (!nativeSessionId || this.sessions.has(nativeSessionId)) return fail(appError('session_create_failed', 'session', 'Pi Session 身份无法创建。'));
      this.sessions.set(nativeSessionId, { manager, busy: false, unusable: false });
      return ok({ nativeSessionId });
    } catch { return fail(appError('session_create_failed', 'session', 'Pi Session 无法创建。', true)); }
  }

  public inspect(nativeSessionId: string): { availability: 'ready' | 'busy' | 'unusable' | 'missing' } {
    const session = this.sessions.get(nativeSessionId);
    if (!session) return { availability: 'missing' };
    if (this.unusable) return { availability: 'unusable' };
    if (session.unusable) return { availability: 'unusable' };
    return { availability: session.busy ? 'busy' : 'ready' };
  }

  public async prepare(
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedAgent>> {
    if (this.closed || this.unusable) return fail(appError('agent_closed', 'runtime', 'Agent Runtime 已关闭或不可复用。'));
    const session = this.sessions.get(nativeSessionId);
    if (!session) return fail(appError('session_history_unavailable', 'session', 'Session 原生历史在当前进程中不可用。'));
    if (session.unusable) return fail(appError('session_unusable', 'session', 'Session 尚未确认停止，不能复用。'));
    if (session.busy) return fail(appError('session_busy', 'session', '该 Session 已有 Run 正在执行。'));
    if (signal.aborted) return fail(appError('provider_cancelled', 'provider', 'Provider 请求已中止。'));
    this.activePreparations += 1;
    try {
      return await this.prepareSession(session, nativeSessionId, config, limits, signal);
    } catch {
      return fail(appError('agent_prepare_failed', 'runtime', 'Agent Session 准备失败。', true));
    } finally { this.activePreparations -= 1; }
  }

  private async prepareSession(
    session: SessionState,
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedAgent>> {
    const runtimeKey = `${config.native.authPath}\0${config.native.modelsPath ?? ''}`;
    let state = this.runtimes.get(runtimeKey);
    if (!state) {
      const tracker: RefreshTracker = { pending: new Set(), errors: [] };
      let registered: RuntimeState | undefined;
      const created = await prepareModelRuntime(config, limits, signal, this.dependencies, undefined, (runtime) => {
        registered = this.trackRuntime(runtime, tracker);
        if (config.connection) registered.providers.add(config.modelRef.provider);
        if (this.dependencies.runtimeApiKeyFor?.(config) ?? this.dependencies.runtimeApiKey) registered.apiKeys.add(config.modelRef.provider);
        this.runtimes.set(runtimeKey, registered);
      });
      if (!created.ok) {
        if (registered) {
          const cleared = await this.clearRuntimeConfig(registered);
          if (!cleared.ok) return cleared;
          await this.drainRefreshes(registered);
        }
        return created;
      }
      state = registered!;
      const drained = await this.drainRefreshes(state);
      if (!drained.ok) return drained;
      const model = state.runtime.getModel(config.modelRef.provider, config.modelRef.model);
      if (!model || state.runtime.getError()) {
        const cleared = await this.clearRuntimeConfig(state);
        if (!cleared.ok) return cleared;
        await this.drainRefreshes(state);
        return fail(appError('provider_model_not_found', 'provider', '所选模型在刷新后不可用。'));
      }
      const ready = await this.finishPreparation(session, nativeSessionId, config, limits, signal, state, model, created.data.snapshot);
      if (!ready.ok) {
        const cleared = await this.clearRuntimeConfig(state);
        if (!cleared.ok) return cleared;
        await this.drainRefreshes(state);
      }
      return ready;
    }

    const cleared = await this.clearRuntimeConfig(state);
    if (!cleared.ok) return cleared;
    let drained = await this.drainRefreshes(state);
    if (!drained.ok) return drained;

    if (config.connection) state.providers.add(config.modelRef.provider);
    if (this.dependencies.runtimeApiKeyFor?.(config) ?? this.dependencies.runtimeApiKey) state.apiKeys.add(config.modelRef.provider);
    const prepared = await prepareModelRuntime(config, limits, signal, this.dependencies, state.runtime);
    if (!prepared.ok) {
      await this.clearRuntimeConfig(state);
      await this.drainRefreshes(state);
      return prepared;
    }
    drained = await this.drainRefreshes(state);
    if (!drained.ok) return drained;
    const model = state.runtime.getModel(config.modelRef.provider, config.modelRef.model);
    if (!model || state.runtime.getError()) {
      const clearResult = await this.clearRuntimeConfig(state);
      if (!clearResult.ok) return clearResult;
      await this.drainRefreshes(state);
      return fail(appError('provider_model_not_found', 'provider', '所选模型在刷新后不可用。'));
    }
    const ready = await this.finishPreparation(session, nativeSessionId, config, limits, signal, state, model, prepared.data.snapshot);
    if (!ready.ok) {
      const clearResult = await this.clearRuntimeConfig(state);
      if (!clearResult.ok) return clearResult;
      await this.drainRefreshes(state);
    }
    return ready;
  }

  private async finishPreparation(
    session: SessionState,
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
    runtime: RuntimeState,
    model: NonNullable<ReturnType<ModelRuntime['getModel']>>,
    baseSnapshot: SafeConfigSnapshot,
  ): Promise<Result<PreparedAgent>> {
    if (signal.aborted) return fail(appError('provider_cancelled', 'provider', 'Provider 请求已中止。'));
    try {
      const nextRuntimeKey = `${config.native.authPath}\0${config.native.modelsPath ?? ''}`;
      if (!session.agent || session.runtimeKey !== nextRuntimeKey) {
        session.agent?.dispose();
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: config.parameters.maxRetryDelayMs } },
          transport: 'sse',
          enableSkillCommands: false,
        });
        const made = await createAgentSession({
          cwd: this.dependencies.cwd,
          agentDir: this.dependencies.cwd,
          modelRuntime: runtime.runtime,
          model,
          sessionManager: session.manager,
          settingsManager,
          resourceLoader: emptyResourceLoader(),
          tools: [],
          customTools: [],
          thinkingLevel: 'off',
        });
        session.agent = made.session;
        session.runtimeKey = nextRuntimeKey;
      }
      const agent = session.agent!;
      agent.settingsManager.applyOverrides({
        compaction: { enabled: false },
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: config.parameters.maxRetryDelayMs } },
      });
      await agent.setModel(model, { persist: false });
      if (signal.aborted) return fail(appError('provider_cancelled', 'provider', 'Provider 请求已中止。'));
      agent.setThinkingLevel('off', { persist: false });
      if (agent.getActiveToolNames().length > 0) return fail(appError('agent_tools_not_empty', 'runtime', 'Agent 工具装配超出 P2 范围。'));
      const facts: AgentConfigFacts = {
        policyVersion: 'p2-invoice-chat-v1', nativeSessionId, systemPrompt,
        thinkingLevel: 'off', resourcePolicy: 'none', historyPolicy: 'memory-only',
        maxContextBytes, maxOutputBytes, maxAssistantContentBytes, maxModelCalls: 1, sessionRetry: false,
      };
      const snapshot: AgentConfigSnapshot = { ...baseSnapshot, agent: facts };
      const runConfig = { ...config, parameters: { ...config.parameters }, native: { ...config.native } };
      const runLimits = { ...limits };
      return ok({
        snapshot,
        execute: (input, executeSignal, observe) => this.execute(session, agent, runtime, nativeSessionId, runConfig, runLimits, input, executeSignal, observe),
      });
    } catch (error) {
      return fail(safeError(error));
    }
  }

  private async execute(
    session: SessionState,
    agent: AgentSession,
    runtime: RuntimeState,
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    input: AgentExecutionInput,
    signal: AbortSignal,
    observe: (event: NativeObservation) => void,
  ): Promise<AgentNativeOutcome> {
    const noRequest = (error: ReturnType<typeof appError>, reason: string): AgentNativeOutcome => ({
      text: '', partial: false, stopReason: 'not_started', responseId: null, responseModel: null, error,
      usage: emptyUsage(reason), tokens: emptyTokens(), stopped: true, cleanupErrors: [],
      agent: { nativeSessionId, turnCount: 0, modelCallCount: 0 },
    });
    if (this.closed || session.unusable) return noRequest(appError('runtime_unusable', 'runtime', 'Agent Runtime 不可复用。'), 'not-started');
    if (this.activeExecutions > 0 || session.busy || agent.isStreaming) return noRequest(appError('runtime_busy', 'runtime', '已有 Agent Run 正在执行。'), 'not-started');
    if (signal.aborted) return noRequest(appError('provider_cancelled', 'provider', 'Provider 请求已中止。'), 'not-started');
    const contextBytes = utf8Length(JSON.stringify({ systemPrompt: agent.systemPrompt, messages: agent.agent.state.messages, nextText: input.text }));
    if (contextBytes > maxContextBytes) return noRequest(appError('agent_context_limit', 'input', 'Session 上下文超过 P2 限额，请创建新会话继续。'), 'context-limit');

    session.busy = true;
    this.activeExecutions += 1;
    let turns = 0;
    let responseText = '';
    let outputLimitExceeded = false;
    let abortTask: Promise<void> | undefined;
    let abortFailed = false;
    let promptError: unknown;
    const emit = (type: NativeObservation['type'], data: Readonly<Record<string, unknown>> = {}) => {
      try { observe({ type, at: new Date().toISOString(), monotonicMs: performance.now(), data }); } catch { /* diagnostics cannot affect a Run */ }
    };
    const active: ActiveStream = { config, limits, signal, observe: (event) => emit(event.type, event.data), calls: 0 };
    runtime.active = active;
    const abortAgent = () => { abortTask ??= agent.abort().catch(() => { abortFailed = true; }); };
    const unsubscribe = agent.subscribe((event) => {
      const raw = event as unknown as { type: string; message?: { role?: string; stopReason?: string }; assistantMessageEvent?: { type?: string; delta?: string } };
      if (raw.type === 'turn_start') turns += 1;
      let textBytes = 0;
      if (raw.type === 'message_update' && raw.assistantMessageEvent?.type === 'text_delta' && typeof raw.assistantMessageEvent.delta === 'string') {
        const delta = raw.assistantMessageEvent.delta;
        const candidate = responseText + delta;
        textBytes = utf8Length(candidate);
        if (textBytes > maxOutputBytes) {
          responseText = truncateUtf8(candidate, maxOutputBytes);
          textBytes = utf8Length(responseText);
          outputLimitExceeded = true;
          abortAgent();
        } else responseText = candidate;
        emit('text_delta', { length: utf8Length(delta) });
      }
      emit('agent_event', {
        eventName: raw.type,
        ...(raw.message?.role ? { role: raw.message.role } : {}),
        ...(raw.message?.stopReason ? { stopReason: raw.message.stopReason } : {}),
        ...(raw.type === 'turn_start' ? { turnOrdinal: turns } : {}),
        ...(raw.type === 'message_update' ? { callSequence: active.calls } : {}),
        ...(raw.type === 'message_update' ? { textBytes } : {}),
      });
    });
    const onAbort = () => abortAgent();
    signal.addEventListener('abort', onAbort, { once: true });
    emit('request_budget', { contextBytes, maxContextBytes, maxOutputBytes });
    try {
      if (signal.aborted) abortAgent();
      else await agent.prompt(input.text, { expandPromptTemplates: false });
    } catch (error) { promptError = error; }
    finally {
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      if (abortTask) await abortTask;
      runtime.active = undefined;
    }

    const cleared = await this.clearRuntimeConfig(runtime);
    const clearResult = cleared.ok ? await this.drainRefreshes(runtime) : cleared;
    session.busy = false;
    this.activeExecutions -= 1;

    const final = assistantMessage(agent);
    let text = outputLimitExceeded ? responseText : (agent.getLastAssistantText() ?? responseText);
    if (final && utf8Length(JSON.stringify(final.content)) > maxAssistantContentBytes) {
      outputLimitExceeded = true;
      text = truncateUtf8(text, maxOutputBytes);
    }
    const stopReason = outputLimitExceeded ? 'output_limit' : signal.aborted ? 'aborted' : String(final?.stopReason ?? (promptError ? 'error' : 'stop'));
    let error: ReturnType<typeof appError> | null = null;
    if (signal.aborted) error = appError('provider_cancelled', 'provider', 'Agent Run 已取消。');
    else if (outputLimitExceeded) error = appError('agent_output_limit', 'runtime', 'Agent 输出超过 P2 限额。');
    else if (promptError) error = safeError(promptError);
    else if (!final || stopReason !== 'stop' || !text) error = appError('agent_incomplete_response', 'runtime', 'Agent 未返回完整文本回复。');
    const rawUsage = final?.usage;
    const hasUsage = Boolean(rawUsage && rawUsage.totalTokens > 0);
    const usage: AgentNativeOutcome['usage'] = hasUsage && rawUsage ? {
      version: 1, source: 'sdk', reason: null,
      sdkValues: {
        input: rawUsage.input, output: rawUsage.output, cacheRead: rawUsage.cacheRead, cacheWrite: rawUsage.cacheWrite,
        totalTokens: rawUsage.totalTokens, costInput: rawUsage.cost.input, costOutput: rawUsage.cost.output,
        costCacheRead: rawUsage.cost.cacheRead, costCacheWrite: rawUsage.cost.cacheWrite, costTotal: rawUsage.cost.total,
      },
      attempts: active.calls || null, attemptsComplete: agent.isIdle, costSource: 'pi-sdk-model-catalog-estimate', updatedAt: new Date().toISOString(),
    } : { ...emptyUsage(active.calls ? 'sdk-usage-missing' : 'request-not-started'), attempts: active.calls || null, attemptsComplete: agent.isIdle };
    const tokens = hasUsage && rawUsage
      ? { inputTokens: rawUsage.input, outputTokens: rawUsage.output, totalTokens: rawUsage.totalTokens, cost: String(rawUsage.cost.total), usageComplete: agent.isIdle }
      : emptyTokens();
    const stopped = agent.isIdle && !abortFailed && clearResult.ok;
    const cleanupErrors = [
      ...(abortFailed ? [appError('agent_abort_failed', 'runtime', 'Pi Agent 停止失败。', true)] : []),
      ...(!clearResult.ok ? [clearResult.error] : []),
    ];
    if (!stopped) session.unusable = true;
    if (stopped) emit('native_terminal', { stopReason });
    return {
      text,
      partial: Boolean(text) && error !== null,
      stopReason,
      responseId: final?.responseId ?? null,
      responseModel: final?.responseModel ?? final?.model ?? null,
      error, usage, tokens, stopped, cleanupErrors,
      agent: { nativeSessionId, turnCount: turns, modelCallCount: active.calls },
    };
  }

  private trackRuntime(runtime: ModelRuntime, tracker: RefreshTracker): RuntimeState {
    const state: RuntimeState = { runtime, refresh: tracker, providers: new Set(), apiKeys: new Set() };
    const originalRefresh = runtime.refresh.bind(runtime);
    runtime.refresh = ((options) => {
      const work = originalRefresh(options);
      tracker.pending.add(work);
      void work.then((result) => {
        if (result.aborted) tracker.errors.push('refresh-aborted');
        if (result.errors.size) tracker.errors.push('refresh-errors');
      }, () => { tracker.errors.push('refresh-failed'); }).finally(() => tracker.pending.delete(work));
      return work;
    }) as typeof runtime.refresh;
    const originalStream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = ((model, context, options) => {
      const active = state.active;
      if (active) {
        active.signal.throwIfAborted();
        if (active.calls >= 1) throw new Error('agent_unexpected_continuation');
        active.calls += 1;
        active.observe({ type: 'model_request', at: new Date().toISOString(), monotonicMs: performance.now(), data: {
          callSequence: active.calls, messageCount: context.messages.length, toolCount: context.tools?.length ?? 0,
        } });
        const signal = options?.signal ? AbortSignal.any([options.signal, active.signal]) : active.signal;
        options = { ...options, signal, maxRetries: active.config.parameters.maxRetries, maxRetryDelayMs: active.config.parameters.maxRetryDelayMs, timeoutMs: active.limits.timeoutMs };
        if (this.dependencies.fetch) options.fetch = this.dependencies.fetch as FetchFunction;
      }
      return originalStream(model, context, options);
    }) as typeof runtime.streamSimple;
    return state;
  }

  private async drainRefreshes(state: RuntimeState): Promise<Result<void>> {
    while (state.refresh.pending.size) await Promise.allSettled([...state.refresh.pending]);
    if (state.refresh.errors.length) {
      state.refresh.errors.splice(0);
      return fail(appError('provider_runtime_init_failed', 'provider', 'Provider Runtime 刷新未能确认完成。', true));
    }
    return ok(undefined);
  }

  private async clearRuntimeConfig(state: RuntimeState): Promise<Result<void>> {
    for (const provider of state.providers) state.runtime.unregisterProvider(provider);
    state.providers.clear();
    const failed: string[] = [];
    for (const key of state.apiKeys) {
      try {
        await state.runtime.removeRuntimeApiKey(key);
        state.apiKeys.delete(key);
      } catch { failed.push(key); }
    }
    if (failed.length) {
      this.unusable = true;
      const error = appError('stop_unconfirmed', 'runtime', 'Pi Runtime 凭据清理未确认，Agent Runtime 已封闭。', true);
      this.closeErrors.set(error.code, error);
      return fail(error);
    }
    return ok(undefined);
  }

  public async releaseSession(nativeSessionId: string): Promise<CloseReport> {
    const session = this.sessions.get(nativeSessionId);
    if (!session) return { stopped: true, closed: true, errors: [] };
    if (session.busy || session.agent?.isStreaming) return { stopped: false, closed: false, errors: [appError('session_busy', 'session', 'Session 仍在执行。', true)] };
    session.agent?.dispose();
    this.sessions.delete(nativeSessionId);
    return { stopped: true, closed: true, errors: [] };
  }

  public async close(): Promise<CloseReport> {
    if (this.closed) return { stopped: true, closed: true, errors: [...this.closeErrors.values()] };
    if (this.activeExecutions || this.activePreparations || [...this.sessions.values()].some((session) => session.busy || session.agent?.isStreaming)) {
      return { stopped: false, closed: false, errors: [appError('stop_unconfirmed', 'runtime', 'Agent Session 仍在收口。', true)] };
    }
    let stopped = true;
    for (const session of this.sessions.values()) session.agent?.dispose();
    for (const state of this.runtimes.values()) {
      const cleared = await this.clearRuntimeConfig(state);
      if (!cleared.ok) stopped = false;
      if (!(await this.drainRefreshes(state)).ok) stopped = false;
    }
    if (stopped) { this.sessions.clear(); this.runtimes.clear(); this.closed = true; }
    return { stopped, closed: stopped, errors: [...this.closeErrors.values(), ...(stopped ? [] : [appError('stop_unconfirmed', 'runtime', 'Agent Runtime 关闭未确认。', true)])] };
  }
}
