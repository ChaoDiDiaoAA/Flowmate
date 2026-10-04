import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  createAgentSession,
  sessionEntryToContextMessages,
  convertToLlm,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentToolResult,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { RUNTIME_CONFIG, appError, fail, ok, NativeInputContextBindingSchema, NativeToolResultContextBindingSchema, RequestContextBindingSchema, ContextSafeErrorCodeSchema } from '@flowmate/contracts';
import type {
  AgentConfigFacts,
  AgentObservation,
  AgentToolBinding,
  AgentExecutionInput,
  AgentNativeOutcome,
  AgentPort,
  AgentPortAvailability,
  AgentInputDispatch,
  CloseReport,
  NativeObservation,
  NativeSessionHistory,
  NativeContextBindingSeed,
  NativeHistoryRecoverySeed,
  HistoryCommitState,
  HistoryCommitReceipt,
  NativeHistoryWrite,
  NativeDerivedContextBinding,
  NativeInputContextBinding,
  NativeToolResultContextBinding,
  RequestContextBinding,
  ContextEvidenceUpdate,
  PromptTraceBuffer,
  PromptTraceEntry,
  PromptTraceEvent,
  PromptTraceReference,
  PreparedAgent,
  Result,
  P3AgentConfigFacts,
  P5ChatAgentConfigFacts,
  RuntimeAgentConfigFacts,
  SdkUsageValues,
  TokenColumns,
  ToolDefinition,
  UsageRecordV1,
  UsageRecordV2,
  NativeEntryLiveBinding,
  NativeMessageProjectionInput,
  SessionMessagesPage,
  SessionMessageView,
  GoalMode,
} from '@flowmate/contracts';
import type { ProviderConfig } from '@flowmate/contracts';
import { INVOICE_CHAT_SYSTEM_PROMPT, INVOICE_TOOLS_SYSTEM_PROMPT, INVOICE_FILL_FORM_SYSTEM_PROMPT, NativeToolOutputSchema, NATIVE_TOOL_NAMES } from '@flowmate/contracts';
import { normalizeUsage, modelRuntimeSnapshot, observedFetch, prepareModelRuntime, safeUrl } from './model-runtime.ts';
import type { FetchLike, PiProviderDependencies } from './model-runtime.ts';
import { toPiTool } from './tools.ts';
import { getNativeToolParameters } from './native-tools.ts';
import { projectSessionEvent } from './events.ts';
import { checkPayload, checkWire, preparePayloadCodec, sdkRequestId } from './context-evidence.ts';
import { formatExecutionPrompt, validateNativeHistory, validateModelMessages, projectSessionMessages, projectMessageView } from './messages.ts';

import { managerFor, validateRecovery, validateAgentContext, validateLlmMessages, referenceIds, inspectSessionHistory, buildForkSessionHistory } from './memory/history.ts';
import { PiMemoryAdapter } from './memory/persistence.ts';

const maxContextBytes = RUNTIME_CONFIG.llmPayload.maxChatContextBytes;
const maxOutputBytes = RUNTIME_CONFIG.llmPayload.maxOutputTextBytes;
const maxAssistantContentBytes = RUNTIME_CONFIG.llmPayload.maxAssistantContentBytes;
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
type ToolRequestState = { name: string; raw: unknown; sdkRaw: unknown; invoked: boolean; terminal: boolean; messageObserved: boolean; messageObservedAt: string | null; requestObservedAtSequence: number | null;
  requestBinding?: RequestContextBinding;
  failureStage?: 'sdk_arguments' | 'sdk_before' | 'unknown'; sdkBlocked?: boolean;
  feedback?: AgentToolResult<unknown>; feedbackIsError?: boolean };
type InputDispatchState = { inputId: number; text: string; promptText: string; contextSnapshotId?: number; started: boolean; message?: object };

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
  multiCall: boolean;
  admissionClosed: boolean;
  inputMessages: WeakMap<object, number>;
  inputs: Map<number, InputDispatchState>;
  openInputIds: Set<number>;
  resultBindings: WeakMap<object, { inputIds: number[]; entryId: string }>;
  dispatchSlot?: { inputId: number; captured: () => void; streaming: boolean };
  queueCleared: boolean;
  goalMode: GoalMode;
  nativeFailures: Set<string>;
  toolBinding?: AgentToolBinding;
  toolRequests: Map<string, ToolRequestState>;
  assistantBindings: WeakMap<object, RequestContextBinding>;
  modelCallUsages: ModelCallUsage[];
  modelCalls: NonNullable<AgentNativeOutcome['agent']['modelCalls']>;
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
  snapshot?: PreparedAgent['snapshot'];
  policy?: 'p2' | 'p3' | 'fill';
  workingDirectory?: string;
  sessionInputs?: boolean;
  dispatchTail?: Promise<void>;
  preparing: boolean;
  running: boolean;
  unusable: boolean;
  historyWriter?: (write: NativeHistoryWrite) => Result<HistoryCommitReceipt>;
  memory?: PiMemoryAdapter;
  recoverySeed?: NativeHistoryRecoverySeed;
  receipt?: HistoryCommitState;
  nativeObjects?: WeakMap<object, { entryId: string; original: unknown }>;
  convertedOrigins?: WeakMap<object, NativeDerivedContextBinding>;
  inheritedToolIds?: Set<string>;
  persistenceWatched?: boolean;
  lastSavedHistory?: NativeSessionHistory;
  liveBindings: Map<string, NativeEntryLiveBinding>;
  contextEntries: Map<string, NativeInputContextBinding>;
  contextMessages: WeakMap<object, NativeInputContextBinding>;
  contextSeeded: boolean;
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
  return isDeepStrictEqual(a, b);
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
  const usageComplete = calls.length > 0 && calls.every((call) => call.tokens.usageComplete)
    && inputTokens !== null && outputTokens !== null && totalTokens !== null;
  const usage: UsageRecordV2 = {
    version: 2,
    source,
    reason: source === 'sdk' ? usageComplete ? null : 'one-or-more-model-call-usages-incomplete'
      : calls.length ? 'one-or-more-model-call-usages-unknown' : 'no-model-call-usage-recorded',
    sdkValues,
    attempts: attempts > 0 ? attempts : null,
    attemptsComplete: complete && calls.length > 0 && calls.every((call) => call.complete),
    costSource: calls.length && calls.every((call) => call.usage.costSource !== null && call.usage.costSource === calls[0]?.usage.costSource)
      ? calls[0]!.usage.costSource : null,
    updatedAt,
    calls: calls.map(({ callSequence, usage: callUsage, tokens }) => ({ callSequence, usage: callUsage, tokens })),
  };
  return { usage, tokens: { inputTokens, outputTokens, totalTokens, cost,
    usageComplete } };
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
  private readonly dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer; tools?: readonly ToolDefinition<any, any>[];
    sessionSetup?: (session: AgentSession) => void };
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition<any, any>>;
  private closed = false;

  public constructor(dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer; tools?: readonly ToolDefinition<any, any>[];
    sessionSetup?: (session: AgentSession) => void } = {}) {
    this.dependencies = dependencies;
    this.toolsByName = new Map((dependencies.tools ?? []).map((tool) => [tool.name, tool]));
  }

  public createSession(): Result<{ nativeSessionId: string }> {
    if (this.closed) return fail(appError('agent_port_closed', 'runtime', 'Agent Runtime 已关闭。'));
    const cwd = this.dependencies.cwd ?? process.cwd();
    const manager = SessionManager.inMemory(cwd);
    const nativeSessionId = manager.getSessionId();
    this.sessions.set(nativeSessionId, { manager, preparing: false, running: false, unusable: false, liveBindings: new Map(),
      contextEntries: new Map(), contextMessages: new WeakMap(), contextSeeded: false });
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

  public restoreSession(nativeSessionId: string, history: NativeSessionHistory, seed: NativeHistoryRecoverySeed, commit: HistoryCommitState): Result<void> {
    if (this.closed || this.sessions.has(nativeSessionId)) return fail(appError('session_history_invalid', 'session', 'Conversation cannot be restored in this state.'));
    const cwd = this.dependencies.cwd ?? process.cwd();
    const valid = validateRecovery(history, seed, commit);
    if (!valid.ok || history.header.id !== nativeSessionId || history.header.cwd !== cwd || history.unusable) {
      return fail(appError('session_history_invalid', 'session', 'Saved conversation history is incompatible. Start a new chat.'));
    }
    try {
      const manager = managerFor(history);
      const record: SessionRecord = { manager, preparing: false, running: false, unusable: false,
        lastSavedHistory: structuredClone(history), liveBindings: new Map(), contextEntries: new Map(),
        contextMessages: new WeakMap(), contextSeeded: false };
      record.recoverySeed = structuredClone(seed); record.receipt = structuredClone(commit);
      const seeded = this.reseedContext(record, seed.inputs);
      if (!seeded.ok) return seeded;
      this.sessions.set(nativeSessionId, record);
      return ok(undefined);
    } catch { return fail(appError('session_history_invalid', 'session', 'Saved conversation history could not be restored.')); }
  }

  private reseedContext(record: SessionRecord, bindings?: readonly NativeContextBindingSeed[]): Result<void> {
    const entries = bindings === undefined ? new Map(record.contextEntries) : new Map<string, NativeInputContextBinding>();
    if (bindings !== undefined) {
      const inputs = new Map<number, string>();
      for (const value of bindings) {
        const parsed = NativeInputContextBindingSchema.safeParse(value);
        if (!parsed.success) return fail(appError('context_binding_unknown', 'runtime', 'Saved input provenance is unavailable.'));
        const source = parsed.data; const native = record.manager.getEntry(source.nativeEntryId);
        if (!native || native.type !== 'message' || native.message.role !== 'user')
          return fail(appError('context_binding_unknown', 'runtime', 'Saved input entry is unavailable.'));
        const previous = entries.get(source.nativeEntryId) ?? record.contextEntries.get(source.nativeEntryId);
        if (previous && !isDeepStrictEqual(previous, source))
          return fail(appError('context_binding_conflict', 'runtime', 'Saved input provenance conflicts with its entry.'));
        if (source.inputId !== null) {
          const previousEntry = inputs.get(source.inputId);
          if (previousEntry !== undefined && previousEntry !== source.nativeEntryId)
            return fail(appError('context_binding_conflict', 'runtime', 'Saved Input belongs to distinct entries.'));
          inputs.set(source.inputId, source.nativeEntryId);
        }
        entries.set(source.nativeEntryId, Object.freeze(structuredClone(source)));
      }
    }
    const messages = new WeakMap<object, NativeInputContextBinding>();
    const nativeObjects = new WeakMap<object, { entryId: string; original: unknown }>();
    const assembled: AgentSession['messages'] = [];
    for (const entry of record.manager.buildContextEntries()) {
      for (const message of sessionEntryToContextMessages(entry)) {
        assembled.push(message); nativeObjects.set(message, { entryId: entry.id, original: structuredClone(message) });
        if (message.role === 'user') {
          const source = entries.get(entry.id);
          if (source) messages.set(message, source);
          else if (bindings !== undefined || record.contextSeeded) return fail(appError('context_binding_unknown', 'runtime', 'Current input provenance is unavailable.'));
        }
      }
    }
    // Install this exact array: helper-created derived objects are never interchangeable.
    if (record.session) record.session.agent.state.messages = assembled;
    record.nativeObjects = nativeObjects;
    const origins = new Map(record.recoverySeed?.origins.map(o => [o.nativeEntryId, o]));
    record.inheritedToolIds = new Set(record.manager.getEntries().flatMap(entry => entry.type === 'message'
      && entry.message.role === 'assistant' && origins.get(entry.id)?.originSessionId !== undefined
      && origins.get(entry.id)!.originSessionId !== record.recoverySeed?.sessionId
      ? entry.message.content.flatMap(block => block.type === 'toolCall' ? [block.id] : []) : []));
    record.contextEntries = entries; record.contextMessages = messages;
    record.contextSeeded ||= bindings !== undefined;
    return ok(undefined);
  }

  public watchSession(nativeSessionId: string, commit: HistoryCommitState, seed: NativeHistoryRecoverySeed, save: (write: NativeHistoryWrite) => Result<HistoryCommitReceipt>): Result<void> {
    const record = this.sessions.get(nativeSessionId);
    if (!record || record.unusable) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    const initial = this.exportSession(nativeSessionId);
    if (!initial.ok || typeof save !== 'function' || !validateRecovery(initial.data, seed, commit).ok
      || record.recoverySeed && record.recoverySeed.sessionId !== seed.sessionId
      || record.receipt && !isDeepStrictEqual(record.receipt, commit)
      || record.recoverySeed && !isDeepStrictEqual(record.recoverySeed, seed)) return fail(appError('session_history_invalid', 'session', 'Saved history receipt or origins are inconsistent.'));
    record.historyWriter = save;
    record.memory = new PiMemoryAdapter(initial.data, commit, seed, save);
    record.lastSavedHistory = structuredClone(initial.data); record.receipt = structuredClone(commit); record.recoverySeed = structuredClone(seed);
    const reseeded = this.reseedContext(record, seed.inputs); if (!reseeded.ok) return reseeded;
    if (record.persistenceWatched) return ok(undefined);
    record.persistenceWatched = true;
    const manager = record.manager;
    const original = manager._persist.bind(manager);
    manager._persist = (entry) => {
      original(entry);
      if (record.historyFailure) throw new Error('native_history_write_failed');
      const active = record.active;
      const ordinal = entry.type === 'message' && active ? active.liveOrdinals.get(entry.message) : undefined;
      const inputId = entry.type === 'message' && active && entry.message.role === 'user'
        ? active.inputMessages.get(entry.message) : undefined;
      const acknowledged = record.memory!.lastSavedHistory.entries.find(saved => saved.id === entry.id);
      const resultInputIds = !acknowledged && entry.type === 'message' && active && active.input.inputId !== undefined
        && entry.message.role === 'assistant' && entry.message.stopReason === 'stop'
        && textFrom(entry.message).trim().length > 0
        && !entry.message.content.some(part => part.type === 'toolCall') && !active.failure
        ? [...active.openInputIds] : undefined;
      const context = !acknowledged && entry.type === 'message' && active && ordinal !== undefined
        ? { entryId: entry.id, runId: active.runId, ...(inputId === undefined ? {} : { inputId }),
          ...(resultInputIds?.length ? { resultInputIds } : {}) } : undefined;
      const snapshot = this.exportSession(nativeSessionId);
      let saved: Result<HistoryCommitReceipt>;
      let source: NativeInputContextBinding | undefined;
      if (!acknowledged && entry.type === 'message' && active && entry.message.role === 'user' && ordinal !== undefined) {
        const state = inputId === undefined ? undefined : active.inputs.get(inputId);
        source = { nativeEntryId: entry.id, originRunId: active.runId, inputId: inputId ?? null,
          snapshotId: state?.contextSnapshotId ?? null };
        const previous = record.contextEntries.get(entry.id);
        if (previous && !isDeepStrictEqual(previous, source)) {
          const error = appError('context_binding_conflict', 'runtime', 'Input entry provenance conflicts.');
          this.failToolRun(record, active, error); throw error;
        }
      }
      if (!acknowledged && entry.type === 'message' && entry.message.role === 'user' && !active)
        source = { nativeEntryId: entry.id, originRunId: null, inputId: null, snapshotId: null };
      // A repeat acknowledgement retains its original association. Only actual live identity
      // can assert an association again; idle confirmation must not invent a legacy owner.
      let confirmationError: ReturnType<typeof appError> | undefined;
      if (acknowledged && !isDeepStrictEqual(acknowledged, entry))
        confirmationError = appError('session_history_invalid', 'session', 'The confirmed native entry changed.');
      if (acknowledged && active && entry.type === 'message' && (ordinal !== undefined || inputId !== undefined)) {
        const origin = record.recoverySeed!.origins.find(value => value.nativeEntryId === entry.id);
        const originalInput = record.recoverySeed!.inputs.find(value => value.nativeEntryId === entry.id);
        const state = inputId === undefined ? undefined : active.inputs.get(inputId);
        if (origin?.originRunId !== active.runId || entry.message.role === 'user' && !isDeepStrictEqual(originalInput,
          { nativeEntryId: entry.id, originRunId: active.runId, inputId: inputId ?? null, snapshotId: state?.contextSnapshotId ?? null }))
          confirmationError = appError('context_binding_conflict', 'runtime', 'Confirmed entry provenance conflicts.');
      }
      try {
        saved = confirmationError ? fail(confirmationError)
          : snapshot.ok ? record.memory!.save(snapshot.data, context ? [context] : [], source ? [source] : []) : snapshot;
      }
      catch { saved = fail(appError('storage_write_failed', 'storage', 'Native conversation history could not be saved.', true)); }
      if (!saved.ok) {
        record.historyFailure = saved.error;
        record.unusable = true;
        if (active) {
          if (entry.type === 'message' && ordinal !== undefined) this.publishMessage(record, active, entry.message, ordinal, 'failed', 'ended');
          this.failToolRun(record, active, record.historyFailure);
        }
        throw new Error('native_history_write_failed');
      }
      record.lastSavedHistory = structuredClone(record.memory!.lastSavedHistory);
      record.receipt = structuredClone(record.memory!.commit); record.recoverySeed = structuredClone(record.memory!.seed);
      if (acknowledged) return;
      if (entry.type === 'message') record.nativeObjects?.set(entry.message, { entryId: entry.id, original: structuredClone(entry.message) });
      if (entry.type === 'custom_message' && record.session?.isIdle) {
        // Fixed 0.85.1 idle custom push precedes this append: its actual array tail is the source object.
        const actual = record.session.messages.at(-1);
        if (actual?.role === 'custom' && !record.nativeObjects?.has(actual) && actual.customType === entry.customType
          && actual.display === entry.display && isDeepStrictEqual(actual.content, entry.content) && isDeepStrictEqual(actual.details, entry.details))
          record.nativeObjects?.set(actual, { entryId: entry.id, original: structuredClone(actual) });
      }
      if (source && entry.type === 'message') {
        const frozen = Object.freeze(structuredClone(source));
        record.contextEntries.set(entry.id, frozen); record.contextMessages.set(entry.message, frozen);
      }
      if (active && inputId !== undefined) active.openInputIds.add(inputId);
      if (active && entry.type === 'message' && resultInputIds?.length) {
        active.resultBindings.set(entry.message, { inputIds: resultInputIds, entryId: entry.id });
        for (const completedId of resultInputIds) active.openInputIds.delete(completedId);
      }
      if (active && entry.type === 'message' && ordinal !== undefined) {
        record.liveBindings.set(entry.id, { entryId: entry.id, runId: active.runId, liveOrdinal: ordinal });
        this.publishMessage(record, active, entry.message, ordinal, 'saved', 'ended', entry.id);
      }
    };
    return ok(undefined);
  }

  public inspectSessionHistory = inspectSessionHistory;
  public buildForkSessionHistory = buildForkSessionHistory;

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
    const inputId = message && typeof message === 'object' ? active.inputMessages.get(message) : undefined;
    const productInput = inputId === undefined ? undefined : active.inputs.get(inputId);
    const view = projectMessageView(message, { entryId, runId: active.runId, liveOrdinal: ordinal, persistence, phase,
      ...(productInput ? { productInput: { text: productInput.text, promptText: productInput.promptText } } : { runInput: { runId: active.runId, input: {
        ...(active.input.workspaceInput ? { version: 2 as const, workspaceInput: active.input.workspaceInput } : { version: 1 as const }),
        goal: active.input.goal, text: active.input.text, messageTimestamp: active.input.messageTimestamp },
        goalMode: active.input.toolBinding ? active.goalMode : null,
        ...(active.input.workspaceContext ? { workspaceContext: active.input.workspaceContext } : {}),
        ...(active.input.workingDirectory ? { workingDirectory: active.input.workingDirectory } : {}) } }) });
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

  public async moveSessionLeaf(nativeSessionId: string, targetEntryId: string): Promise<Result<NativeSessionHistory>> {
    const record = this.sessions.get(nativeSessionId);
    if (!record || record.unusable || this.closed) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    if (record.preparing || record.running || record.session && !record.session.isIdle)
      return fail(appError('agent_session_busy', 'session', 'Conversation is busy.'));
    const snapshot = this.exportSession(nativeSessionId);
    if (!snapshot.ok) return snapshot;
    if (!record.recoverySeed) return fail(appError('context_binding_unknown', 'runtime', 'Saved conversation sources are unavailable.'));
    const inspected = inspectSessionHistory({ history: snapshot.data, seed: record.recoverySeed });
    if (!inspected.ok) return inspected;
    if (inspected.data.positions.find(position => position.entryId === targetEntryId)?.contextState !== 'complete')
      return fail(appError('session_branch_unavailable', 'session', 'Select a complete saved native context.'));
    record.preparing = true;
    try {
      record.manager.branch(targetEntryId);
      const seeded = this.reseedContext(record);
      if (!seeded.ok) return seeded;
      return this.exportSession(nativeSessionId);
    } catch { return fail(appError('session_history_invalid', 'session', 'Conversation position could not be confirmed.')); }
    finally { record.preparing = false; }
  }

  public restoreSessionLeaf(nativeSessionId: string, committed: NativeSessionHistory, seed: NativeHistoryRecoverySeed, commit: HistoryCommitState): Result<void> {
    const record = this.sessions.get(nativeSessionId);
    if (!record || record.unusable || this.closed) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    if (record.preparing || record.running || record.session && !record.session.isIdle)
      return fail(appError('agent_session_busy', 'session', 'Conversation is busy.'));
    try {
      const current = this.exportSession(nativeSessionId);
      if (!validateRecovery(committed, seed, commit).ok || record.recoverySeed && record.recoverySeed.sessionId !== seed.sessionId || !current.ok || committed.unusable
        || !isDeepStrictEqual(JSON.parse(JSON.stringify(current.data.header)), JSON.parse(JSON.stringify(committed.header)))
        || !isDeepStrictEqual(JSON.parse(JSON.stringify(current.data.entries)), JSON.parse(JSON.stringify(committed.entries))))
        throw new Error('branch_restore_mismatch');
      if (committed.leafId === null) record.manager.resetLeaf(); else record.manager.branch(committed.leafId);

      const restored = this.exportSession(nativeSessionId);
      if (!restored.ok || !isDeepStrictEqual(JSON.parse(JSON.stringify(restored.data)), JSON.parse(JSON.stringify(committed))))
        throw new Error('branch_restore_unconfirmed');
      record.recoverySeed = structuredClone(seed); record.receipt = structuredClone(commit);
      if (record.historyWriter) record.memory = new PiMemoryAdapter(committed, commit, seed, record.historyWriter);
      const seeded = this.reseedContext(record, seed.inputs);
      if (!seeded.ok) { record.unusable = true; return seeded; }
      record.lastSavedHistory = structuredClone(committed);
      return ok(undefined);
    } catch {
      record.unusable = true;
      return fail(appError('session_history_invalid', 'session', 'The last saved conversation position could not be restored.'));
    }
  }

  public async enqueueInput(nativeSessionId: string, input: AgentInputDispatch): Promise<Result<void>> {
    const record = this.sessions.get(nativeSessionId); const active = record?.active;
    if (!record || !active || active.input.inputId === undefined || !record.session)
      return fail(appError('input_admission_closed', 'runtime', 'The Run is no longer accepting inputs.'));
    if (input.runId !== active.runId || input.sessionId !== active.sessionId || !Number.isSafeInteger(input.inputId) || input.inputId <= 0
      || !['steer', 'followUp'].includes(input.mode) || typeof input.text !== 'string' || !input.text.trim()
      || encoder.encode(input.text).byteLength > 65_000 || typeof input.promptText !== 'string' || !input.promptText.trim())
      return fail(appError('input_invalid', 'input', 'Input does not belong to the active Run.'));
    if (active.goalMode === 'fill-form') return fail(appError('tool_access_denied', 'runtime', 'A form application Run cannot accept additional inputs.'));
    if ((active.input.contextHooks !== undefined) !== (input.contextSnapshotId !== undefined)
      || input.contextSnapshotId !== undefined && (!Number.isSafeInteger(input.contextSnapshotId) || input.contextSnapshotId <= 0))
      return fail(appError('context_binding_unknown', 'runtime', 'Input context association is unavailable.'));
    try {
      const dispatched = await this.dispatchInput(record, active, input, () => input.mode === 'steer'
        ? record.session!.steer(input.promptText) : record.session!.followUp(input.promptText), true);
      await dispatched.execution;
      return ok(undefined);
    } catch (error) {
      return fail(error && typeof error === 'object' && 'code' in error ? error as ReturnType<typeof appError>
        : active.failure ?? appError('agent_execution_failed', 'runtime', 'Input delivery could not be confirmed.', true));
    }
  }

  private closeInputAdmission(active: ActiveExecution): void {
    if (active.admissionClosed) return;
    active.admissionClosed = true;
    try { active.input.onInputAdmissionClosed?.(); }
    catch { active.failure ??= appError('agent_execution_failed', 'runtime', 'Input admission could not be closed.', true); }
  }

  private installInputCapture(record: SessionRecord, session: AgentSession): void {
    type Message = AgentSession['messages'][number];
    const capture = (messages: readonly Message[]) => {
      const active = record.active;
      if (!active || active.input.inputId === undefined) return;
      const slot = active.dispatchSlot; const users = messages.filter(message => message.role === 'user');
      const state = slot ? active.inputs.get(slot.inputId) : undefined;
      if (!slot || !state || users.length !== 1 || state.message) {
        const error = appError('session_history_invalid', 'session', 'Native input has no unique product identity.');
        this.failToolRun(record, active, error); throw error;
      }
      if (active.admissionClosed || active.signal.aborted || slot.streaming && !session.isStreaming)
        throw appError('input_admission_closed', 'runtime', 'The Run is no longer accepting inputs.');
      const allowed = active.input.verifyInputUse?.(slot.inputId) ?? fail(appError('tool_access_denied', 'runtime', 'Input authorization is unavailable.'));
      if (!allowed.ok || active.signal.aborted) {
        const error = !allowed.ok ? allowed.error : appError('agent_cancelled', 'runtime', 'Agent execution was cancelled.');
        this.failToolRun(record, active, error); throw error;
      }
      state.message = users[0]!;
      active.inputMessages.set(users[0]!, slot.inputId);
      slot.captured();
    };
    const prompt = session.agent.prompt.bind(session.agent);
    session.agent.prompt = (value: Message | Message[] | string, images?: Parameters<AgentSession['steer']>[1]) => {
      if (typeof value === 'string') {
        if (record.active?.input.inputId !== undefined) capture([]);
        return prompt(value, images);
      }
      capture(Array.isArray(value) ? value : [value]);
      return prompt(value);
    };
    const steer = session.agent.steer.bind(session.agent);
    const followUp = session.agent.followUp.bind(session.agent);
    session.agent.steer = message => { capture([message]); steer(message); };
    session.agent.followUp = message => { capture([message]); followUp(message); };
  }

  private dispatchInput(record: SessionRecord, active: ActiveExecution, input: Pick<AgentInputDispatch, 'inputId' | 'text' | 'promptText' | 'contextSnapshotId'>,
    invoke: () => Promise<void>, streaming: boolean): Promise<{ execution: Promise<void> }> {
    const dispatched = (record.dispatchTail ?? Promise.resolve()).then(async () => {
      if (record.active !== active || active.admissionClosed || active.signal.aborted || active.failure
        || streaming && !record.session?.isStreaming)
        throw appError('input_admission_closed', 'runtime', 'The Run is no longer accepting inputs.');
      if (active.inputs.has(input.inputId)) throw appError('state_conflict', 'input', 'This input has already been dispatched.');
      const allowed = active.input.verifyInputUse?.(input.inputId) ?? fail(appError('tool_access_denied', 'runtime', 'Input authorization is unavailable.'));
      if (!allowed.ok) throw allowed.error;
      const state: InputDispatchState = { ...input, started: false };
      active.inputs.set(input.inputId, state);
      let captured!: () => void;
      const capture = new Promise<void>(resolve => { captured = resolve; });
      active.dispatchSlot = { inputId: input.inputId, captured, streaming };
      try {
        const execution = invoke();
        await Promise.race([capture, execution.then(() => { if (!state.message) throw appError('session_history_invalid', 'session', 'Native input was not captured.'); })]);
        return { execution };
      } finally { delete active.dispatchSlot; }
    });
    record.dispatchTail = dispatched.then(() => {}, () => {});
    return dispatched;
  }

  public async prepare(
    nativeSessionId: string,
    config: ProviderConfig,
    limits: { timeoutMs: number; stopGraceMs: number },
    signal: AbortSignal,
    options?: Parameters<AgentPort['prepare']>[4],
  ): Promise<Result<PreparedAgent>> {
    const record = this.sessions.get(nativeSessionId);
    if (this.closed) return fail(appError('agent_port_closed', 'runtime', 'Agent Runtime 已关闭。'));
    if (!record) return fail(appError('agent_session_missing', 'session', 'Agent Session 不存在。'));
    if (record.unusable) return fail(record.historyFailure ?? appError('agent_session_unusable', 'session', 'This session cannot continue after an interrupted run. Start a new session.'));
    if (record.preparing || record.running) return fail(appError('agent_session_busy', 'session', 'Agent Session 正在执行。'));
    if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));

    if (options?.goalMode !== undefined && !['answer', 'save-candidate', 'fill-form'].includes(options.goalMode))
      return fail(appError('input_invalid', 'input', 'The goal mode is invalid.'));
    const policy = options?.goalMode === 'fill-form' ? 'fill' : options?.activeToolNames !== undefined
      || options?.workingDirectory !== undefined || options?.goalMode !== undefined ? 'p3' : 'p2';
    const cwd = options?.workingDirectory ?? this.dependencies.cwd ?? process.cwd();
    if (options?.workingDirectory) {
      if (!isAbsolute(cwd) || !cwd.trim() || /[\u0000-\u001f\u007f]/.test(cwd))
        return fail(appError('input_invalid', 'input', 'The working directory must be an absolute local path.'));
    }
    const activeToolNames = policy !== 'p2' ? [...(options?.activeToolNames ?? [])] : [];
    if (policy === 'fill' ? activeToolNames.length !== 1 || activeToolNames[0] !== 'fill_invoice_form'
      || options?.workingDirectory !== undefined : activeToolNames.includes('fill_invoice_form')) {
      return fail(appError('tool_access_denied', 'runtime', 'Form application is available only in a dedicated fill Run.'));
    }
    if (new Set(activeToolNames).size !== activeToolNames.length
      || activeToolNames.some((name) => !this.toolsByName.has(name))) {
      return fail(appError('tool_runtime_unavailable', 'runtime', 'Run 获准的工具未在 Pi Runtime 注册。', true));
    }

    const previousSettings = record.manager.buildSessionContext();
    const prepareStartCount = record.manager.getEntries().length;
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
      if (session && (runtime !== record.runtime || record.policy !== policy || record.workingDirectory !== cwd)) {
        session.dispose();
        record.session = undefined;
        session = undefined;
        replacingSession = true;
      }
      if (!session) {
        sessionCreationStarted = true;
        const created = await createAgentSession({
          cwd,
          agentDir: this.dependencies.agentDir ?? cwd,
          modelRuntime: runtime,
          model,
          sessionManager: record.manager,
          settingsManager: inMemorySettings(),
          resourceLoader: emptyResourceLoader(policy === 'fill' ? INVOICE_FILL_FORM_SYSTEM_PROMPT
            : policy === 'p3' ? INVOICE_TOOLS_SYSTEM_PROMPT : INVOICE_CHAT_SYSTEM_PROMPT),
          noTools: 'all', tools: policy === 'p2' ? [] : [...this.toolsByName.keys()],
          customTools: policy !== 'p2' ? [...this.toolsByName.values()].map((definition) => toPiTool(
            definition,
            (toolCallId, input, toolSignal) => this.executePiTool(record, definition, toolCallId, input, toolSignal),
            raw => {
              const requests = [...record.active?.toolRequests.values() ?? []].filter(call => call.name === definition.name && call.sdkRaw === raw && !call.invoked);
              if (requests.length === 1) requests[0]!.failureStage = 'sdk_arguments';
            },
          )) : [],
          thinkingLevel: 'off',
        });
        session = created.session;
        const installed = session.getAllTools().map(tool => tool.name);
        const expected = policy === 'p2' ? [] : [...this.toolsByName.keys()];
        if (installed.length !== expected.length || new Set(installed).size !== installed.length
          || expected.some(name => !installed.includes(name))) {
          session.dispose();
          throw new Error('Controlled tool registry mismatch.');
        }
        this.dependencies.sessionSetup?.(session);
        const beforeToolCall = session.agent.beforeToolCall;
        session.agent.beforeToolCall = async (context, hookSignal) => {
          const toolCall = context.toolCall;
          const inherited = this.guardInheritedTool(record, toolCall.id);
          if (!inherited.ok) return { block: true, reason: inherited.error.message };
          const original = structuredClone(toolCall);
          const request = record.active?.toolRequests.get(context.toolCall.id);
          if (request) request.failureStage = 'sdk_before';
          let result;
          let changed = false;
          try { result = await beforeToolCall?.(context, hookSignal); }
          finally {
            changed = context.toolCall !== toolCall || !isDeepStrictEqual(toolCall, original);
            if (changed) {
              // The SDK retains this raw block for execution, result identity, and history.
              for (const key of Object.keys(toolCall)) Reflect.deleteProperty(toolCall, key);
              Object.assign(toolCall, original);
              if (request) request.sdkRaw = toolCall.arguments;
            }
          }
          if (changed) result = { block: true, reason: 'The SDK before hook changed the original tool request.' };
          if (request && result?.block) request.sdkBlocked = true;
          return result;
        };
        const afterToolCall = session.agent.afterToolCall;
        session.agent.afterToolCall = async (context, hookSignal) => {
          const active = record.active;
          try {
            const request = active?.toolRequests.get(context.toolCall.id);
            const feedback = structuredClone(request?.feedback ?? context.result);
            const result = await afterToolCall?.(context, hookSignal);
            if (!active) return result;
            const saved = active.toolBinding?.queryCall?.(context.toolCall.id);
            if (saved && (!saved.ok || saved.data.result === null)) {
              return this.rejectPiFeedback(record, active, context.toolCall.id,
                appError('storage_read_failed', 'storage', 'The saved tool outcome could not be verified.', true));
            }
            const expectedError = saved?.ok ? saved.data.result!.status !== 'succeeded'
              : request?.feedbackIsError ?? context.isError;
            const content = result?.content ?? context.result.content;
            const details = result?.details ?? context.result.details;
            const nativeFailure = active.nativeFailures.has(context.toolCall.id);
            const isError = result?.isError ?? (nativeFailure ? true : context.isError);
            if (isError !== expectedError || !isDeepStrictEqual(content, feedback.content)
              || !isDeepStrictEqual(details, feedback.details)) {
              return this.rejectPiFeedback(record, active, context.toolCall.id,
                appError('tool_feedback_conflict', 'runtime', 'The SDK feedback differs from the saved tool outcome.'));
            }
            if (active.nativeFailures.delete(context.toolCall.id)) return { ...result, isError: true };
            return result;
          } catch {
            if (!active) throw new Error('The SDK after hook failed.');
            return this.rejectPiFeedback(record, active, context.toolCall.id,
              appError('tool_sdk_after_failed', 'runtime', 'The SDK after hook failed.'));
          }
        };
        session.agent.toolExecution = 'parallel';
        // The controlled resourcePolicy=none has no context handlers. Pi's empty
        // ExtensionRunner still clones messages; preserve the saved native identities.
        session.agent.transformContext = async messages => messages;
        session.setActiveToolsByName(activeToolNames);
        session.agent.streamFunction = this.wrapStream(record, session, session.agent.streamFunction);
        this.installInputCapture(record, session);
        const nativeConvert = session.agent.convertToLlm.bind(session.agent);
        session.agent.convertToLlm = async (messages) => {
          const rejectConversion = (error: ReturnType<typeof appError>): never => {
            if (record.active) this.failToolRun(record, record.active, error); throw error;
          };
          const allowed = this.verifyModelUse(record);
          const valid = this.validateMessages(record, messages, true);
          if (!allowed.ok || !valid.ok) {
            const error = !allowed.ok ? allowed.error : !valid.ok ? valid.error : appError('session_history_invalid', 'session', 'Invalid model messages.');
            if (record.active) this.failToolRun(record, record.active, error);
            throw new Error(error.code);
          }
          const nativeProof = messages.map(message => record.nativeObjects?.get(message));
          for (let index = 0; index < messages.length; index++) {
            const message = messages[index]!;
            if ((record.contextSeeded || ['bashExecution', 'custom', 'branchSummary', 'compactionSummary'].includes(message.role))
              && (!nativeProof[index] || !isDeepStrictEqual(message, nativeProof[index]!.original)))
              rejectConversion(appError('context_binding_unknown', 'runtime', 'Native context object provenance is unavailable.'));
          }
          const converted = await nativeConvert(messages);
          const structure = validateLlmMessages(converted); if (!structure.ok) rejectConversion(structure.error);
          // The fixed converter drops only excluded bash. Compare every actual output against its single source conversion.
          const derived = new WeakMap<object, NativeDerivedContextBinding>();
          let outputIndex = 0;
          for (let inputIndex = 0; inputIndex < messages.length; inputIndex++) {
            const message = messages[inputIndex]!, expected = convertToLlm([message]);
            if (expected.length === 0) continue;
            const output = converted[outputIndex++];
            if (!output || !isDeepStrictEqual(output, expected[0])
              || ['user', 'assistant', 'toolResult'].includes(message.role) && output !== message)
              rejectConversion(appError('context_binding_unknown', 'runtime', 'Converted context no longer preserves its source.'));
            if (!['user', 'assistant', 'toolResult'].includes(message.role)) {
              const proof = nativeProof[inputIndex], entry = proof && record.manager.getEntry(proof.entryId);
              const origin = record.recoverySeed?.origins.find(o => o.nativeEntryId === proof?.entryId);
              if (!entry || !origin || !['message', 'custom_message', 'branch_summary', 'compaction'].includes(entry.type))
                return rejectConversion(appError('context_binding_unknown', 'runtime', 'Native context origin is unavailable.'));
              derived.set(output, { nativeEntryId: entry.id, originSessionId: origin.originSessionId,
                entryType: entry.type as NativeDerivedContextBinding['entryType'], messageRole: message.role as NativeDerivedContextBinding['messageRole'],
                contextMessageIndex: inputIndex, referenceEntryIds: referenceIds(entry) });
            }
          }
          if (outputIndex !== converted.length) rejectConversion(appError('context_binding_unknown', 'runtime', 'Converted context contains unproven messages.'));
          record.convertedOrigins = derived;
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
        const appended = record.manager.getEntries().slice(prepareStartCount);
        const effectiveModel = session.model;
        if (effectiveModel && (previousSettings.model?.provider !== effectiveModel.provider || previousSettings.model?.modelId !== effectiveModel.id)
          && !appended.some(e => e.type === 'model_change' && e.provider === effectiveModel.provider && e.modelId === effectiveModel.id))
          record.manager.appendModelChange(effectiveModel.provider, effectiveModel.id);
        if (previousSettings.thinkingLevel !== session.thinkingLevel
          && !record.manager.getEntries().slice(prepareStartCount).some(e => e.type === 'thinking_level_change' && e.thinkingLevel === session.thinkingLevel))
          record.manager.appendThinkingLevelChange(session.thinkingLevel);
        if (record.historyFailure) return fail(record.historyFailure);
      }
      if (session) {
        const seeded = this.reseedContext(record);
        if (!seeded.ok) return seeded;
        session.agent.toolExecution = 'parallel';
        session.setActiveToolsByName(activeToolNames);
        session.setSteeringMode('one-at-a-time');
        session.setFollowUpMode('one-at-a-time');
      }

      const snapshot = modelRuntimeSnapshot(config, limits, model, authSource);
      record.runtime = runtime;
      record.model = model;
      record.config = structuredClone(config);
      record.policy = policy;
      record.workingDirectory = cwd;
      record.sessionInputs = options?.sessionInputs === true;
      replacingSession = false;
      if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));
      const taskAgent: AgentConfigFacts | P3AgentConfigFacts | P5ChatAgentConfigFacts = policy !== 'p2' ? {
        policyVersion: 'p3-invoice-tools-v1', nativeSessionId, systemPrompt: session.systemPrompt,
        thinkingLevel: session.thinkingLevel, resourcePolicy: 'none', historyPolicy: 'memory-only',
        maxContextBytes: RUNTIME_CONFIG.llmPayload.maxWorkspaceContextBytes, maxOutputBytes, maxAssistantContentBytes,
        maxModelCalls: RUNTIME_CONFIG.runBudget.maxModelCalls.workspace,
        maxToolCalls: RUNTIME_CONFIG.runBudget.maxToolCalls, toolTimeoutMs: RUNTIME_CONFIG.runBudget.toolTimeoutMs, sessionRetry: false,
      } : {
        ...(record.sessionInputs ? { policyVersion: 'p5-session-inputs-v1' as const, maxModelCalls: RUNTIME_CONFIG.runBudget.maxModelCalls.chat }
          : { policyVersion: 'p2-invoice-chat-v1' as const, maxModelCalls: 1 as const }), nativeSessionId, systemPrompt: session.systemPrompt,
        thinkingLevel: session.thinkingLevel, resourcePolicy: 'none', historyPolicy: 'memory-only',
        maxContextBytes, maxOutputBytes, maxAssistantContentBytes, sessionRetry: false,
      };
      const agent: AgentConfigFacts | P3AgentConfigFacts | P5ChatAgentConfigFacts | RuntimeAgentConfigFacts = options?.runtimeBudget
        ? { ...taskAgent, ...options.runtimeBudget, policyVersion: 'runtime-v1', taskPolicyVersion: taskAgent.policyVersion } : taskAgent;
      record.snapshot = { ...snapshot, historyPolicyVersion: 'p9-native-history-v1', ...(options?.runtimeBudget ? { version: 2 as const } : {}), agent };
      return ok({
        snapshot: record.snapshot,
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
      const modelCallLimit = record.snapshot?.agent.maxModelCalls ?? 1;
      if (active.callSequence >= modelCallLimit) {
        this.stop(record, active);
        active.failure ??= appError(active.multiCall ? 'agent_model_call_budget' : 'agent_unexpected_continuation', 'runtime',
          active.multiCall ? 'Run 已达到模型调用次数上限。' : 'P2 Agent 请求次数超过限制。');
        active.stopReason = active.failure.code;
        return errorStream(model, active.failure);
      }

      const remainingMs = active.input.remainingRunMs?.();
      if (remainingMs !== undefined && remainingMs <= 0) {
        const error = appError('agent_timeout', 'runtime', 'The Run deadline has elapsed.');
        this.failToolRun(record, active, error);
        return errorStream(model, error);
      }
      // Awareness is a request-local copy; native history and the saved system prompt remain authoritative.
      const requestContext = this.withRuntimeAwareness(active, context, modelCallLimit, remainingMs);
      const contextLimit = active.p3 ? RUNTIME_CONFIG.llmPayload.maxWorkspaceContextBytes : maxContextBytes;
      let contextSize: number;
      try {
        contextSize = encoder.encode(JSON.stringify(requestContext)).byteLength;
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
      let requestBinding: RequestContextBinding | undefined;
      if (active.input.contextHooks) {
        const binding = this.bindContext(record, active, context, model);
        if (!binding.ok) { this.failToolRun(record, active, binding.error); return errorStream(model, binding.error); }
        requestBinding = binding.data;
      }
      active.attemptsAtCallStart = active.attempts;
      active.responseStarted = false;
      active.complete = false;
      if (active.multiCall) {
        active.text = '';
        active.textBytes = 0;
      }
      this.observe(active, 'model_request', {
        callSequence: active.callSequence,
        model: model.id,
        messageCount: requestContext.messages.length,
        toolCount: requestContext.tools?.length ?? 0,
        contextBytes: contextSize,
      });
      const output = createAssistantMessageEventStream();
      const worker = this.forwardStream(record, session, active, nativeStream, model, requestContext, options, output, requestBinding);
      active.streams.add(worker);
      void worker.then(() => active.streams.delete(worker), () => active.streams.delete(worker));
      return output;
    };
  }

  private bindContext(record: SessionRecord, active: ActiveExecution, context: StreamContext, model: StreamModel): Result<RequestContextBinding> {
    const hooks = active.input.contextHooks!;
    const includedBindings: NativeInputContextBinding[] = [];
    const includedToolResults: NativeToolResultContextBinding[] = [];
    const includedNativeContexts: NativeDerivedContextBinding[] = [];
    try {
      for (const message of context.messages) {
        if (message.role === 'user') {
          const native = record.convertedOrigins?.get(message);
          if (native) { includedNativeContexts.push(native); } else {
          const source = record.contextMessages.get(message);
          if (!source) return fail(appError('context_binding_unknown', 'runtime', 'Actual input provenance is unavailable.'));
          includedBindings.push(source);
          }
        } else if (message.role === 'toolResult') {
          const source = hooks.resolveToolResult({ sessionId: active.sessionId, nativeToolCallId: message.toolCallId });
          if (!source.ok) return source;
          const parsed = NativeToolResultContextBindingSchema.safeParse(source.data);
          if (!parsed.success || parsed.data.nativeToolCallId !== message.toolCallId)
            return fail(appError('context_binding_unknown', 'runtime', 'Actual tool result provenance is unavailable.'));
          includedToolResults.push(parsed.data);
        }
        if (includedBindings.length + includedToolResults.length + includedNativeContexts.length > 512)
          return fail(appError('context_evidence_too_large', 'runtime', 'Request provenance exceeds its budget.'));
      }
      const primary = [...includedBindings].reverse().find(source => source.originRunId === active.runId && source.snapshotId !== null);
      if (!primary || primary.inputId === null)
        return fail(appError('context_binding_unknown', 'runtime', 'The current request has no saved input context.'));
      const parsed = RequestContextBindingSchema.safeParse({ runId: active.runId, sessionId: active.sessionId,
        nativeSessionId: active.nativeSessionId, requestSequence: active.callSequence, callSequence: active.callSequence,
        inputId: primary.inputId, snapshotId: primary.snapshotId, includedBindings, includedToolResults, includedNativeContexts });
      if (!parsed.success) return fail(appError('context_binding_unknown', 'runtime', 'Request provenance is inconsistent.'));
      const binding = structuredClone(parsed.data);
      for (const source of binding.includedBindings) Object.freeze(source);
      for (const source of binding.includedToolResults) { if (source.context) Object.freeze(source.context); Object.freeze(source); }
      for (const source of binding.includedNativeContexts) { Object.freeze(source.referenceEntryIds); Object.freeze(source); }
      Object.freeze(binding.includedNativeContexts); Object.freeze(binding.includedBindings); Object.freeze(binding.includedToolResults); Object.freeze(binding);
      const saved = hooks.bind({ binding, api: model.api,
        transport: observedFetch(model.api, this.dependencies.fetch ?? globalThis.fetch) ? 'observed-fetch' : 'not-observable', at: now().at });
      return saved.ok ? ok(binding) : saved;
    } catch { return fail(appError('context_binding_unknown', 'runtime', 'Request provenance could not be confirmed.')); }
  }

  private withRuntimeAwareness(active: ActiveExecution, context: StreamContext, maxModelCalls: number,
    remainingMs: number | undefined): StreamContext {
    if (active.input.budgetAwareness === false || !active.input.runtimeBudget) return context;
    const budget = active.input.runtimeBudget;
    const strategy = active.input.runtimeStrategy;
    const allowed = active.toolBinding?.context.scope.allowedTools ?? [];
    const diagnostics = [...active.toolRequests.entries()].slice(-8).flatMap(([id, request]) => {
      if (!allowed.includes(request.name)) return [];
      const saved = active.toolBinding?.queryCall?.(id);
      if (!saved?.ok || !saved.data.runtimeObservation) return [{ tool: request.name, missingEvidence: true }];
      const observation = saved.data.runtimeObservation;
      return [{ tool: request.name, diagnosticCode: observation.diagnosticCode, failureStage: observation.failureStage,
        missingEvidence: observation.afterDomain === 'unknown' || observation.afterDomain === 'invalid' }];
    });
    const facts = {
      remainingModelCalls: Math.max(0, maxModelCalls - active.callSequence),
      remainingToolCalls: Math.max(0, budget.maxToolCalls - active.toolRequests.size),
      remainingRunMs: remainingMs === undefined ? null : Math.max(0, Math.floor(remainingMs)),
      tools: allowed.map(name => { const group = strategy?.calibration.groups.find(item => item.toolName === name);
        return { name, timeoutMs: group?.selectedTimeoutMs ?? budget.toolTimeoutMs, timeoutSource: group?.timeoutSource ?? 'configured',
          fallbackReason: group?.fallbackReason ?? (strategy ? null : 'no-calibration') }; }),
      diagnostics, experience: strategy?.experience.items ?? [],
    };
    return { ...context, systemPrompt: context.systemPrompt + '\n\nRuntime awareness (advisory, current request only):\n'
      + JSON.stringify(facts) + '\nUse only the allowed tools above. Prefer a cheaper allowed read or narrower query when it supplies the missing evidence. '
      + 'Stop with an explicit evidence gap when no legal alternative can meet the goal. Validation does not save a candidate.' };
  }

  private rejectPiFeedback(record: SessionRecord, active: ActiveExecution, nativeToolCallId: string,
    error: ReturnType<typeof appError>) {
    const request = active.toolRequests.get(nativeToolCallId);
    const saved = active.toolBinding?.recordDelivery(nativeToolCallId, { version: 1, state: 'failed',
      messageObservedAt: request?.messageObservedAt ?? null, includedInCallSequence: null, requestDispatchedAt: null, error });
    this.failToolRun(record, active, saved?.ok ? error : appError('storage_write_failed', 'storage', 'Tool feedback failure could not be saved.', true));
    return { content: [{ type: 'text' as const, text: error.message }], details: {}, isError: true };
  }

  private verifyModelUse(record: SessionRecord): Result<void> {
    const active = record.active;
    if (!active) return fail(appError('agent_unbound_execution', 'runtime', 'Agent 请求缺少有效 Run 绑定。'));
    if (record.historyFailure) return fail(record.historyFailure);
    if (record.unusable) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    if (active.failure) return fail(active.failure);
    if (active.signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 执行已取消。'));
    try {
      const allowed = active.input.verifyModelUse();
      if (!allowed.ok) return allowed;
      for (const state of active.inputs.values()) if (state.started) {
        const inputAllowed = active.input.verifyInputUse?.(state.inputId);
        if (!inputAllowed?.ok) return inputAllowed ?? fail(appError('tool_access_denied', 'runtime', 'Input authorization is unavailable.'));
      }
      return ok(undefined);
    }
    catch { return fail(appError('storage_read_failed', 'storage', 'Session 使用权限无法确认。', true, active.runId, active.sessionId)); }
  }

  private validateMessages(record: SessionRecord, messages: Parameters<typeof validateModelMessages>[0], agentContext = false): Result<void> {
    for (const message of messages) {
      if (!('content' in message) || !Array.isArray(message.content)
        || !message.content.some(block => block && typeof block === 'object' && 'type' in block && block.type === 'image')) continue;
      const proven = message.role === 'toolResult'
        ? NATIVE_TOOL_NAMES.includes(message.toolName as typeof NATIVE_TOOL_NAMES[number]) || !!record.nativeObjects?.get(message)
        : message.role === 'user' ? !!record.contextMessages.get(message) || !!record.convertedOrigins?.get(message)
        : message.role === 'custom' && !!record.nativeObjects?.get(message);
      if (!proven) return fail(appError('context_binding_unknown', 'runtime', 'Image provenance is unavailable.'));
      if (!['openai-completions', 'openai-responses'].includes(record.model?.api ?? ''))
        return fail(appError('agent_image_history_blocked', 'session', 'The selected codec cannot preserve native images.'));
      if (!record.model?.input.includes('image')) return fail(appError('agent_model_image_unsupported', 'session',
        'The selected model does not support image tool results. The saved image was not sent or removed.',
        false, record.active?.runId, record.active?.sessionId));
    }
    return agentContext ? validateAgentContext(messages) : validateLlmMessages(messages);
  }

  private failToolRun(record: SessionRecord, active: ActiveExecution, error: ReturnType<typeof appError>): void {
    if (error.code === 'session_history_invalid') {
      // SDK may append after notifying observers; keep only the confirmed prefix.
      record.historyFailure ??= error;
      record.unusable = true;
    }
    active.failure ??= error;
    active.stopReason = active.failure.code;
    this.stop(record, active);
  }

  private guardInheritedTool(record: SessionRecord, id: string): Result<void> {
    if (!record.inheritedToolIds?.has(id)) return ok(undefined);
    const error = appError('context_binding_conflict', 'runtime', 'An inherited native tool call ID cannot be executed again.');
    if (record.active) { record.historyFailure ??= error; record.unusable = true; this.failToolRun(record, record.active, error); }
    return fail(error);
  }

  private observeAgentEvent(record: SessionRecord, active: ActiveExecution, event: PiAgentEvent, eventSignal?: PiAgentEventSignal): void {
    if (active.multiCall && event.type === 'message_end' && event.message.role === 'assistant' && active.callSequence > 0) {
      const normalized = normalizeUsage(event.message, { attempts: Math.max(0, active.attempts - active.attemptsAtCallStart),
        complete: active.complete && event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted' }, record.config?.connection === undefined);
      if (normalized.usage.version === 1) {
        const prior = active.modelCallUsages.findIndex(item => item.callSequence === active.callSequence);
        const usage: ModelCallUsage = { callSequence: active.callSequence, usage: normalized.usage, tokens: normalized.tokens,
          complete: normalized.usage.attemptsComplete };
        if (prior < 0) active.modelCallUsages.push(usage); else active.modelCallUsages[prior] = usage;
      }
    }
    const binding = active.toolBinding;
    if (!active.p3 || !binding) return;
    const signal = eventSignal ?? active.signal;
    const ensureRequest = (name: string, raw: unknown, nativeToolCallId: string, requestBinding?: RequestContextBinding): ToolRequestState | null => {
      if (!this.guardInheritedTool(record, nativeToolCallId).ok) return null;
      const prior = active.toolRequests.get(nativeToolCallId);
      if (prior) {
        if (prior.name !== name || !isDeepStrictEqual(prior.raw, raw)
          || requestBinding !== undefined && !isDeepStrictEqual(prior.requestBinding, requestBinding)) {
          this.failToolRun(record, active, appError('context_binding_conflict', 'runtime', 'Tool request conflicts with its original generating request.'));
          return null;
        }
        return prior;
      }
      if (active.input.contextHooks && !requestBinding) {
        this.failToolRun(record, active, appError('context_binding_unknown', 'runtime', 'The tool has no confirmed generating request.'));
        return null;
      }
      const observed = binding.observeRequest(name, raw, { nativeToolCallId, signal, ...(requestBinding ? { requestBinding } : {}) });
      if (!observed.ok) {
        this.failToolRun(record, active, observed.error);
        return null;
      }
      const state: ToolRequestState = { name, raw: structuredClone(raw), sdkRaw: raw, ...(requestBinding ? { requestBinding } : {}), invoked: false, terminal: false,
        messageObserved: false, messageObservedAt: null, requestObservedAtSequence: null };
      active.toolRequests.set(nativeToolCallId, state);
      return state;
    };
    const rejectUninvoked = (state: ToolRequestState, nativeToolCallId: string, feedbackText?: string) => {
      if (state.invoked || state.terminal) return;
      const definition = this.toolsByName.get(state.name);
      const error = !definition
        ? appError('tool_not_found', 'tool', '此 Run 未注册请求的工具。', false, active.runId, active.sessionId, nativeToolCallId)
        : !binding.context.scope.allowedTools.includes(state.name)
          ? appError('tool_access_denied', 'runtime', '此 Run 未获准使用请求的工具。', false, active.runId, active.sessionId, nativeToolCallId)
          : signal.aborted
            ? appError('agent_cancelled', 'runtime', 'The Run was cancelled before tool execution.', false, active.runId, active.sessionId, nativeToolCallId)
            : state.failureStage === 'sdk_arguments'
            ? appError('tool_invalid_input', 'tool', '工具参数不符合输入 Schema。', false, active.runId, active.sessionId, nativeToolCallId)
            : state.failureStage === 'sdk_before'
              ? appError(state.sdkBlocked ? 'tool_sdk_blocked' : 'tool_sdk_before_failed', 'tool', 'The SDK rejected this tool before execution.', false, active.runId, active.sessionId, nativeToolCallId)
              : appError('tool_execution_not_started', 'tool', 'The SDK did not start this tool execution.', false, active.runId, active.sessionId, nativeToolCallId);
      const rejected = binding.rejectRequest(state.name, state.raw, { nativeToolCallId, signal,
        ...(state.requestBinding ? { requestBinding: state.requestBinding } : {}) },
        feedbackText === undefined ? error : { ...error, message: feedbackText }, state.failureStage ?? 'unknown');
      if (!rejected.ok) this.failToolRun(record, active, rejected.error);
      state.terminal = true;
    };

    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const valid = projectMessageView(event.message, { entryId: null, runId: active.runId,
        liveOrdinal: null, persistence: 'pending', phase: 'ended' });
      if (!valid.ok) { this.failToolRun(record, active, valid.error); return; }
      const calls = event.message.content.filter((part): part is Extract<typeof part, { type: 'toolCall' }> => part.type === 'toolCall');
      const requestBinding = active.assistantBindings.get(event.message);
      if (active.input.contextHooks && calls.length && !requestBinding) {
        this.failToolRun(record, active, appError('context_binding_unknown', 'runtime', 'The terminal assistant has no generating request.'));
        return;
      }
      for (const call of calls) ensureRequest(call.name, call.arguments, call.id, requestBinding);
      if (event.message.stopReason === 'stop' && calls.length === 0) active.finalAssistantMessage = event.message;
    }

    if (event.type === 'tool_execution_start') {
      ensureRequest(event.toolName, event.args, event.toolCallId);
    }

    if (event.type === 'tool_execution_end') {
      const state = active.toolRequests.get(event.toolCallId);
      if (state) rejectUninvoked(state, event.toolCallId,
        event.result.content.flatMap((part: AgentToolResult<unknown>['content'][number]) => part.type === 'text' ? [part.text] : []).join('\n'));
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
    const inherited = this.guardInheritedTool(record, nativeToolCallId); if (!inherited.ok) throw inherited.error;
    let request = active.toolRequests.get(nativeToolCallId);
    if (!request) {
      if (active.input.contextHooks) {
        const error = appError('context_binding_unknown', 'runtime', 'The tool has no original request state.');
        this.failToolRun(record, active, error); throw new Error(error.message);
      }
      const observed = binding.observeRequest(definition.name, input, { nativeToolCallId, signal: active.signal });
      if (!observed.ok) {
        this.failToolRun(record, active, observed.error);
        throw new Error(observed.error.message);
      }
      request = { name: definition.name, raw: structuredClone(input), sdkRaw: input, invoked: false, terminal: false, messageObserved: false, messageObservedAt: null, requestObservedAtSequence: null };
      active.toolRequests.set(nativeToolCallId, request);
    }
    if (active.input.contextHooks && !request.requestBinding || request.name !== definition.name) {
      const error = appError('context_binding_unknown', 'runtime', 'The tool generating request is unavailable.');
      this.failToolRun(record, active, error); throw new Error(error.message);
    }
    const toolCall = Object.freeze({ nativeToolCallId, signal: toolSignal
      ? AbortSignal.any([active.signal, toolSignal]) : active.signal,
      ...(request.requestBinding ? { requestBinding: request.requestBinding } : {}) });
    request.invoked = true;
    let invocation;
    try {
      invocation = await binding.execute(definition.name, input, toolCall, request.raw);
    } catch {
      const error = appError('tool_execution_failed', 'tool', '工具执行失败。');
      this.failToolRun(record, active, error);
      request.terminal = true;
      throw new Error(error.message);
    }
    const result = invocation.result;
    request.terminal = true;
    request.feedbackIsError = result.status !== 'succeeded';
    request.feedback = result.status === 'succeeded'
      ? { content: [{ type: 'text', text: JSON.stringify(result.data) }], details: result.data }
      : { content: [{ type: 'text', text: result.error.message }], details: {} };
    if (invocation.fatal) {
      const error = result.status === 'succeeded'
        ? appError('storage_write_failed', 'storage', '工具运行记录无法保存。', true)
        : result.error;
      this.failToolRun(record, active, error);
      throw new Error(error.message);
    }
    if (getNativeToolParameters(definition)) {
      const native = NativeToolOutputSchema.safeParse(result.data);
      if (native.success) {
        if (result.status !== 'succeeded') active.nativeFailures.add(nativeToolCallId);
        request.feedback = { content: native.data.content, details: native.data.details };
        return request.feedback;
      }
      if (result.status === 'succeeded') throw new Error('The native tool returned an invalid result.');
    }
    if (result.status !== 'succeeded') throw new Error(result.error.message);

    return request.feedback;
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
    requestBinding?: RequestContextBinding,
  ): Promise<void> {
    const callSequence = active.callSequence;
    const callStartedAt = performance.now();
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
    const codecResult = requestBinding ? preparePayloadCodec(model.api, context, model.input.includes('image')) : ok(undefined);
    if (!codecResult.ok) { failStream(codecResult.error); return; }
    const codec = codecResult.data;
    const modelIdentity = { api: model.api, provider: model.provider, model: model.id };
    const recordEvidence = (update: ContextEvidenceUpdate): Result<void> => {
      if (!requestBinding) return ok(undefined);
      let saved: Result<void>;
      try { saved = active.input.contextHooks!.record(requestBinding, update); }
      catch { saved = fail(appError('storage_write_failed', 'storage', 'Request evidence could not be saved.', true)); }
      if (!saved.ok) failStream(saved.error);
      return saved;
    };
    const requireEvidence = (update: ContextEvidenceUpdate) => {
      const saved = recordEvidence(update); if (!saved.ok) throw new Error(saved.error.code);
    };
    let localAttempt = 0;
    let sdkPayloadFact: Extract<ContextEvidenceUpdate, { kind: 'sdk-payload' }> | undefined;
    let sdkSuccessSlot: { attempt: number; status: number; responseAt: string } | undefined;
    let consumedResponse: { status: number; nativeRequestId: string | null; api: string; provider: string; model: string } | undefined;
    const observable = observedFetch(model.api, this.dependencies.fetch ?? globalThis.fetch) !== undefined;
    const baseFetch: FetchLike = (options?.fetch as FetchLike | undefined)
      ?? this.dependencies.fetch
      ?? ((request, init) => globalThis.fetch(request, init));
    const fetch: FetchLike = async (request, init) => {
      const wire = requestBinding ? await checkWire(codec, request, init) : ok({ inclusion: 'confirmed' as const, reason: null });
      if (!wire.ok) { failStream(wire.error); throw new Error(wire.error.code); }
      if (signal.aborted) { const error = appError('agent_cancelled', 'runtime', 'The request was cancelled before dispatch.');
        this.failToolRun(record, active, error); throw new Error(error.code); }
      if ((active.input.remainingRunMs?.() ?? Infinity) <= 0) {
        const error = appError('agent_timeout', 'runtime', 'The Run deadline elapsed before dispatch.');
        this.failToolRun(record, active, error);
        throw new Error(error.code);
      }
      const allowed = this.verifyModelUse(record);
      if (!allowed.ok) {
        this.failToolRun(record, active, allowed.error);
        throw new Error(allowed.error.code);
      }
      if (!this.observeOutgoingToolResults(record, active, context)) throw new Error('tool_result_delivery_failed');
      const attempt = ++localAttempt;
      if (requestBinding) requireEvidence({ kind: 'attempt-prepared', evidence: { attempt, preparedAt: now().at,
        enteredAt: null, responseAt: null, responseStatus: null, transportErrorCode: null, nativeRequestId: null,
        wireInclusion: wire.data.inclusion, wireReason: wire.data.reason } });
      active.attempts += 1;
      const requestUrl = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url;
      this.observe(active, 'request_dispatched', { callSequence: active.callSequence, attempt: active.attempts, url: safeUrl(requestUrl) });
      let launched: Promise<Response>;
      try { launched = baseFetch(request, init); } catch (error) { launched = Promise.reject(error); }
      // Attach immediately: an entered-write rejection must not abandon a rejected launched request.
      const settled = launched.then(response => ({ response }), error => ({ error }));
      const entered = requestBinding ? recordEvidence({ kind: 'attempt-entered', attempt, at: now().at }) : ok(undefined);
      const outcome = await settled;
      if ('response' in outcome) {
        const response = outcome.response;
        const responseAt = now().at;
        const recorded = requestBinding ? recordEvidence({ kind: 'response', attempt, at: responseAt,
          status: response.status, nativeRequestId: null }) : ok(undefined);
        active.responseStatus = response.status;
        active.responseStarted = true;
        this.observe(active, 'response_started', { callSequence: active.callSequence, attempt: active.attempts, status: response.status });
        if (!entered.ok) throw new Error(entered.error.code);
        if (!recorded.ok) throw new Error(recorded.error.code);
        if (requestBinding && response.ok && codec) sdkSuccessSlot = { attempt, status: response.status, responseAt };
        return response;
      }
      if (!entered.ok) throw new Error(entered.error.code);
      if (requestBinding) {
        const failure = active.failure ?? (active.signal.aborted ? appError('agent_cancelled', 'runtime', 'The request was cancelled.')
          : appError('provider_transport_error', 'provider', 'The request transport failed.'));
        const safeCode = ContextSafeErrorCodeSchema.safeParse(failure.code);
        requireEvidence({ kind: 'transport-failed', attempt, at: now().at, code: safeCode.success ? safeCode.data : 'provider_transport_error' });
        failStream(failure);
      } else if (!active.failure) active.failure = this.providerError(active, outcome.error, true);
      throw outcome.error;
    };
    const signal = options?.signal ? AbortSignal.any([options.signal, active.signal]) : active.signal;
    const onPayload = async (payload: unknown, requestedModel: StreamModel) => {
      const replacement = await options?.onPayload?.(payload, requestedModel);
      const outgoing = replacement === undefined ? payload : replacement;
      if (requestBinding) {
        const inclusion = checkPayload(codec, outgoing);
        if (!inclusion.ok) { failStream(inclusion.error); throw new Error(inclusion.error.code); }
        const fact = { kind: 'sdk-payload' as const, at: sdkPayloadFact?.at ?? now().at, ...inclusion.data };
        requireEvidence(fact); sdkPayloadFact ??= fact;
      }
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
      const captured = { status: response.status, nativeRequestId: sdkRequestId(response.headers),
        api: requestedModel.api, provider: requestedModel.provider, model: requestedModel.id };
      await options?.onResponse?.(response, requestedModel);
      if (requestBinding && codec && observable) {
        const slot = sdkSuccessSlot;
        const code = !slot ? 'context_binding_unknown' : captured.status !== slot.status || captured.api !== modelIdentity.api
          || captured.provider !== modelIdentity.provider || captured.model !== modelIdentity.model
          || consumedResponse && !isDeepStrictEqual(consumedResponse, captured) ? 'context_binding_conflict' : null;
        if (code) { const error = appError(code, 'runtime', 'The SDK response does not match its original request.'); failStream(error); throw new Error(code); }
        if (!consumedResponse) {
          requireEvidence({ kind: 'response', attempt: slot!.attempt, at: slot!.responseAt, status: slot!.status, nativeRequestId: captured.nativeRequestId });
          consumedResponse = captured;
        }
      }
      active.responseStatus = response.status;
      active.responseStarted = true;
      this.observe(active, 'response_started', { callSequence: active.callSequence, attempt: active.attempts || 1, status: response.status });
    };
    try {
      const requestTimeoutMs = Math.floor(Math.min(record.snapshot?.limits.timeoutMs ?? RUNTIME_CONFIG.request.timeoutMs,
        active.input.remainingRunMs?.() ?? Infinity));
      if (!(requestTimeoutMs > 0)) {
        const error = appError('agent_timeout', 'runtime', 'The Run deadline elapsed before dispatch.');
        this.failToolRun(record, active, error);
        throw new Error(error.code);
      }
      const stream = await nativeStream(model, context, {
        ...options,
        signal,
        fetch: observedFetch(model.api, fetch),
        timeoutMs: requestTimeoutMs,
        maxRetries: record.config?.parameters.maxRetries,
        maxRetryDelayMs: record.config?.parameters.maxRetryDelayMs,
        onPayload,
        onResponse,
      });
      for await (const event of stream) {
        if (event.type === 'start') active.responseStarted = true;
        if (event.type === 'text_delta' && !outputEnded) {
          const deltaBytes = encoder.encode(event.delta).byteLength;
          if (active.multiCall && active.totalOutputBytes + deltaBytes > maxOutputBytes) {
            failStream(appError('agent_output_limit', 'runtime', 'Run 的累计 Agent 输出超过本阶段限制。'));
            continue;
          }
          const previousText = active.text;
          const appended = appendUtf8(active.text, event.delta, active.textBytes);
          if (active.multiCall) active.totalOutputBytes += deltaBytes;
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
        if (event.type === 'done') {
          finalMessage = event.message;
          if (requestBinding && (event.message.stopReason === 'stop' || event.message.stopReason === 'toolUse'))
            active.assistantBindings.set(event.message, requestBinding);
        }
        if (!outputEnded) output.push(event);
      }
      if (finalMessage === undefined) {
        finalMessage = await stream.result();
        if (requestBinding && (finalMessage.stopReason === 'stop' || finalMessage.stopReason === 'toolUse'))
          active.assistantBindings.set(finalMessage, requestBinding);
      }
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
        if (finalTextBytes > maxOutputBytes || active.multiCall && active.totalOutputBytes + (active.textBytes === 0 ? finalTextBytes : 0) > maxOutputBytes) {
          active.text = appendUtf8('', finalText, 0).text;
          active.textBytes = maxOutputBytes;
          failStream(appError('agent_output_limit', 'runtime', 'Agent 回复超过本阶段限制。'));
        } else if (active.textBytes === 0 && finalTextBytes > 0) {
          active.text = finalText;
          active.textBytes = finalTextBytes;
          if (active.multiCall) active.totalOutputBytes += finalTextBytes;
        }
        if (active.multiCall && finalMessage.stopReason === 'stop'
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
    active.modelCalls.push({ callSequence, durationMs: Math.max(0, performance.now() - callStartedAt),
      complete: active.complete && !streamFailed && !active.signal.aborted });
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
    this.closeInputAdmission(active);
    if (!active.queueCleared && record.session) {
      try {
        record.session.clearQueue();
        if (record.session.agent.hasQueuedMessages()) throw new Error('native_input_queue_remains');
        active.queueCleared = true;
      }
      catch { active.failure ??= appError('agent_cleanup_failed', 'runtime', 'Agent input queues could not be cleared.', true); }
    }
    if (!active.abortPromise && record.session) {
      active.abortPromise = record.session.abort().catch(() => {
        active.failure ??= appError('agent_cleanup_failed', 'runtime', 'Agent 停止请求失败。', true);
      });
    }
  }

  private providerError(active: ActiveExecution, error: unknown, transportFailed = false): ReturnType<typeof appError> {
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
    if (!active.responseStarted) return transportFailed ? appError('provider_network_error', 'provider', 'Provider 请求未建立响应。', true)
      : appError('provider_error', 'provider', 'Provider 请求失败。', true);
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
    if ((record.policy === 'fill') !== (input.goalMode === 'fill-form')) {
      return this.notStarted(nativeSessionId, appError('tool_access_denied', 'runtime', 'The execution does not match its prepared form policy.'));
    }
    if (input.workingDirectory !== undefined && input.workingDirectory !== record.workingDirectory) {
      return this.notStarted(nativeSessionId, appError('tool_access_denied', 'runtime', 'The execution does not match its prepared working directory.'));
    }
    if (record.recoverySeed && record.recoverySeed.sessionId !== input.sessionId)
      return this.notStarted(nativeSessionId, appError('context_binding_unknown', 'runtime', 'Execution Session differs from its recovery origins.'));
    if (input.inputId !== undefined && (!Number.isSafeInteger(input.inputId) || input.inputId <= 0
      || typeof input.promptText !== 'string' || !input.promptText.trim() || !record.historyWriter
      || !input.verifyInputUse || !input.completeInputResult)) {
      return this.notStarted(nativeSessionId, appError('agent_execution_invalid', 'input', 'Input identity, frozen prompt, and persistence callbacks are required.'));
    }
    if ((input.contextHooks !== undefined) !== (input.contextSnapshotId !== undefined)
      || input.contextHooks !== undefined && (input.inputId === undefined
        || !Number.isSafeInteger(input.contextSnapshotId) || input.contextSnapshotId! <= 0))
      return this.notStarted(nativeSessionId, appError('context_binding_unknown', 'runtime', 'Execution context association is unavailable.'));

    const active: ActiveExecution = {
      input, nextLiveOrdinal: 0, liveOrdinals: new WeakMap(), nativeFailures: new Set(),
      runId: input.runId, sessionId: input.sessionId, nativeSessionId, signal, observe,
      p3: input.toolBinding !== undefined,
      multiCall: input.toolBinding !== undefined || record.sessionInputs === true,
      admissionClosed: false, inputMessages: new WeakMap(), inputs: new Map(), openInputIds: new Set(),
      resultBindings: new WeakMap(), queueCleared: false,
      goalMode: input.goalMode ?? 'answer',
      ...(input.toolBinding ? { toolBinding: input.toolBinding } : {}),
      toolRequests: new Map(), assistantBindings: new WeakMap(), modelCallUsages: [], modelCalls: [], attemptsAtCallStart: 0, totalOutputBytes: 0,
      callSequence: 0, turnOrdinal: 0, attempts: 0, responseStatus: null,
      responseStarted: false, complete: false, wireMaxTokens: null,
      text: '', textBytes: 0, assistantContentBytes: 0, failure: null,
      promptEntered: true, streams: new Set(), abortPromise: null, stopReason: 'pending',
    };
    record.running = true;
    record.active = active;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant')
        for (const block of event.message.content) if (block.type === 'toolCall' && !this.guardInheritedTool(record, block.id).ok) return;
      if (event.type === 'agent_end' || event.type === 'agent_settled') this.closeInputAdmission(active);
      if (event.type === 'turn_start') active.turnOrdinal += 1;
      if (event.type === 'turn_end' && input.inputId !== undefined && !active.failure && !record.historyFailure) {
        const result = active.resultBindings.get(event.message);
        if (result) {
          try {
            const completed = input.completeInputResult!(result.inputIds, result.entryId);
            if (!completed.ok) this.failToolRun(record, active, completed.error);
          } catch { this.failToolRun(record, active, appError('storage_write_failed', 'storage', 'Input result completion could not be saved.', true)); }
          active.resultBindings.delete(event.message);
        }
      }
      if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
        if (record.historyFailure) return;
        const message = event.message;
        let ordinal = active.liveOrdinals.get(message);
        const assistant = message.role === 'assistant';
        if (event.type === 'message_start') {
          if (message.role === 'user' && input.inputId !== undefined) {
            const inputId = active.inputMessages.get(message); const state = inputId === undefined ? undefined : active.inputs.get(inputId);
            if (!state || state.started) {
              this.failToolRun(record, active, appError('session_history_invalid', 'session', 'Consumed native input has no unique product identity.'));
              return;
            }
            state.started = true;
          }
          if (ordinal !== undefined || assistant && active.assistantOrdinal !== undefined) {
            this.failToolRun(record, active, appError('session_history_invalid', 'session', 'Native message generation identity is inconsistent.'));
            return;
          }
          ordinal = ++active.nextLiveOrdinal;
          if (assistant) active.assistantOrdinal = ordinal;
        } else {
          if (assistant && (active.assistantOrdinal === undefined
            || ordinal !== undefined && ordinal !== active.assistantOrdinal)) {
            this.failToolRun(record, active, appError('session_history_invalid', 'session', 'Native message generation identity is inconsistent.'));
            return;
          }
          // SDK partial/final objects can differ; only an open assistant may share its ordinal.
          if (assistant) ordinal ??= active.assistantOrdinal;
          if (ordinal === undefined) {
            this.failToolRun(record, active, appError('session_history_invalid', 'session', 'Native message has no actual live identity.'));
            return;
          }
        }
        active.liveOrdinals.set(message, ordinal);
        this.publishMessage(record, active, message, ordinal, 'pending',
          event.type !== 'message_end' && assistant ? 'streaming' : 'ended');
        if (event.type === 'message_end' && assistant) delete active.assistantOrdinal;
      }
      const projected = projectSessionEvent(event, active.turnOrdinal);
      if (projected) this.observe(active, 'agent_event', projected);
    });
    const unsubscribeAgent = session.agent.subscribe((event, eventSignal) => this.observeAgentEvent(record, active, event, eventSignal));
    const onAbort = () => this.stop(record, active);
    signal.addEventListener('abort', onAbort, { once: true });
    let promptSettled = false;
    try {
      try {
        if (input.inputId !== undefined) {
          const dispatched = await this.dispatchInput(record, active, { inputId: input.inputId, text: input.text, promptText: input.promptText!, contextSnapshotId: input.contextSnapshotId },
            () => session.prompt(input.promptText!, { expandPromptTemplates: false }), false);
          await dispatched.execution;
        } else await session.prompt(formatExecutionPrompt({ ...input, business: input.toolBinding !== undefined }), { expandPromptTemplates: false });
      } finally { promptSettled = true; }
      this.closeInputAdmission(active);
      await record.dispatchTail;
      await Promise.all([...active.streams]);
      await active.abortPromise;
    } catch {
      active.failure ??= signal.aborted
        ? appError('agent_cancelled', 'runtime', 'Agent 执行已取消。')
        : appError('agent_execution_failed', 'runtime', 'Agent 执行失败。', true);
      active.stopReason = active.failure.code;
    } finally {
      this.closeInputAdmission(active);
      await record.dispatchTail;
      if (session.isIdle) {
        active.queueCleared = false;
        try {
          session.clearQueue();
          if (session.agent.hasQueuedMessages()) throw new Error('native_input_queue_remains');
          active.queueCleared = true;
        }
        catch { active.failure ??= appError('agent_cleanup_failed', 'runtime', 'Agent input queues could not be cleared.', true); }
      }
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
        if (active.multiCall) active.totalOutputBytes += bounded.bytes;
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
      if (record.memory && !record.historyFailure) {
        const snapshot = this.exportSession(nativeSessionId);
        const saved = snapshot.ok ? record.memory.save(snapshot.data, []) : snapshot;
        if (!saved.ok) {
          record.unusable = true; record.historyFailure = saved.error; active.failure = saved.error;
          active.stopReason = saved.error.code; this.stop(record, active); await active.abortPromise;
        } else {
          record.lastSavedHistory = structuredClone(record.memory.lastSavedHistory);
          record.receipt = structuredClone(record.memory.commit); record.recoverySeed = structuredClone(record.memory.seed);
        }
      }
      const messageForUsage = finalMessage ?? systemError(active.failure ?? appError('agent_execution_failed', 'runtime', 'Agent 执行失败。'), model);
      const usage = active.multiCall
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
        agent: { nativeSessionId, turnCount: active.turnOrdinal, modelCallCount: active.callSequence, modelCalls: active.modelCalls,
          ...(input.inputId !== undefined && stopped && active.queueCleared && !record.historyFailure
            ? { confirmedUnconsumedInputIds: [...active.inputs.values()].filter(value => !value.started).map(value => value.inputId) } : {}) },
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
