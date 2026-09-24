import {
  createAssistantMessageEventStream,
  type AssistantMessage,
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
import type {
  AgentConfigFacts,
  AgentExecutionInput,
  AgentNativeOutcome,
  AgentPort,
  AgentPortAvailability,
  CloseReport,
  NativeObservation,
  PromptTraceBuffer,
  PromptTraceEntry,
  PromptTraceEvent,
  PromptTraceReference,
  PreparedAgent,
  Result,
  SafeConfigSnapshot,
} from '@flowmate/contracts';
import type { ProviderConfig } from '@flowmate/contracts';
import { INVOICE_CHAT_SYSTEM_PROMPT } from '@flowmate/contracts';
import { normalizeUsage, modelRuntimeSnapshot, prepareModelRuntime, safeUrl } from './model-runtime.ts';
import type { FetchLike, PiProviderDependencies } from './model-runtime.ts';

const maxContextBytes = 512 * 1024;
const maxOutputBytes = 256 * 1024;
const maxAssistantContentBytes = 512 * 1024;
const encoder = new TextEncoder();

type AgentStream = AgentSession['agent']['streamFunction'];
type AgentStreamArguments = Parameters<AgentStream>;
type StreamModel = AgentStreamArguments[0];
type StreamContext = AgentStreamArguments[1];
type StreamOptions = AgentStreamArguments[2];

type ActiveExecution = {
  runId: number;
  sessionId: number;
  nativeSessionId: string;
  signal: AbortSignal;
  observe: (event: NativeObservation) => void;
  callSequence: number;
  turnOrdinal: number;
  attempts: number;
  responseStatus: number | null;
  responseStarted: boolean;
  complete: boolean;
  wireMaxTokens: number | null;
  text: string;
  textBytes: number;
  assistantContentBytes: number;
  failure: ReturnType<typeof appError> | null;
  promptEntered: boolean;
  streams: Set<Promise<void>>;
  abortPromise: Promise<void> | null;
  stopReason: string;
};

type SessionRecord = {
  manager: SessionManager;
  session?: AgentSession;
  runtime?: ModelRuntime;
  model?: NonNullable<ReturnType<ModelRuntime['getModel']>>;
  config?: ProviderConfig;
  snapshot?: SafeConfigSnapshot;
  preparing: boolean;
  running: boolean;
  unusable: boolean;
  active?: ActiveExecution;
};

function emptyResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('agent_resources_disabled'); },
    reload: async () => {},
  };
}

function inMemorySettings(): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1, provider: { maxRetries: 0, maxRetryDelayMs: 0 } },
    transport: 'sse',
    enableSkillCommands: false,
    defaultTools: [],
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
}

function canReuseRuntime(previous: ProviderConfig | undefined, next: ProviderConfig): boolean {
  return Boolean(previous)
    && previous!.native.authPath === next.native.authPath
    && previous!.native.modelsPath === next.native.modelsPath
    && Boolean(previous!.connection) === Boolean(next.connection);
}

function sameModel(a: NonNullable<ReturnType<ModelRuntime['getModel']>> | undefined, b: NonNullable<ReturnType<ModelRuntime['getModel']>>): boolean {
  return Boolean(a && a.provider === b.provider && a.id === b.id && a.api === b.api && a.baseUrl === b.baseUrl);
}

function systemError(error: ReturnType<typeof appError>, model: StreamModel, stopReason: 'error' | 'aborted' = 'error', text = ''): AssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage: error.message,
    timestamp: Date.now(),
  };
}

function errorStream(model: StreamModel, error: ReturnType<typeof appError>, stopReason: 'error' | 'aborted' = 'error', text = '') {
  const stream = createAssistantMessageEventStream();
  const message = systemError(error, model, stopReason, text);
  stream.push({ type: 'error', reason: stopReason, error: message });
  stream.end(message);
  return stream;
}

function appendUtf8(current: string, delta: string, currentBytes: number): { text: string; bytes: number; exceeded: boolean } {
  let accepted = '';
  let bytes = currentBytes;
  for (const character of delta) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxOutputBytes) return { text: current + accepted, bytes, exceeded: true };
    accepted += character;
    bytes += size;
  }
  return { text: current + accepted, bytes, exceeded: false };
}

function contentBytes(message: AssistantMessage): number {
  return encoder.encode(JSON.stringify(message.content)).byteLength;
}

function textFrom(message: AssistantMessage): string {
  return message.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text).join('');
}

function now(): { at: string; monotonicMs: number } {
  return { at: new Date().toISOString(), monotonicMs: performance.now() };
}

function traceInteger(value: unknown): string {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : 'unknown';
}

function safeTraceStopReason(value: unknown): 'stop' | 'length' | 'error' | 'aborted' | 'pending' | null {
  return value === 'stop' || value === 'length' || value === 'error' || value === 'aborted' || value === 'pending' ? value : null;
}

export class PiAgentAdapter implements AgentPort {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer };
  private closed = false;

  public constructor(dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer } = {}) {
    this.dependencies = dependencies;
  }

  public createSession(): Result<{ nativeSessionId: string }> {
    if (this.closed) return fail(appError('agent_port_closed', 'runtime', 'Agent Runtime 已关闭。'));
    const cwd = this.dependencies.cwd ?? process.cwd();
    const manager = SessionManager.inMemory(cwd);
    const nativeSessionId = manager.getSessionId();
    this.sessions.set(nativeSessionId, { manager, preparing: false, running: false, unusable: false });
    return ok({ nativeSessionId });
  }

  public inspect(nativeSessionId: string) {
    const record = this.sessions.get(nativeSessionId);
    const availability: AgentPortAvailability = !record ? 'missing'
      : record.unusable ? 'unusable'
        : record.preparing || record.running ? 'busy' : 'ready';
    const model = record?.snapshot?.resolvedModel ?? record?.snapshot?.requestedModel;
    return {
      availability,
      boundConfig: record?.config ? structuredClone(record.config) : null,
      boundModel: record?.config && model ? {
        provider: model.provider,
        model: model.model,
        api: record.snapshot?.api ?? record.config.connection?.api ?? '',
        endpoint: record.snapshot?.endpoint ?? record.config.connection?.baseUrl ?? '',
      } : null,
    };
  }

  public async prepare(
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
  ): Promise<Result<PreparedAgent>> {
    const record = this.sessions.get(nativeSessionId);
    if (this.closed) return fail(appError('agent_port_closed', 'runtime', 'Agent Runtime 已关闭。'));
    if (!record) return fail(appError('agent_session_missing', 'session', 'Agent Session 不存在。'));
    if (record.unusable) return fail(appError('agent_session_unusable', 'session', 'This session cannot continue after an interrupted run. Start a new session.'));
    if (record.preparing || record.running) return fail(appError('agent_session_busy', 'session', 'Agent Session 正在执行。'));
    if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));

    record.preparing = true;
    let replacingSession = false;
    let sessionCreationStarted = false;
    try {
      const reuseRuntime = canReuseRuntime(record.config, config) && record.runtime;
      if (reuseRuntime && record.config && record.snapshot?.native.authSource === 'pi-runtime-api-key'
        && record.config.modelRef.provider !== config.modelRef.provider) {
        try {
          await record.runtime!.removeRuntimeApiKey(record.config.modelRef.provider, { signal });
        } catch {
          return fail(appError('provider_runtime_init_failed', 'provider', '旧 Provider 凭据未能从运行时清除。', true));
        }
      }
      const prepared = await prepareModelRuntime(config, limits, signal, this.dependencies, reuseRuntime || undefined);
      if (!prepared.ok) return prepared;
      const { runtime, model } = prepared.data;
      const authSource = prepared.data.snapshot.native.authSource;
      if (authSource === 'unknown') return fail(appError('agent_auth_source_unknown', 'runtime', '无法确认 Agent 模型凭据来源。'));
      if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));

      let session = record.session;
      if (session && runtime !== record.runtime) {
        session.dispose();
        record.session = undefined;
        session = undefined;
        replacingSession = true;
      }
      if (!session) {
        const cwd = this.dependencies.cwd ?? process.cwd();
        sessionCreationStarted = true;
        const created = await createAgentSession({
          cwd,
          agentDir: this.dependencies.agentDir ?? cwd,
          modelRuntime: runtime,
          model,
          sessionManager: record.manager,
          settingsManager: inMemorySettings(),
          resourceLoader: emptyResourceLoader(INVOICE_CHAT_SYSTEM_PROMPT),
          noTools: 'all',
          tools: [],
          customTools: [],
          thinkingLevel: 'off',
        });
        session = created.session;
        session.agent.streamFunction = this.wrapStream(record, session, session.agent.streamFunction);
        record.session = session;
      } else if (!sameModel(record.model, model)) {
        try {
          await session.setModel(model, { persist: false });
        } catch {
          return fail(appError('agent_model_switch_failed', 'session', '所选模型无法在此会话中使用。'));
        }
      }

      const snapshot = modelRuntimeSnapshot(config, limits, model, authSource);
      record.runtime = runtime;
      record.model = model;
      record.config = structuredClone(config);
      record.snapshot = snapshot;
      replacingSession = false;
      if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));
      const agent: AgentConfigFacts = {
        policyVersion: 'p2-invoice-chat-v1',
        nativeSessionId,
        systemPrompt: session.systemPrompt,
        thinkingLevel: session.thinkingLevel,
        resourcePolicy: 'none',
        historyPolicy: 'memory-only',
        maxContextBytes: 524_288,
        maxOutputBytes: 262_144,
        maxAssistantContentBytes: 524_288,
        maxModelCalls: 1,
        sessionRetry: false,
      };
      return ok({
        snapshot: { ...snapshot, agent },
        execute: (input, executionSignal, observe) => this.execute(record, nativeSessionId, input, executionSignal, observe),
      });
    } catch {
      // createAgentSession can append native model metadata before it throws; do not reuse an uncertain manager.
      if ((replacingSession || sessionCreationStarted) && !record.session) record.unusable = true;
      return fail(appError('agent_session_init_failed', 'session', 'Agent Session 初始化失败。', true));
    } finally {
      record.preparing = false;
    }
  }

  private wrapStream(record: SessionRecord, session: AgentSession, nativeStream: AgentStream): AgentStream {
    return (model, context, options) => {
      const active = record.active;
      if (!active) return errorStream(model, appError('agent_unbound_execution', 'runtime', 'Agent 请求缺少有效 Run 绑定。'));
      if (active.signal.aborted) return errorStream(model, appError('agent_cancelled', 'runtime', 'Agent 执行已取消。'), 'aborted');
      if (active.callSequence >= 1) {
        this.stop(record, active);
        active.failure ??= appError('agent_unexpected_continuation', 'runtime', 'P2 Agent 请求次数超过限制。');
        active.stopReason = active.failure.code;
        return errorStream(model, active.failure);
      }

      let contextSize: number;
      try {
        contextSize = encoder.encode(JSON.stringify(context)).byteLength;
      } catch {
        contextSize = maxContextBytes + 1;
      }
      if (contextSize > maxContextBytes) {
        active.failure ??= appError('agent_context_limit', 'runtime', 'Agent 上下文超过本阶段限制。');
        active.stopReason = active.failure.code;
        this.stop(record, active);
        return errorStream(model, active.failure);
      }

      active.callSequence += 1;
      this.observe(active, 'model_request', {
        callSequence: active.callSequence,
        model: model.id,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
        contextBytes: contextSize,
      });
      const output = createAssistantMessageEventStream();
      const worker = this.forwardStream(record, session, active, nativeStream, model, context, options, output);
      active.streams.add(worker);
      void worker.then(() => active.streams.delete(worker), () => active.streams.delete(worker));
      return output;
    };
  }

  private async forwardStream(
    record: SessionRecord,
    session: AgentSession,
    active: ActiveExecution,
    nativeStream: AgentStream,
    model: StreamModel,
    context: StreamContext,
    options: StreamOptions,
    output: ReturnType<typeof createAssistantMessageEventStream>,
  ): Promise<void> {
    let outputEnded = false;
    let finalMessage: AssistantMessage | undefined;
    let streamFailed = false;
    const failStream = (error: ReturnType<typeof appError>, stopReason: 'error' | 'aborted' = 'error') => {
      if (!active.failure) {
        active.failure = error;
        active.stopReason = error.code;
      }
      this.stop(record, active);
      if (!outputEnded) {
        const message = systemError(error, model, stopReason, active.text);
        output.push({ type: 'error', reason: stopReason, error: message });
        output.end(message);
        outputEnded = true;
      }
    };
    const baseFetch: FetchLike = (options?.fetch as FetchLike | undefined)
      ?? this.dependencies.fetch
      ?? ((request, init) => globalThis.fetch(request, init));
    const fetch: FetchLike = async (request, init) => {
      active.attempts += 1;
      const requestUrl = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      this.observe(active, 'request_dispatched', { callSequence: active.callSequence, attempt: active.attempts, url: safeUrl(requestUrl) });
      try {
        const response = await baseFetch(request, init);
        active.responseStatus = response.status;
        active.responseStarted = true;
        this.observe(active, 'response_started', { callSequence: active.callSequence, attempt: active.attempts, status: response.status });
        return response;
      } catch (error) {
        if (!active.failure) active.failure = this.providerError(active, error);
        throw error;
      }
    };
    const signal = options?.signal ? AbortSignal.any([options.signal, active.signal]) : active.signal;
    const onPayload = async (payload: unknown, requestedModel: StreamModel) => {
      const replacement = await options?.onPayload?.(payload, requestedModel);
      const outgoing = replacement === undefined ? payload : replacement;
      if (outgoing && typeof outgoing === 'object') {
        const body = outgoing as Record<string, unknown>;
        const generation = body.generationConfig as Record<string, unknown> | undefined;
        const budget = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? generation?.maxOutputTokens;
        active.wireMaxTokens = typeof budget === 'number' ? budget : active.wireMaxTokens;
        this.observe(active, 'request_budget', { callSequence: active.callSequence, wireMaxTokens: active.wireMaxTokens });
      }
      return replacement;
    };
    const onResponse = async (response: { status: number; headers: Record<string, string> }, requestedModel: StreamModel) => {
      await options?.onResponse?.(response, requestedModel);
      active.responseStatus = response.status;
      active.responseStarted = true;
      this.observe(active, 'response_started', { callSequence: active.callSequence, attempt: active.attempts || 1, status: response.status });
    };
    try {
      const stream = await nativeStream(model, context, {
        ...options,
        signal,
        fetch: fetch as FetchFunction,
        timeoutMs: record.snapshot?.limits.timeoutMs,
        maxRetries: record.config?.parameters.maxRetries,
        maxRetryDelayMs: record.config?.parameters.maxRetryDelayMs,
        onPayload,
        onResponse,
      });
      for await (const event of stream) {
        if (event.type === 'start') active.responseStarted = true;
        if (event.type === 'text_delta' && !outputEnded) {
          const appended = appendUtf8(active.text, event.delta, active.textBytes);
          const length = appended.text.length - active.text.length;
          active.text = appended.text;
          active.textBytes = appended.bytes;
          this.observe(active, 'text_delta', { length, textBytes: active.textBytes });
          if (appended.exceeded) {
            failStream(appError('agent_output_limit', 'runtime', 'Agent 回复超过本阶段限制。'));
            continue;
          }
        }
        const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error
          : 'partial' in event ? event.partial : undefined;
        if (message) {
          try {
            active.assistantContentBytes = contentBytes(message);
          } catch {
            active.assistantContentBytes = maxAssistantContentBytes + 1;
          }
          if (active.assistantContentBytes > maxAssistantContentBytes) {
            failStream(appError('agent_content_limit', 'runtime', 'Agent 原生回复内容超过本阶段限制。'));
            continue;
          }
          if (message.content.some((part) => part.type === 'toolCall')) {
            failStream(appError('agent_unexpected_tool_call', 'runtime', 'P2 Agent 收到未授权的工具调用。'));
            continue;
          }
        }
        if (event.type === 'error') finalMessage = event.error;
        if (event.type === 'done') finalMessage = event.message;
        if (!outputEnded) output.push(event);
      }
      finalMessage ??= await stream.result();
      if (finalMessage) {
        try { active.assistantContentBytes = contentBytes(finalMessage); }
        catch { active.assistantContentBytes = maxAssistantContentBytes + 1; }
        if (active.assistantContentBytes > maxAssistantContentBytes) {
          failStream(appError('agent_content_limit', 'runtime', 'Agent 原生回复内容超过本阶段限制。'));
        } else if (finalMessage.content.some((part) => part.type === 'toolCall')) {
          failStream(appError('agent_unexpected_tool_call', 'runtime', 'P2 Agent 收到未授权的工具调用。'));
        }
        const finalText = textFrom(finalMessage);
        const finalTextBytes = encoder.encode(finalText).byteLength;
        if (finalTextBytes > maxOutputBytes) {
          active.text = appendUtf8('', finalText, 0).text;
          active.textBytes = maxOutputBytes;
          failStream(appError('agent_output_limit', 'runtime', 'Agent 回复超过本阶段限制。'));
        } else if (active.textBytes === 0 && finalTextBytes > 0) {
          active.text = finalText;
          active.textBytes = finalTextBytes;
        }
      }
      active.complete = true;
      active.stopReason = finalMessage.stopReason;
      if (!outputEnded) output.end(finalMessage);
    } catch (error) {
      streamFailed = true;
      active.complete = false;
      const mapped = active.failure ?? this.providerError(active, error);
      active.failure = mapped;
      active.stopReason = mapped.code;
      if (!outputEnded) {
        const message = systemError(mapped, model, active.signal.aborted ? 'aborted' : 'error', active.text);
        output.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message });
        output.end(message);
      }
    }
    if (!active.responseStarted && (active.signal.aborted || streamFailed)) active.complete = false;
  }

  private observe(
    active: ActiveExecution,
    type: 'agent_event',
    data: Extract<NativeObservation, { type: 'agent_event' }>['data'],
  ): void;
  private observe(
    active: ActiveExecution,
    type: Exclude<NativeObservation['type'], 'agent_event'>,
    data: Readonly<Record<string, unknown>>,
  ): void;
  private observe(active: ActiveExecution, type: NativeObservation['type'], data: Readonly<Record<string, unknown>>): void {
    const event = type === 'agent_event'
      ? { type, ...now(), data }
      : { type, ...now(), data: { runId: active.runId, sessionId: active.sessionId, ...data } };
    this.recordPromptTrace(active, type, event.at, data);
    try { active.observe(event as NativeObservation); } catch { /* observers cannot interrupt the native run */ }
  }

  private recordPromptTrace(active: ActiveExecution, type: NativeObservation['type'], at: string, data: Readonly<Record<string, unknown>>): void {
    const buffer = this.dependencies.promptTrace;
    if (!buffer) return;
    const reference: PromptTraceReference = {
      runId: active.runId,
      sessionId: active.sessionId,
      nativeSessionId: active.nativeSessionId,
      callSequence: active.callSequence,
    };
    try {
      if (type === 'model_request') buffer.begin(reference);
      if (active.callSequence < 1) return;
      let event: PromptTraceEvent;
      let summary: string;
      if (type === 'agent_event') {
        const eventName = data.eventName;
        if (typeof eventName !== 'string') return;
        event = `agent:${eventName}` as PromptTraceEvent;
        const role = data.role === 'user' || data.role === 'assistant' || data.role === 'toolResult' ? ` · role=${data.role}` : '';
        const turn = Number.isSafeInteger(data.turnOrdinal) ? ` · turn=${data.turnOrdinal}` : '';
        const bytes = Number.isSafeInteger(data.textBytes) ? ` · deltaBytes=${data.textBytes}` : '';
        const stopReason = safeTraceStopReason(data.stopReason);
        summary = `${eventName}${role}${turn}${bytes}${stopReason ? ` · stop=${stopReason}` : ''}`;
      } else {
        event = type;
        if (type === 'model_request') summary = `Model context prepared · messages=${traceInteger(data.messageCount)} · tools=${traceInteger(data.toolCount)} · contextBytes=${traceInteger(data.contextBytes)}`;
        else if (type === 'request_budget') summary = `Output budget=${traceInteger(data.wireMaxTokens)} tokens`;
        else if (type === 'request_dispatched') summary = `HTTP attempt ${traceInteger(data.attempt)} dispatched`;
        else if (type === 'response_started') summary = `HTTP response started · status=${traceInteger(data.status)}`;
        else if (type === 'text_delta') summary = `Assistant text delta · bytes=${traceInteger(data.length)}`;
        else if (type === 'native_terminal') summary = `Native call settled · stop=${safeTraceStopReason(data.stopReason) ?? 'other'} · stopped=${data.stopped === true ? 'yes' : 'no'}`;
        else return;
      }
      const entry: PromptTraceEntry = { at, event, summary, truncated: false };
      buffer.append(reference, entry);
      if (type === 'native_terminal') buffer.end(reference);
    } catch { /* diagnostics must not change the Agent result */ }
  }

  private stop(record: SessionRecord, active: ActiveExecution): void {
    if (!active.abortPromise && record.session) {
      active.abortPromise = record.session.abort().catch(() => {
        active.failure ??= appError('agent_cleanup_failed', 'runtime', 'Agent 停止请求失败。', true);
      });
    }
  }

  private providerError(active: ActiveExecution, error: unknown): ReturnType<typeof appError> {
    if (active.signal.aborted) return appError('agent_cancelled', 'runtime', 'Agent 执行已取消。');
    if (active.responseStatus === 401 || active.responseStatus === 403) return appError('provider_auth_failed', 'provider', 'Provider 认证失败。');
    if (active.responseStatus === 429) return appError('provider_rate_limited', 'provider', 'Provider 请求受到限流。', true);
    if (!active.responseStarted) return appError('provider_network_error', 'provider', 'Provider 请求未建立响应。', true);
    if (error instanceof Error && error.name === 'AbortError') return appError('agent_cancelled', 'runtime', 'Agent 执行已取消。');
    return appError('provider_stream_interrupted', 'provider', 'Provider 响应流中断。', true);
  }

  private async execute(
    record: SessionRecord,
    nativeSessionId: string,
    input: AgentExecutionInput,
    signal: AbortSignal,
    observe: (event: NativeObservation) => void,
  ): Promise<AgentNativeOutcome> {
    const session = record.session;
    const model = record.model;
    if (!session || !model || !record.snapshot || !record.config || record.unusable) {
      return this.notStarted(nativeSessionId, appError('agent_session_unusable', 'session', 'Agent Session 不能继续执行。'));
    }
    if (record.running || !session.isIdle) return this.notStarted(nativeSessionId, appError('agent_session_busy', 'session', 'Agent Session 正在执行。'));
    if (!Number.isSafeInteger(input.runId) || input.runId <= 0 || !Number.isSafeInteger(input.sessionId) || input.sessionId <= 0) {
      return this.notStarted(nativeSessionId, appError('agent_execution_invalid', 'input', 'Agent Run 身份无效。'));
    }
    if (signal.aborted) return this.notStarted(nativeSessionId, appError('agent_cancelled', 'runtime', 'Agent 执行已取消。'), 'aborted');

    const active: ActiveExecution = {
      runId: input.runId, sessionId: input.sessionId, nativeSessionId, signal, observe,
      callSequence: 0, turnOrdinal: 0, attempts: 0, responseStatus: null,
      responseStarted: false, complete: false, wireMaxTokens: null,
      text: '', textBytes: 0, assistantContentBytes: 0, failure: null,
      promptEntered: true, streams: new Set(), abortPromise: null, stopReason: 'pending',
    };
    record.running = true;
    record.active = active;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'turn_start') active.turnOrdinal += 1;
      const name = event.type;
      if (name === 'agent_start' || name === 'agent_end' || name === 'agent_settled'
        || name === 'turn_start' || name === 'turn_end' || name === 'message_start'
        || name === 'message_update' || name === 'message_end'
        || name === 'tool_execution_start' || name === 'tool_execution_update' || name === 'tool_execution_end') {
        const message = 'message' in event ? event.message : undefined;
        const role = message?.role === 'user' || message?.role === 'assistant' || message?.role === 'toolResult' ? message.role : undefined;
        this.observe(active, 'agent_event', {
          eventName: name,
          ...(role ? { role } : {}),
          ...(message?.role === 'assistant' && message.stopReason ? { stopReason: message.stopReason } : {}),
          ...(name.startsWith('turn_') ? { turnOrdinal: active.turnOrdinal } : {}),
          ...(name === 'message_update' && event.assistantMessageEvent.type === 'text_delta'
            ? { textBytes: encoder.encode(event.assistantMessageEvent.delta).byteLength } : {}),
        });
      }
    });
    const onAbort = () => this.stop(record, active);
    signal.addEventListener('abort', onAbort, { once: true });
    let promptSettled = false;
    try {
      const prompt = session.prompt(input.text, { expandPromptTemplates: false });
      try { await prompt; } finally { promptSettled = true; }
      await Promise.all([...active.streams]);
      await active.abortPromise;
    } catch {
      active.failure ??= signal.aborted
        ? appError('agent_cancelled', 'runtime', 'Agent 执行已取消。')
        : appError('agent_execution_failed', 'runtime', 'Agent 执行失败。', true);
      active.stopReason = active.failure.code;
    } finally {
      signal.removeEventListener('abort', onAbort);
      try { unsubscribe(); } catch {
        active.failure ??= appError('agent_cleanup_failed', 'runtime', 'Agent 事件订阅清理失败。', true);
      }
    }

    const finalMessage = [...session.state.messages].reverse().find((message): message is AssistantMessage => message.role === 'assistant');
    if (finalMessage && active.textBytes === 0) {
      const bounded = appendUtf8('', textFrom(finalMessage), 0);
      active.text = bounded.text;
      active.textBytes = bounded.bytes;
    }
    if (!active.failure && (signal.aborted || finalMessage?.stopReason === 'aborted')) {
      active.failure = appError('agent_cancelled', 'runtime', 'Agent 执行已取消。');
    }
    if (!active.failure && finalMessage) {
      if (finalMessage.stopReason === 'length') active.failure = appError('agent_incomplete_response', 'runtime', 'Agent 回复因输出限制提前结束。');
      else if (finalMessage.stopReason === 'error') active.failure = this.providerError(active, new Error('provider_error'));
      else if (finalMessage.stopReason !== 'stop' || !active.text) active.failure = appError('agent_goal_not_met', 'runtime', 'Agent 未返回可用的发票摘要回答。');
    }
    if (!active.failure && !finalMessage) active.failure = appError('agent_goal_not_met', 'runtime', 'Agent 未返回最终回复。');

    const stopped = promptSettled && session.isIdle && active.streams.size === 0;
    if (!stopped) active.failure ??= appError('stop_unconfirmed', 'runtime', 'Agent 停止未确认。', true);
    if (active.promptEntered && active.failure) record.unusable = true;
    const messageForUsage = finalMessage ?? systemError(active.failure ?? appError('agent_execution_failed', 'runtime', 'Agent 执行失败。'), model);
    const usage = normalizeUsage(messageForUsage, { attempts: active.attempts, complete: active.complete && stopped }, record.config.connection === undefined);
    const end = now();
    this.observe(active, 'native_terminal', { stopReason: active.stopReason, responseId: finalMessage?.responseId ?? null, stopped });
    record.active = undefined;
    record.running = false;
    return {
      wireMaxTokens: active.wireMaxTokens,
      text: active.text,
      partial: active.textBytes > 0 && active.failure !== null,
      stopReason: active.stopReason === 'pending' ? finalMessage?.stopReason ?? 'error' : active.stopReason,
      responseId: finalMessage?.responseId ?? null,
      responseModel: finalMessage?.responseModel ?? finalMessage?.model ?? null,
      error: active.failure,
      usage: usage.usage,
      tokens: usage.tokens,
      stopped,
      cleanupErrors: active.failure?.code === 'agent_cleanup_failed' ? [active.failure] : stopped ? [] : [appError('stop_unconfirmed', 'runtime', 'Agent 停止未确认。', true)],
      agent: { nativeSessionId, turnCount: active.turnOrdinal, modelCallCount: active.callSequence },
    };
  }

  private notStarted(nativeSessionId: string, error: ReturnType<typeof appError>, stopReason = 'not_started'): AgentNativeOutcome {
    const at = new Date().toISOString();
    return {
      text: '', partial: false, stopReason, responseId: null, responseModel: null, error,
      usage: { version: 1, source: 'not-requested', reason: 'agent-not-started', sdkValues: null, attempts: 0, attemptsComplete: true, costSource: null, updatedAt: at },
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
      stopped: true, cleanupErrors: [],
      agent: { nativeSessionId, turnCount: 0, modelCallCount: 0 },
    };
  }

  public async releaseSession(nativeSessionId: string): Promise<CloseReport> {
    const record = this.sessions.get(nativeSessionId);
    if (!record) return { stopped: true, closed: true, errors: [] };
    if (record.preparing || record.running || (record.session && !record.session.isIdle)) {
      return { stopped: false, closed: false, errors: [appError('stop_unconfirmed', 'runtime', 'Agent Session 仍在执行。', true)] };
    }
    try { record.session?.dispose(); }
    catch { return { stopped: true, closed: false, errors: [appError('agent_cleanup_failed', 'runtime', 'Agent Session 清理失败。', true)] }; }
    this.sessions.delete(nativeSessionId);
    return { stopped: true, closed: true, errors: [] };
  }

  public async close(): Promise<CloseReport> {
    this.closed = true;
    const reports = await Promise.all([...this.sessions.keys()].map((id) => this.releaseSession(id)));
    return {
      stopped: reports.every((report) => report.stopped),
      closed: reports.every((report) => report.closed),
      errors: reports.flatMap((report) => report.errors),
    };
  }
}
