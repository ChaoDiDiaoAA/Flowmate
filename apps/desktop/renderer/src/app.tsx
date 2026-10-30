import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import { usePanelLayout } from './panel-layout.tsx';
import { ResearchPage } from './research.tsx';
import { PersonalAgentPage } from './personal-agent.tsx';
import { readPersonalDraft, savePersonalDraft, type PersonalReviewTarget } from './personal-state.ts';
import { EvaluationModels } from './evaluation-models.tsx';
import { EvaluationPage } from './evaluation.tsx';
import { applyEvaluationControl, applyEvaluationEvent, createEvaluationView, evaluationBusy } from './evaluation-state.ts';
import type { EvaluationControlState } from '../../../../packages/contracts/src/evaluation.ts';
import type { ResearchTask, ResearchIntent, ResearchPlanBody } from '@flowmate/contracts';
import type { DiagnosticsSnapshot } from '@flowmate/contracts';
import type { BackgroundServiceActivationView, BackgroundServiceEnableRequest } from '@flowmate/contracts';
import { InvoiceFormBridgeRequestSchema, InvoiceFormTargetSchema, StoredCandidateDraftSchema,
  MAX_INVOICE_FIELD_CHARS, MAX_INVOICE_LINES, MAX_INVOICE_NOTES, MAX_INVOICE_NOTE_CHARS, MAX_INVOICE_BLOCKS_PER_PAGE } from '../../../../packages/contracts/src/invoice.ts';
import { serializeDesktopPromptRequest } from '../../../../packages/contracts/src/settings.ts';
import { RuntimeBudgetOverridesSchema, RuntimeRequestOverridesSchema } from '../../../../packages/contracts/src/runtime.ts';
import { RUNTIME_CONFIG } from '../../../../packages/contracts/src/runtime-config.ts';
import type { ForkSessionRequest, ForkSessionResult, HistoryCommitState, RuntimeRequestOverrides, Result, SourceRef, WorkspaceSelection, WorkspaceView } from '@flowmate/contracts';
import { WorkspaceContextSchema } from '../../../../packages/contracts/src/workspace.ts';
import type { DesktopInvoiceFormRunRequest, DesktopSessionInputRequest, InvoiceCandidateOperationQuery, InvoiceFormApplicationReceipt, InvoiceFormDraft, SaveInvoiceCandidateResponse, SessionInputSnapshot } from '@flowmate/contracts';
import { applyInvoiceForm, bindInvoiceFormRun, cancelInvoiceFormRun, createInvoiceFormState, editInvoiceForm, invalidateInvoiceForm,
  invoiceHeaderFields, invoiceLineFields, queryInvoiceFormApplication, type InvoiceFormState } from './invoice-form.ts';
import type { AgentRunEvent, AgentRunSnapshot, BusinessEventSnapshot, CandidateJobDetail, CandidateSummary, DesktopEvent, DesktopState, DocumentOriginalImage, DocumentSnapshot, InvoiceToolOutput, JobSnapshot, ModelCatalogProvider, ModelProfile, NativeToolAvailability, ProductSettings, RunSnapshot, RuntimeState, SessionCursor, SessionMessageView, SessionSnapshot, WorkspaceChange, WorkspaceSnapshot } from '@flowmate/contracts';
import { applyMessageUpsert, mergeSavedHistory, messageViewsForDisplay, type MessageViewState } from './message-state.ts';
import { ResourcePage } from './prompt.tsx';
import { PromptOptimizer } from './prompt-optimizer.tsx';
import { ExtensionsPage } from './extensions.tsx';
import { InputCommands } from './input-commands.tsx';
import { Subagents } from './subagents.tsx';
import { ActivityPage } from './activity.tsx';
import { WorkspacePage, InvoiceFieldDetails } from './workspace.tsx';
import { SessionDetails, type ContextBasis } from './session-details.tsx';
import { hasNewContextEvents } from './context-state.ts';
import { createWorkspaceState, beginWorkspaceRequest, acceptWorkspaceSnapshot, failWorkspaceRequest,
  resetWorkspaceHost, sameWorkspaceBasis, sameWorkspaceSelection, selectionLabel, workspaceReady, type WorkspaceState } from './workspace-state.ts';
import { createEventView, bindEventSubscription, applyEventWake, applyEventRead, eventReadRequest,
  selectEventSegment, retryEventPrefix, enqueueEventRead, drainEventReadQueue, type EventViewState } from './event-state.ts';
import type { RuntimeEventsWake, RuntimeToolView } from '@flowmate/contracts';

type Page = 'conversation' | 'workspace' | 'workspace-detail' | 'tasks' | 'chats' | 'research' | 'personal' | 'activity' | 'models' | 'evaluation' | 'settings' | 'prompts' | 'skills' | 'extensions';
const pageLabels: Record<Page, string> = {
  conversation: 'Conversation',
  workspace: 'Invoices', 'workspace-detail': 'Workspace', tasks: 'Processing History', chats: 'Chats', research: 'Deep Research', personal: 'Personal Agent',
  activity: 'Activity', models: 'Models', evaluation: 'Evaluation', settings: 'Settings', prompts: 'Prompts', skills: 'Skills', extensions: 'Extensions',
};

function NavigationIcon({ name }: { name: Exclude<Page, 'conversation'> | 'new-chat' }) {
  const paths = {
    'new-chat': 'M12 5v14M5 12h14',
    workspace: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6',
    'workspace-detail': 'M3 4h18v16H3V4Zm6 0v16m0-10h12',
    tasks: 'M4 6h16M4 12h10M4 18h10m3-5 4 4-4 4',
    chats: 'M4 4h16v12H9l-5 4V4Zm4 5h8m-8 3h5',
    research: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm5.5 13 5 5',
    personal: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM5 21v-3a7 7 0 0 1 14 0v3M5 21h14',
    activity: 'M3 12h4l3-8 4 16 3-8h4',
    models: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    evaluation: 'M4 4h16v16H4V4Zm4 12v-4m4 4V8m4 8v-6',
    prompts: 'M5 4h14v16H5V4Zm4 5h6m-6 4h6m-6 4h3',
    skills: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
    extensions: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm13 0v6m-3-3h6',
    settings: 'm9 3-.5 3-2 1-3-.5L2 10l2.5 2L4 15l2.5 2 2.5-1 2 2 .5 3h4l.5-3 2-1 3 .5L22 14l-2.5-2L20 9l-2.5-2-2.5 1-2-2-.5-3H9Zm3 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
type EventObservation = { view: EventViewState; wanted: boolean; opening: boolean; through?: number;
  pendingWake: RuntimeEventsWake | null; snapshot: RunSnapshot | null; tools: readonly RuntimeToolView[];
  nextToolId: number | null; toolsExpanded: boolean; toolsLoading: boolean;
  snapshotError: boolean; toolsError: boolean; toolsVerified: boolean };
type Notice = { tone: 'good' | 'bad' | 'info'; message: string } | null;
type ProfileDraft = { displayName: string; theme: 'system' | 'light' | 'dark' };
const runtimeLimitFields = [
  { key: 'maxModelCalls', label: 'model requests', ...RUNTIME_CONFIG.ranges.maxModelCalls },
  { key: 'maxToolCalls', label: 'tool calls', ...RUNTIME_CONFIG.ranges.maxToolCalls },
  { key: 'toolTimeoutMs', label: 'tool timeout (ms)', ...RUNTIME_CONFIG.ranges.toolTimeoutMs },
  { key: 'timeoutMs', label: 'Run timeout (ms)', ...RUNTIME_CONFIG.ranges.timeoutMs },
  { key: 'stopGraceMs', label: 'stop wait (ms)', ...RUNTIME_CONFIG.ranges.stopGraceMs },
] as const;
type RuntimeLimitDraft = Record<(typeof runtimeLimitFields)[number]['key'], string>;
function runtimeLimitsDraft(value: RuntimeRequestOverrides): RuntimeLimitDraft {
  return Object.fromEntries(runtimeLimitFields.map(({ key }) => [key, String((key === 'timeoutMs' || key === 'stopGraceMs'
    ? value[key] : value.budget?.[key]) ?? '')])) as RuntimeLimitDraft;
}
function parseRuntimeLimits(value: RuntimeLimitDraft) {
  const numbers = Object.fromEntries(runtimeLimitFields.filter(({ key }) => value[key].trim() !== '').map(({ key }) => [key, Number(value[key])]));
  const { timeoutMs, stopGraceMs, ...budget } = numbers;
  return RuntimeRequestOverridesSchema.safeParse({ ...(Object.keys(budget).length ? { budget } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(stopGraceMs === undefined ? {} : { stopGraceMs }) });
}
function RuntimeLimitFields({ value, onChange, prefix, disabled }: { value: RuntimeLimitDraft;
  onChange(value: RuntimeLimitDraft): void; prefix: string; disabled?: boolean }) {
  return <div className="runtime-limit-fields">{runtimeLimitFields.map(({ key, label, min, max }) => <label className="field" key={key}>
    <span>{prefix} {label}</span><input type="number" min={min} max={max} step={1} value={value[key]} disabled={disabled}
      placeholder={`${min}–${max}`} onChange={event => onChange({ ...value, [key]: event.target.value })} />
  </label>)}</div>;
}
type ChatTurn = {
  id: string;
  sessionId: number;
  runId: number | null;
  prompt: string;
  response: string | null;
  error: string | null;
  status: 'sending' | 'completed' | 'failed' | 'cancelled';
  progress?: string | null;
  clientSequence?: number;
  inputId?: number;
};
type RunFeedback = { runId: number; status: 'completed' | 'failed' | 'cancelled'; error: string | null; limits?: string };

function emptyMessageState(sessionId: number): MessageViewState {
  return { sessionId, byEntryId: new Map(), liveByRun: new Map(), lastSequenceByMessage: new Map(),
    aliases: new Map(), highestSeenSequenceByRun: new Map(), closedRuns: new Set() };
}

function newId(): string { return crypto.randomUUID().replaceAll('-', ''); }

function sameInputWorkspace(expected: DesktopSessionInputRequest['workspace'], saved: SessionInputSnapshot['content']['workspaceContext']): boolean {
  if (expected === undefined || saved === null) return expected === undefined && saved === null;
  return expected.sessionId === saved.sessionId && expected.revision === saved.revision && expected.jobId === saved.jobId
    && (expected.documentRef === null || saved.documentRef === null ? expected.documentRef === saved.documentRef
      : expected.documentRef.id === saved.documentRef.id && expected.documentRef.version === saved.documentRef.version)
    && (expected.candidateRef === null || saved.candidateRef === null ? expected.candidateRef === saved.candidateRef
      : expected.candidateRef.id === saved.candidateRef.id && expected.candidateRef.sequence === saved.candidateRef.sequence);
}

async function identifyOriginalInput(original: DesktopSessionInputRequest, saved: SessionInputSnapshot): Promise<'same' | 'conflict' | 'unknown'> {
  if (original.sessionId !== saved.sessionId || original.clientSequence !== saved.clientSequence) return 'unknown';
  if (original.mode !== saved.mode) return 'conflict';
  if (original.mode === 'prompt') {
    if (saved.content.version !== 2 || !saved.content.desktopRequestIdentity) return 'unknown';
    try {
      return serializeDesktopPromptRequest(original, saved.content.requestIdentityVersion) === saved.content.desktopRequestIdentity ? 'same' : 'conflict';
    } catch { return 'unknown'; }
  }
  if (saved.content.version !== 2) return 'unknown';
  return original.runId === saved.runId && original.text === saved.content.text && sameInputWorkspace(original.workspace, saved.content.workspaceContext)
    ? 'same' : 'conflict';
}
function chatTitle(title: string): string { return title === 'New Session' ? 'New chat' : title; }

function blankModel(): ModelProfile {
  return { id: newId(), credentialRef: newId(), name: 'Primary model', kind: 'catalog', providerId: null,
    baseUrl: '', model: '', api: '', contextWindow: null, maxTokens: null, reasoning: false };
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: { message?: unknown; code?: unknown; category?: unknown } }).error;
    if (error?.code === 'agent_goal_not_met') return 'The requested outcome was not confirmed. Check Processing History for any saved result.';
    if (error?.code === 'agent_model_call_budget') return 'The assistant reached the request limit before finishing. Check Processing History for any saved result.';
    if (error?.code === 'tool_budget_exceeded') return 'The assistant reached the tool limit before finishing. Check Processing History for any saved result.';
    if (error?.code === 'session_scope_revoked') return 'Model access to this invoice was revoked. Start a new chat.';
    if (error?.code === 'state_conflict') return 'The invoice context changed. Review it and send again.';
    if (error?.code === 'workspace_recovery_blocked') return 'Workspace recovery is blocked. Check access to the saved invoice material, then refresh.';
    if (error && typeof error.message === 'string' && !/[\u3400-\u9fff]/u.test(error.message)) return error.message;
    if (error?.category === 'provider') return 'The model request failed. Check the connection and model settings.';
    if (error?.category === 'storage') return 'Your changes could not be saved. Please try again.';
    if (error?.category === 'input') return 'The request is invalid. Check the selected invoice and message.';
    if (error?.category === 'session') return 'This chat cannot continue. Start a new chat.';
  }
  return 'The operation could not be completed.';
}

function runtimeMessage(state: RuntimeState | null, readFailed: boolean, hostReady: boolean): string {
  if (!hostReady) return 'Runtime status is unavailable while the application Host is not ready.';
  if (readFailed) return 'Runtime status could not be confirmed. New requests are blocked. Check status again.';
  if (!state) return 'Checking runtime status…';
  if (state.blocked) return 'Runtime is blocked. A previous Run did not confirm stopping or saving. New requests are blocked.';
  if (state.active) return `Runtime is still occupied by Run ${state.active.runId}. New requests are blocked.`;
  return 'Runtime is ready for a new request.';
}

export function App() {
  const [page, setPage] = useState<Page>('conversation');
  const [settingsTab, setSettingsTab] = useState('General');
  const [state, setState] = useState<DesktopState | null>(null);
  const [evaluationView, setEvaluationView] = useState(createEvaluationView);
  const [evaluationTraceTarget, setEvaluationTraceTarget] = useState<{ runId: number; sessionId: number | null } | null>(null);
  const evaluationViewRef = useRef(evaluationView);
  function receiveEvaluationControl(control: EvaluationControlState, revision: number) {
    const next = applyEvaluationControl(evaluationViewRef.current, control, revision);
    evaluationViewRef.current = next; setEvaluationView(next);
  }
  async function stopEvaluation() {
    const current = evaluationViewRef.current, batchId = current.control?.batchId;
    if (!batchId) return;
    try {
      const result = await window.flowmate.cancelEvaluation({ batchId });
      if (result.ok) receiveEvaluationControl(result.data, current.revision);
      else setNotice({ tone: 'bad', message: result.error.message });
    } catch { setNotice({ tone: 'bad', message: 'Stop response unavailable. Query the original evaluation batch.' }); }
  }
  const [runtimeState, setRuntimeState] = useState<RuntimeState | null>(null);
  const [runtimeReadFailed, setRuntimeReadFailed] = useState(false);
  const [draft, setDraft] = useState<ModelProfile>(blankModel);
  const [catalog, setCatalog] = useState<readonly ModelCatalogProvider[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ displayName: 'Local user', theme: 'system' });
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [nativeTools, setNativeTools] = useState<readonly NativeToolAvailability[]>([]);
  const [nativeToolsError, setNativeToolsError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<'refresh' | 'export' | 'recheck' | null>(null);
  const [activationBusy, setActivationBusy] = useState<'prepare' | 'enable' | 'query' | null>(null);
  const [activationView, setActivationView] = useState<BackgroundServiceActivationView | null>(null);
  const activationRequest = useRef<BackgroundServiceEnableRequest | null>(null);
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [messageState, setMessageState] = useState<MessageViewState | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [inputReadError, setInputReadError] = useState<string | null>(null);
  const [inputSubmitting, setInputSubmitting] = useState(false);
  const [unknownInput, setUnknownInput] = useState<{ sessionId: number; clientSequence: number } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [runFeedbacks, setRunFeedbacks] = useState<RunFeedback[]>([]);
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [sidebarRenameId, setSidebarRenameId] = useState<number | null>(null);
  const [sidebarRenameTitle, setSidebarRenameTitle] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [researchTask, setResearchTask] = useState<ResearchTask | null>(null);
  const [researchSessionLoading, setResearchSessionLoading] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionSnapshot | null>(null);
  const [sessionDetails, setSessionDetails] = useState<{ sessionId: number; basis: ContextBasis | null; token: number; initialRunId?: number | null; initialSnapshotId?: number } | null>(null);
  const [contextRefresh, setContextRefresh] = useState(0);
  const [contextSourceError, setContextSourceError] = useState<string | null>(null);
  const contextNavigation = useRef(0);
  const contextTarget = useRef<{ sessionId: number; runId: number | null } | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [workspaceState, setWorkspaceState] = useState(createWorkspaceState);
  const [workspacePending, setWorkspacePending] = useState(0);
  const [workspaceCandidate, setWorkspaceCandidate] = useState<CandidateJobDetail | null>(null);
  const [workspaceCandidateLoading, setWorkspaceCandidateLoading] = useState(false);
  const [workspaceCandidateError, setWorkspaceCandidateError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentSnapshot[]>([]);
  const [historicalDocuments, setHistoricalDocuments] = useState<Record<number, DocumentSnapshot>>({});
  const [historicalInvoice, setHistoricalInvoice] = useState<DocumentSnapshot | null>(null);
  const [historicalInvoiceView, setHistoricalInvoiceView] = useState<'original' | 'parsed' | 'candidate'>('original');
  const [historicalJobs, setHistoricalJobs] = useState<Record<number, JobSnapshot>>({});
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [historyJobId, setHistoryJobId] = useState<number | null>(null);
  const [hidingDocumentId, setHidingDocumentId] = useState<number | null>(null);
  const [candidateSummaries, setCandidateSummaries] = useState<CandidateSummary[]>([]);
  const [candidateDetail, setCandidateDetail] = useState<CandidateJobDetail | null>(null);
  const [sourceReview, setSourceReview] = useState<{ source: SourceRef; text: string | null; loading: boolean; error: string | null } | null>(null);
  const sourceReviewGeneration = useRef(0);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceFormState | null>(null);
  const [formFeedback, setFormFeedback] = useState('');
  const [formPreparing, setFormPreparing] = useState(false);
  const [formLeavePrompt, setFormLeavePrompt] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formOutcomeUnknown, setFormOutcomeUnknown] = useState(false);
  const [humanOperationUnknown, setHumanOperationUnknown] = useState(false);
  const [rejectPrompt, setRejectPrompt] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [personalReview, setPersonalReview] = useState<PersonalReviewTarget | null>(() => {
    const saved = readPersonalDraft(localStorage); return saved.ok ? saved.data.review?.target ?? null : null;
  });
  const [activity, setActivity] = useState<BusinessEventSnapshot[]>([]);
  const [parsedPage, setParsedPage] = useState<InvoiceToolOutput<'read_invoice_document'> | null>(null);
  const [originalImage, setOriginalImage] = useState<DocumentOriginalImage | null>(null);
  const [materialLoading, setMaterialLoading] = useState(false);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const [parsedIndex, setParsedIndex] = useState<InvoiceToolOutput<'list_invoice_pages'> | null>(null);
  const [localWorkspaceView, setLocalWorkspaceView] = useState<WorkspaceView | null>(null);
  const [taskGoal, setTaskGoal] = useState('');
  const [goalMode, setGoalMode] = useState<'answer' | 'save-candidate'>('answer');
  const [runtimeDefaultsDraft, setRuntimeDefaultsDraft] = useState(() => runtimeLimitsDraft({}));
  const [activeAgentRunId, setActiveAgentRunId] = useState<number | null>(null);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<number | null>(null);
  const [activeRunModel, setActiveRunModel] = useState<{ id: string; name: string; model: string } | null>(null);
  const [sessionCursor, setSessionCursor] = useState<SessionCursor | null>(null);
  const [runCursor, setRunCursor] = useState<number | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionMutating, setSessionMutating] = useState(false);
  const [revokingAccess, setRevokingAccess] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(() => window.innerWidth < 1080);
  const [researchChatCollapsed, setResearchChatCollapsed] = useState(true);
  const chatPresentation = page === 'conversation' ? 'main' : 'sidebar';
  const sidebarCollapsed = page === 'research' ? researchChatCollapsed : chatCollapsed;
  const assistantCollapsed = chatPresentation === 'sidebar' && sidebarCollapsed;
  const panels = usePanelLayout(assistantCollapsed, chatPresentation);
  const [navOpen, setNavOpen] = useState(false);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [activityTarget, setActivityTarget] = useState<{ runId: number; sessionId: number | null } | null>(null);
  const [activityView, setActivityView] = useState<EventViewState | null>(null);
  const [activitySnapshot, setActivitySnapshot] = useState<RunSnapshot | null>(null);
  const [activityTools, setActivityTools] = useState<readonly RuntimeToolView[]>([]);
  const [activityToolCursor, setActivityToolCursor] = useState<number | null>(null);
  const [activityToolsLoading, setActivityToolsLoading] = useState(false);
  const [activitySnapshotError, setActivitySnapshotError] = useState(false);
  const [activityToolsError, setActivityToolsError] = useState(false);
  const [activityToolsVerified, setActivityToolsVerified] = useState(false);
  const activityTargetRef = useRef<typeof activityTarget>(null);
  const activityVisibleRef = useRef(false);
  const activityFocusedRef = useRef(!document.hidden && document.hasFocus());
  const eventObservations = useRef(new Map<number, EventObservation>());
  const eventReadQueue = useRef<string[]>([]);
  const eventReadBusy = useRef(false);
  const runtimeReadsInFlight = useRef(0);
  const eventReadTimer = useRef<number | null>(null);
  const eventViewGeneration = useRef(0);
  const eventCoordinatorAlive = useRef(true);
  const observedActiveRef = useRef<RuntimeState['active']>(null);
  const taskDetailsGeneration = useRef(0);
  const documentReadGeneration = useRef(0);
  const historyJobIdRef = useRef<number | null>(null);
  useEffect(() => {
    let active = true;
    void window.flowmate.listModelCatalog().then((result) => {
      if (!active) return;
      if (result.ok) {
        setCatalog(result.data);
        setCatalogError(result.data.length ? null : 'No Pi providers are available. Reload providers to try again.');
      } else setCatalogError(errorMessage(result));
    }).catch(() => {
      if (active) setCatalogError('Could not load Pi providers. Reload providers to try again.');
    }).finally(() => {
      if (active) setCatalogLoading(false);
    });
    return () => { active = false; };
  }, []);
  const latestFinished = useRef(new Map<string, Extract<DesktopEvent, { type: 'provider_finished' }>>());
  const connectionStarting = useRef(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeChatTurnId = useRef<string | null>(null);
  const activeChatSessionId = useRef<number | null>(null);
  const chatDrafts = useRef(new Map<string, string>());
  const chatInputRef = useRef('');
  const eventSequences = useRef(new Map<number, number>());
  const messageStates = useRef(new Map<number, MessageViewState>());
  const messageCursors = useRef(new Map<number, string | null>());
  const inputReadTokens = useRef(new Map<number, number>());
  const unknownInputs = useRef(new Map<number, DesktopSessionInputRequest & { submittedDraft?: string }>());
  const inputSubmittingRef = useRef(false);
  const historyPositions = useRef(new Map<number, HistoryCommitState>());
  const historyForkRequests = useRef(new Map<number, ForkSessionRequest>());
  const nativeSessionIds = useRef(new Map<number, string>());
  const knownRunSessions = useRef(new Map<number, number>());
  const historyQueries = useRef(new Map<number, { inFlight: boolean; refreshPending: boolean; beforeEntryId?: string }>());
  const activeAgentRunIdRef = useRef<number | null>(null);
  const agentStopRequested = useRef(false);
  const selectedSessionIdRef = useRef<number | null>(null);
  const workspaceRef = useRef<WorkspaceSnapshot | null>(null);
  const workspaceStateRef = useRef(createWorkspaceState());
  const workspacePendingRef = useRef(0);
  const workspaceToken = useRef(0);
  const workspaceHostEpoch = useRef(0);
  const workspaceCandidateGeneration = useRef(0);
  const materialReadLease = useRef<{ generation: number; epoch: number; token: number } | null>(null);
  const candidateReadLease = useRef<{ generation: number; epoch: number; token: number } | null>(null);
  const workspaceDetailsToReload = useRef({ material: false, candidate: false });
  const workspaceChanges = useRef<Promise<void>>(Promise.resolve());
  const sessionCursorRef = useRef<SessionCursor | null>(null);
  const sessionLoadSequence = useRef(0);
  const allowInitialSessionSelection = useRef(true);
  const focusComposerWhenReady = useRef(false);
  const chatComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const navToggleRef = useRef<HTMLButtonElement | null>(null);
  const latestAgentFinished = useRef(new Map<number, Extract<AgentRunEvent, { type: 'run_finished' }>>());
  const chatTranscriptRef = useRef<HTMLDivElement | null>(null);
  const assistantWasToggled = useRef(false);
  const revisionLoaded = useRef<number | null>(null);
  const runtimeQuerySequence = useRef(0);
  const hostStateSequence = useRef(0);
  const settingsRevision = useRef(-1);
  const hostReadyRef = useRef(false);
  const invoiceFormRef = useRef<InvoiceFormState | null>(null);
  const pendingFill = useRef<DesktopInvoiceFormRunRequest | null>(null);
  const formLastCall = useRef<{ runId: number; toolCallId: number } | null>(null);
  const formLeaveResolve = useRef<((leave: boolean) => void) | null>(null);
  const candidateQuerySequence = useRef(0);

  function publishEventObservation(observation: EventObservation) {
    if (!eventCoordinatorAlive.current || activityTargetRef.current?.runId !== observation.view.runId) return;
    setActivityView(observation.view); setActivitySnapshot(observation.snapshot); setActivityTools(observation.tools);
    setActivityToolCursor(observation.nextToolId); setActivityToolsLoading(observation.toolsLoading);
    setActivitySnapshotError(observation.snapshotError); setActivityToolsError(observation.toolsError);
    setActivityToolsVerified(observation.toolsVerified);
  }
  function queueEventRead(observation: EventObservation) {
    const id = observation.view.subscriptionId;
    if (!id || !observation.wanted || !hostReadyRef.current || !eventCoordinatorAlive.current) return;
    eventReadQueue.current = enqueueEventRead(eventReadQueue.current, id);
    void drainEventReads();
  }
  async function drainEventReads() {
    if (eventReadBusy.current) return;
    eventReadBusy.current = true;
    try {
      await drainEventReadQueue(() => eventReadQueue.current.shift(),
        () => eventCoordinatorAlive.current && hostReadyRef.current, async id => {
        const observation = [...eventObservations.current.values()].find(item => item.view.subscriptionId === id && item.wanted);
        if (!observation) return;
        const generation = observation.view.generation;
        const request = eventReadRequest(observation.view, observation.through);
        try {
          const [result, snapshot, tools] = await Promise.all([
            window.flowmate.queryRuntimeEvents(request), window.flowmate.queryRun(request.runId),
            window.flowmate.listRunToolCalls({ runId: request.runId, sessionId: request.sessionId, limit: 50 }),
          ]);
          if (!observation.wanted || generation !== observation.view.generation || observation.view.subscriptionId !== id) return;
          const previousView = observation.view;
          observation.view = applyEventRead(observation.view, result, request, generation);
          if (contextTarget.current && hasNewContextEvents(previousView, observation.view, contextTarget.current)) setContextRefresh(value => value + 1);
          observation.snapshotError = !snapshot.ok || snapshot.data.runId !== request.runId || snapshot.data.sessionId !== request.sessionId;
          if (snapshot.ok && !observation.snapshotError) observation.snapshot = snapshot.data;
          observation.toolsError = !tools.ok;
          if (tools.ok) {
            observation.toolsVerified = true;
            const byId = new Map(observation.tools.map(tool => [tool.toolCallId, tool]));
            for (const tool of tools.data.items) byId.set(tool.toolCallId, tool);
            observation.tools = [...byId.values()].sort((a, b) => b.toolCallId - a.toolCallId);
            if (!observation.toolsExpanded) observation.nextToolId = tools.data.nextBeforeId;
          }
          publishEventObservation(observation);
          if (!result.ok && result.error.code === 'event_subscription_invalid') {
            observation.view = { ...observation.view, subscriptionId: null };
            observation.through = undefined;
            void openEventObservation(observation);
          } else if (result.ok && !observation.view.error) {
            const completedHandoff = observation.through !== undefined && !result.data.hasMore;
            if (completedHandoff) observation.through = undefined;
            if (completedHandoff || observation.view.needsRefresh) {
              // One page per FIFO round. A hot request goes behind other waiting observations.
              eventReadQueue.current = enqueueEventRead(eventReadQueue.current, id);
            }
          }
        } catch {
          if (generation !== observation.view.generation) return;
          observation.view = { ...observation.view, error: { code: 'storage_read_failed', category: 'storage',
            message: 'Recorded activity could not be read. Refresh to try again.', retryable: true }, needsRefresh: false };
          observation.snapshotError = true; observation.toolsError = true;
          publishEventObservation(observation);
        }
      });
    } finally { eventReadBusy.current = false; }
  }
  async function openEventObservation(observation: EventObservation) {
    if (observation.opening || observation.view.subscriptionId || !observation.wanted || !hostReadyRef.current) return;
    observation.opening = true;
    const generation = ++eventViewGeneration.current;
    observation.view = { ...observation.view, generation };
    try {
      const opened = await window.flowmate.subscribeRuntimeEvents({ runId: observation.view.runId,
        sessionId: observation.view.sessionId, cursor: observation.view.cursor });
      if (!observation.wanted || generation !== observation.view.generation || !eventCoordinatorAlive.current) {
        if (opened.ok) await window.flowmate.unsubscribeRuntimeEvents(opened.data.subscriptionId).catch(() => {});
        return;
      }
      if (!opened.ok) { observation.view = { ...observation.view, error: opened.error, needsRefresh: false }; publishEventObservation(observation); return; }
      observation.view = bindEventSubscription(observation.view, opened.data, generation);
      observation.through = opened.data.highWatermark;
      if (observation.pendingWake) observation.view = applyEventWake(observation.view, observation.pendingWake, generation);
      observation.pendingWake = null;
      publishEventObservation(observation); queueEventRead(observation);
    } catch {
      if (generation === observation.view.generation) {
        observation.view = { ...observation.view, error: { code: 'storage_read_failed', category: 'storage',
          retryable: true, message: 'Recorded activity is unavailable. Refresh to try again.' }, needsRefresh: false };
        publishEventObservation(observation);
      }
    } finally {
      if (generation === observation.view.generation) observation.opening = false;
    }
  }
  function releaseEventObservation(observation: EventObservation) {
    const id = observation.view.subscriptionId;
    observation.wanted = false; observation.opening = false;
    observation.view = { ...observation.view, generation: ++eventViewGeneration.current, subscriptionId: null };
    observation.pendingWake = null; observation.through = undefined;
    if (id) { eventReadQueue.current = eventReadQueue.current.filter(item => item !== id);
      void window.flowmate.unsubscribeRuntimeEvents(id).catch(() => {}); }
  }
  function reconcileEventObservations() {
    const wanted = new Map<number, number | null>();
    if (hostReadyRef.current && eventCoordinatorAlive.current) {
      if (observedActiveRef.current && observedActiveRef.current.kind !== 'compaction')
        wanted.set(observedActiveRef.current.runId, observedActiveRef.current.sessionId);
      if (activityVisibleRef.current && activityFocusedRef.current && activityTargetRef.current)
        wanted.set(activityTargetRef.current.runId, activityTargetRef.current.sessionId);
    }
    for (const observation of eventObservations.current.values()) if (!wanted.has(observation.view.runId) && observation.wanted) releaseEventObservation(observation);
    for (const [id, sessionId] of wanted) {
      let observation = eventObservations.current.get(id);
      if (!observation || observation.view.sessionId !== sessionId) {
        observation = { view: createEventView(id, sessionId, ++eventViewGeneration.current), wanted: true,
          opening: false, pendingWake: null, snapshot: null, tools: [], nextToolId: null, toolsExpanded: false, toolsLoading: false,
          snapshotError: false, toolsError: false, toolsVerified: false };
        eventObservations.current.set(id, observation);
      }
      observation.wanted = true;
      publishEventObservation(observation);
      if (observation.view.subscriptionId) queueEventRead(observation); else void openEventObservation(observation);
    }
    if (wanted.size && eventReadTimer.current === null) eventReadTimer.current = window.setInterval(pollEventObservations, 2000);
    else if (!wanted.size && eventReadTimer.current !== null) { window.clearInterval(eventReadTimer.current); eventReadTimer.current = null; }
  }
  function observeActivity(runId: number, sessionId: number | null) {
    const target = { runId, sessionId };
    taskDetailsGeneration.current++;
    activityTargetRef.current = target; setActivityTarget(target);
    setActivityView(null); setActivitySnapshot(null); setActivityTools([]);
    setActivityToolCursor(null); setActivityToolsLoading(false);
    setActivitySnapshotError(false); setActivityToolsError(false); setActivityToolsVerified(false);
    reconcileEventObservations();
  }
  function clearActivityObservation() {
    taskDetailsGeneration.current++;
    activityTargetRef.current = null; setActivityTarget(null);
    setActivityView(null); setActivitySnapshot(null); setActivityTools([]);
    setActivityToolCursor(null); setActivityToolsLoading(false);
    setActivitySnapshotError(false); setActivityToolsError(false); setActivityToolsVerified(false);
    reconcileEventObservations();
  }
  function refreshObservedActivity() {
    for (const observation of eventObservations.current.values()) if (observation.wanted) {
      observation.through = undefined;
    }
    reconcileEventObservations();
  }
  async function loadEarlierActivityTools() {
    const observation = activityTargetRef.current ? eventObservations.current.get(activityTargetRef.current.runId) : undefined;
    if (!observation || observation.toolsLoading || observation.nextToolId === null) return;
    const generation = observation.view.generation;
    observation.toolsLoading = true; publishEventObservation(observation);
    try {
      const result = await window.flowmate.listRunToolCalls({ runId: observation.view.runId, sessionId: observation.view.sessionId,
        beforeId: observation.nextToolId, limit: 50 });
      if (generation !== observation.view.generation) return;
      if (result.ok) {
        const byId = new Map(observation.tools.map(tool => [tool.toolCallId, tool]));
        for (const tool of result.data.items) byId.set(tool.toolCallId, tool);
        observation.tools = [...byId.values()].sort((a, b) => b.toolCallId - a.toolCallId);
        observation.nextToolId = result.data.nextBeforeId; observation.toolsExpanded = true;
      } else setNotice({ tone: 'bad', message: 'More tool activity could not be loaded. Your recorded position is retained.' });
    } catch {
      if (generation === observation.view.generation) setNotice({ tone: 'bad', message: 'More tool activity is unavailable. Try again.' });
    } finally {
      observation.toolsLoading = false; if (generation === observation.view.generation) publishEventObservation(observation);
    }
  }
  function chooseActivitySegment(after: number | null) {
    const observation = activityTargetRef.current ? eventObservations.current.get(activityTargetRef.current.runId) : undefined;
    if (!observation) return;
    if (after === null && observation.view.error?.code === 'event_cursor_invalid') {
      const { runId, sessionId } = observation.view;
      releaseEventObservation(observation);
      observation.view = createEventView(runId, sessionId, ++eventViewGeneration.current);
      observation.wanted = true; publishEventObservation(observation); void openEventObservation(observation); return;
    }
    observation.view = after === null ? retryEventPrefix(observation.view) : selectEventSegment(observation.view, after);
    observation.through = undefined; publishEventObservation(observation); queueEventRead(observation);
  }
  useEffect(() => {
    activityVisibleRef.current = page === 'activity';
    if (runtimeState !== null) observedActiveRef.current = runtimeState.active;
    reconcileEventObservations();
  }, [page, activityTarget, runtimeState, state?.ready]);
  function pollEventObservations() {
      if (!hostReadyRef.current) return;
      for (const observation of eventObservations.current.values()) if (observation.wanted) {
        if (observation.view.subscriptionId) queueEventRead(observation); else void openEventObservation(observation);
      }
      if (observedActiveRef.current && runtimeReadsInFlight.current === 0) {
        runtimeReadsInFlight.current++;
        const generation = hostStateSequence.current;
        const sequence = ++runtimeQuerySequence.current;
        void window.flowmate.queryRuntimeState().then(result => {
          if (generation !== hostStateSequence.current || sequence !== runtimeQuerySequence.current || !eventCoordinatorAlive.current) return;
          if (result.ok) { setRuntimeState(result.data); setRuntimeReadFailed(false); }
          else setRuntimeReadFailed(true);
        }).catch(() => { if (generation === hostStateSequence.current && sequence === runtimeQuerySequence.current && eventCoordinatorAlive.current) setRuntimeReadFailed(true); })
          .finally(() => { runtimeReadsInFlight.current--; });
      }
  }
  useEffect(() => {
    eventCoordinatorAlive.current = true;
    const focus = () => { activityFocusedRef.current = !document.hidden && document.hasFocus();
      reconcileEventObservations(); };
    document.addEventListener('visibilitychange', focus);
    window.addEventListener('focus', focus); window.addEventListener('blur', focus);
    return () => {
      eventCoordinatorAlive.current = false;
      if (eventReadTimer.current !== null) { window.clearInterval(eventReadTimer.current); eventReadTimer.current = null; }
      document.removeEventListener('visibilitychange', focus); window.removeEventListener('focus', focus); window.removeEventListener('blur', focus);
      for (const observation of eventObservations.current.values()) releaseEventObservation(observation);
      eventReadQueue.current = [];
    };
  }, []);

  function receiveDesktopState(next: DesktopState): boolean {
    if (next.ready && next.settings.revision < settingsRevision.current) return false;
    if (hostReadyRef.current !== next.ready) {
      workspaceHostEpoch.current++;
      publishWorkspaceState(resetWorkspaceHost(workspaceStateRef.current, workspaceHostEpoch.current));
      documentReadGeneration.current++;
      candidateQuerySequence.current++;
      workspaceCandidateGeneration.current++;
      setMaterialLoading(false); setWorkspaceCandidateLoading(false);
    }
    settingsRevision.current = Math.max(settingsRevision.current, next.settings.revision);
    hostReadyRef.current = next.ready;
    if (!evaluationViewRef.current.control && next.evaluationControl) receiveEvaluationControl(next.evaluationControl, evaluationViewRef.current.revision);
    setState(current => current && next.settings.revision < current.settings.revision
      ? { ...next, settings: current.settings, modelCredentials: current.modelCredentials, evaluationCredentials: current.evaluationCredentials } : next);
    return true;
  }
  const formSubmittingRef = useRef(false);
  const lastHumanOperation = useRef<InvoiceCandidateOperationQuery | null>(null);

  function publishInvoiceForm(next: InvoiceFormState | null) {
    invoiceFormRef.current = next;
    setInvoiceForm(next);
    if (next) void window.flowmate.setInvoiceFormDirty(next.formInstanceId, next.dirty, next.revision);
  }

  async function discardForm() {
    const current = invoiceFormRef.current;
    if (current) {
      await window.flowmate.setInvoiceFormDirty(current.formInstanceId, false, current.revision);
      await window.flowmate.invalidateInvoiceFormTarget(current.formInstanceId);
    }
    pendingFill.current = null;
    formLastCall.current = null;
    publishInvoiceForm(null);
    setFormFeedback('');
    setFormOutcomeUnknown(false);
  }

  async function discardInvoiceChanges() {
    const form = invoiceFormRef.current;
    if (!form || formSubmittingRef.current || busy || formPreparing || humanOperationUnknown) return;
    const epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken;
    const basis = workspaceRef.current, sequence = ++candidateQuerySequence.current;
    const currentPreview = () => epoch === workspaceHostEpoch.current && token === workspaceStateRef.current.requestToken
      && sequence === candidateQuerySequence.current && sameWorkspaceBasis(basis, workspaceRef.current) && hostReadyRef.current;
    setFormPreparing(true);
    try {
      await discardForm(); // Invalidate the old owner before registering another instance.
      if (!currentPreview()) return;
      const [current, runtime, detail] = await Promise.all([window.flowmate.readWorkspace(), window.flowmate.queryRuntimeState(),
        window.flowmate.queryJobCandidate({ jobId: form.basis.jobId, candidateId: form.basis.candidateId })]);
      if (!currentPreview()) return;
      if (detail.ok) setCandidateDetail(detail.data);
      if (!current.ok || !runtime.ok || !detail.ok || !hostReadyRef.current || current.data.invalidReferences.length
        || current.data.jobId !== form.basis.jobId || current.data.candidateRef?.id !== form.basis.candidateId
        || current.data.candidateRef.sequence !== form.basis.candidateSequence || current.data.documentRef?.id !== form.basis.documentRef.id
        || current.data.documentRef.version !== form.basis.documentRef.version || detail.data.candidate.status === 'accepted'
        || runtime.data.active !== null || runtime.data.blocked) {
        setNotice({ tone: 'info', message: 'Local changes discarded. The saved result remains available; explicitly select a current editable result to continue.' });
        return;
      }
      acceptWorkspace(current.data);
      const next = await prepareInvoiceForm('edit', detail.data);
      if (next) setFormFeedback('Local changes discarded. Saved result restored in a new form.');
      else setNotice({ tone: 'bad', message: 'Local changes discarded; the saved result is retained, but a new editor could not be registered.' });
    } finally { setFormPreparing(false); }
  }

  async function confirmFormLeave(): Promise<boolean> {
    if (!invoiceFormRef.current) return true;
    if (formSubmittingRef.current) return false;
    if (!invoiceFormRef.current?.dirty) { await discardForm(); return true; }
    if (formLeaveResolve.current) return false;
    setFormLeavePrompt(true);
    return new Promise(resolve => { formLeaveResolve.current = resolve; });
  }

  async function resolveFormLeave(leave: boolean) {
    if (leave) await discardForm();
    const resolve = formLeaveResolve.current; formLeaveResolve.current = null;
    setFormLeavePrompt(false); resolve?.(leave);
  }

  function setFormSubmission(value: boolean) { formSubmittingRef.current = value; setFormSubmitting(value); }

  useEffect(() => {
    const unsubscribe = window.flowmate.onInvoiceFormInspect((requestId, formInstanceId) => {
      const form = invoiceFormRef.current;
      if (!form || form.formInstanceId !== formInstanceId) { void window.flowmate.replyInvoiceFormInspect(requestId, null); return; }
      setFormSubmission(true);
      void window.flowmate.replyInvoiceFormInspect(requestId, { formInstanceId, revision: form.revision, dirty: form.dirty,
        valid: form.valid, basis: structuredClone(form.basis), draft: structuredClone(form.draft), lineOrigins: [...form.lineOrigins] });
    });
    const finished = window.flowmate.onInvoiceFormInspectFinished(unknownOperation => {
      setFormSubmission(false);
      if (unknownOperation) {
        lastHumanOperation.current = unknownOperation; setHumanOperationUnknown(true);
        setFormFeedback('Close Save result is unknown. Check the original operation; your draft is retained.');
      }
    });
    return () => { unsubscribe(); finished(); };
  }, []);

  useEffect(() => window.flowmate.onInvoiceFormRequest((requestId, raw) => {
    const parsed = InvoiceFormBridgeRequestSchema.safeParse(raw);
    if (!parsed.success) return;
    const request = parsed.data;
    const stamp = new Date().toISOString();
    const unknown: InvoiceFormApplicationReceipt = { runId: request.runId, toolCallId: request.toolCallId,
      formInstanceId: request.target.formInstanceId, candidateId: request.candidateId,
      candidateSequence: request.candidateSequence, outcome: 'unknown', observedAt: stamp };
    let current = invoiceFormRef.current;
    let receipt: InvoiceFormApplicationReceipt | null = unknown;
    if (current?.formInstanceId === request.target.formInstanceId) {
      // Main has verified the actual committed Run and the owning frame before forwarding.
      if (request.operation === 'apply' && current.runId === null
        && pendingFill.current?.target.formInstanceId === current.formInstanceId) {
        const bound = bindInvoiceFormRun(current, request.runId);
        if (bound) { current = bound; publishInvoiceForm(bound); trackFillRun(request.runId, request.sessionId); }
      }
      if (request.operation === 'query') receipt = queryInvoiceFormApplication(current, request, stamp);
      else {
        const result = applyInvoiceForm(current, request, stamp);
        receipt = result.receipt; publishInvoiceForm(result.state);
      }
      formLastCall.current = { runId: request.runId, toolCallId: request.toolCallId };
      showFormReceipt(receipt ?? unknown);
    }
    void window.flowmate.replyInvoiceFormRequest(requestId, receipt ?? unknown);
  }), []);

  function showFormReceipt(receipt: InvoiceFormApplicationReceipt) {
    setFormOutcomeUnknown(receipt.outcome === 'unknown');
    setFormFeedback(receipt.outcome === 'applied' ? 'Form draft applied; review before saving.'
      : receipt.outcome === 'not_applied' ? `Form was not applied (${receipt.reason}). Review the form before trying again.`
      : 'Fill result is unknown. Check the original status; do not repeat Fill.');
  }

  function trackFillRun(runId: number, sessionId: number) {
    knownRunSessions.current.set(runId, sessionId);
    if (latestAgentFinished.current.has(runId)) return;
    activeAgentRunIdRef.current = runId; activeChatSessionId.current = sessionId;
    setActiveAgentRunId(runId); setActiveAgentSessionId(sessionId); setRunId(runId); setBusy(true);
  }

  async function prepareInvoiceForm(purpose: 'fill' | 'edit', detail = candidateDetail): Promise<InvoiceFormState | null> {
    if (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current) return null;
    const current = workspaceRef.current;
    const sequence = candidateQuerySequence.current, epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken;
    if (!current?.documentRef || !current.jobId || !current.candidateRef || !detail
      || detail.candidate.candidateId !== current.candidateRef.id || detail.candidate.sequence !== current.candidateRef.sequence
      || detail.documentRef.id !== current.documentRef.id || detail.documentRef.version !== current.documentRef.version) return null;
    if (!await confirmFormLeave()) return null;
    if (sequence !== candidateQuerySequence.current || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return null;
    const expected = { revision: current.revision, sessionId: current.sessionId, documentRef: current.documentRef,
      jobId: current.jobId, candidateRef: current.candidateRef };
    const target = await window.flowmate.registerInvoiceFormTarget({ purpose, workspace: expected, formRevision: 0 });
    if (!target.ok) { setNotice({ tone: 'bad', message: errorMessage(target) }); return null; }
    if (workspaceRef.current?.revision !== current.revision || !hostReadyRef.current || sequence !== candidateQuerySequence.current
      || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) {
      await window.flowmate.invalidateInvoiceFormTarget(target.data.formInstanceId); return null;
    }
    const stored = StoredCandidateDraftSchema.safeParse({ fields: detail.candidate.fields, lines: detail.candidate.lines, notes: detail.candidate.notes });
    if (!stored.success) return null;
    const next = createInvoiceFormState({ formInstanceId: target.data.formInstanceId,
      basis: { sessionId: current.sessionId, documentRef: current.documentRef, jobId: current.jobId,
        candidateId: current.candidateRef.id, candidateSequence: current.candidateRef.sequence },
      candidate: purpose === 'fill' ? null : stored.data, editable: true });
    publishInvoiceForm(next); return next;
  }

  async function beginEditInvoiceForm() {
    setFormPreparing(true);
    try { if (await prepareInvoiceForm('edit')) setFormFeedback('Local draft ready. Changes are not saved until you save them.'); }
    finally { setFormPreparing(false); }
  }

  async function fillInvoiceForm() {
    if (!persistedModel || !modelReady || busy || !workspaceReady(workspaceStateRef.current) || workspacePendingRef.current) return;
    setFormPreparing(true);
    try {
      const next = await prepareInvoiceForm('fill');
      const current = workspaceRef.current;
      if (!next || !current?.sessionId) return;
      const [session, ledger] = await Promise.all([window.flowmate.querySession(current.sessionId), window.flowmate.querySessionInput({ sessionId: current.sessionId })]);
      if (!session.ok || !ledger.ok || ledger.data.nextClientSequence === null) {
        setFormFeedback('Fill input could not be confirmed. Check status before trying again.'); return;
      }
      nativeSessionIds.current.set(session.data.sessionId, session.data.nativeSessionId);
      const input: DesktopInvoiceFormRunRequest = { target: { formInstanceId: next.formInstanceId, expectedRevision: next.revision },
        clientSequence: ledger.data.nextClientSequence, modelId: persistedModel.id,
        workspace: { revision: current.revision, sessionId: current.sessionId, documentRef: current.documentRef, jobId: current.jobId, candidateRef: current.candidateRef } };
      pendingFill.current = input; setFormFeedback('Waiting for the Fill tool to apply the draft.');
      const accepted = await window.flowmate.startInvoiceFormRun(input);
      if (!accepted.ok) {
        setFormOutcomeUnknown(accepted.error.code === 'operation_result_unknown');
        setFormFeedback(accepted.error.code === 'operation_result_unknown' ? 'Fill input delivery is unknown. Check the original status; do not repeat Fill.' : errorMessage(accepted));
        if (accepted.error.code !== 'operation_result_unknown') pendingFill.current = null;
        void refreshRuntimeState(); return;
      }
      const form = invoiceFormRef.current;
      if (form?.formInstanceId === input.target.formInstanceId && form.runId === null) {
        const bound = bindInvoiceFormRun(form, accepted.data.runId); if (bound) publishInvoiceForm(bound);
      }
      trackFillRun(accepted.data.runId, accepted.data.sessionId); void refreshRuntimeState();
    } finally { setFormPreparing(false); }
  }

  async function checkFillStatus() {
    const call = formLastCall.current;
    if (call) {
      const receipt = await window.flowmate.queryInvoiceFormApplication(call);
      if (receipt.ok) showFormReceipt(receipt.data); else setFormFeedback(errorMessage(receipt));
    } else if (pendingFill.current) {
      const input = pendingFill.current;
      const result = await window.flowmate.querySessionInput({ sessionId: input.workspace.sessionId, clientSequence: input.clientSequence });
      if (result.ok && result.data.input?.runId) {
        const saved = result.data.input;
        const run = await window.flowmate.queryRun(saved.runId!);
        if (!run.ok) { setFormFeedback('Original Fill Run cannot be verified. Your draft is preserved; check again.'); return; }
        const target = InvoiceFormTargetSchema.safeParse(run.data.config.formTarget);
        const runWorkspace = WorkspaceContextSchema.safeParse(run.data.config.workspaceContext);
        if (saved.sessionId !== input.workspace.sessionId || saved.clientSequence !== input.clientSequence || saved.mode !== 'prompt'
          || saved.goalMode !== 'fill-form' || saved.content.version !== 2 || !sameInputWorkspace(input.workspace, saved.content.workspaceContext)
          || run.data.kind !== 'agent' || run.data.sessionId !== saved.sessionId || run.data.config.goalMode !== 'fill-form'
          || !runWorkspace.success || !sameInputWorkspace(input.workspace, runWorkspace.data)
          || !target.success || target.data.formInstanceId !== input.target.formInstanceId || target.data.expectedRevision !== input.target.expectedRevision) {
          setFormFeedback('The saved input belongs to another form target. Your draft is preserved; check the original Fill again.'); return;
        }
        const form = invoiceFormRef.current;
        if (form?.formInstanceId === input.target.formInstanceId && form.runId === null) {
          const bound = bindInvoiceFormRun(form, saved.runId!); if (bound) publishInvoiceForm(bound);
        }
        if (run.ok && (run.data.status === 'created' || run.data.status === 'running')) trackFillRun(saved.runId!, saved.sessionId);
        setFormFeedback(`Original Fill input is ${saved.status}. Its form application has not been confirmed. Processing ${saved.processingStatus}${run.ok ? `; Run ${run.data.status}` : ''}.`);
        void refreshRuntimeState();
      } else setFormFeedback(result.ok ? 'Original Fill input has no confirmed delivery. Do not repeat it automatically.' : errorMessage(result));
    }
  }

  function changeInvoiceFormDraft(value: InvoiceFormDraft, lineOrigins?: InvoiceFormState['lineOrigins']) {
    if (formSubmittingRef.current) return;
    const current = invoiceFormRef.current; if (!current) return;
    const next = editInvoiceForm(current, value, lineOrigins); if (next) publishInvoiceForm(next);
  }

  async function saveInvoiceResult(): Promise<boolean> {
    const form = invoiceFormRef.current; const current = workspaceRef.current;
    if (!form?.valid || !current || formSubmittingRef.current || humanOperationUnknown) return false;
    const request = { operationRef: crypto.randomUUID(), jobId: form.basis.jobId, basedOnCandidateId: form.basis.candidateId,
      expectedCandidateId: form.basis.candidateId, expectedRevision: current.revision, draft: structuredClone(form.draft), lineOrigins: [...form.lineOrigins] };
    lastHumanOperation.current = { kind: 'save', request }; setFormSubmission(true);
    try {
      const result = await window.flowmate.saveInvoiceCandidate(request);
      if (!result.ok) { setHumanOperationUnknown(result.error.code === 'operation_result_unknown'); setFormFeedback(errorMessage(result)); return false; }
      await discardForm(); acceptWorkspace(result.data.workspace);
      const detail = await window.flowmate.queryJobCandidate({ jobId: request.jobId, candidateId: result.data.candidate.candidateId });
      const editor = detail.ok ? (setCandidateDetail(detail.data), await prepareInvoiceForm('edit', detail.data)) : null;
      const feedback = editor ? 'Result saved for review.' : `Result saved: candidate ${result.data.candidate.candidateId}. Editor could not be reloaded.${detail.ok ? '' : ` ${errorMessage(detail)}`}`;
      setFormFeedback(feedback); if (!editor) setNotice({ tone: 'info', message: feedback });
      await loadTaskDetails(request.jobId); await loadProductLists(); return true;
    } finally { setFormSubmission(false); }
  }

  async function decideInvoiceResult(kind: 'accept' | 'reject', reason?: string) {
    const form = invoiceFormRef.current; const current = workspaceRef.current;
    if (!form?.valid || form.dirty || !current || formSubmittingRef.current || humanOperationUnknown) return;
    if (kind === 'reject' && !reason?.trim()) { setRejectReason(''); setRejectPrompt(true); return; }
    setRejectPrompt(false);
    const base = { operationRef: crypto.randomUUID(), jobId: form.basis.jobId, candidateId: form.basis.candidateId,
      expectedCandidateId: form.basis.candidateId, expectedRevision: current.revision };
    const operation: InvoiceCandidateOperationQuery = kind === 'accept'
      ? { kind, request: { ...base, dirty: false } } : { kind, request: { ...base, reason: reason!.trim() } };
    let acceptanceReview: PersonalReviewTarget | null = null;
    if (operation.kind === 'accept' && personalReview && current.documentRef?.id === personalReview.documentRef.id
      && current.documentRef.version === personalReview.documentRef.version && (personalReview.jobId === null || personalReview.jobId === base.jobId)) {
      const saved = readPersonalDraft(localStorage);
      if (!saved.ok) {
        setFormFeedback('The original acceptance request could not be retained for this invoice Work. No acceptance was submitted.'); return;
      }
      if (saved.data.review?.target.workId === personalReview.workId && saved.data.review.target.itemId === personalReview.itemId) {
        if (!savePersonalDraft(localStorage, { ...saved.data, review: { target: personalReview, acceptRequest: operation.request } })) {
          setFormFeedback('The original acceptance request could not be retained for this invoice Work. No acceptance was submitted.'); return;
        }
        acceptanceReview = personalReview;
      } else setPersonalReview(null);
    }
    lastHumanOperation.current = operation; setFormSubmission(true);
    try {
      const result = operation.kind === 'accept' ? await window.flowmate.acceptInvoiceCandidate(operation.request)
        : await window.flowmate.rejectInvoiceCandidate(operation.request);
      if (!result.ok) { setHumanOperationUnknown(result.error.code === 'operation_result_unknown'); setFormFeedback(errorMessage(result)); return; }
      await discardForm(); acceptWorkspace(result.data.workspace);
      const detail = await window.flowmate.queryJobCandidate({ jobId: base.jobId, candidateId: base.candidateId });
      if (detail.ok) setCandidateDetail(detail.data);
      setNotice({ tone: 'good', message: kind === 'accept' ? acceptanceReview
        ? 'Result accepted. Return to Personal Agent to attach this confirmed acceptance to the original invoice Work.' : 'Result accepted.' : 'Result rejected.' });
      await loadTaskDetails(base.jobId); await loadProductLists();
    } finally { setFormSubmission(false); }
  }

  async function exportInvoiceResult(format: 'json' | 'csv' | 'markdown') {
    const candidate = candidateDetail?.candidate; if (!candidate || candidate.status !== 'accepted') return;
    const request = { operationRef: crypto.randomUUID(), candidateId: candidate.candidateId, format };
    lastHumanOperation.current = { kind: 'export', request }; setFormSubmission(true);
    try {
      const result = await window.flowmate.saveInvoiceExport(request);
      if (!result.ok) setHumanOperationUnknown(result.error.code === 'operation_result_unknown');
      setNotice(result.ok ? result.data.outcome === 'cancelled' ? { tone: 'info', message: 'Export Save cancelled. No new managed export was created.' }
        : { tone: 'good', message: `Export saved: ${result.data.destinationPath}` }
        : { tone: 'bad', message: errorMessage(result) });
    } finally { setFormSubmission(false); }
  }

  async function checkHumanOperation() {
    const operation = lastHumanOperation.current; if (!operation || formSubmittingRef.current) return;
    const result = await window.flowmate.queryInvoiceCandidateOperation(operation);
    setNotice(result.ok ? { tone: 'info', message: result.data ? operation.kind === 'export'
      ? 'Original managed export confirmed. The external destination is not recorded; inspect the chosen file or explicitly Save again.' : `Original ${operation.kind} operation confirmed.`
      : 'Original operation has no confirmed commit. Your local draft is retained.' } : { tone: 'bad', message: errorMessage(result) });
    if (result.ok && result.data) { setHumanOperationUnknown(false); await loadWorkspace(); await loadProductLists(); if (workspaceRef.current?.jobId) await loadTaskDetails(workspaceRef.current.jobId); }
  }

  async function refreshRuntimeState(): Promise<RuntimeState | null> {
    const sequence = ++runtimeQuerySequence.current;
    setRuntimeState(null);
    setRuntimeReadFailed(false);
    if (!hostReadyRef.current) return null;
    runtimeReadsInFlight.current++;
    try {
      const result = await window.flowmate.queryRuntimeState();
      if (sequence !== runtimeQuerySequence.current || !hostReadyRef.current) return null;
      if (!result.ok) { setRuntimeReadFailed(true); return null; }
      setRuntimeState(result.data);
      return result.data;
    } catch {
      if (sequence === runtimeQuerySequence.current && hostReadyRef.current) setRuntimeReadFailed(true);
      return null;
    } finally { runtimeReadsInFlight.current--; }
  }

  function draftKey(sessionId: number | null): string { return sessionId === null ? 'new' : String(sessionId); }

  function updateChatInput(value: string) {
    chatInputRef.current = value;
    chatDrafts.current.set(draftKey(selectedSessionIdRef.current), value);
    setChatInput(value);
  }

  async function navigate(next: Page) {
    const sharesInvoiceForm = (page === 'workspace' || page === 'workspace-detail') && (next === 'workspace' || next === 'workspace-detail');
    if (next !== page && !sharesInvoiceForm && !await confirmFormLeave()) return false;
    cancelWorkspaceDetailReads();
    taskDetailsGeneration.current++;
    documentReadGeneration.current++;
    candidateQuerySequence.current++;
    workspaceCandidateGeneration.current++;
    setPage(next);
    setNavOpen(false);
    const selectedJobId = historyJobId ?? workspace?.jobId;
    if (next === 'tasks' && selectedJobId) void loadTaskDetails(selectedJobId);
    if (next === 'workspace-detail' && workspaceRef.current?.documentRef) {
      const current = workspaceRef.current.documentRef;
      if (!parsedPage || parsedPage.documentRef.id !== current.id || parsedPage.documentRef.version !== current.version
        || !originalImage || originalImage.documentRef.id !== current.id || originalImage.documentRef.version !== current.version
        || !parsedIndex || parsedIndex.documentRef.id !== current.id || parsedIndex.documentRef.version !== current.version || materialLoading) {
        void loadDocumentMaterial(current.id);
      }
      void loadWorkspaceCandidate();
    }
    return true;
  }
  function selectHistoryJob(jobId: number | null) {
    historyJobIdRef.current = jobId; taskDetailsGeneration.current++; setHistoryJobId(jobId);
  }

  async function openChat(sessionId: number) {
    if (!await confirmFormLeave() || !await navigate('conversation')) return;
    selectSession(sessionId, true);
  }

  async function loadSessionList(append = false) {
    const before = append ? sessionCursorRef.current : null;
    const result = await window.flowmate.listSessions({ limit: 100, ...(before ? { before } : {}) });
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    sessionCursorRef.current = result.data.next;
    for (const session of result.data.items) nativeSessionIds.current.set(session.sessionId, session.nativeSessionId);
    setSessionCursor(result.data.next);
    setSessions((current) => append ? [...current, ...result.data.items] : result.data.items);
  }

  function publishWorkspaceState(next: WorkspaceState) {
    if (next.hostEpoch !== workspaceStateRef.current.hostEpoch || next.requestToken !== workspaceStateRef.current.requestToken) cancelWorkspaceDetailReads();
    workspaceStateRef.current = next;
    setWorkspaceState(next);
  }

  function cancelWorkspaceDetailReads() {
    if (materialReadLease.current) {
      materialReadLease.current = null; workspaceDetailsToReload.current.material = true;
      documentReadGeneration.current++; setMaterialLoading(false);
    }
    if (candidateReadLease.current) {
      candidateReadLease.current = null; workspaceDetailsToReload.current.candidate = true;
      workspaceCandidateGeneration.current++; setWorkspaceCandidateLoading(false);
    }
  }

  function acceptWorkspace(snapshot: WorkspaceSnapshot, epoch = workspaceHostEpoch.current,
    token = workspaceStateRef.current.requestToken): boolean {
    const before = workspaceStateRef.current;
    const next = acceptWorkspaceSnapshot(before, epoch, token, snapshot);
    if (next === before) return false;
    publishWorkspaceState(next);
    const previous = workspaceRef.current;
    const form = invoiceFormRef.current;
    if (form && (previous?.sessionId !== snapshot.sessionId || previous?.jobId !== snapshot.jobId
      || previous?.candidateRef?.id !== snapshot.candidateRef?.id || previous?.documentRef?.id !== snapshot.documentRef?.id
      || previous?.documentRef?.version !== snapshot.documentRef?.version)) {
      void window.flowmate.invalidateInvoiceFormTarget(form.formInstanceId);
      publishInvoiceForm(invalidateInvoiceForm(form));
    }
    if (previous?.documentRef?.id !== snapshot.documentRef?.id || previous?.documentRef?.version !== snapshot.documentRef?.version) {
      setParsedPage(null);
      setOriginalImage(null);
      setParsedIndex(null);
      setLocalWorkspaceView(null);
    }
    if (!sameWorkspaceBasis(previous, snapshot)) {
      workspaceCandidateGeneration.current++;
      candidateQuerySequence.current++;
      setWorkspaceCandidate(null);
      setWorkspaceCandidateError(null);
    }
    workspaceRef.current = snapshot;
    setWorkspace(snapshot);
    return true;
  }

  async function loadWorkspace() {
    if (workspacePendingRef.current) return null;
    const epoch = workspaceHostEpoch.current, token = ++workspaceToken.current;
    publishWorkspaceState(beginWorkspaceRequest(workspaceStateRef.current, token, 'loading'));
    try {
      const result = await window.flowmate.readWorkspace();
      if (!result.ok) {
        publishWorkspaceState(failWorkspaceRequest(workspaceStateRef.current, epoch, token, errorMessage(result), 'error'));
        return null;
      }
      return acceptWorkspace(result.data, epoch, token) ? result.data : null;
    } catch {
      publishWorkspaceState(failWorkspaceRequest(workspaceStateRef.current, epoch, token, 'Workspace could not be read. Refresh to try again.', 'error'));
      return null;
    }
  }

  async function loadProductLists() {
    const epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken;
    const [documentsResult, jobsResult] = await Promise.all([
      window.flowmate.listDocuments({ limit: 50 }),
      window.flowmate.listJobs({ limit: 50 }),
    ]);
    if (epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return;
    if (documentsResult.ok) setDocuments(documentsResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(documentsResult) });
    if (jobsResult.ok) setJobs(jobsResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(jobsResult) });
    if (jobsResult.ok) {
      const visibleIds = new Set(documentsResult.ok ? documentsResult.data.items.map((item) => item.documentRef.id) : []);
      const missingIds = [...new Set(jobsResult.data.items.map((item) => item.documentRef.id))]
        .filter((id) => !visibleIds.has(id));
      const fetched = await Promise.all(missingIds.map((id) => window.flowmate.queryDocument(id)));
      if (epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return;
      setHistoricalDocuments((current) => ({ ...current, ...Object.fromEntries(fetched.filter((item) => item.ok)
        .map((item) => [item.data.documentRef.id, item.data])) }));
    }
  }

  async function changeWorkspace(change: WorkspaceChange) {
    if (change.kind !== 'selection' && change.kind !== 'view' && !await confirmFormLeave()) return null;
    const result = await mutateWorkspace(async current => {
      const updated = await window.flowmate.updateWorkspace({ expectedRevision: current.revision, change });
      return updated.ok ? { ok: true as const, data: { workspace: updated.data } } : updated;
    }, change);
    return result?.workspace ?? null;
  }

  async function mutateWorkspace<T extends { workspace: WorkspaceSnapshot }>(operation: (current: WorkspaceSnapshot) => Promise<Result<T>>,
    change: WorkspaceChange | null = null, isCurrent: () => boolean = () => true): Promise<T | null> {
    const queuedEpoch = workspaceHostEpoch.current;
    workspacePendingRef.current++;
    setWorkspacePending(workspacePendingRef.current);
    const update = workspaceChanges.current.then(async () => {
      if (!isCurrent() || queuedEpoch !== workspaceHostEpoch.current || !hostReadyRef.current) return null;
      const epoch = queuedEpoch, token = ++workspaceToken.current;
      publishWorkspaceState(beginWorkspaceRequest(workspaceStateRef.current, token, 'saving', change));
      try {
        let current = workspaceRef.current;
        if (!current) {
          const read = await window.flowmate.readWorkspace();
          if (!isCurrent() || !read.ok || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return null;
          current = read.data;
        }
        const result = await operation(current);
        if (!isCurrent() || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return null;
        if (!result.ok) {
          const status = result.error.code === 'state_conflict' ? 'conflict'
            : result.error.code === 'operation_result_unknown' ? 'unknown' : 'error';
          publishWorkspaceState(failWorkspaceRequest(workspaceStateRef.current, epoch, token, errorMessage(result), status));
          setNotice({ tone: 'bad', message: errorMessage(result) });
          if (status === 'conflict' || status === 'unknown') {
            const read = await window.flowmate.readWorkspace();
            if (isCurrent() && read.ok) acceptWorkspace(read.data, epoch, token);
          }
          return null;
        }
        return acceptWorkspace(result.data.workspace, epoch, token) ? result.data : null;
      } catch {
        if (!isCurrent()) return null;
        publishWorkspaceState(failWorkspaceRequest(workspaceStateRef.current, epoch, token,
          'The workspace write receipt is unknown. Refresh to read the saved selection.', 'unknown'));
        // A lost write receipt is recovered by reading facts, never by repeating the write.
        try { const read = await window.flowmate.readWorkspace(); if (isCurrent() && read.ok) acceptWorkspace(read.data, epoch, token); } catch { /* keep unknown */ }
        return null;
      }
    }).finally(() => {
      workspacePendingRef.current--;
      setWorkspacePending(workspacePendingRef.current);
    });
    workspaceChanges.current = update.then(() => undefined, () => undefined);
    return update;
  }

  async function loadProductOverview() {
    await loadWorkspace();
    await loadProductLists();
  }

  function materialReadError(result: Result<unknown>) {
    return !result.ok && result.error.code === 'host_protocol_invalid'
      ? 'The invoice material changed. Refresh the workspace.' : errorMessage(result);
  }

  async function loadDocumentMaterial(documentId: number, generation = ++documentReadGeneration.current) {
    const epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken, basis = workspaceRef.current;
    const lease = { generation, epoch, token }; materialReadLease.current = lease;
    workspaceDetailsToReload.current.material = false;
    setMaterialLoading(true); setMaterialError(null);
    try {
    const [document, index, original] = await Promise.all([
      window.flowmate.queryDocument(documentId),
      window.flowmate.listDocumentPages({ documentId }),
      window.flowmate.readDocumentOriginal(documentId, 1),
    ]);
    if (generation !== documentReadGeneration.current || epoch !== workspaceHostEpoch.current
      || token !== workspaceStateRef.current.requestToken || !sameWorkspaceBasis(basis, workspaceRef.current)) return;
    if (!document.ok) { setMaterialError(materialReadError(document)); return; }
    const expected = document.data;
    const sameDocument = (reference: DocumentSnapshot['documentRef']) => reference.id === expected.documentRef.id && reference.version === expected.documentRef.version;
    if (expected.documentRef.id !== documentId || basis?.documentRef?.id === documentId && !sameDocument(basis.documentRef)
      || index.ok && (!sameDocument(index.data.documentRef) || index.data.parsedArtifactId !== expected.parsedArtifactId)
      || original.ok && !sameDocument(original.data.documentRef)) {
      setMaterialError('The invoice material changed. Refresh the workspace.'); return;
    }
    if (!index.ok) { setMaterialError(materialReadError(index)); return; }
    if (!original.ok && original.error.code === 'host_protocol_invalid') { setMaterialError(materialReadError(original)); return; }
    const wantedPage = basis?.selection?.kind === 'source' ? basis.selection.page : undefined;
    const pageNumber = wantedPage && index.data.pages.some(page => page.page === wantedPage)
      ? wantedPage : index.data.pages[0]?.page;
    if (pageNumber === undefined) { setParsedIndex(index.data); setParsedPage(null); if (original.ok) setOriginalImage(original.data); return; }
    const page = await window.flowmate.readDocumentPage({ documentId, page: pageNumber, afterBlockId: null, limit: 50 });
    if (generation !== documentReadGeneration.current || epoch !== workspaceHostEpoch.current
      || token !== workspaceStateRef.current.requestToken || !sameWorkspaceBasis(basis, workspaceRef.current)) return;
    setMaterialLoading(false);
    if (!page.ok) { setMaterialError(materialReadError(page)); return; }
    if (!sameDocument(page.data.documentRef) || page.data.parsedArtifactId !== expected.parsedArtifactId || page.data.page !== pageNumber) {
      setMaterialError('The invoice material changed. Refresh the workspace.'); return;
    }
    setParsedIndex(index.data); setParsedPage(page.data);
    if (original.ok) setOriginalImage(original.data);
    else { setOriginalImage(null); setMaterialError(materialReadError(original)); }
    } catch {
      if (materialReadLease.current === lease) setMaterialError('Invoice material could not be loaded. Refresh to try again.');
    } finally {
      if (materialReadLease.current === lease) { materialReadLease.current = null; setMaterialLoading(false); }
    }
  }

  async function readParsedPage(pageNumber: number, more = false) {
    const basis = workspaceRef.current;
    if (!basis?.documentRef) return;
    const previous = parsedPage;
    const expected = workspaceDocument;
    const sameDocument = (reference: DocumentSnapshot['documentRef']) => reference.id === basis.documentRef!.id && reference.version === basis.documentRef!.version;
    if (!expected || !sameDocument(expected.documentRef) || more && (!previous || !sameDocument(previous.documentRef)
      || previous.parsedArtifactId !== expected.parsedArtifactId || previous.page !== pageNumber || !previous.nextAfterBlockId)) {
      setMaterialError('The invoice material changed. Refresh the workspace.'); return;
    }
    const generation = ++documentReadGeneration.current, epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken;
    const lease = { generation, epoch, token }; materialReadLease.current = lease;
    workspaceDetailsToReload.current.material = false;
    setMaterialLoading(true); setMaterialError(null);
    try {
      const result = await window.flowmate.readDocumentPage({ documentId: basis.documentRef.id, page: pageNumber,
        afterBlockId: more ? previous?.nextAfterBlockId ?? null : null, limit: 50 });
      if (generation !== documentReadGeneration.current || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken
        || !sameWorkspaceBasis(basis, workspaceRef.current)) return;
      setMaterialLoading(false);
      if (!result.ok) { setMaterialError(materialReadError(result)); return; }
      if (!sameDocument(result.data.documentRef) || result.data.parsedArtifactId !== expected.parsedArtifactId || result.data.page !== pageNumber
        || more && previous && result.data.blocks.some(block => previous.blocks.some(prior => prior.id === block.id))) {
        setMaterialError('The invoice material changed. Refresh the workspace.'); return;
      }
      setParsedPage(more && previous
        ? { ...result.data, blocks: [...previous.blocks, ...result.data.blocks] } : result.data);
    } catch {
      if (generation === documentReadGeneration.current && epoch === workspaceHostEpoch.current && token === workspaceStateRef.current.requestToken) {
        setMaterialLoading(false); setMaterialError('The parsed page could not be loaded. Retry the page or refresh the workspace.');
      }
    } finally {
      if (materialReadLease.current === lease) { materialReadLease.current = null; setMaterialLoading(false); }
    }
  }

  async function loadWorkspaceCandidate() {
    const basis = workspaceRef.current;
    const generation = ++workspaceCandidateGeneration.current, epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken;
    const lease = { generation, epoch, token }; candidateReadLease.current = lease;
    workspaceDetailsToReload.current.candidate = false;
    if (!basis?.jobId || !basis.candidateRef) { candidateReadLease.current = null; setWorkspaceCandidate(null); setWorkspaceCandidateLoading(false); return; }
    setWorkspaceCandidateLoading(true); setWorkspaceCandidateError(null);
    try {
      const result = await window.flowmate.queryJobCandidate({ jobId: basis.jobId, candidateId: basis.candidateRef.id });
      if (generation !== workspaceCandidateGeneration.current || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken
        || !sameWorkspaceBasis(basis, workspaceRef.current)) return;
      setWorkspaceCandidateLoading(false);
      if (result.ok && result.data.documentRef.id === basis.documentRef?.id && result.data.documentRef.version === basis.documentRef.version
        && result.data.candidate.jobId === basis.jobId && result.data.candidate.candidateId === basis.candidateRef.id && result.data.candidate.sequence === basis.candidateRef.sequence) {
        setWorkspaceCandidate(result.data);
        setCandidateDetail(result.data);
      } else {
        setWorkspaceCandidate(current => current && basis.documentRef && current.documentRef.id === basis.documentRef.id && current.documentRef.version === basis.documentRef.version
          && current.candidate.jobId === basis.jobId && current.candidate.candidateId === basis.candidateRef!.id && current.candidate.sequence === basis.candidateRef!.sequence ? current : null);
        setWorkspaceCandidateError(result.ok ? 'The saved result changed. Refresh the workspace.' : errorMessage(result));
      }
    } catch {
      if (generation === workspaceCandidateGeneration.current && epoch === workspaceHostEpoch.current && token === workspaceStateRef.current.requestToken) {
        setWorkspaceCandidateLoading(false); setWorkspaceCandidateError('The saved result could not be loaded. Refresh to try again.');
      }
    } finally {
      if (candidateReadLease.current === lease) { candidateReadLease.current = null; setWorkspaceCandidateLoading(false); }
    }
  }

  async function restoreWorkspace() {
    if (workspacePendingRef.current) return;
    const epoch = workspaceHostEpoch.current, token = ++workspaceToken.current;
    publishWorkspaceState(beginWorkspaceRequest(workspaceStateRef.current, token, 'loading'));
    try {
      const result = await window.flowmate.restoreWorkspace();
      if (!result.ok) {
        const blocked = result.error.code === 'workspace_recovery_blocked' || result.error.code === 'input_unavailable';
        publishWorkspaceState(failWorkspaceRequest(workspaceStateRef.current, epoch, token,
          blocked ? 'Workspace recovery is blocked. Check access to the saved invoice material, then refresh.' : errorMessage(result),
          blocked ? 'blocked' : result.error.code === 'operation_result_unknown' ? 'unknown' : 'error'));
        return;
      }
      if (!acceptWorkspace(result.data.workspace, epoch, token)) return;
      const snapshot = result.data.workspace;
      // Restore the saved chat before lists can render; null is an intentional saved choice.
      selectSession(snapshot.sessionId);
      selectHistoryJob(snapshot.jobId);
      await Promise.all([loadSessionList(), loadProductLists()]);
      if (epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return;
      if (snapshot.documentRef) {
        const document = await window.flowmate.queryDocument(snapshot.documentRef.id);
        if (epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return;
        if (document.ok) setHistoricalDocuments(current => ({ ...current, [document.data.documentRef.id]: document.data }));
        await loadDocumentMaterial(snapshot.documentRef.id);
      }
      if (snapshot.jobId) {
        const job = await window.flowmate.queryJob(snapshot.jobId);
        if (epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken) return;
        if (job.ok) setHistoricalJobs(current => ({ ...current, [job.data.jobId]: job.data }));
        await loadTaskDetails(snapshot.jobId);
      }
      await loadWorkspaceCandidate();
    } catch {
      publishWorkspaceState(failWorkspaceRequest(workspaceStateRef.current, epoch, token,
        'Workspace recovery could not be confirmed. Refresh to try again.', 'error'));
    }
  }

  async function selectWorkspaceSource(source: SourceRef) {
    const generation = sourceReviewGeneration.current, epoch = workspaceHostEpoch.current;
    const snapshot = await changeWorkspace({ kind: 'selection', selection: { formatVersion: 1, kind: 'source', target: 'document',
      targetId: source.documentId, targetVersion: source.version, artifactId: source.artifactId, page: source.page,
      ...(source.blockId ? { block: source.blockId } : {}) } });
    if (!snapshot || generation !== sourceReviewGeneration.current || epoch !== workspaceHostEpoch.current || !hostReadyRef.current) return;
    // Local navigation reveals the chosen evidence without adding a second persistent view write.
    setLocalWorkspaceView('parsed');
    await Promise.all([readParsedPage(source.page), reviewInvoiceSource(source)]);
  }

  async function reviewInvoiceSource(source: SourceRef) {
    const generation = ++sourceReviewGeneration.current, epoch = workspaceHostEpoch.current;
    const current = () => generation === sourceReviewGeneration.current && epoch === workspaceHostEpoch.current && hostReadyRef.current;
    setSourceReview(previous => ({ source, text: JSON.stringify(previous?.source) === JSON.stringify(source) ? previous!.text : null, loading: true, error: null }));
    try {
      const index = await window.flowmate.listDocumentPages({ documentId: source.documentId });
      if (!current()) return;
      if (!index.ok) throw new Error(errorMessage(index));
      if (index.data.documentRef.id !== source.documentId || index.data.documentRef.version !== source.version
        || index.data.parsedArtifactId !== source.artifactId || !index.data.pages.some(page => page.page === source.page)) throw new Error('The saved evidence reference no longer matches the document.');
      let afterBlockId: string | null = null; const texts: string[] = []; const visited = new Set<string>();
      for (;;) {
        const result = await window.flowmate.readDocumentPage({ documentId: source.documentId, page: source.page, afterBlockId, limit: 50 });
        if (!current()) return;
        if (!result.ok) throw new Error(errorMessage(result));
        const page = result.data;
        if (page.documentRef.id !== source.documentId || page.documentRef.version !== source.version || page.parsedArtifactId !== source.artifactId || page.page !== source.page)
          throw new Error('The parsed evidence changed during review.');
        for (const block of page.blocks) {
          if (visited.has(block.id)) throw new Error('The parsed evidence page repeated a block.');
          visited.add(block.id);
          if (source.blockId === null || source.blockId === block.id) texts.push(block.text);
        }
        if (source.blockId !== null && texts.length || page.nextAfterBlockId === null) break;
        if (page.nextAfterBlockId === afterBlockId || visited.size >= MAX_INVOICE_BLOCKS_PER_PAGE) throw new Error('The parsed evidence cursor could not be advanced.');
        afterBlockId = page.nextAfterBlockId;
      }
      const text = texts.join('\n');
      setSourceReview({ source, text, loading: false, error: !texts.length ? 'Evidence gap: the referenced block was not found.'
        : source.quote !== null && !text.includes(source.quote) ? 'Evidence gap: the quote does not appear in this parsed text.' : null });
    } catch (error) {
      if (current()) setSourceReview(previous => ({ source, text: JSON.stringify(previous?.source) === JSON.stringify(source) ? previous!.text : null,
        loading: false, error: error instanceof Error ? error.message : 'Evidence could not be loaded.' }));
    }
  }

  useEffect(() => { sourceReviewGeneration.current++; setSourceReview(null); }, [candidateDetail?.candidate.candidateId, workspace?.documentRef?.id, workspace?.documentRef?.version, state?.ready]);

  async function importInvoice() {
    if (!await confirmFormLeave()) return;
    const result = await window.flowmate.chooseAndImportInvoice();
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    if (!result.data) return;
    setNotice({ tone: 'good', message: 'Invoice imported and ready to review.' });
    await loadProductLists();
    await selectWorkspaceDocument(result.data.documentRef.id);
  }

  async function selectWorkspaceDocument(documentId: number | null) {
    const generation = ++documentReadGeneration.current;
    let doc = documents.find((item) => item.documentRef.id === documentId);
    if (documentId !== null && !doc) {
      const queried = await window.flowmate.queryDocument(documentId);
      if (generation !== documentReadGeneration.current) return;
      if (!queried.ok) { setNotice({ tone: 'bad', message: errorMessage(queried) }); return; }
      doc = queried.data;
    }
    if (doc?.isHidden) {
      if (!await confirmFormLeave() || generation !== documentReadGeneration.current) return;
      setHistoricalInvoice(doc); setHistoricalInvoiceView('original');
      setParsedPage(null); setOriginalImage(null);
      await loadDocumentMaterial(doc.documentRef.id, generation);
      return;
    }
    const snapshot = await changeWorkspace({ kind: 'document', documentId });
    if (!snapshot || generation !== documentReadGeneration.current) return;
    setHistoricalInvoice(null);
    selectHistoryJob(null);
    if (documentId === null) return;
    if (doc) await loadDocumentMaterial(documentId, generation);
  }

  async function startTask() {
    if (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current) return;
    if (!await confirmFormLeave()) return;
    let current = workspaceRef.current;
    if (!current?.documentRef) return;
    if (!current.sessionId) {
      const created = await createNewSession();
      if (!created) return;
      current = workspaceRef.current;
    }
    if (!current?.documentRef || !current.sessionId) return;
    const result = await mutateWorkspace(current => window.flowmate.startTask({
      clientSequence: current.nextTaskSequence,
      expectedRevision: current.revision,
      documentRef: current.documentRef!,
      goal: `Prepare an invoice candidate from this document.${taskGoal.trim() ? ` Additional requirements: ${taskGoal.trim()}` : ''}`,
    }));
    if (!result) return;
    selectHistoryJob(result.job.jobId);
    setGoalMode('save-candidate');
    updateChatInput('Generate and save a result for this invoice using its parsed data and source references. Keep missing or ambiguous details explicit.');
    setChatCollapsed(false);
    setNotice({ tone: 'good', message: 'Ready to process. Review the request in Assistant, then press Send.' });
    await loadProductLists();
    await loadTaskDetails(result.job.jobId);
  }

  async function loadTaskDetails(jobId: number) {
    const generation = taskDetailsGeneration.current;
    const basis = workspaceRef.current, epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken;
    const documentId = basis?.documentRef?.id ?? null;
    const selectedJob = historyJobIdRef.current ?? workspaceRef.current?.jobId;
    if (selectedJob !== jobId) return;
    const [candidatesResult, activityResult] = await Promise.all([
      window.flowmate.listJobCandidates({ jobId, limit: 50 }),
      window.flowmate.listActivity({ jobId, limit: 50 }),
    ]);
    if (generation !== taskDetailsGeneration.current || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken
      || !sameWorkspaceBasis(basis, workspaceRef.current) || documentId !== (workspaceRef.current?.documentRef?.id ?? null)
      || jobId !== (historyJobIdRef.current ?? workspaceRef.current?.jobId)) return;
    if (candidatesResult.ok) setCandidateSummaries(candidatesResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(candidatesResult) });
    if (activityResult.ok) setActivity(activityResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(activityResult) });
  }

  async function openCandidate(jobId: number, candidateId: number) {
    if (candidateDetail?.candidate.candidateId !== candidateId && !await confirmFormLeave()) return;
    const sequence = ++candidateQuerySequence.current;
    const basis = workspaceRef.current, epoch = workspaceHostEpoch.current, token = workspaceStateRef.current.requestToken;
    const result = await window.flowmate.queryJobCandidate({ jobId, candidateId });
    if (sequence !== candidateQuerySequence.current || epoch !== workspaceHostEpoch.current || token !== workspaceStateRef.current.requestToken
      || !sameWorkspaceBasis(basis, workspaceRef.current)) return;
    if (result.ok) setCandidateDetail(result.data);
    else setNotice({ tone: 'bad', message: errorMessage(result) });
  }

  async function openPersonalInvoice(target: PersonalReviewTarget): Promise<void> {
    const epoch = workspaceHostEpoch.current;
    const draft = readPersonalDraft(localStorage); if (!draft.ok) throw new Error(draft.error.message);
    if (draft.data.review?.acceptRequest && (draft.data.review.target.workId !== target.workId || draft.data.review.target.itemId !== target.itemId))
      throw new Error(`The original acceptance for invoice item ${draft.data.review.target.itemId} is retained. Attach it or check its receipt in its Personal Agent Work before reviewing another item.`);
    const original = await window.flowmate.invoiceWorks.get({ view: 'item', workId: target.workId, itemId: target.itemId, limit: 1 });
    if (!original.ok) throw new Error(errorMessage(original));
    if (original.data.view !== 'item' || original.data.item.documentRef.id !== target.documentRef.id
      || original.data.item.documentRef.version !== target.documentRef.version || original.data.item.jobId !== target.jobId
      || original.data.item.candidateRef?.id !== target.candidateRef?.id || original.data.item.candidateRef?.sequence !== target.candidateRef?.sequence)
      throw new Error('The original Work invoice changed. Refresh it before opening review.');
    if (epoch !== workspaceHostEpoch.current || !await confirmFormLeave()) return;
    setFormPreparing(true);
    try {
      if (!await navigate('workspace')) return;
      await selectWorkspaceDocument(target.documentRef.id);
      if (target.jobId !== null) {
        const selected = await changeWorkspace({ kind: 'job', jobId: target.jobId });
        if (!selected || selected.documentRef?.id !== target.documentRef.id || selected.documentRef.version !== target.documentRef.version)
          throw new Error('The original invoice Job could not be selected for review.');
        selectHistoryJob(target.jobId);
        await loadProductLists(); await loadTaskDetails(target.jobId);
        if (target.candidateRef !== null) await openCandidate(target.jobId, target.candidateRef.id);
      }
      await workspaceChanges.current;
      const refreshed = await loadWorkspace();
      if (epoch !== workspaceHostEpoch.current) return;
      if (!refreshed || refreshed.documentRef?.id !== target.documentRef.id || refreshed.documentRef.version !== target.documentRef.version
        || refreshed.jobId !== target.jobId || refreshed.candidateRef?.id !== target.candidateRef?.id || refreshed.candidateRef?.sequence !== target.candidateRef?.sequence)
        throw new Error('The original invoice review selection changed. Refresh the Work before opening it again.');
      const saved = readPersonalDraft(localStorage); if (!saved.ok) throw new Error(saved.error.message);
      const acceptRequest = saved.data.review?.target.workId === target.workId && saved.data.review.target.itemId === target.itemId ? saved.data.review.acceptRequest : null;
      if (!savePersonalDraft(localStorage, { ...saved.data, selectedWorkId: target.workId, review: { target, acceptRequest } }))
        throw new Error('The original Work review target could not be retained.');
      setPersonalReview(target);
      setNotice({ tone: 'info', message: `Reviewing invoice item ${target.itemId} for Personal Agent Work ${target.workId}. Existing editing, acceptance, Fill and export rules apply.` });
    } finally { setFormPreparing(false); }
  }

  async function selectCandidate(jobId: number, candidateId: number) {
    if (!await confirmFormLeave()) return;
    const result = await mutateWorkspace(current => window.flowmate.selectCandidate({
      jobId,
      candidateId,
      expectedCandidateId: jobs.find((job) => job.jobId === jobId)?.currentCandidateId ?? null,
      expectedRevision: current.revision,
    }));
    if (!result) return;
    setNotice({ tone: 'good', message: 'Selected result updated.' });
    await loadProductLists();
    await loadTaskDetails(jobId);
    await loadWorkspaceCandidate();
  }

  async function openJob(jobId: number) {
    if (!await confirmFormLeave()) return;
    const generation = taskDetailsGeneration.current;
    const visibleJob = jobs.find((item) => item.jobId === jobId);
    const queriedJob = visibleJob ? null : await window.flowmate.queryJob(jobId);
    if (generation !== taskDetailsGeneration.current) return;
    const job = visibleJob ?? (queriedJob?.ok ? queriedJob.data : null);
    if (!job) return;
    const document = await window.flowmate.queryDocument(job.documentRef.id);
    if (generation !== taskDetailsGeneration.current) return;
    if (!document.ok) { setNotice({ tone: 'bad', message: errorMessage(document) }); return; }
    setHistoricalDocuments((current) => ({ ...current, [document.data.documentRef.id]: document.data }));
    if (!visibleJob) setHistoricalJobs(current => ({ ...current, [jobId]: job }));
    if (visibleJob && !document.data.isHidden) {
      const snapshot = await changeWorkspace({ kind: 'job', jobId });
      if (!snapshot || generation !== taskDetailsGeneration.current) return;
    }
    selectHistoryJob(jobId);
    setCandidateDetail(null);
    await loadTaskDetails(jobId);
  }

  async function hideProcessing(jobId: number) {
    if (!await confirmFormLeave()) return;
    if (!window.confirm('Remove this item from Recent processing? Saved results and activity will remain available.')) return;
    const result = await window.flowmate.hideJob(jobId);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    if (workspaceRef.current?.jobId === jobId || historyJobId === jobId) {
      selectHistoryJob(null);
      setCandidateSummaries([]);
      setCandidateDetail(null);
      setActivity([]);
    }
    await loadProductOverview();
    setNotice({ tone: 'good', message: 'Processing record removed from Recent processing.' });
  }

  async function hideInvoice(documentId: number) {
    if (!await confirmFormLeave()) return;
    if (hidingDocumentId !== null) return;
    const document = documents.find((item) => item.documentRef.id === documentId);
    if (!document || !window.confirm(`Remove “${document.displayName}” from All invoices? Processing history and saved results will remain. Related chats will become read only. Reimport this invoice to show it again.`)) return;
    setHidingDocumentId(documentId);
    const result = await window.flowmate.hideDocument(documentId);
    setHidingDocumentId(null);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    if (workspaceRef.current?.documentRef?.id === documentId) {
      setParsedPage(null);
      setOriginalImage(null);
      setCandidateSummaries([]);
      setCandidateDetail(null);
      setGoalMode('answer');
    }
    await Promise.all([loadProductOverview(), loadSessionList()]);
    if (selectedSessionIdRef.current !== null) {
      const queriedSessionId = selectedSessionIdRef.current;
      const current = await window.flowmate.querySession(queriedSessionId);
      if (current.ok && selectedSessionIdRef.current === queriedSessionId) setSelectedSession(current.data);
    }
    const updated = await window.flowmate.queryDocument(documentId);
    if (updated.ok) setHistoricalDocuments((current) => ({ ...current, [documentId]: updated.data }));
    setNotice({ tone: 'good', message: `Invoice removed from All invoices. ${result.data.affectedChatCount} related ${result.data.affectedChatCount === 1 ? 'chat cannot' : 'chats cannot'} use it for new messages.` });
  }

  async function loadSession(sessionId: number) {
    await queryChatMessages(sessionId);
  }

  function publishMessages(next: MessageViewState) {
    messageStates.current.set(next.sessionId, next);
    if (selectedSessionIdRef.current !== next.sessionId) return;
    setMessageState(next);
    const userRuns = new Set([...next.byEntryId.values(), ...[...next.liveByRun.values()].flatMap((items) => [...items.values()])]
      .filter((item) => item.role === 'user').map((item) => item.runId));
    setChatTurns((turns) => turns.filter((turn) => turn.clientSequence !== undefined || turn.runId === null || !userRuns.has(turn.runId)));
  }

  async function loadSessionInputs(sessionId: number) {
    const epoch = workspaceHostEpoch.current, selection = sessionLoadSequence.current;
    const request = (inputReadTokens.current.get(sessionId) ?? 0) + 1; inputReadTokens.current.set(sessionId, request);
    const result = await window.flowmate.listSessionInputs({ sessionId, limit: 50 }).catch(() => null);
    if (inputReadTokens.current.get(sessionId) !== request || epoch !== workspaceHostEpoch.current || selection !== sessionLoadSequence.current || selectedSessionIdRef.current !== sessionId) return;
    if (!result?.ok) { setInputReadError('Saved inputs are unavailable.'); return; }
    setInputReadError(null);
    const resolved = result.data.items.filter(input => input.status !== 'queued');
    const resolvedIds = new Set(resolved.map(input => input.inputId));
    const resolvedSequences = new Set(resolved.map(input => input.clientSequence));
    setChatTurns(turns => turns.filter(turn => turn.sessionId !== sessionId
      || (turn.inputId !== undefined ? !resolvedIds.has(turn.inputId) : turn.clientSequence === undefined || !resolvedSequences.has(turn.clientSequence))));
  }

  async function checkInputStatus() {
    const sessionId = selectedSessionIdRef.current;
    const original = sessionId === null ? undefined : unknownInputs.current.get(sessionId);
    const clientSequence = original?.clientSequence;
    if (sessionId === null || clientSequence === undefined || inputSubmittingRef.current) return;
    inputSubmittingRef.current = true; setInputSubmitting(true);
    try {
    const result = await window.flowmate.querySessionInput({ sessionId, clientSequence });
    if (!result.ok || !result.data.input) {
      setNotice({ tone: 'bad', message: result.ok ? 'The original input has not been confirmed. Keep its draft and check again.' : errorMessage(result) });
      return;
    }
    const identity = await identifyOriginalInput(original!, result.data.input);
    if (identity !== 'same') {
      if (identity === 'conflict') {
        unknownInputs.current.delete(sessionId);
        if (selectedSessionIdRef.current === sessionId) setUnknownInput(null);
      }
      setNotice({ tone: 'bad', message: identity === 'conflict'
        ? 'This input sequence belongs to another request. Your draft is preserved. Review it and send again.'
        : 'The original request receipt cannot be verified. Your draft is preserved; check its status again.' });
      return;
    }
    if (result.data.input.runId === null) {
      setNotice({ tone: 'bad', message: 'The original input has no confirmed Run. It cannot be sent again.' });
      return;
    }
    if (original!.mode === 'prompt') {
      if (original!.goalMode === 'save-candidate') setGoalMode('answer');
    }
    unknownInputs.current.delete(sessionId);
    const draft = chatDrafts.current.get(draftKey(sessionId)) ?? '';
    const submittedDraft = original!.submittedDraft ?? original!.text;
    const remainingDraft = draft === submittedDraft ? '' : draft.startsWith(`${submittedDraft}\n\n`) ? draft.slice(submittedDraft.length + 2) : draft;
    chatDrafts.current.set(draftKey(sessionId), remainingDraft);
    if (selectedSessionIdRef.current === sessionId) updateChatInput(remainingDraft);
    if (selectedSessionIdRef.current === sessionId) setUnknownInput(null);
    knownRunSessions.current.set(result.data.input.runId, sessionId);
    setNotice({ tone: 'info', message: `Input ${result.data.input.inputId}: ${result.data.input.status} · ${result.data.input.processingStatus}` });
    await loadSessionInputs(sessionId);
    void refreshRuntimeState();
    void queryChatMessages(sessionId);
    } finally { inputSubmittingRef.current = false; setInputSubmitting(false); }
  }

  async function queryChatMessages(sessionId: number, beforeEntryId?: string) {
    if (selectedSessionIdRef.current !== sessionId) return;
    void loadSessionInputs(sessionId);
    const coordinator = historyQueries.current.get(sessionId) ?? { inFlight: false, refreshPending: false };
    historyQueries.current.set(sessionId, coordinator);
    if (coordinator.inFlight) {
      coordinator.refreshPending = true;
      coordinator.beforeEntryId = beforeEntryId;
      return;
    }
    coordinator.inFlight = true;
    const selection = sessionLoadSequence.current, epoch = workspaceHostEpoch.current;
    const historyQuery = beforeEntryId !== undefined ? { beforeEntryId }
      : { afterEntryId: [...(messageStates.current.get(sessionId)?.byEntryId.keys() ?? [])].at(-1) ?? null };
    setHistoryLoading(true);
    let failed = false;
    try {
      const [sessionResult, runsResult, messagesResult, nativeHistory] = await Promise.all([
        window.flowmate.querySession(sessionId),
        window.flowmate.listSessionRuns({ sessionId, limit: 100 }),
        window.flowmate.listSessionMessages({ sessionId, limit: 50, ...(beforeEntryId ? { beforeEntryId } : {}) }),
        window.flowmate.querySessionHistory({ sessionId, limit: 1 }),
      ]);
      if (selection !== sessionLoadSequence.current || selectedSessionIdRef.current !== sessionId || epoch !== workspaceHostEpoch.current) return;
      if (!sessionResult.ok || !runsResult.ok || !messagesResult.ok) {
        failed = true;
        const rejection = !sessionResult.ok ? sessionResult : !runsResult.ok ? runsResult : messagesResult;
        if (sessionResult.ok) setSelectedSession(sessionResult.data);
        setHistoryError(errorMessage(rejection));
        return;
      }
      if (sessionResult.data.sessionId !== sessionId || messagesResult.data.session.sessionId !== sessionId
        || runsResult.data.items.some((item) => item.sessionId !== sessionId)
        || messagesResult.data.session.nativeSessionId !== sessionResult.data.nativeSessionId) {
        failed = true;
        setHistoryError('The history response does not match this chat. Refresh history to verify it.');
        return;
      }
      nativeSessionIds.current.set(sessionId, sessionResult.data.nativeSessionId);
      if (nativeHistory.ok && nativeHistory.data.session.sessionId === sessionId) historyPositions.current.set(sessionId, nativeHistory.data.commit);
      else historyPositions.current.delete(sessionId);
      const base = messageStates.current.get(sessionId) ?? emptyMessageState(sessionId);
      const closedRuns = new Set(base.closedRuns);
      for (const item of runsResult.data.items) {
        knownRunSessions.current.set(item.runId, sessionId);
        if (item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled') closedRuns.add(item.runId);
      }
      const merged = mergeSavedHistory({ ...base, closedRuns }, messagesResult.data, historyQuery);
      publishMessages(merged.state);
      setSelectedSession(sessionResult.data);
      setHistoryError(merged.queryRequired ? 'Saved message facts conflict with the displayed history. Refresh history to verify it.' : null);
      failed = merged.queryRequired;
      messageCursors.current.set(sessionId, messagesResult.data.nextBeforeEntryId);
      setMessageCursor(messageCursors.current.get(sessionId) ?? null);
      setRunCursor(runsResult.data.nextBeforeRunId);
      if (sessionResult.data.historyState === 'legacy-read-only') {
        setChatTurns(runsResult.data.items.slice().reverse().map(turnFromRun));
      }
      setRunFeedbacks(runsResult.data.items.filter((item) => item.status === 'cancelled' || item.status === 'failed')
        .map((item) => {
          const budget = RuntimeBudgetOverridesSchema.passthrough().safeParse(item.config.runtimeBudget ?? item.config.agent);
          const limits = budget.success ? [
            budget.data.maxModelCalls === undefined ? null : `${budget.data.maxModelCalls} model request${budget.data.maxModelCalls === 1 ? '' : 's'}`,
            budget.data.maxToolCalls === undefined ? null : `${budget.data.maxToolCalls} tool call${budget.data.maxToolCalls === 1 ? '' : 's'}`,
          ].filter(Boolean).join(' · ') : '';
          return { runId: item.runId, status: item.status as 'failed' | 'cancelled',
            error: item.error ? errorMessage({ error: item.error }) : null,
            ...(limits ? { limits: `Run ${item.runId} limits: ${limits}` } : {}) };
        }));
    } catch {
      failed = true;
      if (selection === sessionLoadSequence.current && selectedSessionIdRef.current === sessionId && epoch === workspaceHostEpoch.current) {
        setHistoryError('History could not be loaded. Refresh history to try again.');
      }
    } finally {
      coordinator.inFlight = false;
      const followUp = coordinator.refreshPending && !failed && selectedSessionIdRef.current === sessionId;
      const pendingBefore = coordinator.beforeEntryId;
      coordinator.refreshPending = false;
      delete coordinator.beforeEntryId;
      if (selection === sessionLoadSequence.current && selectedSessionIdRef.current === sessionId && epoch === workspaceHostEpoch.current) setHistoryLoading(false);
      if (followUp) void queryChatMessages(sessionId, pendingBefore);
    }
  }

  function publishSelectedSession(sessionId: number | null) {
    sessionLoadSequence.current++;
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
  }

  function captureHistorySelection() {
    const epoch = workspaceHostEpoch.current, selection = sessionLoadSequence.current, sessionId = selectedSessionIdRef.current;
    return () => epoch === workspaceHostEpoch.current && selection === sessionLoadSequence.current && sessionId === selectedSessionIdRef.current;
  }

  function selectSession(sessionId: number | null, focusComposer = false, researchSelection = false) {
    const knownResearch = researchSelection || sessionId !== null && sessionId === researchTask?.sessionId;
    if (!knownResearch) setResearchTask(null);
    setResearchSessionLoading(!knownResearch && sessionId !== null);
    chatDrafts.current.set(draftKey(selectedSessionIdRef.current), chatInputRef.current);
    setSessionMutating(false);
    focusComposerWhenReady.current = focusComposer;
    publishSelectedSession(sessionId);
    chatInputRef.current = chatDrafts.current.get(draftKey(sessionId)) ?? '';
    setChatInput(chatInputRef.current);
    setSelectedSession(null);
    setRunCursor(null);
    setChatTurns([]);
    setMessageState(sessionId === null ? null : messageStates.current.get(sessionId) ?? null);
    setMessageCursor(sessionId === null ? null : messageCursors.current.get(sessionId) ?? null);
    setInputReadError(null);
    setUnknownInput(sessionId !== null && unknownInputs.current.has(sessionId)
      ? { sessionId, clientSequence: unknownInputs.current.get(sessionId)!.clientSequence } : null);
    if (sessionId === null) setHistoryLoading(false);
    setHistoryError(null);
    setRunFeedbacks([]);
    setNotice(null);
    if (!knownResearch && sessionId !== null) {
      const selection = sessionLoadSequence.current;
      void window.flowmate.queryResearchForSession({ sessionId }).then(result => {
        if (selection !== sessionLoadSequence.current || selectedSessionIdRef.current !== sessionId) return;
        if (!result.ok) { setNotice({ tone: 'bad', message: 'The Session purpose could not be verified. Select it again to retry.' }); return; }
        setResearchTask(result.data); setResearchSessionLoading(false);
        if (!result.data && workspaceRef.current?.sessionId !== sessionId) void changeWorkspace({ kind: 'session', sessionId });
      }).catch(() => { if (selection === sessionLoadSequence.current) setNotice({ tone: 'bad', message: 'The Session purpose could not be verified. Select it again to retry.' }); });
    } else if (!knownResearch && workspaceRef.current?.sessionId !== sessionId) void changeWorkspace({ kind: 'session', sessionId });
    if (sessionId !== null) {
      void loadSession(sessionId);
    }
  }

  function closeSessionDetails() {
    contextNavigation.current++; contextTarget.current = null; setSessionDetails(null); setContextSourceError(null);
  }
  function openSessionDetails(sessionId: number, basis: ContextBasis | null = null, initialRunId?: number | null, initialSnapshotId?: number) {
    const token = ++contextNavigation.current;
    contextTarget.current = { sessionId, runId: basis?.runId ?? null };
    setContextSourceError(null); setSessionDetails({ sessionId, basis, token, initialRunId, initialSnapshotId });
  }
  async function openCandidateContextBasis(original: CandidateSummary) {
    const epoch = workspaceHostEpoch.current, token = ++contextNavigation.current;
    const current = () => hostReadyRef.current && workspaceHostEpoch.current === epoch && contextNavigation.current === token;
    setContextSourceError(null);
    try {
      let candidate = original;
      const seen = new Set<number>();
      while (candidate.origin === 'human_edit' && candidate.basedOnCandidateId != null) {
        if (seen.has(candidate.candidateId)) throw new Error('Candidate basis cycle');
        seen.add(candidate.candidateId);
        const result = await window.flowmate.queryJobCandidate({ jobId: original.jobId, candidateId: candidate.basedOnCandidateId });
        if (!current()) return;
        if (!result.ok || result.data.candidate.jobId !== original.jobId || result.data.candidate.candidateId !== candidate.basedOnCandidateId)
          throw new Error('Candidate basis not verified');
        candidate = result.data.candidate;
      }
      if ((candidate.origin ?? 'model') !== 'model' || candidate.runId === null || candidate.context === null) {
        if (current()) setContextSourceError('Evidence unavailable · No model context basis was saved.'); return;
      }
      const result = await window.flowmate.queryRun(candidate.runId);
      if (!current()) return;
      if (!result.ok || result.data.kind !== 'agent' || result.data.runId !== candidate.runId || result.data.jobId !== original.jobId
        || typeof result.data.sessionId !== 'number' || !Number.isSafeInteger(result.data.sessionId) || result.data.sessionId < 1) throw new Error('Original Run not verified');
      openSessionDetails(result.data.sessionId, { sessionId: result.data.sessionId, runId: result.data.runId, context: candidate.context });
    } catch { if (current()) setContextSourceError('The original candidate context could not be loaded. Refresh to try again.'); }
  }

  async function createNewSession(preserveDraft = false): Promise<SessionSnapshot | null> {
    if (!await confirmFormLeave()) return null;
    if (!state?.ready || sessionLoading || sessionMutating) return null;
    const priorDraft = chatInputRef.current;
    allowInitialSessionSelection.current = false;
    chatDrafts.current.set('new', preserveDraft ? priorDraft : '');
    selectSession(null, true);
    const pendingSelection = sessionLoadSequence.current;
    setSessionLoading(true);
    chatComposerRef.current?.focus();
    const created = await window.flowmate.createSession();
    setSessionLoading(false);
    if (!created.ok) { setNotice({ tone: 'bad', message: errorMessage(created) }); return null; }
    const session = created.data;
    nativeSessionIds.current.set(session.sessionId, session.nativeSessionId);
    const createdDraft = chatDrafts.current.get('new') ?? '';
    chatDrafts.current.set(draftKey(session.sessionId), createdDraft);
    setSessions((current) => [session, ...current.filter((item) => item.sessionId !== session.sessionId)]);
    if (selectedSessionIdRef.current !== null || sessionLoadSequence.current !== pendingSelection) {
      void loadSessionList();
      return session;
    }
    chatInputRef.current = createdDraft;
    setChatInput(chatInputRef.current);
    publishSelectedSession(session.sessionId);
    setSelectedSession(session);
    setChatTurns([]);
    const newMessages = emptyMessageState(session.sessionId);
    messageStates.current.set(session.sessionId, newMessages);
    setMessageState(newMessages);
    setMessageCursor(null);
    setHistoryError(null);
    setRunFeedbacks([]);
    setRunCursor(null);
    setNotice(null);
    if (workspaceRef.current?.sessionId !== session.sessionId) await changeWorkspace({ kind: 'session', sessionId: session.sessionId });
    void loadSessionList();
    return session;
  }

  async function loadNativeTools() {
    const result = await window.flowmate.queryNativeTools();
    if (result.ok) { setNativeTools(result.data); setNativeToolsError(null); }
    else setNativeToolsError(errorMessage(result));
  }

  async function serviceActivationAction(action: 'prepare' | 'enable' | 'query') {
    if (activationBusy || !state?.backgroundService) return;
    const service = state.backgroundService;
    setActivationBusy(action);
    try {
      if (action === 'prepare') {
        const result = await window.flowmate.backgroundService.prepare({});
        setNotice(result.ok ? { tone: 'good', message: 'Service configuration prepared. Enable it explicitly when ready.' }
          : { tone: 'bad', message: errorMessage(result) });
      } else {
        if (!service.installationId) return;
        const operationId = service.activationOperationId ?? activationRequest.current?.operationId;
        if (action === 'query') {
          if (!operationId) return;
          const result = await window.flowmate.backgroundService.queryActivation({ installationId: service.installationId, operationId });
          if (result.ok) setActivationView(result.data); else setNotice({ tone: 'bad', message: errorMessage(result) });
        } else {
          const expectedSettingsRevision = service.activationOperationId ? service.activationSettingsRevision : state.settings.revision;
          if (expectedSettingsRevision === null || expectedSettingsRevision === undefined) {
            setNotice({ tone: 'bad', message: 'The original activation configuration revision is unavailable. Check the saved activation before continuing.' }); return;
          }
          const input = { installationId: service.installationId, operationId: operationId ?? crypto.randomUUID(), expectedSettingsRevision };
          activationRequest.current = input;
          const result = await window.flowmate.backgroundService.enable(input);
          if (result.ok) { setActivationView(result.data); if (result.data.error) setNotice({ tone: 'bad', message: result.data.error.message }); }
          else setNotice({ tone: 'bad', message: errorMessage(result) });
        }
      }
      const current = await window.flowmate.getState(); if (current.ok) receiveDesktopState(current.data);
    } catch { setNotice({ tone: 'bad', message: 'The original activation reply is unknown. Check its saved operation before continuing.' }); }
    finally { setActivationBusy(null); }
  }

  async function diagnosticsAction(action: 'refresh' | 'export' | 'recheck') {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(action); setDiagnosticsError(null);
    try {
      if (action === 'export') {
        const result = await window.flowmate.exportDiagnostics();
        if (!result.ok) setDiagnosticsError(result.error.message);
        else setNotice({ tone: 'good', message: result.data.outcome === 'saved' ? 'Diagnostics JSON saved.' : 'Diagnostics export cancelled.' });
        return;
      }
      if (action === 'recheck') {
        const result = await window.flowmate.restartHost();
        if (!result.ok) {
          setDiagnosticsError(result.error.message);
          const snapshot = await window.flowmate.queryDiagnostics(); if (snapshot.ok) setDiagnostics(snapshot.data);
          return;
        }
        receiveDesktopState(result.data); await refreshRuntimeState();
      }
      const result = await window.flowmate.queryDiagnostics();
      if (result.ok) setDiagnostics(result.data); else setDiagnosticsError(result.error.message);
    } catch { setDiagnosticsError('Diagnostics are unavailable. Refresh to check the current sources.'); }
    finally { setDiagnosticsBusy(null); }
  }

  async function chooseWorkingDirectory() {
    const result = await window.flowmate.chooseWorkingDirectory();
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    if (result.data === null) return;
    setWorkingDirectory(result.data);
  }

  async function renameSession(sessionId: number, title: string): Promise<boolean> {
    if (sessionMutating) return false;
    setSessionMutating(true);
    const result = await window.flowmate.renameSession({ sessionId, title });
    setSessionMutating(false);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return false; }
    if (selectedSessionIdRef.current === sessionId) setSelectedSession(result.data);
    setSessions((current) => current.map((item) => item.sessionId === result.data.sessionId ? result.data : item)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.sessionId - left.sessionId));
    setNotice({ tone: 'good', message: 'Chat renamed.' });
    return true;
  }

  async function deleteSession(sessionId: number): Promise<void> {
    if (sessionMutating) return;
    const wasSelected = selectedSessionIdRef.current === sessionId;
    setSessionMutating(true);
    const result = await window.flowmate.deleteSession(sessionId);
    if (!result.ok) {
      const refreshed = await window.flowmate.listSessions({ limit: 100 });
      if (refreshed.ok) {
        setSessions(refreshed.data.items);
        setSessionCursor(refreshed.data.next);
        sessionCursorRef.current = refreshed.data.next;
      }
      if (selectedSessionIdRef.current !== null) {
        const queriedSessionId = selectedSessionIdRef.current;
        const current = await window.flowmate.querySession(queriedSessionId);
        if (current.ok && selectedSessionIdRef.current === queriedSessionId) setSelectedSession(current.data);
      }
      setNotice({ tone: 'bad', message: errorMessage(result) });
      setSessionMutating(false);
      return;
    }

    const refreshed = await window.flowmate.listSessions({ limit: 100 });
    const remaining = refreshed.ok ? refreshed.data.items : sessions.filter((item) => item.sessionId !== sessionId);
    setSessions(remaining);
    const nextCursor = refreshed.ok ? refreshed.data.next : null;
    setSessionCursor(nextCursor);
    sessionCursorRef.current = nextCursor;
    unknownInputs.current.delete(sessionId);
    historyPositions.current.delete(sessionId);
    const next = wasSelected ? remaining.find((item) => item.status === 'active' && item.availability === 'ready'
      && item.historyState === 'recoverable' && !item.modelUseBlocked) ?? null : null;
    if (wasSelected) {
      allowInitialSessionSelection.current = false;
    }
    if (activeAgentSessionId === sessionId) {
      setBusy(false);
      setCancelPending(false);
      setActiveAgentRunId(null);
      setActiveAgentSessionId(null);
      activeAgentRunIdRef.current = null;
      activeChatTurnId.current = null;
      activeChatSessionId.current = null;
      setActiveRunModel(null);
    }
    if (workspaceRef.current?.sessionId === sessionId) {
      await loadWorkspace();
    }
    if (wasSelected) selectSession(next?.sessionId ?? null);
    chatDrafts.current.delete(draftKey(sessionId));
    setNotice({ tone: 'good', message: result.data.disposition === 'hidden'
      ? 'Chat removed from Conversations. Invoice history and saved results remain available.' : 'Chat deleted.' });
    setSessionMutating(false);
  }

  async function loadMoreSessions() {
    if (sessionCursorRef.current) await loadSessionList(true);
  }

  async function loadOlderRuns() {
    const sessionId = selectedSessionIdRef.current;
    if (sessionId !== null && selectedSession?.historyState !== 'legacy-read-only') {
      const cursor = messageCursors.current.get(sessionId);
      if (cursor) await queryChatMessages(sessionId, cursor);
      return;
    }
    const beforeRunId = runCursor;
    if (sessionId === null || beforeRunId === null) return;
    const selection = sessionLoadSequence.current, epoch = workspaceHostEpoch.current;
    const result = await window.flowmate.listSessionRuns({ sessionId, beforeRunId, limit: 100 });
    if (selection !== sessionLoadSequence.current || selectedSessionIdRef.current !== sessionId || epoch !== workspaceHostEpoch.current) return;
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    setRunCursor(result.data.nextBeforeRunId);
    setChatTurns((current) => [...result.data.items.slice().reverse().map(turnFromRun), ...current]);
  }

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const hostSequence = hostStateSequence.current;
      const result = await window.flowmate.getState();
      if (!alive || hostSequence !== hostStateSequence.current) return;
      if (result.ok) {
        if (receiveDesktopState(result.data)) void refreshRuntimeState();
      }
      else setNotice({ tone: 'bad', message: errorMessage(result) });
    };
    void refresh();
    const unsubscribe = window.flowmate.subscribe((event) => {
      if (!alive) return;
      if (event.type === 'evaluation_event') {
        const next = applyEvaluationEvent(evaluationViewRef.current, event.value);
        evaluationViewRef.current = next; setEvaluationView(next); return;
      }
      if (event.type === 'compaction_observation') {
        // Reuse the window's single subscription; a panel must not unsubscribe the chat's transport.
        if (event.observation.sessionId === contextTarget.current?.sessionId) setContextRefresh(value => value + 1);
        return;
      }
      if (event.type === 'runtime_events_available') {
        const observation = eventObservations.current.get(event.runId);
        if (!observation?.wanted) return;
        if (observation.opening && !observation.view.subscriptionId) {
          if (!observation.pendingWake || event.sequence >= observation.pendingWake.sequence) observation.pendingWake = event;
        } else {
          observation.view = applyEventWake(observation.view, event, observation.view.generation);
          if (observation.view.needsRefresh) queueEventRead(observation);
        }
        return;
      }
      if (event.type === 'host_state') {
        if (!receiveDesktopState(event.state)) return;
        hostStateSequence.current += 1;
        runtimeQuerySequence.current += 1;
        setRuntimeState(null);
        setRuntimeReadFailed(false);
        if (!event.state.ready) for (const observation of eventObservations.current.values()) releaseEventObservation(observation);
        if (!event.state.ready && invoiceFormRef.current) publishInvoiceForm(invalidateInvoiceForm(invoiceFormRef.current));
        if (event.state.ready) void refreshRuntimeState();
        return;
      }
      if (event.type === 'model_auth_notice' || event.type === 'model_auth_prompt') return;
      if (event.type === 'message_upsert') {
        if (event.sessionId !== selectedSessionIdRef.current
          || nativeSessionIds.current.get(event.sessionId) !== event.nativeSessionId
          || knownRunSessions.current.get(event.runId) !== event.sessionId) return;
        const merged = applyMessageUpsert(messageStates.current.get(event.sessionId) ?? emptyMessageState(event.sessionId), event);
        publishMessages(merged.state);
        if (event.message.persistence === 'saved' && event.message.phase === 'ended') void loadSessionInputs(event.sessionId);
        if (event.message.persistence === 'failed') {
          setSelectedSession((current) => current?.sessionId === event.sessionId ? { ...current, availability: 'unusable' } : current);
        }
        if (merged.queryRequired) void loadSession(event.sessionId);
        return;
      }
      if (event.type === 'run_progress') {
        if (latestAgentFinished.current.has(event.runId)
          || messageStates.current.get(event.sessionId)?.closedRuns.has(event.runId)
          || nativeSessionIds.current.get(event.sessionId) !== event.nativeSessionId
          || event.sequence <= (eventSequences.current.get(event.runId) ?? 0)) return;
        if (activeChatSessionId.current !== null && event.sessionId !== activeChatSessionId.current) return;
        if (activeAgentRunIdRef.current !== null && event.runId !== activeAgentRunIdRef.current) return;
        eventSequences.current.set(event.runId, event.sequence);
        knownRunSessions.current.set(event.runId, event.sessionId);
        activeAgentRunIdRef.current = event.runId;
        activeChatSessionId.current = event.sessionId;
        setActiveAgentRunId(event.runId);
        setActiveAgentSessionId(event.sessionId);
        setBusy(true);
        if (event.phase === 'created' && selectedSessionIdRef.current === event.sessionId) {
          void refreshRuntimeState();
          setRunId(event.runId);
          const turnId = activeChatTurnId.current;
          if (turnId) setChatTurns((turns) => turns.map((turn) => turn.id === turnId ? { ...turn, runId: event.runId } : turn));
        }
        if (agentStopRequested.current) {
          agentStopRequested.current = false;
          void requestAgentCancellation(event.runId);
        }
        return;
      }
      if (event.type === 'text_delta') return;
      if (event.type === 'tool_progress') {
        if (latestAgentFinished.current.has(event.runId)
          || messageStates.current.get(event.sessionId)?.closedRuns.has(event.runId)
          || event.sequence <= (eventSequences.current.get(event.runId) ?? 0)) return;
        eventSequences.current.set(event.runId, event.sequence);
        if (event.runId !== activeAgentRunIdRef.current || event.sessionId !== activeChatSessionId.current
          || event.sessionId !== selectedSessionIdRef.current) return;
        const turnId = activeChatTurnId.current;
        if (!turnId) return;
        setChatTurns((turns) => turns.map((turn) => turn.id !== turnId || turn.status !== 'sending' ? turn
          : { ...turn, progress: event.phase === 'running' ? event.label : null }));
        return;
      }
      if (event.type === 'run_finished') {
        if (latestAgentFinished.current.has(event.runId)
          || nativeSessionIds.current.get(event.sessionId) !== event.nativeSessionId
          || knownRunSessions.current.get(event.runId) !== event.sessionId) return;
        latestAgentFinished.current.set(event.runId, event);
        void refreshRuntimeState();
        const prior = messageStates.current.get(event.sessionId) ?? emptyMessageState(event.sessionId);
        publishMessages({ ...prior, closedRuns: new Set([...prior.closedRuns, event.runId]) });
        if (selectedSessionIdRef.current === event.sessionId) {
          setRunId(event.runId);
          const turnId = activeChatTurnId.current;
          if (turnId && activeAgentRunIdRef.current === event.runId) applyAgentFinish(event, turnId);
          void loadSession(event.sessionId);
        }
        void loadSessionList();
        void loadProductLists();
        if (workspaceRef.current?.jobId) void loadTaskDetails(workspaceRef.current.jobId);
        if (activeAgentRunIdRef.current === event.runId) {
          activeAgentRunIdRef.current = null;
          activeChatSessionId.current = null;
          activeChatTurnId.current = null;
          setActiveAgentRunId(null);
          setActiveAgentSessionId(null);
          setActiveRunModel(null);
          agentStopRequested.current = false;
          setBusy(false);
          setCancelPending(false);
        }
        return;
      }
      if (event.type === 'provider_observation') {
        if (event.observation === 'run_created') {
          if (activeRequestIdRef.current === event.requestId) setRunId(event.runId);
          void refreshRuntimeState();
        }
        return;
      }
      if (event.type === 'provider_finished') {
        void refreshRuntimeState();
        if (connectionStarting.current) {
          latestFinished.current.set(event.requestId, event);
          if (latestFinished.current.size > 4) latestFinished.current.delete(latestFinished.current.keys().next().value!);
        }
        if (activeRequestIdRef.current === event.requestId) {
          setRunId(event.runId);
          void loadRun(event.runId);
          setBusy(false);
          setCancelPending(false);
          activeRequestIdRef.current = null;
          setActiveRequestId(null);
        }
      }
    });
    return () => { alive = false; hostReadyRef.current = false; hostStateSequence.current += 1; runtimeQuerySequence.current += 1; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (state?.ready) {
      void loadNativeTools();
      void restoreWorkspace();
    }
  }, [state?.ready]);

  useEffect(() => {
    if (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current
      || page !== 'workspace' && page !== 'workspace-detail') return;
    const reload = workspaceDetailsToReload.current;
    if (reload.material && workspaceRef.current?.documentRef) void loadDocumentMaterial(workspaceRef.current.documentRef.id);
    if (reload.candidate) void loadWorkspaceCandidate();
  }, [workspaceState.requestToken, workspaceState.status, workspacePending, page]);

  useEffect(() => {
    const transcript = chatTranscriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [chatTurns, messageState]);

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1079px)');
    const followWidth = () => setChatCollapsed(narrow.matches);
    narrow.addEventListener('change', followWidth);
    return () => narrow.removeEventListener('change', followWidth);
  }, []);

  useEffect(() => { if (page === 'research') setResearchChatCollapsed(true); }, [page]);

  useEffect(() => {
    if (!assistantWasToggled.current) return;
    assistantWasToggled.current = false;
    if (assistantCollapsed) document.querySelector<HTMLButtonElement>('.chat-expand')?.focus();
    else chatComposerRef.current?.focus();
  }, [assistantCollapsed]);

  useEffect(() => {
    if (!state) return;
    const revision = state.settings.revision;
    if (revisionLoaded.current === revision) return;
    revisionLoaded.current = revision;
    setProfileDraft(state.settings.profile);
    setRuntimeDefaultsDraft(runtimeLimitsDraft(state.settings.runtime ?? {}));
    const preferred = state.settings.models.find((item) => item.id === state.settings.defaultModelId)
      ?? state.settings.models[0];
    if (preferred) {
      setSelectedModelId(preferred.id);
      setDraft(preferred);
    } else {
      const fresh = blankModel();
      setSelectedModelId(fresh.id);
      setDraft(fresh);
    }
  }, [state]);

  const persistedModel = state?.settings.models.find((item) => item.id === selectedModelId) ?? null;
  const credentialStatus = selectedModelId ? (state?.modelCredentials[selectedModelId] ?? 'missing') : 'missing';
  const isDraftSaved = persistedModel !== null && modelFieldsEqual(draft, persistedModel);
  const selectedCatalogProvider = catalog.find((provider) => provider.id === draft.providerId);
  const selectedCatalogModel = selectedCatalogProvider?.models.find((model) => model.id === draft.model);
  const keyReusable = credentialStatus === 'configured' && persistedModel?.kind === draft.kind
    && (draft.kind === 'catalog' ? persistedModel.providerId === draft.providerId
      : draft.kind === 'custom' ? persistedModel.baseUrl === draft.baseUrl && persistedModel.api === draft.api : false);
  const modelReady = Boolean(state?.ready && persistedModel && isDraftSaved && persistedModel.kind !== 'legacy'
    && credentialStatus === 'configured'
    && (persistedModel.kind !== 'catalog' || selectedCatalogProvider?.authMethods.includes('api_key')));
  const runtimeReady = Boolean(state?.ready && runtimeState && !runtimeState.blocked && runtimeState.active === null);
  const runtimeFeedback = runtimeMessage(runtimeState, runtimeReadFailed, Boolean(state?.ready));
  const runtimeStatus = <div data-testid="runtime-feedback"><p role="status">{runtimeFeedback}</p>
    <button className="text-button" onClick={() => void refreshRuntimeState()} disabled={!state?.ready || busy}>Check runtime status</button></div>;
  const canTest = Boolean(modelReady && runtimeReady && !busy && !saving);
  const dependentReady = workspaceReady(workspaceState) && workspacePending === 0;
  const canNewChatAndSend = Boolean(dependentReady && modelReady && runtimeReady && !busy && !sessionLoading && !sessionMutating && !inputSubmitting);
  const inputEnabled = true;
  const selectedForSend = selectedSession ?? sessions.find((item) => item.sessionId === selectedSessionId) ?? null;
  const researchSelected = researchTask !== null && researchTask.sessionId === selectedSessionId;
  const canChat = Boolean((researchSelected || dependentReady) && modelReady && runtimeReady && !busy && !sessionLoading && !sessionMutating && !historyLoading && !historyError
    && !inputSubmitting && !unknownInput && !researchSessionLoading
    && (selectedSessionId === null || selectedForSend?.availability === 'ready' && !selectedForSend.modelUseBlocked
      && !selectedForSend.deletePending && selectedForSend.status === 'active' && selectedForSend.historyState === 'recoverable')
    && (researchSelected || goalMode !== 'save-candidate' || (workspace?.documentRef && workspace.jobId)));
  const canAppend = Boolean((researchSelected || dependentReady) && state?.ready && busy && activeAgentRunId !== null && activeAgentSessionId === selectedSessionId
    && !cancelPending && !agentStopRequested.current && !inputSubmitting && !unknownInput && !sessionMutating && !historyError
    && selectedForSend?.status === 'active' && !selectedForSend.deletePending && !selectedForSend.modelUseBlocked
    && selectedForSend.historyState === 'recoverable' && !(invoiceForm?.runId === activeAgentRunId));
  const targetRun = run?.runId === activeAgentRunId && run.sessionId === activeAgentSessionId ? run : null;
  const targetWorkspace = targetRun ? WorkspaceContextSchema.safeParse(targetRun.config.workspaceContext) : null;
  const targetDocument = targetWorkspace?.success ? targetWorkspace.data.documentRef : null;
  const activeInputTarget = activeAgentRunId !== null && activeAgentSessionId === selectedSessionId ? {
    runId: activeAgentRunId,
    material: !targetRun ? 'Checking original material…' : targetRun.config.workspaceContext === undefined
      || targetWorkspace?.success && targetDocument === null ? 'General conversation'
      : targetDocument ? documents.find(item => item.documentRef.id === targetDocument.id
        && item.documentRef.version === targetDocument.version)?.displayName ?? 'Original invoice'
        : 'Original material could not be verified.',
    selection: targetWorkspace?.success ? selectionLabel(targetWorkspace.data.selection) : null,
  } : null;
  useEffect(() => {
    if (activeAgentRunId === null || activeAgentSessionId !== selectedSessionId
      || run?.runId === activeAgentRunId && run.sessionId === activeAgentSessionId) return;
    const targetRunId = activeAgentRunId;
    const targetSessionId = activeAgentSessionId;
    let current = true;
    void window.flowmate.queryRun(targetRunId).then(result => {
      if (current && result.ok && result.data.runId === targetRunId && result.data.sessionId === targetSessionId
        && activeAgentRunIdRef.current === targetRunId && selectedSessionIdRef.current === targetSessionId) setRun(result.data);
    }).catch(() => {});
    return () => { current = false; };
  }, [activeAgentRunId, activeAgentSessionId, selectedSessionId, run?.runId, run?.sessionId]);
  useLayoutEffect(() => {
    if (!focusComposerWhenReady.current || !inputEnabled) return;
    focusComposerWhenReady.current = false;
    chatComposerRef.current?.focus();
  }, [inputEnabled, selectedSessionId, sessionLoading]);
  const savedModels = state?.settings.models ?? [];

  async function revokeModelAccess() {
    const documentId = workspaceRef.current?.documentRef?.id;
    if (!documentId || revokingAccess) return;
    if (!window.confirm('Revoke model access to this invoice? Any active response will stop. Chats that used this invoice can no longer send messages, while local records remain. Information already sent to a remote model cannot be recalled.')) return;
    setRevokingAccess(true);
    const result = await window.flowmate.revokeDocumentUse(documentId);
    setRevokingAccess(false);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    await loadSessionList();
    if (selectedSessionIdRef.current !== null) {
      const queriedSessionId = selectedSessionIdRef.current;
      const selected = await window.flowmate.querySession(queriedSessionId);
      if (selected.ok && selectedSessionIdRef.current === queriedSessionId) setSelectedSession(selected.data);
    }
    setNotice({ tone: result.data.stopRequested ? 'info' : 'good',
      message: result.data.affectedSessionIds.length === 0
        ? 'No previous chat used this invoice.'
        : `Model access was revoked for ${result.data.affectedSessionIds.length} ${result.data.affectedSessionIds.length === 1 ? 'chat' : 'chats'}.${result.data.stopRequested ? ' The active response is stopping.' : ''}` });
  }

  function selectModel(id: string) {
    const item = state?.settings.models.find((model) => model.id === id);
    if (!item) return;
    setSelectedModelId(id);
    setDraft(item);
    setApiKey('');
    setRun(current => current?.runId === activeAgentRunIdRef.current ? current : null);
    setNotice(null);
  }

  async function refreshCatalog() {
    setCatalogLoading(true);
    try {
      const result = await window.flowmate.listModelCatalog(draft.providerId ?? undefined, Boolean(draft.providerId));
      if (!result.ok) { setCatalogError(errorMessage(result)); return; }
      setCatalogError(result.data.length ? null : 'No Pi providers are available. Reload providers to try again.');
      setCatalog((current) => draft.providerId
        ? current.map((provider) => result.data.find((item) => item.id === provider.id) ?? provider)
        : result.data);
    } catch {
      setCatalogError('Could not load Pi providers. Reload providers to try again.');
    } finally {
      setCatalogLoading(false);
    }
  }

  async function logoutModel() {
    if (!persistedModel || persistedModel.kind !== 'catalog' || !isDraftSaved) return;
    const result = await window.flowmate.logoutModel(persistedModel.id);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    setApiKey('');
    const hostSequence = hostStateSequence.current;
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok && hostSequence === hostStateSequence.current) receiveDesktopState(refreshed.data);
    setNotice({ tone: 'good', message: 'API key removed. Add a key before testing or sending.' });
  }

  function updateDraft<K extends keyof ModelProfile>(key: K, value: ModelProfile[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function saveConfiguration() {
    if (!state) return;
    setSaving(true);
    setNotice(null);
    const models = state.settings.models.filter((model) => model.id !== draft.id).concat(draft);
    const requestSettings: ProductSettings = {
      ...state.settings,
      profile: profileDraft,
      models,
      defaultModelId: draft.id,
    };
    const credentialUpdate = apiKey.trim() ? { modelId: draft.id, apiKey } : undefined;
    const saved = await window.flowmate.saveSettings(requestSettings, credentialUpdate);
    setSaving(false);
    if (!saved.ok) {
      setNotice({ tone: 'bad', message: errorMessage(saved) });
      return;
    }
    setApiKey('');
    const hostSequence = hostStateSequence.current;
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok && hostSequence === hostStateSequence.current) receiveDesktopState(refreshed.data);
    setNotice({ tone: 'good', message: 'Configuration saved. New runs will use this model profile.' });
  }

  async function saveProfile() {
    if (!state) return;
    setSaving(true);
    const result = await window.flowmate.saveSettings({ ...state.settings, profile: profileDraft });
    setSaving(false);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    const hostSequence = hostStateSequence.current;
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok && hostSequence === hostStateSequence.current) receiveDesktopState(refreshed.data);
    setNotice({ tone: 'good', message: 'Profile preferences saved.' });
  }
  async function saveRuntimeLimits() {
    if (!state) return;
    const limits = parseRuntimeLimits(runtimeDefaultsDraft);
    if (!limits.success) { setNotice({ tone: 'bad', message: 'Run limits must be whole numbers within the displayed ranges.' }); return; }
    setSaving(true);
    const saved = await window.flowmate.saveSettings({ ...state.settings, runtime: limits.data });
    setSaving(false);
    if (!saved.ok) { setNotice({ tone: 'bad', message: errorMessage(saved) }); return; }
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok) receiveDesktopState(refreshed.data);
    setNotice({ tone: 'good', message: 'Run limits saved.' });
  }

  async function testConnection() {
    if (!canTest || !selectedModelId) return;
    setBusy(true);
    const actualRuntime = await refreshRuntimeState();
    if (!actualRuntime || actualRuntime.blocked || actualRuntime.active !== null) {
      setBusy(false);
      setNotice({ tone: 'bad', message: runtimeMessage(actualRuntime, !actualRuntime, hostReadyRef.current) });
      return;
    }
    setCancelPending(false);
    setRun(null);
    setRunId(null);
    setNotice({ tone: 'info', message: 'Sending a real Provider request. The request may incur usage charges.' });
    connectionStarting.current = true; latestFinished.current.clear();
    const accepted = await window.flowmate.callProvider({ goal: 'Verify this model connection.', text: 'Reply with OK.', modelId: selectedModelId });
    connectionStarting.current = false;
    if (!accepted.ok) {
      void refreshRuntimeState();
      setBusy(false);
      setNotice({ tone: 'bad', message: errorMessage(accepted) });
      return;
    }
    activeRequestIdRef.current = accepted.data.requestId;
    setActiveRequestId(accepted.data.requestId);
    setRunId(accepted.data.runId);
    void refreshRuntimeState();
    const finished = latestFinished.current.get(accepted.data.requestId); latestFinished.current.clear();
    if (finished?.requestId === accepted.data.requestId) {
      setBusy(false);
      setCancelPending(false);
      activeRequestIdRef.current = null;
      setActiveRequestId(null);
    }
    await loadRun(accepted.data.runId);
  }

  async function sendAssistantMessage() {
    if (!researchTask || selectedSessionIdRef.current !== researchTask.sessionId) return sendChatMessage();
    const expectedSession = researchTask.sessionId;
    const loaded = await window.flowmate.queryResearchTask(researchTask.researchId);
    if (!loaded.ok) { setNotice({ tone: 'bad', message: errorMessage(loaded) }); return; }
    const task = loaded.data;
    const saved = task.currentPlanId ? await window.flowmate.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId }) : null;
    if (selectedSessionIdRef.current !== expectedSession) return;
    if (saved && !saved.ok) { setNotice({ tone: 'bad', message: errorMessage(saved) }); return; }
    const plan = saved?.ok ? saved.data : null;
    const planning = task.status === 'planning' || task.status === 'awaiting_confirmation' || !task.planConfirmed || !plan;
    await sendChatMessage(undefined, { text: chatInputRef.current, intent: planning
      ? { researchId: task.researchId, phase: 'planning', plan: null }
      : { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision }, continuation: true },
      ...(!planning && plan ? { execution: plan.body.execution } : {}) });
  }
  async function sendChatMessage(override?: { sessionId: number; prompt: string; scene: WorkspaceSnapshot; hostEpoch: number; detached: boolean },
    researchInput?: { text: string; intent: ResearchIntent; execution?: ResearchPlanBody['execution'] }) {
    if (!researchInput && (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current)) return;
    const sendEpoch = override?.hostEpoch ?? workspaceHostEpoch.current;
    const submittedDraft = researchInput?.text ?? override?.prompt ?? chatInputRef.current;
    const prompt = submittedDraft.trim();
    let sessionId = override?.sessionId ?? selectedSessionIdRef.current;
    const directory = researchInput ? '' : workingDirectory;
    const model = persistedModel;
    if ((!canChat && !override) || !modelReady || busy || !selectedModelId || !model || !prompt || inputSubmittingRef.current) return;
    if (override?.detached && (goalMode !== 'answer' || directory)) {
      setNotice({ tone: 'bad', message: 'Open the new chat and review its context and Run limits before sending. Your draft is preserved.' }); return;
    }
    inputSubmittingRef.current = true;
    setInputSubmitting(true);
    try {
    setBusy(true);
    const actualRuntime = await refreshRuntimeState();
    if (!actualRuntime || actualRuntime.blocked || actualRuntime.active !== null) {
      setBusy(false);
      setNotice({ tone: 'bad', message: runtimeMessage(actualRuntime, !actualRuntime, hostReadyRef.current) });
      return;
    }
    if (sendEpoch !== workspaceHostEpoch.current || !researchInput && !workspaceReady(workspaceStateRef.current)) {
      setBusy(false); setNotice({ tone: 'bad', message: 'The workspace changed while preparing your message. Your draft is preserved.' }); return;
    }
    setNotice({ tone: 'info', message: 'Preparing your request…' });
    if (sessionId === null) {
      const created = await createNewSession(true);
      if (!created) { setBusy(false); return; }
      sessionId = created.sessionId;
    }
    let current = researchInput ? null : workspaceRef.current ?? await loadWorkspace();
    if (sendEpoch !== workspaceHostEpoch.current || !researchInput && !workspaceReady(workspaceStateRef.current)) {
      setBusy(false); setNotice({ tone: 'bad', message: 'The workspace changed while preparing your message. Your draft is preserved.' }); return;
    }
    if (override && (override.hostEpoch !== workspaceHostEpoch.current || !current || current.revision !== override.scene.revision
      || !sameWorkspaceBasis(current, override.scene))) {
      setBusy(false); setNotice({ tone: 'bad', message: 'The workspace changed while preparing your message. Your draft is preserved.' }); return;
    }
    if (!researchInput && !override?.detached && current && current.sessionId !== sessionId) current = await changeWorkspace({ kind: 'session', sessionId });
    if (!researchInput && !current) { setBusy(false); return; }
    const sequence = await window.flowmate.querySessionInput({ sessionId });
    if (!sequence.ok || sequence.data.nextClientSequence === null) {
      setBusy(false);
      setNotice({ tone: 'bad', message: sequence.ok ? 'This chat cannot allocate another input.' : errorMessage(sequence) });
      return;
    }
    const clientSequence = sequence.data.nextClientSequence;
    if (sendEpoch !== workspaceHostEpoch.current || !researchInput && (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current
      || workspaceRef.current?.revision !== current!.revision || !sameWorkspaceBasis(workspaceRef.current, current!))) {
      setBusy(false); setNotice({ tone: 'bad', message: 'The workspace changed while preparing your message. Your draft is preserved.' }); return;
    }
    const turnId = newId();
    const newTurn: ChatTurn = { id: turnId, sessionId, runId: null, clientSequence, prompt, response: null, error: null, status: 'sending' };
    activeChatTurnId.current = turnId;
    activeChatSessionId.current = sessionId;
    activeAgentRunIdRef.current = null;
    agentStopRequested.current = false;
    setActiveRunModel({ id: model.id, name: model.name, model: model.model });
    const currentDraft = chatDrafts.current.get(draftKey(sessionId)) ?? '';
    const remainingDraft = currentDraft === submittedDraft ? '' : currentDraft.startsWith(`${submittedDraft}\n\n`)
      ? currentDraft.slice(submittedDraft.length + 2) : currentDraft;
    const clearedDraft = remainingDraft !== currentDraft;
    if (clearedDraft) {
      chatDrafts.current.set(draftKey(sessionId), remainingDraft);
      if (selectedSessionIdRef.current === sessionId) updateChatInput(remainingDraft);
    }
    if (selectedSessionIdRef.current === sessionId) setChatTurns((turns) => [...turns, newTurn]);
    setBusy(true);
    setCancelPending(false);
    setNotice(null);
    const request: DesktopSessionInputRequest = {
      sessionId,
      clientSequence,
      mode: 'prompt',
      text: prompt,
      modelId: model.id,
      ...(!researchInput && !override?.detached ? { workspace: {
        revision: current!.revision,
        documentRef: current!.documentRef,
        jobId: current!.jobId,
        candidateRef: current!.candidateRef,
        sessionId,
      } } : {}),
      goalMode: researchInput ? 'answer' : goalMode,
      ...(researchInput ? { research: researchInput.intent, ...researchInput.execution } : {}),
      ...(directory ? { workingDirectory: directory } : {}),
    };
    const accepted = await window.flowmate.submitInput(request);
    if (!accepted.ok) {
      if (accepted.error.code === 'operation_result_unknown' || accepted.error.code === 'input_delivery_unknown') {
        unknownInputs.current.set(sessionId, { ...request, submittedDraft });
        if (selectedSessionIdRef.current === sessionId) setUnknownInput({ sessionId, clientSequence });
      }
      void refreshRuntimeState();
      setChatTurns((turns) => turns.filter((turn) => turn.id !== turnId));
      if (clearedDraft) {
        const restoredDraft = chatDrafts.current.get(draftKey(sessionId));
        const nextDraft = restoredDraft === submittedDraft ? restoredDraft : restoredDraft ? `${submittedDraft}\n\n${restoredDraft}` : submittedDraft;
        chatDrafts.current.set(draftKey(sessionId), nextDraft);
        if (selectedSessionIdRef.current === sessionId) updateChatInput(nextDraft);
      }
      if (accepted.error.code === 'state_conflict') await loadWorkspace();
      setNotice({ tone: 'bad', message: accepted.error.code === 'state_conflict'
        ? 'Invoice context changed. Review it and press Send again; your message is preserved.' : errorMessage(accepted) });
      if (activeAgentRunIdRef.current === null) {
        setBusy(false);
        activeChatTurnId.current = null;
        activeChatSessionId.current = null;
        setActiveRunModel(null);
        agentStopRequested.current = false;
      }
      return;
    }
    if (goalMode === 'save-candidate') setGoalMode('answer');
    void refreshRuntimeState();
    knownRunSessions.current.set(accepted.data.runId, sessionId);
    void loadSessionInputs(sessionId);
    const finished = latestAgentFinished.current.get(accepted.data.runId);
    if (!finished) {
      activeAgentRunIdRef.current = accepted.data.runId;
      activeChatSessionId.current = sessionId;
      setActiveAgentRunId(accepted.data.runId);
      setActiveAgentSessionId(sessionId);
      setBusy(true);
      if (agentStopRequested.current) {
        agentStopRequested.current = false;
        void requestAgentCancellation(accepted.data.runId);
      }
    }
    setRunId(accepted.data.runId);
    void loadRun(accepted.data.runId);
    setChatTurns((turns) => turns.map((turn) => turn.id === turnId
      ? { ...turn, runId: accepted.data.runId, inputId: accepted.data.inputId }
      : turn));
    if (finished) {
      if (activeChatTurnId.current === turnId || activeAgentRunIdRef.current === accepted.data.runId) {
        setBusy(false);
        setCancelPending(false);
        activeAgentRunIdRef.current = null;
        activeChatSessionId.current = null;
        setActiveAgentRunId(null);
        setActiveAgentSessionId(null);
        setActiveRunModel(null);
        agentStopRequested.current = false;
        activeChatTurnId.current = null;
        applyAgentFinish(finished, turnId);
      }
    }
    } finally { inputSubmittingRef.current = false; setInputSubmitting(false); }
  }

  async function appendChatInput(mode: 'steer' | 'followUp') {
    if (!researchSelected && (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current)) return;
    const sessionId = selectedSessionIdRef.current;
    const runId = activeAgentRunIdRef.current;
    const submittedDraft = chatInputRef.current;
    const prompt = submittedDraft.trim();
    if (!canAppend || !sessionId || !runId || !prompt || inputSubmittingRef.current) return;
    inputSubmittingRef.current = true; setInputSubmitting(true);
    try {
      const actual = await refreshRuntimeState();
      if (!actual || actual.blocked || actual.active?.runId !== runId || actual.active.sessionId !== sessionId) {
        setNotice({ tone: 'bad', message: 'This Run no longer accepts inputs. Your draft is preserved.' }); return;
      }
      const [sequence, originalRun] = await Promise.all([
        window.flowmate.querySessionInput({ sessionId }), window.flowmate.queryRun(runId),
      ]);
      if (!sequence.ok || sequence.data.nextClientSequence === null || !originalRun.ok || originalRun.data.kind !== 'agent') {
        setNotice({ tone: 'bad', message: 'The active Run or next input could not be confirmed. Your draft is preserved.' }); return;
      }
      if (originalRun.data.runId === runId && originalRun.data.sessionId === sessionId) setRun(originalRun.data);
      const clientSequence = sequence.data.nextClientSequence;
      const current = workspaceRef.current;
      if (!researchSelected && (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current)) return;
      const hasWorkspace = originalRun.data.config.workspaceContext !== undefined;
      if (hasWorkspace && (!current || current.sessionId !== sessionId)) {
        setNotice({ tone: 'bad', message: 'Select this Run’s invoice context before adding an input. Your draft is preserved.' }); return;
      }
      const request: DesktopSessionInputRequest = { sessionId, clientSequence, mode, runId, text: prompt,
          ...(hasWorkspace && current ? { workspace: { revision: current.revision, documentRef: current.documentRef,
          jobId: current.jobId, candidateRef: current.candidateRef, sessionId } } : {}),
      };
      const accepted = await window.flowmate.submitInput(request);
      if (!accepted.ok) {
        if (accepted.error.code === 'operation_result_unknown' || accepted.error.code === 'input_delivery_unknown') {
          unknownInputs.current.set(sessionId, { ...request, submittedDraft });
          if (selectedSessionIdRef.current === sessionId) setUnknownInput({ sessionId, clientSequence });
        }
        setNotice({ tone: 'bad', message: errorMessage(accepted) }); return;
      }
      const currentDraft = chatDrafts.current.get(draftKey(sessionId)) ?? '';
      const remainingDraft = currentDraft === submittedDraft ? '' : currentDraft.startsWith(`${submittedDraft}\n\n`)
        ? currentDraft.slice(submittedDraft.length + 2) : currentDraft;
      chatDrafts.current.set(draftKey(sessionId), remainingDraft);
      if (selectedSessionIdRef.current === sessionId) updateChatInput(remainingDraft);
      await loadSessionInputs(sessionId);
    } finally { inputSubmittingRef.current = false; setInputSubmitting(false); }
  }

  async function setSessionStatus(sessionId: number, status: 'active' | 'archived') {
    const session = sessions.find(item => item.sessionId === sessionId);
    if (!session || sessionMutating) return;
    setSessionMutating(true);
    try {
      const result = await window.flowmate.setSessionStatus({ sessionId, expectedStatus: session.status, status });
      if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
      setSessions(items => items.map(item => item.sessionId === sessionId ? result.data : item));
      await loadWorkspace();
      if (selectedSessionIdRef.current === sessionId) {
        sessionLoadSequence.current += 1;
        setSelectedSession(result.data);
        void queryChatMessages(sessionId);
      }
      void loadSessionList();
      setNotice({ tone: 'good', message: status === 'archived' ? 'Chat archived. Its messages and draft are preserved.' : 'Chat is ready to continue.' });
    } finally { setSessionMutating(false); }
  }

  function historyBranchSaved(sessionId: number) {
    if (selectedSessionIdRef.current !== sessionId) return;
    const branchMessages = { ...emptyMessageState(sessionId), closedRuns: new Set(messageStates.current.get(sessionId)?.closedRuns ?? []) };
    messageStates.current.set(sessionId, branchMessages); messageCursors.current.delete(sessionId); historyPositions.current.delete(sessionId);
    setMessageState(branchMessages); void queryChatMessages(sessionId);
  }

  async function selectFork(result: ForkSessionResult, current: () => boolean): Promise<boolean> {
    if (!current() || !await confirmFormLeave() || !current()) return false;
    const valid = current;
    const saved = await mutateWorkspace(async workspace => {
      if (!valid()) return { ok: false, error: { code: 'state_conflict', category: 'runtime', retryable: false, message: 'Chat selection changed.' } };
      const update = await window.flowmate.updateWorkspace({ expectedRevision: workspace.revision, change: { kind: 'session', sessionId: result.session.sessionId } });
      return update.ok ? { ok: true, data: { workspace: update.data } } : update;
    }, { kind: 'session', sessionId: result.session.sessionId }, valid);
    if (!valid() || !saved || saved.workspace.sessionId !== result.session.sessionId) return false;
    selectSession(result.session.sessionId, true); closeSessionDetails(); void loadSessionList(); return true;
  }

  async function branchSession(targetEntryId: string) {
    const sessionId = selectedSessionIdRef.current;
    const position = sessionId === null ? undefined : historyPositions.current.get(sessionId);
    if (!sessionId || !position || sessionMutating || historyLoading) return;
    const epoch = workspaceHostEpoch.current, selection = sessionLoadSequence.current;
    const current = () => epoch === workspaceHostEpoch.current && selection === sessionLoadSequence.current && selectedSessionIdRef.current === sessionId;
    setSessionMutating(true);
    try {
      const result = await window.flowmate.branchSession({ sessionId, expectedLeafId: position.leafId,
        expectedEntryCount: position.entryCount, expectedCommitRevision: position.commitRevision, targetEntryId });
      if (!current()) return;
      if (!result.ok) { setNotice({ tone: 'bad', message: result.error.message }); return; }
      historyBranchSaved(sessionId);
      setNotice({ tone: 'good', message: 'Chat position saved. Your next Send will continue from this reply.' });
    } catch { if (current()) setNotice({ tone: 'bad', message: 'History is unavailable.' }); }
    finally { if (current()) setSessionMutating(false); }
  }

  async function newChatAndSend() {
    const prompt = chatInputRef.current.trim();
    if (!prompt || !runtimeReady || busy) return;
    if (!workspaceReady(workspaceStateRef.current) || workspacePendingRef.current) return;
    const epoch = workspaceHostEpoch.current;
    const initial = workspaceRef.current;
    const created = await createNewSession(true);
    if (!created) return;
    // A create may have queued its own selection and the user's later selection.
    // Wait for those facts, without repeating either write or replacing the later choice.
    while (workspacePendingRef.current && epoch === workspaceHostEpoch.current) await workspaceChanges.current;
    const scene = workspaceRef.current;
    if (epoch !== workspaceHostEpoch.current || !workspaceReady(workspaceStateRef.current) || !scene) return;
    const detached = selectedSessionIdRef.current !== created.sessionId || scene.sessionId !== created.sessionId;
    const sameBusiness = initial?.documentRef?.id === scene.documentRef?.id && initial?.documentRef?.version === scene.documentRef?.version
      && initial?.jobId === scene.jobId && initial?.candidateRef?.id === scene.candidateRef?.id && initial?.candidateRef?.sequence === scene.candidateRef?.sequence;
    if (!sameBusiness || initial?.activeView !== scene.activeView || !sameWorkspaceSelection(initial?.selection ?? null, scene.selection)
      || detached && (scene.documentRef || scene.jobId || scene.candidateRef || scene.selection || workingDirectory)) {
      setNotice({ tone: 'info', message: 'The invoice context changed. Open the new chat and review its draft before sending.' }); return;
    }
    await sendChatMessage({ sessionId: created.sessionId, prompt, scene, hostEpoch: epoch, detached });
  }

  function applyAgentFinish(event: Extract<AgentRunEvent, { type: 'run_finished' }>, turnId: string) {
    setChatTurns((turns) => turns.filter((turn) => turn.id !== turnId));
    if (selectedSessionIdRef.current !== event.sessionId) return;
    if (!event.result.ok) {
      setRunFeedbacks((items) => [...items.filter((item) => item.runId !== event.runId),
        { runId: event.runId, status: 'failed', error: errorMessage(event.result) }]);
      return;
    }
    const outcome = event.result.data;
    if (outcome.status !== 'completed') {
      setRunFeedbacks((items) => [...items.filter((item) => item.runId !== event.runId),
        { runId: event.runId, status: outcome.status, error: outcome.error ? errorMessage({ error: outcome.error }) : null }]);
    }
  }

  async function cancelAgentRun() {
    const runId = activeAgentRunIdRef.current;
    if (!busy) return;
    setCancelPending(true);
    if (runId === null) {
      agentStopRequested.current = true;
      setNotice({ tone: 'info', message: 'Stop requested. Waiting for the request to start.' });
      return;
    }
    await requestAgentCancellation(runId);
  }

  async function requestAgentCancellation(runId: number) {
    if (invoiceFormRef.current?.runId === runId) publishInvoiceForm(cancelInvoiceFormRun(invoiceFormRef.current));
    setCancelPending(true);
    const result = await window.flowmate.cancelRun(runId);
    if (!result.ok) {
      setCancelPending(false);
      setNotice({ tone: 'bad', message: errorMessage(result) });
      return;
    }
    setNotice({ tone: 'info', message: result.data.accepted
      ? 'Stop was accepted. Waiting for the Agent to confirm it stopped.'
      : 'The response has already ended. Its saved result is shown in the chat.' });
  }

  async function cancelRequest() {
    if (!activeRequestId || !busy) return;
    setCancelPending(true);
    const result = await window.flowmate.cancelProvider(activeRequestId);
    if (!result.ok) {
      setNotice({ tone: 'bad', message: errorMessage(result) });
      return;
    }
    setNotice({ tone: 'info', message: result.data.accepted
      ? 'Cancellation was accepted. Waiting for the Provider to confirm it stopped.'
      : 'No active request was found. The saved result remains available.' });
  }

  async function loadRun(id: number) {
    const result = await window.flowmate.queryRun(id);
    if (result.ok) setRun(result.data);
    else setNotice({ tone: 'bad', message: errorMessage(result) });
  }

  async function removeModel() {
    if (!state || !selectedModelId || !persistedModel) return;
    const models = state.settings.models.filter((model) => model.id !== selectedModelId);
    const saved = await window.flowmate.saveSettings({
      ...state.settings,
      profile: profileDraft,
      models,
      defaultModelId: models[0]?.id ?? null,
    });
    if (!saved.ok) { setNotice({ tone: 'bad', message: errorMessage(saved) }); return; }
    const hostSequence = hostStateSequence.current;
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok && hostSequence === hostStateSequence.current) receiveDesktopState(refreshed.data);
    setRun(null);
    setNotice({ tone: 'good', message: 'Model profile removed.' });
  }

  const workspaceDocument = documents.find(item => item.documentRef.id === workspace?.documentRef?.id
    && item.documentRef.version === workspace.documentRef.version)
    ?? (workspace?.documentRef && historicalDocuments[workspace.documentRef.id]?.documentRef.version === workspace.documentRef.version
      ? historicalDocuments[workspace.documentRef.id]! : null);
  const workspaceParsed = parsedPage && parsedPage.documentRef.id === workspace?.documentRef?.id
    && parsedPage.documentRef.version === workspace.documentRef.version && parsedPage.parsedArtifactId === workspaceDocument?.parsedArtifactId ? parsedPage : null;
  const workspaceOriginal = originalImage && originalImage.documentRef.id === workspace?.documentRef?.id
    && originalImage.documentRef.version === workspace.documentRef.version ? originalImage : null;
  const workspaceIndex = parsedIndex && parsedIndex.documentRef.id === workspace?.documentRef?.id
    && parsedIndex.documentRef.version === workspace.documentRef.version && parsedIndex.parsedArtifactId === workspaceDocument?.parsedArtifactId ? parsedIndex : null;

  const invoiceFormControls = invoiceForm || candidateDetail && workspace?.candidateRef?.id === candidateDetail.candidate.candidateId ? <>
              {candidateDetail && workspace?.candidateRef?.id === candidateDetail.candidate.candidateId && candidateDetail.candidate.status !== 'accepted' && <div className="button-row"><button className="secondary-button" disabled={!dependentReady || !runtimeReady || !modelReady || busy || formPreparing || formSubmitting || formOutcomeUnknown || humanOperationUnknown || invoiceForm?.dirty || !workspace?.sessionId || candidateDetail.candidate.status !== 'generated'}
                onClick={() => void fillInvoiceForm()}>Fill form</button>
                <button className="secondary-button" disabled={!dependentReady || !runtimeReady || busy || formPreparing || formSubmitting}
                  onClick={() => void beginEditInvoiceForm()}>Edit result</button></div>}
              {invoiceForm && <InvoiceFormEditor state={invoiceForm} feedback={formFeedback} disabled={!dependentReady || !invoiceForm.valid || busy || formPreparing || formSubmitting}
                onChange={changeInvoiceFormDraft} onDiscard={() => void discardInvoiceChanges()} onQuery={() => void checkFillStatus()}
                canQuery={invoiceForm.runId !== null || pendingFill.current !== null} canDiscard={!busy && !formPreparing && !formSubmitting && !humanOperationUnknown}
                operationUnknown={humanOperationUnknown} onSave={() => void saveInvoiceResult()} onAccept={() => void decideInvoiceResult('accept')} onReject={() => void decideInvoiceResult('reject')} />}
              {candidateDetail?.candidate.status === 'accepted' && <div className="button-row">{(['json', 'csv', 'markdown'] as const).map(format =>
                <button key={format} className="secondary-button" disabled={formSubmitting || humanOperationUnknown} onClick={() => void exportInvoiceResult(format)}>Export {format === 'markdown' ? 'Markdown' : format.toUpperCase()}</button>)}</div>}
              <button className="text-button" disabled={formSubmitting} onClick={() => void checkHumanOperation()}>Check original operation</button>
            </> : null;

  return (
    <div ref={panels.shellRef} style={panels.style} className={`desktop-shell theme-${profileDraft.theme} ${page === 'personal' ? 'personal-is-main' : ''} ${chatPresentation === 'main' ? 'conversation-is-main' : ''} ${assistantCollapsed ? 'chat-is-collapsed' : ''} ${navOpen ? 'nav-is-open' : ''} ${panels.dragging ? 'panels-resizing' : ''}`}>
      {panels.separators}
      {rejectPrompt && <div role="dialog" aria-modal="true" aria-label="Reject invoice result"
        style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center' }}>
        <section className="panel" style={{ maxWidth: 440, padding: 24 }}><h2>Reject invoice result</h2>
          <label className="field"><span>Reason for rejection</span><textarea autoFocus value={rejectReason} maxLength={256}
            onChange={event => setRejectReason(event.target.value)} /></label><div className="button-row">
            <button className="secondary-button" onClick={() => setRejectPrompt(false)}>Cancel</button>
            <button className="danger-action" disabled={!rejectReason.trim()} onClick={() => void decideInvoiceResult('reject', rejectReason)}>Reject result</button>
          </div></section></div>}
      {formLeavePrompt && <div role="dialog" aria-modal="true" aria-label="Unsaved invoice changes"
        style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center' }}>
        <section className="panel" style={{ maxWidth: 440, padding: 24 }}><h2>Unsaved invoice changes</h2>
          <p>Your manual changes are still in this local draft.</p><div className="button-row">
            <button className="secondary-button" autoFocus disabled={formSubmitting} onClick={() => void resolveFormLeave(false)}>Continue editing</button>
            <button className="secondary-button" disabled={formSubmitting || !invoiceForm?.valid} onClick={() => void saveInvoiceResult().then(saved => { if (saved) void resolveFormLeave(true); })}>Save result</button>
            <button className="danger-action" onClick={() => void resolveFormLeave(true)}>Discard changes</button>
          </div></section></div>}
      {navOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => { setNavOpen(false); navToggleRef.current?.focus(); }} />}
      <aside className={`rail ${navOpen ? 'expanded' : ''}`} data-testid="workspace-sidebar"
        onKeyDown={(event) => { if (event.key === 'Escape' && navOpen) { setNavOpen(false); navToggleRef.current?.focus(); } }}>
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span className="brand-wordmark"><strong>Flowmate</strong><small>LOCAL WORKSPACE</small></span>
          <button ref={navToggleRef} type="button" className="rail-toggle" aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}>{navOpen ? '×' : '☰'}</button>
        </div>
        <button className="sidebar-new-chat" type="button" aria-label="New chat" title="New chat" disabled={!state?.ready || sessionLoading || sessionMutating}
          onClick={() => { void navigate('conversation').then(moved => { if (moved) void createNewSession(); }); }}>
          <NavigationIcon name="new-chat" /><span>New chat</span>
        </button>
        <nav aria-label="Workspace navigation">
          <span className="rail-caption">WORK</span>
          {([
            ['personal', 'Personal Agent'],
            ['workspace', 'Invoices'],
            ['workspace-detail', 'Workspace'],
            ['tasks', 'Processing History'],
            ['chats', 'Chats'],
            ['research', 'Deep Research'],
            ['activity', 'Activity'],
          ] as const).map(([target, label]) => <button key={target} type="button"
            className={`nav-item ${page === target ? 'active' : ''}`} aria-label={label} title={label}
            aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}>
            <span className="nav-glyph"><NavigationIcon name={target} /></span><span>{label}</span>
          </button>)}
          <span className="rail-caption setup-caption">SETUP</span>
          {([
            ['models', 'Models'],
            ['evaluation', 'Evaluation'],
            ['prompts', 'Prompts'],
            ['skills', 'Skills'],
            ['extensions', 'Extensions'],
          ] as const).map(([target, label]) => <button key={target} type="button"
            className={`nav-item ${page === target ? 'active' : ''}`} aria-label={label} title={label}
            aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}>
            <span className="nav-glyph"><NavigationIcon name={target} /></span><span>{label}</span>
          </button>)}
        </nav>
        <section className="sidebar-recents" aria-label="Recent chats">
          <div className="sidebar-section-head"><span>RECENT CHATS</span><button type="button" onClick={() => navigate('chats')}>View all</button></div>
          {sessions.filter(session => session.status === 'active').slice(0, 5).map((session) => <div key={session.sessionId} className="sidebar-chat-row">{sidebarRenameId === session.sessionId
            ? <form className="sidebar-chat-edit" onSubmit={async (event) => {
              event.preventDefault();
              if (await renameSession(session.sessionId, sidebarRenameTitle.trim())) setSidebarRenameId(null);
            }}><input autoFocus aria-label="Chat title" value={sidebarRenameTitle} maxLength={120}
              onChange={(event) => setSidebarRenameTitle(event.target.value)} />
              <button type="submit" disabled={sessionMutating || !sidebarRenameTitle.trim()}>Save</button>
              <button type="button" onClick={() => setSidebarRenameId(null)}>Cancel</button>
            </form>
            : <><button type="button" data-session-id={session.sessionId}
            className={`sidebar-chat ${session.sessionId === selectedSessionId ? 'selected' : ''}`}
            aria-label={`Open chat ${chatTitle(session.title)}`}
            aria-current={session.sessionId === selectedSessionId ? 'true' : undefined}
            onClick={() => openChat(session.sessionId)}>
            <span className="sidebar-chat-mark" aria-hidden="true">◌</span>
            <span className="sidebar-chat-title">{chatTitle(session.title)}</span>
          </button><button className="sidebar-chat-rename" type="button" aria-label={`Rename chat ${chatTitle(session.title)}`}
            disabled={sessionMutating || session.status === 'archived'} onClick={() => {
              setSidebarRenameId(session.sessionId);
              setSidebarRenameTitle(chatTitle(session.title));
            }}>Rename</button></>}</div>)}
          {sessions.length === 0 && <p className="sidebar-empty">Your conversations will appear here.</p>}
        </section>
        <div className="rail-bottom">
          <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} type="button" aria-label="Settings" title="Settings"
            aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}>
            <span className="nav-glyph"><NavigationIcon name="settings" /></span><span>Settings</span>
          </button>
          <div className="sidebar-status"><span className={`status-dot ${state?.ready ? 'is-ready' : 'is-error'}`} />
            <span>{state?.ready ? 'Ready' : 'Unavailable'}</span></div>
        </div>
      </aside>

      {evaluationView.control && evaluationView.control.state !== 'idle' && <section className="evaluation-global" aria-label="Global evaluation control">
        <button className="text-button" onClick={() => navigate('evaluation')}>Evaluation: {evaluationView.control.state}</button>
        <span>{evaluationView.control.progress?.caseId ?? evaluationView.control.batchId} · stop: {evaluationView.control.stop}</span>
        {evaluationBusy(evaluationView.control) && <button className="secondary-button" disabled={!['preparing', 'running', 'cancelling'].includes(evaluationView.control.state)}
          onClick={() => void stopEvaluation()}>Stop evaluation</button>}
      </section>}
      <main className="workspace" data-testid="main-content" hidden={chatPresentation === 'main'}>
        {sourceReview && <section className="panel invoice-evidence" aria-label="Source evidence">
          <div className="panel-head"><h2>Source evidence</h2><button className="text-button" onClick={() => { sourceReviewGeneration.current++; setSourceReview(null); }}>Close evidence</button></div>
          <p>Document {sourceReview.source.documentId} · {sourceReview.source.version} · artifact {sourceReview.source.artifactId} · page {sourceReview.source.page} · {sourceReview.source.blockId ?? 'whole page'}</p>
          <p>Quote: {sourceReview.source.quote ?? 'None saved'}</p>
          {sourceReview.loading && <p role="status">Loading parsed evidence…</p>}
          {sourceReview.error && <p role="alert">{sourceReview.error}<button className="text-button" onClick={() => void reviewInvoiceSource(sourceReview.source)}>Retry evidence</button></p>}
          {sourceReview.text !== null && <pre>{sourceReview.text || '(no extracted text)'}</pre>}
        </section>}
        <header className="topline">
          <div><span className="crumb">{pageLabels[page]}</span></div>
          <div className="top-state"><span className={`status-dot ${state?.ready ? 'is-ready' : 'is-error'}`} />{state?.backgroundService && state.backgroundService.state !== 'disabled'
            ? `SERVICE · ${state.backgroundService.state}` : state?.ready ? 'LOCAL' : 'OFFLINE'}</div>
        </header>

        {personalReview && (page === 'workspace' || page === 'workspace-detail') && workspace?.documentRef?.id === personalReview.documentRef.id
          && workspace.documentRef.version === personalReview.documentRef.version && <section className="notice personal-review-return" aria-label="Personal Agent invoice review">
            <span>Original invoice item {personalReview.itemId} · Personal Agent Work {personalReview.workId}. Candidate acceptance and Work disposition are recorded separately.</span>
            <button type="button" disabled={formSubmitting || formPreparing || workspacePending > 0} onClick={() => void navigate('personal')}>Return to Personal Agent Work {personalReview.workId}</button>
          </section>}

        <PromptOptimizer visible={page === 'prompts'} hostEpoch={workspaceHostEpoch.current} ready={Boolean(modelReady && runtimeReady && !busy && !saving)}
          model={persistedModel} onUse={text => { updateChatInput(chatInputRef.current ? `${chatInputRef.current}\n\n${text}` : text); setChatCollapsed(false); }} />
        {page === 'conversation' ? null : page === 'evaluation' ? <EvaluationPage desktop={state} control={evaluationView.control} revision={() => evaluationViewRef.current.revision}
          traceTarget={evaluationTraceTarget} onOpenActivity={(runId, sessionId) => { void navigate('activity').then(moved => { if (moved) observeActivity(runId, sessionId); }); }}
          onControl={receiveEvaluationControl} onModels={() => navigate('models')} /> : page === 'prompts' ? null : page === 'workspace' ? (
          <InvoicesPage
            workspace={workspace}
            documents={documents}
            historicalDocument={historicalInvoice}
            historicalView={historicalInvoiceView}
            candidates={candidateSummaries}
            candidateDetail={candidateDetail}
            onOpenContextBasis={candidate => void openCandidateContextBasis(candidate)}
            onReviewSource={source => void reviewInvoiceSource(source)}
            onSelectCandidate={(jobId, candidateId) => void selectCandidate(jobId, candidateId)}
            formControls={invoiceFormControls}
            dependentReady={dependentReady}
            taskGoal={taskGoal}
            parsedPage={parsedPage}
            originalImage={originalImage}
            notice={notice}
            onImport={() => void importInvoice()}
            onSelectDocument={(id) => void selectWorkspaceDocument(id)}
            onHideDocument={(id) => void hideInvoice(id)}
            hidingDocumentId={hidingDocumentId}
            onStartTask={() => void startTask()}
            onOpenCandidate={(jobId, candidateId) => void openCandidate(jobId, candidateId)}
            onTaskGoalChange={setTaskGoal}
            onChangeView={(view) => { if (historicalInvoice) setHistoricalInvoiceView(view); else void changeWorkspace({ kind: 'view', view }); }}
            onRefresh={() => void loadProductOverview()}
            onRevokeModelAccess={() => void revokeModelAccess()}
            revokingAccess={revokingAccess}
          />
        ) : page === 'workspace-detail' ? (
          <WorkspacePage workspace={workspace} state={workspaceState}
            document={workspaceDocument}
            job={jobs.find(item => item.jobId === workspace?.jobId) ?? (workspace?.jobId ? historicalJobs[workspace.jobId] ?? null : null)}
            chatName={selectedSession?.title ?? sessions.find(item => item.sessionId === workspace?.sessionId)?.title ?? null}
            candidate={workspaceCandidate ?? candidateDetail} candidateLoading={workspaceCandidateLoading} candidateError={workspaceCandidateError}
            parsedPage={workspaceParsed} original={workspaceOriginal} materialLoading={materialLoading} materialError={materialError}
            pages={workspaceIndex?.pages.map(page => page.page) ?? []}
            originalPageSelectable={!!workspaceIndex?.pages.some(page => page.page === 1)} view={localWorkspaceView ?? workspace?.activeView ?? 'original'}
            dependentReady={dependentReady} formControls={invoiceFormControls}
            onRefresh={() => void restoreWorkspace()}
            onView={view => { setLocalWorkspaceView(null); void changeWorkspace({ kind: 'view', view }); }}
            onPage={number => void readParsedPage(number)}
            onMoreBlocks={() => parsedPage && void readParsedPage(parsedPage.page, true)}
            onSelection={selection => void changeWorkspace({ kind: 'selection', selection })}
            onSource={source => void selectWorkspaceSource(source)}
            onSelectCandidate={(jobId, candidateId) => void selectCandidate(jobId, candidateId)} />
        ) : page === 'tasks' ? (
          <TasksPage
            workspace={workspace}
            documents={documents}
            historicalDocuments={historicalDocuments}
            historicalJobs={historicalJobs}
            jobs={jobs}
            selectedJobId={historyJobId ?? workspace?.jobId ?? null}
            candidates={candidateSummaries}
            candidateDetail={candidateDetail}
            onOpenContextBasis={candidate => void openCandidateContextBasis(candidate)}
            onReviewSource={source => void reviewInvoiceSource(source)}
            activity={activity}
            notice={notice}
            onOpenJob={(jobId) => void openJob(jobId)}
            onHideJob={(jobId) => void hideProcessing(jobId)}
            onOpenCandidate={(jobId, candidateId) => void openCandidate(jobId, candidateId)}
            onSelectCandidate={(jobId, candidateId) => void selectCandidate(jobId, candidateId)}
          />
        ) : page === 'chats' ? (
          <ChatsPage sessions={sessions} selectedSessionId={selectedSessionId} activeSessionId={activeAgentSessionId}
            managementBlocked={!state?.ready || !runtimeState || runtimeState.blocked} hasMore={sessionCursor !== null}
            workingDirectory={workingDirectory} onChooseDirectory={() => void chooseWorkingDirectory()}
            onClearDirectory={() => setWorkingDirectory('')}
            runDirectory={run?.kind === 'agent' && typeof run.config.workingDirectory === 'string'
              ? { runId: run.runId, directory: run.config.workingDirectory } : null}
            ready={Boolean(state?.ready && !sessionLoading && !sessionMutating)}
            mutating={sessionMutating} notice={notice} onSelect={openChat}
            onRename={renameSession} onDelete={deleteSession} onSetStatus={setSessionStatus} onLoadMore={() => void loadMoreSessions()} />
        ) : page === 'personal' && state ? (
          <PersonalAgentPage key={`personal:${workspaceHostEpoch.current}`} ready={state.ready} hostEpoch={workspaceHostEpoch.current}
            models={state.settings.models} onModels={() => void navigate('models')} onOpenInvoice={openPersonalInvoice} />
        ) : page === 'research' && state ? (
          <ResearchPage key={`research:${workspaceHostEpoch.current}`} ready={state.ready} documents={documents}
            canRun={canChat && researchSelected} selectedId={researchTask?.researchId ?? null} refreshToken={`${contextRefresh}:${busy}:${runId}`}
            onSelect={(task, draft) => { setResearchChatCollapsed(draft === undefined); setResearchTask(task); selectSession(task.sessionId, draft !== undefined, true); if (draft !== undefined) updateChatInput(draft); void loadSessionList(); }}
            onUpdated={task => setResearchTask(current => current?.researchId === task.researchId ? task : current)}
            onAssistant={collapsed => { setResearchChatCollapsed(collapsed); if (!collapsed) requestAnimationFrame(() => chatComposerRef.current?.focus()); }}
            running={busy && researchTask?.sessionId === activeAgentSessionId} stopping={cancelPending} onStop={() => void cancelAgentRun()}
            onRun={(text, intent, execution) => { setResearchChatCollapsed(false); void sendChatMessage(undefined, { text, intent, execution }); }} />
        ) : page === 'activity' ? (
          <ActivityPage key={`activity:${workspaceHostEpoch.current}`} hostEpoch={workspaceHostEpoch.current} ready={Boolean(state?.ready)}
            sessions={sessions} selectedSessionId={selectedSessionId} jobs={jobs} documents={documents}
            onOpenContextBasis={basis => openSessionDetails(basis.sessionId, basis)}
            onOpenEvaluationTrace={(runId, sessionId) => { void navigate('evaluation').then(moved => { if (moved) setEvaluationTraceTarget({ runId, sessionId }); }); }}
            currentRun={run} runtime={runtimeState} view={activityView} snapshot={activitySnapshot} tools={activityTools}
            snapshotError={activitySnapshotError} toolsError={activityToolsError} toolsVerified={activityToolsVerified}
            nextToolId={activityToolCursor} toolsLoading={activityToolsLoading} onLoadMoreTools={() => void loadEarlierActivityTools()}
            onClearObservation={clearActivityObservation}
            onObserve={observeActivity} onRefresh={refreshObservedActivity} onSegment={after => chooseActivitySegment(after)}
            onRetryPrefix={() => chooseActivitySegment(null)}
            onOpenInvoice={id => { void navigate('workspace').then(moved => { if (moved) void selectWorkspaceDocument(id); }); }}
            onOpenProcessing={id => { void navigate('tasks').then(moved => { if (moved) void openJob(id); }); }} />
        ) : page === 'extensions' && state ? (
          <ExtensionsPage key={`extensions:${workspaceHostEpoch.current}`} hostEpoch={workspaceHostEpoch.current} ready={state.ready}
            settings={state.settings} selectedSessionId={selectedSessionId ?? workspace?.sessionId ?? null} refreshToken={contextRefresh}
            onSaved={async () => { const next = await window.flowmate.getState(); if (next.ok) receiveDesktopState(next.data); }} />
        ) : page === 'skills' ? (
          <ResourcePage key={`${page}:${workspaceHostEpoch.current}`} kind='skill' hostEpoch={workspaceHostEpoch.current}
            ready={Boolean(state?.ready)} revision={state?.settings.revision ?? 0} onSaved={async () => { const next = await window.flowmate.getState(); if (next.ok) receiveDesktopState(next.data); }} />
        ) : (
          <section className="page-content">
            <div className="page-heading">
              <div><h1>{pageLabels[page]}</h1><p>{page === 'models'
                ? 'Choose and configure the models available to Assistant.'
                : 'Make Flowmate comfortable to use on this device.'}</p></div>
            </div>

            {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
            {!state?.ready && <div className="notice bad" role="alert">The application Host is not ready. No model request can be sent until its data store opens successfully.</div>}

            {page === 'settings' && <div className="settings-tabs" role="tablist" aria-label="Settings sections">{['General', 'LLM', 'Connections', 'Skills', 'Performance'].map((tab, index, tabs) =>
              <button key={tab} type="button" role="tab" id={`settings-tab-${tab}`} aria-controls={`settings-panel-${tab}`} aria-selected={settingsTab === tab}
                tabIndex={settingsTab === tab ? 0 : -1} onClick={() => setSettingsTab(tab)} onKeyDown={event => {
                  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
                  if (next !== null) { event.preventDefault(); setSettingsTab(tabs[next]!); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); }
                }}>{tab}</button>)}</div>}
            <div role={page === 'settings' ? 'tabpanel' : undefined} id={page === 'settings' ? `settings-panel-${settingsTab}` : undefined}
              aria-labelledby={page === 'settings' ? `settings-tab-${settingsTab}` : undefined}>
            {page === 'settings' && settingsTab === 'General' && <section className="panel settings-application"><div className="panel-head"><h2>Application</h2></div>
              <dl className="settings-facts"><div><dt>Application</dt><dd>Flowmate</dd></div><div><dt>Version</dt><dd>{state?.appVersion ?? 'Unavailable'}</dd></div>
                <div><dt>Agent runtime</dt><dd>{!state?.ready ? 'Unavailable' : runtimeReadFailed || !runtimeState ? 'Checking status' : runtimeState.blocked ? 'Blocked' : runtimeState.active ? 'Busy' : 'Ready'}</dd></div><div><dt>Active model</dt><dd>{persistedModel?.name ?? 'None selected'}</dd></div></dl></section>}
            {(page === 'models' || page === 'settings' && settingsTab === 'LLM') && <div className="model-layout">
              <section className="panel model-list-panel">
                <div className="panel-head"><div><span className="section-index">MODEL ROUTES</span><h2>Your models</h2></div><button className="quiet-button" onClick={() => { const fresh = blankModel(); setDraft(fresh); setSelectedModelId(fresh.id); setApiKey(''); setRun(null); setNotice(null); }}>＋ Add</button></div>
                <div className="model-list">
                  {savedModels.length === 0 && <div className="empty-route"><div className="empty-symbol">＋</div><strong>No models yet</strong><span>Choose a Pi provider and model to begin.</span></div>}
                  {savedModels.map((model) => <button key={model.id} title={model.name} className={`route-row ${selectedModelId === model.id ? 'selected' : ''}`} onClick={() => selectModel(model.id)}>
                    <span className="route-icon">{(model.providerId ?? model.api).slice(0, 1).toUpperCase() || 'P'}</span>
                    <span className="route-name"><strong>{model.name}</strong><small>{model.model}</small></span>
                    <span className={`credential-pill ${state?.modelCredentials[model.id] === 'configured' ? 'ready' : ''}`}>{model.kind === 'legacy' ? 'RECONFIGURE' : state?.modelCredentials[model.id] === 'configured' ? 'KEY SAVED' : state?.modelCredentials[model.id] === 'unavailable' ? 'LOCKED' : 'KEY NEEDED'}</span>
                  </button>)}
                </div>
                <div className="list-foot"><span>{savedModels.length} saved model{savedModels.length === 1 ? '' : 's'}</span></div>
              </section>

              <section className="panel config-panel">
                <div className="panel-head"><h2>Model details</h2>{draft.kind === 'catalog' && <button type="button" className="quiet-button"
                  disabled={catalogLoading} onClick={() => void refreshCatalog()}>{catalogLoading ? 'Loading…' : draft.providerId ? 'Refresh models' : 'Reload providers'}</button>}</div>
                <div className="form-grid">
                  <div className="field full"><span>Connection type</span><div className="config-actions">
                    <button type="button" className="secondary-button" onClick={() => { setApiKey(''); setDraft((current) => ({ ...current, kind: 'catalog', providerId: null, baseUrl: '', api: '', model: '', contextWindow: null, maxTokens: null })); }}>Pi provider</button>
                    <button type="button" className="secondary-button" onClick={() => { setApiKey(''); setDraft((current) => ({ ...current, kind: 'custom', providerId: null, baseUrl: '', api: '', model: '', contextWindow: null, maxTokens: null })); }}>Custom model</button>
                  </div></div>
                  <label className="field full"><span>Display name</span><input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="Primary model" maxLength={128} /></label>
                  {draft.kind === 'legacy' && <p className="config-note">This older route needs to be chosen again from Pi or configured as a custom model.</p>}
                  {draft.kind === 'catalog' && <>
                    <label className="field full"><span>Pi provider</span><select value={draft.providerId ?? ''} onChange={(event) => {
                      const providerId = event.target.value || null;
                      if (draft.providerId && draft.providerId !== providerId) setApiKey('');
                      setDraft((current) => ({ ...current, providerId, model: '' }));
                    }}>
                      <option value="">Choose a provider</option>{catalog.map((provider) =>
                        <option key={provider.id} value={provider.id} disabled={!provider.authMethods.includes('api_key')}>{provider.name}{provider.authMethods.includes('api_key') ? '' : ' · API key unavailable'}</option>)}
                    </select></label>
                    {catalogError && <p className="config-note catalog-error" role="alert">{catalogError}</p>}
                    <label className="field full"><span>Model</span><select value={draft.model} disabled={!selectedCatalogProvider?.authMethods.includes('api_key')} onChange={(event) => updateDraft('model', event.target.value)}>
                      <option value="">Choose a model</option>{selectedCatalogProvider?.models.map((model) =>
                        <option key={model.id} value={model.id}>{model.name}</option>)}
                    </select></label>
                    {selectedCatalogModel && <>
                      <div className="field"><span>Context window</span><output className="model-limit">{selectedCatalogModel.contextWindow.toLocaleString()} tokens</output></div>
                      <div className="field"><span>Maximum output</span><output className="model-limit">{selectedCatalogModel.maxTokens.toLocaleString()} tokens</output></div>
                    </>}
                    <label className="field full"><span>API Key <i>{keyReusable ? 'saved in system secure storage' : 'write only'}</i></span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keyReusable ? 'Leave blank to keep the saved key' : 'Enter API Key'} autoComplete="new-password" /></label>
                  </>}
                  {draft.kind === 'custom' && <>
                    <label className="field full"><span>Base URL</span><input value={draft.baseUrl} onChange={(event) => updateDraft('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoCapitalize="off" spellCheck={false} /></label>
                    <label className="field full"><span>Model ID</span><input value={draft.model} onChange={(event) => updateDraft('model', event.target.value)} placeholder="model-name" autoCapitalize="off" spellCheck={false} /></label>
                    <label className="field"><span>Pi API type</span><input value={draft.api} onChange={(event) => updateDraft('api', event.target.value)} placeholder="openai-completions" autoCapitalize="off" spellCheck={false} /></label>
                    <label className="field"><span>Context window</span><input type="number" min="1" value={draft.contextWindow ?? ''} onChange={(event) => updateDraft('contextWindow', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field"><span>Maximum output tokens</span><input type="number" min="1" value={draft.maxTokens ?? ''} onChange={(event) => updateDraft('maxTokens', event.target.value ? Number(event.target.value) : null)} /></label>
                    <label className="field"><span>Reasoning</span><input type="checkbox" checked={draft.reasoning} onChange={(event) => updateDraft('reasoning', event.target.checked)} /></label>
                  </>}
                  {draft.kind === 'custom' && <label className="field full"><span>API Key <i>{keyReusable ? 'saved in system secure storage' : 'write only'}</i></span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keyReusable ? 'Leave blank to keep the saved key' : 'Enter API Key'} autoComplete="new-password" /></label>}
                </div>
                {draft.kind === 'catalog' && <section className="model-subsection" aria-labelledby="model-auth-heading">
                  <h3 id="model-auth-heading">Authentication</h3>
                  <p role="status">{!draft.providerId ? 'Choose a Pi provider and model.'
                    : selectedCatalogProvider && !selectedCatalogProvider.authMethods.includes('api_key') ? 'This Pi provider cannot use an API key in Flowmate. Choose another provider.'
                      : credentialStatus === 'unavailable' && isDraftSaved ? 'Secure credential storage is unavailable. Save an API key when storage is ready.'
                        : apiKey.trim() ? 'API key ready to save. Saving will not contact the model.'
                          : keyReusable ? 'API key saved in system secure storage.'
                            : 'API key required before testing or sending.'}</p>
                  <div className="model-subsection-actions">
                    {isDraftSaved && credentialStatus === 'configured' && <button className="text-button danger-text"
                      onClick={() => void logoutModel()}>Remove API key</button>}
                  </div>
                </section>}
                {isDraftSaved && credentialStatus === 'missing' && <p role="status">The saved credential is unavailable. Enter your API key again before testing or sending.</p>}
                <div className="config-actions">
                  {persistedModel && <button className="text-button danger-text" onClick={() => void removeModel()}>Remove model</button>}
                  <div className="action-spacer" />
                  <button className="secondary-button" onClick={() => void saveConfiguration()} disabled={saving || !state?.ready || draft.kind === 'legacy' || draft.kind === 'catalog' && Boolean(selectedCatalogProvider && !selectedCatalogProvider.authMethods.includes('api_key'))}>{saving ? 'Saving…' : 'Save changes'}</button>
                </div>
                <section className="model-subsection model-check" aria-labelledby="model-check-heading">
                  <h3 id="model-check-heading">Connection check</h3>
                  <p>Testing sends a real model request and may incur usage charges. Saving or opening this page does not send a request.</p>
                  <p role="status">{busy ? 'Checking your model connection…' : isDraftSaved && run
                    ? run.status === 'completed' ? 'Connection succeeded. Your model is ready.'
                      : run.status === 'cancelled' ? 'Connection check stopped.' : 'Connection failed. Check the model and API key.'
                    : !isDraftSaved && persistedModel ? 'Save model changes before checking the connection.'
                      : persistedModel && credentialStatus !== 'configured' ? 'Save an API key before checking this connection.'
                        : persistedModel ? 'Send a short test to check this model.' : 'Add a model before checking its connection.'}</p>
                  <div className="model-subsection-actions">
                    {busy ? <button className="secondary-button" onClick={() => void cancelRequest()} disabled={cancelPending}>Stop check</button>
                      : <button className="primary-button" onClick={() => void testConnection()} disabled={!canTest}>Test connection</button>}
                  </div>
                </section>
              </section>
            </div>}
            {page === 'models' && state && <EvaluationModels revision={state.settings.revision} settings={state.settings.evaluation}
              credentials={state.evaluationCredentials} ready={state.ready} onSaved={async () => {
                const next = await window.flowmate.getState(); if (!next.ok) throw Error('Saved settings unavailable'); receiveDesktopState(next.data);
              }} />}
            {page === 'settings' && settingsTab === 'General' && <section className="panel profile-panel settings-appearance"><div className="panel-head"><h2>Appearance</h2></div>
              <div className="profile-fields"><label className="field"><span>Display name</span><input value={profileDraft.displayName} onChange={(event) => setProfileDraft((old) => ({ ...old, displayName: event.target.value }))} maxLength={80} /></label><label className="field"><span>Theme</span><select value={profileDraft.theme} onChange={(event) => setProfileDraft((old) => ({ ...old, theme: event.target.value as typeof old.theme }))}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
              <div className="config-actions"><span className="action-spacer" /><button className="secondary-button" onClick={() => void saveProfile()} disabled={saving || !state?.ready}>Save appearance</button></div>
            </section>}
            {page === 'settings' && settingsTab === 'Performance' && <section className="panel diagnostics-panel"><div className="panel-head"><h2>Runtime status</h2></div>{runtimeStatus}</section>}
            {page === 'settings' && settingsTab === 'Performance' && <details className="panel diagnostics-panel"><summary>Diagnostics</summary>
              <div><p>Application: {state?.ready ? 'Ready' : 'Unavailable'}</p>
                <p>Selected model: {persistedModel ? credentialStatus === 'configured' ? 'Ready to connect' : 'Credential needs attention' : 'No model selected'}</p>
                <div className="config-actions">
                  <button className="secondary-button" disabled={diagnosticsBusy !== null} onClick={() => void diagnosticsAction('refresh')}>Refresh diagnostics</button>
                  <button className="secondary-button" disabled={diagnosticsBusy !== null} onClick={() => void diagnosticsAction('export')}>Export diagnostics JSON</button>
                  <button className="secondary-button" disabled={diagnosticsBusy !== null || state?.ready === true} onClick={() => void diagnosticsAction('recheck')}>Recheck Host</button>
                </div>
                {diagnosticsBusy && <p role="status">{diagnosticsBusy === 'recheck' ? 'Checking the original controller and saved state…' : diagnosticsBusy === 'export' ? 'Preparing diagnostics export…' : 'Collecting diagnostics…'}</p>}
                {diagnosticsError && <p role="alert">{diagnosticsError}</p>}
                {!diagnostics && !diagnosticsBusy && <p>No diagnostics collected. Refresh to read the current process buffers.</p>}
                {diagnostics && <div data-testid="installation-diagnostics">
                  <p>Collected: {diagnostics.collectedAt}. Host diagnostics: {diagnostics.host.availability}.</p>
                  <p>Main records: {diagnostics.main.entries.length}, dropped: {diagnostics.main.dropped}. Host records: {diagnostics.host.entries.length}, dropped: {diagnostics.host.dropped ?? 'unknown'}.</p>
                  <p>Runtime: Bun {diagnostics.runtime.bunVersion ?? 'unknown'}, Pi {diagnostics.runtime.sdkVersion}, {diagnostics.runtime.platform}/{diagnostics.runtime.arch}.</p>
                  {diagnostics.gaps.length > 0 && <p>Collection gaps: {diagnostics.gaps.join(', ')}. Missing process records are unavailable; saved business history is unchanged.</p>}
                  {diagnostics.host.stderrTail && <p>Recent Host diagnostic codes: {diagnostics.host.stderrTail.trim().split('\n').slice(-5).join(' · ')}</p>}
                  <p>Latest {Math.min(10, diagnostics.main.entries.length + diagnostics.host.entries.length)} records; export JSON for all collected records.</p>
                  <ul>{[...diagnostics.main.entries, ...diagnostics.host.entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-10).map((entry, index) => <li key={index}>{entry.at} · {entry.component} · {entry.event}{entry.code ? ` · ${entry.code}` : ''}</li>)}</ul>
                </div>}
                <h3>Tools on this device</h3><button className="quiet-button" disabled={!state?.ready} onClick={() => void loadNativeTools()}>Refresh tools</button>
                {nativeToolsError ? <p role="alert">{nativeToolsError}</p> : <ul>{nativeTools.map(tool => <li key={tool.name}><strong>{tool.name}</strong>: {tool.available ? 'Available' : tool.reason ?? 'Unavailable'}</li>)}</ul>}</div>
            </details>}
            {page === 'settings' && settingsTab === 'Performance' && state?.backgroundService && <section className="panel" aria-label="Background service connection"><h2>Background service</h2>
              <p role="status">{state.backgroundService.state}</p>{state.backgroundService.error && <p role="alert">{state.backgroundService.error.message}</p>}
              <p>Enabling saves an offline backup, moves configured product credentials into the service account store and hands background work to the installed service.</p>
              <div className="button-row">
                {state.backgroundService.state === 'disabled' && <button type="button" disabled={activationBusy !== null} onClick={() => void serviceActivationAction('prepare')}>Prepare service</button>}
                {state.backgroundService.installationId && (state.backgroundService.state === 'disabled' || state.backgroundService.activationOperationId && state.backgroundService.state !== 'ready')
                  && <button type="button" disabled={activationBusy !== null || state.backgroundService.state === 'stopping'} onClick={() => void serviceActivationAction('enable')}>
                    {state.backgroundService.activationOperationId ? 'Continue original activation' : 'Enable background service'}</button>}
                {(state.backgroundService.activationOperationId || activationRequest.current) && <button type="button" disabled={activationBusy !== null} onClick={() => void serviceActivationAction('query')}>Check activation</button>}
                <button type="button" disabled={activationBusy !== null} onClick={() => void window.flowmate.backgroundService.getServiceState().then(async result => {
                if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
                const refreshed = await window.flowmate.getState(); if (refreshed.ok) receiveDesktopState(refreshed.data);
              })}>Refresh service state</button>
                {state.backgroundService.installationId && state.backgroundService.state !== 'disabled' && state.backgroundService.state !== 'blocked' && <button type="button" disabled={activationBusy !== null || state.backgroundService.state === 'starting'}
                  onClick={() => { const service = state.backgroundService!; if (!service.installationId) return;
                    void (service.state === 'ready' || service.state === 'stopping' ? window.flowmate.backgroundService.disconnect({ installationId: service.installationId })
                      : window.flowmate.backgroundService.connect({ installationId: service.installationId })).then(async result => {
                        if (!result.ok) setNotice({ tone: 'bad', message: errorMessage(result) }); const refreshed = await window.flowmate.getState(); if (refreshed.ok) receiveDesktopState(refreshed.data);
                      }); }}>{state.backgroundService.state === 'stopping' ? 'Check foreground stop' : state.backgroundService.state === 'ready' ? 'Disconnect desktop' : 'Connect service'}</button>}</div>
              {activationBusy && <p role="status">{activationBusy === 'prepare' ? 'Preparing the installed service configuration…' : activationBusy === 'query' ? 'Reading the original activation facts…' : 'Continuing the original service handoff…'}</p>}
              {(activationView?.operationId || state.backgroundService.activationOperationId) && <p>Original activation: {activationView?.operationId ?? state.backgroundService.activationOperationId}</p>}
              {activationView && <div data-testid="service-activation-facts"><p>Backup: {activationView.backupId ?? 'not confirmed'}. Product credentials: {activationView.credentialsPublished === null ? 'unknown' : activationView.credentialsPublished ? 'published' : 'not published'}.</p>
                <p>Enabled: {activationView.enabled ? 'yes' : 'no'}. Connected: {activationView.connected ? 'yes' : 'no'}. Background scheduling: {activationView.active === null ? 'unknown' : activationView.active ? 'active' : 'inactive'}.</p>
                {activationView.error && <p role="alert">{activationView.error.message}</p>}</div>}
              {state.backgroundService.error?.code === 'service_elevation_required' && <p>Install and start the prepared Flowmate service from an elevated console, then continue this original activation. No elevation was requested by the desktop.</p>}
            </section>}
            {page === 'settings' && settingsTab === 'Performance' && <section className="panel runtime-limits-panel" aria-labelledby="runtime-limits-heading">
              <div className="panel-head"><h2 id="runtime-limits-heading">Run limits</h2></div>
              <p>Empty values use task defaults. Saved limits apply to new Runs.</p>
              <RuntimeLimitFields value={runtimeDefaultsDraft} onChange={setRuntimeDefaultsDraft} prefix="Default" disabled={saving} />
              <div className="config-actions"><button className="secondary-button" onClick={() => void saveRuntimeLimits()} disabled={saving || !state?.ready}>Save Run limits</button></div>
            </section>}
            {page === 'settings' && settingsTab === 'LLM' && <details className="panel business-instructions"><summary>Business instructions</summary>
              <ResourcePage embedded kind="prompt" hostEpoch={workspaceHostEpoch.current} ready={Boolean(state?.ready)} revision={state?.settings.revision ?? 0}
                onSaved={async () => { const next = await window.flowmate.getState(); if (next.ok) receiveDesktopState(next.data); }} /></details>}
            {page === 'settings' && settingsTab === 'Skills' && <ResourcePage embedded kind="skill" hostEpoch={workspaceHostEpoch.current} ready={Boolean(state?.ready)}
              revision={state?.settings.revision ?? 0} onSaved={async () => { const next = await window.flowmate.getState(); if (next.ok) receiveDesktopState(next.data); }} />}
            {page === 'settings' && settingsTab === 'Connections' && <><section className="panel"><div className="panel-head"><h2>Model connections</h2>
              <button className="text-button" onClick={() => setSettingsTab('LLM')}>Manage models</button></div><dl className="settings-facts">
                {savedModels.map(model => <div key={model.id}><dt>{model.name}</dt><dd>{state?.modelCredentials[model.id] === 'configured' ? 'API key saved' : 'API key needed'}</dd></div>)}</dl>
              {!savedModels.length && <p className="connection-empty">No model connections configured.</p>}</section>
              {state && <ExtensionsPage summary hostEpoch={workspaceHostEpoch.current} ready={state.ready} settings={state.settings}
                selectedSessionId={selectedSessionId ?? workspace?.sessionId ?? null} refreshToken={contextRefresh}
                onSaved={async () => { const next = await window.flowmate.getState(); if (next.ok) receiveDesktopState(next.data); }} />}
              <button className="secondary-button" onClick={() => void navigate('extensions')}>Manage plugins</button></>}
            </div>
          </section>
        )}
      </main>
      {page !== 'personal' && <AgentChatPanel
        key={`chat:${workspaceHostEpoch.current}`}
        presentation={chatPresentation}
        notice={chatPresentation === 'main' ? notice : null}
        runtimeStatus={chatPresentation === 'main' && (!state?.ready || runtimeReadFailed || runtimeState?.blocked) ? runtimeStatus : null}
        hostEpoch={workspaceHostEpoch.current} hostReady={Boolean(state?.ready)}
        collapsed={assistantCollapsed}
        onToggle={() => { assistantWasToggled.current = true; if (page === 'research') setResearchChatCollapsed(value => !value); else setChatCollapsed(value => !value); }}
        researchContext={page === 'research' || researchSelected}
        selectedSessionId={selectedSessionId}
        selectedSession={selectedSession}
        hasOlderRuns={selectedSession?.historyState === 'legacy-read-only' ? runCursor !== null : messageCursor !== null}
        canNewChatAndSend={canNewChatAndSend}
        onNewChatAndSend={() => void newChatAndSend()}
        onLoadOlderRuns={() => void loadOlderRuns()}
        turns={chatTurns}
        messages={messageState ? messageViewsForDisplay(messageState) : []}
        ownsRun={runId => knownRunSessions.current.get(runId) === selectedSessionId}
        unconfirmedCount={messageState ? [...messageState.liveByRun]
          .filter(([runId]) => messageState.closedRuns.has(runId)).reduce((total, [, items]) => total + items.size, 0) : 0}
        historyLoading={historyLoading}
        historyError={historyError}
        runFeedbacks={runFeedbacks}
        onRefreshHistory={() => { if (selectedSessionIdRef.current !== null) void loadSession(selectedSessionIdRef.current); }}
        onSessionDetails={() => { if (selectedSessionIdRef.current !== null) openSessionDetails(selectedSessionIdRef.current); }}
        transcriptRef={chatTranscriptRef}
        input={chatInput}
        composerRef={chatComposerRef}
        onInputChange={updateChatInput}
        onSend={() => void sendAssistantMessage()}
        onAppend={mode => void appendChatInput(mode)}
        canAppend={canAppend}
        inputReadError={inputReadError}
        unknownInput={unknownInput !== null}
        onCheckInputStatus={() => void checkInputStatus()}
        onBranch={entryId => void branchSession(entryId)}
        canBranch={Boolean(state?.ready && runtimeState && !runtimeState.blocked
          && runtimeState.active?.sessionId !== selectedSessionId && activeAgentSessionId !== selectedSessionId
          && !sessionMutating && !historyLoading && !historyError && selectedForSend?.availability === 'ready'
          && selectedForSend.status === 'active' && !selectedForSend.deletePending && !selectedForSend.modelUseBlocked
          && selectedForSend.historyState === 'recoverable')}
        onCancel={() => void cancelAgentRun()}
        enabled={canChat}
        busy={busy}
        cancelPending={cancelPending}
        activeAgentRunId={activeAgentRunId}
        activeAgentSessionId={activeAgentSessionId}
        activeRunModel={activeRunModel}
        activeInputTarget={activeInputTarget}
        selectedModelId={selectedModelId}
        modelName={persistedModel?.name ?? null}
        modelId={persistedModel?.model ?? null}
        contextName={researchSelected ? `Research: ${researchTask.title}` : workspace?.documentRef ? [documents.find(item => item.documentRef.id === workspace.documentRef!.id)?.displayName ?? 'Selected invoice',
          workspace.jobId ? 'Processing task selected' : null, workspace.candidateRef ? `Result ${workspace.candidateRef.sequence}` : null,
          selectionLabel(workspace.selection)].filter(Boolean).join(' · ') : null}
        goalMode={researchSelected ? 'answer' : goalMode}
        canGenerate={!researchSelected && Boolean(workspace?.documentRef && workspace.jobId)}
        onGoalModeChange={setGoalMode}
        sessionHint={!runtimeReady ? '' : !selectedSession ? selectedSessionId !== null ? 'Loading this chat. You can write while it loads.' : ''
          : selectedSession.historyState === 'legacy-read-only' ? 'This older conversation is read only. Start a new chat to continue.'
            : selectedSession.historyState === 'invalid' ? 'Saved conversation history is invalid. Start a new chat.'
            : selectedSession.modelUseBlocked ? 'Model access was revoked for this chat. Start a new chat to continue.'
            : selectedSession.availability === 'archived' ? selectedSession.deletePending
              ? 'This chat is pending deletion. Retry Delete to finish removing it.'
              : 'This chat is archived. Unarchive it in Chats to continue.'
            : selectedSession.availability === 'unusable' ? ''
              : selectedSession.availability === 'busy' ? 'This chat is responding.'
                : !modelReady ? 'Save a model and its API key to start a chat.'
                  : goalMode === 'save-candidate' && (!workspace?.documentRef || !workspace.jobId) ? 'Process an invoice first to generate a result.' : ''}
      />}
      {contextSourceError && !sessionDetails && <p className="notice bad context-source-error" role="alert">{contextSourceError}</p>}
      {sessionDetails && <SessionDetails key={sessionDetails.token} sessionId={sessionDetails.sessionId} basis={sessionDetails.basis}
        modelId={selectedModelId} models={(state?.settings.models ?? []).filter(model => model.kind !== 'legacy'
          && state?.modelCredentials[model.id] === 'configured')} onModelChange={selectModel}
        initialForkRequest={historyForkRequests.current.get(sessionDetails.sessionId) ?? null}
        onForkRequest={request => { if (request) historyForkRequests.current.set(sessionDetails.sessionId, request); else historyForkRequests.current.delete(sessionDetails.sessionId); }}
        captureHistorySelection={captureHistorySelection} historySelectionToken={sessionLoadSequence.current}
        initialRunId={sessionDetails.initialRunId} initialSnapshotId={sessionDetails.initialSnapshotId}
        onHistoryBranch={historyBranchSaved} onHistoryFork={selectFork}
        onOpenOwner={(sessionId, runId, context, snapshotId) => openSessionDetails(sessionId, context && runId !== null ? { sessionId, runId, context } : null, runId, snapshotId)}
        navigationToken={sessionDetails.token} hostEpoch={workspaceHostEpoch.current} hostReady={Boolean(state?.ready)} refreshToken={contextRefresh}
        sourceError={contextSourceError} onClose={closeSessionDetails} onRunChange={id => { contextNavigation.current++; contextTarget.current = { sessionId: sessionDetails.sessionId, runId: id }; }}
        onOpenCandidateBasis={candidate => void openCandidateContextBasis(candidate)} />}
    </div>
  );
}

function ChatsPage({ sessions, selectedSessionId, activeSessionId, managementBlocked, hasMore, mutating, notice, onSelect, onRename, onDelete, onSetStatus, onLoadMore,
  workingDirectory, onChooseDirectory, onClearDirectory, runDirectory, ready }: {
  sessions: readonly SessionSnapshot[];
  selectedSessionId: number | null;
  activeSessionId: number | null;
  managementBlocked: boolean;
  hasMore: boolean;
  mutating: boolean;
  notice: Notice;
  onSelect(sessionId: number): void;
  onRename(sessionId: number, title: string): Promise<boolean>;
  onDelete(sessionId: number): Promise<void>;
  onSetStatus(sessionId: number, status: 'active' | 'archived'): Promise<void>;
  onLoadMore(): void;
  workingDirectory: string;
  onChooseDirectory(): void;
  onClearDirectory(): void;
  runDirectory: { runId: number; directory: string } | null;
  ready: boolean;
}) {
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (renamingId !== null) { renameInputRef.current?.focus(); renameInputRef.current?.select(); }
  }, [renamingId]);
  return <section className="page-content chats-page">
    <div className="page-heading"><div><h1>Chats</h1><p>Pick a conversation to continue in Assistant.</p></div></div>
    {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
    <section className="panel run-tools-panel" aria-label="Working directory">
      <div className="panel-head"><h2>Working directory</h2></div>
      <div className="form-grid">
        <label className="field full"><span>Working directory</span><input value={workingDirectory} readOnly placeholder="Automatic · current Run directory" /></label>
        <button className="secondary-button" type="button" disabled={!ready} onClick={onChooseDirectory}>Choose directory</button>
        <button className="quiet-button" type="button" disabled={!workingDirectory} onClick={onClearDirectory}>Use Run directory</button>
        {runDirectory && <p className="full">Run {runDirectory.runId} working directory: <code>{runDirectory.directory}</code></p>}
      </div>
    </section>
    <section className="panel chat-directory">
      <div className="panel-head"><h2>Conversations</h2><span>{sessions.length} loaded</span></div>
      {sessions.length === 0 && <div className="empty-route"><strong>No chats yet</strong><span>Use New chat in the sidebar to start one.</span></div>}
      {sessions.map((session) => <div className={`chat-directory-row ${session.sessionId === selectedSessionId ? 'selected' : ''}`}
        data-session-id={session.sessionId} key={session.sessionId}>
        <button className="chat-directory-open" type="button" onClick={() => onSelect(session.sessionId)}
          aria-current={session.sessionId === selectedSessionId ? 'true' : undefined}>
          <strong>{chatTitle(session.title)}</strong>
          <small>{session.deletePending ? 'Delete incomplete · retry Delete' : session.status === 'archived' ? 'Archived'
            : session.historyState === 'legacy-read-only' ? 'Read only' : session.historyState === 'invalid' ? 'History unavailable'
            : session.modelUseBlocked ? 'Access revoked' : session.availability === 'ready' ? 'Ready'
              : session.availability === 'busy' ? 'Responding' : session.availability === 'unusable' ? 'Cannot continue' : 'Unavailable'}
            {' · '}{new Date(session.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</small>
        </button>
        {renamingId === session.sessionId ? <form className="chat-directory-rename" onSubmit={async (event) => {
          event.preventDefault();
          if (await onRename(session.sessionId, renameTitle)) setRenamingId(null);
        }}>
          <input ref={renameInputRef} aria-label="Chat title" value={renameTitle} maxLength={120}
            onChange={(event) => setRenameTitle(event.target.value)} />
          <button type="submit" disabled={mutating}>Save</button>
          <button type="button" onClick={() => setRenamingId(null)}>Cancel</button>
        </form> : <div className="chat-directory-actions">
          <button type="button" disabled={mutating || managementBlocked || session.sessionId === activeSessionId || session.availability === 'busy' || session.deletePending}
            onClick={() => void onSetStatus(session.sessionId, session.status === 'active' ? 'archived' : 'active')}>
            {session.status === 'active' ? 'Archive' : 'Unarchive'}</button>
          <button type="button" onClick={() => { setRenamingId(session.sessionId); setRenameTitle(session.title); }}
            disabled={mutating || session.status === 'archived'}>Rename</button>
          <button type="button" disabled={mutating || session.sessionId === activeSessionId || session.availability === 'busy'}
            title={session.availability === 'busy' ? 'Wait for the current response or stop it before removing this chat.' : undefined}
            onClick={() => {
              const confirmation = session.hasBusinessHistory
                ? `Remove “${chatTitle(session.title)}” from Conversations? Its invoice history and saved results will remain available. This chat cannot continue.`
                : `Permanently delete this chat (“${chatTitle(session.title)}”) and its messages? Other chats and connection tests will be kept. This cannot be undone.`;
              if (window.confirm(confirmation)) void onDelete(session.sessionId);
            }}>Delete</button>
        </div>}
      </div>)}
      {hasMore && <button type="button" className="chat-directory-more" onClick={onLoadMore}>Load more chats</button>}
    </section>
  </section>;
}

function InvoicesPage(props: {
  workspace: WorkspaceSnapshot | null;
  documents: readonly DocumentSnapshot[];
  historicalDocument: DocumentSnapshot | null;
  historicalView: 'original' | 'parsed' | 'candidate';
  candidates: readonly CandidateSummary[];
  candidateDetail: CandidateJobDetail | null;
  onOpenContextBasis(candidate: CandidateSummary): void;
  onReviewSource(source: SourceRef): void;
  formControls: ReactNode;
  dependentReady: boolean;
  onSelectCandidate(jobId: number, candidateId: number): void;
  taskGoal: string;
  parsedPage: InvoiceToolOutput<'read_invoice_document'> | null;
  originalImage: DocumentOriginalImage | null;
  notice: Notice;
  onImport(): void;
  onSelectDocument(id: number | null): void;
  onHideDocument(id: number): void;
  hidingDocumentId: number | null;
  onStartTask(): void;
  onOpenCandidate(jobId: number, candidateId: number): void;
  onTaskGoalChange(value: string): void;
  onChangeView(value: 'original' | 'parsed' | 'candidate'): void;
  onRefresh(): void;
  onRevokeModelAccess(): void;
  revokingAccess: boolean;
}) {
  const { workspace, documents, candidates, candidateDetail, taskGoal, parsedPage, originalImage, notice, revokingAccess } = props;
  const selectedDocument = props.historicalDocument ?? documents.find((item) => item.documentRef.id === workspace?.documentRef?.id) ?? null;
  const historical = props.historicalDocument !== null;
  const view = historical ? props.historicalView : workspace?.activeView;
  return <section className="page-content invoice-page">
    <div className="page-heading">
      <div><h1>Invoices</h1><p>Review the original, parsed details and saved results in one place.</p></div>
      <div className="invoice-heading-actions"><select className="context-select" aria-label="Choose invoice" value={historical ? '' : selectedDocument?.documentRef.id ?? ''} onChange={(event) => props.onSelectDocument(Number(event.target.value))}><option value="" disabled>Choose invoice</option>{documents.map((item) => <option key={item.documentRef.id} value={item.documentRef.id}>{item.displayName}</option>)}</select>{selectedDocument && !historical && <button className="text-button danger-text invoice-heading-delete" disabled={props.hidingDocumentId !== null} onClick={() => props.onHideDocument(selectedDocument.documentRef.id)}>Delete</button>}<button className="secondary-button" onClick={props.onImport}>＋ Import invoice</button></div>
    </div>
    {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
    <section className="invoice-context">
      <div className="invoice-context-head"><strong>All invoices</strong><button className="text-button" onClick={props.onRefresh} aria-label="Refresh invoices" title="Refresh invoices">↻</button></div>
      {documents.length === 0 ? <div className="empty-route"><strong>No invoices yet</strong><span>Import an invoice to begin.</span></div> :
        <div className="model-list">{documents.map((document) => <div key={`${document.documentRef.id}:${document.documentRef.version}`} className={`route-row ${workspace?.documentRef?.id === document.documentRef.id ? 'selected' : ''}`}>
          <span className="route-icon" aria-hidden="true">▧</span>
          <button className="route-name processing-open" type="button" onClick={() => props.onSelectDocument(document.documentRef.id)}><strong>{document.displayName}</strong><small>{document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'} · {new Date(document.createdAt).toLocaleDateString()}</small></button>
          <button className="text-button danger-text invoice-row-delete" type="button" aria-label={`Delete ${document.displayName}`} disabled={props.hidingDocumentId !== null} onClick={() => props.onHideDocument(document.documentRef.id)}>Delete</button>
        </div>)}</div>}
    </section>

    {(historical || workspace?.documentRef) && <section className="panel config-panel invoice-sheet">
      {historical && <p className="notice info" role="status">This invoice was removed from the daily list. You are viewing a read-only record; it is not the Assistant context.</p>}
      <div className="panel-head"><div><h2>{selectedDocument?.displayName ?? 'Invoice'}</h2><p className="invoice-subtitle">{selectedDocument?.pageCount ?? 1} {selectedDocument?.pageCount === 1 ? 'page' : 'pages'} · Imported {selectedDocument ? new Date(selectedDocument.createdAt).toLocaleDateString() : 'recently'}</p></div>
        {!historical && <details className="invoice-access"><summary>Material access</summary><button className="danger-action" disabled={revokingAccess} onClick={props.onRevokeModelAccess}>{revokingAccess ? 'Revoking…' : 'Revoke model access'}</button></details>}
      </div>
      <div className="button-row invoice-tabs" role="tablist" aria-label="Invoice view">
        <button className={view === 'original' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('original')}>Original</button>
        <button className={view === 'parsed' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('parsed')}>Parsed</button>
        <button className={view === 'candidate' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('candidate')}>Results</button>
      </div>
      {view === 'original' && (originalImage
        ? <figure><img style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }} src={`data:${originalImage.mimeType};base64,${originalImage.base64}`} alt={`Original invoice document page 1`} /><figcaption>Original page shown for user review.</figcaption></figure>
        : <p className="config-note">Original page is unavailable. The selected document may be missing its source asset.</p>)}
      {view === 'parsed' && (parsedPage
        ? <div className="model-list parsed-list">{parsedPage.blocks.map((block) => <article className="route-row" key={block.id}>
          <span className="route-icon">{block.kind === 'table' ? '▤' : block.kind === 'image' ? '▧' : '¶'}</span>
          <span className="route-name"><strong>{block.kind === 'table' ? 'Table' : block.kind === 'image' ? 'Image note' : 'Text'} · Page {block.source.page}</strong><small>{block.text || '(no extracted text)'}</small></span>
        </article>)}</div>
        : <p className="config-note">Parsed page could not be loaded.</p>)}
      {view === 'candidate' && historical && <p className="config-note">Saved results and sources remain available in Processing History.</p>}
      {view === 'candidate' && !historical && workspace && <div className="invoice-results">{candidates.length === 0
        ? <div className="empty-route"><strong>No results yet</strong><span>Choose Process this invoice, then send the request in Assistant.</span></div>
        : <div className="model-list">{candidates.map((item) => <button className="route-row" key={item.candidateId} onClick={() => workspace.jobId && props.onOpenCandidate(workspace.jobId, item.candidateId)}><span className="route-icon">✓</span><span className="route-name"><strong>Result {item.sequence}</strong><small>{item.issueCount ? `${item.issueCount} issues to review` : 'No issues found'} · {new Date(item.createdAt).toLocaleDateString()}</small></span></button>)}</div>}
        {candidateDetail && <><CandidateDetails detail={candidateDetail} onOpenContextBasis={props.onOpenContextBasis} onReviewSource={props.onReviewSource} />
          {workspace.jobId && <button className="secondary-button" disabled={workspace.candidateRef?.id === candidateDetail.candidate.candidateId}
            onClick={() => props.onSelectCandidate(workspace.jobId!, candidateDetail.candidate.candidateId)}>Select result</button>}
          </>}{props.formControls}</div>}
    </section>}

    {!historical && <section className="panel invoice-process">
      <div className="panel-head"><div><h2>Process this invoice</h2><p className="invoice-subtitle">Prepare a result from the parsed content. The model starts only when you press Send.</p></div></div>
      <details><summary>Additional requirements</summary><label className="field full"><span>What else should the assistant consider?</span><textarea value={taskGoal} onChange={(event) => props.onTaskGoalChange(event.target.value)} maxLength={3500} rows={3} placeholder="Optional instructions for this invoice" /></label></details>
      <div className="config-actions"><span className="action-spacer" /><button className="primary-button" disabled={!props.dependentReady || !workspace?.documentRef} onClick={props.onStartTask}>Process this invoice</button></div>
    </section>}
    <footer className="page-footer"><span>The original is for your review. Assistant uses registered parsed content and source references.</span></footer>
  </section>;
}

function TasksPage(props: {
  workspace: WorkspaceSnapshot | null;
  documents: readonly DocumentSnapshot[];
  historicalDocuments: Readonly<Record<number, DocumentSnapshot>>;
  historicalJobs: Readonly<Record<number, JobSnapshot>>;
  jobs: readonly JobSnapshot[];
  selectedJobId: number | null;
  candidates: readonly CandidateSummary[];
  candidateDetail: CandidateJobDetail | null;
  onOpenContextBasis(candidate: CandidateSummary): void;
  onReviewSource(source: SourceRef): void;
  activity: readonly BusinessEventSnapshot[];
  notice: Notice;
  onOpenJob(jobId: number): void;
  onHideJob(jobId: number): void;
  onOpenCandidate(jobId: number, candidateId: number): void;
  onSelectCandidate(jobId: number, candidateId: number): void;
}) {
  const { workspace, jobs, candidates, candidateDetail, activity } = props;
  const job = jobs.find((item) => item.jobId === props.selectedJobId)
    ?? (props.selectedJobId === null ? null : props.historicalJobs[props.selectedJobId]) ?? null;
  const documentInfo = (documentId: number) => props.documents.find((item) => item.documentRef.id === documentId) ?? props.historicalDocuments[documentId];
  const documentName = (documentId: number) => documentInfo(documentId)?.displayName ?? 'Invoice';
  return <section className="page-content">
    <div className="page-heading"><div><h1>Processing History</h1><p>Review prepared results, their sources, issues and past actions.</p></div></div>
    {props.notice && <div className={`notice ${props.notice.tone}`} role="status">{props.notice.message}</div>}
    <section className="panel model-list-panel"><div className="panel-head"><div><h2>Recent processing</h2></div></div>
      {jobs.length === 0 ? <div className="empty-route"><strong>No processing yet</strong><span>Choose an invoice and select Process this invoice.</span></div> :
        <div className="model-list">{jobs.map((item) => <div key={item.jobId} className={`route-row ${item.jobId === props.selectedJobId ? 'selected' : ''}`}>
          <span className="route-icon">☷</span><button className="route-name processing-open" type="button" onClick={() => props.onOpenJob(item.jobId)}><strong>{documentName(item.documentRef.id)}</strong><small>{item.goal}</small></button><span className="credential-pill">{item.status}</span>
          <button className="text-button danger-text" type="button" onClick={() => props.onHideJob(item.jobId)}>Delete</button>
        </div>)}</div>}
    </section>
    {job && <>
      <section className="panel config-panel"><div className="panel-head"><div><h2>Results for {documentName(job.documentRef.id)}</h2></div><span className="revision-tag">{documentInfo(job.documentRef.id)?.isHidden ? 'Read only' : `${candidates.length} saved`}</span></div>
        {candidates.length === 0 ? <p className="config-note">No result has been saved. The assistant can prepare one when you send a processing request.</p> :
          <div className="model-list">{candidates.map((item) => <div className="route-row" key={item.candidateId}>
            <span className="route-icon">{item.status === 'accepted' ? '✓' : '▧'}</span><span className="route-name"><strong>Result {item.sequence} · {item.status}</strong><small>{item.issueCount} issues · {new Date(item.createdAt).toLocaleString()}</small></span>
            <button className="text-button" onClick={() => props.onOpenCandidate(job.jobId, item.candidateId)}>View</button>
            {!documentInfo(job.documentRef.id)?.isHidden && item.status === 'generated' && item.candidateId !== job.currentCandidateId && <button className="secondary-button" onClick={() => props.onSelectCandidate(job.jobId, item.candidateId)}>Select</button>}
          </div>)}</div>}
      </section>
      {candidateDetail && <section className="panel profile-panel"><div className="panel-head"><h2>Result details</h2></div><CandidateDetails detail={candidateDetail} onOpenContextBasis={props.onOpenContextBasis} onReviewSource={props.onReviewSource} /></section>}
      <section className="panel profile-panel"><div className="panel-head"><h2>Activity</h2></div>
        {activity.length === 0 ? <p className="config-note">No actions recorded yet.</p> : <ol>{activity.map((event) => <li key={event.id}><strong>{activityLabel(event.type)}</strong> · {event.result} · {event.safeSummary} · {new Date(event.occurredAt).toLocaleString()}</li>)}</ol>}
      </section>
    </>}
  </section>;
}

function activityLabel(type: BusinessEventSnapshot['type']): string {
  return ({ document_imported: 'Invoice imported', task_started: 'Processing started',
    candidate_generated: 'Result prepared', candidate_selected: 'Result selected', candidate_edited: 'Result edited',
    candidate_accepted: 'Result accepted', candidate_rejected: 'Result rejected', candidate_exported: 'Managed export registered' })[type];
}

const invoiceFieldLabels: Record<typeof invoiceHeaderFields[number] | typeof invoiceLineFields[number], string> = {
  invoiceNumber: 'Invoice number', issueDate: 'Issue date', sellerName: 'Seller name', sellerTaxId: 'Seller tax ID',
  buyerName: 'Buyer name', buyerTaxId: 'Buyer tax ID', currency: 'Currency', netAmount: 'Net amount', taxAmount: 'Tax amount', totalAmount: 'Total amount',
  description: 'Description', quantity: 'Quantity', unitPrice: 'Unit price', taxRate: 'Tax rate', unit: 'Unit',
};

function InvoiceFormEditor({ state, feedback, disabled, canQuery, canDiscard, operationUnknown, onChange, onDiscard, onQuery, onSave, onAccept, onReject }: {
  state: InvoiceFormState; feedback: string; disabled: boolean;
  canQuery: boolean; canDiscard: boolean;
  operationUnknown: boolean;
  onChange(value: InvoiceFormDraft, lineOrigins?: InvoiceFormState['lineOrigins']): void; onDiscard(): void; onQuery(): void;
  onSave(): void; onAccept(): void; onReject(): void;
}) {
  return <section className="panel" aria-label="Invoice form"><div className="panel-head"><h2>Invoice form</h2>
    <span>{state.dirty ? 'Unsaved changes' : 'Local draft'} · Revision {state.revision}</span></div>
    {feedback && <p role="status">{feedback}</p>}
    {!state.valid && <p role="alert">This form target is no longer valid. Your local draft is retained.</p>}
    {state.warnings.length > 0 && <ul>{state.warnings.map(warning => <li key={warning.path}>{warning.path}: {warning.reason.replaceAll('_', ' ')}</li>)}</ul>}
    <div className="profile-fields">{invoiceHeaderFields.map(name => <label className="field" key={name}><span>{invoiceFieldLabels[name]}</span>
      <input aria-label={invoiceFieldLabels[name]} value={state.draft.fields[name]} maxLength={MAX_INVOICE_FIELD_CHARS} disabled={disabled}
        onChange={event => onChange({ ...state.draft, fields: { ...state.draft.fields, [name]: event.target.value } })} /></label>)}</div>
    <h3>Line items</h3>{state.draft.lines.map((line, index) => <fieldset key={index} disabled={disabled}><legend>Line {index + 1}</legend>
      <div className="profile-fields">{invoiceLineFields.map(name => <label className="field" key={name}><span>{invoiceFieldLabels[name]}</span>
        <input aria-label={`Line ${index + 1} ${invoiceFieldLabels[name]}`} value={line[name]} maxLength={MAX_INVOICE_FIELD_CHARS}
          onChange={event => onChange({ ...state.draft, lines: state.draft.lines.map((value, position) => position === index ? { ...value, [name]: event.target.value } : value) })} /></label>)}</div>
      <button className="text-button" onClick={() => onChange({ ...state.draft, lines: state.draft.lines.filter((_, position) => position !== index) },
        state.lineOrigins.filter((_, position) => position !== index))}>Remove line {index + 1}</button>
    </fieldset>)}
    <button className="text-button" disabled={disabled || state.draft.lines.length >= MAX_INVOICE_LINES} onClick={() => onChange({ ...state.draft,
      lines: [...state.draft.lines, Object.fromEntries(invoiceLineFields.map(name => [name, ''])) as InvoiceFormDraft['lines'][number]] }, [...state.lineOrigins, null])}>Add line</button>
    <h3>Notes</h3>{state.draft.notes.map((note, index) => <label className="field" key={index}><span>Note {index + 1}</span>
      <input value={note} maxLength={MAX_INVOICE_NOTE_CHARS} disabled={disabled} onChange={event => onChange({ ...state.draft, notes: state.draft.notes.map((value, position) => position === index ? event.target.value : value) })} />
      <button className="text-button" disabled={disabled} onClick={() => onChange({ ...state.draft, notes: state.draft.notes.filter((_, position) => position !== index) })}>Remove note {index + 1}</button></label>)}
    <button className="text-button" disabled={disabled || state.draft.notes.length >= MAX_INVOICE_NOTES} onClick={() => onChange({ ...state.draft, notes: [...state.draft.notes, ''] })}>Add note</button>
    <div className="button-row"><button className="secondary-button" onClick={onQuery} disabled={!canQuery}>Check Fill status</button>
      <button className="secondary-button" onClick={onSave} disabled={disabled || !state.dirty || operationUnknown}>Save result</button>
      <button className="secondary-button" onClick={onAccept} disabled={disabled || state.dirty || operationUnknown}>Accept result</button>
      <button className="secondary-button" onClick={onReject} disabled={disabled || state.dirty || operationUnknown}>Reject result</button>
      <button className="danger-action" onClick={onDiscard} disabled={!canDiscard}>Discard changes</button></div>
  </section>;
}

function CandidateDetails({ detail, onOpenContextBasis, onReviewSource }: { detail: CandidateJobDetail; onOpenContextBasis(candidate: CandidateSummary): void; onReviewSource(source: SourceRef): void }) {
  const candidate = detail.candidate;
  const field = (value: CandidateJobDetail['candidate']['fields'][typeof invoiceHeaderFields[number]], path: string, label: string) => <article key={path}>
    <strong>{label}</strong><InvoiceFieldDetails value={value} path={path} issues={candidate.issues} />
    {value.sources.map((source, index) => <button key={index} className="text-button" aria-label={`Review ${label} source ${index + 1}`} onClick={() => onReviewSource(source)}>Review source {index + 1}</button>)}
  </article>;
  return <div className="candidate-details">
    {(candidate.context || candidate.basedOnCandidateId) && <button className="text-button" onClick={() => onOpenContextBasis(candidate)}>View original context basis</button>}
    <div className="profile-fields">{invoiceHeaderFields.map(name => field(candidate.fields[name], `fields.${name}`, invoiceFieldLabels[name]))}</div>
    {candidate.lines.length > 0 && <><h3>Line items</h3>{candidate.lines.map((line, index) => <section key={index}><h4>Line {index + 1}</h4>
      <div className="profile-fields">{invoiceLineFields.map(name => field(line[name], `lines.${index}.${name}`, `Line ${index + 1} ${invoiceFieldLabels[name]}`))}</div></section>)}</>}
    <h3>Issues</h3>{candidate.issues.length ? <ul>{candidate.issues.map((issue, index) => <li key={index}>{issue.severity} · {issue.message}</li>)}</ul> : <p className="config-note">No validation issues.</p>}
    <h3>Sources</h3>{candidate.sources.length ? <ul>{candidate.sources.map((source, index) => <li key={index}>Page {source.page}{source.quote ? ` · “${source.quote}”` : ''}</li>)}</ul> : <p className="config-note">No source links were saved.</p>}
  </div>;
}

function modelFieldsEqual(left: ModelProfile, right: ModelProfile): boolean {
  return left.id === right.id && left.name === right.name && left.baseUrl === right.baseUrl && left.model === right.model
    && left.api === right.api && left.credentialRef === right.credentialRef && left.kind === right.kind
    && left.providerId === right.providerId && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens && left.reasoning === right.reasoning;
}

function turnFromRun(run: AgentRunSnapshot): ChatTurn {
  const input = run.input as { text?: unknown };
  const output = run.output as { text?: unknown } | null;
  return {
    id: `run-${run.runId}`,
    sessionId: run.sessionId,
    runId: run.runId,
    prompt: typeof input.text === 'string' ? input.text : 'Input unavailable.',
    response: typeof output?.text === 'string' && output.text ? output.text : null,
    error: run.error ? errorMessage({ error: run.error }) : null,
    status: run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled'
      : run.status === 'failed' ? 'failed' : 'sending',
  };
}

function AgentChatPanel({
  presentation, notice, runtimeStatus,
  hostEpoch, hostReady,
  collapsed,
  onToggle,
  selectedSessionId,
  selectedSession,
  hasOlderRuns,
  canNewChatAndSend,
  onNewChatAndSend,
  onLoadOlderRuns,
  turns,
  messages,
  ownsRun,
  unconfirmedCount,
  historyLoading,
  historyError,
  runFeedbacks,
  onRefreshHistory,
  onSessionDetails,
  transcriptRef,
  input,
  composerRef,
  onInputChange,
  onSend,
  onAppend,
  canAppend,
  inputReadError,
  unknownInput,
  onCheckInputStatus,
  canBranch,
  onBranch,
  onCancel,
  enabled,
  busy,
  cancelPending,
  activeAgentRunId,
  activeAgentSessionId,
  activeRunModel,
  activeInputTarget,
  selectedModelId,
  modelName,
  modelId,
  contextName,
  researchContext,
  goalMode,
  canGenerate,
  onGoalModeChange,
  sessionHint,
}: {
  presentation: 'main' | 'sidebar';
  notice: Notice;
  runtimeStatus: ReactNode;
  hostEpoch: number; hostReady: boolean;
  collapsed: boolean;
  onToggle(): void;
  selectedSessionId: number | null;
  selectedSession: SessionSnapshot | null;
  hasOlderRuns: boolean;
  canNewChatAndSend: boolean;
  onNewChatAndSend(): void;
  onLoadOlderRuns(): void;
  turns: readonly ChatTurn[];
  messages: readonly SessionMessageView[];
  ownsRun(runId: number): boolean;
  unconfirmedCount: number;
  historyLoading: boolean;
  historyError: string | null;
  runFeedbacks: readonly RunFeedback[];
  onRefreshHistory(): void;
  onSessionDetails(): void;
  transcriptRef: RefObject<HTMLDivElement | null>;
  input: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange(value: string): void;
  onSend(): void;
  onAppend(mode: 'steer' | 'followUp'): void;
  canAppend: boolean;
  inputReadError: string | null;
  unknownInput: boolean;
  onCheckInputStatus(): void;
  canBranch: boolean;
  onBranch(entryId: string): void;
  onCancel(): void;
  enabled: boolean;
  busy: boolean;
  cancelPending: boolean;
  activeAgentRunId: number | null;
  activeAgentSessionId: number | null;
  activeRunModel: { id: string; name: string; model: string } | null;
  activeInputTarget: { runId: number; material: string; selection: string | null } | null;
  selectedModelId: string | null;
  modelName: string | null;
  modelId: string | null;
  contextName: string | null;
  researchContext: boolean;
  goalMode: 'answer' | 'save-candidate';
  canGenerate: boolean;
  onGoalModeChange(value: 'answer' | 'save-candidate'): void;
  sessionHint: string;
}) {
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const commandOwner = useRef(0);
  const currentDraft = useRef(input); currentDraft.current = input;
  useEffect(() => () => { commandOwner.current++; }, []);
  useEffect(() => { commandOwner.current++; setCommandPending(false); setCommandError(null); }, [selectedSessionId, hostEpoch]);
  async function send() {
    if (commandPending) return;
    if (!/^\/invoice-assist(?:\s|$)/.test(input)) { onSend(); return; }
    const token = ++commandOwner.current; setCommandError(null);
    if (input.trim() !== '/invoice-assist') { setCommandError('invoice-assist is a diagnostic command and takes no arguments.'); return; }
    if (!hostReady || busy || selectedSessionId === null) { setCommandError('Choose an idle conversation with invoice-assist loaded. Your draft is retained.'); return; }
    const draft = input; setCommandPending(true);
    try {
      const loaded = await window.flowmate.querySessionExtensions({ sessionId: selectedSessionId });
      if (commandOwner.current !== token) return;
      const instance = loaded.ok ? loaded.data.instances.find(item => item.state === 'active' && item.ref.id === 'invoice-assist'
        && item.registeredCommands.includes('invoice-assist')) : null;
      if (!instance) { setCommandError('The diagnostic command is not registered in this conversation.'); return; }
      const result = await window.flowmate.executeExtensionCommand({ sessionId: selectedSessionId, expectedInstanceId: instance.instanceId,
        name: 'invoice-assist', arguments: '' });
      if (commandOwner.current !== token) return;
      if (result.ok) { if (currentDraft.current === draft) onInputChange(''); setCommandError('Diagnostic confirmed.'); } else setCommandError(result.error.message);
    } catch { if (commandOwner.current === token) setCommandError('Command receipt is unknown. Your draft is retained.'); }
    finally { if (commandOwner.current === token) setCommandPending(false); }
  }
  const childParent = activeAgentSessionId === selectedSessionId && activeAgentRunId !== null ? activeAgentRunId
    : [...messages].reverse().find(message => message.runId !== null && ownsRun(message.runId))?.runId
      ?? [...turns].reverse().find(turn => turn.sessionId === selectedSessionId)?.runId;
  const title = selectedSession ? chatTitle(selectedSession.title) : 'New conversation';
  const emptyHint = contextName ? 'Ask about your selected material, or continue the conversation.'
    : 'Start a conversation, explore a question, or work with your documents.';
  return <section className={`agent-chat-panel ${presentation === 'main' ? 'main' : ''} ${collapsed ? 'collapsed' : ''}`}
    data-testid="agent-chat-panel" role={presentation === 'main' ? 'main' : 'complementary'} aria-label="Assistant"
    onKeyDown={(event) => { if (event.key === 'Escape' && presentation === 'sidebar' && !collapsed && window.innerWidth < 1080) onToggle(); }}>
    <div className="chat-collapsed-controls" hidden={!collapsed}>
      <button className="chat-expand" type="button" onClick={onToggle} aria-label="Open Assistant" aria-expanded={false} title="Open Assistant"><span aria-hidden="true">‹</span><b>Assistant</b></button>
      {busy && <button className="chat-collapsed-stop" type="button" onClick={onCancel} disabled={cancelPending} aria-label={cancelPending ? 'Stopping…' : 'Stop'} title={cancelPending ? 'Stopping…' : 'Stop active run'}>■</button>}
    </div>
    <div className="chat-panel-content" hidden={collapsed}>
    <header className="chat-panel-head">
      <div><h2>{presentation === 'main' ? title : 'Assistant'}</h2>
        {presentation === 'sidebar' && <span className="chat-current-title">{title}</span>}</div>
      {presentation === 'sidebar' && <button className="chat-collapse" type="button" onClick={onToggle} aria-label="Close Assistant" aria-expanded={true} title="Close Assistant">›</button>}
    </header>
    {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
    {runtimeStatus}
    <div className="chat-model-row"><span className={`status-dot ${modelName ? 'is-ready' : 'is-error'}`} /><div><strong>{modelName ?? 'Set up a model in Settings'}</strong></div></div>
    {selectedSession && <div className="chat-session-state"><span className={`status-dot ${selectedSession.availability === 'ready' ? 'is-ready' : selectedSession.availability === 'busy' ? 'is-warning' : 'is-error'}`} />
      <button className="text-button" type="button" onClick={onSessionDetails}>Session details</button>
      <span>{selectedSession.deletePending ? 'Delete incomplete · retry Delete in Chats' : selectedSession.status === 'archived' ? 'Archived · unarchive in Chats to continue'
        : selectedSession.historyState === 'legacy-read-only' ? 'Read only · older conversation' : selectedSession.historyState === 'invalid' ? 'History cannot be restored' : selectedSession.availability === 'ready' ? 'Ready' : selectedSession.availability === 'busy' ? 'Responding' : selectedSession.availability === 'unusable' ? 'Cannot continue' : 'Unavailable'}</span>
    </div>}
    {activeAgentRunId !== null && activeAgentSessionId !== null && activeAgentSessionId !== selectedSessionId
      && <div className="chat-active-run">Another conversation is responding. You can draft a message here.</div>}
    {busy && activeRunModel && <div className="chat-run-model">Responding with {activeRunModel.name}{selectedModelId !== activeRunModel.id && <span>Your new model choice will apply next time.</span>}</div>}
    <div className="chat-transcript" ref={transcriptRef} role="log" aria-live="polite" aria-relevant="additions text">
      <div className="chat-history-actions">
        {hasOlderRuns && <button type="button" className="chat-more-runs" onClick={onLoadOlderRuns} disabled={historyLoading}>Earlier messages</button>}
        {selectedSessionId !== null && <button type="button" className="chat-more-runs" onClick={onRefreshHistory} disabled={historyLoading}>
          {historyLoading ? 'Loading history…' : 'Refresh history'}</button>}
      </div>
      {historyError && <p className="chat-error" role="alert">{historyError}</p>}
      {unconfirmedCount > 0 && <p className="chat-save-feedback" role="status">{unconfirmedCount} {unconfirmedCount === 1 ? 'message has' : 'messages have'} not been confirmed as saved. Refresh history to check.</p>}
      {messages.length === 0 && turns.length === 0 && !historyLoading && <div className="chat-empty"><span className="chat-empty-mark" aria-hidden="true">F</span><strong>{researchContext ? 'Explore your research question' : 'How can I help?'}</strong><p>{researchContext ? 'Create or select a research task to plan an investigation, refine its scope, or discuss a saved report.' : emptyHint}</p></div>}
      {messages.map((message) => <article className="chat-turn native-message" data-testid="chat-turn"
        data-message-role={message.role} data-message-entry={message.entryId ?? undefined}
        data-message-run={message.runId ?? undefined} data-message-ordinal={message.liveOrdinal ?? undefined}
        data-persistence={message.persistence} key={message.entryId ? `entry:${message.entryId}` : `live:${message.runId}:${message.liveOrdinal}`}>
        <div className={message.role === 'user' ? 'chat-user-message' : message.role === 'toolResult' ? 'chat-tool-result'
          : `chat-assistant-message ${message.phase === 'streaming' ? 'sending' : message.stopReason === 'aborted' ? 'cancelled' : message.stopReason === 'error' ? 'failed' : 'completed'}`}>
          <span className="chat-speaker">{message.role === 'user' ? 'YOU' : message.role === 'toolResult' ? 'TOOL RESULT' : 'ASSISTANT'}</span>
          {message.role === 'toolResult' && <div className="chat-tool-identity"><strong>{message.toolName}</strong><small>{message.toolCallId}</small></div>}
          {message.blocks.map((block, index) => block.type === 'text' ? <p key={index}>{block.text}</p>
            : <div className="chat-tool-call" key={`${block.id}:${index}`}><strong>{block.name}</strong><small>{block.id}</small></div>)}
          {message.phase === 'streaming' && <div className="chat-pending"><span className="loader-ring" />Responding…</div>}
          {message.truncated && <p className="chat-save-feedback">This message is shortened for display. Its full saved content is preserved.</p>}
          <span className={`chat-message-save ${message.persistence}`}>
            {message.persistence === 'saved' ? 'Saved' : message.persistence === 'failed' ? 'Save failed' : 'Waiting to save'}
          </span>
          {message.role === 'assistant' && message.persistence === 'saved' && message.entryId !== null
            && message.phase === 'ended' && message.stopReason === 'stop' && !message.blocks.some(block => block.type === 'toolCall')
            && <button className="text-button" type="button" disabled={!canBranch} onClick={() => onBranch(message.entryId!)}>Continue from this reply</button>}
        </div>
      </article>)}
      {selectedSession?.historyState !== 'legacy-read-only' && turns.filter((turn) => turn.status === 'sending').map((turn) =>
        <div className="chat-input-intent" key={turn.id}><span>Submitting your message…</span><p>{turn.prompt}</p></div>)}
      {selectedSession?.historyState === 'legacy-read-only' && turns.length > 0 && <p className="chat-save-feedback">Earlier conversation summaries · full message history is unavailable</p>}
      {selectedSession?.historyState === 'legacy-read-only' && turns.map((turn) => <article className="chat-turn" data-testid="legacy-run-summary" key={turn.id}>
        <div className="chat-user-message"><span className="chat-speaker">YOU</span><p>{turn.prompt}</p></div>
        <div className={`chat-assistant-message ${turn.status}`}>
          <span className="chat-speaker">ASSISTANT</span>
          {turn.response && <p>{turn.response}</p>}
          {turn.status === 'sending' && <div className="chat-pending"><span className="loader-ring" />{turn.progress ?? 'Responding…'}</div>}
          {turn.status !== 'sending' && !turn.response && <p>{turn.status === 'cancelled' ? 'Request cancelled.' : 'No response was returned.'}</p>}
          {turn.error && <p className="chat-error">{turn.error}</p>}
        </div>
      </article>)}
      {busy && activeAgentSessionId === selectedSessionId && !messages.some((message) => message.phase === 'streaming')
        && <div className="chat-pending"><span className="loader-ring" />Responding…</div>}
      {runFeedbacks.map((item) => <div key={item.runId}>
        <p className={item.status === 'failed' ? 'chat-error' : 'chat-save-feedback'}>
          {item.status === 'cancelled' ? 'Request cancelled.' : item.error ?? 'The request failed.'}</p>
        {item.limits && <p className="chat-save-feedback">{item.limits}</p>}
      </div>)}
    </div>
    {inputReadError && <p className="chat-save-feedback" role="alert">{inputReadError}</p>}
    {unknownInput && <div className="chat-save-feedback" role="status">The original input receipt is unknown. Your draft is preserved.
      <button className="text-button" type="button" onClick={onCheckInputStatus}>Check input status</button></div>}
    {childParent != null && selectedSessionId !== null && <Subagents compact busy={busy && activeAgentSessionId === selectedSessionId}
      key={`${hostEpoch}:${selectedSessionId}:${childParent}`} parentRunId={childParent} parentSessionId={selectedSessionId}
      hostEpoch={hostEpoch} ready={hostReady} refreshToken={`${busy}:${messages.length}:${turns.length}`}
      onObserve={() => onSessionDetails()} />}
    {commandError && <p className="chat-save-feedback" role="status">{commandError}</p>}
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {(activeInputTarget ? activeInputTarget.material !== 'General conversation' : Boolean(contextName)) && <div className="chat-context">{activeInputTarget ? `Responding to ${activeInputTarget.material}${activeInputTarget.selection && activeInputTarget.selection !== 'No selection' ? ` · ${activeInputTarget.selection}` : ''}`
        : `Working with ${contextName}`}</div>}
      {sessionHint && <p className="chat-config-hint">{sessionHint}</p>}
      {(selectedSession?.historyState === 'legacy-read-only' || selectedSession?.historyState === 'invalid') && input.trim() && <button className="secondary-button" type="button" disabled={!canNewChatAndSend} onClick={onNewChatAndSend}>New chat and send</button>}
      {canGenerate && <button className={`generate-toggle ${goalMode === 'save-candidate' ? 'selected' : ''}`} type="button" aria-pressed={goalMode === 'save-candidate'} onClick={() => onGoalModeChange(goalMode === 'save-candidate' ? 'answer' : 'save-candidate')}>Generate result {goalMode === 'save-candidate' ? 'for next message' : ''}</button>}
      <InputCommands input={input} onChange={onInputChange} onSend={() => void send()} composerRef={composerRef}
        sessionId={selectedSessionId} ready={hostReady} busy={busy} />
      <div className="chat-composer-foot"><span>{busy ? 'Choose how to add this input' : 'Enter to send · Shift+Enter for a new line'}</span>
        {busy ? <><button className="secondary-button" type="button" disabled={!canAppend || !input.trim()} onClick={() => onAppend('steer')}>Steer</button>
          <button className="secondary-button" type="button" disabled={!canAppend || !input.trim()} onClick={() => onAppend('followUp')}>Follow up</button>
          <button className="secondary-button cancel-button" type="button" onClick={onCancel} disabled={cancelPending}>{cancelPending ? 'Stopping…' : 'Stop'}</button></>
          : <button className="primary-button" type="submit" disabled={!enabled || !input.trim()}>Send <span aria-hidden="true">↗</span></button>}
      </div>
    </form>
    </div>
  </section>;
}
