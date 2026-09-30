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
  type SessionEntry,
  type SessionHeader,
  type AgentSession,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { appError, fail, ok } from '@flowmate/contracts';
import type {
  AgentConfigFacts,
  AgentObservation,
  AgentToolBinding,
  AgentExecutionInput,
  AgentNativeOutcome,
  AgentPort,
  AgentPortAvailability,
  CloseReport,
  NativeObservation,
  NativeSessionHistory,
  PromptTraceBuffer,
  PromptTraceEntry,
  PromptTraceEvent,
  PromptTraceReference,
  PreparedAgent,
  Result,
  SafeConfigSnapshot,
  P3AgentConfigFacts,
  SdkUsageValues,
  TokenColumns,
  ToolDefinition,
  UsageRecordV1,
  UsageRecordV2,
  NativeHistoryAppendContext,
  NativeEntryLiveBinding,
  NativeMessageProjectionInput,
  SessionMessagesPage,
  SessionMessageView,
} from '@flowmate/contracts';
import type { ProviderConfig } from '@flowmate/contracts';
import { INVOICE_CHAT_SYSTEM_PROMPT, INVOICE_TOOLS_SYSTEM_PROMPT } from '@flowmate/contracts';
import { normalizeUsage, modelRuntimeSnapshot, prepareModelRuntime, safeUrl } from './model-runtime.ts';
import type { FetchLike, PiProviderDependencies } from './model-runtime.ts';
import { toPiTool } from './tools.ts';
import { formatExecutionPrompt, validateNativeHistory, validateModelMessages, projectSessionMessages, projectMessageView } from './messages.ts';

const maxContextBytes = 512 * 1024;
const maxOutputBytes = 256 * 1024;
const maxAssistantContentBytes = 512 * 1024;
const encoder = new TextEncoder();

type AgentStream = AgentSession['agent']['streamFunction'];
type AgentStreamArguments = Parameters<AgentStream>;
type StreamModel = AgentStreamArguments[0];
type StreamContext = AgentStreamArguments[1];
type StreamOptions = AgentStreamArguments[2];
type PiAgentEventListener = Parameters<AgentSession['agent']['subscribe']>[0];
type PiAgentEvent = Parameters<PiAgentEventListener>[0];
type PiAgentEventSignal = Parameters<PiAgentEventListener>[1];
type ModelCallUsage = { callSequence: number; usage: UsageRecordV1; tokens: TokenColumns; complete: boolean };
type ToolRequestState = { name: string; raw: unknown; invoked: boolean; terminal: boolean; messageObserved: boolean; messageObservedAt: string | null; requestObservedAtSequence: number | null };

type ActiveExecution = {
  input: AgentExecutionInput;
  nextLiveOrdinal: number;
  liveOrdinals: WeakMap<object, number>;
  assistantOrdinal?: number;
  runId: number;
  sessionId: number;
  nativeSessionId: string;
  signal: AbortSignal;
  observe: (event: AgentObservation) => void;
  p3: boolean;
  goalMode: 'answer' | 'save-candidate';
  toolBinding?: AgentToolBinding;
  toolRequests: Map<string, ToolRequestState>;
  modelCallUsages: ModelCallUsage[];
  attemptsAtCallStart: number;
  totalOutputBytes: number;
  finalAssistantMessage?: AssistantMessage;
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
  policy?: 'p2' | 'p3';
  preparing: boolean;
  running: boolean;
  unusable: boolean;
  historyWriter?: (history: NativeSessionHistory, context?: NativeHistoryAppendContext) => Result<void>;
  persistenceWatched?: boolean;
  lastSavedHistory?: NativeSessionHistory;
  liveBindings: Map<string, NativeEntryLiveBinding>;
  historyFailure?: ReturnType<typeof appError>;
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
    && previous!.credentialRef === next.credentialRef
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

function sumKnown(values: Array<number | null | undefined>): number | null {
  if (values.length === 0 || values.some((value) => value === null || value === undefined || !Number.isFinite(value))) return null;
  return values.reduce<number>((total, value) => total + Number(value), 0);
}

function sumDecimalStrings(values: Array<string | null>): string | null {
  if (!values.length || values.some((value) => value === null)) return null;
  let scale = 0;
  const parts = values.map((value) => {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value!);
    if (!match) return null;
    const fraction = match[3] ?? '';
    const exponent = Number(match[4] ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
    const decimalPlaces = fraction.length - exponent;
    const coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
    const adjusted = decimalPlaces < 0 ? coefficient * 10n ** BigInt(-decimalPlaces) : coefficient;
    scale = Math.max(scale, Math.max(0, decimalPlaces));
    return { adjusted, decimalPlaces: Math.max(0, decimalPlaces) };
  });
  if (parts.some((part) => part === null)) return null;
  let total = parts.reduce((sum, part) => sum + part!.adjusted * 10n ** BigInt(scale - part!.decimalPlaces), 0n);
  if (total === 0n) return '0';
  const negative = total < 0n;
  if (negative) total = -total;
  let digits = total.toString().padStart(scale + 1, '0');
  if (scale) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
  return `${negative ? '-' : ''}${digits}`;
}

function aggregateUsage(calls: ModelCallUsage[], attempts: number, complete: boolean, updatedAt: string): { usage: UsageRecordV2; tokens: TokenColumns } {
  const sdkFields: Array<keyof SdkUsageValues> = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens',
    'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'costTotal'];
  const sdkValues: SdkUsageValues | null = calls.length && calls.every((call) => call.usage.sdkValues !== null)
    ? Object.fromEntries(sdkFields.map((field) => [field, sumKnown(calls.map((call) => call.usage.sdkValues?.[field] ?? null))])) as SdkUsageValues
    : null;
  const source = calls.length > 0 && calls.every((call) => call.usage.source === 'sdk') ? 'sdk' : 'unknown';
  const inputTokens = sumKnown(calls.map((call) => call.tokens.inputTokens));
  const outputTokens = sumKnown(calls.map((call) => call.tokens.outputTokens));
  const totalTokens = sumKnown(calls.map((call) => call.tokens.totalTokens));
  const cost = sumDecimalStrings(calls.map((call) => call.tokens.cost));
  const usage: UsageRecordV2 = {
    version: 2,
    source,
    reason: source === 'sdk' ? null : calls.length ? 'one-or-more-model-call-usages-unknown' : 'no-model-call-usage-recorded',
    sdkValues,
    attempts: attempts > 0 ? attempts : null,
    attemptsComplete: complete && calls.length > 0 && calls.every((call) => call.complete),
    costSource: calls.length && calls.every((call) => call.usage.costSource !== null && call.usage.costSource === calls[0]?.usage.costSource)
      ? calls[0]!.usage.costSource : null,
    updatedAt,
    calls: calls.map(({ callSequence, usage: callUsage, tokens }) => ({ callSequence, usage: callUsage, tokens })),
  };
  return { usage, tokens: { inputTokens, outputTokens, totalTokens, cost,
    usageComplete: inputTokens !== null && outputTokens !== null && totalTokens !== null } };
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
  private readonly dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer; tools?: readonly ToolDefinition<any, any>[] };
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition<any, any>>;
  private closed = false;

  public constructor(dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer; tools?: readonly ToolDefinition<any, any>[] } = {}) {
    this.dependencies = dependencies;
    this.toolsByName = new Map((dependencies.tools ?? []).map((tool) => [tool.name, tool]));
  }

  public createSession(): Result<{ nativeSessionId: string }> {
    if (this.closed) return fail(appError('agent_port_closed', 'runtime', 'Agent Runtime 已关闭。'));
    const cwd = this.dependencies.cwd ?? process.cwd();
    const manager = SessionManager.inMemory(cwd);
    const nativeSessionId = manager.getSessionId();
    this.sessions.set(nativeSessionId, { manager, preparing: false, running: false, unusable: false, liveBindings: new Map() });
    return ok({ nativeSessionId });
  }

  public exportSession(nativeSessionId: string): Result<NativeSessionHistory> {
    try {
      const record = this.sessions.get(nativeSessionId);
      const header = record?.manager.getHeader();
      if (!record || !header || header.id !== nativeSessionId) {
        return fail(appError('session_history_invalid', 'session', 'Native conversation identity is unavailable.'));
      }
      const snapshot: NativeSessionHistory = { storageVersion: 1, header,
        entries: record.manager.getEntries() as unknown as NativeSessionHistory['entries'],
        leafId: record.manager.getLeafId(), unusable: record.unusable };
      const valid = validateNativeHistory(snapshot);
      return valid.ok ? ok(structuredClone(snapshot)) : valid;
    } catch { return fail(appError('session_history_invalid', 'session', 'Native conversation cannot be safely serialized.')); }
  }

  public restoreSession(nativeSessionId: string, history: NativeSessionHistory): Result<void> {
    if (this.closed || this.sessions.has(nativeSessionId)) return fail(appError('session_history_invalid', 'session', 'Conversation cannot be restored in this state.'));
    const cwd = this.dependencies.cwd ?? process.cwd();
    const valid = validateNativeHistory(history);
    if (!valid.ok || history.header.id !== nativeSessionId || history.header.cwd !== cwd || history.unusable) {
      return fail(appError('session_history_invalid', 'session', 'Saved conversation history is incompatible. Start a new chat.'));
    }
    try {
      const manager = SessionManager.inMemory(cwd, undefined,
        [history.header as SessionHeader, ...history.entries as unknown as SessionEntry[]]);
      if (history.leafId === null) manager.resetLeaf();
      else if (manager.getLeafId() !== history.leafId) manager.branch(history.leafId);
      if (manager.getSessionId() !== nativeSessionId || manager.getEntries().length !== history.entries.length) throw new Error('native_history_mismatch');
      manager.buildSessionContext();
      this.sessions.set(nativeSessionId, { manager, preparing: false, running: false, unusable: false,
        lastSavedHistory: structuredClone(history), liveBindings: new Map() });
      return ok(undefined);
    } catch { return fail(appError('session_history_invalid', 'session', 'Saved conversation history could not be restored.')); }
  }

  public watchSession(nativeSessionId: string, save: (history: NativeSessionHistory, context?: NativeHistoryAppendContext) => Result<void>): Result<void> {
    const record = this.sessions.get(nativeSessionId);
    if (!record || record.unusable) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    record.historyWriter = save;
    const initial = this.exportSession(nativeSessionId);
    if (initial.ok) record.lastSavedHistory ??= initial.data;
    if (record.persistenceWatched) return ok(undefined);
    record.persistenceWatched = true;
    const manager = record.manager;
    const original = manager._persist.bind(manager);
    manager._persist = (entry) => {
      original(entry);
      if (record.historyFailure) throw new Error('native_history_write_failed');
      const active = record.active;
      const ordinal = entry.type === 'message' && active ? active.liveOrdinals.get(entry.message) : undefined;
      const context = entry.type === 'message' && active && ordinal !== undefined
        ? { entryId: entry.id, runId: active.runId } : undefined;
      const snapshot = this.exportSession(nativeSessionId);
      let saved: Result<void>;
      try {
        saved = entry.type === 'message' && active && ordinal === undefined
          ? fail(appError('session_history_invalid', 'session', 'Native message has no actual live identity.'))
          : snapshot.ok ? record.historyWriter!(snapshot.data, context) : snapshot;
      }
      catch { saved = fail(appError('storage_write_failed', 'storage', 'Native conversation history could not be saved.', true)); }
      if (!saved.ok) {
        record.historyFailure = saved.error.code === 'session_history_invalid' ? saved.error
          : appError('storage_write_failed', 'storage', 'Native conversation history could not be saved.', true);
        record.unusable = true;
        if (active) {
          if (entry.type === 'message' && ordinal !== undefined) this.publishMessage(record, active, entry.message, ordinal, 'failed', 'ended');
          this.failToolRun(record, active, record.historyFailure);
        }
        throw new Error('native_history_write_failed');
      }
      if (snapshot.ok) record.lastSavedHistory = structuredClone(snapshot.data);
      if (active && entry.type === 'message' && ordinal !== undefined) {
        record.liveBindings.set(entry.id, { entryId: entry.id, runId: active.runId, liveOrdinal: ordinal });
        this.publishMessage(record, active, entry.message, ordinal, 'saved', 'ended', entry.id);
      }
    };
    return ok(undefined);
  }

  public projectSessionMessages(input: NativeMessageProjectionInput): Result<Pick<SessionMessagesPage, 'items' | 'nextBeforeEntryId'>> {
    const record = this.sessions.get(input.history.header.id);
    const runIds = new Set(input.runInputs.map((run) => run.runId));
    const bindings = new Map(input.bindings.map((binding) => [binding.entryId, binding.runId]));
    const entries = new Map(input.history.entries.filter((entry) => entry.type === 'message').map((entry) => [entry.id, entry]));
    const liveBindings = record && JSON.stringify(record.manager.getHeader()) === JSON.stringify(input.history.header)
      ? [...record.liveBindings.values()].filter((binding) =>
        entries.has(binding.entryId) && bindings.get(binding.entryId) === binding.runId && runIds.has(binding.runId)
        && JSON.stringify(record.manager.getEntry(binding.entryId)) === JSON.stringify(entries.get(binding.entryId))) : [];
    return projectSessionMessages({ ...input, liveBindings });
  }

  private publishMessage(record: SessionRecord, active: ActiveExecution, message: unknown, ordinal: number, persistence: SessionMessageView['persistence'],
    phase: SessionMessageView['phase'], entryId: string | null = null): void {
    const view = projectMessageView(message, { entryId, runId: active.runId, liveOrdinal: ordinal, persistence, phase,
      runInput: { runId: active.runId, input: {
        ...(active.input.workspaceInput ? { version: 2 as const, workspaceInput: active.input.workspaceInput } : { version: 1 as const }),
        goal: active.input.goal, text: active.input.text, messageTimestamp: active.input.messageTimestamp },
        goalMode: active.input.toolBinding ? active.goalMode : null } });
    if (view.ok) {
      try { active.observe({ type: 'display_message', message: structuredClone(view.data), ...now() }); } catch { /* display loss is repaired by querying native history */ }
    } else this.failToolRun(record, active, view.error);
  }

  public inspect(nativeSessionId: string) {
    const record = this.sessions.get(nativeSessionId);
    const availability: AgentPortAvailability = !record ? 'missing'
      : record.unusable ? 'unusable'
        : record.preparing || record.running ? 'busy' : 'ready';
    return { availability };
  }

  public async prepare(
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
    options?: { activeToolNames?: readonly string[] },
  ): Promise<Result<PreparedAgent>> {
    const record = this.sessions.get(nativeSessionId);
    if (this.closed) return fail(appError('agent_port_closed', 'runtime', 'Agent Runtime 已关闭。'));
    if (!record) return fail(appError('agent_session_missing', 'session', 'Agent Session 不存在。'));
    if (record.unusable) return fail(record.historyFailure ?? appError('agent_session_unusable', 'session', 'This session cannot continue after an interrupted run. Start a new session.'));
    if (record.preparing || record.running) return fail(appError('agent_session_busy', 'session', 'Agent Session 正在执行。'));
    if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));

    const policy = options ? 'p3' : 'p2';
    const activeToolNames = policy === 'p3' ? [...(options?.activeToolNames ?? [])] : [];
    if (new Set(activeToolNames).size !== activeToolNames.length
      || activeToolNames.some((name) => !this.toolsByName.has(name))) {
      return fail(appError('tool_runtime_unavailable', 'runtime', 'Run 获准的工具未在 Pi Runtime 注册。', true));
    }

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
      if (session && (runtime !== record.runtime || record.policy !== policy)) {
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
          resourceLoader: emptyResourceLoader(policy === 'p3' ? INVOICE_TOOLS_SYSTEM_PROMPT : INVOICE_CHAT_SYSTEM_PROMPT),
          ...(policy === 'p2' ? { noTools: 'all' as const, tools: [] } : {}),
          customTools: policy === 'p3' ? [...this.toolsByName.values()].map((definition) => toPiTool(
            definition,
            (toolCallId, input, toolSignal) => this.executePiTool(record, definition, toolCallId, input, toolSignal),
          )) : [],
          thinkingLevel: 'off',
        });
        session = created.session;
        session.agent.toolExecution = 'parallel';
        session.setActiveToolsByName(activeToolNames);
        session.agent.streamFunction = this.wrapStream(record, session, session.agent.streamFunction);
        const nativeConvert = session.agent.convertToLlm.bind(session.agent);
        session.agent.convertToLlm = async (messages) => {
          const allowed = this.verifyModelUse(record);
          const valid = this.validateMessages(record, messages);
          if (!allowed.ok || !valid.ok) {
            const error = !allowed.ok ? allowed.error : !valid.ok ? valid.error : appError('session_history_invalid', 'session', 'Invalid model messages.');
            if (record.active) this.failToolRun(record, record.active, error);
            throw new Error(error.code);
          }
          const converted = await nativeConvert(messages);
          const verified = this.validateMessages(record, converted);
          if (!verified.ok) {
            if (record.active) this.failToolRun(record, record.active, verified.error);
            throw new Error(verified.error.code);
          }
          return converted;
        };
        record.session = session;
        record.policy = policy;
      } else if (!sameModel(record.model, model)) {
        try {
          await session.setModel(model, { persist: false });
        } catch {
          return fail(record.historyFailure ?? appError('agent_model_switch_failed', 'session', '所选模型无法在此会话中使用。'));
        }
      }
      if (session) {
        session.agent.toolExecution = 'parallel';
        session.setActiveToolsByName(activeToolNames);
      }

      const snapshot = modelRuntimeSnapshot(config, limits, model, authSource);
      record.runtime = runtime;
      record.model = model;
      record.config = structuredClone(config);
      record.snapshot = snapshot;
      record.policy = policy;
      replacingSession = false;
      if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));
      const agent: AgentConfigFacts | P3AgentConfigFacts = policy === 'p3' ? {
        policyVersion: 'p3-invoice-tools-v1', nativeSessionId, systemPrompt: session.systemPrompt,
        thinkingLevel: session.thinkingLevel, resourcePolicy: 'none', historyPolicy: 'memory-only',
        maxContextBytes: 8_388_608, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 12,
        maxToolCalls: 24, toolTimeoutMs: 10_000, sessionRetry: false,
      } : {
        policyVersion: 'p2-invoice-chat-v1', nativeSessionId, systemPrompt: session.systemPrompt,
        thinkingLevel: session.thinkingLevel, resourcePolicy: 'none', historyPolicy: 'memory-only',
        maxContextBytes: 524_288, maxOutputBytes: 262_144, maxAssistantContentBytes: 524_288, maxModelCalls: 1, sessionRetry: false,
      };
      return ok({
        snapshot: { ...snapshot, agent },
        execute: (input, executionSignal, observe) => this.execute(record, nativeSessionId, input, executionSignal, observe),
      });
    } catch {
      // createAgentSession can append native model metadata before it throws; do not reuse an uncertain manager.
      if ((replacingSession || sessionCreationStarted) && !record.session) record.unusable = true;
      return fail(record.historyFailure ?? appError('agent_session_init_failed', 'session', 'Agent Session 初始化失败。', true));
    } finally {
      record.preparing = false;
    }
  }

  private wrapStream(record: SessionRecord, session: AgentSession, nativeStream: AgentStream): AgentStream {
    return (model, context, options) => {
      const active = record.active;
      if (!active) return errorStream(model, appError('agent_unbound_execution', 'runtime', 'Agent 请求缺少有效 Run 绑定。'));
      if (active.signal.aborted) return errorStream(model, appError('agent_cancelled', 'runtime', 'Agent 执行已取消。'), 'aborted');
      const allowed = this.verifyModelUse(record);
      const valid = this.validateMessages(record, context.messages);
      if (!allowed.ok || !valid.ok) {
        const error = !allowed.ok ? allowed.error : !valid.ok ? valid.error : appError('session_history_invalid', 'session', 'Invalid model messages.');
        active.failure ??= error;
        active.stopReason = error.code;
        this.stop(record, active);
        return errorStream(model, error);
      }
      const modelCallLimit = active.p3 ? 12 : 1;
      if (active.callSequence >= modelCallLimit) {
        this.stop(record, active);
        active.failure ??= appError(active.p3 ? 'agent_model_call_budget' : 'agent_unexpected_continuation', 'runtime',
          active.p3 ? 'Run 已达到模型调用次数上限。' : 'P2 Agent 请求次数超过限制。');
        active.stopReason = active.failure.code;
        return errorStream(model, active.failure);
      }

      const contextLimit = active.p3 ? 8_388_608 : maxContextBytes;
      let contextSize: number;
      try {
        contextSize = encoder.encode(JSON.stringify(context)).byteLength;
      } catch {
        contextSize = contextLimit + 1;
      }
      if (contextSize > contextLimit) {
        active.failure ??= appError('agent_context_limit', 'runtime', 'Agent 上下文超过本阶段限制。');
        active.stopReason = active.failure.code;
        this.stop(record, active);
        return errorStream(model, active.failure);
      }

      active.callSequence += 1;
      active.attemptsAtCallStart = active.attempts;
      active.responseStarted = false;
      active.complete = false;
      if (active.p3) {
        active.text = '';
        active.textBytes = 0;
      }
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

  private verifyModelUse(record: SessionRecord): Result<void> {
    const active = record.active;
    if (!active) return fail(appError('agent_unbound_execution', 'runtime', 'Agent 请求缺少有效 Run 绑定。'));
    if (record.historyFailure) return fail(record.historyFailure);
    if (record.unusable) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    if (active.failure) return fail(active.failure);
    if (active.signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 执行已取消。'));
    try { return active.input.verifyModelUse(); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Session 使用权限无法确认。', true, active.runId, active.sessionId)); }
  }

  private validateMessages(record: SessionRecord, messages: Parameters<typeof validateModelMessages>[0]): Result<void> {
    if (messages.some((message) => 'content' in message && Array.isArray(message.content)
      && message.content.some((block) => block && typeof block === 'object' && 'type' in block && block.type === 'image'))) {
      return fail(appError('agent_image_history_blocked', 'session', '当前 Session 历史包含图像内容，未向模型发送。请通过 New Session 新建会话后继续。',
        false, record.active?.runId, record.active?.sessionId));
    }
    return validateModelMessages(messages);
  }

  private failToolRun(record: SessionRecord, active: ActiveExecution, error: ReturnType<typeof appError>): void {
    active.failure ??= error;
    active.stopReason = active.failure.code;
    this.stop(record, active);
  }

  private observeAgentEvent(record: SessionRecord, active: ActiveExecution, event: PiAgentEvent, eventSignal?: PiAgentEventSignal): void {
    const binding = active.toolBinding;
    if (!active.p3 || !binding) return;
    const signal = eventSignal ?? active.signal;
    const ensureRequest = (name: string, raw: unknown, nativeToolCallId: string): ToolRequestState | null => {
      const prior = active.toolRequests.get(nativeToolCallId);
      if (prior) return prior;
      const observed = binding.observeRequest(name, raw, { nativeToolCallId, signal });
      if (!observed.ok) {
        this.failToolRun(record, active, observed.error);
        return null;
      }
      const state: ToolRequestState = { name, raw, invoked: false, terminal: false,
        messageObserved: false, messageObservedAt: null, requestObservedAtSequence: null };
      active.toolRequests.set(nativeToolCallId, state);
      return state;
    };
    const rejectUninvoked = (state: ToolRequestState, nativeToolCallId: string) => {
      if (state.invoked || state.terminal) return;
      const definition = this.toolsByName.get(state.name);
      const error = !definition
        ? appError('tool_not_found', 'tool', '此 Run 未注册请求的工具。', false, active.runId, active.sessionId, nativeToolCallId)
        : !binding.context.scope.allowedTools.includes(state.name)
          ? appError('tool_access_denied', 'runtime', '此 Run 未获准使用请求的工具。', false, active.runId, active.sessionId, nativeToolCallId)
          : appError('tool_invalid_input', 'tool', '工具参数不符合输入 Schema。', false, active.runId, active.sessionId, nativeToolCallId);
      const rejected = binding.rejectRequest(state.name, state.raw, { nativeToolCallId, signal }, error);
      if (!rejected.ok) this.failToolRun(record, active,
        appError('storage_write_failed', 'storage', '拒绝的 ToolCall 终态无法保存。', true, active.runId));
      state.terminal = true;
    };

    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const valid = projectMessageView(event.message, { entryId: null, runId: active.runId,
        liveOrdinal: null, persistence: 'pending', phase: 'ended' });
      if (!valid.ok) { this.failToolRun(record, active, valid.error); return; }
      const calls = event.message.content.filter((part): part is Extract<typeof part, { type: 'toolCall' }> => part.type === 'toolCall');
      for (const call of calls) ensureRequest(call.name, call.arguments, call.id);
      if (active.callSequence > 0) {
        const attemptCount = Math.max(0, active.attempts - active.attemptsAtCallStart);
        const normalized = normalizeUsage(event.message, {
          attempts: attemptCount,
          complete: active.complete && event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted',
        }, record.config?.connection === undefined);
        if (normalized.usage.version === 1) {
          const prior = active.modelCallUsages.findIndex((item) => item.callSequence === active.callSequence);
          const callUsage: ModelCallUsage = { callSequence: active.callSequence, usage: normalized.usage,
            tokens: normalized.tokens, complete: normalized.usage.attemptsComplete };
          if (prior < 0) active.modelCallUsages.push(callUsage);
          else active.modelCallUsages[prior] = callUsage;
        }
      }
      if (event.message.stopReason === 'stop' && calls.length === 0) active.finalAssistantMessage = event.message;
    }

    if (event.type === 'tool_execution_start') {
      ensureRequest(event.toolName, event.args, event.toolCallId);
    }

    if (event.type === 'tool_execution_end') {
      const state = active.toolRequests.get(event.toolCallId);
      if (state) rejectUninvoked(state, event.toolCallId);
    }

    if (event.type === 'message_end' && event.message.role === 'toolResult') {
      const state = active.toolRequests.get(event.message.toolCallId);
      if (state && !state.messageObserved && state.requestObservedAtSequence === null) {
        const observedAt = now().at;
        const saved = binding.recordDelivery(event.message.toolCallId, { version: 1, state: 'message_observed',
          messageObservedAt: observedAt, includedInCallSequence: null, requestDispatchedAt: null, error: null });
        if (!saved.ok) this.failToolRun(record, active,
          appError('storage_write_failed', 'storage', '工具结果观察事实无法保存。', true, active.runId));
        else {
          state.messageObserved = true;
          state.messageObservedAt = observedAt;
        }
      }
    }

    if (event.type === 'agent_end') {
      for (const [nativeToolCallId, state] of active.toolRequests) {
        rejectUninvoked(state, nativeToolCallId);
        if (state.invoked && !state.terminal) {
          this.failToolRun(record, active, appError('tool_execution_unconfirmed', 'runtime', '工具执行尚未完成。', true, active.runId));
        }
      }
    }
  }

  private async executePiTool(
    record: SessionRecord,
    definition: ToolDefinition<any, any>,
    nativeToolCallId: string,
    input: unknown,
    toolSignal?: AbortSignal,
  ) {
    const active = record.active;
    const binding = active?.toolBinding;
    if (!active || !active.p3 || !binding) throw new Error('工具调用缺少有效 Run 绑定。');
    const toolCall = Object.freeze({ nativeToolCallId, signal: toolSignal
      ? AbortSignal.any([active.signal, toolSignal]) : active.signal });
    let request = active.toolRequests.get(nativeToolCallId);
    if (!request) {
      const observed = binding.observeRequest(definition.name, input, toolCall);
      if (!observed.ok) {
        this.failToolRun(record, active, observed.error);
        throw new Error(observed.error.message);
      }
      request = { name: definition.name, raw: input, invoked: false, terminal: false, messageObserved: false, messageObservedAt: null, requestObservedAtSequence: null };
      active.toolRequests.set(nativeToolCallId, request);
    }
    request.invoked = true;
    if (active.failure || toolCall.signal.aborted) {
      const error = active.failure ?? appError('agent_cancelled', 'runtime', 'Run 已取消，工具未执行。');
      throw new Error(error.message);
    }

    let invocation;
    try {
      invocation = await binding.execute(definition.name, input, toolCall);
    } catch {
      const error = appError('tool_execution_failed', 'tool', '工具执行失败。');
      this.failToolRun(record, active, error);
      request.terminal = true;
      throw new Error(error.message);
    }
    const result = invocation.result;
    request.terminal = true;
    if (invocation.fatal) {
      const error = result.status === 'succeeded'
        ? appError('storage_write_failed', 'storage', '工具运行记录无法保存。', true)
        : result.error;
      this.failToolRun(record, active, error);
      throw new Error(error.message);
    }
    if (result.status !== 'succeeded') throw new Error(result.error.message);

    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }], details: result.data };
  }

  private observeOutgoingToolResults(record: SessionRecord, active: ActiveExecution, context: StreamContext): boolean {
    const binding = active.toolBinding;
    if (!active.p3 || !binding) return true;
    for (const message of context.messages) {
      if (message.role !== 'toolResult') continue;
      const request = active.toolRequests.get(message.toolCallId);
      if (!request || request.requestObservedAtSequence !== null) continue;
      if (!request.messageObserved) {
        const messageObservedAt = now().at;
        const messageObserved = binding.recordDelivery(message.toolCallId, { version: 1, state: 'message_observed',
          messageObservedAt, includedInCallSequence: null, requestDispatchedAt: null, error: null });
        if (!messageObserved.ok) {
          this.failToolRun(record, active,
            appError('storage_write_failed', 'storage', '工具结果观察事实无法保存。', true, active.runId));
          return false;
        }
        request.messageObserved = true;
        request.messageObservedAt = messageObservedAt;
      }
      const dispatchedAt = now().at;
      const observed = binding.recordDelivery(message.toolCallId, { version: 1, state: 'request_observed',
        messageObservedAt: request.messageObservedAt, includedInCallSequence: active.callSequence, requestDispatchedAt: dispatchedAt, error: null });
      if (!observed.ok) {
        this.failToolRun(record, active,
          appError('storage_write_failed', 'storage', '模型请求中的工具结果事实无法保存。', true, active.runId));
        return false;
      }
      request.requestObservedAtSequence = active.callSequence;
    }
    return true;
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
      const allowed = this.verifyModelUse(record);
      if (!allowed.ok) {
        this.failToolRun(record, active, allowed.error);
        throw new Error(allowed.error.code);
      }
      if (!this.observeOutgoingToolResults(record, active, context)) throw new Error('tool_result_delivery_failed');
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
          const deltaBytes = encoder.encode(event.delta).byteLength;
          if (active.p3 && active.totalOutputBytes + deltaBytes > maxOutputBytes) {
            failStream(appError('agent_output_limit', 'runtime', 'Run 的累计 Agent 输出超过本阶段限制。'));
            continue;
          }
          const previousText = active.text;
          const appended = appendUtf8(active.text, event.delta, active.textBytes);
          if (active.p3) active.totalOutputBytes += deltaBytes;
          const length = appended.text.length - active.text.length;
          active.text = appended.text;
          active.textBytes = appended.bytes;
          this.observe(active, 'text_delta', { length, textBytes: active.textBytes });
          const displayText = appended.text.slice(previousText.length);
          if (displayText) {
            try { active.observe({ type: 'display_text_delta', text: displayText, ...now() }); }
            catch { /* display observers cannot interrupt the native run */ }
          }
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
          if (!active.p3 && message.content.some((part) => part.type === 'toolCall')) {
            failStream(appError('agent_unexpected_tool_call', 'runtime', 'P2 Agent 收到未授权的工具调用。'));
            continue;
          }
        }
        if (event.type === 'error') {
          finalMessage = event.error;
          active.failure ??= event.error.stopReason === 'length'
            ? appError('agent_incomplete_response', 'runtime', 'Agent 回复因输出限制提前结束。')
            : this.providerError(active, event.error);
          active.stopReason = active.failure.code;
        }
        if (event.type === 'done') finalMessage = event.message;
        if (!outputEnded) output.push(event);
      }
      finalMessage ??= await stream.result();
      if (finalMessage) {
        try { active.assistantContentBytes = contentBytes(finalMessage); }
        catch { active.assistantContentBytes = maxAssistantContentBytes + 1; }
        if (active.assistantContentBytes > maxAssistantContentBytes) {
          failStream(appError('agent_content_limit', 'runtime', 'Agent 原生回复内容超过本阶段限制。'));
        } else if (!active.p3 && finalMessage.content.some((part) => part.type === 'toolCall')) {
          failStream(appError('agent_unexpected_tool_call', 'runtime', 'P2 Agent 收到未授权的工具调用。'));
        }
        const finalText = textFrom(finalMessage);
        const finalTextBytes = encoder.encode(finalText).byteLength;
        if (finalTextBytes > maxOutputBytes || active.p3 && active.totalOutputBytes + (active.textBytes === 0 ? finalTextBytes : 0) > maxOutputBytes) {
          active.text = appendUtf8('', finalText, 0).text;
          active.textBytes = maxOutputBytes;
          failStream(appError('agent_output_limit', 'runtime', 'Agent 回复超过本阶段限制。'));
        } else if (active.textBytes === 0 && finalTextBytes > 0) {
          active.text = finalText;
          active.textBytes = finalTextBytes;
          if (active.p3) active.totalOutputBytes += finalTextBytes;
        }
        if (active.p3 && finalMessage.stopReason === 'stop'
          && !finalMessage.content.some((part) => part.type === 'toolCall')) active.finalAssistantMessage = finalMessage;
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
    if (active.responseStatus !== null && active.responseStatus >= 400 && active.responseStatus < 500) {
      const raw = error instanceof Error ? error.message
        : typeof error === 'object' && error !== null && 'errorMessage' in error && typeof error.errorMessage === 'string'
          ? error.errorMessage : '';
      const detail = raw.replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').trim().slice(0, 300);
      return appError('provider_request_rejected', 'provider',
        `Provider 拒绝了 Agent 请求（HTTP ${active.responseStatus}）${detail ? `：${detail}` : '。'}`);
    }
    if (!active.responseStarted) return appError('provider_network_error', 'provider', 'Provider 请求未建立响应。', true);
    if (error instanceof Error && error.name === 'AbortError') return appError('agent_cancelled', 'runtime', 'Agent 执行已取消。');
    return appError('provider_stream_interrupted', 'provider', 'Provider 响应流中断。', true);
  }

  private async execute(
    record: SessionRecord,
    nativeSessionId: string,
    input: AgentExecutionInput,
    signal: AbortSignal,
    observe: (event: AgentObservation) => void,
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
      input, nextLiveOrdinal: 0, liveOrdinals: new WeakMap(),
      runId: input.runId, sessionId: input.sessionId, nativeSessionId, signal, observe,
      p3: input.toolBinding !== undefined,
      goalMode: input.goalMode ?? 'answer',
      ...(input.toolBinding ? { toolBinding: input.toolBinding } : {}),
      toolRequests: new Map(), modelCallUsages: [], attemptsAtCallStart: 0, totalOutputBytes: 0,
      callSequence: 0, turnOrdinal: 0, attempts: 0, responseStatus: null,
      responseStarted: false, complete: false, wireMaxTokens: null,
      text: '', textBytes: 0, assistantContentBytes: 0, failure: null,
      promptEntered: true, streams: new Set(), abortPromise: null, stopReason: 'pending',
    };
    record.running = true;
    record.active = active;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'turn_start') active.turnOrdinal += 1;
      if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
        const message = event.message;
        let ordinal = active.liveOrdinals.get(message);
        if (event.type === 'message_start') {
          ordinal = ++active.nextLiveOrdinal;
          if (message.role === 'assistant') active.assistantOrdinal = ordinal;
        } else if (ordinal === undefined && message.role === 'assistant') ordinal = active.assistantOrdinal;
        if (ordinal !== undefined) {
          active.liveOrdinals.set(message, ordinal);
          this.publishMessage(record, active, message, ordinal, 'pending',
            event.type !== 'message_end' && message.role === 'assistant' ? 'streaming' : 'ended');
        }
      }
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
    const unsubscribeAgent = session.agent.subscribe((event, eventSignal) => this.observeAgentEvent(record, active, event, eventSignal));
    const onAbort = () => this.stop(record, active);
    signal.addEventListener('abort', onAbort, { once: true });
    let promptSettled = false;
    try {
      const prompt = session.prompt(formatExecutionPrompt({ ...input, business: input.toolBinding !== undefined }), { expandPromptTemplates: false });
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
      try { unsubscribeAgent(); } catch {
        active.failure ??= appError('agent_cleanup_failed', 'runtime', 'Agent 工具事件清理失败。', true);
      }
    }

    try {
      const candidate = active.p3 ? active.finalAssistantMessage
        : [...session.state.messages].reverse().find((message): message is AssistantMessage =>
          message.role === 'assistant' && active.liveOrdinals.has(message));
      let finalMessage: AssistantMessage | undefined;
      if (candidate) {
        const valid = projectMessageView(candidate, { entryId: null, runId: active.runId,
          liveOrdinal: null, persistence: 'pending', phase: 'ended' });
        if (valid.ok) finalMessage = candidate;
        else { this.failToolRun(record, active, valid.error); await active.abortPromise; }
      }
      if (finalMessage && active.textBytes === 0) {
        const bounded = appendUtf8('', textFrom(finalMessage), 0);
        active.text = bounded.text;
        active.textBytes = bounded.bytes;
        if (active.p3) active.totalOutputBytes += bounded.bytes;
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
      if (record.historyFailure) active.failure = record.historyFailure;

      const stopped = promptSettled && session.isIdle && active.streams.size === 0;
      if (!stopped) active.failure ??= appError('stop_unconfirmed', 'runtime', 'Agent 停止未确认。', true);
      if (active.promptEntered && active.failure) record.unusable = true;
      if (record.historyWriter) {
        const hadHistoryFailure = record.historyFailure !== undefined;
        const snapshot = record.historyFailure && record.lastSavedHistory
          ? ok({ ...record.lastSavedHistory, unusable: true }) : this.exportSession(nativeSessionId);
        let saved: Result<void>;
        try { saved = snapshot.ok ? record.historyWriter(snapshot.data) : snapshot; }
        catch { saved = fail(appError('storage_write_failed', 'storage', 'Native conversation history could not be saved.', true)); }
        if (!saved.ok) {
          record.unusable = true;
          record.historyFailure = appError('storage_write_failed', 'storage', 'Native conversation history could not be saved.', true);
          active.failure = record.historyFailure;
          active.stopReason = record.historyFailure.code;
          this.stop(record, active);
          await active.abortPromise;
          if (!hadHistoryFailure && record.lastSavedHistory) {
            // A failed final flush may only mark the last confirmed prefix, never retry an uncertain tail.
            const blocked = { ...record.lastSavedHistory, unusable: true };
            try { if (record.historyWriter(blocked).ok) record.lastSavedHistory = blocked; } catch { /* Runtime's terminal/startup transaction also enforces the sticky block. */ }
          }
        }
      }
      const messageForUsage = finalMessage ?? systemError(active.failure ?? appError('agent_execution_failed', 'runtime', 'Agent 执行失败。'), model);
      const usage = active.p3
        ? aggregateUsage(active.modelCallUsages, active.attempts, active.complete && stopped, now().at)
        : normalizeUsage(messageForUsage, { attempts: active.attempts, complete: active.complete && stopped }, record.config.connection === undefined);
      const end = now();
      this.observe(active, 'native_terminal', { stopReason: active.stopReason, responseId: finalMessage?.responseId ?? null, stopped });
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
    } finally {
      record.active = undefined;
      record.running = false;
    }
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
