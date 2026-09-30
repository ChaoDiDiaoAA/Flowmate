import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AgentRunEvent, AgentRunSnapshot, BusinessEventSnapshot, CandidateJobDetail, CandidateSummary, DesktopEvent, DesktopState, DocumentOriginalImage, DocumentSnapshot, InvoiceToolOutput, JobSnapshot, ModelCatalogProvider, ModelProfile, ProductSettings, RunSnapshot, SessionCursor, SessionSnapshot, WorkspaceChange, WorkspaceSnapshot } from '@flowmate/contracts';

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

export function App() {
  const [page, setPage] = useState<Page>('workspace');
  const [state, setState] = useState<DesktopState | null>(null);
  const [draft, setDraft] = useState<ModelProfile>(blankModel);
  const [catalog, setCatalog] = useState<readonly ModelCatalogProvider[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ displayName: 'Local user', theme: 'system' });
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
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
  const activeAgentRunIdRef = useRef<number | null>(null);
  const agentStopRequested = useRef(false);
  const selectedSessionIdRef = useRef<number | null>(null);
  const workspaceRef = useRef<WorkspaceSnapshot | null>(null);
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

  function draftKey(sessionId: number | null): string { return sessionId === null ? 'new' : String(sessionId); }

  function updateChatInput(value: string) {
    chatInputRef.current = value;
    chatDrafts.current.set(draftKey(selectedSessionIdRef.current), value);
    setChatInput(value);
  }

  function navigate(next: Page) {
    setPage(next);
    setNavOpen(false);
    const selectedJobId = historyJobId ?? workspace?.jobId;
    if (next === 'tasks' && selectedJobId) void loadTaskDetails(selectedJobId);
  }

  function openChat(sessionId: number) {
    selectSession(sessionId, true);
    setNavOpen(false);
    if (window.innerWidth < 1080) setChatCollapsed(false);
  }

  async function loadSessionList(append = false) {
    const before = append ? sessionCursorRef.current : null;
    const result = await window.flowmate.listSessions({ limit: 100, ...(before ? { before } : {}) });
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    sessionCursorRef.current = result.data.next;
    setSessionCursor(result.data.next);
    setSessions((current) => append ? [...current, ...result.data.items] : result.data.items);
    if (allowInitialSessionSelection.current && selectedSessionIdRef.current === null
      && !chatDrafts.current.get('new') && result.data.items[0]) {
      selectSession(result.data.items[0].sessionId);
    }
  }

  function acceptWorkspace(snapshot: WorkspaceSnapshot) {
    const previous = workspaceRef.current;
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
    let current = workspaceRef.current;
    if (!current) current = await loadWorkspace();
    if (!current) return null;
    const result = await window.flowmate.updateWorkspace({ expectedRevision: current.revision, change });
    if (!result.ok) {
      setNotice({ tone: 'bad', message: errorMessage(result) });
      if (result.error.code === 'state_conflict') void loadWorkspace();
      return null;
    }
    acceptWorkspace(result.data);
    return result.data;
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
    const result = await window.flowmate.queryJobCandidate({ jobId, candidateId });
    if (result.ok) setCandidateDetail(result.data);
    else setNotice({ tone: 'bad', message: errorMessage(result) });
  }

  async function selectCandidate(jobId: number, candidateId: number) {
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
      const current = await window.flowmate.querySession(selectedSessionIdRef.current);
      if (current.ok) setSelectedSession(current.data);
    }
    const updated = await window.flowmate.queryDocument(documentId);
    if (updated.ok) setHistoricalDocuments((current) => ({ ...current, [documentId]: updated.data }));
    setNotice({ tone: 'good', message: `Invoice removed from All invoices. ${result.data.affectedChatCount} related ${result.data.affectedChatCount === 1 ? 'chat cannot' : 'chats cannot'} use it for new messages.` });
  }

  async function loadSession(sessionId: number) {
    const sequence = ++sessionLoadSequence.current;
    const [sessionResult, runsResult] = await Promise.all([
      window.flowmate.querySession(sessionId),
      window.flowmate.listSessionRuns({ sessionId, limit: 100 }),
    ]);
    if (sequence !== sessionLoadSequence.current || selectedSessionIdRef.current !== sessionId) return;
    if (!sessionResult.ok) { setNotice({ tone: 'bad', message: errorMessage(sessionResult) }); return; }
    if (!runsResult.ok) { setNotice({ tone: 'bad', message: errorMessage(runsResult) }); return; }
    setSelectedSession(sessionResult.data);
    setRunCursor(runsResult.data.nextBeforeRunId);
    setChatTurns(runsResult.data.items.slice().reverse().map(turnFromRun));
  }

  function selectSession(sessionId: number, focusComposer = false) {
    chatDrafts.current.set(draftKey(selectedSessionIdRef.current), chatInputRef.current);
    focusComposerWhenReady.current = focusComposer;
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    chatInputRef.current = chatDrafts.current.get(draftKey(sessionId)) ?? '';
    setChatInput(chatInputRef.current);
    setSelectedSession(null);
    setRunCursor(null);
    setChatTurns([]);
    setNotice(null);
    if (workspaceRef.current?.sessionId !== sessionId) void changeWorkspace({ kind: 'session', sessionId });
    void loadSession(sessionId);
  }

  async function createNewSession(preserveDraft = false): Promise<SessionSnapshot | null> {
    if (!state?.ready || sessionLoading || sessionMutating) return null;
    const priorDraft = chatInputRef.current;
    chatDrafts.current.set(draftKey(selectedSessionIdRef.current), priorDraft);
    allowInitialSessionSelection.current = false;
    if (!preserveDraft) { chatInputRef.current = ''; setChatInput(''); }
    focusComposerWhenReady.current = true;
    setSessionLoading(true);
    chatComposerRef.current?.focus();
    const created = await window.flowmate.createSession();
    setSessionLoading(false);
    if (!created.ok) { setNotice({ tone: 'bad', message: errorMessage(created) }); return null; }
    const session = created.data;
    chatInputRef.current = preserveDraft ? priorDraft : '';
    chatDrafts.current.set(draftKey(session.sessionId), chatInputRef.current);
    setChatInput(chatInputRef.current);
    selectedSessionIdRef.current = session.sessionId;
    setSelectedSessionId(session.sessionId);
    setSelectedSession(session);
    setChatTurns([]);
    setRunCursor(null);
    setNotice(null);
    setSessions((current) => [session, ...current.filter((item) => item.sessionId !== session.sessionId)]);
    if (workspaceRef.current?.sessionId !== session.sessionId) await changeWorkspace({ kind: 'session', sessionId: session.sessionId });
    void loadSessionList();
    return session;
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
        const current = await window.flowmate.querySession(selectedSessionIdRef.current);
        if (current.ok) setSelectedSession(current.data);
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
    const next = wasSelected ? remaining.find((item) => item.status === 'active') ?? null : null;
    if (wasSelected) {
      sessionLoadSequence.current += 1;
      allowInitialSessionSelection.current = false;
      selectedSessionIdRef.current = next?.sessionId ?? null;
      setSelectedSessionId(next?.sessionId ?? null);
      setSelectedSession(null);
      updateChatInput(chatDrafts.current.get(draftKey(next?.sessionId ?? null)) ?? '');
      setChatTurns([]);
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
    const beforeRunId = runCursor;
    if (sessionId === null || beforeRunId === null) return;
    const result = await window.flowmate.listSessionRuns({ sessionId, beforeRunId, limit: 100 });
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    setRunCursor(result.data.nextBeforeRunId);
    setChatTurns((current) => [...result.data.items.slice().reverse().map(turnFromRun), ...current]);
  }

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const result = await window.flowmate.getState();
      if (alive && result.ok) setState(result.data);
      else if (alive) setNotice({ tone: 'bad', message: errorMessage(result) });
    };
    void refresh();
    const unsubscribe = window.flowmate.subscribe((event) => {
      if (!alive) return;
      if (event.type === 'host_state') {
        setState(event.state);
        return;
      }
      if (event.type === 'model_auth_notice' || event.type === 'model_auth_prompt') return;
      if ('runId' in event && 'sequence' in event) {
        if (event.sequence <= (eventSequences.current.get(event.runId) ?? 0)) return;
        if (latestAgentFinished.current.has(event.runId) && event.type !== 'run_finished') return;
        eventSequences.current.set(event.runId, event.sequence);
      }
      if (event.type === 'run_progress') {
        if (activeChatSessionId.current !== null && event.sessionId !== activeChatSessionId.current) return;
        if (activeAgentRunIdRef.current !== null && event.runId !== activeAgentRunIdRef.current) return;
        activeAgentRunIdRef.current = event.runId;
        activeChatSessionId.current = event.sessionId;
        setActiveAgentRunId(event.runId);
        setActiveAgentSessionId(event.sessionId);
        setBusy(true);
        if (event.phase === 'created' && selectedSessionIdRef.current === event.sessionId) {
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
      if (event.type === 'text_delta' || event.type === 'tool_progress') {
        if (event.runId !== activeAgentRunIdRef.current || event.sessionId !== activeChatSessionId.current
          || event.sessionId !== selectedSessionIdRef.current) return;
        const turnId = activeChatTurnId.current;
        if (!turnId) return;
        setChatTurns((turns) => turns.map((turn) => turn.id !== turnId || turn.status !== 'sending' ? turn
          : event.type === 'text_delta'
            ? { ...turn, response: `${turn.response ?? ''}${event.text}` }
            : { ...turn, progress: event.phase === 'running' ? event.label : null }));
        return;
      }
      if (event.type === 'run_finished') {
        latestAgentFinished.current.set(event.runId, event);
        if (selectedSessionIdRef.current === event.sessionId) {
          setRunId(event.runId);
          const turnId = activeChatTurnId.current;
          if (turnId) applyAgentFinish(event, turnId);
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
        }
        return;
      }
      if (event.type === 'provider_finished') {
        latestFinished.current = event;
        setRunId(event.runId);
        setBusy(false);
        setCancelPending(false);
        if (activeRequestIdRef.current === event.requestId) {
          activeRequestIdRef.current = null;
          setActiveRequestId(null);
        }
        void loadRun(event.runId);
      }
    });
    return () => { alive = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (state?.ready) {
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
  }, [chatTurns]);

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
  const canTest = Boolean(modelReady && !busy && !saving);
  const inputEnabled = true;
  const selectedForSend = selectedSession ?? sessions.find((item) => item.sessionId === selectedSessionId) ?? null;
  const canChat = Boolean(modelReady && !busy && !sessionLoading && !sessionMutating
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
      const selected = await window.flowmate.querySession(selectedSessionIdRef.current);
      if (selected.ok) setSelectedSession(selected.data);
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
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok) setState(refreshed.data);
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
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok) setState(refreshed.data);
    setNotice({ tone: 'good', message: 'Configuration saved. New runs will use this model profile.' });
  }

  async function saveProfile() {
    if (!state) return;
    setSaving(true);
    const result = await window.flowmate.saveSettings({ ...state.settings, profile: profileDraft });
    setSaving(false);
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    const refreshed = await window.flowmate.getState();
    if (refreshed.ok) setState(refreshed.data);
    setNotice({ tone: 'good', message: 'Profile preferences saved.' });
  }

  async function testConnection() {
    if (!canTest || !selectedModelId) return;
    setBusy(true);
    setCancelPending(false);
    setRun(null);
    setRunId(null);
    setNotice({ tone: 'info', message: 'Sending a real Provider request. The request may incur usage charges.' });
    const accepted = await window.flowmate.callProvider({ goal: 'Verify this model connection.', text: 'Reply with OK.', modelId: selectedModelId });
    if (!accepted.ok) {
      setBusy(false);
      setNotice({ tone: 'bad', message: errorMessage(accepted) });
      return;
    }
    activeRequestIdRef.current = accepted.data.requestId;
    setActiveRequestId(accepted.data.requestId);
    setRunId(accepted.data.runId);
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
    const model = persistedModel;
    if ((!canChat && !override) || !modelReady || busy || !selectedModelId || !model || !prompt) return;
    setBusy(true);
    setNotice({ tone: 'info', message: 'Preparing your request…' });
    let sessionId = override?.sessionId ?? selectedSessionIdRef.current;
    if (sessionId === null) {
      const created = await createNewSession(true);
      if (!created) { setBusy(false); return; }
      sessionId = created.sessionId;
    }
    let current = workspaceRef.current ?? await loadWorkspace();
    if (current?.documentRef && current.sessionId !== sessionId) current = await changeWorkspace({ kind: 'session', sessionId });
    if (workspaceRef.current?.documentRef && !current) { setBusy(false); return; }
    const turnId = newId();
    const newTurn: ChatTurn = { id: turnId, sessionId, runId: null, prompt, response: null, error: null, status: 'sending' };
    activeChatTurnId.current = turnId;
    activeChatSessionId.current = sessionId;
    activeAgentRunIdRef.current = null;
    agentStopRequested.current = false;
    setActiveRunModel({ id: model.id, name: model.name, model: model.model });
    chatDrafts.current.set(draftKey(sessionId), '');
    if (selectedSessionIdRef.current === sessionId) updateChatInput('');
    setChatTurns((turns) => [...turns, newTurn]);
    setBusy(true);
    setCancelPending(false);
    setNotice(null);
    const accepted = await window.flowmate.startRun({
      sessionId,
      text: prompt,
      modelId: model.id,
      ...(current?.documentRef ? { workspace: {
        revision: current.revision,
        documentRef: current.documentRef,
        jobId: current.jobId,
        candidateRef: current.candidateRef,
        sessionId,
      } } : {}),
      goalMode,
      ...(goalMode === 'save-candidate' ? { timeoutMs: 120_000 } : {}),
    });
    if (!accepted.ok) {
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
    setChatTurns((turns) => turns.map((turn) => turn.id === turnId
      ? { ...turn, runId: accepted.data.runId }
      : turn));
    if (finished) {
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

  async function newChatAndSend() {
    const prompt = chatInputRef.current.trim();
    if (!prompt) return;
    const created = await createNewSession(true);
    if (!created) return;
    await sendChatMessage({ sessionId: created.sessionId, prompt });
  }

  function applyAgentFinish(event: Extract<AgentRunEvent, { type: 'run_finished' }>, turnId: string) {
    if (!event.result.ok) {
      setChatTurns((turns) => turns.map((turn) => turn.id === turnId
        ? { ...turn, runId: event.runId, status: 'failed', error: errorMessage(event.result) }
        : turn));
      return;
    }
    const outcome = event.result.data;
    setChatTurns((turns) => turns.map((turn) => turn.id === turnId
      ? {
        ...turn,
        runId: event.runId,
        response: outcome.text || null,
        progress: null,
        error: outcome.error ? errorMessage({ error: outcome.error }) : null,
        status: outcome.status === 'completed' ? 'completed' : outcome.status === 'cancelled' ? 'cancelled' : 'failed',
      }
      : turn));
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
    setState({ ...state, settings: saved.data });
    setRun(null);
    setNotice({ tone: 'good', message: 'Model profile removed.' });
  }

  return (
    <div className={`desktop-shell theme-${profileDraft.theme} ${chatCollapsed ? 'chat-is-collapsed' : ''} ${navOpen ? 'nav-is-open' : ''}`}>
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
                <p>Selected model: {persistedModel ? credentialStatus === 'configured' ? 'Ready to connect' : 'Credential needs attention' : 'No model selected'}</p></div>
            </details>}
          </section>
        )}
      </main>
      <AgentChatPanel
        collapsed={chatCollapsed}
        onToggle={() => { assistantWasToggled.current = true; setChatCollapsed((collapsed) => !collapsed); }}
        selectedSessionId={selectedSessionId}
        selectedSession={selectedSession}
        hasOlderRuns={runCursor !== null}
        onNewChatAndSend={() => void newChatAndSend()}
        onLoadOlderRuns={() => void loadOlderRuns()}
        turns={chatTurns}
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
        sessionHint={!selectedSession ? selectedSessionId !== null ? 'Loading this chat. You can write while it loads.' : 'Write a message to start a new chat.'
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

function ChatsPage({ sessions, selectedSessionId, hasMore, mutating, notice, onSelect, onRename, onDelete, onLoadMore }: {
  sessions: readonly SessionSnapshot[];
  selectedSessionId: number | null;
  hasMore: boolean;
  mutating: boolean;
  notice: Notice;
  onSelect(sessionId: number): void;
  onRename(sessionId: number, title: string): Promise<boolean>;
  onDelete(sessionId: number): Promise<void>;
  onLoadMore(): void;
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
    <section className="panel chat-directory">
      <div className="panel-head"><h2>Conversations</h2><span>{sessions.length} loaded</span></div>
      {sessions.length === 0 && <div className="empty-route"><strong>No chats yet</strong><span>Use New chat in the sidebar to start one.</span></div>}
      {sessions.map((session) => <div className={`chat-directory-row ${session.sessionId === selectedSessionId ? 'selected' : ''}`}
        data-session-id={session.sessionId} key={session.sessionId}>
        <button className="chat-directory-open" type="button" onClick={() => onSelect(session.sessionId)}
          aria-current={session.sessionId === selectedSessionId ? 'true' : undefined}>
          <strong>{chatTitle(session.title)}</strong>
          <small>{session.historyState === 'legacy-read-only' ? 'Read only' : session.historyState === 'invalid' ? 'History unavailable'
            : session.modelUseBlocked ? 'Access revoked' : session.availability === 'busy' ? 'Responding' : 'Ready'}
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
        {candidateDetail && <CandidateDetails detail={candidateDetail} />}</div>}
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
    candidate_generated: 'Result prepared', candidate_selected: 'Result selected' })[type];
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
      {hasOlderRuns && <button type="button" className="chat-more-runs" onClick={onLoadOlderRuns}>Earlier messages</button>}
      {turns.length === 0 && <div className="chat-empty"><span className="chat-empty-mark">↗</span><strong>How can I help?</strong><p>Ask about this invoice, or start a general conversation.</p></div>}
      {turns.map((turn) => <article className="chat-turn" data-testid="chat-turn" key={turn.id}>
        <div className="chat-user-message"><span className="chat-speaker">YOU</span><p>{turn.prompt}</p></div>
        <div className={`chat-assistant-message ${turn.status}`}>
          <span className="chat-speaker">ASSISTANT</span>
          {turn.response && <p>{turn.response}</p>}
          {turn.status === 'sending' && <div className="chat-pending"><span className="loader-ring" />{turn.progress ?? 'Responding…'}</div>}
          {turn.status !== 'sending' && !turn.response && <p>{turn.status === 'cancelled' ? 'Request cancelled.' : 'No response was returned.'}</p>}
          {turn.error && <p className="chat-error">{turn.error}</p>}
        </div>
      </article>)}
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
