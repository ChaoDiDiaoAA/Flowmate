import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { DesktopEvent, DesktopState, ModelProfile, ProductSettings, RunSnapshot } from '@flowmate/contracts';

type Page = 'model' | 'profile';
type Notice = { tone: 'good' | 'bad' | 'info'; message: string } | null;
type ProfileDraft = { displayName: string; theme: 'system' | 'light' | 'dark' };
type ChatTurn = {
  id: string;
  requestId: string | null;
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
  const [page, setPage] = useState<Page>('model');
  const [state, setState] = useState<DesktopState | null>(null);
  const [draft, setDraft] = useState<ModelProfile>(blankModel);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>({ displayName: 'Local user', theme: 'system' });
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [goal, setGoal] = useState('Answer the user clearly and directly.');
  const [text, setText] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const latestFinished = useRef<Extract<DesktopEvent, { type: 'provider_finished' }> | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeChatTurnId = useRef<string | null>(null);
  const chatTranscriptRef = useRef<HTMLDivElement | null>(null);
  const revisionLoaded = useRef<number | null>(null);

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
      if (event.type === 'provider_observation') {
        if (event.observation === 'run_created') {
          setRunId(event.runId);
          const chatTurnId = activeChatTurnId.current;
          if (chatTurnId && (activeRequestIdRef.current === null || activeRequestIdRef.current === event.requestId)) {
            setChatTurns((turns) => turns.map((turn) => turn.id === chatTurnId ? { ...turn, requestId: event.requestId, runId: event.runId } : turn));
          }
        }
        return;
      }
      if (event.type === 'provider_finished') {
        latestFinished.current = event;
        setRunId(event.runId);
        setBusy(false);
        setCancelPending(false);
        if (activeRequestIdRef.current === event.requestId) {
          const chatTurnId = activeChatTurnId.current;
          if (chatTurnId) applyChatFinish(event, chatTurnId);
          activeRequestIdRef.current = null;
          activeChatTurnId.current = null;
          setActiveRequestId(null);
        }
        void loadRun(event.runId);
      }
    });
    return () => { alive = false; unsubscribe(); };
  }, []);

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
  const canTest = Boolean(state?.ready && persistedModel && isDraftSaved && credentialStatus === 'configured' && !busy && !saving);
  const canChat = canTest;
  const savedModels = state?.settings.models ?? [];
  const modelLabel = useMemo(() => draft.model.trim() || 'No model selected', [draft.model]);

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
    if (!canChat || !selectedModelId || !prompt) return;
    const turnId = newId();
    const newTurn: ChatTurn = { id: turnId, requestId: null, runId: null, prompt, response: null, error: null, status: 'sending' };
    activeChatTurnId.current = turnId;
    setChatInput('');
    setChatTurns((turns) => [...turns, newTurn].slice(-30));
    setBusy(true);
    setCancelPending(false);
    setNotice(null);
    const accepted = await window.flowmate.callProvider({
      goal: 'Answer the user clearly and directly.',
      text: prompt,
      modelId: selectedModelId,
    });
    if (!accepted.ok) {
      setBusy(false);
      activeChatTurnId.current = null;
      setChatTurns((turns) => turns.map((turn) => turn.id === turnId
        ? { ...turn, status: 'failed', error: errorMessage(accepted) }
        : turn));
      return;
    }
    activeRequestIdRef.current = accepted.data.requestId;
    setActiveRequestId(accepted.data.requestId);
    setRunId(accepted.data.runId);
    setChatTurns((turns) => turns.map((turn) => turn.id === turnId
      ? { ...turn, requestId: accepted.data.requestId, runId: accepted.data.runId }
      : turn));
    const finished = latestFinished.current;
    if (finished?.requestId === accepted.data.requestId) {
      setBusy(false);
      setCancelPending(false);
      activeRequestIdRef.current = null;
      activeChatTurnId.current = null;
      setActiveRequestId(null);
      applyChatFinish(finished, turnId);
    }
    await loadRun(accepted.data.runId);
  }

  function applyChatFinish(event: Extract<DesktopEvent, { type: 'provider_finished' }>, turnId: string) {
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

  const activeDisplayName = state?.settings.profile.displayName || 'Local user';

  return (
    <div className={`desktop-shell theme-${profileDraft.theme} ${chatCollapsed ? 'chat-is-collapsed' : ''}`}>
      <aside className="rail" data-testid="workspace-sidebar">
        <div className="brand-lockup"><span className="brand-mark">F</span><span>flowmate</span></div>
        <div className="rail-caption">LOCAL WORKSPACE</div>
        <nav aria-label="Workspace navigation">
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
          <div><span className="crumb">{activeDisplayName}</span><span className="slash">/</span><span>{page === 'model' ? 'Model' : 'Profile'}</span></div>
          <div className="top-state"><span className={`status-dot ${state?.ready ? 'is-ready' : 'is-error'}`} />{state?.ready ? 'LOCAL' : 'OFFLINE'}</div>
        </header>

        {page === 'model' ? (
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

            {(run || runId !== null) && <RunDetails run={run} runId={runId} onRefresh={() => runId && void loadRun(runId)} />}
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
        turns={chatTurns}
        transcriptRef={chatTranscriptRef}
        input={chatInput}
        onInputChange={setChatInput}
        onSend={() => void sendChatMessage()}
        onCancel={() => void cancelRequest()}
        enabled={canChat}
        busy={busy}
        cancelPending={cancelPending}
        modelName={persistedModel?.name ?? null}
        modelId={persistedModel?.model ?? null}
        onOpenRun={(id) => { setPage('model'); void loadRun(id); }}
      />
    </div>
  );
}

function modelFieldsEqual(left: ModelProfile, right: ModelProfile): boolean {
  return left.id === right.id && left.name === right.name && left.baseUrl === right.baseUrl && left.model === right.model
    && left.api === right.api && left.credentialRef === right.credentialRef;
}

function RunDetails({ run, runId, onRefresh }: { run: RunSnapshot | null; runId: number | null; onRefresh(): void }) {
  if (!run) return <section className="run-panel loading-run"><span className="loader-ring" /><span>Loading the persisted Run…</span><button className="text-button" onClick={onRefresh}>Refresh</button></section>;
  const input = run.input as { goal?: string; text?: string };
  const output = run.output as { text?: string; partial?: boolean; responseModel?: string | null; stopReason?: string } | null;
  const config = run.config as { requestedModel?: { provider?: string; model?: string }; resolvedModel?: { provider?: string; model?: string } | null; api?: string | null; endpoint?: string | null };
  const usage = run.usage as { source?: string; reason?: string | null; sdkValues?: { input?: number | null; output?: number | null; totalTokens?: number | null; costTotal?: number | null } | null; attempts?: number | null };
  const cleanup = run.cleanup as { stopped?: boolean; stopReason?: string | null; errors?: unknown[] };
  return <section className="run-panel">
    <div className="run-heading"><div><span className="section-index">PERSISTED PROVIDER RUN</span><h2>Run {runId ?? run.runId} <span className={`run-status ${run.status}`}>{run.status}</span></h2></div><button className="quiet-button" onClick={onRefresh}>↻ Refresh facts</button></div>
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
    <details className="raw-run"><summary>Full persisted Run record</summary><pre>{stringify(run)}</pre></details>
  </section>;
}

function AgentChatPanel({
  collapsed,
  onToggle,
  turns,
  transcriptRef,
  input,
  onInputChange,
  onSend,
  onCancel,
  enabled,
  busy,
  cancelPending,
  modelName,
  modelId,
  onOpenRun,
}: {
  collapsed: boolean;
  onToggle(): void;
  turns: readonly ChatTurn[];
  transcriptRef: RefObject<HTMLDivElement | null>;
  input: string;
  onInputChange(value: string): void;
  onSend(): void;
  onCancel(): void;
  enabled: boolean;
  busy: boolean;
  cancelPending: boolean;
  modelName: string | null;
  modelId: string | null;
  onOpenRun(runId: number): void;
}) {
  if (collapsed) {
    return <aside className="agent-chat-panel collapsed" data-testid="agent-chat-panel">
      <button className="chat-expand" type="button" onClick={onToggle} aria-label="Expand Agent Chat" aria-expanded={false} title="Expand Agent Chat"><span aria-hidden="true">‹</span><b>CHAT</b></button>
    </aside>;
  }
  return <aside className="agent-chat-panel" data-testid="agent-chat-panel" aria-label="Agent Chat">
    <header className="chat-panel-head">
      <div><span className="section-index">PROVIDER WORKSPACE</span><h2>Agent Chat</h2></div>
      <button className="chat-collapse" type="button" onClick={onToggle} aria-label="Collapse Agent Chat" aria-expanded={true} title="Collapse Agent Chat">›</button>
    </header>
    <div className="chat-model-row"><span className={`status-dot ${enabled ? 'is-ready' : 'is-error'}`} /><div><strong>{modelName ?? 'No model configured'}</strong><small>{modelId ?? 'Open Model to add a route'}</small></div></div>
    <div className="chat-boundary">Each message is a separate Provider Run. Previous messages stay visible here but are never sent to the model. Sessions and Agent tools are planned for P2.</div>
    <div className="chat-transcript" ref={transcriptRef} role="log" aria-live="polite" aria-relevant="additions text">
      {turns.length === 0 && <div className="chat-empty"><span className="chat-empty-mark">↗</span><strong>Ask your model a question.</strong><p>Your first message will start one direct Provider request.</p></div>}
      {turns.map((turn) => <article className="chat-turn" data-testid="chat-turn" key={turn.id}>
        <div className="chat-user-message"><span className="chat-speaker">YOU</span><p>{turn.prompt}</p></div>
        <div className={`chat-assistant-message ${turn.status}`}>
          <span className="chat-speaker">FLOWMATE · {turn.status === 'sending' ? 'RUNNING' : turn.status.toUpperCase()}</span>
          {turn.status === 'sending' ? <div className="chat-pending"><span className="loader-ring" />Waiting for the Provider response…</div>
            : turn.response ? <p>{turn.response}</p> : <p>{turn.status === 'cancelled' ? 'Request cancelled.' : 'No response text was returned.'}</p>}
          {turn.error && <p className="chat-error">{turn.error}</p>}
          {turn.runId !== null && <button type="button" className="chat-run-link" onClick={() => onOpenRun(turn.runId!)}>OPEN RUN · {turn.runId}</button>}
        </div>
      </article>)}
    </div>
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      {!enabled && <p className="chat-config-hint">Save a model route with an API key to start a chat.</p>}
      <label className="sr-only" htmlFor="agent-chat-input">Message to model</label>
      <textarea id="agent-chat-input" aria-label="Message to model" value={input} onChange={(event) => onInputChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); }
      }} placeholder="Write a message…" rows={3} disabled={!enabled || busy} />
      <div className="chat-composer-foot"><span>Enter to send · Shift+Enter for a new line</span>
        {busy ? <button className="secondary-button cancel-button" type="button" onClick={onCancel} disabled={cancelPending}>{cancelPending ? 'Stopping…' : 'Stop'}</button>
          : <button className="primary-button" type="submit" disabled={!enabled || !input.trim()}>Send to model <span aria-hidden="true">↗</span></button>}
      </div>
    </form>
  </aside>;
}
