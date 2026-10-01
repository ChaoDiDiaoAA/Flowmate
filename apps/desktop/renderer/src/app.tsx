import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import { InvoiceFormBridgeRequestSchema, StoredCandidateDraftSchema } from '../../../../packages/contracts/src/invoice.ts';
import type { DesktopInvoiceFormRunRequest, InvoiceCandidateOperationQuery, InvoiceFormApplicationReceipt, InvoiceFormDraft, SaveInvoiceCandidateResponse } from '@flowmate/contracts';
import { applyInvoiceForm, bindInvoiceFormRun, cancelInvoiceFormRun, createInvoiceFormState, editInvoiceForm, invalidateInvoiceForm,
  invoiceHeaderFields, invoiceLineFields, queryInvoiceFormApplication, type InvoiceFormState } from './invoice-form.ts';
import type { AgentRunEvent, AgentRunSnapshot, BusinessEventSnapshot, CandidateJobDetail, CandidateSummary, DesktopEvent, DesktopState, DocumentOriginalImage, DocumentSnapshot, InvoiceToolOutput, JobSnapshot, ModelCatalogProvider, ModelProfile, NativeToolAvailability, ProductSettings, RunSnapshot, RuntimeState, SessionCursor, SessionMessageView, SessionSnapshot, WorkspaceChange, WorkspaceSnapshot } from '@flowmate/contracts';
import { applyMessageUpsert, mergeSavedHistory, messageViewsForDisplay, type MessageViewState } from './message-state.ts';

type Page = 'workspace' | 'tasks' | 'chats' | 'models' | 'settings';
const pageLabels: Record<Page, string> = {
  workspace: 'Invoices', tasks: 'Processing History', chats: 'Chats',
  models: 'Models', settings: 'Settings',
};
type Notice = { tone: 'good' | 'bad' | 'info'; message: string } | null;
type ProfileDraft = { displayName: string; theme: 'system' | 'light' | 'dark' };
type ChatTurn = {
  id: string;
  sessionId: number;
  runId: number | null;
  prompt: string;
  response: string | null;
  error: string | null;
  status: 'sending' | 'completed' | 'failed' | 'cancelled';
  progress?: string | null;
};
type RunFeedback = { runId: number; status: 'completed' | 'failed' | 'cancelled'; error: string | null };

function emptyMessageState(sessionId: number): MessageViewState {
  return { sessionId, byEntryId: new Map(), liveByRun: new Map(), lastSequenceByMessage: new Map(),
    aliases: new Map(), highestSeenSequenceByRun: new Map(), closedRuns: new Set() };
}

function newId(): string { return crypto.randomUUID().replaceAll('-', ''); }
function chatTitle(title: string): string { return title === 'New Session' ? 'New chat' : title; }

function blankModel(): ModelProfile {
  return { id: newId(), credentialRef: newId(), name: 'Primary model', kind: 'catalog', providerId: null,
    baseUrl: '', model: '', api: '', contextWindow: null, maxTokens: null, reasoning: false };
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: { message?: unknown; code?: unknown; category?: unknown } }).error;
    if (error?.code === 'agent_goal_not_met') return 'No result was saved. Ask the assistant to generate and save a result.';
    if (error?.code === 'session_scope_revoked') return 'Model access to this invoice was revoked. Start a new chat.';
    if (error?.code === 'state_conflict') return 'The invoice context changed. Review it and send again.';
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
  const [page, setPage] = useState<Page>('workspace');
  const [state, setState] = useState<DesktopState | null>(null);
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
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [messageState, setMessageState] = useState<MessageViewState | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [runFeedbacks, setRunFeedbacks] = useState<RunFeedback[]>([]);
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [sidebarRenameId, setSidebarRenameId] = useState<number | null>(null);
  const [sidebarRenameTitle, setSidebarRenameTitle] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [documents, setDocuments] = useState<DocumentSnapshot[]>([]);
  const [historicalDocuments, setHistoricalDocuments] = useState<Record<number, DocumentSnapshot>>({});
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [historyJobId, setHistoryJobId] = useState<number | null>(null);
  const [hidingDocumentId, setHidingDocumentId] = useState<number | null>(null);
  const [candidateSummaries, setCandidateSummaries] = useState<CandidateSummary[]>([]);
  const [candidateDetail, setCandidateDetail] = useState<CandidateJobDetail | null>(null);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceFormState | null>(null);
  const [formFeedback, setFormFeedback] = useState('');
  const [formPreparing, setFormPreparing] = useState(false);
  const [formLeavePrompt, setFormLeavePrompt] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formOutcomeUnknown, setFormOutcomeUnknown] = useState(false);
  const [humanOperationUnknown, setHumanOperationUnknown] = useState(false);
  const [rejectPrompt, setRejectPrompt] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [activity, setActivity] = useState<BusinessEventSnapshot[]>([]);
  const [parsedPage, setParsedPage] = useState<InvoiceToolOutput<'read_invoice_document'> | null>(null);
  const [originalImage, setOriginalImage] = useState<DocumentOriginalImage | null>(null);
  const [taskGoal, setTaskGoal] = useState('');
  const [goalMode, setGoalMode] = useState<'answer' | 'save-candidate'>('answer');
  const [activeAgentRunId, setActiveAgentRunId] = useState<number | null>(null);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<number | null>(null);
  const [activeRunModel, setActiveRunModel] = useState<{ id: string; name: string; model: string } | null>(null);
  const [sessionCursor, setSessionCursor] = useState<SessionCursor | null>(null);
  const [runCursor, setRunCursor] = useState<number | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionMutating, setSessionMutating] = useState(false);
  const [revokingAccess, setRevokingAccess] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(() => window.innerWidth < 1080);
  const [navOpen, setNavOpen] = useState(false);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
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
  const latestFinished = useRef<Extract<DesktopEvent, { type: 'provider_finished' }> | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeChatTurnId = useRef<string | null>(null);
  const activeChatSessionId = useRef<number | null>(null);
  const chatDrafts = useRef(new Map<string, string>());
  const chatInputRef = useRef('');
  const eventSequences = useRef(new Map<number, number>());
  const messageStates = useRef(new Map<number, MessageViewState>());
  const messageCursors = useRef(new Map<number, string | null>());
  const nativeSessionIds = useRef(new Map<number, string>());
  const knownRunSessions = useRef(new Map<number, number>());
  const historyQueries = useRef(new Map<number, { inFlight: boolean; refreshPending: boolean; beforeEntryId?: string }>());
  const activeAgentRunIdRef = useRef<number | null>(null);
  const agentStopRequested = useRef(false);
  const selectedSessionIdRef = useRef<number | null>(null);
  const workspaceRef = useRef<WorkspaceSnapshot | null>(null);
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

  function receiveDesktopState(next: DesktopState): boolean {
    if (next.ready && next.settings.revision < settingsRevision.current) return false;
    settingsRevision.current = Math.max(settingsRevision.current, next.settings.revision);
    hostReadyRef.current = next.ready;
    setState(current => current && next.settings.revision < current.settings.revision
      ? { ...next, settings: current.settings, modelCredentials: current.modelCredentials } : next);
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
        valid: form.valid, basis: structuredClone(form.basis), draft: structuredClone(form.draft) });
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
    const current = workspaceRef.current;
    if (!current?.documentRef || !current.jobId || !current.candidateRef || !detail
      || detail.candidate.candidateId !== current.candidateRef.id || detail.candidate.sequence !== current.candidateRef.sequence
      || detail.documentRef.id !== current.documentRef.id || detail.documentRef.version !== current.documentRef.version) return null;
    if (!await confirmFormLeave()) return null;
    const expected = { revision: current.revision, sessionId: current.sessionId, documentRef: current.documentRef,
      jobId: current.jobId, candidateRef: current.candidateRef };
    const target = await window.flowmate.registerInvoiceFormTarget({ purpose, workspace: expected, formRevision: 0 });
    if (!target.ok) { setNotice({ tone: 'bad', message: errorMessage(target) }); return null; }
    if (workspaceRef.current?.revision !== current.revision || !hostReadyRef.current) {
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
    if (!persistedModel || !modelReady || busy) return;
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
        const form = invoiceFormRef.current;
        if (form?.formInstanceId === input.target.formInstanceId && form.runId === null) {
          const bound = bindInvoiceFormRun(form, saved.runId!); if (bound) publishInvoiceForm(bound);
        }
        const run = await window.flowmate.queryRun(saved.runId!);
        if (run.ok && (run.data.status === 'created' || run.data.status === 'running')) trackFillRun(saved.runId!, saved.sessionId);
        setFormFeedback(`Original Fill input is ${saved.status}. Its form application has not been confirmed. Processing ${saved.processingStatus}${run.ok ? `; Run ${run.data.status}` : ''}.`);
        void refreshRuntimeState();
      } else setFormFeedback(result.ok ? 'Original Fill input has no confirmed delivery. Do not repeat it automatically.' : errorMessage(result));
    }
  }

  function changeInvoiceFormDraft(value: InvoiceFormDraft) {
    if (formSubmittingRef.current) return;
    const current = invoiceFormRef.current; if (!current) return;
    const next = editInvoiceForm(current, value); if (next) publishInvoiceForm(next);
  }

  async function saveInvoiceResult(): Promise<boolean> {
    const form = invoiceFormRef.current; const current = workspaceRef.current;
    if (!form?.valid || !current || formSubmittingRef.current || humanOperationUnknown) return false;
    const request = { operationRef: crypto.randomUUID(), jobId: form.basis.jobId, basedOnCandidateId: form.basis.candidateId,
      expectedCandidateId: form.basis.candidateId, expectedRevision: current.revision, draft: structuredClone(form.draft) };
    lastHumanOperation.current = { kind: 'save', request }; setFormSubmission(true);
    try {
      const result = await window.flowmate.saveInvoiceCandidate(request);
      if (!result.ok) { setHumanOperationUnknown(result.error.code === 'operation_result_unknown'); setFormFeedback(errorMessage(result)); return false; }
      await discardForm(); acceptWorkspace(result.data.workspace);
      const detail = await window.flowmate.queryJobCandidate({ jobId: request.jobId, candidateId: result.data.candidate.candidateId });
      if (detail.ok) { setCandidateDetail(detail.data); await prepareInvoiceForm('edit', detail.data); }
      setFormFeedback('Result saved for review.'); await loadTaskDetails(request.jobId); await loadProductLists(); return true;
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
    lastHumanOperation.current = operation; setFormSubmission(true);
    try {
      const result = operation.kind === 'accept' ? await window.flowmate.acceptInvoiceCandidate(operation.request)
        : await window.flowmate.rejectInvoiceCandidate(operation.request);
      if (!result.ok) { setHumanOperationUnknown(result.error.code === 'operation_result_unknown'); setFormFeedback(errorMessage(result)); return; }
      await discardForm(); acceptWorkspace(result.data.workspace);
      const detail = await window.flowmate.queryJobCandidate({ jobId: base.jobId, candidateId: base.candidateId });
      if (detail.ok) setCandidateDetail(detail.data);
      setNotice({ tone: 'good', message: kind === 'accept' ? 'Result accepted.' : 'Result rejected.' });
      await loadTaskDetails(base.jobId); await loadProductLists();
    } finally { setFormSubmission(false); }
  }

  async function exportInvoiceResult(format: 'json' | 'csv' | 'markdown') {
    const candidate = candidateDetail?.candidate; if (!candidate || candidate.status !== 'accepted') return;
    const request = { operationRef: crypto.randomUUID(), candidateId: candidate.candidateId, format };
    lastHumanOperation.current = { kind: 'export', request }; setFormSubmission(true);
    try {
      const result = await window.flowmate.exportInvoiceCandidate(request);
      if (!result.ok) setHumanOperationUnknown(result.error.code === 'operation_result_unknown');
      setNotice(result.ok ? { tone: 'good', message: `Export created: ${result.data.relativePath}` }
        : { tone: 'bad', message: errorMessage(result) });
    } finally { setFormSubmission(false); }
  }

  async function checkHumanOperation() {
    const operation = lastHumanOperation.current; if (!operation || formSubmittingRef.current) return;
    const result = await window.flowmate.queryInvoiceCandidateOperation(operation);
    setNotice(result.ok ? { tone: 'info', message: result.data ? `Original ${operation.kind} operation confirmed.`
      : 'Original operation has no confirmed commit. Your local draft is retained.' } : { tone: 'bad', message: errorMessage(result) });
    if (result.ok && result.data) { setHumanOperationUnknown(false); await loadWorkspace(); await loadProductLists(); if (workspaceRef.current?.jobId) await loadTaskDetails(workspaceRef.current.jobId); }
  }

  async function refreshRuntimeState(): Promise<RuntimeState | null> {
    const sequence = ++runtimeQuerySequence.current;
    setRuntimeState(null);
    setRuntimeReadFailed(false);
    if (!hostReadyRef.current) return null;
    try {
      const result = await window.flowmate.queryRuntimeState();
      if (sequence !== runtimeQuerySequence.current || !hostReadyRef.current) return null;
      if (!result.ok) { setRuntimeReadFailed(true); return null; }
      setRuntimeState(result.data);
      return result.data;
    } catch {
      if (sequence === runtimeQuerySequence.current && hostReadyRef.current) setRuntimeReadFailed(true);
      return null;
    }
  }

  function draftKey(sessionId: number | null): string { return sessionId === null ? 'new' : String(sessionId); }

  function updateChatInput(value: string) {
    chatInputRef.current = value;
    chatDrafts.current.set(draftKey(selectedSessionIdRef.current), value);
    setChatInput(value);
  }

  async function navigate(next: Page) {
    if (next !== page && !await confirmFormLeave()) return;
    setPage(next);
    setNavOpen(false);
    const selectedJobId = historyJobId ?? workspace?.jobId;
    if (next === 'tasks' && selectedJobId) void loadTaskDetails(selectedJobId);
  }

  async function openChat(sessionId: number) {
    if (!await confirmFormLeave()) return;
    selectSession(sessionId, true);
    setNavOpen(false);
    if (window.innerWidth < 1080) setChatCollapsed(false);
  }

  async function loadSessionList(append = false) {
    const before = append ? sessionCursorRef.current : null;
    const result = await window.flowmate.listSessions({ limit: 100, ...(before ? { before } : {}) });
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    sessionCursorRef.current = result.data.next;
    for (const session of result.data.items) nativeSessionIds.current.set(session.sessionId, session.nativeSessionId);
    setSessionCursor(result.data.next);
    setSessions((current) => append ? [...current, ...result.data.items] : result.data.items);
    if (allowInitialSessionSelection.current && selectedSessionIdRef.current === null
      && !chatDrafts.current.get('new') && result.data.items[0]) {
      selectSession(result.data.items[0].sessionId);
    }
  }

  function acceptWorkspace(snapshot: WorkspaceSnapshot) {
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
    }
    workspaceRef.current = snapshot;
    setWorkspace(snapshot);
  }

  async function loadWorkspace() {
    const result = await window.flowmate.readWorkspace();
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return null; }
    acceptWorkspace(result.data);
    return result.data;
  }

  async function loadProductLists() {
    const [documentsResult, jobsResult] = await Promise.all([
      window.flowmate.listDocuments({ limit: 50 }),
      window.flowmate.listJobs({ limit: 50 }),
    ]);
    if (documentsResult.ok) setDocuments(documentsResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(documentsResult) });
    if (jobsResult.ok) setJobs(jobsResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(jobsResult) });
    if (jobsResult.ok) {
      const visibleIds = new Set(documentsResult.ok ? documentsResult.data.items.map((item) => item.documentRef.id) : []);
      const missingIds = [...new Set(jobsResult.data.items.map((item) => item.documentRef.id))]
        .filter((id) => !visibleIds.has(id));
      const fetched = await Promise.all(missingIds.map((id) => window.flowmate.queryDocument(id)));
      setHistoricalDocuments((current) => ({ ...current, ...Object.fromEntries(fetched.filter((item) => item.ok)
        .map((item) => [item.data.documentRef.id, item.data])) }));
    }
  }

  async function changeWorkspace(change: WorkspaceChange) {
    if (!await confirmFormLeave()) return null;
    const update = workspaceChanges.current.then(async () => {
      let current = workspaceRef.current;
      if (!current) current = await loadWorkspace();
      if (!current) return null;
      const result = await window.flowmate.updateWorkspace({ expectedRevision: current.revision, change });
      if (!result.ok) {
        setNotice({ tone: 'bad', message: errorMessage(result) });
        if (result.error.code === 'state_conflict') await loadWorkspace();
        return null;
      }
      acceptWorkspace(result.data);
      return result.data;
    });
    workspaceChanges.current = update.then(() => undefined, () => undefined);
    return update;
  }

  async function loadProductOverview() {
    await Promise.all([loadWorkspace(), loadProductLists()]);
  }

  async function loadDocumentMaterial(documentId: number) {
    const page = await window.flowmate.readDocumentPage({ documentId, page: 1, afterBlockId: null, limit: 50 });
    if (page.ok) setParsedPage(page.data);
    else { setParsedPage(null); setNotice({ tone: 'bad', message: errorMessage(page) }); }
    const original = await window.flowmate.readDocumentOriginal(documentId, 1);
    if (original.ok) setOriginalImage(original.data);
    else setOriginalImage(null);
  }

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
    const snapshot = await changeWorkspace({ kind: 'document', documentId });
    if (!snapshot) return;
    setHistoryJobId(null);
    if (documentId === null) return;
    let doc = documents.find((item) => item.documentRef.id === documentId);
    if (!doc) {
      const queried = await window.flowmate.queryDocument(documentId);
      if (queried.ok) doc = queried.data;
    }
    if (doc) await loadDocumentMaterial(documentId);
  }

  async function startTask() {
    if (!await confirmFormLeave()) return;
    let current = workspaceRef.current;
    if (!current?.documentRef) return;
    if (!current.sessionId) {
      const created = await createNewSession();
      if (!created) return;
      current = workspaceRef.current;
    }
    if (!current?.documentRef || !current.sessionId) return;
    const result = await window.flowmate.startTask({
      clientSequence: current.nextTaskSequence,
      expectedRevision: current.revision,
      documentRef: current.documentRef,
      goal: `Prepare an invoice candidate from this document.${taskGoal.trim() ? ` Additional requirements: ${taskGoal.trim()}` : ''}`,
    });
    if (!result.ok) {
      if (result.error.code === 'state_conflict') await loadWorkspace();
      setNotice({ tone: 'bad', message: errorMessage(result) });
      return;
    }
    acceptWorkspace(result.data.workspace);
    setHistoryJobId(result.data.job.jobId);
    setGoalMode('save-candidate');
    updateChatInput('Generate and save a result for this invoice using its parsed data and source references. Keep missing or ambiguous details explicit.');
    setChatCollapsed(false);
    setNotice({ tone: 'good', message: 'Ready to process. Review the request in Assistant, then press Send.' });
    await loadProductLists();
    await loadTaskDetails(result.data.job.jobId);
  }

  async function loadTaskDetails(jobId: number) {
    const [candidatesResult, activityResult] = await Promise.all([
      window.flowmate.listJobCandidates({ jobId, limit: 50 }),
      window.flowmate.listActivity({ jobId, limit: 50 }),
    ]);
    if (candidatesResult.ok) setCandidateSummaries(candidatesResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(candidatesResult) });
    if (activityResult.ok) setActivity(activityResult.data.items);
    else setNotice({ tone: 'bad', message: errorMessage(activityResult) });
  }

  async function openCandidate(jobId: number, candidateId: number) {
    if (candidateDetail?.candidate.candidateId !== candidateId && !await confirmFormLeave()) return;
    const sequence = ++candidateQuerySequence.current;
    const result = await window.flowmate.queryJobCandidate({ jobId, candidateId });
    if (sequence !== candidateQuerySequence.current) return;
    if (result.ok) setCandidateDetail(result.data);
    else setNotice({ tone: 'bad', message: errorMessage(result) });
  }

  async function selectCandidate(jobId: number, candidateId: number) {
    if (!await confirmFormLeave()) return;
    const current = workspaceRef.current;
    if (!current) return;
    const result = await window.flowmate.selectCandidate({
      jobId,
      candidateId,
      expectedCandidateId: jobs.find((job) => job.jobId === jobId)?.currentCandidateId ?? null,
      expectedRevision: current.revision,
    });
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    acceptWorkspace(result.data.workspace);
    setNotice({ tone: 'good', message: 'Selected result updated.' });
    await loadProductLists();
    await loadTaskDetails(jobId);
  }

  async function openJob(jobId: number) {
    if (!await confirmFormLeave()) return;
    const job = jobs.find((item) => item.jobId === jobId);
    if (!job) return;
    const document = await window.flowmate.queryDocument(job.documentRef.id);
    if (!document.ok) { setNotice({ tone: 'bad', message: errorMessage(document) }); return; }
    setHistoricalDocuments((current) => ({ ...current, [document.data.documentRef.id]: document.data }));
    if (!document.data.isHidden) {
      const snapshot = await changeWorkspace({ kind: 'job', jobId });
      if (!snapshot) return;
    }
    setHistoryJobId(jobId);
    setCandidateDetail(null);
    await loadTaskDetails(jobId);
  }

  async function hideProcessing(jobId: number) {
    if (!await confirmFormLeave()) return;
    if (!window.confirm('Remove this item from Recent processing? Saved results and activity will remain available.')) return;
    const result = await window.flowmate.hideJob(jobId);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    if (workspaceRef.current?.jobId === jobId || historyJobId === jobId) {
      setHistoryJobId(null);
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
    await querySessionHistory(sessionId);
  }

  function publishMessages(next: MessageViewState) {
    messageStates.current.set(next.sessionId, next);
    if (selectedSessionIdRef.current !== next.sessionId) return;
    setMessageState(next);
    const userRuns = new Set([...next.byEntryId.values(), ...[...next.liveByRun.values()].flatMap((items) => [...items.values()])]
      .filter((item) => item.role === 'user').map((item) => item.runId));
    setChatTurns((turns) => turns.filter((turn) => turn.runId === null || !userRuns.has(turn.runId)));
  }

  async function querySessionHistory(sessionId: number, beforeEntryId?: string) {
    if (selectedSessionIdRef.current !== sessionId) return;
    const coordinator = historyQueries.current.get(sessionId) ?? { inFlight: false, refreshPending: false };
    historyQueries.current.set(sessionId, coordinator);
    if (coordinator.inFlight) {
      coordinator.refreshPending = true;
      coordinator.beforeEntryId = beforeEntryId;
      return;
    }
    coordinator.inFlight = true;
    const selection = sessionLoadSequence.current;
    const historyQuery = beforeEntryId !== undefined ? { beforeEntryId }
      : { afterEntryId: [...(messageStates.current.get(sessionId)?.byEntryId.keys() ?? [])].at(-1) ?? null };
    setHistoryLoading(true);
    let failed = false;
    try {
      const [sessionResult, runsResult, messagesResult] = await Promise.all([
        window.flowmate.querySession(sessionId),
        window.flowmate.listSessionRuns({ sessionId, limit: 100 }),
        window.flowmate.listSessionMessages({ sessionId, limit: 50, ...(beforeEntryId ? { beforeEntryId } : {}) }),
      ]);
      if (selection !== sessionLoadSequence.current || selectedSessionIdRef.current !== sessionId) return;
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
        .map((item) => ({ runId: item.runId, status: item.status as 'failed' | 'cancelled',
          error: item.error ? errorMessage({ error: item.error }) : null })));
    } catch {
      failed = true;
      if (selection === sessionLoadSequence.current && selectedSessionIdRef.current === sessionId) {
        setHistoryError('History could not be loaded. Refresh history to try again.');
      }
    } finally {
      coordinator.inFlight = false;
      const followUp = coordinator.refreshPending && !failed && selectedSessionIdRef.current === sessionId;
      const pendingBefore = coordinator.beforeEntryId;
      coordinator.refreshPending = false;
      delete coordinator.beforeEntryId;
      if (selection === sessionLoadSequence.current && selectedSessionIdRef.current === sessionId) setHistoryLoading(false);
      if (followUp) void querySessionHistory(sessionId, pendingBefore);
    }
  }

  function selectSession(sessionId: number | null, focusComposer = false) {
    chatDrafts.current.set(draftKey(selectedSessionIdRef.current), chatInputRef.current);
    focusComposerWhenReady.current = focusComposer;
    selectedSessionIdRef.current = sessionId;
    sessionLoadSequence.current += 1;
    setSelectedSessionId(sessionId);
    chatInputRef.current = chatDrafts.current.get(draftKey(sessionId)) ?? '';
    setChatInput(chatInputRef.current);
    setSelectedSession(null);
    setRunCursor(null);
    setChatTurns([]);
    setMessageState(sessionId === null ? null : messageStates.current.get(sessionId) ?? null);
    setMessageCursor(sessionId === null ? null : messageCursors.current.get(sessionId) ?? null);
    if (sessionId === null) setHistoryLoading(false);
    setHistoryError(null);
    setRunFeedbacks([]);
    setNotice(null);
    if (sessionId !== null) {
      if (workspaceRef.current?.sessionId !== sessionId) void changeWorkspace({ kind: 'session', sessionId });
      void loadSession(sessionId);
    }
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
    sessionLoadSequence.current += 1;
    chatInputRef.current = createdDraft;
    setChatInput(chatInputRef.current);
    selectedSessionIdRef.current = session.sessionId;
    setSelectedSessionId(session.sessionId);
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
    chatDrafts.current.delete(draftKey(sessionId));
    const next = wasSelected ? remaining.find((item) => item.status === 'active' && item.availability === 'ready'
      && item.historyState === 'recoverable' && !item.modelUseBlocked) ?? null : null;
    if (wasSelected) {
      sessionLoadSequence.current += 1;
      allowInitialSessionSelection.current = false;
      selectedSessionIdRef.current = next?.sessionId ?? null;
      setSelectedSessionId(next?.sessionId ?? null);
      setSelectedSession(null);
      updateChatInput(chatDrafts.current.get(draftKey(next?.sessionId ?? null)) ?? '');
      setChatTurns([]);
      setMessageState(next ? messageStates.current.get(next.sessionId) ?? null : null);
      setMessageCursor(next ? messageCursors.current.get(next.sessionId) ?? null : null);
      setHistoryError(null);
      setRunFeedbacks([]);
      setRunCursor(null);
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
      const refreshedWorkspace = await loadWorkspace();
      if (refreshedWorkspace && next && refreshedWorkspace.sessionId !== next.sessionId) {
        await changeWorkspace({ kind: 'session', sessionId: next.sessionId });
      }
    }
    setNotice({ tone: 'good', message: result.data.disposition === 'hidden'
      ? 'Chat removed from Conversations. Invoice history and saved results remain available.' : 'Chat deleted.' });
    if (wasSelected && next) void loadSession(next.sessionId);
    setSessionMutating(false);
  }

  async function loadMoreSessions() {
    if (sessionCursorRef.current) await loadSessionList(true);
  }

  async function loadOlderRuns() {
    const sessionId = selectedSessionIdRef.current;
    if (sessionId !== null && selectedSession?.historyState !== 'legacy-read-only') {
      const cursor = messageCursors.current.get(sessionId);
      if (cursor) await querySessionHistory(sessionId, cursor);
      return;
    }
    const beforeRunId = runCursor;
    if (sessionId === null || beforeRunId === null) return;
    const selection = sessionLoadSequence.current;
    const result = await window.flowmate.listSessionRuns({ sessionId, beforeRunId, limit: 100 });
    if (selection !== sessionLoadSequence.current || selectedSessionIdRef.current !== sessionId) return;
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
      if (event.type === 'host_state') {
        if (!receiveDesktopState(event.state)) return;
        hostStateSequence.current += 1;
        runtimeQuerySequence.current += 1;
        setRuntimeState(null);
        setRuntimeReadFailed(false);
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
          setRunId(event.runId);
          void refreshRuntimeState();
        }
        return;
      }
      if (event.type === 'provider_finished') {
        void refreshRuntimeState();
        latestFinished.current = event;
        setRunId(event.runId);
        if (activeRequestIdRef.current === event.requestId) {
          setBusy(false);
          setCancelPending(false);
          activeRequestIdRef.current = null;
          setActiveRequestId(null);
        }
        void loadRun(event.runId);
      }
    });
    return () => { alive = false; hostReadyRef.current = false; hostStateSequence.current += 1; runtimeQuerySequence.current += 1; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (state?.ready) {
      void loadNativeTools();
      void loadWorkspace().then((snapshot) => {
        if (!snapshot) return;
        void loadSessionList();
        void loadProductLists();
      });
    }
  }, [state?.ready]);

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

  useEffect(() => {
    if (!assistantWasToggled.current) return;
    if (chatCollapsed) document.querySelector<HTMLButtonElement>('.chat-expand')?.focus();
    else chatComposerRef.current?.focus();
  }, [chatCollapsed]);

  useEffect(() => {
    if (!state) return;
    const revision = state.settings.revision;
    if (revisionLoaded.current === revision) return;
    revisionLoaded.current = revision;
    setProfileDraft(state.settings.profile);
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
  const inputEnabled = true;
  const selectedForSend = selectedSession ?? sessions.find((item) => item.sessionId === selectedSessionId) ?? null;
  const canChat = Boolean(modelReady && runtimeReady && !busy && !sessionLoading && !sessionMutating && !historyLoading && !historyError
    && (selectedSessionId === null || selectedForSend?.availability === 'ready' && !selectedForSend.modelUseBlocked
      && selectedForSend.historyState === 'recoverable')
    && (goalMode !== 'save-candidate' || (workspace?.documentRef && workspace.jobId)));
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
    setRun(null);
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
    const accepted = await window.flowmate.callProvider({ goal: 'Verify this model connection.', text: 'Reply with OK.', modelId: selectedModelId });
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
    const finished = latestFinished.current;
    if (finished?.requestId === accepted.data.requestId) {
      setBusy(false);
      setCancelPending(false);
      activeRequestIdRef.current = null;
      setActiveRequestId(null);
    }
    await loadRun(accepted.data.runId);
  }

  async function sendChatMessage(override?: { sessionId: number; prompt: string }) {
    const prompt = override?.prompt ?? chatInputRef.current.trim();
    const directory = workingDirectory;
    const model = persistedModel;
    if ((!canChat && !override) || !modelReady || busy || !selectedModelId || !model || !prompt) return;
    setBusy(true);
    const actualRuntime = await refreshRuntimeState();
    if (!actualRuntime || actualRuntime.blocked || actualRuntime.active !== null) {
      setBusy(false);
      setNotice({ tone: 'bad', message: runtimeMessage(actualRuntime, !actualRuntime, hostReadyRef.current) });
      return;
    }
    setNotice({ tone: 'info', message: 'Preparing your request…' });
    let sessionId = override?.sessionId ?? selectedSessionIdRef.current;
    if (sessionId === null) {
      const created = await createNewSession(true);
      if (!created) { setBusy(false); return; }
      sessionId = created.sessionId;
    }
    let current = workspaceRef.current ?? await loadWorkspace();
    if (current && current.sessionId !== sessionId) current = await changeWorkspace({ kind: 'session', sessionId });
    if (!current) { setBusy(false); return; }
    const turnId = newId();
    const newTurn: ChatTurn = { id: turnId, sessionId, runId: null, prompt, response: null, error: null, status: 'sending' };
    activeChatTurnId.current = turnId;
    activeChatSessionId.current = sessionId;
    activeAgentRunIdRef.current = null;
    agentStopRequested.current = false;
    setActiveRunModel({ id: model.id, name: model.name, model: model.model });
    chatDrafts.current.set(draftKey(sessionId), '');
    if (selectedSessionIdRef.current === sessionId) updateChatInput('');
    if (selectedSessionIdRef.current === sessionId) setChatTurns((turns) => [...turns, newTurn]);
    setBusy(true);
    setCancelPending(false);
    setNotice(null);
    const accepted = await window.flowmate.startRun({
      sessionId,
      text: prompt,
      modelId: model.id,
      workspace: {
        revision: current.revision,
        documentRef: current.documentRef,
        jobId: current.jobId,
        candidateRef: current.candidateRef,
        sessionId,
      },
      goalMode,
      ...(directory ? { workingDirectory: directory } : {}),
      ...(goalMode === 'save-candidate' ? { timeoutMs: 120_000 } : {}),
    });
    if (!accepted.ok) {
      void refreshRuntimeState();
      setChatTurns((turns) => turns.filter((turn) => turn.id !== turnId));
      const restoredDraft = chatDrafts.current.get(draftKey(sessionId));
      const nextDraft = restoredDraft ? `${prompt}\n\n${restoredDraft}` : prompt;
      chatDrafts.current.set(draftKey(sessionId), nextDraft);
      if (selectedSessionIdRef.current === sessionId) updateChatInput(nextDraft);
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
      ? { ...turn, runId: accepted.data.runId }
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
  }

  async function newChatAndSend() {
    const prompt = chatInputRef.current.trim();
    if (!prompt || !runtimeReady || busy) return;
    const created = await createNewSession(true);
    if (!created) return;
    await sendChatMessage({ sessionId: created.sessionId, prompt });
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

  return (
    <div className={`desktop-shell theme-${profileDraft.theme} ${chatCollapsed ? 'chat-is-collapsed' : ''} ${navOpen ? 'nav-is-open' : ''}`}>
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
          <span className="brand-wordmark"><strong>Flowmate</strong><small>INVOICE DESK</small></span>
          <button ref={navToggleRef} type="button" className="rail-toggle" aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}>{navOpen ? '×' : '☰'}</button>
        </div>
        <button className="sidebar-new-chat" type="button" aria-label="New chat" title="New chat" disabled={!state?.ready || sessionLoading || sessionMutating}
          onClick={() => { setNavOpen(false); if (window.innerWidth < 1080) setChatCollapsed(false); void createNewSession(); }}>
          <span aria-hidden="true">＋</span><span>New chat</span>
        </button>
        <nav aria-label="Workspace navigation">
          <span className="rail-caption">WORK</span>
          {([
            ['workspace', 'Invoices', '▧'],
            ['tasks', 'Processing History', '☷'],
            ['chats', 'Chats', '◌'],
          ] as const).map(([target, label, glyph]) => <button key={target} type="button"
            className={`nav-item ${page === target ? 'active' : ''}`} aria-label={label} title={label}
            aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}>
            <span className="nav-glyph" aria-hidden="true">{glyph}</span><span>{label}</span>
          </button>)}
          <span className="rail-caption setup-caption">SETUP</span>
          {([
            ['models', 'Models', '◇'],
          ] as const).map(([target, label, glyph]) => <button key={target} type="button"
            className={`nav-item ${page === target ? 'active' : ''}`} aria-label={label} title={label}
            aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}>
            <span className="nav-glyph" aria-hidden="true">{glyph}</span><span>{label}</span>
          </button>)}
        </nav>
        <section className="sidebar-recents" aria-label="Recent chats">
          <div className="sidebar-section-head"><span>RECENT CHATS</span><button type="button" onClick={() => navigate('chats')}>View all</button></div>
          {sessions.slice(0, 5).map((session) => <div key={session.sessionId} className="sidebar-chat-row">{sidebarRenameId === session.sessionId
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
            <span className="nav-glyph" aria-hidden="true">⚙</span><span>Settings</span>
          </button>
          <div className="sidebar-status"><span className={`status-dot ${state?.ready ? 'is-ready' : 'is-error'}`} />
            <span>{state?.ready ? 'Ready' : 'Unavailable'}</span></div>
        </div>
      </aside>

      <main className="workspace" data-testid="main-content">
        <header className="topline">
          <div><span className="crumb">{pageLabels[page]}</span></div>
          <div className="top-state"><span className={`status-dot ${state?.ready ? 'is-ready' : 'is-error'}`} />{state?.ready ? 'LOCAL' : 'OFFLINE'}</div>
        </header>

        {page === 'workspace' ? (
          <WorkspacePage
            workspace={workspace}
            documents={documents}
            candidates={candidateSummaries}
            candidateDetail={candidateDetail}
            onSelectCandidate={(jobId, candidateId) => void selectCandidate(jobId, candidateId)}
            formControls={invoiceForm || candidateDetail && workspace?.candidateRef?.id === candidateDetail.candidate.candidateId ? <>
              {candidateDetail && workspace?.candidateRef?.id === candidateDetail.candidate.candidateId && candidateDetail.candidate.status !== 'accepted' && <div className="button-row"><button className="secondary-button" disabled={!runtimeReady || !modelReady || busy || formPreparing || formSubmitting || formOutcomeUnknown || humanOperationUnknown || invoiceForm?.dirty || !workspace?.sessionId || candidateDetail.candidate.status !== 'generated'}
                onClick={() => void fillInvoiceForm()}>Fill form</button>
                <button className="secondary-button" disabled={!runtimeReady || busy || formPreparing || formSubmitting}
                  onClick={() => void beginEditInvoiceForm()}>Edit result</button></div>}
              {invoiceForm && <InvoiceFormEditor state={invoiceForm} feedback={formFeedback} disabled={!invoiceForm.valid || busy || formPreparing || formSubmitting}
                onChange={changeInvoiceFormDraft} onDiscard={() => void discardForm()} onQuery={() => void checkFillStatus()}
                canQuery={invoiceForm.runId !== null || pendingFill.current !== null} canDiscard={!busy && !formPreparing && !formSubmitting}
                operationUnknown={humanOperationUnknown} onSave={() => void saveInvoiceResult()} onAccept={() => void decideInvoiceResult('accept')} onReject={() => void decideInvoiceResult('reject')} />}
              {candidateDetail?.candidate.status === 'accepted' && <div className="button-row">{(['json', 'csv', 'markdown'] as const).map(format =>
                <button key={format} className="secondary-button" disabled={formSubmitting || humanOperationUnknown} onClick={() => void exportInvoiceResult(format)}>Export {format === 'markdown' ? 'Markdown' : format.toUpperCase()}</button>)}</div>}
              <button className="text-button" disabled={formSubmitting} onClick={() => void checkHumanOperation()}>Check original operation</button>
            </> : null}
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
            onChangeView={(view) => void changeWorkspace({ kind: 'view', view })}
            onRefresh={() => void loadProductOverview()}
            onRevokeModelAccess={() => void revokeModelAccess()}
            revokingAccess={revokingAccess}
          />
        ) : page === 'tasks' ? (
          <TasksPage
            workspace={workspace}
            documents={documents}
            historicalDocuments={historicalDocuments}
            jobs={jobs}
            selectedJobId={historyJobId ?? workspace?.jobId ?? null}
            candidates={candidateSummaries}
            candidateDetail={candidateDetail}
            activity={activity}
            notice={notice}
            onOpenJob={(jobId) => void openJob(jobId)}
            onHideJob={(jobId) => void hideProcessing(jobId)}
            onOpenCandidate={(jobId, candidateId) => void openCandidate(jobId, candidateId)}
            onSelectCandidate={(jobId, candidateId) => void selectCandidate(jobId, candidateId)}
          />
        ) : page === 'chats' ? (
          <ChatsPage sessions={sessions} selectedSessionId={selectedSessionId} hasMore={sessionCursor !== null}
            workingDirectory={workingDirectory} onChooseDirectory={() => void chooseWorkingDirectory()}
            onClearDirectory={() => setWorkingDirectory('')} nativeTools={nativeTools} nativeToolsError={nativeToolsError}
            onRefreshTools={() => void loadNativeTools()}
            runDirectory={run?.kind === 'agent' && typeof run.config.workingDirectory === 'string'
              ? { runId: run.runId, directory: run.config.workingDirectory } : null}
            ready={Boolean(state?.ready && !sessionLoading && !sessionMutating)}
            mutating={sessionMutating} notice={notice} onSelect={openChat}
            onRename={renameSession} onDelete={deleteSession} onLoadMore={() => void loadMoreSessions()} />
        ) : (
          <section className="page-content">
            <div className="page-heading">
              <div><h1>{pageLabels[page]}</h1><p>{page === 'models'
                ? 'Choose and configure the models available to Assistant.'
                : 'Make Flowmate comfortable to use on this device.'}</p></div>
            </div>

            {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
            {!state?.ready && <div className="notice bad" role="alert">The application Host is not ready. No model request can be sent until its data store opens successfully.</div>}

            {page === 'models' && <div className="model-layout">
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
                <div className="config-actions">
                  {persistedModel && <button className="text-button danger-text" onClick={() => void removeModel()}>Remove model</button>}
                  <div className="action-spacer" />
                  <button className="secondary-button" onClick={() => void saveConfiguration()} disabled={saving || !state?.ready || draft.kind === 'legacy' || draft.kind === 'catalog' && Boolean(selectedCatalogProvider && !selectedCatalogProvider.authMethods.includes('api_key'))}>{saving ? 'Saving…' : 'Save changes'}</button>
                </div>
                <section className="model-subsection model-check" aria-labelledby="model-check-heading">
                  <h3 id="model-check-heading">Connection check</h3>
                  <p>Testing sends a real model request and may incur usage charges. Saving or opening this page does not send a request.</p>
                  {runtimeStatus}
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
            {page === 'settings' && <section className="panel profile-panel settings-appearance"><div className="panel-head"><h2>Appearance</h2></div>
              <div className="profile-fields"><label className="field"><span>Display name</span><input value={profileDraft.displayName} onChange={(event) => setProfileDraft((old) => ({ ...old, displayName: event.target.value }))} maxLength={80} /></label><label className="field"><span>Theme</span><select value={profileDraft.theme} onChange={(event) => setProfileDraft((old) => ({ ...old, theme: event.target.value as typeof old.theme }))}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
              <div className="config-actions"><span className="action-spacer" /><button className="secondary-button" onClick={() => void saveProfile()} disabled={saving || !state?.ready}>Save appearance</button></div>
            </section>}
            {page === 'settings' && <details className="panel diagnostics-panel"><summary>Diagnostics</summary>
              <div><p>Application: {state?.ready ? 'Ready' : 'Unavailable'}</p>
                <p>Selected model: {persistedModel ? credentialStatus === 'configured' ? 'Ready to connect' : 'Credential needs attention' : 'No model selected'}</p>{runtimeStatus}</div>
            </details>}
          </section>
        )}
      </main>
      <AgentChatPanel
        collapsed={chatCollapsed}
        onToggle={() => { assistantWasToggled.current = true; setChatCollapsed((collapsed) => !collapsed); }}
        selectedSessionId={selectedSessionId}
        selectedSession={selectedSession}
        hasOlderRuns={selectedSession?.historyState === 'legacy-read-only' ? runCursor !== null : messageCursor !== null}
        onNewChatAndSend={() => void newChatAndSend()}
        onLoadOlderRuns={() => void loadOlderRuns()}
        turns={chatTurns}
        messages={messageState ? messageViewsForDisplay(messageState) : []}
        unconfirmedCount={messageState ? [...messageState.liveByRun]
          .filter(([runId]) => messageState.closedRuns.has(runId)).reduce((total, [, items]) => total + items.size, 0) : 0}
        historyLoading={historyLoading}
        historyError={historyError}
        runFeedbacks={runFeedbacks}
        onRefreshHistory={() => { if (selectedSessionIdRef.current !== null) void loadSession(selectedSessionIdRef.current); }}
        transcriptRef={chatTranscriptRef}
        input={chatInput}
        composerRef={chatComposerRef}
        onInputChange={updateChatInput}
        onSend={() => void sendChatMessage()}
        onCancel={() => void cancelAgentRun()}
        enabled={canChat}
        busy={busy}
        cancelPending={cancelPending}
        activeAgentRunId={activeAgentRunId}
        activeAgentSessionId={activeAgentSessionId}
        activeRunModel={activeRunModel}
        selectedModelId={selectedModelId}
        modelName={persistedModel?.name ?? null}
        modelId={persistedModel?.model ?? null}
        contextName={documents.find((item) => item.documentRef.id === workspace?.documentRef?.id)?.displayName ?? null}
        goalMode={goalMode}
        canGenerate={Boolean(workspace?.documentRef && workspace.jobId)}
        onGoalModeChange={setGoalMode}
        sessionHint={!runtimeReady ? runtimeFeedback : !selectedSession ? selectedSessionId !== null ? 'Loading this chat. You can write while it loads.' : 'Write a message to start a new chat.'
          : selectedSession.historyState === 'legacy-read-only' ? 'This older conversation is read only. Start a new chat to continue.'
            : selectedSession.historyState === 'invalid' ? 'Saved conversation history is invalid. Start a new chat.'
            : selectedSession.modelUseBlocked ? 'Model access was revoked for this chat. Start a new chat to continue.'
            : selectedSession.availability === 'archived' ? 'This chat is pending deletion. Retry Delete to finish removing it.'
            : selectedSession.availability === 'unusable' ? 'This chat cannot continue safely. Start a new chat.'
              : selectedSession.availability === 'busy' ? 'This chat is responding.'
                : !modelReady ? 'Save a model and its API key to start a chat.'
                  : goalMode === 'save-candidate' && (!workspace?.documentRef || !workspace.jobId) ? 'Process an invoice first to generate a result.' : ''}
      />
    </div>
  );
}

function ChatsPage({ sessions, selectedSessionId, hasMore, mutating, notice, onSelect, onRename, onDelete, onLoadMore,
  workingDirectory, onChooseDirectory, onClearDirectory, nativeTools, nativeToolsError, onRefreshTools, runDirectory, ready }: {
  sessions: readonly SessionSnapshot[];
  selectedSessionId: number | null;
  hasMore: boolean;
  mutating: boolean;
  notice: Notice;
  onSelect(sessionId: number): void;
  onRename(sessionId: number, title: string): Promise<boolean>;
  onDelete(sessionId: number): Promise<void>;
  onLoadMore(): void;
  workingDirectory: string;
  onChooseDirectory(): void;
  onClearDirectory(): void;
  nativeTools: readonly NativeToolAvailability[];
  nativeToolsError: string | null;
  onRefreshTools(): void;
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
    <section className="panel run-tools-panel" aria-label="Run tools">
      <div className="panel-head"><h2>Run tools</h2><button className="quiet-button" type="button" disabled={!ready} onClick={onRefreshTools}>Refresh tools</button></div>
      <div className="form-grid">
        <label className="field full"><span>Working directory</span><input value={workingDirectory} readOnly placeholder="Automatic · current Run directory" /></label>
        <button className="secondary-button" type="button" disabled={!ready} onClick={onChooseDirectory}>Choose directory</button>
        <button className="quiet-button" type="button" disabled={!workingDirectory} onClick={onClearDirectory}>Use Run directory</button>
        <p className="full">Optional for your next Run. Changing this directory does not affect an active request. Send a message in Assistant to run; choosing a directory and refreshing tools do not execute anything.</p>
        {runDirectory && <p className="full">Run {runDirectory.runId} working directory: <code>{runDirectory.directory}</code></p>}
        <p className="full">The working directory resolves relative paths. SDK tools use your operating system account; it is not a sandbox or file access permission.</p>
        <div className="field full native-tool-availability" aria-label="Native tool availability"><span>Tools on this device</span>
          {nativeToolsError ? <p role="alert">{nativeToolsError}</p> : nativeTools.length === 0 ? <p>Checking tools…</p>
            : <ul>{nativeTools.map((tool) => <li key={tool.name}><strong>{tool.name}</strong>: {tool.available ? 'Available' : tool.reason ?? 'Unavailable'}</li>)}</ul>}
        </div>
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
          <small>{session.historyState === 'legacy-read-only' ? 'Read only' : session.historyState === 'invalid' ? 'History unavailable'
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
          <button type="button" onClick={() => { setRenamingId(session.sessionId); setRenameTitle(session.title); }}
            disabled={mutating || session.status === 'archived'}>Rename</button>
          <button type="button" disabled={mutating || session.availability === 'busy'}
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

function WorkspacePage(props: {
  workspace: WorkspaceSnapshot | null;
  documents: readonly DocumentSnapshot[];
  candidates: readonly CandidateSummary[];
  candidateDetail: CandidateJobDetail | null;
  formControls: ReactNode;
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
  const selectedDocument = documents.find((item) => item.documentRef.id === workspace?.documentRef?.id) ?? null;
  return <section className="page-content invoice-page">
    <div className="page-heading">
      <div><h1>Invoices</h1><p>Review the original, parsed details and saved results in one place.</p></div>
      <div className="invoice-heading-actions"><select className="context-select" aria-label="Choose invoice" value={selectedDocument?.documentRef.id ?? ''} onChange={(event) => props.onSelectDocument(Number(event.target.value))}><option value="" disabled>Choose invoice</option>{documents.map((item) => <option key={item.documentRef.id} value={item.documentRef.id}>{item.displayName}</option>)}</select>{selectedDocument && <button className="text-button danger-text invoice-heading-delete" disabled={props.hidingDocumentId !== null} onClick={() => props.onHideDocument(selectedDocument.documentRef.id)}>Delete</button>}<button className="secondary-button" onClick={props.onImport}>＋ Import invoice</button></div>
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

    {workspace?.documentRef && <section className="panel config-panel invoice-sheet">
      <div className="panel-head"><div><h2>{selectedDocument?.displayName ?? 'Invoice'}</h2><p className="invoice-subtitle">{selectedDocument?.pageCount ?? 1} {selectedDocument?.pageCount === 1 ? 'page' : 'pages'} · Imported {selectedDocument ? new Date(selectedDocument.createdAt).toLocaleDateString() : 'recently'}</p></div>
        <details className="invoice-access"><summary>Material access</summary><button className="danger-action" disabled={revokingAccess} onClick={props.onRevokeModelAccess}>{revokingAccess ? 'Revoking…' : 'Revoke model access'}</button></details>
      </div>
      <div className="button-row invoice-tabs" role="tablist" aria-label="Invoice view">
        <button className={workspace.activeView === 'original' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('original')}>Original</button>
        <button className={workspace.activeView === 'parsed' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('parsed')}>Parsed</button>
        <button className={workspace.activeView === 'candidate' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('candidate')}>Results</button>
      </div>
      {workspace.activeView === 'original' && (originalImage
        ? <figure><img style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }} src={`data:${originalImage.mimeType};base64,${originalImage.base64}`} alt={`Original invoice document page 1`} /><figcaption>Original page shown for user review.</figcaption></figure>
        : <p className="config-note">Original page is unavailable. The selected document may be missing its source asset.</p>)}
      {workspace.activeView === 'parsed' && (parsedPage
        ? <div className="model-list parsed-list">{parsedPage.blocks.map((block) => <article className="route-row" key={block.id}>
          <span className="route-icon">{block.kind === 'table' ? '▤' : block.kind === 'image' ? '▧' : '¶'}</span>
          <span className="route-name"><strong>{block.kind === 'table' ? 'Table' : block.kind === 'image' ? 'Image note' : 'Text'} · Page {block.source.page}</strong><small>{block.text || '(no extracted text)'}</small></span>
        </article>)}</div>
        : <p className="config-note">Parsed page could not be loaded.</p>)}
      {workspace.activeView === 'candidate' && <div className="invoice-results">{candidates.length === 0
        ? <div className="empty-route"><strong>No results yet</strong><span>Choose Process this invoice, then send the request in Assistant.</span></div>
        : <div className="model-list">{candidates.map((item) => <button className="route-row" key={item.candidateId} onClick={() => workspace.jobId && props.onOpenCandidate(workspace.jobId, item.candidateId)}><span className="route-icon">✓</span><span className="route-name"><strong>Result {item.sequence}</strong><small>{item.issueCount ? `${item.issueCount} issues to review` : 'No issues found'} · {new Date(item.createdAt).toLocaleDateString()}</small></span></button>)}</div>}
        {candidateDetail && <><CandidateDetails detail={candidateDetail} />
          {workspace.jobId && <button className="secondary-button" disabled={workspace.candidateRef?.id === candidateDetail.candidate.candidateId}
            onClick={() => props.onSelectCandidate(workspace.jobId!, candidateDetail.candidate.candidateId)}>Select result</button>}
          </>}{props.formControls}</div>}
    </section>}

    <section className="panel invoice-process">
      <div className="panel-head"><div><h2>Process this invoice</h2><p className="invoice-subtitle">Prepare a result from the parsed content. The model starts only when you press Send.</p></div></div>
      <details><summary>Additional requirements</summary><label className="field full"><span>What else should the assistant consider?</span><textarea value={taskGoal} onChange={(event) => props.onTaskGoalChange(event.target.value)} maxLength={3500} rows={3} placeholder="Optional instructions for this invoice" /></label></details>
      <div className="config-actions"><span className="action-spacer" /><button className="primary-button" disabled={!workspace?.documentRef} onClick={props.onStartTask}>Process this invoice</button></div>
    </section>
    <footer className="page-footer"><span>The original is for your review. Assistant uses registered parsed content and source references.</span></footer>
  </section>;
}

function TasksPage(props: {
  workspace: WorkspaceSnapshot | null;
  documents: readonly DocumentSnapshot[];
  historicalDocuments: Readonly<Record<number, DocumentSnapshot>>;
  jobs: readonly JobSnapshot[];
  selectedJobId: number | null;
  candidates: readonly CandidateSummary[];
  candidateDetail: CandidateJobDetail | null;
  activity: readonly BusinessEventSnapshot[];
  notice: Notice;
  onOpenJob(jobId: number): void;
  onHideJob(jobId: number): void;
  onOpenCandidate(jobId: number, candidateId: number): void;
  onSelectCandidate(jobId: number, candidateId: number): void;
}) {
  const { workspace, jobs, candidates, candidateDetail, activity } = props;
  const job = jobs.find((item) => item.jobId === props.selectedJobId) ?? null;
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
      {candidateDetail && <section className="panel profile-panel"><div className="panel-head"><h2>Result details</h2></div><CandidateDetails detail={candidateDetail} /></section>}
      <section className="panel profile-panel"><div className="panel-head"><h2>Activity</h2></div>
        {activity.length === 0 ? <p className="config-note">No actions recorded yet.</p> : <ol>{activity.map((event) => <li key={event.id}><strong>{activityLabel(event.type)}</strong> · {event.result} · {event.safeSummary} · {new Date(event.occurredAt).toLocaleString()}</li>)}</ol>}
      </section>
    </>}
  </section>;
}

function activityLabel(type: BusinessEventSnapshot['type']): string {
  return ({ document_imported: 'Invoice imported', task_started: 'Processing started',
    candidate_generated: 'Result prepared', candidate_selected: 'Result selected', candidate_edited: 'Result edited',
    candidate_accepted: 'Result accepted', candidate_rejected: 'Result rejected', candidate_exported: 'Result exported' })[type];
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
  onChange(value: InvoiceFormDraft): void; onDiscard(): void; onQuery(): void;
  onSave(): void; onAccept(): void; onReject(): void;
}) {
  return <section className="panel" aria-label="Invoice form"><div className="panel-head"><h2>Invoice form</h2>
    <span>{state.dirty ? 'Unsaved changes' : 'Local draft'} · Revision {state.revision}</span></div>
    {feedback && <p role="status">{feedback}</p>}
    {!state.valid && <p role="alert">This form target is no longer valid. Your local draft is retained.</p>}
    {state.warnings.length > 0 && <ul>{state.warnings.map(warning => <li key={warning.path}>{warning.path}: {warning.reason.replaceAll('_', ' ')}</li>)}</ul>}
    <div className="profile-fields">{invoiceHeaderFields.map(name => <label className="field" key={name}><span>{invoiceFieldLabels[name]}</span>
      <input aria-label={invoiceFieldLabels[name]} value={state.draft.fields[name]} maxLength={1024} disabled={disabled}
        onChange={event => onChange({ ...state.draft, fields: { ...state.draft.fields, [name]: event.target.value } })} /></label>)}</div>
    <h3>Line items</h3>{state.draft.lines.map((line, index) => <fieldset key={index} disabled={disabled}><legend>Line {index + 1}</legend>
      <div className="profile-fields">{invoiceLineFields.map(name => <label className="field" key={name}><span>{invoiceFieldLabels[name]}</span>
        <input aria-label={`Line ${index + 1} ${invoiceFieldLabels[name]}`} value={line[name]} maxLength={1024}
          onChange={event => onChange({ ...state.draft, lines: state.draft.lines.map((value, position) => position === index ? { ...value, [name]: event.target.value } : value) })} /></label>)}</div>
      <button className="text-button" onClick={() => onChange({ ...state.draft, lines: state.draft.lines.filter((_, position) => position !== index) })}>Remove line {index + 1}</button>
    </fieldset>)}
    <button className="text-button" disabled={disabled || state.draft.lines.length >= 200} onClick={() => onChange({ ...state.draft,
      lines: [...state.draft.lines, Object.fromEntries(invoiceLineFields.map(name => [name, ''])) as InvoiceFormDraft['lines'][number]] })}>Add line</button>
    <h3>Notes</h3>{state.draft.notes.map((note, index) => <label className="field" key={index}><span>Note {index + 1}</span>
      <input value={note} maxLength={1024} disabled={disabled} onChange={event => onChange({ ...state.draft, notes: state.draft.notes.map((value, position) => position === index ? event.target.value : value) })} />
      <button className="text-button" disabled={disabled} onClick={() => onChange({ ...state.draft, notes: state.draft.notes.filter((_, position) => position !== index) })}>Remove note {index + 1}</button></label>)}
    <button className="text-button" disabled={disabled || state.draft.notes.length >= 20} onClick={() => onChange({ ...state.draft, notes: [...state.draft.notes, ''] })}>Add note</button>
    <div className="button-row"><button className="secondary-button" onClick={onQuery} disabled={!canQuery}>Check Fill status</button>
      <button className="secondary-button" onClick={onSave} disabled={disabled || operationUnknown}>Save result</button>
      <button className="secondary-button" onClick={onAccept} disabled={disabled || state.dirty || operationUnknown}>Accept result</button>
      <button className="secondary-button" onClick={onReject} disabled={disabled || state.dirty || operationUnknown}>Reject result</button>
      <button className="danger-action" onClick={onDiscard} disabled={!canDiscard}>Discard changes</button></div>
  </section>;
}

function CandidateDetails({ detail }: { detail: CandidateJobDetail }) {
  const candidate = detail.candidate;
  return <div className="candidate-details">
    <div className="profile-fields">{Object.entries(candidate.fields).map(([name, field]) => <div key={name}><strong>{name.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())}</strong><p>{field.normalized ?? field.raw ?? '—'}</p><small>{field.state.replaceAll('_', ' ')}</small></div>)}</div>
    {candidate.lines.length > 0 && <><h3>Line items</h3><ul>{candidate.lines.map((line, index) => <li key={index}>{line.description.raw ?? 'Unnamed item'} · {line.quantity.normalized ?? line.quantity.raw ?? '—'} × {line.unitPrice.normalized ?? line.unitPrice.raw ?? '—'} = {line.totalAmount.normalized ?? line.totalAmount.raw ?? '—'}</li>)}</ul></>}
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
  collapsed,
  onToggle,
  selectedSessionId,
  selectedSession,
  hasOlderRuns,
  onNewChatAndSend,
  onLoadOlderRuns,
  turns,
  messages,
  unconfirmedCount,
  historyLoading,
  historyError,
  runFeedbacks,
  onRefreshHistory,
  transcriptRef,
  input,
  composerRef,
  onInputChange,
  onSend,
  onCancel,
  enabled,
  busy,
  cancelPending,
  activeAgentRunId,
  activeAgentSessionId,
  activeRunModel,
  selectedModelId,
  modelName,
  modelId,
  contextName,
  goalMode,
  canGenerate,
  onGoalModeChange,
  sessionHint,
}: {
  collapsed: boolean;
  onToggle(): void;
  selectedSessionId: number | null;
  selectedSession: SessionSnapshot | null;
  hasOlderRuns: boolean;
  onNewChatAndSend(): void;
  onLoadOlderRuns(): void;
  turns: readonly ChatTurn[];
  messages: readonly SessionMessageView[];
  unconfirmedCount: number;
  historyLoading: boolean;
  historyError: string | null;
  runFeedbacks: readonly RunFeedback[];
  onRefreshHistory(): void;
  transcriptRef: RefObject<HTMLDivElement | null>;
  input: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange(value: string): void;
  onSend(): void;
  onCancel(): void;
  enabled: boolean;
  busy: boolean;
  cancelPending: boolean;
  activeAgentRunId: number | null;
  activeAgentSessionId: number | null;
  activeRunModel: { id: string; name: string; model: string } | null;
  selectedModelId: string | null;
  modelName: string | null;
  modelId: string | null;
  contextName: string | null;
  goalMode: 'answer' | 'save-candidate';
  canGenerate: boolean;
  onGoalModeChange(value: 'answer' | 'save-candidate'): void;
  sessionHint: string;
}) {
  if (collapsed) {
    return <aside className="agent-chat-panel collapsed" data-testid="agent-chat-panel">
      <button className="chat-expand" type="button" onClick={onToggle} aria-label="Open Assistant" aria-expanded={false} title="Open Assistant"><span aria-hidden="true">‹</span><b>Assistant</b></button>
    </aside>;
  }
  return <aside className="agent-chat-panel" data-testid="agent-chat-panel" aria-label="Assistant" onKeyDown={(event) => { if (event.key === 'Escape' && window.innerWidth < 1080) onToggle(); }}>
    <header className="chat-panel-head">
      <div><h2>Assistant</h2><span className="chat-current-title">{selectedSession ? chatTitle(selectedSession.title) : 'New conversation'}</span></div>
      <button className="chat-collapse" type="button" onClick={onToggle} aria-label="Close Assistant" aria-expanded={true} title="Close Assistant">›</button>
    </header>
    <div className="chat-model-row"><span className={`status-dot ${modelName ? 'is-ready' : 'is-error'}`} /><div><strong>{modelName ?? 'Set up a model in Settings'}</strong></div></div>
    {selectedSession && <div className="chat-session-state"><span className={`status-dot ${selectedSession.availability === 'ready' ? 'is-ready' : selectedSession.availability === 'busy' ? 'is-warning' : 'is-error'}`} />
      <span>{selectedSession.historyState === 'legacy-read-only' ? 'Read only · older conversation' : selectedSession.historyState === 'invalid' ? 'History cannot be restored' : selectedSession.availability === 'ready' ? 'Ready' : selectedSession.availability === 'busy' ? 'Responding' : selectedSession.availability === 'unusable' ? 'Cannot continue' : 'Unavailable'}</span>
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
      {messages.length === 0 && turns.length === 0 && !historyLoading && <div className="chat-empty"><span className="chat-empty-mark">↗</span><strong>How can I help?</strong><p>Ask about this invoice, or start a general conversation.</p></div>}
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
      {runFeedbacks.map((item) => <p className={item.status === 'failed' ? 'chat-error' : 'chat-save-feedback'} key={item.runId}>
        {item.status === 'cancelled' ? 'Request cancelled.' : item.error ?? 'The request failed.'}</p>)}
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      <div className="chat-context">{contextName ? `Working with ${contextName}` : 'General conversation'}</div>
      {sessionHint && <p className="chat-config-hint">{sessionHint}</p>}
      {(selectedSession?.historyState === 'legacy-read-only' || selectedSession?.historyState === 'invalid') && input.trim() && <button className="secondary-button" type="button" onClick={onNewChatAndSend}>New chat and send</button>}
      {canGenerate && <button className={`generate-toggle ${goalMode === 'save-candidate' ? 'selected' : ''}`} type="button" aria-pressed={goalMode === 'save-candidate'} onClick={() => onGoalModeChange(goalMode === 'save-candidate' ? 'answer' : 'save-candidate')}>Generate result {goalMode === 'save-candidate' ? 'for next message' : ''}</button>}
      <label className="sr-only" htmlFor="agent-chat-input">Message to model</label>
      <textarea ref={composerRef} id="agent-chat-input" aria-label="Message to model" value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} placeholder="Write a message…" rows={3} />
      <div className="chat-composer-foot"><span>Enter to send · Shift+Enter for a new line</span>
        {busy ? <button className="secondary-button cancel-button" type="button" onClick={onCancel} disabled={cancelPending}>{cancelPending ? 'Stopping…' : 'Stop'}</button>
          : <button className="primary-button" type="submit" disabled={!enabled || !input.trim()}>Send <span aria-hidden="true">↗</span></button>}
      </div>
    </form>
  </aside>;
}
