import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AgentRunEvent, AgentRunSnapshot, BusinessEventSnapshot, CandidateJobDetail, CandidateSummary, DesktopEvent, DesktopState, DocumentOriginalImage, DocumentSnapshot, InvoiceToolOutput, JobSnapshot, ModelProfile, ProductSettings, PromptTraceResult, RunSnapshot, SessionCursor, SessionSnapshot, WorkspaceChange, WorkspaceSnapshot } from '@flowmate/contracts';

type Page = 'workspace' | 'tasks' | 'model' | 'profile';
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
};

function newId(): string { return crypto.randomUUID().replaceAll('-', ''); }

function blankModel(): ModelProfile {
  return { id: newId(), credentialRef: newId(), name: 'Primary model', baseUrl: '', model: '', api: 'openai-responses' };
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: { message?: unknown; code?: unknown } }).error;
    if (error && typeof error.message === 'string') return error.message;
    if (error && typeof error.code === 'string') return error.code;
  }
  return 'The operation could not be completed.';
}

function stringify(value: unknown): string { return JSON.stringify(value, null, 2); }

export function App() {
  const [page, setPage] = useState<Page>('workspace');
  const [state, setState] = useState<DesktopState | null>(null);
  const [draft, setDraft] = useState<ModelProfile>(blankModel);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ displayName: 'Local user', theme: 'system' });
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [goal, setGoal] = useState('Answer the user clearly and directly.');
  const [text, setText] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionSnapshot | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [confirmedWorkspaceRevision, setConfirmedWorkspaceRevision] = useState<number | null>(null);
  const [documents, setDocuments] = useState<DocumentSnapshot[]>([]);
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [candidateSummaries, setCandidateSummaries] = useState<CandidateSummary[]>([]);
  const [candidateDetail, setCandidateDetail] = useState<CandidateJobDetail | null>(null);
  const [activity, setActivity] = useState<BusinessEventSnapshot[]>([]);
  const [parsedPage, setParsedPage] = useState<InvoiceToolOutput<'read_invoice_document'> | null>(null);
  const [originalImage, setOriginalImage] = useState<DocumentOriginalImage | null>(null);
  const [taskGoal, setTaskGoal] = useState('Prepare an invoice candidate from this document.');
  const [goalMode, setGoalMode] = useState<'answer' | 'save-candidate'>('answer');
  const [activeAgentRunId, setActiveAgentRunId] = useState<number | null>(null);
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<number | null>(null);
  const [activeRunModel, setActiveRunModel] = useState<{ id: string; name: string; model: string } | null>(null);
  const [sessionCursor, setSessionCursor] = useState<SessionCursor | null>(null);
  const [runCursor, setRunCursor] = useState<number | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionMutating, setSessionMutating] = useState(false);
  const [revokingAccess, setRevokingAccess] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [promptTrace, setPromptTrace] = useState<PromptTraceResult | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const latestFinished = useRef<Extract<DesktopEvent, { type: 'provider_finished' }> | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeChatTurnId = useRef<string | null>(null);
  const activeChatSessionId = useRef<number | null>(null);
  const activeAgentRunIdRef = useRef<number | null>(null);
  const agentStopRequested = useRef(false);
  const selectedSessionIdRef = useRef<number | null>(null);
  const workspaceRef = useRef<WorkspaceSnapshot | null>(null);
  const sessionCursorRef = useRef<SessionCursor | null>(null);
  const sessionLoadSequence = useRef(0);
  const allowInitialSessionSelection = useRef(true);
  const focusComposerWhenReady = useRef(false);
  const chatComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const latestAgentFinished = useRef(new Map<number, Extract<AgentRunEvent, { type: 'run_finished' }>>());
  const chatTranscriptRef = useRef<HTMLDivElement | null>(null);
  const revisionLoaded = useRef<number | null>(null);

  async function loadSessionList(append = false) {
    const before = append ? sessionCursorRef.current : null;
    const result = await window.flowmate.listSessions({ limit: 100, ...(before ? { before } : {}) });
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    sessionCursorRef.current = result.data.next;
    setSessionCursor(result.data.next);
    setSessions((current) => append ? [...current, ...result.data.items] : result.data.items);
    if (allowInitialSessionSelection.current && selectedSessionIdRef.current === null && result.data.items[0]) {
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
    if (previous?.revision !== snapshot.revision || previous?.sessionId !== snapshot.sessionId) setConfirmedWorkspaceRevision(null);
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
    setNotice({ tone: 'good', message: `Imported document #${result.data.documentRef.id}. Choose it as the Workspace source.` });
    await loadProductLists();
    await selectWorkspaceDocument(result.data.documentRef.id);
  }

  async function selectWorkspaceDocument(documentId: number | null) {
    const snapshot = await changeWorkspace({ kind: 'document', documentId });
    if (!snapshot || documentId === null) return;
    let doc = documents.find((item) => item.documentRef.id === documentId);
    if (!doc) {
      const queried = await window.flowmate.queryDocument(documentId);
      if (queried.ok) doc = queried.data;
    }
    if (doc) await loadDocumentMaterial(documentId);
  }

  async function startTask() {
    const current = workspaceRef.current;
    if (!current?.documentRef || !current.sessionId || !taskGoal.trim()) return;
    const result = await window.flowmate.startTask({
      clientSequence: current.nextTaskSequence,
      expectedRevision: current.revision,
      documentRef: current.documentRef,
      goal: taskGoal.trim(),
    });
    if (!result.ok) { setNotice({ tone: 'bad', message: errorMessage(result) }); return; }
    acceptWorkspace(result.data.workspace);
    setGoalMode('save-candidate');
    setNotice({ tone: 'good', message: `Task #${result.data.job.jobId} started. Confirm this Workspace before sending a Run.` });
    await loadProductLists();
    await loadTaskDetails(result.data.job.jobId);
    setPage('tasks');
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
    setNotice({ tone: 'good', message: `Candidate #${candidateId} is now the selected Workspace candidate.` });
    await loadProductLists();
    await loadTaskDetails(jobId);
  }

  async function openJob(jobId: number) {
    const snapshot = await changeWorkspace({ kind: 'job', jobId });
    if (!snapshot) return;
    setCandidateDetail(null);
    setGoalMode('save-candidate');
    await loadTaskDetails(jobId);
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
    focusComposerWhenReady.current = focusComposer && modelReady && !busy;
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setSelectedSession(null);
    setRunCursor(null);
    setChatTurns([]);
    setNotice(null);
    if (workspaceRef.current?.sessionId !== sessionId) void changeWorkspace({ kind: 'session', sessionId });
    void loadSession(sessionId);
  }

  async function createNewSession() {
    if (!state?.ready || sessionLoading || sessionMutating) return;
    setChatInput('');
    focusComposerWhenReady.current = modelReady && !busy;
    setSessionLoading(true);
    chatComposerRef.current?.focus();
    const created = await window.flowmate.createSession();
    setSessionLoading(false);
    if (!created.ok) { setNotice({ tone: 'bad', message: errorMessage(created) }); return; }
    const session = created.data;
    focusComposerWhenReady.current = modelReady && !busy;
    selectedSessionIdRef.current = session.sessionId;
    setSelectedSessionId(session.sessionId);
    setSelectedSession(session);
    setChatTurns([]);
    setRunCursor(null);
    setNotice(null);
    setSessions((current) => [session, ...current.filter((item) => item.sessionId !== session.sessionId)]);
    if (workspaceRef.current?.sessionId !== session.sessionId) await changeWorkspace({ kind: 'session', sessionId: session.sessionId });
    void loadSessionList();
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
    setNotice({ tone: 'good', message: 'Session renamed.' });
    return true;
  }

  async function deleteSession(sessionId: number): Promise<void> {
    if (sessionMutating) return;
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
    const next = remaining.find((item) => item.status === 'active') ?? null;
    setSessions(remaining);
    const nextCursor = refreshed.ok ? refreshed.data.next : null;
    setSessionCursor(nextCursor);
    sessionCursorRef.current = nextCursor;
    allowInitialSessionSelection.current = false;
    selectedSessionIdRef.current = next?.sessionId ?? null;
    setSelectedSessionId(next?.sessionId ?? null);
    setSelectedSession(null);
    setChatInput('');
    setChatTurns([]);
    setRunCursor(null);
    if (run?.kind === 'agent' && run.sessionId === sessionId) {
      setRun(null);
      setRunId(null);
      setPromptTrace(null);
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
    setNotice({ tone: 'good', message: 'Session and its conversations deleted.' });
    if (workspaceRef.current?.sessionId === sessionId) {
      await changeWorkspace({ kind: 'session', sessionId: next?.sessionId ?? null });
    }
    if (next) void loadSession(next.sessionId);
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
      if (event.type === 'run_progress') {
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
      if (event.type === 'run_finished') {
        latestAgentFinished.current.set(event.runId, event);
        if (selectedSessionIdRef.current === event.sessionId) {
          setRunId(event.runId);
          const turnId = activeChatTurnId.current;
          if (turnId) applyAgentFinish(event, turnId);
          void loadSession(event.sessionId);
        }
        void loadSessionList();
        void loadRun(event.runId);
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
  const modelReady = Boolean(state?.ready && persistedModel && isDraftSaved && credentialStatus === 'configured');
  const canTest = Boolean(state?.ready && persistedModel && isDraftSaved && credentialStatus === 'configured' && !busy && !saving);
  const inputSessionAvailable = selectedSessionId === null
    ? sessionLoading
    : selectedSession === null || selectedSession.availability === 'ready';
  const inputEnabled = Boolean(modelReady && !saving && !busy && !sessionMutating && inputSessionAvailable);
  const workspaceReady = Boolean(workspace && workspace.sessionId === selectedSessionId
    && confirmedWorkspaceRevision === workspace.revision
    && (goalMode !== 'save-candidate' || (workspace.documentRef && workspace.jobId)));
  const canChat = Boolean(inputEnabled && !sessionLoading && selectedSession?.availability === 'ready'
    && !selectedSession.modelUseBlocked && workspaceReady);
  useLayoutEffect(() => {
    if (!focusComposerWhenReady.current || !inputEnabled) return;
    focusComposerWhenReady.current = false;
    chatComposerRef.current?.focus();
  }, [inputEnabled, selectedSessionId, sessionLoading]);
  const savedModels = state?.settings.models ?? [];
  const modelLabel = useMemo(() => draft.model.trim() || 'No model selected', [draft.model]);

  async function confirmWorkspace() {
    const latest = await window.flowmate.readWorkspace();
    if (!latest.ok) { setNotice({ tone: 'bad', message: errorMessage(latest) }); return; }
    if (latest.data.revision !== workspaceRef.current?.revision || latest.data.sessionId !== selectedSessionId) {
      acceptWorkspace(latest.data);
      setNotice({ tone: 'info', message: 'Workspace changed. Review the current source and confirm it again.' });
      return;
    }
    setConfirmedWorkspaceRevision(latest.data.revision);
    workspaceRef.current = latest.data;
    setWorkspace(latest.data);
    setNotice({ tone: 'good', message: `Workspace revision ${latest.data.revision} confirmed for Session #${latest.data.sessionId}.` });
  }

  async function revokeModelAccess() {
    const documentId = workspaceRef.current?.documentRef?.id;
    if (!documentId || revokingAccess) return;
    if (!window.confirm('Revoke this material for every Session that previously had access? Active Runs will be stopped. Those Sessions will no longer be able to send model requests; local records remain, and copies already sent to a remote model cannot be recalled.')) return;
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
        ? 'No previous Session was authorized for this material.'
        : `Model access was revoked for ${result.data.affectedSessionIds.length} Session(s).${result.data.stopRequested ? ' The active Run is stopping.' : ''}` });
  }

  function selectModel(id: string) {
    const item = state?.settings.models.find((model) => model.id === id);
    if (!item) return;
    setSelectedModelId(id);
    setDraft(item);
    setApiKey('');
    setNotice(null);
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
    const accepted = await window.flowmate.callProvider({ goal, text, modelId: selectedModelId });
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

  async function sendChatMessage() {
    const prompt = chatInput.trim();
    const sessionId = selectedSessionId;
    const model = persistedModel;
    if (!canChat || !selectedModelId || !model || sessionId === null || !prompt) return;
    const current = workspaceRef.current;
    if (!current || current.sessionId !== sessionId || confirmedWorkspaceRevision !== current.revision) {
      setConfirmedWorkspaceRevision(null);
      setNotice({ tone: 'info', message: 'Review and confirm the current Workspace before starting a Run.' });
      return;
    }
    const freshWorkspace = await window.flowmate.readWorkspace();
    if (!freshWorkspace.ok) { setNotice({ tone: 'bad', message: errorMessage(freshWorkspace) }); return; }
    if (freshWorkspace.data.revision !== current.revision || freshWorkspace.data.sessionId !== sessionId) {
      acceptWorkspace(freshWorkspace.data);
      setNotice({ tone: 'info', message: 'Workspace changed before Send. Review and confirm it again.' });
      return;
    }
    const turnId = newId();
    const newTurn: ChatTurn = { id: turnId, sessionId, runId: null, prompt, response: null, error: null, status: 'sending' };
    activeChatTurnId.current = turnId;
    activeChatSessionId.current = sessionId;
    activeAgentRunIdRef.current = null;
    agentStopRequested.current = false;
    setActiveRunModel({ id: model.id, name: model.name, model: model.model });
    setChatInput('');
    setChatTurns((turns) => [...turns, newTurn]);
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
    });
    if (!accepted.ok) {
      setChatTurns((turns) => turns.map((turn) => turn.id === turnId
        ? { ...turn, status: 'failed', error: errorMessage(accepted) }
        : turn));
      if (activeAgentRunIdRef.current === null) {
        setBusy(false);
        activeChatTurnId.current = null;
        activeChatSessionId.current = null;
        setActiveRunModel(null);
        agentStopRequested.current = false;
      }
      return;
    }
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
    await loadRun(accepted.data.runId);
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
        error: outcome.error?.message ?? null,
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
      setNotice({ tone: 'info', message: 'Stop requested. Waiting for the Agent Run to be accepted.' });
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
      : 'The Run is no longer active. Its saved state remains the source of truth.' });
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
      : 'No active request was found. The saved Run remains the source of truth.' });
  }

  async function loadRun(id: number) {
    const [result, trace] = await Promise.all([window.flowmate.queryRun(id), window.flowmate.queryPromptTrace(id)]);
    if (result.ok) setRun(result.data);
    else setNotice({ tone: 'bad', message: errorMessage(result) });
    if (trace.ok) setPromptTrace(trace.data);
    else setPromptTrace({ availability: 'source-unavailable', calls: [], droppedCalls: null });
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

  const activeDisplayName = state?.settings.profile.displayName || 'Local user';

  return (
    <div className={`desktop-shell theme-${profileDraft.theme} ${chatCollapsed ? 'chat-is-collapsed' : ''}`}>
      <aside className="rail" data-testid="workspace-sidebar">
        <div className="brand-lockup"><span className="brand-mark">F</span><span>flowmate</span></div>
        <div className="rail-caption">LOCAL WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          <button className={`nav-item ${page === 'workspace' ? 'active' : ''}`} aria-current={page === 'workspace' ? 'page' : undefined} onClick={() => setPage('workspace')}>
            <span className="nav-glyph">▧</span><span>Workspace</span>
          </button>
          <button className={`nav-item ${page === 'tasks' ? 'active' : ''}`} aria-current={page === 'tasks' ? 'page' : undefined} onClick={() => { setPage('tasks'); if (workspace?.jobId) void loadTaskDetails(workspace.jobId); }}>
            <span className="nav-glyph">☷</span><span>Tasks</span>
          </button>
          <button className={`nav-item ${page === 'model' ? 'active' : ''}`} aria-current={page === 'model' ? 'page' : undefined} onClick={() => setPage('model')}>
            <span className="nav-glyph">◈</span><span>Model</span>
          </button>
          <button className={`nav-item ${page === 'profile' ? 'active' : ''}`} aria-current={page === 'profile' ? 'page' : undefined} onClick={() => setPage('profile')}>
            <span className="nav-glyph">◎</span><span>Profile</span>
          </button>
        </nav>
        <div className="rail-bottom">
          <span className={`status-dot ${state?.ready ? 'is-ready' : 'is-error'}`} />
          <div><strong>{state?.ready ? 'Host ready' : 'Host unavailable'}</strong><small>{state?.ready ? 'Local runtime connected' : 'Check the terminal output'}</small></div>
        </div>
      </aside>

      <main className="workspace" data-testid="main-content">
        <header className="topline">
          <div><span className="crumb">{activeDisplayName}</span><span className="slash">/</span><span>{{ workspace: 'Workspace', tasks: 'Tasks', model: 'Model', profile: 'Profile' }[page]}</span></div>
          <div className="top-state"><span className={`status-dot ${state?.ready ? 'is-ready' : 'is-error'}`} />{state?.ready ? 'LOCAL' : 'OFFLINE'}</div>
        </header>

        {page === 'workspace' ? (
          <WorkspacePage
            workspace={workspace}
            documents={documents}
            jobs={jobs}
            selectedSessionId={selectedSessionId}
            confirmed={confirmedWorkspaceRevision === workspace?.revision}
            goalMode={goalMode}
            taskGoal={taskGoal}
            parsedPage={parsedPage}
            originalImage={originalImage}
            notice={notice}
            onImport={() => void importInvoice()}
            onSelectDocument={(id) => void selectWorkspaceDocument(id)}
            onStartTask={() => void startTask()}
            onConfirm={() => void confirmWorkspace()}
            onGoalModeChange={setGoalMode}
            onTaskGoalChange={setTaskGoal}
            onChangeView={(view) => void changeWorkspace({ kind: 'view', view })}
            onRefresh={() => void loadProductOverview()}
            onRevokeModelAccess={() => void revokeModelAccess()}
            revokingAccess={revokingAccess}
          />
        ) : page === 'tasks' ? (
          <TasksPage
            workspace={workspace}
            jobs={jobs}
            candidates={candidateSummaries}
            candidateDetail={candidateDetail}
            activity={activity}
            confirmed={confirmedWorkspaceRevision === workspace?.revision}
            notice={notice}
            onOpenJob={(jobId) => void openJob(jobId)}
            onOpenCandidate={(jobId, candidateId) => void openCandidate(jobId, candidateId)}
            onSelectCandidate={(jobId, candidateId) => void selectCandidate(jobId, candidateId)}
            onConfirm={() => void confirmWorkspace()}
          />
        ) : page === 'model' ? (
          <section className="page-content">
            <div className="page-heading">
              <div><div className="eyebrow">PROVIDER WORKBENCH</div><h1>Connect a model.</h1><p>Set the route once, then send an explicit diagnostic request through Flowmate’s Provider runtime.</p></div>
              <div className="model-stamp"><span className="stamp-label">CURRENT MODEL</span><strong>{modelLabel}</strong><small>{draft.api}</small></div>
            </div>

            {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
            {!state?.ready && <div className="notice bad" role="alert">The application Host is not ready. No model request can be sent until its data store opens successfully.</div>}

            <div className="model-layout">
              <section className="panel model-list-panel">
                <div className="panel-head"><div><span className="section-index">MODEL ROUTES</span><h2>Your models</h2></div><button className="quiet-button" onClick={() => { const fresh = blankModel(); setDraft(fresh); setSelectedModelId(fresh.id); setApiKey(''); setNotice(null); }}>＋ Add</button></div>
                <div className="model-list">
                  {savedModels.length === 0 && <div className="empty-route"><div className="empty-symbol">＋</div><strong>No model routes yet</strong><span>Add a Base URL, model ID, API type and API Key to begin.</span></div>}
                  {savedModels.map((model) => <button key={model.id} className={`route-row ${selectedModelId === model.id ? 'selected' : ''}`} onClick={() => selectModel(model.id)}>
                    <span className="route-icon">{model.api === 'anthropic-messages' ? 'A' : model.api === 'google-generative-ai' ? 'G' : 'P'}</span>
                    <span className="route-name"><strong>{model.name}</strong><small>{model.model}</small></span>
                    <span className={`credential-pill ${state?.modelCredentials[model.id] === 'configured' ? 'ready' : ''}`}>{state?.modelCredentials[model.id] === 'configured' ? 'KEY SET' : state?.modelCredentials[model.id] === 'unavailable' ? 'LOCKED' : 'NO KEY'}</span>
                  </button>)}
                </div>
                <div className="list-foot"><span>{savedModels.length} saved route{savedModels.length === 1 ? '' : 's'}</span><span>PI RUNTIME · 0.85.1</span></div>
              </section>

              <section className="panel config-panel">
                <div className="panel-head"><div><span className="section-index">MODEL CONFIGURATION</span><h2>Connection details</h2></div><span className="revision-tag">REV {state?.settings.revision ?? '—'}</span></div>
                <div className="form-grid">
                  <label className="field full"><span>Display name</span><input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="Primary model" maxLength={128} /></label>
                  <label className="field full"><span>Base URL <i>API root</i></span><input value={draft.baseUrl} onChange={(event) => updateDraft('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" autoCapitalize="off" spellCheck={false} /></label>
                  <label className="field full"><span>Model ID</span><input value={draft.model} onChange={(event) => updateDraft('model', event.target.value)} placeholder="model-name" autoCapitalize="off" spellCheck={false} /></label>
                  <label className="field"><span>API protocol</span><select value={draft.api} onChange={(event) => updateDraft('api', event.target.value as ModelProfile['api'])}>
                    <option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option>
                  </select></label>
                  <label className="field full"><span>API Key <i>{credentialStatus === 'configured' ? 'saved in system secure storage' : 'write only'}</i></span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={credentialStatus === 'configured' ? 'Leave blank to keep the saved key' : 'Enter API Key'} autoComplete="new-password" /></label>
                </div>
                <div className="config-actions">
                  {persistedModel && <button className="text-button danger-text" onClick={() => void removeModel()}>Remove model</button>}
                  <div className="action-spacer" />
                  <button className="secondary-button" onClick={() => void saveConfiguration()} disabled={saving || !state?.ready}>{saving ? 'Saving…' : 'Save changes'}</button>
                  <button className="primary-button" onClick={() => void testConnection()} disabled={!canTest}>Test connection <span aria-hidden="true">↗</span></button>
                </div>
                <div className="config-note"><span className="note-mark">i</span><span>Only <b>Test connection</b> sends a real request. Saving this form, opening the app and refreshing it never call the model.</span></div>
              </section>
            </div>

            <section className="diagnostic-panel">
              <div className="diagnostic-top">
                <div><span className="section-index">LIVE DIAGNOSTIC</span><h2>Send a test request</h2><p>One request, one persisted Provider Run. Conversation history and Agent tools are not included.</p></div>
                <div className={`request-state ${busy ? 'running' : run ? (run.status === 'completed' ? 'completed' : 'failed') : ''}`}><span className="state-light" />{busy ? 'REQUEST IN PROGRESS' : run ? run.status.toUpperCase() : 'READY WHEN CONFIGURED'}</div>
              </div>
              <div className="diagnostic-form">
                <label className="field"><span>Instruction</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} maxLength={4096} /></label>
                <label className="field"><span>Message</span><textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} placeholder="Type a short message for the selected model…" /></label>
                <div className="send-row"><span>Target · <b>{draft.model || 'No model selected'}</b> <i>{draft.api}</i></span><div>{busy && <button className="secondary-button cancel-button" onClick={() => void cancelRequest()} disabled={cancelPending}>{cancelPending ? 'Waiting for stop…' : 'Cancel request'}</button>}<button className="primary-button send-button" onClick={() => void testConnection()} disabled={!canTest}>{busy ? 'Sending…' : 'Send request'} <span aria-hidden="true">→</span></button></div></div>
              </div>
            </section>

            {(run || runId !== null) && <RunDetails run={run} runId={runId} trace={promptTrace} onRefresh={() => runId && void loadRun(runId)} />}
            <footer className="page-footer"><span>FLOWMATE · LOCAL PROVIDER RUNTIME</span><span>API KEYS STAY ON THIS DEVICE</span></footer>
          </section>
        ) : (
          <section className="page-content profile-content">
            <div className="page-heading"><div><div className="eyebrow">LOCAL IDENTITY</div><h1>Your profile.</h1><p>Device-local display preferences and runtime location. No account or cloud sync is configured.</p></div><div className="profile-orbit">{(profileDraft.displayName.trim()[0] || 'F').toUpperCase()}</div></div>
            {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
            <section className="panel profile-panel"><div className="panel-head"><div><span className="section-index">PREFERENCES</span><h2>Local profile</h2></div></div>
              <div className="profile-fields"><label className="field"><span>Display name</span><input value={profileDraft.displayName} onChange={(event) => setProfileDraft((old) => ({ ...old, displayName: event.target.value }))} maxLength={80} /></label><label className="field"><span>Appearance</span><select value={profileDraft.theme} onChange={(event) => setProfileDraft((old) => ({ ...old, theme: event.target.value as typeof old.theme }))}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
              <div className="config-actions"><span className="action-spacer" /><button className="primary-button" onClick={() => void saveProfile()} disabled={saving || !state?.ready}>{saving ? 'Saving…' : 'Save profile'}</button></div>
            </section>
            <section className="system-facts"><div><span>APPLICATION</span><strong>Flowmate {state?.appVersion ?? '—'}</strong></div><div><span>APPLICATION HOST</span><strong>{state?.host ?? 'starting'}</strong></div><div><span>DATA DIRECTORY</span><code>{state?.userDataPath ?? 'Loading…'}</code></div><div><span>DATABASE</span><code>{state?.userDataPath ? `${state.userDataPath}\\data\\app.sqlite` : 'Loading…'}</code></div></section>
            <footer className="page-footer"><span>PROFILE SETTINGS ARE STORED IN settings.json</span><span>SECRETS USE OS SECURE STORAGE</span></footer>
          </section>
        )}
      </main>
      <AgentChatPanel
        collapsed={chatCollapsed}
        onToggle={() => setChatCollapsed((collapsed) => !collapsed)}
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        selectedSession={selectedSession}
        sessionLoading={sessionLoading}
        hasMoreSessions={sessionCursor !== null}
        hasOlderRuns={runCursor !== null}
        onSelectSession={(id) => selectSession(id, true)}
        onNewSession={() => void createNewSession()}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        sessionMutating={sessionMutating}
        onLoadMoreSessions={() => void loadMoreSessions()}
        onLoadOlderRuns={() => void loadOlderRuns()}
        turns={chatTurns}
        transcriptRef={chatTranscriptRef}
        input={chatInput}
        composerRef={chatComposerRef}
        onInputChange={setChatInput}
        onSend={() => void sendChatMessage()}
        onCancel={() => void (activeAgentRunIdRef.current === null ? cancelRequest() : cancelAgentRun())}
        enabled={canChat}
        inputEnabled={inputEnabled}
        busy={busy}
        cancelPending={cancelPending}
        activeAgentRunId={activeAgentRunId}
        activeAgentSessionId={activeAgentSessionId}
        activeRunModel={activeRunModel}
        selectedModelId={selectedModelId}
        modelName={persistedModel?.name ?? null}
        modelId={persistedModel?.model ?? null}
        sessionHint={!selectedSession ? selectedSessionId !== null ? 'Loading this Session. You can write while it loads; Send will be available when ready.' : 'Create a Session to begin. Creating one does not call the model.'
          : selectedSession.availability === 'history-unavailable' ? "This session's conversation history is unavailable after restart. Create a new session to continue."
            : selectedSession.modelUseBlocked ? 'Model access was revoked for this Session. Create a new Session to continue.'
            : selectedSession.availability === 'archived' ? 'This Session is pending deletion. Retry Delete to finish removing it.'
            : selectedSession.availability === 'unusable' ? 'This Agent Session cannot continue safely. Create a new Session.'
              : selectedSession.availability === 'busy' ? 'A Run is active for this Session.'
                : !modelReady ? 'Save a model route and API Key to start a chat.'
                  : !workspace ? 'Loading the Workspace.'
                    : workspace.sessionId !== selectedSessionId ? 'Binding this Session to the Workspace.'
                      : confirmedWorkspaceRevision !== workspace.revision ? 'Review the Workspace source and confirm it before Send.'
                        : goalMode === 'save-candidate' && (!workspace.documentRef || !workspace.jobId) ? 'Select a document and start a Task to save a candidate.' : ''}
        onOpenRun={(id) => { setPage('model'); void loadRun(id); }}
      />
    </div>
  );
}

function WorkspacePage(props: {
  workspace: WorkspaceSnapshot | null;
  documents: readonly DocumentSnapshot[];
  jobs: readonly JobSnapshot[];
  selectedSessionId: number | null;
  confirmed: boolean;
  goalMode: 'answer' | 'save-candidate';
  taskGoal: string;
  parsedPage: InvoiceToolOutput<'read_invoice_document'> | null;
  originalImage: DocumentOriginalImage | null;
  notice: Notice;
  onImport(): void;
  onSelectDocument(id: number | null): void;
  onStartTask(): void;
  onConfirm(): void;
  onGoalModeChange(value: 'answer' | 'save-candidate'): void;
  onTaskGoalChange(value: string): void;
  onChangeView(value: 'original' | 'parsed' | 'candidate'): void;
  onRefresh(): void;
  onRevokeModelAccess(): void;
  revokingAccess: boolean;
}) {
  const { workspace, documents, jobs, selectedSessionId, confirmed, goalMode, taskGoal, parsedPage, originalImage, notice, revokingAccess } = props;
  const selectedDocument = documents.find((item) => item.documentRef.id === workspace?.documentRef?.id) ?? null;
  return <section className="page-content">
    <div className="page-heading">
      <div><div className="eyebrow">P3 · FORMAL INPUT</div><h1>Workspace.</h1><p>Choose existing invoice material, review its parsed evidence, then explicitly start a Task.</p></div>
      <div className="model-stamp"><span className="stamp-label">WORKSPACE REVISION</span><strong>{workspace?.revision ?? '—'}</strong><small>{workspace?.sessionId ? `Session #${workspace.sessionId}` : 'No Session bound'}</small></div>
    </div>
    {notice && <div className={`notice ${notice.tone}`} role="status">{notice.message}</div>}
    <section className="panel model-list-panel">
      <div className="panel-head"><div><span className="section-index">FORMAL DOCUMENTS</span><h2>Invoice materials</h2></div>
        <div className="button-row"><button className="secondary-button" onClick={props.onRefresh}>Refresh</button><button className="primary-button" onClick={props.onImport}>＋ Choose and import</button></div>
      </div>
      {documents.length === 0 ? <div className="empty-route"><strong>No imported documents</strong><span>Import a directory that contains the existing original and parser output.</span></div> :
        <div className="model-list">{documents.map((document) => <button key={`${document.documentRef.id}:${document.documentRef.version}`} className={`route-row ${workspace?.documentRef?.id === document.documentRef.id ? 'selected' : ''}`} onClick={() => props.onSelectDocument(document.documentRef.id)}>
          <span className="route-icon">▧</span><span className="route-name"><strong>Document #{document.documentRef.id}</strong><small>{document.pageCount} pages · {document.parser.name} {document.parser.version}</small></span>
          <span className={`credential-pill ${document.status === 'available' ? 'ready' : ''}`}>{document.status.toUpperCase()}</span>
        </button>)}</div>}
      {workspace?.documentRef && <div className="config-note"><span className="note-mark">i</span><span>Selected source · Document #{workspace.documentRef.id} · revision {workspace.documentRef.version}{selectedDocument?.unavailableReason ? ` · ${selectedDocument.unavailableReason}` : ''}</span></div>}
      {workspace?.documentRef && <div className="config-actions"><span className="action-spacer" /><button className="danger-action" disabled={revokingAccess} onClick={props.onRevokeModelAccess}>{revokingAccess ? 'Revoking…' : 'Revoke model access'}</button></div>}
    </section>

    {workspace?.documentRef && <section className="panel config-panel">
      <div className="panel-head"><div><span className="section-index">SOURCE REVIEW</span><h2>Original and parsed evidence</h2></div><span className="revision-tag">PAGE 1</span></div>
      <div className="button-row">
        <button className={workspace.activeView === 'original' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('original')}>Original</button>
        <button className={workspace.activeView === 'parsed' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('parsed')}>Parsed</button>
        <button className={workspace.activeView === 'candidate' ? 'secondary-button' : 'text-button'} onClick={() => props.onChangeView('candidate')}>Candidate</button>
      </div>
      {workspace.activeView === 'original' && (originalImage
        ? <figure><img style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }} src={`data:${originalImage.mimeType};base64,${originalImage.base64}`} alt={`Original invoice document page 1`} /><figcaption>Original page shown for user review.</figcaption></figure>
        : <p className="config-note">Original page is unavailable. The selected document may be missing its source asset.</p>)}
      {workspace.activeView === 'parsed' && (parsedPage
        ? <div className="model-list">{parsedPage.blocks.map((block) => <article className="route-row" key={block.id}>
          <span className="route-icon">{block.kind === 'table' ? '▤' : block.kind === 'image' ? '▧' : '¶'}</span>
          <span className="route-name"><strong>{block.id} · {block.kind}</strong><small>{block.text || '(no extracted text)'}</small><small>Page {block.source.page} · artifact #{block.source.artifactId}{block.source.quote ? ` · ${block.source.quote}` : ''}</small></span>
        </article>)}</div>
        : <p className="config-note">Parsed page could not be loaded.</p>)}
      {workspace.activeView === 'candidate' && <p className="config-note">Candidate details and source links are available in Tasks after a Run saves a candidate.</p>}
    </section>}

    <section className="panel profile-panel">
      <div className="panel-head"><div><span className="section-index">START TASK</span><h2>Freeze this source for a Job</h2></div><span className="revision-tag">NEXT #{workspace?.nextTaskSequence ?? '—'}</span></div>
      <label className="field full"><span>Task goal</span><textarea value={taskGoal} onChange={(event) => props.onTaskGoalChange(event.target.value)} maxLength={4096} rows={3} placeholder="What should the Agent prepare from this invoice?" /></label>
      <div className="config-actions"><span className="action-spacer" /><button className="primary-button" disabled={!workspace?.documentRef || !selectedSessionId || !taskGoal.trim()} onClick={props.onStartTask}>Start Task</button></div>
      <p className="config-note">Starting a Task creates the Job from the selected document. Choose or create a Session in Agent Chat first.</p>
    </section>

    <section className="panel profile-panel">
      <div className="panel-head"><div><span className="section-index">RUN GATE</span><h2>Confirm current Workspace</h2></div><span className={`credential-pill ${confirmed ? 'ready' : ''}`}>{confirmed ? 'CONFIRMED' : 'REVIEW REQUIRED'}</span></div>
      <label className="field"><span>Run goal mode</span><select value={goalMode} onChange={(event) => props.onGoalModeChange(event.target.value as 'answer' | 'save-candidate')}>
        <option value="answer">Answer only</option><option value="save-candidate" disabled={!workspace?.jobId || !workspace?.documentRef}>Prepare and save candidate</option>
      </select></label>
      <div className="config-actions"><span className="action-spacer" /><button className="primary-button" disabled={!workspace || !selectedSessionId || workspace.sessionId !== selectedSessionId} onClick={props.onConfirm}>{confirmed ? 'Reconfirm Workspace' : 'Confirm Workspace'}</button></div>
      <p className="config-note">Changing Session, document, Job, view or selected candidate changes the revision and requires confirmation again. Send stays disabled until the current revision and Session match.</p>
    </section>
    <footer className="page-footer"><span>MODEL RUNS START ONLY FROM EXPLICIT SEND</span><span>FORMAL INPUT · NO BENCHMARK GOLD</span></footer>
  </section>;
}

function TasksPage(props: {
  workspace: WorkspaceSnapshot | null;
  jobs: readonly JobSnapshot[];
  candidates: readonly CandidateSummary[];
  candidateDetail: CandidateJobDetail | null;
  activity: readonly BusinessEventSnapshot[];
  confirmed: boolean;
  notice: Notice;
  onOpenJob(jobId: number): void;
  onOpenCandidate(jobId: number, candidateId: number): void;
  onSelectCandidate(jobId: number, candidateId: number): void;
  onConfirm(): void;
}) {
  const { workspace, jobs, candidates, candidateDetail, activity, confirmed } = props;
  const job = jobs.find((item) => item.jobId === workspace?.jobId) ?? null;
  return <section className="page-content">
    <div className="page-heading"><div><div className="eyebrow">P3 · TASKS AND CANDIDATES</div><h1>Tasks.</h1><p>Inspect Job status, saved candidates, source references and business activity.</p></div><div className="model-stamp"><span className="stamp-label">ACTIVE JOB</span><strong>{job ? `#${job.jobId}` : 'None'}</strong><small>{job?.status ?? 'Select a Job'}</small></div></div>
    {props.notice && <div className={`notice ${props.notice.tone}`} role="status">{props.notice.message}</div>}
    <section className="panel model-list-panel"><div className="panel-head"><div><span className="section-index">JOBS</span><h2>Task history</h2></div></div>
      {jobs.length === 0 ? <div className="empty-route"><strong>No Tasks yet</strong><span>Choose a formal document in Workspace and click Start Task.</span></div> :
        <div className="model-list">{jobs.map((item) => <button key={item.jobId} className={`route-row ${item.jobId === workspace?.jobId ? 'selected' : ''}`} onClick={() => props.onOpenJob(item.jobId)}>
          <span className="route-icon">☷</span><span className="route-name"><strong>Job #{item.jobId} · {item.status}</strong><small>Document #{item.documentRef.id} · {item.goal}</small><small>Candidate pointer · {item.currentCandidateId ? `#${item.currentCandidateId}` : 'none'}</small></span><span className="credential-pill">OPEN</span>
        </button>)}</div>}
    </section>
    {job && <>
      <section className="panel config-panel"><div className="panel-head"><div><span className="section-index">SAVED CANDIDATES</span><h2>Job #{job.jobId}</h2></div><span className="revision-tag">{candidates.length} shown</span></div>
        {candidates.length === 0 ? <p className="config-note">No candidate has been saved. Confirm this Workspace, then Send a Run in “Prepare and save candidate” mode.</p> :
          <div className="model-list">{candidates.map((item) => <div className="route-row" key={item.candidateId}>
            <span className="route-icon">{item.status === 'accepted' ? '✓' : '▧'}</span><span className="route-name"><strong>Candidate #{item.candidateId} · {item.status}</strong><small>Sequence {item.sequence} · Run #{item.runId} · {item.issueCount} issues · {item.createdAt}</small></span>
            <button className="text-button" onClick={() => props.onOpenCandidate(job.jobId, item.candidateId)}>View</button>
            {item.status === 'generated' && item.candidateId !== job.currentCandidateId && <button className="secondary-button" onClick={() => props.onSelectCandidate(job.jobId, item.candidateId)}>Select</button>}
          </div>)}</div>}
      </section>
      {candidateDetail && <section className="panel profile-panel"><div className="panel-head"><div><span className="section-index">CANDIDATE DETAILS</span><h2>Candidate #{candidateDetail.candidate.candidateId}</h2></div><span className="revision-tag">Run #{candidateDetail.candidate.runId}</span></div>
        <div className="profile-fields">{Object.entries(candidateDetail.candidate.fields).map(([name, field]) => <div key={name}><strong>{name}</strong><div>{field.raw ?? '—'} {field.normalized && field.normalized !== field.raw ? `→ ${field.normalized}` : ''} · {field.state}</div></div>)}</div>
        <h3>Issues</h3>{candidateDetail.candidate.issues.length === 0 ? <p>No validation issues.</p> : <ul>{candidateDetail.candidate.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.severity} · {issue.message} ({issue.fieldPaths.join(', ') || 'document'})</li>)}</ul>}
        <h3>Sources</h3>{candidateDetail.candidate.sources.length === 0 ? <p>No explicit source links were saved.</p> : <ul>{candidateDetail.candidate.sources.map((source, index) => <li key={`${source.artifactId}:${source.page}:${source.blockId}:${index}`}>Document #{source.documentId} · artifact #{source.artifactId} · page {source.page} · {source.blockId ?? 'page'}{source.quote ? ` · “${source.quote}”` : ''}</li>)}</ul>}
        {candidateDetail.candidate.lines.map((line, index) => <details key={index}><summary>Line {index + 1} · {line.description.raw ?? 'description missing'}</summary><pre>{stringify(line)}</pre></details>)}
      </section>}
      <section className="panel profile-panel"><div className="panel-head"><div><span className="section-index">BUSINESS ACTIVITY</span><h2>Job #{job.jobId} events</h2></div></div>
        {activity.length === 0 ? <p>No business events are recorded yet.</p> : <ol>{activity.map((event) => <li key={event.id}><strong>{event.type}</strong> · {event.result} · {event.safeSummary} · {event.occurredAt}{event.errorCode ? ` · ${event.errorCode}` : ''}</li>)}</ol>}
      </section>
    </>}
    <section className="panel profile-panel"><div className="panel-head"><div><span className="section-index">RUN CONFIRMATION</span><h2>Workspace must be reviewed after a change</h2></div><span className={`credential-pill ${confirmed ? 'ready' : ''}`}>{confirmed ? 'CONFIRMED' : 'REVIEW REQUIRED'}</span></div><p className="config-note">{workspace?.documentRef ? `Document #${workspace.documentRef.id}` : 'No document'} · {workspace?.jobId ? `Job #${workspace.jobId}` : 'no Job'} · Session {workspace?.sessionId ? `#${workspace.sessionId}` : 'unbound'} · revision ${workspace?.revision ?? '—'}</p><div className="config-actions"><span className="action-spacer" /><button className="primary-button" disabled={!workspace?.sessionId} onClick={props.onConfirm}>Confirm Workspace</button></div></section>
    <footer className="page-footer"><span>CANDIDATES ARE GENERATED, NOT ACCEPTED</span><span>ACTIVITY IS A BUSINESS RECORD</span></footer>
  </section>;
}

function modelFieldsEqual(left: ModelProfile, right: ModelProfile): boolean {
  return left.id === right.id && left.name === right.name && left.baseUrl === right.baseUrl && left.model === right.model
    && left.api === right.api && left.credentialRef === right.credentialRef;
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
    error: run.error?.message ?? null,
    status: run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled'
      : run.status === 'failed' ? 'failed' : 'sending',
  };
}

function RunDetails({ run, runId, trace, onRefresh }: { run: RunSnapshot | null; runId: number | null; trace: PromptTraceResult | null; onRefresh(): void }) {
  if (!run) return <section className="run-panel loading-run"><span className="loader-ring" /><span>Loading the persisted Run…</span><button className="text-button" onClick={onRefresh}>Refresh</button></section>;
  const input = run.input as { goal?: string; text?: string };
  const output = run.output as { text?: string; partial?: boolean; responseModel?: string | null; stopReason?: string } | null;
  const config = run.config as { requestedModel?: { provider?: string; model?: string }; resolvedModel?: { provider?: string; model?: string } | null; api?: string | null; endpoint?: string | null };
  const usage = run.usage as { source?: string; reason?: string | null; sdkValues?: { input?: number | null; output?: number | null; totalTokens?: number | null; costTotal?: number | null } | null; attempts?: number | null };
  const cleanup = run.cleanup as { stopped?: boolean; stopReason?: string | null; errors?: unknown[] };
  return <section className="run-panel">
    <div className="run-heading"><div><span className="section-index">PERSISTED {run.kind === 'agent' ? 'AGENT' : 'PROVIDER'} RUN</span><h2>Run {runId ?? run.runId} <span className={`run-status ${run.status}`}>{run.status}</span></h2></div><button className="quiet-button" onClick={onRefresh}>↻ Refresh facts</button></div>
    <div className="run-grid">
      <article className="fact-card"><span className="fact-label">MODEL ROUTE</span><strong>{config.resolvedModel?.model ?? config.requestedModel?.model ?? 'Unknown'}</strong><small>{config.api ?? 'API unknown'} · {config.endpoint ?? 'endpoint unavailable'}</small></article>
      <article className="fact-card"><span className="fact-label">USAGE</span><strong>{usage.source === 'sdk' ? `${usage.sdkValues?.totalTokens ?? 'Unknown'} tokens` : 'Unknown'}</strong><small>{usage.reason ?? `Attempts: ${usage.attempts ?? 'unknown'}`}</small></article>
      <article className="fact-card"><span className="fact-label">STOP & CLEANUP</span><strong>{cleanup.stopped === true ? 'Stopped' : cleanup.stopped === false ? 'Not confirmed' : 'Unknown'}</strong><small>{cleanup.stopReason ?? 'No stop request'}</small></article>
    </div>
    <div className="evidence-columns">
      <article className="evidence-block"><span className="fact-label">INPUT SENT</span><div className="input-copy"><b>Instruction</b><p>{input.goal ?? 'Not recorded'}</p><b>Message</b><p>{input.text ?? 'Not recorded'}</p></div></article>
      <article className="evidence-block response-block"><span className="fact-label">ACTUAL RESPONSE {output?.partial ? '· PARTIAL' : ''}</span><pre className="response-copy">{output?.text || 'No response text was persisted.'}</pre></article>
    </div>
    {(run.error || (cleanup.errors?.length ?? 0) > 0) && <div className="error-facts"><span className="fact-label">FAILURE / CLEANUP FACTS</span><pre>{stringify({ error: run.error, cleanup })}</pre></div>}
    <section className="prompt-trace-panel" aria-label="Temporary Prompt Trace">
      <div className="trace-heading"><div><span className="section-index">TEMPORARY PROMPT TRACE</span><p>One logical model call; this in-memory summary is cleared when the Host exits.</p></div><strong>{trace?.availability ?? 'loading'}</strong></div>
      {!trace && <p className="trace-empty">Loading trace availability…</p>}
      {trace && trace.availability !== 'available' && <p className="trace-empty">{trace.availability === 'not-started' ? 'No model call started for this Run.'
        : trace.availability === 'evicted' ? 'This call summary was evicted from the bounded buffer.'
          : trace.availability === 'process-exited' ? 'The Host process that owned this in-memory trace has exited.'
            : trace.availability === 'not-collected' ? 'Prompt Trace was not collected for this Run type.'
              : 'The trace source is unavailable. Saved Run facts remain available.'}</p>}
      {trace?.calls.map((call) => <div className="trace-call" key={`${call.runId}-${call.callSequence}`}>
        <div className="trace-call-heading"><span>CALL {call.callSequence} · {call.state}</span><span>{call.droppedEntries} entries dropped</span></div>
        <ol>{call.entries.map((entry, index) => <li key={`${entry.at}-${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><code>{entry.event}</code><span>{entry.summary}{entry.truncated ? ' · truncated' : ''}</span></li>)}</ol>
      </div>)}
      {trace?.availability === 'available' && <small className="trace-retention">{trace.droppedCalls ?? 0} ended call summaries evicted from this Host process.</small>}
    </section>
    <details className="raw-run"><summary>Full persisted Run record</summary><pre>{stringify(run)}</pre></details>
  </section>;
}

function AgentChatPanel({
  collapsed,
  onToggle,
  sessions,
  selectedSessionId,
  selectedSession,
  sessionLoading,
  hasMoreSessions,
  hasOlderRuns,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  sessionMutating,
  onLoadMoreSessions,
  onLoadOlderRuns,
  turns,
  transcriptRef,
  input,
  composerRef,
  onInputChange,
  onSend,
  onCancel,
  enabled,
  inputEnabled,
  busy,
  cancelPending,
  activeAgentRunId,
  activeAgentSessionId,
  activeRunModel,
  selectedModelId,
  modelName,
  modelId,
  sessionHint,
  onOpenRun,
}: {
  collapsed: boolean;
  onToggle(): void;
  sessions: readonly SessionSnapshot[];
  selectedSessionId: number | null;
  selectedSession: SessionSnapshot | null;
  sessionLoading: boolean;
  hasMoreSessions: boolean;
  hasOlderRuns: boolean;
  onSelectSession(sessionId: number): void;
  onNewSession(): void;
  onRenameSession(sessionId: number, title: string): Promise<boolean>;
  onDeleteSession(sessionId: number): Promise<void>;
  sessionMutating: boolean;
  onLoadMoreSessions(): void;
  onLoadOlderRuns(): void;
  turns: readonly ChatTurn[];
  transcriptRef: RefObject<HTMLDivElement | null>;
  input: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange(value: string): void;
  onSend(): void;
  onCancel(): void;
  enabled: boolean;
  inputEnabled: boolean;
  busy: boolean;
  cancelPending: boolean;
  activeAgentRunId: number | null;
  activeAgentSessionId: number | null;
  activeRunModel: { id: string; name: string; model: string } | null;
  selectedModelId: string | null;
  modelName: string | null;
  modelId: string | null;
  sessionHint: string;
  onOpenRun(runId: number): void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setRenaming(false);
    setEditingSessionId(null);
    setRenameTitle(selectedSession?.title ?? '');
  }, [selectedSessionId]);
  useLayoutEffect(() => {
    if (!renaming || !renameInputRef.current) return;
    renameInputRef.current.focus();
    renameInputRef.current.select();
  }, [renaming, selectedSessionId]);
  if (collapsed) {
    return <aside className="agent-chat-panel collapsed" data-testid="agent-chat-panel">
      <button className="chat-expand" type="button" onClick={onToggle} aria-label="Expand Agent Chat" aria-expanded={false} title="Expand Agent Chat"><span aria-hidden="true">‹</span><b>CHAT</b></button>
    </aside>;
  }
  return <aside className="agent-chat-panel" data-testid="agent-chat-panel" aria-label="Agent Chat">
    <header className="chat-panel-head">
      <div><span className="section-index">PI NATIVE AGENT</span><h2>Agent Chat</h2></div>
      <button className="chat-new-session" type="button" onClick={onNewSession} disabled={sessionLoading || sessionMutating}>{sessionLoading ? 'Creating…' : sessionMutating ? 'Working…' : '＋ New'}</button>
      <button className="chat-collapse" type="button" onClick={onToggle} aria-label="Collapse Agent Chat" aria-expanded={true} title="Collapse Agent Chat">›</button>
    </header>
    <div className="chat-model-row"><span className={`status-dot ${enabled ? 'is-ready' : 'is-error'}`} /><div><strong>{modelName ?? 'No model configured'}</strong><small>{modelId ?? 'Open Model to add a route'}</small></div></div>
    <div className="chat-session-select">
      <label htmlFor="agent-session-select">SESSION</label>
      <select id="agent-session-select" aria-label="Session" value={selectedSessionId ?? ''} disabled={sessionMutating} onChange={(event) => { const id = Number(event.target.value); if (Number.isSafeInteger(id) && id > 0) onSelectSession(id); }}>
        <option value="">Select a Session</option>
        {sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.title} · #{session.sessionId}</option>)}
      </select>
      {selectedSession && <details className="chat-session-actions">
        <summary aria-label="Session actions" title="Session actions">•••</summary>
        <div className="chat-session-action-menu">
          <button type="button" onClick={(event) => {
            setRenameTitle(selectedSession.title);
            setEditingSessionId(selectedSession.sessionId);
            setRenaming(true);
            event.currentTarget.closest('details')?.removeAttribute('open');
          }} disabled={sessionMutating || selectedSession.status === 'archived'}>Rename</button>
          <button type="button" className="danger-action" disabled={sessionMutating || selectedSession.hasBusinessHistory}
            aria-describedby={selectedSession.hasBusinessHistory ? `session-delete-reason-${selectedSession.sessionId}` : undefined} onClick={() => {
            const title = selectedSession.title;
            if (window.confirm(`Permanently delete only this Session (“${title}”), including its conversations and Agent Runs? Other Sessions and Provider test Runs will be kept. This cannot be undone.`)) void onDeleteSession(selectedSession.sessionId);
          }}>Delete Session</button>
          {selectedSession.hasBusinessHistory && <span id={`session-delete-reason-${selectedSession.sessionId}`} role="note">This Session contains invoice history and cannot be deleted.</span>}
        </div>
      </details>}
      {hasMoreSessions && <button type="button" className="chat-more" onClick={onLoadMoreSessions}>More</button>}
    </div>
    {renaming && selectedSession && <form className="chat-session-rename" onSubmit={async (event) => {
      event.preventDefault();
      if (editingSessionId !== null && await onRenameSession(editingSessionId, renameTitle)) setRenaming(false);
    }}>
      <label className="sr-only" htmlFor="agent-session-title">Session title</label>
      <input ref={renameInputRef} id="agent-session-title" aria-label="Session title" value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} autoFocus />
      <button type="submit" disabled={sessionMutating}>Save</button>
      <button type="button" onClick={() => setRenaming(false)} disabled={sessionMutating}>Cancel</button>
    </form>}
    {selectedSession && <div className="chat-session-state"><span className={`status-dot ${selectedSession.availability === 'ready' ? 'is-ready' : selectedSession.availability === 'busy' ? 'is-warning' : 'is-error'}`} />
      <span>{selectedSession.availability === 'ready' ? 'Ready for another Run' : selectedSession.availability === 'busy' ? 'Run in progress' : selectedSession.availability === 'history-unavailable' ? 'History unavailable after restart' : selectedSession.availability === 'unusable' ? 'Session cannot continue' : selectedSession.availability}</span>
    </div>}
    {activeAgentRunId !== null && activeAgentSessionId !== null && activeAgentSessionId !== selectedSessionId
      && <div className="chat-active-run">Run {activeAgentRunId} continues in Session #{activeAgentSessionId}. Stop remains bound to that Run.</div>}
    {busy && activeRunModel && <div className="chat-run-model">RUNNING WITH · {activeRunModel.name} · {activeRunModel.model}{selectedModelId !== activeRunModel.id && <span>The selected model will be used for the next Run.</span>}</div>}
    <div className="chat-boundary">Each Send starts a new Run in this native Session. P2 keeps Agent history in memory for this process; saved Session history cannot be restored after restart.</div>
    <div className="chat-transcript" ref={transcriptRef} role="log" aria-live="polite" aria-relevant="additions text">
      {hasOlderRuns && <button type="button" className="chat-more-runs" onClick={onLoadOlderRuns}>Load older Runs</button>}
      {turns.length === 0 && <div className="chat-empty"><span className="chat-empty-mark">↗</span><strong>{selectedSession ? 'Continue this Session.' : 'Create a Session.'}</strong><p>{selectedSession ? 'Send a message to start a new Agent Run.' : 'New Session creates an identity only; it does not call the model.'}</p></div>}
      {turns.map((turn) => <article className="chat-turn" data-testid="chat-turn" key={turn.id}>
        <div className="chat-user-message"><span className="chat-speaker">YOU</span><p>{turn.prompt}</p></div>
        <div className={`chat-assistant-message ${turn.status}`}>
          <span className="chat-speaker">FLOWMATE · {turn.status === 'sending' ? 'RUNNING' : turn.status.toUpperCase()}</span>
          {turn.status === 'sending' ? <div className="chat-pending"><span className="loader-ring" />Waiting for the Agent Run to finish…</div>
            : turn.response ? <p>{turn.response}</p> : <p>{turn.status === 'cancelled' ? 'Request cancelled.' : 'No response text was returned.'}</p>}
          {turn.error && <p className="chat-error">{turn.error}</p>}
          {turn.runId !== null && <button type="button" className="chat-run-link" onClick={() => onOpenRun(turn.runId!)}>OPEN RUN · {turn.runId}</button>}
        </div>
      </article>)}
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      {sessionHint && <p className="chat-config-hint">{sessionHint}</p>}
      <label className="sr-only" htmlFor="agent-chat-input">Message to model</label>
      <textarea ref={composerRef} id="agent-chat-input" aria-label="Message to model" value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} placeholder="Write a message…" rows={3} disabled={!inputEnabled || busy} />
      <div className="chat-composer-foot"><span>Enter to send · Shift+Enter for a new line</span>
        {busy ? <button className="secondary-button cancel-button" type="button" onClick={onCancel} disabled={cancelPending}>{cancelPending ? 'Stopping…' : 'Stop'}</button>
          : <button className="primary-button" type="submit" disabled={!enabled || !input.trim()}>Send to model <span aria-hidden="true">↗</span></button>}
      </div>
    </form>
  </aside>;
}
