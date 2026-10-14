import { RESEARCH_PLANNING_SYSTEM_PROMPT, RESEARCH_INVESTIGATION_SYSTEM_PROMPT } from '@flowmate/contracts';
import { FrozenInputDefinitionsSchema, InputCommandOwnerSchema, InputCommandReceiptSchema } from '@flowmate/contracts';
import { nativeFileResultIncludes } from '@flowmate/shared';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import { isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { isDeepStrictEqual } from 'node:util';
import {
  createAgentSession,
  sessionEntryToContextMessages,
  convertToLlm,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  estimateTokens,
  calculateContextTokens,
  formatSkillsForPrompt,
  type AgentSession,
  type AgentToolResult, type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent';
import { RUNTIME_CONFIG, appError, fail, ok, NativeInputContextBindingSchema, NativeToolResultContextBindingSchema, RequestContextBindingSchema, ContextSafeErrorCodeSchema, CompactionPolicySchema, ContextToolDefinitionsEvidenceSchema } from '@flowmate/contracts';
import { loadControlledExtensions, extensionAssembly, type LoadedExtensionSet } from './extensions/loader.ts';
import type { DelegateExecution } from './extensions/subagents.ts';
import type { ManagedChildControl } from '@tintinweb/pi-subagents/dist/agent-runner.js';
import { DelegateArgsSchema, ToolExecutionFailure, SUBAGENT_ROLE, SUBAGENT_SYSTEM_PROMPT } from '@flowmate/contracts';
import type { ToolExecutionContext, DelegateArgs, NativeToolOutput, SubagentCallbacks, PreparedSubagent } from '@flowmate/contracts';
import { FrozenExtensionsSchema, matchesExtensionAssembly, type NativeExtensionView } from '@flowmate/contracts';
import { createRunResourceLoader, verifySkillExpansion, verifyManagedReadOutput, verifySkillToolOutput } from './resources/loader.ts';
import { matchesResourceBinding, resourceContentKey, ResourceRequestEvidenceSchema } from '@flowmate/contracts';
import type { ResourceRef, ResourceBinding, ResourceExpansionEvidence, ResourceRequestEvidence, ResourceContentEvidence, ResourceReadEvidence } from '@flowmate/contracts';
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
  CompactionCapacity,
  SavedCompactionView,
  CompactionObservation,
  NativeCompactionControl,
  NativeCompactionOutcome,
  SummaryCallEvidence,
} from '@flowmate/contracts';
import type { ProviderConfig } from '@flowmate/contracts';
import { INVOICE_CHAT_SYSTEM_PROMPT, INVOICE_TOOLS_SYSTEM_PROMPT, INVOICE_FILL_FORM_SYSTEM_PROMPT, NativeToolOutputSchema, NATIVE_TOOL_NAMES } from '@flowmate/contracts';
import { normalizeUsage, modelRuntimeSnapshot, observedFetch, prepareModelRuntime, safeUrl } from './model-runtime.ts';
import type { FetchLike, PiProviderDependencies } from './model-runtime.ts';
import { toPiTool } from './tools.ts';
import { getNativeToolParameters } from './native-tools.ts';
import { projectSessionEvent } from './events.ts';
import { checkPayload, checkWire, preparePayloadCodec, sdkRequestId, checkResourcePayload, checkResourceWire,
  type ResourcePayloadText, type ResourceInclusion } from './context-evidence.ts';
import { formatExecutionPrompt, validateNativeHistory, validateModelMessages, projectSessionMessages, projectMessageView } from './messages.ts';

import { managerFor, validateRecovery, validateAgentContext, validateLlmMessages, referenceIds, inspectSessionHistory, buildForkSessionHistory } from './memory/history.ts';
import { PiMemoryAdapter } from './memory/persistence.ts';
import { installNativeCompactionBridge, type NativeSummaryScope } from './memory/compaction.ts';

const maxContextBytes = RUNTIME_CONFIG.llmPayload.maxChatContextBytes;
const maxOutputBytes = RUNTIME_CONFIG.llmPayload.maxOutputTextBytes;
const maxAssistantContentBytes = RUNTIME_CONFIG.llmPayload.maxAssistantContentBytes;
const encoder = new TextEncoder();
const resourceTextHash = (text: string) => createHash('sha256').update(text).digest('hex');
function refineResourceEvidence(value: ResourceRequestEvidence, layer: 'sdk' | 'wire', facts: readonly ResourceInclusion[]): ResourceRequestEvidence {
  return { ...value, contentChecks: value.contentChecks.map((item, index) => {
    const fact = facts[index]!;
    const next = { ...item, [layer === 'sdk' ? 'sdkInclusion' : 'wireInclusion']: fact.inclusion };
    return { ...next, reason: next.sdkInclusion === 'unknown' || next.wireInclusion === 'unknown' ? fact.reason ?? item.reason : null };
  }) };
}

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
  feedback?: AgentToolResult<unknown>; feedbackIsError?: boolean; resourceReads?: ResourceReadEvidence[] };
type InputDispatchState = { inputId: number; text: string; promptText: string; contextSnapshotId?: number; resourceBinding?: ResourceBinding;
  expansion?: Omit<ResourceExpansionEvidence, 'inputId' | 'nativeEntryId'>; started: boolean; message?: object };

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
  modelCallIndex: number;
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
  subagentOwner?: { childRunId: number; pluginAgentId: string };
  extensions?: LoadedExtensionSet;
  delegations?: Map<string, { call: DelegateExecution; promise: Promise<AgentToolResult<unknown>>; control?: ManagedChildControl;
    childError?: import('@flowmate/contracts').AppError }>;
  extensionKey?: string;
  disposing?: Promise<CloseReport>;
  commanding?: boolean;
  compactionBridge?: { dispose(): void };
  compacting?: boolean;
  compaction?: { control: NativeCompactionControl; observation: CompactionObservation; baseline: HistoryCommitState;
    scope?: NativeSummaryScope; failure?: ReturnType<typeof appError>; purposes: ('history' | 'turn-prefix')[];
    calls: SummaryCallEvidence[]; usages: ModelCallUsage[]; streams: Set<Promise<void>>;
    firstKeptEntryId: string | null; splitTurn: boolean | null };
  manager: SessionManager;
  session?: AgentSession;
  runtime?: ModelRuntime;
  model?: NonNullable<ReturnType<ModelRuntime['getModel']>>;
  config?: ProviderConfig;
  snapshot?: PreparedAgent['snapshot'];
  policy?: 'p2' | 'p3' | 'fill';
  workingDirectory?: string;
  resourceKey?: string | null;
  resourceLoader?: Extract<ReturnType<typeof createRunResourceLoader>, { ok: true }>['data'];
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

function inMemorySettings(): SettingsManager {
  return SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: RUNTIME_CONFIG.compaction.reserveTokens, keepRecentTokens: RUNTIME_CONFIG.compaction.keepRecentTokens },
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

function deliveredToolDefinitions(api: string, payload: unknown) {
  if (!['anthropic-messages', 'openai-completions', 'openai-responses'].includes(api)) return undefined;
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const body = object(payload);
  if (!body || body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128)) return undefined;
  const definitions = [];
  for (const raw of (body.tools ?? []) as unknown[]) {
    const entry = object(raw), tool = api === 'openai-completions' ? object(entry?.function) : entry;
    if (!tool || api !== 'anthropic-messages' && entry?.type !== 'function') return undefined;
    const parameters = object(api === 'anthropic-messages' ? tool.input_schema : tool.parameters);
    if (!parameters || parameters.properties !== undefined && !object(parameters.properties)) return undefined;
    definitions.push({ toolName: tool.name, properties: Object.keys(object(parameters.properties) ?? {}), required: parameters.required ?? [] });
  }
  const parsed = ContextToolDefinitionsEvidenceSchema.safeParse(definitions);
  return parsed.success ? parsed.data : undefined;
}

async function wireToolDefinitions(api: string, request: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) {
  try {
    const body = typeof init?.body === 'string' ? init.body : request instanceof Request ? await request.clone().text() : undefined;
    return body === undefined ? undefined : deliveredToolDefinitions(api, JSON.parse(body));
  } catch { return undefined; }
}

export class PiAgentAdapter implements AgentPort {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer; tools?: readonly ToolDefinition<any, any>[];
    resourceBundleRoot?: string;
    sessionSetup?: (session: AgentSession) => void };
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition<any, any>>;
  private closed = false;
  private readonly recentExtensions = new Map<string, NativeExtensionView>();
  private subagentCallbacks?: SubagentCallbacks;

  public constructor(dependencies: PiProviderDependencies & { cwd?: string; agentDir?: string; promptTrace?: PromptTraceBuffer; tools?: readonly ToolDefinition<any, any>[];
    resourceBundleRoot?: string;
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

  public bindSubagents(callbacks: SubagentCallbacks): void {
    if (this.subagentCallbacks || this.closed) throw new Error('subagent_callbacks_already_bound');
    this.subagentCallbacks = callbacks;
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

  private reseedContext(record: SessionRecord, bindings?: readonly NativeContextBindingSeed[], projection?: AgentSession['messages']): Result<void> {
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
      for (const canonical of sessionEntryToContextMessages(entry)) {
        if (projection && assembled.length >= projection.length) continue;
        const message = projection?.[assembled.length] ?? canonical;
        if (!isDeepStrictEqual(message, canonical))
          return fail(appError('session_history_invalid', 'session', 'Native context projection differs from the saved history.'));
        assembled.push(message); nativeObjects.set(message, { entryId: entry.id, original: structuredClone(message) });
        if (message.role === 'user') {
          const source = entries.get(entry.id);
          if (source) messages.set(message, source);
          else if (bindings !== undefined || record.contextSeeded) return fail(appError('context_binding_unknown', 'runtime', 'Current input provenance is unavailable.'));
        }
      }
    }
    // Install this exact array: helper-created derived objects are never interchangeable.
    if (record.session && !projection) record.session.agent.state.messages = assembled;
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
          ...(inputId !== undefined && active.inputs.get(inputId)?.expansion ? { resourceExpansion: {
            ...active.inputs.get(inputId)!.expansion!, inputId, nativeEntryId: entry.id } } : {}),
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
      if (active && entry.type === 'message' && entry.message.role === 'toolResult') {
        const request = active.toolRequests.get(entry.message.toolCallId);
        for (const read of request?.resourceReads ?? []) {
          const receipt = { ...read, nativeEntryId: entry.id };
          const result = active.input.contextHooks!.recordResourceRead!(receipt);
          if (!result.ok) { this.failToolRun(record, active, result.error); throw new Error(result.error.code); }
          Object.assign(read, receipt);
        }
      }
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
    if (productInput?.resourceBinding?.requiredSkill && persistence !== 'saved') return;
    const resourceExpansion = productInput && record.recoverySeed?.resourceExpansions?.find(value => value.inputId === productInput.inputId && value.nativeEntryId === entryId);
    const view = projectMessageView(message, { entryId, runId: active.runId, liveOrdinal: ordinal, persistence, phase,
      ...(productInput ? { productInput: { text: productInput.text, promptText: productInput.promptText, inputId: productInput.inputId,
        ...(productInput.resourceBinding ? { resourceBinding: productInput.resourceBinding } : {}),
        ...(resourceExpansion ? { resourceExpansion } : {}) } } : { runInput: { runId: active.runId, input: {
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
        : record.preparing || record.running || record.compacting || record.session?.isCompacting ? 'busy' : 'ready';
    return { availability };
  }

  public inspectSessionCompaction(input: Parameters<NonNullable<AgentPort['inspectSessionCompaction']>>[0]):
    Result<{ capacity: CompactionCapacity; lastSaved: SavedCompactionView | null; operation: CompactionObservation | null }> {
    const valid = validateRecovery(input.history, input.seed, input.commit);
    if (!valid.ok) return valid;
    try {
      const manager = managerFor(input.history), messages = manager.buildSessionContext().messages;
      const record = this.sessions.get(input.history.header.id);
      const current = record?.session;
      const sameCommitted = record?.lastSavedHistory && isDeepStrictEqual(record.lastSavedHistory, input.history)
        && isDeepStrictEqual(record.receipt, input.commit) && current && isDeepStrictEqual(current.messages, messages);
      const modelWindow = current?.model?.contextWindow;
      const contextWindow = Number.isSafeInteger(modelWindow) && modelWindow! > 0 ? modelWindow! : null;
      const reserve = record?.snapshot?.compactionPolicy?.reserveTokens ?? RUNTIME_CONFIG.compaction.reserveTokens;
      const thresholdTokens = contextWindow !== null && contextWindow > reserve ? contextWindow - reserve : null;
      const sdkUsage = sameCommitted ? current.getContextUsage() : undefined;
      const estimate = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
      const rawTokens = sdkUsage?.tokens ?? estimate;
      const tokens = Number.isSafeInteger(rawTokens) && rawTokens >= 0 ? rawTokens : null;
      const path = manager.getBranch();
      const entry = [...path].reverse().find(value => value.type === 'compaction');
      const source: CompactionCapacity['source'] = tokens === null ? 'unknown' : sdkUsage?.tokens !== null && sdkUsage?.tokens !== undefined
        ? 'sdk-usage-estimate' : sameCommitted && entry ? 'sdk-post-compaction-estimate' : 'message-estimate';
      const capacity: CompactionCapacity = { tokens, source, contextWindow, thresholdTokens,
        fitsEstimate: tokens !== null && thresholdTokens !== null ? tokens <= thresholdTokens : null };
      const origin = entry && input.seed.origins.find(value => value.nativeEntryId === entry.id);
      if (entry && !origin) return fail(appError('context_binding_unknown', 'runtime', 'Compaction origin is unavailable.'));
      const lastSaved: SavedCompactionView | null = entry && origin ? { entryId: entry.id,
        firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore, originSessionId: origin.originSessionId,
        usage: entry.usage ? normalizeUsage({ usage: entry.usage }, { attempts: 0, complete: false }, false).usage : null } : null;
      return ok({ capacity, lastSaved, operation: record?.compaction?.observation ?? null });
    } catch { return fail(appError('session_history_invalid', 'session', 'Committed compaction facts are invalid.')); }
  }

  public async moveSessionLeaf(nativeSessionId: string, targetEntryId: string): Promise<Result<NativeSessionHistory>> {
    const record = this.sessions.get(nativeSessionId);
    if (!record || record.unusable || this.closed) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    if (record.preparing || record.running || record.compacting || record.session && !record.session.isIdle)
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
    if (record.preparing || record.running || record.compacting || record.session && !record.session.isIdle)
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
    if (record?.compacting)
      return fail(appError('session_busy', 'session', 'Wait for compaction to stop before delivering another input.'));
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
        ? record.session!.steer(this.nativeInputText(input)) : record.session!.followUp(this.nativeInputText(input)), true);
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
      if (!matchesResourceBinding(active.input.resources ?? null, state.resourceBinding)) {
        const error = appError('resource_evidence_conflict', 'runtime', 'Input resources do not match the active Run.');
        this.failToolRun(record, active, error); throw error;
      }
      const required = state.resourceBinding?.requiredSkill;
      if (required) {
        const skill = session.resourceLoader.getSkills().skills.find(value => value.name === required.id);
        const body = record.resourceLoader?.bodyFor(required);
        const user = users[0]!, text = typeof user.content === 'string' ? user.content : user.content.map(part => part.type === 'text' ? part.text : '').join('');
        const expanded = skill && body !== null && body !== undefined ? verifySkillExpansion({ text, skill,
          expectedBody: body, expectedUserMessage: state.promptText }) : fail(appError('resource_expansion_mismatch', 'runtime', 'Required native Skill is unavailable.'));
        if (!expanded.ok) { this.failToolRun(record, active, expanded.error); throw expanded.error; }
        state.expansion = { skill: required, bundleHash: state.resourceBinding!.bundleHash, expandedTextHash: expanded.data.expandedTextHash, at: now().at };
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

  private nativeInputText(input: Pick<AgentInputDispatch, 'promptText' | 'resourceBinding'>): string {
    return input.resourceBinding?.requiredSkill ? `/skill:${input.resourceBinding.requiredSkill.id} ${input.promptText}` : input.promptText;
  }

  private dispatchInput(record: SessionRecord, active: ActiveExecution, input: Pick<AgentInputDispatch, 'inputId' | 'text' | 'promptText' | 'contextSnapshotId' | 'resourceBinding'>,
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
    if (record.preparing || record.running || record.compacting || record.commanding || record.disposing) return fail(appError('agent_session_busy', 'session', 'Agent Session 正在执行。'));
    if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));

    if (options?.compactionPolicy !== undefined && (!CompactionPolicySchema.safeParse(options.compactionPolicy).success
      || !isDeepStrictEqual(options.compactionPolicy, RUNTIME_CONFIG.compaction)))
      return fail(appError('compaction_unavailable', 'runtime', 'Compaction policy does not match the fixed product policy.'));

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
    const extensions = options?.extensions === undefined ? null : FrozenExtensionsSchema.safeParse(options.extensions);
    if (extensions && !extensions.success) return fail(appError('extension_config_invalid', 'input', 'Frozen extensions are invalid.'));
    const frozenExtensions = extensions?.success ? extensions.data : null;
    const extensionKey = JSON.stringify([frozenExtensions?.included ?? [], frozenExtensions?.evaluationProfile ?? null]);
    if (frozenExtensions?.included.some(item => policy !== 'p3' || (item.ref.id === 'invoice-assist'
      ? !activeToolNames.includes('check_invoice_sources') : !activeToolNames.includes('Agent'))))
      return fail(appError('extension_incompatible', 'extension', 'Extension is not eligible for this Run.'));
    const resources = options?.resources ?? null;
    const inputDefinitions = options?.inputDefinitions ? FrozenInputDefinitionsSchema.parse(options.inputDefinitions) : null;
    if (inputDefinitions && createHash('sha256').update(JSON.stringify({ roles: inputDefinitions.roles, templates: inputDefinitions.templates })).digest('hex') !== inputDefinitions.hash)
      return fail(appError('input_invalid', 'input', 'Frozen role index changed.'));
    const resourceKey = JSON.stringify([resources?.bundleHash ?? null, resources?.skillIndex?.hash ?? null, inputDefinitions?.hash ?? null, options?.chatDelegation ?? false, options?.researchPhase ?? null, [...activeToolNames].sort()]);
    const roleIndex = activeToolNames.includes('Agent') && inputDefinitions ? inputDefinitions.roles.map(role => '- '+role.id+': '+role.description.slice(0,160)+'; '+(role.tools.every(name=>activeToolNames.includes(name)) ? 'available' : 'unavailable: required tools missing')).join('\n') : undefined;
    const loader = createRunResourceLoader({ fixedSystemPrompt: options?.researchPhase ? options.researchPhase === 'planning' ? RESEARCH_PLANNING_SYSTEM_PROMPT : RESEARCH_INVESTIGATION_SYSTEM_PROMPT : policy === 'fill' ? INVOICE_FILL_FORM_SYSTEM_PROMPT
      : policy === 'p3' && !options?.chatDelegation ? INVOICE_TOOLS_SYSTEM_PROMPT : INVOICE_CHAT_SYSTEM_PROMPT, frozen: resources,
      activeToolNames,
      roleIndex, templates: inputDefinitions?.templates,
      bundleDirectory: join(this.dependencies.resourceBundleRoot ?? join(this.dependencies.agentDir ?? cwd, 'resource-bundles'), resources?.bundleHash ?? '') });
    if (!loader.ok) return loader;
    if (record.session && !record.session.isIdle) return fail(appError('agent_session_busy', 'session', 'The native Session has not stopped.'));

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
      if (frozenExtensions?.included.some(item => item.ref.id === 'subagents')
        && !observedFetch(model.api, this.dependencies.fetch ?? globalThis.fetch))
        return fail(appError('extension_incompatible', 'extension', 'Managed delegation requires an observable SDK HTTP transport.'));
      if (authSource === 'unknown') return fail(appError('agent_auth_source_unknown', 'runtime', '无法确认 Agent 模型凭据来源。'));
      if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));

      const verifiedExtensions = options?.verifyExtensions?.();
      if (verifiedExtensions && !verifiedExtensions.ok) return verifiedExtensions;

      let session = record.session;
      if (session && (runtime !== record.runtime || record.policy !== policy || record.workingDirectory !== cwd || record.resourceKey !== resourceKey || record.extensionKey !== extensionKey)) {
        const disposed = await this.disposeManagedSession(record);
        if (!disposed.closed) return fail(disposed.errors[0]!);
        record.session = undefined;
        session = undefined;
        replacingSession = true;
      }
      if (!session) {
        if (record.extensions?.scopes.some(scope => scope.view.state !== 'disposed')) {
          const disposed = await this.disposeManagedSession(record); if (!disposed.closed) return fail(disposed.errors[0]!);
        }
        record.extensions = undefined;
        let extensionResult: LoadExtensionsResult | undefined;
        if (frozenExtensions?.included.length) {
          const loaded = await loadControlledExtensions({ frozen: frozenExtensions, nativeSessionId, cwd, agentDir: this.dependencies.agentDir ?? cwd, signal,
            sdkToolFor: (name, parameters) => {
              const definition = this.toolsByName.get(name);
              if (!definition) throw appError('extension_incompatible', 'extension', 'The controlled product tool is missing.');
              return toPiTool(definition, (id, input, toolSignal) => this.executePiTool(record, definition, id, input, toolSignal), undefined, parameters);
            },
            subagent: {
              withNativeCall: (call, invoke) => this.withDelegateCall(record, call, invoke),
              controlForCall: id => {
                const control = record.delegations?.get(id)?.control;
                if (!control) throw appError('subagent_origin_invalid', 'runtime', 'Managed child assembly is unavailable for this call.');
                return control;
              },
            },
            onCreated: loaded => { record.extensions = loaded; },
            assertCallOwner: (event, instanceId) => {
              const active = record.active, request = active?.toolRequests.get(event.toolCallId);
              if (!active || !request || request.name !== event.toolName || !request.requestBinding || !active.toolBinding
                || !record.extensions?.scopes.some(scope => scope.view.instanceId === instanceId && scope.view.registeredTools.includes(event.toolName))
                || active.signal.aborted || active.failure)
                return fail(appError('extension_hook_failed', 'extension', 'Extension call has no trusted active owner.'));
              return ok({ instanceId, nativeSessionId, runId: active.runId, sessionId: active.sessionId,
                nativeToolCallId: event.toolCallId, requestBinding: request.requestBinding, scope: active.toolBinding.context.scope });
            },
            onCriticalFailure: (error, instanceId) => { if (record.extensions?.scopes.some(scope => scope.view.instanceId === instanceId) && record.active) this.failToolRun(record, record.active, error); },
          });
          record.extensions = loaded;
          if (loaded.error || !loaded.result) {
            await this.disposeManagedSession(record); return fail(loaded.error ?? appError('extension_load_failed', 'extension', 'Extension registration failed.', true));
          }
          extensionResult = loaded.result;
        }
        const assembledLoader = createRunResourceLoader({ fixedSystemPrompt: loader.data.getSystemPrompt()!, frozen: resources,
          activeToolNames, roleIndex, templates: inputDefinitions?.templates,
          bundleDirectory: join(this.dependencies.resourceBundleRoot ?? join(this.dependencies.agentDir ?? cwd, 'resource-bundles'), resources?.bundleHash ?? ''), extensionResult });
        if (!assembledLoader.ok) return assembledLoader;
        sessionCreationStarted = true;
        const created = await createAgentSession({
          cwd,
          agentDir: this.dependencies.agentDir ?? cwd,
          modelRuntime: runtime,
          model,
          sessionManager: record.manager,
          settingsManager: inMemorySettings(),
          resourceLoader: assembledLoader.data,
          noTools: 'all', tools: policy === 'p2' ? [] : [...this.toolsByName.keys()].filter(name => name !== 'Agent'
            || frozenExtensions?.included.some(item => item.ref.id === 'subagents')),
          customTools: policy !== 'p2' ? [...this.toolsByName.values()].filter(definition => definition.name !== 'Agent'
            && !frozenExtensions?.included.some(item => item.manifest.tools.some(tool => tool.name === definition.name))).map((definition) => toPiTool(
            definition,
            (toolCallId, input, toolSignal) => this.executePiTool(record, definition, toolCallId, input, toolSignal),
            raw => {
              const requests = [...record.active?.toolRequests.values() ?? []].filter(call => call.name === definition.name && call.sdkRaw === raw && !call.invoked);
              if (requests.length === 1) requests[0]!.failureStage = 'sdk_arguments';
            },
          )) : [],
          thinkingLevel: 'off',
        });
        session = created.session; record.session = session;
        record.resourceLoader = assembledLoader.data;
        if (record.extensions) {
          for (const scope of record.extensions.scopes) {
            scope.view.cleanup.sdkSessionCreated = true;
            scope.view.cleanup.shutdownRequired = true;
          }
        }
        const installed = session.getAllTools().map(tool => tool.name);
        const expected = policy === 'p2' ? [] : [...this.toolsByName.keys()].filter(name => name !== 'Agent'
          || frozenExtensions?.included.some(item => item.ref.id === 'subagents'));
        if (installed.length !== expected.length || new Set(installed).size !== installed.length
          || expected.some(name => !installed.includes(name))) {
          throw appError('extension_registration_conflict', 'extension', 'Controlled tool registry mismatch.');
        }
        this.dependencies.sessionSetup?.(session);
        if (record.extensions) {
          const runner = session.extensionRunner, scopes = record.extensions.scopes;
          const commands = scopes.flatMap(scope => scope.view.registeredCommands);
          if (runner.getAllRegisteredTools().length !== scopes.flatMap(scope => scope.view.registeredTools).length
            || runner.getCommandDiagnostics().length || commands.some(name => !runner.getCommand(name)))
            throw appError('extension_registration_conflict', 'extension', 'Controlled command or tool registration conflicts.');
          await session.bindExtensions({ mode: 'print', onError: error => {
            if (['tool_result', 'tool_execution_end'].includes(error.event)) for (const scope of scopes)
              scope.recordHook(error.event as 'tool_result' | 'tool_execution_end', 'sdk_observer_failed');
          } });
          if (signal.aborted) throw appError('agent_cancelled', 'runtime', 'Extension startup was cancelled.');
          for (const scope of scopes) { const activated = scope.activate(); if (!activated.ok) throw activated.error; }
        }
        this.installExecutionHooks(record, session, activeToolNames);
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

      let inputCommandReceipt: import('@flowmate/contracts').SafeConfigSnapshot['inputCommandReceipt'];
      if (inputDefinitions?.command?.kind === 'subagent') {
        const owner = InputCommandOwnerSchema.parse(options?.inputCommandOwner);
        const scope = record.extensions?.scopes.find(scope => scope.view.ref.id === 'subagents');
        const command = session.extensionRunner.getCommand('subagent');
        if (!scope || !command || !scope.view.registeredCommands.includes('subagent')) throw new Error('Subagent command is not registered.');
        const args = inputDefinitions.command.originalText.replace(/^\/subagent\s+/, '');
        scope.beginInputCommand(args, owner);
        try { await command.handler(args, session.extensionRunner.createCommandContext());
          const receipt = scope.finishInputCommand(); if (!receipt || !isDeepStrictEqual(receipt, owner)) throw new Error('Input command has no bound receipt.');
          inputCommandReceipt = InputCommandReceiptSchema.parse({ ...receipt, nativeSessionId, instanceId: scope.view.instanceId,
            originalHash: createHash('sha256').update(inputDefinitions.command.originalText).digest('hex'), role: inputDefinitions.command.requiredRoles[0] });
        } finally { scope.finishInputCommand(); }
      }
      const snapshot = modelRuntimeSnapshot(config, limits, model, authSource);
      record.runtime = runtime;
      record.model = model;
      record.config = structuredClone(config);
      record.policy = policy;
      record.workingDirectory = cwd;
      record.resourceKey = resourceKey;
      record.extensionKey = extensionKey;
      record.resourceLoader ??= loader.data;
      record.sessionInputs = options?.sessionInputs === true;
      replacingSession = false;
      if (signal.aborted) return fail(appError('agent_cancelled', 'runtime', 'Agent 准备已取消。'));
      const taskAgent: AgentConfigFacts | P3AgentConfigFacts | P5ChatAgentConfigFacts = policy !== 'p2' ? {
        policyVersion: 'p3-invoice-tools-v1', nativeSessionId, systemPrompt: session.systemPrompt,
        thinkingLevel: session.thinkingLevel, resourcePolicy: resources ? 'p11-resources-v1' : 'none', historyPolicy: 'memory-only',
        maxContextBytes: RUNTIME_CONFIG.llmPayload.maxWorkspaceContextBytes, maxOutputBytes, maxAssistantContentBytes,
        maxModelCalls: RUNTIME_CONFIG.runBudget.maxModelCalls.workspace,
        maxToolCalls: RUNTIME_CONFIG.runBudget.maxToolCalls, toolTimeoutMs: RUNTIME_CONFIG.runBudget.toolTimeoutMs, sessionRetry: false,
      } : {
        ...(record.sessionInputs ? { policyVersion: 'p5-session-inputs-v1' as const, maxModelCalls: RUNTIME_CONFIG.runBudget.maxModelCalls.chat }
          : { policyVersion: 'p2-invoice-chat-v1' as const, maxModelCalls: 1 as const }), nativeSessionId, systemPrompt: session.systemPrompt,
        thinkingLevel: session.thinkingLevel, resourcePolicy: resources ? 'p11-resources-v1' : 'none', historyPolicy: 'memory-only',
        maxContextBytes, maxOutputBytes, maxAssistantContentBytes, sessionRetry: false,
      };
      const extensionFacts = frozenExtensions ? { extensionPolicy: frozenExtensions.included.length ? frozenExtensions.policyVersion : 'none' as const } : {};
      const agent: AgentConfigFacts | P3AgentConfigFacts | P5ChatAgentConfigFacts | RuntimeAgentConfigFacts = options?.runtimeBudget
        ? { ...taskAgent, ...extensionFacts, ...options.runtimeBudget, policyVersion: 'runtime-v1', taskPolicyVersion: taskAgent.policyVersion } : { ...taskAgent, ...extensionFacts };
      record.snapshot = { ...snapshot, ...(inputDefinitions ? { inputDefinitions: structuredClone(inputDefinitions) } : {}),
        ...(inputCommandReceipt ? { inputCommandReceipt } : {}), historyPolicyVersion: 'p9-native-history-v1', ...(options?.runtimeBudget ? { version: 2 as const } : {}), agent,
        ...(resources ? { resources: Object.freeze(structuredClone(resources)) } : {}),
        ...(frozenExtensions ? { extensions: structuredClone(frozenExtensions), extensionAssembly: record.extensions ? extensionAssembly(record.extensions) : { version: 1 as const, sdkVersion: '0.85.1' as const, instances: [] } } : {}),
        ...(options?.compactionPolicy ? { compactionPolicy: Object.freeze(structuredClone(options.compactionPolicy)) } : {}) };
      if (options?.compactionPolicy && !record.compactionBridge) {
        const bridge = this.installCompaction(record, session);
        if (!bridge.ok) return bridge;
        record.compactionBridge = bridge.data;
      }
      return ok({
        snapshot: record.snapshot,
        execute: (input, executionSignal, observe) => this.execute(record, nativeSessionId, input, executionSignal, observe),
      });
    } catch (error) {
      if (record.extensions) {
        const failure = error && typeof error === 'object' && 'code' in error ? error as ReturnType<typeof appError>
          : appError('extension_load_failed', 'extension', 'Controlled Extension assembly failed.', true);
        for (const scope of record.extensions.scopes) scope.fail(failure);
        await this.disposeManagedSession(record); return fail(failure);
      }
      // createAgentSession can append native model metadata before it throws; do not reuse an uncertain manager.
      if ((replacingSession || sessionCreationStarted) && !record.session) record.unusable = true;
      return fail(record.historyFailure ?? appError('agent_session_init_failed', 'session', 'Agent Session 初始化失败。', true));
    } finally {
      record.preparing = false;
    }
  }

  private publishCompaction(record: SessionRecord, update: Partial<CompactionObservation>): Result<void> {
    const operation = record.compaction;
    if (!operation) return fail(appError('compaction_unavailable', 'runtime', 'No compaction operation is bound.'));
    operation.observation = { ...operation.observation, ...update,
      observationSequence: operation.observation.observationSequence + 1 };
    if (operation.observation.runId !== null) {
      const save = record.active?.input.contextHooks?.compaction;
      let saved: Result<void>;
      try { saved = save ? save({ operationId: operation.observation.operationId, runId: operation.observation.runId,
        sessionId: operation.control.sessionId, nativeSessionId: operation.observation.nativeSessionId,
        reason: operation.observation.reason as 'threshold' | 'overflow', baseline: operation.baseline,
        firstKeptEntryId: operation.firstKeptEntryId, splitTurn: operation.splitTurn,
        observation: structuredClone(operation.observation), calls: structuredClone(operation.calls) })
        : fail(appError('context_binding_unknown', 'runtime', 'Automatic compaction evidence cannot be saved.')); }
      catch { saved = fail(appError('storage_write_failed', 'storage', 'Compaction evidence could not be saved.', true)); }
      if (!saved.ok) {
        operation.failure = saved.error;
        operation.observation = { ...operation.observation, error: saved.error, mayContinue: false };
        if (record.active) this.failToolRun(record, record.active, saved.error);
        return saved;
      }
    }
    try { operation.control.observe(structuredClone(operation.observation)); }
    catch { /* Readonly query retains facts when temporary observation delivery fails. */ }
    return ok(undefined);
  }

  private verifyNativeCompaction(record: SessionRecord): Result<void> {
    const operation = record.compaction;
    if (!operation || !record.compacting) return fail(appError('compaction_unavailable', 'runtime', 'No trusted compaction operation is active.'));
    if (record.historyFailure || record.unusable) return fail(record.historyFailure ?? appError('agent_session_unusable', 'session', 'Native history is unusable.'));
    if (record.receipt?.commitRevision === Number.MAX_SAFE_INTEGER)
      return fail(appError('storage_write_failed', 'storage', 'Conversation history commit revision is exhausted.', false));
    if (operation.control.signal.aborted || operation.scope?.signal.aborted)
      return fail(appError('compaction_cancelled', 'runtime', 'Compaction was cancelled.'));
    if (operation.control.remainingMs() <= 0) return fail(appError('compaction_timeout', 'runtime', 'Compaction deadline expired.'));
    const permission = operation.control.verifyUse();
    if (!permission.ok) return permission;
    const window = record.session?.model?.contextWindow;
    if (!Number.isSafeInteger(window) || window! <= RUNTIME_CONFIG.compaction.reserveTokens)
      return fail(appError('compaction_capacity_exceeded', 'runtime', 'The model window cannot provide required summary headroom.'));
    const snapshot = this.exportSession(operation.observation.nativeSessionId);
    if (!snapshot.ok || !record.lastSavedHistory || !isDeepStrictEqual(snapshot.data, record.lastSavedHistory))
      return fail(appError('session_history_invalid', 'session', 'Native history is not the committed prefix.'));
    return ok(undefined);
  }

  private installCompaction(record: SessionRecord, session: AgentSession) {
    return installNativeCompactionBridge(session, {
      beforeAuto: ({ reason }) => {
        const active = record.active, policy = record.snapshot?.compactionPolicy;
        if (!active || record.compacting || !policy?.autoEnabled || !active.input.contextHooks?.compaction
          || !record.receipt || !record.lastSavedHistory || !record.recoverySeed)
          return fail(appError('compaction_unavailable', 'runtime', 'Automatic compaction has no qualified Run binding.'));
        const valid = this.verifyModelUse(record);
        if (!valid.ok) { this.failToolRun(record, active, valid.error); return valid; }
        const inspected = this.inspectSessionCompaction({ history: record.lastSavedHistory, seed: record.recoverySeed, commit: record.receipt });
        if (!inspected.ok) return inspected;
        const operationId = randomUUID();
        const observation: CompactionObservation = { sessionId: active.sessionId, nativeSessionId: active.nativeSessionId,
          operationId, runId: active.runId, reason, observationSequence: 1, phase: 'preparing', generated: false,
          nativeOutcome: 'pending', entryId: null, saved: null, error: null, stopRequested: active.signal.aborted,
          stopped: false, continuation: 'current-run', mayContinue: false, capacity: inspected.data.capacity,
          usage: { version: 1, source: 'not-requested', reason: 'not-started', sdkValues: null, attempts: 0,
            attemptsComplete: true, costSource: null, updatedAt: now().at },
          tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } };
        record.compaction = { control: { sessionId: active.sessionId, operationId, signal: active.signal,
          remainingMs: () => active.input.remainingRunMs?.() ?? 0,
          maxModelCalls: Math.max(0, record.snapshot!.agent.maxModelCalls - active.modelCallIndex),
          verifyUse: () => this.verifyModelUse(record), observe: () => {} },
          observation, baseline: structuredClone(record.receipt), purposes: [], calls: [], usages: [],
          streams: new Set(), firstKeptEntryId: null, splitTurn: null };
        record.compacting = true;
        const saved = this.publishCompaction(record, {});
        if (!saved.ok) record.compacting = false;
        return saved;
      },
      withSummary: async (scope, run) => {
        const operation = record.compaction;
        const valid = this.verifyNativeCompaction(record);
        if (!valid.ok || !operation || scope.reason !== operation.observation.reason
          || !isDeepStrictEqual(record.receipt, operation.baseline)) {
          const error = !valid.ok ? valid.error : appError('compaction_unavailable', 'runtime', 'Summary is outside its trusted operation.');
          if (operation) operation.failure = error;
          throw error;
        }
        operation.scope = scope;
        const split = scope.preparation.isSplitTurn && scope.preparation.turnPrefixMessages.length > 0;
        operation.firstKeptEntryId = scope.preparation.firstKeptEntryId;
        operation.splitTurn = scope.preparation.isSplitTurn;
        operation.purposes = split ? [...(scope.preparation.messagesToSummarize.length ? ['history' as const] : []), 'turn-prefix'] : ['history'];
        if (operation.calls.length + operation.purposes.length > operation.control.maxModelCalls) {
          operation.scope = undefined;
          operation.failure = appError('agent_model_call_budget', 'runtime', 'The remaining model budget cannot complete this native summary.');
          throw operation.failure;
        }
        const saved = this.publishCompaction(record, {});
        if (!saved.ok) { operation.scope = undefined; throw saved.error; }
        try { return await run(); }
        finally { operation.scope = undefined; }
      },
      onGenerated: result => {
        const operation = record.compaction!;
        const recorded = this.publishCompaction(record, { generated: true });
        if (!recorded.ok) throw recorded.error;
        const valid = this.verifyNativeCompaction(record);
        if (!valid.ok) { operation.failure = valid.error; throw valid.error; }
        if (!operation.scope || result.firstKeptEntryId !== operation.scope.preparation.firstKeptEntryId
          || !Number.isSafeInteger(result.tokensBefore) || result.tokensBefore < 0 || !result.summary.trim()
          || !record.manager.getBranch().some(entry => entry.id === result.firstKeptEntryId)) {
          operation.failure = appError('session_history_invalid', 'session', 'Native summary does not identify a legal saved cut.');
          throw operation.failure;
        }
      },
      onAppend: entryId => {
        const operation = record.compaction;
        const entry = record.manager.getEntry(entryId);
        if (!operation || !operation.observation.generated || !entry || entry.type !== 'compaction'
          || record.receipt?.leafId !== entryId || record.receipt.entryCount !== operation.baseline.entryCount + 1
          || record.receipt.commitRevision !== operation.baseline.commitRevision + 1
          || entry.parentId !== operation.baseline.leafId || !record.lastSavedHistory?.entries.some(value => value.id === entryId)) {
          const error = record.historyFailure ?? appError('storage_write_failed', 'storage', 'Native compaction commit is not confirmed.', true);
          if (operation) operation.failure = error;
          record.unusable = true;
          throw error;
        }
        const recorded = this.publishCompaction(record, { entryId, saved: structuredClone(record.receipt) });
        if (!recorded.ok) throw recorded.error;
      },
      afterAuto: ({ willRetry, sdkWantsContinue }) => {
        const operation = record.compaction, active = record.active;
        if (!operation || !active || operation.observation.runId !== active.runId || !record.compacting)
          return fail(appError('compaction_unavailable', 'runtime', 'Automatic compaction operation is unavailable.'));
        const valid = this.verifyNativeCompaction(record);
        if (!valid.ok) operation.failure ??= valid.error;
        const canonical = record.manager.buildSessionContext().messages;
        const last = canonical.at(-1);
        const expected = willRetry && last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'length')
          ? canonical.slice(0, -1) : canonical;
        if (!isDeepStrictEqual(session.messages, expected))
          operation.failure ??= appError('session_history_invalid', 'session', 'Automatic compaction left an unverified native message projection.');
        else {
          const seeded = this.reseedContext(record, undefined, session.messages);
          if (!seeded.ok) operation.failure ??= seeded.error;
        }
        const view = record.lastSavedHistory && record.recoverySeed && record.receipt
          ? this.inspectSessionCompaction({ history: record.lastSavedHistory, seed: record.recoverySeed, commit: record.receipt }) : null;
        const capacity = view?.ok ? view.data.capacity : operation.observation.capacity;
        const stopped = !session.isCompacting && operation.streams.size === 0;
        const confirmed = operation.observation.generated ? operation.observation.saved !== null
          : isDeepStrictEqual(operation.baseline, record.receipt);
        const budgetAvailable = active.modelCallIndex < record.snapshot!.agent.maxModelCalls;
        // Input admission stays closed after overflow's first agent_end. Core streaming proves a resumed next-assistant loop.
        // Post-agent without queues may finish at the limit; AgentSession.isStreaming spans that post-run work as well.
        const needsModelCall = session.agent.state.isStreaming || !active.admissionClosed || willRetry || sdkWantsContinue;
        if (needsModelCall && !budgetAvailable)
          operation.failure ??= appError('agent_model_call_budget', 'runtime', 'Compaction exhausted the Run model-call budget.');
        if (operation.observation.nativeOutcome === 'pending')
          operation.failure ??= appError('compaction_unavailable', 'runtime', 'Native compaction ended without a completion event; its cause is unknown.');
        const qualified = stopped && confirmed && valid.ok && !active.signal.aborted && capacity.fitsEstimate === true
          && operation.observation.nativeOutcome !== 'cancelled' && (!operation.failure || !operation.observation.generated);
        const mayContinue = qualified && budgetAvailable;
        if (!qualified) operation.failure ??= appError('compaction_capacity_exceeded', 'runtime', 'The Run cannot continue from this compaction result.');
        const saved = this.publishCompaction(record, { phase: stopped ? 'ended' : 'stopping', stopped, capacity, mayContinue,
          nativeOutcome: operation.observation.nativeOutcome === 'pending' ? 'failed' : operation.observation.nativeOutcome,
          stopRequested: active.signal.aborted || operation.observation.stopRequested, error: operation.failure ?? null });
        if (stopped) record.compacting = false;
        if (!saved.ok || !qualified || needsModelCall && !budgetAvailable) {
          const error = !saved.ok ? saved.error : operation.failure!;
          this.failToolRun(record, active, error);
          return fail(error);
        }
        return ok(undefined);
      },
      onEvent: event => {
        if (!record.compacting || !record.compaction || (event.type !== 'compaction_start' && event.type !== 'compaction_end')) return;
        if (event.type === 'compaction_start') this.publishCompaction(record, { phase: 'compacting' });
        else {
          this.publishCompaction(record, { nativeOutcome: event.result ? 'succeeded' : event.aborted ? 'cancelled' : 'failed' });
          if (event.result && record.compaction.observation.saved && record.compaction.observation.runId === null) {
            const seeded = this.reseedContext(record);
            if (!seeded.ok) { record.compaction.failure = seeded.error; record.unusable = true; }
          }
        }
      },
    });
  }

  public async compactSession(nativeSessionId: string, control: NativeCompactionControl): Promise<NativeCompactionOutcome> {
    const record = this.sessions.get(nativeSessionId);
    const emptyCapacity: CompactionCapacity = { tokens: null, source: 'unknown', contextWindow: null, thresholdTokens: null, fitsEstimate: null };
    const inspected = record?.lastSavedHistory && record.recoverySeed && record.receipt
      ? this.inspectSessionCompaction({ history: record.lastSavedHistory, seed: record.recoverySeed, commit: record.receipt }) : null;
    const initial: CompactionObservation = { sessionId: control.sessionId, nativeSessionId, operationId: control.operationId, runId: null,
      reason: 'manual', observationSequence: 1, phase: 'preparing', generated: false, nativeOutcome: 'pending', entryId: null, saved: null,
      error: null, stopRequested: control.signal.aborted, stopped: false, continuation: 'next-run', mayContinue: false,
      capacity: inspected?.ok ? inspected.data.capacity : emptyCapacity,
      usage: { version: 1, source: 'not-requested', reason: 'not-started', sdkValues: null, attempts: 0, attemptsComplete: true,
        costSource: null, updatedAt: new Date().toISOString() },
      tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false } };
    if (!record || record.unusable || record.preparing || record.running || record.compacting || !record.session?.isIdle
      || !record.compactionBridge || !record.receipt || record.recoverySeed?.sessionId !== control.sessionId || this.closed) {
      const error = appError('compaction_unavailable', 'runtime', 'The prepared idle native Session cannot compact.');
      return { observation: { ...initial, phase: 'ended', nativeOutcome: 'failed', stopped: true, error }, stopped: true, cleanupErrors: [] };
    }
    const operation: NonNullable<SessionRecord['compaction']> = { control, observation: initial, baseline: structuredClone(record.receipt),
      purposes: [], calls: [], usages: [], streams: new Set(), firstKeptEntryId: null, splitTurn: null };
    record.compaction = operation; record.compacting = true;
    const session = record.session;
    const cancel = () => {
      this.publishCompaction(record, { phase: 'stopping', stopRequested: true, mayContinue: false });
      session.abortCompaction();
    };
    control.signal.addEventListener('abort', cancel, { once: true });
    try {
      const allowed = this.verifyNativeCompaction(record);
      if (!allowed.ok) { operation.failure = allowed.error; throw allowed.error; }
      await session.compact();
    } catch (error) {
      operation.failure ??= record.historyFailure ?? (control.signal.aborted
        ? appError('compaction_cancelled', 'runtime', 'Compaction was cancelled.')
        : error instanceof Error && (error.message === 'Already compacted' || error.message === 'Nothing to compact (session too small)')
          ? appError('compaction_not_needed', 'runtime', 'There is no eligible history to compact.')
          : appError('compaction_failed', 'runtime', 'Native compaction failed.'));
    } finally {
      control.signal.removeEventListener('abort', cancel);
    }
    await Promise.allSettled([...operation.streams]);
    const stopped = session.isIdle && !session.isCompacting && operation.streams.size === 0;
    let capacity = operation.observation.capacity;
    if (record.lastSavedHistory && record.recoverySeed && record.receipt) {
      const view = this.inspectSessionCompaction({ history: record.lastSavedHistory, seed: record.recoverySeed, commit: record.receipt });
      if (view.ok) capacity = view.data.capacity;
      else operation.failure ??= view.error;
    }
    const qualified = this.verifyNativeCompaction(record);
    if (!qualified.ok) operation.failure ??= qualified.error;
    const unchanged = isDeepStrictEqual(record.receipt, operation.baseline);
    const saved = operation.observation.generated ? operation.observation.saved !== null : unchanged;
    const mayContinue = stopped && saved && capacity.fitsEstimate === true && qualified.ok
      && !control.signal.aborted && operation.observation.nativeOutcome !== 'cancelled';
    if (capacity.fitsEstimate !== true && !operation.failure)
      operation.failure = appError('compaction_capacity_exceeded', 'runtime', 'The compacted context still cannot fit this model window.');
    this.publishCompaction(record, { phase: stopped ? 'ended' : 'stopping', stopped, capacity, mayContinue,
      stopRequested: control.signal.aborted || operation.observation.stopRequested,
      nativeOutcome: operation.observation.nativeOutcome === 'pending' ? control.signal.aborted ? 'cancelled' : 'failed' : operation.observation.nativeOutcome,
      error: operation.failure ?? null });
    if (stopped) record.compacting = false;
    else record.unusable = true;
    return { observation: structuredClone(operation.observation), stopped, cleanupErrors: [] };
  }

  private async forwardSummaryStream(
    record: SessionRecord, session: AgentSession, scope: NativeSummaryScope, nativeStream: AgentStream,
    model: StreamModel, context: StreamContext, options: StreamOptions,
    output: ReturnType<typeof createAssistantMessageEventStream>,
  ): Promise<void> {
    const operation = record.compaction!;
    const callIndex = operation.calls.length;
    const active = operation.observation.runId !== null ? record.active : undefined;
    const callStartedAt = performance.now();
    let trace: PromptTraceReference | undefined;
    let attempt = 0, complete = false;
    let finalMessage: AssistantMessage | undefined;
    let call: SummaryCallEvidence | undefined;
    const signal = AbortSignal.any([operation.control.signal, scope.signal, ...(options?.signal ? [options.signal] : [])]);
    const reject: (error: ReturnType<typeof appError>) => never = error => {
      operation.failure ??= error;
      session.abortCompaction();
      throw error;
    };
    const verify = () => {
      const valid = this.verifyNativeCompaction(record);
      if (!valid.ok) reject(valid.error);
      if (record.compaction !== operation || operation.scope !== scope || !sameModel(record.model, model)
        || context.tools?.length || context.messages.length !== 1 || context.messages[0]?.role !== 'user')
        reject(appError('compaction_unavailable', 'runtime', 'Summary request is outside its trusted native scope.'));
    };
    try {
      verify();
      const purpose = operation.purposes[callIndex];
      if (!purpose || callIndex >= operation.control.maxModelCalls)
        reject(appError('agent_model_call_budget', 'runtime', 'Native summary exceeded its reserved model budget.'));
      const limit = record.snapshot?.agent.maxContextBytes ?? maxContextBytes;
      if (encoder.encode(JSON.stringify(context)).byteLength > limit)
        reject(appError('agent_context_limit', 'runtime', 'Summary request exceeds the configured context byte limit.'));
      const codecResult = preparePayloadCodec(model.api, context, model.input.includes('image'));
      if (!codecResult.ok) reject(codecResult.error);
      const codec = codecResult.data;
      const observed = observedFetch(model.api, this.dependencies.fetch ?? globalThis.fetch) !== undefined;
      const modelCallIndex = active ? ++active.modelCallIndex : callIndex + 1;
      call = { modelCallIndex, purpose: purpose!,
        model: { provider: model.provider, model: model.id, api: model.api, contextWindow: model.contextWindow },
        transport: observed ? 'observed-fetch' : 'not-observable', sdkPayload: null, attempts: [], usage: null, tokens: null };
      operation.calls.push(call);
      if (active) {
        trace = { runId: active.runId, sessionId: active.sessionId, nativeSessionId: active.nativeSessionId,
          callSequence: modelCallIndex, purpose: purpose === 'history' ? 'summary-history' : 'summary-turn-prefix',
          answerRequestSequence: null, operationId: operation.observation.operationId };
        try { this.dependencies.promptTrace?.begin(trace); } catch { /* Diagnostics are optional. */ }
      }
      const prepared = this.publishCompaction(record, {});
      if (!prepared.ok) reject(prepared.error);
      let resources: ReturnType<PiAgentAdapter['resourceRequest']> | undefined;
      const saveResources = (layer?: 'sdk' | 'wire', facts?: ResourceInclusion[]) => {
        const save = active?.input.contextHooks?.recordResourceRequest;
        if (!save || !resources) return;
        if (layer && facts) resources.evidence = refineResourceEvidence(resources.evidence, layer, facts);
        const saved = save(resources.evidence); if (!saved.ok) reject(saved.error);
      };
      if (active?.input.contextHooks?.recordResourceRequest) {
        const sources = purpose === 'history' ? scope.preparation.messagesToSummarize : scope.preparation.turnPrefixMessages;
        const includedBindings: NativeInputContextBinding[] = [], includedToolResults: NativeToolResultContextBinding[] = [];
        const includedNativeContexts: NativeDerivedContextBinding[] = [];
        for (const message of sources) {
          const entry = record.manager.getEntries().find(entry => entry.type === 'message' && entry.message === message);
          if (entry && message.role === 'user') {
            const source = record.contextEntries.get(entry.id);
            if (!source) reject(appError('resource_evidence_conflict', 'runtime', 'Summary input provenance is unavailable.'));
            includedBindings.push(source!);
          } else if (entry && message.role === 'toolResult') {
            const source = active.input.contextHooks!.resolveToolResult({ sessionId: active.sessionId, nativeToolCallId: message.toolCallId });
            if (!source.ok) reject(source.error); else includedToolResults.push(source.data);
          }
        }
        const previous = purpose === 'history' && scope.preparation.previousSummary !== undefined
          ? [...record.manager.getBranch(operation.baseline.leafId ?? undefined)].reverse().find(entry => entry.type === 'compaction' && entry.summary === scope.preparation.previousSummary) : undefined;
        if (purpose === 'history' && scope.preparation.previousSummary !== undefined && !previous)
          reject(appError('resource_evidence_conflict', 'runtime', 'Previous summary provenance is unavailable.'));
        try { resources = this.resourceRequest(record, context, { callSequence: modelCallIndex, includedBindings,
          includedToolResults, includedNativeContexts }, operation.observation.operationId, previous?.id ?? null);
          if (resources.evidence.contentChecks.length === 0 && resources.evidence.referencedBundleHashes.length === 0) resources = undefined;
          saveResources(); }
        catch { reject(operation.failure ?? appError('resource_evidence_conflict', 'runtime', 'Actual summary resource provenance is unavailable.')); }
      }
      const update = (value: Partial<SummaryCallEvidence>) => {
        call = { ...call!, ...value };
        operation.calls[callIndex] = call;
        const saved = this.publishCompaction(record, {});
        if (!saved.ok) reject(saved.error);
      };
      const baseFetch: FetchLike = options?.fetch as FetchLike | undefined ?? this.dependencies.fetch
        ?? ((request, init) => globalThis.fetch(request, init));
      const fetch: FetchLike = async (request, init) => {
        verify();
        const wire = await checkWire(codec, request, init);
        if (!wire.ok) reject(wire.error);
        verify();
        if (resources) saveResources('wire', await checkResourceWire(model.api, request, init, resources.texts));
        const reserved = active?.input.reserveModelRequest?.(); if (reserved && !reserved.ok) reject(reserved.error);
        attempt++;
        if (active) active.attempts++;
        if (attempt > 2) reject(appError('compaction_failed', 'runtime', 'Summary HTTP retry exceeded the frozen provider configuration.'));
        const evidence = { attempt, preparedAt: now().at, enteredAt: null as string | null, responseAt: null as string | null,
          responseStatus: null as number | null, transportErrorCode: null as 'provider_transport_error' | null,
          nativeRequestId: null as string | null, wireInclusion: wire.data.inclusion, wireReason: wire.data.reason };
        update({ attempts: [...call!.attempts, evidence] });
        let pending: Promise<Response>;
        try { pending = baseFetch(request, init); } catch (error) { pending = Promise.reject(error); }
        const enteredAt = now().at;
        update({ attempts: call!.attempts.map(value => value.attempt === attempt ? { ...value, enteredAt } : value) });
        try {
          const response = await pending;
          const responseAt = now().at;
          update({ attempts: call!.attempts.map(value => value.attempt === attempt
            ? { ...value, responseAt, responseStatus: response.status } : value) });
          return response;
        } catch (error) {
          update({ attempts: call!.attempts.map(value => value.attempt === attempt
            ? { ...value, transportErrorCode: 'provider_transport_error' } : value) });
          throw error;
        }
      };
      const onPayload = async (payload: unknown, requestedModel: StreamModel) => {
        verify();
        if (!sameModel(model, requestedModel)) reject(appError('context_binding_conflict', 'runtime', 'Summary payload model changed.'));
        const replacement = await options?.onPayload?.(payload, requestedModel);
        verify();
        const fact = checkPayload(codec, replacement === undefined ? payload : replacement);
        if (!fact.ok) reject(fact.error);
        const sdkPayload = { observedAt: call!.sdkPayload?.observedAt ?? now().at, ...fact.data };
        if (call!.sdkPayload && !isDeepStrictEqual(call!.sdkPayload, sdkPayload))
          reject(appError('context_payload_mismatch', 'runtime', 'Summary payload identity changed.'));
        update({ sdkPayload });
        if (resources) saveResources('sdk', checkResourcePayload(model.api, replacement === undefined ? payload : replacement, resources.texts));
        return replacement;
      };
      const onResponse = async (response: { status: number; headers: Record<string, string> }, requestedModel: StreamModel) => {
        if (!sameModel(model, requestedModel)) reject(appError('context_binding_conflict', 'runtime', 'Summary response model changed.'));
        await options?.onResponse?.(response, requestedModel);
        if (observed) {
          const slot = call!.attempts.at(-1);
          if (!slot || slot.responseStatus !== response.status)
            reject(appError('context_binding_conflict', 'runtime', 'Summary SDK response has no observed HTTP request.'));
          const nativeRequestId = sdkRequestId(response.headers);
          update({ attempts: call!.attempts.map(value => value.attempt === slot!.attempt ? { ...value, nativeRequestId } : value) });
        }
      };
      const timeoutMs = Math.floor(Math.min(record.snapshot!.limits.timeoutMs, operation.control.remainingMs()));
      if (timeoutMs <= 0) reject(appError('compaction_timeout', 'runtime', 'Summary deadline elapsed before dispatch.'));
      const stream = await nativeStream(model, context, { ...options, signal, timeoutMs,
        fetch: observedFetch(model.api, fetch), maxRetries: record.config!.parameters.maxRetries,
        maxRetryDelayMs: record.config!.parameters.maxRetryDelayMs, onPayload, onResponse });
      for await (const event of stream) {
        const message = event.type === 'done' ? event.message : event.type === 'error' ? event.error : 'partial' in event ? event.partial : undefined;
        if (message && (contentBytes(message) > maxAssistantContentBytes || encoder.encode(textFrom(message)).byteLength > maxOutputBytes)) {
          operation.failure ??= appError('agent_content_limit', 'runtime', 'Native summary output exceeds the configured byte limit.');
          session.abortCompaction();
        }
        if (event.type === 'done' || event.type === 'error') finalMessage = message;
        else if (!operation.failure) output.push(event);
      }
      finalMessage ??= await stream.result();
      complete = !signal.aborted && finalMessage.stopReason === 'stop';
      const normalized = normalizeUsage(finalMessage, { attempts: attempt, complete }, record.config!.connection === undefined);
      if (normalized.usage.version !== 1) reject(appError('compaction_failed', 'runtime', 'Summary usage format is incompatible.'));
      update({ usage: normalized.usage, tokens: normalized.tokens });
      const callUsage = { callSequence: call.modelCallIndex, usage: normalized.usage, tokens: normalized.tokens, complete };
      operation.usages.push(callUsage);
      if (active) active.modelCallUsages.push(callUsage);
      const totals = aggregateUsage(operation.usages, operation.calls.reduce((sum, value) => sum + value.attempts.length, 0),
        operation.usages.every(value => value.complete), now().at);
      this.publishCompaction(record, totals);
      if (!complete) operation.failure ??= appError(signal.aborted ? 'compaction_cancelled' : 'compaction_failed',
        'runtime', 'Native summary did not complete safely.');
      if (finalMessage.content.some(part => part.type === 'toolCall'))
        operation.failure ??= appError('compaction_failed', 'runtime', 'Native summary attempted a tool call.');
      if (operation.failure) throw operation.failure;
      verify();
      output.push({ type: 'done', reason: 'stop', message: finalMessage });
      output.end(finalMessage);
    } catch {
      operation.failure ??= appError(signal.aborted ? 'compaction_cancelled' : 'compaction_failed', 'runtime', 'Native summary request failed.');
      const message = systemError(operation.failure, model, signal.aborted ? 'aborted' : 'error');
      output.push({ type: 'error', reason: message.stopReason as 'aborted' | 'error', error: message });
      output.end(message);
    } finally {
      if (active && call) active.modelCalls.push({ callSequence: call.modelCallIndex,
        durationMs: Math.max(0, performance.now() - callStartedAt), complete });
      if (trace) try { this.dependencies.promptTrace?.end(trace); } catch { /* Diagnostics are optional. */ }
    }
  }

  private wrapStream(record: SessionRecord, session: AgentSession, nativeStream: AgentStream): AgentStream {
    return (model, context, options) => {
      const scope = record.compacting ? record.compaction?.scope : undefined;
      if (scope) {
        const output = createAssistantMessageEventStream();
        const worker = this.forwardSummaryStream(record, session, scope, nativeStream, model, context, options, output);
        record.compaction!.streams.add(worker);
        void worker.then(() => record.compaction!.streams.delete(worker), () => record.compaction!.streams.delete(worker));
        return output;
      }
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
      if (active.modelCallIndex >= modelCallLimit) {
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
      active.modelCallIndex += 1;
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
      let primary = [...includedBindings].reverse().find(source => source.originRunId === active.runId && source.snapshotId !== null);
      if (!primary) {
        const compacted = includedNativeContexts.filter(source => source.entryType === 'compaction');
        for (const entry of [...record.manager.getBranch()].reverse()) {
          const source = record.contextEntries.get(entry.id);
          if (!source || source.originRunId !== active.runId || source.inputId === null || source.snapshotId === null
            || !active.inputs.get(source.inputId)?.started) continue;
          if (compacted.some(value => {
            const summary = record.manager.getEntry(value.nativeEntryId);
            if (summary?.type !== 'compaction') return false;
            const prefix = record.manager.getBranch(summary.parentId ?? undefined);
            const original = prefix.findIndex(value => value.id === entry.id), cut = prefix.findIndex(value => value.id === summary.firstKeptEntryId);
            return original >= 0 && cut > original;
          })) { primary = source; break; }
        }
      }
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
      remainingModelCalls: Math.max(0, maxModelCalls - active.modelCallIndex),
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

  private verifyModelUse(record: SessionRecord, settledCompactionFailure = false): Result<void> {
    const active = record.active;
    if (!active) return fail(appError('agent_unbound_execution', 'runtime', 'Agent 请求缺少有效 Run 绑定。'));
    const registry = this.verifyChildRegistry(record);
    if (!registry.ok) return registry;
    const unavailable = record.extensions?.scopes.find(scope => scope.view.state !== 'active' || scope.view.admission !== 'open');
    if (unavailable) return fail(unavailable.view.lastError ?? appError('extension_hook_failed', 'extension', 'Extension execution admission is closed.'));
    if (record.historyFailure) return fail(record.historyFailure);
    if (record.unusable) return fail(appError('agent_session_unusable', 'session', 'Conversation cannot be continued.'));
    if (active.failure && !settledCompactionFailure) return fail(active.failure);
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

  private verifyChildRegistry(record: SessionRecord): Result<void> {
    if (!record.snapshot || !('subagent' in record.snapshot)) return ok(undefined);
    const allowed = record.active?.toolBinding?.context.scope.allowedTools, session = record.session;
    const registered = session?.getAllTools().map(tool => tool.name), visible = session?.getActiveToolNames();
    if (!allowed || !registered || !visible || registered.length !== allowed.length || visible.length !== allowed.length
      || new Set(registered).size !== registered.length || new Set(visible).size !== visible.length
      || registered.some(name => !allowed.includes(name)) || visible.some(name => !allowed.includes(name))
      || registered.some(name => !['PURE', 'READ'].includes(this.toolsByName.get(name)?.effect ?? '') || name === 'Agent'))
      return fail(appError('subagent_tool_denied', 'tool', 'The live child tool registry exceeds its frozen read-only assembly.'));
    return ok(undefined);
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
        const prior = active.modelCallUsages.findIndex(item => item.callSequence === active.modelCallIndex);
        const usage: ModelCallUsage = { callSequence: active.modelCallIndex, usage: normalized.usage, tokens: normalized.tokens,
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
        // Pi 0.85.1 awaits this listener after saving the generating assistant.
        // Abort alone still enters its tool batch and appends an unowned result.
        // Reject the awaited event so Pi takes its actual aborted-assistant path.
        throw new Error(observed.error.code);
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

  private installExecutionHooks(record: SessionRecord, session: AgentSession, activeToolNames: readonly string[]): void {
    const beforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, hookSignal) => {
      const registry = this.verifyChildRegistry(record);
      if (!registry.ok) {
        if (record.active) this.failToolRun(record, record.active, registry.error);
        return { block: true, reason: registry.error.message };
      }
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
      if (changed) {
        const error = appError('extension_hook_failed', 'extension', 'The SDK before hook changed the original tool request.');
        if (record.extensions) {
          for (const scope of record.extensions.scopes) scope.fail(error);
          if (record.active) this.failToolRun(record, record.active, error);
        }
        result = { block: true, reason: error.message };
      }
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
    // The controlled resource loader has no context handlers. Pi's empty
    // ExtensionRunner still clones messages; preserve the saved native identities.
    session.agent.transformContext = async messages => messages;
    session.setActiveToolsByName([...activeToolNames]);
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
  }

  private withDelegateCall(record: SessionRecord, call: DelegateExecution, invokeProduct: () => Promise<AgentToolResult<unknown>>): Promise<AgentToolResult<unknown>> {
    const calls = record.delegations ??= new Map(), id = call.ticket.nativeToolCallId, existing = calls.get(id);
    if (existing) {
      if (!isDeepStrictEqual(existing.call.ticket, call.ticket) || !isDeepStrictEqual(existing.call.arguments, call.arguments))
        throw appError('subagent_identity_conflict', 'runtime', 'The native delegation identity has different arguments.');
      return existing.promise;
    }
    // Invoke on the next microtask so the real SDK context is installed before Executor enters the product tool.
    const promise = Promise.resolve().then(invokeProduct).finally(() => { if (calls.get(id)?.promise === promise) calls.delete(id); });
    calls.set(id, { call, promise }); return promise;
  }

  public async invokeSubagent(context: ToolExecutionContext, args: DelegateArgs): Promise<NativeToolOutput> {
    const binding = context.requestBinding, record = binding && this.sessions.get(binding.nativeSessionId);
    const captured = record?.delegations?.get(context.nativeToolCallId), ticket = captured?.call.ticket;
    const reject = () => new ToolExecutionFailure(appError('subagent_origin_invalid', 'runtime', 'Delegation has no matching live SDK call.'));
    if (!record || !captured || !ticket || !record.active || record.active.failure || context.signal.aborted
      || context.runId !== ticket.runId || context.sessionId !== ticket.sessionId
      || !isDeepStrictEqual(context.requestBinding, ticket.requestBinding) || !isDeepStrictEqual(context.scope, ticket.scope)
      || !isDeepStrictEqual(DelegateArgsSchema.parse(captured.call.arguments), DelegateArgsSchema.parse(args))
      || !record.extensions?.scopes.some(scope => scope.view.instanceId === ticket.instanceId
        && scope.view.ref.id === 'subagents' && scope.view.state === 'active' && scope.view.admission === 'open')) throw reject();
    const saved = record.active.toolBinding?.queryCall?.(context.nativeToolCallId);
    if (!saved?.ok || saved.data.status !== 'running' || saved.data.toolName !== 'Agent' || !this.subagentCallbacks) throw reject();
    if (!Number.isFinite(context.deadlineAt)) throw reject();
    captured.control = this.managedChildControl(record, captured.call, saved.data.toolCallId, context.deadlineAt!, context.signal,
      error => { captured.childError = error; });
    try {
      const [, , , update, nativeContext] = captured.call.nativeArguments;
      const raw = await captured.call.rawTool.execute(context.nativeToolCallId, DelegateArgsSchema.parse(args), context.signal, update, nativeContext);
      const output = NativeToolOutputSchema.parse(JSON.parse(JSON.stringify({ content: raw.content, details: raw.details })));
      if (captured.childError || output.details && typeof output.details === 'object' && Reflect.get(output.details, 'status') === 'error') throw new ToolExecutionFailure(captured.childError
        ?? appError('subagent_execution_failed', 'runtime', 'The plugin reported a failed child.'), output);
      return output;
    } catch (error) {
      if (error instanceof ToolExecutionFailure) throw error;
      throw new ToolExecutionFailure(error instanceof Error && error.message === 'subagent_busy'
        ? appError('subagent_busy', 'runtime', 'Four child executions are already owned.', true)
        : error && typeof error === 'object' && 'code' in error ? error as import('@flowmate/contracts').AppError
        : appError('subagent_execution_failed', 'runtime', 'The managed child execution failed.'));
    }
  }

  private managedChildControl(parent: SessionRecord, call: DelegateExecution, originToolCallId: number, delegateDeadlineAt: number, signal: AbortSignal,
    onError: (error: import('@flowmate/contracts').AppError) => void): ManagedChildControl {
    const args = DelegateArgsSchema.parse(call.arguments);
    const definition = parent.active?.input.inputDefinitions?.roles.find(role => role.id === args.subagent_type);
    if (!definition) throw appError('subagent_tool_denied', 'tool', 'Role is absent from the frozen parent index.');
    return { role: { name: definition.id, description: definition.description, extensions: false, skills: false,
      allowedSubagents: [], systemPrompt: definition.systemPrompt, promptMode: 'replace', inheritContext: false,
      runInBackground: false, isolated: true, persistSession: false, outputTranscript: false, isolation: 'off' },
      beforeCreate: async pluginAgentId => {
        const ticket = call.ticket;
        const prepared = await this.subagentCallbacks!.prepare({ parentRunId: ticket.runId, parentSessionId: ticket.sessionId,
          parentNativeSessionId: ticket.nativeSessionId, originToolCallId, parentNativeToolCallId: ticket.nativeToolCallId,
          extensionInstanceId: ticket.instanceId, requestBinding: ticket.requestBinding, delegateDeadlineAt, delegateSignal: signal }, pluginAgentId, DelegateArgsSchema.parse(call.arguments));
        if (!prepared.ok) { onError(prepared.error); throw prepared.error; }
        const child = prepared.data, record = this.sessions.get(child.childNativeSessionId);
        if (record) record.subagentOwner = { childRunId: child.childRunId, pluginAgentId };
        let outcome: AgentNativeOutcome | undefined;
        let settled = false;
        const settle = async (error: unknown) => {
          if (settled) throw appError('subagent_identity_conflict', 'runtime', 'The managed child has already settled.');
          settled = true;
          outcome ??= this.notStarted(child.childNativeSessionId,
            error && typeof error === 'object' && 'code' in error ? error as import('@flowmate/contracts').AppError
              : appError('subagent_execution_failed', 'runtime', 'Child creation or attachment failed.'));
          const cleanup = record ? await this.disposeManagedSession(record) : { stopped: true, errors: [] };
          outcome = { ...outcome, stopped: outcome.stopped && cleanup.stopped,
            cleanupErrors: [...outcome.cleanupErrors, ...cleanup.errors] };
          if (outcome.error) onError(outcome.error);
          const finished = await this.subagentCallbacks!.finish(child.childRunId, outcome);
          if (!finished.ok) { onError(finished.error); throw finished.error; }
        };
        try {
        if (!record || !record.historyWriter || !record.receipt || record.recoverySeed?.sessionId !== child.childSessionId
          || !parent.model || !parent.runtime || !parent.config || parent.active?.runId !== child.parentRunId)
          throw appError('subagent_origin_invalid', 'runtime', 'Child history or parent model is not bound.');
        const cwd = child.config.workingDirectory ?? parent.workingDirectory!;
        const loader = createRunResourceLoader({ fixedSystemPrompt: child.config.agent.systemPrompt,
          frozen: child.input.resources ?? null, activeToolNames: child.scope.allowedTools, visibleSkillRefs: child.input.visibleSkillRefs, child: true,
          bundleDirectory: join(this.dependencies.resourceBundleRoot ?? join(this.dependencies.agentDir ?? cwd, 'resource-bundles'), child.input.resources?.bundleHash ?? '') });
        if (!loader.ok) throw loader.error;
        const definitions = child.scope.allowedTools.map(name => this.toolsByName.get(name));
        if (definitions.some(tool => !tool || !['PURE', 'READ'].includes(tool.effect) || tool.name === 'Agent')
          || new Set(child.scope.allowedTools).size !== child.scope.allowedTools.length)
          throw appError('subagent_tool_denied', 'tool', 'Child registry would exceed the read-only scope.');
        return { promptText: child.input.promptText!, options: { cwd, agentDir: this.dependencies.agentDir ?? cwd,
          modelRuntime: parent.runtime, model: parent.model, sessionManager: record.manager,
          settingsManager: inMemorySettings(), resourceLoader: loader.data, thinkingLevel: 'off', noTools: 'all',
          tools: [...child.scope.allowedTools], customTools: definitions.map(definition => toPiTool(definition!,
            (id, input, toolSignal) => this.executePiTool(record, definition!, id, input, toolSignal), raw => {
              const requests = [...record.active?.toolRequests.values() ?? []].filter(call => call.name === definition!.name && call.sdkRaw === raw && !call.invoked);
              if (requests.length === 1) requests[0]!.failureStage = 'sdk_arguments';
            })) },
          attach: async session => {
            record.session = session;
            this.dependencies.sessionSetup?.(session);
            const installed = session.getAllTools().map(tool => tool.name);
            if (session.sessionManager !== record.manager || session.sessionManager.getSessionId() !== child.childNativeSessionId
              || !session.model || !sameModel(session.model, parent.model!)
              || !session.systemPrompt.startsWith(`${loader.data.getSystemPrompt()}\n`)
              || installed.length !== child.scope.allowedTools.length || new Set(installed).size !== installed.length
              || installed.some(name => !child.scope.allowedTools.includes(name))
              || session.extensionRunner.getAllRegisteredTools().length || session.extensionRunner.getCommandDiagnostics().length)
              throw appError('subagent_tool_denied', 'tool', 'The actual child assembly differs from its frozen registry.');
            record.runtime = parent.runtime; record.model = parent.model; record.config = structuredClone(parent.config!);
            record.snapshot = { ...child.config, agent: { ...child.config.agent, systemPrompt: session.systemPrompt } };
            record.policy = 'p3'; record.workingDirectory = cwd; record.resourceLoader = loader.data;
            record.resourceKey = child.input.resources?.bundleHash ?? null; record.sessionInputs = true;
            this.installExecutionHooks(record, session, child.scope.allowedTools);
            const seeded = this.reseedContext(record); if (!seeded.ok) throw seeded.error;
            const started = child.start(session.systemPrompt); if (!started.ok) throw started.error;
            const originalPrompt = session.prompt.bind(session);
            let prompted = false;
            session.prompt = async (text, options) => {
              if (prompted || text !== child.input.promptText || options !== undefined)
                throw appError('subagent_identity_conflict', 'runtime', 'The managed child accepts its original prompt exactly once.');
              prompted = true;
              outcome = await this.execute(record, child.childNativeSessionId, child.input,
                AbortSignal.any([child.signal, signal]), child.observe, () => originalPrompt(text, { expandPromptTemplates: false }));
              if (outcome.error) throw outcome.error;
            };
          },
          settle: ({ error }) => settle(error) };
        } catch (error) { await settle(error); throw error; }
      } };
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
    const operation = ['read', 'grep', 'find', 'ls'].includes(definition.name) ? definition.name as 'read' | 'grep' | 'find' | 'ls' : null;
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    let managed: import('./resources/loader.ts').ManagedReadFile[] = [];
    if (operation && active.input.contextHooks?.recordResourceRead) {
      try { managed = record.resourceLoader?.filesForOperation(typeof args.path === 'string' ? args.path : '.', record.workingDirectory!, operation) ?? []; }
      catch { const error = appError('resource_bundle_unavailable', 'storage', 'The managed tool target changed.', true);
        this.failToolRun(record, active, error); throw error; }
    }
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
    if (result.status === 'succeeded' && (definition.name === 'list_skill_resources' || definition.name === 'read_skill_resource')) {
      const owner = binding.queryCall?.(nativeToolCallId);
      const verified = active.input.resources && record.resourceLoader
        ? verifySkillToolOutput(active.input.resources, record.resourceLoader, definition.name, input, result.data) : null;
      if (!verified?.ok || !owner?.ok || !request.requestBinding || !active.input.contextHooks?.recordResourceRead) {
        const failure = verified && !verified.ok ? verified.error
          : appError('resource_evidence_conflict', 'runtime', 'Original Skill read identity is unavailable.');
        this.failToolRun(record, active, failure); throw failure;
      }
      const deliveredHash = resourceTextHash(JSON.stringify(request.feedback!.content));
      const receipts = verified.data.map(file => ({ toolCallId: owner.data.toolCallId, nativeToolCallId,
        requestSequence: request.requestBinding!.requestSequence, ref: file.ref, bundleHash: active.input.resources!.bundleHash,
        path: file.path, fileHash: file.fileHash, deliveredHash, operation: definition.name as 'list_skill_resources' | 'read_skill_resource',
        fullBody: file.fullBody, nativeEntryId: null, at: now().at }));
      request.resourceReads = receipts;
      for (const receipt of receipts) {
        const saved = active.input.contextHooks.recordResourceRead(receipt);
        if (!saved.ok) { this.failToolRun(record, active, saved.error); throw saved.error; }
      }
    }
    if (getNativeToolParameters(definition) || definition.name === 'Agent') {
      const native = NativeToolOutputSchema.safeParse(result.data);
      if (native.success) {
        if (result.status !== 'succeeded') active.nativeFailures.add(nativeToolCallId);
        request.feedback = { content: native.data.content, details: native.data.details };
        if (result.status === 'succeeded' && operation && managed.length) {
          const owner = binding.queryCall?.(nativeToolCallId);
          if (!owner?.ok || !request.requestBinding) {
            const error = appError('resource_evidence_conflict', 'runtime', 'Original managed read identity is unavailable.');
            this.failToolRun(record, active, error); throw error;
          }
          try {
            record.resourceLoader!.filesForOperation(typeof args.path === 'string' ? args.path : '.', record.workingDirectory!, operation);
            const text = native.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            if (operation === 'read') for (const file of managed) {
              const verified = verifyManagedReadOutput(file, args, text);
              if (!verified.ok) { this.failToolRun(record, active, verified.error); throw verified.error; }
            }
            const deliveredHash = resourceTextHash(JSON.stringify(native.data.content));
            request.resourceReads = managed.filter(file => nativeFileResultIncludes(operation, file.relativePath, text)).map(file => ({
              toolCallId: owner.data.toolCallId, nativeToolCallId, requestSequence: request.requestBinding!.requestSequence,
              ref: file.ref, bundleHash: active.input.resources!.bundleHash, path: file.path, fileHash: file.fileHash, deliveredHash, operation,
              fullBody: operation !== 'read' ? false : file.text === null ? null : text === file.text,
              nativeEntryId: null, at: now().at,
            }));
            for (const receipt of request.resourceReads) {
              const saved = active.input.contextHooks!.recordResourceRead!(receipt);
              if (!saved.ok) { this.failToolRun(record, active, saved.error); throw saved.error; }
            }
          } catch (error) {
            if (!active.failure) this.failToolRun(record, active, appError('resource_bundle_unavailable', 'storage', 'Managed content could not be verified after reading.', true));
            throw error;
          }
        }
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

  private resourceRequest(record: SessionRecord, context: StreamContext,
    binding: Pick<RequestContextBinding, 'callSequence' | 'includedBindings' | 'includedToolResults' | 'includedNativeContexts'>,
    compactionOperationId: string | null = null, previousSummaryEntryId: string | null = null): {
    evidence: ResourceRequestEvidence; texts: ResourcePayloadText[];
  } {
    const checks: ResourceContentEvidence[] = [], texts: ResourcePayloadText[] = [], bundles = new Set<string>();
    const add = (check: Omit<ResourceContentEvidence, 'expectedTextHash' | 'sdkInclusion' | 'wireInclusion' | 'reason'>,
      expected: ResourcePayloadText) => {
      if (checks.some(item => resourceContentKey(item) === resourceContentKey(check))) return;
      checks.push({ ...check, expectedTextHash: expected.text === null ? null : resourceTextHash(expected.text),
        sdkInclusion: 'unknown', wireInclusion: 'unknown', reason: expected.text === null ? 'derived-source-only' : 'awaiting_sdk_payload' });
      texts.push(expected);
    };
    const derivedIds = [...binding.includedNativeContexts.map(source => source.nativeEntryId), ...(previousSummaryEntryId ? [previousSummaryEntryId] : [])];
    const compacted = derivedIds.flatMap(nativeEntryId => {
      const entry = record.manager.getEntry(nativeEntryId); if (entry?.type !== 'compaction') return [];
      const prefix = record.manager.getBranch(entry.parentId ?? undefined), cut = prefix.findIndex(item => item.id === entry.firstKeptEntryId);
      return cut > 0 ? [{ nativeEntryId, covered: new Set(prefix.slice(0, cut).map(item => item.id)) }] : [];
    });
    const addDerived = (ref: ResourceRef, bundleHash: string, path: string, originalEntryId: string) => {
      for (const source of compacted) if (source.covered.has(originalEntryId)) {
        bundles.add(bundleHash);
        add({ ref, scope: 'derived-source', path, nativeEntryId: source.nativeEntryId }, { role: 'user', text: null });
      }
    };
    const frozen = record.active?.input.resources;
    if (frozen?.prompt && compactionOperationId === null) {
      const text = record.resourceLoader?.bodyFor(frozen.prompt);
      if (text === undefined || text === null) throw new Error('Fixed business Prompt is unavailable.');
      add({ ref: frozen.prompt, scope: 'business-prompt', path: 'prompt.md', nativeEntryId: null }, { role: 'system', text });
    }
    for (const skill of record.resourceLoader?.getSkills().skills ?? []) {
      const ref = frozen?.discoveredSkills.find(ref => ref.id === skill.name);
      if (!ref || skill.disableModelInvocation || compactionOperationId !== null) continue;
      const text = formatSkillsForPrompt([skill], 'read').match(/  <skill>[\s\S]*?  <\/skill>/)?.[0];
      if (!text) throw new Error('Native Skill index is unavailable.');
      add({ ref, scope: 'skill-index', path: 'SKILL.md', nativeEntryId: null }, { role: 'system', text });
    }
    if (compactionOperationId === null) for (const entry of frozen?.skillIndex?.entries ?? []) {
      const text = record.resourceLoader?.readinessFor(entry.ref);
      if (!text) throw new Error('Fixed Skill readiness is unavailable.');
      add({ ref: entry.ref, scope: 'skill-readiness', path: null, nativeEntryId: null }, { role: 'system', text });
    }
    for (const receipt of record.recoverySeed?.resourceExpansions ?? []) {
      const source = binding.includedBindings.find(source => source.nativeEntryId === receipt.nativeEntryId && source.inputId === receipt.inputId);
      if (source) {
        const entry = record.manager.getEntry(receipt.nativeEntryId);
        const text = entry?.type === 'message' && entry.message.role === 'user' ? typeof entry.message.content === 'string'
          ? entry.message.content : entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : null;
        if (text === null || resourceTextHash(text) !== receipt.expandedTextHash) throw new Error('Original expanded input is unavailable.');
        bundles.add(receipt.bundleHash);
        add({ ref: receipt.skill, scope: 'expanded-body', path: 'SKILL.md', nativeEntryId: receipt.nativeEntryId }, { role: 'user', text, contains: compactionOperationId !== null });
      } else addDerived(receipt.skill, receipt.bundleHash, 'SKILL.md', receipt.nativeEntryId);
    }
    const reads = [...(record.recoverySeed?.resourceReads ?? []),
      ...[...(record.active?.toolRequests.values() ?? [])].flatMap(request => request.resourceReads ?? [])];
    for (const receipt of reads) {
      if (receipt.nativeEntryId === null) continue;
      if (!binding.includedToolResults.some(source => source.toolCallId === receipt.toolCallId && source.nativeToolCallId === receipt.nativeToolCallId)) {
        addDerived(receipt.ref, receipt.bundleHash, receipt.path, receipt.nativeEntryId); continue;
      }
      const entry = record.manager.getEntry(receipt.nativeEntryId);
      if (entry?.type !== 'message' || entry.message.role !== 'toolResult'
        || resourceTextHash(JSON.stringify(entry.message.content)) !== receipt.deliveredHash) throw new Error('Original resource output is unavailable.');
      const text = entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      bundles.add(receipt.bundleHash);
      add({ ref: receipt.ref, scope: 'tool-output', path: receipt.path, nativeEntryId: receipt.nativeEntryId },
        compactionOperationId === null ? { role: 'tool', text, toolCallId: receipt.nativeToolCallId } : { role: 'user', text, contains: true });
    }
    return { texts, evidence: ResourceRequestEvidenceSchema.parse({ purpose: compactionOperationId === null ? 'answer' : 'compaction', callSequence: binding.callSequence,
      compactionOperationId, bundleHash: compactionOperationId === null ? frozen?.bundleHash ?? null : null, referencedBundleHashes: [...bundles],
      systemPromptHash: resourceTextHash(context.systemPrompt ?? ''), inputIds: binding.includedBindings.flatMap(source => source.inputId === null ? [] : [source.inputId]),
      toolCallIds: binding.includedToolResults.map(source => source.toolCallId), contentChecks: checks, at: now().at }) };
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
    const callSequence = active.modelCallIndex;
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
    let resources: ReturnType<PiAgentAdapter['resourceRequest']> | undefined;
    const saveResources = (layer?: 'sdk' | 'wire', facts?: ResourceInclusion[]) => {
      const save = active.input.contextHooks?.recordResourceRequest;
      if (!resources || !save) return;
      if (layer && facts) resources.evidence = refineResourceEvidence(resources.evidence, layer, facts);
      const saved = save(resources.evidence);
      if (!saved.ok) { failStream(saved.error); throw new Error(saved.error.code); }
    };
    if (requestBinding && active.input.contextHooks?.recordResourceRequest) {
      try { resources = this.resourceRequest(record, context, requestBinding);
        if (resources.evidence.bundleHash === null && resources.evidence.contentChecks.length === 0 && resources.evidence.referencedBundleHashes.length === 0) resources = undefined;
        saveResources(); }
      catch { if (!active.failure) failStream(appError('resource_evidence_conflict', 'runtime', 'Actual resource request provenance is unavailable.')); return; }
    }
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
      if (resources) saveResources('wire', await checkResourceWire(model.api, request, init, resources.texts));
      const toolDefinitions = requestBinding ? await wireToolDefinitions(model.api, request, init) : undefined;
      const attempt = ++localAttempt;
      if (requestBinding) requireEvidence({ kind: 'attempt-prepared', evidence: { attempt, preparedAt: now().at,
        enteredAt: null, responseAt: null, responseStatus: null, transportErrorCode: null, nativeRequestId: null,
        wireInclusion: wire.data.inclusion, wireReason: wire.data.reason,
        ...(toolDefinitions === undefined ? {} : { toolDefinitions }) } });
      const reserved = active.input.reserveModelRequest?.();
      if (reserved && !reserved.ok) { this.failToolRun(record, active, reserved.error); throw new Error(reserved.error.code); }
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
        const toolDefinitions = deliveredToolDefinitions(model.api, outgoing);
        const fact = { kind: 'sdk-payload' as const, at: sdkPayloadFact?.at ?? now().at, ...inclusion.data,
          ...(toolDefinitions === undefined ? {} : { toolDefinitions }) };
        requireEvidence(fact); sdkPayloadFact ??= fact;
      }
      if (resources) saveResources('sdk', checkResourcePayload(model.api, outgoing, resources.texts));
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
          // Fixed SDK owns its one compact-and-continue recovery; defer only this actual native overflow.
          const recoverable = session.autoCompactionEnabled && !active.signal.aborted && !active.failure
            && event.error.provider === model.provider && event.error.model === model.id
            && isContextOverflow(event.error, model.contextWindow);
          if (!recoverable) {
            active.failure ??= event.error.stopReason === 'length'
              ? appError('agent_incomplete_response', 'runtime', 'Agent 回复因输出限制提前结束。')
              : this.providerError(active, event.error);
            active.stopReason = active.failure.code;
          }
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
    try {
      const reference = { runId: active.runId, sessionId: active.sessionId, nativeSessionId: active.nativeSessionId, callSequence };
      this.dependencies.promptTrace?.append(reference, { at: now().at, event: 'native_terminal',
        summary: `Native model stream settled · stop=${safeTraceStopReason(finalMessage?.stopReason) ?? 'other'}`, truncated: false });
      this.dependencies.promptTrace?.end(reference);
    } catch { /* Diagnostics are optional. */ }
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
      callSequence: active.modelCallIndex, purpose: 'answer', answerRequestSequence: active.callSequence,
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

  public requestSubagentStop(input: { childRunId: number; childNativeSessionId: string; pluginAgentId: string }): Result<void> {
    const record = this.sessions.get(input.childNativeSessionId);
    if (!record || record.subagentOwner?.childRunId !== input.childRunId || record.subagentOwner.pluginAgentId !== input.pluginAgentId
      || record.active && record.active.runId !== input.childRunId)
      return fail(appError('subagent_identity_conflict', 'runtime', 'Stop request has no matching child execution owner.'));
    if (record.active) this.stop(record, record.active);
    return ok(undefined);
  }

  private providerError(active: ActiveExecution, error: unknown, transportFailed = false): ReturnType<typeof appError> {
    if (active.signal.aborted) return appError('agent_cancelled', 'runtime', 'Agent 执行已取消。');
    if (active.responseStatus === 401 || active.responseStatus === 403) return appError('provider_auth_failed', 'provider', 'Provider 认证失败。');
    if (active.responseStatus === 402) return appError('provider_billing_failed', 'provider', 'Provider 计费或余额不足。');
    if (active.responseStatus === 429) return appError('provider_rate_limited', 'provider', 'Provider 请求受到限流。', true);
    if (active.responseStatus !== null && active.responseStatus >= 400 && active.responseStatus < 500) {
      return appError('provider_request_rejected', 'provider', `Provider 拒绝了 Agent 请求（HTTP ${active.responseStatus}）。`);
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
    invokePrompt?: () => Promise<void>,
  ): Promise<AgentNativeOutcome> {
    const session = record.session;
    const model = record.model;
    if (!session || !model || !record.snapshot || !record.config || record.unusable) {
      return this.notStarted(nativeSessionId, appError('agent_session_unusable', 'session', 'Agent Session 不能继续执行。'));
    }
    if (record.preparing || record.running || record.compacting || !session.isIdle)
      return this.notStarted(nativeSessionId, appError('agent_session_busy', 'session', 'Agent Session 正在执行。'));
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
      callSequence: 0, modelCallIndex: 0, turnOrdinal: 0, attempts: 0, responseStatus: null,
      responseStarted: false, complete: false, wireMaxTokens: null,
      text: '', textBytes: 0, assistantContentBytes: 0, failure: null,
      promptEntered: true, streams: new Set(), abortPromise: null, stopReason: 'pending',
    };
    record.running = true;
    record.active = active;
    session.setAutoCompactionEnabled(!!record.compactionBridge && record.snapshot.compactionPolicy?.autoEnabled === true
      && !!input.contextHooks?.compaction && !!record.memory && !!record.receipt && !!record.recoverySeed);
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
          const dispatchedInput = { inputId: input.inputId, text: input.text, promptText: input.promptText!, contextSnapshotId: input.contextSnapshotId,
            ...(input.resourceBinding ? { resourceBinding: input.resourceBinding } : {}) };
          const dispatched = await this.dispatchInput(record, active, dispatchedInput,
            invokePrompt ?? (() => session.prompt(this.nativeInputText(dispatchedInput), { expandPromptTemplates: input.resourceBinding?.requiredSkill != null })), false);
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
      session.setAutoCompactionEnabled(false);
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
      const compaction = record.compaction;
      // A next-assistant preparation failure makes fixed AgentCore append one observed empty terminal.
      // Keep that committed entry; it is not an unsubmitted tail or a new Provider response.
      const savedCompaction = compaction?.observation.saved;
      const failureTail = savedCompaction ? record.manager.getEntries().slice(savedCompaction.entryCount) : [];
      const terminal = failureTail.length === 1 && failureTail[0]?.type === 'message' ? failureTail[0] : null;
      const terminalMessage = terminal?.message;
      const committedNativeFailure = savedCompaction && terminal && terminalMessage?.role === 'assistant'
        && terminal.parentId === savedCompaction.leafId && record.receipt?.leafId === terminal.id
        && record.receipt.entryCount === savedCompaction.entryCount + 1 && record.receipt.commitRevision === savedCompaction.commitRevision + 1
        && terminalMessage === session.messages.at(-1) && active.liveOrdinals.has(terminalMessage)
        && !active.assistantBindings.has(terminalMessage) && (terminalMessage.stopReason === 'error' || terminalMessage.stopReason === 'aborted')
        && terminalMessage.content.length === 1 && terminalMessage.content[0]?.type === 'text' && terminalMessage.content[0].text === ''
        && calculateContextTokens(terminalMessage.usage) === 0
        && record.recoverySeed?.origins.some(origin => origin.nativeEntryId === terminal.id && origin.originRunId === active.runId
          && origin.originSessionId === active.sessionId);
      const intactCompactionFailure = compaction?.observation.runId === active.runId
        && compaction.failure === active.failure && compaction.observation.stopped && !compaction.observation.stopRequested
        && ['compaction_failed', 'compaction_capacity_exceeded', 'agent_model_call_budget', 'agent_context_limit', 'agent_content_limit']
          .includes(compaction.failure?.code ?? '')
        && stopped && !signal.aborted && !record.historyFailure && !record.unusable
        && (isDeepStrictEqual(record.receipt, compaction.observation.generated ? compaction.observation.saved : compaction.baseline)
          || committedNativeFailure)
        && this.verifyModelUse(record, true).ok && this.validateMessages(record, session.messages, true).ok;
      if (active.promptEntered && active.failure && !intactCompactionFailure) record.unusable = true;
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
        agent: { nativeSessionId, turnCount: active.turnOrdinal, modelCallCount: active.modelCallIndex, modelCalls: active.modelCalls,
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

  public inspectExtensions(nativeSessionId: string): Result<NativeExtensionView> {
    const scopes = this.sessions.get(nativeSessionId)?.extensions?.scopes;
    return ok(scopes ? { nativeSessionId, instances: scopes.map(scope => scope.snapshot()) }
      : structuredClone(this.recentExtensions.get(nativeSessionId) ?? { nativeSessionId, instances: [] }));
  }

  private async disposeManagedSession(record: SessionRecord): Promise<CloseReport> {
    if (record.disposing) return record.disposing;
    const scopes = record.extensions?.scopes ?? [];
    for (const scope of scopes) scope.view.admission = 'closed';
    if (record.running || record.compacting || record.commanding || record.session && !record.session.isIdle)
      return { stopped: false, closed: false, errors: [appError('stop_unconfirmed', 'runtime', 'Agent Session has not stopped.', true)] };
    if (scopes.some(scope => !scope.view.cleanup.ownedCallbacksSettled))
      return { stopped: false, closed: false, errors: [appError('extension_cleanup_failed', 'runtime', 'Extension callbacks or factory have not settled.', true)] };
    const disposing = (async (): Promise<CloseReport> => {
      try {
        if (scopes.some(scope => scope.view.cleanup.shutdownRequired && !scope.view.cleanup.shutdownAcknowledged)) {
          if (!record.session) throw new Error('No native shutdown owner.');
          for (const scope of scopes) scope.clearPhaseError('session_shutdown');
          await record.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
          if (scopes.some(scope => scope.phaseError('session_shutdown') || !scope.view.cleanup.shutdownAcknowledged || !scope.view.cleanup.ownedCallbacksSettled))
            throw new Error('Native shutdown was not acknowledged.');
        }
        record.compactionBridge?.dispose(); record.compactionBridge = undefined;
        if (record.session && !scopes.some(scope => scope.view.cleanup.sdkDisposed)) {
          record.session.dispose(); for (const scope of scopes) scope.view.cleanup.sdkDisposed = true;
        }
        record.session = undefined; record.resourceLoader = undefined;
        for (const scope of scopes) {
          scope.view.state = 'disposed'; scope.view.disposedAt = new Date().toISOString();
        }
        if (scopes.length) this.recentExtensions.set(record.manager.getSessionId(),
          { nativeSessionId: record.manager.getSessionId(), instances: scopes.map(scope => scope.snapshot()) });
        return { stopped: true, closed: true, errors: [] };
      } catch {
        const error = scopes.length
          ? appError('extension_cleanup_failed', 'runtime', 'Extension Session cleanup could not be confirmed. Retry the original instance.', true)
          : appError('agent_cleanup_failed', 'runtime', 'Agent Session cleanup could not be confirmed.', true);
        for (const scope of scopes) scope.view.lastError = error;
        return { stopped: true, closed: false, errors: [error] };
      }
    })();
    record.disposing = disposing;
    try { return await disposing; } finally { record.disposing = undefined; }
  }

  public async executeExtensionCommand(nativeSessionId: string, request: import('@flowmate/contracts').NativeExtensionCommandRequest): Promise<Result<import('@flowmate/contracts').NativeExtensionCommandReceipt>> {
    const record = this.sessions.get(nativeSessionId), scopes = record?.extensions?.scopes ?? [];
    const scope = scopes.find(scope => scope.view.instanceId === request.expectedInstanceId);
    if (!scope && scopes.length) return fail(appError('extension_instance_conflict', 'session', 'Extension instance changed.', true));
    if (!record || !scope || !record.session || scope.view.state !== 'active' || scope.view.admission !== 'open')
      return fail(appError('extension_not_loaded', 'extension', 'No active extension is loaded.'));
    if (scope.view.instanceId !== request.expectedInstanceId) return fail(appError('extension_instance_conflict', 'session', 'Extension instance changed.', true));
    if (record.preparing || record.running || record.compacting || record.commanding || record.disposing || !record.session.isIdle)
      return fail(appError('session_busy', 'session', 'Session management or execution is active.', true));
    record.commanding = true; scope.beginCommand();
    try {
      const runner = record.session.extensionRunner, command = runner.getCommand(request.name);
      if (!command || request.arguments !== '') throw new Error('Command is unavailable.');
      await command.handler(request.arguments, runner.createCommandContext());
      const receipt = scope.finishCommand();
      if (!receipt || scope.view.state !== 'active' || scope.view.admission !== 'open') throw new Error('Command has no current receipt.');
      return ok(receipt);
    } catch { return fail(appError('extension_command_failed', 'extension', 'Extension command could not be confirmed.', true)); }
    finally { scope.finishCommand(); record.commanding = false; }
  }

  public async disposeExtensions(nativeSessionId: string, expectedInstanceId: string): Promise<Result<import('@flowmate/contracts').NativeExtensionDisposeReceipt>> {
    const inspected = this.inspectExtensions(nativeSessionId); if (!inspected.ok) return inspected;
    const instance = inspected.data.instances.find(item => item.instanceId === expectedInstanceId);
    if (!instance) return fail(appError(inspected.data.instances.length ? 'extension_instance_conflict' : 'extension_not_loaded', 'extension', 'No matching extension instance is known.', true));
    if (instance.instanceId !== expectedInstanceId) return fail(appError('extension_instance_conflict', 'session', 'Extension instance changed.', true));
    if (instance.state === 'disposed') return ok({ nativeSessionId, instanceId: expectedInstanceId, state: 'disposed', report: { stopped: true, closed: true, errors: [] } });
    const report = await this.releaseSession(nativeSessionId);
    const current = this.inspectExtensions(nativeSessionId); const latest = current.ok ? current.data.instances.find(item => item.instanceId === expectedInstanceId) : undefined; if (!latest) return fail(appError('extension_cleanup_failed', 'runtime', 'Extension cleanup facts are unavailable.', true));
    return ok({ nativeSessionId, instanceId: expectedInstanceId, state: latest.state, report });
  }

  public async releaseSession(nativeSessionId: string): Promise<CloseReport> {
    const record = this.sessions.get(nativeSessionId);
    if (!record) return { stopped: true, closed: true, errors: [] };
    if (record.preparing || record.running || record.compacting || record.commanding || (record.session && !record.session.isIdle))
      return { stopped: false, closed: false, errors: [appError('stop_unconfirmed', 'runtime', 'Agent Session is still executing.', true)] };
    const report = await this.disposeManagedSession(record);
    if (report.closed) this.sessions.delete(nativeSessionId);
    return report;
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
