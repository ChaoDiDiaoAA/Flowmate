import { useEffect, useMemo, useRef, useState } from 'react';
import { OpenVikingManagementPanel } from './openviking-management.tsx';
import { z } from 'zod';
import { MemoryEntriesPageSchema, MemoryEntryDetailSchema, MemoryForgetResultSchema, MemoryOperationsPageSchema, MemoryRecallResultSchema, MemorySearchRequestSchema,
  MemoryRememberRecoveryResultSchema, MemoryRememberRequestSchema, MemoryRememberResultSchema, MemorySettingsViewSchema,
  appError, fail, ok, type CloudDesktopUserCommand, type MemoryApi, type Result, type SessionInputSnapshot } from '@flowmate/contracts';

type View = z.infer<typeof MemorySettingsViewSchema>;
type Entry = z.infer<typeof MemoryEntryDetailSchema>;
type Entries = z.infer<typeof MemoryEntriesPageSchema>;
type Operations = z.infer<typeof MemoryOperationsPageSchema>;
const kinds = ['sync', 'remember', 'forget'] as const;
function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.message); return result.data; }

function cloudMemory(workspaceId: string): MemoryApi {
  async function call<T>(command: CloudDesktopUserCommand, schema: z.ZodType<T>): Promise<Result<T>> {
    const result = await window.flowmate.cloudDesktop.request({ workspaceId, command });
    if (!result.ok) return result;
    const parsed = schema.safeParse(result.data);
    return parsed.success ? ok(parsed.data) : fail(appError('memory_unavailable', 'runtime', 'The memory response could not be verified.', true));
  }
  return {
    getSettings: () => call({ type: 'cloud_memory_get_settings', input: {} }, MemorySettingsViewSchema),
    listEntries: input => call({ type: 'cloud_memory_list_entries', input: { ...input, limit: input.limit ?? 30 } }, MemoryEntriesPageSchema),
    readEntry: input => call({ type: 'cloud_memory_read_entry', input }, MemoryEntryDetailSchema),
    listOperations: input => call({ type: 'cloud_memory_list_operations', input: { ...input, limit: input.limit ?? 30 } }, MemoryOperationsPageSchema),
    search: input => call({ type: 'cloud_memory_search', input }, MemoryRecallResultSchema),
    updatePolicy: input => call({ type: 'cloud_memory_update_policy', input }, MemorySettingsViewSchema),
    remember: input => call({ type: 'cloud_memory_remember', input }, MemoryRememberResultSchema),
    reconcileRemember: input => call({ type: 'cloud_memory_reconcile_remember', input }, MemoryRememberResultSchema),
    reconcileRememberById: input => call({ type: 'cloud_memory_reconcile_remember_by_id', input }, MemoryRememberRecoveryResultSchema),
    forget: input => call({ type: 'cloud_memory_forget', input }, MemoryForgetResultSchema),
    reconcileSync: async () => fail(appError('memory_unavailable', 'runtime', 'Cloud Work capture is not enabled.', true)),
  };
}

export function MemorySettingsPanel(props: { hostEpoch: number; ready: boolean; sessionId: number | null }) {
  const [workspace, setWorkspace] = useState<string | null>(null), [target, setTarget] = useState<'local' | 'cloud'>('local');
  const [view, setView] = useState<View | null>(null), [entries, setEntries] = useState<Entries | null>(null), [detail, setDetail] = useState<Entry | null>(null);
  const [operations, setOperations] = useState<Partial<Record<(typeof kinds)[number], Operations>>>({});
  const [provider, setProvider] = useState<'native' | 'openviking'>('native'), [recall, setRecall] = useState(false);
  const [capture, setCapture] = useState<'off' | 'explicit' | 'auto'>('off');
  const [source, setSource] = useState<'session' | 'work'>('session'), [inputId, setInputId] = useState('');
  const [workId, setWorkId] = useState(''), [itemId, setItemId] = useState(''), [phaseId, setPhaseId] = useState('');
  const [scope, setScope] = useState<'personal' | 'source'>('source'), [content, setContent] = useState('');
  const [searchQuery, setSearchQuery] = useState(''), [searchResult, setSearchResult] = useState<z.infer<typeof MemoryRecallResultSchema> | null>(null);
  const [chatInputs, setChatInputs] = useState<readonly SessionInputSnapshot[]>([]), [inputCursor, setInputCursor] = useState<number | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const inputGeneration = useRef(0);
  const client = useMemo(() => target === 'local' ? window.flowmate.memory : workspace ? cloudMemory(workspace) : null, [target, workspace]);

  useEffect(() => { let live = true; void window.flowmate.cloudDesktop.state().then(result => {
    if (live) setWorkspace(result.ok ? result.data.workspaceId : null);
  }); return () => { live = false; }; }, [props.hostEpoch]);
  async function load(token: number) {
    if (!client || target === 'local' && !props.ready) return;
    const [settings, list, ...states] = await Promise.all([client.getSettings(), client.listEntries({ limit: 30 }),
      ...kinds.map(kind => client.listOperations({ kind, limit: 30 }))]);
    if (generation.current !== token) return;
    const next = need(settings); setView(next); setProvider(next.settings.provider); setRecall(next.settings.recallEnabled); setCapture(next.settings.captureMode);
    setEntries(need(list)); setOperations(Object.fromEntries(states.map((value, index) => [kinds[index]!, need(value)]))); setDetail(null); setSearchResult(null);
  }
  useEffect(() => {
    const token = ++generation.current; setBusy(false); setView(null); setEntries(null); setOperations({}); setDetail(null); setError(null); setMessage(null);
    void load(token).catch(cause => { if (generation.current === token) setError(cause instanceof Error ? cause.message : 'Memory is unavailable.'); });
    return () => { generation.current++; };
  }, [client, props.hostEpoch, props.ready]);
  useEffect(() => { setSearchResult(null); }, [target, source, inputId, workId, itemId, phaseId, searchQuery, props.sessionId]);
  async function readChatInputs(sessionId: number, beforeInputId?: number) {
    const page = need(await window.flowmate.listSessionInputs({ sessionId, ...(beforeInputId === undefined ? {} : { beforeInputId }), limit: 50 }));
    if (page.items.some((input, index) => input.sessionId !== sessionId
      || input.inputId >= (index ? page.items[index - 1]!.inputId : beforeInputId ?? Infinity))
      || page.nextBeforeInputId !== null && (page.items.length !== 50 || page.nextBeforeInputId !== page.items.at(-1)?.inputId))
      throw Error('Saved inputs do not match this chat.');
    return page;
  }
  useEffect(() => {
    const token = ++inputGeneration.current, sessionId = props.sessionId;
    setChatInputs([]); setInputCursor(null); setInputId(''); setInputError(null);
    if (!props.ready || target !== 'local' || sessionId === null) return;
    void readChatInputs(sessionId).then(page => {
      if (inputGeneration.current === token) { setChatInputs(page.items); setInputCursor(page.nextBeforeInputId); }
    }).catch(() => { if (inputGeneration.current === token) setInputError('Saved chat inputs are unavailable.'); });
    return () => { inputGeneration.current++; };
  }, [props.sessionId, props.hostEpoch, props.ready, target]);
  async function olderInputs(token: number) {
    if (props.sessionId === null || inputCursor === null) return;
    const expected = inputGeneration.current, page = await readChatInputs(props.sessionId, inputCursor);
    if (generation.current === token && inputGeneration.current === expected) {
      setChatInputs(current => [...current, ...page.items]); setInputCursor(page.nextBeforeInputId);
    }
  }
  async function refreshInputs(token: number) {
    if (props.sessionId === null) return;
    const expected = ++inputGeneration.current, page = await readChatInputs(props.sessionId);
    if (generation.current === token && inputGeneration.current === expected) {
      setChatInputs(page.items); setInputCursor(page.nextBeforeInputId); setInputError(null);
    }
  }
  async function run(action: (token: number) => Promise<void>) {
    if (busy || !client) return;
    const token = ++generation.current; setBusy(true); setError(null); setMessage(null);
    try { await action(token); }
    catch (cause) { if (generation.current === token) setError(cause instanceof Error ? cause.message : 'The memory operation could not be completed.'); }
    finally { if (generation.current === token) setBusy(false); }
  }
  const completedInputs = chatInputs.filter(item => item.processingStatus === 'completed');
  async function remember(token: number) {
    const originalSource = source === 'session' && target === 'local' && props.sessionId !== null
      ? { kind: 'session' as const, sessionId: props.sessionId, inputId: Number(inputId) }
      : { kind: 'work' as const, workId: Number(workId), itemId: Number(itemId), phaseId: Number(phaseId) };
    const requestedScope = scope === 'personal' ? { kind: 'personal' as const } : originalSource.kind === 'session'
      ? { kind: 'session' as const, sessionId: originalSource.sessionId } : { kind: 'work' as const, workId: originalSource.workId };
    const parsed = MemoryRememberRequestSchema.safeParse({ requestId: crypto.randomUUID(), source: originalSource, content, scope: requestedScope, confirmed: true });
    if (!parsed.success) throw Error('Choose an original input or Work phase and enter memory text.');
    const runtimeScope = originalSource.kind === 'session' ? 'authorized AgentSession chats' : 'authorized Personal Agent Works';
    const sourceScope = originalSource.kind === 'session' ? 'this chat' : 'this Work';
    const scopeText = requestedScope.kind === 'personal' ? runtimeScope : sourceScope;
    if (!window.confirm(`Save the displayed text to ${target === 'local' ? 'this device’s' : 'this cloud workspace’s'} OpenViking memory for ${scopeText}?`)) return;
    const result = need(await client!.remember(parsed.data));
    if (generation.current !== token) return;
    setMessage(result.state === 'completed' ? 'The memory was saved.' : `The original request is ${result.state}; check its operation before trying again.`);
    if (result.state === 'completed') setContent('');
    await load(token);
  }
  async function search(token: number) {
    const originalSource = source === 'session' && target === 'local' && props.sessionId !== null
      ? { kind: 'session' as const, sessionId: props.sessionId, inputId: Number(inputId) }
      : { kind: 'work' as const, workId: Number(workId), itemId: Number(itemId), phaseId: Number(phaseId) };
    const parsed = MemorySearchRequestSchema.safeParse({ query: searchQuery, source: originalSource });
    if (!parsed.success) throw Error('Choose an original input or Work phase and enter a search.');
    const result = need(await client!.search(parsed.data));
    if (generation.current === token) setSearchResult(result);
  }
  return <section className="panel memory-panel" aria-label="Long-term memory">
    <div className="panel-head"><div><h2>Long-term memory</h2><p>Local and cloud memories are separate.</p></div>
      <button type="button" disabled={busy || !client} onClick={() => void run(async token => {
        await load(token); if (target === 'local' && props.ready && props.sessionId !== null) await refreshInputs(token);
      })}>Refresh memory</button></div>
    <label>Memory location <select value={target} disabled={busy} onChange={event => { const next = event.target.value as 'local' | 'cloud';
      setTarget(next); setSource(next === 'cloud' ? 'work' : 'session'); }}>
      <option value="local">This device</option><option value="cloud" disabled={!workspace}>Connected cloud workspace</option>
    </select></label>
    <OpenVikingManagementPanel />
    {target === 'local' && <p><button type="button" disabled={busy || !props.ready} onClick={() => void run(async token => {
      const result = need(await window.flowmate.memory.configureFromFile());
      if (generation.current !== token || result.cancelled) return;
      setMessage('The local connection was saved.'); await load(token);
    })}>Connect OpenViking from file</button></p>}
    {target === 'local' && <><p>The selected connection file remains on disk; its user key is copied into Windows secure storage. Use an ordinary user key; administrator and Root keys are rejected.</p>
      <details><summary>Connection file format</summary><pre>{`{
  "endpoint": "http://127.0.0.1:19338",
  "accountId": "your-account",
  "userId": "your-user",
  "peerId": "flowmate-agent",
  "apiKey": "your-user-key",
  "recallEnabled": false,
  "captureMode": "off"
}`}</pre></details></>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {inputError && <p role="alert">{inputError}</p>}
    {view && <>
      <p>Current backend: {view.settings.provider}; {view.identity ? `account ${view.identity.accountId}, user ${view.identity.userId}` : 'no external identity configured'}.</p>
      <div className="memory-policy"><label>Backend for new conversations <select value={provider} disabled={busy} onChange={event => setProvider(event.target.value as 'native' | 'openviking')}>
        <option value="native">Native</option><option value="openviking" disabled={!view.identity}>OpenViking</option></select></label>
      <label className="memory-checkbox"><input type="checkbox" checked={recall} disabled={busy || !view.identity} onChange={event => setRecall(event.target.checked)} /> Recall authorized memories</label>
      <label>Capture <select value={capture} disabled={busy || !view.identity} onChange={event => setCapture(event.target.value as typeof capture)}>
        <option value="off">Off</option><option value="explicit">Only when I confirm</option><option value="auto">Completed chats</option></select></label></div>
      <p>Automatic capture sends completed chat turns to OpenViking. Extracted memories may be recalled across authorized conversations in this location. Invoice Work capture requires separate authorization and is currently off.</p>
      <button type="button" disabled={busy} onClick={() => void run(async token => {
        if (capture === 'auto' && view.settings.captureMode !== 'auto' && !window.confirm('Allow completed chats to be sent to OpenViking for extraction? Extracted memories may be recalled across authorized conversations in this location.')) return;
        need(await client!.updatePolicy({ expectedRevision: view.settings.revision, provider, recallEnabled: recall, captureMode: capture }));
        if (generation.current === token) { setMessage('Memory settings were saved.'); await load(token); }
      })}>Save memory settings</button>
      <details><summary>Save a memory</summary>
        <p>Confirm the text and its original input or invoice phase. Long-term memory follows the source runtime in this location. A fork inherits the original chat's memory authorization.</p>
        {target === 'local' && <label>Source <select value={source} disabled={busy} onChange={event => setSource(event.target.value as typeof source)}>
          <option value="session">Current chat</option><option value="work">Invoice Work phase</option></select></label>}
        {source === 'session' && target === 'local' ? <label>Completed input <select value={inputId} disabled={busy} onChange={event => setInputId(event.target.value)}>
          <option value="">Choose an input</option>{completedInputs.map(input => <option key={input.inputId} value={input.inputId}>{input.content.text.slice(0, 100)}</option>)}</select></label>
          : <div className="memory-source-fields"><label>Work ID <input value={workId} inputMode="numeric" onChange={event => setWorkId(event.target.value)} /></label>
            <label>Invoice item ID <input value={itemId} inputMode="numeric" onChange={event => setItemId(event.target.value)} /></label>
            <label>Phase ID <input value={phaseId} inputMode="numeric" onChange={event => setPhaseId(event.target.value)} /></label></div>}
        {source === 'session' && target === 'local' && inputCursor !== null && <button type="button" disabled={busy} onClick={() => void run(olderInputs)}>Older chat inputs</button>}
        <label>Scope <select value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="source">This chat or Work</option><option value="personal">Across {source === 'session' ? 'AgentSession chats' : 'Personal Agent Works'}</option></select></label>
        <label className="memory-text">Memory text <textarea value={content} maxLength={65000} onChange={event => setContent(event.target.value)} /></label>
        <button type="button" disabled={busy || !view.identity || !content.trim()} onClick={() => void run(remember)}>Confirm and save memory</button>
      </details>
      <details><summary>Search authorized memories</summary>
        <p>Manual search uses the selected chat input or Work phase. It does not enable automatic recall.</p>
        {target === 'local' && <label>Search source <select value={source} disabled={busy} onChange={event => setSource(event.target.value as typeof source)}>
          <option value="session">Current chat</option><option value="work">Invoice Work phase</option></select></label>}
        {source === 'session' && target === 'local' ? <label>Search input <select value={inputId} disabled={busy} onChange={event => setInputId(event.target.value)}>
          <option value="">Choose an input</option>{completedInputs.map(input => <option key={input.inputId} value={input.inputId}>{input.content.text.slice(0, 100)}</option>)}</select></label>
          : <div className="memory-source-fields"><label>Search Work ID <input value={workId} inputMode="numeric" onChange={event => setWorkId(event.target.value)} /></label>
            <label>Search invoice item ID <input value={itemId} inputMode="numeric" onChange={event => setItemId(event.target.value)} /></label>
            <label>Search phase ID <input value={phaseId} inputMode="numeric" onChange={event => setPhaseId(event.target.value)} /></label></div>}
        {source === 'session' && target === 'local' && inputCursor !== null && <button type="button" disabled={busy} onClick={() => void run(olderInputs)}>Older chat inputs</button>}
        <label>Search text <input value={searchQuery} maxLength={500} onChange={event => setSearchQuery(event.target.value)} /></label>
        <button type="button" disabled={busy || !view.identity || !searchQuery.trim()} onClick={() => void run(search)}>Search memory</button>
        {searchResult && <div role="status"><p>Search: {searchResult.status}.</p>{searchResult.items.map(item => <article key={item.uri}>
          <p>{item.uri}{item.truncated ? ' · truncated' : ''}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{item.content}</pre></article>)}</div>}
      </details>
      <details><summary>Saved memories</summary>
        {entries?.items.map(item => <article key={item.entryId}><p>{item.uri} · {item.endpoint} · revision {item.revision} · {item.state}{item.identityActive ? '' : ' · identity inactive'}</p>
          <button type="button" disabled={busy} onClick={() => void run(async token => { const value = need(await client!.readEntry({ entryId: item.entryId }));
            if (generation.current === token) setDetail(value); })}>View memory {item.entryId}</button>{' '}
          {item.state === 'active' && <button type="button" disabled={busy} onClick={() => void run(async token => {
            if (!window.confirm('Forget this memory and request its removal from the original OpenViking service?')) return;
            const requestId = crypto.randomUUID(), result = await client!.forget({ entryId: item.entryId, expectedRevision: item.revision, requestId, confirmed: true });
            if (!result.ok) throw Error(`${result.error.message} Original request: ${requestId}`);
            if (generation.current === token) { setMessage(`Forget request ${requestId}: ${result.data.state}.`); await load(token); }
          })}>Forget memory {item.entryId}</button>}</article>)}
        {entries?.nextAfterId && <button type="button" disabled={busy} onClick={() => void run(async token => {
          const next = need(await client!.listEntries({ afterId: entries.nextAfterId!, limit: 30 }));
          if (generation.current === token) setEntries({ items: [...entries.items, ...next.items], nextAfterId: next.nextAfterId });
        })}>More memories</button>}
        {detail && <article><h3>Memory {detail.entryId}</h3><p>{detail.uri}</p><pre style={{ whiteSpace: 'pre-wrap' }}>{detail.content ?? 'Content is no longer available.'}</pre>
          {detail.origin && <p>Original {detail.origin.inputId !== null ? `input ${detail.origin.inputId}` : `phase ${detail.origin.phaseId}`}.</p>}
          <p>Authorized scopes: {detail.grants.map(grant => `${grant.kind} ${grant.scopeId}`).join(', ') || 'none'}.</p></article>}
      </details>
      <details><summary>Memory operations</summary>
        {kinds.map(kind => <div key={kind}><h3>{kind}</h3>{operations[kind]?.items.map(operation => <p key={operation.operationId}>
          Operation {operation.operationId} · {operation.state}{operation.requestId ? ` · ${operation.requestId}` : ''}{' '}
          {kind === 'remember' && operation.requestId && ['pending', 'unknown'].includes(operation.state) && <button type="button" disabled={busy}
            onClick={() => void run(async token => { const result = need(await client!.reconcileRememberById({ operationId: operation.operationId, requestId: operation.requestId! }));
              if (generation.current === token) { setMessage(`Original remember request: ${result.result.state}.`); await load(token); } })}>Check original request</button>}
          {kind === 'sync' && target === 'local' && operation.state === 'unknown' && <button type="button" disabled={busy}
            onClick={() => void run(async token => { const result = need(await client!.reconcileSync(operation.operationId));
              if (generation.current === token) { setMessage(`Original synchronization: ${result.state}.`); await load(token); } })}>Check original synchronization</button>}
          {kind === 'sync' && target === 'local' && operation.state === 'unknown' && <button type="button" disabled={busy}
            onClick={() => void run(async token => {
              if (!window.confirm('Abandon this synchronization? Its remote outcome may remain unknown, and the original remote session will stop receiving later batches.')) return;
              const result = need(await client!.reconcileSync(operation.operationId, true));
              if (generation.current === token) { setMessage(`Original synchronization: ${result.state}.`); await load(token); }
            })}>Abandon synchronization</button>}
          {kind === 'forget' && operation.entryId && operation.requestId && ['pending', 'unknown'].includes(operation.state) &&
            <button type="button" disabled={busy} onClick={() => void run(async token => {
              const result = need(await client!.forget({ entryId: operation.entryId!, operationId: operation.operationId, requestId: operation.requestId! }));
              if (generation.current === token) { setMessage(`Original forget request: ${result.state}.`); await load(token); }
            })}>Check original forget request</button>}
        </p>)}{operations[kind]?.nextAfterId && <button type="button" disabled={busy} onClick={() => void run(async token => {
          const previous = operations[kind]!, next = need(await client!.listOperations({ kind, afterId: previous.nextAfterId!, limit: 30 }));
          if (generation.current === token) setOperations(current => ({ ...current, [kind]: { items: [...previous.items, ...next.items], nextAfterId: next.nextAfterId } }));
        })}>More {kind} operations</button>}</div>)}
      </details>
    </>}
  </section>;
}
