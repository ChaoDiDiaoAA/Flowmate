import { useEffect, useRef, useState } from 'react';
import type { ExtensionCatalog, ExtensionSelection, ExtensionSelectionResult, SessionExtensionView, RunExtensionView,
  ExtensionCommandReceipt, ExtensionDisposeReceipt, ExtensionInstanceView, ProductSettings, RuntimeState, SessionPage, SessionRunsPage } from '@flowmate/contracts';
import { EMPTY_EXTENSION_SELECTION, extensionRefKey } from '../../../../packages/contracts/src/extensions.ts';
import { useRead, type ContextIdentity } from './context-state.ts';

export function ExtensionsPage({ hostEpoch, ready, settings, selectedSessionId, refreshToken, onSaved, summary = false }: {
  hostEpoch: number; ready: boolean; settings: ProductSettings; selectedSessionId: number | null;
  refreshToken: number; onSaved(): Promise<void>; summary?: boolean;
}) {
  const [sessionId, setSessionId] = useState(selectedSessionId ?? 0), [runId, setRunId] = useState<number | null>(null);
  const [notice, setNotice] = useState(''), [refreshRequired, setRefreshRequired] = useState(false);
  const hostIdentity: ContextIdentity = { hostEpoch, sessionId: 0, runId: null, selectionToken: 0 };
  const identity: ContextIdentity = { hostEpoch, sessionId, runId, selectionToken: 0 };
  const catalog = useRead<ExtensionCatalog>(hostIdentity), saving = useRead<ExtensionSelectionResult>(hostIdentity);
  const originalSettings = useRead<ProductSettings>(hostIdentity);
  const sessions = useRead<SessionPage>(hostIdentity), runs = useRead<SessionRunsPage>({ ...identity, runId: null });
  const live = useRead<SessionExtensionView>({ ...identity, runId: null }), history = useRead<RunExtensionView>(identity);
  const runtime = useRead<RuntimeState>(hostIdentity), command = useRead<ExtensionCommandReceipt>({ ...identity, runId: null });
  const releasing = useRead<ExtensionDisposeReceipt>({ ...identity, runId: null });
  const epoch = useRef(hostEpoch); epoch.current = hostEpoch;
  const currentSession = useRef(sessionId); currentSession.current = sessionId;
  const catalogRefresh = useRef(0);
  async function refreshCatalog() {
    if (epoch.current !== hostEpoch) return;
    const ticket = ++catalogRefresh.current;
    const value = await catalog.read('catalog', () => window.flowmate.listExtensions(), value => value.revision >= settings.revision);
    if (ticket !== catalogRefresh.current || epoch.current !== hostEpoch) return;
    if (value) { setRefreshRequired(false); return; }
    const saved = await originalSettings.read('settings', async () => {
      const state = await window.flowmate.getState(); return state.ok ? { ok: true, data: state.data.settings } : state;
    }, value => value.revision >= settings.revision);
    if (saved && ticket === catalogRefresh.current && epoch.current === hostEpoch) setRefreshRequired(false);
  }
  async function refreshSession() {
    if (!ready || epoch.current !== hostEpoch || currentSession.current !== sessionId) return;
    await Promise.all([
      runtime.read('runtime', () => window.flowmate.queryRuntimeState(), () => true),
      ...(sessionId ? [
        live.read('instance', () => window.flowmate.querySessionExtensions({ sessionId }), value => value.sessionId === sessionId),
        runs.read('runs', () => window.flowmate.listSessionRuns({ sessionId }), value => value.items.every(item => item.sessionId === sessionId)),
      ] : []),
    ]);
  }
  useEffect(() => {
    setNotice(''); setRefreshRequired(false);
    if (ready) { void refreshCatalog(); void sessions.read('sessions', () => window.flowmate.listSessions(), () => true); void refreshSession(); }
  }, [hostEpoch, ready]);
  useEffect(() => { if (ready) void refreshCatalog(); }, [settings.revision]);
  useEffect(() => { setNotice(''); setRunId(null); if (ready) void refreshSession(); }, [sessionId]);
  useEffect(() => { if (ready) void refreshSession(); }, [refreshToken]);
  useEffect(() => {
    if (ready && sessionId && runId) void history.read('history', () => window.flowmate.queryRunExtensions({ sessionId, runId }),
      value => value.sessionId === sessionId && value.runId === runId);
  }, [hostEpoch, ready, sessionId, runId]);
  async function save(selection: ExtensionSelection) {
    const expectedRevision = configuration.revision, originalEpoch = hostEpoch;
    setNotice('');
    const result = await saving.read(`save:${expectedRevision}`, () => window.flowmate.updateExtensionSelection({ expectedRevision, selection }),
      value => value.revision === expectedRevision + 1 && JSON.stringify(value.selection) === JSON.stringify(selection));
    if (epoch.current !== originalEpoch) return;
    if (!result) { setRefreshRequired(true); return; }
    setNotice('Saved. This selection applies to later Runs.'); await onSaved(); await refreshCatalog();
  }
  const instances = live.state.data?.instances ?? [], active = runtime.state.data?.active;
  const executing = active?.kind !== 'provider' && active?.sessionId === sessionId;
  const actionPending = command.state.pending || releasing.state.pending;
  const managementBusy = !ready || !sessionId || live.state.pending || runtime.state.pending || !runtime.state.data || Boolean(executing) || actionPending;
  const savedSettings = originalSettings.state.data && originalSettings.state.data.revision > settings.revision ? originalSettings.state.data : settings;
  const configuration = catalog.state.data && catalog.state.data.revision >= savedSettings.revision ? catalog.state.data
    : { revision: savedSettings.revision, selection: savedSettings.extensions ?? EMPTY_EXTENSION_SELECTION };
  const selected = configuration.selection;
  const configurationBusy = !ready || saving.state.pending || refreshRequired;
  async function diagnose(instance: ExtensionInstanceView) {
    if (managementBusy || instance.ref.id !== 'invoice-assist') return;
    const result = await command.read(`command:${instance.instanceId}`, () => window.flowmate.executeExtensionCommand({ sessionId,
      expectedInstanceId: instance.instanceId, name: 'invoice-assist', arguments: '' }),
    value => value.sessionId === sessionId && value.instanceId === instance.instanceId);
    if (result) setNotice(`Diagnostic confirmed for ${result.instanceId}.`);
    await refreshSession();
  }
  async function release(instance: ExtensionInstanceView) {
    if (managementBusy) return;
    const result = await releasing.read(`release:${instance.instanceId}`, () => window.flowmate.disposeSessionExtensions({ sessionId,
      expectedInstanceId: instance.instanceId }), value => value.sessionId === sessionId && value.instanceId === instance.instanceId);
    if (result) setNotice(result.report.closed ? 'Session resources released.' : 'Cleanup remains incomplete. Retry this instance.');
    await refreshSession();
  }
  return <section className={summary ? 'connection-plugins' : 'page-content'}><div className="page-heading"><div>{summary ? <h2>Connected plugins</h2> : <h1>Extensions</h1>}
    <p>Manage the plugins connected to Flowmate.</p></div>
    <button className="secondary-button" disabled={!ready || saving.state.pending || actionPending}
      onClick={() => { void refreshCatalog(); void refreshSession(); }}>Refresh extensions</button></div>
    {notice && <p role="status">{notice}</p>}{!ready && <p role="alert">The Host is unavailable.</p>}
    {[catalog.state.error, originalSettings.state.error, saving.state.error, live.state.error, history.state.error, command.state.error, releasing.state.error,
      runtime.state.error, sessions.state.error, runs.state.error].filter(Boolean).map((message, index) => <p role="alert" key={index}>{message}</p>)}
    {refreshRequired && <p role="alert">Refresh extensions to confirm the saved selection before trying again.</p>}
    <section className="panel plugin-list" aria-label="Extension configuration">
      {!summary && <button className="text-button" disabled={configurationBusy} onClick={() => void save(EMPTY_EXTENSION_SELECTION)}>Clear extension selection</button>}
      {catalog.state.data?.items.map(item => {
        const enabled = selected.enabledExtensions.some(ref => extensionRefKey(ref) === extensionRefKey(item.ref));
        const instance = instances.find(instance => extensionRefKey(instance.ref) === extensionRefKey(item.ref) && instance.state !== 'disposed');
        return <article className="plugin-row" key={extensionRefKey(item.ref)}><div className="skill-row-main"><div className="skill-row-copy"><h3>{item.ref.id} <small>{item.ref.version}</small></h3>
          <p>{item.ref.id === 'invoice-assist' ? 'Checks invoice sources to support invoice review.' : item.ref.id === 'subagents' ? 'Delegates focused, read-only work to an assistant.' : 'Connected Flowmate plugin.'}</p>
          <p>{item.compatibility.available ? 'Compatible' : item.compatibility.code} · {enabled ? 'Enabled' : 'Disabled'} · {live.state.pending ? 'Checking session…' : live.state.error ? 'Session status unavailable' : instance ? `Session: ${instance.state}` : 'Not loaded in this session'}</p></div>
          {!summary && <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Disable' : 'Enable'} ${item.ref.id} ${item.ref.version}`}
            className="resource-switch" disabled={configurationBusy || !enabled && !item.compatibility.available}
            onClick={() => void save({ enabledExtensions: enabled ? selected.enabledExtensions.filter(ref => ref.id !== item.ref.id)
              : [...selected.enabledExtensions, item.ref].sort((a, b) => Number(a.id === 'subagents') - Number(b.id === 'subagents')) })}><span /></button>}</div>
          {!summary && <details className="plugin-details"><summary>Plugin details</summary><p>Pi {item.manifest.sdkVersion} · Settings revision {configuration.revision}</p>
          <p>Tools: {item.manifest.tools.map(tool => tool.name).join(', ')} · Command: {item.manifest.commands.join(', ')}</p>
          <p>Hooks: {item.manifest.hooks.map(hook => `${hook.event} (${hook.policy})`).join(', ')}</p>
          <p>Manifest SHA-256 {item.ref.manifestHash}</p>
          </details>}</article>;
      })}
      {selected.enabledExtensions.some(ref => !catalog.state.data?.items.some(item => extensionRefKey(item.ref) === extensionRefKey(ref)))
        && <p role="alert">The saved extension version is unavailable. Clear the selection or select a verified version.</p>}
      {!summary && <p className="plugin-save-note">Changes apply to future conversations. Active plugins keep their current configuration.</p>}
    </section>
    {!summary && <><details className="panel plugin-details" aria-label="Session extension instance"><summary>Session details</summary><h2>Current Session instance</h2>
      <label>Extension Session<select aria-label="Extension Session" value={sessionId} disabled={!ready || actionPending}
        onChange={event => setSessionId(Number(event.target.value))}><option value={0}>Choose a Session</option>
        {sessions.state.data?.items.map(item => <option key={item.sessionId} value={item.sessionId}>{item.title} ({item.sessionId})</option>)}</select></label>
      {live.state.pending && <p data-testid="extension-session-pending">Checking Session extensions…</p>}
      {!instances.length && <p>No instance recorded in this Host. A selected extension loads only when an eligible Run prepares.</p>}
      {instances.map(instance => <article key={instance.instanceId}><p>{instance.ref.id} {instance.ref.version}</p>
        <p data-testid="extension-instance">{instance.state} · {instance.admission} · {instance.instanceId}</p>
        <p>Actual tools: {instance.registeredTools.join(', ') || 'None'} · Actual commands: {instance.registeredCommands.join(', ') || 'None'}</p>
        <p>Actual Hooks: {instance.hookEvents.join(', ') || 'None'}</p>
        <p>Shutdown: {instance.cleanup.shutdownRequired ? instance.cleanup.shutdownAcknowledged ? 'acknowledged' : 'pending' : 'not required'} · SDK: {instance.cleanup.sdkSessionCreated ? instance.cleanup.sdkDisposed ? 'disposed' : 'retained' : 'not created'} · Callbacks: {instance.cleanup.ownedCallbacksSettled ? 'settled' : 'pending'}</p>
        {instance.lastError && <p role="alert">{instance.lastError.code} · {instance.lastError.message}</p>}
        {instance.ref.id === 'invoice-assist' && <button className="secondary-button" disabled={managementBusy || runtime.state.data?.blocked || instance.state !== 'active' || instance.admission !== 'open'} onClick={() => void diagnose(instance)}>Run invoice-assist diagnostic</button>}{' '}
        <button className="secondary-button" disabled={managementBusy || instance.state === 'disposed'} onClick={() => void release(instance)}>Release Session extensions</button>
        {instance.diagnostics.map((item, index) => <p key={index}>{item.event} · {item.code} · {item.at}</p>)}
      </article>)}
      {executing && <p>Session execution is active. Wait for actual stop before diagnostics or release.</p>}
      {executing && active?.runId && <button className="secondary-button" disabled={!ready || actionPending}
        onClick={async () => { await window.flowmate.cancelRun(active.runId!); await refreshSession(); }}>Stop current Run</button>}
    </details>
    <details className="panel plugin-details" aria-label="Run extension history"><summary>History details</summary><h2>Run fixed extensions</h2>
      <label>Extension Run<select aria-label="Extension Run" value={runId ?? ''} disabled={!ready || !sessionId}
        onChange={event => setRunId(event.target.value ? Number(event.target.value) : null)}><option value="">Choose a Run</option>
        {runs.state.data?.items.map(item => <option key={item.runId} value={item.runId}>Run {item.runId} · {item.status}</option>)}</select></label>
      {history.state.data && <><p>Fixed settings revision: {history.state.data.frozen?.settingsRevision ?? 'Not recorded'}</p>
        <p>Included: {history.state.data.frozen?.included.map(item => `${item.ref.id} ${item.ref.version}`).join(', ') || 'None recorded'}</p>
        {history.state.data.frozen?.excluded.map(item => <p key={extensionRefKey(item.ref)}>Excluded {item.ref.id} · {item.code}</p>)}
        <p>Assembly: {history.state.data.assembly?.instances.map(item => item.instanceId).join(', ') || 'None recorded'}</p>
        <p>Run evidence is historical. It does not prove that this Host has an active instance.</p></>}
    </details></>}
  </section>;
}
